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
  AbortOperationResult, AgentToolsStatusResult, AutomationStatusResult, BlameOptions, BlameResult, BranchCompareResult, BranchCreateOptions,
  BranchCreateResult, BranchDeleteOptions, BranchDeleteResult, BranchMergeOptions,
  BranchMergeResult, BranchSwitchResult,
  CherryPickOptions, CompareOptions, FetchOptions, FetchResult, PullResult, PushOptions,
  PushResult, RebaseOptions, RebaseResult, RefInfo, RemoteListResult, ResetOptions, RevertOptions,
  TagCreateOptions, TagCreateResult, TagDeleteResult, TimeTravelResult, WorktreeAddOptions,
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
  /** V2 批次二历史面（plan §4.3/§4.6）：对比 / blame / cherry-pick / revert / reset / abort。 */
  compareBranches(options: CompareOptions): Promise<RemoteResult<BranchCompareResult>>
  blame(options: BlameOptions): Promise<RemoteResult<BlameResult>>
  cherryPick(options: CherryPickOptions): Promise<RemoteResult<TimeTravelResult>>
  revert(options: RevertOptions): Promise<RemoteResult<TimeTravelResult>>
  reset(options: ResetOptions): Promise<RemoteResult<TimeTravelResult>>
  /** 放弃中间态操作（幂等安全：无中间态 ⇒ 空成功——plan §4.3 abortOperation 行）。 */
  abortOperation(): Promise<RemoteResult<AbortOperationResult>>
  /**
   * V3 批次二（[28]；v3-implementation-plan §4.6）：合并分支到当前分支（ff 三态 +
   * 可选合并消息——danger 确认闸在对话框半，acknowledged 由闸产出）。
   */
  branchMerge(options: BranchMergeOptions): Promise<RemoteResult<BranchMergeResult>>
  /**
   * V3 批次二（[29]；plan §4.6）：变基当前分支（upstream 必填 + onto 可选——重写
   * 历史语义，danger 确认闸在对话框半；冲突走 git/merge-conflict，continue 由变更
   * tab 冲突面板驱动）。
   */
  rebase(options: RebaseOptions): Promise<RemoteResult<RebaseResult>>
  /**
   * V3 批次三（[45]；v3-implementation-plan §5.7）：Agent 工具观测状态——header 菜单
   * 「Agent 工具」状态行的数据源。只读展示，无操作面（工具的启停在 profile 配置层）；
   * 失败由渲染半静默降级（状态行缺席——观测行不进错误卡语义，见
   * admin-view-model.agentToolsStatusLine）。
   */
  agentToolsStatus(): Promise<RemoteResult<AgentToolsStatusResult>>
  /**
   * V3 批次五（[42][43]；v3-implementation-plan §7.5）：自动化观测状态——header 菜单
   * 「自动化」状态行的数据源（两模式开关态 + lastActions 最近动作摘要）。只读观测面，
   * 无操作面（启停在 profile 配置层）；自动化动作失败不抛 RemoteError（plan §7.4
   * 零新域码——结果经 lastActions 环 + auditLog 双可查）；拉取失败由渲染半静默降级
   * （整行缺席——观测行不进错误卡语义，见 admin-view-model.automationStatusLines）。
   */
  automationStatus(): Promise<RemoteResult<AutomationStatusResult>>
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
    // V2 批次二历史面（plan §4.3）：直通 rpc（守卫在 host；UI 半 = 确认框架 + danger 闸）。
    compareBranches: (options) => rpc.compareBranches(options),
    blame: (options) => rpc.blame(options),
    cherryPick: (options) => rpc.cherryPick(options),
    revert: (options) => rpc.revert(options),
    reset: (options) => rpc.reset(options),
    abortOperation: () => rpc.abortOperation(),
    // V3 批次二 merge / rebase（plan §4.6）：直通 rpc（守卫在 host；UI 半 = ff 三态
    // / onto 组装纯函数 + danger 确认闸——acknowledged 由闸产出后过线）。
    branchMerge: (options) => rpc.branchMerge(options),
    rebase: (options) => rpc.rebase(options),
    // V3 批次三（[45]；plan §5.7）：观测方法直通 rpc（只读不入审计环——host 半 §5.5）。
    agentToolsStatus: () => rpc.agentToolsStatus(),
    // V3 批次五（[42][43]；plan §7.5）：观测方法直通 rpc（只读不入审计环——自动化
    // 的写动作自身在 host 引擎内双出口入环，plan §7.3）。
    automationStatus: () => rpc.automationStatus(),
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
