/**
 * M9 — watcher.ts + followStatus 流（workflow 任务口径 R1–R6 一条不落；spec §2.3
 * host 侧刷新契约 + §⑥ 集成范式：真实临时 git 仓库 + 世界重读）。
 *
 * 覆盖：
 *   R1 initial —— 订阅即推当前快照（干净仓库 / 非仓库错误帧，错误不断流）；
 *   R2 变化才推 —— 三目标 watch 形状（.git/index、.git/HEAD、repoRoot depth:0）、
 *                  顶层文件编辑 / git add 的 index 重写 / 同树切分支的 HEAD 重写各产生
 *                  change 帧（world 重读对照）、无变化/连发失效只重算一次且零帧；
 *   R3 mutation —— notifyMutation() 推 mutation 帧；净效果为零不推（R2 约束同样适用）；
 *   R4 poll    —— 嵌套目录编辑无 watch 帧（depth:0 已知限制断言）→ poll 帧捕获；
 *                  watchEnabled=false 纯轮询；
 *   R5 manual  —— refresh() 无条件推帧（唯一旁路 R2）；followStatus 上行
 *                  {type:'refresh'} → manual 帧，未知 type 忽略；
 *   R6 降级    —— SSH provider stub（fs 基类 watch 拒绝）仅 warn 一次转纯轮询；
 *                  changed(error) 同样降级且后续失效回调被忽略；fs 能力缺失同路径；
 *   引用计数   —— 双订阅共享一套 watcher；首个断开不关、末个断开全关；重启重开；
 *                  abort 断开清理（订阅面 watch/定时器全收）。
 *
 * fs watch 替身三件套在 support.ts：chokidarFsFace（fs-local 行为仿真——真实 fs 事件）、
 * manualFsFace（手动触发 + 调用记录）、rejectingFsFace（ssh 世界）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 并行跑的资源裕量（全仓用例大量真实 git 子进程 / 真实 fs+定时器；本机 16 核 Windows
// 上 vitest 默认 5s/10s 边缘超时——client 地基模块全绿门禁实测复现；单文件跑恒绿）。
// 只放宽超时上限，断言面零改动。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })
import type { GitLoggerFace } from '../src/error-codes.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX } from '../src/git-runner.ts'
import { GitService } from '../src/index.ts'
import { StatusEngine } from '../src/status.ts'
import { StatusWatcher } from '../src/watcher.ts'
import type { GitFsWatchFace } from '../src/watcher.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import {
  chokidarFsFace, git, localSubprocess, manualFsFace, rejectingFsFace, scratchDir,
  type SpawnRecord,
} from './support.ts'
import type { GitStatusFrame } from '../src/types.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** 基础仓库：一个提交，含 tracked.txt / tracked2.txt（world 重读基准）。 */
async function baseRepo(prefix: string): Promise<string> {
  const repo = await scratchDir(prefix, cleanups)
  git(repo, 'init', '-q', '-b', 'main')
  for (const name of ['tracked.txt', 'tracked2.txt']) {
    await writeFile(join(repo, name), `${name}\n`, 'utf8')
  }
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  return repo
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveWait => { setTimeout(resolveWait, ms) })
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await sleep(20)
  }
  return true
}

interface WatchHarness {
  watcher: StatusWatcher
  spawns: SpawnRecord[]
  warns: string[]
  infos: string[]
}

function makeWatcher(
  workspace: string,
  options: { debounceMs?: number; pollIntervalMs?: number; watchEnabled?: boolean } = {},
  fsFace?: GitFsWatchFace,
): WatchHarness {
  const spawns: SpawnRecord[] = []
  const runner = new GitRunner(localSubprocess(spawns), 'git', {
    timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  }, READONLY_PREFIX)
  const engine = new StatusEngine(runner, new WorkspaceResolver(workspace), {})
  const warns: string[] = []
  const infos: string[] = []
  const logger: GitLoggerFace = {
    debug() { /* 静音 */ },
    info(message) { infos.push(message) },
    warn(message) { warns.push(message) },
    error() { /* 静音 */ },
  }
  const watcher = new StatusWatcher(engine, fsFace, {
    debounceMs: options.debounceMs ?? 20,
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    watchEnabled: options.watchEnabled ?? true,
    logger,
  })
  return { watcher, spawns, warns, infos }
}

