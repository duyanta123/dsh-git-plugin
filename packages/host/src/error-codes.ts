/**
 * dsh-gitkit — 域错误码注册、RemoteError 工厂、stderr 处理与 logger 约定。
 *
 * 错误码与分类规则：research/capability-spec.md §1.0.5（域码 = `git/<name>`，
 * 经 RemoteError 过线，client 按 code 判别不按 instanceof——map §2.4）。
 * 本模块新增 §1.0.5 之外的域码：`git/session-workspace-unresolved`（本模块
 * workspace.ts 的工作区解析失败；workflow 任务口径，spec §1.0.5 未列——见
 * ModuleResult.openIssues）。⑤ mutations/commit 模块（2026-10-31）续增三码
 * （同为 workflow 任务口径，spec §1.0.5 未列）：`git/no-paths`（stage/unstage/
 * discard 空路径数组）、`git/bad-request`（discard 三重守卫的守卫失败：未确认 /
 * baseRevision 过期 / 路由不可 discard 的路径）、`git/hook-failed`（commit 的
 * hook 失败分类——spec §1.4 落 git/git-error，任务口径单列以便 UI 可读展示
 * [清单 20/49]；details 形状与 git-error 同构）。
 *
 * M6 remote-ops 模块（2026-10-31）续增三码（同为 workflow 任务口径，spec §1.0.5
 * 未列）：`git/no-branch`（push/pull 在 detached/unborn 下的拒绝——git/no-upstream
 * 的 hint 'set-upstream' 对该态是误导动作）、`git/dirty-worktree`（pull 前置脏区
 * 拒绝）、`git/choose-remote`（多 remote 无默认远端——spec §1.5-1/§1.6 同场景落
 * git/no-remote，任务口径按「可选远端」语义单列；两者 details 同形 remotes: string[]）。
 *
 * v2 批次一（2026-11-08，docs/v2-implementation-plan.md §3.4）续增六码 + 一处联合扩展：
 * `git/branch-not-found` / `git/branch-not-merged` / `git/branch-exists`（refs-admin.ts
 * 的分支管理面，branch-exists 与 git/tag-exists 对称的「已存在」语义——方案评审修订轮
 * 定死）、`git/tag-exists` / `git/tag-not-found`（tag 管理面）、`git/worktree-failed`
 * （[清单 68] worktree 写面专用，details.stderr 过 sanitizeStderr）；
 * `git/bad-request` reason 联合 `+= 'force-unacknowledged'`（方案 §3.2：force push /
 * `-D` 删分支 / tag `-f` 共用）与 `+= 'invalid-options'`（worktreeAdd 的 branch/
 * newBranch 互斥与至少其一契约的守卫面——方案 §3.2 类型注记要求该契约生效，方案未指认
 * 承载码，取 bad-request 最贴近语义，登记为偏差）。
 *
 * v2 批次二（2026-11-08，docs/v2-implementation-plan.md §4.4）续增四码 + 一处联合扩展：
 * `git/blame-oversized`（blame 单次 50_000 行硬顶（D3=B），details.lineCount 引导
 * client 转 `-L` 区间分片）、`git/merge-conflict`（cherry-pick/revert/stash-pop 类
 * 冲突的结构化报错——details.op 定为 **string** 而非窄联合（方案 §4.4 注：批次三
 * stash-pop 复用此码时不再改类型），conflicted = `diff --name-only --diff-filter=U`
 * 回读、abortable = 中间态伪引用在场）、`git/unknown-revision`（compareBranches/log/
 * 时间旅行的修订解析失败）、`git/operation-in-progress`（时间旅行写前探测
 * CHERRY_PICK_HEAD/REVERT_HEAD 中间态，拒绝叠操作）；
 * `git/bad-request` reason 联合 `+= 'follow-without-path'`（方案 §4.2：`--follow`
 * 仅在 path 为单路径时合法）。
 *
 * 声明合并形态（模块说明符）照 dsh 树内
 * packages/experimental/client-ui-cot-translation/src/types.ts:23-28 原文：
 * `declare module '@deepseek-ai/dsh-typert-protocol'` + `interface RemoteErrorDetailsMap`，
 * 并以 `import type {}` 保证扩充面被加载（该文件 :2）。dsh 树 MIT —— NOTICE.md 登记。
 *
 * logger 用法对齐树内（§⑧-5）：单条字符串消息（实读 dsh 树 HEAD ce7073d512：
 * workspace-changes/src/index.ts:125 `ctx.logger.info('workspace-changes: git is…')`、
 * :138 `ctx.logger.warn(message)`；client/modules/src/index.ts:688 `ctx.logger.warn(err)`）——
 * cordis Logger.format 的 %-占位面不用，字段以 `key=value` 并入消息串。
 * spec §1.0.6：读操作 debug、写操作 info、失败 warn 附 code；不落盘 message 正文与
 * 文件内容；stderr 只进 debug 且截 500 字符。
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorCode, RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { GitRunResult } from './git-runner.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'git/no-repository': { probed: string }
    'git/identity-missing': { missing: string[] }
    'git/nothing-staged': { branch: string | null }
    'git/empty-message': Record<string, never>
    'git/no-upstream': { branch: string; hint: 'set-upstream' }
    'git/no-remote': { branch: string | null; remotes: string[] }
    'git/diverged': { branch: string; upstream: string; ahead: number; behind: number }
    'git/push-rejected': { remote: string; branch: string; reason: string; stderr: string }
    'git/auth-failed': { stderr: string }
    'git/pull-diverged': { branch: string; upstream: string; ahead: number; behind: number }
    'git/timeout': { op: string; timeoutMs: number }
    'git/git-error': { op: string; exitCode: number | null; stderr: string; truncated: boolean }
    'git/llm-route-unresolved': Record<string, never>
    'git/llm-failed': { stage: 'trim' | 'call' | 'parse'; reason: string }
    'git/session-workspace-unresolved': Record<string, never>
    'git/no-paths': { op: string }
    'git/bad-request': {
      /**
       * 守卫失败原因：v1 三守卫（unacknowledged / stale-base-revision / not-discardable）+
       * v2 批次一 'force-unacknowledged'（force push / `-D` 删分支 / tag `-f` / worktree
       * remove `--force` 共用的「危险动作未确认」闸）+ 'invalid-options'（调用方入参违反
       * wire 契约——worktreeAdd 的 branch/newBranch 互斥与至少其一）+
       * v2 批次二 'follow-without-path'（log 的 follow=true 而无单 path——§4.2）。
       */
      reason: 'unacknowledged' | 'stale-base-revision' | 'not-discardable' | 'force-unacknowledged' | 'invalid-options' | 'follow-without-path'
      /** not-discardable 时 = 被拒的路径清单；其余守卫为 []。 */
      paths: string[]
      /** stale-base-revision 时 = 请求基线（baseRevision），其余 null。 */
      expected: string | null
      /** stale-base-revision 时 = 最新 HEAD oid（unborn 为 null），其余 null。 */
      actual: string | null
    }
    'git/hook-failed': { op: string; exitCode: number | null; stderr: string; truncated: boolean }
    'git/no-branch': { state: 'detached' | 'unborn' }
    'git/dirty-worktree': { branch: string | null; pathCount: number }
    'git/choose-remote': { remotes: string[] }
    // —— v2 批次一六码（refs-admin/remote-ops 消费；docs/v2-implementation-plan.md §3.4）——
    'git/branch-not-found': { name: string }
    'git/branch-not-merged': { name: string }
    'git/branch-exists': { name: string }
    'git/tag-exists': { name: string }
    'git/tag-not-found': { name: string }
    'git/worktree-failed': { path: string; stderr: string }
    // —— v2 批次二四码（blame/graph/time-travel 消费；docs/v2-implementation-plan.md §4.4）——
    /** blame 全区超单次行数硬顶（D3=B）：lineCount 引导 client 转 `-L` 区间分片。 */
    'git/blame-oversized': { path: string; lineCount: number; maxLines: number }
    /**
     * cherry-pick/revert（批次三 stash-pop 复用）的冲突结构化报错。op 为 **string**
     * （方案 §4.4 定死——批次三 stash-pop 冲突复用此码时不再改类型）；conflicted =
     * `diff --name-only --diff-filter=U` 回读；abortable = 中间态伪引用在场（true 时
     * 错误面板给「放弃操作」入口调 abortOperation）。
     */
    'git/merge-conflict': { op: string; conflicted: string[]; abortable: boolean }
    /** compareBranches / log(ref) / 时间旅行的修订解析失败（rev-parse --verify 预检）。 */
    'git/unknown-revision': { op: string; revision: string }
    /** 时间旅行写前探测到中间态（CHERRY_PICK_HEAD/REVERT_HEAD 在场），拒绝叠操作。 */
    'git/operation-in-progress': { op: 'cherry-pick' | 'revert' }
  }
}

