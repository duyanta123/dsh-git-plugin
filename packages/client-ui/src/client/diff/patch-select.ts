/**
 * dsh-gitkit-ui — hunk/行级勾选的补丁裁剪组装（V2 批次三 [10]；plan §5.6/§5.7）。
 *
 * 数据流（plan §5.6）：diff 区 hunk 头勾选框 + 行级勾选 → 本模块纯函数从既有
 * `parsePatch` 产物裁剪组装选中 patch → `stagePatch` RPC（worktree 选中 =
 * `direction:'stage'`，staged 选中 = `direction:'unstage'` 反向还原——D7=B）。
 *
 * 组装规则：
 * - **文件头**：原 patch 首个 hunk 头之前的行（`diff --git`/`index`/`---`/`+++`）——
 *   `parsePatch` 只保留 hunk，文件头从这里取回（单文件 patch；多文件 patch 串接时
 *   在第二个 `diff --git` 截断，防御）。
 * - **hunk 裁剪**：至少选中一行的 hunk 保留全部 context 行 + 选中的 +/- 行（display
 *   序）；一行未选的 hunk 不进 patch。context 行不可勾选（它们是 apply 的定位锚）。
 * - **hunk 头计数重算**：旧行计数 = 保留行中带 old 侧行号的数量、新行计数同理；起点
 *   取保留行中首个对应侧行号；整块全是 add/del（对应侧零保留行）时退到插入点锚
 *   （见 assembleSelectedPatch 内注释）。host `apply --cached --recount`（plan §5.3）
 *   对计数漂移兜底，起点由 apply 的 context 匹配定位。
 * - **返回 null**：选中集为空 / 二进制 / patch 缺席——无可应用补丁（二进制不可选，
 *   plan §5.7「二进制不可选」）。
 *
 * 已知边界（如实登记）：`\ No newline at end of file` 标记行在 `parsePatch` 中被剔除，
 * 本模块组装的 patch 不携带该标记——对「无 EOF 换行」文件的行级勾选可能引入尾换行
 * 漂移，host 侧 apply 失败时走 `git/stage-patch-failed` → UI 提示回落文件级 stage
 * （plan §5.10 风险行）。
 *
 * 纯函数：无 IO、无全局态、同输入同输出（tests/hunk-stage.spec.ts）。
 */

import { hunkHeader, hunkRows, parsePatch } from './patch-hunks.js'
import type { PatchHunk } from './patch-hunks.js'

/** 一行可勾选内容的键（del 记 old 侧行号、add 记 new 侧行号——hunkRows 行号同源）。 */
export type LineKey = `del:${number}` | `add:${number}`

/** hunkRows 的一行 → 勾选键；context 行不可勾选 → null。 */
export function lineKeyOf(row: {
  kind: 'add' | 'del' | 'context'
  old: number | undefined
  new: number | undefined
}): LineKey | null {
  if (row.kind === 'del' && row.old !== undefined) return `del:${row.old}`
  if (row.kind === 'add' && row.new !== undefined) return `add:${row.new}`
  return null
}

/** hunk 头勾选框的三态投影（all/partial 用 checkbox indeterminate 表达）。 */
export type HunkSelectionState = 'none' | 'partial' | 'all'

/** 一个 hunk 的勾选态：可勾选行全选 = all、部分 = partial、零 = none。 */
export function hunkSelectionState(hunk: PatchHunk, selected: ReadonlySet<string>): HunkSelectionState {
  let selectable = 0
  let checked = 0
  for (const row of hunkRows(hunk)) {
    const key = lineKeyOf(row)
    if (key === null) continue
    selectable += 1
    if (selected.has(key)) checked += 1
  }
  if (selectable === 0 || checked === 0) return 'none'
  return checked === selectable ? 'all' : 'partial'
}

/** 一个 hunk 的全部可勾选行键（hunk 头勾选 = 整 hunk 全选/全不选的切换集）。 */
export function hunkLineKeys(hunk: PatchHunk): LineKey[] {
  const keys: LineKey[] = []
  for (const row of hunkRows(hunk)) {
    const key = lineKeyOf(row)
    if (key !== null) keys.push(key)
  }
  return keys
}

/** 勾选是否可用：二进制不可选（无行级语义）；patch 缺席（binary/超预算/加载失败）不可选。 */
export function selectionAvailable(file: { binary: boolean; patch: string | null }): boolean {
  return !file.binary && file.patch !== null
}

/** 展开行的 scope → stagePatch 的 direction（D7=B：worktree 选中=stage、staged 选中=unstage 反向）。 */
export function directionOfScope(scope: 'worktree' | 'staged'): 'stage' | 'unstage' {
  return scope === 'staged' ? 'unstage' : 'stage'
}

/** 文件头提取：首个 hunk 头之前的行（多文件 patch 在第二个 `diff --git` 截断——防御）。 */
function fileHeaderOf(patch: string): string[] {
  const header: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ -')) break
    if (header.length > 0 && line.startsWith('diff --git ')) break
    header.push(line)
  }
  // 尾部空行不进文件头（patch 文本末尾换行产生的空元素）。
  while (header.length > 0 && header[header.length - 1] === '') header.pop()
  return header
}

