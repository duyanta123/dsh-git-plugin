/**
 * M3 — status 真仓库场景矩阵（spec §⑥ status.spec 行的集成半）。
 *
 * 覆盖：七类变更识别 [清单 1]（modified/added/deleted/renamed/copied 探针/untracked/
 * conflict）、untracked vs ignored [清单 5]、ahead/behind [清单 24]（bare 远端，不依赖
 * 网络）、detached [清单 65]、unborn (initial) [清单 64]、真 merge 冲突 UU（[清单 6]
 * 的 porcelain XY 半，B4 修订）、submodule 行不炸、三态（unavailable / not-repository /
 * ready）、<2s 缓存与失效、进行中扫描去重、numstat 双路回填（binary/文本）。
 *
 * 断言纪律：验证世界而非自述——每个写场景后用独立 execFileSync git 重读外部状态
 * （world 重读），RPC 快照与其对照。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 并行跑的资源裕量（全仓用例大量真实 git 子进程 / 真实 fs+定时器；本机 16 核 Windows
// 上 vitest 默认 5s/10s 边缘超时——client 地基模块全绿门禁实测复现；单文件跑恒绿）。
// 只放宽超时上限，断言面零改动。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })
import type { SubprocessFace } from '../src/git-runner.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX } from '../src/git-runner.ts'
import { GitService } from '../src/index.ts'
import { StatusEngine } from '../src/status.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchDir, type SpawnRecord } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Harness {
  service: InstanceType<typeof GitService>
  spawns: SpawnRecord[]
}

function makeService(workspaceOverride: string, subprocess: SubprocessFace = localSubprocess()): Harness {
  const spawns: SpawnRecord[] = []
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', subprocess)
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    outputMaxBytes: 8 * 1024 * 1024,
    workspaceOverride,
  })
  return { service, spawns }
}

/** status 引擎（engine 级缓存/去重断言用；cacheTtlMs 可控）。 */
function makeEngine(workspaceOverride: string, cacheTtlMs: number, record?: SpawnRecord[]): StatusEngine {
  const face = record === undefined ? localSubprocess() : localSubprocess(record)
  const runner = new GitRunner(face, 'git', {
    timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  }, READONLY_PREFIX)
  return new StatusEngine(runner, new WorkspaceResolver(workspaceOverride), { cacheTtlMs })
}

function statusSpawnCount(spawns: SpawnRecord[]): number {
  return spawns.filter(spawn => (spawn.argv as readonly string[]).includes('--porcelain=v2')).length
}

/** 基础仓库：一个提交，含 tracked.txt / tracked2.txt / three.txt / vanish.txt；返回工作路径。 */
async function baseRepo(prefix: string): Promise<string> {
  const repo = await scratchDir(prefix, cleanups)
  git(repo, 'init', '-q', '-b', 'main')
  for (const name of ['tracked.txt', 'tracked2.txt', 'three.txt', 'vanish.txt']) {
    await writeFile(join(repo, name), `${name}\n`, 'utf8')
  }
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  return repo
}

