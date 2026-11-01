/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/fileWatcher/fileWatcherService.ts
 *         （DEBOUNCE_MS = 150 常量 :13 与「clearTimeout + setTimeout 防抖窗」结构 :78-92；
 *          登记口径含引用计数启停语义——research/ported-sources/SOURCES.md:36）
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-31（M9 watcher/followStatus 模块）——
 *   ① node:fs.watch 换宿主 fs 能力面（GitFsWatchFace = ctx.fs.resolve + ctx.fs.watch 的
 *      结构切片，同 git-runner.ts SubprocessFace 先例；【map】§4.2：watch 是可选能力，
 *      远端（ssh）provider 无 override → 基类默认拒绝）；
 *   ② 监听目标改三目标（.git/index 文件、.git/HEAD 文件、仓库根目录 depth:0）——
 *      宿主 watch 限制（depth:0 不递归、目录目标无忽略过滤、回调不带内容路径）下的
 *      设计：.git/index 由 index 重写触发（add/commit/stage），.git/HEAD 由切分支触发，
 *      仓库根 depth:0 盖顶层直接子项；.git 内部超出 depth 0 不产生事件（fs-local 实读，
 *      map §4.2 ✅核），故根目标对 .git 自身变动天然「过滤」；防抖回调无路径可过滤 →
 *      R2 内容比对承担去重；嵌套目录编辑只有 R4 轮询兜底能捕获（已知限制，测试断言）；
 *   ③ 事件风暴防线从「路径过滤」改为 ZCode 同款防抖 + R2 变化才推（帧签名剔除
 *      generatedAt 后比对）；
 *   ④ 引用计数启停为本模块实现（首个订阅开 watch+定时器，末个订阅者断开全关）；
 *   ⑤ R6 降级：watch 抛错/拒绝/回调报错 → 仅 warn 一次 → 转纯轮询（拉闸后回调忽略）；
 *   ⑥ GitStatusFrame 流帧与 R1–R5 触发规则、上行 refresh 命令为本模块设计
 *      （workflow 任务口径 M9）；失效+重算范式对照 dsh workspace-files changes.ts
 *      follow()（MIT，仅语义对照）。
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * dsh-gitkit — 状态监听与流式广播引擎（spec §2.3 host 侧刷新契约的 v1 落地面）。
 *
 * 事件广播不可用（spec §2.1：API_REMOTE_FORWARDED_EVENTS 静态收口无 git/*），v1 的
 * 「推送」落为 `followStatus` 流方法（typert stream 模式）：client 打开一条逻辑流，
 * host 按 R1–R6 规则推 GitStatusFrame：
 *
 *   R1 initial   —— 每个订阅建立即推当前快照/错误帧（无条件）；
 *   R2 变化才推   —— watch 触发的重算，帧内容（剔除 generatedAt 的签名）与上一帧相同不推；
 *   R3 mutation  —— 本插件写操作完成 → notifyMutation() → 重算推帧（reason='mutation'，
 *                   同样受 R2 约束）；写 RPC 属后续模块，本模块只交付入口；
 *   R4 poll      —— pollIntervalMs 定时重算推帧（reason='poll'；嵌套目录编辑只能靠它）；
 *   R5 manual    —— 客户端经流上行 {type:'refresh'}（或进程内 refresh()）→ 重算
 *                   **无条件**推帧（reason='manual'——客户端失步后要求重同步，
 *                   受 R2 约束会永远收不到帧，故 manual 是唯一旁路）；
 *   R6 降级      —— fs watch 不可用（能力缺失/拒绝/抛错/回调报错）→ 仅 warn 一次 →
 *                   关闭全部 watch 转纯轮询（后续失效回调被忽略，不再产生 'change' 帧）。
 *
 * 引用计数：订阅数 0→1 启动（轮询定时器 + 等首个 ready 帧解析出 repoRoot 后开三目标
 * watch），1→0 全部关闭（定时器清空、watch close、未决防抖丢弃、基线帧复位）。
 */

import { join } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { GitLoggerFace } from './error-codes.ts'
import type { StatusEngine, StatusState } from './status.ts'
import type { GitFrameError, GitStatusFrame, GitStatusFrameReason } from './types.ts'

/** fs 事件防抖默认毫秒（ZCode fileWatcherService.ts:13 DEBOUNCE_MS；spec §1.0.2 debounceMs）。 */
export const DEFAULT_DEBOUNCE_MS = 150

