/** 注册 MCP 工具到 server。 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
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
  findEntryByModel,
  listModelSummaries,
  type MediaType,
  type ParamSpec,
} from "./catalog.js";

/** 4 个生成媒体类型 → 提交端点。audio 的 Suno 走单数特例，由 pickAudioPath 处理。 */
const GEN_PATH: Record<MediaType, string> = {
  image: "/v1/images/generations",
  video: "/v1/videos/generations",
  audio: "/v1/audios/generations",
  document: "/v1/run/generations",
};

/** Suno 系列走 /v1/audio/generations（单数），其余音频走 /v1/audios/generations（复数）。 */
function audioPath(model: string): string {
  return /^suno/i.test(model) ? "/v1/audio/generations" : "/v1/audios/generations";
}

const DEFAULT_WAIT = 60;

/** 缓存 /v1/models（TTL 60s），供可用性标注与端点类型。 */
let liveCache: { at: number; models: Map<string, LiveModel> } | null = null;
async function liveModels(client: AihubmaxClient): Promise<Map<string, LiveModel> | null> {
  if (liveCache && Date.now() - liveCache.at < 60_000) return liveCache.models;
  try {
    const models = await client.listLiveModels();
    liveCache = { at: Date.now(), models };
    return models;
  } catch {
    return null; // 拉取失败不阻断 list_models，只是无法标注可用性
  }
}

