/**
 * dsh-gitkit — 冲突条/冲突面板纯视图模型（V3 批次一 [清单 13]；
 * v3-implementation-plan §3.7/§3.8 client 清单）。
 *
 * 渲染决策全部收敛为纯函数（组件只做 t/订阅/事件——spec §6 纯函数单测纪律，
 * changes-view-model.ts/stash-view-model.ts 同款）：
 *   - `conflictBarView`：变更 tab 顶部冲突条的可见性与形态（status.conflicted 非空
 *     常驻——不依赖错误路径，plan §3.7；中间态在场时计数归零也不撤条——continue
 *     循环的可驱性）+ operation 徽标键；
 *   - `conflictRows`：面板文件列表行（code/kind 徽标 + ours/theirs 按钮可用性矩阵，
 *     由 wire 的 oursExists/theirsExists 驱动禁用——「不可向禁用」，plan §3.2）+
 *     DD 两向同效确认态（§3.4 矩阵 DD 行：ours/theirs 同命令，UI 显式确认）；
 *   - `ddAcceptDeleteChoice`：DD 的 wire 决议（两向同效——以 'ours' 过线，host
 *     RESOLUTION_MATRIX DD 两向均为 [rm]，host/src/conflicts.ts:105 实读）；
 *   - `operationActionsEnabled`：底部 继续操作/放弃操作 的可用闸（中间态在场）；
 *   - `continueEnabled`：继续操作的客户端守卫（镜像 host 零命令守卫——仍有 unmerged
 *     路径 ⇒ conflicts-remaining，plan §3.3；UI 先禁用，错误面只是兜底）；
 *   - `continueReducer`：continue 循环状态机（done:false → 刷新面板 → 下一冲突 →
 *     done:true，plan §3.8 client 清单）。
 *
 * 不依赖 DOM/React 即可断言（tests/conflict-view.spec.ts）。
 */

import type {
  ConflictCode, ConflictEntry, OperationContinueResult, OperationInProgressOp,
} from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'
import type { GitErrorLike } from './remote/mount.js'

// ── 冲突条（变更 tab 顶部；plan §3.7「常驻入口」）──

/** 中间态 op → 徽标词典键（「正在 cherry-pick」等）。 */
const OPERATION_LABEL_KEYS: Readonly<Record<OperationInProgressOp, GitLocaleKey>> = Object.freeze({
  'cherry-pick': 'conflict.operation.cherry-pick',
  'revert': 'conflict.operation.revert',
  'merge': 'conflict.operation.merge',
  'rebase': 'conflict.operation.rebase',
})

/** 冲突条渲染模型。 */
export interface ConflictBarView {
  /**
   * 可见 = conflicted 计数非空（常驻入口——不依赖错误路径，plan §3.7）**或**中间态
   * 仍在场。后者是 continue 循环的可驱性要求：最后一个冲突解决后计数归零，但
   * sequencer 停在中间态等待「继续操作」——此时条必须仍在（否则面板随条卸载，
   * continue/abort 无入口）。
   */
  visible: boolean
  /** 冲突文件数（status 快照 conflicted 组计数；中间态在场可为 0）。 */
  count: number
  /** 条主文案键：有冲突 → conflict.bar.label（{count}）；冲突清零但操作未完 → conflict.bar.resolved。 */
  labelKey: GitLocaleKey
  /** 主文案插值参数（label 形态 = {count}）。 */
  params: Record<string, unknown>
  /** operation 徽标词典键；null = 裸冲突（无中间态）或清单未加载。 */
  operationKey: GitLocaleKey | null
}

/**
 * 冲突条视图（纯函数）：`count` = status 快照 conflicted 组长度（常驻判据）；
 * `operation` = conflictList 的探测结果（清单未加载时 null——徽标随首查出现；
 * 摘要未加载而计数 > 0 时可见性由计数独立成立，不依赖清单回包）。
 */
export function conflictBarView(count: number, operation: OperationInProgressOp | null): ConflictBarView {
  const visible = count > 0 || operation !== null
  return {
    visible,
    count,
    labelKey: count > 0 ? 'conflict.bar.label' : 'conflict.bar.resolved',
    params: count > 0 ? { count } : {},
    operationKey: operation === null ? null : OPERATION_LABEL_KEYS[operation],
  }
}

// ── 冲突面板文件行（code/kind 徽标 + 按钮可用性矩阵）──

/** 面板文件行渲染模型。 */
export interface ConflictRowView {
  /** -z 原样路径（repo 相对）。 */
  path: string
  /** porcelain v2 unmerged 七码徽标（原样码字）。 */
  code: ConflictCode
  /** kind 徽标词典键（conflict.kind.*）。 */
  kindKey: GitLocaleKey
  /** 「保留我方（ours）」按钮可用 = oursExists（wire 推导——不可向禁用，plan §3.2）。 */
  oursEnabled: boolean
  /** 「采用对方（theirs）」按钮可用 = theirsExists。 */
  theirsEnabled: boolean
  /** DD 两向同效确认态（§3.4 DD 行：ours/theirs 同命令——单按钮 + 显式确认）。 */
  ddSymmetric: boolean
}

