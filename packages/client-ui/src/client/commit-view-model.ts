/**
 * dsh-gitkit-ui — C4 GitCommitDialog 纯视图模型（④-K 提交对话框模块
 * ask §①；spec §3.1 GitCommitDialog 行的字段全表）。
 *
 * 渲染决策全部收敛为纯函数（组件只做 t/订阅/事件——spec §6 纯函数单测纪律，与
 * ui-model.ts / changes-view-model.ts 同纪律）：消息编辑器的实时校验与计数、
 * Conventional 非阻断警示、staged 只读清单与计数、amend 预填/警示、三条件告警条
 * （身份 / unborn / diverged）、Commit / Commit & Push 的启用闸。不依赖 DOM/React
 * 即可断言（tests/commit-view-model.spec）。
 *
 * Conventional 提示正则 = host commit.ts 守卫链第 3 步同语义的 client 镜像
 * （ZCode `CONVENTIONAL_COMMIT_RE` 语义对照——PORTING.md ⑤ mutations/commit 模块
 * C 级行 + 本模块 C 级登记行；非阻断，只提示不拦截，[清单 17]）。
 */

import type {
  CommitOptions, CommitScanResult, CommitViolation, FileChange, GitIdentityResult,
  GitStatusSnapshot, PushOptions,
} from 'dsh-gitkit/types'
import type { HeadCommitInfo } from './commit-dialog-face.js'
import type { GitErrorLike } from './remote/mount.js'
import { redactTail } from './m13/redact.js'

/**
 * Conventional Commits 非阻断提示正则（client 镜像；与 host `CONVENTIONAL_COMMIT_HINT_RE`
 * 同语义：`type(scope)?!?: subject`，subject 1–100 字符）。
 */
export const CONVENTIONAL_HINT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/

/** 提交动作进行中状态（三动作 + 错误动作 fetch/pull 的 busy 投影；false = 空闲）。 */
export type CommitPending = false | 'commit' | 'push' | 'fetch' | 'pull'

/** 视图模型输入（组件持有的全部决策相关状态）。 */
export interface CommitDialogInput {
  /** 状态源快照（null = 未就绪/不可用——按钮全禁用）。 */
  snapshot: GitStatusSnapshot | null
  /** 身份预检结果（null = 尚未返回）。 */
  identity: GitIdentityResult | null
  /** 编辑器当前文本。 */
  message: string
  /** amend 开关。 */
  amend: boolean
  /** HEAD 首条提交（amend 标签/预填用；null = unborn 或尚未取回）。 */
  head: HeadCommitInfo | null
  /** 进行中的动作。 */
  pending: CommitPending
  /** 护栏结果面板视图（V2 批次三 [21][22]；null = 面板尚未进入渲染态）。 */
  guard?: GuardScanView | null
  /** 可豁免类的 danger 勾选豁免态（D5；仅 guard.overridable 时参与放行）。 */
  overrideAcknowledged?: boolean
  /** 提交已成功（评审修复：成功路径不再立即 onDone 关框——对话框转入「已提交」终态，
   *  hook 输出折叠区可见，footer 换单关按钮；[63] 成功半由此可达）。 */
  succeeded?: boolean
}

