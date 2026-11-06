# @friday-ai-codes/mcp

[Friday AI](https://github.com/friday-ai-codes/friday-ai) 的 MCP（Model Context Protocol）server。把 Friday 的代码索引、Graph RAG、编码计划与 PR / MR 工具暴露给 Cursor / Claude Code / Codex 等 AI 编码助手。

下文命令使用候选版本 `0.7.0`。发布前可在对应的父仓库递归检出后，进入 `mcp/` 运行 `pnpm install --frozen-lockfile && pnpm build`，用 `node dist/cli.js doctor` 检查本地构建。

## 配置（一条命令）

在 Friday Web 控制台「个人资料 → 访问令牌」创建 PAT（明文只显示一次），然后：

```bash
npx -y @friday-ai-codes/mcp@0.7.0 setup
```

交互式中文向导一条龙：凭证问答 → 自动注册进本机 agent → 连通性测速（延迟 ms 高亮）→ 能力演示（随机介绍一个已索引仓库）。

脚本 / CI 场景用命令式 `init`：

```bash
npx -y @friday-ai-codes/mcp@0.7.0 init --base-url https://friday.example.com --token <你的访问令牌>
```

配置写入 `~/.friday/config.json`（权限 0600）。也可以用环境变量 `FRIDAY_BASE_URL` / `FRIDAY_ACCESS_TOKEN` 覆盖。

运行 `npx -y @friday-ai-codes/mcp@0.7.0 doctor` 可查看客户端和服务端版本、契约版本及清单 SHA-256。
`exact` 表示契约完全匹配，`additive` 表示服务端有兼容扩展，两者退出码均为 0。
`incompatible` 会列出缺失或变更的工具并以非零状态退出。
`unauthorized` 表示令牌被拒绝，`manifest_unavailable` 表示部署缺少清单接口，
`network_error` 和 `malformed_manifest` 分别表示网络故障和无效清单。

## 注册到 IDE

一条命令，自动探测已安装的 agent 并幂等注册：

```bash
npx -y @friday-ai-codes/mcp@0.7.0 register
```

- Cursor：写入 `~/.cursor/mcp.json`（`--project` 时写 `./.cursor/mcp.json`）
- Claude Code：执行 `claude mcp add friday -- npx -y @friday-ai-codes/mcp@0.7.0`
- Codex：追加 `[mcp_servers.friday]` 到 `~/.codex/config.toml`

只新增 `friday` 条目，不覆盖既有配置；已注册则跳过。用 `--agent cursor|claude-code|codex`（可重复）指定目标，`--all` 注册全部。

## 命令

| 命令 | 作用 |
| --- | --- |
| `friday-mcp`（无参数） | 启动 stdio MCP server |
| `friday-mcp setup` | 交互式中文向导：凭证 → 注册 → 测速 → 能力演示 |
| `friday-mcp init` | 写入配置（带 `--base-url` / `--token` 为命令式，否则交互式问答） |
| `friday-mcp register [--agent <name>] [--all] [--project]` | 把 friday MCP server 注册进 agent 配置（幂等） |
| `friday-mcp doctor` | 查看注册状态、服务端契约差异及请求耗时 |

## 工具集

55 个工具对应 Friday `/api/mcp/tools/*` 端点，其中包括仓库发现（`route_repositories`）、Graph RAG 检索（`search_rag_chunks`、`find_related_chunks`）、精确文本检索（`grep_repository`）、仓库浏览（`get_repository` / `list_repository_files` / `get_repository_file`）、分析与计划（`analyze_repository` / `create_coding_plan` / `improve_coding_plan`）、执行与 MR（`execute_coding_plan` / `get_coding_execution` / `summarize_branch` / `create_merge_request`）、飞书工作项（`get_feishu_work_item_context` / `create_feishu_technical_plan` / `create_work_item_repo_tasks` / `execute_work_item_repo_tasks`）、学习案例（`create_learning_case` / `search_learning_cases`）、交付知识图谱（`search_delivery_knowledge` / `get_entity_timeline` / `get_related_entities`）。

每个工具都带 MCP 标准 `annotations`（中文 `title` 按「阶段 · 动作」分组 + `readOnlyHint` / `idempotentHint` / `openWorldHint` 行为提示）。

配合 [Friday AI skills](https://github.com/friday-ai-codes/skills)（4 个技能：`friday` / `friday-code` / `friday-feishu` / `friday-memory`）使用效果最佳，一键全装：

```bash
npx @friday-ai-codes/skills
```

## License

MIT