/** 本包声明过的域码键集（类型面 = RemoteErrorDetailsMap 的 git/* 子集）。 */
export type GitErrorCode = Extract<RemoteErrorCode, `git/${string}`>

/** 构造一个本包域码的 RemoteError（details 形状按码键检查）。 */
export function gitError<Code extends GitErrorCode>(
  code: Code,
  message: string,
  details: RemoteErrorDetailsMap[Code],
): RemoteError<Code> {
  return new RemoteError(code, message, details)
}

/** stderr 进入错误 details / 日志前的脱敏与封顶。 */
export function sanitizeStderr(stderr: string, maxChars = 16 * 1024): string {
  const redacted = stderr
    // URL 携带的 userinfo（https://user:token@host/…）
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => {
      const scheme = match.slice(0, match.indexOf('://'))
      return `${scheme}://***:***@`
    })
    // 凭证形键值（…token=… / password=… / authorization: Bearer …）
    .replace(/(token|access[_-]?token|password|passwd|pwd|secret|api[_-]?key|authorization)([=:])(\s*)(bearer\s+)?[^\s&;]+/gi,
      '$1$2$3***')
  return redacted.length <= maxChars ? redacted : redacted.slice(-maxChars)
}

/**
 * spec §1.0.5 分类规则认识的 stderr 关键词簇（network 簇为 M6 remote-ops 任务口径
 * 续补——spec §1.0.5 未列，登记见 PORTING.md M6 行）。
 */
