/**
 * setup 辅助函数单测：延迟测量、仓库介绍截断、演示降级。
 */

import { describe, expect, it, vi } from 'vitest'
import { measureLatency, pickDemoRepository, repoIntro } from '../src/setup.js'

const CONFIG = { baseUrl: 'https://friday.internal', accessToken: 'secret-pat' }

describe('measureLatency', () => {
  it('健康端点正常时返回采样统计', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const report = await measureLatency('https://friday.internal', 3, fetchMock)
    expect(report.ok).toBe(true)
    expect(report.samples).toHaveLength(3)
    expect(report.best).toBeGreaterThanOrEqual(0)
    expect(report.avg).toBeGreaterThanOrEqual(report.best)
    // 1 次预热 + 3 次采样
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('网络错误时 ok=false 不抛异常', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const report = await measureLatency('https://friday.internal', 3, fetchMock)
    expect(report.ok).toBe(false)
  })

  it('非 2xx 时 ok=false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 502 }))
    const report = await measureLatency('https://friday.internal', 2, fetchMock)
    expect(report.ok).toBe(false)
  })
})

describe('repoIntro', () => {
  it('优先 ai_summary 并截断到 50 字以内', () => {
    const intro = repoIntro({ ai_summary: '这'.repeat(80) })
    expect(intro.length).toBeLessThanOrEqual(50)
    expect(intro.endsWith('…')).toBe(true)
  })

  it('无摘要时回落到 description', () => {
    expect(repoIntro({ description: '订单服务' })).toBe('订单服务')
  })

  it('全空时用元数据组一句', () => {
    const intro = repoIntro({ default_branch: 'main', index_status: 'completed' })
    expect(intro).toContain('main')
  })
})

describe('pickDemoRepository', () => {
  it('从 ranked_repos 中挑一个并给出介绍', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ranked_repos: [{ name: 'friday-ai', ai_summary: 'AI 驱动的敏捷开发自动化系统' }],
      }), { status: 200 }),
    )
    const demo = await pickDemoRepository(CONFIG, fetchMock)
    expect(demo).toEqual({ name: 'friday-ai', intro: 'AI 驱动的敏捷开发自动化系统' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://friday.internal/api/mcp/tools/route_repositories/')
    expect(init.headers.Authorization).toBe('Bearer secret-pat')
  })

  it('无仓库 / 请求失败时返回 null（优雅降级）', async () => {
    const emptyMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ranked_repos: [] }), { status: 200 }),
    )
    expect(await pickDemoRepository(CONFIG, emptyMock)).toBeNull()

    const errorMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    expect(await pickDemoRepository(CONFIG, errorMock)).toBeNull()
  })
})
