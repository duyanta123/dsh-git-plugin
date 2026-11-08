/**
 * dsh-gitkit-ui — 管理面业务 face（V2 批次一；plan §3.6 的 client 消费半）。
 *
 * 组件只吃这个面（范式：commit-dialog-face.ts 同构——组件不做 RPC，map §3.4）。
 * `createGitAdminFace` 在 apply 顶层用 root rpc 铸一次，由 header 按钮与提交图 tab
 * 两个消费方共享（同一闭包，无第二份状态）。
 *
 * 语义分叉（plan §3.6 推送对话框行）：`pushRoute(remoteCount)` 纯函数判定 remotes>1
 * 走对话框（remote picker）、单 remote 一步直推——v1 单远端直推行为不回归。
 */

import type {
  BranchCreateOptions, BranchCreateResult, BranchDeleteOptions, BranchDeleteResult,
  BranchSwitchResult, FetchOptions, FetchResult, PullResult, PushOptions, PushResult, RefInfo,
  RemoteListResult, TagCreateOptions, TagCreateResult, TagDeleteResult, WorktreeAddOptions,
  WorktreeAddResult, WorktreeListResult, WorktreeRemoveOptions, WorktreeRemoveResult,
} from 'dsh-gitkit/types'
import type { RemoteResult } from './remote/mount.js'
import type { GitRpcFace } from './remote/mount.js'

/** 管理面对话框/菜单动作的业务面（组件不做 RPC——注入面纪律）。 */
export interface GitAdminFace {
  /** 本地分支清单（refs() 数据面的 local-branch 投影；子菜单数据源）。 */
  listLocalBranches(): Promise<RemoteResult<RefInfo[]>>
  /** 多远端清单（推送对话框 remote picker 的数据源）。 */
  listRemotes(): Promise<RemoteResult<RemoteListResult>>
  branchCreate(options: BranchCreateOptions): Promise<RemoteResult<BranchCreateResult>>
  branchSwitch(name: string): Promise<RemoteResult<BranchSwitchResult>>
  branchDelete(options: BranchDeleteOptions): Promise<RemoteResult<BranchDeleteResult>>
  tagCreate(options: TagCreateOptions): Promise<RemoteResult<TagCreateResult>>
  tagDelete(name: string): Promise<RemoteResult<TagDeleteResult>>
  worktreeList(): Promise<RemoteResult<WorktreeListResult>>
  worktreeAdd(options: WorktreeAddOptions): Promise<RemoteResult<WorktreeAddResult>>
  worktreeRemove(options: WorktreeRemoveOptions): Promise<RemoteResult<WorktreeRemoveResult>>
  /** 推送（菜单直推与推送对话框共用；force/remote 目标随 PushOptions 扩展面）。 */
  push(options: PushOptions): Promise<RemoteResult<PushResult>>
  pull(): Promise<RemoteResult<PullResult>>
  fetch(options: FetchOptions): Promise<RemoteResult<FetchResult>>
}

/** 铸管理面业务面（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitAdminFace(rpc: GitRpcFace): GitAdminFace {
  return {
    async listLocalBranches() {
      const snapshot = await rpc.refs()
      if (!snapshot.ok) return snapshot
      return { ok: true, value: snapshot.value.refs.filter((ref) => ref.type === 'local-branch') }
    },
    listRemotes: () => rpc.remoteList(),
    branchCreate: (options) => rpc.branchCreate(options),
    branchSwitch: (name) => rpc.branchSwitch(name),
    branchDelete: (options) => rpc.branchDelete(options),
    tagCreate: (options) => rpc.tagCreate(options),
    tagDelete: (name) => rpc.tagDelete(name),
    worktreeList: () => rpc.worktreeList(),
    worktreeAdd: (options) => rpc.worktreeAdd(options),
    worktreeRemove: (options) => rpc.worktreeRemove(options),
    push: (options) => rpc.push(options),
    pull: () => rpc.pull(),
    fetch: (options) => rpc.fetch(options),
  }
}

/**
 * 推送行的路由判定（plan §3.6：remotes 数 > 1 或用户需要 force 时开「推送…」对话框；
 * remotes ≤ 1 且无 force 诉求保持菜单一步直推——v1 行为不回归）。force 诉求只可能
 * 来自对话框（菜单直推无 force 入口），故路由只看远端数。
 */
export function pushRoute(remoteCount: number): 'direct' | 'dialog' {
  return remoteCount > 1 ? 'dialog' : 'direct'
}
