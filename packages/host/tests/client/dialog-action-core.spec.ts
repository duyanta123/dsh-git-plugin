/**
 * Phase 2·client 前置 — useDialogAction 契约的纯函数半（**TDD 红**：当前
 * `../src/client/hooks/dialog-action-core.ts` 尚不存在，交 Hook 提炼师实现；
 * 本 spec 不得被兜底实现"转绿"——断言即契约）。
 *
 * 环境事实（为何有本文件）：vitest 全局 node 环境且仓库无 jsdom/testing-library
 * 基建（graph-error-surfaces.spec.ts 文件头同证），react-test-renderer 未安装且
 * 禁装新依赖（jsdom/happy-dom/react-test-renderer require.resolve 探测全部
 * NOT RESOLVABLE，2026-11-21 实测）——hook 无法交互式渲染（act 无渲染器可用）。
 * 按任务口径退化为「提炼 reducer 纯函数」：本文件锁 stepDialogAction 状态机契约；
 * hook 绑定面的可渲染半（返回面/初值）在 useDialogAction.spec.ts（SSR 探针），
 * 交互半的实现契约在提交说明 locked 清单（先 commit state 再消费 done 的时序、
 * run 的同步 ref 闸、载波炸折叠）。
 *
 * 状态机契约（stepDialogAction 返回 `{ state, done }`）：
 *   - `open-changed`：仅 **false→true 边沿**重置 pending/error（防陈旧错误跨框残留）；
 *   - `run-start`：pending 翻 true；pending 已 true 时 no-op（防重入的双保险半——
 *     hook 侧另有同步 ref 闸，props.run 不被再调）；
 *   - `run-settled`：pending=false；成功（result.ok）⇒ error=null + done=result.value
 *     （**state 已结算与 done 在同一步返回**——hook「先 commit state 再消费 done」
 *     即结构性满足「先置 pending=false 再调 onDone」）；失败 ⇒ error=result.error
 *     （**逐字保留含 details**）+ done=null（失败零回调）；
 *   - `error-set`：setError 透传（含 null 清除），pending 不变。
 */

import { describe, expect, it } from 'vitest'
import type { GitErrorLike, RemoteResult } from '../../src/client/remote/mount.ts'
import type { DialogActionState } from '../../src/client/hooks/dialog-action-core.ts'
import { createInitialDialogActionState, stepDialogAction } from '../../src/client/hooks/dialog-action-core.ts'

const err = (code: string, message = 'boom'): GitErrorLike => ({ code, message })

describe('dialog-action-core — useDialogAction 状态机契约（TDD 红：交 Hook 提炼师实现）', () => {
  it('createInitialDialogActionState：{ open:false, pending:false, error:null }', () => {
    expect(createInitialDialogActionState()).toEqual({ open: false, pending: false, error: null })
  })

  it('open-changed false→true 边沿重置：pending=false、error=null（此前 pending=true 且带错误也清）', () => {
    const seeded: DialogActionState = { open: false, pending: true, error: err('git/push-rejected') }
    const step = stepDialogAction<string>(seeded, { type: 'open-changed', open: true })
    expect(step.state).toEqual({ open: true, pending: false, error: null })
    expect(step.done).toBeNull()
  })

  it('open-changed true→true 非边沿：pending/error 原样保留（重置只认 false→true 边沿）', () => {
    const seeded: DialogActionState = { open: true, pending: true, error: err('git/push-rejected') }
    const step = stepDialogAction<string>(seeded, { type: 'open-changed', open: true })
    expect(step.state).toEqual({ open: true, pending: true, error: err('git/push-rejected') })
    expect(step.done).toBeNull()
  })

  it('open-changed →false：open 落 false、pending/error 原样（关闭不重置——下次 open 边沿才清）', () => {
    const seeded: DialogActionState = { open: true, pending: true, error: err('git/x') }
    const step = stepDialogAction<string>(seeded, { type: 'open-changed', open: false })
    expect(step.state).toEqual({ open: false, pending: true, error: err('git/x') })
    expect(step.done).toBeNull()
  })

  it('run-start：pending false→true、error 保持、done=null', () => {
    const step = stepDialogAction<string>(createInitialDialogActionState(), { type: 'run-start' })
    expect(step.state).toEqual({ open: false, pending: true, error: null })
    expect(step.done).toBeNull()
  })

  it('run-start 防重入：pending=true 时 no-op（state 原样、零 done——重入双保险的 reducer 半）', () => {
    const seeded: DialogActionState = { open: true, pending: true, error: err('git/x') }
    const step = stepDialogAction<string>(seeded, { type: 'run-start' })
    expect(step.state).toEqual({ open: true, pending: true, error: err('git/x') })
    expect(step.done).toBeNull()
  })

  it('run-settled 成功：pending=false + error=null + done=value（同一步返回——hook 先 commit 后消费 done 即满足「先置 pending=false 再调 onDone」时序）', () => {
    const seeded: DialogActionState = { open: true, pending: true, error: err('git/stale-from-last-run') }
    const result: RemoteResult<string> = { ok: true, value: 'pr-url' }
    const step = stepDialogAction<string>(seeded, { type: 'run-settled', result })
    expect(step.state).toEqual({ open: true, pending: false, error: null })
    expect(step.done).toBe('pr-url')
  })

  it('run-settled 失败：pending=false + error=result.error 逐字保留（details 不剥）+ done=null（失败零回调）', () => {
    const failure: RemoteResult<string> = {
      ok: false,
      error: { code: 'git/pr-create-failed', message: 'gh failed', details: { stderr: 'redacted' } },
    }
    const step = stepDialogAction<string>({ open: true, pending: true, error: null }, { type: 'run-settled', result: failure })
    expect(step.state).toEqual({
      open: true,
      pending: false,
      error: { code: 'git/pr-create-failed', message: 'gh failed', details: { stderr: 'redacted' } },
    })
    expect(step.done).toBeNull()
  })

  it('error-set：setError 透传（对象置入 / null 清除），pending 不变、done=null', () => {
    const idle = createInitialDialogActionState()
    const set = stepDialogAction<string>(idle, { type: 'error-set', error: err('git/bad-request', 'bad') })
    expect(set.state).toEqual({ open: false, pending: false, error: err('git/bad-request', 'bad') })
    expect(set.done).toBeNull()
    const clear = stepDialogAction<string>(set.state, { type: 'error-set', error: null })
    expect(clear.state).toEqual({ open: false, pending: false, error: null })
    const duringPending = stepDialogAction<string>({ open: true, pending: true, error: null }, { type: 'error-set', error: err('git/y') })
    expect(duringPending.state.pending).toBe(true)
    expect(duringPending.state.error).toEqual(err('git/y'))
  })
})
