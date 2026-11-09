/**
 * dsh-gitkit-ui — 非 git 目录空态引导纯视图模型（V2 批次四 [8]；plan §6.6）。
 *
 * 交付面（plan §6.1 [8] 行 + §6.6）：`git/no-repository` 状态下 changes/graph tab
 * 空态卡片（说明 + 初始化按钮）+ header 菜单「初始化 Git 仓库…」行；成功后
 * `source.refresh()`（R5 manual——init 后 host 侧 StatusEngine 缓存失效 + workspace
 * 重解析，客户端重开流取首帧，plan §6.3 initRepository 行）。
 *
 * **workspaceOverride 钉死态的判定口径（如实登记）**：plan §6.6 要求「workspaceOverride
 * 已钉死时不显示」。wire 面（host RemoteErrorDetailsMap：`session-workspace-unresolved`
 * details 为空，`no-repository` details 只有 probed 路径——workspace.ts 实读）**没有**
 * 暴露「workspaceOverride 已钉死且可解析」的信号，client 无法直接判别该 Config。
 * 可判别的近似 = 错误码分态：`git/session-workspace-unresolved`（workspace 解析失败，
 * 覆盖「钉死路径解析不了」情形——该态无可用目标目录，初始化无从谈起）⇒ 卡片不显示；
 * `git/no-repository`（workspace 已解析、只是不是仓库）⇒ 显示。钉死到「可解析但非
 * 仓库」目录时卡片仍显示（该场景 init 是有效动作且可成功）——与 plan 的括号注记
 * 「（已是仓库）」的隐含意图一致，偏差记入施工 deviations。
 *
 * 断言面 = tests/init-empty-state.spec.ts（空态视图模型 / workspace-unresolved 不
 * 显示 / 确认流意图）。
 */

import type { GitLocaleKey } from './locales.js'
import type { GitErrorLike } from './remote/mount.js'

/** 初始化空态卡片渲染模型（null = 不渲染）。 */
export interface InitEmptyStateView {
  /** 主文案键（init.card.title）。 */
  titleKey: GitLocaleKey
  /** 说明文案键（init.card.body）。 */
  bodyKey: GitLocaleKey
  /** 动作文案键（init.card.action）。 */
  actionKey: GitLocaleKey
  /** 进行中文案键（init.card.running）。 */
  runningKey: GitLocaleKey
  /** 点击意图（initRepository 成功后 refresh——组件映射为 refresh 回调）。 */
  intent: 'init-and-refresh'
}

/**
 * 状态源快照 → 初始化引导卡片渲染模型（纯函数）。
 *
 * 显示条件 = 仓库不可用 && 非检查中 && 最近一帧错误恰为 `git/no-repository`
 * （workspace 已解析的目标目录不是仓库——可初始化）。`git/session-workspace-unresolved`
 * （无可用目标目录）与检查中/可用态 ⇒ null 不渲染；可用仓库的空态由既有
 * changes.empty / graph.noCommits 承担。
 */
export function initEmptyStateView(params: {
  available: boolean
  checking: boolean
  statusError: GitErrorLike | null
}): InitEmptyStateView | null {
  if (params.available || params.checking) return null
  if (params.statusError?.code !== 'git/no-repository') return null
  return {
    titleKey: 'init.card.title',
    bodyKey: 'init.card.body',
    actionKey: 'init.card.action',
    runningKey: 'init.card.running',
    intent: 'init-and-refresh',
  }
}

/**
 * header 菜单「初始化 Git 仓库…」行的可见性（纯函数；ui-model.headerMenuItems 的
 * no-repo 分支消费同一判定——单点实现两处消费）。与卡片同口径：恰 no-repository 可见。
 */
export function initMenuEntryVisible(params: {
  available: boolean
  checking: boolean
  statusError: GitErrorLike | null
}): boolean {
  return initEmptyStateView(params) !== null
}
