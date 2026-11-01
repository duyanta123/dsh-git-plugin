/**
 * M8 — 提交图数据层测试（spec §⑥ log-refs-show 行 + workflow M8 任务口径：
 * 已知 DAG 仓库 分页=全量、边界、unborn 空页）。
 *
 * 覆盖：log format 解析（多行 body、字段回接）；分页 over-fetch limit+1/hasMore/
 * skip（分页串联 = 全量单呼；world 重读 git log --topo-order 对照）；limit/skip
 * 钳制（normalize 纯函数 + 引擎行为）；unborn HEAD → 空页不抛错 [清单 64]；topo 序
 * children-first；refs 三类 + shortName/fullName + annotated tag peeled oid 命中
 * （B6：装饰按 ref.oid == commit.oid 匹配）+ detached/unborn head + upstream:track
 * 的 [gone]/[ahead 1] 解析（单次 for-each-ref）；getCommitDetail 元数据 + 文件清单
 * （merge 按第一父 / 根提交 --root）+ path 模式 patch + refs 过滤 + not-a-repository。
 *
 * 断言纪律：验证世界而非自述——每个场景用独立 execFileSync git 重读外部状态对照。
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 真实 git 子进程风暴用例（每用例多次 execFileSync/spawn）——资源裕量放宽（diff.spec 同款）。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

import type { LogPage, RefsSnapshot } from '../src/types.ts'
import { DiffEngine } from '../src/diff.ts'
import {
  DEFAULT_LOG_MAX_LIMIT, GraphEngine,
  normalizeLogLimit, normalizeLogSkip, parseForEachRef, parseLogCommits,
} from '../src/graph.ts'
import { GitRunner, READONLY_PREFIX, DEFAULT_OUTPUT_MAX_BYTES } from '../src/git-runner.ts'
import { GitService } from '../src/index.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchDir, scratchRepo } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface EngineHarness {
  engine: GraphEngine
  repo: string
}

/** 引擎装配（只读 runner + WorkspaceResolver 钉死工作区 + DiffEngine）。 */
async function makeEngine(logMaxLimit?: number): Promise<EngineHarness> {
  const repo = await scratchRepo('dsh-git-log-refs-', cleanups, { name: 't', email: 't@example.com' })
  const runner = new GitRunner(localSubprocess(), 'git', {
    timeoutMs: 20_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  }, READONLY_PREFIX)
  const workspace = new WorkspaceResolver(repo)
  const diff = new DiffEngine(runner, workspace)
  return { engine: new GraphEngine(runner, workspace, diff, logMaxLimit !== undefined ? { logMaxLimit } : {}), repo }
}

function makeService(workspaceOverride: string): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, { gitCommand: 'git', fastTimeoutMs: 15_000, workspaceOverride })
}

/** world 重读：git log --topo-order 的全量 oid 序（children-first 权威）。 */
function worldTopoOids(repo: string): string[] {
  return git(repo, 'log', '--topo-order', '--format=%H').trim().split('\n').filter((line) => line !== '')
}

/** 写文件 + 提交的同步小步进（execFileSync 权威，验证世界而非自述）。 */
function step(repo: string, message: string, file: string, content: string): string {
  execFileSync('node', ['-e', `require('node:fs').writeFileSync(process.argv[1], process.argv[2])`, join(repo, file), content], { stdio: 'ignore' })
  git(repo, 'add', '--', file)
  git(repo, 'commit', '-m', message)
  return git(repo, 'rev-parse', 'HEAD').trim()
}

/** 造一个已知 DAG：base ← fa(feature) / m1(main) ← merge ← ob1/ob2 ← octopus；打 annotated/light tag。 */
/** 已知 DAG 的提交 oid 集（具名键——noUncheckedIndexedAccess 下直取 string）。 */
interface DagOids { base: string; fa: string; m1: string; merge: string; ob1: string; ob2: string; oct: string }

