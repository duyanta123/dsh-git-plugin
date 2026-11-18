/**
 * 冲突条/冲突面板纯视图模型单测（V3 批次一 [13]；v3-implementation-plan §3.8
 * client 清单「新 conflict-view.spec.ts：冲突条可见性/矩阵→按钮可用性/DD 两向同效
 * 确认态/continue 循环状态机 done:false→刷新→done:true」）。
 *
 * 被测面 = src/client/conflict-view-model.ts；danger 勾选闸的闸逻辑复用
 * ui-model.confirmButtonEnabled（GitConfirmDialog 同款——本 spec 断言接线）。
 */

import { describe, expect, it } from 'vitest'
import type { ConflictEntry, ConflictListResult, OperationContinueResult } from 'dsh-gitkit/types'
import {
  conflictBarView, conflictRows, continueEnabled, continueHintKey, continueReducer,
  ddAcceptDeleteChoice, initialContinueState, operationActionsEnabled,
} from '../src/client/conflict-view-model.ts'
import type { ConflictRowView } from '../src/client/conflict-view-model.ts'
import { confirmButtonEnabled } from '../src/client/ui-model.ts'

/** 七码夹具（X/Y 码 → wire 条目；oursExists/theirsExists 按 host
 * conflicts.ts CONFLICT_CODE_EXISTS:77-85 的推导值）。 */
function mkEntry(code: ConflictEntry['code'], path: string): ConflictEntry {
  const kind: Record<ConflictEntry['code'], ConflictEntry['kind']> = {
    DD: 'deleted', AU: 'added', UD: 'deleted', UA: 'added', DU: 'deleted', AA: 'added', UU: 'modified',
  }
  const exists: Record<ConflictEntry['code'], { ours: boolean; theirs: boolean }> = {
    DD: { ours: false, theirs: false },
    AU: { ours: true, theirs: false },
    UD: { ours: true, theirs: false },
    UA: { ours: false, theirs: true },
    DU: { ours: false, theirs: true },
    AA: { ours: true, theirs: true },
    UU: { ours: true, theirs: true },
  }
  return { path, code, kind: kind[code], oursExists: exists[code].ours, theirsExists: exists[code].theirs }
}

/** 单条目 → 单行模型（夹具恒单元素，索引非空以断言收窄——host conflicts.ts `!` 同款）。 */
function rowOf(code: ConflictEntry['code'], path = 'f.txt'): ConflictRowView {
  return conflictRows([mkEntry(code, path)])[0]!
}

describe('冲突条可见性（plan §3.7「status.conflicted 非空常驻——不依赖错误路径」）', () => {
  it('计数 > 0 可见，主文案 = conflict.bar.label（{count}）；operation 在场 → 徽标键（四 op 词汇）', () => {
    expect(conflictBarView(3, 'cherry-pick')).toEqual({
      visible: true, count: 3, labelKey: 'conflict.bar.label', params: { count: 3 },
      operationKey: 'conflict.operation.cherry-pick',
    })
    expect(conflictBarView(1, 'revert')?.operationKey).toBe('conflict.operation.revert')
    expect(conflictBarView(2, 'merge')?.operationKey).toBe('conflict.operation.merge')
    expect(conflictBarView(5, 'rebase')?.operationKey).toBe('conflict.operation.rebase')
  })

  it('计数 > 0 且清单未加载（operation null）→ 可见但无徽标（可见性由计数独立成立，不依赖清单回包）', () => {
    expect(conflictBarView(2, null)).toEqual({
      visible: true, count: 2, labelKey: 'conflict.bar.label', params: { count: 2 }, operationKey: null,
    })
  })

  it('计数 = 0 但中间态在场 → 仍可见（主文案 = conflict.bar.resolved；continue 循环可驱性——面板不得随条撤走）', () => {
    expect(conflictBarView(0, 'cherry-pick')).toEqual({
      visible: true, count: 0, labelKey: 'conflict.bar.resolved', params: {},
      operationKey: 'conflict.operation.cherry-pick',
    })
  })

  it('计数 = 0 且无中间态 → 不可见（裸工作区/冲突全清且操作已终结；labelKey 取 count 形态——不可见时该字段惰性）', () => {
    expect(conflictBarView(0, null)).toEqual({
      visible: false, count: 0, labelKey: 'conflict.bar.resolved', params: {}, operationKey: null,
    })
  })
})

