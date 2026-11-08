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
 *
 * **V2 批次三（plan §5.6）扩块**：① diff 区 hunk 头 + 行级勾选（[10]；D7=B 双侧
 * 同构——worktree 选中=stage、staged 选中=unstage 反向还原；勾选变化 →
 * diff/patch-select.ts 组装选中 patch → changesOps.stagePatch，失败就地显示并
 * 提示回落文件级 stage）；② CRLF 提示条（[56]；repoDiagnostics，可折叠不阻断）；
 * ③ stash 计数 chip → 面板（[14]；列表 / 应用=pop / 删除=drop danger 闸 /
 * 「Stash 全部变更」includeUntracked 缺省勾选 + untracked 计数提示，D4=B）。
 */

import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffFile, RepoDiagnostics, StashEntry } from 'dsh-gitkit/types'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseGitChangesAddress } from '../addresses.js'
import type { ChangeRow, ChangesViewModel } from '../changes-view-model.js'
import { changesViewModel, crlfBarView } from '../changes-view-model.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import type { GitCommitDialogFace } from '../commit-dialog-face.js'
import { assembleSelectedPatch, directionOfScope, hunkLineKeys } from '../diff/patch-select.js'
import { parsePatch } from '../diff/patch-hunks.js'
import type { PathNode } from '../group-paths.js'
import { groupPaths } from '../group-paths.js'
import type { NS } from '../locales.js'
import type { GitErrorLike } from '../remote/mount.js'
import {
  STASH_INCLUDE_UNTRACKED_DEFAULT, popConflictHint, stashChipView, stashDropConfirmView,
  stashPushDisabled, stashPushOptions, untrackedHint,
} from '../stash-view-model.js'
import type { GitBlameState } from '../store/git-blame-store.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import { diffCacheKey } from '../store/git-changes-store.js'
import type { GitChangesState } from '../store/git-changes-store.js'
import type { ChangesTabStoreHandle } from '../store/changes-tab-store.js'
import { ChangeCard } from './ChangeCard.js'
import { FileDiffView } from './FileDiffView.js'
import { GitBlameView } from './GitBlameView.js'
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
    /** blame 数据缓存（V2 批次二 [34]；D3=B -L 区间分片——git-blame-store）。 */
    gitBlame: ObservableSnapshot<GitBlameState>
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
  /** blame 首载（全区一次；V2 批次二 [34]）。 */
  blameEnsure(path: string): void
  /** blame 分片加载（-L start,end；D3=B 虚拟滚动联动；store 侧去重）。 */
  blameEnsureRange(path: string, start: number, end: number): void
  /** 文件历史动作（[60]；跨 tab 意图 → 图 tab path 模式 + openResource 打开图 tab）。 */
  openFileHistory(path: string): void
  /** 批次三动作面（[10] stagePatch / [14] stash / [56] repoDiagnostics——changes-ops-face）。 */
  changesOps: GitChangesOpsFace
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

/** 勾选集初始值（具名函数——check-locale 的行级 JSX 扫描会把「同一行内两个泛型 +
 *  `>`…`<` 相邻」误判成裸文本，初始化器提为函数规避）。 */
