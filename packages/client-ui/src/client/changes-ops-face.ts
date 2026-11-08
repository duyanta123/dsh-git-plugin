/**
 * dsh-gitkit-ui — 变更面板批次三动作业务面（V2 批次三；plan §5.6 的 client 消费半）。
 *
 * 组件只吃这个面（范式：admin-face.ts/commit-dialog-face.ts 同构——组件不做 RPC，
 * map §3.4）。`createChangesOpsFace` 在 apply 顶层用 root rpc 铸一次，由变更 tab 的
 * inject 工厂消费（同一闭包，无第二份状态）。
 *
 * - `stagePatch`：hunk/行级勾选的补丁应用（[10]；D7=B direction 两态——worktree 选中
 *   = 'stage'、staged 选中 = 'unstage' 反向还原）；
 * - `stash*`：stash 四动作（[14]；D4=B includeUntracked 缺省 true 由调用方显式传 wire；
 *   drop 的 acknowledged = UI 已过 danger 勾选闸——commit-dialog-face 的 checkIdentity
 *   同款「闸在上游组件、本层只承接」纪律）；
 * - `repoDiagnostics`：CRLF 提示条数据（[56]；只读，可折叠不阻断）。
 */

import type {
  RepoDiagnostics, StagePatchOptions, StagePatchResult, StashDropOptions, StashListResult,
  StashOpResult, StashPopOptions, StashPushOptions,
} from 'dsh-gitkit/types'
import type { RemoteResult } from './remote/mount.js'
import type { GitRpcFace } from './remote/mount.js'

/** 变更面板批次三动作的业务面（组件不做 RPC——注入面纪律）。 */
export interface GitChangesOpsFace {
  /** hunk/行级勾选的补丁应用（patch 由 diff/patch-select.ts 纯函数组装）。 */
  stagePatch(options: StagePatchOptions): Promise<RemoteResult<StagePatchResult>>
  stashList(): Promise<RemoteResult<StashListResult>>
  stashPush(options: StashPushOptions): Promise<RemoteResult<StashOpResult>>
  /** pop（index null/缺省 = 最新一条——StashPopOptions；plan §5.3）。 */
  stashPop(options: StashPopOptions): Promise<RemoteResult<StashOpResult>>
  /** drop（UI 已过 danger 勾选闸；acknowledged 直传——StashDropOptions）。 */
  stashDrop(options: StashDropOptions): Promise<RemoteResult<StashOpResult>>
  /** 行尾诊断（CRLF 提示条；只读）。 */
  repoDiagnostics(): Promise<RemoteResult<RepoDiagnostics>>
}

/** 铸变更面板批次三动作业务面（工厂——模块级句柄禁止，map §3.4）。 */
export function createChangesOpsFace(rpc: GitRpcFace): GitChangesOpsFace {
  return {
    stagePatch: (options) => rpc.stagePatch(options),
    stashList: () => rpc.stashList(),
    stashPush: (options) => rpc.stashPush(options),
    stashPop: (options) => rpc.stashPop(options),
    stashDrop: (options) => rpc.stashDrop(options),
    repoDiagnostics: () => rpc.repoDiagnostics(),
  }
}
