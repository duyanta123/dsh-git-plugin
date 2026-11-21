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
 *
 * **V3 批次一（[13]；v3-implementation-plan §3.7）扩块**：变更 tab 顶部冲突条
 * （status.conflicted 非空**常驻**——不依赖错误路径；计数 + operation 徽标）→
 * GitConflictPanel（文件列表 code/kind 徽标 + ours/theirs + 手动标记 + 底部
 * 继续/放弃 danger 闸）。merge-conflict 错误面板（变更动作错误条 / stash 面板
 * op 错误条）追加「解决冲突…」入口 → 就地展开冲突面板。
 *
 * **V3 批次四（[39][40][41]；v3-implementation-plan §6.6）扩块**：① 会话改动时间线
 * 折叠区（GitCheckpointTimeline——stash 条与文件组之间，打开才拉 checkpointList；
 * 回合分组 + 文件 ± 计数 → 点击看 diff（checkpointDiff → FileDiffView 只读）→
 * 「恢复此回合」（GitConfirmDialog danger 勾选闸 + baseRevision 确认时刻捕获——
 * discard 三重守卫范式）；summary null 回合诚实 unavailable 文案 + 恢复禁用；
 * wire 不携带 turn reason（session-watch.ts:81-82）——无 reason 徽标，缺口如实登记）；
 * ② 文件卡片归因徽标（[40]——attributionGet 按 revision 拉取，agent/user/mixed/
 * unknown 四态，unknown tooltip 明示宿主重启前无记录）；③ 时间线区归因筛选
 * （filterChangesViewModel 过滤主文件列表；折叠区收起即复位 'all'）。
 *
 * **Phase 2·client（本轮拆分）**：主组件收敛为列表/展开/勾选主干（<400 行），
 * 四处自包含面拆为独立组件：① GitCrlfBar（CRLF 提示条——诊断拉取 + 折叠/关闭
 * 相位自包含）；② GitConflictBar（冲突条 + conflictList 摘要半自包含——面板开合
 * 相位仍在主干：status/mutation/stash 三处错误条「解决冲突…」入口要能从外面打开）；
 * ③ GitStashPanel（stash chip → 面板——七态相位机/三动作闸/drop danger 确认框
 * 自包含）；④ GitDiffArea（展开行 diff 装配区——diffOf 的组件半，分支序/锚面
 * 原样迁移；载荷组装 applyPatchSelection 留在主干）。data-* 锚面与词典键组逐字节
 * 不变；GroupSection/NodeRows 的 13 个钻透 props 已由 Phase 3·client 收尾合并为单一
 * TreeProps 对象透传（回调本体与闭包逐字保真，行为与 data-* 锚不变）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffFile } from 'dsh-gitkit/types'
