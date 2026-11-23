/**
 * dsh-gitkit — async-action-core：useAsyncAction 的 reducer 纯函数半 + ref 闸
 * 本体（Phase 2·client 样板收敛；契约见 tests/async-action-core.spec.ts）。
 *
 * `createBusyGate` — 同步翻转闸：tryEnter 的判定与置位原子同帧，先于任何 await
 * ——「根治闭包 busy 竞态」的结构点（setState 写的 busy 同帧不生效而闸生效）；
 * leave 后可再入（重复 leave 也不锁死）；实例间隔离。
 *
 * `stepAsyncAction` 状态机：run-start busy 翻 true（已 true ⇒ no-op 双保险）；
 * run-settled busy=false，成功 ⇒ error=null + done=value，失败 ⇒ error=result.error
 * **逐字保留含 details** + done=null（失败零回调）；error-set 透传，busy 不变。
 */

import type { GitErrorLike, RemoteResult } from '../remote/mount.js'

/** useAsyncAction 内部状态。 */
export interface AsyncActionState {
  busy: boolean
  error: GitErrorLike | null
}

/** useAsyncAction 状态机事件。 */
export type AsyncActionEvent<T> =
  | { type: 'run-start' }
  | { type: 'run-settled'; result: RemoteResult<T> }
  | { type: 'error-set'; error: GitErrorLike | null }

/** stepAsyncAction 一步的产出：已结算 state 与（成功时）待消费 value。 */
export interface AsyncActionStep<T> {
  state: AsyncActionState
  done: T | null
}

/** 初始态：{ busy:false, error:null }。 */
export function createInitialAsyncActionState(): AsyncActionState {
  return { busy: false, error: null }
}

/**
 * 同步 busy 闸：trigger 首行 tryEnter（false ⇒ 直接 resolve，run prop 不再调）；
 * settle 后 leave。同一渲染帧二次 tryEnter 必 false——闭包 busy 竞态的根治点。
 */
export interface BusyGate {
  tryEnter(): boolean
  leave(): void
}

/** createBusyGate：每个实例独立可变位（实例间互不串扰）。 */
export function createBusyGate(): BusyGate {
  let entered = false
  return {
    tryEnter(): boolean {
      if (entered) return false
      entered = true
      return true
    },
    leave(): void {
      entered = false
    },
  }
}

/** reducer 纯函数（useReducer 直接接线）。 */
export function stepAsyncAction<T>(state: AsyncActionState, event: AsyncActionEvent<T>): AsyncActionStep<T> {
  switch (event.type) {
    case 'run-start': {
      // 防重入：busy 已 true 时 no-op（state 原样、零 done）。
      if (state.busy) return { state, done: null }
      return { state: { ...state, busy: true }, done: null }
    }
    case 'run-settled': {
      if (event.result.ok) {
        return { state: { ...state, busy: false, error: null }, done: event.result.value }
      }
      // 失败：error 逐字保留（含 details，不剥不重组）；done=null（失败零回调）。
      return { state: { ...state, busy: false, error: event.result.error }, done: null }
    }
    case 'error-set': {
      return { state: { ...state, error: event.error }, done: null }
    }
  }
}
