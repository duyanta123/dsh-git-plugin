/**
 * v2 批次四 — submoduleStatus 测试（[清单 61] 只列不递归；
 * docs/v2-implementation-plan.md §6.7 host 真仓库范式行）。
 *
 * 覆盖：真仓嵌 submodule 三态解析（clean / mismatch / uninitialized——`git submodule
 * add` → submodule 内推进 HEAD（+ 漂移）→ `git submodule deinit`（- 未初始化），每态
 * world 重读 `git submodule status` 前缀 / `git -C sub rev-parse HEAD` / `git ls-files
 * -s` gitlink）；**不递归断言**（submodule 内再嵌 submodule，host 结果只列顶层——
 * 无 --recursive）；无 submodule ⇒ 空数组；非仓库 ⇒ git/no-repository；行解析器夹具
 * （U 前缀映射 dirty、未知前缀映射 unknown、缺 oid/路径的契约破坏要响）。
 *
 * 断言纪律：验证世界而非自述——每个状态断言后用独立 execFileSync git 重读。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { assembleSubmoduleEntries, parseSubmoduleLines } from '../src/submodule.ts'
import { git, localSubprocess, scratchDir, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeService(workspaceOverride: string): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000,
    workspaceOverride, autoFetchIntervalMs: 0,
  })
}

function worldGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** git ≥2.38.1 的 file 协议子模块限制（protocol.file.allow=user 默认）——测试本地路径夹具显式放行。 */
function addSubmodule(parent: string, childPath: string, name: string): void {
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', childPath, name], {
    cwd: parent, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function worldSubmoduleStatusLines(parent: string): string[] {
  // 前缀字符（' '/'-'/'+'/'U'）是世界断言的对象——**不可 trim**（首行前导空格即
  // clean 态本体），只滤空行。
  const out = execFileSync('git', ['submodule', 'status'], { cwd: parent, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split('\n').filter((line) => line !== '')
}

function worldGitlinkOid(parent: string, name: string): string {
  const line = worldGit(parent, 'ls-files', '-s', name)
  const mode = line.split(/\s+/)[0] ?? ''
  expect(mode).toBe('160000')
  return line.split(/\s+/)[1] ?? ''
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, details: remote!.details as Record<string, unknown> }
}

describe('submoduleStatus — [清单 61] 只列不递归（§6.7）', () => {
  it('真仓嵌 submodule：clean → mismatch → uninitialized 三态解析（每态 world 重读）', async () => {
    const parent = await scratchRepo('dshgit-sub-parent-', cleanups)
    const child = await scratchRepo('dshgit-sub-child-', cleanups)
    writeFileSync(join(child, 'c.txt'), 'child content\n', 'utf8')
    git(child, 'add', 'c.txt')
    git(child, 'commit', '-qm', 'child seed')
    git(parent, 'commit', '--allow-empty', '-qm', 'parent seed')
    const service = makeService(parent)

    // 态 1：clean——add 后检出 == index 记录（前缀 ' '）。
    addSubmodule(parent, child, 'sub')
    const clean = await service.submoduleStatus()
    expect(clean.submodules).toHaveLength(1)
    const cleanEntry = clean.submodules[0]!
    expect(cleanEntry.path).toBe('sub')
    expect(cleanEntry.state).toBe('clean')
    expect(cleanEntry.oid).toBe(worldGit(join(parent, 'sub'), 'rev-parse', 'HEAD'))
    expect(cleanEntry.recordedOid).toBe(worldGitlinkOid(parent, 'sub'))
    expect(cleanEntry.oid).toBe(cleanEntry.recordedOid)
    expect(worldSubmoduleStatusLines(parent)[0]!.startsWith(' ')).toBe(true)

    // 态 2：mismatch——submodule 内推进 HEAD（检出 ≠ index 记录，前缀 '+'）。
    writeFileSync(join(parent, 'sub', 'c.txt'), 'drifted\n', 'utf8')
    git(join(parent, 'sub'), 'add', 'c.txt')
    git(join(parent, 'sub'), 'commit', '-qm', 'drift inside submodule')
    const mismatch = await service.submoduleStatus()
    expect(mismatch.submodules[0]!.state).toBe('mismatch')
    expect(mismatch.submodules[0]!.oid).toBe(worldGit(join(parent, 'sub'), 'rev-parse', 'HEAD'))
    expect(mismatch.submodules[0]!.oid).not.toBe(mismatch.submodules[0]!.recordedOid)
    expect(mismatch.submodules[0]!.recordedOid).toBe(worldGitlinkOid(parent, 'sub'))
    expect(worldSubmoduleStatusLines(parent)[0]!.startsWith('+')).toBe(true)

    // 态 3：uninitialized——deinit 后无检出（oid null，recordedOid 保留，前缀 '-'）。
    execFileSync('git', ['submodule', 'deinit', '-f', 'sub'], { cwd: parent, stdio: ['ignore', 'pipe', 'pipe'] })
    const uninitialized = await service.submoduleStatus()
    expect(uninitialized.submodules[0]!.state).toBe('uninitialized')
    expect(uninitialized.submodules[0]!.oid).toBeNull()
    expect(uninitialized.submodules[0]!.recordedOid).toBe(worldGitlinkOid(parent, 'sub'))
    expect(worldSubmoduleStatusLines(parent)[0]!.startsWith('-')).toBe(true)
  })

  it('不递归断言：submodule 内再嵌 submodule，host 结果只列顶层（无 --recursive）', async () => {
    const parent = await scratchRepo('dshgit-sub-norec-parent-', cleanups)
    const child = await scratchRepo('dshgit-sub-norec-child-', cleanups)
    const grandchild = await scratchRepo('dshgit-sub-norec-grand-', cleanups)
    for (const [repo, file] of [[child, 'c.txt'], [grandchild, 'g.txt']] as const) {
      writeFileSync(join(repo, file), 'content\n', 'utf8')
      git(repo, 'add', file)
      git(repo, 'commit', '-qm', `seed ${file}`)
    }
    git(parent, 'commit', '--allow-empty', '-qm', 'parent seed')
    addSubmodule(parent, child, 'sub')
    // submodule 克隆内再嵌 grandchild（会进 sub 的 index；父仓 status --recursive 可见）。
    addSubmodule(join(parent, 'sub'), grandchild, 'subsub')
    git(join(parent, 'sub'), 'commit', '-qm', 'embed grandchild')

    const service = makeService(parent)
    const result = await service.submoduleStatus()
    // 只列顶层：path 集不含 subsub（对齐 [61]「只列不递归」）。
    expect(result.submodules).toHaveLength(1)
    expect(result.submodules[0]!.path).toBe('sub')
    // 对照：--recursive 面确实可见两层（夹具自检——证明非递归是 host 选择而非夹具缺陷）。
    const recursive = worldGit(parent, 'submodule', 'status', '--recursive').split('\n').filter((line) => line !== '')
    expect(recursive.length).toBe(2)
  })

  it('无 submodule ⇒ 空数组（不抛错）；非仓库 ⇒ git/no-repository', async () => {
    const repo = await scratchRepo('dshgit-sub-none-', cleanups)
    git(repo, 'commit', '--allow-empty', '-qm', 'seed')
    const service = makeService(repo)
    const empty = await service.submoduleStatus()
    expect(empty.submodules).toEqual([])
    // 非仓库目录：no-repository。
    const plain = await scratchDir('dshgit-sub-plain-', cleanups)
    const plainService = makeService(plain)
    const rejection = await rejectionOf(() => plainService.submoduleStatus())
    expect(rejection.code).toBe('git/no-repository')
    expect(rejection.details.probed).toBe(plain)
  })

  it('行解析器夹具：U 前缀 → dirty、未知前缀 → unknown、契约破坏要响（缺 oid/空路径/双读不一致）', () => {
    const lines = parseSubmoduleLines(' 0123456789012345678901234567890123456789 a (heads/main)\nU0123456789012345678901234567890123456789 b\nX0123456789012345678901234567890123456789 Q\n')
    expect(lines).toEqual([
      { prefix: ' ', oid: '0123456789012345678901234567890123456789', path: 'a' },
      { prefix: 'U', oid: '0123456789012345678901234567890123456789', path: 'b' },
      { prefix: 'X', oid: '0123456789012345678901234567890123456789', path: 'Q' },
    ])
    const entries = assembleSubmoduleEntries(lines.slice(0, 2), [
      { prefix: ' ', oid: 'fedcba9876543210fedcba9876543210fedcba98', path: 'a' },
      { prefix: ' ', oid: 'fedcba9876543210fedcba9876543210fedcba98', path: 'b' },
    ])
    expect(entries[0]).toEqual({ path: 'a', oid: '0123456789012345678901234567890123456789', recordedOid: 'fedcba9876543210fedcba9876543210fedcba98', state: 'clean' })
    expect(entries[1]).toEqual({ path: 'b', oid: '0123456789012345678901234567890123456789', recordedOid: 'fedcba9876543210fedcba9876543210fedcba98', state: 'dirty' })
    // 未知前缀 → unknown；'-' → uninitialized + oid null。
    const unknown = assembleSubmoduleEntries(
      [{ prefix: 'X', oid: '0123456789012345678901234567890123456789', path: 'q' }],
      [{ prefix: ' ', oid: 'fedcba9876543210fedcba9876543210fedcba98', path: 'q' }],
    )
    expect(unknown[0]!.state).toBe('unknown')
    const uninitialized = assembleSubmoduleEntries(
      [{ prefix: '-', oid: '0123456789012345678901234567890123456789', path: 'q' }],
      [{ prefix: '-', oid: '0123456789012345678901234567890123456789', path: 'q' }],
    )
    expect(uninitialized[0]).toEqual({ path: 'q', oid: null, recordedOid: '0123456789012345678901234567890123456789', state: 'uninitialized' })
    // 契约破坏要响。
    expect(() => parseSubmoduleLines('garbage line\n')).toThrow()
    expect(() => parseSubmoduleLines('0123456789012345678901234567890123456789 a\n')).toThrow()
    expect(() => parseSubmoduleLines(' 0123456789012345678901234567890123456789\n')).toThrow()
    expect(() => assembleSubmoduleEntries(
      [{ prefix: ' ', oid: '0123456789012345678901234567890123456789', path: 'a' }],
      [],
    )).toThrow()
    expect(() => assembleSubmoduleEntries(
      [{ prefix: ' ', oid: '0123456789012345678901234567890123456789', path: 'a' }],
      [{ prefix: ' ', oid: 'fedcba9876543210fedcba9876543210fedcba98', path: 'b' }],
    )).toThrow()
  })
})
