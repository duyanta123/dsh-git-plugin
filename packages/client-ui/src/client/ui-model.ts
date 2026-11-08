/**
 * dsh-gitkit-ui — UI 纯视图模型（tests/ui-model.spec 的被测面）。
 *
 * C1 GitHeaderButton 的渲染决策全部收敛为纯函数（组件只做 t/订阅/事件）——
 * spec §6 的纯函数单测纪律：分支名/角标/detached/unborn/禁用态不依赖 DOM 即可断言。
 */

import type { GitLocaleKey } from './locales.js'
import type { GitStatusSourceState } from './store/git-status-source.js'

/** header 按钮的展示形态（与词典 header.* 键一一对应）。 */
export type HeaderViewKind = 'checking' | 'no-repo' | 'unborn' | 'detached' | 'branch'

/** header 按钮渲染模型。 */
export interface HeaderView {
  kind: HeaderViewKind
  /** 文案键（header.checking/noRepo/unborn/detached/branch）。 */
  labelKey: GitLocaleKey
  /** 文案插值参数（branch → {name}；detached → {oid}）。 */
  params: Record<string, string>
  /** 变更角标数（distinct 路径——UU 同文件在 staged/unstaged/conflicted 不重复计数）。 */
  badge: number
  /** 冲突文件数（problems.conflicted 行）。 */
  conflicted: number
  /** 工作区是否干净（problems.clean 行）。 */
  clean: boolean
  /** 菜单动作是否可用（无仓库时禁用 [清单 54]；unborn 仓库仍可提交 [清单 64]）。 */
  actionsEnabled: boolean
}

/** 不可用类域码（header 空态 [清单 54] 的判据；与状态源的 repo 投影同口径）。 */
const UNAVAILABLE_CODES = new Set(['git/no-repository', 'git/session-workspace-unresolved'])

/**
 * 快照 → 角标数：四组（staged/unstaged/untracked/conflicted）出现过的**去重路径**数。
 * spec §3.1 口径为「staged+unstaged+untracked+conflicted 总数」，ZCode `main ●3` 形态；
 * UU 条目会同时出现在三组，逐组求和会把一个冲突文件数成三次——按去重路径计。
 */
export function badgeCount(snapshot: {
  staged: readonly { path: string }[]
  unstaged: readonly { path: string }[]
  untracked: readonly { path: string }[]
  conflicted: readonly { path: string }[]
}): number {
  const paths = new Set<string>()
  for (const group of [snapshot.staged, snapshot.unstaged, snapshot.untracked, snapshot.conflicted]) {
    for (const change of group) paths.add(change.path)
  }
  return paths.size
}

/** 状态源快照 → header 渲染模型（纯函数）。 */
export function headerViewModel(state: GitStatusSourceState): HeaderView {
  const snapshot = state.status
  if (snapshot === null) {
    // 快照未就绪：域错误不可用类（no-repository 等）⇒ 无仓库空态；否则按「检查中」。
    const unavailable = state.statusError !== null && UNAVAILABLE_CODES.has(state.statusError.code)
    return {
      kind: unavailable ? 'no-repo' : 'checking',
      labelKey: unavailable ? 'header.noRepo' : 'header.checking',
      params: {},
      badge: 0,
      conflicted: 0,
      clean: false,
      actionsEnabled: false,
    }
  }
  const branch = snapshot.branch
  const badge = badgeCount(snapshot)
  if (branch.unborn) {
    return { kind: 'unborn', labelKey: 'header.unborn', params: {}, badge, conflicted: snapshot.conflicted.length, clean: snapshot.clean, actionsEnabled: true }
  }
  if (branch.detached || branch.name === null) {
    const oid = branch.abbrevOid ?? branch.oid ?? ''
    return { kind: 'detached', labelKey: 'header.detached', params: { oid }, badge, conflicted: snapshot.conflicted.length, clean: snapshot.clean, actionsEnabled: true }
  }
  return {
    kind: 'branch',
    labelKey: 'header.branch',
    params: { name: branch.name },
    badge,
    conflicted: snapshot.conflicted.length,
    clean: snapshot.clean,
    actionsEnabled: true,
  }
}

/**
 * C1 菜单条目的纯模型（V2 批次一扩行：打开变更面板 / 提交图 / 提交… / 提交并推送… /
 * 推送 / 拉取 / 获取 / 分支子菜单 / 新建分支… / 打标签… / Worktree… / 删除分支…）。
 * v1 的 `sync` 占位行已拆为 push/pull/fetch 三真行（plan §3.6）——`placeholder` 位随
 * 最后一个占位行消失而移除。
 */
