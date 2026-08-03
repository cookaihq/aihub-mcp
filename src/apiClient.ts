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

/** 5xx 只对幂等请求重试；429 对两类请求都可重试（上游明确未受理）。 */
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 3;
/** 单次请求默认超时。undici 默认 headers/body 超时约 300s，太长，会让一次工具调用长时间无响应。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** retry-after 采信上限。超过则不再重试，把 429 连同服务端要求的等待时长交给调用方决策。 */
const MAX_RETRY_AFTER_MS = 10_000;
/** 带 deadline 时，剩余不足这个量就不再发起重试。 */
const MIN_RETRY_BUDGET_MS = 1_000;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 轮询间隔（文档建议值）。 */
const POLL_INTERVAL_MS = 5_000;
/** 单次任务查询超时：必须远小于轮询间隔的量级，避免一次卡死吃光整段等待预算。 */
const TASK_QUERY_TIMEOUT_MS = 15_000;
/** 轮询途中允许的连续查询失败次数；超过才放弃整段等待。 */
const MAX_POLL_FAILURES = 3;

/**
 * 重试策略：
 * - idempotent：重试 429、5xx 与全部网络层错误。
 * - non-idempotent：提交类请求（创建计费任务），只重试 429 与「请求体确定未送达」的连接期错误。
 */
export type RetryPolicy = "idempotent" | "non-idempotent";

export interface RequestOptions {
  /** 默认按 method 推断：GET/HEAD/OPTIONS 为 idempotent，其余为 non-idempotent。 */
  retry?: RetryPolicy;
  /** 单次请求超时（ms）。 */
  timeoutMs?: number;
  /** 绝对截止时刻（ms）。到点后不再重试，并收窄单次请求的超时，使总耗时有界。 */
  deadline?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 判断网络层错误是否发生在「请求体尚未发出」的阶段——只有这类错误对非幂等请求也能安全重试。
 *
 * 依据实测（Node 22 / undici）：判据是 cause 链上的 `syscall`，不是 `code`。
 * - 连接被拒：`code=ECONNREFUSED, syscall=connect` → 未发出
 * - DNS 失败：`syscall=getaddrinfo` → 未发出
 * - 发出后被断开：`code=ECONNRESET, syscall=read` → 已发出，重试会重复提交
 */
function isPreSendNetworkError(e: unknown): boolean {
  for (let c = e as { syscall?: string; cause?: unknown } | undefined, depth = 0; c && depth < 4; depth++) {
    if (c.syscall === "connect" || c.syscall === "getaddrinfo") return true;
    c = c.cause as { syscall?: string; cause?: unknown } | undefined;
  }
  return false;
}

/** 从 fetch 的 cause 链上取一条可读的失败原因。 */
function networkCauseDetail(e: unknown): string {
  const parts: string[] = [];
  for (let c = e as { code?: string; syscall?: string; message?: string; cause?: unknown } | undefined, depth = 0; c && depth < 4; depth++) {
    if (c.code) parts.push(c.syscall ? `${c.code}(${c.syscall})` : c.code);
    else if (depth > 0 && c.message) parts.push(c.message);
    c = c.cause as typeof c;
  }
  return parts.length ? parts.join(" ← ") : (e as Error)?.message || String(e);
}

export class AihubmaxClient {
  constructor(private readonly cfg: Config) {}

  /**
   * 底层请求：JSON 收发、超时、按幂等性分流的退避重试、错误体翻译。
   *
   * 重试分流是硬约束：POST /v1/*\/generations 会创建任务并预扣额度，对它重试 5xx
   * 会重复提交、重复计费，且调用方只拿得到最后一个 task_id。
   */
  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const policy: RetryPolicy =
      opts.retry ?? (IDEMPOTENT_METHODS.has(method.toUpperCase()) ? "idempotent" : "non-idempotent");
    let lastErr: ApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const timeoutMs = this.attemptTimeoutMs(opts);
      if (timeoutMs <= 0) {
        throw lastErr ?? new ApiError(`请求超时：已达调用方设定的截止时间（${method} ${path}）。`, 0);
      }

      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        const err = this.toNetworkError(e, method, path, timeoutMs);
        // 非幂等请求只重试确定未送达的连接期错误；超时/连接中断一律不重试，避免重复提交
        const mayRetry = policy === "idempotent" || isPreSendNetworkError(e);
        if (mayRetry && attempt < MAX_RETRIES && this.hasRetryBudget(opts)) {
          lastErr = err;
          await sleep(this.clampToDeadline(500 * 2 ** attempt, opts));
          continue;
        }
        throw err;
      }

      if (res.ok) return this.parseJson<T>(text, res, method, path);

