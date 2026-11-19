/**
 * 工具调用单测：缺配置引导、run_id 透传、401 graceful、非 JSON 兜底、PAT 脱敏。
 */

import { describe, expect, it, vi } from 'vitest'
import packageInfo from '../package.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { chmod, link, lutimes, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MISSING_CONFIG_MESSAGE } from '../src/config.js'
import { errorMeta, RETRY_AFTER_META_KEY } from '../src/errors.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { callFridayTool, createServer, RunContext, SERVER_VERSION } from '../src/server.js'
import { DEFAULT_HANDOFF_MAX_FILES, DEFAULT_HANDOFF_RETENTION_DAYS, handoffRetentionPolicy } from '../src/resultAdapters.js'
import { FRIDAY_TOOLS, TOOL_ANNOTATIONS } from '../src/tools.js'

// Pin only the destination nonce so the test can stage a pre-existing file and
// observe its inode across a real filesystem rename.
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}))

// Lets a test make handoff cleanup deletions fail without touching the write path.
const fsControl = vi.hoisted(() => ({ failUnlink: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (fsControl.failUnlink)
        throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' })
      return actual.unlink(path)
    },
  }
})

const CONFIG = { baseUrl: 'https://friday.internal', accessToken: 'secret-pat' }

/** Tools whose generated outputSchema carries the sanitized error branch (structuredContent kept). */
function hasErrorBranch(name: string): boolean {
  return 'oneOf' in FRIDAY_TOOLS.find(tool => tool.name === name)!.outputSchema
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fRIDAY_TOOLS', () => {
  it('lists every generated contract through MCP discovery', async () => {
    const server = createServer()
    const client = new Client({ name: 'catalog-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      expect(SERVER_VERSION).toBe(packageInfo.version)
      expect(client.getServerVersion()?.version).toBe(packageInfo.version)
      const { tools } = await client.listTools()
      // Assert domain effects independently of the generated catalog used by the server.
      const effects = new Map(tools.map(tool => [tool.name, tool.annotations]))
      for (const name of ['get_blueprint_status', 'get_blueprint_review', 'get_blueprint_repositories', 'get_blueprint_merge_rounds', 'get_blueprint_events', 'get_blueprint_operation', 'get_technical_blueprint', 'read_blueprint_context', 'get_repo_research', 'route_blueprint_repos']) {
        expect(effects.get(name), name).toMatchObject({ readOnlyHint: true, idempotentHint: true })
      }
      for (const name of ['report_blueprint_context', 'answer_blueprint_clarification', 'confirm_feature_tech_plan',
        'get_confirmed_blueprint_handoff', 'execute_coding_plan', 'start_repo_research']) {
        expect(effects.get(name), name).toMatchObject({ readOnlyHint: false, idempotentHint: false })
      }
      for (const name of ['approve_technical_blueprint', 'apply_repo_association']) {
        expect(effects.get(name), name).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: true })
      }
      expect(effects.get('request_technical_blueprint_changes')).toMatchObject({
        readOnlyHint: false, idempotentHint: false, destructiveHint: true,
      })
      // Repository confirmation gate: read is safe to repeat, action and confirm mutate.
      expect(effects.get('get_blueprint_repository_gate')).toMatchObject({
        readOnlyHint: true, idempotentHint: true, destructiveHint: false,
      })
      expect(effects.get('apply_blueprint_repository_gate_action')).toMatchObject({
        readOnlyHint: false, idempotentHint: false,
      })
      expect(effects.get('confirm_blueprint_repository_gate')).toMatchObject({
        readOnlyHint: false, idempotentHint: true, destructiveHint: true,
      })
      const confirm = tools.find(tool => tool.name === 'confirm_blueprint_repository_gate')
      expect(confirm?.inputSchema.required).toEqual(
        expect.arrayContaining(['expected_gate_version', 'expected_gate_snapshot_hash']),
      )
      expect(tools).toEqual(FRIDAY_TOOLS.map(tool => ({
        name: tool.name,
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      })))
    }
    finally {
      await client.close()
      await server.close()
    }
  })

  it('returns a structured cursor error before the first upstream request', async () => {
    const client = new Client({ name: 'diagnostic-client', version: '1' })
    const server = createServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      await client.listTools()
      const result = await client.callTool({
        name: 'get_blueprint_events',
        arguments: { session_id: 'a82dbbfa-b358-4ece-9eb4-10ec3df6fd46', limit: 101 },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({
        error_code: 'invalid_params', http_status: 400, retryable: false, run_id: null,
      })
    }
    finally {
      await client.close()
      await server.close()
    }
  })

  it('定义了与服务端一致的 71 个工具', () => {
    expect(FRIDAY_TOOLS).toHaveLength(71)
    const names = FRIDAY_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(71)
    // 蓝图定向重试、finding 处置与终审（expose-blueprint-review-and-handoff）
    for (const name of ['get_blueprint_repo_plan', 'get_blueprint_merge_artifacts', 'retry_blueprint_repo_plan',
      'retry_blueprint_merge', 'resolve_blueprint_finding', 'dismiss_blueprint_finding',
      'approve_technical_blueprint', 'request_technical_blueprint_changes']) {
      expect(names).toContain(name)
    }
    // 蓝图仓库确认门：读取快照、逐仓动作、带版本坐标的确认锁定
    expect(names).toContain('get_blueprint_repository_gate')
    expect(names).toContain('apply_blueprint_repository_gate_action')
    expect(names).toContain('confirm_blueprint_repository_gate')
    expect(names).toContain('route_repositories')
    expect(names).toContain('grep_repository')
    expect(names).toContain('execute_coding_plan')
    expect(names).toContain('create_merge_request')
    expect(names).toContain('search_learning_cases')
    expect(names).toContain('search_delivery_knowledge')
    expect(names).toContain('get_entity_timeline')
    expect(names).toContain('get_related_entities')
    // 项目上下文环路 + 反查（v0.3.0 与服务端 30 工具全量对齐）
    expect(names).toContain('reverse_lookup_requirements')
    expect(names).toContain('lookup_project_by_branch')
    expect(names).toContain('search_project_context')
    expect(names).toContain('grep_project')
    expect(names).toContain('read_project_doc')
    expect(names).toContain('report_project_knowledge')
    expect(names).toContain('report_project_state')
    // feature list 技术方案两段式（create 必须配 confirm，get 轮询取方案）
    expect(names).toContain('create_feature_tech_plan')
    expect(names).toContain('confirm_feature_tech_plan')
    expect(names).toContain('get_feature_tech_plan')
    // 蓝图异步澄清协议（取件 + 逐条作答）与共享上下文总线（容器内读写）
    expect(names).toContain('get_technical_blueprint')
    expect(names).toContain('get_confirmed_blueprint_handoff')
    expect(names).toContain('answer_blueprint_clarification')
    expect(names).toContain('read_blueprint_context')
    expect(names).toContain('report_blueprint_context')
    // 蓝图环节单跑（stage sandbox）：dry-run 提案面 + 唯一采纳写回
    expect(names).toContain('route_blueprint_repos')
    expect(names).toContain('generate_requirement_spec')
    expect(names).toContain('start_repo_research')
    expect(names).toContain('get_repo_research')
    expect(names).toContain('apply_repo_association')
  })

  it('每个工具都有非空描述与 object 类型 inputSchema', () => {
    for (const tool of FRIDAY_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('每个工具都有 annotations（中文 title + 行为提示），且无多余条目', () => {
    for (const tool of FRIDAY_TOOLS) {
      const annotations = TOOL_ANNOTATIONS[tool.name]
      expect(annotations, `missing annotations for ${tool.name}`).toBeDefined()
      expect(annotations!.title).toContain(' · ')
      expect(typeof annotations!.readOnlyHint).toBe('boolean')
      expect(typeof annotations!.destructiveHint).toBe('boolean')
    }
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(FRIDAY_TOOLS.map(t => t.name).sort())
  })
})

describe('callFridayTool', () => {
  it('validates a diagnostic cursor and preserves the service-issued error coordinates', async () => {
    const run_id = 'a82dbbfa-b358-4ece-9eb4-10ec3df6fd46'
    const name = 'get_blueprint_events'
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error_code: 'unavailable', retryable: true, run_id, retry_scope: name, detail: 'private',
    }, 503))
    const context = new RunContext()
    const read = (args: Record<string, unknown>) => callFridayTool(name, args, context, fetchMock, () => CONFIG)
    expect((await read({ session_id: run_id, limit: 101 })).structuredContent?.error_code).toBe('invalid_params')
    expect(fetchMock).not.toHaveBeenCalled()
    const result = await read({ session_id: run_id, limit: 1, since_seq: 4 })
    expect(result.structuredContent).toEqual({ error_code: 'unavailable', retryable: true,
      http_status: 503, run_id, retry_scope: name })
    expect(errorMeta(result)).toEqual(result.structuredContent)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(context.runId).toBe(run_id)
  })

  it('round-trips blueprint receipts and preserves the stable idempotency conflict', async () => {
    const operation_id = '1366baaa-2f1e-4bf9-bee3-1606c9ff8f88'
    const receipt = {
      operation_id, session_id: operation_id, artifact_id: operation_id, status: 'accepted',
      poll_after_ms: 2000, next_actions: ['get_blueprint_operation'],
    }
    const input = { project_id: operation_id, idempotency_key: 'request-A', requirement_text: 'Design' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(receipt))
      .mockResolvedValueOnce(jsonResponse({ ...receipt, status: 'pending_review' }))
      .mockResolvedValueOnce(jsonResponse({ error_code: 'idempotency_key_conflict', retryable: false }, 409)))
    vi.stubEnv('FRIDAY_BASE_URL', CONFIG.baseUrl)
    vi.stubEnv('FRIDAY_ACCESS_TOKEN', CONFIG.accessToken)
    const server = createServer()
    const client = new Client({ name: 'operation-test', version: '1' })
    const [local, remote] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(remote)
      await client.connect(local)
      await client.listTools()
      const accepted = await client.callTool({ name: 'start_technical_blueprint', arguments: input })
      expect(accepted.structuredContent).toEqual(receipt)
      const polled = await client.callTool({ name: 'get_blueprint_operation', arguments: { operation_id } })
      expect(polled.structuredContent).toEqual({ ...receipt, status: 'pending_review' })
      const conflict = await client.callTool({
        name: 'start_technical_blueprint', arguments: { ...input, requirement_text: 'Changed' },
      })
      expect(conflict.isError).toBe(true)
      expect(conflict.structuredContent).toMatchObject({
        http_status: 409, error_code: 'idempotency_key_conflict', retryable: false,
      })
    } finally {
      await client.close()
      await server.close()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  // Tools present in Django while the stdio catalog still had 43 entries.
  it.each([
    'approve_technical_blueprint', 'detect_changes', 'get_process', 'get_session_capture',
    'graph_query', 'impact_analysis', 'list_processes', 'rename_preview',
    'report_session_knowledge', 'request_technical_blueprint_changes',
    'search_session_knowledge', 'trace_call_path',
  ])('dispatches %s to its established HTTP endpoint', async (name) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error_code: 'invalid_params' }, 400))
    const args = { probe: name }
    const result = await callFridayTool(name, args, new RunContext(), fetchMock, () => CONFIG)
    expect(errorMeta(result)?.error_code).toBe('invalid_params')
    expect(fetchMock).toHaveBeenCalledWith(`${CONFIG.baseUrl}/api/mcp/tools/${name}/`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(args),
    }))
  })

  it.each(['await_blueprint_context', '../private', '__proto__'])('拒绝未注册工具 %s', async (name) => {
    const fetchMock = vi.fn()
    const result = await callFridayTool(name, {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('缺配置时返回 isError 引导文案，不发请求', async () => {
    const fetchMock = vi.fn()
    const result = await callFridayTool('route_repositories', {}, new RunContext(), fetchMock, () => null)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain(MISSING_CONFIG_MESSAGE)
    expect(result.content[0]!.text).toContain('mcp_config_missing')
    expect(errorMeta(result)).toEqual({ error_code: 'mcp_config_missing', http_status: null, retryable: false, run_id: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('正常调用：POST 到正确 URL、带 Bearer 头，返回 JSON 文本', async () => {
    const body = { query: 'payment', ranked_repos: [], router_version: '1', total: 0, auto_selected: false, run_id: 'run-1' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body))
    const runContext = new RunContext()
    const result = await callFridayTool(
      'route_repositories',
      { query: 'payment' },
      runContext,
      fetchMock,
      () => CONFIG,
    )

    expect(result.isError).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://friday.internal/api/mcp/tools/route_repositories/')
    expect(init.headers.Authorization).toBe('Bearer secret-pat')
    expect(init.body).toBe(JSON.stringify({ query: 'payment' }))
    expect(result.structuredContent).toEqual(body)
    expect(JSON.parse(result.content[0]!.text)).toEqual(body)
  })

  it('首次响应的 run_id 被记住并在后续请求带 X-Friday-Run-ID', async () => {
    const body = { query: 'a', ranked_repos: [], router_version: '1', total: 0, auto_selected: false, run_id: 'run-abc' }
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(body))
    const runContext = new RunContext()

    await callFridayTool('route_repositories', { query: 'a' }, runContext, fetchMock, () => CONFIG)
    expect(fetchMock.mock.calls[0]![1].headers['X-Friday-Run-ID']).toBeUndefined()
    expect(runContext.runId).toBe('run-abc')

    await callFridayTool('search_rag_chunks', { query: 'b' }, runContext, fetchMock, () => CONFIG)
    expect(fetchMock.mock.calls[1]![1].headers['X-Friday-Run-ID']).toBe('run-abc')
  })

  it('已确认蓝图交接包原样落文件，只向模型返回小摘要', async () => {
    const marker = '完整蓝图正文-不应出现在模型摘要里'
    const body = {
      technical_plan_id: '11111111-1111-1111-1111-111111111111',
      artifact_id: '22222222-2222-2222-2222-222222222222',
      artifact_version_id: '33333333-3333-3333-3333-333333333333',
      version_no: 20,
      content_hash: 'a'.repeat(64),
      current_status: 'confirmed',
      markdown: marker.repeat(1000),
      repository_tasks: [{ repository_name: 'frontend/app' }],
      canonical_content: { delivery_contract_version: 1, appendix: marker },
      delivery_readiness: { ready: true, status: 'ready', contractTaskMatrix: [marker], blockers: [marker] },
      repository_task_count: 1,
      run_id: 'run-handoff',
    }
    const bytes = Buffer.from('\ufeff' + JSON.stringify(body, null, 2) + '\n')
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes))
    const directory = await mkdtemp(join(tmpdir(), 'friday-handoff-test-'))
    vi.stubEnv('TMPDIR', directory)
    try {
      const handoffs = join(directory, 'friday-mcp-handoffs')
      await mkdir(handoffs, { mode: 0o700 })
      const target = join(handoffs, `blueprint-handoff-${body.artifact_id}-${body.artifact_version_id}-00000000-0000-4000-8000-000000000001.json`)
      await writeFile(target, 'previous version', { mode: 0o600 })
      const previous = join(directory, 'previous')
      await link(target, previous)

      const result = await callFridayTool(
        'get_confirmed_blueprint_handoff',
        { technical_plan_id: body.technical_plan_id, artifact_id: body.artifact_id, artifact_version_id: body.artifact_version_id, content_hash: body.content_hash },
        new RunContext(),
        fetchMock,
        () => CONFIG,
      )

      expect(result.isError).toBeUndefined()
      expect(result.content[0]!.text).not.toContain(marker)
      const summary = JSON.parse(result.content[0]!.text)
      expect(summary.repository_task_count).toBe(1)
      expect(summary.markdown_chars).toBe(body.markdown.length)
      expect(result.structuredContent).toEqual(summary)
      expect(summary.run_id).toBe(body.run_id)
      expect(summary.delivery_readiness).toEqual({ ready: true, status: 'ready' })
      expect(summary.handoff_file_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(summary.handoff_file).toBe(target)
      expect(await readFile(summary.handoff_file)).toEqual(bytes)
      expect(await readFile(previous, 'utf8')).toBe('previous version')
      expect((await stat(dirname(summary.handoff_file))).mode & 0o777).toBe(0o700)
      expect((await stat(summary.handoff_file)).mode & 0o777).toBe(0o600)
      expect(await readdir(handoffs)).toHaveLength(1)

      // A directory collision forces rename to fail after writing the temp file.
      await rm(target)
      await mkdir(target)
      const failed = await callFridayTool('get_confirmed_blueprint_handoff', body, new RunContext(),
        async () => new Response(bytes), () => CONFIG)
      expect(errorMeta(failed)?.error_code).toBe('handoff_write_failed')
      expect(JSON.stringify(failed)).not.toContain(directory)
      expect(await readdir(handoffs)).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('拒绝错误坐标、空任务和未就绪的新版交接包', async () => {
    const args = { technical_plan_id: 'plan', artifact_id: 'artifact', artifact_version_id: 'version', content_hash: 'a'.repeat(64) }
    const base = { ...args, run_id: 'run-handoff', current_status: 'confirmed', version_no: 1, markdown: 'blueprint', repository_tasks: [{}], repository_task_count: 1 }
    for (const change of [{ artifact_id: 'other' }, { repository_tasks: [] }, { current_status: 'pending_review' }, { canonical_content: { delivery_contract_version: 1 }, delivery_readiness: { ready: false } }]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...base, ...change }))
      const result = await callFridayTool('get_confirmed_blueprint_handoff', args, new RunContext(), fetchMock, () => CONFIG)
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).not.toContain('handoff_file')
    }
  })

  it('401 返回换令牌引导（isError，不抛异常，不泄漏 PAT）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'invalid' }, 401))
    const result = await callFridayTool('get_repository', {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('令牌无效或已失效')
    expect(result.content[0]!.text).not.toContain('secret-pat')
  })

  it('非 2xx 返回结构化错误文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'bad request' }, 400))
    const result = await callFridayTool('get_repository', {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('HTTP 400')
  })

  it('200 但响应非 JSON 时返回解析错误而不是抛异常', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))
    const result = await callFridayTool('get_repository', {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('不是 JSON')
  })

  it('preserves only machine fields from upstream errors across display languages', async () => {
    const id = '12345678-1234-4000-8000-123456789abc'
    for (const detail of ['错误', 'Erreur']) {
      const context = new RunContext()
      const body = { detail: detail + CONFIG.accessToken, error_code: 'repository_not_found', run_id: id, stack: 'private' }
      const result = await callFridayTool('get_repository', {}, context, async () => jsonResponse(body, 404), () => CONFIG)
      expect(errorMeta(result)).toEqual({ error_code: 'repository_not_found', http_status: 404, retryable: false, run_id: id })
      expect(result.structuredContent).toBeUndefined()
      expect(context.runId).toBe(id)
      expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })

  const GATE_SESSION = '7c1f2a4e-9b0d-4c3e-8f5a-2d6b1e0c9a87'
  const GATE_REPO = '3e5d7f9a-1b2c-4d4e-8f6a-7b8c9d0e1f2a'
  it.each([
    ['confirm_blueprint_repository_gate', 'blueprint_gate_stale', 409, false],
    ['confirm_blueprint_repository_gate', 'blueprint_gate_pending_research', 409, false],
    ['confirm_blueprint_repository_gate', 'blueprint_gate_pending_clarification', 409, false],
    ['confirm_blueprint_repository_gate', 'blueprint_gate_already_locked', 409, false],
    ['confirm_blueprint_repository_gate', 'blueprint_gate_content_invalid', 409, false],
    ['confirm_blueprint_repository_gate', 'empty_snapshot', 400, false],
    ['apply_blueprint_repository_gate_action', 'blueprint_gate_upgrade_unavailable', 503, true],
    ['apply_blueprint_repository_gate_action', 'unknown_action', 400, false],
    ['apply_blueprint_repository_gate_action', 'missing_repository_id', 400, false],
    ['apply_blueprint_repository_gate_action', 'invalid_role', 400, false],
    ['get_blueprint_repository_gate', 'not_found', 404, false],
    ['execute_coding_plan', 'blueprint_repositories_not_locked', 409, false],
    ['create_merge_request', 'blueprint_repositories_not_locked', 409, false],
  ] as const)('%s passes through the structured %s gate error', async (name, code, status, retryable) => {
    const args: Record<string, unknown> = { session_id: GATE_SESSION }
    if (name === 'confirm_blueprint_repository_gate')
      Object.assign(args, { expected_gate_version: 7, expected_gate_snapshot_hash: 'a'.repeat(64) })
    if (name === 'apply_blueprint_repository_gate_action')
      Object.assign(args, { action: 'upgrade_research', repository_id: GATE_REPO })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error_code: code, retryable, run_id: GATE_SESSION, detail: `private ${CONFIG.accessToken}`,
    }, status))
    const context = new RunContext()
    const result = await callFridayTool(name, args, context, fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    const envelope = { error_code: code, http_status: status, retryable, run_id: GATE_SESSION }
    expect(errorMeta(result)).toEqual(envelope)
    expect(result.structuredContent).toEqual(hasErrorBranch(name) ? envelope : undefined)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
    expect(fetchMock).toHaveBeenCalledWith(`${CONFIG.baseUrl}/api/mcp/tools/${name}/`, expect.objectContaining({
      method: 'POST', body: JSON.stringify(args),
    }))
  })

  it.each([
    [() => jsonResponse({ detail: CONFIG.accessToken, error_code: CONFIG.accessToken, run_id: CONFIG.accessToken }, 503), 'mcp_http_error'],
    [() => new Response(CONFIG.accessToken, { status: 400 }), 'mcp_http_error'],
    [() => new Response(CONFIG.accessToken), 'mcp_invalid_json'],
    [() => jsonResponse({ repository: {}, run_id: CONFIG.accessToken }), 'mcp_manifest_mismatch'],
    [() => jsonResponse({ repository: CONFIG.accessToken }), 'mcp_manifest_mismatch'],
    [() => { throw new DOMException(CONFIG.accessToken, 'TimeoutError') }, 'mcp_timeout'],
    [() => { throw new TypeError(CONFIG.accessToken) }, 'mcp_network_error'],
  ] as const)('sanitizes response and transport failures', async (respond, code) => {
    const result = await callFridayTool('get_repository', {}, new RunContext(), async () => respond(), () => CONFIG)
    expect(result.isError).toBe(true)
    expect(errorMeta(result)?.error_code).toBe(code)
    expect(result.content[0]!.text).toContain(code)
    expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
  })

  it('网络错误返回 isError 文本而不是抛异常', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const result = await callFridayTool('get_repository', {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('网络')
  })
})

const SESSION = 'a82dbbfa-b358-4ece-9eb4-10ec3df6fd46'
const ARTIFACT = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'
const PLAN = '11111111-1111-4111-8111-111111111111'
const REPO = '3e5d7f9a-1b2c-4d4e-8f6a-7b8c9d0e1f2a'
const THREAD = '7c1f2a4e-9b0d-4c3e-8f5a-2d6b1e0c9a87'
const HASH = 'b'.repeat(64)

async function withStdioClient(run: (client: Client) => Promise<void>) {
  const server = createServer()
  const client = new Client({ name: 'review-handoff-test', version: '1' })
  const [local, remote] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(remote)
    await client.connect(local)
    await run(client)
  }
  finally {
    await client.close()
    await server.close()
  }
}

describe('blueprint review, targeted retry and handoff tools', () => {
  it('discovers the new tools with their effects, rework scopes and permissive scope schema', async () => {
    await withStdioClient(async (client) => {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map(tool => [tool.name, tool]))
      for (const name of ['get_blueprint_repo_plan', 'get_blueprint_merge_artifacts']) {
        expect(byName.get(name)?.annotations, name).toMatchObject({
          readOnlyHint: true, idempotentHint: true, destructiveHint: false,
        })
      }
      for (const name of ['retry_blueprint_repo_plan', 'retry_blueprint_merge']) {
        expect(byName.get(name)?.annotations, name).toMatchObject({
          readOnlyHint: false, idempotentHint: false, destructiveHint: false,
        })
      }
      for (const name of ['resolve_blueprint_finding', 'dismiss_blueprint_finding']) {
        expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, idempotentHint: true })
        expect(byName.get(name)?.inputSchema.required).toEqual(expect.arrayContaining(['thread_id', 'reason']))
      }
      for (const name of ['approve_technical_blueprint', 'request_technical_blueprint_changes'])
        expect(byName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false })

      const rework = byName.get('request_technical_blueprint_changes')!
      for (const phrase of ['review', 'merge', 'repos', 'full', '默认', 'rework_repository_ids'])
        expect(rework.description).toContain(phrase)
      const properties = rework.inputSchema.properties as Record<string, Record<string, unknown>>
      expect(properties.rework_repository_ids).toMatchObject({ type: 'array' })
      expect(properties.rework_scope).toMatchObject({ type: 'string' })
      expect(properties.rework_scope!.enum).toBeUndefined()
      const validate = new AjvJsonSchemaValidator().getValidator(rework.inputSchema)
      for (const rework_scope of ['repos', 'review', 'anything-else', ''])
        expect(validate({ artifact_id: ARTIFACT, rework_scope, rework_repository_ids: [REPO] }).valid).toBe(true)

      const approve = byName.get('approve_technical_blueprint')!
      expect(approve.inputSchema.required).toEqual(
        expect.arrayContaining(['technical_plan_id', 'artifact_id', 'artifact_version_id', 'content_hash']),
      )
      for (const name of ['retry_blueprint_repo_plan', 'retry_blueprint_merge'])
        expect(byName.get(name)?.inputSchema.required).toEqual(expect.arrayContaining(['expected_attempt', 'expected_content_hash']))
    })
  })

  const receipt = { run_id: SESSION, artifact_id: ARTIFACT, session_id: SESSION, action_committed: true,
    drive_pending: true, next_actions: ['get_blueprint_status'] }
  const roundTrips: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['get_blueprint_repo_plan', { session_id: SESSION, repository_id: REPO }, {
      run_id: SESSION, session_id: SESSION, artifact_id: ARTIFACT, completeness: 'complete', missing_fields: [],
      empty_reason: null, repository_id: REPO, role: 'direct', delivery_status: 'failed', attempt: 2,
      plan_dispatch_count: 2, partial_plan_id: null, content_hash: null, created_at: null, repo_plan: null,
      citation_count: 0, citation_ids: [], context_entry: null, open_threads: [], retryable: true,
      retry_reason: 'failed', retry_coordinates: { repository_id: REPO, expected_attempt: 2, expected_content_hash: null },
      history: [],
    }],
    ['get_blueprint_merge_artifacts', { artifact_id: ARTIFACT }, {
      run_id: SESSION, session_id: SESSION, artifact_id: ARTIFACT, completeness: 'complete', missing_fields: [],
      empty_reason: 'no_rounds', rounds: [], resumable: false, retry_reason: 'no_rounds', retry_coordinates: null,
    }],
    ['retry_blueprint_repo_plan', { session_id: SESSION, repository_id: REPO, expected_attempt: 2, expected_content_hash: null }, {
      ...receipt, status: 'accepted', closed_thread_count: 1, repository_id: REPO, attempt: 3, content_hash: null,
      invalidated_partial_count: 0,
    }],
    ['retry_blueprint_merge', { session_id: SESSION, expected_attempt: 1, expected_artifact_version_id: VERSION, expected_content_hash: HASH }, {
      ...receipt, status: 'accepted', closed_thread_count: 0, from_attempt: 1, round: 2,
    }],
    ['resolve_blueprint_finding', { thread_id: THREAD, reason: '已在 v3 修复' }, { run_id: SESSION, status: 'resolved', thread_id: THREAD }],
    ['dismiss_blueprint_finding', { thread_id: THREAD, reason: '误报' }, { run_id: SESSION, status: 'noop', thread_id: THREAD }],
    ['approve_technical_blueprint', { technical_plan_id: PLAN, artifact_id: ARTIFACT, artifact_version_id: VERSION, content_hash: HASH }, {
      run_id: SESSION, status: 'confirmed', technical_plan_id: PLAN, artifact_id: ARTIFACT, artifact_version_id: VERSION,
      version_no: 3, content_hash: HASH, current_status: 'confirmed', markdown: '# blueprint', repository_task_count: 2,
    }],
    ['request_technical_blueprint_changes', { artifact_id: ARTIFACT, rework_scope: 'unknown', comment: 'redo' }, {
      run_id: SESSION, status: 'accepted', artifact_id: ARTIFACT, artifact_version_id: VERSION, version_no: 4,
      revision_round: 2, thread_id: THREAD, current_status: 'pending_review', rework_scope: 'merge',
      reworked_repository_count: 0,
    }],
  ]
  it.each(roundTrips)('%s returns the service response unchanged over stdio', async (name, args, body) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('FRIDAY_BASE_URL', CONFIG.baseUrl)
    vi.stubEnv('FRIDAY_ACCESS_TOKEN', CONFIG.accessToken)
    try {
      await withStdioClient(async (client) => {
        await client.listTools()
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual(body)
        expect(fetchMock).toHaveBeenCalledWith(`${CONFIG.baseUrl}/api/mcp/tools/${name}/`, expect.objectContaining({
          method: 'POST', body: JSON.stringify(args),
        }))
      })
    }
    finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ['retry_blueprint_repo_plan', 'blueprint_repo_plan_stale', 'get_blueprint_repo_plan'],
    ['retry_blueprint_repo_plan', 'blueprint_repo_plan_not_retryable', 'retry_reason'],
    ['retry_blueprint_merge', 'blueprint_merge_stale', 'get_blueprint_merge_artifacts'],
    ['retry_blueprint_merge', 'blueprint_merge_not_retryable', 'retry_reason'],
    ['approve_technical_blueprint', 'blueprint_handoff_mismatch', '不属于'],
    ['get_confirmed_blueprint_handoff', 'blueprint_handoff_mismatch', '不属于'],
    ['get_confirmed_blueprint_handoff', 'blueprint_not_confirmed', '尚未确认'],
    ['get_confirmed_blueprint_handoff', 'blueprint_handoff_stale', '确认时的版本坐标'],
    ['get_confirmed_blueprint_handoff', 'blueprint_handoff_empty', '仓库任务'],
    ['get_confirmed_blueprint_handoff', 'blueprint_delivery_not_ready', '交付合同未就绪'],
  ] as const)('%s passes %s through with a local Chinese hint', async (name, code, hint) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error_code: code, retryable: false, run_id: SESSION, detail: `private ${CONFIG.accessToken}`,
    }, 409))
    const result = await callFridayTool(name, { session_id: SESSION }, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    const envelope = { error_code: code, http_status: 409, retryable: false, run_id: SESSION }
    expect(errorMeta(result)).toEqual(envelope)
    expect(result.structuredContent).toEqual(hasErrorBranch(name) ? envelope : undefined)
    expect(result.content[0]!.text).toContain(code)
    expect(result.content[0]!.text).toContain(hint)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
  })
})

