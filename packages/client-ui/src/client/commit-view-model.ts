/**
 * @dsh-plugin/client-ui-git — C4 GitCommitDialog 纯视图模型（④-K 提交对话框模块
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

import type { CommitOptions, FileChange, GitIdentityResult, GitStatusSnapshot, PushOptions } from '@dsh-plugin/git/types'
import type { HeadCommitInfo } from './commit-dialog-face.js'

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
  /** Commit 启用闸：仓库可用 + 空闲 + 非 amend 时（消息非空 且 staged 非空）。 */
  commitEnabled: boolean
  /** Commit & Push 启用闸（链式：先过 Commit 同款闸，push 失败在链上显错）。 */
  pushEnabled: boolean
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
  const gatesOk = available && idle && (amend || (!messageEmpty && stagedCount > 0))
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
    amendAvailable: available && idle && head !== null,
    amendParams: head === null ? null : { shortOid: head.shortOid, subject: head.subject },
    showAmendWarning: amend && amendRewritesPushedHistory(branch),
    showUnbornBar: branch?.unborn === true,
    showDivergedBar: upstream !== null && (behind ?? 0) > 0,
    divergedBehind: behind ?? 0,
    showIdentityBar: identity !== null && !identity.complete,
    identityMissing: identity?.missing.join(', ') ?? '',
    amendNoEdit: amend && messageEmpty,
    commitEnabled: gatesOk,
    pushEnabled: gatesOk,
  }
}

/**
 * Commit 动作入参（组件把视图状态折算成 CommitOptions 的纯折算——host 守卫链
 * 镜像：amend + 全空白消息 = --no-edit 路，host 保留原消息）。
 */
export function commitOptionsOf(message: string, amend: boolean, skipHooks: boolean): CommitOptions {
  return { message, amend, skipHooks }
}

/** 链式推送的入参：无 upstream ⇒ setUpstream:true（首推设上游，[清单 26] 的 UI 半）。 */
export function pushOptionsOf(branch: { upstream: string | null } | null): PushOptions {
  return { setUpstream: branch?.upstream === null }
}
