/**
 * dsh-gitkit — 会话改动时间线 / 归因徽标纯视图模型（V3 批次四 [清单 39/40/41]；
 * v3-implementation-plan §6.6 的 client 纯函数半）。
 *
 * 渲染决策收敛为纯函数（组件只做 t/订阅/事件——spec §6 纯函数纪律，stash-view-model/
 * conflict-view-model 同款；tests/checkpoint-view.spec.ts 断言）。不依赖 DOM/React。
 *
 * 诚实降级口径（DE=A，plan §6.6）：summary = null 的回合**如实呈现 unavailable 文案**
 * （Host 重启/会话处置后的记录不保留，不伪造）；unknown 徽标 = 无记录覆盖（重启前
 * 历史），tooltip 明示「宿主重启前的回合没有变更记录」。
 *
 * wire 缺口收口（批次四评审）：方案 §6.6 的时间线行要求「reason 徽标」——wire
 * `CheckpointEntry.reason: string | null` 已过线（批次四评审收口交付，§1 变更链回填
 * §6.2），本文件以 `checkpointReasonView` 承接（已知 kind 走词典、未知 kind 原样显示
 * ——dsh TurnEndReasonMap merge-extensible，徽标不因新增 kind 破坏）。
 *
 * 「恢复此回合」的 danger 闸 = reduceRestore 状态机（confirm 事件在勾选未置时 no-op，
 * 双层闸的第二层——GitConfirmDialog 的 confirmButtonEnabled 为第一层，ui-model.ts:281）
 * + baseRevision 乐观并发基线（discard 三重守卫范式——捕获时点 = 确认时刻的 HEAD oid，
 * store/git-changes-store.ts:197-201 同款）。
 */

import type {
  AttributionEntry, CheckpointEntry, CheckpointFileDiff, CheckpointRestoreOptions,
  CheckpointRestoreResult, DiffFile,
} from 'dsh-gitkit/types'
import { relativeTime } from './blame-view.js'
import type { GitLocaleKey } from './locales.js'
import type { GitErrorLike } from './remote/mount.js'
import type { ChangeGroupModel, ChangeRow, ChangesViewModel } from './changes-view-model.js'

// ── [39] 时间线：会话过滤 + turn 分组 ────────────────────────────────────────

/**
 * 环内条目按当前会话过滤（v1 单会话口径——wire `CheckpointEntry.sessionId` 的注释
 * 「client 侧按当前会话过滤」；host 环跨会话持有全部条目）。
 */
export function currentSessionEntries(entries: readonly CheckpointEntry[], sessionId: string): CheckpointEntry[] {
  return entries.filter((entry) => entry.sessionId === sessionId)
}

/** 时间线文件行（diff 定位三元组 seq/index 随行——checkpointDiff 的入参半）。 */
export interface TimelineFileRow {
  path: string
  added: number
  deleted: number
  /** 产出该文件的环内事件序列号（checkpointDiff/checkpointRestore 的 seq）。 */
  seq: number
  /** 该文件在其 summary.files 内的下标（checkpointDiff 的 index）。 */
  index: number
}

/** 一个回合的分组渲染模型（时间线一行一回合——session-watch 同 turn 替换语义）。 */
export interface TimelineTurnGroup {
  turn: number
  /** 回合结束时刻（ISO；最新条目的 endedAt）。 */
  endedAt: string
  /** turn/end reason.kind（组内首个非 null——同 turn 单条替换语义下即该回合的结束原因）。 */
  reason: string | null
  /** 该回合的环内条目（newest-first；同会话同 turn 在环内被替换为单条）。 */
  entries: CheckpointEntry[]
  /** 有 summary 条目的文件行（path 升序；跨条目同 path 以最新条目为准）。 */
  files: TimelineFileRow[]
  /** 完整变更文件计数之和（含封顶截去部分——CheckpointSummary.total 语义）。 */
  total: number
  /** ±计数之和（仅可统计有 summary 的条目）。 */
  added: number
  deleted: number
  /** ≥1 条目有 summary（文件清单/±计数可渲染的前提）。 */
  summaryAvailable: boolean
  /** 全部条目 summary null ⇒ 「恢复此回合」不可用 + unavailable 文案（诚实降级）。 */
  allUnavailable: boolean
  /** restore/diff 的锚 seq（组内最新条目——同 turn 的最新快照）。 */
  seq: number
}

/**
 * 环内条目 → turn 分组（newest-first——host entries() 已 newest-first，组序随输入；
 * 组内条目按输入序保留，同 turn 同会话在环内已替换为单条，多条只出现在跨会话输入）。
 * 文件行按 path 升序（跨条目同 path 先到先得——最新条目优先，替换语义下即最新快照）。
 */