/** 提交对话框渲染模型。 */
export interface CommitDialogView {
  /** 仓库可用（快照就绪）；false ⇒ 动作全禁用。 */
  available: boolean
  /** staged 只读清单（[清单 11] 前端镜像的数据面）。 */
  staged: readonly FileChange[]
  stagedCount: number
  /** 编辑器字符计数（实时）。 */
  chars: number
  /** 消息全空白（实时校验；非 amend 时禁用提交）。 */
  messageEmpty: boolean
  /** 首行命中 Conventional（非阻断提示的判据）。 */
  conventional: boolean
  /** 行内 Conventional 警示可见（非空且不命中——不阻断 [清单 17]）。 */
  showConventionalHint: boolean
  /** amend 可用（有上一笔提交；unborn 禁用勾选）。 */
  amendAvailable: boolean
  /** amend 勾选框标签参数（[清单 19] `shortOid subject`）。 */
  amendParams: { shortOid: string; subject: string } | null
  /** amend 改写已推送历史警示（upstream 且 ahead==0——v1 无 force push，只警示）。 */
  showAmendWarning: boolean
  /** unborn 提示条（[清单 64] 首提交路径）。 */
  showUnbornBar: boolean
  /** diverged 告警条（upstream 且 behind>0——推送将被非快进拒绝）。 */
  showDivergedBar: boolean
  /** diverged 告警条的 behind 数（{behind} 插值）。 */
  divergedBehind: number
  /** 身份告警条（[清单 55] 缺失字段与配置指引）。 */
  showIdentityBar: boolean
  /** 身份缺失键清单（'user.name, user.email' 形态的插值串）。 */
  identityMissing: string
  /** amend + 留空 = host --no-edit 路（保留原消息）的信息行。 */
  amendNoEdit: boolean
  /** Commit 启用闸：仓库可用 + 空闲 + 非 amend 时（消息非空 且 staged 非空）+ 护栏放行 + 未提交成功。 */
  commitEnabled: boolean
  /** Commit & Push 启用闸（链式：先过 Commit 同款闸，push 失败在链上显错）。 */
  pushEnabled: boolean
  /** 护栏拦截中且未豁免（按钮禁用的护栏半边；plan §5.6 ②「blocked ⇒ 禁用提交」）。 */
  guardBlocked: boolean
  /** 提交已成功（对话框转入「已提交」终态——footer 换单关按钮，动作全禁用）。 */
  succeeded: boolean
}

/**
 * status 快照的分支上游态 → amend 改写已推送历史警示（spec §3.1：upstream 且
 * ahead==0；ahead>0 表示尚未推送，改写不涉已发布历史）。
 */
export function amendRewritesPushedHistory(branch: {
  upstream: string | null
  ahead: number | null
} | null): boolean {
  if (branch === null || branch.upstream === null) return false
  return (branch.ahead ?? 0) === 0
}

/** 组装提交对话框视图模型（纯函数）。 */
export function commitDialogView(input: CommitDialogInput): CommitDialogView {
  const { snapshot, identity, message, amend, head, pending } = input
  const available = snapshot !== null
  const staged = snapshot?.staged ?? []
  const stagedCount = staged.length
  const chars = message.length
  const messageEmpty = message.trim() === ''
  const firstLine = message.trimEnd().split(/\r?\n/, 1)[0] ?? ''
  const conventional = firstLine !== '' && CONVENTIONAL_HINT_RE.test(firstLine)
  const branch = snapshot?.branch ?? null
  const idle = pending === false
  // 提交成功后的「已提交」终态：动作全禁用（footer 已换单关按钮，不再二次提交）。
  const succeeded = input.succeeded === true
  const gatesOk = available && idle && !succeeded && (amend || (!messageEmpty && stagedCount > 0))
  // 护栏放行半边（plan §5.6 ②）：blocked ⇒ 禁用，除非可豁免类且用户已勾选豁免（D5）。
  const guard = input.guard ?? null
  const guardBlocked = guard?.blocked === true
  const guardAllows = !guardBlocked || (guard?.overridable === true && input.overrideAcknowledged === true)
  const upstream = branch?.upstream ?? null
  const behind = branch?.behind ?? null
  return {
    available,
    staged,
    stagedCount,
    chars,
    messageEmpty,
    conventional,
    showConventionalHint: !messageEmpty && !conventional,
    amendAvailable: available && idle && !succeeded && head !== null,
    amendParams: head === null ? null : { shortOid: head.shortOid, subject: head.subject },
    showAmendWarning: amend && amendRewritesPushedHistory(branch),
    showUnbornBar: branch?.unborn === true,
    showDivergedBar: upstream !== null && (behind ?? 0) > 0,
    divergedBehind: behind ?? 0,
    showIdentityBar: identity !== null && !identity.complete,
    identityMissing: identity?.missing.join(', ') ?? '',
    amendNoEdit: amend && messageEmpty,
    commitEnabled: gatesOk && guardAllows,
    pushEnabled: gatesOk && guardAllows,
    guardBlocked,
    succeeded,
  }
}

/**
 * Commit 动作入参（组件把视图状态折算成 CommitOptions 的纯折算——host 守卫链
 * 镜像：amend + 全空白消息 = --no-edit 路，host 保留原消息）。V2 批次三 [18]：
 * trailers（[plan §5.2 `CommitOptions += trailers?: string[]`]）——空清单省略该
 * 字段（wire 纪律「可选输入省略传递，不传显式 undefined」）。
 */
