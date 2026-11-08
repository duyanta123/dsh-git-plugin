/**
 * dsh-gitkit-ui — blame 数据缓存 store（V2 批次二 [34]；D3=B -L 区间分片；plan §4.6）。
 *
 * **范式 A**：裸 `createSnapshotStore` observable，工厂函数（模块级句柄禁止——map
 * §3.4）；root 作用域（apply 顶层创建 + ctx.effect 清理）。数据面 = host `blame()`
 * （plan §4.2/§4.3：porcelain 解析为同 oid 连续行合并的 ranges；全区超限 ⇒
 * `git/blame-oversized` 引导分片）。
 *
 * **两段加载纪律（D3=B）**：
 *  1. `ensure(path)`：先试全区一次（`blame({ path })`，无 range）——小文件一步到位；
 *  2. 全区超限（`git/blame-oversized`，details 携带 lineCount/maxLines）⇒ 槽位转
 *     **分片模式**（oversized=true）：组件按虚拟滚动窗口调 `ensureRange(path, start,
 *     end)`，store 以 `loaded` 覆盖簿记 + `pending` 区间级在途簿记双重去重（已覆盖
 *     /在途区间不重发；不同区间并发互不遮蔽——评审修复），区间结果经
 *     `mergeBlameRuns` 按行号归并（跨片同 oid 行仍合并——blame-view 纯半的 spec 钉子）。
 *
 * 无状态源订阅：blame 反映的是 ref（缺省 HEAD）的既有历史，工作区抖动不改写历史；
 * connection/reset 由 apply 半调 `reset()` 清空。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BlameOptions, BlameResult } from 'dsh-gitkit/types'
import { expandBlameRuns, mergeBlameRuns, oversizedPlan } from '../blame-view.js'
import type { BlameRun } from '../blame-view.js'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import { GATEWAY_UNAVAILABLE } from '../remote/mount.js'

/** 一个 path 的 blame 槽位（git-blame-store.byPath 值）。 */
export interface BlameSlotState {
  state: 'loading' | 'ready' | 'error'
  /** 归并后的注记 runs（区间不重叠、同 oid 相接已合并）。 */
  runs: BlameRun[]
  /** 文件总行数（最近一次成功响应的 BlameResult.lineCount；oversized details 亦回填）。 */
  lineCount: number | null
  /** 单次调用行数上限（oversized details.maxLines；缺省镜像 BLAME_PER_CALL_CAP）。 */
  maxLines: number
  /** 已加载行区间（覆盖簿记；分片模式的重复请求闸）。 */
  loaded: { start: number; end: number }[]
  /** true = 全区超限转分片模式（D3=B；false = 全区一次加载路径）。 */
  oversized: boolean
  /** 最近一次错误（state='error' 或分片途中失败——runs 有值时组件仍可渲染已加载半）。 */
  error: GitErrorLike | null
  /** true = 最后一次错误是 git/blame-oversized 且可分片（组件的引导信号）。 */
  oversizeSignaled: boolean
  /**
   * 在途分片键簿记（`"start:end"` → true；**区间级**并发去重——评审修复：原单槽位
   * pendingToken 会被不同区间的并发请求互相覆盖，且首个区间在途期间同区间重入被误
   * 放行（重复 RPC）。集合簿记下不同区间互不遮蔽、同键在途即拒绝。
   */
  pending: Record<string, boolean>
}

/** store 快照（范式 A store 形状）。 */
export interface GitBlameState {
  byPath: Record<string, BlameSlotState>
}

/** 面板消费的 RPC 面（spec §3.2 GitRpcClient 的 blame 切片）。 */
export interface GitBlameRpcFace {
  blame(options: BlameOptions): Promise<RemoteResult<BlameResult>>
}

/** blame 数据缓存（store + 命令面）。 */
export interface GitBlameStore {
  readonly store: SnapshotStore<GitBlameState>
  /** 首载：全区一次；槽位已在加载/就绪时 no-op，error 槽重调 = 重试。 */
  ensure(path: string): Promise<void>
  /** 分片加载一段（-L start,end 语义；已覆盖/在途 ⇒ no-op；结果归并进 runs）。 */
  ensureRange(path: string, start: number, end: number): Promise<void>
  /** connection/reset：清全部槽位。 */
  reset(): void
}

function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** pending 键（区间在途去重）。 */
function rangeKey(start: number, end: number): string {
  return `${start}:${end}`
}

/** 区间是否已被 loaded 覆盖（分片去重；重叠不部分抵扣——请求粒度由规划半保证）。 */
function isCovered(loaded: readonly { start: number; end: number }[], start: number, end: number): boolean {
  return loaded.some((interval) => interval.start <= start && interval.end >= end)
}

