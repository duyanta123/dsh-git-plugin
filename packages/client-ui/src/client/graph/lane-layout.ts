/**
 * @dsh-plugin/client-ui-git — 提交图泳道布局纯函数（spec §3.3.1 契约；workflow M12
 * 任务口径文件名 lane-layout.ts、函数名 computeGraphLayout）。
 *
 * **自研声明（PORTING.md F7 行）**：算法思想来自 pvigier 博客教材
 * （research/ported-sources/notes/commit-graph-drawing-algorithms.md：temporal
 * topological sort + active-branches 直线泳道 + 最小空闲位复用），实现为本模块
 * 原创代码；mhutchie/vscode-git-graph web/graph.ts 与 gitamine（GPL-3.0）**零代码
 * 搬运**（前者仅阅读对照行内 lane 状态机思路，后者一行不得移植）。
 *
 * ── G1–G5 契约（workflow M12 测试即断言面）────────────────────────────────
 * G1 单遍前向：行序确定后，泳道分配只做一次自上而下的前向扫描；某行的 lane
 *    只依赖其上方的行（推论：任意截断前缀的布局 = 全量布局的前缀）。
 * G2 分页追加稳定性：对契约输入（children-first 拓扑序），追加一页后整表重跑，
 *    既有行的 oid/lane/passthrough 逐一不变——分页边界上的悬垂边被补全为真实
 *    父边（toRow/toLane 落到新页），但起点行与 travel lane 不变。
 * G3 确定性：同输入恒同输出（全序比较键 + Map/Set 插入序 + 无随机源）。
 * G4 泳道紧致：lane 从 0 起稠密——任一 lane 下标被某节点或某边的跨行垂直段
 *    至少使用一次；新 lane 只在无空闲位时追加；laneCount = 已用最大下标 + 1。
 * G5 多父与悬挂父：octopus（>2 parents）每个非首父各占一条独立跨行边；父提交
 *    不在输入窗口（分页边界）⇒ kind 'dangling' 的边画到窗口底边（toRow ===
 *    rows.length、toOid === null）。
 *
 * ── 行序（G2 的前提）─────────────────────────────────────────────────
 * 输入契约 = children-first（`git log --topo-order` 输出序，spec §3.3.1 注释）。
 * 该序已是拓扑序且按「分支成组」排列（--topo-order 避免分支交错）；若按
 * committedAt 全序重排，会把成组分支拆散插回时间线——分页窗口内出现「后页
 * 提交比前页尾部更新」的普通仓库形态时，前缀行号整体平移，G2 破坏（实测
 * 推演，merge-then-branch 形态即复现）。故本实现：**输入已拓扑 ⇒ 行序 =
 * 输入序**（快路径，G2 由此成立）；输入违反拓扑序（防御：上游乱序/裁剪）⇒
 * 跑 temporal topological sort（committedAt 降序为遍历优先级、输入序为
 * tiebreak——spec §3.3.1 的重排在修复路径落地，确定性由全序键保证）。
 *
 * ── 泳道分配（一次前向扫描）───────────────────────────────────────────
 * 状态 = 每条 lane 的「当前指向」（laneTargets：跨行垂直段正 heading 到的 oid）
 * + 每 lane 当前边的 trunk 旗标（该边是否是其子提交的第一父边）。
 * 对每行（自上而下）：
 *   1. 收集指向本提交的 lane（incoming）——分支子提交的第一父边与合并子提交的
 *      次父边都各自占一条 lane 指向父提交；
 *   2. 本提交取位：有 trunk incoming ⇒ 取最左 trunk lane（分支直线优先，
 *      教材「replace branch child」语义）；否则最左 incoming；否则最小空闲位，
 *      无空闲位才追加（G4）；
 *   3. 消费全部 incoming lane（其边在本行收口，toLane = 本提交 lane）；
 *   4. 出边：首父边沿本提交 lane 直落（travel = 本 lane）；非首父各取最小空闲
 *      位（无则追加）；travel lane 的 target 置为父 oid——次父边即「折返」边，
 *      经中间行垂直段后在本行内由渲染层画贝塞尔收口。
 * GraphEdge 的 fromLane = **travel lane**（边离开 from 行切片时的 lane，即跨行
 * 垂直段所在 lane；直线情形与 from 节点 lane 相等），toLane = 收口节点 lane
 * （dangling 时 = fromLane，垂直段直达窗口底）。渲染层（graph-svg.tsx）按
 * 「from 行：节点 → (fromLane, 底)；中间行：fromLane 全高垂直；to 行：
 * (fromLane, 顶) → 节点」切片绘制，本函数同时给出每行 passthrough（穿过该行、
 * 不属于该行节点的边的 travel lane 集）。
 */