      const err = this.toApiError(res.status, text);
      const retryableStatus =
        res.status === 429 || (policy === "idempotent" && RETRYABLE_5XX.has(res.status));
      if (retryableStatus && attempt < MAX_RETRIES && this.hasRetryBudget(opts)) {
        const backoff = this.backoffMs(res, attempt);
        if (backoff !== null) {
          lastErr = err;
          await sleep(this.clampToDeadline(backoff, opts));
          continue;
        }
      }
      throw err;
    }
    throw lastErr ?? new ApiError("请求失败", 0);
  }

  /** 本次尝试的超时：取默认/调用方指定值与 deadline 剩余量的较小者。 */
  private attemptTimeoutMs(opts: RequestOptions): number {
    const base = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return opts.deadline === undefined ? base : Math.min(base, opts.deadline - Date.now());
  }

  private hasRetryBudget(opts: RequestOptions): boolean {
    return opts.deadline === undefined || opts.deadline - Date.now() > MIN_RETRY_BUDGET_MS;
  }

  private clampToDeadline(ms: number, opts: RequestOptions): number {
    return opts.deadline === undefined ? ms : Math.max(0, Math.min(ms, opts.deadline - Date.now()));
  }

  /** 退避时长；返回 null 表示服务端要求的等待过长，不应重试而应把 429 交还调用方。 */
  private backoffMs(res: Response, attempt: number): number | null {
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000 > MAX_RETRY_AFTER_MS ? null : retryAfter * 1000;
    }
    return 800 * 2 ** attempt;
  }

  private parseJson<T>(text: string, res: Response, method: string, path: string): T {
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      const ct = res.headers.get("content-type") ?? "(无)";
      throw new ApiError(
        `服务端返回了非 JSON 响应（HTTP ${res.status}，content-type=${ct}，${method} ${path}）。` +
          `常见原因：AIHUB_BASE_URL 未指向 API 网关，或中途被代理/门户页面拦截。` +
          `响应前 200 字符：${text.slice(0, 200)}`,
        res.status,
      );
    }
  }

  private toNetworkError(e: unknown, method: string, path: string, timeoutMs: number): ApiError {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return new ApiError(
        `请求超时（${method} ${path}）：${Math.round(timeoutMs / 1000)}s 内未收到完整响应。请稍后重试。`,
        0,
      );
    }
    return new ApiError(`网络请求失败（${method} ${path}）：${networkCauseDetail(e)}`, 0);
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
        return `认证失败（401）：API Key 无效或缺失。请检查 AIHUB_API_KEY。原始信息：${message}`;
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
        return `触发限流（429）：短退避重试后仍被限流（或服务端要求的等待时长过长），请稍后再试。原始信息：${message}`;
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

  getTask(taskId: string, syncUpstream = false, opts?: RequestOptions): Promise<TaskResponse> {
    const q = syncUpstream ? "?sync_upstream=true" : "";
    return this.request<TaskResponse>("GET", `/v1/tasks/${encodeURIComponent(taskId)}${q}`, undefined, opts);
  }

  /**
   * 轮询任务至终态或等待预算用尽。轮询间隔 5s（与文档建议一致）。
   *
   * 时长有界：休眠量按剩余预算收窄，且预算用尽后不再进入下一轮，因此总耗时
   * ≤ waitSeconds + 最后一次查询（≤ TASK_QUERY_TIMEOUT_MS）。调用方据此可以保证
   * 不撞穿 MCP 客户端的工具超时，避免任务已计费却丢掉 task_id。
   *
   * 等待途中的查询失败不作废整段等待：连续失败超过 MAX_POLL_FAILURES 次才抛出。
   */
  async pollTask(
    taskId: string,
    waitSeconds: number,
    syncUpstream = false,
    onPoll?: (task: TaskResponse) => void | Promise<void>,
  ): Promise<TaskResponse> {
    const deadline = Date.now() + waitSeconds * 1000;
    const query = () =>
      this.getTask(taskId, syncUpstream, {
        timeoutMs: TASK_QUERY_TIMEOUT_MS,
        // 允许最后一次查询略微越过等待上限，换取总时长可预测
        deadline: deadline + TASK_QUERY_TIMEOUT_MS,
      });

    // 首次查询失败直接抛出：一次都查不到说明不是瞬时故障
    let task = await query();
    await onPoll?.(task);

    let failures = 0;
    while (task.status !== "completed" && task.status !== "failed") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      try {
        task = await query();
        failures = 0;
      } catch (e) {
        if (++failures > MAX_POLL_FAILURES) throw e;
        continue;
      }
      await onPoll?.(task);
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
