#!/usr/bin/env node
/** AihubMax MCP server — stdio 入口。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AihubmaxClient } from "./apiClient.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new AihubmaxClient(cfg);

  const server = new McpServer({
    name: "aihub-mcp",
    version: "0.0.1",
  });

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 模式下日志必须走 stderr，避免污染协议流
  process.stderr.write("aihub-mcp 已启动（stdio）\n");
}

main().catch((e) => {
  process.stderr.write(`启动失败：${(e as Error).message}\n`);
  process.exit(1);
});