import type { CommitInfo, RefInfo } from '@dsh-plugin/git/types'

/** spec §3.3.1 GraphLayoutInput。 */
export interface GraphLayoutInput {
  /** children-first（git log --topo-order 输出序）；违反拓扑序时走 temporal 修复（见文件头）。 */
  commits: readonly CommitInfo[]
  /** unborn / detached 时由调用方传入（detached 传 HEAD oid）；无 HEAD 传 null。 */
  headOid: string | null
  /** 仅用于行上 ref 装饰（shortName 列表），不影响 lane 分配。 */
  refs: readonly RefInfo[]
}

/** spec §3.3.1 GraphEdge。 */
export interface GraphEdge {
  /** from 行号（子提交所在行）。 */
  fromRow: number
  /** 边离开 from 行切片时的 lane（跨行垂直段所在 lane；直线情形 = from 节点 lane）。 */
  fromLane: number
  /** to 行号；toRow === rows.length 表示悬垂边（父不在已加载窗口，分页边界）。 */
  toRow: number
  /** 收口节点所在 lane；dangling 时 = fromLane（垂直段直达窗口底）。 */
  toLane: number
  /** 父提交 oid；悬垂边为 null。 */
  toOid: string | null
  kind: 'parent' | 'dangling'
}

/** spec §3.3.1 GraphRowLayout。 */
export interface GraphRowLayout {
  row: number
  oid: string
  /** 本提交所在泳道（0 起，稠密化——G4）。 */
  lane: number
  isHead: boolean
  /** 指向本提交的 ref 短名（'HEAD -> main' 形态由渲染层处理——spec §3.3.1）。 */
  refs: string[]
  /** 穿过本行的边所在 travel lane（升序去重；不含本提交自身的边）。 */
  passthrough: number[]
  /** 本提交 → 各父提交的边（parents 顺序，首父在前）。 */
  edges: GraphEdge[]
}

/** spec §3.3.1 GraphLayoutResult。 */
export interface GraphLayoutResult {
  rows: GraphRowLayout[]
  /** 窗口内最大泳道数（渲染列宽 = laneCount * LANE_W）；空输入为 0。 */
  laneCount: number
}

/**
 * 计算泳道布局（纯函数；G1–G5 契约见文件头）。
 * @throws 输入含重复 oid（契约破坏要响，与 host 解析器同纪律）。
 */