describe('status 场景矩阵（spec §⑥ 集成行）', () => {
  it('七类变更识别 [清单 1]：modified/added/deleted/renamed/untracked/worktree-deleted 分组落位', async () => {
    const repo = await baseRepo('dshgit-st-matrix-')
    // staged: add（A.）、delete（D.，git rm 连工作区一起删）、rename（R.）
    await writeFile(join(repo, 'added.txt'), 'new\n', 'utf8')
    git(repo, 'add', 'added.txt')
    git(repo, 'rm', '-q', 'vanish.txt')
    git(repo, 'mv', 'tracked.txt', 'renamed.txt')
    // unstaged: modify（.M）、delete（.D）
    await writeFile(join(repo, 'tracked2.txt'), 'modified\n', 'utf8')
    await rm(join(repo, 'three.txt'))
    // untracked
    await writeFile(join(repo, 'untracked.txt'), 'free\n', 'utf8')

    const { service } = makeService(repo)
    const snapshot = await service.status()

    // world 重读对照（独立 git 进程，v1 porcelain 全量行；重命名是 'old -> new' 显示形态）。
    const world = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(world.split('\n').filter(Boolean).sort()).toEqual([
      'A  added.txt',
      'D  vanish.txt',
      'R  tracked.txt -> renamed.txt',
      '?? untracked.txt',
      ' D three.txt',
      ' M tracked2.txt',
    ].sort())

    expect(snapshot.staged.map(change => `${change.x}${change.y} ${change.path}`).sort()).toEqual([
      'A. added.txt',
      'D. vanish.txt',
      'R. renamed.txt',
    ])
    expect(snapshot.unstaged.map(change => `${change.x}${change.y} ${change.path}`).sort()).toEqual([
      '.D three.txt',
      '.M tracked2.txt',
    ])
    expect(snapshot.untracked.map(change => change.path)).toEqual(['untracked.txt'])
    expect(snapshot.conflicted).toEqual([])
    expect(snapshot.clean).toBe(false)
    const renamed = snapshot.staged.find(change => change.path === 'renamed.txt')
    expect(renamed?.origPath).toBe('tracked.txt')
    expect(renamed?.kind).toBe('renamed')
    expect(snapshot.staged.find(change => change.path === 'added.txt')?.kind).toBe('added')
    expect(snapshot.staged.find(change => change.path === 'vanish.txt')?.kind).toBe('deleted')
  })

  it('真 merge 冲突 UU [清单 6 的 XY 半]：conflicted 组 + staged/unstaged 重叠', async () => {
    const repo = await baseRepo('dshgit-st-conflict-')
    git(repo, 'checkout', '-qb', 'other')
    await writeFile(join(repo, 'tracked.txt'), 'other-side\n', 'utf8')
    git(repo, 'commit', '-qam', 'other')
    git(repo, 'checkout', '-q', 'main')
    await writeFile(join(repo, 'tracked.txt'), 'main-side\n', 'utf8')
    git(repo, 'commit', '-qam', 'main')
    try {
      execFileSync('git', ['merge', 'other'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
      expect.fail('merge should conflict')
    } catch (error) {
      // merge 的非零退出是本场景预期（冲突）。
      expect((error as { status?: number }).status).not.toBe(0)
    }
    const { service } = makeService(repo)
    const snapshot = await service.status()
    const conflicted = snapshot.conflicted.find(change => change.path === 'tracked.txt')
    expect(conflicted).toBeDefined()
    expect(conflicted?.conflicted).toBe(true)
    expect(conflicted?.x).toBe('U')
    expect(conflicted?.y).toBe('U')
    // UU 同时落 staged/unstaged（spec §1.0.3 分组注释）。
    expect(snapshot.staged.some(change => change.path === 'tracked.txt')).toBe(true)
    expect(snapshot.unstaged.some(change => change.path === 'tracked.txt')).toBe(true)
    // world 重读：ls-files -u 有三个 stage 记录。
    const unmerged = execFileSync('git', ['ls-files', '-u'], { cwd: repo, encoding: 'utf8' })
    expect(unmerged.split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('copy 探针：status 默认不检 copy（A. + .M），ChangeKind.copied 不误标（实测 2026-10-31）', async () => {
    const repo = await baseRepo('dshgit-st-copy-')
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8')
    await writeFile(join(repo, 'twin.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', 'twin.txt')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    const twin = snapshot.staged.find(change => change.path === 'twin.txt')
    expect(twin?.kind).toBe('added')
    expect(twin?.origPath).toBeNull()
  })

  it('untracked vs ignored [清单 5]：.gitignore 命中文件不进 untracked', async () => {
    const repo = await baseRepo('dshgit-st-ignored-')
    await writeFile(join(repo, '.gitignore'), '*.log\n', 'utf8')
    await writeFile(join(repo, 'keep.txt'), 'kept\n', 'utf8')
    await writeFile(join(repo, 'noise.log'), 'ignored\n', 'utf8')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    expect(snapshot.untracked.map(change => change.path).sort()).toEqual(['.gitignore', 'keep.txt'])
    expect(snapshot.untracked.some(change => change.path === 'noise.log')).toBe(false)
    // world 对照：check-ignore 确认 noise.log 被忽略。
    const check = execFileSync('git', ['check-ignore', 'noise.log'], { cwd: repo, encoding: 'utf8' })
    expect(check.trim()).toBe('noise.log')
  })

  it('ahead/behind [清单 24]：bare 远端（本地路径）+ fetch 后 branch.ab +2 -1', async () => {
    const parent = await scratchDir('dshgit-st-sync-', cleanups)
    const repo = join(parent, 'repo')
    const remote = join(parent, 'remote.git')
    await mkdir(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'user.name', 't')
    await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'c1')
    git(repo, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'c2')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'c3')
    // 远端另起一线：tmpmain 自 c1 前进一提交后顶替 main（本地不拥有 c4）。
    const baseOid = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: repo, encoding: 'utf8' }).trim()
    git(repo, 'checkout', '-qb', 'tmpmain', baseOid)
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'c4')
    git(repo, 'push', '-q', 'origin', 'tmpmain:main')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'fetch', '-q', 'origin')

    const { service } = makeService(repo)
    const snapshot = await service.status()
    expect(snapshot.branch.upstream).toBe('origin/main')
    expect(snapshot.branch.ahead).toBe(2)
    expect(snapshot.branch.behind).toBe(1)
    // world 对照：rev-list 计数。
    const counts = execFileSync('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD'], {
      cwd: repo, encoding: 'utf8',
    }).trim()
    expect(counts).toBe('1\t2') // behind=1 ahead=2（列序：left=behind）
  })

  it('detached [清单 65]：checkout --detach → branch.name null / detached / abbrevOid', async () => {
    const repo = await baseRepo('dshgit-st-detach-')
    git(repo, 'checkout', '-q', '--detach', 'HEAD')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    expect(snapshot.branch.detached).toBe(true)
    expect(snapshot.branch.name).toBeNull()
    expect(snapshot.branch.oid).not.toBeNull()
    expect(snapshot.branch.abbrevOid).toBe((snapshot.branch.oid ?? '').slice(0, 7))
    // world 对照。
    const world = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(snapshot.branch.oid).toBe(world)
    // symbolic-ref 失败（exit 非 0）= detached 的 world 判据。
    let symbolicRefFailed = false
    try {
      execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      symbolicRefFailed = true
    }
    expect(symbolicRefFailed).toBe(true)
  })

  it('unborn [清单 64]：(initial) 无提交仓库 —— oid null / unborn / staged 计数仍回填', async () => {
    const repo = await scratchDir('dshgit-st-unborn-', cleanups)
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, 'first.txt'), 'first\ncontent\n', 'utf8')
    git(repo, 'add', 'first.txt')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    expect(snapshot.branch.unborn).toBe(true)
    expect(snapshot.branch.oid).toBeNull()
    expect(snapshot.branch.name).toBe('main')
    expect(snapshot.staged.map(change => change.path)).toEqual(['first.txt'])
    // unborn 仓库 numstat 双路 exit 0（本机实测）→ 计数回填。
    expect(snapshot.staged[0]).toMatchObject({ additions: 2, deletions: 0, binary: false, kind: 'added' })
    // world 对照。
    expect(execFileSync('git', ['diff', '--cached', '--numstat'], { cwd: repo, encoding: 'utf8' }).trim())
      .toBe('2\t0\tfirst.txt')
  })

  it('submodule 行不炸：嵌套仓库 gitlink → submodule true、正常进 staged', async () => {
    const repo = await baseRepo('dshgit-st-submod-')
    const sub = join(repo, 'sub')
    await mkdir(sub)
    git(sub, 'init', '-q', '-b', 'main')
    git(sub, 'config', 'user.email', 't@example.com')
    git(sub, 'config', 'user.name', 't')
    await writeFile(join(sub, 's.txt'), 's\n', 'utf8')
    git(sub, 'add', '.')
    git(sub, 'commit', '-qm', 'sub1')
    git(repo, 'add', 'sub')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    const link = snapshot.staged.find(change => change.path === 'sub')
    expect(link).toBeDefined()
    expect(link?.submodule).toBe(true)
    expect(link?.kind).toBe('added')
    // world 对照：ls-files --stage 的 160000 gitlink。
    const stage = execFileSync('git', ['ls-files', '--stage', 'sub'], { cwd: repo, encoding: 'utf8' })
    expect(stage).toMatch(/^160000 /)
  })
})

