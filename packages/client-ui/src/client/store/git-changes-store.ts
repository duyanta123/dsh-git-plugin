/**
 * @dsh-plugin/client-ui-git — 变更面板数据缓存 store（本模块 ask §⑤；spec §3.2 C2）。
 *
 * **范式 A**：裸 `createSnapshotStore` observable，工厂函数（模块级句柄禁止——
 * map §3.4；ui-deliverables HostReadStore 的 generation/reset 语义同构）。root 作用域
 * （apply 顶层创建 + ctx.effect 清理）。
 *
 * diff 缓存：键 = `${revision}:${path}:${scope}`（本模块 ask：rev:path:scope）；
 * **revision 变化整体失效**——store 订阅状态源，状态源的 revision 递增（新帧被接受/
 * 错误帧/写操作后 host 重算）即清空全部 diff 缓存并递增代际，旧代际在途响应一律
 * 丢弃（绝不写回新代际）。写操作（stage/unstage/discard）成功后触发状态源 refresh
 * （spec §2.3 失效矩阵：写后一次内部 refresh；host 推送 R3/R5 帧 → revision 递增 →
 * 本 store 自动失效）——diff 缓存因此永远与 status 快照同代。
 *
 * 写操作错误以状态承载（mutationError），由面板渲染 GitErrorNotice + 重试；
 * diff 读取错误落在对应缓存槽（error 态可重试，ready/loading 不重复请求），
 * in-flight 按 key 去重。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  DiffFile, DiffResult, DiffScope, DiscardOptions, DiscardResult, StageResult, UnstageResult,
} from '@dsh-plugin/git/types'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import { GATEWAY_UNAVAILABLE } from '../remote/mount.js'
import type { GitStatusSource } from './git-status-source.js'

/** 一个 (rev, path, scope) 的 diff 加载状态（spec §3.2 DiffEntryState；'idle' 由「键缺席」表达）。 */
export interface DiffEntryState {
  state: 'loading' | 'ready' | 'error'
  /** ready 且该路径仍在变更集内时有值（raced-away 文件为 ready 无 file → 面板显示空差异）。 */
  file?: DiffFile
  /** error 时有值（按 code 判别，不按 instanceof——map §2.4）。 */
  error?: GitErrorLike
}

/** 写操作类别（mutationError 的判别域）。 */
export type MutationKind = 'stage' | 'unstage' | 'discard'

/** 最近一次失败的写操作（面板顶部错误条的重试/关闭依据）。 */
export interface MutationErrorState {
  kind: MutationKind
  paths: string[]
  error: GitErrorLike
}

/** 变更面板数据缓存快照（范式 A store 形状）。 */
export interface GitChangesState {
  /** diff 缓存；键 = diffCacheKey(revision, path, scope)。 */
  diffs: Record<string, DiffEntryState>
  /** 最近一次失败的写操作；成功执行任一写操作即清空。 */
  mutationError: MutationErrorState | null
}

/** 面板消费的 RPC 面（spec §3.2 GitRpcClient 的 diff + 写操作切片）。 */
export interface GitChangesRpcFace {
  diff(scope: DiffScope, path: string | null): Promise<RemoteResult<DiffResult>>
  stage(paths: string[]): Promise<RemoteResult<StageResult>>
  unstage(paths: string[]): Promise<RemoteResult<UnstageResult>>
  discard(options: DiscardOptions): Promise<RemoteResult<DiscardResult>>
}

/** 状态源消费面（createGitStatusSource 产物的结构切片）。 */
export type GitChangesStatusFace = Pick<GitStatusSource, 'store' | 'refresh'>

/** 变更面板数据缓存（store + 命令面）。 */
export interface GitChangesStore {
  readonly store: SnapshotStore<GitChangesState>
  /** 懒加载一个文件的 diff（缓存命中不重发；error 态可重试；in-flight 去重）。 */
  loadDiff(scope: DiffScope, path: string): Promise<void>
  /** 暂存（成功 → 状态源 refresh → revision 递增 → diff 缓存整体失效）。 */
  stage(paths: readonly string[]): Promise<RemoteResult<StageResult>>
  /** 取消暂存（失效语义同上）。 */
  unstage(paths: readonly string[]): Promise<RemoteResult<UnstageResult>>
  /** 丢弃工作区改动（UI 已过 C5 确认；失效语义同上）。 */
  discard(paths: readonly string[]): Promise<RemoteResult<DiscardResult>>
  /** 清除写操作错误条（面板关闭按钮）。 */
  dismissMutationError(): void
  /** connection/reset：清缓存 + 代际递增（在途响应丢弃）+ 重对齐 revision。 */
  reset(): void
  /** 终结：退订状态源 + 代际递增（ctx.effect 清理半）。 */
  dispose(): void
}