describe('confirmed handoff file and cleanup', () => {
  const NEW_UUID = '00000000-0000-4000-8000-000000000001'
  const handoffBody = {
    technical_plan_id: PLAN, artifact_id: ARTIFACT, artifact_version_id: VERSION, version_no: 3,
    content_hash: HASH, current_status: 'confirmed', markdown: '蓝图正文-BODY'.repeat(50),
    repository_tasks: [{ repository_name: 'frontend/app', task: '任务正文-BODY' }, { repository_name: 'backend/api' }],
    repository_task_count: 2, run_id: 'run-handoff',
  }
  const handoffArgs = { technical_plan_id: PLAN, artifact_id: ARTIFACT, artifact_version_id: VERSION, content_hash: HASH }
  const name = (uuid: string, suffix = '') => `blueprint-handoff-${ARTIFACT}-${VERSION}-${uuid}.json${suffix}`
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const ago = (ms: number) => new Date(Date.now() - ms)
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  async function sandbox(run: (root: string, handoffs: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'friday-handoff-prune-'))
    vi.stubEnv('TMPDIR', root)
    try {
      await run(root, join(root, 'friday-mcp-handoffs'))
    }
    finally {
      fsControl.failUnlink = false
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      await rm(root, { recursive: true, force: true })
    }
  }

  async function stage(path: string, mtime: Date) {
    await writeFile(path, 'old handoff', { mode: 0o600 })
    await utimes(path, mtime, mtime)
  }

  async function handoff(body: Record<string, unknown> = handoffBody) {
    const bytes = Buffer.from(JSON.stringify(body))
    const result = await callFridayTool('get_confirmed_blueprint_handoff', handoffArgs, new RunContext(),
      async () => new Response(bytes), () => CONFIG)
    return { result, bytes }
  }

  it('writes 0700/0600 files with a recomputable hash and returns metadata only', async () => {
    await sandbox(async (_root, handoffs) => {
      const { result, bytes } = await handoff()
      expect(result.isError).toBeUndefined()
      const summary = result.structuredContent as Record<string, unknown>
      expect(Object.keys(summary).sort()).toEqual([
        'artifact_id', 'artifact_version_id', 'content_hash', 'current_status', 'delivery_readiness',
        'handoff_file', 'handoff_file_sha256', 'markdown_chars', 'note', 'repository_task_count', 'run_id',
        'technical_plan_id', 'version_no',
      ])
      expect(summary).toMatchObject({ ...handoffArgs, version_no: 3, current_status: 'confirmed', repository_task_count: 2 })
      expect(JSON.stringify(result)).not.toContain('BODY')
      const file = summary.handoff_file as string
      expect(file).toBe(join(handoffs, name(NEW_UUID)))
      const written = await readFile(file)
      expect(written).toEqual(bytes)
      expect(summary.handoff_file_sha256).toBe(createHash('sha256').update(written).digest('hex'))
      expect(JSON.parse(written.toString()).repository_tasks).toHaveLength(summary.repository_task_count as number)
      expect((await stat(handoffs)).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    })
  })

  it('writes nothing when the binding is inconsistent or the directory is unsafe', async () => {
    await sandbox(async (_root, handoffs) => {
      for (const change of [{ content_hash: 'c'.repeat(64) }, { repository_task_count: 3 }, { current_status: 'approved' }]) {
        const { result } = await handoff({ ...handoffBody, ...change })
        expect(errorMeta(result)?.error_code).toBe('handoff_binding_invalid')
        expect(result.structuredContent).toBeUndefined()
      }
      await expect(stat(handoffs)).rejects.toThrow()

      await mkdir(handoffs, { mode: 0o700 })
      await chmod(handoffs, 0o755)
      const { result } = await handoff()
      expect(errorMeta(result)?.error_code).toBe('handoff_write_failed')
      expect(await readdir(handoffs)).toEqual([])
    })
  })

  it('prunes by retention, limit and orphan rules while keeping foreign entries and the new file', async () => {
    await sandbox(async (root, handoffs) => {
      vi.stubEnv('FRIDAY_MCP_HANDOFF_MAX_FILES', '3')
      await mkdir(handoffs, { mode: 0o700 })
      await stage(join(handoffs, name(uuid(10))), ago(8 * DAY)) // expired
      for (const [n, hours] of [[11, 1], [12, 2], [13, 3], [14, 4]] as const)
        await stage(join(handoffs, name(uuid(n))), ago(hours * HOUR)) // 11 and 12 fit under the limit
      await stage(join(handoffs, name(uuid(20), '.tmp')), ago(2 * HOUR)) // orphan
      await stage(join(handoffs, name(uuid(21), '.tmp')), ago(5 * 60 * 1000)) // possibly in flight
      await stage(join(handoffs, 'notes.txt'), ago(30 * DAY))
      await stage(join(handoffs, `blueprint-handoff-${ARTIFACT}.json`), ago(30 * DAY))
      await mkdir(join(handoffs, name(uuid(30))))
      const outside = join(root, 'outside.json')
      await stage(outside, ago(30 * DAY))
      await symlink(outside, join(handoffs, name(uuid(31))))
      await lutimes(join(handoffs, name(uuid(31))), ago(30 * DAY), ago(30 * DAY))

      const { result } = await handoff()
      expect(result.isError).toBeUndefined()
      expect((await readdir(handoffs)).sort()).toEqual([
        `blueprint-handoff-${ARTIFACT}.json`,
        name(NEW_UUID), name(uuid(11)), name(uuid(12)), name(uuid(21), '.tmp'), name(uuid(30)), name(uuid(31)),
        'notes.txt',
      ].sort())
      expect(await readFile(outside, 'utf8')).toBe('old handoff')
    })
  })

  it('keeps the handoff result when cleanup deletions fail', async () => {
    await sandbox(async (_root, handoffs) => {
      await mkdir(handoffs, { mode: 0o700 })
      const expired = join(handoffs, name(uuid(40)))
      await stage(expired, ago(30 * DAY))
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      fsControl.failUnlink = true
      const { result, bytes } = await handoff()
      expect(result.isError).toBeUndefined()
      const summary = result.structuredContent as Record<string, unknown>
      expect(summary.handoff_file).toBe(join(handoffs, name(NEW_UUID)))
      expect(summary.handoff_file_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(await readFile(expired, 'utf8')).toBe('old handoff')
      const logged = stderr.mock.calls.map(call => String(call[0])).join('')
      expect(logged).toContain('handoff cleanup failed=1')
      expect(logged).not.toContain(handoffs)
    })
  })

  it('falls back to defaults for out-of-range or malformed limits', async () => {
    const defaults = { retentionDays: DEFAULT_HANDOFF_RETENTION_DAYS, maxFiles: DEFAULT_HANDOFF_MAX_FILES }
    expect(defaults).toEqual({ retentionDays: 7, maxFiles: 50 })
    expect(handoffRetentionPolicy({})).toEqual(defaults)
    for (const [days, files] of [['0', '0'], ['91', '501'], ['-1', '-5'], ['1.5', '2e1'], ['abc', ''], [' ', '50x']])
      expect(handoffRetentionPolicy({ FRIDAY_MCP_HANDOFF_RETENTION_DAYS: days, FRIDAY_MCP_HANDOFF_MAX_FILES: files })).toEqual(defaults)
    expect(handoffRetentionPolicy({ FRIDAY_MCP_HANDOFF_RETENTION_DAYS: '1', FRIDAY_MCP_HANDOFF_MAX_FILES: '500' }))
      .toEqual({ retentionDays: 1, maxFiles: 500 })
    expect(handoffRetentionPolicy({ FRIDAY_MCP_HANDOFF_RETENTION_DAYS: '90', FRIDAY_MCP_HANDOFF_MAX_FILES: '1' }))
      .toEqual({ retentionDays: 90, maxFiles: 1 })

    // An invalid override must not shrink the limit or retention during a real handoff.
    await sandbox(async (_root, handoffs) => {
      vi.stubEnv('FRIDAY_MCP_HANDOFF_MAX_FILES', '0')
      vi.stubEnv('FRIDAY_MCP_HANDOFF_RETENTION_DAYS', '999')
      await mkdir(handoffs, { mode: 0o700 })
      for (const n of [50, 51, 52])
        await stage(join(handoffs, name(uuid(n))), ago(6 * DAY))
      const { result } = await handoff()
      expect(result.isError).toBeUndefined()
      expect(await readdir(handoffs)).toHaveLength(4)
    })
  })

  it('other tools never write or prune handoff files', async () => {
    await sandbox(async (_root, handoffs) => {
      await mkdir(handoffs, { mode: 0o700 })
      const expired = join(handoffs, name(uuid(60)))
      await stage(expired, ago(30 * DAY))
      const body = { query: 'a', ranked_repos: [], router_version: '1', total: 0, auto_selected: false, run_id: 'run-x' }
      const result = await callFridayTool('route_repositories', { query: 'a' }, new RunContext(),
        async () => jsonResponse(body), () => CONFIG)
      expect(result.structuredContent).toEqual(body)
      expect(await readdir(handoffs)).toEqual([name(uuid(60))])
    })
  })
})

describe('blueprint poll throttling (SEC-06)', () => {
  const resultMeta = (result: object) => (result as { _meta?: unknown })._meta
  const OPERATION = '1366baaa-2f1e-4bf9-bee3-1606c9ff8f88'
  const receipt = (poll_after_ms: number) => ({
    operation_id: OPERATION, session_id: OPERATION, artifact_id: OPERATION, status: 'researching',
    poll_after_ms, next_actions: ['get_blueprint_operation'],
  })

  it('forwards the Retry-After header to httpError and paces the next poll locally', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error_code: 'throttled', retryable: true }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
        }))
        .mockResolvedValueOnce(jsonResponse(receipt(1000)))
      const context = new RunContext()
      const read = () => callFridayTool('get_blueprint_operation', { operation_id: OPERATION }, context, fetchImpl, () => CONFIG)
      const limited = await read()
      expect(limited.structuredContent).toEqual({
        error_code: 'throttled', http_status: 429, retryable: true, run_id: null,
      })
      expect(resultMeta(limited)).toEqual({ [RETRY_AFTER_META_KEY]: 2000, 'friday/error': limited.structuredContent })
      expect(JSON.stringify(limited)).not.toContain(CONFIG.accessToken)
      await vi.advanceTimersByTimeAsync(1999)
      const local = await read()
      expect(local.structuredContent).toEqual({ error_code: 'throttled', http_status: null, retryable: true, run_id: null })
      expect(resultMeta(local)).toEqual({ [RETRY_AFTER_META_KEY]: 1, 'friday/error': local.structuredContent })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect((await read()).structuredContent).toEqual(receipt(1000))
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('lets a fresh start_technical_blueprint receipt be polled immediately', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse(receipt(60_000)))
        .mockResolvedValueOnce(jsonResponse({ ...receipt(2000), status: 'accepted' }))
        .mockResolvedValueOnce(jsonResponse(receipt(2000)))
      const context = new RunContext()
      const call = (name: string, args: Record<string, unknown>) => callFridayTool(name, args, context, fetchImpl, () => CONFIG)
      await call('get_blueprint_operation', { operation_id: OPERATION })
      const started = await call('start_technical_blueprint', {
        project_id: OPERATION, idempotency_key: 'request-A', requirement_text: 'Design',
      })
      expect(started.isError).toBeFalsy()
      expect((await call('get_blueprint_operation', { operation_id: OPERATION })).isError).toBeFalsy()
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps 429 handling for non-polling tools without local pacing', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ error_code: 'throttled', retry_after_ms: 1500 }, 429))
    const context = new RunContext()
    for (let i = 0; i < 2; i++) {
      const result = await callFridayTool('search_rag_chunks', { query: 'x' }, context, fetchImpl, () => CONFIG)
      expect(result.structuredContent).toBeUndefined()
      expect(resultMeta(result)).toEqual({
        [RETRY_AFTER_META_KEY]: 1500,
        'friday/error': { error_code: 'throttled', http_status: 429, retryable: true, run_id: null },
      })
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
