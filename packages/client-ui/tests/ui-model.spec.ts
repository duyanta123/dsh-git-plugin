/**
 * UI 纯视图模型测试（C1 GitHeaderButton 的渲染决策 + C5 确认闸——本模块 ask §③/④；
 * spec §6 纯函数单测纪律：分支名/角标/detached/unborn/禁用态不依赖 DOM 断言）。
 * V2 批次一扩面（plan §3.7）：sync 占位消失（推送/拉取/获取三真行）、管理面扩行、
 * 分支子菜单渲染模型（当前分支打勾 / detached 短 oid 信息行）、删除分支清单
 * （当前分支除外）。
 */

import { describe, expect, it } from 'vitest'
import {
  badgeCount, branchDeleteEntries, branchSubmenuEntries, confirmButtonEnabled, headerMenuItems,
  headerViewModel,
} from '../src/client/ui-model.ts'
import type { GitStatusSourceState } from '../src/client/store/git-status-source.ts'
import type { GitStatusSnapshot } from 'dsh-gitkit/types'

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

describe('headerMenuItems — V2 批次一菜单模型（同步占位转真 + 管理面扩行）', () => {
  it('仓库可用时：v1 的 sync 占位消失，推送/拉取/获取三真行 + 管理面扩行全部可点', () => {
    const view = headerViewModel(mkState({ status: mkSnapshot() }))
    const items = headerMenuItems(view)
    expect(items.map((item) => item.id)).toEqual([
      'open-changes', 'open-graph', 'commit', 'commit-push',
      'push', 'pull', 'fetch',
      'branches', 'branch-create', 'tag-create', 'worktree', 'branch-delete',
    ])
    expect(items.every((item) => item.enabled)).toBe(true)
    expect(items.map((item) => item.id as string)).not.toContain('sync')
    expect(items.find((item) => item.id === 'commit')?.labelKey).toBe('menu.commit')
    expect(items.find((item) => item.id === 'commit-push')?.labelKey).toBe('menu.commitPush')
    expect(items.find((item) => item.id === 'push')?.labelKey).toBe('menu.push')
    expect(items.find((item) => item.id === 'fetch')?.labelKey).toBe('menu.fetch')
    expect(items.find((item) => item.id === 'worktree')?.labelKey).toBe('menu.worktree')
  })

  it('无仓库时全部禁用', () => {
    const view = headerViewModel(mkState({
      statusError: { code: 'git/no-repository', message: 'x' },
      repo: { available: false, root: null, checking: false },
    }))
    expect(headerMenuItems(view).every((item) => !item.enabled)).toBe(true)
  })
})

describe('branchSubmenuEntries — 分支子菜单渲染模型（plan §3.6）', () => {
  it('逐本地分支一行；当前分支标 current（组件渲染 ✓ 前缀——原语子菜单无 selected 面）', () => {
    const entries = branchSubmenuEntries({
      branches: [{ shortName: 'main' }, { shortName: 'feature/a' }, { shortName: 'dev' }],
      headName: 'feature/a',
      detached: false,
      abbrevOid: 'ccccccc',
    })
    expect(entries.map((entry) => entry.id)).toEqual([
      'branch-switch:main', 'branch-switch:feature/a', 'branch-switch:dev',
    ])
    expect(entries.map((entry) => entry.current)).toEqual([false, true, false])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
    expect(entries.every((entry) => entry.labelKey === undefined)).toBe(true)
  })

  it('detached：前置禁用信息行（header.detached {oid=短 oid}——detached 显短 oid）', () => {
    const entries = branchSubmenuEntries({
      branches: [{ shortName: 'main' }],
      headName: null,
      detached: true,
      abbrevOid: 'ddddddd',
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      id: 'branch-head',
      labelKey: 'header.detached',
      params: { oid: 'ddddddd' },
      disabled: true,
      current: false,
    })
    expect(entries[1]).toMatchObject({ id: 'branch-switch:main', current: false })
  })

  it('detached 而短 oid 缺席（oid null）⇒ 无信息行，仅分支行', () => {
    const entries = branchSubmenuEntries({
      branches: [{ shortName: 'main' }],
      headName: null,
      detached: true,
      abbrevOid: null,
    })
    expect(entries.map((entry) => entry.id)).toEqual(['branch-switch:main'])
  })

  it('空分支清单（unborn）⇒ 空数组（无 detached 行、无分支行）', () => {
    const entries = branchSubmenuEntries({
      branches: [],
      headName: null,
      detached: false,
      abbrevOid: null,
    })
    expect(entries).toEqual([])
  })
})

describe('branchDeleteEntries — 删除分支子菜单（当前分支除外）', () => {
  it('当前分支不进清单（git 拒删当前分支——UI 前置排除），其余逐行可点', () => {
    const entries = branchDeleteEntries({
      branches: [{ shortName: 'main' }, { shortName: 'feature/a' }],
      headName: 'main',
    })
    expect(entries.map((entry) => entry.id)).toEqual(['branch-delete:feature/a'])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
  })

  it('detached（无当前分支）⇒ 全部分支可删；唯一分支即当前 ⇒ 空清单（行整行禁用由装配半承担）', () => {
    expect(branchDeleteEntries({ branches: [{ shortName: 'a' }, { shortName: 'b' }], headName: null })
      .map((entry) => entry.id)).toEqual(['branch-delete:a', 'branch-delete:b'])
    expect(branchDeleteEntries({ branches: [{ shortName: 'main' }], headName: 'main' })).toEqual([])
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
