/**
 * dsh-gitkit — V2 批次一管理面纯视图模型（推送对话框 / 分支创建 / 标签创建 /
 * worktree 管理的渲染决策；plan §3.6）。组件只做 t/订阅/事件——渲染决策全部收敛为
 * 纯函数（spec §6 纯函数单测纪律；ui-model.ts / commit-view-model.ts 同款收敛），
 * 断言面 = tests/push-dialog.spec.ts（推送对话框：force→danger 闸状态机；remote picker
 * 可见性路由 = admin-face.pushRoute 纯函数，同 spec 亦断言）与
 * tests/admin-view-model.spec.ts（分支/标签/worktree 草稿与移除闸）。
 *
 * danger 双闸复用：force push / 脏 worktree 强制移除的「确认勾选闸」即
 * GitConfirmDialog severity='danger'（勾选前确认禁用，纯逻辑 confirmButtonEnabled
 * ui-model.ts:114 一处实现两处消费）。
 *
 * V3 批次三（[45]；v3-implementation-plan §5.7）扩：`agentToolsStatusLine`——header
 * 菜单「Agent 工具」状态行的渲染决策（只读展示无操作面；断言面同
 * tests/admin-view-model.spec.ts）。
 *
 * V3 批次五（[42][43]；v3-implementation-plan §7.5）扩：`automationStatusLines`——header
 * 菜单「自动化」状态行（开关态行 + 最近动作摘要行）的渲染决策（只读观测无操作面，
 * 启停在 profile 配置层；断言面同 tests/admin-view-model.spec.ts）。
 */

import type {
  AutomationStatusResult, BranchCreateOptions, BranchMergeOptions, CherryPickOptions, PushOptions, RebaseOptions,
  RemoteInfo, ResetOptions, RevertOptions, TagCreateOptions, WorktreeAddOptions, WorktreeInfo,
} from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'

// ── 推送对话框（[27][57]）────────────────────────────────────────────────────

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

// ── 时间旅行（V2 批次二 [37]；plan §4.2/§4.6）────────────────────────────────

/** reset 档位（plan §4.2 ResetOptions.kind）。 */
export type ResetKind = 'soft' | 'mixed' | 'hard'

/**
 * reset 确认计划（plan §4.6「reset 子菜单（soft/mixed/hard；hard 走 danger 勾选闸）」
 * + §4.10「UI 需列出将丢弃的文件计数」的纯决策半）：hard ⇒ severity danger（确认
 * 勾选闸 confirmButtonEnabled('danger', checked) 承担）；baseRevision = 当前 HEAD oid
 * （discard 三重守卫同款乐观并发基线——null ⇒ 不可发起）。
 */
export function resetPlan(input: {
  kind: ResetKind
  target: string
  baseRevision: string | null
  acked: boolean
}): { valid: boolean; severity: 'normal' | 'danger'; options: ResetOptions | null } {
  const severity = input.kind === 'hard' ? 'danger' : 'normal'
  if (input.target === '' || input.baseRevision === null) return { valid: false, severity, options: null }
  if (input.kind === 'hard' && !input.acked) return { valid: false, severity, options: null }
  return {
    valid: true,
    severity,
    options: { kind: input.kind, target: input.target, acknowledged: true, baseRevision: input.baseRevision },
  }
}

/**
 * cherry-pick / revert 的入参组装（plan §4.2：acknowledged + baseRevision——discard
 * 三重守卫同款；baseRevision null ⇒ 不可发起，调用方禁用入口）。重载按 kind 收窄
 * 返回型（调用半 admin.cherryPick/admin.revert 各吃各的入参型）。
 */
export function timeTravelOptions(kind: 'cherry-pick', input: { oid: string; baseRevision: string | null }): CherryPickOptions | null
export function timeTravelOptions(kind: 'revert', input: { oid: string; baseRevision: string | null }): RevertOptions | null
export function timeTravelOptions(
  _kind: 'cherry-pick' | 'revert',
  input: { oid: string; baseRevision: string | null },
): CherryPickOptions | RevertOptions | null {
  if (input.oid === '' || input.baseRevision === null) return null
  return { oid: input.oid, acknowledged: true, baseRevision: input.baseRevision }
}

