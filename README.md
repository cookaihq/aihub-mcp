# aihub-mcp

MCP server for the AihubMax media generation API — <https://docs.aihubmax.com>.

把 AihubMax（`api.aihubmax.com`）的媒体生成能力（图像 / 视频 / 音频 / 文档 + 异步任务体系）封装成 Agent 友好的 MCP server。目标：Agent 拿到一个 `sk-` key 后，能在对话里顺畅地发现模型、生成媒体、拿回结果。

## 工具（14 个）

| 工具 | 作用 |
|---|---|
| `list_models` | 列出生成模型（图/视频/音频/文档），按 media_type/关键词过滤，标注可用性 + 定价摘要 |
| `describe_model` | 查看某模型的端点、参数（类型/枚举/默认/中文说明）、示例、定价 |
| `generate_image` / `generate_video` / `generate_audio` / `generate_document` | 提交生成任务，默认等待 60s：短任务直接返回结果 URL，长任务返回 task_id；图像成功时内联回传图片 |
| `get_task` | 查询/轮询异步任务到终态 |
| `wait_for_task` | 阻塞等待长任务 + MCP 进度通知；超时返回 still-running 可续等 |
| `download_asset` | 把任务产物或 URL 下载到本地磁盘（视频等大文件落盘） |
| `get_credits` | 查询当前 Key 的总额度 / 已用 / 剩余 |
| `upload_file` | 本地文件 / 远程 URL / base64 → 可引用的 URL（i2v 等场景刚需） |
| `analyze_media` | 多模态 LLM 分析图/视频/音频 → 文本（宿主模型看不了视频/听不了音频时补位） |
| `ask_model` | 同步问另一个 LLM（二次意见 / 试用），非主对话通道 |
| `create_embeddings` | 文本向量嵌入（OpenAI 兼容） |

模型 id 有两套命名（文档 spec vs 线上可调用），对应关系见 [docs/model-mapping.md](docs/model-mapping.md)（由 `scripts/build-mapping.ts` 生成）。

## 快速使用（stdio）

在 MCP 客户端（Claude Code / Claude Desktop / Cursor 等）配置：

```json
{
  "mcpServers": {
    "aihub": {
      "command": "npx",
      "args": ["-y", "github:cookaihq/aihub-mcp"],
      "env": { "AIHUBMAX_API_KEY": "sk-你的key" }
    }
  }
}
```

> 当前走 GitHub 分发（npm 发布后再改为 `"aihub-mcp"`）。仓库 `github:cookaihq/aihub-mcp`；首次拉取时 `npx` 会自动执行 `prepare` 编译。
> 本地开发也可把 `command`/`args` 指向 `node /绝对路径/dist/index.js`，或 `AIHUBMAX_API_KEY=sk-... npm run dev`。

Key 也可用 `--api-key sk-...` 传入；base URL 可用 `AIHUBMAX_BASE_URL` 覆盖。

## 开发

```bash
npm install
npm run build-catalog          # 从 mintlify 源码构建 catalog（可用 MINTLIFY_DIR 覆盖路径）
npm run typecheck
npm run build                  # 输出 dist/
AIHUBMAX_API_KEY=sk-... npm run verify   # 端到端打真实 API 验收（会产生少量生成费用）
```

## 进度

- [x] **M0** 目录管道：`catalog/catalog.zh.json`（155 端点 / 128 模型 / 每模型完整参数 Schema）
- [x] **M1** 核心 server：11 工具 + stdio + 真实定价（`/api/pricing`）+ 产物三层交付，实测通过
- [x] **M2 能力补齐**：`analyze_media` / `ask_model` / `create_embeddings` 已实现（14 工具全部实测通过）
- [ ] **M2 发布**：文档站集成页、npm 发布、MCP registry（待授权/确认）
- [ ] **M3** 托管模式（Streamable HTTP）
