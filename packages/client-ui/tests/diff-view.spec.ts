/**
 * FileDiffView 纯函数层单测（spec §6 `client/tests/diff-view.spec.ts` 行：
 * 照抄的 hunkRows/renderedHunks 回归 + 冲突标记行识别与高亮标记 [清单 6] B4 修订的
 * 「标记」半边；本模块 ask §④）。patch 解析形状以 host ④-C diff 引擎的
 * `git diff --unified=3` 原文为输入契约。
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_RENDERED_LINES, hunkHeader, hunkRows, markConflictRows, parsePatch, renderedHunks, splitRows,
} from '../src/client/diff/patch-hunks.ts'
import type { PatchHunk } from '../src/client/diff/patch-hunks.ts'

/** 一段典型 git diff --unified=3 原文（头 + 两个 hunk + \ No newline + CRLF 语义无关）。 */
const SAMPLE_PATCH = [
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
  '@@ -20,4 +21,3 @@ main',
  ' start()',
  '-cleanup()',
  '+finish()',
  '\\ No newline at end of file',
  ' run()',
].join('\n')

describe('parsePatch — unified patch → hunks', () => {
  it('解析 hunk 头与体行；文件头与 \\ No newline 行剔除', () => {
    const hunks = parsePatch(SAMPLE_PATCH)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toEqual({
      oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
      lines: [
        ' import { a } from "./a"',
        '-const old = 1',
        '+const fresh = 1',
        '+const extra = 2',
        ' ',
      ],
    })
    expect(hunks[1]?.lines).toEqual([
      ' start()',
      '-cleanup()',
      '+finish()',
      ' run()',
    ])
  })

  it('无 hunk 的 patch（纯模式变更）→ []', () => {
    const headerOnly = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'].join('\n')
    expect(parsePatch(headerOnly)).toEqual([])
  })

  it('计数缺省（@@ -1 +1 @@）→ 1', () => {
    const hunks = parsePatch('@@ -1 +1 @@\n-a\n+b')
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })
  })

  it('空串 → []', () => {
    expect(parsePatch('')).toEqual([])
  })
})

describe('hunkRows — 行号计数回归（照抄 dsh FileDiff.tsx:66-77）', () => {
  it('context 两侧都计，del 记 old，add 记 new', () => {
    const hunk: PatchHunk = { oldStart: 10, oldLines: 3, newStart: 20, newLines: 3, lines: [' x', '-y', '+z', ' w'] }
    expect(hunkRows(hunk)).toEqual([
      { kind: 'context', old: 10, new: 20, text: 'x' },
      { kind: 'del', old: 11, new: undefined, text: 'y' },
      { kind: 'add', old: undefined, new: 21, text: 'z' },
      { kind: 'context', old: 12, new: 22, text: 'w' },
    ])
  })

  it('空 context 行（单空格）→ 空文本', () => {
    const rows = hunkRows({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' '] })
    expect(rows[0]).toEqual({ kind: 'context', old: 1, new: 1, text: '' })
  })
})

describe('splitRows — 并排对齐回归（照抄 dsh FileDiff.tsx:86-109）', () => {
  it('del 块与后续 add 块逐行对齐；短侧留空', () => {
    const hunk: PatchHunk = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ['-a', '-b', '+1', '+2', '+3', ' c'] }
    const rows = splitRows(hunk)
    expect(rows).toEqual([
      { left: { no: 1, text: 'a', kind: 'del' }, right: { no: 1, text: '1', kind: 'add' } },
      { left: { no: 2, text: 'b', kind: 'del' }, right: { no: 2, text: '2', kind: 'add' } },
      { right: { no: 3, text: '3', kind: 'add' } },
      { left: { no: 3, text: 'c', kind: 'context' }, right: { no: 4, text: 'c', kind: 'context' } },
    ])
  })
})

describe('renderedHunks — MAX_RENDERED_LINES 截断（照抄 dsh FileDiff.tsx:116-125）', () => {
  const hunkOf = (lines: number, tag: string): PatchHunk => ({
    oldStart: 1, oldLines: lines, newStart: 1, newLines: lines,
    lines: Array.from({ length: lines }, (_, at) => ` ${tag}-${at}`),
  })

  it('预算内全保留且未截断', () => {
    const result = renderedHunks([hunkOf(2, 'a'), hunkOf(3, 'b')])
    expect(result.truncated).toBe(false)
    expect(result.hunks).toHaveLength(2)
    expect(result.hunks[1]?.lines).toHaveLength(3)
  })

  it('超预算：最后的 hunk 被截短，标记 truncated', () => {
    const result = renderedHunks([hunkOf(MAX_RENDERED_LINES - 10, 'a'), hunkOf(20, 'b')])
    expect(result.truncated).toBe(true)
    expect(result.hunks).toHaveLength(2)
    expect(result.hunks[1]?.lines).toHaveLength(10)
  })

  it('预算耗尽：后续 hunk 全部丢弃', () => {
    const result = renderedHunks([hunkOf(MAX_RENDERED_LINES, 'a'), hunkOf(5, 'b')])
    expect(result.truncated).toBe(true)
    expect(result.hunks).toHaveLength(1)
  })

  it('恰好 0 行输入 → 未截断', () => {
    const result = renderedHunks([])
    expect(result).toEqual({ hunks: [], truncated: false })
  })
})

describe('markConflictRows — 冲突标记行高亮标记（[清单 6] 标记半边）', () => {
  it('diff 内容中的四类标记行获得类别，其余为 null', () => {
    const hunk: PatchHunk = {
      oldStart: 1, oldLines: 6, newStart: 1, newLines: 6,
      lines: [
        ' const mode = "merge"',
        '+<<<<<<< HEAD',
        '+ ours()',
        '+=======',
        '+ theirs()',
        '+>>>>>>> feature/x',
      ],
    }
    const rows = markConflictRows(hunkRows(hunk))
    expect(rows.map((row) => row.conflict)).toEqual([
      null, 'start', null, 'separator', null, 'end',
    ])
    // 文本原样保留（渲染层只加锚不改写）。
    expect(rows[1]?.text).toBe('<<<<<<< HEAD')
  })

  it('diff3 base 行与长等号线（非标记）', () => {
    const hunk: PatchHunk = {
      oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
      lines: ['+||||||| merged common ancestors', '+==========', '+======='],
    }
    const rows = markConflictRows(hunkRows(hunk))
    expect(rows.map((row) => row.conflict)).toEqual(['base', null, 'separator'])
  })

  it('rename 标题下的正文等号线不误判（Markdown setext）', () => {
    const hunk: PatchHunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' Title', ' ======'] }
    expect(markConflictRows(hunkRows(hunk)).map((row) => row.conflict)).toEqual([null, null])
  })
})

describe('hunkHeader — 头行展示串（照抄 dsh FileDiff.tsx:165-167）', () => {
  it('@@ -old,count +new,count @@', () => {
    expect(hunkHeader({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [] }))
      .toBe('@@ -1,3 +1,4 @@')
  })
})
