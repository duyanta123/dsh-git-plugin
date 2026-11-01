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
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * dsh-gitkit — status 编排引擎（spec §1.1 [清单 1/5/6/24/64/65] + §2.3 host 侧刷新）。
 *
 * 职责：工作区解析 → 仓库发现 → `status --porcelain=v2 …-z` 与两路 numstat 并发 →
 * 解析合并为 GitStatusSnapshot。快照缓存 TTL < 2s（任务口径；§2.3 的 150ms 防抖与
 * 60s 轮询由 watcher 模块驱动本引擎 invalidate，本文件只管缓存语义），进行中的扫描
 * 去重共享同一 Promise（ZCode statusRequests 语义）。
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
   * @param options.fresh true = 绕过 TTL 缓存命中强制重扫（写守卫前的最新世界读取——
   *   discard/commit 路由要用此刻的世界，不允许 1.5s 旧照；进行中去重与缓存回填照常）。
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
    const pending = this.inFlight.get(resolution.root)
    if (pending !== undefined) return pending
    const promise = this.scan(resolution.root, signal).then(
      (state) => {
        this.inFlight.delete(resolution.root)
        // 三态都是稳定事实（瞬时域错误在 scan 内抛出、到不了这里），统一进 TTL 缓存。
        this.cache = { workspace: resolution.root, at: Date.now(), state }
        return state
      },
      (cause: unknown) => {
        this.inFlight.delete(resolution.root)
        throw cause
      },
    )
    this.inFlight.set(resolution.root, promise)
    return promise
  }

  /** 写后失效（spec §1.9 失效列）/ watcher 防抖回调入口。 */
  invalidate(): void {
    this.cache = null
  }

  /** 测试/诊断视图：缓存当前是否就绪（不触发扫描）。 */
  get cached(): boolean {
    return this.cache !== null
  }

  /** 一次完整扫描：仓库发现 → status + numstat 双路并发 → 解析装配。 */
  private async scan(workspaceRoot: string, signal?: AbortSignal): Promise<StatusState> {
    // 仓库发现：exit 128 + "not a git repository" → null 范式（forge git.ts:99-103）。
    let probe: GitRunResult
    try {
      probe = await this.git.run(['rev-parse', '--show-toplevel'], {
        cwd: workspaceRoot,
        op: 'status(rev-parse --show-toplevel)',
        signal: signal ?? neverAborted(),
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
      this.git.run(statusArgs, { cwd: repoRoot, op: 'status', signal: signal ?? neverAborted() }),
      this.git.run(['diff', '--cached', '--numstat', '-z', '--find-renames', '--'], {
        cwd: repoRoot, op: 'status(diff --cached --numstat)', signal: signal ?? neverAborted(),
      }),
      this.git.run(['diff', '--numstat', '-z', '--find-renames', '--'], {
        cwd: repoRoot, op: 'status(diff --numstat)', signal: signal ?? neverAborted(),
      }),
    ])

    // porcelain v2 不被本机 git 支持时回落 v1 解析器（Cline 范本段；spec §5.1 登记行）。
    let parsed: ParsedStatus
    if (
      (statusResult.exitCode === 129 || statusResult.exitCode === 128)
      && /porcelain/i.test(statusResult.stderr)
    ) {
      const v1 = await this.git.run(['status', '--porcelain', '--branch', '--untracked-files=all', '-z'], {
        cwd: repoRoot, op: 'status(v1 fallback)', signal: signal ?? neverAborted(),
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

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
