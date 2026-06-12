/**
 * `friday-mcp setup` —— 交互式中文配置一条龙：
 *
 *   凭证问答（init）→ 注册进 agent（register）→ 连通性测速（ms 高亮）
 *   → 能力演示（随机介绍一个已索引仓库，≤50 字）。
 *
 * 每一步幂等可重跑；演示失败一律优雅降级，绝不让最后一步报错收场。
 * PAT 明文绝不回显、绝不写日志。
 */

import process from 'node:process'
import * as p from '@clack/prompts'
import { CONFIG_FILE, normalizeBaseUrl, resolveConfig, writeConfig } from './config.js'
import type { FridayConfig } from './config.js'
import { detectAgents, registerAgent } from './register.js'
import { formatMs, pc } from './ui.js'

// ---------------------------------------------------------------------------
// 连通性测速
// ---------------------------------------------------------------------------

export interface LatencyReport {
  ok: boolean
  samples: number[]
  best: number
  avg: number
}

/** 对 {baseUrl}/health 采样测延迟（1 次预热 + N 次计时）。 */
export async function measureLatency(
  baseUrl: string,
  samples = 4,
  fetchImpl: typeof fetch = fetch,
): Promise<LatencyReport> {
  const url = `${baseUrl}/health`
  const timings: number[] = []
  try {
    // 预热（建连 / TLS / DNS），不计入采样
    await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
    for (let i = 0; i < samples; i++) {
      const start = performance.now()
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
      if (!resp.ok)
        return { ok: false, samples: timings, best: 0, avg: 0 }
      timings.push(performance.now() - start)
    }
  }
  catch {
    return { ok: false, samples: timings, best: 0, avg: 0 }
  }
  const best = Math.min(...timings)
  const avg = timings.reduce((sum, value) => sum + value, 0) / timings.length
  return { ok: true, samples: timings, best, avg }
}

// ---------------------------------------------------------------------------
// 能力演示：随机介绍一个已索引仓库
// ---------------------------------------------------------------------------

interface RankedRepo {
  name?: string
  description?: string
  ai_summary?: string
  default_branch?: string
  index_status?: string
}

/** 把仓库元数据压成 ≤50 字的一句话介绍。 */
export function repoIntro(repo: RankedRepo): string {
  const source = (repo.ai_summary || repo.description || '').replace(/\s+/g, ' ').trim()
  if (source)
    return source.length > 50 ? `${source.slice(0, 49)}…` : source
  return `默认分支 ${repo.default_branch || 'main'}，索引状态 ${repo.index_status || '未知'}。`
}

/**
 * 调 route_repositories 拉已索引仓库并随机挑一个。
 * 任何失败（无仓库 / 网络 / 权限）都返回 null，由调用方降级。
 */
export async function pickDemoRepository(
  config: FridayConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string, intro: string } | null> {
  try {
    const resp = await fetchImpl(`${config.baseUrl}/api/mcp/tools/route_repositories/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '项目整体架构', top_k: 5 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok)
      return null
    const body = await resp.json() as { ranked_repos?: RankedRepo[] }
    const repos = (body.ranked_repos ?? []).filter(repo => repo.name)
    const repo = repos[Math.floor(Math.random() * repos.length)]
    if (!repo)
      return null
    return { name: repo.name!, intro: repoIntro(repo) }
  }
  catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 交互式 init
// ---------------------------------------------------------------------------

function cancelExit(): never {
  p.cancel('已取消，未做任何更改。')
  process.exit(1)
}

/** 交互式问答收集 baseUrl + token，写入配置。返回写入后的配置。 */
export async function interactiveInit(): Promise<FridayConfig> {
  const baseUrlAnswer = await p.text({
    message: '你的 Friday 服务地址是多少？',
    placeholder: '例如 https://friday.example.com',
    validate: (value) => {
      if (!value?.trim())
        return '地址不能为空'
      try {
        normalizeBaseUrl(value)
        return undefined
      }
      catch (e) {
        return e instanceof Error ? e.message : '无效地址'
      }
    },
  })
  if (p.isCancel(baseUrlAnswer))
    cancelExit()
  const baseUrl = normalizeBaseUrl(baseUrlAnswer)

  p.log.info(
    `${pc.bold('还没有访问令牌？')}\n`
    + `打开 Friday Web 控制台 → ${pc.cyan('个人资料 → 访问令牌')} → 创建令牌。\n`
    + `${pc.yellow('明文只显示一次')}，创建后立即复制。`,
  )
  const tokenAnswer = await p.password({
    message: '你的访问令牌（PAT）是多少？（输入不回显）',
    validate: value => (value?.trim() ? undefined : '令牌不能为空'),
  })
  if (p.isCancel(tokenAnswer))
    cancelExit()

  const config: FridayConfig = { baseUrl, accessToken: tokenAnswer.trim() }
  writeConfig(config)
  p.log.success(`配置已写入 ${pc.dim(CONFIG_FILE)}（权限 0600）`)
  return config
}

// ---------------------------------------------------------------------------
// setup 一条龙
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<number> {
  p.intro(pc.bgMagenta(pc.black(' Friday MCP 配置向导 ')))

  // 1) 凭证：已有配置则询问是否复用
  let config = resolveConfig()
  if (config) {
    const reuse = await p.confirm({
      message: `检测到已有配置（${pc.dim(config.baseUrl)}），直接使用？`,
    })
    if (p.isCancel(reuse))
      cancelExit()
    if (!reuse)
      config = await interactiveInit()
  }
  else {
    config = await interactiveInit()
  }

  // 2) 注册进 agent
  const agents = detectAgents()
  if (agents.length === 0) {
    p.log.warn('未嗅探到 Cursor / Claude Code / Codex，跳过注册。可稍后手动运行 register。')
  }
  else {
    p.log.step(`把 friday MCP server 注册进：${agents.map(agent => pc.green(agent)).join('、')}`)
    for (const agent of agents) {
      const result = registerAgent(agent)
      const mark = result.status === 'registered'
        ? pc.green('✓')
        : result.status === 'already' ? pc.blue('=') : pc.yellow('!')
      p.log.message(`${mark} ${agent}: ${result.detail}`)
    }
  }

  // 3) 连通性测速
  const spinner = p.spinner()
  spinner.start('正在测试连通性与延迟…')
  const latency = await measureLatency(config.baseUrl)
  if (!latency.ok) {
    spinner.stop(`${pc.red('✗')} 无法访问 ${config.baseUrl}/health`)
    p.log.warn('配置已保存，但服务不可达——请检查地址、网络、VPN 或端口后重跑 setup。')
    p.outro(`诊断命令：${pc.cyan('npx -y @friday-ai-codes/mcp doctor')}`)
    return 1
  }
  spinner.stop(
    `连通性正常 — 延迟 ${formatMs(latency.avg)}`
    + pc.dim(`（${latency.samples.length} 次采样，最快 ${Math.round(latency.best)}ms）`),
  )

  // 4) 能力演示：随机介绍一个已索引仓库
  const demoSpinner = p.spinner()
  demoSpinner.start('正在向 Friday 打个招呼…')
  const demo = await pickDemoRepository(config)
  if (demo) {
    demoSpinner.stop('Friday 已经认识你的仓库了，比如——')
    p.note(`${pc.bold(pc.cyan(demo.name))}\n${demo.intro}`, '能力演示')
  }
  else {
    demoSpinner.stop('认证打通（暂无已索引仓库可供演示）。')
  }

  p.outro(`全部就绪。重启 agent 会话后，${pc.cyan('friday')} 工具即会出现。`)
  return 0
}
