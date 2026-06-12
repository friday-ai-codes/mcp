/**
 * friday-mcp CLI 入口。
 *
 * - 无参数：启动 stdio MCP server（供 Cursor / Claude Code / Codex 调用）
 * - setup：交互式中文向导一条龙（凭证 → 注册 → 测速 → 能力演示）
 * - init：写入用户级配置 ~/.friday/config.json（命令式传参或交互式问答）
 * - register：把 friday MCP server 幂等注册进 Cursor / Claude Code / Codex 配置
 * - doctor：检查配置、注册状态与连通性（延迟 ms 高亮）
 *
 * CLI 子命令输出走 stdout 是安全的（无 MCP 协议流）；
 * server 模式下绝不向 stdout 打印任何非协议内容。
 */

import process from 'node:process'
import * as p from '@clack/prompts'
import { CONFIG_FILE, normalizeBaseUrl, resolveConfig, writeConfig } from './config.js'
import { detectAgents, registerAgent, registrationStatus, SUPPORTED_AGENTS } from './register.js'
import type { AgentName } from './register.js'
import { runStdioServer, SERVER_VERSION } from './server.js'
import { interactiveInit, measureLatency, runSetup } from './setup.js'
import { banner, formatMs, pc } from './ui.js'

function parseInitArgs(argv: string[]): { baseUrl?: string, token?: string } {
  const out: { baseUrl?: string, token?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base-url')
      out.baseUrl = argv[++i]
    else if (arg === '--token')
      out.token = argv[++i]
  }
  return out
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) })
    return resp.ok
  }
  catch {
    return false
  }
}

async function runInit(argv: string[]): Promise<number> {
  const { baseUrl: rawBaseUrl, token } = parseInitArgs(argv)

  // 无参数 + TTY → 交互式中文问答；非 TTY 则保持原有报错引导
  if (!rawBaseUrl && !token && process.stdin.isTTY && process.stdout.isTTY) {
    p.intro(pc.bgMagenta(pc.black(' Friday MCP 凭证配置 ')))
    const config = await interactiveInit()
    const healthy = await checkHealth(config.baseUrl)
    if (healthy)
      p.log.success(`连通性正常: ${config.baseUrl}/health`)
    else
      p.log.warn(`无法访问 ${config.baseUrl}/health —— 配置已保存，请确认地址可达（内网 / VPN / 端口）。`)
    p.outro(`下一步：${pc.cyan('npx -y @friday-ai-codes/mcp register')}（或直接跑 setup 一条龙）`)
    return healthy ? 0 : 1
  }

  if (!rawBaseUrl || !token) {
    console.error('用法: friday-mcp init --base-url <Friday 实例地址> --token <访问令牌>')
    console.error('或在终端直接运行 friday-mcp init（不带参数）进入交互式问答。')
    console.error('访问令牌在 Friday Web 控制台「个人资料 → 访问令牌」创建（明文只显示一次）。')
    return 1
  }

  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl)
  }
  catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  }

  writeConfig({ baseUrl, accessToken: token })
  console.log(`已写入 ${CONFIG_FILE}（权限 0600）`)

  const healthy = await checkHealth(baseUrl)
  if (healthy) {
    console.log(`连通性正常: ${baseUrl}/health`)
  }
  else {
    console.warn(`警告: 无法访问 ${baseUrl}/health —— 配置已保存，请确认地址可达（内网 / VPN / 端口）。`)
  }

  console.log('下一步: 注册 MCP server 到你的 agent（自动探测 Cursor / Claude Code / Codex）:')
  console.log('  npx -y @friday-ai-codes/mcp register')
  return 0
}

function parseRegisterArgs(argv: string[]): { agents: AgentName[], project: boolean, error?: string } {
  const agents: AgentName[] = []
  let project = false
  let all = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--agent') {
      const value = argv[++i] as AgentName
      if (!SUPPORTED_AGENTS.includes(value))
        return { agents: [], project, error: `不支持的 agent: ${value}（可用: ${SUPPORTED_AGENTS.join(' / ')}）` }
      agents.push(value)
    }
    else if (arg === '--all') {
      all = true
    }
    else if (arg === '--project') {
      project = true
    }
    else {
      return { agents: [], project, error: `未知参数: ${arg}` }
    }
  }
  if (all)
    return { agents: [...SUPPORTED_AGENTS], project }
  if (agents.length > 0)
    return { agents, project }
  return { agents: detectAgents(), project }
}

