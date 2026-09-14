/**
 * Friday MCP 工具定义（43 个），与服务端 server/mcp_tools/serializers.py 对齐。
 *
 * 每个工具对应一个 HTTP 端点 POST {baseUrl}/api/mcp/tools/{name}/。
 * inputSchema 为 JSON Schema（MCP 标准），字段约束镜像 DRF serializer。
 * 服务端是校验唯一真源，schema 漂移时以服务端 400 错误为准。
 */

export interface FridayToolAnnotations {
  /** 人类可读短标题（中文，带「阶段 · 动作」分组标注）。 */
  title: string
  /** 只读：不修改任何 Friday / 外部系统状态。 */
  readOnlyHint?: boolean
  /** 破坏性：可能不可逆地删除/覆盖数据（Friday 工具均为非破坏性）。 */
  destructiveHint?: boolean
  /** 幂等：同参重复调用与调用一次效果一致。 */
  idempotentHint?: boolean
  /** 开放世界：会触达 Friday 之外的外部系统（Git 平台 / 飞书）。 */
  openWorldHint?: boolean
}

export interface FridayToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const uuid = (description: string) => ({ type: 'string', format: 'uuid', description })
const str = (description: string) => ({ type: 'string', description })
const int = (description: string, opts: { min?: number, max?: number, default?: number } = {}) => ({
  type: 'integer',
  description,
  ...(opts.min !== undefined ? { minimum: opts.min } : {}),
  ...(opts.max !== undefined ? { maximum: opts.max } : {}),
  ...(opts.default !== undefined ? { default: opts.default } : {}),
})
const bool = (description: string, def?: boolean) => ({
  type: 'boolean',
  description,
  ...(def !== undefined ? { default: def } : {}),
})
const strList = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
})
const dictList = (description: string) => ({
  type: 'array',
  items: { type: 'object' },
  description,
})