import { parseGitChangesAddress } from '../addresses.js'
import type { ChangeRow, ChangesViewModel } from '../changes-view-model.js'
import { changesViewModel } from '../changes-view-model.js'
// V3 批次四（[40]）：归因徽标 + 按归因筛选（checkpoint-view 纯函数半）。
import { attributionBadgeView, attributionMap, filterChangesViewModel } from '../checkpoint-view.js'
import type { AttributionBadgeView, AttributionFilter } from '../checkpoint-view.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import type { GitCommitDialogFace } from '../commit-dialog-face.js'
import { assembleSelectedPatch, directionOfScope } from '../diff/patch-select.js'
import type { PathNode } from '../group-paths.js'
import { groupPaths } from '../group-paths.js'
// V2 批次四（[8]）：非 git 目录空态引导卡片的纯视图模型（plan §6.6）。
import { initEmptyStateView } from '../init-empty-state.js'
import type { NS } from '../locales.js'
import type { GitErrorLike } from '../remote/mount.js'
import { useAsyncAction } from '../hooks/useAsyncAction.js'
import type { GitCheckpointState } from '../store/checkpoint-store.js'
import type { GitBlameState } from '../store/git-blame-store.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import { diffCacheKey } from '../store/git-changes-store.js'
import type { GitChangesState } from '../store/git-changes-store.js'
import type { ChangesTabStoreHandle } from '../store/changes-tab-store.js'
import { ChangeCard } from './ChangeCard.js'
// Phase 2·client：展开行 diff 装配区（diffOf 的组件半——分支序/锚面原样迁移）。
import { GitDiffArea } from './GitDiffArea.js'
import { GitCheckpointTimeline } from './GitCheckpointTimeline.js'
import { GitCommitDialog } from './GitCommitDialog.js'
// Phase 2·client：冲突条 + conflictList 摘要半（[13]；面板开合相位仍在主干）。
import { GitConflictBar } from './GitConflictBar.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'
// V2 批次四（[8]）：非 git 目录空态引导卡片（图 tab 同款 JSX 的共享组件收口）。
import { GitInitCard } from './GitInitCard.js'
// V2 批次四（[61]）：子模块状态详情面板（submoduleStatus 列表——plan §6.6）。
import { GitSubmodulePanel } from './GitSubmodulePanel.js'
// Phase 2·client：stash 计数 chip + 面板（[14]——相位机/动作闸/drop 确认自包含）。
import { GitStashPanel } from './GitStashPanel.js'
// Phase 2·client：CRLF 提示条（[56]——诊断拉取与折叠/关闭相位自包含）。
import { GitCrlfBar } from './GitCrlfBar.js'

/** 插件投给 tab body 的业务面（inject 工厂产物；hooks 由渲染器合成 use* 选择器）。 */
export interface ChangesInjected {
  hooks: {
    /** 工作区状态源（④-D git-status-source）。 */
    gitStatus: ObservableSnapshot<GitStatusSourceState>
    /** 变更面板数据缓存（本模块 git-changes-store）。 */
    gitChanges: ObservableSnapshot<GitChangesState>
    /** blame 数据缓存（V2 批次二 [34]；D3=B -L 区间分片——git-blame-store）。 */
    gitBlame: ObservableSnapshot<GitBlameState>
    /** 检查点/归因数据缓存（V3 批次四 [39][40]——checkpoint-store，按需拉取范式）。 */
    gitCheckpoint: ObservableSnapshot<GitCheckpointState>
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
  /** 时间线按需拉取（折叠区打开且 store 相位 idle 时——V3 批次四 [39]）。 */
  checkpointEnsureTimeline(): void
  /** 归因拉取（仓库可用且 store 相位 idle 时——V3 批次四 [40]）。 */
  checkpointEnsureAttribution(): void
  /** 回合文件 diff 懒加载（checkpointDiff 槽位——V3 批次四 [41]；sessionId 随行 = wire 判别半，评审收口）。 */
  checkpointLoadDiff(seq: number, index: number, sessionId: string): void
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

// ── Phase 2·client：闸任务的载荷类型（泛型签名拆行别名——check-locale 的行级
// JSX 扫描会把「同一行内 `>`…`<` 相邻」误判成裸文本，AdminTask 同款规避；
// stash 三连的 StashTask 别名随拆分迁入 GitStashPanel）。 ──
type PatchDirection = ReturnType<typeof directionOfScope>

/** 单展开行的解析（含 diff 缓存键；view/revision 变化时自然重算）。 */
function selectionOf(view: ChangesViewModel, selectedPath: string | null, revision: number): Selection | undefined {
  if (selectedPath === null) return undefined
  const row = view.rowByPath.get(selectedPath)
  if (row === undefined) return undefined
  return { row, key: diffCacheKey(revision, row.path, row.scope) }
}

/**
 * 组树逐层透传的共用渲染面（Phase 3·client 收尾：原 GroupSection → NodeRows 的 13 个
 * 钻透 props 合并为单一对象——递归层只拆 node/depth/groupId，回调语义与各 prop 的
 * 形状逐一保真；对账由本文件编译面 + changes/diff 相关 spec 钉）。
 */
interface TreeProps {
  viewModel: ChangesViewModel
  expandedDirs: Record<string, boolean>
  selectedPath: string | null
  diffOf(path: string): ReactNode
  onToggleDir(path: string): void
  onSelect(path: string): void
  onCheck(row: ChangeRow): void
  onAction(row: ChangeRow, action: 'stage' | 'unstage' | 'discard'): void
  onRowKeyDown(row: ChangeRow, event: ReactKeyboardEvent): void
  onHistory(path: string): void
  /** 子模块详情动作（V2 批次四 [61]；submodule 文件的行内入口——GitSubmodulePanel 拉起）。 */
  onSubmoduleDetails(path: string): void
  /** 归因徽标查询（V3 批次四 [40]；数据未就绪/路径缺席 → undefined——徽标不渲染）。 */
  attributionOf(path: string): AttributionBadgeView | undefined
  t: GitChangesTabProps['t']
}

/** 一个变更组的目录树 + 卡片渲染（组内折叠键带组前缀防跨组串扰）。 */
function GroupSection(props: {
  tree: TreeProps
  group: ChangesViewModel['groups'][number]
}): ReactNode {
  const { tree, group } = props
  const { t } = tree
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
          groupId={group.id}
          tree={tree}
        />
      ))}
    </section>
  )
}