export function groupCheckpointTurns(entries: readonly CheckpointEntry[]): TimelineTurnGroup[] {
  const groups = new Map<number, TimelineTurnGroup>()
  for (const entry of entries) {
    const existing = groups.get(entry.turn)
    if (existing !== undefined) {
      existing.entries.push(entry)
      continue
    }
    groups.set(entry.turn, {
      turn: entry.turn,
      endedAt: entry.endedAt,
      reason: entry.reason,
      entries: [entry],
      files: [],
      total: 0,
      added: 0,
      deleted: 0,
      summaryAvailable: false,
      allUnavailable: true,
      seq: entry.seq,
    })
  }
  // Map 迭代序 = 插入序 = 组的首次出现序（newest-first）；逐组遍历其全部条目
  // （组内多条目只出现在跨会话输入——文件 path 去重，最新条目先得）。
  const out: TimelineTurnGroup[] = []
  for (const group of groups.values()) {
    for (const entry of group.entries) {
      // reason 徽标取组内首个非 null（同 turn 单条替换语义下即该回合的结束原因；
      // 跨会话同 turn 组以 newest-first 首条为准）。
      if (group.reason === null && entry.reason !== null) group.reason = entry.reason
      const files = entry.summary?.files
      for (let index = 0; index < (files?.length ?? 0); index += 1) {
        const file = files?.[index]
        if (file === undefined) continue
        if (group.files.some((row) => row.path === file.path)) continue
        group.files.push({ path: file.path, added: file.added, deleted: file.deleted, seq: entry.seq, index })
      }
      if (entry.summary !== null) {
        group.summaryAvailable = true
        group.allUnavailable = false
        group.total += entry.summary.total
        group.added += entry.summary.added
        group.deleted += entry.summary.deleted
      }
    }
    group.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    out.push(group)
  }
  return out
}

// ── [39] 回合时间 ────────────────────────────────────────────────────────────

/**
 * 回合时间的渲染模型（相对时间的词典半或绝对日期的文本半；组件按 kind 渲染）。
 * 相对半 = **复用 blame-view.relativeTime**（既有 30 天窗 + blame.time.* 词典——
 * 不另造相对时间词汇）；超窗/解析失败 → 绝对日期文本（formatCommitDate 同形态，
 * 中性数字串不走词典——组件回落逻辑与 GitBlameView.tsx:119-143 一致）。
 */
export type CheckpointTimeView =
  | { kind: 'locale'; key: GitLocaleKey; params: Record<string, number> }
  | { kind: 'text'; value: string }

const ABSOLUTE_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/

/**
 * 回合结束时刻 → 时间渲染视图（nowMs 注入保证纯函数）。复用 blame-view.relativeTime
 * （刚刚/N 分钟前/N 小时前/N 天前——30 天窗）；超窗回落 ISO 派生的 `YYYY-MM-DD HH:mm`
 * （formatCommitDate 同形态的中性文本），解析失败回落原串——总有一行可读时间，
 * 不伪造「刚刚」。
 */
export function checkpointTimeView(iso: string, nowMs: number): CheckpointTimeView {
  const relative = relativeTime(iso, nowMs)
  if (relative !== null) return { kind: 'locale', key: relative.key, params: relative.params }
  const match = ABSOLUTE_STAMP.exec(iso)
  return { kind: 'text', value: match !== null ? `${match[1]} ${match[2]}` : iso }
}

// ── [39] turn/end reason 徽标（plan §6.6「相对时间 + reason 徽标 + 文件计数」）──

/** dsh `TurnEndReasonMap` 的基础词汇（merge-extensible——本表只做已知 kind 的词典半）。 */
const REASON_LABEL_KEYS: Readonly<Record<string, GitLocaleKey>> = Object.freeze({
  completed: 'checkpoint.reason.completed',
  aborted: 'checkpoint.reason.aborted',
  blocked: 'checkpoint.reason.blocked',
  error: 'checkpoint.reason.error',
  'max-tokens': 'checkpoint.reason.maxTokens',
  interrupted: 'checkpoint.reason.interrupted',
  forked: 'checkpoint.reason.forked',
})

/** reason 徽标渲染视图（checkpointTimeView 同形：词典半或原样文本半）。 */
export type CheckpointReasonView =
  | { kind: 'locale'; key: GitLocaleKey }
  | { kind: 'raw'; value: string }

