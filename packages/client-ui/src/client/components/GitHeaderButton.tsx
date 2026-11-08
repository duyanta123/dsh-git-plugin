/**
 * dsh-gitkit-ui — C1 GitHeaderButton（spec §3.1 [清单 47/48/54/65]；V2 批次一扩行）。
 *
 * 注册于 `conversation.session.header.utilities`（list/session——ui-open-in-app 范本）；
 * **不碰 `conversation.session.header.corner`**（AppFrame header 自留席位，map §3.2）。
 *
 * 展示：分支名（[清单 47]）+ 变更角标（badgeCount 去重路径）+ detached（短 oid
 * [清单 65]）/ unborn（[清单 64]）/ 无仓库（[清单 54]）/ 检查中态；点击开菜单
 * （原语 Menu：摘要/冲突 label 行 + 数据行，portal 浮层防 header 溢出裁切）。
 *
 * 菜单动作（V2 批次一，plan §3.6）：
 *   1. 打开变更面板 / 2. 打开提交图（openResource 幂等）；
 *   3. 提交… / 4. 提交并推送… —— GitCommitDialog（④-K）；
 *   5. 推送 —— remoteList 路由（pushRoute）：单远端一步直推（v1 行为不回归），
 *      多远端开 GitPushDialog（remote picker + force danger 双闸）；
 *   6. 拉取 / 7. 获取 —— 直跑（fetch 成功后 refresh() = R5 manual 刷 ahead/behind）；
 *   8. 分支（子菜单）—— 本地分支清单（admin.refs()），当前分支 '✓ ' 前缀（原语
 *      子菜单行无 selected 面），detached 前置短 oid 信息行，点击 branchSwitch
 *      （成功后 refresh()——HEAD 变更驱动 status/graph 重载链路，plan §3.10）；
 *   9. 新建分支… / 10. 打标签… / 11. Worktree… —— 各自对话框；
 *   12. 删除分支…（子菜单）—— 非当前分支逐行（当前分支除外——git 拒删当前分支，
 *       UI 前置排除），点击后 GitConfirmDialog 确认 → branchDelete。
 *
 * 菜单直跑动作的错误面：admin 面板（按钮下方浮动卡，GitErrorNotice + 关闭）——
 * 菜单已收起，错误不能丢。对话框动作的错误面在各对话框内。
 */

