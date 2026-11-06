/**
 * 工具调用单测：缺配置引导、run_id 透传、401 graceful、非 JSON 兜底、PAT 脱敏。
 */

import { describe, expect, it, vi } from 'vitest'
import packageInfo from '../package.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MISSING_CONFIG_MESSAGE } from '../src/config.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { callFridayTool, createServer, RunContext, SERVER_VERSION } from '../src/server.js'
import { FRIDAY_TOOLS, TOOL_ANNOTATIONS } from '../src/tools.js'

// Pin only the destination nonce so the test can stage a pre-existing file and
// observe its inode across a real filesystem rename.
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}))

const CONFIG = { baseUrl: 'https://friday.internal', accessToken: 'secret-pat' }

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
      for (const name of ['get_technical_blueprint', 'read_blueprint_context', 'get_repo_research', 'route_blueprint_repos']) {
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

  it('定义了与服务端一致的 55 个工具', () => {
    expect(FRIDAY_TOOLS).toHaveLength(55)
    const names = FRIDAY_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(55)
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
    expect(result.structuredContent.error_code).toBe('invalid_params')
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
    expect(result.content[0]!.text).toBe(MISSING_CONFIG_MESSAGE)
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
      expect(failed.structuredContent.error_code).toBe('handoff_write_failed')
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
      expect(result.structuredContent).toEqual({ error_code: 'repository_not_found', http_status: 404, retryable: false, run_id: id })
      expect(context.runId).toBe(id)
      expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
      expect(JSON.stringify(result)).not.toContain('private')
    }
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
    expect(result.structuredContent.error_code).toBe(code)
    expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
  })

  it('网络错误返回 isError 文本而不是抛异常', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const result = await callFridayTool('get_repository', {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('网络')
  })
})