/**
 * turn/end reason.kind → 徽标渲染视图（纯函数）。已知 kind 走 `checkpoint.reason.*`
 * 词典；未知 kind（dsh merge-extensible，插件可并新 variant）**原样显示**——不吞掉
 * 不认识的结束原因；null（尚未观察到 turn/end）→ null（徽标不渲染，不冒充任何态）。
 */
export function checkpointReasonView(reason: string | null): CheckpointReasonView | null {
  if (reason === null) return null
  const known = REASON_LABEL_KEYS[reason]
  return known !== undefined ? { kind: 'locale', key: known } : { kind: 'raw', value: reason }
}

// ── [40] 归因徽标四态 ────────────────────────────────────────────────────────

/** 归因四态（wire `AttributionEntry.attribution` 的同形投影）。 */
export type AttributionState = AttributionEntry['attribution']

/** 归因筛选的判别域（'all' = 不筛选）。 */
export type AttributionFilter = 'all' | AttributionState

/** 筛选控件的五态（渲染序 = 控件序）。 */
export const ATTRIBUTION_FILTERS: readonly AttributionFilter[] = ['all', 'agent', 'user', 'mixed', 'unknown']

/** 徽标词典键（state → `checkpoint.attribution.*`）。 */
export function attributionLabelKey(state: AttributionState): GitLocaleKey {
  return `checkpoint.attribution.${state}`
}

/** 归因条目 → 徽标渲染模型（tooltip 按态给诚实说明；unknown 明示重启前无记录）。 */
export interface AttributionBadgeView {
  state: AttributionState
  /** 覆盖该路径的回合号（升序——agent tooltip 的插值源）。 */
  turns: number[]
  labelKey: GitLocaleKey
  tipKey: GitLocaleKey
  tipParams: Record<string, string>
}

/** attributionGet 出参 → path 映射（卡片徽标的查询面）。 */
export function attributionMap(entries: readonly AttributionEntry[]): Map<string, AttributionEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]))
}

/**
 * 单条归因 → 徽标视图。entry 缺席（attributionGet 未就绪/路径不在快照）→ null——
 * 徽标不渲染（不把「尚未加载」冒充成「无记录」——unknown 有专属诚实语义）。
 */
export function attributionBadgeView(entry: AttributionEntry | undefined): AttributionBadgeView | null {
  if (entry === undefined) return null
  const turns = [...entry.turns]
  switch (entry.attribution) {
    case 'agent':
      return {
        state: 'agent', turns,
        labelKey: 'checkpoint.attribution.agent',
        tipKey: 'checkpoint.attribution.agentTip',
        tipParams: { turns: turns.join(', ') },
      }
    case 'user':
      return { state: 'user', turns, labelKey: 'checkpoint.attribution.user', tipKey: 'checkpoint.attribution.userTip', tipParams: {} }
    case 'mixed':
      return { state: 'mixed', turns, labelKey: 'checkpoint.attribution.mixed', tipKey: 'checkpoint.attribution.mixedTip', tipParams: {} }
    default:
      return {
        state: 'unknown', turns,
        labelKey: 'checkpoint.attribution.unknown',
        tipKey: 'checkpoint.attribution.unknownTip',
        tipParams: {},
      }
  }
}

// ── [40] 按归因筛选变更列表 ──────────────────────────────────────────────────

/**
 * 归因筛选 × 变更视图模型 → 过滤后的视图模型（plan §6.6「时间线区筛选（按归因过滤
 * 文件列表）」的纯半——控件渲染在时间线折叠区，作用对象 = 主文件卡片列表）。
 * 'all' 原样返回（同引用）；其余按 attribution 映射留行、空组裁撤、rowByPath/totalRows
 * 重建（选中定位与展开逻辑吃同一映射，过滤行不再可展开）。映射缺席的路径不留
 * （attributionGet 覆盖全部 status 路径——缺席即数据未就绪，不冒充任何态）。
 */
export function filterChangesViewModel(
  view: ChangesViewModel,
  attribution: Map<string, AttributionEntry>,
  filter: AttributionFilter,
): ChangesViewModel {
  if (filter === 'all') return view
  const keep = (path: string): boolean => attribution.get(path)?.attribution === filter
  const rowByPath = new Map<string, ChangeRow>()
  const groups: ChangeGroupModel[] = []
  for (const group of view.groups) {
    const rows = group.rows.filter((row) => keep(row.path))
    if (rows.length === 0) continue
    for (const row of rows) if (!rowByPath.has(row.path)) rowByPath.set(row.path, row)
    groups.push({ ...group, rows })
  }
  return { ...view, groups, totalRows: rowByPath.size, rowByPath }
}

// ── [41] checkpointDiff → 既有 FileDiff 只读渲染 ─────────────────────────────

