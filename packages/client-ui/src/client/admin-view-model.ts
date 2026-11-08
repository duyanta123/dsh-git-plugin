/**
 * dsh-gitkit-ui — V2 批次一管理面纯视图模型（推送对话框 / 分支创建 / 标签创建 /
 * worktree 管理的渲染决策；plan §3.6）。组件只做 t/订阅/事件——渲染决策全部收敛为
 * 纯函数（spec §6 纯函数单测纪律；ui-model.ts / commit-view-model.ts 同款收敛），
 * 断言面 = tests/push-dialog.spec.ts（推送对话框：remote picker 可见性 + force→danger
 * 闸状态机）与 tests/admin-view-model.spec.ts（分支/标签/worktree 草稿与移除闸）。
 *
 * danger 双闸复用：force push / 脏 worktree 强制移除的「确认勾选闸」即
 * GitConfirmDialog severity='danger'（勾选前确认禁用，纯逻辑 confirmButtonEnabled
 * ui-model.ts:114 一处实现两处消费）。
 */

import type {
  BranchCreateOptions, PushOptions, RemoteInfo, TagCreateOptions, WorktreeAddOptions, WorktreeInfo,
} from 'dsh-gitkit/types'

// ── 推送对话框（[27][57]）────────────────────────────────────────────────────

/**
 * 推送对话框可见性（plan §3.6：remotes 数 > 1 时开对话框；≤1 一步直推）。
 * `needsForceDialog` 参数预留 force 诉求入口（v1 直推无 force 入口，恒走远端数）。
 */
export function needsPushDialog(remoteCount: number): boolean {
  return remoteCount > 1
}

/** 推送对话框输入（组件持有的全部决策相关状态）。 */
export interface PushDialogInput {
  /** 远端清单（remoteList 数据；空 = 尚未取回/无远端）。 */
  remotes: readonly RemoteInfo[]
  /** 当前选中的远端名（null = 未选——首选项由装配半给首个远端）。 */
  selectedRemote: string | null
  /** 当前分支（null = 快照未就绪/detached——push 需要 branch，不可用即禁）。 */
  branch: { name: string | null; upstream: string | null; detached: boolean; unborn: boolean } | null
  /** force 勾选（对话框内）。 */
  force: boolean
  /** danger 勾选闸（GitConfirmDialog 内的「不可逆」复选框）。 */
  forceAcked: boolean
  /** 推送进行中。 */
  pending: boolean
}

/** 推送对话框渲染模型。 */
export interface PushDialogView {
  /** remote picker 的选项（name + url 展示 + 当前选中标记）。 */
  remoteChoices: readonly { name: string; url: string; current: boolean }[]
  /** 生效的选中远端（装配半的缺省首个 + 输入的 selectedRemote）。 */
  selectedRemote: string | null
  /** 是否展示「将建立 upstream」提示行（upstream 缺失 ⇒ 随推送建立跟踪）。 */
  showSetUpstreamNote: boolean
  /** 推送按钮可用闸（远端已选 + 分支可用 + 空闲）。 */
  canConfirm: boolean
  /** force→danger 闸状态机：force 勾选后确认不再直跑，先开 danger 二次确认。 */
  forceGate: {
    /** true = 确认点击转开 GitConfirmDialog（severity='danger'）。 */
    ask: boolean
    /** danger 确认框内的确认按钮可用（勾选闸——confirmButtonEnabled 同语义）。 */
    confirmed: boolean
  }
  /** 组装 PushOptions（null = 闸未过，调用方不得发起）。 */
  options: PushOptions | null
}

/** 组装推送对话框视图模型（纯函数）。 */
export function pushDialogView(input: PushDialogInput): PushDialogView {
  const { remotes, selectedRemote, branch, force, forceAcked, pending } = input
  const effective = selectedRemote ?? remotes[0]?.name ?? null
  const choices = remotes.map((remote) => ({
    name: remote.name,
    url: remote.url,
    current: remote.name === effective,
  }))
  const branchUsable = branch !== null && branch.name !== null && !branch.detached && !branch.unborn
  const canConfirm = effective !== null && branchUsable && !pending
  // force 勾选 ⇒ 点击确认先开 danger 二次确认；二次确认框内勾选「不可逆」后才可跑
  // （GitConfirmDialog 的勾选闸承担 confirmed；此处镜像同一语义供纯函数断言）。
  const ask = force
  const confirmed = force && forceAcked
  const options: PushOptions | null = canConfirm && (!ask || confirmed)
    ? {
        setUpstream: branch?.upstream === null,
        ...(force ? { force: true, acknowledged: true } : {}),
        remote: effective,
      }
    : null
  return {
    remoteChoices: choices,
    selectedRemote: effective,
    showSetUpstreamNote: branch?.upstream === null,
    canConfirm,
    forceGate: { ask, confirmed },
    options,
  }
}

