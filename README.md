# @friday-ai-codes/mcp

[Friday AI](https://github.com/friday-ai-codes/friday-ai) 的 MCP（Model Context Protocol）server。把 Friday 的代码索引、Graph RAG、编码计划与 PR / MR 工具暴露给 Cursor / Claude Code / Codex 等 AI 编码助手。

## 配置

在 Friday Web 控制台「个人资料 → 访问令牌」创建 PAT（明文只显示一次），然后：

```bash
npx -y @friday-ai-codes/mcp init --base-url https://friday.example.com --token <你的访问令牌>
```

配置写入 `~/.friday/config.json`（权限 0600）。也可以用环境变量 `FRIDAY_BASE_URL` / `FRIDAY_ACCESS_TOKEN` 覆盖。

## 注册到 IDE

一条命令，自动探测已安装的 agent 并幂等注册：

```bash
npx -y @friday-ai-codes/mcp register
```

- Cursor：写入 `~/.cursor/mcp.json`（`--project` 时写 `./.cursor/mcp.json`）
- Claude Code：执行 `claude mcp add friday -- npx -y @friday-ai-codes/mcp`
- Codex：追加 `[mcp_servers.friday]` 到 `~/.codex/config.toml`

只新增 `friday` 条目，不覆盖既有配置；已注册则跳过。用 `--agent cursor|claude-code|codex`（可重复）指定目标，`--all` 注册全部。

## 命令

| 命令 | 作用 |
| --- | --- |
| `friday-mcp`（无参数） | 启动 stdio MCP server |
| `friday-mcp init --base-url <url> --token <pat>` | 写入配置并校验连通性 |
| `friday-mcp register [--agent <name>] [--all] [--project]` | 把 friday MCP server 注册进 agent 配置（幂等） |
| `friday-mcp doctor` | 检查配置、连通性与各 agent 注册状态（不回显令牌） |

## 工具集

19 个工具，对应 Friday `/api/mcp/tools/*` 端点：仓库发现（`route_repositories`）、Graph RAG 检索（`search_rag_chunks`、`find_related_chunks`）、仓库浏览（`get_repository` / `list_repository_files` / `get_repository_file`）、分析与计划（`analyze_repository` / `create_coding_plan` / `improve_coding_plan`）、执行与 MR（`execute_coding_plan` / `get_coding_execution` / `summarize_branch` / `create_merge_request`）、飞书工作项（`get_feishu_work_item_context` / `create_feishu_technical_plan` / `create_work_item_repo_tasks` / `execute_work_item_repo_tasks`）、学习案例（`create_learning_case` / `search_learning_cases`）。

配合 [Friday AI skills](https://github.com/friday-ai-codes/skills)（12 个原子技能，含自举的 `friday-setup`）使用效果最佳，一键全装：

```bash
npx skills add friday-ai-codes/skills --skill '*' -g -y
```

## License

MIT