import { useEffect, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import { pushRoute } from '../admin-face.js'
import type { HeaderMenuId, HeaderSubmenuEntry } from '../ui-model.js'
import { branchDeleteEntries, branchSubmenuEntries, headerMenuItems, headerViewModel } from '../ui-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import { GitBranchCreateDialog } from './GitBranchCreateDialog.js'
import { GitCommitDialog } from './GitCommitDialog.js'
import type { GitCommitDialogFace } from '../commit-dialog-face.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'
import { GitPushDialog } from './GitPushDialog.js'
import { GitTagCreateDialog } from './GitTagCreateDialog.js'
import { GitWorktreeDialog } from './GitWorktreeDialog.js'

/** inject 面投给组件的 props（inject: () => ({...}) 的形状；spec §3.1 注册范本）。 */
export interface GitHeaderButtonProps {
  /** 词典翻译（注册 locale: NS 后由框架注入）。 */
  t: TranslateNS<'git'>
  /** 状态源订阅 hook（渲染器由 inject 面的 hooks.gitStatus 合成）。 */
  useGitStatus: SnapshotSelectorHook<GitStatusSourceState>
  /**
   * 打开变更面板（openResource 幂等；spec §3.1）。**会话域地址**：inject 工厂以
   * 框架解析的 sessionId 闭包铸造 `dsh-resource://git-changes/session/{id}`。
   */
  openChangesPanel(): void
  /** 打开提交图 tab（openResource 幂等；静态地址 GIT_GRAPH_ADDRESS——F7 提交图模块）。 */
  openGraphPanel(): void
  /** 提交对话框业务面（④-K：commit/push/AI/身份/HEAD 预取——apply 顶层单例闭包）。 */
  commitDialog: GitCommitDialogFace
  /** 管理面业务面（V2 批次一：refs/分支/标签/worktree/推送路由——apply 顶层单例闭包）。 */
  admin: GitAdminFace
  /** R5 manual 状态刷新（fetch / branchSwitch 成功后的 ahead/behind 与图链路刷新）。 */
  refresh(): void
}

/** HeaderSubmenuEntry → 原语 MenuItem（'✓ ' 前缀 = 当前分支行——子菜单无 selected 面）。 */
function toSubmenuItem(entry: HeaderSubmenuEntry, t: GitHeaderButtonProps['t']): MenuItem {
  return {
    id: entry.id,
    label: entry.labelKey !== undefined ? t(entry.labelKey, entry.params) : entry.current ? `✓ ${entry.label}` : entry.label,
    disabled: entry.disabled,
  }
}

/** 菜单直跑动作的任务形态（runAdmin 的入参；拆别名避免泛型签名触发 check-locale
 * 的 JSX 文本启发式——单行内 `>…<` 相邻会被当裸文案，见 check-locale.mjs §3）。 */
type AdminTaskResult = Promise<GitErrorLike | null>
type AdminTask = () => AdminTaskResult

export function GitHeaderButton(props: GitHeaderButtonProps) {
  const { t, useGitStatus, openChangesPanel, openGraphPanel, commitDialog, admin, refresh } = props
  const state = useGitStatus((s) => s)
  const view = headerViewModel(state)
  const menu = headerMenuItems(view)
  const [open, setOpen] = useState(false)
  /** 提交对话框的打开意图（null = 关；值 = defaultAction）。 */
  const [commitIntent, setCommitIntent] = useState<'commit' | 'commit-push' | null>(null)
  // ── V2 批次一管理面：对话框意图 + 分支清单 + admin 错误面 ──
  const [pushIntent, setPushIntent] = useState(false)
  const [branchCreateIntent, setBranchCreateIntent] = useState(false)
  const [tagCreateIntent, setTagCreateIntent] = useState(false)
  const [worktreeIntent, setWorktreeIntent] = useState(false)
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null)
  const [branchList, setBranchList] = useState<readonly RefInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [adminError, setAdminError] = useState<GitErrorLike | null>(null)

  const branch = state.status?.branch ?? null
  const headName = branch !== null && !branch.detached && !branch.unborn ? branch.name : null

  // 菜单开着即取本地分支清单（子菜单数据源；每次开菜单重取防陈旧）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void admin.listLocalBranches().then((result) => {
      if (cancelled) return
      if (result.ok) setBranchList(result.value)
      else setAdminError(result.error)
    })
    return () => { cancelled = true }
  }, [open, admin])

  /** 菜单直跑动作的错误折叠 + busy 闸（防双击重入）。 */
  const runAdmin = async (task: AdminTask): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const error = await task()
      if (error !== null) setAdminError(error)
    } finally {
      setBusy(false)
    }
  }

  const switchBranch = (name: string): void => {
    setOpen(false)
    void runAdmin(async () => {
      const result = await admin.branchSwitch(name)
      if (!result.ok) return result.error
      refresh() // HEAD 变更 → R5 manual 帧 → graph reload 链路（plan §3.10）
      return null
    })
  }

  const deleteBranch = (name: string): void => {
    setDeleteAsk(null)
    void runAdmin(async () => {
      const result = await admin.branchDelete({ name })
      if (!result.ok) return result.error
      refresh()
      return null
    })
  }

  const runPush = (): void => {
    setOpen(false)
    void runAdmin(async () => {
      const remotes = await admin.listRemotes()
      if (!remotes.ok) return remotes.error
      // 多远端 → 对话框（remote picker）；单/零远端 → 一步直推（v1 行为不回归）。
      if (pushRoute(remotes.value.remotes.length) === 'dialog') {
        setPushIntent(true)
        return null
      }
      const result = await admin.push({
        setUpstream: branch?.upstream === null,
        remote: remotes.value.remotes[0]?.name ?? null,
      })
      return result.ok ? null : result.error
    })
  }

  const runMenuId = (id: HeaderMenuId): void => {
    setOpen(false)
    if (id === 'open-changes') openChangesPanel()
    else if (id === 'open-graph') openGraphPanel()
    else if (id === 'commit') setCommitIntent('commit')
    else if (id === 'commit-push') setCommitIntent('commit-push')
    else if (id === 'push') runPush()
    else if (id === 'pull') {
      void runAdmin(async () => {
        const result = await admin.pull()
        return result.ok ? null : result.error
      })
    } else if (id === 'fetch') {
      void runAdmin(async () => {
        const result = await admin.fetch({ remote: null })
        if (!result.ok) return result.error
        refresh() // fetch 成功 → R5 manual 刷 ahead/behind（plan §3.6）
        return null
      })
    } else if (id === 'branch-create') setBranchCreateIntent(true)
    else if (id === 'tag-create') setTagCreateIntent(true)
    else if (id === 'worktree') setWorktreeIntent(true)
    // branches / branch-delete：子菜单行本身不触发动作（原语只展开子菜单）。
  }

  const onSelect = (id: string): void => {
    if (id.startsWith('branch-switch:')) {
      switchBranch(id.slice('branch-switch:'.length))
      return
    }
    if (id.startsWith('branch-delete:')) {
      setOpen(false)
      setDeleteAsk(id.slice('branch-delete:'.length))
      return
    }
    runMenuId(id as HeaderMenuId)
  }

  const label = t(view.labelKey, view.params)
  // ── 菜单面（原语 Menu）：摘要/冲突 label 行 + 数据行（子菜单挂 branches /
  // branch-delete 两行；branch-delete 无可删分支时整行禁用）+ 页脚 label 行。
  const switchEntries = branchSubmenuEntries({
    branches: branchList,
    headName,
    detached: branch?.detached ?? false,
    abbrevOid: branch?.abbrevOid ?? null,
  })
  const deleteEntries = branchDeleteEntries({ branches: branchList, headName })
  const menuEntries: MenuEntry[] = [
    {
      type: 'label' as const,
      id: 'dsh-git-menu-summary',
      text: view.badge === 0 && view.clean
        ? t('problems.clean')
        : t('header.badge', { count: view.badge }),
    },
    ...(view.conflicted > 0
      ? [{
          type: 'label' as const,
          id: 'dsh-git-menu-conflicts',
          text: t('problems.conflicted', { count: view.conflicted }),
        }]
      : []),
    ...menu.map((item) => {
      const base = {
        id: item.id,
        label: t(item.labelKey),
        disabled: !item.enabled,
      }
      if (item.id === 'branches' && switchEntries.length > 0) {
        return { ...base, submenu: switchEntries.map((entry) => toSubmenuItem(entry, t)) }
      }
      if (item.id === 'branch-delete') {
        return { ...base, disabled: !item.enabled || deleteEntries.length === 0, ...(deleteEntries.length > 0 ? { submenu: deleteEntries.map((entry) => toSubmenuItem(entry, t)) } : {}) }
      }
      return base
    }),
  ]
  const menuFooter = [
    { type: 'label' as const, id: 'dsh-git-menu-shortcut', text: t('shortcut.hint') },
  ]
  return (
    <div className='dsh-git-header-button' data-git-header-button=''>
      <Menu
        open={open}
        anchor={
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
        }
        items={menuEntries}
        footer={menuFooter}
        onSelect={onSelect}
        onClose={() => { setOpen(false) }}
        portal
        listClassName='dsh-git-header-button__menu'
      />
      {/* admin 错误面：菜单直跑动作失败后的浮动卡（菜单已收起——错误不能丢）。 */}
      {adminError !== null && (
        <div className='dsh-git-header-button__notice' data-git-admin-notice=''>
          <GitErrorNotice error={adminError} t={t} />
          <button
            type='button'
            className='dsh-git-header-button__notice-close'
            data-git-admin-notice-close=''
            onClick={() => { setAdminError(null) }}
          >
            {t('common.close')}
          </button>
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
      <GitPushDialog
        open={pushIntent}
        t={t}
        face={admin}
        branch={branch === null ? null : {
          name: branch.name,
          upstream: branch.upstream,
          detached: branch.detached,
          unborn: branch.unborn,
        }}
        onDone={() => { setPushIntent(false) }}
        onClose={() => { setPushIntent(false) }}
      />
      <GitBranchCreateDialog
        open={branchCreateIntent}
        t={t}
        face={admin}
        onDone={() => {
          setBranchCreateIntent(false)
          refresh()
        }}
        onClose={() => { setBranchCreateIntent(false) }}
      />
      <GitTagCreateDialog
        open={tagCreateIntent}
        t={t}
        face={admin}
        oid={null}
        targetLabel={null}
        onDone={() => {
          setTagCreateIntent(false)
          refresh()
        }}
        onClose={() => { setTagCreateIntent(false) }}
      />
      <GitWorktreeDialog
        open={worktreeIntent}
        t={t}
        face={admin}
        onClose={() => { setWorktreeIntent(false) }}
      />
      <GitConfirmDialog
        open={deleteAsk !== null}
        title={t('branch.delete.title')}
        message={t('branch.delete.message', { name: deleteAsk ?? '' })}
        severity='normal'
        confirmLabel={t('branch.delete.title')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => { if (deleteAsk !== null) deleteBranch(deleteAsk) }}
        onCancel={() => { setDeleteAsk(null) }}
      />
    </div>
  )
}
