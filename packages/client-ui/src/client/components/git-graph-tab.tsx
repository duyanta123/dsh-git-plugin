/**
 * dsh-gitkit-ui — GitGraphTab：提交图 tab body（本模块 ask §③/④；
 * spec §3.1/§3.3 [清单 31/32/33]，注册 key = 'dsh-plugin.git.graph'、定义侧
 * keepMounted: true——图重算昂贵，隐藏不卸载，map §3.3）。
 *
 * 结构：错误/加载/空态条（unborn ⇒ graph.noCommits [清单 64]；log/refs 错误 ⇒
 * GitErrorNotice + 重试，重试按来源路由——refsError ⇒ refreshRefs，否则 reload）→
 * @tanstack/react-virtual 行虚拟化列表（基线模块直接
 * import——map §3.7，不写 dsh.client.external；estimateSize = 行高 24，overscan 12
 * 照 ui-trajectory 生产参数）→ 选中提交的详情面板（commit-detail-panel，列表
 * 下半区固定高度滚动——虚拟行高恒定，不在行内展开；失败详情可重试，P2）。
 *
 * 分页（workflow ask §③）：滚动触发——可见范围末端进入 total-30 触发
 * `loadMore()`（single-writer 闸在 git-graph-store）；追加页后整表重跑布局
 * （computeGraphLayout 纯函数 useMemo），前缀行 lane 稳定（G2，lane-layout.ts）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitAdminFace } from '../admin-face.js'
import { timeTravelOptions } from '../admin-view-model.js'
import { computeGraphLayout } from '../graph/lane-layout.js'
import { bucketArrivals, GRAPH_ROW_HEIGHT, GraphLaneSvg } from '../graph/graph-svg.js'
import { detailViewModel, formatCommitDate, graphNoticeRetry, rowRefChips } from '../graph-view-model.js'
import { searchEmptyResult, searchFilterChips } from '../graph-search.js'
import { comparePanelView } from '../graph-compare.js'
// V2 批次四（[8]）：非 git 目录空态引导卡片的纯视图模型（plan §6.6）。
import { initEmptyStateView } from '../init-empty-state.js'
import { wipNodeViewModel } from '../wip-node.js'
import type { NS } from '../locales.js'
import type { InitResult } from 'dsh-gitkit/types'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import type { GitCompareState } from '../store/git-compare-store.js'
import type { GitGraphState } from '../store/git-graph-store.js'
import { GRAPH_LOAD_MORE_TAIL } from '../store/git-graph-store.js'
import type { GraphIntentState } from '../store/graph-intent-store.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import type { GraphTabStoreHandle } from '../store/graph-tab-store.js'
import { CommitDetailPanel } from './commit-detail-panel.js'
import { GitComparePanel } from './GitComparePanel.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'
import { GitTagCreateDialog } from './GitTagCreateDialog.js'

/** 插件投给 tab body 的业务面（inject 工厂产物；hooks 由渲染器合成 use* 选择器）。 */
export interface GraphInjected {
  hooks: {
    /** 提交图数据缓存（本模块 git-graph-store，root 作用域）。 */
    gitGraph: ObservableSnapshot<GitGraphState>
    /** 工作区状态源（④-D；unborn/无仓库空态判据 + WIP 节点数据源）。 */
    gitStatus: ObservableSnapshot<GitStatusSourceState>
    /** 跨槽位意图通道（V2 批次二：header 对比入口 / changes 文件历史 → 本 tab 模式）。 */
    gitIntent: ObservableSnapshot<GraphIntentState>
    /** 分支对比面板数据缓存（[36]；git-compare-store，root 作用域）。 */
    gitCompare: ObservableSnapshot<GitCompareState>
  }
  /** 追加一页（single-writer 闸在 store）。 */
  loadMore(): void
  /** 清窗重载（错误条 log/仓库级来源的重试动作）。 */
  reload(): void
  /** 重取 refs 快照（错误条 refs 来源的重试动作——P2 路由修复）。 */
  refreshRefs(): void
  /** 详情/文件 patch 懒加载（path=null 列表态；path 给定 patch 态）。 */
  showCommit(oid: string, path: string | null): void
  /** 管理面业务面（V2 批次一 tag chip 菜单；V2 批次二时间旅行/abort 消费半）。 */
  admin: GitAdminFace
  /** 打开变更面板（WIP 节点点击意图 [38]；会话域地址由 apply 半以 sessionId 铸造）。 */
  openChanges(): void
  /**
   * [8] 初始化动作（V2 批次四；apply 半以 changesOps.initRepository 闭包注入——
   * 图 tab 的空态引导卡片消费）。成功后状态帧由 host afterWrite 通知驱动
   * （workspace unresolved → resolved，流不断开——plan §6.3），无需手动刷新。
   */
  initRepository(): Promise<RemoteResult<InitResult>>
  /** 顶栏搜索过滤提交（[35]；store 半归一化 + 变化清窗重载）。 */
  setSearchFilter(query: string, author: string): void
  /** 单文件历史 path 模式开合（[60]；path=null 退出）。 */
  setHistoryPath(path: string | null): void
  /** 对比面板：打开（base 半）并拉取（[36]）。 */
  compareOpen(base: string): void
  /** 对比面板：关闭恢复全图。 */
  compareClose(): void
  /** 对比面板：错误重试。 */
  compareRetry(): void
  /** 消费跨槽位意图（intent store 清空——消费完成信号）。 */
  consumeIntent(): void
}

