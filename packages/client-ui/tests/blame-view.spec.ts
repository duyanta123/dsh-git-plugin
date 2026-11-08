/**
 * blame 视图纯模型测试（V2 批次二 [34]；D3=B -L 区间分片；plan §4.7 client 纯函数
 * 范式）：range 合并渲染模型 / oversized 分片引导与兜底占位 / gutter 注记行折叠 /
 * 跨片同 oid 合并 / 相对时间 / 分片规划（虚拟滚动联动）。
 */

import { describe, expect, it } from 'vitest'
import {
  blameGutterRows, blameRunForLine, blameSlicePlan, blameViewStatus, expandBlameRuns,
  mergeBlameRuns, oversizedPlan, relativeTime, BLAME_PER_CALL_CAP,
} from '../src/client/blame-view.ts'
import type { BlameRange } from 'dsh-gitkit/types'
import type { BlameRun } from '../src/client/blame-view.ts'

function range(startLine: number, count: number, oid = 'a'.repeat(40), authorName = 'Alice'): BlameRange {
  return { startLine, count, oid, authorName, authoredAt: '2026-11-01T00:00:00.000Z' }
}

function run(startLine: number, endLine: number, oid = 'a'.repeat(40)): BlameRun {
  return { startLine, endLine, oid, shortOid: oid.slice(0, 7), authorName: 'Alice', authoredAt: '2026-11-01T00:00:00.000Z' }
}

describe('expandBlameRuns — host range → client run', () => {
  it('endLine = startLine + count - 1；短 oid 截 7；count ≤ 0 丢弃', () => {
    expect(expandBlameRuns([range(3, 2)])).toEqual([
      { startLine: 3, endLine: 4, oid: 'a'.repeat(40), shortOid: 'aaaaaaa', authorName: 'Alice', authoredAt: '2026-11-01T00:00:00.000Z' },
    ])
    expect(expandBlameRuns([range(1, 0), range(1, -2), range(2, 1)])).toHaveLength(1)
  })
})

describe('mergeBlameRuns — 跨片归并（D3=B 的 spec 钉子：跨片同 oid 行仍合并）', () => {
  it('相接同 oid（片边界两侧）⇒ 并成一个 run', () => {
    const merged = mergeBlameRuns([run(1, 100, 'a'.repeat(40))], [run(101, 200, 'a'.repeat(40))])
    expect(merged).toEqual([run(1, 200, 'a'.repeat(40))])
  })

  it('相接不同 oid ⇒ 保留两段（不合并）', () => {
    const merged = mergeBlameRuns([run(1, 100, 'a'.repeat(40))], [run(101, 200, 'b'.repeat(40))])
    expect(merged.map((r) => [r.startLine, r.endLine])).toEqual([[1, 100], [101, 200]])
  })

  it('乱序输入按行号归位；重复覆盖同 oid ⇒ 单调并入', () => {
    const merged = mergeBlameRuns([run(101, 200, 'b'.repeat(40))], [run(1, 50, 'a'.repeat(40)), run(1, 120, 'a'.repeat(40))])
    // 排序序：a(1,50) → a(1,120) 并入 → b(101,200) 与 a 重叠且 oid 不同 ⇒ 排序序
    // 靠后的 b 胜出，a 裁尾到 100（两段 [1,100] / [101,200] 无缝覆盖）。
    expect(merged.map((r) => [r.startLine, r.endLine])).toEqual([[1, 100], [101, 200]])
  })

  it('重叠且 oid 不同（异常路径）⇒ 排序序靠后者胜出（裁既有重叠尾；全覆盖则移除）', () => {
    const trimmed = mergeBlameRuns([run(1, 100, 'a'.repeat(40))], [run(51, 150, 'b'.repeat(40))])
    expect(trimmed.map((r) => [r.startLine, r.endLine])).toEqual([[1, 50], [51, 150]])
    const replaced = mergeBlameRuns([run(1, 100, 'a'.repeat(40))], [run(1, 100, 'b'.repeat(40))])
    expect(replaced).toEqual([run(1, 100, 'b'.repeat(40))])
  })
})

