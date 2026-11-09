/**
 * UI 纯视图模型测试（C1 GitHeaderButton 的渲染决策 + C5 确认闸——本模块 ask §③/④；
 * spec §6 纯函数单测纪律：分支名/角标/detached/unborn/禁用态不依赖 DOM 断言）。
 * V2 批次一扩面（plan §3.7）：sync 占位消失（推送/拉取/获取三真行）、管理面扩行、
 * 分支子菜单渲染模型（当前分支打勾 / detached 短 oid 信息行）、删除分支清单
 * （当前分支除外）。
 * V2 批次二扩面（plan §4.7）：菜单两新行（与当前分支比较 / 重置当前分支）+ 两个
 * 「非当前分支」子菜单的可见性模型（compare / reset——当前分支除外 + detached/unborn
 * 空清单）。
 */

import { describe, expect, it } from 'vitest'
import {
  badgeCount, branchCompareEntries, branchDeleteEntries, branchResetEntries, branchSubmenuEntries,
  confirmButtonEnabled, headerMenuItems, headerViewModel,
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
  it('仓库可用时：v1 的 sync 占位消失，推送/拉取/获取三真行 + 管理面扩行 + 批次二两新行 + 批次四创建 PR 行全部可点', () => {
    const view = headerViewModel(mkState({ status: mkSnapshot() }))
    const items = headerMenuItems(view)
    expect(items.map((item) => item.id)).toEqual([
      'open-changes', 'open-graph', 'commit', 'commit-push',
      'push', 'pull', 'fetch',
      'branches', 'branch-compare', 'branch-reset', 'branch-create', 'tag-create', 'worktree',
      'pr-create', 'branch-delete',
    ])
    expect(items.every((item) => item.enabled)).toBe(true)
    expect(items.map((item) => item.id as string)).not.toContain('sync')
    expect(items.find((item) => item.id === 'commit')?.labelKey).toBe('menu.commit')
    expect(items.find((item) => item.id === 'commit-push')?.labelKey).toBe('menu.commitPush')
    expect(items.find((item) => item.id === 'push')?.labelKey).toBe('menu.push')
    expect(items.find((item) => item.id === 'fetch')?.labelKey).toBe('menu.fetch')
    expect(items.find((item) => item.id === 'worktree')?.labelKey).toBe('menu.worktree')
    expect(items.find((item) => item.id === 'pr-create')?.labelKey).toBe('menu.prCreate')
  })

  it('无仓库态：整菜单收敛为单行「初始化 Git 仓库…」（[8] 空态引导 header 半——可点）', () => {
    const view = headerViewModel(mkState({
      statusError: { code: 'git/no-repository', message: 'x' },
      repo: { available: false, root: null, checking: false },
    }))
    const items = headerMenuItems(view)
    expect(items.map((item) => item.id)).toEqual(['init-repo'])
    expect(items[0]?.labelKey).toBe('menu.initRepo')
    expect(items.every((item) => item.enabled)).toBe(true)
  })

  it('检查中态：保持完整菜单且全部禁用（v1 [清单 54] 行为不回归）', () => {
    const view = headerViewModel(mkState())
    const items = headerMenuItems(view)
    expect(items.map((item) => item.id)).not.toContain('init-repo')
    expect(items.every((item) => !item.enabled)).toBe(true)
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

  it('V2 批次四（[69]）：prNumbers 在场时关联分支行带 prNumber（无关联分支缺省——不占位）', () => {
    const entries = branchSubmenuEntries({
      branches: [{ shortName: 'main' }, { shortName: 'feature/a' }, { shortName: 'dev' }],
      headName: 'main',
      detached: false,
      abbrevOid: null,
      prNumbers: { main: 12, dev: null },
    })
    expect(entries.find((entry) => entry.id === 'branch-switch:main')?.prNumber).toBe(12)
    // feature/a 不在 prNumbers、dev 的查询结果为 null——两行都不带 prNumber 字段。
    expect(entries.find((entry) => entry.id === 'branch-switch:feature/a')?.prNumber).toBeUndefined()
    expect(entries.find((entry) => entry.id === 'branch-switch:dev')?.prNumber).toBeUndefined()
  })

  it('prNumbers 缺席（旧装配/pr 面缺席）⇒ 全部行无 prNumber 字段', () => {
    const entries = branchSubmenuEntries({
      branches: [{ shortName: 'main' }],
      headName: 'main',
      detached: false,
      abbrevOid: null,
    })
    expect(entries[0]?.prNumber).toBeUndefined()
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

describe('branchCompareEntries — 「与当前分支比较」子菜单（V2 批次二 [36]）', () => {
  it('非当前分支逐行（compare 半 = 当前分支，base 从清单选）；id 前缀 branch-compare:', () => {
    const entries = branchCompareEntries({
      branches: [{ shortName: 'main' }, { shortName: 'feature/a' }],
      headName: 'main',
    })
    expect(entries.map((entry) => entry.id)).toEqual(['branch-compare:feature/a'])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
  })

  it('detached/unborn（无当前分支）⇒ 空清单（整行禁用由装配半承担——compareEntryEnabled 同口径）', () => {
    expect(branchCompareEntries({ branches: [{ shortName: 'main' }], headName: null })).toEqual([])
  })
})

describe('branchResetEntries — reset 目标子菜单（V2 批次二 [37]）', () => {
  it('非当前分支逐行（重置到自己无意义——当前分支除外）；id 前缀 branch-reset:', () => {
    const entries = branchResetEntries({
      branches: [{ shortName: 'main' }, { shortName: 'dev' }, { shortName: 'feature/a' }],
      headName: 'dev',
    })
    expect(entries.map((entry) => entry.id)).toEqual(['branch-reset:main', 'branch-reset:feature/a'])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
  })

  it('detached/unborn（无当前分支）⇒ 空清单（重置当前分支的语义需要分支在场）', () => {
    expect(branchResetEntries({ branches: [{ shortName: 'main' }], headName: null })).toEqual([])
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