/** tab body 组合 props（PropsRuntime ⊃ useTabInfo；PropsStore ⊃ useStore/actions）。 */
export type GitGraphTabProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<GraphTabStoreHandle>
  & InjectFace<GraphInjected>
  & PropsLocale<typeof NS>

/**
 * 提交图 tab body（注册 key = 'dsh-plugin.git.graph'）。
 * @param props - 框架组合 props。
 */
export function GitGraphTab(props: GitGraphTabProps): ReactNode {
  const {
    t, useStore, actions, useGitGraph, useGitStatus, useGitIntent, useGitCompare,
    loadMore, reload, refreshRefs, showCommit, admin, openChanges, initRepository,
    setSearchFilter, setHistoryPath, compareOpen, compareClose, compareRetry, consumeIntent,
  } = props
  const graph = useGitGraph((state) => state)
  const status = useGitStatus((state) => state)
  const intent = useGitIntent((state) => state)
  const compareState = useGitCompare((state) => state)
  const selectedOid = useStore((state) => state.selectedOid)
  const detailPath = useStore((state) => state.detailPath)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // ── V2 批次一 tag chip 菜单（[30]）：删 tag 确认 / 在该提交打标签对话框 + 错误面 ──
  const [tagIntent, setTagIntent] = useState<string | null>(null)
  const [deleteTagAsk, setDeleteTagAsk] = useState<string | null>(null)
  const [tagBusy, setTagBusy] = useState(false)
  const [adminError, setAdminError] = useState<GitErrorLike | null>(null)
  // ── V2 批次四 [8]：初始化引导卡片的动作态（空态卡片渲染决策 = initEmptyStateView）──
  const [initRunning, setInitRunning] = useState(false)
  const [initError, setInitError] = useState<GitErrorLike | null>(null)
  // ── V2 批次二：顶栏搜索草稿（[35]）+ 时间旅行确认意图（[37]）──
  const [queryDraft, setQueryDraft] = useState('')
  const [authorDraft, setAuthorDraft] = useState('')
  const [travelAsk, setTravelAsk] = useState<{ kind: 'cherry-pick' | 'revert'; oid: string; shortOid: string; subject: string } | null>(null)
  const [travelBusy, setTravelBusy] = useState(false)

  const deleteTag = (name: string): void => {
    if (tagBusy) return
    setDeleteTagAsk(null)
    setTagBusy(true)
    void admin.tagDelete(name).then((result) => {
      setTagBusy(false)
      if (!result.ok) {
        setAdminError(result.error)
        return
      }
      refreshRefs() // refs 快照刷新 → 行 chips 重算
    })
  }

  // ── 跨槽位意图消费（V2 批次二 [36]/[60]）：compare → 对比面板；path → path 模式 ──
  useEffect(() => {
    const request = intent.request
    if (request === null) return
    if (request.kind === 'compare') compareOpen(request.base)
    else setHistoryPath(request.path)
    consumeIntent()
  }, [intent.request, compareOpen, setHistoryPath, consumeIntent])

  /** [37] 时间旅行确认后的执行半（acknowledged + baseRevision 组装在纯半 timeTravelOptions）。 */
  const runTravel = (kind: 'cherry-pick' | 'revert', oid: string): void => {
    if (headOid === null || travelBusy) return
    let task: Promise<{ ok: true; value: unknown } | { ok: false; error: GitErrorLike }>
    if (kind === 'cherry-pick') {
      const options = timeTravelOptions('cherry-pick', { oid, baseRevision: headOid })
      if (options === null) return
      task = admin.cherryPick(options)
    } else {
      const options = timeTravelOptions('revert', { oid, baseRevision: headOid })
      if (options === null) return
      task = admin.revert(options)
    }
    setTravelBusy(true)
    void task.then((result) => {
      setTravelBusy(false)
      if (!result.ok) setAdminError(result.error)
      else refreshRefs()
    })
  }

  // 整表重跑布局（追加页后 commits 引用变化 → 重算；G2 前缀稳定在 layout 内保证）。
  const layout = useMemo(() => computeGraphLayout({
    commits: graph.log.commits,
    headOid: graph.refs?.head.oid ?? null,
    refs: graph.refs?.refs ?? [],
  }), [graph.log.commits, graph.refs])
  const arrivals = useMemo(() => bucketArrivals(layout.rows), [layout])
  const commitByOid = useMemo(() => new Map(graph.log.commits.map((commit) => [commit.oid, commit])), [graph.log.commits])

  const virtualizer = useVirtualizer({
    count: layout.rows.length,
    estimateSize: () => GRAPH_ROW_HEIGHT,
    getScrollElement: () => scrollRef.current,
    overscan: 12,
  })

  // 滚动分页：可见末端进入 total-30 触发（ask §③）；store 侧 single-writer 去抖。
  const total = layout.rows.length
  const endIndex = virtualizer.range?.endIndex ?? -1
  const hasMore = graph.log.hasMore
  const inFlight = graph.log.loadMoreInFlight
  useEffect(() => {
    if (!hasMore || inFlight) return
    if (endIndex >= total - GRAPH_LOAD_MORE_TAIL) loadMore()
  }, [endIndex, total, hasMore, inFlight, loadMore])

  // HEAD chip 合并标签（rowRefChips/detailViewModel 共用）：branch 名 / detached 'HEAD' / unborn null。
  const head = graph.refs?.head
  const headLabel = head?.kind === 'branch' ? head.name : head?.kind === 'detached' ? 'HEAD' : null

  // ── V2 批次二模式判定：path 模式（[60]）与对比面板（[36]）替换首页全图视图 ──
  const pathMode = graph.filter.path !== null
  const compareMode = compareState.open
  const homeMode = !pathMode && !compareMode

  const unavailable = !status.repo.available && !status.repo.checking
  // 顶部错误条装配 + 重试路由（纯决策半在 graph-view-model.graphNoticeRetry）：
  // 优先序 log.error → 仓库级 statusError → refsError 与既有 `??` 链一致。
  const noticeRoute = graphNoticeRetry({
    logError: graph.log.error,
    statusError: unavailable ? status.statusError : null,
    refsError: graph.refsError,
  })
  const notice: GitErrorLike | null = noticeRoute.notice
  const loading = graph.log.refreshing && graph.log.commits.length === 0
  const empty = !loading && graph.log.commits.length === 0 && !unavailable
  // 过滤激活且窗口为空 ⇒ 顶栏空态换「没有匹配的提交」（[35] 纯决策半 graph-search）。
  const activeSearchFilter = graph.filter.query !== null || graph.filter.author !== null
    ? { query: graph.filter.query, author: graph.filter.author }
    : null
  const searchEmpty = searchEmptyResult({
    filter: activeSearchFilter,
    commitCount: graph.log.commits.length,
    loading: graph.log.refreshing,
  })
  const filterChips = searchFilterChips(activeSearchFilter)
  // WIP 未提交节点（[38]；纯 client 合成——clean/不可用/检查中 ⇒ null 不渲染）。
  const wip = wipNodeViewModel({
    available: status.repo.available,
    checking: status.repo.checking,
    status: status.status,
  })
  // [8] 空态引导卡片（恰 git/no-repository 可见——workspace-unresolved/检查中/可用
  // 态不渲染；判定口径见 init-empty-state.ts）。
  const initView = initEmptyStateView({
    available: status.repo.available,
    checking: status.repo.checking,
    statusError: status.statusError,
  })

  /** [8] 初始化动作：成功后状态帧由 host afterWrite 通知驱动（workspace
      unresolved → resolved，流不断开——plan §6.3）；失败 → 就地错误条。 */
  const runInit = (): void => {
    if (initRunning) return
    setInitRunning(true)
    setInitError(null)
    void initRepository().then((result) => {
      setInitRunning(false)
      if (!result.ok) setInitError(result.error)
    })
  }
  const selectedState = selectedOid !== null ? graph.details[selectedOid] : undefined
  // 时间旅行的乐观并发基线（discard 三重守卫同款）：当前 HEAD oid。
  const headOid = status.status?.branch.oid ?? null

  // 选中即拉详情（列表态）；store reset 后选择残留时同样补拉。
  // 刻意只在「槽缺席」时触发：error 槽存在时若也触发会失败循环（fetch→error→effect）；
  // error 槽的重试走详情面板的重试位（onRetry）与 reloadLog 清槽后的重选（store 半）。
  useEffect(() => {
    if (selectedOid !== null && graph.details[selectedOid] === undefined) showCommit(selectedOid, null)
  }, [selectedOid, graph.details, showCommit])

  /**
   * 图列表快捷键（④-K ask §② 图组：↑↓/Enter，aria-keyshortcuts 全组）：
   * ↑↓ = 移动选中行（虚拟滚动同步 scrollToIndex；无选中时从首行开始，边界钳制）；
   * Enter = 行按钮的原生激活（选中/收起详情——行是 button，见下方 aria-keyshortcuts）。
   */
  const onKeyDownList = (event: ReactKeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const rows = layout.rows
    if (rows.length === 0) return
    const currentIndex = selectedOid !== null ? rows.findIndex((row) => row.oid === selectedOid) : -1
    const nextIndex = currentIndex < 0
      ? 0
      : Math.min(rows.length - 1, Math.max(0, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)))
    const next = rows[nextIndex]
    if (next === undefined || next.oid === selectedOid) return
    actions.select(next.oid)
    virtualizer.scrollToIndex(nextIndex)
  }

  return (
    <div className='dsh-git-graph' data-git-graph-tab='' data-git-graph-rows={String(total)}>
      {notice !== null && (
        <div className='dsh-git-graph__notice'>
          <GitErrorNotice
            error={notice}
            t={t}
            onAction={() => {
              // 重试按来源路由（P2）：refsError ⇒ 只重取 refs（清窗重载修不好 refs
              // 故障，还白丢已加载窗口）；log/仓库级 ⇒ 清窗重载。
              if (noticeRoute.source === 'refs') refreshRefs()
              else reload()
            }}
          />
        </div>
      )}
      {/* [8] 空态引导卡片（plan §6.6：说明 + 初始化按钮——图 tab 的空态半；
          init 失败就地错误条，成功后状态帧驱动图 reload）。 */}
      {unavailable && initView !== null && (
        <div className='dsh-git-init-card' data-git-init-card=''>
          <p className='dsh-git-init-card__title' data-git-init-title=''>{t(initView.titleKey)}</p>
          <p className='dsh-git-init-card__body' data-git-init-body=''>{t(initView.bodyKey)}</p>
          {initError !== null && <GitErrorNotice error={initError} t={t} />}
          <button
            type='button'
            className='dsh-git-init-card__action'
            data-git-init-action=''
            disabled={initRunning}
            onClick={runInit}
          >
            {initRunning ? t(initView.runningKey) : t(initView.actionKey)}
          </button>
        </div>
      )}
      {adminError !== null && (
        <div className='dsh-git-graph__notice' data-git-graph-admin-notice=''>
          <GitErrorNotice
            error={adminError}
            t={t}
            // abort 动作（V2 批次二）：git/merge-conflict / git/operation-in-progress
            // 错误面板的「放弃操作」= abortOperation（幂等安全，plan §4.10）。
            onAction={(action) => {
              if (action === 'abort') {
                void admin.abortOperation().then((result) => {
                  if (!result.ok) setAdminError(result.error)
                  else refreshRefs()
                })
              }
            }}
          />
          <button
            type='button'
            className='dsh-git-graph__notice-dismiss'
            data-git-graph-admin-notice-close=''
            onClick={() => { setAdminError(null) }}
          >
            {t('common.close')}
          </button>
        </div>
      )}
      {/* ── 顶栏（V2 批次二）：path chip（[60]）⇄ 搜索框 + 过滤 chip（[35]）——
          对比面板模式不渲染顶栏（全图工具条与两列视图无关）── */}
      {homeMode && pathMode && (
        <div className='dsh-git-graph__pathbar' data-git-graph-pathbar=''>
          <span className='dsh-git-graph__path-chip' data-git-graph-path-chip=''>
            {t('graph.path.chip', { path: graph.filter.path ?? '' })}
          </span>
          <button
            type='button'
            className='dsh-git-graph__path-exit'
            data-git-graph-path-exit=''
            onClick={() => { setHistoryPath(null) }}
          >
            {t('graph.path.exit')}
          </button>
        </div>
      )}
      {homeMode && !pathMode && (
        <div className='dsh-git-graph__topbar' data-git-graph-topbar=''>
          <input
            type='text'
            className='dsh-git-graph__search'
            data-git-graph-search=''
            value={queryDraft}
            placeholder={t('graph.search.placeholder')}
            aria-label={t('graph.search.placeholder')}
            onChange={(event) => { setQueryDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearchFilter(queryDraft, authorDraft)
            }}
          />
          <input
            type='text'
            className='dsh-git-graph__search'
            data-git-graph-search-author=''
            value={authorDraft}
            placeholder={t('graph.search.authorPlaceholder')}
            aria-label={t('graph.search.authorPlaceholder')}
            title={t('graph.search.authorHint')}
            onChange={(event) => { setAuthorDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearchFilter(queryDraft, authorDraft)
            }}
          />
          {filterChips.length > 0 && (
            <span className='dsh-git-graph__chips' data-git-graph-chips=''>
              {filterChips.map((chip) => (
                <span key={chip.key} className='dsh-git-graph__chip' data-git-graph-chip={chip.key}>
                  {t(chip.key, chip.params)}
                </span>
              ))}
              <button
                type='button'
                className='dsh-git-graph__chip-clear'
                data-git-graph-chip-clear=''
                onClick={() => {
                  setQueryDraft('')
                  setAuthorDraft('')
                  setSearchFilter('', '')
                }}
              >
                {t('graph.search.clear')}
              </button>
            </span>
          )}
        </div>
      )}
      {/* WIP 未提交节点（[38]）：图首页顶部合成行（clean/不可用 ⇒ 不渲染）；
          点击 → 变更面板（会话域地址，openChanges 由 apply 半铸造）。 */}
      {homeMode && wip !== null && (
        <button
          type='button'
          className='dsh-git-graph__wip'
          data-git-graph-wip=''
          aria-label={t(wip.labelKey)}
          onClick={openChanges}
        >
          <span className='dsh-git-graph__wip-label' data-git-graph-wip-label=''>{t(wip.labelKey)}</span>
          <span className='dsh-git-graph__wip-counts' data-git-graph-wip-counts=''>
            {t(wip.countsKey, wip.params)}
          </span>
        </button>
      )}
      {loading && <p className='dsh-git-graph__status' data-git-graph-status='loading'>{t('graph.loading')}</p>}
      {empty && (
        <p className='dsh-git-graph__status' data-git-graph-status='empty'>
          {searchEmpty ? t('graph.search.emptyResult') : t('graph.noCommits')}
        </p>
      )}
      {graph.log.loadMoreInFlight && (
        <p className='dsh-git-graph__status' data-git-graph-status='more' aria-label={t('graph.loadMore')}>
          {t('graph.loadMore')}
        </p>
      )}
      {compareMode ? (
        <GitComparePanel
          view={compareState.result !== null ? comparePanelView(compareState.result) : null}
          pending={compareState.pending}
          error={compareState.error}
          t={t}
          onCommit={(oid) => {
            actions.select(oid)
            showCommit(oid, null)
          }}
          onRetry={compareRetry}
          onClose={() => {
            compareClose()
            actions.select(null)
          }}
        />
      ) : (
        <div
        className='dsh-git-graph__list'
        data-git-graph-list=''
        ref={scrollRef}
        onKeyDown={onKeyDownList}
        aria-keyshortcuts='ArrowDown ArrowUp'
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = layout.rows[item.index]!
            const commit = commitByOid.get(row.oid)
            const selected = selectedOid === row.oid
            return (
              <button
                key={row.oid}
                type='button'
                className={selected ? 'dsh-git-graph__row dsh-git-graph__row--selected' : 'dsh-git-graph__row'}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: GRAPH_ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
                data-git-graph-item={row.oid}
                data-git-graph-row-lane={row.lane}
                aria-keyshortcuts='Enter'
                onClick={() => {
                  if (selected) {
                    actions.select(null)
                    return
                  }
                  actions.select(row.oid)
                  // [60] path 模式行点击 = 该文件当版 patch（getCommitDetail({oid, path})
                  // 既有方法——plan §4.6）；select 先行（其 action 会清 detailPath），
                  // 再展开该 path 的 patch 位。
                  if (pathMode && graph.filter.path !== null) {
                    showCommit(row.oid, graph.filter.path)
                    actions.openDetailPath(graph.filter.path)
                  }
                }}
              >
                <GraphLaneSvg row={row} laneCount={layout.laneCount} arrivals={arrivals.get(row.row) ?? []} />
                {row.refs.length > 0 && (
                  <span className='dsh-git-graph__refs' data-git-graph-refs=''>
                    {rowRefChips(row, headLabel).map((label, index) => (
                      <span
                        key={`${label}-${index}`}
                        className={label.startsWith('HEAD') ? 'dsh-git-graph__ref dsh-git-graph__ref--head' : 'dsh-git-graph__ref'}
                        data-git-graph-ref={label}
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                )}
                <span className='dsh-git-graph__subject' data-git-graph-subject=''>
                  {commit?.subject ?? ''}
                </span>
                <span className='dsh-git-graph__meta' data-git-graph-meta=''>
                  {commit !== undefined ? `${commit.authorName} · ${formatCommitDate(commit.committedAt)}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      )}
      {selectedOid !== null && (
        <CommitDetailPanel
          oid={selectedOid}
          state={selectedState}
          view={detailViewModel({
            oid: selectedOid,
            detail: selectedState?.detail,
            // HEAD chip 仅在本提交 = HEAD 时合并（branch 名 / detached 'HEAD'）。
            headLabel: head !== undefined && head.oid === selectedOid
              ? (head.kind === 'branch' ? head.name ?? 'HEAD' : 'HEAD')
              : null,
            detailPath,
            fallbackSubject: commitByOid.get(selectedOid)?.subject ?? '',
          })}
          t={t}
          // 失败详情重试（P2）：对 error 槽重发列表态拉取（store 清槽重拉）。
          onRetry={() => { showCommit(selectedOid, null) }}
          // tag chip 菜单（V2 批次一 [30]）：删 tag → 确认；打标签 → 对话框。
          onTagDelete={(name) => { setDeleteTagAsk(name) }}
          onTagCreate={(oid) => { setTagIntent(oid) }}
          // [37] 提交行菜单（挂详情面板头部——落点注记见 CommitDetailPanelProps）：
          // baseRevision（当前 HEAD）缺席（detached/unborn）⇒ 不给回调（条件展开表达
          // 「不传」——exactOptionalPropertyTypes 不接受显式 undefined）。
          {...(headOid !== null
            ? {
                onCherryPick: (oid: string) => {
                  setTravelAsk({
                    kind: 'cherry-pick',
                    oid,
                    shortOid: oid.slice(0, 7),
                    subject: commitByOid.get(oid)?.subject ?? '',
                  })
                },
              }
            : {})}
          {...(headOid !== null
            ? {
                onRevert: (oid: string) => {
                  setTravelAsk({
                    kind: 'revert',
                    oid,
                    shortOid: oid.slice(0, 7),
                    subject: commitByOid.get(oid)?.subject ?? '',
                  })
                },
              }
            : {})}
          onFileClick={(path) => {
            if (detailPath === path) {
              actions.openDetailPath(null)
              return
            }
            actions.openDetailPath(path)
            showCommit(selectedOid, path)
          }}
          onClose={() => { actions.select(null) }}
        />
      )}
      {/* tag chip 菜单的两个落点（V2 批次一 [30]）：删除确认 + 打标签对话框。 */}
      <GitTagCreateDialog
        open={tagIntent !== null}
        t={t}
        face={admin}
        oid={tagIntent}
        targetLabel={(() => {
          if (tagIntent === null) return null
          const subject = commitByOid.get(tagIntent)?.subject ?? ''
          return subject === '' ? tagIntent.slice(0, 7) : `${tagIntent.slice(0, 7)} ${subject}`
        })()}
        onDone={() => {
          setTagIntent(null)
          refreshRefs()
        }}
        onClose={() => { setTagIntent(null) }}
      />
      <GitConfirmDialog
        open={deleteTagAsk !== null}
        title={t('tag.delete.title')}
        message={t('tag.delete.message', { name: deleteTagAsk ?? '' })}
        severity='normal'
        confirmLabel={t('tag.delete.title')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => { if (deleteTagAsk !== null) deleteTag(deleteTagAsk) }}
        onCancel={() => { setDeleteTagAsk(null) }}
      />
      {/* [37] cherry-pick / revert 确认（normal 档——确认即置 acknowledged；乐观并发
          基线 baseRevision 由 runTravel 组装；hard 档语义只有 reset，走 GitResetDialog）。 */}
      <GitConfirmDialog
        open={travelAsk !== null}
        title={travelAsk?.kind === 'revert' ? t('timeTravel.revert.title') : t('timeTravel.cherryPick.title')}
        message={travelAsk?.kind === 'revert'
          ? t('timeTravel.revert.message', { shortOid: travelAsk.shortOid, subject: travelAsk.subject })
          : t('timeTravel.cherryPick.message', { shortOid: travelAsk?.shortOid ?? '', subject: travelAsk?.subject ?? '' })}
        severity='normal'
        confirmLabel={t('confirm.ok')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => {
          if (travelAsk === null) return
          const { kind, oid } = travelAsk
          setTravelAsk(null)
          runTravel(kind, oid)
        }}
        onCancel={() => { setTravelAsk(null) }}
      />
    </div>
  )
}
