/**
 * changesViewModel / statusGlyphOf 纯视图模型单测（本模块 ask §②/③；spec §6 纯函数
 * 纪律）：分组装配（冲突置顶 [清单 1]）、行内动作按组区分（staged 仅 unstage；
 * changes/untracked stage+discard）、行 diff scope（staged 组 staged，其余 worktree）、
 * unborn/clean/不可用投影。
 */

import { describe, expect, it } from 'vitest'
import type { FileChange, GitStatusSnapshot, RepoDiagnostics } from 'dsh-gitkit/types'
import { changesViewModel, crlfBarView, statusGlyphOf } from '../src/client/changes-view-model.ts'
import type { GitStatusSourceState } from '../src/client/store/git-status-source.ts'

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

function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    path, origPath: null, kind: 'modified', x: 'M', y: '.', conflicted: false,
    binary: false, additions: 2, deletions: 1, submodule: false,
    ...overrides,
  }
}

describe('statusGlyphOf — 状态字母徽标', () => {
  it('kind → 字母/色调', () => {
    expect(statusGlyphOf(change('a', { kind: 'added' }))).toEqual({ letter: 'A', tone: 'added' })
    expect(statusGlyphOf(change('a', { kind: 'deleted' }))).toEqual({ letter: 'D', tone: 'removed' })
    expect(statusGlyphOf(change('a', { kind: 'renamed', origPath: 'b' }))).toEqual({ letter: 'R', tone: 'renamed' })
    expect(statusGlyphOf(change('a', { kind: 'copied', origPath: 'b' }))).toEqual({ letter: 'C', tone: 'renamed' })
    expect(statusGlyphOf(change('a', { kind: 'untracked' }))).toEqual({ letter: 'U', tone: 'untracked' })
    expect(statusGlyphOf(change('a', { kind: 'modified' }))).toEqual({ letter: 'M', tone: 'modified' })
  })

  it('conflicted 优先于 kind → 冲突徽标', () => {
    expect(statusGlyphOf(change('a', { conflicted: true, x: 'U', y: 'U' }))).toEqual({ letter: '!', tone: 'conflict' })
  })
})

describe('changesViewModel — 分组装配', () => {
  it('空快照（clean）→ clean 态、零组', () => {
    const view = changesViewModel(mkState({ status: mkSnapshot(), repo: { available: true, root: 'D:/repo', checking: false } }))
    expect(view.available).toBe(true)
    expect(view.clean).toBe(true)
    expect(view.groups).toEqual([])
    expect(view.totalRows).toBe(0)
    expect(view.unborn).toBe(false)
  })

  it('冲突置顶，随后 staged / changes / untracked（[清单 1]）', () => {
    const view = changesViewModel(mkState({
      status: mkSnapshot({
        clean: false,
        staged: [change('s.ts')],
        unstaged: [change('m.ts')],
        untracked: [change('u.ts', { kind: 'untracked', x: '?', y: '?', additions: null, deletions: null })],
        conflicted: [change('c.ts', { conflicted: true, x: 'U', y: 'U' })],
      }),
    }))
    expect(view.groups.map((group) => group.id)).toEqual(['conflicted', 'staged', 'changes', 'untracked'])
    expect(view.groups.map((group) => group.rows[0]?.path)).toEqual(['c.ts', 's.ts', 'm.ts', 'u.ts'])
    expect(view.totalRows).toBe(4)
  })

  it('空组不出现', () => {
    const view = changesViewModel(mkState({ status: mkSnapshot({ clean: false, untracked: [change('u.ts', { kind: 'untracked' })] }) }))
    expect(view.groups.map((group) => group.id)).toEqual(['untracked'])
  })

  it('rowByPath 去重：UU 文件跨三组只记第一组（conflicted）', () => {
    const view = changesViewModel(mkState({
      status: mkSnapshot({
        clean: false,
        staged: [change('c.ts', { conflicted: true, x: 'U', y: 'U' })],
        unstaged: [change('c.ts', { conflicted: true, x: 'U', y: 'U' })],
        conflicted: [change('c.ts', { conflicted: true, x: 'U', y: 'U' })],
      }),
    }))
    expect(view.rowByPath.get('c.ts')?.group).toBe('conflicted')
    expect(view.totalRows).toBe(1)
  })
})