/** 兜底轮询默认间隔毫秒（ZCode useGitAutoRefresh 60s，SOURCES.md:40；spec §1.0.2 pollIntervalMs）。 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/**
 * 宿主 fs 能力的结构切片（本包不依赖 @deepseek-ai/dsh-fs 类型包，运行时对象由宿主
 * 提供）。`resolve` 把路径定型为 provider 的 target（opaque）；`watch` 的 `changed`
 * 是**失效回调、不带内容路径**（map §4.2），`signal` 只取消初始化，已建立的 watcher
 * 用返回的 close 关闭；不支持 watching 的 provider（基类默认实现/ssh 世界）拒绝。
 */
export interface GitFsWatchFace {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  watch(
    target: unknown,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>>
}

export interface StatusWatcherOptions {
  /** fs 事件防抖毫秒（缺省 {@link DEFAULT_DEBOUNCE_MS}）。 */
  debounceMs?: number
  /** 兜底轮询间隔毫秒（缺省 {@link DEFAULT_POLL_INTERVAL_MS}）。 */
  pollIntervalMs?: number
  /** host 文件监听开关（缺省 true；false = 纯轮询，info 级日志不算 R6 故障）。 */
  watchEnabled?: boolean
  /** cordis logger 结构切片（可缺省——测试静音）。 */
  logger?: GitLoggerFace
}

/** 一个订阅者的下行队列与唤醒句柄（async generator 单消费者）。 */
interface WatchSubscriber {
  queue: GitStatusFrame[]
  wakeup: (() => void) | null
  signal: AbortSignal
  released: boolean
  /** 首个 disconnect 的完整收尾 promise（abort 路径与生成器 finally 竞争时共享）。 */
  releasePromise: Promise<void>
}

/** 帧推送原因的优先序：同一防抖窗内多个触发合并为一次重算时，取最强原因落帧。 */
const REASON_PRIORITY: readonly GitStatusFrameReason[] = ['mutation', 'manual', 'change', 'poll']

/** R2 的内容签名：剔除 generatedAt（每次重算必变）后全量结构比对。 */
function frameSignature(frame: GitStatusFrame): string {
  if (frame.kind === 'error') {
    return `error:${frame.error.code}:${frame.error.message}`
  }
  const snapshot = frame.snapshot
  return JSON.stringify({
    repoRoot: snapshot.repoRoot,
    branch: snapshot.branch,
    staged: snapshot.staged,
    unstaged: snapshot.unstaged,
    untracked: snapshot.untracked,
    conflicted: snapshot.conflicted,
    clean: snapshot.clean,
  })
}

/** 一次重算失败（含工作区解析不出/非仓库）→ 帧错误投影（wire 面 code+message）。 */
function frameErrorOf(cause: unknown): GitFrameError {
  if (cause instanceof RemoteError) {
    return { code: cause.code, message: cause.message }
  }
  return { code: 'git/git-error', message: cause instanceof Error ? cause.message : String(cause) }
}

/** 从待处理集合取最强原因（一并清空——同一窗内一次重算盖全部触发）。 */
function pickReason(pending: Set<GitStatusFrameReason>): GitStatusFrameReason {
  let chosen: GitStatusFrameReason = 'poll'
  for (const reason of pending) {
    if (REASON_PRIORITY.indexOf(reason) < REASON_PRIORITY.indexOf(chosen)) chosen = reason
  }
  pending.clear()
  return chosen
}

/**
 * 状态监听引擎：三目标 watch + 防抖 + 轮询兜底 + 引用计数启停 + R1–R6 推送规则。
 * 全部帧计算经单飞管线串行（重算触发合并 + R2 基线一致），StatusEngine 负责扫描
 * 去重与三态，本引擎在每次重算前显式失效其 TTL 缓存（watch 事件语义 = 失效信号，
 * dsh workspace-files changes.ts 的失效+重取范式）。
 */
export class StatusWatcher {
  private readonly debounceMs: number
  private readonly pollIntervalMs: number
  private readonly watchEnabled: boolean
  private readonly logger: GitLoggerFace | undefined

  /** 订阅集合（引用计数的真值来源：size 即活跃订阅数）。 */
  private readonly subscribers = new Set<WatchSubscriber>()
  /** 帧计算单飞管线（initial 与重算共用，保证基线读写串行）。 */
  private chain: Promise<unknown> = Promise.resolve()
  private draining = false
  private readonly pendingReasons = new Set<GitStatusFrameReason>()

