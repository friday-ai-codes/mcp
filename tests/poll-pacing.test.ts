/**
 * npm 适配器按机读时长退避且不 busy-loop（SEC-06，verify-blueprint-recovery-and-release）。
 *
 * 用 vitest fake timers 推进时钟，用计数型 fetchImpl 记录每次真正发往服务端的请求时刻。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_AFTER_MS, httpError, MAX_RETRY_AFTER_MS, RETRY_AFTER_META_KEY, retryAfterMeta, retryAfterMs } from '../src/errors.js'
import { isPacedTool, pacingKey, PollPacer } from '../src/pollPacing.js'
import { callFridayTool, RunContext } from '../src/server.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { createServer } from '../src/server.js'
import { localThrottled } from '../src/errors.js'
import { FRIDAY_TOOLS } from '../src/tools.js'

const CONFIG = { baseUrl: 'https://friday.internal', accessToken: 'secret-pat' }
const SESSION = '0f8a4f53-0c6b-4b5e-9b0f-3b7d0c1f2a11'
const OTHER_SESSION = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const OPERATION = '1366baaa-2f1e-4bf9-bee3-1606c9ff8f88'
const ARTIFACT = 'b0c6d1f2-6a3e-4b7d-9c8e-2f1a0b9c8d7e'
const VERSION = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f'
const THREAD = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a'
const PLAN = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function statusBody(poll_after_ms: number, session_id = SESSION) {
  return {
    run_id: session_id, session_id, artifact_id: ARTIFACT, completeness: 'complete', missing_fields: [],
    empty_reason: null, status: poll_after_ms === 0 ? 'confirmed' : 'running', current_stage: 'repo_plan',
    poll_after_ms, next_actions: ['get_blueprint_status'], waiting_on: null, recovery_state: null,
    retryable: false, artifact_version_id: VERSION, content_hash: 'sha256:abc',
    progress: { scope: 'repositories', completed: 1, total: 2 }, answerable_clarifications: [],
  }
}

function operationBody(poll_after_ms: number) {
  return {
    operation_id: OPERATION, session_id: SESSION, artifact_id: ARTIFACT, status: 'researching',
    poll_after_ms, next_actions: ['get_blueprint_operation'],
  }
}

const throttled = (retry_after_ms?: unknown, headers: Record<string, string> = {}) =>
  json({ error_code: 'throttled', retryable: true, ...(retry_after_ms === undefined ? {} : { retry_after_ms }) }, 429, headers)

/** Counting fetchImpl: replays queued responses and records the fake-clock time of each request. */
function countingFetch(...responses: (() => Response)[]) {
  const sentAt: number[] = []
  const impl = vi.fn(async () => {
    sentAt.push(Date.now())
    const next = responses.shift()
    if (!next)
      throw new Error('unexpected upstream request')
    return next()
  })
  return { impl: impl as unknown as typeof fetch, sentAt, calls: () => impl.mock.calls.length }
}

