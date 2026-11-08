/**
 * 图首页「未提交改动」合成节点纯视图模型测试（V2 批次二 [38]；plan §4.7 client
 * 纯函数范式）：clean 不渲染 / 无仓库与检查中不渲染 / 四组计数合成（数据 = status
 * 快照四组计数 + HEAD oid）/ 点击意图 = open-changes。
 */

import { describe, expect, it } from 'vitest'
import { wipNodeViewModel } from '../src/client/wip-node.ts'
import type { GitStatusSnapshot } from 'dsh-gitkit/types'

function change(path: string) {
  return { path, origPath: null, kind: 'modified' as const, x: 'M', y: '.', conflicted: false, binary: false, additions: 1, deletions: 0, submodule: false }
}

function snapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: 'D:/repo',
    generatedAt: '2026-11-08T00:00:00.000Z',
    branch: {
      name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: 'origin/main',
      ahead: 0, behind: 0, detached: false, unborn: false,
    },
    staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
    ...overrides,
  }
}

describe('wipNodeViewModel — 渲染闸（clean/不可用/检查中 ⇒ null 不渲染）', () => {
  it('clean === true ⇒ null（[38] 交付口径：干净工作区不渲染）', () => {
    expect(wipNodeViewModel({ available: true, checking: false, status: snapshot() })).toBeNull()
  })

  it('快照未就绪 / 仓库不可用 / 检查中 ⇒ null', () => {
    expect(wipNodeViewModel({ available: true, checking: false, status: null })).toBeNull()
    expect(wipNodeViewModel({ available: false, checking: false, status: snapshot({ clean: false }) })).toBeNull()
    expect(wipNodeViewModel({ available: true, checking: true, status: snapshot({ clean: false }) })).toBeNull()
  })
})

describe('wipNodeViewModel — 计数合成（纯 client，零 host 变更）', () => {
  it('四组计数 + HEAD oid + 去重总数（UU 跨组去重）+ 点击意图', () => {
    const view = wipNodeViewModel({
      available: true,
      checking: false,
      status: snapshot({
        clean: false,
        staged: [change('a.ts')],
        unstaged: [change('b.ts'), change('c.ts')],
        untracked: [change('d.ts')],
        conflicted: [change('c.ts')],
      }),
    })
    expect(view).not.toBeNull()
    expect(view!.headOid).toBe('a'.repeat(40))
    expect(view!.counts).toEqual({ staged: 1, unstaged: 2, untracked: 1, conflicted: 1 })
    // 去重路径总数：a/b/c/d 四条（c.ts 在 unstaged 与 conflicted 重复）。
    expect(view!.total).toBe(4)
    expect(view!.labelKey).toBe('graph.wip.label')
    expect(view!.countsKey).toBe('graph.wip.counts')
    expect(view!.params).toEqual({ staged: 1, unstaged: 2, untracked: 1, conflicted: 1 })
    expect(view!.intent).toBe('open-changes')
  })

  it('unborn 分支（HEAD oid null）+ 仅 untracked ⇒ 合成行仍渲染', () => {
    const view = wipNodeViewModel({
      available: true,
      checking: false,
      status: snapshot({
        clean: false,
        branch: {
          name: 'main', oid: null, abbrevOid: null, upstream: null,
          ahead: null, behind: null, detached: false, unborn: true,
        },
        untracked: [change('d.ts')],
      }),
    })
    expect(view).not.toBeNull()
    expect(view!.headOid).toBeNull()
    expect(view!.total).toBe(1)
  })
})
