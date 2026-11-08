/**
 * 分支对比面板纯视图模型测试（V2 批次二 [36]/[60]；plan §4.7 client 纯函数范式）：
 * comparePanelView 两列装配 / compareEntryEnabled 入口闸。
 */

import { describe, expect, it } from 'vitest'
import { compareEntryEnabled, comparePanelView } from '../src/client/graph-compare.ts'
import { formatCommitDate } from '../src/client/graph-view-model.ts'
import type { BranchCompareResult } from 'dsh-gitkit/types'

function commit(oid: string, subject: string) {
  return {
    oid,
    parents: [],
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    authoredAt: '2026-11-01T00:00:00.000Z',
    committedAt: '2026-11-01T03:30:00.000Z',
    subject,
    body: '',
  }
}

function result(overrides: Partial<BranchCompareResult> = {}): BranchCompareResult {
  return {
    base: 'feature/a',
    compare: 'main',
    mergeBase: 'c'.repeat(40),
    ahead: [commit('a'.repeat(40), 'on main'), commit('d'.repeat(40), 'also on main')],
    behind: [commit('b'.repeat(40), 'on feature')],
    aheadCount: 2,
    behindCount: 1,
    ...overrides,
  }
}

describe('comparePanelView — BranchCompareResult → 面板渲染模型', () => {
  it('两列装配：短 oid/主题/作者/日期（formatCommitDate 形态）+ 计数透传', () => {
    const view = comparePanelView(result())
    expect(view.base).toBe('feature/a')
    expect(view.compare).toBe('main')
    expect(view.mergeBase).toBe('c'.repeat(40))
    expect(view.aheadCount).toBe(2)
    expect(view.behindCount).toBe(1)
    // 日期 = formatCommitDate 透传（本地时区形态——断言经同一函数计算，跨时区稳定）。
    expect(view.ahead).toEqual([
      { oid: 'a'.repeat(40), shortOid: 'aaaaaaa', subject: 'on main', author: 'Alice', date: formatCommitDate('2026-11-01T03:30:00.000Z') },
      { oid: 'd'.repeat(40), shortOid: 'ddddddd', subject: 'also on main', author: 'Alice', date: formatCommitDate('2026-11-01T03:30:00.000Z') },
    ])
    expect(view.behind).toHaveLength(1)
    expect(view.behind[0]?.subject).toBe('on feature')
  })

  it('空列/mergeBase null（无共同历史）安全装配', () => {
    const view = comparePanelView(result({ ahead: [], behind: [], aheadCount: 0, behindCount: 0, mergeBase: null }))
    expect(view.ahead).toEqual([])
    expect(view.behind).toEqual([])
    expect(view.mergeBase).toBeNull()
  })
})

describe('compareEntryEnabled — 「与当前分支比较」入口闸', () => {
  it('当前分支在场 ⇒ 可用；detached/unborn/无名 ⇒ 禁用；null 快照 ⇒ 禁用', () => {
    expect(compareEntryEnabled({ name: 'main', detached: false, unborn: false })).toBe(true)
    expect(compareEntryEnabled({ name: null, detached: true, unborn: false })).toBe(false)
    expect(compareEntryEnabled({ name: 'main', detached: false, unborn: true })).toBe(false)
    expect(compareEntryEnabled({ name: null, detached: false, unborn: false })).toBe(false)
    expect(compareEntryEnabled(null)).toBe(false)
  })
})
