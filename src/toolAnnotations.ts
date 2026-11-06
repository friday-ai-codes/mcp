import { FRIDAY_TOOLS, type FridayToolAnnotations } from './generated/toolCatalog.js'

/** Existing callers can still look up generated annotations by tool name. */
export const TOOL_ANNOTATIONS: Record<string, FridayToolAnnotations> = Object.fromEntries(
  FRIDAY_TOOLS.map(tool => [tool.name, tool.annotations]),
)