describe('changesViewModel — 行内动作按组区分（ask §②）', () => {
  it('staged 组仅 unstage；changes/untracked 组 stage + discard', () => {
    const view = changesViewModel(mkState({
      status: mkSnapshot({
        clean: false,
        staged: [change('s.ts')],
        unstaged: [change('m.ts')],
        untracked: [change('u.ts', { kind: 'untracked' })],
      }),
    }))
    const staged = view.groups.find((group) => group.id === 'staged')?.rows[0]
    const modified = view.groups.find((group) => group.id === 'changes')?.rows[0]
    const untracked = view.groups.find((group) => group.id === 'untracked')?.rows[0]
    expect(staged?.actions).toEqual({ stage: false, unstage: true, discard: false })
    expect(modified?.actions).toEqual({ stage: true, unstage: false, discard: true })
    expect(untracked?.actions).toEqual({ stage: true, unstage: false, discard: true })
  })

  it('conflicted 组行 stage + discard（未合并丢弃失败走错误条提示）', () => {
    const view = changesViewModel(mkState({
      status: mkSnapshot({ clean: false, conflicted: [change('c.ts', { conflicted: true, x: 'U', y: 'U' })] }),
    }))
    expect(view.groups[0]?.rows[0]?.actions).toEqual({ stage: true, unstage: false, discard: true })
  })

  it('行 diff scope：staged 组 staged，其余 worktree（[清单 2/3]）', () => {
    const view = changesViewModel(mkState({
      status: mkSnapshot({
        clean: false,
        staged: [change('s.ts')],
        unstaged: [change('m.ts')],
      }),
    }))
    expect(view.groups.find((group) => group.id === 'staged')?.rows[0]?.scope).toBe('staged')
    expect(view.groups.find((group) => group.id === 'changes')?.rows[0]?.scope).toBe('worktree')
  })
})

describe('changesViewModel — unborn / 不可用投影', () => {
  it('unborn 分支 → 提示条位（可与组并存）', () => {
    const view = changesViewModel(mkState({
      status: mkSnapshot({
        clean: false,
        branch: { name: 'main', oid: null, abbrevOid: null, upstream: null, ahead: null, behind: null, detached: false, unborn: true },
        staged: [change('s.ts')],
      }),
    }))
    expect(view.unborn).toBe(true)
    expect(view.totalRows).toBe(1)
  })

  it('无仓库（no-repository 错误帧）→ available false、checking false', () => {
    const view = changesViewModel(mkState({
      statusError: { code: 'git/no-repository', message: 'not a git repository' },
    }))
    expect(view.available).toBe(false)
    expect(view.checking).toBe(false)
    expect(view.groups).toEqual([])
  })

  it('首帧未到（checking）→ checking 态', () => {
    const view = changesViewModel(mkState())
    expect(view.available).toBe(true)
    expect(view.checking).toBe(true)
  })
})

// ── V2 批次三：CRLF 提示条视图模型（[56]；plan §5.6——可折叠不阻断）──

describe('crlfBarView — repoDiagnostics → 提示条视图', () => {
  it('null（未取回/取回失败）→ 不可见', () => {
    expect(crlfBarView(null).visible).toBe(false)
  })

  it('有混用文件：可见 + autocrlf 生效值 + 混用计数 + 封顶清单透传', () => {
    const diagnostics: RepoDiagnostics = {
      autocrlf: 'true', coreEol: 'lf',
      mixedEolFiles: ['a.ts', 'b.ts'], worktreeCrlfCount: 2,
    }
    const view = crlfBarView(diagnostics)
    expect(view.visible).toBe(true)
    expect(view.value).toBe('true')
    expect(view.unset).toBe(false)
    expect(view.mixedCount).toBe(2)
    expect(view.mixedFiles).toEqual(['a.ts', 'b.ts'])
  })

  it('autocrlf 缺席 → 回落 core.eol；两者都缺 → unset 形态（{value} 走 changes.crlf.unset）', () => {
    const eolOnly = crlfBarView({ autocrlf: null, coreEol: 'crlf', mixedEolFiles: ['x.ts'], worktreeCrlfCount: 1 })
    expect(eolOnly.value).toBe('crlf')
    expect(eolOnly.unset).toBe(false)
    const unset = crlfBarView({ autocrlf: null, coreEol: null, mixedEolFiles: ['x.ts'], worktreeCrlfCount: 1 })
    expect(unset.value).toBe('')
    expect(unset.unset).toBe(true)
    expect(unset.visible).toBe(true)
  })

  it('零混用 → 不可见（autocrlf 有值但零混用是常规形态，不渲染免噪）', () => {
    const clean: RepoDiagnostics = { autocrlf: 'true', coreEol: null, mixedEolFiles: [], worktreeCrlfCount: 0 }
    expect(crlfBarView(clean).visible).toBe(false)
  })

  it('评审修复②：全 CRLF、零混用的 Windows autocrlf=true 仓库 → 不可见（不误报常驻混用条）', () => {
    // host 语义实读（diagnostics.ts / guard-scan.spec）：worktreeCrlfCount 统计「含
    // CRLF 的文件」（全 CRLF 也计入），不是混用数——普通 Windows 仓库 3 含 CRLF / 0 混用。
    const allCrlf: RepoDiagnostics = { autocrlf: 'true', coreEol: null, mixedEolFiles: [], worktreeCrlfCount: 3 }
    const view = crlfBarView(allCrlf)
    expect(view.visible).toBe(false)
    expect(view.mixedCount).toBe(0)
  })

  it('评审修复②：worktreeCrlfCount（含 CRLF 数）不折算混用数——mixedCount 恒 = mixedEolFiles.length', () => {
    const capped: RepoDiagnostics = {
      autocrlf: 'input', coreEol: null,
      mixedEolFiles: ['mixed.py'], worktreeCrlfCount: 7,
    }
    const view = crlfBarView(capped)
    expect(view.mixedCount).toBe(1)
    expect(view.visible).toBe(true)
  })
})