describe('blameRunForLine / blameGutterRows — gutter 注记与折叠渲染模型', () => {
  const runs = [run(1, 3, 'a'.repeat(40)), run(4, 9, 'b'.repeat(40))]

  it('行 → 归属 run；未加载/越界 ⇒ null', () => {
    expect(blameRunForLine(runs, 2)?.oid).toBe('a'.repeat(40))
    expect(blameRunForLine(runs, 9)?.oid).toBe('b'.repeat(40))
    expect(blameRunForLine(runs, 10)).toBeNull()
    expect(blameRunForLine(runs, 0)).toBeNull()
  })

  it('折叠：注记只在 run 首行（runStart），续行 run 相同但 runStart=false', () => {
    const rows = blameGutterRows(runs, 9)
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ line: 1, runStart: true })
    expect(rows[1]).toMatchObject({ line: 2, runStart: false })
    expect(rows[1]!.run?.oid).toBe('a'.repeat(40))
    expect(rows[3]).toMatchObject({ line: 4, runStart: true })
  })

  it('lineCount 缺席 ⇒ 退化为 runs 覆盖的最大 endLine；未加载行 run=null', () => {
    const rows = blameGutterRows([run(4, 9, 'b'.repeat(40))], null)
    expect(rows).toHaveLength(9)
    expect(rows[0]).toEqual({ line: 1, run: null, runStart: false })
    expect(rows[3]).toMatchObject({ line: 4, runStart: true })
  })
})

describe('relativeTime — 相对时间（now 注入；超窗回落绝对日期）', () => {
  const now = Date.parse('2026-11-08T12:00:00.000Z')

  it('刚刚 / N 分钟前 / N 小时前 / N 天前', () => {
    expect(relativeTime('2026-11-08T11:59:40.000Z', now)).toEqual({ key: 'blame.time.now', params: {} })
    expect(relativeTime('2026-11-08T11:40:00.000Z', now)).toEqual({ key: 'blame.time.minutes', params: { count: 20 } })
    expect(relativeTime('2026-11-08T09:00:00.000Z', now)).toEqual({ key: 'blame.time.hours', params: { count: 3 } })
    expect(relativeTime('2026-11-05T12:00:00.000Z', now)).toEqual({ key: 'blame.time.days', params: { count: 3 } })
  })

  it('超 30 天 / 解析失败 ⇒ null（组件回落 formatCommitDate 绝对日期）', () => {
    expect(relativeTime('2026-09-01T00:00:00.000Z', now)).toBeNull()
    expect(relativeTime('not-a-date', now)).toBeNull()
  })
})

describe('oversizedPlan — git/blame-oversized 分片引导（D3=B：不再是占位终点）', () => {
  it('details 携带 lineCount/maxLines ⇒ 可分片（lineCount/maxLines 回填）', () => {
    const plan = oversizedPlan({
      code: 'git/blame-oversized',
      message: 'oversized',
      details: { path: 'big.txt', lineCount: 120_000, maxLines: 50_000 },
    })
    expect(plan).toEqual({ sliceable: true, lineCount: 120_000, maxLines: 50_000 })
  })

  it('details 缺席/形状漂移/非该码 ⇒ 兜底占位（无法分片）+ 上限镜像缺省', () => {
    expect(oversizedPlan({ code: 'git/blame-oversized', message: 'x' }))
      .toEqual({ sliceable: false, lineCount: null, maxLines: BLAME_PER_CALL_CAP })
    expect(oversizedPlan({ code: 'git/blame-oversized', message: 'x', details: { lineCount: 0 } }))
      .toEqual({ sliceable: false, lineCount: null, maxLines: BLAME_PER_CALL_CAP })
    expect(oversizedPlan({ code: 'git/git-error', message: 'x' }).sliceable).toBe(false)
  })
})

