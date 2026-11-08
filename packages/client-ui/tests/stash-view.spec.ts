/**
 * stash 面板纯视图模型单测（V2 批次三 [14]；plan §5.6/§5.7「新 stash-view.spec.ts：
 * 列表 / pop 冲突提示 / drop danger 闸 / includeUntracked 缺省勾选模型」）。
 *
 * 被测面 = src/client/stash-view-model.ts；danger 勾选闸的闸逻辑复用
 * ui-model.confirmButtonEnabled（GitConfirmDialog 同款——本 spec 断言接线）。
 */

import { describe, expect, it } from 'vitest'
import type { GitStatusSnapshot, StashEntry, StashListResult } from 'dsh-gitkit/types'
import {
  STASH_INCLUDE_UNTRACKED_DEFAULT, popConflictHint, stashChipView, stashDropConfirmView,
  stashPushDisabled, stashPushOptions, stashRows, untrackedHint,
} from '../src/client/stash-view-model.ts'
import { confirmButtonEnabled } from '../src/client/ui-model.ts'

function mkEntry(index: number): StashEntry {
  return {
    index,
    oid: 'a'.repeat(40),
    shortOid: 'aaaaaaa',
    message: `WIP on main: ${index} feat: x`,
    authoredAt: '2026-11-08T00:00:00.000Z',
  }
}

const mkSnapshot = (untrackedPaths: string[]): GitStatusSnapshot => ({
  repoRoot: 'D:/repo',
  generatedAt: '2026-11-08T00:00:00.000Z',
  branch: {
    name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: null,
    ahead: null, behind: null, detached: false, unborn: false,
  },
  staged: [], unstaged: [], untracked: untrackedPaths.map((path) => ({
    path, origPath: null, kind: 'untracked' as const, x: '?', y: '?', conflicted: false,
    binary: false, additions: null, deletions: null, submodule: false,
  })),
  conflicted: [],
  clean: untrackedPaths.length === 0,
})

describe('stash 列表渲染模型（plan §5.7「列表」）', () => {
  it('StashListResult → 行模型（index/message/shortOid 透传）', () => {
    const result: StashListResult = { stashes: [mkEntry(0), mkEntry(1)] }
    expect(stashRows(result)).toEqual([
      { index: 0, message: 'WIP on main: 0 feat: x', shortOid: 'aaaaaaa' },
      { index: 1, message: 'WIP on main: 1 feat: x', shortOid: 'aaaaaaa' },
    ])
  })

  it('空清单 → 空数组（面板显示 stash.empty）', () => {
    expect(stashRows({ stashes: [] })).toEqual([])
  })
})

describe('includeUntracked 缺省勾选模型（D4=B；plan §5.7「includeUntracked 缺省勾选模型」）', () => {
  it('缺省 = true（D4=B 拍板：默认含 untracked）', () => {
    expect(STASH_INCLUDE_UNTRACKED_DEFAULT).toBe(true)
  })

  it('stashPushOptions：勾选态显式过 wire；baseRevision null 省略字段（wire 纪律）', () => {
    expect(stashPushOptions(true, null)).toEqual({ includeUntracked: true })
    expect(stashPushOptions(false, null)).toEqual({ includeUntracked: false })
    expect(stashPushOptions(true, 'a'.repeat(40))).toEqual({ includeUntracked: true, baseRevision: 'a'.repeat(40) })
  })

  it('untracked 计数提示：untracked > 0 可见并携带计数；零 untracked 隐藏；空快照隐藏', () => {
    expect(untrackedHint(mkSnapshot(['dist/a.js', 'dist/b.js']))).toEqual({ visible: true, count: 2 })
    expect(untrackedHint(mkSnapshot([]))).toEqual({ visible: false, count: 0 })
    expect(untrackedHint(null)).toEqual({ visible: false, count: 0 })
  })
})

describe('pop 冲突提示（plan §5.10「UI 必须明示『应用失败但 stash 保留』」）', () => {
  it('git/merge-conflict（op stash-pop 复用该码）⇒ 提示可见', () => {
    expect(popConflictHint({ code: 'git/merge-conflict', message: 'conflict', details: { op: 'stash-pop', conflicted: ['a.ts'], abortable: false } })).toBe(true)
  })

  it('其它码 / 成功（null）⇒ 不可见', () => {
    expect(popConflictHint({ code: 'git/stash-not-found', message: 'gone' })).toBe(false)
    expect(popConflictHint(null)).toBe(false)
  })
})

describe('drop danger 闸（plan §5.7「drop danger 闸」）', () => {
  it('stashDropConfirmView：severity danger（GitConfirmDialog 勾选闸生效）+ {index}/{message} 插值参数', () => {
    const view = stashDropConfirmView(mkEntry(2))
    expect(view.severity).toBe('danger')
    expect(view.params).toEqual({ index: 2, message: 'WIP on main: 2 feat: x' })
    expect(view.entry.index).toBe(2)
  })

  it('danger 勾选闸接线 = ui-model.confirmButtonEnabled：未勾选禁用、勾选放行', () => {
    const view = stashDropConfirmView(mkEntry(0))
    expect(confirmButtonEnabled(view.severity, false)).toBe(false)
    expect(confirmButtonEnabled(view.severity, true)).toBe(true)
  })
})

describe('「Stash 全部变更」禁用闸 + 计数 chip', () => {
  it('不可用 / 工作区干净 / 动作在途 ⇒ 禁用；有变更且空闲 ⇒ 可用', () => {
    expect(stashPushDisabled(false, false, false)).toBe(true)
    expect(stashPushDisabled(true, true, false)).toBe(true)
    expect(stashPushDisabled(true, false, true)).toBe(true)
    expect(stashPushDisabled(true, false, false)).toBe(false)
  })

  it('chip：计数未知/为 0 → stash.chip（无计数形态）；> 0 → stash.chipCount 带 {count}', () => {
    expect(stashChipView(null)).toEqual({ labelKey: 'stash.chip', params: {} })
    expect(stashChipView(0)).toEqual({ labelKey: 'stash.chip', params: {} })
    expect(stashChipView(3)).toEqual({ labelKey: 'stash.chipCount', params: { count: 3 } })
  })
})
