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

71 个工具对应 Friday `/api/mcp/tools/*` 端点，其中包括仓库发现（`route_repositories`）、Graph RAG 检索（`search_rag_chunks`、`find_related_chunks`）、精确文本检索（`grep_repository`）、仓库浏览（`get_repository` / `list_repository_files` / `get_repository_file`）、分析与计划（`analyze_repository` / `create_coding_plan` / `improve_coding_plan`）、执行与 MR（`execute_coding_plan` / `get_coding_execution` / `summarize_branch` / `create_merge_request`）、飞书工作项（`get_feishu_work_item_context` / `create_feishu_technical_plan` / `create_work_item_repo_tasks` / `execute_work_item_repo_tasks`）、学习案例（`create_learning_case` / `search_learning_cases`）、交付知识图谱（`search_delivery_knowledge` / `get_entity_timeline` / `get_related_entities`），以及技术蓝图的定向重试（`get_blueprint_repo_plan` / `retry_blueprint_repo_plan` / `get_blueprint_merge_artifacts` / `retry_blueprint_merge`）、评审发现处置（`resolve_blueprint_finding` / `dismiss_blueprint_finding`）、终审（`approve_technical_blueprint` / `request_technical_blueprint_changes`）与确认交接（`get_confirmed_blueprint_handoff`）。

每个工具都带 MCP 标准 `annotations`（中文 `title` 按「阶段 · 动作」分组 + `readOnlyHint` / `idempotentHint` / `openWorldHint` 行为提示）。

配合 [Friday AI skills](https://github.com/friday-ai-codes/skills)（4 个技能：`friday` / `friday-code` / `friday-feishu` / `friday-memory`）使用效果最佳，一键全装：

```bash
npx @friday-ai-codes/skills
```

## 蓝图轮询节流

服务端对蓝图轮询入口按用户限流，超限时返回 HTTP 429 `throttled`。适配器把重试时长（毫秒）放进工具结果的 `_meta["friday/retry_after_ms"]`，文本内容中也带 `retry_after_ms=…`：优先取响应体的 `retry_after_ms`，其次取 `Retry-After` 头 × 1000，只接受正整数并限制在 1–300000；缺失或无法解析时按 5000 毫秒退避。`structuredContent` 保持与工具 outputSchema 错误分支一致（`error_code` / `http_status` / `retryable` / `run_id`），不新增字段，因此按 outputSchema 校验结果的 MCP SDK 客户端可以正常接收。

`get_blueprint_status`、`get_blueprint_operation` 和其他蓝图诊断工具（`get_blueprint_events`、`get_blueprint_review` 等）在本地按 `(工具, session_id | operation_id | artifact_id)` 节流：下次允许发送的时间为上次发送时刻加上 `poll_after_ms` 与 `retry_after_ms` 中的较大者。提前到达的同键调用不会发往服务端，直接返回 `throttled`，其中 `http_status` 为 `null`，`_meta["friday/retry_after_ms"]` 为剩余毫秒数。

- `poll_after_ms` 为 0 表示已到终态，应停止轮询。
- 同一会话上的改动性工具（审批、退回、重试、仓库确认等）调用成功后，该会话的节流状态立即清除，可以马上查询最新状态。
- 适配器从不自动重发请求，也不在后台轮询。其他工具不受本地节流影响。

## 蓝图交接文件

`get_confirmed_blueprint_handoff` 校验服务端响应与调用参数的四个确认坐标一致、状态为 `confirmed` 且仓库任务非空后，把完整交接包按服务端字节原样写入系统临时目录下的 `friday-mcp-handoffs/`，只向模型返回文件路径、SHA-256、仓库任务数、确认坐标和不含正文的元数据。坐标不一致返回 `handoff_binding_invalid`，目录不属于当前用户或权限不是 0700 返回 `handoff_write_failed`，两种情况都不写文件。目录权限为 0700，文件先以 `wx` + 0600 写入临时文件再原子 `rename`。

每次交接成功写入后会清理该目录中较早的交接文件：

- 只处理该目录的直接子项，且名称必须是本工具生成的 `blueprint-handoff-<artifact>-<version>-<uuid>.json`（或对应的 `.json.tmp`）；其他文件、子目录、符号链接和不属于当前用户的文件一律保留。
- 刚写入的文件永不删除。先删除修改时间超过保留期的文件，再按修改时间从新到旧保留不超过数量上限（含刚写入的文件）；超过 1 小时的孤儿 `.tmp` 文件直接删除。
- 清理失败只在 stderr 输出失败计数，不影响当次交接结果。其他工具不会写盘，也不会触发清理。

| 环境变量 | 默认值 | 取值范围 | 含义 |
| --- | --- | --- | --- |
| `FRIDAY_MCP_HANDOFF_RETENTION_DAYS` | `7` | 1–90 | 交接文件保留天数 |
| `FRIDAY_MCP_HANDOFF_MAX_FILES` | `50` | 1–500 | 目录内最多保留的交接文件数 |

非整数或越界的取值会回落到默认值。

Windows 没有 POSIX 属主与权限位，适配器在 Windows 上不强校验 0700 / 0600 与文件属主，只依赖用户临时目录自身的 ACL 隔离；需要更强隔离时请在 macOS / Linux 上运行。

## License

MIT
