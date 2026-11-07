/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/repo/gitCliRepo.ts（getStatus 编排 :857-892 ——
 *         status + 并发 numstat 双路 Promise.all + 命令成功断言；in-flight 去重
 *         reuseInFlightRequest :571-593；输出上限下的大仓库 untracked 折叠 :544-569——
 *         v1 采纳其「截断必须显式处理」的立场，折叠降级未采纳，见 openIssues）
 * Ported from deepseek-ai/deepseek-harness (dsh 树)
 *   path: packages/experimental/client-ui-forge/src/git.ts:99-103（repo 发现的
 *         "exit 128 + not a git repository → null" 范式；locateGitWorkspace 本体按
 *         map §4.1 禁用——快照专用 env 不用于 status）
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 *           （repo 发现范式段 MIT — Copyright (c) DeepSeek，dsh 源码树许可）
 * Modifications: 2026-10-31（⑤ status 引擎模块）—— child_process/commandProvider →
 *   GitRunner（只读实例）；缓存与三态为本模块设计（workflow 任务口径：编排 + 并发
 *   numstat 双路 + <2s 缓存 + unavailable/not-repository/ready）；v1 porcelain 回退段
 *   来自 cline（见 status-parser.ts）；域错误改 RemoteError（spec §1.0.5）。
 *   2026-11-07（竞态修复 P2-1/P2-2）—— P2-1：共享扫描改引擎自有 AbortController
 *   （不链接任何调用方 signal——一方 abort 不得连坐其余调用方），调用方取消改在调用方
 *   私有等待层落地（只拒自己的返回 Promise）；P2-2：invalidate() 递增失效纪元并清空
 *   在飞去重表（写后 fresh 读取不得去重到写前在飞扫描），在飞扫描完成按身份判等删
 *   条目、按纪元判等回填缓存（写前迟到完成不得污染写后缓存）。
 *   2026-11-07（评审追加）—— fresh 守卫读取不再参与在飞去重：封住「并发写已落盘而
 *   其 afterWrite()→invalidate() 尚未执行」窗口内 fresh 去重到写前在飞扫描的既有竞态
 *   （清表只封住 invalidate 之后那半边）；并显式登记 P2-1 的取舍——调用方 abort 不再
 *   终止在飞扫描的 git 子进程，由 GitRunner fastTimeoutMs 封顶。
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * dsh-gitkit — status 编排引擎（spec §1.1 [清单 1/5/6/24/64/65] + §2.3 host 侧刷新）。
 *
 * 职责：工作区解析 → 仓库发现 → `status --porcelain=v2 …-z` 与两路 numstat 并发 →
 * 解析合并为 GitStatusSnapshot。快照缓存 TTL < 2s（任务口径；§2.3 的 150ms 防抖与
 * 60s 轮询由 watcher 模块驱动本引擎 invalidate，本文件只管缓存语义）。进行中的扫描
 * 去重共享同一 Promise（ZCode statusRequests 语义），但共享扫描归引擎自有——内部
 * AbortController，不链接任何调用方 signal：一方 abort 只拒绝自己的返回 Promise，
 * 不连坐其余调用方；invalidate() 同时清空在飞去重表并递增失效纪元，写后的 fresh
 * 读取永不落回写前在飞扫描，写前扫描的迟到完成也不得把写前世界回填进缓存；fresh
 * 守卫读取更进一步不参与在飞去重——「写已落盘而 invalidate 未及执行」的窗口内同样
 * 不得共享到写前在飞扫描（去重只对普通读取保留）。
 *
 * 三态（workflow 任务口径）：
 *   - unavailable —— git 可执行文件解析失败（RemoteError op='resolve-git'）；
 *   - not-repository —— 工作区不是 git 仓库（git/no-repository，details.probed = 工作区）；
 *   - ready —— 快照就绪。
 * unavailable/not-repository 属稳定事实，同样进 TTL 缓存；瞬时失败（git-error/timeout）
 * 不缓存，调用方下次调用即重试。
 */