/** hunk 体行计数（host checkpoints.ts serializeCheckpointPatch 同口径：'-'/空格计旧侧、'+'/' ' 计新侧）。 */
function hunkCounts(lines: readonly string[]): { oldCount: number; newCount: number } {
  return {
    oldCount: lines.filter((line) => line.startsWith('-') || line.startsWith(' ')).length,
    newCount: lines.filter((line) => line.startsWith('+') || line.startsWith(' ')).length,
  }
}

/**
 * {@link CheckpointFileDiff} → 既有 `DiffFile`（FileDiffView 只读渲染的输入形状；
 * selection 不传 = 只读——plan §6.6「点击看 diff（checkpointDiff → 既有 FileDiff
 * 渲染结构，只读）」）。
 *
 * patch 文本按 host serializeCheckpointPatch 的头部纪律重建（`diff --git` 头必带、
 * 新增/删除带 /dev/null 头 + mode 扩展行、零行侧起点归一 `0`、hunk 计数自 body 重算）
 * ——客户端 parsePatch（diff/patch-hunks.ts）按行前缀解析，该文本可无损往返。
 * hunks 空（两侧同行 no-op）⇒ patch ''（FileDiffView 落 diff.empty 占位）；binary/
 * oversized ⇒ 对应旗标占位（patch null——FileDiffView 的占位分支先行）。
 */
export function checkpointDiffFile(file: CheckpointFileDiff): DiffFile {
  if (file.kind === 'binary') {
    return { path: file.path, origPath: null, status: 'modified', binary: true, additions: null, deletions: null, patch: null, patchTruncated: false, oversized: false }
  }
  if (file.kind === 'oversized') {
    return { path: file.path, origPath: null, status: 'modified', binary: false, additions: null, deletions: null, patch: null, patchTruncated: false, oversized: true }
  }
  const status: DiffFile['status'] = file.before === false ? 'added' : file.after === false ? 'deleted' : 'modified'
  let additions = 0
  let deletions = 0
  const lines: string[] = []
  if (file.hunks.length > 0) {
    lines.push(`diff --git a/${file.path} b/${file.path}`)
    if (file.before === false && file.after === true) lines.push('new file mode 100644')
    if (file.before === true && file.after === false) lines.push('deleted file mode 100644')
    lines.push(`--- ${file.before === true ? `a/${file.path}` : '/dev/null'}`)
    lines.push(`+++ ${file.after === true ? `b/${file.path}` : '/dev/null'}`)
    for (const hunk of file.hunks) {
      const { oldCount, newCount } = hunkCounts(hunk.lines)
      const oldStart = oldCount === 0 ? 0 : hunk.oldStart
      const newStart = newCount === 0 ? 0 : hunk.newStart
      lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
      for (const line of hunk.lines) {
        lines.push(line)
        if (line.startsWith('+')) additions += 1
        else if (line.startsWith('-')) deletions += 1
      }
    }
  }
  return {
    path: file.path,
    origPath: null,
    status,
    binary: false,
    additions,
    deletions,
    patch: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    patchTruncated: false,
    oversized: false,
  }
}

// ── [39] 恢复此回合：danger 闸状态机（discard 三重守卫范式）──────────────────

/** 恢复流程相位（idle → confirming → running → applied|partial|error → idle）。 */
export type RestorePhase = 'idle' | 'confirming' | 'running' | 'applied' | 'partial' | 'error'

/** 恢复状态机的当前态（组件渲染与 wire 调用都从这里读）。 */
export interface RestoreMachineState {
  phase: RestorePhase
  /** 待恢复回合的锚 seq（null = 空闲）。 */
  seq: number | null
  /** 待恢复回合号（确认文案插值）。 */
  turn: number | null
  /** 确认框全量列出的文件路径（恢复范围 = paths null 即全部——wire 语义）。 */
  paths: string[]
  /** danger 勾选闸的勾选态（每轮 request 重置 false——GitConfirmDialog 同语义）。 */
  checkboxChecked: boolean
  /** 确认时刻捕获的 HEAD oid（乐观并发基线；null = 不校验/无快照）。 */
  baseRevision: string | null
  /** 成功结果（applied/partial 相位有值）。 */
  applied: string[]
  /** 部分成功的失败清单（partial 相位渲染 path/reason 行）。 */
  failed: Array<{ path: string; reason: string }>
  /** RPC 层拒绝（checkpoint-unavailable/stale-base-revision 等域码）。 */
  error: GitErrorLike | null
}

