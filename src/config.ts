/** 运行时配置：API base URL 与 key 的解析（stdio 模式）。 */

export interface Config {
  baseUrl: string;
  apiKey: string;
}

const DEFAULT_BASE_URL = "https://api.aihubmax.com";

/**
 * 解析配置。key 优先级：--api-key 参数 > AIHUB_API_KEY 环境变量。
 * base URL：AIHUB_BASE_URL 环境变量 > 默认 https://api.aihubmax.com。
 */
export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let apiKey = process.env.AIHUB_API_KEY ?? "";
  let baseUrl = process.env.AIHUB_BASE_URL ?? DEFAULT_BASE_URL;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--api-key") apiKey = argv[++i] ?? apiKey;
    else if (a.startsWith("--api-key=")) apiKey = a.slice("--api-key=".length);
    else if (a === "--base-url") baseUrl = argv[++i] ?? baseUrl;
    else if (a.startsWith("--base-url=")) baseUrl = a.slice("--base-url=".length);
  }

  if (!apiKey) {
    throw new Error(
      "缺少 API Key。请设置环境变量 AIHUB_API_KEY=sk-... 或传入 --api-key sk-...",
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
