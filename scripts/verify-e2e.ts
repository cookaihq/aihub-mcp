/**
 * 端到端验收：用真实 MCP Client 通过 stdio 连接 server，调用各工具打真实 API。
 *
 * 会产生少量真实生成费用。每步都有断言，任一步失败即以非 0 退出码结束——
 * 这是 CI gate，不是打印脚本。
 *
 * 用法：AIHUB_API_KEY=sk-... tsx scripts/verify-e2e.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.AIHUB_API_KEY;
if (!key) throw new Error("需要 AIHUB_API_KEY");

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail: string): boolean {
  checks++;
  if (ok) {
    console.log(`  PASS  ${name} — ${detail}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} — ${detail}`);
  }
  return ok;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "src", "index.ts")],
  env: { ...process.env, AIHUB_API_KEY: key },
});

const client = new Client({ name: "verify", version: "0.0.1" });

/** 调用工具并把结果拆成 {isError, text, json}。 */
async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse((r.content ?? []).find((c) => c.type === "text")?.text ?? "");
  } catch {
    /* 错误结果是纯文本，不是 JSON */
  }
  return { isError: !!r.isError, text, json: parsed };
}

/** 成功路径的通用断言：不得是错误结果。 */
function expectOk(name: string, r: { isError: boolean; text: string }): boolean {
  return check(name, !r.isError, r.isError ? `返回 isError：${r.text.slice(0, 160)}` : "调用成功");
}

try {
  await client.connect(transport);

  console.log("== 工具注册 ==");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const expected = [
    "list_models", "describe_model",
    "generate_image", "generate_video", "generate_audio", "generate_document",
    "get_task", "wait_for_task", "download_asset", "get_credits", "upload_file",
    "analyze_media", "ask_model",
  ];
  const missing = expected.filter((t) => !tools.includes(t));
  check("13 个工具全部注册", missing.length === 0, missing.length ? `缺失：${missing.join(", ")}` : tools.join(", "));

  console.log("\n== list_models ==");
  const lm = await call("list_models", { media_type: "image" });
  if (expectOk("list_models(image)", lm)) {
    const models = (lm.json?.models ?? []) as { model: string }[];
    check("返回非空模型列表", models.length > 0, `${models.length} 个模型`);
    check("availability_known 为 true", lm.json?.availability_known === true, String(lm.json?.availability_known));
    check("含 catalog_only 段", lm.json?.catalog_only !== undefined,
      `catalog_only.count=${(lm.json?.catalog_only as { count?: number })?.count}`);
  }

  const lmLlm = await call("list_models", { media_type: "llm" });
  if (expectOk("list_models(llm)", lmLlm)) {
    const models = (lmLlm.json?.models ?? []) as unknown[];
    check("llm-router 注册表非空", models.length > 0, `${models.length} 个模型`);
  }

  console.log("\n== describe_model ==");
  // 用 list_models 主列表里的第一个真实 id，确保 describe 的是可提交的 id
  const firstModel = ((lm.json?.models ?? []) as { model: string }[])[0]?.model;
  if (check("拿到可提交的 model id", !!firstModel, String(firstModel))) {
    const dm = await call("describe_model", { model: firstModel! });
    if (expectOk(`describe_model(${firstModel})`, dm)) {
      check("含 endpoint 与 example_request",
        typeof dm.json?.endpoint === "string" && typeof dm.json?.example_request === "object",
        `endpoint=${dm.json?.endpoint}`);
      check("示例不含 null 占位值",
        !JSON.stringify((dm.json?.example_request as { params?: unknown })?.params ?? {}).includes("null"),
        JSON.stringify((dm.json?.example_request as { params?: unknown })?.params ?? {}).slice(0, 160));
    }
  }

  console.log("\n== upload_file ==");
  const up = await call("upload_file", {
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    file_name: "verify.png",
  });
  if (expectOk("upload_file(base64)", up)) {
    check("返回可用 url", typeof up.json?.url === "string" && String(up.json.url).startsWith("http"), String(up.json?.url));
  }

  console.log("\n== generate_image（会产生真实费用）==");
  const gi = await call("generate_image", {
    model: "gemini-3.1-flash-image-preview",
    params: { prompt: "a origami red fox on a white background" },
    wait_seconds: 90,
  });
  if (expectOk("generate_image", gi)) {
    const status = gi.json?.status;
    check("拿到 task_id", typeof gi.json?.task_id === "string", String(gi.json?.task_id));
    check("任务未失败", status !== "failed", `status=${status}${status === "failed" ? ` error=${JSON.stringify(gi.json?.error)}` : ""}`);
  }

  console.log("\n== get_credits ==");
  const cr = await call("get_credits", {});
  if (expectOk("get_credits", cr)) {
    check("返回额度字段", typeof cr.json?.total === "number", `total=${cr.json?.total}, used=${cr.json?.used}`);
  }

  console.log("\n== 错误路径（应当报错，不是静默通过）==");
  const bad = await call("generate_image", {
    model: "definitely-not-a-real-model-xyz",
    params: { prompt: "x" },
    wait_seconds: 0,
  });
  check("未知模型返回 isError", bad.isError, bad.isError ? bad.text.slice(0, 120) : `竟然成功了：${bad.text.slice(0, 120)}`);

  const conflict = await call("generate_image", {
    model: "gemini-3.1-flash-image-preview",
    params: { model: "another-model", prompt: "x" },
    wait_seconds: 0,
  });
  check("params 内 model 冲突被拦截", conflict.isError && conflict.text.includes("不一致"),
    conflict.isError ? conflict.text.slice(0, 120) : `未拦截：${conflict.text.slice(0, 120)}`);
} finally {
  // 无论成败都要关掉 stdio 子进程，否则脚本抛错时会留下孤儿进程
  await client.close().catch(() => {});
}

console.log(`\n== 验收结果：${checks - failures}/${checks} 通过 ==`);
if (failures > 0) console.log(`   ${failures} 项失败，退出码 1`);
process.exitCode = failures > 0 ? 1 : 0;
