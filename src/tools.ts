/** 注册 MCP 工具到 server。 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AihubmaxClient,
  ApiError,
  type LiveModel,
  type PricingEntry,
  type PricingTable,
  type SubmitResponse,
  type TaskResponse,
} from "./apiClient.js";
import {
  listModelSummaries,
  resolveEntry,
  type MediaType,
  type ParamSpec,
} from "./catalog.js";
import { normalizeModelId } from "./modelId.js";

/**
 * 兜底提交端点：仅在 catalog 查不到该模型时使用。
 *
 * 正常路径以 catalog 条目的 path 为准——它同时也是 describe_model 展示的端点，
 * 两个工具因此不会各说各话。特例（如 Suno 走单数 /v1/audio/generations）由 catalog 数据本身承载，
 * 不再用模型名正则去猜。
 */
const GEN_PATH: Record<MediaType, string> = {
  image: "/v1/images/generations",
  video: "/v1/videos/generations",
  audio: "/v1/audios/generations",
  document: "/v1/run/generations",
};

/**
 * 各媒体类型默认等待秒数。video 取 0 是刻意的：视频生成本就是分钟级，
 * 默认等待只会与客户端 60s 量级的工具超时赛跑——一旦被掐断，任务已提交、
 * 额度已预扣，而含 task_id 的返回体永远送不到调用方。视频一律先拿 task_id。
 */
const DEFAULT_WAIT: Record<MediaType, number> = {
  image: 45,
  audio: 45,
  document: 45,
  video: 0,
};
/** LLM 族（analyze_media / ask_model）的默认等待。 */
const DEFAULT_LLM_WAIT = 45;

const LIVE_TTL_MS = 60_000;
const PRICE_TTL_MS = 300_000;
/** 失败结果的负缓存时长：避免上游持续不可用时，每次工具调用都白跑一整轮退避重试。 */
const FAILURE_TTL_MS = 10_000;

/**
 * 带 TTL 的单值缓存，并发调用共享同一个在途请求。
 *
 * 缓存 Promise 而非结果：list_models / describe_model 都会并发拉 live + pricing，
 * 冷启动时若缓存结果，两个工具并发就会打出 4 个请求。
 */
function cachedLoader<T>(load: () => Promise<T>, ttlOf: (v: T) => number): () => Promise<T> {
  let entry: { at: number; ttl: number; value: Promise<T> } | null = null;
  return () => {
    if (entry && Date.now() - entry.at < entry.ttl) return entry.value;
    const fresh = { at: Date.now(), ttl: Number.MAX_SAFE_INTEGER, value: load() };
    entry = fresh;
    fresh.value.then(
      (v) => {
        if (entry === fresh) fresh.ttl = ttlOf(v);
      },
      () => {
        if (entry === fresh) entry = null;
      },
    );
    return fresh.value;
  };
}

/** /v1/models 的拉取结果。失败原因必须带出来，调用方要据此决定是拒绝还是降级。 */
export type LiveResult =
  | { ok: true; models: Map<string, LiveModel> }
  | { ok: false; error: string };

const liveLoader = new WeakMap<AihubmaxClient, () => Promise<LiveResult>>();
function liveModels(client: AihubmaxClient): Promise<LiveResult> {
  let loader = liveLoader.get(client);
  if (!loader) {
    loader = cachedLoader<LiveResult>(
      async () => {
        try {
          return { ok: true, models: await client.listLiveModels() };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      (v) => (v.ok ? LIVE_TTL_MS : FAILURE_TTL_MS),
    );
    liveLoader.set(client, loader);
  }
  return loader();
}

const priceLoader = new WeakMap<AihubmaxClient, () => Promise<PricingTable | null>>();
function pricing(client: AihubmaxClient): Promise<PricingTable | null> {
  let loader = priceLoader.get(client);
  if (!loader) {
    loader = cachedLoader<PricingTable | null>(
      () => client.getPricing().catch(() => null),
      (v) => (v ? PRICE_TTL_MS : FAILURE_TTL_MS),
    );
    priceLoader.set(client, loader);
  }
  return loader();
}

/** 定价摘要字符串。按次固定价给 USD 基准；按量计费透传倍率，不臆造 $/1M。 */
function priceSummary(e: PricingEntry | undefined): string | null {
  if (!e) return null;
  if (e.quota_type === 1 && typeof e.model_price === "number" && e.model_price > 0)
    return `$${e.model_price.toFixed(3)}/次（基准价，最终价=基准×分组倍率）`;
  if (e.quota_type === 0 && typeof e.model_ratio === "number")
    return `按量计费·model_ratio=${e.model_ratio}${e.completion_ratio ? `·completion_ratio=${e.completion_ratio}` : ""}（×分组倍率）`;
  return null;
}

/** 按次固定价模型：对该模型开放的分组给出「基准×倍率」的实际 USD 单价。 */
function perGroupPrice(e: PricingEntry, groupRatio: Record<string, number>): Record<string, number> | null {
  if (e.quota_type !== 1 || typeof e.model_price !== "number" || e.model_price <= 0) return null;
  const out: Record<string, number> = {};
  for (const g of e.enable_groups ?? []) {
    const r = groupRatio[g];
    if (typeof r === "number") out[g] = Number((e.model_price * r).toFixed(4));
  }
  return Object.keys(out).length ? out : null;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** 错误结果。context 用于把 task_id 等「丢了就找不回」的线索一并交还调用方。 */
function errorResult(e: unknown, context?: string) {
  const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: context ? `${msg}\n${context}` : msg }] };
}