import { resolve } from 'node:path'
import type { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertGitOk, gitError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { GitRunResult } from './git-runner.ts'
import { assembleStatus, numstatCounts, parseNumstat, parsePorcelainV1, parsePorcelainV2 } from './status-parser.ts'
import type { ParsedStatus } from './status-parser.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { GitStatusSnapshot } from './types.ts'

/** 快照缓存 TTL：任务口径 <2s（§2.3 client 轮询 3s 一档之下）。 */
export const STATUS_CACHE_TTL_MS = 1_500

/** status 的三态。 */
export type StatusAvailability = 'unavailable' | 'not-repository' | 'ready'

export type StatusState =
  | { availability: 'unavailable'; snapshot: null; error: RemoteError }
  | { availability: 'not-repository'; snapshot: null; error: RemoteError }
  | { availability: 'ready'; snapshot: GitStatusSnapshot; error: null }

export interface StatusEngineOptions {
  /** 快照缓存 TTL 毫秒；0 = 每次重扫（测试用）。 */
  cacheTtlMs?: number
}

export class StatusEngine {
  private readonly cacheTtlMs: number
  private cache: { workspace: string; at: number; state: StatusState } | null = null
  /** 失效纪元：invalidate() 单调递增；在飞扫描完成时只有纪元仍当前才允许回填 TTL 缓存。 */
  private epoch = 0
  private readonly inFlight = new Map<string, Promise<StatusState>>()

  constructor(
    /** 只读实例（READONLY_PREFIX + fastTimeoutMs，spec §1.9 status 行）。 */
    private readonly git: GitRunner,
    private readonly workspace: WorkspaceResolver,
    options: StatusEngineOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? STATUS_CACHE_TTL_MS
  }

  /**
   * 当前状态（缓存命中不重扫；同工作区进行中的扫描共享同一 Promise）。
   * @param signal 调用方取消信号：只取消调用方自己的等待（返回 Promise 以普通 Error
   *   拒绝，gateway 侧按取消折叠——git-runner 同款契约），不取消共享扫描——共享扫描
   *   归引擎自有（见 scan），其余调用方与缓存回填不受任何一方 abort 影响（P2-1）。
   * @param options.fresh true = 绕过 TTL 缓存命中强制重扫（写守卫前的最新世界读取——
   *   discard/commit 路由要用此刻的世界，不允许 1.5s 旧照），且不参与在飞去重：并发写
   *   已落盘而其 afterWrite()→invalidate() 尚未执行时，去重会共享到写前在飞扫描、以
   *   写前世界做写守卫路由（评审追加封堵）；在飞登记与缓存回填照常（纪元守卫兜底）。
   * @throws git/session-workspace-unresolved（工作区本身解析不出——三态之外的输入前提）。
   */
  async current(signal?: AbortSignal, options?: { fresh?: boolean }): Promise<StatusState> {
    const resolution = await this.workspace.resolve()
    const now = Date.now()
    if (
      options?.fresh !== true
      && this.cache !== null
      && this.cache.workspace === resolution.root
      && now - this.cache.at < this.cacheTtlMs
    ) {
      return this.cache.state
    }
    // fresh 守卫读取（mutations/remote-ops 的 scanFresh）不参与在飞去重：去重共享的是
    // 「已在飞」的扫描，而它可能起于并发写落盘之前、且该写的 afterWrite()→invalidate()
    // 尚未执行（index.ts 写方法尾部 logWrite/结果装配的 await 间隙）——共享它就会以
    // 写前世界做写守卫路由。fresh 一律自扫：看到自己扫描开始时的世界（≥ 一切已落盘的
    // 写）；代价是并发 fresh 各扫一次（只读命令，无正确性影响）。在飞登记照常（后续
    // 普通读取仍可共享 fresh 扫描——普通读取的时新性由 TTL + invalidate 契约约束），
    // 缓存回填照常（纪元守卫防写前迟到完成污染）。
    const pending = options?.fresh === true ? undefined : this.inFlight.get(resolution.root)
    if (pending !== undefined) return this.own(pending, signal)
    const startedEpoch = this.epoch
    const promise = this.scan(resolution.root).then(
      (state) => {
        // 身份判等删除：invalidate 已清空在飞表后，写前扫描的迟到完成不得误删
        // 新一轮扫描的条目（否则并发调用方会漏上去重、重复扫描）。
        if (this.inFlight.get(resolution.root) === promise) this.inFlight.delete(resolution.root)
        // 纪元判等回填：invalidate 之后的完成若属写前扫描（纪元已旧），不得把
        // 写前世界写回 TTL 缓存（P2-2：写后读取看到的必须是写后世界）。
        if (startedEpoch === this.epoch) {
          // 三态都是稳定事实（瞬时域错误在 scan 内抛出、到不了这里），统一进 TTL 缓存。
          this.cache = { workspace: resolution.root, at: Date.now(), state }
        }
        return state
      },
      (cause: unknown) => {
        if (this.inFlight.get(resolution.root) === promise) this.inFlight.delete(resolution.root)
        throw cause
      },
    )
    this.inFlight.set(resolution.root, promise)
    return this.own(promise, signal)
  }

  /**
   * 写后失效（spec §1.9 失效列）/ watcher 防抖回调入口。
   *
   * 除 TTL 缓存外同时：清空在飞去重表（写后的 fresh 读取——mutations/remote-ops 的
   * scanFresh 守卫——不得去重到写前在飞扫描）并递增失效纪元（写前扫描的迟到完成
   * 不得把写前世界回填进缓存）。刻意不中止在飞扫描：中止会把非域码的 abort 拒绝
   * 泼给未取消的写前读者（P2-1 的串扰病理换门重现）；写前读者按其读取起点线性化。
   */
  invalidate(): void {
    this.cache = null
    this.epoch += 1
    this.inFlight.clear()
  }

  /** 测试/诊断视图：缓存当前是否就绪（不触发扫描）。 */
  get cached(): boolean {
    return this.cache !== null
  }

  /**
   * 调用方私有等待（P2-1）：共享扫描 Promise 不链接任何调用方 signal；signal 的 abort
   * 只拒绝本次调用自己的返回 Promise（普通 Error，gateway 侧按取消折叠），共享扫描
   * 照常完成、照常服务其余调用方与缓存回填。无 signal 的调用方（watcher 重算）直接
   * 共享原 Promise，零开销。
   */
  private own(promise: Promise<StatusState>, signal?: AbortSignal): Promise<StatusState> {
    if (signal === undefined) return promise
    return new Promise<StatusState>((resolveOwn, rejectOwn) => {
      const onAbort = (): void => { rejectOwn(new Error('git status was aborted (caller signal)')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      // 无条件挂接结局 handler：即便本调用方已被 abort 先行拒绝，共享 Promise 的最终
      // 结局也有订阅者，不产生 unhandledRejection（对已定 Promise rejectOwn 是 no-op）。
      promise.then(
        (state) => { signal.removeEventListener('abort', onAbort); resolveOwn(state) },
        (cause: unknown) => { signal.removeEventListener('abort', onAbort); rejectOwn(cause) },
      )
    })
  }

  /**
   * 一次完整扫描：仓库发现 → status + numstat 双路并发 → 解析装配。
   *
   * 共享扫描归引擎自有（P2-1）：全程使用本扫描私有的内部 AbortController signal，
   * 不链接任何调用方 signal——调用方 abort 由 {@link StatusEngine.current} 的调用方
   * 私有等待层（own）落地，不会取消共享扫描，也不会以非域码错误连坐其余调用方；
   * 在飞扫描的 git 子进程因此不随任何调用方 abort 终止，由 GitRunner fastTimeoutMs
   * 封顶（刻意取舍：引擎级取消会以非域码错误连坐其余调用方）。
   */
  private async scan(workspaceRoot: string): Promise<StatusState> {
    const engineSignal = neverAborted()
    // 仓库发现：exit 128 + "not a git repository" → null 范式（forge git.ts:99-103）。
    let probe: GitRunResult
    try {
      probe = await this.git.run(['rev-parse', '--show-toplevel'], {
        cwd: workspaceRoot,
        op: 'status(rev-parse --show-toplevel)',
        signal: engineSignal,
      })
    } catch (cause) {
      if (isResolveGitError(cause)) {
        return { availability: 'unavailable', snapshot: null, error: cause }
      }
      throw cause
    }
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      return {
        availability: 'not-repository',
        snapshot: null,
        error: gitError('git/no-repository', `not a git repository: ${workspaceRoot}`, { probed: workspaceRoot }),
      }
    }
    assertGitOk(probe, 'status(rev-parse --show-toplevel)')
    const repoRoot = resolve(workspaceRoot, probe.stdout.trim())

    // 并发 numstat 双路（ZCode gitCliRepo.ts:871-892）：status 本体 + staged + worktree。
    const statusArgs = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']
    const [statusResult, stagedResult, unstagedResult] = await Promise.all([
      this.git.run(statusArgs, { cwd: repoRoot, op: 'status', signal: engineSignal }),
      this.git.run(['diff', '--cached', '--numstat', '-z', '--find-renames', '--'], {
        cwd: repoRoot, op: 'status(diff --cached --numstat)', signal: engineSignal,
      }),
      this.git.run(['diff', '--numstat', '-z', '--find-renames', '--'], {
        cwd: repoRoot, op: 'status(diff --numstat)', signal: engineSignal,
      }),
    ])

    // porcelain v2 不被本机 git 支持时回落 v1 解析器（Cline 范本段；spec §5.1 登记行）。
    let parsed: ParsedStatus
    if (
      (statusResult.exitCode === 129 || statusResult.exitCode === 128)
      && /porcelain/i.test(statusResult.stderr)
    ) {
      const v1 = await this.git.run(['status', '--porcelain', '--branch', '--untracked-files=all', '-z'], {
        cwd: repoRoot, op: 'status(v1 fallback)', signal: engineSignal,
      })
      assertGitOk(v1, 'status(v1 fallback)')
      parsed = parsePorcelainV1(v1.stdout)
    } else {
      assertGitOk(statusResult, 'status')
      parsed = parsePorcelainV2(statusResult.stdout)
    }
    assertGitOk(stagedResult, 'status(diff --cached --numstat)')
    assertGitOk(unstagedResult, 'status(diff --numstat)')

    const snapshot = assembleStatus({
      repoRoot,
      generatedAt: new Date().toISOString(),
      parsed,
      stagedStats: numstatCounts(parseNumstat(stagedResult.stdout)),
      unstagedStats: numstatCounts(parseNumstat(unstagedResult.stdout)),
    })
    return { availability: 'ready', snapshot, error: null }
  }
}

/** resolve-git 失败（git 不可用）→ 三态的 unavailable；logger 可选注入。 */
export function isResolveGitError(cause: unknown): cause is RemoteError & { details: { op: string } } {
  if (typeof cause !== 'object' || cause === null) return false
  const code = (cause as { code?: unknown }).code
  const details = (cause as { details?: { op?: unknown } }).details
  return code === 'git/git-error' && details?.op === 'resolve-git'
}

/** 引擎自有 signal：每次扫描一个内部 AbortController，永不触发（引擎层无取消源；调用方取消不进引擎）。 */
function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
