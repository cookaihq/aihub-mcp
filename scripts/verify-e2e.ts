/**
 * M1 端到端验收：用真实 MCP Client 通过 stdio 连接 server，调用各工具打真实 API。
 * 用法：AIHUBMAX_API_KEY=sk-... tsx scripts/verify-e2e.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.AIHUBMAX_API_KEY;
if (!key) throw new Error("需要 AIHUBMAX_API_KEY");

function textOf(r: { content?: { type: string; text?: string }[]; isError?: boolean }): string {
  const t = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  return (r.isError ? "[isError] " : "") + t;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(root, "src", "index.ts")],
  env: { ...process.env, AIHUBMAX_API_KEY: key },
});

const client = new Client({ name: "verify", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("== tools:", tools.tools.map((t) => t.name).join(", "), "\n");

console.log("== list_models(image, keyword=gemini) ==");
console.log(
  textOf(await client.callTool({ name: "list_models", arguments: { media_type: "image", keyword: "gemini" } }) as any),
  "\n",
);

console.log("== describe_model(gemini-3.1-flash-image-preview) ==");
console.log(
  textOf(await client.callTool({ name: "describe_model", arguments: { model: "gemini-3.1-flash-image-preview" } }) as any).slice(0, 900),
  "\n",
);

console.log("== upload_file(base64 1x1 png) ==");
const up = textOf(
  await client.callTool({
    name: "upload_file",
    arguments: {
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      file_name: "verify.png",
    },
  }) as any,
);
console.log(up, "\n");

console.log("== generate_image(gemini flash, wait 90s) ==");
console.log(
  textOf(
    await client.callTool({
      name: "generate_image",
      arguments: {
        model: "gemini-3.1-flash-image-preview",
        params: { prompt: "a origami red fox on a white background" },
        wait_seconds: 90,
      },
    }) as any,
  ),
  "\n",
);

console.log("== get_credits ==");
console.log(textOf(await client.callTool({ name: "get_credits", arguments: {} }) as any), "\n");

console.log("== 错误路径：generate_image(未知模型) ==");
console.log(
  textOf(
    await client.callTool({
      name: "generate_image",
      arguments: { model: "z-image-turbo", params: { prompt: "x" }, wait_seconds: 0 },
    }) as any,
  ),
  "\n",
);

await client.close();
console.log("== 验证完成 ==");
