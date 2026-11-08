/**
 * v2 批次二 — 分支对比测试（[清单 36] compareBranches；docs/v2-implementation-plan.md
 * §4.7 host 真仓库范式行）。
 *
 * 覆盖：对称差计数与列表（ahead = compare 独有 / behind = base 独有，rev-list 双向
 * 计数与 log 两列互检）/ mergeBase（world git merge-base 对照）/ 同分支零列 / 祖先
 * 关系（单侧全量）/ 未知 ref ⇒ unknown-revision / 空修订 ⇒ bad-request invalid-options /
 * @Remote 接线一致。
 *
 * 断言纪律：验证世界而非自述——计数与 merge-base 用独立 git 进程重读对照。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GraphEngine } from '../src/graph.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX } from '../src/git-runner.ts'
import { DiffEngine } from '../src/diff.ts'
import { GitService } from '../src/index.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function makeEngine(): Promise<{ engine: GraphEngine; repo: string }> {
  const repo = await scratchRepo('dshgit-compare-', cleanups)
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

function commitFile(repo: string, rel: string, content: string, message: string): string {
  writeFileSync(join(repo, rel), content, 'utf8')
  git(repo, 'add', rel)
  git(repo, 'commit', '-qm', message)
  return git(repo, 'rev-parse', 'HEAD').trim()
}

/** world 重读（独立 git 进程）。 */
function worldOids(repo: string, ...args: string[]): string[] {
  const out = git(repo, 'log', '--topo-order', '--format=%H', ...args).trim()
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

describe('compareBranches — 对称差（[清单 36]）', () => {
  it('分叉双分支：ahead/behind 各 1（计数 == 列表 == world rev-list/log 对照）', async () => {
    const { engine, repo } = await makeEngine()
    const base = commitFile(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'feature')
    const featureOid = commitFile(repo, 'feature.txt', 'feature\n', 'feature work')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = commitFile(repo, 'main.txt', 'main\n', 'main work')

    const result = await engine.compareBranches({ base: 'main', compare: 'feature' })
    expect(result.base).toBe('main')
    expect(result.compare).toBe('feature')
    expect(result.aheadCount).toBe(1)
    expect(result.behindCount).toBe(1)
    expect(result.ahead.map((commit) => commit.oid)).toEqual([featureOid])
    expect(result.behind.map((commit) => commit.oid)).toEqual([mainOid])
    expect(result.mergeBase).toBe(base)
    // world 重读：rev-list --left-right --count 与 merge-base 的权威值。
    const worldCounts = git(repo, 'rev-list', '--left-right', '--count', 'main...feature').trim().split(/\s+/)
    expect(Number(worldCounts[0])).toBe(result.behindCount) // left = base(main) 独有
    expect(Number(worldCounts[1])).toBe(result.aheadCount) // right = compare(feature) 独有
    expect(git(repo, 'merge-base', 'main', 'feature').trim()).toBe(result.mergeBase)
    // 列表两列与 world log 区间对照。
    expect(result.ahead.map((commit) => commit.oid)).toEqual(worldOids(repo, 'main..feature'))
    expect(result.behind.map((commit) => commit.oid)).toEqual(worldOids(repo, 'feature..main'))
    // 列表元数据（subject）随行携带。
    expect(result.ahead[0]!.subject).toBe('feature work')
    expect(result.behind[0]!.subject).toBe('main work')
  })

  it('同分支对比：双列空、mergeBase = 自身 oid', async () => {
    const { engine, repo } = await makeEngine()
    const oid = commitFile(repo, 'f.txt', 'x\n', 'only commit')
    const result = await engine.compareBranches({ base: 'main', compare: 'main' })
    expect(result.aheadCount).toBe(0)
    expect(result.behindCount).toBe(0)
    expect(result.ahead).toEqual([])
    expect(result.behind).toEqual([])
    expect(result.mergeBase).toBe(oid)
  })

  it('祖先关系：feature 严格领先 main（ahead 全量、behind 空）', async () => {
    const { engine, repo } = await makeEngine()
    commitFile(repo, 'f.txt', 'v1\n', 'base')
    git(repo, 'checkout', '-qb', 'feature')
    const c1 = commitFile(repo, 'g.txt', '1\n', 'feature 1')
    const c2 = commitFile(repo, 'h.txt', '2\n', 'feature 2')
    const result = await engine.compareBranches({ base: 'main', compare: 'feature' })
    expect(result.aheadCount).toBe(2)
    expect(result.behindCount).toBe(0)
    expect(result.ahead.map((commit) => commit.oid)).toEqual([c2, c1])
    expect(result.behind).toEqual([])
    expect(result.mergeBase).toBe(git(repo, 'merge-base', 'main', 'feature').trim())
  })

  it('oid 修订同样可作 base/compare', async () => {
    const { engine, repo } = await makeEngine()
    const base = commitFile(repo, 'f.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'feature')
    const featureOid = commitFile(repo, 'feature.txt', 'feature\n', 'feature work')
    // base 是 feature 的祖先：ahead = {feature}，behind = {}（base 自身可达于 compare，不计数）。
    const byOid = await engine.compareBranches({ base, compare: featureOid })
    expect(byOid.aheadCount).toBe(1)
    expect(byOid.behindCount).toBe(0)
    expect(byOid.ahead[0]!.oid).toBe(featureOid)
    expect(byOid.behind).toEqual([])
    expect(byOid.mergeBase).toBe(base)
  })

  it('未知 ref ⇒ unknown-revision（details 带原词与 op）', async () => {
    const { engine, repo } = await makeEngine()
    commitFile(repo, 'f.txt', 'seed\n', 'seed')
    const badBase = await rejectionOf(() => engine.compareBranches({ base: 'no-such-branch', compare: 'main' }))
    expect(badBase.code).toBe('git/unknown-revision')
    expect(badBase.details).toEqual({ op: 'compareBranches', revision: 'no-such-branch' })
    const badCompare = await rejectionOf(() => engine.compareBranches({ base: 'main', compare: 'no-such-tag' }))
    expect(badCompare.code).toBe('git/unknown-revision')
    expect(badCompare.details.revision).toBe('no-such-tag')
  })

  it('空 base / compare ⇒ bad-request invalid-options', async () => {
    const { engine } = await makeEngine()
    const emptyBase = await rejectionOf(() => engine.compareBranches({ base: '', compare: 'main' }))
    expect(emptyBase.code).toBe('git/bad-request')
    expect(emptyBase.details.reason).toBe('invalid-options')
    const emptyCompare = await rejectionOf(() => engine.compareBranches({ base: 'main', compare: '' }))
    expect(emptyCompare.details.reason).toBe('invalid-options')
  })

  it('@Remote compareBranches 接线（GitService）与引擎一致', async () => {
    const { repo } = await makeEngine()
    commitFile(repo, 'f.txt', 'v1\n', 'base')
    git(repo, 'checkout', '-qb', 'feature')
    commitFile(repo, 'g.txt', '1\n', 'feature 1')
    git(repo, 'checkout', '-q', 'main')
    const service = makeService(repo)
    const viaService = await service.compareBranches({ base: 'main', compare: 'feature' })
    expect(viaService.aheadCount).toBe(1)
    expect(viaService.behindCount).toBe(0)
    expect(viaService.ahead[0]!.subject).toBe('feature 1')
  })
})
