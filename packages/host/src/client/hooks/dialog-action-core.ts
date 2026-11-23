/**
 * dsh-gitkit — dialog-action-core：useDialogAction 的 reducer 纯函数半
 * （Phase 2·client 样板收敛；契约见 tests/dialog-action-core.spec.ts）。
 *
 * 状态机：`open` 为内部边沿检测字段（hook 返回面不暴露）；`open-changed` 仅
 * false→true 边沿重置 pending/error（防陈旧错误跨框残留）；`run-start` pending
 * 翻 true（已 true 时 no-op——防重入双保险的 reducer 半，hook 侧另有同步 ref 闸）；
 * `run-settled` pending=false，成功 ⇒ error=null + done=value（state 已结算与 done
 * 同一步返回——hook「先 commit state 再消费 done」结构性满足「先置 pending=false
 * 再调 onDone」时序），失败 ⇒ error=result.error **逐字保留含 details** + done=null
 * （失败零回调）；`error-set` setError 透传（含 null 清除），pending 不变。
 */

import type { GitErrorLike, RemoteResult } from '../remote/mount.js'

/** useDialogAction 内部状态（open 仅为边沿检测，不进返回面）。 */
export interface DialogActionState {
  open: boolean
  pending: boolean
  error: GitErrorLike | null
}

/** useDialogAction 状态机事件。 */
export type DialogActionEvent<T> =
  | { type: 'open-changed'; open: boolean }
  | { type: 'run-start' }
  | { type: 'run-settled'; result: RemoteResult<T> }
  | { type: 'error-set'; error: GitErrorLike | null }

/** stepDialogAction 一步的产出：已结算 state 与（成功时）待消费 value。 */
export interface DialogActionStep<T> {
  state: DialogActionState
  done: T | null
}

/** 初始态：{ open:false, pending:false, error:null }。 */
export function createInitialDialogActionState(): DialogActionState {
  return { open: false, pending: false, error: null }
}

/** reducer 纯函数（useReducer 直接接线）。 */
export function stepDialogAction<T>(state: DialogActionState, event: DialogActionEvent<T>): DialogActionStep<T> {
  switch (event.type) {
    case 'open-changed': {
      // 仅 false→true 边沿重置（true→true 非边沿、→false 关闭均不重置）。
      if (state.open === false && event.open === true) {
        return { state: { open: true, pending: false, error: null }, done: null }
      }
      return { state: { ...state, open: event.open }, done: null }
    }
    case 'run-start': {
      // 防重入：pending 已 true 时 no-op（state 原样、零 done）。
      if (state.pending) return { state, done: null }
      return { state: { ...state, pending: true }, done: null }
    }
    case 'run-settled': {
      if (event.result.ok) {
        return { state: { ...state, pending: false, error: null }, done: event.result.value }
      }
      // 失败：error 逐字保留（含 details，不剥不重组）；done=null（失败零回调）。
      return { state: { ...state, pending: false, error: event.result.error }, done: null }
    }
    case 'error-set': {
      return { state: { ...state, error: event.error }, done: null }
    }
  }
}
