/**
 * dsh-gitkit — 写操作守卫与回读助手收口（Phase 2 重构：time-travel.ts ≡ merge-rebase.ts
 * ≡ stash.ts 的同款私有方法提为共享函数；docs/v3-implementation-plan.md 批次一
 * detectOperation 提共享同一先例的延续）。
 *
 * 收口纪律（与 conflicts.ts detectOperation 同款）：
 *   - **逐字节保真**：共享实现的行为 = 原三份私有方法逐字一致——runner op 词汇、
 *     域错误 message/details 形状、exit 语义全部不变；差异面（各引擎的 op 前缀词）
 *     以参数表达，不在共享层hardcode。
 *   - **消费面**：time-travel.ts（cherry-pick/revert/reset）、merge-rebase.ts
 *     （branchMerge/rebase）、stash.ts（stashPop 冲突回读）、commit.ts/message-gen.ts
 *     （currentBranch）、index.ts identity / remote-ops.ts / commit.ts / diagnostics.ts
 *     （configGetScalar——四份同语义实现收口，index.ts 的 scope 旗标组装留在调用侧）。
 *   - refs-admin.ts currentBranch（symbolic-ref + lenient 选项）与 admin-repo.ts
 *     currentBranch（init 后契约破坏要响）是**另一口径，刻意不并入**本模块——语义
 *     不同（detached ⇒ null vs 抛错），收口只合并真正同款的实现。
 */

