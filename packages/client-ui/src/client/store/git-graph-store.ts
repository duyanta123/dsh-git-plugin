/**
 * dsh-gitkit-ui — 提交图数据缓存 store（本模块 ask §④ createGitGraphStore；
 * spec §3.2 GitHostReadState 的 log 窗口切片）。
 *
 * **范式 A**：裸 `createSnapshotStore` observable，工厂函数（模块级句柄禁止——map
 * §3.4）；root 作用域（apply 顶层创建 + ctx.effect 清理）。形状：
 *   - `log`：追加式窗口（children-first；spec §3.2「appendRowsAtCursor 语义」——
 *     本实现的追加 = 纯 push + oid 去重，分页窗口是全量 walk 的无重叠前缀）；
 *     `loadMoreInFlight` 为 **single-writer** 闸（spec §3.3.4；GitLens graphSession
 *     契约 SOURCES.md:106——进行中的 more 请求期间再触发直接忽略）；
 *   - `refs`：RefsSnapshot 快照（head 三态供布局 headOid 与 HEAD chip）；
 *   - `details`：oid → CommitDetail 缓存（getCommitDetail 列表态 + 文件 patch 态
 *     splice——点文件按 path 重取详情，把带 patch 的文件并回缓存）。
 *
 * 失效语义（spec §1.9/§2.3 + F7 任务口径）：host 对 log/refs/show 无缓存，client
 * 的失效由 **状态订阅** 承担——status 源的 `branch.oid` 变化（提交/切分支）→
 * reloadLog + refreshRefs（旧窗口对新历史无意义，spec §3.3.4「commit/pull 后
 * reloadLog」）；revision 变化但 oid 不变（工作区抖动）→ 不动图。connection/reset
 * → reset()（清缓存 + 回到「未见过分支」哨兵 → 立即按当前快照重载）。refs 的
 * 非 oid 变化（fetch 更新远端引用）v1 不追踪——记 ModuleResult.openIssues。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CommitDetail, CommitInfo, LogOptions, LogPage, RefsSnapshot, ShowOptions } from 'dsh-gitkit/types'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import { GATEWAY_UNAVAILABLE } from '../remote/mount.js'
import type { GitStatusSource } from './git-status-source.js'

/** client 每页条数（spec §1.0.2 logDefaultLimit 默认值；host 侧仍有 logMaxLimit 钳制兜底）。 */
export const GRAPH_PAGE_LIMIT = 500

/** 滚动分页触发余量（workflow ask §③：滚到 total-30 触发）。 */
export const GRAPH_LOAD_MORE_TAIL = 30

/** 一个 oid 的详情加载态（spec §3.2 CommitDetailState；'idle' 由「键缺席」表达）。 */
export interface CommitDetailState {
  state: 'loading' | 'ready' | 'error'
  /** ready 时有值（列表态 files 的 patch 为 null；点文件后 splice 进带 patch 版本）。 */
  detail?: CommitDetail
  /** error 时有值（按 code 判别，不按 instanceof——map §2.4）。 */
  error?: GitErrorLike
  /** 文件 patch 取回进行中（ready 态下的文件级 loading 信号）；null = 无。 */
  pendingPath: string | null
}

/** 提交图数据缓存快照（范式 A store 形状）。 */
export interface GitGraphState {
  refs: RefsSnapshot | null
  /** refs 查询错误（reloadLog 复用 log.error；refs 独立承载以便分别重试）。 */
  refsError: GitErrorLike | null
  log: {
    /** 追加式窗口（children-first，oid 去重）。 */
    commits: CommitInfo[]
    hasMore: boolean
    /** 已从全量 walk 消费的条数（= 下一页 skip；去重时 ≥ commits.length）。 */
    loadedCount: number
    /** single-writer 闸：进行中拒绝新的 more 请求。 */
    loadMoreInFlight: boolean
    /** reload（清窗重载）进行中。 */
    refreshing: boolean
    error: GitErrorLike | null
  }
  /** 详情缓存；键 = commit oid。 */
  details: Record<string, CommitDetailState>
}

/** 本 store 消费的 RPC 面（spec §3.2 GitRpcClient 的 log/refs/show 切片）。 */
export interface GitGraphRpcFace {
  log(options: LogOptions): Promise<RemoteResult<LogPage>>
  refs(): Promise<RemoteResult<RefsSnapshot>>
  getCommitDetail(options: ShowOptions): Promise<RemoteResult<CommitDetail>>
}

/** 状态源消费面（createGitStatusSource 产物的结构切片）。 */
export type GitGraphStatusFace = Pick<GitStatusSource, 'store'>

