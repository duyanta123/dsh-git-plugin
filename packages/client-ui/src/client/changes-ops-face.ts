/**
 * dsh-gitkit-ui — 变更面板动作业务面（V2 批次三建立；plan §5.6 的 client 消费半；
 * 批次四扩面）。
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
 *
 * **V2 批次四扩面（plan §6.6）**：`initRepository`（[8] 空态引导卡片的动作半——header
 * 与 changes/graph 两个空态拉起方共享同一闭包；成功后调用方 source.refresh()）+
 * `submoduleStatus`（[61] 子模块详情面板数据——只列不递归）。
 *
 * **V3 批次一扩面（[清单 13]；v3-implementation-plan §3.7）**：冲突面板动作半——
 * `conflictList`（fresh 扫描清单）/ `conflictResolve`（ours/theirs 两向矩阵）/
 * `conflictMarkResolved`（手动编辑后标记）/ `operationContinue`（继续中间态操作；
 * 冲突是返回值不是错误）+ `abortOperation`（放弃操作——UI 已过 danger 勾选闸，
 * stashDrop 的 acknowledged 同款「闸在上游组件、本层只承接」纪律；changes tab 的
 * 冲突面板经本面消费，adminFace 同名直通并存——均为无状态直通闭包）。
 *
 * **V3 批次四扩面（[清单 39]；v3-implementation-plan §6.6）**：`checkpointRestore`
 * ——「恢复此回合」的写半（danger 写方法：acknowledged = UI 已过 GitConfirmDialog
 * 勾选闸 + baseRevision 乐观并发基线由 restore 状态机在确认时刻捕获传入；逐文件
 * 部分成功语义——applied/failed 由组件按 reduceRestore 状态机渲染）。只读三方法
 * （checkpointList/checkpointDiff/attributionGet）不经本面——它们的缓存半在
 * store/checkpoint-store.ts（按需拉取 + 代际失效），restore 是无缓存的写直通。
 */

import type {
  AbortOperationResult, CheckpointRestoreOptions, CheckpointRestoreResult, ConflictListResult,
  ConflictMarkOptions, ConflictMarkResult, ConflictResolveOptions, ConflictResolveResult, InitResult,
  OperationContinueResult, RepoDiagnostics, StagePatchOptions, StagePatchResult, StashDropOptions,
  StashListResult, StashOpResult, StashPopOptions, StashPushOptions, SubmoduleStatusResult,
} from 'dsh-gitkit/types'
import type { RemoteResult } from './remote/mount.js'
import type { GitRpcFace } from './remote/mount.js'

/** 变更面板动作业务面（组件不做 RPC——注入面纪律；批次三 + 批次四 + V3 批次一扩面）。 */
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
  /** V2 批次四 [8]：当前 workspace 根初始化 Git 仓库（成功后调用方 refresh）。 */
  initRepository(): Promise<RemoteResult<InitResult>>
  /** V2 批次四 [61]：子模块状态清单（只列不递归——详情面板数据面）。 */
  submoduleStatus(): Promise<RemoteResult<SubmoduleStatusResult>>
  /** V3 批次一 [13]：冲突清单（fresh porcelain v2 扫描——不走 1.5s 缓存）。 */
  conflictList(): Promise<RemoteResult<ConflictListResult>>
  /** V3 批次一 [13]：逐条两向解决（ours/theirs 命令矩阵——choices 由调用方组装）。 */
  conflictResolve(options: ConflictResolveOptions): Promise<RemoteResult<ConflictResolveResult>>
  /** V3 批次一 [13]：手动编辑后标记已解决（删除侧走 git rm——host 半判定）。 */
  conflictMarkResolved(options: ConflictMarkOptions): Promise<RemoteResult<ConflictMarkResult>>
  /** V3 批次一 [13]：继续中间态操作（冲突是返回值不是错误——done:false + conflicted）。 */
  operationContinue(): Promise<RemoteResult<OperationContinueResult>>
  /** V3 批次一 [13]：放弃中间态操作（UI 已过 danger 勾选闸——GitConfirmDialog）。 */
  abortOperation(): Promise<RemoteResult<AbortOperationResult>>
  /** V3 批次四 [39]：恢复此回合（UI 已过 danger 勾选闸——acknowledged 直传；
   *  baseRevision 由 restore 状态机捕获；paths null = 该回合全部文件）。 */
  checkpointRestore(options: CheckpointRestoreOptions): Promise<RemoteResult<CheckpointRestoreResult>>
}

/** 铸变更面板动作业务面（工厂——模块级句柄禁止，map §3.4）。 */
export function createChangesOpsFace(rpc: GitRpcFace): GitChangesOpsFace {
  return {
    stagePatch: (options) => rpc.stagePatch(options),
    stashList: () => rpc.stashList(),
    stashPush: (options) => rpc.stashPush(options),
    stashPop: (options) => rpc.stashPop(options),
    stashDrop: (options) => rpc.stashDrop(options),
    repoDiagnostics: () => rpc.repoDiagnostics(),
    // V2 批次四（plan §6.6）：init 空态引导动作 + 子模块详情数据——直通 rpc。
    initRepository: () => rpc.initRepository(),
    submoduleStatus: () => rpc.submoduleStatus(),
    // V3 批次一（[13]；plan §3.7）：冲突面板动作半——五方法直通 rpc（abort 的
    // acknowledged 语义无独立 wire 旗标——abortOperation 幂等安全，danger 闸在组件）。
    conflictList: () => rpc.conflictList(),
    conflictResolve: (options) => rpc.conflictResolve(options),
    conflictMarkResolved: (options) => rpc.conflictMarkResolved(options),
    operationContinue: () => rpc.operationContinue(),
    abortOperation: () => rpc.abortOperation(),
    // V3 批次四（[39]；plan §6.6）：恢复此回合——写直通（闸与基线在调用方状态机）。
    checkpointRestore: (options) => rpc.checkpointRestore(options),
  }
}