function caller(context: RunContext, fetchImpl: typeof fetch) {
  return (name: string, args: Record<string, unknown>) => callFridayTool(name, args, context, fetchImpl, () => CONFIG)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('429 retry_after_ms preservation', () => {
  it('keeps throttled and T in the structured result', async () => {
    const upstream = countingFetch(() => throttled(7000))
    const result = await caller(new RunContext(), upstream.impl)('get_blueprint_status', { session_id: SESSION })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error_code: 'throttled', http_status: 429, retryable: true, run_id: null,
    })
    expect((result as { _meta?: unknown })._meta).toEqual({ [RETRY_AFTER_META_KEY]: 7000 })
    expect(result.content[0]!.text).toContain('retry_after_ms=7000')
    expect(result.content[0]!.text).toContain('限流')
  })

  it('falls back to Retry-After × 1000 when the body omits retry_after_ms', () => {
    const error = httpError(429, { error_code: 'throttled' }, null, new Headers({ 'Retry-After': '3' }))
    expect(error.structuredContent).toEqual({ error_code: 'throttled', http_status: 429, retryable: true, run_id: null })
    expect(retryAfterMeta(error)).toBe(3000)
  })

  it('backs off 5000 ms when the duration is missing or malformed', () => {
    expect(DEFAULT_RETRY_AFTER_MS).toBe(5000)
    expect(retryAfterMs({}, null)).toBe(5000)
    expect(retryAfterMs({}, new Headers())).toBe(5000)
    for (const bad of [0, -1, 1.5, '2000', null, Number.NaN, Number.POSITIVE_INFINITY])
      expect(retryAfterMs({ retry_after_ms: bad }, null), String(bad)).toBe(5000)
    for (const bad of ['0', '-3', '1.5', 'soon', 'Wed, 18 Nov 2026 00:00:10 GMT'])
      expect(retryAfterMs({}, new Headers({ 'Retry-After': bad })), bad).toBe(5000)
  })

  it('prefers the body over the header and clamps to [1, 300000]', () => {
    expect(retryAfterMs({ retry_after_ms: 1200 }, new Headers({ 'Retry-After': '9' }))).toBe(1200)
    expect(retryAfterMs({ retry_after_ms: 1 }, null)).toBe(1)
    expect(retryAfterMs({ retry_after_ms: 10_000_000 }, null)).toBe(MAX_RETRY_AFTER_MS)
    expect(retryAfterMs({}, new Headers({ 'Retry-After': '86400' }))).toBe(MAX_RETRY_AFTER_MS)
  })

  it('applies the conservative default when a 429 carries no duration at all', async () => {
    const upstream = countingFetch(() => throttled(), () => json(statusBody(1000)))
    const read = caller(new RunContext(), upstream.impl)
    expect(retryAfterMeta(await read('get_blueprint_status', { session_id: SESSION }))).toBe(5000)
    await vi.advanceTimersByTimeAsync(4999)
    const early = await read('get_blueprint_status', { session_id: SESSION })
    expect(early.structuredContent).toMatchObject({ error_code: 'throttled', http_status: null })
    expect(retryAfterMeta(early)).toBe(1)
    expect(upstream.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await read('get_blueprint_status', { session_id: SESSION })).isError).toBeFalsy()
    expect(upstream.calls()).toBe(2)
  })
})

describe('local pacing before T elapses', () => {
  it('does not contact the service again until T has passed', async () => {
    const upstream = countingFetch(() => throttled(4000), () => json(operationBody(1500)))
    const read = caller(new RunContext(), upstream.impl)
    await read('get_blueprint_operation', { operation_id: OPERATION })
    for (const step of [0, 1000, 1000, 1999]) {
      await vi.advanceTimersByTimeAsync(step)
      const local = await read('get_blueprint_operation', { operation_id: OPERATION })
      expect(local.isError).toBe(true)
      expect(local.structuredContent.error_code).toBe('throttled')
      expect(local.structuredContent.http_status).toBeNull()
      expect(local.structuredContent.retryable).toBe(true)
      const remaining = retryAfterMeta(local)!
      expect(remaining).toBeGreaterThan(0)
      expect(remaining).toBeLessThanOrEqual(4000)
    }
    expect(upstream.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await read('get_blueprint_operation', { operation_id: OPERATION })).isError).toBeFalsy()
    expect(upstream.calls()).toBe(2)
  })

  it('never schedules timers or resends on its own', async () => {
    const upstream = countingFetch(() => throttled(2000))
    await caller(new RunContext(), upstream.impl)('get_blueprint_status', { session_id: SESSION })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(upstream.calls()).toBe(1)
  })

  it('reports the remaining milliseconds in the local throttled result', async () => {
    const upstream = countingFetch(() => json(statusBody(3000)))
    const read = caller(new RunContext(), upstream.impl)
    await read('get_blueprint_status', { session_id: SESSION })
    await vi.advanceTimersByTimeAsync(1200)
    const local = await read('get_blueprint_status', { session_id: SESSION })
    expect(local.structuredContent).toEqual({
      error_code: 'throttled', http_status: null, retryable: true, run_id: SESSION,
    })
    expect(retryAfterMeta(local)).toBe(1800)
    expect(local.content[0]!.text).toContain('1800')
  })

  it('keys pacing by tool and session so other sessions and tools are not blocked', async () => {
    const upstream = countingFetch(
      () => throttled(10_000),
      () => json(statusBody(1000, OTHER_SESSION)),
      () => json({ run_id: SESSION, session_id: SESSION, artifact_id: ARTIFACT, completeness: 'complete',
        missing_fields: [], empty_reason: 'no_rounds', rounds: [], resumable: false, retry_reason: 'no_rounds',
        retry_coordinates: null }),
    )
    const read = caller(new RunContext(), upstream.impl)
    await read('get_blueprint_status', { session_id: SESSION })
    expect((await read('get_blueprint_status', { session_id: OTHER_SESSION })).isError).toBeFalsy()
    expect((await read('get_blueprint_merge_artifacts', { session_id: SESSION })).isError).toBeFalsy()
    expect(upstream.calls()).toBe(3)
  })
})