/** 资产下载的停滞超时：这段时间内没有新字节即判定卡死。用停滞判定而非总时长上限，避免大文件被误杀。 */
const ASSET_STALL_MS = 60_000;
/** 上传走 base64 JSON 体，没有流式通道，只能限体积。 */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 流式下载到本地文件，返回实际写入字节数。
 *
 * 必须流式：产物可能是几百 MB 的视频，整体 arrayBuffer 会 OOM 并拖垮整个 server 进程。
 * resolvePath 在拿到响应头后调用，以便从 content-type 推断文件名。
 */
export async function downloadToFile(
  url: string,
  resolvePath: (contentType: string | null) => string,
): Promise<{ path: string; bytes: number }> {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), ASSET_STALL_MS);
  const resetStall = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ASSET_STALL_MS);
  };
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
    if (!res.body) throw new Error(`下载失败：响应无 body: ${url}`);
    const outPath = resolvePath(res.headers.get("content-type"));
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        resetStall();
        cb(null, chunk);
      },
    });
    await mkdir(dirname(outPath), { recursive: true });
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(outPath),
    );
    return { path: outPath, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/** 提交生成 + 可选等待。返回精简任务视图；图像成功时附带内联图像块。 */
async function submitAndMaybeWait(
  client: AihubmaxClient,
  path: string,
  params: Record<string, unknown>,
  waitSeconds: number,
  inlineImages: boolean,
) {
  const submit: SubmitResponse = await client.submitGeneration(path, params);
  if (waitSeconds <= 0 || submit.status === "completed" || submit.status === "failed") {
    return taskResult(submit, shapeTask(submit), inlineImages);
  }
  const task = await client.pollTask(submit.id, waitSeconds);
  const shaped = shapeTask(task);
  if (task.status !== "completed" && task.status !== "failed") {
    return json({ ...shaped, note: `任务仍在进行，已等待 ${waitSeconds}s。用 get_task("${task.id}") 或 wait_for_task("${task.id}") 继续。` });
  }
  return taskResult(task, shaped, inlineImages);
}

/** 异步提交 LLM 生成/理解任务 + 可选等待。完成后抽取助手文本；超时返回 task_id。 */
async function llmSubmitAndWait(
  client: AihubmaxClient,
  body: Record<string, unknown>,
  waitSeconds: number,
) {
  const submit = await client.llmGenerate(body);
  if (waitSeconds <= 0) {
    return json({
      task_id: submit.id,
      status: submit.status,
      model: submit.model,
      note: `已异步提交。用 get_task("${submit.id}") 或 wait_for_task 取回结果（results[0] 为 ChatCompletion）。`,
    });
  }
  const task = await client.pollTask(submit.id, waitSeconds);
  if (task.status === "completed") {
    const { text, completion } = AihubmaxClient.llmText(task);
    return json({ task_id: task.id, status: task.status, model: task.model, text, usage: completion?.usage });
  }
  if (task.status === "failed") {
    return json({ task_id: task.id, status: task.status, error: task.error });
  }
  return json({
    task_id: task.id,
    status: task.status,
    progress: task.progress ?? 0,
    note: `等待 ${waitSeconds}s 仍未完成，用 get_task("${task.id}") 或 wait_for_task 继续取回结果。`,
  });
}

function shapeTask(t: SubmitResponse | TaskResponse) {
  return {
    task_id: t.id,
    status: t.status,
    progress: t.progress ?? 0,
    model: t.model,
    ...("results" in t && t.results ? { results: t.results } : {}),
    ...("error" in t && t.error ? { error: t.error } : {}),
    usage: t.usage,
  };
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/wav": ".wav", "application/zip": ".zip",
};

/** 从 URL（含 content-type 兜底）推断保存文件名。 */
function urlFilename(url: string, contentType: string | null, index: number): string {
  try {
    const base = basename(new URL(url).pathname);
    if (base && extname(base)) return base;
  } catch {
    /* 非法 URL，走兜底 */
  }
  const ext = (contentType && MIME_EXT[contentType.split(";")[0]!.trim()]) || ".bin";
  return `asset-${index}${ext}`;
}

const INLINE_IMAGE_MAX_BYTES = 1_500_000; // 超过则只回 URL，不内联
const INLINE_IMAGE_MAX_COUNT = 4;
const INLINE_IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_MIME = /^image\//;

/** 从任务结果里挑出图片 URL。 */
function imageUrls(task: TaskResponse | SubmitResponse): string[] {
  const raw = (task as { results?: unknown }).results;
  const results: unknown[] = Array.isArray(raw) ? raw : [];
  const urls: string[] = [];
  for (const r of results) {
    if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") {
      const url = (r as { url: string }).url;
      const ct = (r as { content_type?: string }).content_type;
      // 扩展名判定要容忍 query 与 #fragment；无扩展名的签名 URL 靠 content_type 兜底
      if ((ct && IMAGE_MIME.test(ct)) || /\.(png|jpe?g|webp|gif)([?#]|$)/i.test(url)) urls.push(url);
    }
  }
  return urls;
}

/** 拉取图片并转成 MCP image 内容块（小图直接内联到对话；大图/失败跳过，只留 URL）。best-effort。 */
async function imageContentBlocks(
  task: TaskResponse | SubmitResponse,
): Promise<{ type: "image"; data: string; mimeType: string }[]> {
  const urls = imageUrls(task).slice(0, INLINE_IMAGE_MAX_COUNT);
  const blocks = await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(INLINE_IMAGE_TIMEOUT_MS) });
        if (!res.ok) return null;
        const mimeType = res.headers.get("content-type") ?? "image/png";
        const declared = Number(res.headers.get("content-length"));
        // 先按 content-length 判定，避免为一张必然被丢弃的大图白下载一整遍
        const tooBig = Number.isFinite(declared) && declared > INLINE_IMAGE_MAX_BYTES;
        if (!IMAGE_MIME.test(mimeType) || tooBig) {
          await res.body?.cancel();
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > INLINE_IMAGE_MAX_BYTES) return null;
        return { type: "image" as const, data: buf.toString("base64"), mimeType };
      } catch {
        return null;
      }
    }),
  );
  return blocks.filter((b): b is { type: "image"; data: string; mimeType: string } => b !== null);
}

