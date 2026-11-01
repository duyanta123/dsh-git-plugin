/**
 * M4 — diff 引擎测试（spec §⑥ diff.spec 行 + workflow M4 任务口径：二进制 PNG、
 * >256KiB 截断、untracked no-index 断言、merge/根提交）。
 *
 * 覆盖：name-status/numstat 解析与装配纯函数；worktree/staged 双路一致性 [清单 2/3]；
 * binary → binary:true,patch:null [清单 59]（tracked numstat '-' 与 untracked
 * 'Binary files' 标记两路）；>256KiB → oversized+patchTruncated [清单 59]；总预算
 * totalTruncated；untracked --no-index（exit=1 白名单、零字节文件也 exit=1、argv 形态
 * 恰好一个 `--` 紧邻路径、双 `--` 形态 exit 129 回归守卫）；中文路径全程 round-trip；
 * commitDiff merge 第一父对比 / 根提交 --root；单文件 patch 失败不炸整体（patch:null）；
 * not-repository 域码。
 *
 * 断言纪律：验证世界而非自述——每个场景后用独立 execFileSync git 重读外部状态对照。
 */

import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 本文件是真实 git 子进程风暴用例（每用例多次 execFileSync/spawn）。全仓并行跑时与
// watcher 等真实定时器用例争 CPU，默认 5s 超时在本机并行负载下边缘超时
// （client 地基模块全绿门禁实测 3/3 复现；单文件跑恒绿）。只放宽资源裕量，断言面不变。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })
import type { SubprocessFace } from '../src/git-runner.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX } from '../src/git-runner.ts'
import { DiffEngine, analyzeUntrackedPatch, assembleDiffFiles, parseNameStatus } from '../src/diff.ts'
import { GitService } from '../src/index.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchDir, type SpawnRecord } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** PNG 文件魔数（含 NUL —— git 二进制判定依据）。 */
function pngBytes(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]),
    Buffer.from(marker, 'utf8'),
  ])
}

interface EngineHarness {
  engine: DiffEngine
  spawns: SpawnRecord[]
}

function makeEngine(
  workspaceOverride: string,
  options: { filePatchMaxBytes?: number; totalPatchMaxBytes?: number } = {},
  record?: SpawnRecord[],
): EngineHarness {
  const subprocess = localSubprocess(record)
  const runner = new GitRunner(subprocess, 'git', {
    timeoutMs: 20_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  }, READONLY_PREFIX)
  return {
    engine: new DiffEngine(runner, new WorkspaceResolver(workspaceOverride), options),
    spawns: record ?? [],
  }
}

function makeService(workspaceOverride: string, subprocess: SubprocessFace = localSubprocess()): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', subprocess)
  return new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    outputMaxBytes: 8 * 1024 * 1024,
    workspaceOverride,
  })
}

/** 跑一条预期非零退出的命令，返回真实退出码（execFileSync 的 error.status）。 */
function exitStatusOf(args: readonly string[], cwd: string): number {
  try {
    execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return (error as { status?: number }).status ?? -1
  }
  return 0
}

/** 基础仓库：一个 base 提交（a.txt / b.txt），返回工作路径。 */
async function baseRepo(prefix: string): Promise<string> {
  const repo = await scratchDir(prefix, cleanups)
  git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'a1\na2\n', 'utf8')
  await writeFile(join(repo, 'b.txt'), 'b1\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  return repo
}

// ---------- 纯函数：name-status / untracked patch 分析 / 装配 ----------

