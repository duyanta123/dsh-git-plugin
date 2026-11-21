/**
 * dsh-gitkit — 域错误码注册、RemoteError 工厂、stderr 处理与 logger 约定。
 *
 * 错误码与分类规则：research/capability-spec.md §1.0.5（域码 = `git/<name>`，
 * 经 RemoteError 过线，client 按 code 判别不按 instanceof——map §2.4）。
 *
 * 各批次域码增补史（⑤ mutations·commit 三码 / M6 三码 / v2 批次一~四 / v3 批次一·四的
 * 续增域码与 reason/op 联合扩展原文）已迁 docs/host-wiring-notes.md §2。
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
import type { CommitViolation } from './types.ts'
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
    // resolved（可选）：conflictResolve/conflictMarkResolved 多文件中途失败的已成功
    // 清单（conflicts.ts rethrowWithResolvedPartial——§3.10「结果如实分列」；仅确有
    // 部分成功时附着，纯失败/守卫失败不带空清单）。
    'git/git-error': { op: string; exitCode: number | null; stderr: string; truncated: boolean; resolved?: string[] }
    'git/llm-route-unresolved': Record<string, never>
    'git/llm-failed': { stage: 'trim' | 'call' | 'parse'; reason: string }
    'git/session-workspace-unresolved': Record<string, never>
    'git/no-paths': { op: string }
    'git/bad-request': {
      /**
       * 守卫失败原因：v1 三守卫（unacknowledged / stale-base-revision / not-discardable）+
       * v2 批次一 'force-unacknowledged'（force push / `-D` 删分支 / tag `-f` / worktree
       * remove `--force` 共用的「危险动作未确认」闸）+ 'invalid-options'（调用方入参违反
       * wire 契约——worktreeAdd 的 branch/newBranch 互斥与至少其一；amend --no-edit 与
       * trailers 同给）+
       * v2 批次二 'follow-without-path'（log 的 follow=true 而无单 path——§4.2）+
       * v2 批次三 'malformed-trailer'（CommitOptions.trailers 条目不合法——§5.2）+
       * v3 批次一 'path-not-conflicted'（conflictResolve/conflictMarkResolved 的路径不
       * 在当前 unmerged 集——零写命令守卫）与 'conflicts-remaining'（operationContinue
       * 前置：仍有 unmerged 路径——零命令守卫；docs/v3-implementation-plan.md §3.2）。
       */
      reason: 'unacknowledged' | 'stale-base-revision' | 'not-discardable' | 'force-unacknowledged' | 'invalid-options' | 'follow-without-path' | 'malformed-trailer' | 'path-not-conflicted' | 'conflicts-remaining'
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
    /** 时间旅行/冲突引擎写前探测到中间态（CHERRY_PICK_HEAD/REVERT_HEAD/MERGE_HEAD 或 rebase-merge|apply 目录在场），拒绝叠操作；v3 批次一联合 += 'merge'|'rebase'（docs/v3-implementation-plan.md §3.2/§3.5）。 */
    'git/operation-in-progress': { op: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }
    // —— v2 批次三三码（staging-patch/stash/commit 消费；docs/v2-implementation-plan.md §5.4）——
    /** stagePatch 的 `apply --cached` 失败（patch 与 index 冲突）与二进制/模式变更 hunk 前置拒绝；stderr 过 sanitizeStderr。 */
    'git/stage-patch-failed': { path: string; stderr: string }
    /** stashPop/stashDrop 的序号越界与空 stash 预检（rev-parse --verify --quiet stash@{N}）。 */
    'git/stash-not-found': { index: number }
    /**
     * 提交护栏拦截（[21][22]）。overridable 按 **D5=A** 语义：违规集中无 secret 类时
     * 才有豁免许可（env-file/大文件/构建产物可 danger 勾选豁免）；**secret 硬阻断
     * 不可豁免**（overridable:false——host commit 守卫强制，零命令）。
     */
    'git/commit-blocked': { violations: CommitViolation[]; overridable: boolean }
    // —— v2 批次四三码（admin-repo/pr 消费；docs/v2-implementation-plan.md §6.4）——
    /**
     * initRepository 前置复核失败（[清单 8]）：目录已是仓库（`rev-parse` 复核非仓库态
     * 失败——方案 §6.5「前置 git rev-parse 复核非仓库态」）或 `git init` 自身失败；
     * reason 为英文诊断词（'already-a-repository' / 'git-init-failed'）。
     */
    'git/init-failed': { path: string; reason: string }
    /** gh CLI 不可用（[清单 46/69]；D1=A）：可执行解析失败（ghCommand 指向解析不到的名字）或 `gh auth status` 预检未通过（未安装/未登录——方案 §6.10「未装/未登录 ⇒ pr-tool-missing」）。 */
    'git/pr-tool-missing': { tool: 'gh' }
    /** gh pr create / pr view 的 API 侧失败（stderr 过 sanitizeStderr 后进 details）。 */
    'git/pr-create-failed': { stderr: string }
    // —— v3 批次四一码（session-watch/checkpoints 消费；docs/v3-implementation-plan.md §6.5）——
    /**
     * checkpointDiff / checkpointRestore 对无记录 seq 的显式拒绝（plan §6.2：listing
     * 侧不抛错只置 summary null，**操作侧必须硬失败防误恢复**）。触发面 = seq 不在
     * session-watch 环 / workspaceChanges 服务未挂载 / 该 seq 无 summary 记录 / seq
     * 跨会话歧义。details.seq = 请求的事件序列号。
     */
    'git/checkpoint-unavailable': { seq: number }
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

/**
 * 引擎内 logFailure 的空实现兜底（logger 可选注入的引擎——commit.ts ≡ message-gen.ts
 * 同款私有 nullLogger 收口；`this.logger ?? nullLogger` 的调用点语义不变）。
 */
export const nullLogger: GitLoggerFace = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * 域错误码提取（index.ts 私有 errorCodeOf ≡ automation.ts codeOf 同形副本收口；
 * agent-tools.ts ToolErrorValue.error 注记的同口径）：cause 带 string `code` 字段
 * （RemoteError 形状）取之，其余（含原生 Error/gateway 折叠）按 'gateway/internal'。
 */
export function errorCodeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code
  }
  return 'gateway/internal'
}

/**
 * `key=value` 字段串（logger 用法对齐树内：单条字符串消息，字段并入消息）。
 * audit.ts summarizeAuditFields（审计摘要）= 本函数同形副本收口——audit.ts 以
 * `summarizeAuditFields` 名字 re-export（wire/测试面名字不变，实现单源）。
 */
export function fields(pairs: Readonly<Record<string, unknown>>): string {
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
