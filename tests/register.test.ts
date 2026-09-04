import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexConfigPath, cursorConfigPath, registerAgent, registrationStatus } from '../src/register.js'

const originalCwd = process.cwd()

afterEach(() => {
  process.chdir(originalCwd)
})

function enterTemporaryProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-mcp-project-scope-'))
  process.chdir(dir)
  return process.cwd()
}

describe('project-scoped registration', () => {
  it('uses project paths by default for Cursor and Codex', () => {
    const dir = enterTemporaryProject()

    expect(cursorConfigPath()).toBe(path.join(dir, '.cursor', 'mcp.json'))
    expect(codexConfigPath()).toBe(path.join(dir, '.codex', 'config.toml'))
  })

  it('registers Codex in the current project when scope is omitted', () => {
    const dir = enterTemporaryProject()

    const result = registerAgent('codex')
    const projectConfig = path.join(dir, '.codex', 'config.toml')

    expect(result.status).toBe('registered')
    expect(result.detail).toContain(projectConfig)
    expect(fs.readFileSync(projectConfig, 'utf-8')).toContain('[mcp_servers.friday]')
  })

  it('reports only the current project registration by default', () => {
    enterTemporaryProject()
    registerAgent('cursor')
    registerAgent('codex')

    const byAgent = new Map(registrationStatus().map(status => [status.agent, status]))

    expect(byAgent.get('cursor')?.registered).toBe(true)
    expect(byAgent.get('codex')?.registered).toBe(true)
    expect(byAgent.get('cursor')?.location).toContain(`${path.sep}.cursor${path.sep}mcp.json`)
    expect(byAgent.get('codex')?.location).toContain(`${path.sep}.codex${path.sep}config.toml`)
  })
})
