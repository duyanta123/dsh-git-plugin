/**
 * [61] 子模块状态详情纯视图模型测试（V2 批次四；plan §6.6——详情面板行模型）。
 */

import { describe, expect, it } from 'vitest'
import type { SubmoduleEntry } from 'dsh-gitkit/types'
import { submoduleRows, submoduleStateKey } from '../src/client/submodule-view-model.ts'

function entry(partial: Partial<SubmoduleEntry> & Pick<SubmoduleEntry, 'path'>): SubmoduleEntry {
  return { oid: null, recordedOid: null, state: 'clean', ...partial }
}

describe('submoduleRows — 行模型', () => {
  it('clean 行：oid 一致不标记差异；state 徽标键映射', () => {
    const rows = submoduleRows([entry({ path: 'libs/a', oid: 'a1', recordedOid: 'a1', state: 'clean' })])
    expect(rows).toEqual([{
      path: 'libs/a',
      oid: 'a1',
      recordedOid: 'a1',
      mismatch: false,
      stateKey: 'submodule.state.clean',
    }])
  })

  it('mismatch 状态行（host 判定）⇒ 差异高亮；oid 与记录不一致（client 复核）同样标记', () => {
    const hostJudged = submoduleRows([entry({ path: 'libs/a', oid: 'a1', recordedOid: 'a2', state: 'mismatch' })])
    expect(hostJudged[0]?.mismatch).toBe(true)
    const clientChecked = submoduleRows([entry({ path: 'libs/b', oid: 'b9', recordedOid: 'b1', state: 'clean' })])
    expect(clientChecked[0]?.mismatch).toBe(true)
  })

  it('uninitialized（未初始化）：oid null ⇒ 无差异可言，state 徽标「未初始化」', () => {
    const rows = submoduleRows([entry({ path: 'libs/c', oid: null, recordedOid: 'c1', state: 'uninitialized' })])
    expect(rows[0]?.oid).toBeNull()
    expect(rows[0]?.mismatch).toBe(false)
    expect(rows[0]?.stateKey).toBe('submodule.state.uninitialized')
  })

  it('dirty / unknown 徽标键；行序保持 host 返回序', () => {
    const rows = submoduleRows([
      entry({ path: 'x', state: 'dirty' }),
      entry({ path: 'y', state: 'unknown' }),
    ])
    expect(rows.map((row) => row.stateKey)).toEqual(['submodule.state.dirty', 'submodule.state.unknown'])
    expect(rows.map((row) => row.path)).toEqual(['x', 'y'])
  })
})

describe('submoduleStateKey — state 联合闭合映射（未知形状安全降级）', () => {
  it('wire 联合五态逐键', () => {
    expect(submoduleStateKey('clean')).toBe('submodule.state.clean')
    expect(submoduleStateKey('dirty')).toBe('submodule.state.dirty')
    expect(submoduleStateKey('uninitialized')).toBe('submodule.state.uninitialized')
    expect(submoduleStateKey('mismatch')).toBe('submodule.state.mismatch')
    expect(submoduleStateKey('unknown')).toBe('submodule.state.unknown')
  })

  it('形状漂移（undefined/陌生值）⇒ unknown 键', () => {
    expect(submoduleStateKey(undefined)).toBe('submodule.state.unknown')
    expect(submoduleStateKey('future-state')).toBe('submodule.state.unknown')
  })
})
