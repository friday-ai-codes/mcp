/**
 * 工具调用单测：缺配置引导、run_id 透传、401 graceful、非 JSON 兜底、PAT 脱敏。
 */

import { describe, expect, it, vi } from 'vitest'
import { MISSING_CONFIG_MESSAGE } from '../src/config.js'
import { callFridayTool, RunContext } from '../src/server.js'
import { FRIDAY_TOOLS, TOOL_ANNOTATIONS } from '../src/tools.js'

const CONFIG = { baseUrl: 'https://friday.internal', accessToken: 'secret-pat' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fRIDAY_TOOLS', () => {
  it('定义了与服务端一致的 42 个工具', () => {
    expect(FRIDAY_TOOLS).toHaveLength(42)
    const names = FRIDAY_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(42)
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
      expect(annotations!.destructiveHint).toBe(false)
    }
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(FRIDAY_TOOLS.map(t => t.name).sort())
  })
})

describe('callFridayTool', () => {
  it('缺配置时返回 isError 引导文案，不发请求', async () => {
    const fetchMock = vi.fn()
    const result = await callFridayTool('route_repositories', {}, new RunContext(), fetchMock, () => null)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(MISSING_CONFIG_MESSAGE)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('正常调用：POST 到正确 URL、带 Bearer 头，返回 JSON 文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ total: 1, run_id: 'run-1' }))
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
    expect(JSON.parse(result.content[0]!.text)).toEqual({ total: 1, run_id: 'run-1' })
  })

  it('首次响应的 run_id 被记住并在后续请求带 X-Friday-Run-ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run_id: 'run-abc' }))
    const runContext = new RunContext()

    await callFridayTool('route_repositories', { query: 'a' }, runContext, fetchMock, () => CONFIG)
    expect(fetchMock.mock.calls[0]![1].headers['X-Friday-Run-ID']).toBeUndefined()
    expect(runContext.runId).toBe('run-abc')

    await callFridayTool('search_rag_chunks', { query: 'b' }, runContext, fetchMock, () => CONFIG)
    expect(fetchMock.mock.calls[1]![1].headers['X-Friday-Run-ID']).toBe('run-abc')
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

  it('网络错误返回 isError 文本而不是抛异常', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const result = await callFridayTool('get_repository', {}, new RunContext(), fetchMock, () => CONFIG)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('网络')
  })
})
