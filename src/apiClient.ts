/**
 * api.aihubmax.com HTTP 客户端。
 *
 * 已实测的真实契约（2026-07-16，见 docs/PLAN.md §2）：
 * - 提交生成：POST /v1/{images,videos,audios}/generations、/v1/run/generations（Doc2X）、
 *   /v1/audio/generations（Suno 单数特例）→ 200 返回 {id, object, type, model, status:"pending", usage:{credits_reserved}}
 * - 任务查询：GET /v1/tasks/{id} → {status: pending|processing|completed|failed, progress, results|error}
 * - 文件上传：POST /v1/files/upload/{base64,url} → {id, filename, url, size, created}
 * - 模型清单：GET /v1/models → OpenAI 格式 {data:[{id}]}（当前 key 分组可调用的全部模型）
 * - 错误体：{"error":{"message, type, code}}
 */
import type { Config } from "./config.js";

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface SubmitResponse {
  id: string;
  object?: string;
  type?: string;
  model?: string;
  status: TaskStatus;
  progress?: number;
  usage?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface TaskResponse {
  id: string;
  object?: string;
  type?: string;
  model?: string;
  status: TaskStatus;
  progress?: number;
  results?: unknown[] | null;
  error?: { code?: string; message?: string; type?: string } | null;
  usage?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface LiveModel {
  id: string;
  owned_by?: string;
  supported_endpoint_types?: string[];
}

export interface PricingEntry {
  model_name: string;
  description?: string;
  tags?: string;
  vendor_id?: number;
  quota_type?: number; // 0=按量倍率, 1=按次固定价
  model_ratio?: number;
  model_price?: number; // quota_type=1 时为每次调用 USD 基准价
  completion_ratio?: number;
  enable_groups?: string[];
  supported_endpoint_types?: string[];
}

export interface PricingTable {
  models: Map<string, PricingEntry>;
  groupRatio: Record<string, number>;
}

/** 面向调用方的错误：message 已翻译成可行动的指引。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class AihubmaxClient {
  constructor(private readonly cfg: Config) {}

  /** 底层请求：JSON 收发、429/5xx 指数退避、错误体翻译。 */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    let lastErr: ApiError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        // 网络层错误也退避重试
        lastErr = new ApiError(`网络请求失败：${(e as Error).message}`, 0);
        if (attempt < MAX_RETRIES) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }

      const text = await res.text();
      if (res.ok) {
        return (text ? JSON.parse(text) : {}) as T;
      }

      const err = this.toApiError(res.status, text);
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        lastErr = err;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** attempt);
        continue;
      }
      throw err;
    }
    throw lastErr ?? new ApiError("请求失败", 0);
  }

  private toApiError(status: number, text: string): ApiError {
    let type: string | undefined;
    let code: string | undefined;
    let message = text.slice(0, 400);
    let requestId: string | undefined;
    try {
      const j = JSON.parse(text) as { error?: { message?: string; type?: string; code?: string } };
      if (j.error) {
        message = j.error.message ?? message;
        type = j.error.type;
        code = j.error.code;
        const m = /request_id:\s*([\w-]+)/.exec(message);
        if (m) requestId = m[1];
      }
    } catch {
      /* 非 JSON 错误体，保留原文 */
    }
    return new ApiError(this.hint(status, code, message), status, type, code, requestId);
  }

  /** 把 HTTP 状态翻译成 Agent 可行动的一句话指引。 */
  private hint(status: number, code: string | undefined, message: string): string {
    switch (status) {
      case 401:
        return `认证失败（401）：API Key 无效或缺失。请检查 AIHUBMAX_API_KEY。原始信息：${message}`;
      case 402:
        return `余额不足（402）：请到 AihubMax 控制台充值后重试。原始信息：${message}`;
      case 404:
        return `未找到（404）：${message}`;
      case 422:
        if (code === "model_not_found")
          return `模型不可用（422 ${code}）：该 model 不存在或当前 Key 分组未开通。用 list_models 查看可用模型。原始信息：${message}`;
        if (code === "no_compatible_channel")
          return `暂无可用渠道（422 ${code}）：该模型当前无可用上游渠道（与参数无关），请稍后重试或换一个模型。原始信息：${message}`;
        if (code === "invalid_file_type" || code === "invalid_image_url")
          return `文件/URL 无效（422 ${code}）：请检查传入的图片/文件 URL 是否可访问、格式是否受支持（可先用 upload_file 转存本地文件）。原始信息：${message}`;
        return `参数校验失败（422${code ? " " + code : ""}）：请对照 describe_model 的参数说明修正。原始信息：${message}`;
      case 429:
        return `触发限流（429）：已自动退避重试仍失败，请稍后再试。原始信息：${message}`;
      case 503:
        return `暂无可用渠道（503）：该模型当前无可用上游，请稍后重试或换模型。原始信息：${message}`;
      default:
        return `请求失败（HTTP ${status}${code ? " " + code : ""}）：${message}`;
    }
  }

  // ---- 高层能力 ----

  submitGeneration(path: string, params: Record<string, unknown>): Promise<SubmitResponse> {
    return this.request<SubmitResponse>("POST", path, params);
  }

  getTask(taskId: string, syncUpstream = false): Promise<TaskResponse> {
    const q = syncUpstream ? "?sync_upstream=true" : "";
    return this.request<TaskResponse>("GET", `/v1/tasks/${encodeURIComponent(taskId)}${q}`);
  }

  /** 轮询任务至终态或超时。轮询间隔 5s（与文档建议一致）。 */
  async pollTask(taskId: string, waitSeconds: number, syncUpstream = false): Promise<TaskResponse> {
    const deadline = Date.now() + waitSeconds * 1000;
    let task = await this.getTask(taskId, syncUpstream);
    while (task.status !== "completed" && task.status !== "failed" && Date.now() < deadline) {
      await sleep(5000);
      task = await this.getTask(taskId, syncUpstream);
    }
    return task;
  }

  uploadBase64(fileData: string, fileName?: string): Promise<{ id: string; filename: string; url: string; size: number; created: number }> {
    return this.request("POST", "/v1/files/upload/base64", {
      file_data: fileData,
      ...(fileName ? { file_name: fileName } : {}),
    });
  }

  uploadUrl(url: string, fileName?: string): Promise<{ id: string; filename: string; url: string; size: number; created: number }> {
    return this.request("POST", "/v1/files/upload/url", {
      url,
      ...(fileName ? { file_name: fileName } : {}),
    });
  }

  /** 当前 Key 分组可调用的全部 model id + 端点类型（含 chat 与生成类）。 */
  async listLiveModels(): Promise<Map<string, LiveModel>> {
    const j = await this.request<{ data?: LiveModel[] }>("GET", "/v1/models");
    return new Map((j.data ?? []).map((m) => [m.id, m]));
  }

  /**
   * 平台定价表（公开端点 `/api/pricing`，无需认证）。含每模型定价与分组倍率：
   * - quota_type=1：按次固定价，单价 USD = model_price × group_ratio[group]
   * - quota_type=0：按量计费，透传 model_ratio / completion_ratio（不臆造 $/1M）
   */
  async getPricing(): Promise<PricingTable> {
    const j = await this.request<{
      data?: PricingEntry[];
      group_ratio?: Record<string, number>;
    }>("GET", "/api/pricing");
    const models = new Map<string, PricingEntry>();
    for (const e of j.data ?? []) models.set(e.model_name, e);
    return { models, groupRatio: j.group_ratio ?? {} };
  }

  /**
   * 额度与用量（New API 的 OpenAI 计费兼容端点，sk- key 认证）。
   * - subscription：总额度 = 剩余 + 已用，已按站点展示单位换算（字段名为 *_usd，实际单位由站点配置决定，可能是 USD/CNY/tokens）
   * - usage：已用量，OpenAI 惯例以「分」返回（total_usage = 已用 × 100）
   * UnlimitedQuota 的 token，hard_limit 返回 sentinel 1e8。
   */
  async getBilling(): Promise<{
    total: number;
    used: number;
    remaining: number;
    unlimited: boolean;
    accessUntil: number;
    raw: { subscription: unknown; usage: unknown };
  }> {
    const sub = await this.request<{
      hard_limit_usd?: number;
      soft_limit_usd?: number;
      access_until?: number;
    }>("GET", "/dashboard/billing/subscription");
    const usage = await this.request<{ total_usage?: number }>("GET", "/dashboard/billing/usage");
    const total = sub.hard_limit_usd ?? 0;
    const used = (usage.total_usage ?? 0) / 100;
    const unlimited = total >= 100_000_000;
    return {
      total,
      used,
      remaining: unlimited ? Number.POSITIVE_INFINITY : total - used,
      unlimited,
      accessUntil: sub.access_until ?? 0,
      raw: { subscription: sub, usage },
    };
  }

  /** 文本嵌入（OpenAI 兼容，同步秒回，无异步任务模式）。 */
  createEmbeddings(body: Record<string, unknown>): Promise<{
    data?: { embedding: number[]; index: number }[];
    model?: string;
    usage?: Record<string, unknown>;
  }> {
    return this.request("POST", "/v1/embeddings", body);
  }

  /**
   * LLM 异步生成/理解入口（协议由请求体字段自动判别：prompt=text、image_urls=vision、
   * video_urls=video、audio_url=audio、messages=custom）。异步提交，返回 task；
   * 轮询 /v1/tasks/{id}，results[0] 为 OpenAI ChatCompletion。模型来自 llm-router 注册表。
   */
  llmGenerate(body: Record<string, unknown>): Promise<SubmitResponse> {
    return this.request<SubmitResponse>("POST", "/v1/llm/generations", { ...body, sync: false });
  }

  /** 从 LLM 任务结果里取回助手文本（results[0] 是 ChatCompletion）。 */
  static llmText(task: TaskResponse): { text: string | null; completion: ChatCompletion | null } {
    const cc = (Array.isArray(task.results) ? task.results[0] : null) as ChatCompletion | null;
    return { text: cc?.choices?.[0]?.message?.content ?? null, completion: cc };
  }

  /** llm-router 可用模型（独立于 /v1/models，含能力标签 text/vision/video/audio/file）。 */
  async listLlmModels(): Promise<{ id: string; capabilities?: string[] }[]> {
    const j = await this.request<{ data?: { id: string; capabilities?: string[] }[] }>(
      "GET",
      "/v1/configs/llm_generations_models",
    );
    return j.data ?? [];
  }
}

export interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: { index: number; message?: { role: string; content: string }; finish_reason?: string }[];
  usage?: Record<string, unknown>;
  [k: string]: unknown;
}
