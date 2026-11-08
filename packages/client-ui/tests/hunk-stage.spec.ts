/**
 * hunk/行级勾选 → stagePatch 的组装纯函数单测（V2 批次三 [10]；plan §5.6/§5.7）。
 *
 * 被测面 = src/client/diff/patch-select.ts（plan §5.7「新 hunk-stage.spec.ts：
 * hunk 选择→patch 裁剪组装 / 行选择计数重算 / direction 两态组装（stage/unstage
 * 反向）/ 二进制不可选」）。patch 输入契约 = host diff 引擎的 `git diff
 * --unified=3` 原文（DiffFile.patch），与 diff-view.spec 的 SAMPLE_PATCH 同源纪律。
 */

import { describe, expect, it } from 'vitest'
import type { DiffFile } from 'dsh-gitkit/types'
import { hunkRows, parsePatch } from '../src/client/diff/patch-hunks.ts'
import {
  assembleSelectedPatch, directionOfScope, hunkLineKeys, hunkSelectionState, lineKeyOf,
  selectionAvailable,
} from '../src/client/diff/patch-select.ts'

/** 两 hunk 样本（hunk 1 含 context/del/add；hunk 2 含 del+add 两侧）。 */
const PATCH = [
  'diff --git a/app.ts b/app.ts',
  'index 1111111..2222222 100644',
  '--- a/app.ts',
  '+++ b/app.ts',
  '@@ -1,3 +1,4 @@ imports',
  ' import { a } from "./a"',
  '-const old = 1',
  '+const fresh = 1',
  '+const extra = 2',
  ' ',
  '@@ -20,3 +21,3 @@ main',
  ' start()',
  '-cleanup()',
  '+finish()',
  ' run()',
].join('\n')

function mkFile(patch: string | null, binary = false): DiffFile {
  return {
    path: 'app.ts', origPath: null, status: 'modified', binary,
    additions: 3, deletions: 2, patch, patchTruncated: false, oversized: false,
  }
}

const setOf = (...keys: string[]): ReadonlySet<string> => new Set(keys)

describe('lineKeyOf / hunkLineKeys — 勾选键（del 记 old、add 记 new；context 不可勾选）', () => {
  it('context → null；del/add → 对应侧行号键', () => {
    const hunks = parsePatch(PATCH)
    const rows = hunkRows(hunks[0]!)
    expect(lineKeyOf(rows[0]!)).toBeNull() // context
    expect(lineKeyOf(rows[1]!)).toBe('del:2')
    expect(lineKeyOf(rows[2]!)).toBe('add:2')
    expect(lineKeyOf(rows[3]!)).toBe('add:3')
  })

  it('hunkLineKeys = 该 hunk 全部可勾选键（hunk 头勾选的切换集）', () => {
    const hunks = parsePatch(PATCH)
    expect(hunkLineKeys(hunks[0]!)).toEqual(['del:2', 'add:2', 'add:3'])
    expect(hunkLineKeys(hunks[1]!)).toEqual(['del:21', 'add:22'])
  })

  it('hunkSelectionState 三态：none / partial（indeterminate）/ all', () => {
    const hunks = parsePatch(PATCH)
    expect(hunkSelectionState(hunks[0]!, setOf())).toBe('none')
    expect(hunkSelectionState(hunks[0]!, setOf('add:2'))).toBe('partial')
    expect(hunkSelectionState(hunks[0]!, setOf('del:2', 'add:2', 'add:3'))).toBe('all')
    expect(hunkSelectionState(hunks[1]!, setOf('del:2'))).toBe('none') // 键属 hunk 1
  })
})

describe('selectionAvailable / assembleSelectedPatch — 二进制不可选与空选守卫', () => {
  it('二进制不可选；patch 缺席不可选；正常 patch 可选', () => {
    expect(selectionAvailable({ binary: true, patch: 'x' })).toBe(false)
    expect(selectionAvailable({ binary: false, patch: null })).toBe(false)
    expect(selectionAvailable({ binary: false, patch: PATCH })).toBe(true)
  })

  it('二进制 / patch null / 空选中集 → null（无可应用补丁）', () => {
    expect(assembleSelectedPatch(mkFile(PATCH, true), setOf('add:2'))).toBeNull()
    expect(assembleSelectedPatch(mkFile(null), setOf('add:2'))).toBeNull()
    expect(assembleSelectedPatch(mkFile(PATCH), setOf())).toBeNull()
    expect(assembleSelectedPatch(mkFile(PATCH), setOf('del:999'))).toBeNull() // 键不命中任何行
  })
})

