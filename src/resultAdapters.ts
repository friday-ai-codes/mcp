import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientError } from './errors.js'

export function success(body: Record<string, unknown>) {
  return {
    structuredContent: body,
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    isError: undefined,
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function persistConfirmedHandoff(
  bytes: Uint8Array,
  body: Record<string, unknown>,
  args: Record<string, unknown>,
  runId: string | null,
) {
  const coordinates = ['technical_plan_id', 'artifact_id', 'artifact_version_id', 'content_hash']
  if (coordinates.some(key => typeof args[key] !== 'string' || !args[key] || body[key] !== args[key])
    || body.current_status !== 'confirmed'
    || !Array.isArray(body.repository_tasks) || body.repository_tasks.length === 0
    || body.repository_task_count !== body.repository_tasks.length
    || typeof body.markdown !== 'string' || !body.markdown
    || !Number.isInteger(body.version_no) || Number(body.version_no) < 1) {
    return clientError('handoff_binding_invalid', runId)
  }
  const readiness = body.delivery_readiness
  if (isObject(body.canonical_content) && body.canonical_content.delivery_contract_version !== undefined
    && !(isObject(readiness) && readiness.ready === true))
    return clientError('blueprint_delivery_not_ready', runId)

  // The readiness matrix and blockers can themselves contain private blueprint content.
  const publicReadiness: Record<string, unknown> = {}
  if (isObject(readiness)) {
    if (typeof readiness.ready === 'boolean') publicReadiness.ready = readiness.ready
    if (typeof readiness.status === 'string' && ['ready', 'blocked', 'legacy_unverified'].includes(readiness.status))
      publicReadiness.status = readiness.status
  } else {
    publicReadiness.ready = false
    publicReadiness.status = 'legacy_unverified'
  }

  try {
    const directory = join(tmpdir(), 'friday-mcp-handoffs')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const dir = await lstat(directory)
    if (!dir.isDirectory() || (process.getuid && (dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700)))
      return clientError('handoff_write_failed', runId)
    const safePart = (value: unknown) => String(value).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'unknown'
    const finalPath = join(directory,
      `blueprint-handoff-${safePart(body.artifact_id)}-${safePart(body.artifact_version_id)}-${randomUUID()}.json`)
    const temporaryPath = `${finalPath}.tmp`
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      try { await file.writeFile(bytes) }
      finally { await file.close() }
      await rename(temporaryPath, finalPath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    return success({
      run_id: runId,
      technical_plan_id: body.technical_plan_id,
      artifact_id: body.artifact_id,
      artifact_version_id: body.artifact_version_id,
      version_no: body.version_no,
      content_hash: body.content_hash,
      current_status: body.current_status,
      delivery_readiness: publicReadiness,
      repository_task_count: body.repository_tasks.length,
      markdown_chars: body.markdown.length,
      handoff_file: finalPath,
      handoff_file_sha256: createHash('sha256').update(bytes).digest('hex'),
      note: '完整交接包已原样写入本机文件。请直接上传该文件，不要复制或改写正文。',
    })
  } catch {
    return clientError('handoff_write_failed', runId)
  }
}
