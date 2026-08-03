# aihub-mcp

MCP server for the AihubMax media generation API — <https://docs.aihubmax.com>.

把 AihubMax（`api.aihubmax.com`）的媒体生成能力（图像 / 视频 / 音频 / 文档 + 异步任务体系）封装成 Agent 友好的 MCP server。目标：Agent 拿到一个 `sk-` key 后，能在对话里顺畅地发现模型、生成媒体、拿回结果。

## 工具（13 个）

| 工具 | 作用 |
|---|---|
| `list_models` | 列出模型。主列表来自 `GET /v1/models`，里面的 id 可直接提交；另附 `catalog_only` 段（文档可见但当前 Key 未开通）。`media_type="llm"` 改列 llm-router 注册表 |
| `describe_model` | 查看某模型的端点、参数（类型/枚举/默认/中文说明）、示例、定价 |
| `generate_image` / `generate_audio` / `generate_document` | 提交生成任务，默认等待 45s：短任务直接返回结果 URL，超时返回 task_id；图像成功时内联回传图片 |
| `generate_video` | 提交视频任务，**默认不等待**、立即返回 task_id（视频是分钟级，阻塞等待会撞穿客户端工具超时），再用 `wait_for_task` 取结果 |
| `get_task` | 查询/轮询异步任务到终态 |
| `wait_for_task` | 阻塞等待长任务 + MCP 进度通知；超时返回 still-running 可续等 |
| `download_asset` | 把任务产物或 URL 流式下载到本地磁盘（视频等大文件落盘） |
| `get_credits` | 查询当前 Key 的总额度 / 已用 / 剩余 |
| `upload_file` | 本地文件 / 远程 URL / base64 → 可引用的 URL（i2v 等场景刚需）。本地文件上限 20 MB，更大的请走 `url` 模式 |
| `analyze_media` | 多模态 LLM 分析图/视频/音频 → 文本（宿主模型看不了视频/听不了音频时补位） |
| `ask_model` | 问另一个 LLM（二次意见 / 试用），非主对话通道 |

### 模型 id 用哪个

线上可调用 id 与文档 spec 里的 model 名是两套命名：文档写 `veo-3.1`，网关实际提供的是
`veo-3.1[4k]`、`google/veo-3.1[fast]` 这类变体 id，**裸 family 名不一定能直接提交**。

因此 `list_models` 的 `models` 段直接给线上真实 id，照抄即可提交；`catalog_only` 段列的是
文档中存在但当前 Key 未开通的模型，需要先开通。两套命名的完整对应关系见
[docs/model-mapping.md](docs/model-mapping.md)（由 `scripts/build-mapping.ts` 生成）。

## 快速使用（stdio）

在 MCP 客户端（Claude Code / Claude Desktop / Cursor 等）配置：

```json
{
  "mcpServers": {
    "aihub": {
      "command": "npx",
      "args": ["-y", "github:cookaihq/aihub-mcp"],
      "env": { "AIHUB_API_KEY": "sk-你的key" }
    }
  }
}
```

> 当前走 GitHub 分发（npm 发布后再改为 `"aihub-mcp"`）。仓库 `github:cookaihq/aihub-mcp`；首次拉取时 `npx` 会自动执行 `prepare` 编译。
> 本地开发也可把 `command`/`args` 指向 `node /绝对路径/dist/index.js`，或 `AIHUB_API_KEY=sk-... npm run dev`。

base URL 可用 `AIHUB_BASE_URL` 覆盖。Key 推荐用环境变量 `AIHUB_API_KEY`；也支持
`--api-key sk-...`，但命令行参数会出现在 `ps aux` 里，同机其他用户可见，仅建议本机调试时使用。

## 开发

```bash
npm install
npm run typecheck
npm test                       # 离线回归测试（不需要 Key，不产生费用）
npm run build                  # 输出 dist/

# 目录管道（需要 aihubmax 文档站源码）
MINTLIFY_DIR=/path/to/mintlify npm run build-catalog
AIHUB_API_KEY=sk-... npm run build-mapping    # 重建 catalog ↔ 线上 id 映射表

AIHUB_API_KEY=sk-... npm run verify           # 端到端打真实 API 验收（会产生少量生成费用）
```

## 进度

- [x] **M0** 目录管道：`catalog/catalog.zh.json`（155 端点 / 128 模型 / 每模型完整参数 Schema）
- [x] **M1** 核心 server：11 工具 + stdio + 真实定价（`/api/pricing`）+ 产物三层交付，实测通过
- [x] **M2 能力补齐**：`analyze_media` / `ask_model` 已实现（13 工具全部实测通过）
- [ ] **M2 发布**：文档站集成页、npm 发布、MCP registry（待授权/确认）
- [ ] **M3** 托管模式（Streamable HTTP）
