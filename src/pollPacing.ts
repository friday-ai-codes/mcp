/**
 * 蓝图轮询的本地节流（verify-blueprint-recovery-and-release，SEC-06）。
 *
 * 只作用于 get_blueprint_status、get_blueprint_operation 与诊断轮询工具。状态键为
 * (tool, session_id | operation_id | artifact_id)，值为 notBefore = 发送时刻 +
 * max(poll_after_ms, retry_after_ms)。notBefore 之前到达的同键调用由适配器本地拒绝，
 * 不发往服务端。
 *
 * 这是适配器内唯一的等待逻辑：从不自动重发请求，也不使用 setTimeout 循环；
 * 所有判断都在一次工具调用内同步完成，时间只读 Date.now()。
 */

const ID_FIELDS = ['session_id', 'operation_id', 'artifact_id'] as const

/** The two named polling tools; diagnostic tools are flagged by the caller. */
export const POLL_TOOLS: ReadonlySet<string> = new Set(['get_blueprint_status', 'get_blueprint_operation'])

export function isPacedTool(name: string, diagnostic: boolean): boolean {
  return diagnostic || POLL_TOOLS.has(name)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Identifiers carried by a tool's arguments or response that name a blueprint session. */
export function sessionIds(...sources: unknown[]): string[] {
  const ids = new Set<string>()
  for (const source of sources) {
    if (typeof source !== 'object' || source === null)
      continue
    for (const field of ID_FIELDS) {
      const value = (source as Record<string, unknown>)[field]
      if (nonEmptyString(value))
        ids.add(value)
    }
  }
  return [...ids]
}

/** (tool, session_id | operation_id | artifact_id); the first identifier present wins. */
export function pacingKey(tool: string, args: Record<string, unknown>): string | null {
  for (const field of ID_FIELDS) {
    const value = args[field]
    if (nonEmptyString(value))
      return JSON.stringify([tool, field, value])
  }
  return null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

interface PacingEntry {
  notBefore: number
  /** Last poll_after_ms the service issued for this key; combined with a later 429. */
  pollAfterMs: number
  /** Session/operation/artifact IDs observed for this key, used by mutation invalidation. */
  ids: Set<string>
}

export class PollPacer {
  private readonly entries = new Map<string, PacingEntry>()
  private readonly stopped = new Set<string>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Current time for stamping a request just before it is sent. */
  clock(): number {
    return this.now()
  }

  /** Milliseconds left before the key may reach the service, or null when it may be sent now. */
  remaining(key: string): number | null {
    const entry = this.entries.get(key)
    if (!entry)
      return null
    const left = entry.notBefore - this.now()
    return left > 0 ? left : null
  }

  /** True after the service answered poll_after_ms = 0 for this key. */
  isStopped(key: string): boolean {
    return this.stopped.has(key)
  }

  /** Record a successful poll: P = 0 clears the key and marks it stopped. */
  recordPoll(key: string, sentAt: number, pollAfterMs: unknown, ids: string[]): void {
    const poll = nonNegativeInteger(pollAfterMs)
    if (poll === null)
      return
    if (poll === 0) {
      this.entries.delete(key)
      this.stopped.add(key)
      return
    }
    this.stopped.delete(key)
    this.entries.set(key, { notBefore: sentAt + poll, pollAfterMs: poll, ids: this.idsFor(key, ids) })
  }

  /** Record a 429: the next request waits max(last poll_after_ms, retry_after_ms) from sentAt. */
  recordThrottle(key: string, sentAt: number, retryAfterMs: number, ids: string[]): void {
    const previous = this.entries.get(key)
    const poll = previous?.pollAfterMs ?? 0
    const notBefore = sentAt + Math.max(poll, retryAfterMs)
    this.entries.set(key, {
      notBefore: Math.max(notBefore, previous?.notBefore ?? 0),
      pollAfterMs: poll,
      ids: this.idsFor(key, ids),
    })
  }

  /** A successful mutation on a session lets the caller read its status immediately. */
  clearSession(ids: string[]): void {
    if (ids.length === 0)
      return
    const wanted = new Set(ids)
    for (const [key, entry] of this.entries) {
      if ([...entry.ids].some(id => wanted.has(id)))
        this.entries.delete(key)
    }
    for (const key of this.stopped) {
      const id = keyId(key)
      if (id !== null && wanted.has(id))
        this.stopped.delete(key)
    }
  }

  private idsFor(key: string, ids: string[]): Set<string> {
    const merged = new Set(this.entries.get(key)?.ids ?? [])
    const own = keyId(key)
    if (own !== null)
      merged.add(own)
    for (const id of ids)
      merged.add(id)
    return merged
  }
}

/** The identifier a key was built from (see pacingKey); opaque keys carry none. */
function keyId(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) && nonEmptyString(parsed[2]) ? parsed[2] : null
  }
  catch {
    return null
  }
}
