/*!
 * 对照（C 级，PORTING.md 登记，无代码搬运）：zai-org/ZCode
 *   packages/services/src/git/repo/gitCliRepo.ts:1421-1486（stage/unstage/discard 的
 *   命令形态：`add -- <paths>` / `restore --staged -- <paths>` / tracked
 *   `restore --worktree -- <paths>` + 去重入参 + 写后 invalidate）与
 *   packages/services/src/git/gitService.ts:242-253（服务编排转发）。
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-31（⑤ mutations 引擎模块）—— 命令形态语义对照自研实现：
 *   字面路径（git 全局位 --literal-pathspecs + `--` 分隔，GIT_LITERAL_PATHSPECS=1 双保险）、
 *   空数组 git/no-paths（任务口径，ZCode 是静默 no-op）、unstage 的 unborn →
 *   `git rm --cached` 与极老 git → `git reset HEAD` 双兜底（spec §1.3【报告】:262）、
 *   discard 三重守卫（acknowledged / baseRevision 乐观并发 / 最新 status 逐路径路由，
 *   任务口径，ZCode 无守卫）、写失效经 StatusEngine fresh 扫描 + watcher R3。
 * SPDX-License-Identifier: MIT
 */

/**
 * @dsh-plugin/git — 写操作引擎（spec §1.3 [清单 9/12]；权限 stage/unstage B、discard C）。
 *
 * 命令一律走 write runner 实例（WRITE_PREFIX：仅 safe.bareRepository——无
 * --no-optional-locks / hooksPath 禁用，保留正常锁；spec §1.0.7），超时 fastTimeoutMs
 * （spec §1.3 超时档）。路径参数的安全性由两层承载：
 *   1. git **全局位**旗标 `--literal-pathspecs`（实测：子命令位 `git add --literal-pathspecs`
 *      非法 exit 129——diff.ts 文件头实测修订 1 同源结论）；
 *   2. runner 环境变量 GIT_LITERAL_PATHSPECS=1（git-runner.ts GIT_ENV，等价语义双保险）；
 *   并一律以 `--` 分隔路径与选项（含 `-`/`--` 开头路径的防注入面）。
 *
 * discard 三重守卫（workflow 任务口径；全过才执行任何命令）：
 *   1. acknowledged=false ⇒ `git/bad-request`（reason 'unacknowledged'）；
 *   2. baseRevision 与最新 status 的 branch.oid 不一致 ⇒ 'stale-base-revision'（乐观并发）；
 *   3. 逐路径按**最新 status**（fresh 扫描，绕 TTL 缓存）路由：untracked → `git clean -fd`、
 *      有 worktree 侧变更 → `git restore --worktree`；仅暂存条目 / 冲突文件 / 未知路径 ⇒
 *      'not-discardable' **整请求拒绝**（spec §1.3 的 unmerged 路径 restore 非零退出
 *      git-error 升级为前置拒绝——错误可读、零副作用）。
 */

import { assertGitOk, gitError } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { GitRunner, GitRunResult } from './git-runner.ts'
import type { StatusEngine } from './status.ts'
import type { GitStatusSnapshot, DiscardOptions, DiscardResult, StageResult, UnstageResult } from './types.ts'

/** git 全局位字面路径旗标（runner 环境变量 GIT_LITERAL_PATHSPECS=1 的命令行双保险）。 */
const LITERAL_PATHSPECS = ['--literal-pathspecs'] as const

/**
 * 极老 git 的 restore 缺失特征（本机 git 2.55 无从实测旧版；特征按 usage 语义定义）：
 *   - exit 129 = usage 错误（`restore` 不认识传入选项，usage 转储到 stderr）；
 *   - "git: 'restore' is not a git command"（pre-2.23 无 restore 子命令，exit 1）；
 *   - "unknown switch/option"（--staged 之类选项不存在的另一措辞）。
 * 注意排除 exit 1 + "did not match any file(s) known to git"（本机实测的 pathspec
 * 未命中，属正常失败非能力缺失）。
 */
const OLD_GIT_RESTORE_RE = /is not a git command|unknown switch|unknown option/i

/** mutations 引擎构造项。 */
export interface MutationEngineOptions {
  /** 可选 logger（info 写日志由服务面打；引擎内留作守卫诊断扩展位）。 */
  logger?: GitLoggerFace
}