describe('blameSlicePlan — 虚拟滚动联动的分片规划', () => {
  it('可视窗口减去已加载覆盖 ⇒ 缺口片（余量 ± BLAME_WINDOW_MARGIN 体现在扩窗）', () => {
    const slices = blameSlicePlan({
      lineCount: 100_000,
      loaded: [{ start: 1, end: 100 }],
      window: { start: 200, end: 220 },
      maxLines: BLAME_PER_CALL_CAP,
    })
    // 窗口 [200,220] ± 80 → [120, 300]；已覆盖 [1,100] 不相交 ⇒ 单片 [120, 300]。
    expect(slices).toEqual([{ start: 120, end: 300 }])
  })

  it('覆盖命中 ⇒ 不重发（已加载区间与扩窗相交部分被扣除）', () => {
    const slices = blameSlicePlan({
      lineCount: 100_000,
      loaded: [{ start: 1, end: 180 }],
      window: { start: 200, end: 220 },
      maxLines: BLAME_PER_CALL_CAP,
    })
    expect(slices).toEqual([{ start: 181, end: 300 }])
    expect(blameSlicePlan({
      lineCount: 100_000,
      loaded: [{ start: 1, end: 400 }],
      window: { start: 200, end: 220 },
      maxLines: BLAME_PER_CALL_CAP,
    })).toEqual([])
  })

  it('lineCount 钳上界（窗口越界收在文件尾）；缺口 > maxLines ⇒ 切多片', () => {
    expect(blameSlicePlan({
      lineCount: 250,
      loaded: [],
      window: { start: 200, end: 220 },
      maxLines: BLAME_PER_CALL_CAP,
    })).toEqual([{ start: 120, end: 250 }])
    const capped = blameSlicePlan({
      lineCount: null,
      loaded: [],
      window: { start: 1, end: 10 },
      maxLines: 100,
    })
    // 窗口 [1,10] - 余量 80 → 下界 1；上界 10+80=90（lineCount null 不钳）→ 单片 1..90。
    expect(capped).toEqual([{ start: 1, end: 90 }])
    const split = blameSlicePlan({
      lineCount: null,
      loaded: [],
      window: { start: 1, end: 30 },
      maxLines: 50,
    })
    // [1, 110] 缺口按 50 行切：1..50 / 51..100 / 101..110。
    expect(split).toEqual([{ start: 1, end: 50 }, { start: 51, end: 100 }, { start: 101, end: 110 }])
  })

  it('窗口缺席 ⇒ 空规划（全区路径不走分片）', () => {
    expect(blameSlicePlan({ lineCount: 100, loaded: [], window: null, maxLines: BLAME_PER_CALL_CAP })).toEqual([])
  })
})

describe('blameViewStatus — GitBlameView 分支纯决策（评审修复钉子）', () => {
  const base = { state: 'ready' as const, error: null, oversized: false, oversizeSignaled: false }

  it('分片模式首片前（runs 空、lineCount ≥ 1）⇒ list：行数权威 = lineCount，行骨架非零，empty 不可达', () => {
    // 行数链钉子：blameGutterRows([], lineCount) = lineCount 行（首片前渲染行号骨架）。
    expect(blameGutterRows([], 120_000)).toHaveLength(120_000)
    expect(blameViewStatus({ ...base, oversized: true }, 120_000)).toBe('list')
  })

  it('D3=B 不变式：分片模式零行态（host 契约破坏的理论路径——lineCount 缺席/为 0）⇒ loading，永不 empty', () => {
    expect(blameViewStatus({ ...base, oversized: true }, 0)).toBe('loading')
  })

  it('非分片空文件（全区成功、lineCount 0、非 oversized）⇒ empty（合法语义保留）', () => {
    expect(blameViewStatus({ ...base }, 0)).toBe('empty')
    expect(blameViewStatus({ ...base }, 7)).toBe('list')
  })

  it('loading / error / oversized-fallback / 分片途中失败四分支', () => {
    expect(blameViewStatus({ ...base, state: 'loading' }, 5)).toBe('loading')
    expect(blameViewStatus({ ...base, state: 'error', error: { code: 'git/git-error', message: 'x' } }, 0)).toBe('error')
    // 无法分片的兜底占位：blame-oversized 且未转分片模式（details 缺席）。
    expect(blameViewStatus({ ...base, state: 'error', error: { code: 'git/blame-oversized', message: 'x' } }, 0))
      .toBe('oversized-fallback')
    // 分片途中失败（oversizeSignaled 仍在）⇒ error 分支（GitErrorNotice + retry，行为同修复前）。
    expect(blameViewStatus({
      ...base, state: 'error', oversized: true, oversizeSignaled: true,
      error: { code: 'git/git-error', message: 'x' },
    }, 5)).toBe('error')
  })
})
