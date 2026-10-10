/**
 * 把 friday MCP server 注册进各 agent 的配置（幂等）。
 *
 * - cursor: 默认 ./.cursor/mcp.json；显式 --global 时写 ~/.cursor/mcp.json
 * - claude-code: 默认 project scope；显式 --global 时写 user scope
 * - codex: 默认 ./.codex/config.toml；显式 --global 时写 ~/.codex/config.toml
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

export function cursorConfigPath(project = true): string {
  return project
    ? path.join(process.cwd(), '.cursor', 'mcp.json')
    : path.join(homeDir(), '.cursor', 'mcp.json')
}

export function codexConfigPath(project = true): string {
  return project
    ? path.join(process.cwd(), '.codex', 'config.toml')
    : path.join(homeDir(), '.codex', 'config.toml')
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
      detail: `未找到 claude 命令。手动运行: claude mcp add --scope ${project ? 'project' : 'user'} friday -- npx -y @friday-ai-codes/mcp`,
    }
  }
  try {
    const scopeArgs = ['--scope', project ? 'project' : 'user']
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

function registerCodex(project: boolean): RegisterResult {
  const file = codexConfigPath(project)
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  if (/^\s*\[mcp_servers\.friday\]/m.test(existing))
    return { agent: 'codex', status: 'already', detail: `${file} 已存在 [mcp_servers.friday]` }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n${CODEX_SNIPPET}` : `${existing}${CODEX_SNIPPET}`
  fs.writeFileSync(file, next)
  return { agent: 'codex', status: 'registered', detail: `已追加到 ${file}` }
}

export function registerAgent(agent: AgentName, options: { project?: boolean } = {}): RegisterResult {
  const project = options.project ?? true
  switch (agent) {
    case 'cursor':
      return registerCursor(project)
    case 'claude-code':
      return registerClaudeCode(project)
    case 'codex':
      return registerCodex(project)
  }
}

/** doctor 用：检查各 agent 配置中 friday MCP 的注册状态（不修改任何文件）。 */
export function registrationStatus(options: { project?: boolean } = {}): Array<{ agent: AgentName, registered: boolean, location: string }> {
  const results: Array<{ agent: AgentName, registered: boolean, location: string }> = []
  const project = options.project ?? true

  const cursorFile = cursorConfigPath(project)
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
    const claudeFile = project
      ? path.join(process.cwd(), '.mcp.json')
      : path.join(homeDir(), '.claude.json')
    if (fs.existsSync(claudeFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(claudeFile, 'utf-8'))
        registered = Boolean(config?.mcpServers?.friday)
      }
      catch {
        registered = false
      }
    }
    results.push({ agent: 'claude-code', registered, location: claudeFile })
  }

  const codexFile = codexConfigPath(project)
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