export function computeGraphLayout(input: GraphLayoutInput): GraphLayoutResult {
  const commits = input.commits
  const indexOf = new Map<string, number>()
  for (const [index, commit] of commits.entries()) {
    if (indexOf.has(commit.oid)) throw new Error(`computeGraphLayout: duplicate commit oid ${commit.oid}`)
    indexOf.set(commit.oid, index)
  }
  if (commits.length === 0) return { rows: [], laneCount: 0 }

  // 行序：拓扑输入直通（G2），否则 temporal 修复（G3）。
  const ordered = isTopologicalOrder(commits, indexOf) ? [...commits] : temporalTopologicalRepair(commits, indexOf)

  // ── 泳道分配状态 ──
  // laneTargets[lane] = 该 lane 当前跨行边 heading 到的 oid（null = 空闲）。
  const laneTargets: Array<string | null> = []
  // laneTrunk[lane] = 占用该 lane 的边是否为其子提交的首父边（incoming 取位偏好用）。
  const laneTrunk: boolean[] = []
  // pendingByLane[lane] = 占用该 lane 的未收口边草稿（父提交到位时收口）。
  const pendingByLane: Array<EdgeDraft | null> = []
  const edgesByRow: Array<EdgeDraft[]> = Array.from({ length: ordered.length }, () => [])
  const nodeLane = new Map<string, number>()

  const firstFreeLane = (): number => {
    const found = laneTargets.indexOf(null)
    return found === -1 ? laneTargets.length : found
  }
  const addDraft = (draft: EdgeDraft): void => {
    edgesByRow[draft.childRow]!.push(draft)
  }

  for (const [row, commit] of ordered.entries()) {
    // 1. incoming：指向本提交的 lane（升序即 lane 序）。
    const incoming: Array<{ lane: number; trunk: boolean }> = []
    for (const [lane, target] of laneTargets.entries()) {
      if (target === commit.oid) incoming.push({ lane, trunk: laneTrunk[lane] === true })
    }
    // 2. 取位：最左 trunk incoming → 最左 incoming → 最小空闲位（G4）。
    const chosen = incoming.find((item) => item.trunk) ?? incoming[0]
    const lane = chosen !== undefined ? chosen.lane : firstFreeLane()
    nodeLane.set(commit.oid, lane)
    // 3. 消费 incoming：各边在本行收口（toLane = 本提交 lane）。
    for (const item of incoming) {
      laneTargets[item.lane] = null
      const draft = pendingByLane[item.lane]
      if (draft !== null && draft !== undefined && draft.parentOid === commit.oid) {
        draft.toRow = row
        draft.toLane = lane
        pendingByLane[item.lane] = null
      }
    }
    // 4. 出边（parents 去重保序；自引用防御性视作悬垂）。
    const seenParents = new Set<string>()
    for (const parent of commit.parents) {
      if (seenParents.has(parent) || parent === commit.oid) continue
      seenParents.add(parent)
      const parentPos = indexOf.get(parent)
      const first = seenParents.size === 1
      if (parentPos === undefined) {
        // 悬垂父（分页边界）：边直达窗口底；lane 永久占用（G5）。
        const travel = first ? lane : firstFreeLane()
        addDraft({
          childRow: row,
          travel,
          parentOid: parent,
          toRow: ordered.length,
          toLane: travel,
          toOid: null,
          kind: 'dangling',
        })
        reserveLane(travel, parent, first, laneTargets, laneTrunk, pendingByLane, null)
        continue
      }
      const travel = first ? lane : firstFreeLane()
      const draft: EdgeDraft = {
        childRow: row,
        travel,
        parentOid: parent,
        toRow: -1,
        toLane: -1,
        toOid: parent,
        kind: 'parent',
      }
      addDraft(draft)
      reserveLane(travel, parent, first, laneTargets, laneTrunk, pendingByLane, draft)
    }
  }

  // 防御收尾：拓扑修复产物里的环残留边（父提交最终未被分配）转悬垂。
  for (const rowDrafts of edgesByRow) {
    for (const draft of rowDrafts) {
      if (draft.kind === 'parent' && draft.toRow < 0) {
        draft.kind = 'dangling'
        draft.toRow = ordered.length
        draft.toLane = draft.travel
        draft.toOid = null
      }
    }
  }

  // passthrough（G1 的可观测形态：行只依赖上方行）+ 行装配。
  const through: Array<number[]> = Array.from({ length: ordered.length }, () => [])
  let maxLane = -1
  for (const rowDrafts of edgesByRow) {
    for (const draft of rowDrafts) {
      if (draft.travel > maxLane) maxLane = draft.travel
      if (draft.toLane > maxLane) maxLane = draft.toLane
      for (let row = draft.childRow + 1; row < draft.toRow; row++) {
        through[row]!.push(draft.travel)
      }
    }
  }
  const rows: GraphRowLayout[] = ordered.map((commit, row) => {
    const lane = nodeLane.get(commit.oid) ?? 0
    if (lane > maxLane) maxLane = lane
    const passthrough = [...new Set(through[row]!)].sort((a, b) => a - b)
    return {
      row,
      oid: commit.oid,
      lane,
      isHead: commit.oid === input.headOid,
      refs: input.refs.filter((ref) => ref.oid === commit.oid).map((ref) => ref.shortName),
      passthrough,
      edges: edgesByRow[row]!.map((draft): GraphEdge => ({
        fromRow: draft.childRow,
        fromLane: draft.travel,
        toRow: draft.toRow,
        toLane: draft.toLane,
        toOid: draft.toOid,
        kind: draft.kind,
      })),
    }
  })
  return { rows, laneCount: maxLane + 1 }
}