function emptySlot(): BlameSlotState {
  return {
    state: 'loading',
    runs: [],
    lineCount: null,
    maxLines: 0,
    loaded: [],
    oversized: false,
    error: null,
    oversizeSignaled: false,
    pending: {},
  }
}

/** 创建 blame 数据缓存（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitBlameStore(rpc: GitBlameRpcFace): GitBlameStore {
  const store = createSnapshotStore<GitBlameState>({ byPath: {} })

  function slotOf(path: string): BlameSlotState | undefined {
    return store.getSnapshot().byPath[path]
  }

  function patch(path: string, mutate: (draft: BlameSlotState) => void): void {
    store.update((draft) => {
      const slot = draft.byPath[path]
      if (slot === undefined) return
      mutate(slot)
    })
  }

  /** 成功响应 → 槽位写回（全区：覆盖整文件；区间：归并 + 覆盖簿记推进）。 */
  function applyResult(path: string, result: BlameResult, requested?: { start: number; end: number }): void {
    const incoming = expandBlameRuns(result.ranges)
    patch(path, (slot) => {
      slot.lineCount = result.lineCount
      if (requested === undefined) {
        slot.runs = incoming
        slot.loaded = result.lineCount > 0 ? [{ start: 1, end: result.lineCount }] : []
      } else {
        slot.runs = mergeBlameRuns(slot.runs, incoming)
        if (!isCovered(slot.loaded, requested.start, requested.end)) slot.loaded.push({ ...requested })
        slot.loaded.sort((a, b) => a.start - b.start)
      }
      slot.error = null
      slot.oversizeSignaled = false
      slot.state = 'ready'
    })
  }

  async function callBlame(path: string, options: BlameOptions, requested?: { start: number; end: number }): Promise<void> {
    let result: RemoteResult<BlameResult>
    try {
      result = await rpc.blame(options)
    } catch (cause) {
      patch(path, (slot) => {
        slot.state = 'error'
        slot.error = { code: causeCode(cause), message: causeMessage(cause) }
      })
      return
    }
    if (result.ok) {
      applyResult(path, result.value, requested)
      return
    }
    // 全区超限（D3=B）：details 携带 { path, lineCount, maxLines } ⇒ 转分片模式
    // （state 回 ready + oversized=true，等待组件按可视窗口 ensureRange）；details
    // 不可用（无法分片）或其它码 ⇒ error 槽（兜底占位形态）。
    const plan = oversizedPlan(result.error)
    if (requested === undefined && plan.sliceable) {
      patch(path, (slot) => {
        slot.state = 'ready'
        slot.oversized = true
        slot.oversizeSignaled = true
        slot.lineCount = plan.lineCount
        slot.maxLines = plan.maxLines
        slot.error = result.error
      })
      return
    }
    patch(path, (slot) => {
      slot.state = 'error'
      slot.error = result.error
      if (plan.maxLines > 0 && slot.maxLines === 0) slot.maxLines = plan.maxLines
    })
  }

  return {
    store,
    ensure(path) {
      const slot = slotOf(path)
      if (slot !== undefined && (slot.state === 'loading' || slot.state === 'ready')) return Promise.resolve()
      store.update((draft) => {
        draft.byPath[path] = emptySlot()
      })
      return callBlame(path, { path, ref: null, range: null })
    },
    async ensureRange(path, start, end) {
      const slot = slotOf(path)
      // 分片前置：槽位已就绪（全区成功或分片模式）才可分片；越界/倒序/已覆盖/在途 ⇒ no-op。
      if (slot === undefined || slot.state !== 'ready') return
      const lineCount = slot.lineCount
      const clampedEnd = lineCount !== null ? Math.min(end, lineCount) : end
      const clampedStart = Math.max(1, start)
      if (!Number.isFinite(clampedStart) || !Number.isFinite(clampedEnd)) return
      if (clampedStart > clampedEnd) return
      if (isCovered(slot.loaded, clampedStart, clampedEnd)) return
      const key = rangeKey(clampedStart, clampedEnd)
      // 区间级在途去重（评审修复）：同键在途即拒绝；不同区间并发互不遮蔽。
      if (slot.pending[key]) return
      patch(path, (draft) => {
        draft.pending[key] = true
      })
      try {
        await callBlame(path, { path, ref: null, range: { start: clampedStart, end: clampedEnd } }, { start: clampedStart, end: clampedEnd })
      } finally {
        // 槽位若被 reset 移除，patch 对缺席槽位 no-op——簿记随槽位整体消亡，无悬挂。
        patch(path, (draft) => {
          delete draft.pending[key]
        })
      }
    },
    reset() {
      store.update((draft) => {
        draft.byPath = {}
      })
    },
  }
}
