/**
 * M12 — computeGraphLayout 快照与 G1–G5 契约断言（spec §6 graph-layout 行 +
 * workflow M12 任务口径：快照夹具 线性/分叉/合并/octopus/双分叉/根/空集）。
 *
 * G1 单遍前向 = 任意截断前缀的布局（oid/lane/passthrough）与全量布局前缀逐一相等；
 * G2 分页追加稳定性 = 页 1 布局在追加页 2 后前缀行不变、悬垂边补全为真实父边
 * （起点行/travel lane 不变）；G3 确定性 = 同输入两次全等（含快照）；G4 泳道紧致 =
 * laneCount == 已用最大下标 + 1 且每个下标至少被一个节点/边使用、最小空闲位复用；
 * G5 多父与悬挂父 = octopus 3 父各占独立边、窗口外父 ⇒ dangling 直达窗口底。
 * 另断言：非拓扑输入走 temporal 修复（确定性 + 拓扑正确）；unborn 空输入 ⇒ 空结果。
 */

import { describe, expect, it } from 'vitest'
import type { CommitInfo, RefInfo } from 'dsh-gitkit/types'
import { computeGraphLayout } from '../src/client/graph/lane-layout.ts'
import type { GraphLayoutResult } from '../src/client/graph/lane-layout.ts'

/** 确定性提交构造（authoredAt == committedAt；日期全序一致，触发不了修复路径）。 */
function commit(oid: string, parents: readonly string[], committedAt: string, subject = `subject ${oid}`): CommitInfo {
  return {
    oid,
    parents: [...parents],
    authorName: 't',
    authorEmail: 't@example.com',
    authoredAt: committedAt,
    committedAt,
    subject,
    body: '',
  }
}

function ref(type: RefInfo['type'], fullName: string, shortName: string, oid: string): RefInfo {
  return { type, fullName, shortName, oid, upstreamTrack: null }
}

// ── 快照夹具（children-first；日期单调 = git log --topo-order 的常见输出形态） ──

/** 线性：base ← c1 ← c2。 */
const LINEAR = [commit('c2', ['c1'], '2026-01-03T00:00:00Z'), commit('c1', ['base'], '2026-01-02T00:00:00Z'), commit('base', [], '2026-01-01T00:00:00Z')]

/** 分叉：base ← a / b（两条分支并行）。 */
const FORK = [commit('a', ['base'], '2026-01-03T00:00:00Z'), commit('b', ['base'], '2026-01-02T00:00:00Z'), commit('base', [], '2026-01-01T00:00:00Z')]

/** 合并：base ← dev / main ← m（merge parents [main, dev]）。 */
const MERGE = [
  commit('m', ['main', 'dev'], '2026-01-04T00:00:00Z'),
  commit('main', ['base'], '2026-01-03T00:00:00Z'),
  commit('dev', ['base'], '2026-01-02T00:00:00Z'),
  commit('base', [], '2026-01-01T00:00:00Z'),
]

/** octopus：base ← b1 / b2 / main ← oct（3 parents）。 */
const OCTOPUS = [
  commit('oct', ['main', 'b1', 'b2'], '2026-01-05T00:00:00Z'),
  commit('main', ['base'], '2026-01-04T00:00:00Z'),
  commit('b1', ['base'], '2026-01-03T00:00:00Z'),
  commit('b2', ['base'], '2026-01-02T00:00:00Z'),
  commit('base', [], '2026-01-01T00:00:00Z'),
]

/** 双分叉：两条独立分叉线再合流（base ← l1/r1 ← l2/r2 ← m2）。 */
const DOUBLE_FORK = [
  commit('m2', ['l2', 'r2'], '2026-01-06T00:00:00Z'),
  commit('l2', ['l1'], '2026-01-05T00:00:00Z'),
  commit('r2', ['r1'], '2026-01-04T00:00:00Z'),
  commit('l1', ['base'], '2026-01-03T00:00:00Z'),
  commit('r1', ['base'], '2026-01-02T00:00:00Z'),
  commit('base', [], '2026-01-01T00:00:00Z'),
]

/** 根：单提交无父。 */
const ROOT = [commit('r', [], '2026-01-01T00:00:00Z')]

/** 空集（unborn 窗口）。 */
const EMPTY: readonly CommitInfo[] = []

const MERGE_REFS: readonly RefInfo[] = [
  ref('local-branch', 'refs/heads/main', 'main', 'm'),
  ref('tag', 'refs/tags/v1', 'v1', 'main'),
]

function layout(commits: readonly CommitInfo[], headOid: string | null = commits[0]?.oid ?? null, refs: readonly RefInfo[] = []): GraphLayoutResult {
  return computeGraphLayout({ commits, headOid, refs })
}

