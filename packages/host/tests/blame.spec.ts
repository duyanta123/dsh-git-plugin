/**
 * v2 批次二 — blame 测试（[清单 34] + D3=B 分片纪律；docs/v2-implementation-plan.md
 * §4.7 host 真仓库范式行）。
 *
 * 覆盖：多作者多提交（author/authorAt 与 world 逐字段对照 + pickaxe -S 独立世界
 * oracle）/ 范围合并正确（同 oid 连续行 = 一段）/ **-L 区间往返正确性 / 区间行号
 * 与全区行号一致性**（相邻窗口边界行归属一致）/ 全区超限 ⇒ blame-oversized（精确
 * lineCount）/ 区间超限同钳（end 截短 + truncated）/ outputMaxBytes 互相校验
 * （小预算引擎 ⇒ 有效上限 < 文件行数）/ 工作区未提交行（全零 oid + Not Committed
 * Yet）/ ref blame（numstat 探测 + 二进制 show 回落）/ 空 path / 空 range 守卫 /
 * 不存在 path 与仓库外 path 的行为如实断言 / parseBlamePorcelain 纯函数契约。
 *
 * 断言纪律：验证世界而非自述——内容归属用 `git log -S`（pickaxe，独立于 blame 的
 * 世界面）与 `git show -s --format` 对照。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BlameResult } from '../src/types.ts'
import {
  BLAME_LINE_BYTES_BUDGET, BLAME_MAX_LINES, BlameEngine, effectiveBlameMaxLines, parseBlamePorcelain,
} from '../src/blame.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX } from '../src/git-runner.ts'
import { GitService } from '../src/index.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

// 真实 git 子进程用例（含 50k 行 blame）——资源裕量放宽（log-refs-show.spec 同款）。
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeEngine(repo: string, outputMaxBytes?: number): BlameEngine {
  const runner = new GitRunner(localSubprocess(), 'git', {
    timeoutMs: 30_000, outputMaxBytes: outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
  }, READONLY_PREFIX)
  return new BlameEngine(runner, new WorkspaceResolver(repo), outputMaxBytes !== undefined ? { outputMaxBytes } : {})
}

function makeService(workspaceOverride: string, outputMaxBytes?: number): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, {
    gitCommand: 'git', fastTimeoutMs: 20_000, workspaceOverride,
    ...(outputMaxBytes !== undefined ? { outputMaxBytes } : {}),
    autoFetchIntervalMs: 0,
  })
}

/** 以指定作者提交（多作者夹具；world 作者对照用）。 */
function gitAs(cwd: string, author: { name: string; email: string }, ...args: string[]): void {
  execFileSync('git', ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** world oracle（独立于 blame）：pickaxe 找到引入该内容的提交（内容唯一且不改删）。 */
function pickaxeOid(repo: string, needle: string, path: string): string {
  const out = git(repo, 'log', '--format=%H', '-S', needle, '--', path).trim()
  expect(out, `pickaxe -S ${JSON.stringify(needle)} should hit exactly one commit`).not.toContain('\n')
  return out
}

/** world：提交的 author unix 秒与作者名。 */
function worldAuthor(repo: string, oid: string): { name: string; atUnix: number; subject: string } {
  return {
    name: git(repo, 'show', '-s', '--format=%an', oid).trim(),
    atUnix: Number(git(repo, 'show', '-s', '--format=%at', oid).trim()),
    subject: git(repo, 'show', '-s', '--format=%s', oid).trim(),
  }
}

/** 展开区间为逐行 oid 映射（区间行号一致性断言用）。 */
function lineOwnerOids(result: BlameResult): Map<number, string> {
  const owners = new Map<number, string>()
  for (const range of result.ranges) {
    for (let line = range.startLine; line < range.startLine + range.count; line++) {
      owners.set(line, range.oid)
    }
  }
  return owners
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, message: remote!.message, details: remote!.details as Record<string, unknown> }
}

const alice = { name: 'Alice', email: 'alice@example.com' }
const bob = { name: 'Bob', email: 'bob@example.com' }

describe('blame — 全区多作者（world 对照）', () => {
  it('多作者多提交：区间合并正确、author/authorAt/subject 与 world 逐字段一致（pickaxe oracle）', async () => {
    const repo = await scratchRepo('dshgit-blame-multi-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'alpha-1\nalpha-2\nalpha-3\n', 'utf8')
    gitAs(repo, alice, 'add', 'f.txt')
    gitAs(repo, alice, 'commit', '-qm', 'alice writes alpha')
    writeFileSync(join(repo, 'f.txt'), 'alpha-1\nalpha-2\nalpha-3\nbeta-4\nbeta-5\n', 'utf8')
    gitAs(repo, bob, 'commit', '-qam', 'bob appends beta')
    const aliceOid = pickaxeOid(repo, 'alpha-1', 'f.txt')
    const bobOid = pickaxeOid(repo, 'beta-4', 'f.txt')

    const result = await makeEngine(repo).blame({ path: 'f.txt' })
    expect(result.path).toBe('f.txt')
    expect(result.ref).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.lineCount).toBe(5)
    // 范围合并：alice 的 3 行连续 = 一段、bob 的 2 行连续 = 一段。
    expect(result.ranges).toEqual([
      { startLine: 1, count: 3, oid: aliceOid, authorName: 'Alice', authoredAt: expect.any(String) },
      { startLine: 4, count: 2, oid: bobOid, authorName: 'Bob', authoredAt: expect.any(String) },
    ])
    // world 对照：author-time（unix 秒）→ ISO 与 %at 同值；作者名一致。
    const aliceWorld = worldAuthor(repo, aliceOid)
    const bobWorld = worldAuthor(repo, bobOid)
    expect(result.ranges[0]!.authoredAt).toBe(new Date(aliceWorld.atUnix * 1000).toISOString())
    expect(result.ranges[1]!.authoredAt).toBe(new Date(bobWorld.atUnix * 1000).toISOString())
    expect(result.ranges[0]!.authorName).toBe(aliceWorld.name)
    // commits 去重清单（首现序）+ shortOid + subject。
    expect(result.commits).toEqual([
      { oid: aliceOid, shortOid: aliceOid.slice(0, 7), authorName: 'Alice', subject: aliceWorld.subject },
      { oid: bobOid, shortOid: bobOid.slice(0, 7), authorName: 'Bob', subject: bobWorld.subject },
    ])
  })

  it('空文件：ranges 空集、lineCount 0', async () => {
    const repo = await scratchRepo('dshgit-blame-empty-', cleanups)
    writeFileSync(join(repo, 'empty.txt'), '', 'utf8')
    git(repo, 'add', 'empty.txt')
    git(repo, 'commit', '-qm', 'empty file')
    const result = await makeEngine(repo).blame({ path: 'empty.txt' })
    expect(result).toMatchObject({ path: 'empty.txt', ref: null, lineCount: 0, truncated: false, ranges: [], commits: [] })
  })

  it('工作区未提交行：全零 oid + Not Committed Yet（真实世界如实过线）', async () => {
    const repo = await scratchRepo('dshgit-blame-wip-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'committed\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'committed line')
    const committedOid = git(repo, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(repo, 'f.txt'), 'committed\nuncommitted edit\n', 'utf8')
    const result = await makeEngine(repo).blame({ path: 'f.txt' })
    expect(result.ranges).toHaveLength(2)
    expect(result.ranges[0]).toMatchObject({ startLine: 1, count: 1, oid: committedOid })
    expect(result.ranges[1]).toMatchObject({
      startLine: 2, count: 1, oid: '0000000000000000000000000000000000000000', authorName: 'Not Committed Yet',
    })
    expect(result.commits.map((commit) => commit.oid)).toContain('0000000000000000000000000000000000000000')
  })
})

describe('blame — -L 区间（D3=B 分片纪律）', () => {
  it('-L 区间往返正确：区间行号与全区行号一致（边界行归属逐行对照）', async () => {
    const repo = await scratchRepo('dshgit-blame-range-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'six lines')
    writeFileSync(join(repo, 'f.txt'), 'l1\nl2\nl3\nl4\nl5-x\nl6\n', 'utf8')
    git(repo, 'commit', '-qam', 'edit line 5')
    const c1 = pickaxeOid(repo, 'l1', 'f.txt')
    const c2 = pickaxeOid(repo, 'l5-x', 'f.txt')

    const full = await makeEngine(repo).blame({ path: 'f.txt' })
    expect(full.ranges).toEqual([
      { startLine: 1, count: 4, oid: c1, authorName: expect.any(String), authoredAt: expect.any(String) },
      { startLine: 5, count: 1, oid: c2, authorName: expect.any(String), authoredAt: expect.any(String) },
      { startLine: 6, count: 1, oid: c1, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])

    // 区间 2..4：行号与全区一致（同 oid 同行号）；区间结果按行号展开 == 全区切片。
    const slice = await makeEngine(repo).blame({ path: 'f.txt', range: { start: 2, end: 4 } })
    expect(slice.truncated).toBe(false)
    const fullOwners = lineOwnerOids(full)
    const sliceOwners = lineOwnerOids(slice)
    for (let line = 2; line <= 4; line++) {
      expect(sliceOwners.get(line), `line ${String(line)} owner`).toBe(fullOwners.get(line))
    }
    expect(slice.ranges).toEqual([
      { startLine: 2, count: 3, oid: c1, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])
    // 区间 5..6 跨两段：边界行 5（c2）与 6（c1）与全区一致。
    const cross = await makeEngine(repo).blame({ path: 'f.txt', range: { start: 5, end: 6 } })
    expect(cross.ranges).toEqual([
      { startLine: 5, count: 1, oid: c2, authorName: expect.any(String), authoredAt: expect.any(String) },
      { startLine: 6, count: 1, oid: c1, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])
  })

  it('全区超限 ⇒ blame-oversized（精确 lineCount=50_001）；-L 分片成功；相邻窗口边界一致', async () => {
    const repo = await scratchRepo('dshgit-blame-oversize-', cleanups)
    // 50_001 行：1..25_000 由 c1 写入、25_001..50_001 由 c2 追加（内容唯一供 pickaxe）。
    const first = Array.from({ length: 25_000 }, (_, i) => `c1 line ${String(i + 1)}\n`).join('')
    const second = Array.from({ length: 25_001 }, (_, i) => `c2 line ${String(i + 1)}\n`).join('')
    writeFileSync(join(repo, 'big.txt'), first, 'utf8')
    git(repo, 'add', 'big.txt')
    git(repo, 'commit', '-qm', 'first half')
    writeFileSync(join(repo, 'big.txt'), first + second, 'utf8')
    git(repo, 'commit', '-qam', 'second half')
    const c1 = pickaxeOid(repo, 'c1 line 24999', 'big.txt')
    const c2 = pickaxeOid(repo, 'c2 line 25001', 'big.txt')

    const engine = makeEngine(repo)
    const oversize = await rejectionOf(() => engine.blame({ path: 'big.txt' }))
    expect(oversize.code).toBe('git/blame-oversized')
    expect(oversize.details).toEqual({ path: 'big.txt', lineCount: 50_001, maxLines: BLAME_MAX_LINES })

    // 分片 1：-L 1,50_000（恰在硬顶内）成功，truncated=false；首段归属 c1。
    const slice = await engine.blame({ path: 'big.txt', range: { start: 1, end: 50_000 } })
    expect(slice.truncated).toBe(false)
    expect(slice.lineCount).toBe(50_001)
    expect(slice.ranges[0]).toMatchObject({ startLine: 1, count: 25_000, oid: c1 })
    expect(slice.ranges[1]).toMatchObject({ startLine: 25_001, count: 25_000, oid: c2 })

    // 相邻窗口边界一致：窗口 A 尾行（25_000）与窗口 B 首行（25_001）归属与 pickaxe 同。
    const windowA = await engine.blame({ path: 'big.txt', range: { start: 24_999, end: 25_000 } })
    const windowB = await engine.blame({ path: 'big.txt', range: { start: 25_001, end: 25_002 } })
    expect(windowA.ranges).toEqual([
      { startLine: 24_999, count: 2, oid: c1, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])
    expect(windowB.ranges).toEqual([
      { startLine: 25_001, count: 2, oid: c2, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])
  })

  it('区间超限同钳：end 截短到 start+maxLines-1，truncated=true（50k 文件 -L 1,60_000）', async () => {
    const repo = await scratchRepo('dshgit-blame-clamp-', cleanups)
    const body = Array.from({ length: 50_001 }, (_, i) => `line ${String(i + 1)}\n`).join('')
    writeFileSync(join(repo, 'big.txt'), body, 'utf8')
    git(repo, 'add', 'big.txt')
    git(repo, 'commit', '-qm', '50k lines')
    const result = await makeEngine(repo).blame({ path: 'big.txt', range: { start: 1, end: 60_000 } })
    expect(result.truncated).toBe(true)
    expect(result.lineCount).toBe(50_001)
    // 同 oid 连续行合并为一段（单提交写入全部行）。
    expect(result.ranges).toEqual([
      { startLine: 1, count: 50_000, oid: expect.any(String), authorName: expect.any(String), authoredAt: expect.any(String) },
    ])
  })

  it('outputMaxBytes 互相校验：小预算引擎的有效上限 < 文件行数（同钳 + oversized）', async () => {
    const repo = await scratchRepo('dshgit-blame-budget-', cleanups)
    const body = Array.from({ length: 150 }, (_, i) => `line ${String(i + 1)}\n`).join('')
    writeFileSync(join(repo, 'f.txt'), body, 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', '150 lines')
    // floor(12_800/128) = 100 ⇒ 有效上限 100（< BLAME_MAX_LINES）。
    const engine = makeEngine(repo, 12_800)
    const oversize = await rejectionOf(() => engine.blame({ path: 'f.txt' }))
    expect(oversize.code).toBe('git/blame-oversized')
    expect(oversize.details).toEqual({ path: 'f.txt', lineCount: 150, maxLines: 100 })
    const clamped = await engine.blame({ path: 'f.txt', range: { start: 1, end: 150 } })
    expect(clamped.truncated).toBe(true)
    expect(clamped.ranges[0]!.count).toBe(100)
  })
})

describe('blame — ref 模式与错误形状', () => {
  it('ref 探测零写入：hash-object（无 -w）不向对象库落对象；空 stdin 与 mktree 同 oid（独立评审修复回归）', async () => {
    const repo = await scratchRepo('dshgit-blame-nowrite-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'v1\nv2\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'two lines')
    // 夹具世界基准：git count-objects -v 的 loose 计数（hash-object / numstat / blame
    // 全链执行前后的对象库必须零变化——blame 是只读操作，ref 探测不得落空树对象）。
    const looseObjectCount = (): number =>
      Number(git(repo, 'count-objects', '-v').split('\n')
        .find((line) => line.startsWith('count:'))!.slice('count:'.length).trim())
    const before = looseObjectCount()
    const result = await makeEngine(repo).blame({ path: 'f.txt', ref: 'HEAD' })
    expect(result.lineCount).toBe(2) // 探测照常出精确值（numstat 路径工作）
    expect(looseObjectCount()).toBe(before)
    // 命令等价性（hash 算法无关）：`hash-object -t tree --stdin`（无 -w）与 `mktree`
    // 的空 stdin 输出同 oid——mktree 只作等价 oracle（放在计数断言之后，其落盘不污染断言）。
    const viaHashObject = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: repo, input: '', encoding: 'utf8' }).trim()
    const viaMktree = execFileSync('git', ['mktree'], { cwd: repo, input: '', encoding: 'utf8' }).trim()
    expect(viaHashObject).toMatch(/^[0-9a-f]{40,64}$/)
    expect(viaHashObject).toBe(viaMktree)
  })

  it('ref blame：numstat 探测路径（HEAD~1 只见首提交的行）', async () => {
    const repo = await scratchRepo('dshgit-blame-ref-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'v1\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'v1')
    const v1Oid = git(repo, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(repo, 'f.txt'), 'v1\nv2\n', 'utf8')
    git(repo, 'commit', '-qam', 'v2')
    const headOid = git(repo, 'rev-parse', 'HEAD').trim()

    const atV1 = await makeEngine(repo).blame({ path: 'f.txt', ref: 'HEAD~1' })
    expect(atV1.ref).toBe('HEAD~1')
    expect(atV1.lineCount).toBe(1)
    expect(atV1.ranges).toEqual([
      { startLine: 1, count: 1, oid: v1Oid, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])

    const atHead = await makeEngine(repo).blame({ path: 'f.txt', ref: 'HEAD' })
    expect(atHead.lineCount).toBe(2)
    expect(atHead.ranges.map((range) => range.oid)).toEqual([v1Oid, headOid])
  })

  it('二进制文件（numstat "-" → git show 探测回落）：ref blame 照常工作', async () => {
    const repo = await scratchRepo('dshgit-blame-binary-', cleanups)
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x44, 0x41, 0x54, 0x00, 0x41, 0x0a, 0x42, 0x0a]))
    git(repo, 'add', 'bin.dat')
    git(repo, 'commit', '-qm', 'binary with two text lines')
    const oid = git(repo, 'rev-parse', 'HEAD').trim()
    const result = await makeEngine(repo).blame({ path: 'bin.dat', ref: 'HEAD' })
    expect(result.lineCount).toBe(2)
    expect(result.ranges).toEqual([
      { startLine: 1, count: 2, oid, authorName: expect.any(String), authoredAt: expect.any(String) },
    ])
  })

  it('不存在 path：git 自身的失败如实映射（git-error，message 带 git 原文）', async () => {
    const repo = await scratchRepo('dshgit-blame-missing-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'x\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'seed')
    const rejection = await rejectionOf(() => makeEngine(repo).blame({ path: 'nope.txt' }))
    expect(rejection.code).toBe('git/git-error')
    // git 原文进 details.stderr（sanitizeStderr 后）——message 只有 op 与退出码。
    expect(String(rejection.details.stderr)).toContain("no such path 'nope.txt' in HEAD")
  })

  it('仓库外 path：fs 探测拒绝（越界守卫）→ git 自身拒绝如实映射', async () => {
    const repo = await scratchRepo('dshgit-blame-traversal-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'x\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'seed')
    const rejection = await rejectionOf(() => makeEngine(repo).blame({ path: '../outside.txt' }))
    expect(rejection.code).toBe('git/git-error')
  })

  it('空 path / 非法区间 ⇒ bad-request invalid-options；区间 start>end ⇒ 同', async () => {
    const repo = await scratchRepo('dshgit-blame-guards-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'x\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'seed')
    const engine = makeEngine(repo)
    const emptyPath = await rejectionOf(() => engine.blame({ path: '' }))
    expect(emptyPath.code).toBe('git/bad-request')
    expect(emptyPath.details.reason).toBe('invalid-options')
    const badRange = await rejectionOf(() => engine.blame({ path: 'f.txt', range: { start: 3, end: 1 } }))
    expect(badRange.code).toBe('git/bad-request')
    expect(badRange.details.reason).toBe('invalid-options')
    const zeroStart = await rejectionOf(() => engine.blame({ path: 'f.txt', range: { start: 0, end: 1 } }))
    expect(zeroStart.details.reason).toBe('invalid-options')
    // start 超出文件行数：git 自身拒绝（"file f.txt has only 1 lines"）。
    const beyond = await rejectionOf(() => engine.blame({ path: 'f.txt', range: { start: 100, end: 200 } }))
    expect(beyond.code).toBe('git/git-error')
    expect(String(beyond.details.stderr)).toContain('has only 1 line')
  })

  it('@Remote blame 接线（GitService）与引擎一致', async () => {
    const repo = await scratchRepo('dshgit-blame-service-', cleanups)
    writeFileSync(join(repo, 'f.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'two lines')
    const service = makeService(repo)
    const viaService = await service.blame({ path: 'f.txt' })
    const viaEngine = await makeEngine(repo).blame({ path: 'f.txt' })
    expect(viaService).toEqual(viaEngine)
  })
})

describe('blame — effectiveBlameMaxLines / parseBlamePorcelain 纯函数', () => {
  it('effectiveBlameMaxLines：min(硬顶, floor(outputMaxBytes/128))，至少 1', () => {
    expect(BLAME_MAX_LINES).toBe(50_000)
    expect(effectiveBlameMaxLines(DEFAULT_OUTPUT_MAX_BYTES)).toBe(BLAME_MAX_LINES) // 8 MiB / 128 > 硬顶
    expect(effectiveBlameMaxLines(12_800)).toBe(100)
    expect(effectiveBlameMaxLines(127)).toBe(1)
    expect(effectiveBlameMaxLines(0)).toBe(1)
    expect(BLAME_LINE_BYTES_BUDGET).toBe(128)
  })

  it('porcelain 解析：组首四段 + 续行三段 + 头块 + boundary + 全零 oid（实测形态样本）', () => {
    // 形态取自本机 git 2.55.0.windows.2 实测（组首 4 段带 count、同组续行 3 段、
    // root 提交带 boundary、未提交行全零 oid）。
    const stdout = [
      'aaaa000000000000000000000000000000000000 1 1 2',
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'author-tz +0800',
      'committer Alice',
      'committer-mail <alice@example.com>',
      'committer-time 1700000000',
      'committer-tz +0800',
      'summary first commit',
      'boundary',
      'filename f.txt',
      '\tline one',
      'aaaa000000000000000000000000000000000000 2 2',
      '\tline two',
      '0000000000000000000000000000000000000000 3 3 1',
      'author Not Committed Yet',
      'author-mail <not.committed.yet>',
      'author-time 1700000001',
      'author-tz +0800',
      'committer Not Committed Yet',
      'committer-mail <not.committed.yet>',
      'committer-time 1700000001',
      'committer-tz +0800',
      'summary Version of f.txt from f.txt',
      'previous aaaa000000000000000000000000000000000000 f.txt',
      'filename f.txt',
      '\tworktree edit',
    ].join('\n') + '\n'
    const parsed = parseBlamePorcelain(stdout)
    expect(parsed.ranges).toEqual([
      {
        startLine: 1, count: 2, oid: 'aaaa000000000000000000000000000000000000',
        authorName: 'Alice', authoredAt: new Date(1_700_000_000 * 1000).toISOString(),
      },
      {
        startLine: 3, count: 1, oid: '0000000000000000000000000000000000000000',
        authorName: 'Not Committed Yet', authoredAt: new Date(1_700_000_001 * 1000).toISOString(),
      },
    ])
    expect(parsed.commits).toEqual([
      { oid: 'aaaa000000000000000000000000000000000000', shortOid: 'aaaa000', authorName: 'Alice', subject: 'first commit' },
      { oid: '0000000000000000000000000000000000000000', shortOid: '0000000', authorName: 'Not Committed Yet', subject: 'Version of f.txt from f.txt' },
    ])
    expect(parsed.coveredEnd).toBe(3)
  })

  it('porcelain 解析：-L 窗口的组边界重开（同提交两组间被它提交隔断 → 不合并）', () => {
    const stdout = [
      'aaaa000000000000000000000000000000000000 1 1 1',
      'author A', 'author-mail <a@e>', 'author-time 100', 'author-tz +0000',
      'committer A', 'committer-mail <a@e>', 'committer-time 100', 'committer-tz +0000',
      'summary c1',
      '\tx',
      'bbbb000000000000000000000000000000000000 2 2 1',
      'author B', 'author-mail <b@e>', 'author-time 200', 'author-tz +0000',
      'committer B', 'committer-mail <b@e>', 'committer-time 200', 'committer-tz +0000',
      'summary c2',
      '\ty',
      'aaaa000000000000000000000000000000000000 3 3 1',
      '\tz',
    ].join('\n') + '\n'
    const parsed = parseBlamePorcelain(stdout)
    expect(parsed.ranges.map((range) => [range.startLine, range.count, range.oid.slice(0, 4)])).toEqual([
      [1, 1, 'aaaa'], [2, 1, 'bbbb'], [3, 1, 'aaaa'],
    ])
    expect(parsed.commits).toHaveLength(2)
  })

  it('porcelain 解析：空输出 / 契约破坏要响', () => {
    expect(parseBlamePorcelain('')).toEqual({ ranges: [], commits: [], coveredEnd: 0 })
    expect(() => parseBlamePorcelain('aaaa000000000000000000000000000000000000 1 1 1')).toThrow(/newline-terminated/)
    // 首现 oid 无头块（内容行先到）= 契约破坏。
    expect(() => parseBlamePorcelain('aaaa000000000000000000000000000000000000 1 1 1\n\tline\n')).toThrow(/header incomplete/)
    // final 行号不连续。
    expect(() => parseBlamePorcelain([
      'aaaa000000000000000000000000000000000000 1 1 1', 'author A', 'author-mail <a@e>',
      'author-time 100', 'author-tz +0000', 'summary s',
      '\tx',
      'aaaa000000000000000000000000000000000000 3 3 1',
      '\ty',
    ].join('\n') + '\n')).toThrow(/not consecutive/)
    // 无法识别的裸行。
    expect(() => parseBlamePorcelain([
      'garbage line', 'aaaa000000000000000000000000000000000000 1 1 1', 'author A', 'author-mail <a@e>',
      'author-time 100', 'author-tz +0000', 'summary s', '\tx',
    ].join('\n') + '\n')).toThrow(/unrecognized line/)
    // 头块行在无 pending 提交时出现 = 契约破坏。
    expect(() => parseBlamePorcelain([
      'author A',
      'aaaa000000000000000000000000000000000000 1 1 1', 'author A', 'author-mail <a@e>',
      'author-time 100', 'author-tz +0000', 'summary s', '\tx',
    ].join('\n') + '\n')).toThrow(/header line outside/)
    // author-time 非数值 = 契约破坏。
    expect(() => parseBlamePorcelain([
      'aaaa000000000000000000000000000000000000 1 1 1', 'author A', 'author-mail <a@e>',
      'author-time not-a-number', 'author-tz +0000', 'summary s', '\tx',
    ].join('\n') + '\n')).toThrow(/author-time/)
  })
})
