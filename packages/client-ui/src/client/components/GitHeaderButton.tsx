/**
 * dsh-gitkit-ui — C1 GitHeaderButton（spec §3.1 [清单 47/48/54/65]）。
 *
 * 注册于 `conversation.session.header.utilities`（list/session——ui-open-in-app 范本）；
 * **不碰 `conversation.session.header.corner`**（AppFrame header 自留席位，map §3.2）。
 *
 * 展示：分支名（[清单 47]）+ 变更角标（ZCode `main ●3` 形态，badgeCount 去重路径）+
 * detached（短 oid [清单 65]）/ unborn（[清单 64]）/ 无仓库（友好空态 [清单 54]）/
 * 检查中态；点击开菜单，五动作（④-K 提交对话框模块接线）：
 *   1. 打开变更面板 —— `ctx.sidebarRight.openResource(gitChangesAddress(sessionId))`
 *      （真实；会话域地址由 inject 工厂闭包铸造，tab body 在 F 变更面板模块落地）；
 *   2. 打开提交图（openResource 幂等；F7 模块）；
 *   3. 提交… / 4. 提交并推送… —— 拉起 GitCommitDialog（portal 浮层，defaultAction
 *      随菜单项；spec §3.1 [清单 48]）；
 *   5. 同步 —— 占位（禁用 + placeholderHint；push/pull/fetch 菜单动作随同步模块落地）。
 *
 * 数据订阅：inject 面的 `hooks.gitStatus`（状态源 store）经渲染器 uSES 桥合成为
 * `useGitStatus` 选择器 hook（ui-renderer scoped-slots cachedSlotInject 实读语义）。
 */

import { useState } from 'react'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitCommitDialogFace } from '../commit-dialog-face.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import { headerMenuItems, headerViewModel } from '../ui-model.js'
import { GitCommitDialog } from './GitCommitDialog.js'

/** inject 面投给组件的 props（inject: () => ({...}) 的形状；spec §3.1 注册范本）。 */
export interface GitHeaderButtonProps {
  /** 词典翻译（注册 locale: NS 后由框架注入）。 */
  t: TranslateNS<'git'>
  /** 状态源订阅 hook（渲染器由 inject 面的 hooks.gitStatus 合成）。 */
  useGitStatus: SnapshotSelectorHook<GitStatusSourceState>
  /**
   * 打开变更面板（openResource 幂等；spec §3.1）。**会话域地址**：inject 工厂以
   * 框架解析的 sessionId 闭包铸造 `dsh-resource://git-changes/session/{id}`（本模块
   * ask §①），组件无需自行持有 session id。
   */
  openChangesPanel(): void
  /** 打开提交图 tab（openResource 幂等；静态地址 GIT_GRAPH_ADDRESS——F7 提交图模块）。 */
  openGraphPanel(): void
  /** 提交对话框业务面（④-K：commit/push/AI/身份/HEAD 预取——apply 顶层单例闭包）。 */
  commitDialog: GitCommitDialogFace
  /** 同步占位（push/pull/fetch 模块接线）。 */
  syncNow(): void
}

export function GitHeaderButton(props: GitHeaderButtonProps) {
  const { t, useGitStatus, openChangesPanel, openGraphPanel, commitDialog, syncNow } = props
  const state = useGitStatus((s) => s)
  const view = headerViewModel(state)
  const menu = headerMenuItems(view)
  const [open, setOpen] = useState(false)
  /** 提交对话框的打开意图（null = 关；值 = defaultAction）。 */
  const [commitIntent, setCommitIntent] = useState<'commit' | 'commit-push' | null>(null)
  const run = (id: 'open-changes' | 'open-graph' | 'commit' | 'commit-push' | 'sync'): void => {
    setOpen(false)
    if (id === 'open-changes') openChangesPanel()
    else if (id === 'open-graph') openGraphPanel()
    else if (id === 'commit') setCommitIntent('commit')
    else if (id === 'commit-push') setCommitIntent('commit-push')
    else syncNow()
  }
  const label = t(view.labelKey, view.params)
  return (
    <div className='dsh-git-header-button' data-git-header-button=''>
      <button
        type='button'
        className='dsh-git-header-button__toggle'
        aria-haspopup='menu'
        aria-expanded={open}
        aria-label={t('header.title')}
        title={t('header.title')}
        data-git-header-state={view.kind}
        onClick={() => { setOpen((value) => !value) }}
      >
        <span className='dsh-git-header-button__label'>{label}</span>
        {view.badge > 0 && (
          <span className='dsh-git-header-button__badge' data-git-badge=''>{view.badge}</span>
        )}
      </button>
      {open && (
        <div className='dsh-git-header-button__menu' data-git-menu='' role='menu'>
          <p className='dsh-git-header-button__summary' data-git-summary=''>
            {view.badge === 0 && view.clean
              ? t('problems.clean')
              : t('header.badge', { count: view.badge })}
          </p>
          {view.conflicted > 0 && (
            <p className='dsh-git-header-button__conflicts' data-git-conflicts=''>
              {t('problems.conflicted', { count: view.conflicted })}
            </p>
          )}
          {menu.map((item) => (
            <button
              key={item.id}
              type='button'
              role='menuitem'
              className='dsh-git-header-button__item'
              data-git-menu-item={item.id}
              disabled={!item.enabled}
              title={item.placeholder ? t('menu.placeholderHint') : undefined}
              onClick={() => { if (item.enabled) run(item.id) }}
            >
              {t(item.labelKey)}
            </button>
          ))}
          <p className='dsh-git-header-button__shortcut' data-git-shortcut=''>{t('shortcut.hint')}</p>
        </div>
      )}
      <GitCommitDialog
        open={commitIntent !== null}
        defaultAction={commitIntent ?? 'commit'}
        snapshot={state.status}
        t={t}
        face={commitDialog}
        onDone={() => { setCommitIntent(null) }}
        onClose={() => { setCommitIntent(null) }}
      />
    </div>
  )
}