function emptyLineSet(): ReadonlySet<string> {
  return new Set<string>()
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
  onHistory(path: string): void
  t: GitChangesTabProps['t']
}): ReactNode {
  const { viewModel, group, expandedDirs, selectedPath, diffOf, onToggleDir, onSelect, onCheck, onAction, onRowKeyDown, onHistory, t } = props
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
          onHistory={onHistory}
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
  onHistory(path: string): void
  t: GitChangesTabProps['t']
}): ReactNode {
  const {
    node, depth, viewModel, groupId, expandedDirs, selectedPath,
    diffOf, onToggleDir, onSelect, onCheck, onAction, onRowKeyDown, onHistory, t,
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
            onHistory={onHistory}
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
      onHistory={() => { onHistory(row.path) }}
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
    useTabInfo, useStore, actions, useGitStatus, useGitChanges, useGitBlame,
    loadDiff, stage, unstage, discard, refresh, dismissMutationError, commitDialog,
    blameEnsure, blameEnsureRange, openFileHistory, changesOps, t,
  } = props
  const { tab } = useTabInfo()
  const coordinates = useMemo(() => parseGitChangesAddress(tab.contentId), [tab.contentId])
  if (coordinates === undefined) {
    throw new Error(`dsh-plugin-git: not a git-changes address "${tab.contentId}"`)
  }
  const statusState = useGitStatus((state) => state)
  const changesState = useGitChanges((state) => state)
  const blameState = useGitBlame((state) => state)
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
  // ── blame 模式（V2 批次二 [34]）：展开行的 diff 区模式切换（diff | blame）──
  const [blameMode, setBlameMode] = useState(false)
  // ── hunk/行级勾选（V2 批次三 [10]；D7=B 双侧）：乐观勾选集 + 在途闸 + 就地错误 ──
  const [selectedLines, setSelectedLines] = useState<ReadonlySet<string>>(emptyLineSet)
  const [patchBusy, setPatchBusy] = useState(false)
  const [patchError, setPatchError] = useState<GitErrorLike | null>(null)
  // ── CRLF 提示条（V2 批次三 [56]）：诊断数据 + 折叠态 ──
  const [diagnostics, setDiagnostics] = useState<RepoDiagnostics | null>(null)
  const [crlfDismissed, setCrlfDismissed] = useState(false)
  const [crlfExpanded, setCrlfExpanded] = useState(false)
  // ── stash 面板（V2 批次三 [14]）：chip/面板/列表/动作态（D4=B includeUntracked 缺省勾选）──
  const [stashOpen, setStashOpen] = useState(false)
  const [stashPhase, setStashPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [stashEntries, setStashEntries] = useState<StashEntry[]>([])
  const [stashError, setStashError] = useState<GitErrorLike | null>(null)
  const [stashOpError, setStashOpError] = useState<GitErrorLike | null>(null)
  const [stashBusy, setStashBusy] = useState(false)
  const [includeUntracked, setIncludeUntracked] = useState(STASH_INCLUDE_UNTRACKED_DEFAULT)
  const [pendingDrop, setPendingDrop] = useState<StashEntry | null>(null)

  // blame 模式开着且展开行槽位缺席 ⇒ 首载（全区一次；oversized 转 D3=B 分片模式）。
  useEffect(() => {
    if (!blameMode || selectedPath === null) return
    if (blameState.byPath[selectedPath] === undefined) blameEnsure(selectedPath)
  }, [blameMode, selectedPath, blameState.byPath, blameEnsure])

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

  // hunk/行级勾选（[10]）：展开行/revision 变化 → 乐观勾选集与就地错误作废
  // （stagePatch 成功后 refresh → revision 递增 → 新 diff 的勾选态重新开始）。
  useEffect(() => {
    setSelectedLines(new Set<string>())
    setPatchError(null)
  }, [selectedPath, statusState.revision])

  // CRLF 提示条（[56]）：仓库可用时取一次行尾诊断（只读、可折叠、不阻断）。
  useEffect(() => {
    if (!view.available) return
    let cancelled = false
    void changesOps.repoDiagnostics().then((result) => {
      if (!cancelled) setDiagnostics(result.ok ? result.value : null)
    })
    return () => { cancelled = true }
  }, [view.available, changesOps])

  /**
   * 勾选变化 → 组装选中 patch → stagePatch（plan §5.6 数据流的组件半）：
   * worktree 选中 = direction 'stage'、staged 选中 = 'unstage' 反向还原（D7=B，
   * directionOfScope）。每次勾选立即应用（勾选即动作——hunk 头勾选 = 整 hunk）；
   * 成功 → refresh（R5 manual，不等 R3 帧——changes-store mutate 同款乐观口径）；
   * 失败 → 乐观勾选回退 + 就地 GitErrorNotice（stage-patch-failed 文案自带
   * 「回落文件级 stage」指引，plan §5.10）。
   */
  const applyPatchSelection = (file: DiffFile, keys: readonly string[]): void => {
    const current = selection
    if (current === undefined || patchBusy) return
    const selected = new Set<string>(keys)
    const patch = assembleSelectedPatch(file, selected)
    if (patch === null) return
    setPatchBusy(true)
    setPatchError(null)
    setSelectedLines((prev) => new Set([...prev, ...keys]))
    void changesOps.stagePatch({
      path: current.row.path,
      patch,
      direction: directionOfScope(current.row.scope),
    }).then((result) => {
      setPatchBusy(false)
      if (result.ok) {
        refresh()
        return
      }
      setSelectedLines((prev) => new Set([...prev].filter((key) => !keys.includes(key))))
      setPatchError(result.error)
    })
  }

  const diffOf = (path: string): ReactNode => {
    const row = view.rowByPath.get(path)
    if (row === undefined || selection === undefined || selection.row.path !== path) return null
    // ── blame 模式切换条（V2 批次二 [34]）：diff | blame 两态（aria-pressed）──
    const modeBar = (
      <div className='dsh-git-changes__diff-modes' data-git-change-diff-modes=''>
        <button
          type='button'
          className='dsh-git-changes__diff-mode'
          aria-pressed={!blameMode}
          onClick={() => { setBlameMode(false) }}
        >
          {t('changes.diffMode')}
        </button>
        <button
          type='button'
          className='dsh-git-changes__diff-mode'
          aria-pressed={blameMode}
          data-git-change-blame-toggle=''
          onClick={() => { setBlameMode(true) }}
        >
          {t('changes.blameMode')}
        </button>
      </div>
    )
    if (blameMode) {
      const slot = blameState.byPath[path]
      return (
        <>
          {modeBar}
          {slot !== undefined ? (
            <GitBlameView
              path={path}
              slot={slot}
              t={t}
              onEnsureRange={(start, end) => { blameEnsureRange(path, start, end) }}
              onRetry={() => { blameEnsure(path) }}
            />
          ) : (
            <p className='dsh-git-changes__diff-status' role='status' data-git-change-diff-status='loading'>{t('blame.loading')}</p>
          )}
        </>
      )
    }
    const entry = changesState.diffs[selection.key]
    if (entry === undefined || entry.state === 'loading') {
      return (
        <>
          {modeBar}
          <p className='dsh-git-changes__diff-status' role='status' data-git-change-diff-status='loading'>{t('diff.loading')}</p>
        </>
      )
    }
    if (entry.state === 'error' && entry.error !== undefined) {
      return (
        <>
          {modeBar}
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
        </>
      )
    }
    if (entry.file === undefined) {
      return (
        <>
          {modeBar}
          <p className='dsh-git-changes__diff-status' data-git-change-diff-status='empty'>{t('diff.empty')}</p>
        </>
      )
    }
    const file = entry.file // 收窄进局部 const（闭包内属性收窄不保留）
    return (
      <>
        {modeBar}
        {/* hunk/行级勾选（[10]；D7=B 双侧同构）：worktree 侧勾选=stage、staged 侧
            勾选=unstage 反向——direction 由 directionOfScope(row.scope) 折算。 */}
        <FileDiffView
          file={file}
          t={t}
          selection={{
            selected: selectedLines,
            onToggleLine: (key) => { applyPatchSelection(file, [key]) },
            onToggleHunk: (hunkIndex) => {
              const hunk = parsePatch(file.patch ?? '')[hunkIndex]
              if (hunk === undefined) return
              applyPatchSelection(file, hunkLineKeys(hunk))
            },
          }}
        />
        {patchError !== null && (
          <div className='dsh-git-changes__patch-error' data-git-change-patch-error=''>
            <GitErrorNotice error={patchError} t={t} />
            <button
              type='button'
              className='dsh-git-changes__patch-error-dismiss'
              data-git-change-patch-error-dismiss=''
              onClick={() => { setPatchError(null) }}
            >
              {t('common.close')}
            </button>
          </div>
        )}
      </>
    )
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

  // ── stash 面板（[14]）：懒加载 + push/pop/drop 三动作（成功 → refresh + 重读清单）──
  const reloadStash = (): void => {
    setStashPhase('loading')
    setStashError(null)
    void changesOps.stashList().then((result) => {
      if (result.ok) {
        setStashEntries(result.value.stashes)
        setStashPhase('ready')
      } else {
        setStashError(result.error)
        setStashPhase('error')
      }
    })
  }
  const toggleStashPanel = (): void => {
    const next = !stashOpen
    setStashOpen(next)
    if (next && stashPhase !== 'ready') reloadStash() // 面板首开懒加载
  }
  const runStashPush = (): void => {
    setStashBusy(true)
    setStashOpError(null)
    // D4=B：includeUntracked 显式过 wire（缺省 true——STASH_INCLUDE_UNTRACKED_DEFAULT
    // 初始化勾选态）；baseRevision = 乐观并发基线（discard 范式的可选沿用，plan §5.2）。
    void changesOps.stashPush(stashPushOptions(includeUntracked, statusState.status?.branch.oid ?? null))
      .then((result) => {
        setStashBusy(false)
        if (!result.ok) {
          setStashOpError(result.error)
          return
        }
        refresh()
        reloadStash()
      })
  }
  const runStashPop = (entry: StashEntry): void => {
    setStashBusy(true)
    setStashOpError(null)
    void changesOps.stashPop({ index: entry.index }).then((result) => {
      setStashBusy(false)
      if (!result.ok) {
        // git/merge-conflict（op 'stash-pop'）⇒ 面板明示「stash 保留未丢失」（plan §5.10）。
        setStashOpError(result.error)
        return
      }
      refresh()
      reloadStash()
    })
  }
  const runStashDrop = (): void => {
    const entry = pendingDrop
    setPendingDrop(null)
    if (entry === null) return
    setStashBusy(true)
    setStashOpError(null)
    // acknowledged = 本调用契约「UI 已过 C5 danger 勾选闸」（changes-ops-face 同纪律）。
    void changesOps.stashDrop({ index: entry.index, acknowledged: true }).then((result) => {
      setStashBusy(false)
      if (!result.ok) {
        setStashOpError(result.error)
        return
      }
      refresh()
      reloadStash()
    })
  }

  const crlf = crlfBarView(diagnostics)
  const stashChip = stashChipView(stashPhase === 'ready' ? stashEntries.length : null)
  const untrackedHintView = untrackedHint(statusState.status)
  const popConflictVisible = popConflictHint(stashOpError)
  const pendingDropView = pendingDrop !== null ? stashDropConfirmView(pendingDrop) : null

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
      {/* CRLF 提示条（[56]）：autocrlf 生效值 + mixedEolFiles 摘要；可折叠，不阻断。 */}
      {crlf.visible && !crlfDismissed && (
        <div className='dsh-git-changes__crlf' data-git-changes-crlf=''>
          <span className='dsh-git-changes__crlf-title' data-git-changes-crlf-title=''>{t('changes.crlf.title')}</span>
          <span className='dsh-git-changes__crlf-summary' data-git-changes-crlf-summary=''>
            {t('changes.crlf.summary', { value: crlf.unset ? t('changes.crlf.unset') : crlf.value, count: crlf.mixedCount })}
          </span>
          <button
            type='button'
            className='dsh-git-changes__crlf-toggle'
            data-git-changes-crlf-toggle=''
            aria-expanded={crlfExpanded}
            onClick={() => { setCrlfExpanded(!crlfExpanded) }}
          >
            {t('common.details')}
          </button>
          <button
            type='button'
            className='dsh-git-changes__crlf-dismiss'
            data-git-changes-crlf-dismiss=''
            onClick={() => { setCrlfDismissed(true) }}
          >
            {t('common.close')}
          </button>
          {crlfExpanded && (
            <p className='dsh-git-changes__crlf-files' data-git-changes-crlf-files=''>
              {t('changes.crlf.files', { files: crlf.mixedFiles.length > 0 ? crlf.mixedFiles.join(', ') : '—' })}
            </p>
          )}
        </div>
      )}
      {/* stash 计数 chip（[14]）→ 面板：列表 / 应用=pop / 删除=drop danger 闸 +
          「Stash 全部变更」（includeUntracked 缺省勾选 + untracked 计数提示，D4=B）。 */}
      {view.available && (
        <div className='dsh-git-changes__stashbar' data-git-changes-stashbar=''>
          <button
            type='button'
            className='dsh-git-changes__stash-chip'
            data-git-changes-stash-chip=''
            aria-expanded={stashOpen}
            onClick={toggleStashPanel}
          >
            {t(stashChip.labelKey, stashChip.params)}
          </button>
        </div>
      )}
      {view.available && stashOpen && (
        <div className='dsh-git-changes__stash-panel' data-git-changes-stash-panel=''>
          <h3 className='dsh-git-changes__stash-title' data-git-changes-stash-title=''>{t('stash.panelTitle')}</h3>
          {stashPhase === 'loading' && (
            <p className='dsh-git-changes__stash-status' role='status' data-git-changes-stash-status='loading'>{t('stash.loading')}</p>
          )}
          {stashError !== null && (
            <GitErrorNotice error={stashError} t={t} onAction={(action) => { if (action === 'retry') reloadStash() }} />
          )}
          {stashPhase === 'ready' && stashEntries.length === 0 && (
            <p className='dsh-git-changes__stash-status' data-git-changes-stash-status='empty'>{t('stash.empty')}</p>
          )}
          {stashEntries.length > 0 && (
            <ul className='dsh-git-changes__stash-list' data-git-changes-stash-list=''>
              {stashEntries.map((entry) => (
                <li key={entry.index} className='dsh-git-changes__stash-item' data-git-changes-stash-item={entry.index}>
                  <span className='dsh-git-changes__stash-message'>{entry.message}</span>
                  <span className='dsh-git-changes__stash-oid'>{entry.shortOid}</span>
                  <button
                    type='button'
                    className='dsh-git-changes__stash-action'
                    data-git-changes-stash-pop=''
                    disabled={stashBusy}
                    onClick={() => { runStashPop(entry) }}
                  >
                    {t('stash.pop')}
                  </button>
                  <button
                    type='button'
                    className='dsh-git-changes__stash-action'
                    data-git-changes-stash-drop=''
                    disabled={stashBusy}
                    onClick={() => { setPendingDrop(entry) }}
                  >
                    {t('stash.drop')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {popConflictVisible && (
            <p className='dsh-git-changes__stash-conflict' data-git-changes-stash-popconflict=''>{t('stash.popConflict')}</p>
          )}
          {stashOpError !== null && <GitErrorNotice error={stashOpError} t={t} />}
          <div className='dsh-git-changes__stash-push' data-git-changes-stash-push=''>
            <button
              type='button'
              className='dsh-git-changes__stash-push-button'
              data-git-changes-stash-push-button=''
              disabled={stashPushDisabled(view.available, view.clean, stashBusy)}
              onClick={runStashPush}
            >
              {t('stash.pushAll')}
            </button>
            <Checkbox
              className='dsh-git-changes__stash-untracked'
              checked={includeUntracked}
              label={t('stash.pushAllIncludeUntracked')}
              onChange={setIncludeUntracked}
            />
            {untrackedHintView.visible && (
              <p className='dsh-git-changes__stash-hint' data-git-changes-stash-untracked-hint=''>
                {t('stash.untrackedHint', { count: untrackedHintView.count })}
              </p>
            )}
          </div>
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
              onHistory={openFileHistory}
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
      {/* stash drop 的 danger 确认（[14]；severity danger ⇒ GitConfirmDialog 勾选闸生效，
          纯载荷模型 = stash-view-model.stashDropConfirmView） */}
      <GitConfirmDialog
        open={pendingDropView !== null}
        title={t('stash.drop.title')}
        message={pendingDropView !== null
          ? t('stash.drop.message', { index: pendingDropView.params.index, message: pendingDropView.params.message })
          : ''}
        severity={pendingDropView?.severity ?? 'danger'}
        confirmLabel={t('stash.drop')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={runStashDrop}
        onCancel={() => { setPendingDrop(null) }}
      />
    </div>
  )
}