export class MutationEngine {
  private readonly logger: GitLoggerFace | undefined

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs，spec §1.9 stage/unstage/discard 行）。 */
    private readonly git: GitRunner,
    /** 最新世界读取（discard 路由与 unstage 的 unborn 选路；fresh 扫描，含 repoRoot）。 */
    private readonly status: StatusEngine,
    options: MutationEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  /**
   * stage（spec §1.3）：`git --literal-pathspecs add -- <paths>`；untracked 路径也走 add。
   * 空数组 ⇒ `git/no-paths`（任务口径；spec §1.3 的 `paths=[] ⇒ git add -A` 语义按任务
   * 口径收敛为拒绝——见 ModuleResult.openIssues）。
   * @returns 去重后的路径数（命令一次处理全部，全成 ⇒ 该数；部分不成 ⇒ 整命令非零失败）。
   * @throws git/no-paths、git/session-workspace-unresolved、git/no-repository（经
   *   fresh 扫描顺带发现）、git/git-error、git/timeout。
   */
  async stage(paths: readonly string[], signal?: AbortSignal): Promise<StageResult> {
    const unique = dedupe(paths)
    if (unique.length === 0) throw noPaths('stage')
    const { repoRoot } = await this.scanFresh('stage', signal)
    const result = await this.git.run(
      [...LITERAL_PATHSPECS, 'add', '--', ...unique],
      { cwd: repoRoot, op: 'stage(git add)', signal: active(signal) },
    )
    assertGitOk(result, 'stage(git add)')
    return { staged: unique.length }
  }

  /**
   * unstage（spec §1.3）：`git restore --staged -- <paths>`；unborn 分支回落
   * `git rm --cached -- <paths>`（无 HEAD 可 reset，[清单 64]）；极老 git（无 restore）
   * 回落 `git reset HEAD -- <paths>`。不在暂存视图内的路径按 no-op 跳过（幂等：
   * 本机实测 restore --staged 对未知路径 exit 1 "did not match"，重击不报错）。
   * @returns 实际参与命令的去重路径数。
   * @throws git/no-paths、git/session-workspace-unresolved、git/no-repository、
   *   git/git-error、git/timeout。
   */
  async unstage(paths: readonly string[], signal?: AbortSignal): Promise<UnstageResult> {
    const unique = dedupe(paths)
    if (unique.length === 0) throw noPaths('unstage')
    const { repoRoot, snapshot } = await this.scanFresh('unstage', signal)
    const stagedPaths = new Set(snapshot.staged.map(change => change.path))
    const target = unique.filter(path => stagedPaths.has(path))
    if (target.length === 0) return { unstaged: 0 }

    if (snapshot.branch.unborn) {
      // 无提交仓库：restore --staged / reset HEAD 都需要 HEAD ⇒ rm --cached 兜底（spec §1.3）。
      const removed = await this.git.run(
        [...LITERAL_PATHSPECS, 'rm', '--cached', '--', ...target],
        { cwd: repoRoot, op: 'unstage(git rm --cached, unborn)', signal: active(signal) },
      )
      assertGitOk(removed, 'unstage(git rm --cached, unborn)')
      return { unstaged: target.length }
    }

    const restored = await this.git.run(
      [...LITERAL_PATHSPECS, 'restore', '--staged', '--', ...target],
      { cwd: repoRoot, op: 'unstage(git restore --staged)', signal: active(signal) },
    )
    if (isOldGitRestore(restored)) {
      // 极老 git 兜底：restore 缺失 ⇒ reset HEAD（mix reset，仅回退 index）。
      this.logger?.debug('git unstage: restore unavailable, falling back to git reset HEAD')
      const reset = await this.git.run(
        [...LITERAL_PATHSPECS, 'reset', 'HEAD', '--', ...target],
        { cwd: repoRoot, op: 'unstage(git reset HEAD fallback)', signal: active(signal) },
      )
      assertGitOk(reset, 'unstage(git reset HEAD fallback)')
      return { unstaged: target.length }
    }
    assertGitOk(restored, 'unstage(git restore --staged)')
    return { unstaged: target.length }
  }