/** 提交图数据缓存（store + 命令面）。 */
export interface GitGraphStore {
  readonly store: SnapshotStore<GitGraphState>
  /** 追加一页（single-writer：进行中/无更多/非有限游标时忽略）。 */
  loadMore(): Promise<void>
  /** 清窗重载第一页（branch.oid 变化 / 手动重试）；同时清理失败详情槽（成功缓存保留）。 */
  reloadLog(): Promise<void>
  /** 重取 refs 快照。 */
  refreshRefs(): Promise<void>
  /**
   * 详情加载：path 为 null/缺省 = 列表态（meta + numstat）；给定 path = 该文件
   * patch 重取并 splice 回缓存（点文件调 host commitDiff 路——workflow ask §④）。
   * in-flight 按 `oid|path` 去重；error 态可重试——对 error 槽再次调用即清除失败槽
   * （置 loading）并重新拉取（详情面板重试按钮走的就是这条路；reloadLog 也清 error 槽）。
   */
  showCommit(oid: string, path?: string | null): Promise<void>
  /** connection/reset：清全部缓存 + 代际递增（在途响应丢弃）+ 立即按当前快照重载。 */
  reset(): void
  /** 终结：退订状态源 + 代际递增（ctx.effect 清理半）。 */
  dispose(): void
}

const INITIAL_LOG = {
  commits: [] as CommitInfo[],
  hasMore: false,
  loadedCount: 0,
  loadMoreInFlight: false,
  refreshing: false,
  error: null as GitErrorLike | null,
}

