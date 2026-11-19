/**
 * 错误信封回归：真实 SDK Client 对 isError 结果同样按 outputSchema 校验 structuredContent。
 * 71 个工具里只有 12 个蓝图工具的 outputSchema 带错误分支，其余工具出错时若仍返回
 * {error_code, http_status, retryable, run_id} 形状的 structuredContent，客户端会抛 -32602
 * 并丢失错误码。适配器改为把错误信封放在 _meta['friday/error']，仅在 schema 接受时保留
 * structuredContent。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { ERROR_META_KEY, RETRY_AFTER_META_KEY } from '../src/errors.js'
import { isPacedTool } from '../src/pollPacing.js'
import { createServer } from '../src/server.js'
import { FRIDAY_TOOLS } from '../src/tools.js'

const CONFIG = { baseUrl: 'https://friday.internal', accessToken: 'secret-pat-not-real' }
const SESSION = 'a82dbbfa-b358-4ece-9eb4-10ec3df6fd46'
// Diagnostic tools validate their identifier locally; every tool tolerates extra arguments upstream.
const ARGS = { session_id: SESSION, operation_id: SESSION, artifact_id: SESSION }
const OLD_SHAPE = { error_code: 'not_found', http_status: 404, retryable: false, run_id: null }

const validators = new AjvJsonSchemaValidator()
const errorBranchTools = FRIDAY_TOOLS.filter(tool => 'oneOf' in tool.outputSchema).map(tool => tool.name)

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Scenario = [label: string, respond: () => Response, code: string, status: number | null, retryable: boolean]
const SCENARIOS: Scenario[] = [
  ['HTTP 400', () => json({ error_code: 'invalid_params', detail: `bad ${CONFIG.accessToken}` }, 400), 'invalid_params', 400, false],
  ['HTTP 401', () => json({ detail: 'invalid token' }, 401), 'mcp_authentication_failed', 401, false],
  ['HTTP 403', () => json({ error_code: 'forbidden' }, 403), 'mcp_authentication_failed', 403, false],
  ['HTTP 404', () => json({ error_code: 'not_found' }, 404), 'not_found', 404, false],
  ['HTTP 409', () => json({ error_code: 'conflict', retryable: false }, 409), 'conflict', 409, false],
  ['HTTP 422', () => json({ detail: 'unprocessable' }, 422), 'mcp_http_error', 422, false],
  ['HTTP 500', () => new Response('<html>oops</html>', { status: 500 }), 'mcp_http_error', 500, true],
  ['network error', () => { throw new TypeError(`fetch failed ${CONFIG.accessToken}`) }, 'mcp_network_error', null, true],
  // 429 last: it arms local pacing for polling tools, which the next scenario relies on.
  ['HTTP 429', () => json({ error_code: 'throttled', retryable: true, retry_after_ms: 60_000 }, 429), 'throttled', 429, true],
]

let respond: () => Response = () => json({}, 500)
let client: Client
let server: Server

async function connect(target: Server) {
  const [local, remote] = InMemoryTransport.createLinkedPair()
  const connected = new Client({ name: 'error-envelope-test', version: '1' })
  await target.connect(remote)
  await connected.connect(local)
  // Discovery caches outputSchema validators, exactly like Cursor / Claude Code / Codex clients.
  await connected.listTools()
  return connected
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => respond()))
  vi.stubEnv('FRIDAY_BASE_URL', CONFIG.baseUrl)
  vi.stubEnv('FRIDAY_ACCESS_TOKEN', CONFIG.accessToken)
  server = createServer()
  client = await connect(server)
})

afterEach(async () => {
  await client.close()
  await server.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function expectEnvelope(result: Awaited<ReturnType<Client['callTool']>>, tool: string, label: string, code: string, status: number | null, retryable: boolean) {
  const name = `${tool} ${label}`
  expect(result.isError, name).toBe(true)
  const envelope = result._meta?.[ERROR_META_KEY] as Record<string, unknown> | undefined
  expect(envelope, name).toMatchObject({ error_code: code, http_status: status, retryable })
  expect(typeof envelope?.error_code === 'string' && envelope.error_code.length > 0).toBe(true)
  if (errorBranchTools.includes(tool))
    expect(result.structuredContent, name).toEqual(envelope)
  else
    expect(result.structuredContent, name).toBeUndefined()
  const text = (result.content as { type: string, text: string }[])[0]!.text
  expect(text, name).toContain(code)
  expect(JSON.stringify(result)).not.toContain(CONFIG.accessToken)
}

describe('error envelope over a real SDK client', () => {
  it('has 71 tools of which only 12 declare the sanitized error branch', () => {
    expect(FRIDAY_TOOLS).toHaveLength(71)
    expect(errorBranchTools).toHaveLength(12)
  })

  it('the pre-fix shape is rejected by the outputSchema of every tool without an error branch', () => {
    const rejected = FRIDAY_TOOLS.filter(tool => !validators.getValidator(tool.outputSchema)(OLD_SHAPE).valid)
    expect(rejected).toHaveLength(59)
    expect(rejected.map(tool => tool.name).some(name => errorBranchTools.includes(name))).toBe(false)
  })

  it('a real SDK client throws on the pre-fix shape and accepts the _meta envelope', async () => {
    let shape: 'old' | 'new' = 'old'
    const raw = new Server({ name: 'raw', version: '1' }, { capabilities: { tools: {} } })
    raw.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: FRIDAY_TOOLS.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })),
    }) as never)
    raw.setRequestHandler(CallToolRequestSchema, async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'Friday 工具调用失败（HTTP 404，not_found）。' }],
      ...(shape === 'old' ? { structuredContent: OLD_SHAPE } : { _meta: { [ERROR_META_KEY]: OLD_SHAPE } }),
    }))
    const rawClient = await connect(raw)
    try {
      const failures: string[] = []
      for (const tool of FRIDAY_TOOLS) {
        const outcome = await rawClient.callTool({ name: tool.name, arguments: ARGS }).then(() => 'ok', (error: Error) => error.message)
        if (outcome !== 'ok') {
          expect(outcome).toMatch(/structured content does not match/i)
          failures.push(tool.name)
        }
      }
      expect(failures).toHaveLength(59)
      shape = 'new'
      for (const tool of FRIDAY_TOOLS) {
        const result = await rawClient.callTool({ name: tool.name, arguments: ARGS })
        expect(result._meta?.[ERROR_META_KEY]).toEqual(OLD_SHAPE)
      }
    }
    finally {
      await rawClient.close()
      await raw.close()
    }
  })

  it.each(FRIDAY_TOOLS.map(tool => tool.name))('%s returns a machine-readable error for every failure mode', async (name) => {
    const tool = FRIDAY_TOOLS.find(candidate => candidate.name === name)!
    const diagnostic = tool.inputSchema.anyOf !== undefined && name.startsWith('get_blueprint_')
    // Diagnostic tools validate input locally (closed schema): send a valid cursor so the request leaves.
    const args = diagnostic
      ? { session_id: SESSION, ...(name === 'get_blueprint_repo_plan' ? { repository_id: SESSION } : {}) }
      : ARGS
    for (const [label, scenario, code, status, retryable] of SCENARIOS) {
      respond = scenario
      const result = await client.callTool({ name, arguments: args })
      expectEnvelope(result, name, label, code, status, retryable)
      if (status === 429)
        expect(result._meta?.[RETRY_AFTER_META_KEY]).toBe(60_000)
    }
    // Local refusal of a paced tool: nothing is sent and http_status is null.
    if (isPacedTool(name, diagnostic)) {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
      const sent = fetchMock.mock.calls.length
      const refused = await client.callTool({ name, arguments: args })
      expectEnvelope(refused, name, 'local throttled', 'throttled', null, true)
      expect(refused._meta?.[RETRY_AFTER_META_KEY]).toBeGreaterThan(0)
      expect(fetchMock.mock.calls.length).toBe(sent)
    }
  })

  it('surfaces the local handoff binding error instead of a schema failure', async () => {
    respond = () => json({ ...ARGS, technical_plan_id: 'other', current_status: 'confirmed' }, 200)
    const args = { technical_plan_id: 'plan', artifact_id: 'artifact', artifact_version_id: 'version', content_hash: 'a'.repeat(64) }
    const result = await client.callTool({ name: 'get_confirmed_blueprint_handoff', arguments: args })
    expect(result.isError).toBe(true)
    // Either the manifest check or the binding check refuses it; both must arrive intact.
    const envelope = result._meta?.[ERROR_META_KEY] as Record<string, unknown>
    expect(['handoff_binding_invalid', 'mcp_manifest_mismatch']).toContain(envelope.error_code)
    expect(result.structuredContent).toBeUndefined()
  })
})