  /**
   * discard（spec §1.3 + 任务口径三重守卫）：tracked ⇒ `git restore --worktree -- <paths>`、
   * untracked ⇒ `git clean -fd -- <paths>`（混合列表拆两批，先 restore 后 clean——
   * 不可逆删除只在实际回退成功后发生）。任一守卫失败 ⇒ `git/bad-request`，零命令执行。
   * @returns restore 批 + clean 批的去重路径合计。
   * @throws git/no-paths、git/bad-request（三守卫）、git/session-workspace-unresolved、
   *   git/no-repository、git/git-error、git/timeout。
   */
  async discard(options: DiscardOptions, signal?: AbortSignal): Promise<DiscardResult> {
    const unique = dedupe(options.paths)
    if (unique.length === 0) throw noPaths('discard')

    // 守卫 1：C 级二次确认旗标（[清单 12]；spec §1.0.4 权限 C）。
    if (options.acknowledged !== true) {
      throw badRequest('unacknowledged', [], null, null,
        'discard requires acknowledged=true (destructive confirmation gate)')
    }

    // 守卫 2+3 的世界读取：fresh 扫描（绕 TTL 缓存——路由要此刻的世界）。
    const { repoRoot, snapshot } = await this.scanFresh('discard', signal)

    // 守卫 2：baseRevision 乐观并发（客户端视角的 HEAD 未变才许执行）。
    if (options.baseRevision !== null && options.baseRevision !== snapshot.branch.oid) {
      throw badRequest('stale-base-revision', [], options.baseRevision, snapshot.branch.oid,
        `stale base revision: request was made against ${options.baseRevision}, HEAD is now ${snapshot.branch.oid ?? '(unborn)'}`)
    }

    // 守卫 3：逐路径路由（conflicted 优先——UU/DU 等同时落在 staged/unstaged 视图，
    // 必须先于 worktree 侧判定拦截，否则会被 restore 命中并以 git-error 失败）。
    const conflicted = new Set(snapshot.conflicted.map(change => change.path))
    const untracked = new Set(snapshot.untracked.map(change => change.path))
    const worktreeChanged = new Set(snapshot.unstaged.map(change => change.path))
    const restorePaths: string[] = []
    const cleanPaths: string[] = []
    const rejected: string[] = []
    for (const path of unique) {
      if (conflicted.has(path)) rejected.push(path)
      else if (untracked.has(path)) cleanPaths.push(path)
      else if (worktreeChanged.has(path)) restorePaths.push(path)
      else rejected.push(path) // 仅暂存条目（Y='.'）或 clean/未知路径：本操作不处置
    }
    if (rejected.length > 0) {
      throw badRequest('not-discardable', rejected, null, null,
        `discard routed no command for ${rejected.length} path(s): staged-only, conflicted, or unknown to git`)
    }

    let discarded = 0
    if (restorePaths.length > 0) {
      const result = await this.git.run(
        [...LITERAL_PATHSPECS, 'restore', '--worktree', '--', ...restorePaths],
        { cwd: repoRoot, op: 'discard(git restore --worktree)', signal: active(signal) },
      )
      assertGitOk(result, 'discard(git restore --worktree)')
      discarded += restorePaths.length
    }
    if (cleanPaths.length > 0) {
      const result = await this.git.run(
        [...LITERAL_PATHSPECS, 'clean', '-fd', '--', ...cleanPaths],
        { cwd: repoRoot, op: 'discard(git clean -fd)', signal: active(signal) },
      )
      assertGitOk(result, 'discard(git clean -fd)')
      discarded += cleanPaths.length
    }
    return { discarded }
  }

  /** fresh status 扫描（守卫世界读取 + repoRoot；三态的 error 就地抛出）。 */
  private async scanFresh(
    op: string,
    signal?: AbortSignal,
  ): Promise<{ repoRoot: string; snapshot: GitStatusSnapshot }> {
    const state = await this.status.current(signal, { fresh: true })
    if (state.error !== null) throw state.error
    this.logger?.debug(`git ${op}: fresh status scan (repoRoot resolved)`)
    return { repoRoot: state.snapshot.repoRoot, snapshot: state.snapshot }
  }
}

/** 一次 git 失败是否为「restore 能力缺失」（极老 git 兜底触发条件）。 */
export function isOldGitRestore(result: GitRunResult): boolean {
  if (result.exitCode === 129) return true
  return OLD_GIT_RESTORE_RE.test(result.stderr)
}

/** 去重保序（ZCode 对照语义：Set 去重、原顺序进命令）。 */
function dedupe(paths: readonly string[]): string[] {
  return Array.from(new Set(paths))
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}

function noPaths(op: string): never {
  throw gitError('git/no-paths', `git ${op}: no paths given (refusing whole-repo side effects)`, { op })
}

function badRequest(
  reason: 'unacknowledged' | 'stale-base-revision' | 'not-discardable',
  paths: readonly string[],
  expected: string | null,
  actual: string | null,
  message: string,
): never {
  throw gitError('git/bad-request', message, { reason, paths: [...paths], expected, actual })
}