function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 创建提交图数据缓存（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitGraphStore(rpc: GitGraphRpcFace, status: GitGraphStatusFace): GitGraphStore {
  const store = createSnapshotStore<GitGraphState>({
    refs: null,
    refsError: null,
    log: { ...INITIAL_LOG, commits: [] },
    details: {},
  })
  let generation = 0
  /**
   * 最近一次触发 reload 的 branch.oid（undefined = 尚未见过任何 status 帧——
   * 创建时不加载：没有快照就没有可比的游标，等第一帧真实状态再拉图）。
   */
  let lastBranchOid: string | null | undefined = undefined
  const detailPending = new Map<string, Promise<void>>()

  /** branch.oid 变化 → 清窗重载 + refs 重取（失效语义见文件头；无快照时不记游标）。 */
  const reconcile = (): void => {
    const snapshot = status.store.getSnapshot().status
    if (snapshot === null) return
    const oid = snapshot.branch.oid ?? null
    if (oid === lastBranchOid) return
    lastBranchOid = oid
    void reloadLog()
    void refreshRefs()
  }
  const unsubscribe = status.store.subscribe(reconcile)
  reconcile()

  async function reloadLog(): Promise<void> {
    const gen = generation
    store.update((draft) => {
      draft.log = { ...INITIAL_LOG, commits: [], refreshing: true }
      // 失败详情槽一并清理（P2 卡死修复的配套半）：清窗重载 = 详情的重新拉取机会——
      // error 槽移除后，重选该行会经 tab 的「槽缺席即拉」effect 重新触发；ready（成功）
      // 缓存保留（详情按 oid 键，oid 不可变，成功详情不随 reload 失效）；loading 槽
      // （在途）不动——其响应落地路径与本清理无关。
      for (const oid of Object.keys(draft.details)) {
        if (draft.details[oid]?.state === 'error') delete draft.details[oid]
      }
    })
    let page: RemoteResult<LogPage>
    try {
      page = await rpc.log({ limit: GRAPH_PAGE_LIMIT, skip: 0 })
    } catch (cause) {
      if (gen !== generation) return
      store.update((draft) => {
        draft.log = { ...INITIAL_LOG, commits: [], error: { code: causeCode(cause), message: causeMessage(cause) } }
      })
      return
    }
    if (gen !== generation) return
    store.update((draft) => {
      if (page.ok) {
        draft.log = {
          commits: [...page.value.commits],
          hasMore: page.value.hasMore,
          loadedCount: page.value.commits.length,
          loadMoreInFlight: false,
          refreshing: false,
          error: null,
        }
      } else {
        draft.log = { ...INITIAL_LOG, commits: [], error: page.error }
      }
    })
  }

  async function refreshRefs(): Promise<void> {
    const gen = generation
    let result: RemoteResult<RefsSnapshot>
    try {
      result = await rpc.refs()
    } catch (cause) {
      if (gen !== generation) return
      store.update((draft) => {
        draft.refsError = { code: causeCode(cause), message: causeMessage(cause) }
      })
      return
    }
    if (gen !== generation) return
    store.update((draft) => {
      if (result.ok) {
        draft.refs = result.value
        draft.refsError = null
      } else {
        draft.refsError = result.error
      }
    })
  }

  async function loadMore(): Promise<void> {
    const snapshot = store.getSnapshot()
    if (snapshot.log.loadMoreInFlight || !snapshot.log.hasMore) return
    const gen = generation
    const skip = snapshot.log.loadedCount
    store.update((draft) => {
      draft.log.loadMoreInFlight = true
    })
    let page: RemoteResult<LogPage>
    try {
      page = await rpc.log({ limit: GRAPH_PAGE_LIMIT, skip })
    } catch (cause) {
      if (gen !== generation) return
      store.update((draft) => {
        draft.log.loadMoreInFlight = false
        draft.log.error = { code: causeCode(cause), message: causeMessage(cause) }
      })
      return
    }
    if (gen !== generation) return
    store.update((draft) => {
      draft.log.loadMoreInFlight = false
      if (page.ok) {
        // 追加窗口（G2 的 store 半）：纯 push + oid 去重——既有行的行号/lane 前缀稳定。
        const seen = new Set(draft.log.commits.map((commit) => commit.oid))
        const fresh = page.value.commits.filter((commit) => !seen.has(commit.oid))
        draft.log.commits.push(...fresh)
        draft.log.hasMore = page.value.hasMore
        draft.log.loadedCount += page.value.commits.length
      } else {
        draft.log.error = page.error
      }
    })
  }

  async function showCommit(oid: string, path?: string | null): Promise<void> {
    const baseOnly = path === null || path === undefined
    if (!baseOnly) {
      // path 态串行化：基座（列表态）必须先 ready——基座在途则 join 之，失败则放弃。
      const before = store.getSnapshot().details[oid]
      if (before === undefined || before.state === 'loading') await showCommit(oid)
      const baseSlot = store.getSnapshot().details[oid]
      if (baseSlot?.state !== 'ready' || baseSlot.detail === undefined) return
      // 已有 patch（或 binary/oversized 占位）的文件不重取。
      const file = baseSlot.detail.files.find((item) => item.path === path)
      if (file !== undefined && (file.patch !== null || file.binary || file.oversized)) return
    }
    const gen = generation
    const key = `${oid}|${path ?? ''}`
    const existing = detailPending.get(key)
    if (existing !== undefined) return existing
    if (baseOnly) {
      const cached = store.getSnapshot().details[oid]
      if (cached !== undefined && cached.state !== 'error') return
      store.update((draft) => {
        draft.details[oid] = { state: 'loading', pendingPath: null }
      })
    } else {
      store.update((draft) => {
        const slot = draft.details[oid]
        draft.details[oid] = slot?.state === 'ready' && slot.detail !== undefined
          ? { state: 'ready', detail: slot.detail, pendingPath: path ?? null }
          : { state: 'loading', pendingPath: null }
      })
    }
    const task = (async () => {
      let result: RemoteResult<CommitDetail>
      try {
        result = await rpc.getCommitDetail({ oid, path: path ?? null })
      } catch (cause) {
        if (gen !== generation) return
        store.update((draft) => {
          const slot = draft.details[oid]
          draft.details[oid] = slot?.detail !== undefined
            ? { state: 'ready', detail: slot.detail, pendingPath: null }
            : { state: 'error', error: { code: causeCode(cause), message: causeMessage(cause) }, pendingPath: null }
        })
        return
      }
      if (gen !== generation) return
      store.update((draft) => {
        const slot = draft.details[oid]
        const base = slot?.detail
        if (!result.ok) {
          // path 态失败 = 保住基座（文件行回落 loadFailed 占位）；基座态失败 = error 槽。
          draft.details[oid] = base !== undefined
            ? { state: 'ready', detail: base, pendingPath: null }
            : { state: 'error', error: result.error, pendingPath: null }
          return
        }
        const value = result.value
        if (baseOnly || base === undefined) {
          draft.details[oid] = { state: 'ready', detail: value, pendingPath: null }
          return
        }
        // path 态 splice：带 patch 的文件并回列表缓存（其余文件与 refs 不动）。
        const incoming = value.files.find((item) => item.path === path)
        const files = incoming !== undefined
          ? base.files.map((item) => item.path === path ? incoming : item)
          : base.files
        draft.details[oid] = { state: 'ready', detail: { ...base, files }, pendingPath: null }
      })
    })().finally(() => {
      if (detailPending.get(key) === task) detailPending.delete(key)
    })
    detailPending.set(key, task)
    return task
  }

  return {
    store,
    loadMore,
    reloadLog,
    refreshRefs,
    showCommit,
    reset() {
      generation += 1
      detailPending.clear()
      lastBranchOid = undefined
      store.update((draft) => {
        draft.refs = null
        draft.refsError = null
        draft.log = { ...INITIAL_LOG, commits: [] }
        draft.details = {}
      })
      reconcile()
    },
    dispose() {
      generation += 1
      detailPending.clear()
      unsubscribe()
    },
  }
}
