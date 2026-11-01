/**
 * dsh-gitkit-ui — C2 GitChangesTab：变更审查 tab body（本模块 ask §②/⑥；
 * spec §3.1 [清单 1/2/3/4/9/12/59]）。
 *
 * 注册于 keyed `sidebar.right.pane.tab`（key = 'dsh-plugin.git.changes'——两段注册
 * 第二段；ui-deliverables ReviewTab 范本）：useTabInfo 读 tab.contentId（会话域
 * git-changes 地址）严格解析，解析不过即抛（本插件只渲染自己铸造的地址）。
 *
 * 面板结构：unborn 提示条（[清单 64]）→ 状态/写操作错误条 → 四组列表（冲突置顶
 * [清单 1]，组内目录树分组 [清单 4]，目录折叠态在 tab store）→ 变更卡片（勾选 ⇄
 * stage/unstage [清单 9]；行内动作按组区分——staged 仅 unstage，changes/untracked
 * stage + discard）→ 点行懒加载 diff [清单 2/3]（缓存 rev:path:scope，git-changes
 * store）→ discard 走 C5 GitConfirmDialog 二次确认（路径全量 + 勾选闸 [清单 12]）。
 *
 * 空态：无仓库友好空态 [清单 54]；工作区干净 changes.empty。
 */

import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { parseGitChangesAddress } from '../addresses.js'
import type { ChangeRow, ChangesViewModel } from '../changes-view-model.js'
import { changesViewModel } from '../changes-view-model.js'
import type { GitCommitDialogFace } from '../commit-dialog-face.js'
import type { PathNode } from '../group-paths.js'
import { groupPaths } from '../group-paths.js'
import type { NS } from '../locales.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import { diffCacheKey } from '../store/git-changes-store.js'
import type { GitChangesState } from '../store/git-changes-store.js'
import type { ChangesTabStoreHandle } from '../store/changes-tab-store.js'
import { ChangeCard } from './ChangeCard.js'
import { FileDiffView } from './FileDiffView.js'
import { GitCommitDialog } from './GitCommitDialog.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** 插件投给 tab body 的业务面（inject 工厂产物；hooks 由渲染器合成 use* 选择器）。 */
export interface ChangesInjected {
  hooks: {
    /** 工作区状态源（④-D git-status-source）。 */
    gitStatus: ObservableSnapshot<GitStatusSourceState>
    /** 变更面板数据缓存（本模块 git-changes-store）。 */
    gitChanges: ObservableSnapshot<GitChangesState>
  }
  loadDiff(scope: ChangeRow['scope'], path: string): void
  stage(paths: readonly string[]): void
  unstage(paths: readonly string[]): void
  discard(paths: readonly string[]): void
  /** 状态源手动刷新（R5 manual；状态错误条的重试动作）。 */
  refresh(): void
  /** 关闭写操作错误条。 */
  dismissMutationError(): void
  /** 提交对话框业务面（④-K；与 header 拉起方共享同一 apply 顶层闭包）。 */
  commitDialog: GitCommitDialogFace
}

/** tab body 组合 props（PropsRuntime ⊃ useTabInfo；PropsStore ⊃ useStore/actions）。 */
export type GitChangesTabProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ChangesTabStoreHandle>
  & InjectFace<ChangesInjected>
  & PropsLocale<typeof NS>

/** 展开行与其 diff 键（装配中间态）。 */
interface Selection {
  row: ChangeRow
  key: string
}

/** 单展开行的解析（含 diff 缓存键；view/revision 变化时自然重算）。 */
function selectionOf(view: ChangesViewModel, selectedPath: string | null, revision: number): Selection | undefined {
  if (selectedPath === null) return undefined
  const row = view.rowByPath.get(selectedPath)
  if (row === undefined) return undefined
  return { row, key: diffCacheKey(revision, row.path, row.scope) }
}