/** 缓存 /api/pricing（TTL 5min，公开端点），供定价摘要。 */
let priceCache: { at: number; table: PricingTable } | null = null;
async function pricing(client: AihubmaxClient): Promise<PricingTable | null> {
  if (priceCache && Date.now() - priceCache.at < 300_000) return priceCache.table;
  try {
    const table = await client.getPricing();
    priceCache = { at: Date.now(), table };
    return table;
  } catch {
    return null;
  }
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

function errorResult(e: unknown) {
  const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
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
      if ((ct && IMAGE_MIME.test(ct)) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) urls.push(url);
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
        const res = await fetch(url);
        if (!res.ok) return null;
        const mimeType = res.headers.get("content-type") ?? "image/png";
        if (!IMAGE_MIME.test(mimeType)) return null;
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
        "列出 AihubMax 的媒体生成模型（图像/视频/音频/文档）。可按 media_type 或关键词过滤。available=true 表示当前 API Key 分组可直接调用；available=false 表示文档中存在但当前 Key 未开通。price 为定价摘要，group_ratios 给出各分组倍率（最终价=基准×倍率）。",
      inputSchema: {
        media_type: z.enum(["image", "video", "audio", "document"]).optional()
          .describe("按媒体类型过滤"),
        keyword: z.string().optional().describe("按模型名/标题关键词过滤，如 veo、kling、tts"),
        available_only: z.boolean().optional().describe("仅返回当前 Key 可调用的模型"),
      },
    },
    async ({ media_type, keyword, available_only }) => {
      try {
        const summaries = listModelSummaries({ mediaType: media_type as MediaType, keyword });
        const [live, price] = await Promise.all([liveModels(client), pricing(client)]);
        let rows = summaries.map((s) => ({
          model: s.model,
          media_type: s.mediaType,
          title: s.title,
          available: live ? live.has(s.model) : null,
          price: price ? priceSummary(price.models.get(s.model)) : null,
        }));
        if (available_only && live) rows = rows.filter((r) => r.available);
        return json({
          total: rows.length,
          availability_known: live !== null,
          pricing_known: price !== null,
          group_ratios: price?.groupRatio ?? null,
          models: rows,
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
        const entry = findEntryByModel(model);
        if (!entry) {
          return errorResult(
            new Error(`目录中未找到模型 "${model}"。用 list_models 查看可用模型（注意用真实 model id）。`),
          );
        }
        const example: Record<string, unknown> = { model };
        for (const p of entry.paramSpecs) {
          if (p.name === "model") continue;
          if (!p.required) continue;
          example[p.name] =
            p.default ?? (p.enum?.[0]) ?? (p.type === "string" ? "..." : p.type === "array" ? [] : null);
        }
        const [live, price] = await Promise.all([liveModels(client), pricing(client)]);
        const pe = price?.models.get(model);
        const pricingInfo = pe
          ? {
              summary: priceSummary(pe),
              quota_type: pe.quota_type === 1 ? "per_call" : pe.quota_type === 0 ? "per_token" : "unknown",
              enable_groups: pe.enable_groups ?? null,
              per_group_usd: perGroupPrice(pe, price!.groupRatio),
            }
          : null;
        return json({
          model,
          media_type: entry.mediaType,
          endpoint: `POST ${entry.mediaType === "audio" ? audioPath(model) : entry.path}`,
          title: entry.title,
          description: entry.description,
          available: live ? live.has(model) : null,
          supported_endpoint_types: live?.get(model)?.supported_endpoint_types ?? null,
          pricing: pricingInfo,
          required_params: entry.requiredParams,
          params: renderParams(entry.paramSpecs),
          example_request: example,
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
          `${hint} 先用 describe_model 确认该 model 的参数。默认等待 ${DEFAULT_WAIT}s：短任务直接返回结果 URL；长任务超时返回 task_id，用 get_task 继续查询。`,
        inputSchema: {
          model: z.string().describe("模型 id"),
          params: z.record(z.string(), z.unknown())
            .describe("请求参数对象（不含 model），如 {prompt, aspect_ratio, ...}，见 describe_model"),
          wait_seconds: z.number().int().min(0).max(600).optional()
            .describe(`最长等待秒数，默认 ${DEFAULT_WAIT}，设 0 立即返回 task_id`),
          inline_image: z.boolean().optional()
            .describe("图像成功时是否内联回传图片（默认 true，仅 generate_image 生效；大图自动降级为纯 URL）"),
        },
      },
      async ({ model, params, wait_seconds, inline_image }) => {
        try {
          const body = { model, ...(params as Record<string, unknown>) };
          const path = media === "audio" ? audioPath(model) : GEN_PATH[media];
          const inline = media === "image" && (inline_image ?? true);
          return await submitAndMaybeWait(client, path, body, wait_seconds ?? DEFAULT_WAIT, inline);
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
        const deadline = Date.now() + budget * 1000;
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
        let task = await client.getTask(task_id, sync_upstream ?? false);
        await notify(task);
        while (task.status !== "completed" && task.status !== "failed" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          task = await client.getTask(task_id, sync_upstream ?? false);
          await notify(task);
        }
        const shaped = shapeTask(task);
        if (task.status !== "completed" && task.status !== "failed") {
          return json({ ...shaped, wait_result: "still-running", note: `已等待 ${budget}s 仍未完成，可再次调用 wait_for_task 续等。` });
        }
        return await taskResult(task, shaped, inline_image ?? true);
      } catch (e) {
        return errorResult(e);
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
        for (let i = 0; i < urls.length; i++) {
          const u = urls[i]!;
          const res = await fetch(u);
          if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${u}`);
          const buf = Buffer.from(await res.arrayBuffer());
          let outPath: string;
          if (save_path && urls.length === 1) {
            outPath = save_path;
          } else {
            const fname = urlFilename(u, res.headers.get("content-type"), i);
            outPath = isAbsolute(save_dir ?? "") ? join(save_dir!, fname) : join(process.cwd(), save_dir ?? "", fname);
          }
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(outPath, buf);
          saved.push({ url: u, path: outPath, bytes: buf.length });
        }
        return json({ downloaded: saved.length, files: saved });
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
          unit_note: "站点展示单位（USD/CNY/tokens 由站点配置决定）",
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
        "用多模态 LLM 分析媒体内容并输出文本（宿主模型自身无法看视频/听音频，此为能力补充）。三选一提供 image_urls / video_urls / audio_url（协议自动判别）。模型来自 llm-router 注册表（与生成类不同），用支持对应能力的模型（如 gemini-3.1-pro-preview 支持 vision/video/audio）；model 无效时错误会列出可用模型。注意：同步阻塞调用，视频/思考模型可能较慢，若客户端有工具超时限制请留意。",
      inputSchema: {
        model: z.string().describe("llm-router 模型 id，如 gemini-3.1-pro-preview、claude-sonnet-4-6"),
        prompt: z.string().describe("对媒体的分析指令，如“描述这段视频”“转写这段音频”"),
        image_urls: z.array(z.string()).optional().describe("图片 URL 数组（1–10 张）"),
        video_urls: z.array(z.string()).optional().describe("视频 URL 数组（1–10 个）"),
        audio_url: z.string().optional().describe("单个音频 URL"),
        system_prompt: z.string().optional().describe("系统指令"),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
      },
    },
    async ({ model, prompt, image_urls, video_urls, audio_url, system_prompt, max_tokens, temperature }) => {
      try {
        const media = [image_urls?.length ? "image" : null, video_urls?.length ? "video" : null, audio_url ? "audio" : null].filter(Boolean);
        if (media.length !== 1)
          return errorResult(new Error("image_urls / video_urls / audio_url 必须且只能提供一个。"));
        const body: Record<string, unknown> = { model, prompt, sync: true };
        if (image_urls?.length) body.image_urls = image_urls;
        if (video_urls?.length) body.video_urls = video_urls;
        if (audio_url) body.audio_url = audio_url;
        if (system_prompt) body.system_prompt = system_prompt;
        if (max_tokens !== undefined) body.max_tokens = max_tokens;
        if (temperature !== undefined) body.temperature = temperature;
        const r = await client.llmGenerate(body);
        return json({ text: r.choices?.[0]?.message?.content ?? null, model: r.model, usage: r.usage });
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
        "同步调用一个 LLM 做对话，定位为“向另一个模型征询二次意见 / 试用免费模型”，不是主对话通道、不支持流式。model 用标准 chat 模型 id（如 gpt-5-nano、gemini-3.5-flash、deepseek-chat）。传 prompt（单轮）或 messages（多轮，OpenAI 格式）。",
      inputSchema: {
        model: z.string().describe("chat 模型 id"),
        prompt: z.string().optional().describe("单轮用户输入（与 messages 二选一）"),
        messages: z.array(z.object({ role: z.string(), content: z.string() })).optional()
          .describe("多轮消息（OpenAI 格式，与 prompt 二选一）"),
        system: z.string().optional().describe("系统指令（prompt 模式下前置）"),
        max_tokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
      },
    },
    async ({ model, prompt, messages, system, max_tokens, temperature }) => {
      try {
        if ((prompt ? 1 : 0) + (messages?.length ? 1 : 0) !== 1)
          return errorResult(new Error("prompt / messages 必须且只能提供一个。"));
        const msgs = messages ?? [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt! },
        ];
        const body: Record<string, unknown> = { model, messages: msgs };
        if (max_tokens !== undefined) body.max_tokens = max_tokens;
        if (temperature !== undefined) body.temperature = temperature;
        const r = await client.chatCompletion(body);
        return json({ text: r.choices?.[0]?.message?.content ?? null, model: r.model, finish_reason: r.choices?.[0]?.finish_reason, usage: r.usage });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // 12. create_embeddings —— 文本嵌入
  server.registerTool(
    "create_embeddings",
    {
      title: "文本嵌入",
      description:
        "生成文本向量嵌入（OpenAI 兼容）。model 用嵌入模型 id（如 text-embedding-3-small、jina-embeddings-v3）。input 为字符串或字符串数组。",
      inputSchema: {
        model: z.string().describe("嵌入模型 id"),
        input: z.union([z.string(), z.array(z.string())]).describe("待嵌入文本，单条或数组"),
      },
    },
    async ({ model, input }) => {
      try {
        const r = await client.createEmbeddings({ model, input });
        return json({
          model: r.model,
          count: r.data?.length ?? 0,
          dimensions: r.data?.[0]?.embedding?.length ?? null,
          usage: r.usage,
          embeddings: r.data?.map((d) => ({ index: d.index, embedding: d.embedding })),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