/** 目录/文件节点递归渲染。 */
function NodeRows(props: {
  node: PathNode
  depth: number
  groupId: string
  tree: TreeProps
}): ReactNode {
  const { node, depth, groupId, tree } = props
  const {
    viewModel, expandedDirs, selectedPath,
    diffOf, onToggleDir, onSelect, onCheck, onAction, onRowKeyDown, onHistory, onSubmoduleDetails, attributionOf, t,
  } = tree
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
            groupId={groupId}
            tree={tree}
          />
        ))}
      </div>
    )
  }
  const row = viewModel.rowByPath.get(node.path)
  if (row === undefined) return null
  // [40] 归因徽标（exactOptionalPropertyTypes：缺席用条件展开——ChangeCardProps 可选属性面）。
  const attribution = attributionOf(row.path)
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
      // [61] 仅 submodule 文件注入详情入口（exactOptionalPropertyTypes：缺席用
      // 条件展开而非显式 undefined——ChangeCardProps 的可选属性面）。
      {...(row.change.submodule ? { onSubmoduleDetails: (): void => { onSubmoduleDetails(row.path) } } : {})}
      {...(attribution !== undefined ? { attribution } : {})}
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
    useTabInfo, useStore, actions, useGitStatus, useGitChanges, useGitBlame, useGitCheckpoint,
    loadDiff, stage, unstage, discard, refresh, dismissMutationError, commitDialog,
    blameEnsure, blameEnsureRange, openFileHistory, changesOps, t,
    checkpointEnsureTimeline, checkpointEnsureAttribution, checkpointLoadDiff,
  } = props
  const { tab } = useTabInfo()
  const coordinates = useMemo(() => parseGitChangesAddress(tab.contentId), [tab.contentId])
  if (coordinates === undefined) {
    throw new Error(`dsh-plugin-git: not a git-changes address "${tab.contentId}"`)
  }
  const statusState = useGitStatus((state) => state)
  const changesState = useGitChanges((state) => state)
  const blameState = useGitBlame((state) => state)
  const checkpointState = useGitCheckpoint((state) => state)
  const selectedPath = useStore((state) => state.selectedPath)
  const expandedDirs = useStore((state) => state.expandedDirs)
  const pendingConfirm = useStore((state) => state.pendingConfirm)
  // ── V3 批次四（[39][40]）：时间线折叠区开合 + 归因筛选（声明先于下方的过滤 memo）──
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [attributionFilter, setAttributionFilter] = useState<AttributionFilter>('all')
  const view = useMemo(() => changesViewModel(statusState), [statusState])
  // [40] 归因映射（徽标查询 + 筛选数据源）与按归因过滤后的列表视图（'all' 原样返回
  // 同引用；组/行过滤后空组裁撤——selection/rowByPath 仍吃全量 view）。
  const attributionByPath = useMemo(
    () => attributionMap(checkpointState.attribution.entries),
    [checkpointState.attribution.entries],
  )
  const filteredView = useMemo(
    () => filterChangesViewModel(view, attributionByPath, attributionFilter),
    [view, attributionByPath, attributionFilter],
  )
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
  const [patchError, setPatchError] = useState<GitErrorLike | null>(null)
  // ── V2 批次四：[8] 初始化引导（动作/进行态/失败面）+ [61] 子模块详情面板开合 ──
  const [initError, setInitError] = useState<GitErrorLike | null>(null)
  const [submodulePanelPath, setSubmodulePanelPath] = useState<string | null>(null)
  // ── V3 批次一（[13]）：冲突面板开合相位（条/conflictList 摘要半自包含在
  // GitConflictBar——status/mutation/stash 三处错误条的「解决冲突…」入口要能从
  // 外面打开面板，故相位留在主干）。
  const [conflictOpen, setConflictOpen] = useState(false)

  // ── Phase 2·client：在途闸收敛到 useAsyncAction 的同步闸（createBusyGate——判定
  // 与置位原子同帧，先于任何 await；根治「读闭包 busy」的双击竞态：setState 写的
  // busy 同帧不生效而闸生效）。hunk 勾选应用闸留守主干；stash 三连/仓库初始化闸
  // 分别随拆分迁入 GitStashPanel / 留守下方。applyPatchSelection 的入参载荷
  // （点击时组装——patch/direction 依赖当轮 selection）。
  const patchTaskRef = useRef<{ path: string; patch: string; keys: readonly string[]; direction: PatchDirection } | null>(null)
  const patchAction = useAsyncAction<null>({
    run: async () => {
      const task = patchTaskRef.current!
      setSelectedLines((prev) => new Set([...prev, ...task.keys])) // 乐观勾选（闸已过）
      setPatchError(null)
      const result = await changesOps.stagePatch({ path: task.path, patch: task.patch, direction: task.direction })
      if (!result.ok) {
        setSelectedLines((prev) => new Set([...prev].filter((key) => !task.keys.includes(key))))
        setPatchError(result.error)
        return { ok: true, value: null }
      }
      refresh() // R5 manual（不等 R3 帧——changes-store mutate 同款乐观口径）
      return { ok: true, value: null }
    },
  })
  // patchBusy：原布尔在途态已由 patchAction 的同步闸承载（原守卫读闭包 patchBusy——
  // 同帧二次点击漏闸，闸修复；JSX 本无 patch busy 消费位，故不保留变量）。

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

  // 归因徽标数据（[40]）：仓库可用且 store 相位 idle（首装/revision 失效后的自动回落）
  // ⇒ 拉取一次（store 半去重；host 侧 status 快照 + 逐文件 mtime，tab 关闭不拉）。
  useEffect(() => {
    if (view.available && checkpointState.attribution.phase === 'idle') checkpointEnsureAttribution()
  }, [view.available, checkpointState.attribution.phase, checkpointEnsureAttribution])

  // 时间线折叠区收起 ⇒ 归因筛选复位 'all'（不可见的过滤不保留——筛选控件住在折叠区）。
  useEffect(() => {
    if (!timelineOpen) setAttributionFilter('all')
  }, [timelineOpen])

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
    if (current === undefined) return
    const selected = new Set<string>(keys)
    const patch = assembleSelectedPatch(file, selected)
    if (patch === null) return
    patchTaskRef.current = { path: current.row.path, patch, keys, direction: directionOfScope(current.row.scope) }
    void patchAction.trigger()
  }

  // 展开行 diff 装配区（Phase 2·client 拆分）：分支序/锚面原样迁入 GitDiffArea——
  // 本函数只保留守卫（非选中行不渲染）与回调接线（载荷组装仍在此闭包内）。
  const diffOf = (path: string): ReactNode => {
    const row = view.rowByPath.get(path)
    if (row === undefined || selection === undefined || selection.row.path !== path) return null
    return (
      <GitDiffArea
        path={path}
        entry={changesState.diffs[selection.key]}
        blameSlot={blameState.byPath[path]}
        blameMode={blameMode}
        selectedLines={selectedLines}
        patchError={patchError}
        onBlameMode={setBlameMode}
        onRetryDiff={() => { loadDiff(row.scope, row.path) }}
        onRetryBlame={() => { blameEnsure(path) }}
        onEnsureBlameRange={(start, end) => { blameEnsureRange(path, start, end) }}
        onApplySelection={applyPatchSelection}
        onDismissPatchError={() => { setPatchError(null) }}
        t={t}
      />
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
  // ── Phase 3·client 收尾：组树透传面收敛（原 13 个逐 prop 钻透合并为单一对象——
  // 回调本体与闭包逐字保真，仅打包位一处；GroupSection/NodeRows 递归只拆 node/depth）。
  const tree: TreeProps = {
    viewModel: view,
    expandedDirs,
    selectedPath,
    diffOf,
    onToggleDir: (key) => { actions.toggleDir(key) },
    onSelect: (path) => { actions.select(path === selectedPath ? null : path) },
    onCheck,
    onAction,
    onRowKeyDown,
    onHistory: openFileHistory,
    onSubmoduleDetails: (path) => { setSubmodulePanelPath(path) },
    attributionOf: (path) => attributionBadgeView(attributionByPath.get(path)) ?? undefined,
    t,
  }
  const pendingPaths = pendingConfirm?.paths ?? []
  const resolveDiscard = (ok: boolean): void => {
    actions.resolveConfirm(ok)
    if (ok) discard(pendingPaths)
  }

  // V3 批次一（[13]）：冲突条计数（常驻入口判据——条/摘要半在 GitConflictBar）。
  const conflictedCount = statusState.status?.conflicted.length ?? 0
  // V2 批次四（[8]）：非 git 目录空态引导卡片（恰 git/no-repository 可见——
  // workspace-unresolved/检查中/可用态不渲染；判定口径见 init-empty-state.ts）。
  const initView = initEmptyStateView({
    available: statusState.repo.available,
    checking: statusState.repo.checking,
    statusError: statusState.statusError,
  })

  /** [8] 初始化动作：成功 → refresh（workspace 从 unresolved → resolved，R5 manual
      取首帧——plan §6.3）；失败 → 就地错误条（git/init-failed 文案带 path/reason）。
      在途闸收敛到 useAsyncAction 同步闸（Phase 2·client）。 */
  const initAction = useAsyncAction<null>({
    run: async () => {
      setInitError(null)
      const result = await changesOps.initRepository()
      if (!result.ok) {
        setInitError(result.error)
        return { ok: true, value: null }
      }
      refresh()
      return { ok: true, value: null }
    },
  })
  const initRunning = initAction.busy
  const runInit = (): void => { void initAction.trigger() }

  return (
    <div className='dsh-git-changes' data-git-changes='' data-git-changes-session={coordinates.sessionId}>
      {view.unborn && (
        <p className='dsh-git-changes__unborn' data-git-changes-unborn=''>{t('changes.emptyRepo')}</p>
      )}
      {/* V3 批次一（[13]）冲突条：conflicted 非空常驻（不依赖错误路径）——计数 +
          operation 徽标 → 展开冲突面板（plan §3.7「常驻入口」）。条/摘要半自包含在
          GitConflictBar，面板开合相位留在主干（三处错误条「解决冲突…」入口）。 */}
      <GitConflictBar
        available={view.available}
        conflictedCount={conflictedCount}
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        ops={changesOps}
        refresh={refresh}
        t={t}
      />
      {statusState.statusError !== null && (
        <GitErrorNotice
          error={statusState.statusError}
          t={t}
          // resolve（V3 批次一）：merge-conflict 形态错误条的「解决冲突…」→ 就地展开
          // 冲突面板（plan §3.7；status 读错误不会是 merge-conflict——分支仅兜底）。
          onAction={(action) => {
            if (action === 'retry') refresh()
            else if (action === 'resolve') setConflictOpen(true)
          }}
        />
      )}
      {mutationError !== null && (
        <div className='dsh-git-changes__mutation' data-git-changes-mutation-error={mutationError.kind}>
          <GitErrorNotice
            error={mutationError.error}
            t={t}
            onAction={(action) => {
              if (action === 'resolve') { setConflictOpen(true); return }
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
      {/* CRLF 提示条（[56]）：autocrlf 生效值 + mixedEolFiles 摘要；可折叠，不阻断。
          数据拉取与折叠/关闭相位自包含在 GitCrlfBar。 */}
      <GitCrlfBar available={view.available} ops={changesOps} t={t} />
      {/* stash 计数 chip（[14]）→ 面板：列表 / 应用=pop / 删除=drop danger 闸 +
          「Stash 全部变更」（includeUntracked 缺省勾选 + untracked 计数提示，D4=B）。
          相位机/三动作闸/drop 确认框自包含在 GitStashPanel（组件半——本环境不可
          驱动，changes-ops-face.spec 文件头同证登记）。 */}
      <GitStashPanel
        available={view.available}
        clean={view.clean}
        status={statusState.status}
        ops={changesOps}
        refresh={refresh}
        onResolveConflict={() => { setConflictOpen(true) }}
        t={t}
      />
      {/* V3 批次四（[39][41]）会话改动时间线折叠区：打开才拉 checkpointList（不做
          常驻轮询——store 半 HostReadStore 范式）；内含归因筛选行（[40]——作用对象
          是下方文件卡片列表）。仓库不可用时不渲染（无会话事件面可言）。 */}
      {view.available && (
        <GitCheckpointTimeline
          open={timelineOpen}
          state={checkpointState}
          sessionId={coordinates.sessionId}
          baseRevision={statusState.status?.branch.oid ?? null}
          filter={attributionFilter}
          ops={changesOps}
          t={t}
          onToggle={() => { setTimelineOpen(!timelineOpen) }}
          onFilterChange={setAttributionFilter}
          ensureTimeline={checkpointEnsureTimeline}
          loadDiff={checkpointLoadDiff}
          onMutated={refresh}
        />
      )}
      {!view.available ? (
        initView !== null ? (
          // [8] 空态引导卡片（plan §6.6：说明 + 初始化按钮；init 失败就地错误条，
          // 成功 → refresh 走 R5 manual 取 init 后首帧）。共享组件 GitInitCard
          // （图 tab 同款 JSX 收口）。
          <GitInitCard initView={initView} initError={initError} initRunning={initRunning} runInit={runInit} t={t} />
        ) : (
          <p className='dsh-git-changes__empty' data-git-changes-empty='no-repo'>{t('error.no-repository')}</p>
        )
      ) : view.groups.length === 0 ? (
        <p className='dsh-git-changes__empty' data-git-changes-empty={view.checking ? 'checking' : 'clean'}>
          {view.checking ? t('header.checking') : t('changes.empty')}
        </p>
      ) : filteredView.groups.length === 0 ? (
        // [40] 归因筛选启用且无一命中（筛选控件在时间线折叠区——复位即可全量回来）。
        <p className='dsh-git-changes__empty' data-git-changes-empty='filtered'>{t('checkpoint.filter.empty')}</p>
      ) : (
        <div className='dsh-git-changes__groups' data-git-changes-groups=''>
          {filteredView.groups.map((group) => (
            <GroupSection
              key={group.id}
              tree={tree}
              group={group}
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
      {/* [61] 子模块状态详情面板（submodule 徽标行的「子模块详情」动作拉起；
          submoduleStatus 列表——path / oid 对照高亮 / state 徽标，只列不递归）。 */}
      <GitSubmodulePanel
        open={submodulePanelPath !== null}
        t={t}
        ops={changesOps}
        onClose={() => { setSubmodulePanelPath(null) }}
      />
    </div>
  )
}
