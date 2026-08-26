# @friday-ai-codes/mcp

[Friday AI](https://github.com/friday-ai-codes/friday-ai) 的 MCP（Model Context Protocol）server。把 Friday 的代码索引、Graph RAG、编码计划与 PR / MR 工具暴露给 Cursor / Claude Code / Codex 等 AI 编码助手。

## 配置（一条命令）

在 Friday Web 控制台「个人资料 → 访问令牌」创建 PAT（明文只显示一次），然后：

```bash
npx -y @friday-ai-codes/mcp setup
```

交互式中文向导一条龙：凭证问答 → 自动注册进本机 agent → 连通性测速（延迟 ms 高亮）→ 能力演示（随机介绍一个已索引仓库）。

脚本 / CI 场景用命令式 `init`：

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
| `friday-mcp setup` | 交互式中文向导：凭证 → 注册 → 测速 → 能力演示 |
| `friday-mcp init` | 写入配置（带 `--base-url` / `--token` 为命令式，否则交互式问答） |
| `friday-mcp register [--agent <name>] [--all] [--project]` | 把 friday MCP server 注册进 agent 配置（幂等） |
| `friday-mcp doctor` | 检查配置、注册状态与连通性测速（不回显令牌） |

## 工具集

44 个工具，对应 Friday `/api/mcp/tools/*` 端点：仓库发现、Graph RAG、编码计划与 PR/MR、飞书工作项、交付知识图谱，以及完整的技术蓝图控制链路。蓝图控制器应使用 `get_technical_blueprint` 原样展示 Friday 的问题和 Markdown，逐条用 `answer_blueprint_clarification` 回答，最终用 `approve_technical_blueprint` 提交人类批准；若需退回则用 `request_technical_blueprint_changes`。最终批准要求携带刚读取的 `artifact_version_id` 与 `content_hash`，版本变更会被拒绝，编码任务也只接受仍处于 `confirmed` 的同一版本。

每个工具都带 MCP 标准 `annotations`（中文 `title` 按「阶段 · 动作」分组 + `readOnlyHint` / `idempotentHint` / `openWorldHint` 行为提示）。

配合 [Friday AI skills](https://github.com/friday-ai-codes/skills)（4 个技能：`friday` / `friday-code` / `friday-feishu` / `friday-memory`）使用效果最佳，一键全装：

```bash
npx @friday-ai-codes/skills
```

## License

MIT
