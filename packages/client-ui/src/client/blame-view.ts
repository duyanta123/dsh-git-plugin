/**
 * dsh-gitkit-ui — blame 视图纯模型（V2 批次二 [34]；D3=B -L 区间分片；plan §4.6）。
 *
 * 「行号 gutter 注记（短 oid + 作者 + 相对时间，同 range 合并显示）」与「大文件按
 * 虚拟滚动窗口 -L 区间增量加载（区间结果按行号归并，跨片同 oid 行仍合并）」的渲染
 * 决策收敛为纯函数，断言面 = tests/blame-view.spec.ts（range 合并渲染模型 / oversized
 * 占位 / gutter 注记行折叠 / 跨片同 oid 合并）。
 *
 * host wire（plan §4.2）：`BlameRange { startLine, count, oid, authorName, authoredAt }`
 * （同 oid 连续行已合并）；client 归并半把区间化为 [startLine, endLine] 闭区间的 run，
 * 并负责跨片 union 合并（覆盖簿记在 git-blame-store）。
 */

import type { BlameRange } from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'
import type { GitErrorLike } from './remote/mount.js'

/** 单次调用行数硬顶（plan §4.3/§4.10：host 侧 50_000；client 分片规划同值钳制）。 */
export const BLAME_PER_CALL_CAP = 50_000

/** 虚拟滚动窗口的分片余量（行）——可视区外多加载一屏防滚动抖动（图 tab overscan 同思路）。 */
export const BLAME_WINDOW_MARGIN = 80

/** 一个连续同归属行的注记 run（[startLine, endLine] 闭区间，1-based）。 */
export interface BlameRun {
  startLine: number
  endLine: number
  oid: string
  shortOid: string
  authorName: string
  /** ISO（host authoredAt）。 */
  authoredAt: string
}

/** host BlameRange → client run（endLine = startLine + count - 1；count ≤ 0 丢弃）。 */
export function expandBlameRuns(ranges: readonly BlameRange[]): BlameRun[] {
  const runs: BlameRun[] = []
  for (const range of ranges) {
    if (!Number.isFinite(range.startLine) || !Number.isFinite(range.count)) continue
    if (range.count <= 0) continue
    runs.push({
      startLine: Math.max(1, Math.trunc(range.startLine)),
      endLine: Math.trunc(range.startLine) + Math.trunc(range.count) - 1,
      oid: range.oid,
      shortOid: range.oid.slice(0, 7),
      authorName: range.authorName,
      authoredAt: range.authoredAt,
    })
  }
  return runs.sort((a, b) => a.startLine - b.startLine)
}

/**
 * 跨片归并（D3=B 的 spec 钉子）：按 startLine 排序后单趟扫描——
 *  - 同 oid 且相接/重叠（startLine ≤ prev.endLine + 1）⇒ 并入（跨片同 oid 行仍合并）；
 *  - 重叠且 oid 不同（异常路径：重复请求/口径漂移）⇒ **排序序靠后者胜出**：裁掉既有
 *    run 的重叠尾；既有 run 被完全覆盖则移除（病理输入下不做 split——确定性且不放大
 *    覆盖；真实分片流程由 store 的覆盖簿记排除跨 oid 重叠请求）。
 */
export function mergeBlameRuns(
  existing: readonly BlameRun[],
  incoming: readonly BlameRun[],
): BlameRun[] {
  const all = [...existing, ...incoming].sort((a, b) => a.startLine - b.startLine)
  const out: BlameRun[] = []
  for (const run of all) {
    const prev = out[out.length - 1]
    if (prev !== undefined && run.oid === prev.oid && run.startLine <= prev.endLine + 1) {
      if (run.endLine > prev.endLine) out[out.length - 1] = { ...prev, endLine: run.endLine }
      continue
    }
    if (prev !== undefined && run.oid !== prev.oid && run.startLine <= prev.endLine) {
      const trimmed = { ...prev, endLine: run.startLine - 1 }
      if (trimmed.endLine >= trimmed.startLine) out[out.length - 1] = trimmed
      else out.pop()
    }
    out.push({ ...run })
  }
  return out
}

/** 行 → 归属 run（gutter 注记查找；未加载/越界 ⇒ null）。runs 须已归并（区间不重叠）。 */
export function blameRunForLine(runs: readonly BlameRun[], line: number): BlameRun | null {
  for (const run of runs) {
    if (line >= run.startLine && line <= run.endLine) return run
  }
  return null
}