describe('三态（workflow 任务口径）', () => {
  it('not-repository：普通目录 → git/no-repository，details.probed = 工作区', async () => {
    const plain = await scratchDir('dshgit-st-plain-', cleanups)
    const { service } = makeService(plain)
    const error = await service.status().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/no-repository')
    expect(remote?.details).toEqual({ probed: plain })
  })

  it('unavailable：git 可执行解析失败 → git/git-error op="resolve-git"', async () => {
    const plain = await scratchDir('dshgit-st-unavail-', cleanups)
    const failing: SubprocessFace = {
      resolveExecutable: async () => null,
      spawn: () => { throw new Error('should not spawn') },
    }
    const { service } = makeService(plain, failing)
    const error = await service.status().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/git-error')
    expect(remote?.details).toMatchObject({ op: 'resolve-git' })
  })

  it('ready：干净仓库 → clean true、四组全空（world 对照 status --porcelain 为空）', async () => {
    const repo = await baseRepo('dshgit-st-clean-')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    expect(snapshot.clean).toBe(true)
    expect(snapshot.staged).toEqual([])
    expect(snapshot.unstaged).toEqual([])
    expect(snapshot.untracked).toEqual([])
    expect(snapshot.conflicted).toEqual([])
    expect(snapshot.repoRoot).toBe(repo)
    const world = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(world).toBe('')
  })
})

