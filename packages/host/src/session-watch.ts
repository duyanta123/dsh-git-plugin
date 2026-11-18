/**
 * dsh-gitkit — 会话事件观察与检查点索引（v3 批次四 [清单 39/40/41] 的消费底座；
 * docs/v3-implementation-plan.md §6.4）。
 *
 * 职责：构造期 `ctx.on('session/event')`（workspace.ts 先例——监听随宿主 fiber 清理，
 * 不进 static inject），消费
 *   - `type === 'workspace/changes'`（事件自身携带 `seq`，载荷 `{ turn }`——字段名已按
 *     rc.2 `createAppendEvent` 冻结形状核实，plan §0.2-②）建 (sessionId, seq, turn)
 *     检查点索引；
 *   - `type === 'turn/end'`（载荷 `{ turn, reason }`）补 endedAt/reason——两个事件
 *     先到序不定（recorder 的 workspace/changes 经异步快照链，可能晚于 turn/end；
 *     `agent/turn-stopping` 记录时又早于 turn/end），双向补齐；
 *   - `session/disposed` 清理该会话全部索引（workspace-changes src/index.ts:154 同款）。
 *
 * per-session 环（容量 Config `checkpointMaxTurns` 默认 50）：同一 turn 的最新
 * workspace/changes 事件替换旧行（dsh SessionEventMap 注记「The latest event for one
 * turn replaces earlier ones」——时间线一行一回合）。
 *
 * workspaceChanges 服务经**可选切片**读取（plan §0.2-② 可达性口径——绝不进
 * `static inject`）：索引只依赖事件流（服务未挂载的部署照建），summary/diff 在
 * 消费点逐次现读（face 缺失 ⇒ list 的 summary null / 操作侧 git/checkpoint-unavailable，
 * 不伪造——DE=A 诚实降级口径）。现读时点选在消费而非事件回调，有两个原因：
 *   (a) recorder 先 `session.append('workspace/changes')` 后 `records.set(seq)`——
 *       若总线同步发布，事件回调里的 summary(seq) 尚不可取；
 *   (b) 服务 fiber 可能晚于本服务激活（ctx.tools 时序同款），逐次 ctx.get 天然跟随。
 *
 * 降级守卫：`seq`/`data` 在 0.2.1-rc.5 声明下限上的同形性未实证（plan §6.9 残余
 * 风险）——事件缺 `seq` 或载荷缺 `turn` 时该条目跳过（debug 一次），绝不炸监听。
 */

import type { GitSessionEventFace, GitSessionFace } from './workspace.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { CheckpointFileDiff } from './types.ts'

/** 环容量默认（Config checkpointMaxTurns 缺省——plan §6.2 拍板 50）。 */
export const DEFAULT_CHECKPOINT_MAX_TURNS = 50

/**
 * workspace-changes 服务面的最小结构投影（`ctx.get('workspaceChanges')` 切片读取；
 * 零运行期依赖——workspace.ts GitSessionFace 最小结构接口先例）。形状对齐 dsh 树
 * workspace-changes `src/types.ts:30-70`（`WorkspaceChangesSummary`/`WorkspaceFileDiff`）。
 */
export interface GitChangesSummaryFace {
  /** 摘要描述的回合号。 */
  turn: number
  /** 会话工作目录（summary `path` 的相对基准；宿主侧路径）。 */
  cwd: string
  /** 变更文件（display 序，受 maxFiles 封顶）。 */
  files: ReadonlyArray<{ path: string; display: string; added: number; deleted: number }>
  /** 完整变更文件计数（含封顶截去部分）。 */
  total: number
  added: number
  deleted: number
}

/** 逐文件比较的取回面（diff 形状 = wire 的 {@link CheckpointFileDiff} 同形投影）。 */
export interface GitWorkspaceChangesFace {
  summary(sessionId: string, seq: number): GitChangesSummaryFace | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<CheckpointFileDiff | undefined>
}

/**
 * 宿主事件面切片：`session/event` + `session/disposed` 两个事件名的结构监听面
 * （workspace.ts GitSessionEventHost 的双事件扩展）。
 */
export interface SessionWatchHost {
  on(event: 'session/event', listener: (session: GitSessionFace, event: GitSessionEventFace) => void): unknown
  on(event: 'session/disposed', listener: (session: GitSessionFace) => void): unknown
}