/** G4 不变量：laneCount = 已用最大 lane + 1，且每个下标 < laneCount 至少被一个节点/边使用。 */
function assertCompact(result: GraphLayoutResult): void {
  const used = new Set<number>()
  for (const row of result.rows) {
    expect(row.lane).toBeGreaterThanOrEqual(0)
    expect(row.lane).toBeLessThan(result.laneCount)
    used.add(row.lane)
    for (const edge of row.edges) {
      expect(edge.fromLane).toBeLessThan(result.laneCount)
      used.add(edge.fromLane)
      expect(edge.toLane).toBeLessThan(result.laneCount)
      used.add(edge.toLane)
    }
  }
  expect(result.laneCount).toBe(used.size)
  for (let lane = 0; lane < result.laneCount; lane++) {
    expect(used.has(lane)).toBe(true)
  }
}

/** 拓扑校验（产物必须是 children-first：父提交在子提交下方或不在窗口）。 */
function assertTopological(result: GraphLayoutResult, commits: readonly CommitInfo[]): void {
  const position = new Map(result.rows.map((row) => [row.oid, row.row]))
  for (const commit of commits) {
    const childRow = position.get(commit.oid)
    expect(childRow).toBeDefined()
    for (const parentOid of commit.parents) {
      const parentRow = position.get(parentOid)
      if (parentRow !== undefined) {
        expect(parentRow).toBeGreaterThan(childRow as number)
      }
    }
  }
}

describe('M12 快照夹具（线性/分叉/合并/octopus/双分叉/根/空集）', () => {
  it('线性：单泳道直线', () => {
    const result = layout(LINEAR)
    expect(result.rows.map((row) => [row.oid, row.lane])).toEqual([['c2', 0], ['c1', 0], ['base', 0]])
    expect(result.laneCount).toBe(1)
    expect(result.rows[0]!.edges).toEqual([{ fromRow: 0, fromLane: 0, toRow: 1, toLane: 0, toOid: 'c1', kind: 'parent' }])
    expect(result.rows[2]!.edges).toEqual([])
    assertCompact(result)
    expect(result).toMatchSnapshot('linear')
  })

  it('分叉：两条并行泳道在 base 收口', () => {
    const result = layout(FORK)
    expect(result.rows.map((row) => [row.oid, row.lane])).toEqual([['a', 0], ['b', 1], ['base', 0]])
    expect(result.laneCount).toBe(2)
    // a→base 的垂直段穿过 b 所在行（lane 0 passthrough）。
    expect(result.rows[1]!.passthrough).toEqual([0])
    assertCompact(result)
    expect(result).toMatchSnapshot('fork')
  })

  it('合并：merge 次父边折返入 lane 1', () => {
    const result = layout(MERGE, 'm', MERGE_REFS)
    expect(result.rows.map((row) => [row.oid, row.lane])).toEqual([['m', 0], ['main', 0], ['dev', 1], ['base', 0]])
    expect(result.rows[0]!.edges.map((edge) => [edge.fromLane, edge.toRow, edge.toLane, edge.toOid]))
      .toEqual([[0, 1, 0, 'main'], [1, 2, 1, 'dev']])
    // main/dev 的行各持一条指向 base 的出边（base 为根提交，其自身 edges 为空）。
    expect(result.rows[1]!.edges).toEqual([{ fromRow: 1, fromLane: 0, toRow: 3, toLane: 0, toOid: 'base', kind: 'parent' }])
    expect(result.rows[2]!.edges).toEqual([{ fromRow: 2, fromLane: 1, toRow: 3, toLane: 0, toOid: 'base', kind: 'parent' }])
    expect(result.rows[3]!.edges).toEqual([])
    // refs 装饰：m 挂 main 分支 + HEAD；main 挂 v1 tag。
    expect(result.rows[0]!.refs).toEqual(['main'])
    expect(result.rows[0]!.isHead).toBe(true)
    expect(result.rows[1]!.refs).toEqual(['v1'])
    assertCompact(result)
    expect(result).toMatchSnapshot('merge')
  })

  it('octopus：三父各占独立 travel lane', () => {
    const result = layout(OCTOPUS)
    expect(result.rows.map((row) => [row.oid, row.lane])).toEqual([['oct', 0], ['main', 0], ['b1', 1], ['b2', 2], ['base', 0]])
    const octEdges = result.rows[0]!.edges
    expect(octEdges).toHaveLength(3)
    expect(octEdges.map((edge) => edge.fromLane)).toEqual([0, 1, 2])
    expect(octEdges.map((edge) => edge.toOid)).toEqual(['main', 'b1', 'b2'])
    expect(result.laneCount).toBe(3)
    assertCompact(result)
    expect(result).toMatchSnapshot('octopus')
  })

  it('双分叉：两条分叉线全程平行再合流', () => {
    const result = layout(DOUBLE_FORK)
    expect(result.rows.map((row) => [row.oid, row.lane])).toEqual([['m2', 0], ['l2', 0], ['r2', 1], ['l1', 0], ['r1', 1], ['base', 0]])
    expect(result.laneCount).toBe(2)
    assertCompact(result)
    expect(result).toMatchSnapshot('double-fork')
  })

  it('根：单提交零边', () => {
    const result = layout(ROOT)
    expect(result.rows).toEqual([{
      row: 0, oid: 'r', lane: 0, isHead: true, refs: [], passthrough: [], edges: [],
    }])
    expect(result.laneCount).toBe(1)
    expect(result).toMatchSnapshot('root')
  })

  it('空集（unborn）：空结果零泳道', () => {
    const result = layout(EMPTY, null)
    expect(result).toEqual({ rows: [], laneCount: 0 })
    expect(result).toMatchSnapshot('empty')
  })
})