describe('assembleSelectedPatch — hunk 选择 → 整 hunk 裁剪（原头原样，零漂移）', () => {
  it('选中 hunk 1 全部可勾选行 → 文件头 + 原 hunk 1（hunk 2 不进 patch）', () => {
    const patch = assembleSelectedPatch(mkFile(PATCH), setOf('del:2', 'add:2', 'add:3'))
    expect(patch).toBe([
      'diff --git a/app.ts b/app.ts',
      'index 1111111..2222222 100644',
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1,3 +1,4 @@ imports',
      ' import { a } from "./a"',
      '-const old = 1',
      '+const fresh = 1',
      '+const extra = 2',
      ' ',
    ].join('\n') + '\n')
  })

  it('选中 hunk 2 一行 → 仅 hunk 2 进 patch（整 hunk 时原头原样）', () => {
    const patch = assembleSelectedPatch(mkFile(PATCH), setOf('del:21', 'add:22'))
    expect(patch).toContain('@@ -20,3 +21,3 @@ main')
    expect(patch).toContain('-cleanup()')
    expect(patch).toContain('+finish()')
    expect(patch).not.toContain('const old = 1')
  })

  it('两个 hunk 各选部分行 → 双 hunk patch（文件头仅一次）', () => {
    const patch = assembleSelectedPatch(mkFile(PATCH), setOf('add:2', 'del:21'))
    expect(patch).not.toBeNull()
    const headerCount = (patch as string).match(/diff --git /g)?.length ?? 0
    expect(headerCount).toBe(1)
    expect(patch).toContain('@@ -1,')
    expect(patch).toContain('@@ -20,')
  })
})

describe('assembleSelectedPatch — 行选择计数重算（plan §5.7「行选择计数重算」）', () => {
  it('仅选一条 add → 头重算 @@ -1,2 +1,3 @@（context 恒保留作 apply 定位锚）', () => {
    // add:2 = 新文件第 2 行（`+const fresh = 1`）。
    const patch = assembleSelectedPatch(mkFile(PATCH), setOf('add:2'))
    expect(patch).toBe([
      'diff --git a/app.ts b/app.ts',
      'index 1111111..2222222 100644',
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1,2 +1,3 @@',
      ' import { a } from "./a"',
      '+const fresh = 1',
      ' ',
    ].join('\n') + '\n')
  })

  it('仅选一条 del → 头重算 @@ -1,3 +1,2 @@', () => {
    const patch = assembleSelectedPatch(mkFile(PATCH), setOf('del:2'))
    expect(patch).toContain('@@ -1,3 +1,2 @@')
    expect(patch).toContain('-const old = 1')
    expect(patch).not.toContain('+const fresh = 1')
    expect(patch).not.toContain('+const extra = 2')
  })

  it('选部分 del+add → 头重算保持两侧计数一致', () => {
    const patch = assembleSelectedPatch(mkFile(PATCH), setOf('del:2', 'add:3'))
    expect(patch).toContain('@@ -1,3 +1,3 @@')
    expect(patch).toContain('-const old = 1')
    expect(patch).toContain('+const extra = 2')
    expect(patch).not.toContain('+const fresh = 1')
  })

  it('零 context 的纯块：只选 add → 插入点锚 = 前一个 del 的 old 行号（display 序）', () => {
    const noContext = [
      'diff --git a/blocks.ts b/blocks.ts',
      '--- a/blocks.ts',
      '+++ b/blocks.ts',
      '@@ -5,2 +5,3 @@',
      '-a',
      '-b',
      '+1',
      '+2',
      '+3',
    ].join('\n')
    const patch = assembleSelectedPatch(mkFile(noContext), setOf('add:6'))
    expect(patch).toContain('@@ -6,0 +6,1 @@')
    expect(patch).toContain('+2')
    expect(patch).not.toContain('-a')
    expect(patch).not.toContain('+1')
  })
})

describe('direction 两态组装（D7=B；plan §5.7「direction 两态组装（stage/unstage 反向）」）', () => {
  it('worktree 选中 = stage；staged 选中 = unstage 反向', () => {
    expect(directionOfScope('worktree')).toBe('stage')
    expect(directionOfScope('staged')).toBe('unstage')
  })

  it('组装与 direction 无关：同选中集同 patch（direction 只进 stagePatch 入参）', () => {
    const selected = setOf('add:2')
    const worktree = assembleSelectedPatch(mkFile(PATCH), selected)
    const staged = assembleSelectedPatch(mkFile(PATCH), selected)
    expect(worktree).toBe(staged)
    expect(worktree).not.toBeNull()
  })
})
