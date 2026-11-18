/**
 * dsh-gitkit-ui — 检查点/归因数据缓存 store（V3 批次四 [39][40][41]；plan §6.6
 * 「checkpointList 轮询接入既有 HostReadStore 模式（低频——打开折叠区才拉取，不做
 * 常驻轮询）」的 client 半）。
 *
 * **范式 A**：裸 `createSnapshotStore` observable，工厂函数（模块级句柄禁止——map
 * §3.4）；root 作用域（apply 顶层创建 + ctx.effect 清理；git-changes-store 同款）。
 *
 * 三段数据：
 *  - `timeline`（checkpointList 环内条目）：**打开折叠区才拉**——组件在 open 且相位
 *    idle 时 ensureTimeline()；status revision 变化（新帧/写后失效）自动把相位打回
 *    idle，下一次打开/仍在展开时由组件 effect 重拉（不做常驻轮询——HostReadStore
 *    按需拉取 + 代际失效语义）；
 *  - `attribution`（attributionGet 徽标映射）：仓库可用即按 revision 一次（status 快照
 *    面，host 侧 1.5s 缓存语义）；revision 变化同样自动 idle → 组件重拉；
 *  - `diffs`（checkpointDiff 槽位）：键 = `${seq}:${index}`；回合快照冻结不变——**不随
 *    revision 失效**，error 态可重试，in-flight 去重。
 *
 * revision 失效的代际纪律与 git-changes-store 相同：订阅状态源，revision 递增即
 * 递增代际 + 时间线/归因打回 idle，旧代际在途响应一律丢弃（绝不写回新代际）。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AttributionEntry, AttributionResult, CheckpointEntry, CheckpointFileDiff, CheckpointListResult } from 'dsh-gitkit/types'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import { GATEWAY_UNAVAILABLE } from '../remote/mount.js'
import type { GitStatusSource } from './git-status-source.js'

/** 一段只读数据（timeline / attribution 共形）的相位。 */
export type CheckpointSectionPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 时间线段（checkpointList 的缓存面）。 */
export interface CheckpointTimelineState {
  phase: CheckpointSectionPhase
  entries: CheckpointEntry[]
  /** error 时有值（按 code 判别；GitErrorNotice + 重试渲染）。 */
  error: GitErrorLike | null
}

/** 归因段（attributionGet 的缓存面；卡片徽标 + 筛选的数据源）。 */
export interface CheckpointAttributionState {
  phase: CheckpointSectionPhase
  entries: AttributionEntry[]
  error: GitErrorLike | null
}

/** 一个 checkpointDiff 槽位（'idle' 由「键缺席」表达——diff 槽同 DiffEntryState 形状）。 */
export interface CheckpointDiffSlot {
  state: 'loading' | 'ready' | 'error'
  diff?: CheckpointFileDiff
  error?: GitErrorLike
}

/** store 快照（范式 A store 形状）。 */
export interface GitCheckpointState {
  timeline: CheckpointTimelineState
  attribution: CheckpointAttributionState
  /** diff 槽位；键 = checkpointDiffSlotKey(seq, index)。 */
  diffs: Record<string, CheckpointDiffSlot>
}

/** store 消费的 RPC 面（GitRpcFace 的 checkpoint 读切片——结构化窄化）。 */
export interface GitCheckpointRpcFace {
  checkpointList(limit?: number | null): Promise<RemoteResult<CheckpointListResult>>
  checkpointDiff(options: { seq: number; index: number; sessionId?: string | null }): Promise<RemoteResult<CheckpointFileDiff>>
  attributionGet(): Promise<RemoteResult<AttributionResult>>
}

/** 状态源消费面（revision 失效的订阅源——createGitStatusSource 产物的切片）。 */
export type CheckpointStatusFace = Pick<GitStatusSource, 'store'>

/** 检查点/归因数据缓存（store + 命令面）。 */
export interface GitCheckpointStore {
  readonly store: SnapshotStore<GitCheckpointState>
  /** 时间线按需拉取（组件在折叠区打开且相位 idle 时调；loading/ready 相位 no-op）。 */
  ensureTimeline(): Promise<void>
  /** 归因拉取（仓库可用且相位 idle 时调；loading/ready 相位 no-op）。 */
  ensureAttribution(): Promise<void>
  /** 懒加载一个回合文件的 diff（缓存命中不重发；error 态可重试；in-flight 去重）。
   *  sessionId = wire 判别半（多会话 seq 碰撞防歧义——批次四评审收口）。 */
  loadDiff(seq: number, index: number, sessionId?: string): Promise<void>
  /** connection/reset：清全部段 + 代际递增（在途响应丢弃）。 */
  reset(): void
  /** 终结：退订状态源 + 代际递增（ctx.effect 清理半）。 */
  dispose(): void
}

/** diff 槽位键（sessionId:seq:index——checkpointDiff 三元组入参；sessionId 进键防
 *  跨会话 seq 碰撞共享槽位——批次四评审收口）。 */
export function checkpointDiffSlotKey(sessionId: string, seq: number, index: number): string {
  return `${sessionId}:${seq}:${index}`
}