function porcelainScanCount(spawns: readonly SpawnRecord[]): number {
  return spawns.filter(spawn => (spawn.argv as readonly string[]).includes('--porcelain=v2')).length
}

/** 流泵：后台 for-await 收帧；waitFor 以谓词+时限等待，不丢失唤醒（广播即时 resolve）。 */
class FramePump {
  private readonly buffer: GitStatusFrame[] = []
  private finished = false
  private failure: unknown = null
  private wake: (() => void) | null = null
  private readonly task: Promise<void>
  private readonly iterator: AsyncIterator<GitStatusFrame>

  constructor(stream: AsyncIterable<GitStatusFrame>) {
    this.iterator = stream[Symbol.asyncIterator]()
    const iterator = this.iterator
    this.task = (async () => {
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) break
          this.buffer.push(next.value)
          this.releaseWake()
        }
      } catch (error) {
        this.failure = error
      } finally {
        this.finished = true
        this.releaseWake()
      }
    })()
  }

  get frames(): readonly GitStatusFrame[] {
    return [...this.buffer]
  }

  get pumpFailure(): unknown {
    return this.failure
  }

  private releaseWake(): void {
    const wakeup = this.wake
    this.wake = null
    wakeup?.()
  }

  /** 等到谓词成立或时限；返回是否成立（不成立时调用方自行断言已收集帧）。 */
  async waitFor(predicate: (frames: readonly GitStatusFrame[]) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate(this.buffer)) return true
      if (this.finished || this.failure !== null) return false
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise<void>((resolveWait) => {
        let wakeRef: () => void
        const timer = setTimeout(() => { wakeRef() }, Math.min(remaining, 20))
        wakeRef = (): void => {
          clearTimeout(timer)
          if (this.wake === wakeRef) this.wake = null
          resolveWait()
        }
        this.wake = wakeRef
      })
    }
  }

  /** 断开：先 abort（生成器等待点被 disconnect 唤醒）再 return，等泵彻底收尾。 */
  async stop(controller?: AbortController): Promise<void> {
    controller?.abort()
    if (!this.finished) {
      try {
        await this.iterator.return?.()
      } catch {
        // 已结束/竞态：泵收尾由 task 承担。
      }
    }
    await this.task
  }
}

function reasonSequence(frames: readonly GitStatusFrame[]): string[] {
  return frames.map(frame => frame.reason)
}

/**
 * 本文件用例的统一 60s 预算（真 git 子进程 + chokidar 就绪 + 世界重读；vitest 默认
 * 5s 对首跑实测的「initial 帧 + chokidar 开目标 + 重算」链路太紧）。F7 提交图全链
 * 模块（2026-10-31）20s→60s：套件加量（log-refs-show 等真 git 用例）后的重负载
 * 轮次把「嵌套目录编辑 → poll 帧捕获」用例顶到 20s 超时（全量门禁实测 1 次；
 * 单文件跑恒绿）——M6 remote-ops 模块的同款资源裕量处置，纯上限放宽零断言改动。
 */
function m9it(name: string, fn: () => Promise<void>): void {
  it(name, fn, 60_000)
}

/**
 * 等三目标 watch 全部就绪。initial 帧的广播**不等待** openWatchers 完成（fire-and-forget），
 * 测试在触发 fs 事件前必须先等就绪，否则唯一的一次事件会落在 watcher ready 之前丢失
 * （生产态由 R4 轮询兜底，测试窗内等不到）。
 */
async function watchTargetsReady(watcher: StatusWatcher, count = 3): Promise<boolean> {
  // 5s 在 6-worker 全量门禁下会被 chokidar 的 ready 顶穿（2026-11-01 实测：
  // 同文件单跑恒绿、全量偶发 false）；这是测试前置条件，不是被测行为。
  return waitForCondition(() => watcher.openWatcherCount >= count, 15_000)
}

// ─────────────────────────────── R1 initial ───────────────────────────────

