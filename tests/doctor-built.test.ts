import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, expect, it } from 'vitest'
import { CLIENT_CONTRACT_VERSION, CLIENT_MANIFEST_HASH, FRIDAY_TOOLS } from '../src/tools.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const token = 'friday_pat_synthetic_doctor'
const privateDescription = 'synthetic private manifest detail'
const name = 'zz_remote_tool'
type SchemaPosition = 'inputSchema' | 'outputSchema'

let catalogTools: string

function manifestJson(extra?: object) {
  const tools = extra ? catalogTools.slice(0, -1) + ',' + JSON.stringify(extra) + ']' : catalogTools
  return `{"contract_version":${JSON.stringify(CLIENT_CONTRACT_VERSION)},"tools":${tools}}\n`
}

const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  const build = createRequire(import.meta.url).resolve('tsdown/run')
  await promisify(execFile)(process.execPath, [build], { cwd: root })
  // Keep the generated JSON's numeric spelling (e.g. 1.0) for the canonical byte hash.
  const source = await readFile(new URL('../src/generated/toolCatalog.ts', import.meta.url), 'utf8')
  const array = source.split('export const FRIDAY_TOOLS: FridayToolDefinition[] = ')[1]!
  catalogTools = array.replace(/"(?:\\.|[^"\\])*"|\s+/gu, match => match.startsWith('"') ? match : '')
  expect(sha256(manifestJson())).toBe(CLIENT_MANIFEST_HASH)
}, 30_000)

async function doctor(invalid?: SchemaPosition) {
  // Match the server's sorted-key serialization, including the extra tool at the end.
  const schema = { properties: { value: { type: 'string' } }, type: 'object' }
  const manifest = manifestJson({
    annotations: FRIDAY_TOOLS[0]!.annotations,
    description: privateDescription,
    endpoint: '/api/mcp/tools/zz_remote_tool/',
    inputSchema: invalid === 'inputSchema' ? { type: 'string' } : schema,
    name,
    outputSchema: invalid === 'outputSchema' ? { type: 'string' } : schema,
    route_name: 'zz_remote_tool',
  })
  const body = JSON.stringify({ manifest: JSON.parse(manifest), server_version: '0.26.0', contract_version: CLIENT_CONTRACT_VERSION, manifest_hash: sha256(manifest) })
  const server = createServer((req, res) => {
    if (req.url !== '/api/mcp/manifest/' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = (server.address() as AddressInfo).port
    const env = { FRIDAY_BASE_URL: `http://127.0.0.1:${port}`, FRIDAY_ACCESS_TOKEN: token, HOME: root, USERPROFILE: root, PATH: '' }
    return await new Promise<{ code: number, stdout: string, stderr: string }>((resolve, reject) => {
      execFile(process.execPath, ['dist/cli.js', 'doctor'], { cwd: root, env }, (error, stdout, stderr) => {
        const code = error ? error.code : 0
        if (typeof code === 'number')
          resolve({ code, stdout, stderr })
        else
          reject(error)
      })
    })
  }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

it.each(['inputSchema', 'outputSchema'] as const)('rejects a remote-only tool with a string %s root', async (position) => {
  const { code, stdout, stderr } = await doctor(position)
  expect(code).toBe(1)
  expect(stderr.trim()).toBe('doctor=malformed_manifest')
  expect(stdout + stderr).not.toContain(token)
  expect(stdout + stderr).not.toContain(privateDescription)
})

it('accepts the same remote-only tool with object roots', async () => {
  const { code, stdout, stderr } = await doctor()
  expect(code).toBe(0)
  expect(stderr.trim()).toBe('doctor=additive')
  expect(stdout).toContain(`missing_on_client=${name}`)
})
