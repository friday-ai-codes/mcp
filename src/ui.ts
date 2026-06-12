/**
 * 终端视觉层：渐变 ASCII banner 与延迟高亮，与 @friday-ai-codes/skills 观感统一。
 *
 * 注意：本模块只能用于 CLI 子命令（init / setup / doctor / register）。
 * stdio server 模式下绝不向 stdout 打印任何非协议内容。
 */

import process from 'node:process'
import pc from 'picocolors'

const BANNER_LINES = [
  '███████╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗',
  '██╔════╝██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝',
  '█████╗  ██████╔╝██║██║  ██║███████║ ╚████╔╝ ',
  '██╔══╝  ██╔══██╗██║██║  ██║██╔══██║  ╚██╔╝  ',
  '██║     ██║  ██║██║██████╔╝██║  ██║   ██║   ',
  '╚═╝     ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   ',
]

const GRADIENT_FROM = [0, 219, 222] // 青
const GRADIENT_TO = [252, 70, 107] // 品红

function supportsColor(): boolean {
  if (process.env.NO_COLOR)
    return false
  return Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1'
}

/** 渐变 ASCII banner（FRIDAY 大字 + MCP 副标）。 */
export function banner(version: string): string {
  const subtitle = 'M C P'
  const tagline = `Friday AI MCP 配置向导 v${version}`
  if (!supportsColor())
    return ['', ...BANNER_LINES, '', `  ${subtitle}`, `  ${tagline}`, ''].join('\n')

  const colored = BANNER_LINES.map((line, index) => {
    const t = index / (BANNER_LINES.length - 1)
    const [r, g, b] = GRADIENT_FROM.map((from, channel) =>
      Math.round(from + ((GRADIENT_TO[channel] ?? 0) - from) * t),
    )
    return `\x1B[38;2;${r};${g};${b}m${line}\x1B[0m`
  })
  return ['', ...colored, '', `  ${pc.bold(pc.magenta(subtitle))}   ${pc.dim(tagline)}`, ''].join('\n')
}

/** 毫秒数高亮：<100ms 绿 / <300ms 黄 / 其余红。 */
export function formatMs(ms: number): string {
  const text = `${Math.round(ms)}ms`
  if (ms < 100)
    return pc.bold(pc.green(text))
  if (ms < 300)
    return pc.bold(pc.yellow(text))
  return pc.bold(pc.red(text))
}

export { pc }
