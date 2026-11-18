import { MISSING_CONFIG_MESSAGE } from './config.js'

const clientMessages = {
  mcp_config_missing: MISSING_CONFIG_MESSAGE,
  mcp_network_error: 'Friday 网络请求失败。',
  mcp_timeout: 'Friday 请求超时。',
  mcp_authentication_failed: '令牌无效或已失效，或当前用户无权访问此工具。请检查 Friday 访问令牌。',
  mcp_invalid_json: 'Friday 响应不是 JSON。',
  mcp_unknown_tool: '未知工具。',
  mcp_manifest_mismatch: 'Friday 工具响应不符合本地契约。',
  handoff_binding_invalid: '交接包与确认坐标不符。',
  blueprint_delivery_not_ready: '蓝图业务交付合同未就绪。',
  handoff_write_failed: 'Friday 蓝图交接包写入本机文件失败。',
}

// Local guidance for server codes from targeted retries and confirmed handoff
// (expose-blueprint-review-and-handoff). Upstream detail text is never forwarded.
export const serverErrorHints: Record<string, string> = {
  blueprint_repo_plan_stale: '该仓的 attempt 或 content hash 已变化，或坐标已被一次成功重试消费；请重新调用 get_blueprint_repo_plan 读取最新坐标。',
  blueprint_repo_plan_not_retryable: '该仓当前状态不允许定向重试（运行中、已就绪或不在可重试阶段）；请先调用 get_blueprint_repo_plan 查看 retry_reason。',
  blueprint_merge_stale: '融合坐标已不是最新一轮或已被一次成功重试消费；请重新调用 get_blueprint_merge_artifacts 读取最新坐标。',
  blueprint_merge_not_retryable: '当前融合不可恢复（无轮次、未失败或存在其他阻塞澄清）；请先调用 get_blueprint_merge_artifacts 查看 retry_reason。',
  blueprint_handoff_mismatch: '技术方案不属于该技术蓝图，请核对 technical_plan_id 与 artifact_id。',
  blueprint_handoff_stale: '技术蓝图版本或内容哈希已变化，请使用确认时的版本坐标。',
  blueprint_handoff_empty: '已确认蓝图没有可交接的仓库任务。',
  blueprint_not_confirmed: '技术蓝图尚未确认，不能交接；请先完成终审确认。',
  blueprint_delivery_not_ready: '蓝图业务交付合同未就绪，请先修复评审发现。',
}

// Only these server-owned identifiers may cross the HTTP error boundary.
const publicCodes = new Set([
  'ambiguous_symbol', 'analysis_not_found', 'authentication_failed', 'blueprint_delivery_not_ready',
  'blueprint_handoff_empty', 'blueprint_handoff_mismatch', 'blueprint_handoff_repository_unresolved',
  'blueprint_handoff_stale', 'blueprint_identity_unavailable', 'blueprint_not_approved',
  'blueprint_not_confirmed', 'blueprint_thread_answer_required', 'blocked', 'branch_not_bound', 'conflict',
  'chunk_not_found', 'coding_plan_not_found', 'coding_plan_version_conflict',
  'coding_plan_version_not_found', 'diff_too_large', 'empty_feature_list', 'execution_not_found',
  'feishu_project_not_configured', 'feishu_work_item_error', 'file_excluded', 'file_not_found',
  'forbidden', 'git_platform_error', 'git_timeout', 'graph_build_failed', 'graph_build_timeout',
  'graph_unavailable', 'grep_failed', 'idempotency_key_conflict', 'internal_error', 'invalid',
  'invalid_input', 'invalid_params', 'key_not_owned', 'mirror_disabled', 'mirror_fetch_failed',
  'method_not_allowed', 'mirror_unavailable', 'missing_session_header', 'missing_source', 'not_answerable',
  'not_blueprint_session', 'not_editable', 'not_feature_solution_session', 'not_found',
  'not_member', 'pending_unavailable', 'permission_denied', 'project_not_found',
  'project_unresolved', 'repo_task_matrix_empty', 'repo_task_not_found', 'repo_task_required',
  'repository_access_denied', 'repository_not_found', 'repository_not_indexed', 'session_not_found',
  'session_not_owned', 'stale', 'symbol_not_found', 'technical_plan_not_found', 'throttled', 'unavailable', 'work_item_context_not_found',
  // Repository confirmation gate and execution admission (expose-blueprint-repository-gate).
  'blueprint_gate_already_locked', 'blueprint_gate_content_invalid', 'blueprint_gate_pending_clarification',
  'blueprint_gate_pending_research', 'blueprint_gate_stale', 'blueprint_gate_upgrade_unavailable',
  'blueprint_repositories_not_locked', 'empty_snapshot', 'invalid_role', 'missing_repository_id', 'unknown_action',
  // Targeted repo plan and merge retries (expose-blueprint-review-and-handoff).
  'blueprint_merge_not_retryable', 'blueprint_merge_stale', 'blueprint_repo_plan_not_retryable',
  'blueprint_repo_plan_stale',
])

function failure(code: string, detail: string, status: number | null, retryable: boolean, runId: string | null) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: detail }],
    structuredContent: { error_code: code, http_status: status, retryable, run_id: runId },
  }
}

export function clientError(code: keyof typeof clientMessages, runId: string | null, status: number | null = null) {
  const retryable = code === 'mcp_timeout' || code === 'mcp_network_error'
  // Earlier handoff consumers parsed these two local validation errors as JSON.
  const detail = code === 'handoff_binding_invalid' || code === 'blueprint_delivery_not_ready'
    ? JSON.stringify({ code, retryable }) : clientMessages[code]
  return failure(code, detail, status, retryable, runId)
}

export function httpError(status: number, body: Record<string, unknown>, runId: string | null) {
  if (status === 401 || status === 403)
    return clientError('mcp_authentication_failed', runId, status)
  const code = typeof body.error_code === 'string' && publicCodes.has(body.error_code)
    ? body.error_code : 'mcp_http_error'
  const retryable = typeof body.retryable === 'boolean' ? body.retryable : status === 408 || status === 429 || status >= 500
  const hint = Object.hasOwn(serverErrorHints, code) ? serverErrorHints[code] ?? '' : ''
  return failure(code, `Friday 工具调用失败（HTTP ${status}，${code}）。${hint}`, status, retryable, runId)
}
