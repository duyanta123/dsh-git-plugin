/**
 * `git/identity` 集成测试（spec §⑥：真实临时 git 仓库，断言纪律 = 验证世界而非自述——
 * 每个写场景后用独立 execFileSync `git config --get` 重读外部状态）。
 *
 * 退出码语义（本机 git 2.55.0.windows.2 实测，见实现注释）：--get 0=有值（空串值
 * 也是 0+空输出）、1=键未设置、128=--local 出仓等命令失败。
 * 全局配置用受控 GIT_CONFIG_GLOBAL（GIT_ENV 不墓碑该变量——正好验证继承链），
 * 隔离本机真实全局身份。
 */

import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GitService } from '../src/index.ts'
import { localSubprocess, scratchDir, scratchGlobalConfig, scratchRepo } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
const globalCleanups: Array<() => Promise<unknown>> = []
let realGlobalConfig: string | undefined

beforeAll(async () => {
  // 受控全局配置：global.name/email 可预测，隔离本机 ~/.gitconfig。
  // 用独立清理数组（afterEach 只清每测试夹具，afterAll 才清全局夹具）。
  const file = await scratchGlobalConfig('dshgit-id-global-', globalCleanups, {
    'user.name': 'global-name',
    'user.email': 'global@example.com',
  })
  realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = file
})

afterAll(async () => {
  if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig
  while (globalCleanups.length > 0) await globalCleanups.pop()!()
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Harness {
  service: InstanceType<typeof GitService>
}

function makeService(workspaceOverride: string): Harness {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
  })
  return { service }
}

/** 顶层会话 turn/start 注入（构造期 ctx.on('session/event') 的记忆路径）。 */
function emitTurnStart(harness: Harness, cwd: string): void {
  const ctx = (harness.service as unknown as { ctx: { emit(event: string, ...args: unknown[]): void } }).ctx
  ctx.emit('session/event', { header: { cwd, origin: 'user' } }, { type: 'turn/start' })
}

describe('git/identity（带参 @Remote 方法；spec §1.4 前置校验 1 的查询面）', () => {
  it('本地身份齐全：返回生效值，且与 world 重读一致（workspaceOverride 解析）', async () => {
    const repo = await scratchRepo('dshgit-id-ok-', cleanups, { name: 'repo-name', email: 'repo@example.com' })
    const { service } = makeService(repo)
    const result = await service.identity()
    expect(result.complete).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.name).toBe('repo-name')
    expect(result.email).toBe('repo@example.com')
    // world 重读（独立 git 进程）
    expect(execFileSync('git', ['config', '--get', 'user.name'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('repo-name')
    // workspace 解析：override 来源 + realpath
    expect(result.workspaceSource).toBe('workspace-override')
    expect(result.workspace).toBe(await (await import('node:fs/promises')).realpath(repo))
  })

  it('缺 user.email（exit 1）：missing 列出该键，complete=false，name 不受影响（local 视角）', async () => {
    const repo = await scratchRepo('dshgit-id-partial-', cleanups, { name: 'only-name' })
    const { service } = makeService(repo)
    // local 视角才有"键未设置"（合并视图会从全局配置按键回填，另案断言）。
    const result = await service.identity('local')
    expect(result.name).toBe('only-name')
    expect(result.email).toBeNull()
    expect(result.missing).toEqual(['user.email'])
    expect(result.complete).toBe(false)
  })

  it('合并视图按键回填：本地只有 name 时 email 从全局回填', async () => {
    const repo = await scratchRepo('dshgit-id-fill-', cleanups, { name: 'only-name' })
    const { service } = makeService(repo)
    const result = await service.identity()
    expect(result.name).toBe('only-name')
    expect(result.email).toBe('global@example.com')
    expect(result.complete).toBe(true)
  })

  it('空串值按缺失（exit 0 + 空输出 → null）', async () => {
    const repo = await scratchRepo('dshgit-id-empty-', cleanups, { name: 'named' })
    execFileSync('git', ['config', 'user.email', ''], { cwd: repo, encoding: 'utf8' })
    const { service } = makeService(repo)
    const result = await service.identity()
    expect(result.email).toBeNull()
    expect(result.missing).toEqual(['user.email'])
  })

  it('scope=local 只读仓库本地配置（机器全局被受控文件隔离后仍互不干扰）', async () => {
    const repo = await scratchRepo('dshgit-id-local-', cleanups) // 无本地身份
    const { service } = makeService(repo)
    const result = await service.identity('local')
    expect(result.name).toBeNull()
    expect(result.email).toBeNull()
    expect(result.missing).toEqual(['user.name', 'user.email'])
  })

  it('scope=global 读受控全局文件', async () => {
    const repo = await scratchRepo('dshgit-id-glob-', cleanups)
    const { service } = makeService(repo)
    const result = await service.identity('global')
    expect(result.name).toBe('global-name')
    expect(result.email).toBe('global@example.com')
  })

  it('合并视图本地覆盖全局', async () => {
    const repo = await scratchRepo('dshgit-id-merge-', cleanups, { name: 'local-wins' })
    const { service } = makeService(repo)
    const result = await service.identity('merged')
    expect(result.name).toBe('local-wins')
  })

  it('--local 出仓（无 .git 目录）→ git/git-error，stderr 脱敏后进 details', async () => {
    const plain = await scratchDir('dshgit-id-plain-', cleanups)
    const { service } = makeService(plain)
    const error = await service.identity('local').then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/git-error')
    const details = remote?.details as { op: string; exitCode: number | null; stderr: string; truncated: boolean }
    expect(details.op).toContain('identity')
    expect(details.exitCode).toBe(128)
    expect(details.stderr).toContain('--local can only be used inside a git repository')
    expect(details.truncated).toBe(false)
  })

  it('会话解析路径：无 override 时用最近顶层会话 cwd（source=session）', async () => {
    const repo = await scratchRepo('dshgit-id-sess-', cleanups, { name: 'session-name', email: 'session@example.com' })
    const { service } = makeService('')
    emitTurnStart({ service }, repo)
    const result = await service.identity()
    expect(result.workspaceSource).toBe('session')
    expect(result.name).toBe('session-name')
    expect(result.complete).toBe(true)
  })

  it('既无 override 也无会话：git/session-workspace-unresolved', async () => {
    const { service } = makeService('')
    const error = await service.resolveWorkspace().then(
      () => { throw new Error('expected rejection') },
      (cause: unknown) => cause,
    )
    expect(remoteErrorOf(error)?.code).toBe('git/session-workspace-unresolved')
    // identity 同样拒绝（不做 git 调用）
    await expect(service.identity()).rejects.toMatchObject({ code: 'git/session-workspace-unresolved' })
  })

  it('子代理会话不提供工作区（eligibility 语义贯通到服务）', async () => {
    const repo = await scratchRepo('dshgit-id-subagent-', cleanups, { name: 'agent-name' })
    const { service } = makeService('')
    emitTurnStart({ service }, repo) // 顶层会话先落位
    const ctx = (service as unknown as { ctx: { emit(event: string, ...args: unknown[]): void } }).ctx
    ctx.emit('session/event', { header: { cwd: 'D:/nowhere', origin: 'subagent' } }, { type: 'turn/start' })
    const result = await service.identity()
    expect(result.workspaceSource).toBe('session')
    // 最近合法会话仍是本 repo（子代理 cwd 被资格判定拒绝）
    expect(result.name).toBe('agent-name')
  })
})