/** 空闲态（唯一初值——reducer 不持有模块级句柄）。 */
export function initialRestoreState(): RestoreMachineState {
  return {
    phase: 'idle', seq: null, turn: null, paths: [], checkboxChecked: false,
    baseRevision: null, applied: [], failed: [], error: null,
  }
}

export type RestoreEvent =
  | { type: 'request'; seq: number; turn: number; paths: string[] }
  | { type: 'toggleCheckbox' }
  | { type: 'confirm'; baseRevision: string | null }
  | { type: 'cancel' }
  | { type: 'succeeded'; applied: string[]; failed: Array<{ path: string; reason: string }> }
  | { type: 'rejected'; error: GitErrorLike }
  | { type: 'dismiss' }

/**
 * 恢复流程状态机（纯函数；危险闸的两层：UI 层 = GitConfirmDialog danger 勾选 +
 * confirmButtonEnabled，逻辑层 = 本机 confirm 在 checkboxChecked=false 时 no-op）。
 * baseRevision 在 **confirm 事件**捕获（确认时刻的 HEAD oid——乐观并发基线的捕获点；
 * 请求发起只是打开确认框，对话框存续期间的 HEAD 变化会以新值进 wire，host 侧
 * stale-base-revision 零命令拒绝兜底）。事件在错误相位到达一律 no-op（同态返回原
 * 引用），不发重复 wire。
 */
export function reduceRestore(state: RestoreMachineState, event: RestoreEvent): RestoreMachineState {
  switch (event.type) {
    case 'request': {
      // 仅空闲/已出结果相位可再发起；confirming/running 在途必须先 cancel/收束。
      if (state.phase === 'confirming' || state.phase === 'running') return state
      return {
        phase: 'confirming', seq: event.seq, turn: event.turn, paths: [...event.paths],
        checkboxChecked: false, baseRevision: null, applied: [], failed: [], error: null,
      }
    }
    case 'toggleCheckbox':
      if (state.phase !== 'confirming') return state
      return { ...state, checkboxChecked: !state.checkboxChecked }
    case 'confirm':
      // danger 闸（逻辑层）：勾选未置 ⇒ no-op（确认按钮在 UI 层已禁用，双保险）。
      if (state.phase !== 'confirming' || !state.checkboxChecked) return state
      return { ...state, phase: 'running', baseRevision: event.baseRevision }
    case 'cancel':
      if (state.phase !== 'confirming') return state
      return initialRestoreState()
    case 'succeeded':
      if (state.phase !== 'running' || state.seq === null) return state
      return {
        ...state,
        phase: event.failed.length === 0 ? 'applied' : 'partial',
        applied: [...event.applied],
        failed: event.failed.map((entry) => ({ ...entry })),
      }
    case 'rejected':
      if (state.phase !== 'running' || state.seq === null) return state
      return { ...state, phase: 'error', error: event.error }
    case 'dismiss':
      // running 在途不可 dismiss（wire 已发出——结果事件收束）；confirming 的 dismiss
      // 等价 cancel（遮罩 Escape 关闭路径）。
      if (state.phase === 'running') return state
      if (state.phase === 'idle') return state
      return initialRestoreState()
  }
}

/**
 * running 相位 → wire 入参（acknowledged = true 仅在机器通过勾选闸后可产出——
 * 本函数对非 running 相位返回 null，杜绝旁路调用）。paths 固定 null = 该回合全部
 * 文件（「恢复此回合」语义；host 侧逐条校验记录成员——checkpoints.ts paths 守卫）。
 * sessionId = wire 判别半（批次四评审收口）：时间线行已按当前会话过滤（currentSessionEntries），
 * 回传条目自带的 sessionId 让 host 把 seq 解析收窄到单会话环——多会话并发下 seq 碰撞
 * 不再歧义硬拒；空串不传（host 对空形 invalidOptions）。
 */
export function restoreWireOptions(state: RestoreMachineState, sessionId?: string): CheckpointRestoreOptions | null {
  if (state.phase !== 'running' || state.seq === null) return null
  return {
    seq: state.seq,
    paths: null,
    acknowledged: true,
    baseRevision: state.baseRevision,
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  }
}

/** 出参 → 结果提示视图（applied 全成功 / partial 部分成功——失败行原样透传）。 */
export interface RestoreOutcomeView {
  key: 'checkpoint.restore.applied' | 'checkpoint.restore.partial'
  params: Record<string, number>
}

export function restoreOutcomeView(result: CheckpointRestoreResult): RestoreOutcomeView {
  if (result.failed.length === 0) return { key: 'checkpoint.restore.applied', params: { count: result.applied.length } }
  return { key: 'checkpoint.restore.partial', params: { applied: result.applied.length, failed: result.failed.length } }
}