/** 环内单条检查点索引行（引擎/测试消费的内部形态；wire 投影在 index.ts `@Remote` 出参）。 */
export interface CheckpointIndexEntry {
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  /**
   * 回合结束时刻：turn/end 已观察 = turn/end 事件时间；尚未观察 = workspace/changes
   * 事件自身时间（host epoch ms → ISO）。turn/end 晚到时原位更新。
   */
  endedAt: string
  /** turn/end reason.kind（批次四评审收口起经 wire CheckpointEntry.reason 投影——§6.6 时间线 reason 徽标；null = 尚未观察到 turn/end）。 */
  reason: string | null
  /** workspace/changes 事件自身时间（epoch ms——列表 newest-first 排序键）。 */
  recordedAt: number
}

/** turn/end 观察的暂存行（workspace/changes 晚到序时补齐 endedAt/reason 用；容量随环钳制）。 */
interface TurnEndMemo {
  at: number
  reason: string | null
}

/** SessionWatch 构造项。 */
export interface SessionWatchOptions {
  /** per-session 环容量（Config checkpointMaxTurns；非法/缺席回落 DEFAULT_CHECKPOINT_MAX_TURNS）。 */
  maxTurns?: number
  /** 可选 logger（降级跳过走 debug——不落事件内容，spec §1.0.6）。 */
  logger?: GitLoggerFace | undefined
}

/** 单事件载荷的最小判别形状（`workspace/changes` 与 `turn/end` 共用 `{ turn }` 骨架）。 */
interface TurnEventData {
  turn?: unknown
  reason?: unknown
}

/**
 * 会话事件观察器：per-session 检查点环 + turn/end 记忆。监听注册在构造期
 * （host 面给出时）；测试可直喂 {@link observe}（WorkspaceResolver.observe 先例）。
 */
export class SessionWatch {
  /** sessionId → 环（插入序 = 事件到达序；列表序在 entries() 现排）。 */
  private readonly rings = new Map<string, CheckpointIndexEntry[]>()
  /** sessionId → (turn → turn/end 记忆)：workspace/changes 晚到序的 endedAt/reason 补齐源。 */
  private readonly turnEnds = new Map<string, Map<number, TurnEndMemo>>()
  private readonly maxTurns: number
  private readonly logger: GitLoggerFace | undefined

  constructor(
    /** 宿主上下文面；提供时注册 session/event 与 session/disposed 监听。 */
    host?: SessionWatchHost,
    options: SessionWatchOptions = {},
  ) {
    const max = options.maxTurns ?? DEFAULT_CHECKPOINT_MAX_TURNS
    this.maxTurns = Number.isSafeInteger(max) && max >= 1 ? max : DEFAULT_CHECKPOINT_MAX_TURNS
    this.logger = options.logger
    host?.on('session/event', (session, event) => { this.observe(session, event) })
    host?.on('session/disposed', (session) => { this.forget(session.id) })
  }

  /** session/event 处理（构造期监听与测试直喂共用；只消费两类事件，其余忽略）。 */
  observe(session: GitSessionFace, event: GitSessionEventFace): void {
    const sessionId = typeof session?.id === 'string' && session.id !== '' ? session.id : null
    if (sessionId === null) return
    if (event.type === 'workspace/changes') {
      this.recordChange(sessionId, event)
      return
    }
    if (event.type === 'turn/end') {
      this.recordTurnEnd(sessionId, event)
    }
  }

