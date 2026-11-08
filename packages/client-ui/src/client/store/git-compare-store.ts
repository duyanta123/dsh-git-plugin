/**
 * dsh-gitkit-ui — 分支对比面板数据缓存 store（V2 批次二 [36]；plan §4.6）。
 *
 * **范式 A**：裸 `createSnapshotStore` observable，工厂函数（模块级句柄禁止——map
 * §3.4）；root 作用域（apply 顶层创建 + ctx.effect 清理）。数据面 = host
 * `compareBranches({ base, compare })`（plan §4.2/§4.3：revListCounts 双向计数 +
 * `git log base..compare` 两列 + merge-base）。
 *
 * compare 半 = 当前分支（open 时从状态源快照读取）；detached/unborn/无名分支 ⇒
 * 不发起（open 无效果——入口闸 compareEntryEnabled 已在菜单半拦截，此处兜底）。
 * open(base) 幂等：同 base 重复 open 不重发；base 变化 ⇒ 重拉。错误落 error 态
 * （GitErrorNotice + 重试）；close() 恢复全图（清选择态由消费方承担）。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BranchCompareResult, CompareOptions } from 'dsh-gitkit/types'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import { GATEWAY_UNAVAILABLE } from '../remote/mount.js'
import type { GitStatusSource } from './git-status-source.js'

/** 对比面板数据快照（范式 A store 形状）。 */
export interface GitCompareState {
  /** 面板开合（false = 全图模式）。 */
  open: boolean
  /** 对比目标分支（base 半；null = 未开）。 */
  base: string | null
  /** 最近一次成功结果（open 态下展示）。 */
  result: BranchCompareResult | null
  pending: boolean
  /** error 态（GitErrorNotice；可重试）。 */
  error: GitErrorLike | null
}

/** 面板消费的 RPC 面（spec §3.2 GitRpcClient 的 compareBranches 切片）。 */
export interface GitCompareRpcFace {
  compareBranches(options: CompareOptions): Promise<RemoteResult<BranchCompareResult>>
}

/** 状态源消费面（createGitStatusSource 产物的结构切片）。 */
export type GitCompareStatusFace = Pick<GitStatusSource, 'store'>

/** 分支对比数据缓存（store + 命令面）。 */
export interface GitCompareStore {
  readonly store: SnapshotStore<GitCompareState>
  /** 打开对比面板并拉取（compare = 当前分支；无当前分支 ⇒ no-op）。 */
  open(base: string): Promise<void>
  /** 关闭面板恢复全图（清结果与错误；开合态即时翻转不等待 RPC）。 */
  close(): void
  /** 错误重试（对当前 base 重发）。 */
  retry(): Promise<void>
  /** connection/reset：清全部缓存。 */
  reset(): void
}

function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 创建分支对比数据缓存（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitCompareStore(rpc: GitCompareRpcFace, status: GitCompareStatusFace): GitCompareStore {
  const store = createSnapshotStore<GitCompareState>({
    open: false,
    base: null,
    result: null,
    pending: false,
    error: null,
  })

  async function load(base: string): Promise<void> {
    const snapshot = status.store.getSnapshot().status
    const compare = snapshot !== null && !snapshot.branch.detached && !snapshot.branch.unborn
      ? snapshot.branch.name
      : null
    if (compare === null) return
    store.update((draft) => {
      draft.open = true
      draft.base = base
      draft.pending = true
      draft.error = null
    })
    let result: RemoteResult<BranchCompareResult>
    try {
      result = await rpc.compareBranches({ base, compare })
    } catch (cause) {
      store.update((draft) => {
        draft.pending = false
        draft.error = { code: causeCode(cause), message: causeMessage(cause) }
      })
      return
    }
    store.update((draft) => {
      draft.pending = false
      if (result.ok) {
        draft.result = result.value
        draft.error = null
      } else {
        draft.error = result.error
      }
    })
  }

  return {
    store,
    open(base) {
      const current = store.getSnapshot()
      // 同 base 幂等：成功结果直接复用，不重发（base 变化/有错误 ⇒ 重拉）。
      if (current.open && current.base === base && current.result !== null && current.error === null && !current.pending) {
        return Promise.resolve()
      }
      return load(base)
    },
    close() {
      store.update((draft) => {
        draft.open = false
        draft.base = null
        draft.result = null
        draft.pending = false
        draft.error = null
      })
    },
    retry() {
      const base = store.getSnapshot().base
      if (base === null) return Promise.resolve()
      return load(base)
    },
    reset() {
      store.update((draft) => {
        draft.open = false
        draft.base = null
        draft.result = null
        draft.pending = false
        draft.error = null
      })
    },
  }
}