export function commitOptionsOf(message: string, amend: boolean, skipHooks: boolean, trailers: readonly string[] = []): CommitOptions {
  if (trailers.length === 0) return { message, amend, skipHooks }
  return { message, amend, skipHooks, trailers: [...trailers] }
}

/** 链式推送的入参：无 upstream ⇒ setUpstream:true（首推设上游，[清单 26] 的 UI 半）。 */
export function pushOptionsOf(branch: { upstream: string | null } | null): PushOptions {
  return { setUpstream: branch?.upstream === null }
}

// ── V2 批次三：[18] trailer 编辑区 / [21][22] 护栏面板 / [63] hook 输出折叠区 ──

/**
 * trailer 行校验正则（plan §5.6 ①「非法行即时警示不阻断——镜像 Conventional 预检
 * 形态」；host 校验不合法条目 ⇒ `git/bad-request` reason 'malformed-trailer'，
 * plan §5.2——客户端只提示不拦截，最终裁决在 host）。
 * 形如 `Key: value`：Key = 字母开头的字母数字连字符串，value 非空。
 */
export const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*: \S.*$/

/** 编辑区文本 → trailer 行清单（每行一条；空白行剔除——「可增删」的文本形态）。 */
export function trailerLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 第一条非法 trailer 行（警示文案的锚；null = 全部合法或编辑区为空）。 */
export function invalidTrailerLine(text: string): string | null {
  for (const line of trailerLines(text)) {
    if (!TRAILER_LINE_RE.test(line)) return line
  }
  return null
}

/** 护栏扫描阶段（面板渲染决策；'idle' = 面板不渲染）。 */
export type GuardScanPhase = 'idle' | 'scanning' | 'ready' | 'error'

/** 护栏结果面板渲染模型（plan §5.6 ②；D5 豁免语义由 overridable + 勾选态折算）。 */
export interface GuardScanView {
  /** 面板可见（scanning/ready/error 三态可见；idle 不渲染）。 */
  visible: boolean
  phase: GuardScanPhase
  scanning: boolean
  /** 扫描完成且零违规（通过行）。 */
  clean: boolean
  /** host 裁决的拦截态（CommitScanResult.blocked）。 */
  blocked: boolean
  /** 违规清单（面板逐行渲染 kind/path/detail）。 */
  violations: readonly CommitViolation[]
  /** D5：可豁免（= 违规集中无 secret 类——client 按 D5=A 语义派生，与 host
   *  git/commit-blocked details.overridable 同式；CommitScanResult wire 无该字段）。 */
  overridable: boolean
  /** secret 类违规在场（硬阻断提示行——不可豁免）。 */
  hasSecret: boolean
}

/** 护栏扫描态 → 面板视图（纯函数；ready 且 scan 缺席按未就绪降级）。 */
export function guardScanView(phase: GuardScanPhase, scan: CommitScanResult | null): GuardScanView {
  if (phase !== 'ready' || scan === null) {
    return {
      visible: phase !== 'idle',
      phase,
      scanning: phase === 'scanning',
      clean: false,
      blocked: false,
      violations: [],
      overridable: false,
      hasSecret: false,
    }
  }
  const hasSecret = scan.violations.some((violation) => violation.kind === 'secret')
  return {
    visible: true,
    phase,
    scanning: false,
    clean: !scan.blocked && scan.violations.length === 0,
    blocked: scan.blocked,
    violations: scan.violations,
    // D5=A（2026-11-08 拍板）：secret 硬阻断不可豁免；其余可 danger 勾选豁免——
    // 与 host commit-blocked details.overridable 的计算同式（error-codes.ts 注）。
    overridable: !hasSecret,
    hasSecret,
  }
}

/**
 * 违规集签名（kind:path:line 串接；评审修复 [清单 63]/§5.6② 的豁免 TOCTOU——
 * 豁免勾选必须绑定「产生它的违规集」，点提交前的 fresh 扫描发现违规集变化时，
 * 上一个违规集勾选的豁免不再放行新集）。sizeBytes/detail/redactedMatch 不进签名
 * （同 kind/path/line 的违规对豁免裁决等价）。
 */
export function violationsSignature(violations: readonly CommitViolation[]): string {
  return violations
    .map((violation) => `${violation.kind}:${violation.path}:${violation.line ?? ''}`)
    .join('|')
}