describe('R1 initial（订阅即推当前状态，不经 R2 门）', () => {
  m9it('干净仓库：首帧 kind=status reason=initial clean=true（world 重读对照）', async () => {
    const repo = await baseRepo('dshgit-wt-r1-')
    const { watcher } = makeWatcher(repo, {}, chokidarFsFace())
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      const first = pump.frames[0]
      expect(first?.kind).toBe('status')
      expect(first?.reason).toBe('initial')
      if (first?.kind !== 'status') throw new Error('unreachable')
      expect(first.snapshot.repoRoot).toBe(repo)
      expect(first.snapshot.clean).toBe(true)
      expect(first.snapshot.staged).toEqual([])
      // world 重读：仓库确实干净。
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(pump.pumpFailure).toBeNull()
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('非仓库：首帧 kind=error git/no-repository；git init 后流不断开、poll 帧转 status；错误帧不重复', async () => {
    const plain = await scratchDir('dshgit-wt-r1plain-', cleanups)
    const { watcher } = makeWatcher(plain, { pollIntervalMs: 80 }, chokidarFsFace())
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      const first = pump.frames[0]
      expect(first?.kind).toBe('error')
      expect(first?.reason).toBe('initial')
      if (first?.kind !== 'error') throw new Error('unreachable')
      expect(first.error.code).toBe('git/no-repository')

      // 稳定不就绪态进 R2 门：同签名错误帧在后续 poll 里不重复推。
      await sleep(250)
      expect(pump.frames.filter(frame => frame.kind === 'error')).toHaveLength(1)

      // 世界变化：目录变成仓库 → 下一个 poll 帧 kind=status，流未断。
      git(plain, 'init', '-q', '-b', 'main')
      expect(await pump.waitFor(frames => frames.some(frame => frame.kind === 'status'), 10_000)).toBe(true)
      const ready = pump.frames.find(frame => frame.kind === 'status')
      expect(ready?.reason).toBe('poll')
      expect(pump.pumpFailure).toBeNull()
    } finally {
      await pump.stop(controller)
    }
  })
})

// ─────────────────────────────── R2 变化才推 ───────────────────────────────

describe('R2 变化才推（三目标 watch → 防抖 → 重算 → 门）', () => {
  m9it('三目标形状：watch 以 .git/index、.git/HEAD、repoRoot 三个目标打开（manual stub 记录）', async () => {
    const repo = await baseRepo('dshgit-wt-targets-')
    const face = manualFsFace()
    const { watcher } = makeWatcher(repo, {}, face.face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      // 三目标在首个 ready 帧解析出 repoRoot 后打开。
      expect(await waitForCondition(() => face.records.length === 3, 5_000)).toBe(true)
      expect(face.records.map(record => record.target).sort()).toEqual([
        join(repo, '.git', 'HEAD'),
        join(repo, '.git', 'index'),
        repo,
      ].sort())
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('无变化不推：防抖窗内连发 5 次失效 → 仅一次重算（spawn 计数）、零新帧', async () => {
    const repo = await baseRepo('dshgit-wt-r2quiet-')
    const face = manualFsFace()
    const { watcher, spawns } = makeWatcher(repo, { debounceMs: 30 }, face.face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(await waitForCondition(() => face.records.length === 3, 5_000)).toBe(true)
      const baseline = porcelainScanCount(spawns)

      for (let index = 0; index < 5; index += 1) face.fireAll()
      // 防抖后的那次重算确实发生（否则断言无意义）。
      expect(await waitForCondition(() => porcelainScanCount(spawns) >= baseline + 1, 5_000)).toBe(true)
      await sleep(300)
      // 单飞合并：整窗只有一次重算；R2 门：内容未变 → 无帧。
      expect(porcelainScanCount(spawns)).toBe(baseline + 1)
      expect(pump.frames).toHaveLength(1)
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('顶层文件编辑（repoRoot depth:0 目标）→ reason=change 帧 + world 重读', async () => {
    const repo = await baseRepo('dshgit-wt-r2top-')
    const { watcher } = makeWatcher(repo, {}, chokidarFsFace())
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(await watchTargetsReady(watcher)).toBe(true)
      await writeFile(join(repo, 'tracked.txt'), 'modified\n', 'utf8')
      expect(await pump.waitFor(frames => frames.some(frame => frame.reason === 'change'), 10_000)).toBe(true)
      const change = pump.frames.find(frame => frame.reason === 'change')
      expect(change?.kind).toBe('status')
      if (change?.kind !== 'status') throw new Error('unreachable')
      const modified = change.snapshot.unstaged.find(entry => entry.path === 'tracked.txt')
      expect(modified?.x).toBe('.')
      expect(modified?.y).toBe('M')
      // world 重读（独立 git 进程）。
      expect(git(repo, 'status', '--porcelain')).toContain(' M tracked.txt')
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('.git/index 目标：git add 新文件（index 重写）→ staged 组进帧', async () => {
    const repo = await baseRepo('dshgit-wt-r2index-')
    const { watcher } = makeWatcher(repo, {}, chokidarFsFace())
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(await watchTargetsReady(watcher)).toBe(true)
      // new.txt 的创建本身也是根目标事件（untracked 态可能先出一帧）；这里锚定
      // 「staged 含 new.txt」的那一帧——只有 index 目标能捕获 staging 动作。
      await writeFile(join(repo, 'new.txt'), 'new\n', 'utf8')
      git(repo, 'add', 'new.txt')
      expect(await pump.waitFor(
        frames => frames.some(frame =>
          frame.kind === 'status' && frame.snapshot.staged.some(entry => entry.path === 'new.txt')),
        10_000,
      )).toBe(true)
      const staged = pump.frames.find(frame =>
        frame.kind === 'status' && frame.snapshot.staged.some(entry => entry.path === 'new.txt'))
      expect(staged?.reason).toBe('change')
      // world 重读。
      expect(git(repo, 'status', '--porcelain')).toContain('A  new.txt')
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('.git/HEAD 目标：同树切分支（仅 HEAD 重写）→ change 帧 branch.name 更新', async () => {
    const repo = await baseRepo('dshgit-wt-r2head-')
    const { watcher } = makeWatcher(repo, {}, chokidarFsFace())
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      const initial = pump.frames[0]
      expect(initial?.kind).toBe('status')
      if (initial?.kind !== 'status') throw new Error('unreachable')
      expect(initial.snapshot.branch.name).toBe('main')
      expect(await watchTargetsReady(watcher)).toBe(true)
      git(repo, 'checkout', '-qb', 'topic')
      expect(await pump.waitFor(
        frames => frames.some(frame => frame.kind === 'status' && frame.snapshot.branch.name === 'topic'),
        10_000,
      )).toBe(true)
      const topic = pump.frames.find(frame => frame.kind === 'status' && frame.snapshot.branch.name === 'topic')
      expect(topic?.reason).toBe('change')
      // world 重读。
      expect(git(repo, 'branch', '--show-current')).toBe('topic\n')
    } finally {
      await pump.stop(controller)
    }
  })
})

// ─────────────────────────────── R3 mutation ───────────────────────────────

describe('R3 mutation（写后失效入口；净效果为零受 R2 约束）', () => {
  m9it('notifyMutation() → reason=mutation 帧（world 重读）', async () => {
    const repo = await baseRepo('dshgit-wt-r3-')
    const { watcher } = makeWatcher(repo, {}, manualFsFace().face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      await writeFile(join(repo, 'tracked.txt'), 'mutated\n', 'utf8')
      watcher.notifyMutation()
      expect(await pump.waitFor(frames => frames.some(frame => frame.reason === 'mutation'), 10_000)).toBe(true)
      const mutation = pump.frames.find(frame => frame.reason === 'mutation')
      if (mutation?.kind !== 'status') throw new Error('unreachable')
      expect(mutation.snapshot.unstaged.some(entry => entry.path === 'tracked.txt')).toBe(true)
      expect(git(repo, 'status', '--porcelain')).toContain(' M tracked.txt')
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('未变更仓库 notifyMutation() → 无帧（R2 门适用于 mutation）', async () => {
    const repo = await baseRepo('dshgit-wt-r3quiet-')
    const { watcher } = makeWatcher(repo, {}, manualFsFace().face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      watcher.notifyMutation()
      expect(await pump.waitFor(frames => frames.length > 1, 600)).toBe(false)
      expect(pump.frames).toHaveLength(1)
    } finally {
      await pump.stop(controller)
    }
  })
})

// ─────────────────────────────── R4 poll ───────────────────────────────

describe('R4 poll（轮询兜底；嵌套目录编辑的已知限制）', () => {
  m9it('嵌套目录编辑：watch 层无 change 帧（depth:0 已知限制断言）→ poll 帧捕获', async () => {
    const repo = await baseRepo('dshgit-wt-r4nested-')
    // 嵌套目录在订阅**之前**建好：空目录不进 porcelain（untracked-files=all 不列空目录），
    // 也消除 mkdir 的 addDir 竞态——首轮门禁在负载下实测踩坑：addDir 是根的直接子项事件，
    // 其触发的重算若读到已写入的嵌套文件会推出 'change' 帧，污染「无 change 帧」的限制断言。
    // 目录先于 watcher 存在后，写嵌套文件是 depth 1，三目标均无任何事件，窗内只剩轮询。
    await mkdir(join(repo, 'nested'))
    const { watcher, warns } = makeWatcher(repo, { pollIntervalMs: 80 }, chokidarFsFace())
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(
        await watchTargetsReady(watcher),
        `openWatcherCount=${watcher.openWatcherCount} degraded=${watcher.degradedToPolling} warns=${JSON.stringify(warns)}`,
      ).toBe(true)
      const framesBeforeEdit = pump.frames.length
      // 嵌套文件编辑：depth 1 —— 三目标 watch 均无信号（已知限制）。
      await writeFile(join(repo, 'nested', 'file.txt'), 'deep\n', 'utf8')
      expect(await pump.waitFor(frames => frames.length > framesBeforeEdit, 5_000)).toBe(true)
      const caughtUp = pump.frames.slice(framesBeforeEdit)
      // 限制断言：捕获它的只能是轮询（没有任何 'change' 帧）。
      expect(caughtUp.every(frame => frame.reason === 'poll')).toBe(true)
      const last = caughtUp.at(-1)
      if (last?.kind !== 'status') throw new Error('unreachable')
      // porcelain -z 的路径分隔符恒为 '/'（git 输出契约，平台无关）。
      expect(last.snapshot.untracked.map(entry => entry.path)).toContain('nested/file.txt')
      // world 重读（独立 git 进程；-uall 防 v1 porcelain 的空目录折叠）。
      expect(git(repo, 'status', '--porcelain', '-uall')).toContain('?? nested/file.txt')
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('watchEnabled=false：从不打开 watch（零记录）、不 warn（info 降级）、变更经 poll 帧到达', async () => {
    const repo = await baseRepo('dshgit-wt-r4off-')
    const face = manualFsFace()
    const { watcher, warns, infos } = makeWatcher(repo, { watchEnabled: false, pollIntervalMs: 80 }, face.face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(await waitForCondition(() => watcher.degradedToPolling, 2_000)).toBe(true)
      expect(face.records).toHaveLength(0)
      expect(warns).toEqual([])
      expect(infos.some(message => message.includes('watchEnabled=false'))).toBe(true)
      await writeFile(join(repo, 'tracked.txt'), 'poll-only\n', 'utf8')
      expect(await pump.waitFor(frames => frames.some(frame => frame.reason === 'poll'), 10_000)).toBe(true)
    } finally {
      await pump.stop(controller)
    }
  })
})

// ─────────────────────────────── R5 manual ───────────────────────────────

describe('R5 manual（显式刷新：唯一旁路 R2 的原因）', () => {
  m9it('refresh()：内容未变也推 reason=manual（连续两次 → 两帧）', async () => {
    const repo = await baseRepo('dshgit-wt-r5-')
    const { watcher } = makeWatcher(repo, {}, manualFsFace().face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      watcher.refresh()
      expect(await pump.waitFor(frames => frames.filter(frame => frame.reason === 'manual').length >= 1, 10_000)).toBe(true)
      watcher.refresh()
      expect(await pump.waitFor(frames => frames.filter(frame => frame.reason === 'manual').length >= 2, 10_000)).toBe(true)
      // 内容未变的 manual 帧也带完整 status 快照。
      const manual = pump.frames.find(frame => frame.reason === 'manual')
      expect(manual?.kind).toBe('status')
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('followStatus 上行命令：{type:"refresh"} → manual 帧；未知 type 忽略', async () => {
    const repo = await baseRepo('dshgit-wt-r5uplink-')
    const ctx = new Context() as never
    const face = ctx as { provide(name: string, value: unknown): void }
    face.provide('subprocess', localSubprocess())
    const uplink = (async function* () {
      yield { type: 'refresh' }
      yield { type: 'mystery' }
    })()
    face.provide('invocation', { uplink: () => uplink })
    const service = new GitService(ctx, {
      gitCommand: 'git',
      fastTimeoutMs: 15_000,
      outputMaxBytes: 8 * 1024 * 1024,
      workspaceOverride: repo,
      debounceMs: 20,
      pollIntervalMs: 60_000,
      watchEnabled: true,
    })
    const controller = new AbortController()
    const pump = new FramePump(await service.followStatus(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.some(frame => frame.reason === 'manual'), 10_000)).toBe(true)
      // uplink 恰有一个 refresh → 恰一帧 manual；mystery 被忽略。
      await sleep(300)
      expect(reasonSequence(pump.frames)).toEqual(['initial', 'manual'])
    } finally {
      await pump.stop(controller)
    }
  })
})

// ─────────────────────────────── R6 降级 ───────────────────────────────

describe('R6 降级（watch 抛错仅 warn 一次转纯轮询）', () => {
  m9it('SSH provider stub（watch 拒绝）：不向消费者抛错、仅 warn 一次、拉闸后不再尝试、变更只有 poll 帧', async () => {
    const repo = await baseRepo('dshgit-wt-r6ssh-')
    const face = rejectingFsFace()
    const { watcher, warns } = makeWatcher(repo, { pollIntervalMs: 80 }, face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      // R1 initial 不受降级影响（重算真值来自 git，不来自 watch）。
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(pump.frames[0]?.kind).toBe('status')
      // index 目标 resolve 可用 → watch 被尝试并拒绝 → R6。
      expect(await waitForCondition(() => face.resolveCalls >= 1, 5_000)).toBe(true)
      expect(await waitForCondition(() => watcher.degradedToPolling, 5_000)).toBe(true)
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('poll')
      await sleep(200)
      expect(face.watchAttempts).toBe(1)
      expect(face.resolveCalls).toBe(1)
      // 后续变更只由轮询捕获（reason=poll，无 change）。
      await writeFile(join(repo, 'tracked.txt'), 'after-degrade\n', 'utf8')
      expect(await pump.waitFor(frames => frames.length > 1, 10_000)).toBe(true)
      expect(pump.frames.slice(1).every(frame => frame.reason === 'poll')).toBe(true)
      expect(warns).toHaveLength(1)
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('changed(error) → 降级：warn 一次；后续失效回调被忽略（无 change 帧），poll 仍推', async () => {
    const repo = await baseRepo('dshgit-wt-r6error-')
    const face = manualFsFace()
    const { watcher, warns } = makeWatcher(repo, { pollIntervalMs: 100 }, face.face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(await waitForCondition(() => face.records.length === 3, 5_000)).toBe(true)
      face.records[0]?.changed(new Error('EPERM: watcher broke'))
      expect(await waitForCondition(() => watcher.degradedToPolling, 5_000)).toBe(true)
      expect(warns).toHaveLength(1)
      // 拉闸：全部 watch 关闭。
      expect(await waitForCondition(() => face.records.every(record => record.closed), 5_000)).toBe(true)
      // 降级后到达的失效回调被忽略（close 竞态防御）：真实变更也不产生 change 帧。
      await writeFile(join(repo, 'tracked.txt'), 'post-degrade\n', 'utf8')
      face.records[0]?.changed()
      expect(await pump.waitFor(frames => frames.length > 1, 10_000)).toBe(true)
      expect(pump.frames.slice(1).every(frame => frame.reason === 'poll')).toBe(true)
      expect(warns).toHaveLength(1)
    } finally {
      await pump.stop(controller)
    }
  })

  m9it('fs 能力缺失（宿主未提供 fs 服务）：R6 降级纯轮询，followStatus 帧流照常', async () => {
    const repo = await baseRepo('dshgit-wt-r6nofs-')
    const ctx = new Context() as never
    const face = ctx as { provide(name: string, value: unknown): void }
    face.provide('subprocess', localSubprocess())
    const service = new GitService(ctx, {
      gitCommand: 'git',
      fastTimeoutMs: 15_000,
      outputMaxBytes: 8 * 1024 * 1024,
      workspaceOverride: repo,
      pollIntervalMs: 80,
      watchEnabled: true,
    })
    const controller = new AbortController()
    const pump = new FramePump(await service.followStatus(controller.signal))
    try {
      expect(await pump.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(service.watcherOf().degradedToPolling).toBe(true)
      await writeFile(join(repo, 'tracked.txt'), 'no-fs\n', 'utf8')
      expect(await pump.waitFor(frames => frames.some(frame => frame.reason === 'poll'), 10_000)).toBe(true)
    } finally {
      await pump.stop(controller)
    }
  })
})

// ─────────────────────── 引用计数启停与订阅断开清理 ───────────────────────

describe('引用计数启停与订阅断开清理', () => {
  m9it('双订阅共享同一套 watcher（3 目标各一次）；首个断开不关，末个断开全关', async () => {
    const repo = await baseRepo('dshgit-wt-refs-')
    const face = manualFsFace()
    const { watcher } = makeWatcher(repo, {}, face.face)
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    const pumpA = new FramePump(watcher.follow(controllerA.signal))
    const pumpB = new FramePump(watcher.follow(controllerB.signal))
    try {
      expect(await pumpA.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      expect(await pumpB.waitFor(frames => frames.length >= 1, 10_000)).toBe(true)
      // 两个订阅各得一个 initial 帧（R1），共享同一套 watch（三目标各一次）。
      expect(await waitForCondition(() => face.records.length === 3, 5_000)).toBe(true)
      expect(watcher.subscriberCount).toBe(2)
      expect(face.records.every(record => record.closeCount === 0)).toBe(true)

      await pumpA.stop(controllerA)
      expect(watcher.subscriberCount).toBe(1)
      expect(face.records.every(record => !record.closed)).toBe(true)

      await pumpB.stop(controllerB)
      expect(watcher.subscriberCount).toBe(0)
      expect(await waitForCondition(() => face.records.every(record => record.closed && record.closeCount === 1), 5_000)).toBe(true)
    } finally {
      await pumpA.stop(controllerA)
      await pumpB.stop(controllerB)
    }
  })

  m9it('重启：全部断开后再订阅 → watcher 重新打开（watch 记录再增 3）', async () => {
    const repo = await baseRepo('dshgit-wt-restart-')
    const face = manualFsFace()
    const { watcher } = makeWatcher(repo, {}, face.face)
    const first = new AbortController()
    const pump1 = new FramePump(watcher.follow(first.signal))
    expect(await pump1.waitFor(frameCount(1), 10_000)).toBe(true)
    expect(await waitForCondition(() => face.records.length === 3, 5_000)).toBe(true)
    await pump1.stop(first)
    expect(await waitForCondition(() => face.records.every(record => record.closed), 5_000)).toBe(true)

    const second = new AbortController()
    const pump2 = new FramePump(watcher.follow(second.signal))
    try {
      expect(await pump2.waitFor(frameCount(1), 10_000)).toBe(true)
      expect(await waitForCondition(() => face.records.length === 6, 5_000)).toBe(true)
      expect(face.records.slice(0, 3).every(record => record.closed)).toBe(true)
      expect(face.records.slice(3).every(record => !record.closed)).toBe(true)
    } finally {
      await pump2.stop(second)
    }
  })

  m9it('订阅断开清理（abort 信号）：生成器结束、watch 全关、订阅面归零', async () => {
    const repo = await baseRepo('dshgit-wt-abort-')
    const face = manualFsFace()
    const { watcher } = makeWatcher(repo, {}, face.face)
    const controller = new AbortController()
    const pump = new FramePump(watcher.follow(controller.signal))
    expect(await pump.waitFor(frameCount(1), 10_000)).toBe(true)
    expect(await waitForCondition(() => face.records.length === 3, 5_000)).toBe(true)
    controller.abort()
    await pump.stop(controller)
    expect(pump.pumpFailure).toBeNull()
    expect(watcher.subscriberCount).toBe(0)
    expect(await waitForCondition(() => face.records.every(record => record.closed), 5_000)).toBe(true)
  })
})

/** frameCount 谓词工厂（waitFor 用）。 */
function frameCount(minimum: number): (frames: readonly GitStatusFrame[]) => boolean {
  return frames => frames.length >= minimum
}