export type GitStderrClass = 'auth-failed' | 'push-rejected' | 'pull-diverged' | 'network' | undefined

/**
 * 分类器簇表（顺序敏感：认证最先——auth stderr 可能同时含 network 措辞；rejected
 * 先于 diverged——`non-fast-forward` 提示簇与 `Not possible to fast-forward` 措辞
 * 不同不重叠，但 [rejected] 行优先给出拒绝语义）。**单一事实源**：M6 起强版正则
 * （/i + `[remote rejected]` + network 簇）曾另持于 remote-ops.ts（REMOTE_STDERR_
 * PATTERNS），与本弱版事实分叉——已收敛为这一份，remote-ops.ts 的
 * classifyRemoteStderr 改为消费本分类器（仅做词汇映射）。关键词依据：spec §1.0.5
 * 关键词簇 + M6 本机实测补 `[remote rejected]`（pre-receive 拒绝的实际 stderr 不含
 * 字面 `[rejected]`）+ network 簇（curl 传输层措辞）。正则不带 g 标志（`test` 无状态）。
 */
export const STDERR_PATTERNS: ReadonlyArray<{
  kind: Exclude<GitStderrClass, undefined>
  pattern: RegExp
}> = Object.freeze([
  { kind: 'auth-failed', pattern: /Authentication failed|could not read Username|Permission denied \(publickey\)/i },
  { kind: 'push-rejected', pattern: /\[rejected\]|\[remote rejected\]|non-fast-forward/i },
  { kind: 'pull-diverged', pattern: /Not possible to fast-forward/i },
  {
    kind: 'network',
    pattern: /Could not resolve host|Failed to connect|Connection timed out|Network is unreachable|Connection reset by peer|SSL connect error/i,
  },
])

/** 非零退出的 stderr 关键词分类（spec §1.0.5：其余 → undefined，由调用方落 git/git-error）。 */
export function classifyStderr(stderr: string): GitStderrClass {
  for (const { kind, pattern } of STDERR_PATTERNS) {
    if (pattern.test(stderr)) return kind
  }
  return undefined
}

