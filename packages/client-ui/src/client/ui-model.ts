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

/** C1 菜单条目的纯模型（五动作：打开变更面板 / 提交图 / 提交… / 提交并推送… / 同步占位）。 */
export interface HeaderMenuItem {
  id: 'open-changes' | 'open-graph' | 'commit' | 'commit-push' | 'sync'
  labelKey: GitLocaleKey
  /** 占位动作：禁用 + placeholderHint 提示（后续模块接线）。 */
  placeholder: boolean
}

/** 菜单模型（actionsEnabled=false 时全部禁用——无仓库无动作 [清单 54]）。 */
export function headerMenuItems(view: HeaderView): ReadonlyArray<HeaderMenuItem & { enabled: boolean }> {
  const items: HeaderMenuItem[] = [
    { id: 'open-changes', labelKey: 'menu.openChanges', placeholder: false },
    { id: 'open-graph', labelKey: 'menu.graph', placeholder: false },
    // ④-K 提交对话框模块：commit / commitPush 接通对话框拉起（spec §3.1 [清单 48]）。
    { id: 'commit', labelKey: 'menu.commit', placeholder: false },
    { id: 'commit-push', labelKey: 'menu.commitPush', placeholder: false },
    // 推送/拉取/获取的合并占位（写 UI 动作随同步模块接线；openIssues 记录）。
    { id: 'sync', labelKey: 'menu.sync', placeholder: true },
  ]
  return items.map((item) => ({ ...item, enabled: view.actionsEnabled && !item.placeholder }))
}

/**
 * C5 danger 确认闸（纯逻辑；tests/ui-model.spec 断言）：normal 恒可确认；
 * danger 必须勾选「不可逆」复选框后才可确认。
 */
export function confirmButtonEnabled(severity: 'normal' | 'danger', checkboxChecked: boolean): boolean {
  return severity !== 'danger' || checkboxChecked
}
