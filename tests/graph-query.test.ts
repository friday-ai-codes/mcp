import { describe, expect, it } from 'vitest'
import { FRIDAY_TOOLS, TOOL_ANNOTATIONS } from '../src/tools.js'
import { GRAPH_QUERY_MANIFEST } from '../src/generated/graphQueryManifest.js'

describe('graph_query contract discovery', () => {
  it('publishes the complete canonical input schema and read-only annotations', () => {
    const tool = FRIDAY_TOOLS.find(t => t.name === 'graph_query')
    expect(tool?.inputSchema).toEqual(GRAPH_QUERY_MANIFEST.inputSchema)
    expect(TOOL_ANNOTATIONS.graph_query).toEqual(GRAPH_QUERY_MANIFEST.annotations)
    expect(tool?.inputSchema.required).toContain('repository_id')
    expect(TOOL_ANNOTATIONS.graph_query?.readOnlyHint).toBe(true)
  })
})
