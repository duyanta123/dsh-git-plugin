/**
 * dsh-gitkit — useDialogAction：Dialog 异步动作样板 hook（Phase 2·client 收敛；
 * 8 个 Dialog 的 open 重置 effect + pending/error + 「成功先置 pending=false 再调
 * onDone」时序 + 防重入的统一接线面）。
 *
 * 实现契约（交互半不可渲染驱动，见 tests/dialog-action-core.spec.ts 文件头）：
 *  - useReducer(stepDialogAction) + useEffect(open → dispatch 'open-changed')——
 *    open 重置语义（false→true 边沿清 pending/error）由 reducer 承载；
 *  - run() 首行同步 ref 闸（pending 期间二次 run 直接 resolve，props.run 不再调），
 *    先于 dispatch 与任何 await；
 *  - run() 意外 reject（非 RemoteResult 载波炸——契约补全）折叠为 dispatch
 *    run-settled{ok:false, error:{code:'gateway/service-unavailable',…}}（GATEWAY_
 *    UNAVAILABLE 单一权威，不复制字面量），pending 不得卡死；
 *  - settle 后先 dispatch（commit state，pending=false）再消费 done（调 onDone）
 *    ——「先置 pending/busy=false 再调 onDone」时序由此结构性成立。
 */

import { useEffect, useReducer, useRef } from 'react'
import { GATEWAY_UNAVAILABLE, type GitErrorLike, type RemoteResult } from '../remote/mount.js'
import { causeMessage } from '../rpc-error.js'
import type { DialogActionEvent, DialogActionState } from './dialog-action-core.js'
import { createInitialDialogActionState, stepDialogAction } from './dialog-action-core.js'

export interface UseDialogActionInput<T> {
  open: boolean
  run: () => Promise<RemoteResult<T>>
  onDone: (value: T) => void
}

export interface DialogActionFace {
  pending: boolean
  error: GitErrorLike | null
  run: () => Promise<void>
  setError: (error: GitErrorLike | null) => void
}

/** Dialog 异步动作 hook：返回面恰四键（error/pending/run/setError）。 */
export function useDialogAction<T>(input: UseDialogActionInput<T>): DialogActionFace {
  const { open, run, onDone } = input
  // reducer 接线：stepDialogAction 一步产出 {state, done}；useReducer 只吃 state 半
  // （done 由 hook 在 settle 侧消费——先 dispatch 后 onDone 的时序不变）。
  const reducer = (state: DialogActionState, event: DialogActionEvent<T>): DialogActionState =>
    stepDialogAction<T>(state, event).state
  const [state, dispatch] = useReducer(reducer, createInitialDialogActionState())
  const gateRef = useRef(false)
  // 每次渲染后捕获最新 props（ref 闸只管防重入，回调取新值防陈旧闭包）。
  const propsRef = useRef({ run, onDone })
  propsRef.current = { run, onDone }

  useEffect(() => {
    dispatch({ type: 'open-changed', open })
  }, [open])

  const trigger = (): Promise<void> => {
    // 同步 ref 闸：先于 dispatch 与任何 await——pending 期间二次 run 直接 resolve。
    if (gateRef.current) return Promise.resolve()
    gateRef.current = true
    dispatch({ type: 'run-start' })
    return propsRef.current.run().then((result) => {
      // 先 dispatch（reducer 半同一步置 pending=false / error）再消费 done。
      dispatch({ type: 'run-settled', result })
      if (result.ok) propsRef.current.onDone(result.value)
    }).catch((cause: unknown) => {
      // 载波炸折叠：非 RemoteResult 出口折叠为 gateway/service-unavailable，pending 不卡死。
      dispatch({
        type: 'run-settled',
        result: { ok: false, error: { code: GATEWAY_UNAVAILABLE, message: causeMessage(cause) } },
      })
    }).finally(() => {
      gateRef.current = false
    })
  }

  const setError = (error: GitErrorLike | null): void => {
    dispatch({ type: 'error-set', error })
  }

  return { pending: state.pending, error: state.error, run: trigger, setError }
}