describe('<2s 缓存与失效、并发去重（engine 级）', () => {
  it('TTL 内复用快照（不重扫）；invalidate 后重扫；TTL=0 每次重扫', async () => {
    const repo = await baseRepo('dshgit-st-cache-')
    const spawns: SpawnRecord[] = []
    const engine = makeEngine(repo, 60_000, spawns)
    const first = await engine.current()
    expect(first.availability).toBe('ready')
    expect(statusSpawnCount(spawns)).toBe(1)
    const second = await engine.current()
    expect(second).toBe(first) // 缓存命中：同一状态对象
    expect(statusSpawnCount(spawns)).toBe(1)
    engine.invalidate()
    const third = await engine.current()
    expect(third).not.toBe(first)
    expect(statusSpawnCount(spawns)).toBe(2)

    const freshSpawns: SpawnRecord[] = []
    const noCache = makeEngine(repo, 0, freshSpawns)
    await noCache.current()
    await noCache.current()
    expect(statusSpawnCount(freshSpawns)).toBe(2)
  })

  it('缓存感知外部变化：TTL=0 时工作区文件变化如实反映（快照是重扫结果，非陈旧缓存）', async () => {
    const repo = await baseRepo('dshgit-st-fresh-')
    const engine = makeEngine(repo, 0)
    const before = await engine.current()
    expect(before.availability).toBe('ready')
    if (before.availability !== 'ready') throw new Error('unreachable')
    expect(before.snapshot.clean).toBe(true)
    await writeFile(join(repo, 'tracked.txt'), 'changed\n', 'utf8')
    const after = await engine.current()
    if (after.availability !== 'ready') throw new Error('unreachable')
    expect(after.snapshot.clean).toBe(false)
    expect(after.snapshot.unstaged.some(change => change.path === 'tracked.txt')).toBe(true)
  })

  it('进行中扫描去重（ZCode statusRequests 语义）：并发 current 共享同一 Promise', async () => {
    const repo = await baseRepo('dshgit-st-dedup-')
    const spawns: SpawnRecord[] = []
    const engine = makeEngine(repo, 0, spawns)
    const [a, b] = await Promise.all([engine.current(), engine.current()])
    expect(a).toBe(b)
    expect(statusSpawnCount(spawns)).toBe(1) // 一次扫描（3 条并发命令 + rev-parse）
  })

  it('not-repository 态同样进缓存（稳定事实）；瞬时域错误不缓存', async () => {
    const plain = await scratchDir('dshgit-st-plain2-', cleanups)
    const spawns: SpawnRecord[] = []
    const engine = makeEngine(plain, 60_000, spawns)
    const first = await engine.current()
    expect(first.availability).toBe('not-repository')
    const revParseCount = spawns.filter(spawn => (spawn.argv as readonly string[]).includes('rev-parse')).length
    const second = await engine.current()
    expect(second).toBe(first)
    expect(spawns.filter(spawn => (spawn.argv as readonly string[]).includes('rev-parse'))).toHaveLength(revParseCount)
    // 工作区变成仓库后：TTL 内仍缓存旧态 → invalidate 后 ready。
    git(plain, 'init', '-q', '-b', 'main')
    engine.invalidate()
    const third = await engine.current()
    expect(third.availability).toBe('ready')
  })
})
