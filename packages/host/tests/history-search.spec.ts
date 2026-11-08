/**
 * v2 批次二 — 历史搜索测试（[清单 35/60] LogOptions 过滤参数；docs/v2-implementation-plan.md
 * §4.7 host 真仓库范式行）。
 *
 * 覆盖：`--grep=<q> -F` 固定串（正则元字符不解释）/ `--author`（正则语义）/ path
 * pathspec（world `git log -- <path>` 对照）/ **--follow rename 跟踪**（world
 * `git log --follow` 对照 + 无 follow 的收窄差）/ follow 无 path ⇒ bad-request
 * 'follow-without-path' / 未知 ref ⇒ unknown-revision / 过滤 + 分页组合（skip 在
 * 过滤结果上滑动）/ ref 起点 / unborn + 过滤空页 / @Remote 接线一致。
 *
 * 断言纪律：验证世界而非自述——过滤命中集合用独立 git 进程的同参命令对照。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogPage } from '../src/types.ts'
import { GraphEngine } from '../src/graph.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX } from '../src/git-runner.ts'
import { DiffEngine } from '../src/diff.ts'
import { GitService } from '../src/index.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { execFileSync } from 'node:child_process'
import { git, localSubprocess, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** 引擎装配（只读 runner + WorkspaceResolver + DiffEngine，log-refs-show.spec 同款）。 */
async function makeEngine(): Promise<{ engine: GraphEngine; repo: string }> {
  const repo = await scratchRepo('dshgit-hsearch-', cleanups)
  const runner = new GitRunner(localSubprocess(), 'git', {
    timeoutMs: 20_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  }, READONLY_PREFIX)
  const workspace = new WorkspaceResolver(repo)
  return { engine: new GraphEngine(runner, workspace, new DiffEngine(runner, workspace)), repo }
}

function makeService(workspaceOverride: string): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, { gitCommand: 'git', fastTimeoutMs: 15_000, workspaceOverride, autoFetchIntervalMs: 0 })
}