/** 一个变更组的目录树 + 卡片渲染（组内折叠键带组前缀防跨组串扰）。 */
function GroupSection(props: {
  viewModel: ChangesViewModel
  group: ChangesViewModel['groups'][number]
  expandedDirs: Record<string, boolean>
  selectedPath: string | null
  diffOf(path: string): ReactNode
  onToggleDir(path: string): void
  onSelect(path: string): void
  onCheck(row: ChangeRow): void
  onAction(row: ChangeRow, action: 'stage' | 'unstage' | 'discard'): void
  onRowKeyDown(row: ChangeRow, event: ReactKeyboardEvent): void
  t: GitChangesTabProps['t']
}): ReactNode {
  const { viewModel, group, expandedDirs, selectedPath, diffOf, onToggleDir, onSelect, onCheck, onAction, onRowKeyDown, t } = props
  const nodes = useMemo(() => groupPaths(group.rows.map((row) => row.path)), [group.rows])
  return (
    <section className='dsh-git-changes__group' data-git-changes-group={group.id}>
      <h3 className='dsh-git-changes__group-header' data-git-changes-group-header=''>
        <span className='dsh-git-changes__group-label' data-git-changes-group-label=''>{t(group.labelKey)}</span>
        <span className='dsh-git-changes__group-count' data-git-changes-group-count=''>{group.rows.length}</span>
      </h3>
      {nodes.map((node) => (
        <NodeRows
          key={node.kind === 'dir' ? node.path : node.path}
          node={node}
          depth={0}
          viewModel={viewModel}
          groupId={group.id}
          expandedDirs={expandedDirs}
          selectedPath={selectedPath}
          diffOf={diffOf}
          onToggleDir={onToggleDir}
          onSelect={onSelect}
          onCheck={onCheck}
          onAction={onAction}
          onRowKeyDown={onRowKeyDown}
          t={t}
        />
      ))}
    </section>
  )
}

/** 目录/文件节点递归渲染。 */
function NodeRows(props: {
  node: PathNode
  depth: number
  viewModel: ChangesViewModel
  groupId: string
  expandedDirs: Record<string, boolean>
  selectedPath: string | null
  diffOf(path: string): ReactNode
  onToggleDir(path: string): void
  onSelect(path: string): void
  onCheck(row: ChangeRow): void
  onAction(row: ChangeRow, action: 'stage' | 'unstage' | 'discard'): void
  onRowKeyDown(row: ChangeRow, event: ReactKeyboardEvent): void
  t: GitChangesTabProps['t']
}): ReactNode {
  const {
    node, depth, viewModel, groupId, expandedDirs, selectedPath,
    diffOf, onToggleDir, onSelect, onCheck, onAction, onRowKeyDown, t,
  } = props
  if (node.kind === 'dir') {
    const key = `${groupId}:${node.path}`
    const expanded = expandedDirs[key] ?? true
    return (
      <div className='dsh-git-changes__dir' data-git-changes-dir={node.path}>
        <button
          type='button'
          className='dsh-git-changes__dir-toggle'
          aria-expanded={expanded}
          data-git-changes-dir-toggle=''
          onClick={() => { onToggleDir(key) }}
        >
          <span className='dsh-git-changes__dir-name'>{node.name}</span>
        </button>
        {expanded && node.children.map((child) => (
          <NodeRows
            key={child.path}
            node={child}
            depth={depth + 1}
            viewModel={viewModel}
            groupId={groupId}
            expandedDirs={expandedDirs}
            selectedPath={selectedPath}
            diffOf={diffOf}
            onToggleDir={onToggleDir}
            onSelect={onSelect}
            onCheck={onCheck}
            onAction={onAction}
            onRowKeyDown={onRowKeyDown}
            t={t}
          />
        ))}
      </div>
    )
  }
  const row = viewModel.rowByPath.get(node.path)
  if (row === undefined) return null
  return (
    <ChangeCard
      key={node.path}
      row={row}
      checked={row.group === 'staged'}
      expanded={selectedPath === row.path}
      diffArea={selectedPath === row.path ? diffOf(row.path) : undefined}
      t={t}
      onToggleCheck={() => { onCheck(row) }}
      onToggleExpand={() => { onSelect(row.path) }}
      onStage={() => { onAction(row, 'stage') }}
      onUnstage={() => { onAction(row, 'unstage') }}
      onDiscard={() => { onAction(row, 'discard') }}
      onKeyDown={(event) => { onRowKeyDown(row, event) }}
    />
  )
}