// ── 分支创建对话框（[23]）────────────────────────────────────────────────────

/** 分支创建草稿 → 校验 + 入参组装（null = 校验未过）。 */
export function branchCreateDraft(input: {
  name: string
  from: string
  checkout: boolean
}): { valid: boolean; options: BranchCreateOptions | null } {
  const name = input.name.trim()
  if (name === '') return { valid: false, options: null }
  const from = input.from.trim()
  return {
    valid: true,
    options: {
      name,
      from: from === '' ? null : from,
      checkout: input.checkout,
    },
  }
}

// ── 标签创建对话框（[30]）────────────────────────────────────────────────────

/**
 * 标签创建草稿 → 校验 + 入参组装（message 非空 = annotated；oid null = HEAD——
 * header 打标签的目标；graph「在此提交打标签」传具体 oid）。
 */
export function tagCreateDraft(input: {
  name: string
  message: string
  oid: string | null
}): { valid: boolean; options: TagCreateOptions | null } {
  const name = input.name.trim()
  if (name === '') return { valid: false, options: null }
  const message = input.message.trim()
  return {
    valid: true,
    options: {
      name,
      oid: input.oid,
      message: message === '' ? null : message,
    },
  }
}

// ── worktree 管理对话框（[62][68]）──────────────────────────────────────────

/** worktree 列表区一行（path + 状态徽标组装 + 移除可用性）。 */
export interface WorktreeRow {
  path: string
  /** 被检出的分支短名；detached/bare 为 null。 */
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  /** bare 不可移除（git worktree remove 对主 bare 无效）；其余可走移除确认。 */
  removable: boolean
}

/** worktreeList 数据 → 列表区渲染模型（纯函数；行序保持 host 返回序）。 */
export function worktreeRows(worktrees: readonly WorktreeInfo[]): WorktreeRow[] {
  return worktrees.map((worktree) => ({
    path: worktree.path,
    branch: worktree.branch,
    detached: worktree.detached,
    bare: worktree.bare,
    locked: worktree.locked,
    removable: !worktree.bare,
  }))
}

/**
 * worktree 移除闸状态机（plan §3.6「移除入口（脏 worktree 走 danger 勾选闸）」——
 * WorktreeInfo 无脏标记，client 无法预判脏态）：首次走 normal 确认（force 不传，
 * host 对脏 worktree 拒绝）；移除失败（git/worktree-failed）后转 danger 勾选闸的
 * 强制移除（force + acknowledged 透传——host 守卫的解锁路径）。
 */
export function worktreeRemovePlan(stage: 'ask' | 'force'): {
  severity: 'normal' | 'danger'
  force: boolean
  acknowledged: boolean
} {
  if (stage === 'ask') return { severity: 'normal', force: false, acknowledged: false }
  return { severity: 'danger', force: true, acknowledged: true }
}

/** worktree 新建区的分支模式（检出现有分支与新建分支互斥——plan §3.2）。 */
export type WorktreeBranchMode = 'existing' | 'new'

/**
 * worktree 新建草稿 → 校验 + 入参组装（null = 校验未过）：path 必填；
 * existing ⇒ branch 给定（newBranch 缺省）；new ⇒ newBranch 给定（branch 缺省）。
 */
export function worktreeAddDraft(input: {
  path: string
  mode: WorktreeBranchMode
  branch: string
  newBranch: string
}): { valid: boolean; missing: 'path' | 'branch' | null; options: WorktreeAddOptions | null } {
  const path = input.path.trim()
  if (path === '') return { valid: false, missing: 'path', options: null }
  if (input.mode === 'existing') {
    const branch = input.branch.trim()
    if (branch === '') return { valid: false, missing: 'branch', options: null }
    return { valid: true, missing: null, options: { path, branch } }
  }
  const newBranch = input.newBranch.trim()
  if (newBranch === '') return { valid: false, missing: 'branch', options: null }
  return { valid: true, missing: null, options: { path, newBranch } }
}