function gitAs(cwd: string, author: { name: string; email: string }, ...args: string[]): void {
  execFileSync('git', ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** world：同参 git log 的 oid 序（独立进程的权威命中集）。 */
function worldLog(repo: string, ...args: string[]): string[] {
  const out = git(repo, 'log', '--format=%H', ...args).trim()
  return out === '' ? [] : out.split('\n')
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

describe('history-search — query（--grep -F 固定串）', () => {
  it('-F 固定串：正则元字符不解释（"a.c" 不命中 "abc"）', async () => {
    const { engine, repo } = await makeEngine()
    writeFileSync(join(repo, 'f.txt'), 'x\n')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'seed')
    git(repo, 'commit', '--allow-empty', '-qm', 'add abc')
    git(repo, 'commit', '--allow-empty', '-qm', 'add a.c')

    const hits = await engine.log({ limit: 10, skip: 0, query: 'a.c' })
    expect(hits.commits.map((commit) => commit.subject)).toEqual(['add a.c'])
    // world 对照：同参固定串命中集一致。
    const world = worldLog(repo, '--grep=a.c', '-F')
    expect(hits.commits.map((commit) => commit.oid)).toEqual(world)
    // 反证：不加 -F（正则语义）会同时命中两者——固定串差异真实存在。
    expect(worldLog(repo, '--grep=a.c')).toHaveLength(2)
  })

  it('query 与分页组合：skip 在过滤结果上滑动（limit+1 over-fetch 不变）', async () => {
    const { engine, repo } = await makeEngine()
    writeFileSync(join(repo, 'f.txt'), 'x\n')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'seed')
    for (const subject of ['fix: one', 'chore: quiet', 'fix: two', 'fix: three']) {
      git(repo, 'commit', '--allow-empty', '-qm', subject)
    }
    const world = worldLog(repo, '--grep=fix:', '-F')
    expect(world).toHaveLength(3)

    const page1 = await engine.log({ limit: 2, skip: 0, query: 'fix:' })
    expect(page1.commits.map((commit) => commit.subject)).toEqual(['fix: three', 'fix: two'])
    expect(page1.hasMore).toBe(true)
    expect(page1.limitUsed).toBe(2)
    expect(page1.skipUsed).toBe(0)
    const page2 = await engine.log({ limit: 2, skip: 2, query: 'fix:' })
    expect(page2.commits.map((commit) => commit.subject)).toEqual(['fix: one'])
    expect(page2.hasMore).toBe(false)
    expect(page2.skipUsed).toBe(2)
    // 分页串联 = world 全集。
    expect([...page1.commits, ...page2.commits].map((commit) => commit.oid)).toEqual(world)
  })
})

describe('history-search — author / path / ref', () => {
  it('author 过滤（--author 正则语义）', async () => {
    const { engine, repo } = await makeEngine()
    git(repo, 'commit', '--allow-empty', '-qm', 'by t')
    gitAs(repo, alice, 'commit', '--allow-empty', '-qm', 'by alice')
    git(repo, 'commit', '--allow-empty', '-qm', 'by t again')

    const hits = await engine.log({ limit: 10, skip: 0, author: 'Alice' })
    expect(hits.commits).toHaveLength(1)
    expect(hits.commits[0]!.subject).toBe('by alice')
    expect(hits.commits[0]!.authorName).toBe('Alice')
    expect(hits.commits.map((commit) => commit.oid)).toEqual(worldLog(repo, '--author=Alice'))
    // 正则语义：'Al' 子串命中（与 query 的固定串不同面）。
    const regex = await engine.log({ limit: 10, skip: 0, author: 'Ali' })
    expect(regex.commits).toHaveLength(1)
  })

  it('path pathspec：只列触及该路径的提交（world git log -- <path> 对照）', async () => {
    const { engine, repo } = await makeEngine()
    writeFileSync(join(repo, 'f1.txt'), 'one\n')
    git(repo, 'add', 'f1.txt')
    git(repo, 'commit', '-qm', 'f1 v1')
    writeFileSync(join(repo, 'f2.txt'), 'two\n')
    git(repo, 'add', 'f2.txt')
    git(repo, 'commit', '-qm', 'f2 added')
    writeFileSync(join(repo, 'f1.txt'), 'one two\n')
    git(repo, 'commit', '-qam', 'f1 v2')

    const hits = await engine.log({ limit: 10, skip: 0, path: 'f1.txt' })
    expect(hits.commits.map((commit) => commit.subject)).toEqual(['f1 v2', 'f1 v1'])
    expect(hits.commits.map((commit) => commit.oid)).toEqual(worldLog(repo, '--', 'f1.txt'))
    // 中文路径同面（GIT_LITERAL_PATHSPECS=1 字面语义）。
    writeFileSync(join(repo, '中文.txt'), '内容\n')
    git(repo, 'add', '中文.txt')
    git(repo, 'commit', '-qm', '中文路径提交')
    const zh = await engine.log({ limit: 10, skip: 0, path: '中文.txt' })
    expect(zh.commits.map((commit) => commit.subject)).toEqual(['中文路径提交'])
  })

  it('--follow rename 跟踪（world --follow 对照 + 无 follow 的收窄差）', async () => {
    const { engine, repo } = await makeEngine()
    writeFileSync(join(repo, 'orig.txt'), 'v1\n')
    git(repo, 'add', 'orig.txt')
    git(repo, 'commit', '-qm', 'orig commit')
    git(repo, 'mv', 'orig.txt', 'moved.txt')
    git(repo, 'commit', '-qm', 'rename commit')
    writeFileSync(join(repo, 'moved.txt'), 'v2\n')
    git(repo, 'commit', '-qam', 'edit after rename')

    const followed = await engine.log({ limit: 10, skip: 0, path: 'moved.txt', follow: true })
    expect(followed.commits.map((commit) => commit.subject)).toEqual(['edit after rename', 'rename commit', 'orig commit'])
    expect(followed.commits.map((commit) => commit.oid)).toEqual(worldLog(repo, '--follow', '--', 'moved.txt'))

    const plain = await engine.log({ limit: 10, skip: 0, path: 'moved.txt' })
    expect(plain.commits).toHaveLength(2) // rename + edit（无 follow 不跨 rename）
    expect(plain.commits.map((commit) => commit.oid)).toEqual(worldLog(repo, '--', 'moved.txt'))

    // follow + 分页组合：limit 2 → hasMore。
    const paged = await engine.log({ limit: 2, skip: 0, path: 'moved.txt', follow: true })
    expect(paged.hasMore).toBe(true)
    expect(paged.commits).toHaveLength(2)
  })

  it('ref 起点：分支/oid 起点分页（world 对照）', async () => {
    const { engine, repo } = await makeEngine()
    writeFileSync(join(repo, 'f.txt'), 'a\n')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'base')
    const baseOid = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'checkout', '-qb', 'side')
    git(repo, 'commit', '--allow-empty', '-qm', 'side one')
    git(repo, 'commit', '--allow-empty', '-qm', 'side two')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'commit', '--allow-empty', '-qm', 'main ahead')

    const fromSide = await engine.log({ limit: 10, skip: 0, ref: 'side' })
    expect(fromSide.commits.map((commit) => commit.subject)).toEqual(['side two', 'side one', 'base'])
    expect(fromSide.commits.map((commit) => commit.oid)).toEqual(worldLog(repo, 'side'))

    const fromOid = await engine.log({ limit: 2, skip: 0, ref: baseOid })
    expect(fromOid.commits.map((commit) => commit.oid)).toEqual([baseOid])
    expect(fromOid.hasMore).toBe(false)
  })
})

