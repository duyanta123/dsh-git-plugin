/**
 * dsh-gitkit-ui — 提交图行内 gutter SVG 切片（本模块 ask §③；spec
 * §3.3.2「每行一个 <svg> 切片」——虚拟滚动只渲染可见行，每行切片自含）。
 *
 * 常量（workflow ask §③）：行高 24 / 泳道宽 14；泳道色 = lane 取模 8 的 CSS
 * 变量调色板（`--dsh-git-lane-0..7`，跟随 dsh 暗色主题 [清单 53]——主题未提供
 * 变量时用内置 fallback 色，渲染不空窗）；HEAD 描边 = 节点外圈 ring（CSS 变量
 * `--dsh-git-graph-head-ring`）。变道 = 三次贝塞尔：出边在 from 行切片下半
 * （节点 → fromLane）、入边在 to 行切片上半（fromLane → 节点），中间行为
 * fromLane 全高垂直段（lane-layout.ts 的 passthrough/edges 契约）。
 *
 * 切片几何（lane-layout.ts GraphEdge 语义）：
 *   - passthrough lane：全高直线（该 lane 有边穿过本行）；
 *   - 入边（arrivals，渲染层由行 edges 按 toRow 分桶）：
 *     `M (fromLane, 0) C (fromLane, 6) (node, 6) (node, 12)`；
 *   - 出边（row.edges）：`M (node, 12) C (node, 18) (fromLane, 18) (fromLane, 24)`；
 *   - 节点：实心圆 r=4；isHead 追加外圈 r=6.5 描边（先 ring 后节点覆盖）。
 * 颜色一律取 travel lane（边的身份 = 其跨行垂直段所在 lane；入边/出边/passthrough
 * 同色，与 gitk 的分支线着色一致）。
 */

import type { ReactNode } from 'react'
import type { GraphRowLayout } from './lane-layout.js'

/** 行高（workflow ask §③）。 */
export const GRAPH_ROW_HEIGHT = 24

/** 泳道宽（workflow ask §③）。 */
export const GRAPH_LANE_WIDTH = 14

/** 泳道色数量（lane 取模；spec §3.3.2「lane 序号取模 8 色 CSS 变量调色板」）。 */
export const GRAPH_LANE_COLOR_COUNT = 8

/** 节点半径与 HEAD 描边半径（切片几何常量）。 */
const NODE_RADIUS = 4
const HEAD_RING_RADIUS = 6.5
const LINE_WIDTH = 2

/** 泳道 fallback 调色板（主题未提供 --dsh-git-lane-* 时的兜底；暗色底友好）。 */
const LANE_FALLBACKS: readonly string[] = [
  '#5b8def', '#4caf7d', '#e0a63f', '#d45f74', '#9a6fd0', '#43b8c9', '#c97db3', '#8fa860',
]

/** lane → 颜色（CSS 变量 + fallback）。 */
export function laneColor(lane: number): string {
  const slot = ((lane % GRAPH_LANE_COLOR_COUNT) + GRAPH_LANE_COLOR_COUNT) % GRAPH_LANE_COLOR_COUNT
  return `var(--dsh-git-lane-${slot}, ${LANE_FALLBACKS[slot]})`
}

/** lane 中心 x 坐标（切片内）。 */
export function laneX(lane: number): number {
  return lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
}

/** 一条到达本行的入边端点（渲染层把全表 edges 按 toRow 分桶得到）。 */
export interface GraphArrival {
  fromLane: number
}

const EMPTY_ARRIVALS: readonly GraphArrival[] = []

/** 入边贝塞尔（to 行切片上半：fromLane → 节点）。 */
function arrivalPath(fromX: number, nodeX: number): string {
  return `M ${fromX} 0 C ${fromX} 6, ${nodeX} 6, ${nodeX} 12`
}

/** 出边贝塞尔（from 行切片下半：节点 → fromLane）。 */
function departurePath(nodeX: number, fromX: number): string {
  return `M ${nodeX} 12 C ${nodeX} 18, ${fromX} 18, ${fromX} 24`
}

/**
 * 渲染一行的图切片（纯展示；无 hooks——虚拟行组件直接内联调用）。
 * @param props.row 行布局（lane-layout.ts 产物）。
 * @param props.laneCount 全表泳道数（切片宽 = laneCount * GRAPH_LANE_WIDTH）。
 * @param props.arrivals 到达本行的入边（toRow === row.row 的 edges 投影）。
 */
export function GraphLaneSvg(props: {
  row: GraphRowLayout
  laneCount: number
  arrivals?: readonly GraphArrival[]
}): ReactNode {
  const { row, laneCount, arrivals = EMPTY_ARRIVALS } = props
  const width = Math.max(1, laneCount) * GRAPH_LANE_WIDTH
  const nodeX = laneX(row.lane)
  return (
    <svg
      className='dsh-git-graph__gutter'
      data-git-graph-gutter=''
      data-git-graph-row={row.oid}
      data-git-graph-lane={row.lane}
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
      aria-hidden='true'
      focusable='false'
    >
      {row.passthrough.map((lane) => (
        <line
          key={`p${lane}`}
          x1={laneX(lane)}
          y1={0}
          x2={laneX(lane)}
          y2={GRAPH_ROW_HEIGHT}
          stroke={laneColor(lane)}
          strokeWidth={LINE_WIDTH}
        />
      ))}
      {arrivals.map((arrival, index) => (
        <path
          key={`a${index}`}
          d={arrivalPath(laneX(arrival.fromLane), nodeX)}
          fill='none'
          stroke={laneColor(arrival.fromLane)}
          strokeWidth={LINE_WIDTH}
        />
      ))}
      {row.edges.map((edge, index) => (
        <path
          key={`e${index}`}
          d={departurePath(nodeX, laneX(edge.fromLane))}
          fill='none'
          stroke={laneColor(edge.fromLane)}
          strokeWidth={LINE_WIDTH}
        />
      ))}
      {row.isHead && (
        <circle
          cx={nodeX}
          cy={GRAPH_ROW_HEIGHT / 2}
          r={HEAD_RING_RADIUS}
          fill='none'
          stroke='var(--dsh-git-graph-head-ring, #f2b03d)'
          strokeWidth={1.5}
          data-git-graph-head=''
        />
      )}
      <circle
        cx={nodeX}
        cy={GRAPH_ROW_HEIGHT / 2}
        r={NODE_RADIUS}
        fill={laneColor(row.lane)}
        data-git-graph-node=''
      />
    </svg>
  )
}

/**
 * 全表出边 → 逐行 arrivals 桶（渲染层一次性 O(rows + edges)；避免每行扫描全表）。
 * 入边去重：同一行同 fromLane 的多条入边只画一条（理论不发生，防御 Octopus 折返
 * 同 lane 的退化输入）。
 */
export function bucketArrivals(rows: readonly GraphRowLayout[]): Map<number, GraphArrival[]> {
  const buckets = new Map<number, GraphArrival[]>()
  for (const row of rows) {
    for (const edge of row.edges) {
      if (edge.kind === 'dangling') continue // 悬垂边没有收口行
      let bucket = buckets.get(edge.toRow)
      if (bucket === undefined) {
        bucket = []
        buckets.set(edge.toRow, bucket)
      }
      if (!bucket.some((arrival) => arrival.fromLane === edge.fromLane)) {
        bucket.push({ fromLane: edge.fromLane })
      }
    }
  }
  return buckets
}
