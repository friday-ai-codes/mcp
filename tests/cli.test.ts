import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../src/doctor.js'
import { CLIENT_CONTRACT_VERSION, CLIENT_MANIFEST_HASH, FRIDAY_TOOLS } from '../src/tools.js'
import packageInfo from '../package.json' with { type: 'json' }

vi.mock('../src/register.js', () => ({ registrationStatus: () => [{ agent: 'cursor', registered: true }] }))

const token = 'friday_pat_private_test_value'
let output: string[]
beforeEach(() => {
  output = []
  vi.stubEnv('FRIDAY_BASE_URL', 'https://friday.test')
  vi.stubEnv('FRIDAY_ACCESS_TOKEN', token)
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation(line => { output.push(String(line)) })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function exact() {
  return {
    server_version: '0.26.0', contract_version: CLIENT_CONTRACT_VERSION, manifest_hash: CLIENT_MANIFEST_HASH,
    manifest: { contract_version: CLIENT_CONTRACT_VERSION, tools: structuredClone(FRIDAY_TOOLS) },
  }
}
function fetchResult(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('doctor', () => {
  it('compares both identities at the authenticated endpoint', async () => {
    const request = fetchResult(exact())
    expect(await runDoctor(request)).toBe(0)
    expect(request).toHaveBeenCalledWith('https://friday.test/api/mcp/manifest/', expect.objectContaining({
      headers: { Authorization: `Bearer ${token}` }, redirect: 'manual',
    }))
    const printed = output.join('\n')
    for (const field of [`client_version=${packageInfo.version}`, 'server_version=0.26.0',
      `deployed_hash=${CLIENT_MANIFEST_HASH}`, `bundled_hash=${CLIENT_MANIFEST_HASH}`,
      'missing_on_client=-', 'missing_on_server=-', 'changed_tools=-', 'doctor=exact', 'duration_ms=', 'cursor: 已注册'])
      expect(printed).toContain(field)
    expect(printed).not.toContain(token)
  })

  it('reports server-only tools and changed tools for a compatible deployment', async () => {
    const deployment = exact()
    deployment.manifest_hash = 'f'.repeat(64)
    const first = deployment.manifest.tools[0]!
    deployment.manifest.tools.push({ ...first, name: 'new_tool' })
    const properties = first.inputSchema.properties as Record<string, Record<string, unknown>>
    properties.optional = { type: 'string' }
    properties.max_files!.maximum = 201
    expect(await runDoctor(fetchResult(deployment))).toBe(0)
    expect(output).toEqual(expect.arrayContaining(['doctor=additive', 'missing_on_client=new_tool', `changed_tools=${first.name}`]))
  })

  it.each(['missing', 'version', 'route', 'enum', 'required', 'bound', 'default', 'annotation', 'type', 'property'])(
    'rejects incompatible %s changes', async (change) => {
      const deployment = exact()
      deployment.manifest_hash = 'e'.repeat(64)
      const tool = deployment.manifest.tools[0]!
      const inputs = tool.inputSchema.properties as Record<string, Record<string, any>>
      const outputs = tool.outputSchema.properties as Record<string, Record<string, any>>
      switch (change) {
        case 'missing': deployment.manifest.tools.shift(); break
        case 'version': deployment.contract_version = deployment.manifest.contract_version = 'mcp-tools/v2'; break
        case 'route': tool.endpoint += 'new/'; break
        case 'enum': outputs.branch!.enum = ['only']; break
        case 'required': tool.inputSchema.required = ['repository_id', 'focus']; break
        case 'bound': inputs.context_chunks!.maxItems = 0; break
        case 'default': inputs.focus!.default = 'changed'; break
        case 'annotation': tool.annotations.destructiveHint = true; break
        case 'type': inputs.branch!.type = 'string'; break
        case 'property': delete outputs.analysis; break
      }
      expect(await runDoctor(fetchResult(deployment))).toBe(1)
      expect(output).toContain('doctor=incompatible')
      if (change === 'missing')
        expect(output).toContain(`missing_on_server=${tool.name}`)
      else if (change !== 'version')
        expect(output).toContain(`changed_tools=${tool.name}`)
    },
  )

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [404, 'manifest_unavailable'], [503, 'http_error http_status=503']] as const)(
    'returns a bounded diagnostic for HTTP %i', async (status, code) => {
      expect(await runDoctor(fetchResult({ detail: token }, status))).toBe(1)
      expect(output).toContain(`doctor=${code}`)
      expect(output.join(' ')).not.toContain(token)
    },
  )
  it('separates fetch errors from invalid JSON', async () => {
    expect(await runDoctor(async () => { throw Error(token) })).toBe(1)
    expect(output).toContain('doctor=network_error')
    expect(await runDoctor(async () => new Response(token))).toBe(1)
    expect(output).toContain('doctor=malformed_manifest')
    expect(output.join(' ')).not.toContain(token)
  })

  it.each(['oversize', 'duplicate', 'nested-schema', 'forged-exact', 'invalid-hash'])('rejects malformed %s', async (kind) => {
    const deployment = exact()
    const tool = deployment.manifest.tools[0]!
    switch (kind) {
      case 'oversize': tool.description = token.repeat(100_000); break
      case 'duplicate': deployment.manifest.tools.push(tool); break
      case 'nested-schema': tool.inputSchema.properties = { x: { type: 123 } }; break
      case 'forged-exact': deployment.manifest.tools.pop(); break
      case 'invalid-hash': deployment.manifest_hash = token; break
    }
    expect(await runDoctor(fetchResult(deployment))).toBe(1)
    expect(output).toContain('doctor=malformed_manifest')
    expect(output.join(' ')).not.toContain(token)
  })
  it('bounds and redacts reflected names and identity fields', async () => {
    const deployment = exact()
    deployment.server_version += token
    deployment.manifest_hash = 'a'.repeat(64)
    deployment.manifest.tools.push({ ...deployment.manifest.tools[0]!, name: token })
    for (let i = 0; i < 40; i++)
      deployment.manifest.tools.push({ ...deployment.manifest.tools[0]!, name: `new_tool_${i}` })
    expect(await runDoctor(fetchResult(deployment))).toBe(0)
    expect(output.join(' ')).toContain('[redacted]')
    expect(output.join(' ')).toContain('(+9)')
    expect(output.join(' ')).not.toContain(token)
  })
})
