import { isDeepStrictEqual as equal } from 'node:util'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { CLIENT_CONTRACT_VERSION, CLIENT_MANIFEST_HASH, FRIDAY_TOOLS } from './tools.js'
import type { FridayToolDefinition } from './tools.js'

interface Deployment {
  server_version: string
  contract_version: string
  manifest_hash: string
  manifest: { contract_version: string, tools: FridayToolDefinition[] }
}

// Only compile this trusted envelope. Remote schemas are data, including their $refs.
const schema = { type: 'object', $ref: 'http://json-schema.org/draft-07/schema#' }
const identity = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._+/-]{0,63}$' }
const hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const validate = new AjvJsonSchemaValidator().getValidator({
  type: 'object',
  required: ['server_version', 'contract_version', 'manifest_hash', 'manifest'],
  properties: {
    server_version: { type: 'string', pattern: '^[0-9][a-zA-Z0-9.+_-]{0,63}$' },
    contract_version: identity,
    manifest_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    manifest: {
      type: 'object',
      required: ['contract_version', 'tools'],
      properties: {
        contract_version: identity,
        tools: {
          type: 'array', maxItems: 1024,
          items: {
            type: 'object',
            required: ['name', 'endpoint', 'description', 'route_name', 'inputSchema', 'outputSchema', 'annotations'],
            properties: {
              name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
              endpoint: { type: 'string', minLength: 1 },
              route_name: { type: 'string', minLength: 1 },
              description: { type: 'string' },
              inputSchema: { allOf: [{ type: 'object' }, schema] },
              outputSchema: { allOf: [{ type: 'object' }, schema] },
              annotations: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  ...Object.fromEntries(Object.keys(hints).map(k => [k, { type: 'boolean' }])),
                },
              },
            },
          },
        },
      },
    },
  },
})

export function parseDeployment(value: unknown): Deployment {
  if (!validate(value).valid)
    throw new Error('malformed_manifest')
  const deployment = value as Deployment
  const names = deployment.manifest.tools.map(tool => tool.name)
  if (new Set(names).size !== names.length || deployment.contract_version !== deployment.manifest.contract_version)
    throw new Error('malformed_manifest')
  return deployment
}

type Schema = boolean | Record<string, any>
const allTypes = ['string', 'number', 'integer', 'object', 'array', 'null', 'boolean']
function types(value: string | string[] | undefined): string[] {
  const list = value === undefined ? allTypes : [value].flat()
  return list.includes('number') ? [...list, 'integer'] : list
}

const lower = ['minimum', 'exclusiveMinimum', 'minItems', 'minLength', 'minProperties']
const upper = ['maximum', 'exclusiveMaximum', 'maxItems', 'maxLength', 'maxProperties']

// Mirror the server's compatibility policy for both request and result fields.
function covers(oldSchema: Schema, newSchema: Schema): boolean {
  if (equal(oldSchema, newSchema) || oldSchema === false)
    return true
  if (newSchema === false)
    return false
  const old = oldSchema === true ? {} : oldSchema
  const next = newSchema === true ? {} : newSchema
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].every((key) => {
    const a = old[key]
    const b = next[key]
    if (equal(a, b) || key === 'description' || key === 'title')
      return true
    if (key === 'properties')
      return Object.keys(a ?? {}).every(name => Object.hasOwn(b ?? {}, name) && covers(a[name], b[name]))
    if (key === 'required')
      return (b ?? []).every((name: string) => (a ?? []).includes(name))
    if (key === 'items' || key === 'additionalProperties')
      return covers(a ?? true, b ?? true)
    if (key === 'type')
      return types(a).every(type => types(b).includes(type))
    if (key === 'enum')
      return !b || !!a && a.every((v: unknown) => b.some((choice: unknown) => equal(v, choice)))
    if (key === 'anyOf')
      return !b || !!a && a.every((v: Schema) => b.some((choice: Schema) => covers(v, choice)))
    if (lower.includes(key))
      return b === undefined || b <= (a ?? (key.startsWith('min') && key !== 'minimum' ? 0 : -Infinity))
    if (upper.includes(key))
      return b === undefined || b >= (a ?? Infinity)
    if (['const', 'pattern', 'format'].includes(key))
      return b === undefined
    return false
  })
}

function compatible(previous: FridayToolDefinition, current: FridayToolDefinition): boolean {
  if (previous.route_name !== current.route_name || previous.endpoint !== current.endpoint)
    return false
  const annotations = new Set([...Object.keys(previous.annotations), ...Object.keys(current.annotations)])
  for (const key of annotations) {
    const value = Reflect.get(current.annotations, key)
    if (key !== 'title' && value !== Reflect.get(previous.annotations, key)
      && !(Object.hasOwn(hints, key) && value === Reflect.get(hints, key)))
      return false
  }
  return covers(previous.inputSchema, current.inputSchema) && covers(previous.outputSchema, current.outputSchema)
}

export function compareDeployment(deployed: Deployment) {
  const previous = new Map(FRIDAY_TOOLS.map(tool => [tool.name, tool]))
  const current = new Map(deployed.manifest.tools.map(tool => [tool.name, tool]))
  const missing_on_client = [...current.keys()].filter(name => !previous.has(name)).sort()
  const missing_on_server = [...previous.keys()].filter(name => !current.has(name)).sort()
  const changed_tools: string[] = []
  let breaking = missing_on_server.length > 0 || CLIENT_CONTRACT_VERSION !== deployed.contract_version
  for (const [name, tool] of previous) {
    const remote = current.get(name)
    if (remote && !equal(tool, remote)) {
      changed_tools.push(name)
      if (!compatible(tool, remote))
        breaking = true
    }
  }
  const same = equal(deployed.manifest, { contract_version: CLIENT_CONTRACT_VERSION, tools: FRIDAY_TOOLS })
  if (same !== (deployed.manifest_hash === CLIENT_MANIFEST_HASH))
    throw new Error('malformed_manifest')
  const status = same ? 'exact' : breaking ? 'incompatible' : 'additive'
  return { status, missing_on_client, missing_on_server, changed_tools: changed_tools.sort() }
}
