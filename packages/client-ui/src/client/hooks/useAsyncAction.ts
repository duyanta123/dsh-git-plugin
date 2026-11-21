/**
 * dsh-gitkit-ui — useAsyncAction：通用异步动作样板 hook（Phase 2·client 收敛；
 * busy/error/trigger/setError 统一面，根治「读闭包 busy」的双击竞态）。
 *
 * 实现契约（交互半不可渲染驱动，见 tests/async-action-core.spec.ts 文件头）：
 *  - trigger 首行 createBusyGate().tryEnter()（false ⇒ resolve，run prop 不再调
 *    ——同一渲染帧二次触发被忽略：闸同步翻转先于任何 await，setState 写的 busy
 *    同帧不生效而闸生效）；
 *  - busy 翻转/错误折叠/成功回调时序同 useDialogAction（先 dispatch 后消费 done）；
 *  - run() 意外 reject（载波炸）折叠为 gateway/service-unavailable，busy 不卡死；
 *  - setError 与 optional onDone 为契约补全。
 */

import { useReducer, useRef } from 'react'
import { GATEWAY_UNAVAILABLE, type GitErrorLike, type RemoteResult } from '../remote/mount.js'
import { causeMessage } from '../rpc-error.js'
import type { AsyncActionEvent, AsyncActionState } from './async-action-core.js'
import { createBusyGate, createInitialAsyncActionState, stepAsyncAction } from './async-action-core.js'

export interface UseAsyncActionInput<T> {
  run: () => Promise<RemoteResult<T>>
  onDone?: (value: T) => void
}

export interface AsyncActionFace {
  busy: boolean
  error: GitErrorLike | null
  trigger: () => Promise<void>
  setError: (error: GitErrorLike | null) => void
}

/** 通用异步动作 hook：返回面恰四键（busy/error/setError/trigger）。 */
export function useAsyncAction<T>(input: UseAsyncActionInput<T>): AsyncActionFace {
  const { run, onDone } = input
  // reducer 接线：stepAsyncAction 一步产出 {state, done}；useReducer 只吃 state 半
  // （done 由 hook 在 settle 侧消费——先 dispatch 后 onDone 的时序不变）。
  const reducer = (state: AsyncActionState, event: AsyncActionEvent<T>): AsyncActionState =>
    stepAsyncAction<T>(state, event).state
  const [state, dispatch] = useReducer(reducer, createInitialAsyncActionState())
  const gateRef = useRef(createBusyGate())
  const propsRef = useRef({ run, onDone })
  propsRef.current = { run, onDone }

  const trigger = (): Promise<void> => {
    // 同步闸：先于 dispatch 与任何 await——同帧二次触发被忽略。
    if (!gateRef.current.tryEnter()) return Promise.resolve()
    dispatch({ type: 'run-start' })
    return propsRef.current.run().then((result) => {
      // 先 dispatch（同一步置 busy=false / error）再消费 done。
      dispatch({ type: 'run-settled', result })
      if (result.ok) propsRef.current.onDone?.(result.value)
    }).catch((cause: unknown) => {
      // 载波炸折叠：非 RemoteResult 出口折叠为 gateway/service-unavailable，busy 不卡死。
      dispatch({
        type: 'run-settled',
        result: { ok: false, error: { code: GATEWAY_UNAVAILABLE, message: causeMessage(cause) } },
      })
    }).finally(() => {
      gateRef.current.leave()
    })
  }

  const setError = (error: GitErrorLike | null): void => {
    dispatch({ type: 'error-set', error })
  }

  return { busy: state.busy, error: state.error, trigger, setError }
}