function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const idleTimeline: CheckpointTimelineState = { phase: 'idle', entries: [], error: null }
const idleAttribution: CheckpointAttributionState = { phase: 'idle', entries: [], error: null }

/** 创建检查点/归因数据缓存（工厂——模块级句柄禁止，map §3.4）。 */
export function createCheckpointStore(rpc: GitCheckpointRpcFace, status: CheckpointStatusFace): GitCheckpointStore {
  const store = createSnapshotStore<GitCheckpointState>({
    timeline: { ...idleTimeline, entries: [] },
    attribution: { ...idleAttribution, entries: [] },
    diffs: {},
  })
  let generation = 0
  let revision = status.store.getSnapshot().revision
  const pending = new Map<string, Promise<void>>()

  // revision 变化失效（timeline/attribution 打回 idle；diff 槽不随 revision 失效——
  // 回合快照冻结不变，error 重试即可）。旧代际在途响应经代际比对丢弃。
  const unsubscribe = status.store.subscribe(() => {
    const next = status.store.getSnapshot().revision
    if (next === revision) return
    revision = next
    generation += 1
    store.update((draft) => {
      draft.timeline = { phase: 'idle', entries: [], error: null }
      draft.attribution = { phase: 'idle', entries: [], error: null }
    })
  })

  function forgetGeneration(): void {
    generation += 1
    pending.clear()
  }

  /** 一段只读数据的通用按需拉取（timeline / attribution 共形；段键防在途串扰）。 */
  function ensureSection(
    section: 'timeline' | 'attribution',
    call: () => Promise<RemoteResult<CheckpointListResult | AttributionResult>>,
    write: (draft: GitCheckpointState, result: CheckpointListResult | AttributionResult) => void,
    fail: (draft: GitCheckpointState, error: GitErrorLike) => void,
  ): Promise<void> {
    const current = section === 'timeline' ? store.getSnapshot().timeline : store.getSnapshot().attribution
    if (current.phase === 'loading' || current.phase === 'ready') return Promise.resolve()
    const inFlight = pending.get(section)
    if (inFlight !== undefined) return inFlight
    const gen = generation
    store.update((draft) => {
      const slot = section === 'timeline' ? draft.timeline : draft.attribution
      slot.phase = 'loading'
      slot.error = null
    })
    const task = (async () => {
      const result = await call()
      if (gen !== generation) return // 代际已换代：迟到的响应丢弃
      store.update((draft) => {
        if (result.ok) write(draft, result.value)
        else fail(draft, result.error)
      })
    })().catch((cause: unknown) => {
      if (gen !== generation) return
      store.update((draft) => {
        fail(draft, { code: causeCode(cause), message: causeMessage(cause) })
      })
    }).finally(() => {
      if (pending.get(section) === task) pending.delete(section)
    })
    pending.set(section, task)
    return task
  }

  async function loadDiff(seq: number, index: number, sessionId?: string): Promise<void> {
    const key = checkpointDiffSlotKey(sessionId ?? '', seq, index)
    const existing = store.getSnapshot().diffs[key]
    if (existing !== undefined && existing.state !== 'error') return
    const inFlight = pending.get(key)
    if (inFlight !== undefined) return inFlight
    const gen = generation
    store.update((draft) => {
      draft.diffs[key] = { state: 'loading' }
    })
    const task = (async () => {
      // exactOptionalPropertyTypes：sessionId 缺席时不出键（undefined 不落 optional 字段）。
      const result = await rpc.checkpointDiff({ seq, index, ...(sessionId !== undefined ? { sessionId } : {}) })
      if (gen !== generation) return // reset/dispose 后丢弃
      store.update((draft) => {
        if (result.ok) draft.diffs[key] = { state: 'ready', diff: result.value }
        else draft.diffs[key] = { state: 'error', error: result.error }
      })
    })().catch((cause: unknown) => {
      if (gen !== generation) return
      store.update((draft) => {
        draft.diffs[key] = { state: 'error', error: { code: causeCode(cause), message: causeMessage(cause) } }
      })
    }).finally(() => {
      if (pending.get(key) === task) pending.delete(key)
    })
    pending.set(key, task)
    return task
  }

  return {
    store,
    ensureTimeline() {
      return ensureSection(
        'timeline',
        () => rpc.checkpointList(null),
        (draft, value) => {
          draft.timeline = { phase: 'ready', entries: (value as CheckpointListResult).entries, error: null }
        },
        (draft, error) => {
          draft.timeline = { phase: 'error', entries: draft.timeline.entries, error }
        },
      )
    },
    ensureAttribution() {
      return ensureSection(
        'attribution',
        () => rpc.attributionGet(),
        (draft, value) => {
          draft.attribution = { phase: 'ready', entries: (value as AttributionResult).entries, error: null }
        },
        (draft, error) => {
          draft.attribution = { phase: 'error', entries: draft.attribution.entries, error }
        },
      )
    },
    loadDiff,
    reset() {
      forgetGeneration()
      store.update((draft) => {
        draft.timeline = { phase: 'idle', entries: [], error: null }
        draft.attribution = { phase: 'idle', entries: [], error: null }
        draft.diffs = {}
      })
    },
    dispose() {
      forgetGeneration()
      unsubscribe()
    },
  }
}