/** 任务成功且含图片时，在 JSON 文本之外附带图像内容块，供 Claude Desktop 等直接看图。 */
async function taskResult(task: TaskResponse | SubmitResponse, shaped: object, inlineImages: boolean) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: JSON.stringify(shaped, null, 2) },
  ];
  if (inlineImages && task.status === "completed") {
    content.push(...(await imageContentBlocks(task)));
  }
  return { content };
}

/**
 * 示例请求里的占位值。无 default、无 enum 时用尖括号占位符而不是 null——
 * null 看起来像个合法值，照抄提交必然 422；`<number>` 一眼可见必须替换。
 */
function exampleValue(p: ParamSpec): unknown {
  if (p.default !== undefined) return p.default;
  if (p.enum?.length) return p.enum[0];
  switch (p.type) {
    case "string":
      return "<string>";
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${p.type ?? "value"}>`;
  }
}

/** 把 catalog 的 ParamSpec 渲染成紧凑可读的参数说明。 */
function renderParams(specs: ParamSpec[]) {
  return specs.map((p) => ({
    name: p.name,
    type: p.items ? `${p.type ?? "array"}<${p.items}>` : p.type,
    required: p.required,
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.description ? { description: p.description } : {}),
  }));
}

export function registerTools(server: McpServer, client: AihubmaxClient): void {
  // 1. list_models
  server.registerTool(
    "list_models",
    {
      title: "列出可用生成模型",
      description:
        "列出模型。models 里的 model 就是可直接提交的真实 id（来自 GET /v1/models），" +
        "含 veo-3.1[4k]、google/veo-3.1[fast] 这类变体命名——照抄即可提交。" +
        "catalog_only 段是文档中存在但当前 Key 未开通的模型（需开通后才能调用，不要直接提交）。" +
        "media_type=\"llm\" 时改为列出 llm-router 注册表（analyze_media / ask_model 用的模型集，与生成类不同）。" +
        "price 为定价摘要，group_ratios 给出各分组倍率（最终价=基准×倍率）。",
      inputSchema: {
        media_type: z.enum(["image", "video", "audio", "document", "llm"]).optional()
          .describe("按媒体类型过滤；llm 表示改列 llm-router 模型（analyze_media / ask_model 用）"),
        keyword: z.string().optional().describe("按模型名/标题关键词过滤，如 veo、kling、tts"),
        available_only: z.boolean().optional()
          .describe("只要主列表（省略 catalog_only 段）。无法确认可用性时本工具会报错而非静默返回全量"),
      },
    },
    async ({ media_type, keyword, available_only }) => {
      try {
        const kw = keyword?.toLowerCase();
        if (media_type === "llm") {
          const models = await client.listLlmModels();
          const rows = models
            .filter((m) => !kw || `${m.id} ${(m.capabilities ?? []).join(" ")}`.toLowerCase().includes(kw))
            .map((m) => ({ model: m.id, capabilities: m.capabilities ?? null }));
          return json({
            source: "GET /v1/configs/llm_generations_models（llm-router 注册表）",
            note: "这些模型供 analyze_media / ask_model 使用，与生成类模型是两套注册表。",
            total: rows.length,
            models: rows,
          });
        }

        // media_type === "llm" 已在上面提前返回，剩下的必然是 4 个媒体类型之一
        const mediaFilter: MediaType | undefined = media_type;
        const [live, price] = await Promise.all([liveModels(client), pricing(client)]);

        if (!live.ok) {
          // H3：无法确认可用性时，available_only 无法履行，必须报错而不是静默返回全量
          if (available_only) {
            return errorResult(
              new Error(
                `无法确认模型可用性（拉取 /v1/models 失败：${live.error}）。` +
                  `available_only 无法履行，请稍后重试；或去掉 available_only —— 届时返回的是文档目录，` +
                  `其中的裸 family 名（如 veo-3.1）不保证能直接提交。`,
              ),
            );
          }
          const rows = listModelSummaries({ mediaType: mediaFilter, keyword }).map((s) => ({
            model: s.model,
            media_type: s.mediaType,
            title: s.title,
            price: price ? priceSummary(price.models.get(s.model)) : null,
          }));
          return json({
            source: "catalog（文档目录，降级结果）",
            availability_known: false,
            availability_error: live.error,
            note: "拉取 /v1/models 失败，无法确认可用性。此处 model 来自文档，可能是不可直接提交的 family 名，提交前请先重试本工具拿真实 id。",
            pricing_known: price !== null,
            group_ratios: price?.groupRatio ?? null,
            total: rows.length,
            models: rows,
          });
        }

        // 主列表以 live 为准：列出的 id 必然可提交。catalog 只负责补参数说明与标题。
        const mappedCatalogModels = new Set<string>();
        const rows: Record<string, unknown>[] = [];
        let unmappedLive = 0;
        for (const [liveId, lm] of live.models) {
          const r = resolveEntry(liveId);
          if (!r) {
            unmappedLive++;
            continue;
          }
          mappedCatalogModels.add(r.catalogModel);
          if (mediaFilter && r.entry.mediaType !== mediaFilter) continue;
          if (kw && !`${liveId} ${r.entry.title} ${r.entry.summary ?? ""}`.toLowerCase().includes(kw)) continue;
          const variants = normalizeModelId(liveId).variants;
          rows.push({
            model: liveId,
            media_type: r.entry.mediaType,
            title: r.entry.title,
            ...(r.match === "family" ? { catalog_model: r.catalogModel } : {}),
            ...(variants.length ? { variants } : {}),
            price: price ? priceSummary(price.models.get(liveId) ?? price.models.get(r.catalogModel)) : null,
            ...(lm.supported_endpoint_types ? { supported_endpoint_types: lm.supported_endpoint_types } : {}),
          });
        }
        rows.sort((a, b) => String(a.model).localeCompare(String(b.model)));

        // catalog 有、live 无对应 id：文档可见但当前 Key 未开通。
        // 必须排除已被变体命中的 family（如 fabric-1.0 有 fabric-1.0[480p] 在线），否则会误报「不可用」。
        const catalogOnly = listModelSummaries({ mediaType: mediaFilter, keyword })
          .filter((s) => !mappedCatalogModels.has(s.model) && !live.models.has(s.model))
          .map((s) => ({ model: s.model, media_type: s.mediaType, title: s.title }));

        return json({
          source: "GET /v1/models（当前 Key 实际可调用）+ catalog（参数说明）",
          availability_known: true,
          pricing_known: price !== null,
          group_ratios: price?.groupRatio ?? null,
          total: rows.length,
          models: rows,
          ...(available_only
            ? {}
            : {
                catalog_only: {
                  count: catalogOnly.length,
                  note: "文档中存在但当前 Key 未开通，直接提交会 422 model_not_found；需先在控制台开通。",
                  models: catalogOnly,
                },
              }),
          unmapped_live_count: unmappedLive,
          unmapped_live_note:
            "网关可见但 catalog 无对应生成条目的模型数（多为 chat 模型）。LLM 族请用 media_type=\"llm\" 查询。",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 2. describe_model
  server.registerTool(
    "describe_model",
    {
      title: "查看模型参数说明",
      description:
        "返回指定模型的提交端点、必填/可选参数（含类型、枚举、默认值、中文说明）与一个示例请求。生成前用它确认参数，避免 422。",
      inputSchema: {
        model: z.string().describe("模型 id，如 veo-3.1-text-to-video、gpt-image-2"),
      },
    },
    async ({ model }) => {
      try {
        const resolved = resolveEntry(model);
        if (!resolved) {
          return errorResult(
            new Error(`目录中未找到模型 "${model}"。用 list_models 查看可用模型（models 段里的 model 可直接提交）。`),
          );
        }
        const { entry, catalogModel, match } = resolved;
        const params: Record<string, unknown> = {};
        for (const p of entry.paramSpecs) {
          if (p.name === "model") continue;
          if (!p.required) continue;
          params[p.name] = exampleValue(p);
        }
        const [live, price] = await Promise.all([liveModels(client), pricing(client)]);
        const liveModel = live.ok ? live.models.get(model) : undefined;
        const pe = price?.models.get(model) ?? price?.models.get(catalogModel);
        const pricingInfo =
          pe && price
            ? {
                summary: priceSummary(pe),
                quota_type: pe.quota_type === 1 ? "per_call" : pe.quota_type === 0 ? "per_token" : "unknown",
                enable_groups: pe.enable_groups ?? null,
                per_group_usd: perGroupPrice(pe, price.groupRatio),
              }
            : null;
        return json({
          model,
          media_type: entry.mediaType,
          // 端点以 catalog 的 path 为准，与 generate_* 实际提交的地址是同一个来源
          endpoint: `POST ${entry.path}`,
          title: entry.title,
          description: entry.description,
          available: live.ok ? live.models.has(model) : null,
          ...(live.ok ? {} : { availability_error: live.error }),
          ...(match === "family"
            ? {
                catalog_model: catalogModel,
                param_source_note: `参数说明来自 catalog 的 family 条目 "${catalogModel}"；变体 [${normalizeModelId(model).variants.join("|")}] 的专属参数可能未收录。`,
              }
            : {}),
          supported_endpoint_types: liveModel?.supported_endpoint_types ?? null,
          pricing: pricingInfo,
          required_params: entry.requiredParams,
          params: renderParams(entry.paramSpecs),
          // 与 generate_* 的入参形状一致：model 单独传，其余放 params
          example_request: { model, params },
          example_note: "尖括号占位符（如 <number>）必须替换成真实值后再提交。",
          spec_file: `${entry.file}`,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 3-6. generate_{image,video,audio,document}
  const genTool = (
    name: string,
    media: MediaType,
    title: string,
    hint: string,
  ) =>
    server.registerTool(
      name,
      {
        title,
        description:
          `${hint} 先用 describe_model 确认该 model 的参数；model 请用 list_models 返回的真实 id。` +
          (DEFAULT_WAIT[media] > 0
            ? `默认等待 ${DEFAULT_WAIT[media]}s：短任务直接返回结果 URL；超时返回 task_id，用 wait_for_task 续等。`
            : `默认不等待、立即返回 task_id——该类任务通常是分钟级，阻塞等待会撞穿客户端的工具超时，` +
              `导致任务已提交、额度已扣却拿不到 task_id。拿到 task_id 后用 wait_for_task 等结果；确需同步等待可显式传 wait_seconds。`),
        inputSchema: {
          model: z.string().describe("模型 id（用 list_models 返回的真实 id）"),
          params: z.record(z.string(), z.unknown())
            .describe("请求参数对象（不含 model），如 {prompt, aspect_ratio, ...}，见 describe_model"),
          wait_seconds: z.number().int().min(0).max(600).optional()
            .describe(`最长等待秒数，默认 ${DEFAULT_WAIT[media]}，设 0 立即返回 task_id`),
          inline_image: z.boolean().optional()
            .describe("图像成功时是否内联回传图片（默认 true，仅 generate_image 生效；大图自动降级为纯 URL）"),
        },
      },
      async ({ model, params, wait_seconds, inline_image }) => {
        try {
          const extra = params as Record<string, unknown>;
          // params 里混进 model 会与顶层 model 打架：端点按顶层 model 选，body 却可能是另一个模型
          if ("model" in extra && extra.model !== model) {
            return errorResult(
              new Error(
                `params 里的 model（"${String(extra.model)}"）与顶层 model（"${model}"）不一致。` +
                  `params 不应包含 model，请只在顶层传 model。`,
              ),
            );
          }
          const resolved = resolveEntry(model);
          if (resolved?.entry.mediaType && resolved.entry.mediaType !== media) {
            return errorResult(
              new Error(
                `模型 "${model}" 是 ${resolved.entry.mediaType} 类模型，不能用 ${name} 提交，` +
                  `请改用 generate_${resolved.entry.mediaType}。`,
              ),
            );
          }
          // 端点以 catalog 的 path 为准（describe_model 展示的也是它），硬编码表只作兜底
          const path = resolved?.entry.path ?? GEN_PATH[media];
          const body = { ...extra, model };
          const inline = media === "image" && (inline_image ?? true);
          return await submitAndMaybeWait(client, path, body, wait_seconds ?? DEFAULT_WAIT[media], inline);
        } catch (e) {
          return errorResult(e);
        }
      },
    );

  genTool("generate_image", "image", "生成图像", "提交图像生成/编辑任务。");
  genTool("generate_video", "video", "生成视频", "提交视频生成任务（通常耗时较长）。");
  genTool("generate_audio", "audio", "生成音频", "提交音频任务：TTS/音乐/语音识别/语音克隆（Suno 自动走专用端点）。");
  genTool("generate_document", "document", "文档转换", "提交文档处理任务（如 Doc2X：PDF→md/tex/docx）。");

  // 7. get_task
  server.registerTool(
    "get_task",
    {
      title: "查询任务状态与结果",
      description:
        "查询异步任务。wait_seconds>0 时在服务端轮询（每 5s）直到完成或超时。完成后 results 内为结果（图/视频/音频为 {url}，24 小时内有效，请尽快转存）。",
      inputSchema: {
        task_id: z.string().describe("提交生成时返回的 task_id"),
        wait_seconds: z.number().int().min(0).max(600).optional()
          .describe("最长等待秒数，默认 0（立即返回当前状态）"),
        sync_upstream: z.boolean().optional().describe("是否在返回前主动向上游刷新一次状态"),
        inline_image: z.boolean().optional().describe("图像结果是否内联回传（默认 true）"),
      },
    },
    async ({ task_id, wait_seconds, sync_upstream, inline_image }) => {
      try {
        const wait = wait_seconds ?? 0;
        const task =
          wait > 0
            ? await client.pollTask(task_id, wait, sync_upstream ?? false)
            : await client.getTask(task_id, sync_upstream ?? false);
        const shaped = shapeTask(task);
        if (wait > 0 && task.status !== "completed" && task.status !== "failed") {
          return json({ ...shaped, note: `等待 ${wait}s 后仍未完成，可再次调用 get_task 或 wait_for_task 继续等待。` });
        }
        return await taskResult(task, shaped, inline_image ?? true);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 7b. wait_for_task —— 阻塞等待 + 进度通知
  server.registerTool(
    "wait_for_task",
    {
      title: "阻塞等待任务完成",
      description:
        "阻塞等待某个异步任务直到完成/失败或达到单次等待上限。等待期间向支持的客户端发送 MCP 进度通知。达到 timeout_seconds 仍未完成则返回 still-running（含最新状态），可再次调用续等。适合长任务（视频等）。",
      inputSchema: {
        task_id: z.string().describe("要等待的 task_id"),
        timeout_seconds: z.number().int().min(5).max(600).optional()
          .describe("单次等待上限秒数，默认 300"),
        sync_upstream: z.boolean().optional().describe("每次轮询是否主动刷新上游状态"),
        inline_image: z.boolean().optional().describe("图像结果是否内联回传（默认 true）"),
      },
    },
    async ({ task_id, timeout_seconds, sync_upstream, inline_image }, extra) => {
      try {
        const budget = timeout_seconds ?? 300;
        const progressToken = extra?._meta?.progressToken;
        const notify = async (task: TaskResponse) => {
          if (progressToken === undefined) return;
          try {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: task.progress ?? 0,
                total: 100,
                message: `任务 ${task.status}（${task.progress ?? 0}%）`,
              },
            });
          } catch {
            /* 客户端不支持进度通知则忽略 */
          }
        };
        const task = await client.pollTask(task_id, budget, sync_upstream ?? false, notify);
        const shaped = shapeTask(task);
        if (task.status !== "completed" && task.status !== "failed") {
          return json({ ...shaped, wait_result: "still-running", note: `已等待 ${budget}s 仍未完成，可再次调用 wait_for_task 续等。` });
        }
        return await taskResult(task, shaped, inline_image ?? true);
      } catch (e) {
        // 任务已提交（可能已计费），失败时必须把 task_id 交还，否则调用方彻底失去线索
        return errorResult(e, `task_id=${task_id}（任务可能仍在进行，可稍后用 get_task 重新查询）`);
      }
    },
  );

  // 7c. download_asset —— 结果落盘
  server.registerTool(
    "download_asset",
    {
      title: "下载任务产物到本地",
      description:
        "把任务产物或任意 URL 下载到本地磁盘（视频等大文件的显式落盘手段）。传 task_id 时下载其成功结果里的全部 url；或直接传 url。产物 URL 24 小时失效，请及时下载。",
      inputSchema: {
        task_id: z.string().optional().describe("要下载其结果的 task_id（下载全部结果 url）"),
        url: z.string().optional().describe("直接下载的 URL（与 task_id 二选一）"),
        save_dir: z.string().optional().describe("保存目录（默认当前工作目录）；文件名从 URL 推断"),
        save_path: z.string().optional().describe("单文件完整保存路径（仅 url 模式或单结果时生效，优先于 save_dir）"),
      },
    },
    async ({ task_id, url, save_dir, save_path }) => {
      try {
        if ((task_id ? 1 : 0) + (url ? 1 : 0) !== 1) {
          return errorResult(new Error("task_id / url 必须且只能提供一个。"));
        }
        let urls: string[] = [];
        if (url) {
          urls = [url];
        } else {
          const task = await client.getTask(task_id!);
          if (task.status !== "completed")
            return errorResult(new Error(`任务未完成（status=${task.status}），无结果可下载。`));
          urls = (task.results ?? [])
            .map((r) => (r && typeof r === "object" ? (r as { url?: string }).url : undefined))
            .filter((u): u is string => typeof u === "string");
          if (urls.length === 0) return errorResult(new Error("任务结果中没有可下载的 url（可能是非文件类结果）。"));
        }
        const saved: { url: string; path: string; bytes: number }[] = [];
        const failed: { url: string; error: string }[] = [];
        for (let i = 0; i < urls.length; i++) {
          const u = urls[i]!;
          const resolvePath = (contentType: string | null): string => {
            if (save_path && urls.length === 1) return save_path;
            const fname = urlFilename(u, contentType, i);
            return isAbsolute(save_dir ?? "")
              ? join(save_dir!, fname)
              : join(process.cwd(), save_dir ?? "", fname);
          };
          // 单个 url 失败不作废其余：产物 URL 24 小时失效，已下好的必须原样报回
          try {
            const { path, bytes } = await downloadToFile(u, resolvePath);
            saved.push({ url: u, path, bytes });
          } catch (e) {
            failed.push({ url: u, error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (saved.length === 0 && failed.length > 0) {
          return errorResult(new Error(`全部 ${failed.length} 个下载均失败：${failed.map((f) => f.error).join("；")}`));
        }
        return json({
          downloaded: saved.length,
          files: saved,
          ...(failed.length ? { failed_count: failed.length, failed } : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 8. get_credits
  server.registerTool(
    "get_credits",
    {
      title: "查询额度与用量",
      description:
        "查询当前 API Key 的总额度、已用量与剩余额度。数据来自 New API 的计费端点。数值单位为站点展示单位（可能是美元/人民币/tokens，由站点配置决定），字段名沿用 OpenAI 惯例的 _usd 但不代表一定是美元。unlimited=true 表示该 Key 为无限额度。",
      inputSchema: {},
    },
    async () => {
      try {
        const b = await client.getBilling();
        return json({
          total: b.total,
          used: b.used,
          remaining: b.unlimited ? "unlimited" : b.remaining,
          unlimited: b.unlimited,
          hard_limit_raw: b.hardLimit,
          unit_note: "站点展示单位（USD/CNY/tokens 由站点配置决定）",
          unlimited_note:
            "unlimited 由 hard_limit 是否达到 New API 的 sentinel 值 1e8 判定；hard_limit_raw 为原始值，可据此自行判别。",
          access_until: b.accessUntil || null,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 9. upload_file
  server.registerTool(
    "upload_file",
    {
      title: "上传文件获取可用 URL",
      description:
        "把本地文件或远程 URL 转存为 AihubMax 可直接引用的 URL（用于 image-to-video 等需要 image_urls/audio_url 的场景）。三选一：path（本地文件）、url（远程转存）、base64。返回的 url 可填入生成参数。",
      inputSchema: {
        path: z.string().optional().describe("本地文件绝对路径"),
        url: z.string().optional().describe("远程文件 URL（转存到 AihubMax）"),
        base64: z.string().optional().describe("Base64 或 data URL 文件内容"),
        file_name: z.string().optional().describe("文件名（含扩展名），影响 MIME 推断"),
      },
    },
    async ({ path, url, base64, file_name }) => {
      try {
        const provided = [path, url, base64].filter(Boolean).length;
        if (provided !== 1) {
          return errorResult(new Error("path / url / base64 必须且只能提供一个。"));
        }
        let res;
        if (url) {
          res = await client.uploadUrl(url, file_name);
        } else if (path) {
          const info = await stat(path);
          if (info.size > UPLOAD_MAX_BYTES) {
            return errorResult(
              new Error(
                `文件过大（${(info.size / 1048576).toFixed(1)}MB，上限 ${UPLOAD_MAX_BYTES / 1048576}MB）：` +
                  `上传端点只接受 base64 JSON 体，大文件整体进内存会拖垮 server 进程。` +
                  `请改用 url 模式（把文件放到可公网访问的地址后传 url），或先压缩/切分。`,
              ),
            );
          }
          const buf = await readFile(path);
          res = await client.uploadBase64(buf.toString("base64"), file_name ?? basename(path));
        } else {
          res = await client.uploadBase64(base64!, file_name);
        }
        return json({ url: res.url, file_id: res.id, filename: res.filename, size: res.size });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 10. analyze_media —— 媒体理解（LLM 异步族，走 /v1/llm/generations，独立 llm-router 模型注册表）
  server.registerTool(
    "analyze_media",
    {
      title: "媒体理解（图/视频/音频 → 文本）",
      description:
        "用多模态 LLM 分析媒体内容并输出文本（宿主模型自身无法看视频/听音频，此为能力补充）。" +
        "三选一提供 image_urls / video_urls / audio_url（协议自动判别）。" +
        `异步提交：默认等待 ${DEFAULT_LLM_WAIT}s，短任务直接返回 text；长任务（视频/思考模型）超时返回 task_id，用 wait_for_task 取回。` +
        "模型来自 llm-router 注册表（与生成类是两套），用 list_models(media_type=\"llm\") 查可用集与各模型的 capabilities（vision/video/audio 等），据此选模型。",
      inputSchema: {
        model: z.string().describe("llm-router 模型 id（用 list_models(media_type=\"llm\") 查可用集）"),
        prompt: z.string().describe("对媒体的分析指令，如“描述这段视频”“转写这段音频”"),
        image_urls: z.array(z.string()).optional().describe("图片 URL 数组（1–10 张）"),
        video_urls: z.array(z.string()).optional().describe("视频 URL 数组（1–10 个）"),
        audio_url: z.string().optional().describe("单个音频 URL"),
        system_prompt: z.string().optional().describe("系统指令"),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        wait_seconds: z.number().int().min(0).max(600).optional()
          .describe(`最长等待秒数，默认 ${DEFAULT_LLM_WAIT}，设 0 立即返回 task_id`),
      },
    },
    async ({ model, prompt, image_urls, video_urls, audio_url, system_prompt, max_tokens, temperature, wait_seconds }) => {
      try {
        const media = [image_urls?.length ? "image" : null, video_urls?.length ? "video" : null, audio_url ? "audio" : null].filter(Boolean);
        if (media.length !== 1)
          return errorResult(new Error("image_urls / video_urls / audio_url 必须且只能提供一个。"));
        const body: Record<string, unknown> = { model, prompt };
        if (image_urls?.length) body.image_urls = image_urls;
        if (video_urls?.length) body.video_urls = video_urls;
        if (audio_url) body.audio_url = audio_url;
        if (system_prompt) body.system_prompt = system_prompt;
        if (max_tokens !== undefined) body.max_tokens = max_tokens;
        if (temperature !== undefined) body.temperature = temperature;
        return await llmSubmitAndWait(client, body, wait_seconds ?? DEFAULT_LLM_WAIT);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 11. ask_model —— 同步 LLM 对话（二次意见 / 免费模型试用，非主对话通道）
  server.registerTool(
    "ask_model",
    {
      title: "问另一个模型（二次意见）",
      description:
        "调用一个 LLM 做对话，定位为“向另一个模型征询二次意见 / 试用”，不是主对话通道、不支持流式。" +
        `异步提交 + 轮询：默认等待 ${DEFAULT_LLM_WAIT}s，短问答直接返回 text；超时返回 task_id 用 wait_for_task 取回。` +
        "model 用 llm-router 注册表模型（与生成类是两套），用 list_models(media_type=\"llm\") 查可用集。" +
        "传 prompt（单轮）或 messages（多轮，OpenAI 格式）。",
      inputSchema: {
        model: z.string().describe("llm-router 模型 id（用 list_models(media_type=\"llm\") 查可用集）"),
        prompt: z.string().optional().describe("单轮用户输入（与 messages 二选一）"),
        messages: z.array(z.object({ role: z.string(), content: z.string() })).optional()
          .describe("多轮消息（OpenAI 格式，与 prompt 二选一）；用本参数时 system 请写成 messages 的第一条"),
        system: z.string().optional().describe("系统指令（仅 prompt 模式；与 messages 同时传会报错）"),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        wait_seconds: z.number().int().min(0).max(600).optional()
          .describe(`最长等待秒数，默认 ${DEFAULT_LLM_WAIT}，设 0 立即返回 task_id`),
      },
    },
    async ({ model, prompt, messages, system, max_tokens, temperature, wait_seconds }) => {
      try {
        if ((prompt ? 1 : 0) + (messages?.length ? 1 : 0) !== 1)
          return errorResult(new Error("prompt / messages 必须且只能提供一个。"));
        // 之前 messages 模式会静默丢掉 system，调用方无从察觉指令没生效
        if (messages?.length && system)
          return errorResult(
            new Error("messages 模式下 system 不生效，请把系统指令写成 messages 的第一条（role=\"system\"）。"),
          );
        const msgs = messages ?? [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt! },
        ];
        const body: Record<string, unknown> = { model, messages: msgs };
        if (max_tokens !== undefined) body.max_tokens = max_tokens;
        if (temperature !== undefined) body.temperature = temperature;
        return await llmSubmitAndWait(client, body, wait_seconds ?? DEFAULT_LLM_WAIT);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

}