// ── merge / rebase 对话框（V3 批次二 [28][29]；v3-implementation-plan §4.6）────

/** merge 的 ff 三态（BranchMergeOptions.fastForward 的 client 侧别名；plan §4.2）。 */
export type MergeFastForward = 'auto' | 'ff-only' | 'no-ff'

/**
 * merge 草稿 → 校验 + 入参组装（null = 校验未过；tests/merge-dialog.spec 断言面）。
 * - ff 三态 → 命令参数：`fastForward` 原样过线；`message` 仅 no-ff 且非空时组装
 *   （plan §4.6「message 编辑（no-ff 时）」——auto/ff-only 缺省 = host `--no-edit`；
 *   ff-only 恒 omit，git 对纯快进不用 `-m`）。wire 纪律「可选入参省略传递」：不产
 *   `message` 键，不传 undefined。
 * - danger 恒档：合并提交是对外可见动作（plan §4.6）——含 ff-only（纯快进也移动
 *   分支指针），确认走 danger 勾选闸（`confirmButtonEnabled('danger', acked)`）；
 *   acked 未过 ⇒ valid:false + options null（host acknowledged 守卫的 UI 对应物）。
 * - headName（当前分支）/headOid（乐观并发基线）任一缺席（detached/unborn）⇒ 不可
 *   发起——host 守卫链 no-branch/baseRevision 的 UI 前置闸。
 */
export function mergePlan(input: {
  branch: string
  fastForward: MergeFastForward
  message: string
  headName: string | null
  headOid: string | null
  acked: boolean
}): { valid: boolean; severity: 'normal' | 'danger'; options: BranchMergeOptions | null } {
  const severity = 'danger' as const
  const branch = input.branch.trim()
  if (input.headName === null || input.headOid === null || branch === '' || !input.acked) {
    return { valid: false, severity, options: null }
  }
  const message = input.message.trim()
  return {
    valid: true,
    severity,
    options: {
      branch,
      fastForward: input.fastForward,
      ...(input.fastForward === 'no-ff' && message !== '' ? { message } : {}),
      acknowledged: true,
      baseRevision: input.headOid,
    },
  }
}

/**
 * rebase 草稿 → 校验 + 入参组装（null = 校验未过；tests/merge-dialog.spec 断言面）。
 * - upstream 必填、onto 可选（plan §4.2）：onto 空 = omit（wire 可选入参省略纪律）。
 * - danger 恒档：变基重写当前分支的未推送历史（plan §4.6「danger 确认——重写历史
 *   语义」）——acked 未过 ⇒ valid:false + options null。
 * - headOid（乐观并发基线）缺席 ⇒ 不可发起（host 守卫链 ② 的 UI 前置闸）。
 */
export function rebasePlan(input: {
  upstream: string
  onto: string
  headOid: string | null
  acked: boolean
}): { valid: boolean; severity: 'normal' | 'danger'; options: RebaseOptions | null } {
  const severity = 'danger' as const
  const upstream = input.upstream.trim()
  if (upstream === '' || input.headOid === null || !input.acked) {
    return { valid: false, severity, options: null }
  }
  const onto = input.onto.trim()
  return {
    valid: true,
    severity,
    options: {
      upstream,
      ...(onto !== '' ? { onto } : {}),
      acknowledged: true,
      baseRevision: input.headOid,
    },
  }
}

// ── Agent 工具状态行（V3 批次三 [45]；v3-implementation-plan §5.7）────────────

