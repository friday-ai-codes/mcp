import { resolveConfig } from './config.js'
import { compareDeployment, parseDeployment } from './contractDiff.js'
import { registrationStatus } from './register.js'
import { SERVER_VERSION } from './server.js'
import { CLIENT_CONTRACT_VERSION, CLIENT_MANIFEST_HASH } from './tools.js'

const MAX_BYTES = 2 * 1024 * 1024

export async function runDoctor(fetchImpl: typeof fetch = fetch): Promise<number> {
  try {
    const statuses = registrationStatus()
    if (!statuses.length)
      console.log('注册状态: 未探测到已安装的 agent')
    for (const { agent, registered } of statuses)
      console.log(`${agent}: ${registered ? '已注册' : '未注册'}`)
  }
  catch {
    console.log('注册状态: 无法读取')
  }

  console.log(`client_version=${SERVER_VERSION} client_contract_version=${CLIENT_CONTRACT_VERSION} bundled_hash=${CLIENT_MANIFEST_HASH}`)
  const fail = (status: string) => {
    console.error(`doctor=${status}`)
    return 1
  }
  const config = resolveConfig()
  if (!config) {
    console.error('未配置。请运行 friday-mcp setup。')
    return fail('config_missing')
  }
  const safe = (value: string) => value.includes(config.accessToken) || /friday_pat_/i.test(value) ? '[redacted]' : value
  console.log(`token_length=${config.accessToken.length}`)
  const start = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/mcp/manifest/`, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403)
      return fail('unauthorized')
    if (response.status === 404 || response.status === 410)
      return fail('manifest_unavailable')
    if (!response.ok)
      return fail(`http_error http_status=${response.status}`)
    if (!response.body)
      return fail('malformed_manifest')

    const chunks: Uint8Array[] = []
    const reader = response.body.getReader()
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done)
        break
      size += value.byteLength
      if (size > MAX_BYTES)
        return fail('malformed_manifest')
      chunks.push(value)
    }
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      const deployment = parseDeployment(JSON.parse(body))
      const { status, ...diff } = compareDeployment(deployment)
      console.log(`server_version=${safe(deployment.server_version)} server_contract_version=${safe(deployment.contract_version)} deployed_hash=${safe(deployment.manifest_hash)}`)
      for (const [key, names] of Object.entries(diff)) {
        const display = names.slice(0, 32).map(safe)
        if (names.length > display.length)
          display.push(`(+${names.length - display.length})`)
        console.log(`${key}=${display.join(',') || '-'}`)
      }
      if (status === 'incompatible')
        return fail(status)
      if (status === 'additive')
        console.warn('doctor=additive')
      else
        console.log('doctor=exact')
      return 0
    }
    catch {
      return fail('malformed_manifest')
    }
  }
  catch {
    return fail('network_error')
  }
  finally {
    controller.abort()
    clearTimeout(timer)
    console.log(`duration_ms=${Math.round(performance.now() - start)}`)
  }
}