  /** session/disposed 清理（workspace-changes src/index.ts:154 同款时机）：环与 turn/end 记忆全弃。 */
  forget(sessionId: unknown): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (this.rings.delete(sessionId)) this.turnEnds.delete(sessionId)
  }

  /**
   * 全部会话的环内索引（newest-first：recordedAt 降序，平局按 sessionId/seq 定序——
   * 跨会话 seq 不可比，endedAt 晚到更新不改序）。
   */
  entries(): CheckpointIndexEntry[] {
    const all: CheckpointIndexEntry[] = []
    for (const ring of this.rings.values()) all.push(...ring)
    return all.sort((a, b) =>
      b.recordedAt - a.recordedAt
      || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
      || b.seq - a.seq)
  }

  /**
   * seq → 环内唯一条目的解析（checkpointDiff/checkpointRestore 的 seq 校验半）。
   * seq 仅在单会话内唯一：跨会话命中多条 ⇒ 'ambiguous'（操作侧硬失败，防把别的
   * 会话的 diff 反向应用到本仓库）；零命中 ⇒ 'missing'。
   *
   * **sessionId 判别半**（批次四评审收口）：传入非空 sessionId 时只在**该会话的环**
   * 内解析——多会话并发下 seq 碰撞不再歧义（wire CheckpointDiffOptions/RestoreOptions
   * 的可选 sessionId，client 回传条目自带的 sessionId）；判别半下 'ambiguous' 不可达
   * （单环内 seq 唯一）。缺席 = 维持现状口径（唯一放行/歧义硬拒）。
   */
  resolveSeq(seq: number, sessionId?: string): { kind: 'unique'; sessionId: string; entry: CheckpointIndexEntry }
    | { kind: 'ambiguous'; sessionIds: string[] }
    | { kind: 'missing' } {
    const hits: Array<{ sessionId: string; entry: CheckpointIndexEntry }> = []
    if (sessionId !== undefined && sessionId !== '') {
      const entry = this.rings.get(sessionId)?.find((candidate) => candidate.seq === seq)
      if (entry === undefined) return { kind: 'missing' }
      return { kind: 'unique', sessionId, entry }
    }
    for (const [ringSessionId, ring] of this.rings) {
      const entry = ring.find((candidate) => candidate.seq === seq)
      if (entry !== undefined) hits.push({ sessionId: ringSessionId, entry })
    }
    if (hits.length === 1) {
      const hit = hits[0]!
      return { kind: 'unique', sessionId: hit.sessionId, entry: hit.entry }
    }
    if (hits.length === 0) return { kind: 'missing' }
    return { kind: 'ambiguous', sessionIds: hits.map((hit) => hit.sessionId).sort() }
  }

  /** 测试/观测面：指定会话的环（到达序；未观察过的会话 = 空数组）。 */
  ringOf(sessionId: string): CheckpointIndexEntry[] {
    return [...(this.rings.get(sessionId) ?? [])]
  }

  /** `workspace/changes` 消费：取 (seq, turn) 建行——同 turn 替换旧行，环容量截断最旧。 */
  private recordChange(sessionId: string, event: GitSessionEventFace): void {
    const seq = event.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      this.logger?.debug('git session-watch: workspace/changes event without a usable seq skipped (degraded)')
      return
    }
    const turn = turnOf(event.data)
    if (turn === null) {
      this.logger?.debug('git session-watch: workspace/changes event without a usable turn skipped (degraded)')
      return
    }
    const time = event.time
    const recordedAt = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
    const memo = this.turnEnds.get(sessionId)?.get(turn)
    const ring = this.rings.get(sessionId) ?? []
    this.rings.set(sessionId, ring)
    const existing = ring.find((entry) => entry.turn === turn)
    const entry: CheckpointIndexEntry = {
      sessionId,
      seq,
      turn,
      // turn/end 先到序：endedAt/reason 直接补齐（晚到序由 recordTurnEnd 回填）。
      endedAt: new Date(memo !== undefined ? memo.at : recordedAt).toISOString(),
      reason: memo !== undefined ? memo.reason : null,
      recordedAt,
    }
    if (existing !== undefined) {
      // 同 turn 的最新事件替换旧行（dsh SessionEventMap 注记）——保持在环原位。
      ring[ring.indexOf(existing)] = entry
    } else {
      ring.push(entry)
      while (ring.length > this.maxTurns) ring.shift()
    }
  }

  /** `turn/end` 消费：记忆 (turn → at/reason) 并回填环内同 turn 行（两序皆备）。 */
  private recordTurnEnd(sessionId: string, event: GitSessionEventFace): void {
    const turn = turnOf(event.data)
    if (turn === null) return
    const time = event.time
    const at = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
    const reason = reasonKindOf(event.data)
    const ends = this.turnEnds.get(sessionId) ?? new Map<number, TurnEndMemo>()
    this.turnEnds.set(sessionId, ends)
    ends.set(turn, { at, reason })
    // 记忆容量随环钳制（只保留环内 turn 与少量待补 turn——纯无文件回合不积账）。
    while (ends.size > this.maxTurns) {
      const smallest = [...ends.keys()].sort((a, b) => a - b)[0]
      if (smallest === undefined) break
      ends.delete(smallest)
    }
    const ring = this.rings.get(sessionId)
    if (ring !== undefined) {
      for (const entry of ring) {
        if (entry.turn === turn) {
          entry.endedAt = new Date(at).toISOString()
          entry.reason = reason
        }
      }
    }
  }
}

/** 载荷 `{ turn }` 骨架窄化（safe integer 才收）。 */
function turnOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const turn = (data as TurnEventData).turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

/** turn/end reason 的 kind 提取（dsh TurnEndReason = `{ kind: … }` 和型；未知形状 = null）。 */
function reasonKindOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const kind = (data as TurnEventData).reason
  if (typeof kind !== 'object' || kind === null) return null
  const value = (kind as { kind?: unknown }).kind
  return typeof value === 'string' ? value : null
}