describe('history-search — 守卫', () => {
  it('follow 无 path ⇒ bad-request follow-without-path（零命令守卫）', async () => {
    const { engine } = await makeEngine()
    const rejection = await rejectionOf(() => engine.log({ limit: 5, skip: 0, follow: true }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('follow-without-path')
    // path 为空串同样视作缺 path。
    const empty = await rejectionOf(() => engine.log({ limit: 5, skip: 0, follow: true, path: '' }))
    expect(empty.details.reason).toBe('follow-without-path')
  })

  it('未知 ref ⇒ unknown-revision（details.op=log, revision=原词）', async () => {
    const { engine } = await makeEngine()
    const rejection = await rejectionOf(() => engine.log({ limit: 5, skip: 0, ref: 'no-such-branch' }))
    expect(rejection.code).toBe('git/unknown-revision')
    expect(rejection.details).toEqual({ op: 'log', revision: 'no-such-branch' })
  })

  it('unborn + 过滤：空页不抛错（[清单 64] 语义不回归）', async () => {
    const { engine } = await makeEngine()
    const page = await engine.log({ limit: 5, skip: 0, query: 'anything', path: 'f.txt' })
    expect(page).toEqual({ commits: [], hasMore: false, skipUsed: 0, limitUsed: 5 })
  })

  it('缺省参数（仅 limit/skip）语义与 v1 完全一致（HEAD 全量 topo 分页）', async () => {
    const { engine, repo } = await makeEngine()
    for (let index = 0; index < 3; index++) {
      git(repo, 'commit', '--allow-empty', '-qm', `c${String(index)}`)
    }
    const page: LogPage = await engine.log({ limit: 2, skip: 1 })
    expect(page.commits.map((commit) => commit.subject)).toEqual(['c1', 'c0'])
    expect(page.hasMore).toBe(false)
  })

  it('@Remote log 接线（GitService）过滤参数与引擎一致', async () => {
    const { repo } = await makeEngine()
    git(repo, 'commit', '--allow-empty', '-qm', 'fix: alpha')
    git(repo, 'commit', '--allow-empty', '-qm', 'chore: other')
    const service = makeService(repo)
    const viaService = await service.log({ limit: 5, skip: 0, query: 'fix:' })
    expect(viaService.commits.map((commit) => commit.subject)).toEqual(['fix: alpha'])
  })

  it('过滤入参省略传递（wire 纪律）：空 query/author 不进命令（无过滤 = 全量）', async () => {
    const { engine, repo } = await makeEngine()
    git(repo, 'commit', '--allow-empty', '-qm', 'one')
    git(repo, 'commit', '--allow-empty', '-qm', 'two')
    const emptyFilters = await engine.log({ limit: 10, skip: 0, query: '', author: '', path: '', ref: '' })
    expect(emptyFilters.commits).toHaveLength(2)
    expect(emptyFilters.commits.map((commit) => commit.oid)).toEqual(worldLog(repo))
  })
})