/**
 * 变更审查 tab body（注册 key = 'dsh-plugin.git.changes'）。
 * @param props - 框架组合 props。
 */
export function GitChangesTab(props: GitChangesTabProps): ReactNode {
  const {
    useTabInfo, useStore, actions, useGitStatus, useGitChanges,
    loadDiff, stage, unstage, discard, refresh, dismissMutationError, commitDialog, t,
  } = props
  const { tab } = useTabInfo()
  const coordinates = useMemo(() => parseGitChangesAddress(tab.contentId), [tab.contentId])
  if (coordinates === undefined) {
    throw new Error(`dsh-plugin-git: not a git-changes address "${tab.contentId}"`)
  }
  const statusState = useGitStatus((state) => state)
  const changesState = useGitChanges((state) => state)
  const selectedPath = useStore((state) => state.selectedPath)
  const expandedDirs = useStore((state) => state.expandedDirs)
  const pendingConfirm = useStore((state) => state.pendingConfirm)
  const view = useMemo(() => changesViewModel(statusState), [statusState])
  const selection = useMemo(
    () => selectionOf(view, selectedPath, statusState.revision),
    [view, selectedPath, statusState.revision],
  )
  // 提交对话框的打开意图（④-K；null = 关，值 = defaultAction）。
  const [commitIntent, setCommitIntent] = useState<'commit' | 'commit-push' | null>(null)

  // 展开行从变更集消失（stage/discard/外部改动后）→ 收起展开位（ZCode GitPane
  // 同款守卫：expandedPath 不在列表即清）。
  useEffect(() => {
    if (selectedPath !== null && !view.rowByPath.has(selectedPath)) actions.select(null)
  }, [selectedPath, view, actions])

  // 展开行 diff 缓存缺席（首开 / revision 失效后）→ 懒加载（[清单 2/3]）。
  useEffect(() => {
    if (selection === undefined) return
    if (changesState.diffs[selection.key] === undefined) loadDiff(selection.row.scope, selection.row.path)
  }, [selection, changesState.diffs, loadDiff])

  const diffOf = (path: string): ReactNode => {
    const row = view.rowByPath.get(path)
    if (row === undefined || selection === undefined || selection.row.path !== path) return null
    const entry = changesState.diffs[selection.key]
    if (entry === undefined || entry.state === 'loading') {
      return <p className='dsh-git-changes__diff-status' role='status' data-git-change-diff-status='loading'>{t('diff.loading')}</p>
    }
    if (entry.state === 'error' && entry.error !== undefined) {
      return (
        <div className='dsh-git-changes__diff-error' data-git-change-diff-status='error'>
          <GitErrorNotice error={entry.error} t={t} />
          <button
            type='button'
            className='dsh-git-changes__diff-retry'
            data-git-change-diff-retry=''
            onClick={() => { loadDiff(row.scope, row.path) }}
          >
            {t('common.retry')}
          </button>
        </div>
      )
    }
    if (entry.file === undefined) {
      return <p className='dsh-git-changes__diff-status' data-git-change-diff-status='empty'>{t('diff.empty')}</p>
    }
    return <FileDiffView file={entry.file} t={t} />
  }

  const onCheck = (row: ChangeRow): void => {
    // 勾选 ⇄ stage/unstage（[清单 9]）：staged 组行取消勾选 = unstage；其余组勾选 = stage。
    if (row.group === 'staged') unstage([row.path])
    else stage([row.path])
  }
  const onAction = (row: ChangeRow, action: 'stage' | 'unstage' | 'discard'): void => {
    if (action === 'stage') stage([row.path])
    else if (action === 'unstage') unstage([row.path])
    else actions.requestDiscard([row.path])
  }

  /**
   * 行级快捷键（④-K ask §② 列表组：Space/Enter/Delete，aria-keyshortcuts 在
   * ChangeCard 行按钮上）：
   *   - **Space** = 切换该行暂存勾选（VS Code GitPane 同语义；勾选框自身的原生
   *     Space 让位——不拦截，避免双重切换）；
   *   - **Enter** = 行按钮的原生激活（展开/收起 diff——ChangeCard 主按钮）；
   *   - **Delete** = 请求丢弃该行（staged 行无 discard 动作 → 不响应）。
   */
  const onRowKeyDown = (row: ChangeRow, event: ReactKeyboardEvent): void => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.type === 'checkbox') return
    if (event.key === ' ') {
      event.preventDefault() // 阻断行按钮的 Space 原生激活（激活语义让位给暂存切换）
      onCheck(row)
      return
    }
    if (event.key === 'Delete' && row.actions.discard) {
      event.preventDefault()
      actions.requestDiscard([row.path])
    }
  }

  const mutationError = changesState.mutationError
  const pendingPaths = pendingConfirm?.paths ?? []
  const resolveDiscard = (ok: boolean): void => {
    actions.resolveConfirm(ok)
    if (ok) discard(pendingPaths)
  }

  return (
    <div className='dsh-git-changes' data-git-changes='' data-git-changes-session={coordinates.sessionId}>
      {view.unborn && (
        <p className='dsh-git-changes__unborn' data-git-changes-unborn=''>{t('changes.emptyRepo')}</p>
      )}
      {statusState.statusError !== null && (
        <GitErrorNotice
          error={statusState.statusError}
          t={t}
          onAction={(action) => { if (action === 'retry') refresh() }}
        />
      )}
      {mutationError !== null && (
        <div className='dsh-git-changes__mutation' data-git-changes-mutation-error={mutationError.kind}>
          <GitErrorNotice
            error={mutationError.error}
            t={t}
            onAction={(action) => {
              if (action !== 'retry') return
              if (mutationError.kind === 'stage') stage(mutationError.paths)
              else if (mutationError.kind === 'unstage') unstage(mutationError.paths)
              else discard(mutationError.paths)
            }}
          />
          {mutationError.kind === 'discard' && (
            <p className='dsh-git-changes__discard-hint' data-git-changes-discard-hint=''>{t('changes.discardConflict')}</p>
          )}
          <button
            type='button'
            className='dsh-git-changes__mutation-dismiss'
            data-git-changes-mutation-dismiss=''
            onClick={dismissMutationError}
          >
            {t('common.close')}
          </button>
        </div>
      )}
      {!view.available ? (
        <p className='dsh-git-changes__empty' data-git-changes-empty='no-repo'>{t('error.no-repository')}</p>
      ) : view.groups.length === 0 ? (
        <p className='dsh-git-changes__empty' data-git-changes-empty={view.checking ? 'checking' : 'clean'}>
          {view.checking ? t('header.checking') : t('changes.empty')}
        </p>
      ) : (
        <div className='dsh-git-changes__groups' data-git-changes-groups=''>
          {view.groups.map((group) => (
            <GroupSection
              key={group.id}
              viewModel={view}
              group={group}
              expandedDirs={expandedDirs}
              selectedPath={selectedPath}
              diffOf={diffOf}
              onToggleDir={(key) => { actions.toggleDir(key) }}
              onSelect={(path) => { actions.select(path === selectedPath ? null : path) }}
              onCheck={onCheck}
              onAction={onAction}
              onRowKeyDown={onRowKeyDown}
              t={t}
            />
          ))}
        </div>
      )}
      <footer className='dsh-git-changes__footer' data-git-changes-footer=''>
        <button
          type='button'
          className='dsh-git-changes__commit'
          data-git-changes-commit=''
          disabled={!view.available}
          onClick={() => { setCommitIntent('commit') }}
        >
          {t('menu.commit')}
        </button>
      </footer>
      <GitCommitDialog
        open={commitIntent !== null}
        defaultAction={commitIntent ?? 'commit'}
        snapshot={statusState.status}
        t={t}
        face={commitDialog}
        onDone={() => { setCommitIntent(null) }}
        onClose={() => { setCommitIntent(null) }}
      />
      <GitConfirmDialog
        open={pendingConfirm !== null}
        title={t('confirm.discard.title')}
        message={t('confirm.discard.message', { count: pendingPaths.length })}
        items={pendingPaths}
        severity='danger'
        confirmLabel={t('confirm.ok')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={() => { resolveDiscard(true) }}
        onCancel={() => { resolveDiscard(false) }}
      />
    </div>
  )
}