/** gutter 注记的一行（虚拟行模型；注记只在 run 首行渲染——同 range 折叠显示）。 */
export interface BlameGutterRow {
  line: number
  /** 本行归属 run（未加载 ⇒ null——行仍渲染，等待分片加载）。 */
  run: BlameRun | null
  /** 本行是否 run 首行（true ⇒ 组件渲染 短 oid + 作者 + 相对时间 注记）。 */
  runStart: boolean
}

/**
 * 归并后的 runs → 虚拟滚动行模型（行数 = lineCount；lineCount 缺席时退化为 runs 覆盖
 * 的最大 endLine）。行序 1..N；每行携带归属与首行标记（折叠渲染的纯决策半）。
 */
export function blameGutterRows(runs: readonly BlameRun[], lineCount: number | null): BlameGutterRow[] {
  const maxEnd = runs.reduce((acc, run) => Math.max(acc, run.endLine), 0)
  const total = lineCount !== null && Number.isFinite(lineCount) && lineCount > 0
    ? Math.trunc(lineCount)
    : maxEnd
  const rows: BlameGutterRow[] = []
  for (let line = 1; line <= total; line += 1) {
    const run = blameRunForLine(runs, line)
    rows.push({ line, run, runStart: run !== null && run.startLine === line })
  }
  return rows
}

/** 相对时间的渲染模型（key + 数字插值；null = 超出相对窗，回落绝对日期）。 */
export interface BlameRelativeTime {
  key: GitLocaleKey
  params: Record<string, number>
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** 相对时间窗：超过 30 天回落 `YYYY-MM-DD HH:mm` 绝对日期（formatCommitDate 同形态）。 */
const RELATIVE_WINDOW_MS = 30 * DAY_MS

/**
 * ISO → 相对时间（纯函数；`now` 由调用方注入以便测试）。刚刚 / N 分钟前 / N 小时前 /
 * N 天前；解析失败或超窗 ⇒ null（组件回落绝对日期——中性数字串，不走词典）。
 */
export function relativeTime(iso: string, now: number): BlameRelativeTime | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const diff = now - ms
  if (diff < MINUTE_MS) return { key: 'blame.time.now', params: {} }
  if (diff < HOUR_MS) return { key: 'blame.time.minutes', params: { count: Math.floor(diff / MINUTE_MS) } }
  if (diff < DAY_MS) return { key: 'blame.time.hours', params: { count: Math.floor(diff / HOUR_MS) } }
  if (diff < RELATIVE_WINDOW_MS) return { key: 'blame.time.days', params: { count: Math.floor(diff / DAY_MS) } }
  return null
}

/** git/blame-oversized 的分片引导决策（D3=B：不再是占位终点）。 */
export interface OversizedPlan {
  /** true = 可分片（按 -L 窗口增量加载）；false = 无法分片的兜底占位形态。 */
  sliceable: boolean
  /** 文件总行数（details 缺席/形状漂移 ⇒ null——虚拟行数退化，分片仍可按窗口推进）。 */
  lineCount: number | null
  /** 单次调用行数上限（details.maxLines；缺席用 BLAME_PER_CALL_CAP 镜像值）。 */
  maxLines: number
}

/**
 * blame-oversized 错误 → 分片引导（纯函数）：details 携带 { path, lineCount, maxLines }
 * （plan §4.4）且 lineCount 为正有限数 ⇒ 可分片；否则兜底占位（`blame.oversizedFallback`）。
 */
export function oversizedPlan(error: GitErrorLike): OversizedPlan {
  if (error.code !== 'git/blame-oversized') {
    return { sliceable: false, lineCount: null, maxLines: BLAME_PER_CALL_CAP }
  }
  const details = error.details as { lineCount?: unknown; maxLines?: unknown } | undefined
  const lineCount = details?.lineCount
  const maxLines = details?.maxLines
  return {
    sliceable: typeof lineCount === 'number' && Number.isFinite(lineCount) && lineCount > 0,
    lineCount: typeof lineCount === 'number' && Number.isFinite(lineCount) && lineCount > 0
      ? Math.trunc(lineCount)
      : null,
    maxLines: typeof maxLines === 'number' && Number.isFinite(maxLines) && maxLines > 0
      ? Math.trunc(maxLines)
      : BLAME_PER_CALL_CAP,
  }
}