/**
 * 点提交前的最新扫描裁决（plan §5.6 ②「点提交前自动 scanStaged」；plan §5.7
 * 「blocked→按钮禁用 / 豁免状态机」）：blocked 且（不可豁免或未勾选豁免）⇒ 不放行。
 * 豁免许可按 D5=A 语义派生（违规集中无 secret 类——与 guardScanView 同式；
 * CommitScanResult wire 无 overridable 字段，host 的 overridable 在
 * git/commit-blocked 错误 details 上）。
 *
 * `overrideSignature`（评审修复，可选）：豁免勾选所绑定违规集的签名——给定时要求
 * 与本 scan 的 violationsSignature 一致才承认豁免（fresh 扫描违规集已变 ⇒ 上一个
 * 集的豁免失效，需重新对清单勾选）；缺省 = 无签名绑定（面板闸路径——勾选恒绑定
 * 当前 scan）。
 *
 * scan 缺席（扫描失败/未跑）⇒ 放行——护栏是只读预检，不因扫描自身失败阻塞提交。
 */
export function commitAllowedByGuard(
  scan: CommitScanResult | null,
  overrideAcknowledged: boolean,
  overrideSignature?: string | null,
): boolean {
  if (scan === null) return true
  if (!scan.blocked) return true
  const hasSecret = scan.violations.some((violation) => violation.kind === 'secret')
  if (hasSecret) return false
  if (overrideSignature !== undefined && overrideSignature !== null
    && violationsSignature(scan.violations) !== overrideSignature) {
    return false // 违规集已变：旧集的豁免不承认（TOCTOU 闸）
  }
  return overrideAcknowledged
}

/** hook 输出折叠区的渲染模型（[63]；plan §5.6 ③）。 */
export interface ProcessOutputView {
  /** 折叠区可见（有输出/超时才渲染；空输出 process 由 host 置 null，plan §5.2）。 */
  visible: boolean
  timedOut: boolean
  durationMs: number | null
  /** stdout 尾保留文本（redactTail——P3-3 复活点）。 */
  stdout: string
  /** stderr 尾保留文本（redact）。 */
  stderr: string
  /** 任一侧发生尾保留截断。 */
  truncated: boolean
}

/** 长输出尾保留的字符预算（stderr 保留策略的显示面版；redactTail 同款保尾）。 */
export const PROCESS_TAIL_MAX_CHARS = 2000

/**
 * `CommitResult.process` → 折叠区视图。诚实命名口径（plan §5.2）：这是 `git commit`
 * 进程的整体输出（含 hook 输出，git 不做 per-hook 归因）。两侧过 redactTail（先脱敏
 * 再保尾——凭证形状不上屏），超预算置 truncated。
 */
export function processOutputView(process: {
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
} | null | undefined): ProcessOutputView {
  if (process === null || process === undefined) {
    return { visible: false, timedOut: false, durationMs: null, stdout: '', stderr: '', truncated: false }
  }
  const stdout = redactTail(process.stdout, PROCESS_TAIL_MAX_CHARS)
  const stderr = redactTail(process.stderr, PROCESS_TAIL_MAX_CHARS)
  const truncated = process.stdout.length > PROCESS_TAIL_MAX_CHARS || process.stderr.length > PROCESS_TAIL_MAX_CHARS
  return {
    visible: stdout !== '' || stderr !== '' || process.timedOut,
    timedOut: process.timedOut,
    durationMs: process.durationMs,
    stdout,
    stderr,
    truncated,
  }
}

/**
 * `git/hook-failed` 的 details.stderr → 折叠区视图（失败路径没有 CommitResult.process
 * 可读——error-codes 的 hook-failed details 携带 stderr；同款 redactTail 保尾）。
 */
export function processFromHookError(error: GitErrorLike | null): ProcessOutputView | null {
  const stderr = (error?.details as { stderr?: unknown } | null)?.stderr
  if (typeof stderr !== 'string' || stderr.trim() === '') return null
  const tail = redactTail(stderr, PROCESS_TAIL_MAX_CHARS)
  return {
    visible: true,
    timedOut: false,
    durationMs: null,
    stdout: '',
    stderr: tail,
    truncated: stderr.length > PROCESS_TAIL_MAX_CHARS,
  }
}