/** 初始状态在工厂内就地构造（工厂每次调用产独立实例）。 */

/**
 * diff 缓存键（ask §⑤ 口径 rev:path:scope——revision 在前使旧代际键天然不与
 * 新代际冲突，整体失效再清一遍，双保险）。
 */
export function diffCacheKey(revision: number, path: string, scope: DiffScope): string {
  return `${revision}:${path}:${scope}`
}

function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 创建变更面板数据缓存（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitChangesStore(rpc: GitChangesRpcFace, status: GitChangesStatusFace): GitChangesStore {
  const store = createSnapshotStore<GitChangesState>({ diffs: {}, mutationError: null })
  let generation = 0
  let revision = status.store.getSnapshot().revision
  const pending = new Map<string, Promise<void>>()

  // revision 变化整体失效：订阅状态源，任何被接受的帧（含错误帧——状态源对
  // 错误帧也递增 revision）都清空 diff 缓存并递增代际。
  const unsubscribe = status.store.subscribe(() => {
    const next = status.store.getSnapshot().revision
    if (next === revision) return
    revision = next
    generation += 1
    store.update((draft) => {
      draft.diffs = {}
    })
  })

  function forgetGeneration(): void {
    generation += 1
    pending.clear()
  }

  async function loadDiff(scope: DiffScope, path: string): Promise<void> {
    const statusSnapshot = status.store.getSnapshot().status
    if (statusSnapshot === null) return // 尚无快照：没有可对照的 revision，不发起
    const key = diffCacheKey(revision, path, scope)
    const existing = store.getSnapshot().diffs[key]
    if (existing !== undefined && existing.state !== 'error') return
    const inFlight = pending.get(key)
    if (inFlight !== undefined) return inFlight
    const gen = generation
    store.update((draft) => {
      draft.diffs[key] = { state: 'loading' }
    })
    const task = (async () => {
      const result = await rpc.diff(scope, path)
      if (gen !== generation) return // 代际已换代：迟到的响应丢弃
      store.update((draft) => {
        if (result.ok) {
          const file = result.value.files[0]
          draft.diffs[key] = file === undefined ? { state: 'ready' } : { state: 'ready', file }
        } else {
          draft.diffs[key] = { state: 'error', error: result.error }
        }
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

  async function mutate<R extends StageResult | UnstageResult | DiscardResult>(
    kind: MutationKind,
    paths: readonly string[],
    call: (list: string[]) => Promise<RemoteResult<R>>,
  ): Promise<RemoteResult<R>> {
    const result = await call([...paths])
    if (result.ok) {
      store.update((draft) => {
        draft.mutationError = null
      })
      // 写后 refresh（spec §2.3）：host 重算 → 新帧 → revision 递增 → 订阅回调
      // 清 diff 缓存；R3/R5 帧到达前先本地失效一次（不等网络的乐观口径）。
      forgetGeneration()
      store.update((draft) => {
        draft.diffs = {}
      })
      status.refresh()
    } else {
      store.update((draft) => {
        draft.mutationError = { kind, paths: [...paths], error: result.error }
      })
    }
    return result
  }

  return {
    store,
    loadDiff,
    stage: (paths) => mutate('stage', paths, (list) => rpc.stage(list)),
    unstage: (paths) => mutate('unstage', paths, (list) => rpc.unstage(list)),
    // host discard 三重守卫（⑤ mutations 模块）的 store 半：acknowledged = 本方法契约
    // 「UI 已过 C5 GitConfirmDialog 二次确认」（danger 勾选闸在上游组件，本层只承接）；
    // baseRevision = 当前快照的 HEAD oid（乐观并发参与——status 变化后 host 拒绝执行）。
    discard: (paths) => mutate('discard', paths, (list) => rpc.discard({
      paths: list,
      acknowledged: true,
      baseRevision: status.store.getSnapshot().status?.branch.oid ?? null,
    })),
    dismissMutationError() {
      store.update((draft) => {
        draft.mutationError = null
      })
    },
    reset() {
      forgetGeneration()
      revision = status.store.getSnapshot().revision
      store.update((draft) => {
        draft.diffs = {}
        draft.mutationError = null
      })
    },
    dispose() {
      forgetGeneration()
      unsubscribe()
    },
  }
}