export type HeaderMenuId =
  | 'open-changes' | 'open-graph' | 'commit' | 'commit-push'
  | 'push' | 'pull' | 'fetch'
  | 'branches' | 'branch-create' | 'tag-create' | 'worktree' | 'branch-delete'

export interface HeaderMenuItem {
  id: HeaderMenuId
  labelKey: GitLocaleKey
}

/** 菜单模型（actionsEnabled=false 时全部禁用——无仓库无动作 [清单 54]）。 */
export function headerMenuItems(view: HeaderView): ReadonlyArray<HeaderMenuItem & { enabled: boolean }> {
  const items: HeaderMenuItem[] = [
    { id: 'open-changes', labelKey: 'menu.openChanges' },
    { id: 'open-graph', labelKey: 'menu.graph' },
    // ④-K 提交对话框模块：commit / commitPush 接通对话框拉起（spec §3.1 [清单 48]）。
    { id: 'commit', labelKey: 'menu.commit' },
    { id: 'commit-push', labelKey: 'menu.commitPush' },
    // V2 批次一：sync 占位转真的三行（plan §3.6）——push 行的多 remote 分叉在
    // admin-face/push 对话框（remotes>1 开对话框，单 remote 一步直推）。
    { id: 'push', labelKey: 'menu.push' },
    { id: 'pull', labelKey: 'menu.pull' },
    { id: 'fetch', labelKey: 'menu.fetch' },
    // V2 批次一管理面扩行（plan §3.6）：branches/branch-delete 两行挂子菜单
    // （数据由 admin-face refs()/分支清单装配，见 branchSubmenuEntries /
    // branchDeleteEntries）；branch-create/tag-create/worktree 三行拉起对话框。
    { id: 'branches', labelKey: 'menu.branches' },
    { id: 'branch-create', labelKey: 'menu.branchCreate' },
    { id: 'tag-create', labelKey: 'menu.tagCreate' },
    { id: 'worktree', labelKey: 'menu.worktree' },
    { id: 'branch-delete', labelKey: 'menu.branchDelete' },
  ]
  return items.map((item) => ({ ...item, enabled: view.actionsEnabled }))
}

/** 分支子菜单的一行（纯模型；组件映射为原语 Menu 的 MenuItem）。 */
export interface HeaderSubmenuEntry {
  id: string
  /** 直显文本（分支名等 git 中性词；labelKey 给定时由 t() 渲染取代）。 */
  label: string
  /** 词典键渲染（detached 信息行复用 'header.detached'）。 */
  labelKey?: GitLocaleKey
  /** labelKey 的插值参数。 */
  params?: Record<string, string>
  disabled: boolean
  /** 当前分支行（原语 Menu 的子菜单行无 selected 面——组件渲染 '✓ ' 前缀表达打勾）。 */
  current: boolean
}

/**
 * 分支选择子菜单的渲染模型（plan §3.6「当前分支打勾、detached 显短 oid、点击切换」）：
 * detached 时前置一条禁用的信息行（复用 header.detached {oid=短 oid}——不可选，纯提示）；
 * 其后逐本地分支一行，当前分支标 current。unborn/空分支清单 ⇒ 空数组。
 */
export function branchSubmenuEntries(params: {
  branches: readonly { shortName: string }[]
  headName: string | null
  detached: boolean
  abbrevOid: string | null
}): HeaderSubmenuEntry[] {
  const entries: HeaderSubmenuEntry[] = []
  if (params.detached && params.abbrevOid !== null) {
    entries.push({
      id: 'branch-head',
      label: params.abbrevOid,
      labelKey: 'header.detached',
      params: { oid: params.abbrevOid },
      disabled: true,
      current: false,
    })
  }
  for (const branch of params.branches) {
    entries.push({
      id: `branch-switch:${branch.shortName}`,
      label: branch.shortName,
      disabled: false,
      current: branch.shortName === params.headName,
    })
  }
  return entries
}

/**
 * 删除分支子菜单的渲染模型（plan §3.6「当前分支除外——git 拒删当前分支，UI 前置
 * 禁用」）：当前分支不进清单（排除即前置禁用）；其余分支逐行可点。
 */
export function branchDeleteEntries(params: {
  branches: readonly { shortName: string }[]
  headName: string | null
}): HeaderSubmenuEntry[] {
  return params.branches
    .filter((branch) => branch.shortName !== params.headName)
    .map((branch) => ({ id: `branch-delete:${branch.shortName}`, label: branch.shortName, disabled: false, current: false }))
}

/**
 * C5 danger 确认闸（纯逻辑；tests/ui-model.spec 断言）：normal 恒可确认；
 * danger 必须勾选「不可逆」复选框后才可确认。
 */
export function confirmButtonEnabled(severity: 'normal' | 'danger', checkboxChecked: boolean): boolean {
  return severity !== 'danger' || checkboxChecked
}