describe('minimum interval max(P, T)', () => {
  it.each([
    ['T larger than P', 1000, 6000],
    ['P larger than T', 8000, 2000],
  ])('spaces adjacent upstream requests by at least max(P, T) when %s', async (_label, P, T) => {
    const upstream = countingFetch(
      () => json(operationBody(P)),
      () => throttled(T),
      () => json(operationBody(P)),
    )
    const read = caller(new RunContext(), upstream.impl)
    // A client hammering the tool every 250 ms: only paced requests may leave the adapter.
    for (let i = 0; i < 200 && upstream.calls() < 3; i++) {
      await read('get_blueprint_operation', { operation_id: OPERATION })
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(upstream.calls()).toBe(3)
    const [first, second, third] = upstream.sentAt as [number, number, number]
    expect(second - first).toBeGreaterThanOrEqual(P)
    expect(third - second).toBeGreaterThanOrEqual(Math.max(P, T))
  })
})

describe('poll_after_ms = 0 stops polling', () => {
  it('clears the key, marks it stopped and never polls by itself', async () => {
    const context = new RunContext()
    const upstream = countingFetch(() => json(statusBody(0)), () => json(statusBody(0)))
    const read = caller(context, upstream.impl)
    const key = pacingKey('get_blueprint_status', { session_id: SESSION })!
    expect((await read('get_blueprint_status', { session_id: SESSION })).isError).toBeFalsy()
    expect(context.pacing.isStopped(key)).toBe(true)
    expect(context.pacing.remaining(key)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(upstream.calls()).toBe(1)
    // An explicit caller request is still answered: stopping only ends automatic polling.
    expect((await read('get_blueprint_status', { session_id: SESSION })).isError).toBeFalsy()
    expect(upstream.calls()).toBe(2)
  })
})

describe('mutations release the session', () => {
  it('lets the caller read status immediately after a successful mutation on the same session', async () => {
    const upstream = countingFetch(
      () => json(statusBody(30_000)),
      () => json({ run_id: SESSION, status: 'confirmed', technical_plan_id: PLAN, artifact_id: ARTIFACT,
        artifact_version_id: VERSION, version_no: 3, content_hash: 'sha256:abc', current_status: 'confirmed',
        markdown: '# blueprint', repository_task_count: 2 }),
      () => json(statusBody(0)),
    )
    const read = caller(new RunContext(), upstream.impl)
    await read('get_blueprint_status', { session_id: SESSION })
    expect((await read('get_blueprint_status', { session_id: SESSION })).structuredContent)
      .toMatchObject({ error_code: 'throttled', http_status: null })
    const approved = await read('approve_technical_blueprint', {
      technical_plan_id: PLAN, artifact_id: ARTIFACT, artifact_version_id: VERSION, content_hash: 'sha256:abc',
    })
    expect(approved.isError).toBeFalsy()
    expect((await read('get_blueprint_status', { session_id: SESSION })).isError).toBeFalsy()
    expect(upstream.calls()).toBe(3)
  })

  it('keeps pacing when the mutation fails or targets another session', async () => {
    const upstream = countingFetch(
      () => json(statusBody(30_000)),
      () => json({ error_code: 'conflict', retryable: false }, 409),
      () => json({ run_id: OTHER_SESSION, status: 'resolved', thread_id: THREAD, artifact_id: OTHER_SESSION }),
    )
    const read = caller(new RunContext(), upstream.impl)
    await read('get_blueprint_status', { session_id: SESSION })
    await read('approve_technical_blueprint', {
      technical_plan_id: PLAN, artifact_id: ARTIFACT, artifact_version_id: VERSION, content_hash: 'sha256:abc',
    })
    await read('resolve_blueprint_finding', { thread_id: THREAD, reason: 'fixed', artifact_id: OTHER_SESSION })
    expect((await read('get_blueprint_status', { session_id: SESSION })).structuredContent)
      .toMatchObject({ error_code: 'throttled', http_status: null })
    expect(upstream.calls()).toBe(3)
  })
})

describe('non-polling tools are unaffected', () => {
  it('forwards every call of a non-polling tool even after a 429', async () => {
    const upstream = countingFetch(() => throttled(9000), () => throttled(9000), () => throttled(9000))
    const read = caller(new RunContext(), upstream.impl)
    for (let i = 0; i < 3; i++) {
      const result = await read('get_technical_blueprint', { artifact_id: ARTIFACT })
      expect(result.structuredContent).toMatchObject({ error_code: 'throttled', http_status: 429 })
      expect(retryAfterMeta(result)).toBe(9000)
    }
    expect(upstream.calls()).toBe(3)
  })

  it('limits pacing to the two polling tools and diagnostic tools', () => {
    expect(isPacedTool('get_blueprint_status', true)).toBe(true)
    expect(isPacedTool('get_blueprint_operation', false)).toBe(true)
    expect(isPacedTool('get_blueprint_events', true)).toBe(true)
    expect(isPacedTool('get_technical_blueprint', false)).toBe(false)
    expect(isPacedTool('approve_technical_blueprint', false)).toBe(false)
  })

  it('does not pace a diagnostic call without an identifier', () => {
    expect(pacingKey('get_blueprint_status', { project_id: ARTIFACT })).toBeNull()
    expect(pacingKey('get_blueprint_status', { session_id: SESSION, artifact_id: ARTIFACT }))
      .toBe(pacingKey('get_blueprint_status', { session_id: SESSION }))
  })
})

describe('pollPacer', () => {
  it('uses max(last poll_after_ms, retry_after_ms) from the send time of the throttled request', () => {
    let now = 1_000
    const pacer = new PollPacer(() => now)
    pacer.recordPoll('k', now, 5000, [SESSION])
    now = 6_000
    expect(pacer.remaining('k')).toBeNull()
    pacer.recordThrottle('k', now, 1000, [])
    expect(pacer.remaining('k')).toBe(5000)
    pacer.clearSession([SESSION])
    expect(pacer.remaining('k')).toBeNull()
  })

  it('ignores malformed poll_after_ms values', () => {
    const pacer = new PollPacer(() => 0)
    for (const bad of [-1, 1.5, '100', null, undefined])
      pacer.recordPoll('k', 0, bad, [])
    expect(pacer.remaining('k')).toBeNull()
    expect(pacer.isStopped('k')).toBe(false)
  })
})

describe('throttled results stay valid against the generated outputSchema', () => {
  const validator = new AjvJsonSchemaValidator()
  const diagnostic = (tool: (typeof FRIDAY_TOOLS)[number]) =>
    tool.inputSchema.anyOf !== undefined && tool.name.startsWith('get_blueprint_')
  // Every tool whose outputSchema carries the closed error branch, plus every paced tool.
  const closed = FRIDAY_TOOLS.filter(tool => Array.isArray(tool.outputSchema.oneOf)
    || isPacedTool(tool.name, diagnostic(tool)))

  it('covers every paced tool and start_technical_blueprint', () => {
    const names = closed.map(tool => tool.name)
    for (const name of ['get_blueprint_status', 'get_blueprint_operation', 'get_blueprint_events',
      'get_blueprint_review', 'get_blueprint_repo_plan', 'get_blueprint_merge_artifacts', 'start_technical_blueprint'])
      expect(names).toContain(name)
    for (const tool of FRIDAY_TOOLS.filter(t => isPacedTool(t.name, diagnostic(t))))
      expect(Array.isArray(tool.outputSchema.oneOf), tool.name).toBe(true)
  })

  it.each(closed.map(tool => [tool.name, tool] as const))('%s: 429 and local throttled pass SDK validation', (_name, tool) => {
    const validate = validator.getValidator(tool.outputSchema)
    const run = '1366baaa-2f1e-4bf9-bee3-1606c9ff8f88'
    const results = [
      httpError(429, { error_code: 'throttled', retryable: true, retry_after_ms: 4000 }, null),
      httpError(429, { error_code: 'throttled' }, run, new Headers({ 'Retry-After': '2' })),
      httpError(429, {}, null),
      localThrottled(1234.5, null),
      localThrottled(10, run),
    ]
    for (const result of results) {
      const verdict = validate(result.structuredContent)
      expect(verdict.valid, `${tool.name}: ${verdict.errorMessage}`).toBe(true)
      expect(Object.keys(result.structuredContent).sort()).toEqual(['error_code', 'http_status', 'retryable', 'run_id'])
      const wait = retryAfterMeta(result)
      expect(Number.isSafeInteger(wait) && wait! > 0).toBe(true)
    }
    if (diagnostic(tool)) {
      const scoped = { ...results[0]!.structuredContent, retry_scope: tool.name }
      expect(validate(scoped).valid).toBe(true)
    }
  })

  it('a real SDK Client receives the 429 and the local refusal without schema errors', async () => {
    vi.useRealTimers()
    const fetchMock = vi.fn().mockImplementation(async () => json({ error_code: 'throttled', retryable: true, retry_after_ms: 4000 }, 429))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('FRIDAY_BASE_URL', CONFIG.baseUrl)
    vi.stubEnv('FRIDAY_ACCESS_TOKEN', CONFIG.accessToken)
    const server = createServer()
    const client = new Client({ name: 'pacing-client', version: '1' })
    const [local, remote] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(remote)
      await client.connect(local)
      await client.listTools()
      for (const [name, args] of [
        ['get_blueprint_status', { session_id: SESSION }],
        ['get_blueprint_operation', { operation_id: OPERATION }],
        ['get_blueprint_events', { session_id: SESSION, limit: 5 }],
      ] as const) {
        const limited = await client.callTool({ name, arguments: args })
        expect(limited.isError).toBe(true)
        expect(limited.structuredContent).toMatchObject({ error_code: 'throttled', http_status: 429 })
        expect(limited._meta).toEqual({ [RETRY_AFTER_META_KEY]: 4000 })
        const refused = await client.callTool({ name, arguments: args })
        expect(refused.isError).toBe(true)
        expect(refused.structuredContent).toMatchObject({ error_code: 'throttled', http_status: null })
        expect(retryAfterMeta(refused)).toBeGreaterThan(0)
      }
      expect(fetchMock).toHaveBeenCalledTimes(3)
    }
    finally {
      await client.close()
      await server.close()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
