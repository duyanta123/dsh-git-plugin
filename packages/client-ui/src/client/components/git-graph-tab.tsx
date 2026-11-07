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

import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeGraphLayout } from '../graph/lane-layout.js'
import { bucketArrivals, GRAPH_ROW_HEIGHT, GraphLaneSvg } from '../graph/graph-svg.js'
import { detailViewModel, formatCommitDate, graphNoticeRetry, rowRefChips } from '../graph-view-model.js'
import type { NS } from '../locales.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { GitGraphState } from '../store/git-graph-store.js'
import { GRAPH_LOAD_MORE_TAIL } from '../store/git-graph-store.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import type { GraphTabStoreHandle } from '../store/graph-tab-store.js'
import { CommitDetailPanel } from './commit-detail-panel.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** 插件投给 tab body 的业务面（inject 工厂产物；hooks 由渲染器合成 use* 选择器）。 */
export interface GraphInjected {
  hooks: {
    /** 提交图数据缓存（本模块 git-graph-store，root 作用域）。 */
    gitGraph: ObservableSnapshot<GitGraphState>
    /** 工作区状态源（④-D；unborn/无仓库空态判据）。 */
    gitStatus: ObservableSnapshot<GitStatusSourceState>
  }
  /** 追加一页（single-writer 闸在 store）。 */
  loadMore(): void
  /** 清窗重载（错误条 log/仓库级来源的重试动作）。 */
  reload(): void
  /** 重取 refs 快照（错误条 refs 来源的重试动作——P2 路由修复）。 */
  refreshRefs(): void
  /** 详情/文件 patch 懒加载（path=null 列表态；path 给定 patch 态）。 */
  showCommit(oid: string, path: string | null): void
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
  const { t, useStore, actions, useGitGraph, useGitStatus, loadMore, reload, refreshRefs, showCommit } = props
  const graph = useGitGraph((state) => state)
  const status = useGitStatus((state) => state)
  const selectedOid = useStore((state) => state.selectedOid)
  const detailPath = useStore((state) => state.detailPath)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
  const selectedState = selectedOid !== null ? graph.details[selectedOid] : undefined

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
      {loading && <p className='dsh-git-graph__status' data-git-graph-status='loading'>{t('graph.loading')}</p>}
      {empty && <p className='dsh-git-graph__status' data-git-graph-status='empty'>{t('graph.noCommits')}</p>}
      {graph.log.loadMoreInFlight && (
        <p className='dsh-git-graph__status' data-git-graph-status='more' aria-label={t('graph.loadMore')}>
          {t('graph.loadMore')}
        </p>
      )}
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
                onClick={() => { actions.select(selected ? null : row.oid) }}
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
    </div>
  )
}
