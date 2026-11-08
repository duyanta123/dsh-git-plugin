/**
 * dsh-gitkit-ui — GitComparePanel：分支对比面板（V2 批次二 [36]；plan §4.6
 * 「图 tab 内对比面板（ahead/behind 两列提交列表，行点击复用 commit-detail-panel）；
 * 关闭恢复全图」）。
 *
 * 数据半在 git-compare-store（root 作用域；compare 半 = 当前分支）；本组件只渲染
 * 视图模型（graph-compare.comparePanelView 的产物）+ 错误条/重试/关闭。行点击交给
 * GitGraphTab 的 onCommit（select + showCommit → 既有 CommitDetailPanel）。
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComparePanelView } from '../graph-compare.js'
import type { GitErrorLike } from '../remote/mount.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitComparePanelProps {
  /** 面板视图模型（comparePanelView；null = 结果未就绪）。 */
  view: ComparePanelView | null
  pending: boolean
  error: GitErrorLike | null
  t: TranslateNS<'git'>
  /** 行点击（tab 半：select(oid) + showCommit → 详情面板）。 */
  onCommit(oid: string): void
  /** 错误重试。 */
  onRetry(): void
  /** 关闭恢复全图。 */
  onClose(): void
}

/** 一列提交行（ahead / behind 同构）。 */
function CompareColumn(props: {
  kind: 'ahead' | 'behind'
  rows: ComparePanelView['ahead']
  count: number
  base: string
  emptyLabel: string
  headerLabel: string
  t: GitComparePanelProps['t']
  onCommit(oid: string): void
}): ReactNode {
  const { rows, count, base, emptyLabel, headerLabel, onCommit } = props
  return (
    <section className='dsh-git-compare__column' data-git-compare-column={props.kind}>
      <h4 className='dsh-git-compare__column-header' data-git-compare-column-header={props.kind}>
        {headerLabel}
        <span className='dsh-git-compare__column-count' data-git-compare-count={props.kind}>{count}</span>
      </h4>
      {rows.length === 0 ? (
        <p className='dsh-git-compare__empty'>{emptyLabel}</p>
      ) : (
        rows.map((row) => (
          <button
            key={row.oid}
            type='button'
            className='dsh-git-compare__row'
            data-git-compare-item={row.oid}
            title={`${row.shortOid} ${row.subject}`}
            onClick={() => { onCommit(row.oid) }}
          >
            <span className='dsh-git-compare__row-oid'>{row.shortOid}</span>
            <span className='dsh-git-compare__row-subject'>{row.subject}</span>
            <span className='dsh-git-compare__row-meta'>{row.author}{row.date === '' ? '' : ` · ${row.date}`}</span>
          </button>
        ))
      )}
      <span className='dsh-git-compare__column-base' data-git-compare-base={props.kind}>{base}</span>
    </section>
  )
}

/** 分支对比面板（图 tab 的替换视图；关闭恢复全图）。 */
export function GitComparePanel(props: GitComparePanelProps): ReactNode {
  const { view, pending, error, t, onCommit, onRetry, onClose } = props
  return (
    <div className='dsh-git-compare' data-git-compare=''>
      <header className='dsh-git-compare__header' data-git-compare-header=''>
        <p className='dsh-git-compare__title' data-git-compare-title=''>
          {view !== null
            ? t('graph.compare.title', { base: view.base, compare: view.compare })
            : ''}
        </p>
        {view?.mergeBase != null && (
          <span className='dsh-git-compare__merge-base' data-git-compare-merge-base=''>
            {t('graph.compare.mergeBase', { oid: view.mergeBase.slice(0, 7) })}
          </span>
        )}
        <button
          type='button'
          className='dsh-git-compare__close'
          data-git-compare-close=''
          onClick={onClose}
        >
          {t('graph.compare.close')}
        </button>
      </header>
      {error !== null && (
        <div className='dsh-git-compare__error' data-git-compare-error=''>
          <GitErrorNotice error={error} t={t} />
          <button
            type='button'
            className='dsh-git-compare__retry'
            data-git-compare-retry=''
            onClick={onRetry}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {pending && view === null && (
        <p className='dsh-git-compare__status' data-git-compare-status='pending'>{t('graph.compare.pending')}</p>
      )}
      {view !== null && (
        <div className='dsh-git-compare__columns' data-git-compare-columns=''>
          <CompareColumn
            kind='ahead'
            rows={view.ahead}
            count={view.aheadCount}
            base={view.base}
            emptyLabel={t('graph.compare.empty')}
            headerLabel={t('graph.compare.ahead', { base: view.base, count: view.aheadCount })}
            t={t}
            onCommit={onCommit}
          />
          <CompareColumn
            kind='behind'
            rows={view.behind}
            count={view.behindCount}
            base={view.base}
            emptyLabel={t('graph.compare.empty')}
            headerLabel={t('graph.compare.behind', { base: view.base, count: view.behindCount })}
            t={t}
            onCommit={onCommit}
          />
        </div>
      )}
    </div>
  )
}