async function runRegister(argv: string[]): Promise<number> {
  const { agents, project, error } = parseRegisterArgs(argv)
  if (error) {
    console.error(error)
    console.error('用法: friday-mcp register [--agent cursor|claude-code|codex]... [--all] [--project]')
    return 1
  }
  if (agents.length === 0) {
    console.error('未探测到已安装的 agent（~/.cursor、~/.claude、~/.codex 均不存在）。')
    console.error('用 --agent 指定目标，例如: friday-mcp register --agent cursor')
    return 1
  }

  let failed = false
  for (const agent of agents) {
    const result = registerAgent(agent, { project })
    const mark = result.status === 'registered' ? '+' : result.status === 'already' ? '=' : '!'
    console.log(`[${mark}] ${agent}: ${result.detail}`)
    if (result.status === 'skipped')
      failed = true
  }

  if (!resolveConfig())
    console.log('提示: 尚未配置凭证。运行: npx -y @friday-ai-codes/mcp setup（交互式）')
  console.log('注册完成后需重启 agent 会话，friday 工具才会出现。')
  return failed ? 1 : 0
}

async function runDoctor(): Promise<number> {
  const statuses = registrationStatus()
  if (statuses.length === 0) {
    console.log('注册状态: 未探测到已安装的 agent')
  }
  else {
    for (const s of statuses) {
      const mark = s.registered ? pc.green('✓') : pc.red('✗')
      console.log(`${mark} ${s.agent} ${s.registered ? '已注册' : '未注册'}（${s.location}）`)
    }
  }

  const config = resolveConfig()
  if (!config) {
    console.error(`${pc.red('✗')} 未配置。运行: npx -y @friday-ai-codes/mcp setup（交互式中文向导）`)
    return 1
  }
  console.log(`baseUrl: ${config.baseUrl}`)
  console.log(`token: 已配置（${config.accessToken.length} 字符，不回显）`)

  const latency = await measureLatency(config.baseUrl)
  if (!latency.ok) {
    console.error(`${pc.red('✗')} 连通性异常：${config.baseUrl}/health 不可达`)
    return 1
  }
  console.log(
    `${pc.green('✓')} 连通性正常 — 延迟 ${formatMs(latency.avg)}`
    + pc.dim(`（${latency.samples.length} 次采样，最快 ${Math.round(latency.best)}ms）`),
  )
  return 0
}

function usage(): void {
  console.log(banner(SERVER_VERSION))
  console.log(`${pc.bold('用法')}
  npx -y @friday-ai-codes/mcp setup      ${pc.dim('# 交互式中文向导：凭证 → 注册 → 测速 → 演示（推荐）')}
  npx -y @friday-ai-codes/mcp init       ${pc.dim('# 仅配置凭证（无参数进入交互式问答）')}
  npx -y @friday-ai-codes/mcp init --base-url <地址> --token <令牌>
  npx -y @friday-ai-codes/mcp register   ${pc.dim('# 注册进 Cursor / Claude Code / Codex')}
  npx -y @friday-ai-codes/mcp doctor     ${pc.dim('# 诊断：配置 / 注册状态 / 连通性测速')}
  npx -y @friday-ai-codes/mcp serve      ${pc.dim('# 启动 stdio MCP server（agent 调用，勿手动运行）')}
`)
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv

  if (command === 'setup') {
    console.log(banner(SERVER_VERSION))
    process.exitCode = await runSetup()
    return
  }

  if (command === 'init') {
    process.exitCode = await runInit(rest)
    return
  }

  if (command === 'doctor') {
    process.exitCode = await runDoctor()
    return
  }

  if (command === 'register') {
    process.exitCode = await runRegister(rest)
    return
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }

  if (command && command !== 'serve') {
    console.error(`未知命令: ${command}（可用: setup / init / register / doctor / serve）`)
    process.exitCode = 1
    return
  }

  await runStdioServer()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
