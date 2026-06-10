/**
 * 把 friday MCP server 注册进各 agent 的配置（幂等）。
 *
 * - cursor: ~/.cursor/mcp.json（--project 时 ./.cursor/mcp.json）JSON 读-改-写
 * - claude-code: 优先执行 `claude mcp add`，无 claude 命令则打印手动指引
 * - codex: ~/.codex/config.toml 追加 [mcp_servers.friday] 片段（文本探测，存在即跳过）
 *
 * 只新增 friday 条目，绝不覆盖或删除用户已有配置。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AgentName = 'cursor' | 'claude-code' | 'codex'

export const SUPPORTED_AGENTS: AgentName[] = ['cursor', 'claude-code', 'codex']

const SERVER_ENTRY = { command: 'npx', args: ['-y', '@friday-ai-codes/mcp'] }

export interface RegisterResult {
  agent: AgentName
  status: 'registered' | 'already' | 'skipped' | 'manual'
  detail: string
}

function homeDir(): string {
  return os.homedir()
}

function hasClaudeCli(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/** 探测本机安装了哪些 agent（目录或命令存在即视为已安装）。 */
export function detectAgents(): AgentName[] {
  const found: AgentName[] = []
  if (fs.existsSync(path.join(homeDir(), '.cursor')))
    found.push('cursor')
  if (hasClaudeCli() || fs.existsSync(path.join(homeDir(), '.claude')))
    found.push('claude-code')
  if (fs.existsSync(path.join(homeDir(), '.codex')))
    found.push('codex')
  return found
}

export function cursorConfigPath(project: boolean): string {
  return project
    ? path.join(process.cwd(), '.cursor', 'mcp.json')
    : path.join(homeDir(), '.cursor', 'mcp.json')
}

export function codexConfigPath(): string {
  return path.join(homeDir(), '.codex', 'config.toml')
}

function registerCursor(project: boolean): RegisterResult {
  const file = cursorConfigPath(project)
  let config: Record<string, any> = {}
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf-8'))
    }
    catch {
      return { agent: 'cursor', status: 'skipped', detail: `${file} 不是合法 JSON，请手动处理后重试` }
    }
  }
  if (typeof config.mcpServers !== 'object' || config.mcpServers === null)
    config.mcpServers = {}
  if (config.mcpServers.friday)
    return { agent: 'cursor', status: 'already', detail: `${file} 已存在 friday 条目` }

  config.mcpServers.friday = SERVER_ENTRY
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return { agent: 'cursor', status: 'registered', detail: `已写入 ${file}` }
}

function registerClaudeCode(project: boolean): RegisterResult {
  if (!hasClaudeCli()) {
    return {
      agent: 'claude-code',
      status: 'manual',
      detail: '未找到 claude 命令。手动运行: claude mcp add --scope user friday -- npx -y @friday-ai-codes/mcp',
    }
  }
  try {
    // 缺省注册到 user scope（全局生效）；--project 时用 claude 默认的 local scope
    const scopeArgs = project ? [] : ['--scope', 'user']
    const output = execFileSync(
      'claude',
      ['mcp', 'add', ...scopeArgs, 'friday', '--', 'npx', '-y', '@friday-ai-codes/mcp'],
      { encoding: 'utf-8' },
    )
    return { agent: 'claude-code', status: 'registered', detail: output.trim() || 'claude mcp add 完成' }
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // claude mcp add 对已存在的 server 会报错——视为已注册
    if (/already exists/i.test(message))
      return { agent: 'claude-code', status: 'already', detail: 'friday 已注册于 Claude Code' }
    return { agent: 'claude-code', status: 'skipped', detail: `claude mcp add 失败: ${message}` }
  }
}

const CODEX_SNIPPET = `
[mcp_servers.friday]
command = "npx"
args = ["-y", "@friday-ai-codes/mcp"]
`

function registerCodex(): RegisterResult {
  const file = codexConfigPath()
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  if (/^\s*\[mcp_servers\.friday\]/m.test(existing))
    return { agent: 'codex', status: 'already', detail: `${file} 已存在 [mcp_servers.friday]` }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n${CODEX_SNIPPET}` : `${existing}${CODEX_SNIPPET}`
  fs.writeFileSync(file, next)
  return { agent: 'codex', status: 'registered', detail: `已追加到 ${file}` }
}

export function registerAgent(agent: AgentName, options: { project?: boolean } = {}): RegisterResult {
  switch (agent) {
    case 'cursor':
      return registerCursor(options.project ?? false)
    case 'claude-code':
      return registerClaudeCode(options.project ?? false)
    case 'codex':
      return registerCodex()
  }
}

/** doctor 用：检查各 agent 配置中 friday MCP 的注册状态（不修改任何文件）。 */
export function registrationStatus(): Array<{ agent: AgentName, registered: boolean, location: string }> {
  const results: Array<{ agent: AgentName, registered: boolean, location: string }> = []

  const cursorFile = cursorConfigPath(false)
  if (fs.existsSync(path.join(homeDir(), '.cursor'))) {
    let registered = false
    try {
      const config = JSON.parse(fs.readFileSync(cursorFile, 'utf-8'))
      registered = Boolean(config?.mcpServers?.friday)
    }
    catch {
      registered = false
    }
    results.push({ agent: 'cursor', registered, location: cursorFile })
  }

  if (hasClaudeCli() || fs.existsSync(path.join(homeDir(), '.claude'))) {
    let registered = false
    if (hasClaudeCli()) {
      try {
        const output = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf-8' })
        registered = /^friday[:\s]/m.test(output) || /\bfriday\b/.test(output)
      }
      catch {
        registered = false
      }
    }
    results.push({ agent: 'claude-code', registered, location: 'claude mcp list' })
  }

  const codexFile = codexConfigPath()
  if (fs.existsSync(path.join(homeDir(), '.codex'))) {
    const content = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, 'utf-8') : ''
    results.push({
      agent: 'codex',
      registered: /^\s*\[mcp_servers\.friday\]/m.test(content),
      location: codexFile,
    })
  }

  return results
}
