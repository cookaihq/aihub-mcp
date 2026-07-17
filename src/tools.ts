/** 注册 8 个 MCP 工具到 server。 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

/** 提交生成 + 可选等待。返回精简后的任务视图。 */
async function submitAndMaybeWait(
  client: AihubmaxClient,
  path: string,
  params: Record<string, unknown>,
  waitSeconds: number,
) {
  const submit: SubmitResponse = await client.submitGeneration(path, params);
  if (waitSeconds <= 0 || submit.status === "completed" || submit.status === "failed") {
    return json(shapeTask(submit));
  }
  const task = await client.pollTask(submit.id, waitSeconds);
  const shaped = shapeTask(task);
  if (task.status !== "completed" && task.status !== "failed") {
    return json({ ...shaped, note: `任务仍在进行，已等待 ${waitSeconds}s。用 get_task("${task.id}") 继续查询。` });
  }
  return json(shaped);
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
        },
      },
      async ({ model, params, wait_seconds }) => {
        try {
          const body = { model, ...(params as Record<string, unknown>) };
          const path = media === "audio" ? audioPath(model) : GEN_PATH[media];
          return await submitAndMaybeWait(client, path, body, wait_seconds ?? DEFAULT_WAIT);
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
      },
    },
    async ({ task_id, wait_seconds, sync_upstream }) => {
      try {
        const wait = wait_seconds ?? 0;
        const task =
          wait > 0
            ? await client.pollTask(task_id, wait, sync_upstream ?? false)
            : await client.getTask(task_id, sync_upstream ?? false);
        const shaped = shapeTask(task);
        if (wait > 0 && task.status !== "completed" && task.status !== "failed") {
          return json({ ...shaped, note: `等待 ${wait}s 后仍未完成，可再次调用 get_task 继续等待。` });
        }
        return json(shaped);
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
}