describe('parseNameStatus（--name-status -z 记录解析，实测布局 2026-10-31）', () => {
  it('普通条目 = 状态 token + 路径两条记录；A/M/D → added/modified/deleted', () => {
    const entries = parseNameStatus('A\0c.txt\0M\0a.txt\0D\0b.txt\0')
    expect(entries).toEqual([
      { path: 'c.txt', origPath: null, status: 'added' },
      { path: 'a.txt', origPath: null, status: 'modified' },
      { path: 'b.txt', origPath: null, status: 'deleted' },
    ])
  })

  it('重命名 = R100 + 原路径 + 新路径三条记录；复制 = C 前缀', () => {
    const entries = parseNameStatus('R100\0old.txt\0new.txt\0C079\0src.txt\0dst.txt\0')
    expect(entries).toEqual([
      { path: 'new.txt', origPath: 'old.txt', status: 'renamed' },
      { path: 'dst.txt', origPath: 'src.txt', status: 'copied' },
    ])
  })

  it('unmerged 双记录（U + M，实测冲突仓库形态）与 T/typechange → modified', () => {
    const entries = parseNameStatus('U\0f.txt\0M\0f.txt\0T\0t.txt\0')
    expect(entries).toEqual([
      { path: 'f.txt', origPath: null, status: 'modified' },
      { path: 'f.txt', origPath: null, status: 'modified' },
      { path: 't.txt', origPath: null, status: 'modified' },
    ])
  })

  it('非 NUL 结尾 / 缺路径记录 → 抛错（契约破坏要响，与 parseNumstat 同纪律）', () => {
    expect(() => parseNameStatus('M\0a.txt')).toThrow(/NUL-terminated/)
    expect(() => parseNameStatus('M\0')).toThrow(/malformed/)
  })
})

describe('analyzeUntrackedPatch（no-index patch 本体推导——Windows git numstat no-index 渲染 nul => path 不可用的实测修订）', () => {
  it('文本 patch：@@ 后 + 行计数；deletions 恒 0', () => {
    const analysis = analyzeUntrackedPatch(
      'diff --git a/u.txt b/u.txt\nnew file mode 100644\nindex 0000000..86d21ac\n--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    )
    expect(analysis).toEqual({ binary: false, additions: 2, deletions: 0, patch: expect.any(String) })
    expect(analysis.patch).toContain('+one')
  })

  it("Binary files 标记行 → binary:true, patch:null（实测 'Binary files /dev/null and b/x differ'）", () => {
    const analysis = analyzeUntrackedPatch(
      'diff --git a/raw.bin b/raw.bin\nnew file mode 100644\nindex 0000000..9ff2209\nBinary files /dev/null and b/raw.bin differ\n',
    )
    expect(analysis).toEqual({ binary: true, additions: null, deletions: null, patch: null })
  })

  it('零字节文件：header-only patch（无 @@）→ 0/0 计数、patch 非空', () => {
    const analysis = analyzeUntrackedPatch(
      'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n',
    )
    expect(analysis.binary).toBe(false)
    expect(analysis.additions).toBe(0)
    expect(analysis.deletions).toBe(0)
    expect(analysis.patch).toContain('new file mode 100644')
  })
})

describe('assembleDiffFiles（name-status ⊕ numstat 装配）', () => {
  it('rename origPath 落位；计数按新路径键；缺计数 → null/false', () => {
    const files = assembleDiffFiles(
      parseNameStatus('R100\0old.txt\0new.txt\0M\0a.txt\0'),
      new Map([['new.txt', { additions: 3, deletions: 1, binary: false }]]),
    )
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: 'new.txt', origPath: 'old.txt', status: 'renamed', additions: 3, deletions: 1, patch: null, oversized: false, patchTruncated: false })
    expect(files[1]).toMatchObject({ path: 'a.txt', status: 'modified', additions: null, deletions: null, binary: false })
  })

  it('unmerged U+M 双记录按 path 去重（first-wins，实测冲突仓库形态）', () => {
    const files = assembleDiffFiles(
      parseNameStatus('U\0f.txt\0M\0f.txt\0'),
      new Map([['f.txt', { additions: 4, deletions: 0, binary: false }]]),
    )
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'f.txt', status: 'modified', additions: 4 })
  })
})

// ---------- 集成：真仓库场景 ----------