describe('按钮可用性矩阵（plan §3.8「矩阵→按钮可用性」；wire oursExists/theirsExists 驱动禁用）', () => {
  it('UU/AA 双侧在场 → 双钮可用；kind 徽标按 host 推导', () => {
    for (const code of ['UU', 'AA'] as const) {
      const row = rowOf(code)
      expect(row.oursEnabled, code).toBe(true)
      expect(row.theirsEnabled, code).toBe(true)
      expect(row.ddSymmetric, code).toBe(false)
    }
    expect(rowOf('UU').kindKey).toBe('conflict.kind.modified')
    expect(rowOf('AA').kindKey).toBe('conflict.kind.added')
  })

  it('删除侧不可向：AU/UD 仅 ours；UA/DU 仅 theirs（不可向禁用——plan §3.2）', () => {
    const au = rowOf('AU', 'a.txt')
    expect(au.oursEnabled).toBe(true)
    expect(au.theirsEnabled).toBe(false)
    const ud = rowOf('UD', 'b.txt')
    expect(ud.oursEnabled).toBe(true)
    expect(ud.theirsEnabled).toBe(false)
    const ua = rowOf('UA', 'c.txt')
    expect(ua.oursEnabled).toBe(false)
    expect(ua.theirsEnabled).toBe(true)
    const du = rowOf('DU', 'd.txt')
    expect(du.oursEnabled).toBe(false)
    expect(du.theirsEnabled).toBe(true)
    // 删除类码的 kind 徽标 = deleted（UD/DU/DD）。
    expect(ud.kindKey).toBe('conflict.kind.deleted')
    expect(du.kindKey).toBe('conflict.kind.deleted')
  })

  it('DD 双删 → 双钮禁用 + ddSymmetric 确认态（plan §3.4「两向同效，UI 显式确认」）', () => {
    const dd = rowOf('DD', 'gone.txt')
    expect(dd.oursEnabled).toBe(false)
    expect(dd.theirsEnabled).toBe(false)
    expect(dd.ddSymmetric).toBe(true)
    expect(dd.kindKey).toBe('conflict.kind.deleted')
  })

  it('DD 的 wire 决议 = "ours"（host RESOLUTION_MATRIX DD 两向同命令 [rm]——记录性标签）', () => {
    expect(ddAcceptDeleteChoice('gone.txt')).toEqual({ path: 'gone.txt', resolution: 'ours' })
    // 与 theirs 同效的语义锚：七码矩阵里 DD 是唯一双钮全禁用码（上方断言），唯一
    // ddSymmetric 码（逐码扫描复核）。
    const symmetricCodes = (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'] as const)
      .filter((code) => rowOf(code, 'x').ddSymmetric)
    expect(symmetricCodes).toEqual(['DD'])
  })
})

describe('面板动作可用闸（plan §3.3 守卫镜像）', () => {
  it('继续/放弃闸：中间态在场可用；裸冲突（operation null）双禁用', () => {
    expect(operationActionsEnabled('cherry-pick')).toBe(true)
    expect(operationActionsEnabled(null)).toBe(false)
  })

  it('继续操作客户端守卫 = 中间态在场 且 unmerged 清空（镜像 conflicts-remaining 零命令守卫）', () => {
    expect(continueEnabled('merge', 0)).toBe(true)
    expect(continueEnabled('merge', 2)).toBe(false)
    expect(continueEnabled(null, 0)).toBe(false)
  })
})

describe('continue 循环状态机（plan §3.8「done:false→刷新→done:true」）', () => {
  const nextConflict: OperationContinueResult = { op: 'cherry-pick', done: false, conflicted: ['n1.txt', 'n2.txt'] }
  const finished: OperationContinueResult = { op: 'cherry-pick', done: true, conflicted: [] }

  it('闭环：idle → invoke → running → done:false → next-conflict（携带 conflicted）→ invoke → running → done:true → done', () => {
    let state = initialContinueState()
    expect(state.phase).toBe('idle')
    state = continueReducer(state, { type: 'invoke' })
    expect(state.phase).toBe('running')
    state = continueReducer(state, { type: 'progress', result: nextConflict })
    expect(state.phase).toBe('next-conflict')
    expect(state.conflicted).toEqual(['n1.txt', 'n2.txt'])
    expect(continueHintKey(state)).toBe('conflict.continueNext')
    state = continueReducer(state, { type: 'invoke' }) // 面板刷新后进入下一轮
    expect(state.phase).toBe('running')
    state = continueReducer(state, { type: 'progress', result: finished })
    expect(state.phase).toBe('done')
    expect(state.conflicted).toEqual([])
    expect(continueHintKey(state)).toBe('conflict.continueDone')
  })

  it('失败路径：running → fail → error（携带错误投影）；reset 归 idle', () => {
    let state = continueReducer(initialContinueState(), { type: 'invoke' })
    state = continueReducer(state, { type: 'fail', error: { code: 'git/git-error', message: 'boom' } })
    expect(state.phase).toBe('error')
    expect(state.error?.code).toBe('git/git-error')
    expect(continueHintKey(state)).toBeNull()
    state = continueReducer(state, { type: 'reset' })
    expect(state).toEqual({ phase: 'idle', conflicted: [], error: null })
  })

  it('done 判定只看 result.done（done:true 恒清 conflicted；done:false 保留 fresh 回读清单）', () => {
    const fromNext = continueReducer(
      continueReducer(initialContinueState(), { type: 'invoke' }),
      { type: 'progress', result: nextConflict },
    )
    const doneFromNext = continueReducer(fromNext, { type: 'progress', result: finished })
    expect(doneFromNext.phase).toBe('done')
    expect(doneFromNext.conflicted).toEqual([])
  })
})

describe('abort danger 闸接线（plan §3.7「放弃操作——danger 勾选闸」）', () => {
  it('abort 的对话框 severity 恒 danger ⇒ confirmButtonEnabled 未勾选禁用、勾选放行', () => {
    // 组件以 severity='danger' 渲染 GitConfirmDialog（GitConflictPanel 装配）；
    // 闸逻辑复用 ui-model.confirmButtonEnabled（stash drop 同款断言面）。
    expect(confirmButtonEnabled('danger', false)).toBe(false)
    expect(confirmButtonEnabled('danger', true)).toBe(true)
  })

  it('abort 可用闸 = 中间态在场（abortable 与 operation 同源——host conflictList 契约）', () => {
    const withOp: ConflictListResult = { conflicts: [], operation: 'revert', abortable: true }
    const bare: ConflictListResult = { conflicts: [mkEntry('UU', 'x')], operation: null, abortable: false }
    expect(operationActionsEnabled(withOp.operation)).toBe(true)
    expect(operationActionsEnabled(bare.operation)).toBe(false)
    expect(withOp.abortable).toBe(true)
    expect(bare.abortable).toBe(false)
  })
})
