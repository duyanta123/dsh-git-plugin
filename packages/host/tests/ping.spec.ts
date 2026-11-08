/**
 * git.ping 专项测试（v2 批次一 P3-7，docs/v2-implementation-plan.md §10：host ping
 * 方法无专项测试 → 补「ping 走 readonly runner 执行 git --version，断言 GitPingResult
 * 形状与失败路径」）。范式照 identity.spec.ts：真实 spawn 的 SubprocessFace 替身 +
 * spawn record 断言 runner 前缀纪律。
 *
 * 覆盖：
 *   - 成功形状：{ ok: true, gitVersion }（gitVersion == world 重读 `git --version` 首行）；
 *   - readonly runner 纪律：argv 带 READONLY_PREFIX（--no-optional-locks / hooksPath
 *     /dev/null / fsmonitor=false——ping 走只读实例的四实例纪律）；
 *   - 失败路径：git 可执行文件不存在 → git/git-error（could not be spawned，message
 *     不含未脱敏 stderr 通道）。
 */

import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { GitService } from '../src/index.ts'
import { localSubprocess } from './support.ts'
import type { SpawnRecord } from './support.ts'

function makeService(gitCommand: string, workspaceOverride: string, record?: SpawnRecord[]): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess(record))
  return new GitService(ctx, {
    gitCommand,
    fastTimeoutMs: 15_000,
    commitTimeoutMs: 15_000,
    networkTimeoutMs: 20_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
    autoFetchIntervalMs: 0,
  })
}

describe('git.ping（P3-7 专项；readonly runner + GitPingResult 形状 + 失败路径）', () => {
  it('成功：{ ok: true, gitVersion }，gitVersion == world 重读 `git --version` 首行', async () => {
    const record: SpawnRecord[] = []
    // ping 不依赖工作区（cwd 取 TEMP/pwd）——workspaceOverride 给任意 cwd 即可。
    const service = makeService('git', process.cwd(), record)
    const result = await service.ping()
    expect(result.ok).toBe(true)
    expect(result.gitVersion).toMatch(/^git version \S+/)
    // world 重读：与独立 git --version 的首行一致。
    const worldVersion = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    expect(result.gitVersion).toBe(worldVersion)
    // readonly runner 纪律：ping 的 spawn 带只读加固前缀（安全前缀之后）。
    const pingSpawn = record.find(entry => entry.argv.includes('--version'))
    expect(pingSpawn).toBeDefined()
    expect(pingSpawn!.argv.slice(1, 3)).toEqual(['-c', 'safe.bareRepository=explicit'])
    expect(pingSpawn!.argv.slice(3, 6)).toEqual(['--no-optional-locks', '-c', 'core.hooksPath=/dev/null'])
    expect(pingSpawn!.argv).toContain('core.fsmonitor=false')
  })

  it('失败路径：git 可执行文件不存在 → git/git-error（could not be spawned）', async () => {
    const record: SpawnRecord[] = []
    const service = makeService('dshgit-no-such-git-binary', process.cwd(), record)
    const cause = await service.ping().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(cause)
    expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
    expect(remote!.code).toBe('git/git-error')
    expect(remote!.message).toContain('could not be spawned')
    const details = remote!.details as { op: string; exitCode: number | null }
    expect(details.op).toBe('ping(--version)')
    expect(details.exitCode).toBeNull()
  })
})