/**
 * 分片规划（虚拟滚动联动）：可视窗口（± BLAME_WINDOW_MARGIN 余量）减去已加载覆盖 ⇒
 * 待请求的 -L 区间清单（每片高度 ≤ maxLines 钳制；覆盖已足 ⇒ 空数组）。窗口越界钳到
 * [1, lineCount]；lineCount 缺席（null）时只按窗口原样钳下界 1。
 */
export function blameSlicePlan(params: {
  lineCount: number | null
  loaded: readonly { start: number; end: number }[]
  window: { start: number; end: number } | null
  maxLines: number
}): { start: number; end: number }[] {
  const cap = params.maxLines > 0 ? Math.trunc(params.maxLines) : BLAME_PER_CALL_CAP
  if (params.window === null) return []
  const lower = Math.max(1, Math.trunc(params.window.start) - BLAME_WINDOW_MARGIN)
  const upper = params.lineCount !== null && Number.isFinite(params.lineCount) && params.lineCount > 0
    ? Math.min(Math.trunc(params.lineCount), Math.trunc(params.window.end) + BLAME_WINDOW_MARGIN)
    : Math.trunc(params.window.end) + BLAME_WINDOW_MARGIN
  if (upper < lower) return []
  // 窗口内覆盖簿记（布尔图；窗口 ≤ 可视区 + 余量，量级小）。
  const size = upper - lower + 1
  const covered = new Array<boolean>(size).fill(false)
  for (const interval of params.loaded) {
    const from = Math.max(lower, Math.trunc(interval.start))
    const to = Math.min(upper, Math.trunc(interval.end))
    for (let line = from; line <= to; line += 1) covered[line - lower] = true
  }
  const slices: { start: number; end: number }[] = []
  let cursor = -1
  for (let index = 0; index < size; index += 1) {
    if (covered[index]) {
      if (cursor >= 0) {
        pushSlices(slices, lower + cursor, lower + index - 1, cap)
        cursor = -1
      }
      continue
    }
    if (cursor < 0) cursor = index
  }
  if (cursor >= 0) pushSlices(slices, lower + cursor, lower + size - 1, cap)
  return slices
}

/** 连续缺口 → 高度 ≤ cap 的片（50_000 行 ≈ 数 MB，plan §4.10 承载量口径）。 */
function pushSlices(
  out: { start: number; end: number }[],
  start: number,
  end: number,
  cap: number,
): void {
  let from = start
  while (from <= end) {
    const to = Math.min(end, from + cap - 1)
    out.push({ start: from, end: to })
    from = to + 1
  }
}

// ── GitBlameView 的分支纯决策（spec §6 收敛；tests/blame-view.spec 钉子）──────

/** 视图状态枚举（GitBlameView 的五个互斥分支）。 */
export type BlameViewStatus = 'loading' | 'oversized-fallback' | 'error' | 'empty' | 'list'

/**
 * 视图分支判别的输入投影（BlameSlotState 的判别切片——结构化声明，避免
 * store ↔ view 的类型环；store 侧槽位结构满足本面）。
 */
export interface BlameViewStatusInput {
  state: 'loading' | 'ready' | 'error'
  error: GitErrorLike | null
  oversized: boolean
  oversizeSignaled: boolean
}

/**
 * GitBlameView 的状态分支纯决策（原组件内四个独立条件链的收敛；评审修复钉子）：
 *  - **D3=B 不变式：分片模式永不落 'empty'**——runs 空且零行 = 首片在途/缺口等待；
 *    理论上只有 host 契约破坏（分片模式槽位 lineCount 缺席/为 0）才会走进零行态，
 *    此时按加载中处理而非「没有可追溯的行」（对超限大文件那是语义错误的占位）；
 *    `blame.empty` 只属于**非分片**的空文件语义（全区成功 + lineCount 0）。
 *  - 行数权威 = blameGutterRows 的产物（lineCount ≥ 1 时分片模式行数恒 ≥ 1——
 *    首片前渲染行号骨架列表，不触发零行分支）。
 */
export function blameViewStatus(slot: BlameViewStatusInput, rowsCount: number): BlameViewStatus {
  if (slot.state === 'loading') return 'loading'
  // 无法分片的兜底占位形态：blame-oversized 且 details 不可用（镜像 diff.oversized）。
  const oversizeFallback = slot.state === 'error'
    && slot.error !== null
    && slot.error.code === 'git/blame-oversized'
    && !slot.oversizeSignaled
  if (oversizeFallback) return 'oversized-fallback'
  if (slot.state === 'error' && slot.error !== null) return 'error'
  if (rowsCount === 0) return slot.oversized ? 'loading' : 'empty'
  return 'list'
}