  private refs = 0
  private running = false
  private pollTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  /** 本轮启用期（stop 时 abort——只用于取消 watch 初始化，不取消 git 扫描）。 */
  private episode = new AbortController()
  /** R6 拉闸闩：置位后不再打开任何 watch、忽略后续失效回调、不再重复 warn。 */
  private degraded = false
  /** R6 已 warn 过（引擎生命周期内仅一次）。 */
  private warned = false
  /** 已打开的 watch close 函数（引用计数停止时全部关闭）。 */
  private watcherCloses: Array<() => Promise<void>> = []
  /** watch 代际：retarget/关闭/降级递增，陈旧回调与未完成的 open 序列据此自弃。 */
  private watchGeneration = 0
  /** 当前 watch 三目标所属的 repoRoot（随首个 ready 帧解析，变更时重建）。 */
  private watchedRepoRoot: string | null = null
  /** R2 基线：最近一次广播/initial 的帧。 */
  private lastFrame: GitStatusFrame | null = null

  constructor(
    /** 只读 status 引擎（重算真值来源；TTL 缓存由本引擎在每次重算前失效）。 */
    private readonly statusEngine: StatusEngine,
    /** 宿主 fs 能力切片；undefined = 能力缺失 → R6 纯轮询。 */
    private readonly fs: GitFsWatchFace | undefined,
    options: StatusWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.watchEnabled = options.watchEnabled ?? true
    this.logger = options.logger
  }

  // ── 订阅面 ──────────────────────────────────────────────────────────────