describe('diff 双路一致性（spec §1.2 [清单 2/3]）', () => {
  it('staged = index 对 HEAD；worktree = 工作区对 index（world 重读 numstat 对照）', async () => {
    const repo = await baseRepo('dshgit-df-dual-')
    await writeFile(join(repo, 'a.txt'), 'a1\na2-changed\n', 'utf8')
    git(repo, 'add', 'a.txt')
    await writeFile(join(repo, 'b.txt'), 'b1-worktree\n', 'utf8')
    await writeFile(join(repo, 'c.txt'), 'c-new\n', 'utf8')
    git(repo, 'add', 'c.txt')

    const { engine } = makeEngine(repo)
    const staged = await engine.diff('staged', null)
    const worktree = await engine.diff('worktree', null)

    // world 对照：两条独立 git diff --numstat（行序不敏感 → 双侧 sort）。
    const worldStaged = execFileSync('git', ['diff', '--cached', '--numstat'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(worldStaged.split('\n').sort()).toEqual(['1\t0\tc.txt', '1\t1\ta.txt'])
    const worldWorktree = execFileSync('git', ['diff', '--numstat'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(worldWorktree).toBe('1\t1\tb.txt')

    expect(staged.scope).toBe('staged')
    expect(staged.path).toBeNull()
    expect(staged.files.map(file => `${file.path}:${file.status}:${file.additions}/${file.deletions}`).sort()).toEqual([
      'a.txt:modified:1/1', 'c.txt:added:1/0',
    ])
    // worktree scope：a.txt/c.txt 工作区 == index（无二次修改）→ 不在 worktree diff；
    // untracked 无 → 只有 b.txt。
    expect(worktree.files.map(file => file.path)).toEqual(['b.txt'])
    expect(worktree.files[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    // staged 文件 patch 真实取回。
    expect(staged.files.find(file => file.path === 'a.txt')?.patch).toContain('-a2')
    expect(staged.totalTruncated).toBe(false)
    expect(Number.isNaN(Date.parse(staged.generatedAt))).toBe(false)
  })

  it('指定路径 = 单文件；不在变更集合（未变更/未跟踪进 staged）⇒ files: []', async () => {
    const repo = await baseRepo('dshgit-df-single-')
    await writeFile(join(repo, 'a.txt'), 'a1\na2-x\n', 'utf8')
    git(repo, 'add', 'a.txt')
    await writeFile(join(repo, 'untracked.txt'), 'u\n', 'utf8')
    const { engine } = makeEngine(repo)
    const single = await engine.diff('staged', 'a.txt')
    expect(single.path).toBe('a.txt')
    expect(single.files).toHaveLength(1)
    expect(single.files[0]).toMatchObject({ path: 'a.txt', status: 'modified', patch: expect.stringContaining('+a2-x') })
    expect((await engine.diff('staged', 'b.txt')).files).toEqual([])
    // untracked 不在 staged（[清单 3]「已暂存将要提交什么」）。
    expect((await engine.diff('staged', 'untracked.txt')).files).toEqual([])
    // 不存在的路径同样空集。
    expect((await engine.diff('worktree', 'nonexistent.txt')).files).toEqual([])
  })
})

describe('binary 与超大（[清单 59]）', () => {
  it('tracked PNG：numstat "-" → binary:true, patch:null（world 对照 -\t-\t）', async () => {
    const repo = await baseRepo('dshgit-df-bin-')
    await writeFile(join(repo, 'shot.png'), pngBytes('v1'))
    git(repo, 'add', 'shot.png')
    git(repo, 'commit', '-qm', 'png')
    await writeFile(join(repo, 'shot.png'), pngBytes('v2-rewritten'))

    const { engine } = makeEngine(repo)
    const result = await engine.diff('worktree', null)
    const png = result.files.find(file => file.path === 'shot.png')
    expect(png).toBeDefined()
    expect(png?.binary).toBe(true)
    expect(png?.patch).toBeNull()
    expect(png?.additions).toBeNull()
    expect(png?.deletions).toBeNull()
    expect(png?.patchTruncated).toBe(false)
    expect(png?.oversized).toBe(false)
    // world 对照：numstat 对 binary 报 '-'。
    const world = execFileSync('git', ['diff', '--numstat'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(world).toBe('-\t-\tshot.png')
  })

  it('>256KiB patch：runner maxBytes 钉在单文件上限 → oversized+patchTruncated, patch:null', async () => {
    const repo = await baseRepo('dshgit-df-big-')
    const big = Array.from({ length: 12_000 }, (_, index) => `line-${index}-padding-padding-padding-padding`).join('\n')
    // 先提交一个占位（tracked），再改写为超限内容（patch > 262_144 字节）。
    await writeFile(join(repo, 'big.txt'), 'placeholder\n', 'utf8')
    git(repo, 'add', 'big.txt')
    git(repo, 'commit', '-qm', 'big-placeholder')
    await writeFile(join(repo, 'big.txt'), `${big}\n`, 'utf8')

    const { engine } = makeEngine(repo) // 默认 filePatchMaxBytes = 262_144
    const result = await engine.diff('worktree', 'big.txt')
    const bigFile = result.files[0]!
    expect(bigFile).toMatchObject({ path: 'big.txt', status: 'modified' })
    expect(bigFile.oversized).toBe(true)
    expect(bigFile.patchTruncated).toBe(true)
    expect(bigFile.patch).toBeNull()
    // patch 全量确实超上限（否则本用例没测到东西）。
    const worldPatch = execFileSync('git', ['diff', '--', 'big.txt'], { cwd: repo, encoding: 'utf8' })
    expect(Buffer.byteLength(worldPatch, 'utf8')).toBeGreaterThan(262_144)
    expect(result.totalTruncated).toBe(false)
  }, 30_000)

  it('总预算：remaining 耗尽后停止追加 patch → totalTruncated:true，已取得的保留', async () => {
    const repo = await baseRepo('dshgit-df-budget-')
    await writeFile(join(repo, 'a.txt'), 'a1\na2-changed-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b1-changed-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', 'utf8')

    const { engine } = makeEngine(repo, { totalPatchMaxBytes: 10 })
    const result = await engine.diff('worktree', null)
    expect(result.totalTruncated).toBe(true)
    const served = result.files.filter(file => file.patch !== null)
    expect(served).toHaveLength(1) // 预算只够一个文件；第二个停止追加
    expect(result.files.every(file => file.oversized === false && file.patchTruncated === false)).toBe(true)
  }, 30_000)
})

describe('untracked no-index（spec §1.2 untracked 段 + M4 任务口径）', () => {
  it('exit=1 白名单内成功：patch 有内容、计数从 patch 推导；argv 恰好一个 -- 紧邻路径', async () => {
    const repo = await baseRepo('dshgit-df-untr-')
    await writeFile(join(repo, 'u.txt'), 'untracked content\nline2\n', 'utf8')

    const spawns: SpawnRecord[] = []
    const { engine } = makeEngine(repo, {}, spawns)
    const result = await engine.diff('worktree', 'u.txt')
    const untracked = result.files[0]!
    expect(untracked).toMatchObject({ path: 'u.txt', status: 'added', binary: false, additions: 2, deletions: 0 })
    expect(untracked.patch).toContain('+untracked content')
    expect(untracked.patch).toContain('--- /dev/null')
    expect(result.totalTruncated).toBe(false)

    // argv 形态回归守卫：no-index 命令 = ['diff','--no-index','--unified=3','/dev/null','--','u.txt']
    // —— 恰好一个 `--`，紧邻文件路径（双 `--` 形态实测 exit 129，见下一条）。
    const noIndexSpawns = spawns.filter(spawn => (spawn.argv as readonly string[]).includes('--no-index'))
    expect(noIndexSpawns).toHaveLength(1)
    const args = noIndexSpawns[0]!.argv as readonly string[]
    const dashIndex = args.indexOf('--')
    expect(args[dashIndex - 1]).toBe('/dev/null')
    expect(args[dashIndex + 1]).toBe('u.txt')
    expect(args.filter(arg => arg === '--')).toHaveLength(1)
  })

  it('零字节文件：world 探针 exit=1（建文件本身就是差异），engine 侧 header-only patch 0/0', async () => {
    const repo = await baseRepo('dshgit-df-empty-')
    await writeFile(join(repo, 'empty.txt'), '', 'utf8')
    // world 探针：spec §1.2 的实测前提（exit 1 = 有差异仍成功）作为回归守卫钉死。
    expect(exitStatusOf(['diff', '--no-index', '--unified=3', '/dev/null', '--', 'empty.txt'], repo)).toBe(1)
    // 不存在的路径同样 exit 1（stderr 报 Could not access）——engine 侧永不触达该形态：
    // untracked 条目来自 ls-files --others（不列不存在路径），no-index 命令只为真实
    // untracked 文件发出（本条 diff.spec 上面的 argv 守卫即此形态）。
    expect(exitStatusOf(['diff', '--no-index', '--unified=3', '/dev/null', '--', 'does-not-exist.txt'], repo)).toBe(1)

    const { engine } = makeEngine(repo)
    const result = await engine.diff('worktree', 'empty.txt')
    const empty = result.files[0]!
    expect(empty).toMatchObject({ path: 'empty.txt', status: 'added', additions: 0, deletions: 0, binary: false })
    expect(empty.patch).toContain('new file mode 100644')
  })

  it('双 `--` 形态 exit 129 回归守卫（防倒退到 usage 失败形态）', async () => {
    const repo = await baseRepo('dshgit-df-dash-')
    await writeFile(join(repo, 'u.txt'), 'x\n', 'utf8')
    expect(exitStatusOf(['diff', '--no-index', '--unified=3', '/dev/null', '--', '--', 'u.txt'], repo)).toBe(129)
  })

  it('untracked binary PNG：Binary files 标记 → binary:true, patch:null', async () => {
    const repo = await baseRepo('dshgit-df-unbin-')
    await writeFile(join(repo, 'shot.png'), pngBytes('untracked'))
    const { engine } = makeEngine(repo)
    const result = await engine.diff('worktree', null)
    const png = result.files.find(file => file.path === 'shot.png')
    expect(png).toMatchObject({ path: 'shot.png', status: 'added', binary: true, patch: null, additions: null })
  })

  it('diff(worktree, null) 并入 untracked 组（added）；staged scope 不含 untracked', async () => {
    const repo = await baseRepo('dshgit-df-scope-')
    await writeFile(join(repo, 'new.txt'), 'n\n', 'utf8')
    const { engine } = makeEngine(repo)
    const worktree = await engine.diff('worktree', null)
    expect(worktree.files.map(file => file.path)).toContain('new.txt')
    const staged = await engine.diff('staged', null)
    expect(staged.files).toEqual([])
  })
})

describe('中文路径全程 round-trip（spec §⑥ diff.spec 行）', () => {
  it('tracked 中文+空格路径：listing/单文件 patch round-trip', async () => {
    const repo = await baseRepo('dshgit-df-cn-')
    await writeFile(join(repo, '文件 甲.txt'), '原\n', 'utf8')
    git(repo, 'add', '文件 甲.txt')
    git(repo, 'commit', '-qm', 'cn')
    await writeFile(join(repo, '文件 甲.txt'), '原\n改\n', 'utf8')

    const { engine } = makeEngine(repo)
    const all = await engine.diff('worktree', null)
    const entry = all.files.find(file => file.path === '文件 甲.txt')
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('modified')
    expect(entry?.additions).toBe(1)
    expect(entry?.patch).toContain('+改')

    const single = await engine.diff('worktree', '文件 甲.txt')
    expect(single.files).toHaveLength(1)
    expect(single.files[0]?.path).toBe('文件 甲.txt')
    expect(single.files[0]?.patch).toContain('+改')
  })

  it('untracked 中文+空格路径：no-index patch round-trip', async () => {
    const repo = await baseRepo('dshgit-df-cn2-')
    await writeFile(join(repo, '新 文件.md'), '新的未跟踪\n', 'utf8')
    const { engine } = makeEngine(repo)
    const result = await engine.diff('worktree', '新 文件.md')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ path: '新 文件.md', status: 'added', additions: 1 })
    expect(result.files[0]?.patch).toContain('+新的未跟踪')
  })
})

describe('commitDiff（M4 任务口径：merge 第一父对比 / 根提交 --root）', () => {
  it('merge 提交按第一父对比：diff = 被合并分支带入的变更（side.txt），主线自身文件已在第一父内不出现（world 对照两树 numstat）', async () => {
    const repo = await baseRepo('dshgit-df-merge-')
    // root(base) → side: side.txt → main: mainline.txt → merge（无冲突）。
    // 第一父 = mainline-work；`git diff <p1> <merge>` = merge 相对第一父带入的变更
    // = side.txt（mainline.txt 在第一父里已存在，不出现在 diff 中）。
    git(repo, 'checkout', '-qb', 'side')
    await writeFile(join(repo, 'side.txt'), 'side\n', 'utf8')
    git(repo, 'add', 'side.txt')
    git(repo, 'commit', '-qm', 'side-work')
    git(repo, 'checkout', '-q', 'main')
    await writeFile(join(repo, 'mainline.txt'), 'mainline\n', 'utf8')
    git(repo, 'add', 'mainline.txt')
    git(repo, 'commit', '-qm', 'mainline-work')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'clean-merge', 'side')

    const mergeOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const worldParents = execFileSync('git', ['rev-list', '--parents', '-n', '1', mergeOid], { cwd: repo, encoding: 'utf8' }).trim().split(/\s+/)
    expect(worldParents).toHaveLength(3) // 确认这真的是 merge 提交
    const firstParent = worldParents[1] as string
    const worldNumstat = execFileSync('git', ['diff', firstParent, mergeOid, '--numstat'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(worldNumstat).toBe('1\t0\tside.txt')

    const { engine } = makeEngine(repo)
    const merged = await engine.commitDiff(mergeOid, null)
    expect(merged.files.map(file => file.path)).toEqual(['side.txt'])
    expect(merged.files[0]).toMatchObject({ status: 'added', additions: 1, patch: expect.stringContaining('+side') })
    expect(merged.totalTruncated).toBe(false)

    // 单文件：主线自身的文件在第一父对比里无差异 → 空集。
    expect((await engine.commitDiff(mergeOid, 'mainline.txt')).files).toEqual([])
    expect((await engine.commitDiff(mergeOid, 'side.txt')).files).toHaveLength(1)
  }, 30_000)

  it('根提交 --root：全部文件 added（world 对照 diff-tree --root）', async () => {
    const repo = await baseRepo('dshgit-df-root-')
    const rootOid = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const world = execFileSync('git', ['diff-tree', '--root', '-r', '--numstat', '--no-commit-id', rootOid], {
      cwd: repo, encoding: 'utf8',
    }).trim()
    expect(world.split('\n').sort()).toEqual(['1\t0\tb.txt', '2\t0\ta.txt']) // root 提交 = 全文件 added（a.txt 2 行）

    const { engine } = makeEngine(repo)
    const root = await engine.commitDiff(rootOid, null)
    expect(root.files.map(file => `${file.path}:${file.status}`).sort()).toEqual(['a.txt:added', 'b.txt:added'])
    const a = root.files.find(file => file.path === 'a.txt')
    expect(a).toMatchObject({ additions: 2, deletions: 0, patch: expect.stringContaining('+a1') })

    const single = await engine.commitDiff(rootOid, 'b.txt')
    expect(single.files).toHaveLength(1)
    expect(single.files[0]).toMatchObject({ path: 'b.txt', patch: expect.stringContaining('+b1') })
  })

  it('非根普通提交 = 两树形态；不存在的修订 → git/git-error', async () => {
    const repo = await baseRepo('dshgit-df-mid-')
    await writeFile(join(repo, 'a.txt'), 'a1\na2-mid\n', 'utf8')
    git(repo, 'commit', '-qam', 'mid')
    const midOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    const { engine } = makeEngine(repo)
    const mid = await engine.commitDiff(midOid, null)
    expect(mid.files.map(file => file.path)).toEqual(['a.txt'])
    expect(mid.files[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })

    const error = await engine.commitDiff('0'.repeat(40), null).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    expect(remoteErrorOf(error)?.code).toBe('git/git-error')
  })
})

describe('失败面与域码（spec §1.2 错误段）', () => {
  it('单文件 patch 失败不炸整体：该文件 patch:null，其余照常（spec §1.2）', async () => {
    const repo = await baseRepo('dshgit-df-soft-')
    await writeFile(join(repo, 'boom.txt'), 'boom\nboom2\n', 'utf8')
    await writeFile(join(repo, 'fine.txt'), 'fine\nfine2\n', 'utf8')
    git(repo, 'add', '.')

    const spawns: SpawnRecord[] = []
    const inner = localSubprocess(spawns)
    const flaky: SubprocessFace = {
      resolveExecutable: inner.resolveExecutable,
      spawn(spec) {
        const argv = spec.argv as readonly string[]
        if (argv.includes('--unified=3') && argv.includes('boom.txt') && !argv.includes('--no-index')) {
          // spawn 失败形态（exitCode null）：GitRunner 抛 git-error → runPatch 软失败。
          return { done: Promise.resolve({ exitCode: null }), collected: {} }
        }
        return inner.spawn(spec)
      },
    }
    const runner = new GitRunner(flaky, 'git', {
      timeoutMs: 20_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    }, READONLY_PREFIX)
    const engine = new DiffEngine(runner, new WorkspaceResolver(repo))
    const result = await engine.diff('staged', null)
    expect(result.files).toHaveLength(2)
    expect(result.files.find(file => file.path === 'boom.txt')).toMatchObject({ patch: null, oversized: false })
    expect(result.files.find(file => file.path === 'fine.txt')?.patch).toContain('+fine')
    expect(result.totalTruncated).toBe(false)
  })

  it('not-repository：普通目录 → git/no-repository，details.probed = 工作区', async () => {
    const plain = await scratchDir('dshgit-df-plain-', cleanups)
    const { engine } = makeEngine(plain)
    const error = await engine.diff('worktree', null).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/no-repository')
    expect(remote?.details).toEqual({ probed: plain })
  })
})

describe('@Remote diff 接线（spec §1.2 签名 + 服务面）', () => {
  it('service.diff(scope, path) 走 wire 形状：scope/path/files/totalTruncated/generatedAt', async () => {
    const repo = await baseRepo('dshgit-df-rpc-')
    await writeFile(join(repo, 'a.txt'), 'a1\na2-rpc\n', 'utf8')
    const service = makeService(repo)
    const result = await service.diff('worktree', null)
    expect(result.scope).toBe('worktree')
    expect(result.path).toBeNull()
    expect(result.files.map(file => file.path)).toEqual(['a.txt'])
    expect(result.files[0]?.patch).toContain('+a2-rpc')
    expect(result.totalTruncated).toBe(false)
    expect(/^\d{4}-\d{2}-\d{2}T/.test(result.generatedAt)).toBe(true)
  })

  it('service 层 not-repository 抛 git/no-repository', async () => {
    const plain = await scratchDir('dshgit-df-rpcplain-', cleanups)
    const service = makeService(plain)
    const error = await service.diff('staged', null).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    expect(remoteErrorOf(error)?.code).toBe('git/no-repository')
  })
})
