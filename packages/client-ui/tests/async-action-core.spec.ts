/**
 * Phase 2·client 前置 — useAsyncAction 契约的纯函数半（**TDD 红**：当前
 * `../src/client/hooks/async-action-core.ts` 尚不存在，交 Hook 提炼师实现）。
 *
 * 环境事实同 dialog-action-core.spec.ts 文件头（node 环境 + 无 jsdom/testing-library
 * 基建 + 禁装新依赖 ⇒ hook 交互半不可渲染驱动）→ 按任务口径退化为 reducer 纯函数
 * + **ref 闸纯函数** 契约测试。
 *
 * 两个被锁面：
 *   1. `createBusyGate` — useAsyncAction 的 ref 闸本体（**同步**翻转，先于任何 await）：
 *      同一渲染帧二次 tryEnter 必 false——这就是「根治闭包 busy 竞态」的结构点：
 *      setState 写的 busy 在同帧重渲染前不生效，闭包读到的永远是旧值；闸是同步
 *      可变位，tryEnter 的判定与置位原子同帧。leave 后可再入（busy 结束重触发）。
 *      实现契约：hook 的 trigger 首行 tryEnter，false ⇒ 直接 resolve（run prop 不再调）。
 *   2. `stepAsyncAction` — 状态机：run-start（busy 翻 true；busy 已 true ⇒ no-op
 *      双保险）、run-settled（busy=false；成功 ⇒ error=null + done=value——hook
 *      「先 commit state 再消费 done」结构性满足「busy=false 先于 onDone」；失败 ⇒
 *      error=result.error **逐字保留含 details** + done=null）、error-set（透传，
 *      busy 不变）。
 */

import { describe, expect, it } from 'vitest'
import type { GitErrorLike, RemoteResult } from '../src/client/remote/mount.ts'
import type { AsyncActionState } from '../src/client/hooks/async-action-core.ts'
import { createInitialAsyncActionState, createBusyGate, stepAsyncAction } from '../src/client/hooks/async-action-core.ts'

const err = (code: string, message = 'boom'): GitErrorLike => ({ code, message })

describe('async-action-core — BusyGate ref 闸（同帧防重入的结构点；TDD 红：交 Hook 提炼师实现）', () => {
  it('createInitialAsyncActionState：{ busy:false, error:null }', () => {
    expect(createInitialAsyncActionState()).toEqual({ busy: false, error: null })
  })

  it('同帧闸：tryEnter true → 同帧二次 tryEnter false → leave 后 tryEnter 再 true（同步翻转先于 await——闭包 busy 竞态根治点）', () => {
    const gate = createBusyGate()
    expect(gate.tryEnter()).toBe(true)
    expect(gate.tryEnter()).toBe(false)
    expect(gate.tryEnter()).toBe(false)
    gate.leave()
    expect(gate.tryEnter()).toBe(true)
    gate.leave()
    // 重复 leave 后仍可再入（闸不锁死——busy 结束的触发可重入）。
    gate.leave()
    expect(gate.tryEnter()).toBe(true)
  })

  it('闸实例隔离：两个 gate 各自独立（互不串扰）', () => {
    const a = createBusyGate()
    const b = createBusyGate()
    expect(a.tryEnter()).toBe(true)
    expect(b.tryEnter()).toBe(true)
    expect(a.tryEnter()).toBe(false)
    expect(b.tryEnter()).toBe(false)
    a.leave()
    expect(a.tryEnter()).toBe(true)
    expect(b.tryEnter()).toBe(false)
  })
})

describe('async-action-core — stepAsyncAction 状态机契约（TDD 红：交 Hook 提炼师实现）', () => {
  it('run-start：busy false→true、error 保持、done=null', () => {
    const step = stepAsyncAction<string>(createInitialAsyncActionState(), { type: 'run-start' })
    expect(step.state).toEqual({ busy: true, error: null })
    expect(step.done).toBeNull()
  })

  it('run-start 防重入：busy=true 时 no-op（state 原样、零 done——重入双保险的 reducer 半）', () => {
    const seeded: AsyncActionState = { busy: true, error: err('git/x') }
    const step = stepAsyncAction<string>(seeded, { type: 'run-start' })
    expect(step.state).toEqual({ busy: true, error: err('git/x') })
    expect(step.done).toBeNull()
  })

  it('run-settled 成功：busy=false + error=null + done=value（同一步返回——hook 先 commit 后消费 done 即满足「busy=false 先于 onDone」时序）', () => {
    const seeded: AsyncActionState = { busy: true, error: err('git/stale-from-last-run') }
    const result: RemoteResult<string> = { ok: true, value: 'done-value' }
    const step = stepAsyncAction<string>(seeded, { type: 'run-settled', result })
    expect(step.state).toEqual({ busy: false, error: null })
    expect(step.done).toBe('done-value')
  })

  it('run-settled 失败：busy=false + error=result.error 逐字保留（details 不剥）+ done=null（失败零回调）', () => {
    const failure: RemoteResult<string> = {
      ok: false,
      error: { code: 'git/push-rejected', message: 'rejected', details: { reason: 'non-fast-forward' } },
    }
    const step = stepAsyncAction<string>({ busy: true, error: null }, { type: 'run-settled', result: failure })
    expect(step.state).toEqual({
      busy: false,
      error: { code: 'git/push-rejected', message: 'rejected', details: { reason: 'non-fast-forward' } },
    })
    expect(step.done).toBeNull()
  })

  it('error-set：setError 透传（对象置入 / null 清除），busy 不变、done=null', () => {
    const idle = createInitialAsyncActionState()
    const set = stepAsyncAction<string>(idle, { type: 'error-set', error: err('git/timeout') })
    expect(set.state).toEqual({ busy: false, error: err('git/timeout') })
    expect(set.done).toBeNull()
    const clear = stepAsyncAction<string>(set.state, { type: 'error-set', error: null })
    expect(clear.state).toEqual({ busy: false, error: null })
    const duringBusy = stepAsyncAction<string>({ busy: true, error: null }, { type: 'error-set', error: err('git/y') })
    expect(duringBusy.state.busy).toBe(true)
    expect(duringBusy.state.error).toEqual(err('git/y'))
  })
})