  /**
   * 打开一条状态帧流（`followStatus` 流方法的引擎面）。
   * R1：生成器首帧 = 建立订阅时的当前状态（无条件，不经 R2 门）。
   * 清理：外部 signal abort / 消费者 return（断开）→ 引用计数释放，
   * 末个订阅者离开时关闭全部 watch 与定时器。
   */
  follow(external?: AbortSignal): AsyncIterable<GitStatusFrame> {
    const controller = new AbortController()
    const signal = external === undefined
      ? controller.signal
      : AbortSignal.any([external, controller.signal])
    const subscriber: WatchSubscriber = {
      queue: [], wakeup: null, signal, released: false,
      releasePromise: Promise.resolve(),
    }
    const self = this
    async function* frames(): AsyncIterable<GitStatusFrame> {
      self.subscribers.add(subscriber)
      self.acquire()
      const onAbort = (): void => { void self.disconnect(subscriber) }
      signal.addEventListener('abort', onAbort, { once: true })
      // 订阅建立前到达的触发（如上行 refresh 在首个消费者 next() 之前入队）在此补踢。
      if (self.pendingReasons.size > 0) self.kickDrain()
      try {
        const initial = await self.computeInitial()
        yield initial
        while (!signal.aborted) {
          if (subscriber.queue.length === 0) {
            await new Promise<void>((resolveWait) => {
              subscriber.wakeup = resolveWait
              // 唤醒句柄登记与队列复查之间无 await（同步段），广播不会漏唤醒。
              if (subscriber.queue.length > 0 || signal.aborted) {
                subscriber.wakeup = null
                resolveWait()
              }
            })
            subscriber.wakeup = null
            continue
          }
          yield subscriber.queue.shift() as GitStatusFrame
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        await self.disconnect(subscriber)
      }
    }
    return frames()
  }

  /** R5 manual：显式刷新（无条件推帧——内容未变也推，客户端失步后重同步用）。 */
  refresh(): void {
    this.requestSync('manual')
  }

  /**
   * R3 mutation：本插件写操作完成后的失效入口（后续 stage/unstage/commit/push… 模块
   * 接线）。重算受 R2 约束——净效果为零的写（如 stage 后立刻 unstage）不产生帧。
   */
  notifyMutation(): void {
    this.requestSync('mutation')
  }

  /** 观测面：是否已降级纯轮询（R6 / watchEnabled=false / fs 能力缺失）。 */
  get degradedToPolling(): boolean {
    return this.degraded
  }

  /** 观测面：当前打开的 watch 数（引用计数断言用）。 */
  get openWatcherCount(): number {
    return this.watcherCloses.length
  }

  /** 观测面：当前订阅数。 */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  // ── 引用计数 ────────────────────────────────────────────────────────────

  private acquire(): void {
    this.refs += 1
    if (this.refs === 1) this.start()
  }

  private async release(): Promise<void> {
    this.refs -= 1
    if (this.refs === 0) await this.stop()
  }

  /**
   * 订阅断开（幂等）：引用计数按订阅者逐个释放（acquire 每订阅 +1，disconnect 每订阅
   * −1，归零即 stop）——首跑实测踩坑：只在「末个订阅者」释放一次会让计数永不归零、
   * watch 永不关闭。abort 路径（onAbort 的 fire-and-forget）与生成器 finally 竞争时，
   * 后到者 await 同一个收尾 promise——保证调用方（如测试的 pump.stop）能等到 watch
   * close 与定时器清理**全部完成**，不留悬挂句柄（Windows 句柄不释放会让临时目录
   * 删除 EBUSY）。
   */
  private disconnect(subscriber: WatchSubscriber): Promise<void> {
    if (subscriber.released) return subscriber.releasePromise
    subscriber.released = true
    this.subscribers.delete(subscriber)
    const wakeup = subscriber.wakeup
    subscriber.wakeup = null
    subscriber.releasePromise = (async () => {
      await this.release()
    })()
    wakeup?.()
    return subscriber.releasePromise
  }

  /** 启用期开启：轮询定时器 + 复位基线；watch 三目标等首个 ready 帧给出 repoRoot。 */
  private start(): void {
    this.episode = new AbortController()
    this.running = true
    this.lastFrame = null
    this.watchedRepoRoot = null
    this.pendingReasons.clear()
    const timer = setInterval(() => { this.requestSync('poll') }, this.pollIntervalMs)
    timer.unref()
    this.pollTimer = timer
    if (!this.watchEnabled) {
      // 配置关闭：纯轮询是显式意图，不算故障（info 级，不触发 R6 warn）。
      this.degraded = true
      this.logger?.info('git watcher: watchEnabled=false — poll-only')
      return
    }
    if (this.fs === undefined) {
      this.degradeToPolling('fs capability unavailable on this host context')
    }
  }

  /** 启用期关闭：定时器/防抖/未决触发/基线全部复位，watch 全关。 */
  private async stop(): Promise<void> {
    this.running = false
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingReasons.clear()
    this.episode.abort()
    await this.closeWatchers()
    this.lastFrame = null
    this.watchedRepoRoot = null
  }

  // ── 帧计算与广播（单飞管线） ────────────────────────────────────────────

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** R1 的每个订阅初始帧：串行进管线，无条件交付，并充当 R2 的首个基线（若尚无）。 */
  private computeInitial(): Promise<GitStatusFrame> {
    return this.serialize(async () => {
      const frame = await this.buildFrame('initial')
      if (this.lastFrame === null) this.lastFrame = frame
      return frame
    })
  }

  private requestSync(reason: GitStatusFrameReason): void {
    if (this.subscribers.size === 0) return
    this.pendingReasons.add(reason)
    this.kickDrain()
  }

  /** 单飞重算：管线空闲才进，pending 里的触发在循环内全部消化（防抖后的合并点）。 */
  private kickDrain(): void {
    if (this.draining) return
    this.draining = true
    void this.serialize(async () => {
      try {
        while (this.pendingReasons.size > 0) {
          const reason = pickReason(this.pendingReasons)
          const frame = await this.buildFrame(reason)
          // R2 变化才推：manual 是唯一旁路（R5 语义）。
          if (reason !== 'manual' && this.lastFrame !== null
            && frameSignature(frame) === frameSignature(this.lastFrame)) {
            continue
          }
          this.broadcast(frame)
        }
      } finally {
        this.draining = false
      }
      // finally 与本检查之间触发的新原因由本行兜底（否则要等下一次外部触发）。
      if (this.pendingReasons.size > 0) this.kickDrain()
    })
  }

  /** 广播：更新 R2 基线并投递给全部订阅者（唤醒挂起的生成器）。 */
  private broadcast(frame: GitStatusFrame): void {
    this.lastFrame = frame
    for (const subscriber of [...this.subscribers]) {
      subscriber.queue.push(frame)
      const wakeup = subscriber.wakeup
      if (wakeup !== null) {
        subscriber.wakeup = null
        wakeup()
      }
    }
  }

  /** 一次重算：失效 status 缓存 → 扫描 → 帧；就绪帧顺带驱动三目标 retarget。 */
  private async buildFrame(reason: GitStatusFrameReason): Promise<GitStatusFrame> {
    this.statusEngine.invalidate()
    let state: StatusState
    try {
      state = await this.statusEngine.current()
    } catch (cause) {
      // 工作区解析不出（git/session-workspace-unresolved）等：错误帧，流不断开。
      return { kind: 'error', reason, error: frameErrorOf(cause) }
    }
    if (state.availability !== 'ready') {
      const error = state.error
      return { kind: 'error', reason, error: { code: error.code, message: error.message } }
    }
    const snapshot = state.snapshot
    this.retargetWatchersIfNeeded(snapshot.repoRoot)
    return { kind: 'status', reason, snapshot }
  }

  // ── 三目标 watch（R6 降级在此实现） ─────────────────────────────────────

  private retargetWatchersIfNeeded(repoRoot: string): void {
    if (this.watchedRepoRoot === repoRoot) return
    this.watchedRepoRoot = repoRoot
    if (!this.running || this.degraded || this.fs === undefined) return
    void this.openWatchers(repoRoot)
  }

  /**
   * 三目标：`<repoRoot>/.git/index`（staging 区写：add/commit/stage/reset），
   * `<repoRoot>/.git/HEAD`（切分支/detach），`<repoRoot>`（目录 depth:0，顶层直接子项）。
   * .git 内部超出 depth 0 不产生根目标事件（fs-local 实读，map §4.2）——根目标对
   * .git 的持续变动天然免疫；单目标 resolve 失败（如 unborn 仓库尚无 index）只跳过
   * 该目标交轮询兜底，**不构成 R6**；watch 本体拒绝/抛错/回调报错 → R6 全局降级。
   */
  private async openWatchers(repoRoot: string): Promise<void> {
    const fs = this.fs
    if (fs === undefined) return
    // 先关旧代际（closeWatchers 递增代际使其回调全部失效），再领取本轮代际——
    // 否则本轮代际会被自己的 closeWatchers 立即作废（首跑实测踩坑：三目标永不打开）。
    await this.closeWatchers()
    const generation = ++this.watchGeneration
    if (!this.running || generation !== this.watchGeneration) return
    const targets: ReadonlyArray<{ path: string; label: string }> = [
      { path: join(repoRoot, '.git', 'index'), label: '.git/index' },
      { path: join(repoRoot, '.git', 'HEAD'), label: '.git/HEAD' },
      { path: repoRoot, label: 'repoRoot' },
    ]
    for (const target of targets) {
      if (!this.running || generation !== this.watchGeneration) return
      let resolved: unknown
      try {
        resolved = await fs.resolve(target.path, { signal: this.episode.signal })
      } catch (cause) {
        this.logger?.debug(
          `git watcher: target unavailable (${target.label}): ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        continue
      }
      try {
        const close = await fs.watch(resolved, (error) => {
          if (generation !== this.watchGeneration || !this.running) return
          if (error !== undefined) {
            this.degradeToPolling(`watcher error on ${target.label}: ${error.message}`)
            return
          }
          if (this.degraded) return
          this.scheduleDebounce()
        }, this.episode.signal)
        if (generation !== this.watchGeneration || !this.running) {
          await close()
          return
        }
        this.watcherCloses.push(close)
      } catch (cause) {
        if (!this.running || this.episode.signal.aborted) return
        // R6：watch 能力拒绝（基类默认实现/ssh 世界）或初始化失败 → warn 一次转纯轮询。
        this.degradeToPolling(`watch rejected for ${target.label}: ${
          cause instanceof Error ? cause.message : String(cause)}`)
        return
      }
    }
  }

  /** ZCode 防抖窗（fileWatcherService.ts:78-92 结构）：窗内连发只触发一次重算。 */
  private scheduleDebounce(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.requestSync('change')
    }, this.debounceMs)
  }

  /** R6：拉闸（warn 仅一次）——关全部 watch；后续失效回调被回调侧的 degraded 闸忽略。 */
  private degradeToPolling(reason: string): void {
    void this.closeWatchers()
    if (this.degraded) return
    this.degraded = true
    if (!this.warned) {
      this.warned = true
      this.logger?.warn(`git watcher degraded to poll-only (R6, warn-once): ${reason}`)
    }
  }

  private async closeWatchers(): Promise<void> {
    this.watchGeneration += 1
    const closes = this.watcherCloses
    this.watcherCloses = []
    await Promise.allSettled(closes.map(close => close()))
  }
}