export const FRIDAY_TOOLS: FridayToolDefinition[] = [
  {
    name: 'route_repositories',
    description: '根据需求描述路由到最相关的已索引仓库，返回排序后的候选仓库与索引健康度。仓库发现的第一步。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('需求 / 问题描述（<=1000 字符）'),
        top_k: int('返回候选仓库数', { min: 1, max: 10, default: 3 }),
      },
      required: ['query'],
    },
  },
  {
    name: 'search_rag_chunks',
    description: '在指定仓库做 Graph RAG 混合检索（语义 + 关键词 + 图谱扩散），返回相关代码块与关系边。代码证据收集的主力工具。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID（来自 route_repositories / get_repository）'),
        query: str('检索语句（<=1000 字符）'),
        branch: str('分支名，省略用默认分支'),
        top_k: int('召回 chunk 数', { min: 1, max: 50, default: 30 }),
        max_tokens: int('返回内容 token 预算', { min: 1, max: 32000, default: 8000 }),
      },
      required: ['repository_id', 'query'],
    },
  },
  {
    name: 'get_repository',
    description: '查询单个仓库的元数据与索引状态（默认分支、索引健康度等）。',
    inputSchema: {
      type: 'object',
      properties: { repository_id: uuid('仓库 UUID') },
      required: ['repository_id'],
    },
  },
  {
    name: 'list_repository_files',
    description: '列出仓库目录结构（支持分页与递归）。用于浏览项目布局。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID'),
        branch: str('分支名，省略用默认分支'),
        path: str('起始目录路径，默认仓库根'),
        recursive: bool('是否递归列出子目录', false),
        page: int('页码', { min: 1, default: 1 }),
        page_size: int('每页条数', { min: 1, max: 200, default: 50 }),
      },
      required: ['repository_id'],
    },
  },
  {
    name: 'get_repository_file',
    description: '读取仓库内单个文件内容（支持行范围截取）。优先从本地 git 镜像读取完整文件（source="git"，行号精确），镜像不可用时回退索引 chunk 拼接（source="index"）。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID'),
        file_path: str('文件路径（相对仓库根，<=1000 字符）'),
        branch: str('分支名，省略用默认分支'),
        start_line: int('起始行（1-based）', { min: 1 }),
        end_line: int('结束行（>= start_line）', { min: 1 }),
        max_lines: int('最大返回行数', { min: 1, max: 2000, default: 500 }),
      },
      required: ['repository_id', 'file_path'],
    },
  },
  {
    name: 'grep_repository',
    description: '在仓库本地 git 镜像快照上做精确文本检索（ripgrep / git grep，确定性全量结果）。与 search_rag_chunks 的语义召回互补：「穷举所有出现位置」类问题（字面量 / 符号引用 / 跳转路径枚举）必须用这个，语义检索保证不了全量。默认单仓（repository_id）；跨仓需显式 opt-in（repository_ids 数组或 all_repositories=true），结果按仓库分组。默认锁定到与 RAG 索引一致的 commit 快照（matches_index=true）。建议先用 output_mode=files_only 看命中分布，再用 content + context_lines 取关键上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID（单仓检索，来自 route_repositories / get_repository）'),
        repository_ids: strList('跨仓检索的仓库 UUID 列表（<=10 个，显式 opt-in）'),
        all_repositories: bool('对全部已索引仓库检索（显式 opt-in，受 max_repos 限制）', false),
        max_repos: int('跨仓检索的仓库数上限', { min: 1, max: 20, default: 10 }),
        pattern: str('检索模式（<=512 字符）；默认按字面量精确匹配，regex=true 时按正则解释'),
        branch: str('分支名（仅单仓检索可指定），省略用默认分支'),
        regex: bool('是否按正则解释 pattern', false),
        case_sensitive: bool('是否大小写敏感', true),
        paths: strList('限定路径前缀列表（如 "apps/home"，<=10 个）'),
        include_globs: strList('包含 glob 列表（如 "**/*.ts"，<=10 个）'),
        exclude_globs: strList('排除 glob 列表（如 "**/dist/**"，<=10 个）'),
        context_lines: int('每个命中行附带的上下文行数（仅 content 模式生效）', { min: 0, max: 50, default: 0 }),
        max_matches: int('每仓命中行数上限（超出时 truncated=true）', { min: 1, max: 500, default: 100 }),
        output_mode: {
          type: 'string',
          enum: ['content', 'files_only', 'count'],
          default: 'content',
          description: '输出模式：content 命中行+上下文 / files_only 逐文件命中计数（看分布）/ count 仅统计',
        },
        max_tokens: int('content 模式的输出 token 预算（超出截断并置 truncated=true）', { min: 256, max: 32000, default: 8000 }),
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_related_chunks',
    description: '沿代码图谱查找相关代码块（调用 / 被调用 / 导入等关系，1-2 跳扩散）。chunk_id、file_path、symbol_name 三者必须且只能提供一个。用于影响面与调用链分析。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID'),
        branch: str('分支名，省略用默认分支'),
        chunk_id: uuid('起点 chunk UUID（与 file_path / symbol_name 三选一）'),
        file_path: str('起点文件路径（三选一）'),
        symbol_name: str('起点符号名（三选一）'),
        relation_types: strList('关系类型过滤（如 calls / imports），空为全部'),
        hops: int('图谱扩散跳数', { min: 0, max: 2, default: 1 }),
        direction: {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          default: 'both',
          description: '扩散方向：downstream 被依赖方 / upstream 依赖方 / both 双向',
        },
        limit: int('返回上限', { min: 1, max: 50, default: 20 }),
      },
      required: ['repository_id'],
    },
  },
  {
    name: 'reverse_lookup_requirements',
    description: '证据→需求反查：已知代码位置（repository_id + file_path/line 或 chunk_id），反查它关联的需求（related_work_items）、文档（related_documents）与追溯路径（paths）。回答「这段代码是为哪个需求/方案改的」「改这里会影响哪些已交付需求」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID'),
        file_path: str('代码文件路径（相对仓库根；与 chunk_id 二选一）'),
        line: int('行号（1-based，可选，配合 file_path 收窄定位）', { min: 1 }),
        chunk_id: uuid('起点 chunk UUID（与 file_path 二选一）'),
        branch: str('分支名，省略用默认分支'),
      },
      required: ['repository_id'],
    },
  },
  {
    name: 'analyze_repository',
    description: '对仓库做结构化分析（架构、风险、测试建议），可带 focus 聚焦特定主题，返回 analysis_id 供 create_coding_plan 复用证据。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID'),
        branch: str('分支名，省略用默认分支'),
        focus: str('聚焦主题（<=1000 字符），如某个需求或模块'),
        context_chunks: dictList('补充上下文 chunk 列表（来自 search_rag_chunks 结果，<=20 条）'),
        max_files: int('分析文件数上限', { min: 1, max: 200, default: 80 }),
      },
      required: ['repository_id'],
    },
  },
  {
    name: 'create_coding_plan',
    description: '根据需求与代码证据生成结构化编码计划（分步骤、含风险与测试建议），返回 plan_id / version_id。执行编码前的必经步骤。',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: uuid('仓库 UUID'),
        branch: str('分支名，省略用默认分支'),
        requirement: str('需求描述（<=8000 字符）'),
        analysis_id: uuid('analyze_repository 返回的分析 ID（可选，复用证据）'),
        context_chunks: dictList('补充上下文 chunk 列表（<=20 条）'),
        max_steps: int('计划步骤数上限', { min: 1, max: 20, default: 8 }),
      },
      required: ['repository_id', 'requirement'],
    },
  },
  {
    name: 'improve_coding_plan',
    description: '根据反馈修订既有编码计划，生成新版本（返回新 version_id 与 change_summary / risk_delta）。',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: uuid('计划 UUID（来自 create_coding_plan）'),
        feedback: str('修订反馈（<=8000 字符）'),
        context_chunks: dictList('补充上下文 chunk 列表（<=20 条）'),
        max_steps: int('计划步骤数上限', { min: 1, max: 30, default: 10 }),
      },
      required: ['plan_id', 'feedback'],
    },
  },
  {
    name: 'execute_coding_plan',
    description: '在 Friday Runner 的隔离容器中执行已确认的编码计划（Claude Code 实际写代码、跑测试、推分支）。耗时长（默认超时 1 小时），返回 execution_id 供轮询。执行前必须先经用户确认计划内容。',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: uuid('计划 UUID'),
        version_id: uuid('计划版本 UUID（可选，默认最新版本）'),
        branch_name: str('工作分支名（可选，默认自动生成）'),
        target_branch: str('目标分支（可选，默认仓库默认分支）'),
        retry_of_execution_id: uuid('重试来源 execution UUID（可选）'),
        timeout_seconds: int('执行超时秒数', { min: 60, max: 21600, default: 3600 }),
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'get_coding_execution',
    description: '查询编码执行状态与产物（status / commit_sha / file_changes / test_results / last_diff / runner_logs / recovery_state）。执行后轮询与失败诊断用。',
    inputSchema: {
      type: 'object',
      properties: { execution_id: uuid('执行 UUID') },
      required: ['execution_id'],
    },
  },
  {
    name: 'summarize_branch',
    description: '对比分支差异并生成可读摘要与 MR 草稿。提供 execution_id，或同时提供 repository_id + source_branch + target_branch。',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: uuid('执行 UUID（与下三项二选一）'),
        repository_id: uuid('仓库 UUID'),
        source_branch: str('源分支'),
        target_branch: str('目标分支'),
        max_files: int('摘要文件数上限', { min: 1, max: 200, default: 50 }),
      },
    },
  },
  {
    name: 'create_merge_request',
    description: '在 GitHub / GitLab 创建 PR / MR。提供 execution_id，或同时提供 repository_id + source_branch + target_branch。title/description 省略时复用 summarize_branch 草稿。',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: uuid('执行 UUID（与 repository_id 组合二选一）'),
        repository_id: uuid('仓库 UUID'),
        source_branch: str('源分支'),
        target_branch: str('目标分支'),
        title: str('MR 标题（<=200 字符，可选）'),
        description: str('MR 描述（<=20000 字符，可选）'),
        reviewer_usernames: strList('评审人用户名列表（<=20 个）'),
        remove_source_branch: bool('合并后删除源分支', true),
      },
    },
  },
  {
    name: 'get_feishu_work_item_context',
    description: '聚合飞书工作项上下文：字段、关系、关联文档与评论，返回 context_id 供 create_feishu_technical_plan 使用。project_id 与 project_key 至少提供一个。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: uuid('Friday 项目 UUID（与 project_key 二选一）'),
        project_key: str('飞书项目 key（二选一）'),
        work_item_type: { type: 'string', default: 'story', description: '工作项类型，默认 story' },
        work_item_id: int('飞书工作项 ID', { min: 1 }),
        fields: strList('需要拉取的字段列表（<=80 个，空为默认字段）'),
        include_comments: bool('是否包含评论', false),
      },
      required: ['work_item_id'],
    },
  },
  {
    name: 'create_feishu_technical_plan',
    description: '基于工作项上下文与代码证据生成技术方案，可写回飞书文档与评论。返回 technical_plan_id 供建任务 / 执行。',
    inputSchema: {
      type: 'object',
      properties: {
        context_id: uuid('get_feishu_work_item_context 返回的 context UUID'),
        idempotency_key: str('稳定事件 ID（<=128 字符）；超时重试必须复用同一 key，避免重复创建蓝图'),
        blueprint_project_id: uuid('工作项对应的 Friday Project UUID；项目跟踪入口应显式传入以避免 Space 内多项目串线'),
        primary_team: str('可信工作项团队字段的人类可读值；用于 Team hard scope，缺失或歧义时不传并等待澄清'),
        repository_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: '限定仓库 UUID 列表（<=10 个，可选）' },
        repo_hints: strList('仓库提示词（<=20 个，可选，辅助路由）'),
        context_chunks: dictList('补充代码证据 chunk（<=30 条）'),
        similar_cases: dictList('相似历史案例（来自 search_learning_cases，<=20 条）'),
        title: str('方案标题（<=240 字符，可选）'),
        folder_token: str('飞书文档目录 token（可选）'),
        create_document: bool('是否创建飞书文档', true),
        write_comment: bool('是否写回工作项评论', true),
      },
      required: ['context_id'],
    },
  },
  {
    name: 'create_work_item_repo_tasks',
    description: '把技术方案拆解为按仓库划分的任务矩阵（跨仓需求拆分）。',
    inputSchema: {
      type: 'object',
      properties: { technical_plan_id: uuid('技术方案 UUID') },
      required: ['technical_plan_id'],
    },
  },
  {
    name: 'execute_work_item_repo_tasks',
    description: '批量执行技术方案下的仓库任务（派发编码、建 MR、回写飞书）。technical_plan_id 与 task_ids 至少提供一个。耗时长，执行前必须经用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        technical_plan_id: uuid('技术方案 UUID（与 task_ids 二选一）'),
        task_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: '指定任务 UUID 列表（<=20 个，二选一）' },
        create_missing: bool('缺任务时自动补建', true),
        dispatch: bool('是否实际派发编码执行', true),
        create_merge_requests: bool('完成后自动建 MR', true),
        write_back: bool('结果回写飞书', true),
        timeout_seconds: int('单任务超时秒数', { min: 60, max: 21600, default: 3600 }),
        reviewer_usernames: strList('MR 评审人用户名列表（<=20 个）'),
      },
    },
  },
  {
    name: 'create_learning_case',
    description: '把一次技术方案 / 执行的经验沉淀为学习案例（根因、解法、测试），供未来相似需求检索复用。',
    inputSchema: {
      type: 'object',
      properties: {
        technical_plan_id: uuid('技术方案 UUID'),
        outcome: { type: 'string', default: 'unknown', description: '结果标签（如 success / failed / unknown）' },
        root_cause: str('根因记录（<=5000 字符）'),
        solution_notes: str('解法笔记（<=10000 字符）'),
        tests: strList('相关测试列表（<=50 条）'),
      },
      required: ['technical_plan_id'],
    },
  },
  {
    name: 'search_learning_cases',
    description: '检索历史学习案例（按语义 + 仓库 / 文件 / 符号提示），在生成新方案前查相似经验。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('检索语句（<=2000 字符）'),
        work_item_type: str('工作项类型过滤（可选）'),
        repo_hints: strList('仓库提示（<=20 个）'),
        file_hints: strList('文件路径提示（<=50 个）'),
        symbol_hints: strList('符号名提示（<=50 个）'),
        limit: int('返回上限', { min: 1, max: 20, default: 5 }),
      },
    },
  },
  {
    name: 'search_delivery_knowledge',
    description: '在交付知识图谱中检索相似历史需求 / 方案 / 代码变更（向量召回 + 图扩散 + 时间衰减），返回带出处与关联实体的结果。问"以前做过类似需求吗"用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('需求 / 问题描述（<=4000 字符）'),
        top_k: int('返回结果数', { min: 1, max: 20, default: 5 }),
        project_ids: strList('限定项目 ID 列表（<=50 个，可选，只能收窄权限范围）'),
        repository_ids: strList('限定仓库 ID 列表（<=50 个，可选）'),
        entity_kinds: strList('实体类型过滤（work_item / tech_plan / code_change / document，<=20 个，可选）'),
        as_of: str('历史时点查询（ISO8601，可选，如 "2026-05-01T00:00:00+08:00"）'),
        include_superseded: bool('是否包含被取代的旧版本（标注 superseded by vN）', false),
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entity_timeline',
    description: '查询知识实体的完整迭代轨迹：方案 v1→vN 与各次编码按时间排序的时间线（纯版本链，不依赖向量库）。',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: uuid('知识实体 UUID（来自 search_delivery_knowledge 结果）'),
        include_superseded: bool('是否包含被取代的旧版本', false),
        as_of: str('历史时点查询（ISO8601，可选）'),
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'get_related_entities',
    description: '从任一知识实体出发查看关联上下游（需求→方案→代码变更→MR，反向亦可），1-3 跳图遍历。',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: uuid('知识实体 UUID'),
        direction: {
          type: 'string',
          enum: ['both', 'out', 'in'],
          default: 'both',
          description: '遍历方向：out 下游 / in 上游 / both 双向',
        },
        max_hops: int('遍历跳数', { min: 1, max: 3, default: 2 }),
        as_of: str('历史时点查询（ISO8601，可选）'),
      },
      required: ['entity_id'],
    },
  },
  // ── 项目上下文环路（按当前分支召回 → 编码 → 上报，跨分支跨项目通用）──────────
  {
    name: 'lookup_project_by_branch',
    description: '【开工第一步】用当前 git 分支名反查所属 Friday 项目并召回需求/工件/记忆上下文。matched=true 时把返回的 context 当作本次编码的事实依据，并记下 project（含 project_id）供后续 search/grep/read 工具使用；matched=false 时结合 candidates 人工确认，勿臆测。',
    inputSchema: {
      type: 'object',
      properties: {
        branch_name: str('当前 git 分支名（如 feat/xxxx-m123-slug）'),
        repository_id: uuid('仓库 UUID（可选，跨仓同名分支时收窄定位）'),
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'search_project_context',
    description: '在某个 Friday 项目的交付上下文（需求/工件/记忆等实体）里做语义召回。project_id 通常来自 lookup_project_by_branch 的返回。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: uuid('Friday 项目 UUID（来自 lookup_project_by_branch）'),
        query: str('检索语句（<=4000 字符）'),
        top_k: int('返回条数', { min: 1, max: 20, default: 5 }),
        entity_kinds: strList('实体类型过滤（<=20 个，空为全部）'),
      },
      required: ['project_id', 'query'],
    },
  },
  {
    name: 'grep_project',
    description: '在某个 Friday 项目的交付上下文里做关键词精确匹配（与 search_project_context 语义召回互补）。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: uuid('Friday 项目 UUID'),
        query: str('关键词（<=1000 字符）'),
        top_k: int('返回条数', { min: 1, max: 50, default: 10 }),
      },
      required: ['project_id', 'query'],
    },
  },
  {
    name: 'read_project_doc',
    description: '读取项目工作区的单个结构化文档（如 MEMORY / STATE / 调研 / 里程碑 / 预检），返回渲染后的 markdown 与结构块。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: uuid('Friday 项目 UUID'),
        doc_type: str('文档类型（如 memory / state / research / milestone / preflight）'),
      },
      required: ['project_id', 'doc_type'],
    },
  },
  {
    name: 'create_feature_tech_plan',
    description: '【第 1 步 / 共 3 步】由 feature list 发起技术方案生成：判定每个功能点是新增还是改造已有功能，并给出关联仓库建议。**本步不产出方案**，只返回待用户确认的问题（questions）+ 分类结果，status=awaiting_confirmation。必须把 questions 原样呈现给用户、拿到答复后调 confirm_feature_tech_plan 才会继续。取数三选一：project_id（项目已录入的 feature list）/ branch_name（按分支反查项目）/ feature_list_text（直接贴原文）。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: uuid('Friday 项目 UUID（三选一）'),
        branch_name: str('当前 git 分支名（三选一；按已绑定分支反查项目）'),
        repository_id: uuid('仓库 UUID（可选，跨仓同名分支时收窄定位）'),
        feature_list_text: str('feature list 原文（三选一，<=200000 字符）'),
        repository_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: '候选仓库范围收窄（<=20 个，可选；最终选仓仍须用户确认）' },
      },
      required: [],
    },
  },
  {
    name: 'confirm_feature_tech_plan',
    description: '【第 2 步 / 共 3 步】提交用户对关联仓库与功能点分类的确认答复，继续编排。answers 为 [{question_id, selected, freeform_text}]；未覆盖的题按推荐值兜底。返回 status=researching（调研在途，去轮询 get_feature_tech_plan）或 completed（方案已出）。严禁在未向用户展示 questions、未取得真实答复的情况下调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: uuid('create_feature_tech_plan 返回的会话 UUID'),
        answers: dictList('确认答复 [{question_id, selected, freeform_text}]（<=20 条；留空表示全部按推荐执行）'),
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_feature_tech_plan',
    description: '【第 3 步 / 共 3 步】查询方案状态并推进编排。调研阶段是异步的，须轮询本工具直到 status=completed，此时 markdown 字段即完整技术方案（整体方案 + 分仓方案 + 落点文件 + 伪代码），plan 为结构化 MergedPlan。status=failed 时读 error。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: uuid('方案会话 UUID'),
      },
      required: ['session_id'],
    },
  },
  {
    name: 'report_project_knowledge',
    description: '【收工后】把本次产生的、对团队有价值的方案决策/经验教训沉淀回 Friday 项目记忆。不写死项目：传 branch_name 即可按当前分支自动定位唯一项目（也可显式传 project_id）。内容经服务端脱敏+质量门槛+审计回滚兜底。绝不上报任何凭证/密钥/token/个人敏感信息。',
    inputSchema: {
      type: 'object',
      properties: {
        content: str('提炼后的沉淀内容（<=20000 字符）'),
        branch_name: str('当前 git 分支名（与 project_id 二选一；按分支自动定位项目）'),
        project_id: uuid('Friday 项目 UUID（与 branch_name 二选一）'),
        repository_id: uuid('仓库 UUID（可选，跨仓同名分支时收窄定位）'),
        source_conversation_id: uuid('来源会话 UUID（可选）'),
        writeback_mode: { type: 'string', enum: ['draft', 'active'], default: 'draft', description: 'draft 入草稿待确认 / active 直写生效（IDE 自动沉淀）' },
        target: { type: 'string', enum: ['memory', 'research'], default: 'memory', description: '写入目标层' },
        distill: bool('入库前是否经 LLM 精炼', false),
      },
      required: ['content'],
    },
  },
  {
    name: 'report_project_state',
    description: '【收工后】把本次新增/改动的 API 结构化清单回写 Friday 项目 STATE。不写死项目：传 branch_name 即可按当前分支自动定位唯一项目（也可显式传 project_id）。',
    inputSchema: {
      type: 'object',
      properties: {
        apis: dictList('API 清单（每项 {method, path, params?, status?}，<=200 条）'),
        branch_name: str('当前 git 分支名（与 project_id 二选一）'),
        project_id: uuid('Friday 项目 UUID（与 branch_name 二选一）'),
        repository_id: uuid('仓库 UUID（可选，跨仓同名分支时收窄定位）'),
      },
      required: ['apis'],
    },
  },
  {
    name: 'get_technical_blueprint',
    description: '【蓝图取件】按 artifact_id 续取技术蓝图：返回当前状态 current_status、六段摘要 sections（repo_associations / current_state_analysis / implementation_overview / api_contracts / impact_analysis / interaction_flows，每段 {count, titles}）、完整 markdown（未确认的蓝图首行带「未经确认」标注）与待澄清清单 pending_clarifications。蓝图开关打开时 create_feishu_technical_plan 立即回 status=partial + blueprint_artifact_id，之后轮询本工具取件；pending_clarifications 非空时先逐条调 answer_blueprint_clarification 作答，再回来续取终稿。⛔ 没有单独的待澄清列表工具——清单内联在本工具响应里。',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: str('蓝图 artifact ID（<=64 字符；取自 create_feishu_technical_plan 的 blueprint_artifact_id）'),
      },
      required: ['artifact_id'],
    },
  },
  {
    name: 'get_confirmed_blueprint_handoff',
    description: '【蓝图交接取件】按 technical_plan_id、artifact_id、artifact_version_id 与 content_hash 四个确认坐标，只读取得 Friday 已确认蓝图的 canonical_content、完整 Markdown 和结构化 repository_tasks。服务端逐项核对当前 confirmed 版本，任一坐标漂移立即拒绝；不创建版本、不改状态、不触发编码。完整响应由 MCP 原样落本机文件，只向模型返回文件路径与摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        technical_plan_id: uuid('技术方案 UUID（确认蓝图时返回）'),
        artifact_id: str('蓝图 artifact ID（确认蓝图时返回）'),
        artifact_version_id: str('已确认的蓝图版本 ID'),
        content_hash: str('已确认版本的 64 位小写 SHA-256 内容哈希'),
      },
      required: ['technical_plan_id', 'artifact_id', 'artifact_version_id', 'content_hash'],
    },
  },
  {
    name: 'answer_blueprint_clarification',
    description: '【蓝图作答】对 get_technical_blueprint 返回的单条待澄清线程作答，服务端同请求回灌蓝图并返回 reflow（新版本号与冲突块）。逐条调用：一次只答一个 thread_id，答完再调 get_technical_blueprint 续取终稿。必须先把澄清题原样呈现给用户、拿到真实答复再调。⛔ 不能对 AI 评审 finding 线程作答（一律 400 not_answerable，线程状态一字不变）；蓝图已确认（不可编辑）时一律 400 not_editable。',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: str('待澄清线程 ID（<=64 字符；取自 pending_clarifications）'),
        body: str('作答正文（用户的真实答复）'),
        artifact_id: str('蓝图 artifact ID（可选，仅作二次校验：传了就必须与线程实际归属一致）'),
      },
      required: ['thread_id', 'body'],
    },
  },
  {
    name: 'read_blueprint_context',
    description: '【容器内】读取本蓝图会话的共享上下文总线：拉取并行仓容器已写入的接口契约 / 现状结论 / 决策，避免各仓重复调研或按臆测的接口续作。目标会话由任务 token 服务端解析，⛔ 无任何会话入参（结构上读不到别人的会话）。轮询时把上次返回的 max_seq 作 since_seq 传回即可只取新增条目；无参调用 = 拉本会话全部 active 条目。',
    inputSchema: {
      type: 'object',
      properties: {
        key_prefix: str('按条目 key 前缀过滤（<=200 字符，可选；如 repo:{repository_id}.）'),
        kind: { type: 'string', enum: ['finding', 'api_surface', 'contract', 'decision', 'dependency_claim', 'question'], description: '按条目类型过滤（可选，留空不过滤）' },
        repository_id: str('按产出仓过滤（<=64 字符，可选）'),
        since_seq: int('增量游标：只取 seq 大于该值的条目（传上次返回的 max_seq）', { min: 0, default: 0 }),
        limit: int('单次返回条目数上限', { min: 1, max: 200, default: 50 }),
      },
      required: [],
    },
  },
  {
    name: 'report_blueprint_context',
    description: '【容器内】把本仓产出的接口契约 / 关键现状 / 决策写入本蓝图会话的共享上下文总线，写入即对所有并行仓容器可见，并唤醒在等这个 key 的仓续作。目标会话由任务 token 服务端解析，⛔ 无任何会话入参。repository_id 一律由服务端权威覆写（请求体上报值不采信），且 repo: 前缀的 key 必须属于本仓，否则 403 key_not_owned。content 必须是 JSON 对象（不接受数组/标量），入库前递归脱敏——⛔ 绝不写入任何凭证/密钥/token。',
    inputSchema: {
      type: 'object',
      properties: {
        key: str('条目键（<=200 字符；跨仓契约用 repo:{repository_id}.api_surface 这类前缀，须属于本仓）'),
        kind: { type: 'string', enum: ['finding', 'api_surface', 'contract', 'decision', 'dependency_claim', 'question'], description: '条目类型' },
        repository_id: str('产出仓 UUID（可选；服务端权威覆写，保留仅为兼容老镜像）'),
        content: { type: 'object', description: '条目正文（必须是 JSON 对象，嵌套 <=32 层；入库前递归脱敏）' },
      },
      required: ['key', 'kind', 'content'],
    },
  },
  // ── 蓝图环节单跑（stage sandbox）：路由 / 规格 / 调研可基于上游产物单独跑 ────────
  {
    name: 'route_blueprint_repos',
    description: '【环节单跑】三分量蓝图仓库路由（能力树 + 仓库章程 + 历史落点融合，与正式技术方案编排同源）。区别于粗版 route_repositories：返回逐候选 breakdown 证据与 role_suggestion；项目有手动绑定仓库时默认按绑定固定路由（router_version=project_binding），传 ignore_pin=true 可绕过绑定看自动路由的真实输出。dry-run 零落库——结果只是提案，采纳与否由用户经 apply_repo_association 决定。',
    inputSchema: {
      type: 'object',
      properties: {
        requirement_text: str('需求原文（<=8000 字符；与 requirement_spec 至少给一个）'),
        requirement_spec: { type: 'object', description: '上游产物 requirement_spec（含 goal / feature_points，可来自 generate_requirement_spec 输出）' },
        project_id: uuid('Friday 项目 UUID（可选：用于候选范围与固定路由 pin 解析）'),
        include_repository_ids: strList('显式候选仓库 UUID 列表（<=50 个，可选；缺省按项目空间仓库集，再缺省全库）'),
        exclude_repository_ids: strList('排除仓库 UUID 列表（<=50 个，可选）'),
        ignore_pin: bool('是否绕过项目手动绑定的固定路由短路（对比人工绑定 vs 自动路由）', false),
        top_k: int('候选数上限', { min: 1, max: 10, default: 5 }),
      },
      required: [],
    },
  },
  {
    name: 'generate_requirement_spec',
    description: '【环节单跑】需求规格生成：需求原文 → 功能点拆分（LLM，或直接采用传入的 feature_points）→ intent 分类补齐 → 四维歧义打分（目标/边界/约束/验收）。返回 requirement_spec（可直接作 route_blueprint_repos / start_repo_research 的上游输入）与 ambiguity 报告（含澄清问题清单——单跑不开澄清线程，问题直接返回，补答后经 prior_context 重跑）。dry-run 零落库。',
    inputSchema: {
      type: 'object',
      properties: {
        requirement_text: str('需求原文（<=20000 字符）'),
        feature_points: dictList('直采功能点列表（每项 {title, intent?, module?, layer?}，<=200 条；非空即跳过 LLM 拆分）'),
        prior_context: str('已答澄清结论（<=8000 字符，可选；重跑时把上一轮问题的答复拼进来）'),
        assumptions_tier: { type: 'string', enum: ['strict', 'balanced', 'assume_more'], description: '歧义判定档位（可选，缺省 balanced）' },
        classify_intents: bool('是否对缺 intent 的功能点跑 LLM 分类', true),
      },
      required: ['requirement_text'],
    },
  },
  {
    name: 'start_repo_research',
    description: '【环节单跑】对显式仓库集发起沙箱调研（复用技术方案编排的调研链）：role=direct 的仓起隔离容器深调研（评估适配度 fitness、调研现状，约数分钟到 30 分钟），role=indirect 的仓服务端轻量合成；无在线 runner 时深调研自动降级轻量合成（degraded=true）。返回 session_id 供 get_repo_research 轮询。结果只是提案，不会写回项目关联仓库或技术方案。',
    inputSchema: {
      type: 'object',
      properties: {
        requirement_text: str('需求原文（<=20000 字符）'),
        requirement_spec: { type: 'object', description: '上游 requirement_spec（可选，来自 generate_requirement_spec；提供后调研 prompt 按功能点展开）' },
        project_id: uuid('Friday 项目 UUID（可选：调研容器按项目手动绑定分支 checkout）'),
        repositories: dictList('调研仓库列表（每项 {repository_id, role?: direct|indirect, confidence?: high|medium|low}，<=10 个）'),
      },
      required: ['requirement_text', 'repositories'],
    },
  },
  {
    name: 'get_repo_research',
    description: '【环节单跑】轮询沙箱调研结果：逐仓任务状态（pending/running/done/failed）与结构化调研结论（research_summary / fitness / findings / proposed_changes 等）。all_terminal=true 表示全部任务终态。仅会话创建者可读。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: uuid('start_repo_research 返回的沙箱会话 UUID'),
      },
      required: ['session_id'],
    },
  },
  {
    name: 'apply_repo_association',
    description: '【采纳写回】把用户选定的仓库集绑定/解绑到项目（ProjectBranch，source=manual；绑定后会固定后续技术方案路由）。这是环节单跑家族唯一的写回路径——route_blueprint_repos / start_repo_research 的结果永远只是提案，必须把候选清单呈现给用户、拿到明确裁决后才调本工具。branch_name 缺省取仓库默认分支；仅项目成员可调（非成员 403）。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: uuid('Friday 项目 UUID'),
        action: { type: 'string', enum: ['bind', 'unbind'], default: 'bind', description: 'bind 绑定 / unbind 解绑' },
        bindings: dictList('仓库清单（每项 {repository_id, branch_name?}，<=20 个；branch_name 缺省取仓库默认分支）'),
      },
      required: ['project_id', 'bindings'],
    },
  },
]

