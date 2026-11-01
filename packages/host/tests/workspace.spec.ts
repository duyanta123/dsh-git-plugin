/**
 * workspace.ts 集成测试（spec §⑥ 范式：真实临时目录；断言 = 解析结果落盘真实路径）。
 * 覆盖：session→cwd 解析服务面（eligibleSessionCwd / observe 时机）、
 * Config.workspaceOverride 优先、git/session-workspace-unresolved 域码。
 */

import { realpath } from 'node:fs/promises'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceResolver, eligibleSessionCwd } from '../src/workspace.ts'
import { scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function header(cwd?: string, origin?: string, delegationDepth?: number) {
  // exactOptionalPropertyTypes：可选键只以「存在且为 string/number」或「缺键」出现。
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(origin === undefined ? {} : { origin }),
    ...(delegationDepth === undefined ? {} : { delegationDepth }),
  }
}

describe('eligibleSessionCwd（dsh workspace-changes index.ts:60-62 资格语义）', () => {
  it('普通顶层会话：返回 header.cwd', () => {
    expect(eligibleSessionCwd(header('D:/repo', 'user'))).toBe('D:/repo')
  })

  it('子代理来源：跳过（undefined）', () => {
    expect(eligibleSessionCwd(header('D:/repo', 'subagent'))).toBeUndefined()
  })

  it('被委托回合（delegationDepth > 0）：跳过', () => {
    expect(eligibleSessionCwd(header('D:/repo', 'user', 1))).toBeUndefined()
    expect(eligibleSessionCwd(header('D:/repo', 'user', 3))).toBeUndefined()
  })

  it('无 cwd（宿主进程外会话）与空串：跳过', () => {
    expect(eligibleSessionCwd(header(undefined, 'user'))).toBeUndefined()
    expect(eligibleSessionCwd(header('', 'user'))).toBeUndefined()
  })

  it('delegationDepth 缺省视为 0（?? 0）', () => {
    expect(eligibleSessionCwd(header('D:/repo', 'user', undefined))).toBe('D:/repo')
  })
})

describe('WorkspaceResolver（session → cwd + workspaceOverride）', () => {
  it('非 turn/start 事件不记忆（observe 时机 = workspace-changes index.ts:84-87）', async () => {
    const dir = await scratchDir('dshgit-ws-', cleanups)
    const resolver = new WorkspaceResolver('')
    resolver.observe({ header: header(dir, 'user') }, { type: 'turn/end' })
    resolver.observe({ header: header(dir, 'user') }, { type: 'tool/result' })
    expect(resolver.observedSessionCwd).toBeUndefined()
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'git/session-workspace-unresolved' })
  })

  it('turn/start 记忆最近一个顶层会话 cwd，realpath 规范化（recorder.ts:136 语义）', async () => {
    const dir = await scratchDir('dshgit-ws-', cleanups)
    const resolver = new WorkspaceResolver('')
    resolver.observe({ header: header('D:/does-not-exist', 'user') }, { type: 'turn/start' })
    resolver.observe({ header: header(dir, 'user') }, { type: 'turn/start' })
    expect(resolver.observedSessionCwd).toBe(dir)
    const resolution = await resolver.resolve()
    expect(resolution.source).toBe('session')
    expect(resolution.root).toBe(await realpath(dir))
  })

  it('workspaceOverride 优先于已记忆的会话 cwd', async () => {
    const overrideDir = await scratchDir('dshgit-ws-ov-', cleanups)
    const sessionDir = await scratchDir('dshgit-ws-se-', cleanups)
    const resolver = new WorkspaceResolver(overrideDir)
    resolver.observe({ header: header(sessionDir, 'user') }, { type: 'turn/start' })
    const resolution = await resolver.resolve()
    expect(resolution.source).toBe('workspace-override')
    expect(resolution.root).toBe(await realpath(overrideDir))
  })

  it('workspaceOverride 指向不存在目录：解析失败且不回落会话（显式配置坏了要响）', async () => {
    const sessionDir = await scratchDir('dshgit-ws-se-', cleanups)
    const resolver = new WorkspaceResolver('D:/definitely/not/a/dir/dshgit')
    resolver.observe({ header: header(sessionDir, 'user') }, { type: 'turn/start' })
    const error = await resolver.resolve().then(
      () => { throw new Error('expected rejection') },
      (cause: unknown) => cause,
    )
    expect(remoteErrorOf(error)?.code).toBe('git/session-workspace-unresolved')
    expect((error as Error).message).toContain('workspaceOverride')
  })

  it('会话目录消失：git/session-workspace-unresolved', async () => {
    const dir = await scratchDir('dshgit-ws-gone-', cleanups)
    const resolver = new WorkspaceResolver('')
    resolver.observe({ header: header(dir, 'user') }, { type: 'turn/start' })
    await rmDir(dir)
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'git/session-workspace-unresolved' })
  })

  it('经宿主事件面自挂 session/event（构造期注册形态）', async () => {
    const dir = await scratchDir('dshgit-ws-ct-', cleanups)
    const listeners: Array<(session: { header: Record<string, unknown> }, event: { type: string }) => void> = []
    const host = {
      on(event: string, listener: (session: { header: Record<string, unknown> }, event: { type: string }) => void) {
        expect(event).toBe('session/event')
        listeners.push(listener)
        return listener
      },
    }
    const resolver = new WorkspaceResolver('', host)
    expect(listeners).toHaveLength(1)
    listeners[0]!({ header: header(dir, 'user') }, { type: 'turn/start' })
    const resolution = await resolver.resolve()
    expect(resolution.source).toBe('session')
    expect(resolution.root).toBe(await realpath(dir))
  })
})

async function rmDir(dir: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
}
