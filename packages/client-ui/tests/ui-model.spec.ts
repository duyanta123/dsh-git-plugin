/**
 * UI 纯视图模型测试（C1 GitHeaderButton 的渲染决策 + C5 确认闸——本模块 ask §③/④；
 * spec §6 纯函数单测纪律：分支名/角标/detached/unborn/禁用态不依赖 DOM 断言）。
 */

import { describe, expect, it } from 'vitest'
import { badgeCount, confirmButtonEnabled, headerMenuItems, headerViewModel } from '../src/client/ui-model.ts'
import type { GitStatusSourceState } from '../src/client/store/git-status-source.ts'
import type { GitStatusSnapshot } from '@dsh-plugin/git/types'

function mkState(overrides: Partial<GitStatusSourceState> = {}): GitStatusSourceState {
  return {
    repo: { available: false, root: null, checking: true },
    status: null,
    statusError: null,
    revision: 0,
    streaming: false,
    ...overrides,
  }
}

function mkSnapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: 'D:/repo',
    generatedAt: '2026-10-31T00:00:00.000Z',
    branch: {
      name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: 'origin/main',
      ahead: 0, behind: 0, detached: false, unborn: false,
    },
    staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
    ...overrides,
  }
}

function change(path: string) {
  return { path, origPath: null, kind: 'modified' as const, x: 'M', y: '.', conflicted: false, binary: false, additions: 1, deletions: 0, submodule: false }
}

describe('badgeCount — 变更角标（去重路径）', () => {
  it('四组并集去重：UU 冲突文件不重复计数', () => {
    const count = badgeCount({
      staged: [change('a.ts'), change('conflict.ts')],
      unstaged: [change('b.ts'), change('conflict.ts')],
      untracked: [change('c.ts')],
      conflicted: [change('conflict.ts')],
    })
    expect(count).toBe(4)
  })

  it('空快照 → 0', () => {
    expect(badgeCount(mkSnapshot())).toBe(0)
  })
})

describe('headerViewModel — C1 渲染决策', () => {
  it('初始（checking）→ 检查态，动作禁用', () => {
    const view = headerViewModel(mkState())
    expect(view.kind).toBe('checking')
    expect(view.labelKey).toBe('header.checking')
    expect(view.actionsEnabled).toBe(false)
  })

  it('no-repository 错误 → 无仓库空态 [清单 54]', () => {
    const view = headerViewModel(mkState({
      statusError: { code: 'git/no-repository', message: 'not a repo' },
      repo: { available: false, root: null, checking: false },
    }))
    expect(view.kind).toBe('no-repo')
    expect(view.labelKey).toBe('header.noRepo')
    expect(view.actionsEnabled).toBe(false)
  })

  it('可重试错误（gateway/service-unavailable）→ 保持检查态', () => {
    const view = headerViewModel(mkState({
      statusError: { code: 'gateway/service-unavailable', message: 'not ready' },
    }))
    expect(view.kind).toBe('checking')
  })

  it('普通分支 → header.branch {name} + 角标 [清单 47]', () => {
    const view = headerViewModel(mkState({
      status: mkSnapshot({
        clean: false,
        unstaged: [change('a.ts')],
      }),
    }))
    expect(view.kind).toBe('branch')
    expect(view.labelKey).toBe('header.branch')
    expect(view.params).toEqual({ name: 'main' })
    expect(view.badge).toBe(1)
    expect(view.clean).toBe(false)
    expect(view.actionsEnabled).toBe(true)
  })

  it('detached → header.detached {oid=短 oid} [清单 65]', () => {
    const view = headerViewModel(mkState({
      status: mkSnapshot({ branch: { name: null, oid: 'b'.repeat(40), abbrevOid: 'bbbbbbb', upstream: null, ahead: null, behind: null, detached: true, unborn: false } }),
    }))
    expect(view.kind).toBe('detached')
    expect(view.labelKey).toBe('header.detached')
    expect(view.params).toEqual({ oid: 'bbbbbbb' })
  })

  it('unborn → header.unborn，动作仍可用（首提交路径）[清单 64]', () => {
    const view = headerViewModel(mkState({
      status: mkSnapshot({
        branch: { name: 'main', oid: null, abbrevOid: null, upstream: null, ahead: null, behind: null, detached: false, unborn: true },
        untracked: [change('c.ts')],
        clean: false,
      }),
    }))
    expect(view.kind).toBe('unborn')
    expect(view.labelKey).toBe('header.unborn')
    expect(view.actionsEnabled).toBe(true)
    expect(view.badge).toBe(1)
  })
})

describe('headerMenuItems — 菜单五动作（打开变更面板 / 提交图 / 提交… / 提交并推送… / 同步占位）', () => {
  it('仓库可用时：面板与提交链路四动作可点，同步占位禁用（④-K 提交对话框模块接线后）', () => {
    const view = headerViewModel(mkState({ status: mkSnapshot() }))
    const items = headerMenuItems(view)
    expect(items.map((item) => item.id)).toEqual(['open-changes', 'open-graph', 'commit', 'commit-push', 'sync'])
    expect(items[0]).toMatchObject({ enabled: true, placeholder: false })
    expect(items[1]).toMatchObject({ enabled: true, placeholder: false })
    expect(items[2]).toMatchObject({ enabled: true, placeholder: false, labelKey: 'menu.commit' })
    expect(items[3]).toMatchObject({ enabled: true, placeholder: false, labelKey: 'menu.commitPush' })
    expect(items[4]).toMatchObject({ enabled: false, placeholder: true })
  })

  it('无仓库时全部禁用', () => {
    const view = headerViewModel(mkState({
      statusError: { code: 'git/no-repository', message: 'x' },
      repo: { available: false, root: null, checking: false },
    }))
    expect(headerMenuItems(view).every((item) => !item.enabled)).toBe(true)
  })
})

describe('confirmButtonEnabled — C5 danger 确认闸', () => {
  it('normal 恒可确认；danger 必须勾选', () => {
    expect(confirmButtonEnabled('normal', false)).toBe(true)
    expect(confirmButtonEnabled('normal', true)).toBe(true)
    expect(confirmButtonEnabled('danger', false)).toBe(false)
    expect(confirmButtonEnabled('danger', true)).toBe(true)
  })
})