// ---------------------------------------------------------------------------
// 工具注解（MCP annotations）：按「阶段 · 动作」分组的中文短标题 + 行为提示。
//
// 三档行为画像：
// - 查询类：readOnly + idempotent（route/get/list/search/find/timeline/related）
// - 生成类：写 Friday 内部记录但非破坏、不触达外部（analyze/create_plan/
//   improve_plan/summarize/learning_case/technical_plan/repo_tasks）
// - 执行类：触达外部系统——推分支、建 MR、回写飞书（openWorld）
// ---------------------------------------------------------------------------

const query = (title: string): FridayToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})
const generator = (title: string): FridayToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
})
const executor = (title: string): FridayToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
})

export const TOOL_ANNOTATIONS: Record<string, FridayToolAnnotations> = {
  // 仓库发现
  route_repositories: query('仓库 · 路由发现'),
  get_repository: query('仓库 · 元数据与索引状态'),
  list_repository_files: query('仓库 · 目录浏览'),
  get_repository_file: query('仓库 · 读取文件'),
  // 分析
  search_rag_chunks: query('分析 · GraphRAG 混合检索'),
  grep_repository: query('分析 · 精确文本检索（grep）'),
  find_related_chunks: query('分析 · 图谱关系扩散'),
  reverse_lookup_requirements: query('分析 · 代码反查需求'),
  analyze_repository: generator('分析 · 结构化仓库分析'),
  // 计划
  create_coding_plan: generator('计划 · 生成编码计划'),
  improve_coding_plan: generator('计划 · 修订编码计划'),
  // 执行与交付
  execute_coding_plan: executor('执行 · 运行编码计划（长耗时，需用户确认）'),
  get_coding_execution: query('执行 · 查询执行状态与产物'),
  summarize_branch: generator('交付 · 分支摘要与 MR 草稿'),
  create_merge_request: executor('交付 · 创建 PR/MR'),
  // 飞书闭环
  get_feishu_work_item_context: {
    title: '飞书 · 聚合工作项上下文',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true, // 读取飞书外部系统
  },
  create_feishu_technical_plan: executor('飞书 · 生成技术方案并回写'),
  create_work_item_repo_tasks: generator('飞书 · 拆解多仓任务矩阵'),
  execute_work_item_repo_tasks: executor('飞书 · 批量执行与回写（长耗时，需用户确认）'),
  // 记忆与知识
  create_learning_case: generator('记忆 · 沉淀学习案例'),
  search_learning_cases: query('记忆 · 检索学习案例'),
  search_delivery_knowledge: query('知识 · 交付知识检索'),
  get_entity_timeline: query('知识 · 实体版本时间线'),
  get_related_entities: query('知识 · 关联实体遍历'),
  // 项目上下文环路
  lookup_project_by_branch: query('项目 · 按分支召回上下文（开工第一步）'),
  search_project_context: query('项目 · 上下文语义检索'),
  grep_project: query('项目 · 上下文关键词检索'),
  read_project_doc: query('项目 · 读取工作区文档'),
  report_project_knowledge: generator('项目 · 上报沉淀记忆（收工）'),
  report_project_state: generator('项目 · 回写 API 状态清单（收工）'),
  // feature list 技术方案（两段式：create 必须配 confirm，单次调用拿不到方案）
  create_feature_tech_plan: generator('方案 · 发起 feature list 技术方案（出待确认项）'),
  confirm_feature_tech_plan: generator('方案 · 确认关联仓库与分类并继续'),
  get_feature_tech_plan: query('方案 · 查询状态 / 取回完整方案'),
  // 蓝图异步澄清协议（立即回 pending → 逐条作答 → 续取终稿；⛔ 无第三个 list 工具）
  get_technical_blueprint: query('蓝图 · 续取终稿与待澄清清单'),
  get_confirmed_blueprint_handoff: query('蓝图 · 读取已确认交接包'),
  answer_blueprint_clarification: generator('蓝图 · 逐条作答澄清'),
  // 蓝图共享上下文总线（容器内：会话由任务 token 解析，无会话入参）
  read_blueprint_context: query('蓝图 · 读共享上下文总线'),
  report_blueprint_context: generator('蓝图 · 写共享上下文总线'),
  // 蓝图环节单跑（stage sandbox）：dry-run 提案面 + 唯一采纳写回
  route_blueprint_repos: query('环节 · 三分量仓库路由单跑（dry-run）'),
  generate_requirement_spec: query('环节 · 需求规格与歧义打分单跑（dry-run）'),
  start_repo_research: generator('环节 · 发起沙箱仓库调研'),
  get_repo_research: query('环节 · 轮询沙箱调研结果'),
  apply_repo_association: executor('环节 · 采纳写回项目关联仓库（需用户确认）'),
}