/**
 * 原 hunk 头行提取（按 hunk 序）——整 hunk 裁剪时原样透传（保留 `@@ … @@ <section>`
 * 尾段；parsePatch 的结构化字段不含尾段文本，重算头不携带）。
 */
function rawHunkHeaders(patch: string): string[] {
  const headers: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ -')) headers.push(line)
  }
  return headers
}

/**
 * 保留行集合的 hunk 头重算（plan §5.7「行选择计数重算」）。
 * 起点规则：首个保留行带对应侧行号 → 用它；对应侧零保留行（纯 add/纯 del 块）→
 * 插入点锚——沿原 hunk 行序回溯最后一个带对应侧行号的行（其行号即插入点；原 hunk
 * 对应侧计数为 0 的纯插入/纯删除 hunk 直接用原起点）。
 */
function hunkHeaderFor(hunk: PatchHunk, retainedOld: boolean[], retainedNew: boolean[], rows: ReturnType<typeof hunkRows>): string {
  const hasOld = retainedOld.some((flag) => flag)
  const hasNew = retainedNew.some((flag) => flag)
  let oldStart = hunk.oldStart
  let newStart = hunk.newStart
  if (!hasOld) {
    // 纯 add 块：插入点 = 首个保留行之前最后一个 old 侧行（或原 hunk 起点）。
    let anchor = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    for (let at = 0; at < rows.length; at += 1) {
      const row = rows[at]
      if (row === undefined) break
      if (retainedNew[at] === true && !retainedOld[at]) break // 首个保留行处停表
      if (row.old !== undefined) anchor = row.old
    }
    oldStart = Math.max(0, anchor)
  } else {
    for (let at = 0; at < rows.length; at += 1) {
      const row = rows[at]
      if (row !== undefined && retainedOld[at] && row.old !== undefined) {
        oldStart = row.old
        break
      }
    }
  }
  if (!hasNew) {
    let anchor = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
    for (let at = 0; at < rows.length; at += 1) {
      const row = rows[at]
      if (row === undefined) break
      if (retainedOld[at] === true && !retainedNew[at]) break
      if (row.new !== undefined) anchor = row.new
    }
    newStart = Math.max(0, anchor)
  } else {
    for (let at = 0; at < rows.length; at += 1) {
      const row = rows[at]
      if (row !== undefined && retainedNew[at] && row.new !== undefined) {
        newStart = row.new
        break
      }
    }
  }
  const oldLines = retainedOld.filter((flag) => flag).length
  const newLines = retainedNew.filter((flag) => flag).length
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
}

/**
 * 从原 patch 文本 + 勾选键集组装选中 patch（plan §5.6「从既有 parsePatch 产物裁剪」）。
 * @param file - 展开行的 DiffFile（binary/patch 缺席 → null）。
 * @param selected - 勾选键集（lineKeyOf 的产出；hunk 级勾选 = hunkLineKeys 全集）。
 * @returns patch 文本；选中集为空或不可选 → null。
 */
export function assembleSelectedPatch(
  file: { binary: boolean; patch: string | null },
  selected: ReadonlySet<string>,
): string | null {
  if (!selectionAvailable(file) || file.patch === null) return null
  if (selected.size === 0) return null
  const patch = file.patch
  const header = fileHeaderOf(patch)
  const hunks = parsePatch(patch)
  const rawHeaders = rawHunkHeaders(patch)
  const body: string[] = []
  for (let position = 0; position < hunks.length; position += 1) {
    const hunk = hunks[position]
    if (hunk === undefined) continue
    const rows = hunkRows(hunk)
    const retainedOld: boolean[] = []
    const retainedNew: boolean[] = []
    const lines: string[] = []
    let selectedCount = 0
    for (const row of rows) {
      const key = lineKeyOf(row)
      // context 行恒保留（apply 的定位锚，不可勾选）；+/− 行按勾选集。
      const keep = key === null || selected.has(key)
      if (key !== null && selected.has(key)) selectedCount += 1
      retainedOld.push(keep && row.old !== undefined)
      retainedNew.push(keep && row.new !== undefined)
      if (keep) lines.push(`${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`)
    }
    if (selectedCount === 0) continue // 一行未选：整 hunk 不进 patch（纯 context 无意义）
    if (selectedCount === hunkLineKeys(hunk).length) {
      // 整 hunk 选中：原 hunk 头原样透传（含 `@@ … @@ <section>` 尾段——git 产出零漂移）。
      body.push(rawHeaders[position] ?? hunkHeader(hunk), ...lines)
      continue
    }
    body.push(hunkHeaderFor(hunk, retainedOld, retainedNew, rows), ...lines)
  }
  if (body.length === 0) return null
  return [...header, ...body].join('\n') + '\n'
}