/** 单条 git 命令失败（非零退出）→ 域错误（认证/拒绝类按 stderr 分类，其余 git-error 兜底）。 */
export function gitRunError(op: string, exitCode: number | null, stderr: string, truncated: boolean): RemoteError {
  const clean = sanitizeStderr(stderr)
  const kind = classifyStderr(clean)
  if (kind === 'auth-failed') {
    return gitError('git/auth-failed', `git ${op}: authentication failed; stderr redacted/tail kept`, { stderr: clean })
  }
  if (kind === 'push-rejected') {
    // branch/remote 由调用方细化；本工厂只知道 stderr —— 细化前的通用形状由
    // push/pull 实现覆盖，这里保持兜底码的完整 details。
    return gitError('git/git-error', `git ${op}: rejected by remote`, { op, exitCode, stderr: clean, truncated })
  }
  if (kind === 'pull-diverged') {
    return gitError('git/git-error', `git ${op}: fast-forward refused`, { op, exitCode, stderr: clean, truncated })
  }
  if (kind === 'network') {
    // 传输层失败：仍落兜底码，但 message 注记 (network)——remote-ops remoteOpFallback
    // 同款口径（同步引擎的 network 类经此汇入同一形状）。
    return gitError('git/git-error', `git ${op} failed (network) (exit ${String(exitCode)})`, {
      op, exitCode, stderr: clean, truncated,
    })
  }
  return gitError('git/git-error', `git ${op} failed (exit ${String(exitCode)})`, { op, exitCode, stderr: clean, truncated })
}

/** 允许的成功退出码白名单（缺省 [0]）。 */
export const EXIT_OK_ONLY: readonly number[] = [0]

/**
 * 断言一条 git 结果在白名单内且未截断，否则抛域错误。
 * 截断（stdout 超上限保尾部）必须显式报错——不能静默用截断数据解析（map §4.1）。
 * 白名单用例：`git diff --no-index` 的 exit 1（spec §1.2 untracked diff）等。
 */
export function assertGitOk<G extends GitRunResult>(
  result: G,
  op: string,
  allowedExitCodes: readonly number[] = EXIT_OK_ONLY,
): G {
  if (result.exitCode !== null && allowedExitCodes.includes(result.exitCode)) {
    if (result.truncated) {
      throw gitError('git/git-error', `git ${op}: stdout exceeded the configured output cap`, {
        op,
        exitCode: result.exitCode,
        stderr: sanitizeStderr(result.stderr),
        truncated: true,
      })
    }
    return result
  }
  throw gitRunError(op, result.exitCode, result.stderr, result.truncated)
}

/** 树内 logger 形态的最小结构面（cordis Logger 的 Record<LoggerType, LoggerMethod> 子集）。 */
export interface GitLoggerFace {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** `key=value` 字段串（logger 用法对齐树内：单条字符串消息，字段并入消息）。 */
function fields(pairs: Readonly<Record<string, unknown>>): string {
  return Object.entries(pairs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : String(value)}`)
    .join(' ')
}

/** 读操作日志（debug 级）。 */
export function logRead(logger: GitLoggerFace, op: string, pairs: Readonly<Record<string, unknown>> = {}): void {
  logger.debug(`git ${op}${pairsKeys(pairs)}`)
}

/** 写操作日志（info 级；spec §1.0.6 字段 { op, durationMs, … }）。 */
export function logWrite(logger: GitLoggerFace, op: string, pairs: Readonly<Record<string, unknown>> = {}): void {
  logger.info(`git ${op} ${fields(pairs)}`.trimEnd())
}

/** 失败日志（warn 级，附 code；stderr 只在 debug 且截 500 —— 失败正文不重复落 warn）。 */
export function logFailure(logger: GitLoggerFace, op: string, code: string, pairs: Readonly<Record<string, unknown>> = {}): void {
  logger.warn(`git ${op} failed ${fields({ code, ...pairs })}`)
}

/** 调试态 stderr 尾部（spec §1.0.6：debug 级且截 500 字符；先脱敏）。 */
export function stderrForDebug(stderr: string): string {
  return sanitizeStderr(stderr, 500)
}

function pairsKeys(pairs: Readonly<Record<string, unknown>>): string {
  return Object.keys(pairs).length === 0 ? '' : ` ${fields(pairs)}`
}
