/*!
 * Ported from deepseek-ai/deepseek-harness (dsh 树 HEAD ce7073d512)
 *   path: packages/client/ui-deliverables/src/client/FileDiff.tsx（:14 常量与
 *         :66-125/:161-167 纯函数——hunkRows / splitRows / renderedHunks / hunkHeader）
 * License: MIT — Copyright (c) DeepSeek（dsh 源码树许可）
 * Modifications: 2026-10-31（F 变更面板模块）—— hunk 类型从宿主
 *   WorkspaceDiffHunk（@deepseek-ai/dsh-workspace-changes/types，字段同形）换成本包
 *   自有 PatchHunk（我们的 diff 过线形状是 unified patch 文本，由 parsePatch 解析产
 *   出同形 hunk）；逐行逻辑保持原样（含 renderedHunks 的预算递减与截断判定）。
 *   parsePatch / markConflictRows 为本模块自研（后者消费 m13/conflict-markers 的
 *   行级分类器——[清单 6] B4 修订的「标记」半边消费者）。
 * SPDX-License-Identifier: MIT
 */

/**
 * diff 渲染纯函数层（C2 GitChangesTab / C3 提交图共用的 FileDiffView 底座；
 * spec §5.1 登记行「dsh FileDiff.tsx 纯函数照抄进自己包」）。纯函数：无 IO、
 * 无全局态、同输入同输出（tests/diff-view.spec.ts）。
 */

import type { ConflictLineKind } from '../m13/conflict-markers.js'
import { classifyConflictLine } from '../m13/conflict-markers.js'

/** 单次渲染的最大行数预算（超出截断，FileDiffView 显示占位）。 */
export const MAX_RENDERED_LINES = 5000

/** 一个 unified hunk（字段与 dsh WorkspaceDiffHunk 同形；parsePatch 的产物）。 */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** hunk 体行（首字符 '+'/'-'/&nbsp;' '；`\ No newline` 行被 parsePatch 剔除）。 */
  lines: string[]
}

/** 一行 unified diff 与两侧行号（context 两侧都计，del 记 old，add 记 new）。 */
export interface DiffRow {
  kind: 'add' | 'del' | 'context'
  old: number | undefined
  new: number | undefined
  text: string
}

/** 一行带冲突标记分类的 diff 行（FileDiffView 渲染 data-git-diff-conflict 用）。 */
export type MarkedDiffRow = DiffRow & { conflict: ConflictLineKind | null }

/** unified hunk 头：`@@ -a[,b] +c[,d] @@`（计数可省略，缺省 1）。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * 解析 unified patch 文本为 hunk 清单（我们的 DiffFile.patch 是
 * `git diff --unified=3` 原文——含 `diff --git`/`index`/`---`/`+++` 头与 hunk 体）。
 * 规则：hunk 头开新 hunk；体行 = 首字符 '+'/'-'/' '；`\ No newline at end of file`
 * 行与首个 hunk 之前的文件头行剔除；`diff --git` 终止当前 hunk（单文件 patch 无此
 * 形状，防御多文件 patch 串接）。
 */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = []
  let current: PatchHunk | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current === null) continue
    const head = line.charAt(0)
    if (head === '+' || head === '-' || head === ' ') current.lines.push(line)
    // 其余（'\\ No newline …'、空串尾元素、意外形状）不进 hunk 体——与 dsh
    // WorkspaceDiffHunk 的 /^[+ -]/ 行契约一致。
  }
  return hunks
}

/**
 * Number a hunk's lines: context lines count on both sides, deletions on the
 * old side, additions on the new side.
 * @param hunk - a parsed hunk.
 * @returns the rows in order.
 */
export function hunkRows(hunk: PatchHunk): DiffRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line) => {
    const text = line.slice(1)
    switch (line[0]) {
      case '+': return { kind: 'add', old: undefined, new: newNo++, text }
      case '-': return { kind: 'del', old: oldNo++, new: undefined, text }
      default: return { kind: 'context', old: oldNo++, new: newNo++, text }
    }
  })
}

/**
 * Pair a hunk's lines for the side-by-side view: each run of deletions is
 * aligned with the run of additions that follows it, row by row, and context
 * lines sit on both sides.
 * @param hunk - a parsed hunk.
 * @returns the rows in order.
 */
export interface SplitRow {
  left?: { no: number; text: string; kind: 'del' | 'context' }
  right?: { no: number; text: string; kind: 'add' | 'context' }
}

export function splitRows(hunk: PatchHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: NonNullable<SplitRow['left']>[] = []
  let adds: NonNullable<SplitRow['right']>[] = []
  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const left = dels[at]
      const right = adds[at]
      rows.push({ ...left === undefined ? {} : { left }, ...right === undefined ? {} : { right } })
    }
    dels = []
    adds = []
  }
  for (const row of hunkRows(hunk)) {
    if (row.kind === 'del') dels.push({ no: row.old as number, text: row.text, kind: 'del' })
    else if (row.kind === 'add') adds.push({ no: row.new as number, text: row.text, kind: 'add' })
    else {
      flush()
      rows.push({ left: { no: row.old as number, text: row.text, kind: 'context' }, right: { no: row.new as number, text: row.text, kind: 'context' } })
    }
  }
  flush()
  return rows
}

/**
 * The hunks to draw, cut at {@link MAX_RENDERED_LINES} lines in total.
 * @param hunks - parsed hunks.
 * @returns the hunks with the last one shortened as needed, and whether anything was cut.
 */
export function renderedHunks(hunks: readonly PatchHunk[]): { hunks: PatchHunk[]; truncated: boolean } {
  let budget = MAX_RENDERED_LINES
  const kept: PatchHunk[] = []
  for (const hunk of hunks) {
    if (budget === 0) return { hunks: kept, truncated: true }
    kept.push(hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) })
    budget -= Math.min(budget, hunk.lines.length)
  }
  return { hunks: kept, truncated: hunks.some((hunk, at) => kept[at] !== hunk) }
}

/** hunk 头展示串（FileDiffView 的 hunk header 行）。 */
export function hunkHeader(hunk: PatchHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

/**
 * 逐行标注冲突标记类别（[清单 6] 的「标记」半边：FileDiffView 给标记行挂
 * data-git-diff-conflict 高亮锚——<<<<<<< / ||||||| / ======= / >>>>>>>）。
 */
export function markConflictRows(rows: readonly DiffRow[]): MarkedDiffRow[] {
  return rows.map((row) => ({ ...row, conflict: classifyConflictLine(row.text) }))
}