import { assertGitOk, gitError, gitRunError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import { signalOf } from './git-runner.ts'
import { detectOperation } from './conflicts.ts'

/**
 * 未合并路径回读（`diff --name-only --diff-filter=U -z`）：**-z 口径**——NUL 分隔、
 * 路径原样字节不加引号（conflicts.ts scanUnmerged 的 porcelain v2 -z 同口径；
 * status-parser.ts「-z 下路径原样」纪律）。-z 口径承自原 time-travel/merge-rebase/
 * stash 三处私有副本（v3 批次的评审收口已统一此口径，非本次收口引入；本次收口仅合并
 * 副本、口径逐字保留）——行分割口径在 core.quotepath 缺省下会把非 ASCII 路径
 * C-引号化（中文/空格路径失真），且路径内嵌换行会被拆行。
 * 不 trim——`-z` 输出无填充，条目即路径本身（路径尾空格合法）。
 *
 * scope = 引擎 op 前缀词（runner op 与 assertGitOk 的 op 词汇各引擎原样：
 * 'time-travel' / 'merge-rebase' / 'stash'——域错误 message 与日志口径不变）。
 * @throws assertGitOk 的域错误（非零退出 / stdout 截断）。
 */
export async function conflictedPaths(
  gitRead: GitRunner,
  repoRoot: string,
  scope: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const op = `${scope}(diff --diff-filter=U -z)`
  const listing = await gitRead.run(['diff', '--name-only', '--diff-filter=U', '-z'], {
    cwd: repoRoot, op, signal: signalOf(signal),
  })
  assertGitOk(listing, op)
  return listing.stdout.split('\0').filter((entry) => entry !== '')
}

/**
 * 操作后 HEAD 回读（`rev-parse --verify HEAD`；成功路径均不产生 unborn——
 * time-travel 三操作与 merge/rebase 成功后 HEAD 必有提交）。oid 为空 = 契约破坏，
 * 落 git/git-error（原 time-travel/merge-rebase 私有 readHead 逐字一致）。
 * @throws assertGitOk 的域错误；空 oid ⇒ git/git-error。
 */
export async function readHeadAfterOperation(
  gitRead: GitRunner,
  repoRoot: string,
  op: string,
  signal?: AbortSignal,
): Promise<string> {
  const head = await gitRead.run(['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot, op: `${op}(rev-parse --verify HEAD)`, signal: signalOf(signal),
  })
  assertGitOk(head, `${op}(rev-parse --verify HEAD)`)
  const oid = head.stdout.trim()
  if (oid === '') {
    throw gitError('git/git-error', `git ${op}: empty HEAD after a successful operation`, {
      op: `${op}(rev-parse --verify HEAD)`, exitCode: head.exitCode, stderr: '', truncated: false,
    })
  }
  return oid
}

/**
 * cherry-pick/revert/merge/rebase 非零退出 → 域错误映射（time-travel.ts throwOpFailure
 * ≡ merge-rebase.ts throwOpFailure 逐字一致；op 词汇以参数表达）：
 * 输出含 CONFLICT ⇒ git/merge-conflict（conflicted = diff-filter=U 回读——scope 同
 * {@link conflictedPaths}；abortable = 共享 detectOperation 在场——冲突路径恒 true，
 * 防御性探测如实回值）；其余（空 cherry-pick / 空 revert / --ff-only 不可 ff 等）⇒
 * git-error。stash 的 throwStashFailure **不并入**（message 文本不同——'stash-pop'
 * 语义行「stash 未丢」，是另一条域错误形状）。
 * @throws git/merge-conflict（冲突形状）或 gitRunError 的域错误（恒 throw——返回类型 never）。
 */
export async function throwOpFailure(
  gitRead: GitRunner,
  result: { exitCode: number | null; stdout: string; stderr: string; truncated: boolean },
  op: 'cherry-pick' | 'revert' | 'merge' | 'rebase',
  scope: string,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<never> {
  if (/CONFLICT/.test(result.stdout) || /CONFLICT/.test(result.stderr)) {
    const conflicted = await conflictedPaths(gitRead, repoRoot, scope, signal)
    const inProgress = await detectOperation(repoRoot, gitRead, signal)
    throw gitError('git/merge-conflict', `git ${op}: conflict; the repository is left in an intermediate state (abort or resolve it)`, {
      op,
      conflicted,
      abortable: inProgress !== null,
    })
  }
  throw gitRunError(op, result.exitCode, result.stderr, result.truncated)
}

/**
 * 单键 `git config --get` 共享实现（index.ts identity / remote-ops.ts / commit.ts /
 * diagnostics.ts 四份同语义实现收口）。退出码语义（identity configGet 同口径，
 * 本机 git 2.55.0.windows.2 实测）：**0 = 有值（空串值按缺失 → null）**；
 * **1 = 键未设置（缺失）→ null**；其余非零 → gitRunError（stderr 脱敏进 details）。
 *
 * op 词汇由调用方传入（runner op 与域错误 details.op 保持各引擎原样：
 * 'identity(config --get user.name)' / 'config --get …' / 'commit(config --get …)' /
 * 'repoDiagnostics(config --get …)'）；`onFailure` 在非 0/1 退出、抛错**之前**调用
 * （index.ts / commit.ts 的 logFailure 顺序原样保留——先 warn 后 throw；
 * remote-ops/diagnostics 无 logger，不传）。scope 旗标组装留在调用侧（index.ts
 * IDENTITY_SCOPE_FLAGS 查表不变——本助手只接受已组装的 argv 数组）。
 * @returns 生效值（空串归 null）或 null（未设置）。
 * @throws gitRunError 的域错误（其余非零退出）。
 */
export async function configGetScalar(
  runner: GitRunner,
  cwd: string,
  argv: readonly string[],
  op: string,
  signal?: AbortSignal,
  onFailure?: (() => void) | undefined,
): Promise<string | null> {
  const result = await runner.run(argv, { cwd, op, signal: signalOf(signal) })
  if (result.exitCode === 0) {
    const value = result.stdout.trim()
    return value === '' ? null : value
  }
  if (result.exitCode === 1) return null
  onFailure?.()
  throw gitRunError(op, result.exitCode, result.stderr, result.truncated)
}

/**
 * 当前分支短名（`rev-parse --abbrev-ref HEAD`）：detached 输出 'HEAD'（本机实测）或
 * 空串或非零退出 ⇒ null（commit.ts ≡ message-gen.ts 同款私有 currentBranch 收口；
 * exitCode !== 0 与空名同语义——nothing-staged details.branch / generateCommitMessage
 * 的分支查询面只要 null 而不要响）。refs-admin.ts（symbolic-ref + lenient）与
 * admin-repo.ts（init 后契约破坏要响）是另一口径，刻意不并入。
 */
export async function currentBranchShortName(
  gitRead: GitRunner,
  cwd: string,
  op: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await gitRead.run(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd, op, signal,
  })
  if (result.exitCode !== 0) return null
  const name = result.stdout.trim()
  return name === '' || name === 'HEAD' ? null : name
}