describe('G1 单遍前向（截断前缀不变）', () => {
  const full = layout(MERGE)
  for (const k of [1, 2, 3]) {
    it(`前 ${k} 行的 oid/lane/passthrough 与全量布局前缀逐一相等`, () => {
      const truncated = layout(MERGE.slice(0, k))
      expect(truncated.rows).toHaveLength(k)
      for (let index = 0; index < k; index++) {
        expect(truncated.rows[index]!.oid).toBe(full.rows[index]!.oid)
        expect(truncated.rows[index]!.lane).toBe(full.rows[index]!.lane)
        expect(truncated.rows[index]!.passthrough).toEqual(full.rows[index]!.passthrough)
      }
    })
  }
  it('线性与 octopus 夹具同样满足截断前缀不变', () => {
    for (const fixture of [LINEAR, OCTOPUS, DOUBLE_FORK]) {
      const all = layout(fixture)
      for (let k = 1; k < fixture.length; k++) {
        const part = layout(fixture.slice(0, k))
        expect(part.rows.map((row) => [row.oid, row.lane, row.passthrough]))
          .toEqual(all.rows.slice(0, k).map((row) => [row.oid, row.lane, row.passthrough]))
      }
    }
  })
})

describe('G2 分页追加稳定性（整表重跑，前缀不变）', () => {
  it('页 1 [m, main, dev] 追加 [base] 后：前缀行 lane/passthrough/oid 逐一不变', () => {
    const page1 = layout(MERGE.slice(0, 3))
    const full = layout(MERGE)
    expect(full.rows.length).toBe(4)
    for (let index = 0; index < 3; index++) {
      expect(full.rows[index]!.oid).toBe(page1.rows[index]!.oid)
      expect(full.rows[index]!.lane).toBe(page1.rows[index]!.lane)
      expect(full.rows[index]!.passthrough).toEqual(page1.rows[index]!.passthrough)
      expect(full.rows[index]!.isHead).toBe(page1.rows[index]!.isHead)
      expect(full.rows[index]!.refs).toEqual(page1.rows[index]!.refs)
    }
  })

  it('页 1 的悬垂边补全为真实父边：起点行与 travel lane 不变，toOid 落到新页', () => {
    const page1 = layout(MERGE.slice(0, 3))
    // 页 1 边界：main/dev 的父 base 不在窗口 ⇒ dangling 直达窗口底（toRow = 3）。
    expect(page1.rows[1]!.edges).toEqual([{ fromRow: 1, fromLane: 0, toRow: 3, toLane: 0, toOid: null, kind: 'dangling' }])
    expect(page1.rows[2]!.edges).toEqual([{ fromRow: 2, fromLane: 1, toRow: 3, toLane: 1, toOid: null, kind: 'dangling' }])
    const full = layout(MERGE)
    expect(full.rows[1]!.edges).toEqual([{ fromRow: 1, fromLane: 0, toRow: 3, toLane: 0, toOid: 'base', kind: 'parent' }])
    expect(full.rows[2]!.edges).toEqual([{ fromRow: 2, fromLane: 1, toRow: 3, toLane: 0, toOid: 'base', kind: 'parent' }])
  })

  it('追加两页（octopus 分三页）后前缀同样稳定', () => {
    const page1 = layout(OCTOPUS.slice(0, 2))
    const page2 = layout(OCTOPUS.slice(0, 4))
    const full = layout(OCTOPUS)
    for (const [index, prefix] of [[2, page1], [4, page2]] as const) {
      for (let row = 0; row < prefix.rows.length; row++) {
        expect(full.rows[row]!.oid).toBe(prefix.rows[row]!.oid)
        expect(full.rows[row]!.lane).toBe(prefix.rows[row]!.lane)
        expect(full.rows[row]!.passthrough).toEqual(prefix.rows[row]!.passthrough)
      }
      expect(index).toBe(prefix.rows.length)
    }
  })
})

