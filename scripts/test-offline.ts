/**
 * 离线回归测试：不需要 API Key，不产生费用，用本地假网关与假客户端跑。
 *
 * 覆盖的是几条「错了会真金白银出问题」的行为，都曾经是实际缺陷：
 * 重复提交计费请求、轮询超调撞穿客户端超时、大文件整体进内存、
 * 变体模型 id 不可见 / 误报不可用、oneOf 必填项被并集污染。
 *
 * 用法：npm test
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AihubmaxClient, type LiveModel } from "../src/apiClient.js";
import { registerTools, downloadToFile } from "../src/tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail: string): void {
  checks++;
  if (ok) console.log(`  PASS  ${name} — ${detail}`);
  else {
    failures++;
    console.log(`  FAIL  ${name} — ${detail}`);
  }
}

// ---------- 1. 重试分流：非幂等提交不得被重放 ----------
console.log("== 重试策略（H1 / M1 / M3）==");
{
  let hits: Record<string, number> = {};
  let mode = "";
  const srv = createServer((req, res) => {
    const key = `${req.method} ${req.url!.split("?")[0]}`;
    hits[key] = (hits[key] ?? 0) + 1;
    req.resume();
    req.on("end", () => {
      const body = JSON.stringify({ error: { message: "boom" } });
      if (mode === "502") res.writeHead(502, { "content-type": "application/json" }).end(body);
      else if (mode === "429-short")
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(body);
      else if (mode === "429-long")
        res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" }).end(body);
      else if (mode === "html")
        res.writeHead(200, { "content-type": "text/html" }).end("<!DOCTYPE html><html>portal</html>");
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "t1", status: "processing" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const client = new AihubmaxClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "sk-test" });

  mode = "502";
  hits = {};
  await client.getTask("t1").catch(() => {});
  check("GET 遇 502 重试满 4 次", hits["GET /v1/tasks/t1"] === 4, `${hits["GET /v1/tasks/t1"]} 次`);

  hits = {};
  await client.submitGeneration("/v1/videos/generations", { model: "veo-3.1" }).catch(() => {});
  check("提交类 POST 遇 502 只发 1 次（防重复扣费）",
    hits["POST /v1/videos/generations"] === 1, `${hits["POST /v1/videos/generations"]} 次`);

  mode = "429-short";
  hits = {};
  await client.submitGeneration("/v1/images/generations", { model: "x" }).catch(() => {});
  check("POST 遇 429 仍重试（上游明确未受理）",
    hits["POST /v1/images/generations"] === 4, `${hits["POST /v1/images/generations"]} 次`);

  mode = "429-long";
  hits = {};
  const t = Date.now();
  await client.getTask("t2").catch(() => {});
  const el = Date.now() - t;
  check("retry-after 超上限时不重试也不挂死",
    hits["GET /v1/tasks/t2"] === 1 && el < 2000, `${hits["GET /v1/tasks/t2"]} 次，耗时 ${el}ms`);

  mode = "html";
  const e = await client.getTask("t3").then(() => null, (x: Error) => x);
  check("200 非 JSON 给出指向 base URL 的可读错误",
    e?.name === "ApiError" && e.message.includes("AIHUB_BASE_URL"), `${e?.name}: ${e?.message.slice(0, 60)}…`);

  mode = "poll";
  const t2 = Date.now();
  const task = await client.pollTask("t1", 12);
  const el2 = Date.now() - t2;
  check("pollTask 时长有界，不超调（H4）",
    el2 >= 12_000 && el2 < 14_000 && task.status === "processing", `预算 12s，实耗 ${el2}ms`);

  srv.close();
}

// ---------- 2. 流式下载：大文件不进内存 ----------
console.log("\n== 流式下载（H5）==");
{
  const TOTAL_MB = 200;
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": String(TOTAL_MB * 1048576) });
    const chunk = Buffer.alloc(1048576, 0x41);
    let sent = 0;
    const push = () => {
      while (sent < TOTAL_MB) {
        sent++;
        if (!res.write(chunk)) return void res.once("drain", push);
      }
      res.end();
    };
    push();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const out = join(tmpdir(), `aihub-stream-test-${process.pid}.bin`);
  const base = process.memoryUsage().rss;
  let peak = base;
  const mon = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const r = await downloadToFile(`http://127.0.0.1:${port}/big.mp4`, () => out);
  clearInterval(mon);
  const onDisk = (await stat(out)).size;
  await rm(out, { force: true });
  srv.close();
  const growthMB = (peak - base) / 1048576;
  check("字节数完整落盘", r.bytes === TOTAL_MB * 1048576 && onDisk === r.bytes, `${(r.bytes / 1048576).toFixed(0)}MB`);
  check("内存不随文件体积增长", growthMB < TOTAL_MB / 4, `${TOTAL_MB}MB 文件，RSS 仅增 ${growthMB.toFixed(0)}MB`);
}

// ---------- 3. list_models 双列表 ----------
console.log("\n== list_models 双列表（H2 / H3）==");
{
  const mapping = JSON.parse(readFileSync(join(root, "catalog", "mapping.json"), "utf8")) as {
    exact: { live: string }[];
    family: { live: string }[];
  };
  const liveIds = [...mapping.exact.map((r) => r.live), ...mapping.family.map((r) => r.live)];

  class FakeClient extends AihubmaxClient {
    constructor(private readonly liveFails: boolean) {
      super({ baseUrl: "http://127.0.0.1:1", apiKey: "sk-test" });
    }
    override async listLiveModels(): Promise<Map<string, LiveModel>> {
      if (this.liveFails) throw new Error("模拟网络故障");
      return new Map(liveIds.map((id) => [id, { id }]));
    }
    override async getPricing() {
      return { models: new Map(), groupRatio: {} };
    }
  }

  async function harness(liveFails = false) {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, new FakeClient(liveFails));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    return async (args: Record<string, unknown> = {}) => {
      const r = (await mcp.callTool({ name: "list_models", arguments: args })) as {
        content: { text?: string }[];
        isError?: boolean;
      };
      const text = r.content.map((c) => c.text ?? "").join("\n");
      return { isError: !!r.isError, text };
    };
  }

  const call = await harness();
  const j = JSON.parse((await call()).text);
  const ids: string[] = j.models.map((m: { model: string }) => m.model);
  check("变体 id 出现在主列表",
    ids.includes("veo-3.1[4k]") && ids.includes("google/veo-3.1[fast]"),
    `veo-3.1[4k] / google/veo-3.1[fast] 均可见`);

  const co: string[] = j.catalog_only.models.map((m: { model: string }) => m.model);
  check("被变体命中的 family 不再误报未开通",
    !co.includes("fabric-1.0") && !co.includes("fabric-1.0-text"),
    `catalog_only 不含 fabric-1.0 / fabric-1.0-text`);

  const veo = j.models.find((m: { model: string }) => m.model === "veo-3.1[4k]");
  check("变体行标注来源 family 与变体标记",
    veo?.catalog_model === "veo-3.1" && veo?.variants?.includes("4k"),
    JSON.stringify({ catalog_model: veo?.catalog_model, variants: veo?.variants }));

  const callFail = await harness(true);
  const r = await callFail({ available_only: true });
  check("可用性未知时 available_only 报错而非静默返回全量",
    r.isError && r.text.includes("无法确认模型可用性"), r.text.slice(0, 60) + "…");

  const deg = JSON.parse((await callFail({})).text);
  check("降级结果明确标记不可靠",
    deg.availability_known === false && typeof deg.availability_error === "string",
    `availability_known=${deg.availability_known}`);
}

// ---------- 4. oneOf 必填项不取并集 ----------
console.log("\n== oneOf 必填项（M12）==");
{
  const dir = mkdtempSync(join(tmpdir(), "aihub-fixture-"));
  try {
    mkdirSync(join(dir, "openapi", "zh"), { recursive: true });
    writeFileSync(join(dir, "docs.json"), JSON.stringify({ nav: ["openapi/zh/demo.json"] }));
    // 二选一：text-to-video 必填 prompt，image-to-video 必填 image_url，两者互斥
    writeFileSync(
      join(dir, "openapi", "zh", "demo.json"),
      JSON.stringify({
        info: { title: "Demo" },
        paths: {
          "/v1/videos/generations": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          required: ["model", "prompt"],
                          properties: { model: { const: "demo-1.0" }, prompt: { type: "string" } },
                        },
                        {
                          type: "object",
                          required: ["model", "image_url"],
                          properties: { model: { const: "demo-1.0" }, image_url: { type: "string" } },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    execFileSync("npx", ["tsx", join(root, "scripts", "build-catalog.ts")], {
      env: { ...process.env, MINTLIFY_DIR: dir },
      stdio: "pipe",
    });
    const cat = JSON.parse(readFileSync(join(root, "catalog", "catalog.zh.json"), "utf8")) as {
      entries: { models: string[]; requiredParams: string[]; conditionalRequiredParams?: string[] }[];
    };
    const e = cat.entries.find((x) => x.models.includes("demo-1.0"))!;
    check("互斥必填项不进 requiredParams",
      !e.requiredParams.includes("prompt") && !e.requiredParams.includes("image_url"),
      `requiredParams=[${e.requiredParams.join(",")}]（并集实现会是 model,prompt,image_url）`);
    check("互斥必填项落到 conditionalRequiredParams",
      (e.conditionalRequiredParams ?? []).includes("prompt") &&
        (e.conditionalRequiredParams ?? []).includes("image_url"),
      `conditionalRequiredParams=[${(e.conditionalRequiredParams ?? []).join(",")}]`);
    check("所有变体共同必填项仍是 required",
      e.requiredParams.includes("model"), `requiredParams 含 model`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // build-catalog 会覆盖真实产物，用 git 还原
    execFileSync("git", ["checkout", "--", "catalog/catalog.zh.json"], { cwd: root, stdio: "pipe" });
  }
}

console.log(`\n== 离线测试结果：${checks - failures}/${checks} 通过 ==`);
if (failures > 0) console.log(`   ${failures} 项失败`);
process.exitCode = failures > 0 ? 1 : 0;