const KIND_KEYS: Readonly<Record<ConflictEntry['kind'], GitLocaleKey>> = Object.freeze({
  modified: 'conflict.kind.modified',
  added: 'conflict.kind.added',
  deleted: 'conflict.kind.deleted',
})

/**
 * ConflictListResult.conflicts → 面板行模型（纯函数）。按钮可用性矩阵
 * （§3.8「矩阵→按钮可用性」）：
 *   UU/AA 双侧在场 → 双钮可用；AU/UD 仅 ours；UA/DU 仅 theirs；DD 双删 → 双钮禁用 +
 *   ddSymmetric（显式确认的「接受删除」单钮路径）。
 */
export function conflictRows(conflicts: readonly ConflictEntry[]): ConflictRowView[] {
  return conflicts.map((entry) => ({
    path: entry.path,
    code: entry.code,
    kindKey: KIND_KEYS[entry.kind],
    oursEnabled: entry.oursExists,
    theirsEnabled: entry.theirsExists,
    ddSymmetric: entry.code === 'DD',
  }))
}

/**
 * DD「接受删除」的 wire 决议（纯函数）：两向在 host 矩阵同命令（DD ours = theirs =
 * `git rm`，host/src/conflicts.ts RESOLUTION_MATRIX:105）——显式确认后以 'ours' 过线
 * （记录性标签，效果与 'theirs' 逐命令相同）。
 */
export function ddAcceptDeleteChoice(path: string): { path: string; resolution: 'ours' } {
  return { path, resolution: 'ours' }
}

// ── 面板动作可用性 ──

/** 底部 继续操作/放弃操作 的可用闸：中间态在场（abortable = operation ≠ null，host conflictList 契约）。 */
export function operationActionsEnabled(operation: OperationInProgressOp | null): boolean {
  return operation !== null
}

/**
 * 「继续操作」的客户端守卫：中间态在场 **且** unmerged 已清空（镜像 host 零命令守卫
 * ——仍有 unmerged 路径 ⇒ bad-request 'conflicts-remaining'，plan §3.3；UI 侧先禁用，
 * 错误条只是兜底）。
 */
export function continueEnabled(operation: OperationInProgressOp | null, unresolvedCount: number): boolean {
  return operation !== null && unresolvedCount === 0
}

// ── continue 循环状态机（§3.8「done:false→刷新→done:true」）──

/** continue 循环的阶段。 */
export type ContinuePhase = 'idle' | 'running' | 'next-conflict' | 'done' | 'error'

/** continue 循环状态（组件渲染依据）。 */
export interface ContinueState {
  phase: ContinuePhase
  /** done:false 时的下一批冲突路径（fresh 回读——面板刷新的对照面）。 */
  conflicted: readonly string[]
  /** error 时的错误投影。 */
  error: GitErrorLike | null
}

/** continue 循环事件（组件动作 → 归约）。 */
export type ContinueEvent =
  | { type: 'invoke' }
  | { type: 'progress'; result: OperationContinueResult }
  | { type: 'fail'; error: GitErrorLike }
  | { type: 'reset' }

/**
 * continue 循环状态机（纯归约——tests/conflict-view.spec 断言闭环）。归约是事件源：
 * progress/fail 的新态完全由事件定（wire 的 done/conflicted 已是 fresh 回读），前一态
 * 不参与（`_state` 仅保留归约形状——组件侧 `setState((s) => continueReducer(s, e))`）。
 */
export function continueReducer(_state: ContinueState, event: ContinueEvent): ContinueState {
  switch (event.type) {
    case 'invoke':
      return { phase: 'running', conflicted: [], error: null }
    case 'progress':
      // 冲突是返回值不是错误（plan §3.2）：done:false = sequencer 停在下一冲突——
      // 面板刷新后进入下一轮；done:true = 全部完成。
      return event.result.done
        ? { phase: 'done', conflicted: [], error: null }
        : { phase: 'next-conflict', conflicted: event.result.conflicted, error: null }
    case 'fail':
      return { phase: 'error', conflicted: [], error: event.error }
    case 'reset':
      return { phase: 'idle', conflicted: [], error: null }
  }
}

/** continue 状态机的初始态。 */
export function initialContinueState(): ContinueState {
  return { phase: 'idle', conflicted: [], error: null }
}

/** continue 完成提示的词典键（done/next-conflict 两态；其余 null 不渲染）。 */
export function continueHintKey(state: ContinueState): GitLocaleKey | null {
  if (state.phase === 'done') return 'conflict.continueDone'
  if (state.phase === 'next-conflict') return 'conflict.continueNext'
  return null
}