/**
 * agentToolsStatus 出参 → header 菜单「Agent 工具」状态行渲染模型（纯函数；
 * tests/admin-view-model.spec 断言面）。最小展示面（plan §5.7 只定义 off/on 两形态）：
 * - `mode:'off'` ⇒ 关闭行（'agentTools.status.off'）；
 * - `mode:'readonly'|'readwrite'` 且 toolsFaceAvailable ⇒ on 行
 *   （'agentTools.status.on'，{mode} = 配置档位原样词条——profile 配置字面量，
 *   用户可对着 config 核对；{count} = registered.length）；
 * - **降级档决策**：mode 开而 toolsFaceAvailable=false（dsh-tools 未挂载的部署，
 *   host 降级 registered=[]——plan §5.10）⇒ 按关闭行渲染。有效态没有可用工具，
 *   「readonly (0 tools)」会把不可用宣成可用；关闭行忠实表达「模型当前用不了 git
 *   工具」，降级的部署成因仍可经 RPC/verify-load 的 toolsFaceAvailable=false 观测
 *   （§5.10「静默且可观测」）。
 * - 输入 null（拉取失败/未拉取）⇒ null——状态行整行缺席（观测行失败不进错误卡，
 *   GitHeaderButton 半静默降级）。
 * 无操作面：工具启停在 profile 配置层（Config.agentTools），UI 只读。
 */
export function agentToolsStatusLine(status: {
  mode: 'off' | 'readonly' | 'readwrite'
  toolsFaceAvailable: boolean
  registered: readonly string[]
} | null): { labelKey: GitLocaleKey; params: Record<string, string | number> } | null {
  if (status === null) return null
  if (status.mode === 'off' || !status.toolsFaceAvailable) {
    return { labelKey: 'agentTools.status.off', params: {} }
  }
  return {
    labelKey: 'agentTools.status.on',
    params: { mode: status.mode, count: status.registered.length },
  }
}

// ── 自动化状态行（V3 批次五 [42][43]；v3-implementation-plan §7.5）────────────

/**
 * automationStatus 出参 → header 菜单「自动化」状态行渲染模型（纯函数；
 * tests/admin-view-model.spec 断言面）。最小展示面（§7.5 默认仅状态行，无操作面——
 * 启停在 profile 配置层，与批次三同口径）：
 * - `status` = 开关态行：两模式全 off ⇒ 关闭行（'automation.status.off'）；任一开
 *   ⇒ 档位行（'automation.status.on'，{commit}/{branch} = Config 档位字面量
 *   'off'/'turn-end'/'session-start' 原样词条——配置 token 原样，用户可对着 profile
 *   config 核对，agentTools 行 {mode} 同款纪律）。
 * - `latest` = 最近动作摘要行数据：lastActions 首条（host newest-first 环，环 20 条
 *   ——plan §7.3）。kind → 词条键映射（'automation.action.commit'/'branch'）；ok/detail
 *   原样透传——detail = host 白名单摘要（已单行化/消毒/200 上限，不落消息正文；
 *   client 不再截断以免吞掉 skip/失败原因）。**空环 ⇒ null**（摘要行缺席——
 *   「最近动作：无」常驻行对默认 off 档是噪音）。tooltip 注记：原语 MenuEntry 无
 *   tooltip 通道（MenuLabel 只有 {type,id,text}），摘要以相邻非交互行落地
 *   （GitHeaderButton 渲染半）——语义同「最近动作摘要」。
 * - 输入 null（拉取失败/未拉取）⇒ null——两行整组缺席（观测行不进错误卡，
 *   GitHeaderButton 半静默降级，agentToolsStatusLine 同款）。
 */
export function automationStatusLines(status: AutomationStatusResult | null): {
  status: { labelKey: GitLocaleKey; params: Record<string, string | number> }
  latest: { kindKey: GitLocaleKey; ok: boolean; detail: string } | null
} | null {
  if (status === null) return null
  const latest = status.lastActions[0] ?? null
  return {
    status: status.autoCommitMode === 'off' && status.autoBranchMode === 'off'
      ? { labelKey: 'automation.status.off', params: {} }
      : {
          labelKey: 'automation.status.on',
          params: { commit: status.autoCommitMode, branch: status.autoBranchMode },
        },
    latest: latest === null ? null : {
      kindKey: latest.action === 'auto-commit' ? 'automation.action.commit' : 'automation.action.branch',
      ok: latest.ok,
      detail: latest.detail,
    },
  }
}