async function knownDag(): Promise<EngineHarness & { oids: DagOids }> {
  const harness = await makeEngine()
  const { repo } = harness
  const base = step(repo, 'base', 'f0.txt', 'base\n')
  git(repo, 'checkout', '-q', '-b', 'feature')
  const fa = step(repo, 'feature work', 'fa.txt', 'feature\n')
  git(repo, 'checkout', '-q', 'main')
  const m1 = step(repo, 'main work', 'm1.txt', 'main\n')
  git(repo, 'merge', '--no-ff', '--no-edit', '-m', 'merge feature', 'feature')
  const merge = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', '-q', '-b', 'ob1')
  const ob1 = step(repo, 'ob1 work', 'ob1.txt', 'ob1\n')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'checkout', '-q', '-b', 'ob2')
  const ob2 = step(repo, 'ob2 work', 'ob2.txt', 'ob2\n')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '--no-ff', '--no-edit', '-m', 'octopus merge', 'ob1', 'ob2')
  const oct = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'tag', '-a', 'v1', '-m', 'annotated tag', oct)
  git(repo, 'tag', 'light', m1)
  return { ...harness, oids: { base, fa, m1, merge, ob1, ob2, oct } }
}

describe('log — 分页与钳制（已知 DAG）', () => {
  it('分页串联 = 全量单呼 = world 重读 topo 序（children-first）', async () => {
    const { engine, repo, oids } = await knownDag()
    const full = await engine.log({ limit: DEFAULT_LOG_MAX_LIMIT, skip: 0 })
    expect(full.hasMore).toBe(false)
    expect(full.limitUsed).toBe(DEFAULT_LOG_MAX_LIMIT)

    // world：全量 topo 序（7 提交：base/fa/m1/merge/ob1/ob2/oct；--topo-order 的
    // 分支成组以 git 为权威）。
    const world = worldTopoOids(repo)
    expect(world).toHaveLength(7)
    expect(full.commits.map((row) => row.oid)).toEqual(world)
    expect(full.commits[0]!.oid).toBe(oids.oct)
    // children-first 不变式：每个父提交都在其全部子提交之后。
    const position = new Map(full.commits.map((row, index) => [row.oid, index]))
    for (const row of full.commits) {
      for (const parent of row.parents) {
        expect(position.get(parent)!).toBeGreaterThan(position.get(row.oid)!)
      }
    }
    // 父序（第一父在前）。
    expect(full.commits.find((row) => row.oid === oids.merge)!.parents).toEqual([oids.m1, oids.fa])
    expect(full.commits.find((row) => row.oid === oids.oct)!.parents).toEqual([oids.merge, oids.ob1, oids.ob2])

    // 分页串联：limit 2 逐页直到 hasMore=false，拼接 = 全量。
    const paged: LogPage['commits'] = []
    for (let skip = 0; ; skip += 2) {
      const page = await engine.log({ limit: 2, skip })
      paged.push(...page.commits)
      if (!page.hasMore) break
    }
    expect(paged.map((row) => row.oid)).toEqual(full.commits.map((row) => row.oid))
  })

  it('hasMore 边界：limit=total 不多翻页；limit=total-1 恰好一页余量；skip 越界空页', async () => {
    const { engine } = await knownDag()
    const total = (await engine.log({ limit: DEFAULT_LOG_MAX_LIMIT, skip: 0 })).commits.length
    expect(total).toBe(7)

    const exact = await engine.log({ limit: total, skip: 0 })
    expect(exact.hasMore).toBe(false)
    expect(exact.commits).toHaveLength(total)

    const tight = await engine.log({ limit: total - 1, skip: 0 })
    expect(tight.hasMore).toBe(true)
    expect(tight.commits).toHaveLength(total - 1)

    const atEnd = await engine.log({ limit: 4, skip: total })
    expect(atEnd).toEqual({ commits: [], hasMore: false, skipUsed: total, limitUsed: 4 })

    const beyond = await engine.log({ limit: 4, skip: total + 100 })
    expect(beyond.commits).toEqual([])
    expect(beyond.hasMore).toBe(false)

    // skip 尾页不满页：skip=6, limit=4 → 1 条且 hasMore=false。
    const tail = await engine.log({ limit: 4, skip: 6 })
    expect(tail.commits).toHaveLength(1)
    expect(tail.hasMore).toBe(false)
  })

  it('limit/skip 钳制：纯函数 + 引擎行为（limitUsed 回带）', async () => {
    expect(normalizeLogLimit(undefined, 500, 5_000)).toBe(500)
    expect(normalizeLogLimit(Number.NaN, 500, 5_000)).toBe(500)
    expect(normalizeLogLimit(0, 500, 5_000)).toBe(1)
    expect(normalizeLogLimit(-3, 500, 5_000)).toBe(1)
    expect(normalizeLogLimit(2.9, 500, 5_000)).toBe(2)
    expect(normalizeLogLimit(99, 500, 3)).toBe(3)
    expect(normalizeLogSkip(Number.NaN)).toBe(0)
    expect(normalizeLogSkip(-1)).toBe(0)
    expect(normalizeLogSkip(4.9)).toBe(4)

    const harness = await makeEngine(3)
    const engine = harness.engine
    for (const index of ['1', '2', '3', '4']) {
      execFileSync('node', ['-e', `require('node:fs').writeFileSync(process.argv[1], process.argv[2])`, join(harness.repo, `f${index}.txt`), index], { stdio: 'ignore' })
      git(harness.repo, 'add', '--', `f${index}.txt`)
      git(harness.repo, 'commit', '-m', `c${index}`)
    }
    const tiny = await engine.log({ limit: 0, skip: 0 })
    expect(tiny.limitUsed).toBe(1)
    expect(tiny.commits).toHaveLength(1)
    const clamped = await engine.log({ limit: 999, skip: -5 })
    expect(clamped.limitUsed).toBe(3)
    expect(clamped.hasMore).toBe(true) // 4 提交 > 3 上限
  })

  it('unborn HEAD → 空页不抛错（[清单 64]）', async () => {
    const { engine } = await makeEngine()
    const page = await engine.log({ limit: 10, skip: 0 })
    expect(page).toEqual({ commits: [], hasMore: false, skipUsed: 0, limitUsed: 10 })
  })

  it('format 解析：多行 body 完整捕获、subject/body 分离（world 重读 %B 对照）', async () => {
    const { engine, repo } = await makeEngine()
    execFileSync('node', ['-e', `require('node:fs').writeFileSync(process.argv[1], 'x')`, join(repo, 'f.txt')], { stdio: 'ignore' })
    git(repo, 'add', '--', 'f.txt')
    git(repo, 'commit', '-m', 'the subject', '-m', 'body line one\nbody line two')
    const page = await engine.log({ limit: 5, skip: 0 })
    const row = page.commits[0]!
    expect(row.subject).toBe('the subject')
    // %b 原样保留消息体（git commit -m 的消息以\n 收尾）。
    expect(row.body).toBe('body line one\nbody line two\n')
    // world 对照：--format=%b 是 tformat 语义（每记录尾加\n），剥去该层后 = 原始 body。
    const worldBody = git(repo, 'log', '-1', '--format=%b').replace(/\n$/u, '')
    expect(row.body).toBe(worldBody)
    expect(row.authorEmail).toBe('t@example.com')
    expect(row.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('@Remote log 接线（GitService）与引擎一致', async () => {
    const harness = await knownDag()
    const service = makeService(harness.repo)
    const viaService: LogPage = await service.log({ limit: 3, skip: 0 })
    const viaEngine = await harness.engine.log({ limit: 3, skip: 0 })
    expect(viaService.commits.map((row) => row.oid)).toEqual(viaEngine.commits.map((row) => row.oid))
    expect(viaService.hasMore).toBe(true)
  })
})

describe('parseLogCommits — 解析纯函数', () => {
  it('多行 body + 字段回接（正文内嵌 0x1f 不破坏解析）', () => {
    const record = [
      'abc123', 'def456 789aaa', 'A U', 'a@e', '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00',
      'subject line', 'body\x1fwith separator\nmore',
    ].join('\x1f') + '\x1e'
    const commits = parseLogCommits(record)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({
      oid: 'abc123',
      parents: ['def456', '789aaa'],
      authorName: 'A U',
      subject: 'subject line',
      body: 'body\x1fwith separator\nmore',
    })
  })

  it('空输出 = 空列表；缺尾分隔符 / 字段不足 / 空 oid 抛错', () => {
    expect(parseLogCommits('')).toEqual([])
    expect(() => parseLogCommits('abc\x1f\x1fan\x1fae\x1faI\x1fcI\x1fs\x1fb')).toThrow(/record-terminated/)
    expect(() => parseLogCommits('abc\x1f\x1fan\x1fae\x1faI\x1fcI\x1fsubject\x1e')).toThrow(/expected 8 fields/)
    expect(() => parseLogCommits('\x1fp\x1fan\x1fae\x1faI\x1fcI\x1fs\x1fb\x1e')).toThrow(/empty oid/)
  })
})

describe('refs — 单次查询与 head 三态', () => {
  it('三类 refs + shortName/fullName + annotated tag peeled oid 命中（B6）', async () => {
    const { engine, repo, oids } = await knownDag()
    // bare 远端 → push main → refs/remotes/origin/main 入列。
    const remote = await scratchDir('dsh-git-remote-', cleanups)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', 'origin', 'main')

    const snapshot: RefsSnapshot = await engine.refs()
    const byName = new Map(snapshot.refs.map((ref) => [ref.fullName, ref]))
    expect(snapshot.head).toEqual({ kind: 'branch', name: 'main', oid: oids.oct })

    const local = byName.get('refs/heads/main')!
    expect(local).toMatchObject({ type: 'local-branch', shortName: 'main', oid: oids.oct })
    const remoteRef = byName.get('refs/remotes/origin/main')!
    expect(remoteRef).toMatchObject({ type: 'remote-branch', shortName: 'origin/main', oid: oids.oct })
    const annotated = byName.get('refs/tags/v1')!
    // annotated tag：peeled oid = commit oid（本机实测 objectname = tag 对象 ≠ commit）。
    const tagObject = git(repo, 'rev-parse', 'refs/tags/v1').trim()
    expect(tagObject).not.toBe(oids.oct)
    expect(annotated.oid).toBe(oids.oct)
    const light = byName.get('refs/tags/light')!
    expect(light.oid).toBe(oids.m1)
    // 装饰命中：ref.oid == commit.oid 的提交集包含 oct（annotated）与 m1（lightweight）。
    const hits = new Set(snapshot.refs.map((ref) => ref.oid))
    expect(hits.has(oids.oct)).toBe(true)
    expect(hits.has(oids.m1)).toBe(true)
  })

  it('upstream:track 解析：同步为空 / [ahead 1] / [gone]（单次查询一次取回）', async () => {
    const { engine, repo } = await makeEngine()
    step(repo, 'base', 'f0.txt', 'base\n')
    const remote = await scratchDir('dsh-git-track-', cleanups)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    // upstream 指向远端 feature（非当前分支——bare 远端的当前分支拒绝删除）。
    git(repo, 'push', '-q', 'origin', 'main:feature')
    git(repo, 'branch', '-q', '-u', 'origin/feature')
    // 同步态：track 空串 → upstreamTrack null。
    const synced = await engine.refs()
    expect(synced.refs.find((ref) => ref.fullName === 'refs/heads/main')!.upstreamTrack).toBeNull()
    // 领先 1：track [ahead 1]。
    step(repo, 'ahead', 'f1.txt', 'x\n')
    const ahead = await engine.refs()
    expect(ahead.refs.find((ref) => ref.fullName === 'refs/heads/main')!.upstreamTrack).toBe('[ahead 1]')
    // gone：远端分支删除后 track [gone]（删的是远端 feature 分支——bare 远端拒绝
    // 删除当前分支 main，实测 "refusing to delete the current branch"）。
    git(repo, 'push', '-q', 'origin', '--delete', 'feature')
    const gone = await engine.refs()
    expect(gone.refs.find((ref) => ref.fullName === 'refs/heads/main')!.upstreamTrack).toBe('[gone]')
  })

  it('head 三态：detached / unborn', async () => {
    const { engine, repo } = await makeEngine()
    const base = step(repo, 'base', 'f0.txt', 'base\n')
    git(repo, 'checkout', '-q', '--detach', base)
    const detached = await engine.refs()
    expect(detached.head).toEqual({ kind: 'detached', name: null, oid: base })

    const unborn = await makeEngine()
    const snapshot = await unborn.engine.refs()
    expect(snapshot.head).toEqual({ kind: 'unborn', name: 'main', oid: null })
    expect(snapshot.refs).toEqual([])
  })
})

describe('getCommitDetail — 元数据/文件清单/refs 过滤', () => {
  it('meta 字段 = world 重读；merge 按第一父；refs 过滤命中 annotated tag', async () => {
    const { engine, repo, oids } = await knownDag()
    const detail = await engine.getCommitDetail({ oid: oids.merge, path: null })

    // meta：world 重读逐字段对照。
    const worldSubject = git(repo, 'show', '-s', '--format=%s', oids.merge).trim()
    const worldParents = git(repo, 'show', '-s', '--format=%P', oids.merge).trim().split(' ')
    const worldAuthor = git(repo, 'show', '-s', '--format=%an', oids.merge).trim()
    expect(detail.commit.oid).toBe(oids.merge)
    expect(detail.commit.subject).toBe(worldSubject)
    expect(detail.commit.parents).toEqual(worldParents)
    expect(detail.commit.authorName).toBe(worldAuthor)

    // merge 第一父文件清单：world 重读 git diff --name-only <first-parent> <merge>。
    const worldFiles = git(repo, 'diff', '--name-only', oids.m1, oids.merge).trim().split('\n').filter((line) => line !== '')
    expect(detail.files.map((file) => file.path).sort()).toEqual([...worldFiles].sort())
    // feature 侧文件在列、main 侧文件不在列（第一父语义）。
    expect(detail.files.some((file) => file.path === 'fa.txt')).toBe(true)
    expect(detail.files.some((file) => file.path === 'm1.txt')).toBe(false)

    // merge 提交无装饰（v1/main 都在 oct 上）⇒ refs 过滤为空集。
    expect(detail.refs).toEqual([])

    // oct 提交：refs 过滤命中 annotated tag（peeled oid）与 main 分支。
    const octDetail = await engine.getCommitDetail({ oid: oids.oct, path: null })
    const octRefs = octDetail.refs.map((ref) => ref.fullName).sort()
    expect(octRefs).toContain('refs/tags/v1')
    expect(octRefs).toContain('refs/heads/main')
    expect(octDetail.refs.every((ref) => ref.oid === oids.oct)).toBe(true)
  })

  it('path 模式：仅该文件且含 patch 内容；文件不在提交内 ⇒ files 空', async () => {
    const { engine, repo, oids } = await knownDag()
    const detail = await engine.getCommitDetail({ oid: oids.merge, path: 'fa.txt' })
    expect(detail.files).toHaveLength(1)
    expect(detail.files[0]!.path).toBe('fa.txt')
    expect(detail.files[0]!.patch).toContain('feature')
    const worldPatch = git(repo, 'diff', oids.m1, oids.merge, '--', 'fa.txt')
    expect(detail.files[0]!.patch).toBe(worldPatch)

    const absent = await engine.getCommitDetail({ oid: oids.merge, path: 'nope.txt' })
    expect(absent.files).toEqual([])
  })

  it('根提交按 --root：文件清单 = world 重读 diff-tree --root', async () => {
    const { engine, repo, oids } = await knownDag()
    const detail = await engine.getCommitDetail({ oid: oids.base, path: null })
    const worldFiles = git(repo, 'diff-tree', '--root', '-r', '--name-only', '--no-commit-id', oids.base).trim().split('\n').filter((line) => line !== '')
    expect(detail.files.map((file) => file.path)).toEqual(worldFiles)
    const withPatch = await engine.getCommitDetail({ oid: oids.base, path: 'f0.txt' })
    expect(withPatch.files[0]!.patch).toContain('base')
  })

  it('无效修订 / 非仓库：域错误', async () => {
    const { engine } = await knownDag()
    await expect(engine.getCommitDetail({ oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', path: null }))
      .rejects.toMatchObject({ code: 'git/git-error' })

    const emptyDir = await scratchDir('dsh-git-notrepo-', cleanups)
    const runner = new GitRunner(localSubprocess(), 'git', { timeoutMs: 20_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES }, READONLY_PREFIX)
    const workspace = new WorkspaceResolver(emptyDir)
    const wrongRepo = new GraphEngine(runner, workspace, new DiffEngine(runner, workspace))
    await expect(wrongRepo.log({ limit: 5, skip: 0 })).rejects.toMatchObject({ code: 'git/no-repository' })
    await expect(wrongRepo.refs()).rejects.toMatchObject({ code: 'git/no-repository' })
    await expect(wrongRepo.getCommitDetail({ oid: 'HEAD', path: null })).rejects.toMatchObject({ code: 'git/no-repository' })
  })

  it('@Remote getCommitDetail / refs 接线（GitService）', async () => {
    const harness = await knownDag()
    const service = makeService(harness.repo)
    const detail = await service.getCommitDetail({ oid: harness.oids.oct, path: null })
    expect(detail.commit.oid).toBe(harness.oids.oct)
    expect(detail.refs.map((ref) => ref.fullName)).toContain('refs/tags/v1')
    const refs = await service.refs()
    expect(refs.head.kind).toBe('branch')
    expect(refs.head.oid).toBe(harness.oids.oct)
  })
})

describe('parseForEachRef — 解析纯函数', () => {
  it('五字段记录 / peeled 回落 / track 值 / 契约破坏抛错', () => {
    const stdout = [
      ['aaa', '', 'refs/heads/main', 'main', ''].join('\t'),
      ['bbb', 'ccc', 'refs/tags/v1', 'v1', ''].join('\t'),
      ['ddd', '', 'refs/remotes/origin/main', 'origin/main', '[gone]'].join('\t'),
    ].join('\n') + '\n'
    const refs = parseForEachRef(stdout)
    expect(refs).toEqual([
      { type: 'local-branch', fullName: 'refs/heads/main', shortName: 'main', oid: 'aaa', upstreamTrack: null },
      { type: 'tag', fullName: 'refs/tags/v1', shortName: 'v1', oid: 'ccc', upstreamTrack: null },
      { type: 'remote-branch', fullName: 'refs/remotes/origin/main', shortName: 'origin/main', oid: 'ddd', upstreamTrack: null },
    ])
    const tracked = parseForEachRef([['eee', '', 'refs/heads/dev', 'dev', '[ahead 1, behind 2]'].join('\t'), ''].join('\n'))
    expect(tracked[0]!.upstreamTrack).toBe('[ahead 1, behind 2]')
    expect(parseForEachRef('')).toEqual([])
    expect(() => parseForEachRef('a\tb\tc\n')).toThrow(/expected 5 fields/)
    expect(() => parseForEachRef('a\tb\trefs/unknown/x\tx\t\n')).toThrow(/outside heads/)
  })
})

describe('错误形状', () => {
  it('域错误以 RemoteError 过线（按 code 判别）', async () => {
    const emptyDir = await scratchDir('dsh-git-notrepo2-', cleanups)
    const runner = new GitRunner(localSubprocess(), 'git', { timeoutMs: 20_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES }, READONLY_PREFIX)
    const workspace = new WorkspaceResolver(emptyDir)
    const engine = new GraphEngine(runner, workspace, new DiffEngine(runner, workspace))
    try {
      await engine.log({ limit: 1, skip: 0 })
      expect.unreachable('expected git/no-repository')
    } catch (cause) {
      const remote = remoteErrorOf(cause)
      expect(remote?.code).toBe('git/no-repository')
    }
  })
})
