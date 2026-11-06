/**
 * Friday MCP stdio server。
 *
 * 每个工具调用透传到 POST {baseUrl}/api/mcp/tools/{name}/（Bearer PAT）。
 *
 * 审计串联：会话内记住服务端返回的最新 run_id，后续请求自动带
 * X-Friday-Run-ID，使多步 workflow 在 Friday Interaction Ledger 里
 * 聚合为同一条轨迹。
 *
 * 容错：缺配置 / 401 / 403 / 非 200 / 网络错误一律返回 isError 文本，
 * 绝不抛异常崩掉 stdio 进程；PAT 绝不进入任何返回文本或日志。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { clientError, httpError } from './errors.js'
import { isObject, persistConfirmedHandoff, success } from './resultAdapters.js'
import type { FridayConfig } from './config.js'
import { resolveConfig } from './config.js'
import { FRIDAY_TOOLS } from './tools.js'
import { SERVER_VERSION } from './packageIdentity.js'

export const SERVER_NAME = 'friday'
export { SERVER_VERSION }

const provider = new AjvJsonSchemaValidator()
const toolsByName = new Map(FRIDAY_TOOLS.map(tool => [tool.name, {
  ...tool,
  validate: provider.getValidator(tool.outputSchema),
}]))

const REQUEST_TIMEOUT_MS = 120_000
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Session correlation is forwarded only after accepting a response from the service. */
export class RunContext {
  runId: string | null = null
}

/**
 * 执行单次工具调用（导出便于单测，不依赖 MCP transport）。
 */
export async function callFridayTool(
  toolName: string,
  args: Record<string, unknown>,
  runContext: RunContext,
  fetchImpl: typeof fetch = fetch,
  configResolver: () => FridayConfig | null = resolveConfig,
) {
  const tool = toolsByName.get(toolName)
  if (!tool)
    return clientError('mcp_unknown_tool', runContext.runId)

  const config = configResolver()
  if (!config)
    return clientError('mcp_config_missing', runContext.runId)

  const url = `${config.baseUrl}${tool.endpoint}`
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.accessToken}`,
    'Content-Type': 'application/json',
  }
  if (runContext.runId)
    headers['X-Friday-Run-ID'] = runContext.runId

  let resp: Response
  let bytes: Uint8Array
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    bytes = new Uint8Array(await resp.arrayBuffer())
  }
  catch (error) {
    const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    return clientError(timeout ? 'mcp_timeout' : 'mcp_network_error', runContext.runId)
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch {
    if (resp.ok)
      return clientError('mcp_invalid_json', runContext.runId, resp.status)
  }
  if (!resp.ok) {
    const envelope = isObject(body) ? body : {}
    const id = envelope.run_id ?? resp.headers.get('X-Friday-Run-ID')
    if (typeof id === 'string' && uuidPattern.test(id) && !id.includes(config.accessToken))
      runContext.runId = id
    return httpError(resp.status, envelope, runContext.runId)
  }
  const operationTool = tool.name === 'start_technical_blueprint' || tool.name === 'get_blueprint_operation'
  if (!isObject(body) || (operationTool && 'error_code' in body) || !tool.validate(body).valid)
    return clientError('mcp_manifest_mismatch', runContext.runId, resp.status)

  // Reject accidental credential echoes even on a schema-valid HTTP 200.
  const serialized = JSON.stringify(body)
  if (serialized.includes(config.accessToken) || /friday_pat_[A-Za-z0-9_-]{20,}/.test(serialized))
    return clientError('mcp_manifest_mismatch', runContext.runId, resp.status)
  const id = body.run_id
  if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
    runContext.runId = id
  if (tool.name === 'get_confirmed_blueprint_handoff')
    return persistConfirmedHandoff(bytes, body, args, typeof id === 'string' ? id : null)
  return success(body)
}

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )
  const runContext = new RunContext()

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: FRIDAY_TOOLS.map(t => ({
      name: t.name,
      title: t.annotations.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    return callFridayTool(name, (args ?? {}) as Record<string, unknown>, runContext)
  })

  return server
}

export async function runStdioServer(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