/** 未收口边草稿（行装配的中间形状）。 */
interface EdgeDraft {
  childRow: number
  /** 跨行垂直段所在 lane（= GraphEdge.fromLane）。 */
  travel: number
  parentOid: string
  toRow: number
  toLane: number
  toOid: string | null
  kind: 'parent' | 'dangling'
}

/** 把一条新边登记到 travel lane（target/trunk 旗标/未收口草稿；dangling 已收口传 null）。 */
function reserveLane(
  travel: number,
  parentOid: string,
  trunk: boolean,
  laneTargets: Array<string | null>,
  laneTrunk: boolean[],
  pendingByLane: Array<EdgeDraft | null>,
  pending: EdgeDraft | null,
): void {
  laneTargets[travel] = parentOid
  laneTrunk[travel] = trunk
  pendingByLane[travel] = pending
}

/**
 * 拓扑校验（快路径判据）：每个父提交要么不在窗口（悬垂），要么位于子提交**下方**
 * （下标更大）。O(n·p)。
 */
function isTopologicalOrder(commits: readonly CommitInfo[], indexOf: ReadonlyMap<string, number>): boolean {
  for (const [index, commit] of commits.entries()) {
    for (const parent of commit.parents) {
      if (parent === commit.oid) continue
      const parentIndex = indexOf.get(parent)
      if (parentIndex !== undefined && parentIndex < index) return false
    }
  }
  return true
}

/**
 * temporal topological sort（修复路径；spec §3.3.1「按 committedAt 做确定性 topo
 * 重排、tiebreak 保持输入序」的落地——教材 22.4 DFS 变体的迭代形态，避免长历史的
 * 递归栈溢出）：按（committedAt 降序, 输入序升序）遍历起点；DFS 先充分探索子提交
 * （子树按同键降序展开）再分配行号——产物恒为 children-first，且键全序保证确定性。
 * committedAt 解析失败（NaN）按最旧处理（异常时钟不炸布局）。
 */
function temporalTopologicalRepair(commits: readonly CommitInfo[], indexOf: ReadonlyMap<string, number>): CommitInfo[] {
  const inputIndex = new Map<string, number>()
  for (const [index, commit] of commits.entries()) inputIndex.set(commit.oid, index)
  const committedMs = new Map<string, number>()
  for (const commit of commits) {
    const ms = Date.parse(commit.committedAt)
    committedMs.set(commit.oid, Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms)
  }
  const compareKey = (a: CommitInfo, b: CommitInfo): number => {
    const byDate = (committedMs.get(b.oid) ?? Number.NEGATIVE_INFINITY) - (committedMs.get(a.oid) ?? Number.NEGATIVE_INFINITY)
    if (byDate !== 0) return byDate
    return (inputIndex.get(a.oid) ?? 0) - (inputIndex.get(b.oid) ?? 0)
  }
  const childrenOf = new Map<string, CommitInfo[]>()
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (parent === commit.oid || !indexOf.has(parent)) continue
      const list = childrenOf.get(parent)
      if (list === undefined) childrenOf.set(parent, [commit])
      else list.push(commit)
    }
  }
  const visited = new Set<string>()
  const ordered: CommitInfo[] = []
  for (const start of [...commits].sort(compareKey)) {
    if (visited.has(start.oid)) continue
    // 迭代两阶段 DFS（expand 后回访收口），语义同教材伪代码的递归版。
    const stack: Array<{ node: CommitInfo; expanded: boolean }> = [{ node: start, expanded: false }]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      if (!top.expanded) {
        top.expanded = true
        if (visited.has(top.node.oid)) {
          stack.pop()
          continue
        }
        visited.add(top.node.oid)
        const kids = (childrenOf.get(top.node.oid) ?? [])
          .filter((kid) => !visited.has(kid.oid))
          .sort(compareKey)
        // 倒序入栈使 pop 序 = 键降序（最新子树先分配小行号）。
        for (let index = kids.length - 1; index >= 0; index--) {
          stack.push({ node: kids[index]!, expanded: false })
        }
      } else {
        ordered.push(top.node)
        stack.pop()
      }
    }
  }
  return ordered
}