describe('G3 确定性', () => {
  it('同输入两次全等（结构 + 序列化）', () => {
    for (const fixture of [LINEAR, FORK, MERGE, OCTOPUS, DOUBLE_FORK, ROOT]) {
      const first = layout(fixture)
      const second = layout(fixture)
      expect(second).toEqual(first)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    }
  })
})

describe('G4 泳道紧致', () => {
  it('夹具泳道数：线性 1 / 分叉 2 / 合并 2 / octopus 3 / 双分叉 2 / 根 1', () => {
    expect(layout(LINEAR).laneCount).toBe(1)
    expect(layout(FORK).laneCount).toBe(2)
    expect(layout(MERGE).laneCount).toBe(2)
    expect(layout(OCTOPUS).laneCount).toBe(3)
    expect(layout(DOUBLE_FORK).laneCount).toBe(2)
    expect(layout(ROOT).laneCount).toBe(1)
  })
  it('所有夹具满足稠密不变量（每 lane 至少一用、无空洞）', () => {
    for (const fixture of [LINEAR, FORK, MERGE, OCTOPUS, DOUBLE_FORK, ROOT]) {
      assertCompact(layout(fixture))
    }
  })
})

describe('G5 多父与悬挂父', () => {
  it('octopus 提交 3 条出边（首父直线 + 两非首父独立 lane）', () => {
    const result = layout(OCTOPUS)
    const edges = result.rows[0]!.edges
    expect(edges.map((edge) => edge.kind)).toEqual(['parent', 'parent', 'parent'])
    expect(new Set(edges.map((edge) => edge.fromLane)).size).toBe(3)
    // 非首父边从各 travel lane 收口到对应提交。
    expect(edges[1]).toMatchObject({ toOid: 'b1', toRow: 2, toLane: 1 })
    expect(edges[2]).toMatchObject({ toOid: 'b2', toRow: 3, toLane: 2 })
  })

  it('悬挂父：父不在窗口 ⇒ dangling 直达窗口底（toRow = rows.length、toOid null）', () => {
    const result = layout(MERGE.slice(0, 3))
    for (const row of result.rows) {
      for (const edge of row.edges) {
        if (edge.kind === 'dangling') {
          expect(edge.toRow).toBe(result.rows.length)
          expect(edge.toOid).toBeNull()
          expect(edge.toLane).toBe(edge.fromLane)
        }
      }
    }
    const dangling = result.rows.flatMap((row) => row.edges).filter((edge) => edge.kind === 'dangling')
    expect(dangling).toHaveLength(2)
  })

  it('重复 oid 输入按契约破坏抛错', () => {
    const duplicated = [...MERGE, MERGE[0]!]
    expect(() => layout(duplicated)).toThrow(/duplicate commit oid/)
  })
})

describe('temporal 修复路径（非拓扑输入）', () => {
  /** 乱序输入（base 在前、merge 在中间）：非拓扑 ⇒ 修复。 */
  const SHUFFLED = [MERGE[3]!, MERGE[0]!, MERGE[1]!, MERGE[2]!]

  it('修复产物拓扑正确、与规范序布局一致', () => {
    const repaired = layout(SHUFFLED, 'm')
    assertTopological(repaired, SHUFFLED)
    const canonical = layout(MERGE, 'm')
    expect(repaired.rows.map((row) => [row.oid, row.lane, row.passthrough]))
      .toEqual(canonical.rows.map((row) => [row.oid, row.lane, row.passthrough]))
  })

  it('修复路径确定性（乱序输入两次全等）', () => {
    expect(layout(SHUFFLED, 'm')).toEqual(layout(SHUFFLED, 'm'))
    expect(JSON.stringify(layout(SHUFFLED, 'm'))).toBe(JSON.stringify(layout(SHUFFLED, 'm')))
  })

  it('committedAt 异常（乱序日期）仍产出拓扑序（temporal topological sort 语义）', () => {
    // dev 的 committedAt 比 base 还老（异常时钟）——修复后仍须父在子下方。
    const skewed = [
      commit('m', ['main', 'dev'], '2026-01-04T00:00:00Z'),
      commit('main', ['base'], '2026-01-03T00:00:00Z'),
      commit('dev', ['base'], '2025-01-02T00:00:00Z'),
      commit('base', [], '2026-01-01T00:00:00Z'),
    ]
    const result = layout(skewed, 'm')
    assertTopological(result, skewed)
  })
})
