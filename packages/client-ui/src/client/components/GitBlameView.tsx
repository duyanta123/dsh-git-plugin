/**
 * dsh-gitkit-ui — GitBlameView：blame 模式的 gutter 注记视图（V2 批次二 [34]；
 * D3=B -L 区间分片；plan §4.6）。
 *
 * wire 的 BlameResult 只携带区间归属（无行文本）——本视图渲染**行号 gutter 注记
 * 列表**：逐行一条（虚拟化，@tanstack/react-virtual 基线模块直接 import——map §3.7），
 * 注记（短 oid + 作者 + 相对时间）只在 run 首行渲染（blame-view.blameGutterRows 的
 * 折叠纯半；同 range 合并显示）。
 *
 * **大文件分片（D3=B）**：全区超限（git/blame-oversized）⇒ store 槽位转分片模式；
 * 本视图按虚拟滚动可视窗口（± BLAME_WINDOW_MARGIN 余量）以 blameSlicePlan 规划缺口
 * 并经 onEnsureRange 增量加载（store 侧覆盖簿记 + 区间级在途簿记去重）。占位终点只剩
 * 「无法分片」的兜底形态（oversizeSignaled=false 且错误码为 blame-oversized —— 镜像
 * diff.oversized 占位形态 FileDiffView.tsx:54）。**分支判定收敛在 blame-view.
 * blameViewStatus 纯函数**（tests/blame-view.spec 钉住）——不变式：分片模式永不落
 * blame.empty（首片前的零行/缺行数态按加载中处理，评审修复）。
 */

import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { blameGutterRows, blameSlicePlan, blameViewStatus, BLAME_PER_CALL_CAP, relativeTime } from '../blame-view.js'
import type { BlameSlotState } from '../store/git-blame-store.js'
import { formatCommitDate } from '../graph-view-model.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** 视图滚动区高度（变更面板展开区内嵌——固定高度滚动，详情面板同思路）。 */
const BLAME_VIEW_HEIGHT = 240

export interface GitBlameViewProps {
  /** blame 的文件路径（store 槽位键）。 */
  path: string
  /** 该 path 的槽位（git-blame-store.byPath[path]）。 */
  slot: BlameSlotState
  t: TranslateNS<'git'>
  /** 分片加载一段（-L start,end；store 侧去重——重复调用安全）。 */
  onEnsureRange(start: number, end: number): void
  /** 整槽重试（error 态的重试位）。 */
  onRetry(): void
}

/** blame gutter 注记视图（行号 + 折叠注记；虚拟滚动联动分片加载）。 */
export function GitBlameView(props: GitBlameViewProps): ReactNode {
  const { slot, t, onEnsureRange, onRetry } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => blameGutterRows(slot.runs, slot.lineCount), [slot.runs, slot.lineCount])
  const maxLines = slot.maxLines > 0 ? slot.maxLines : BLAME_PER_CALL_CAP
  const relativeNow = Date.now()

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 20,
    getScrollElement: () => scrollRef.current,
    overscan: 12,
  })

  const oversizedMode = slot.oversized
  const visibleStart = virtualizer.range?.startIndex ?? -1
  const visibleEnd = virtualizer.range?.endIndex ?? -1

  // 虚拟滚动联动（D3=B）：可视窗口（rows 下标 0-based → 行号 1-based）的缺口分片。
  // 规划半过滤已覆盖/在途（store 侧再兜底去重）——effect 重入安全。
  useEffect(() => {
    if (!oversizedMode || visibleStart < 0 || visibleEnd < 0) return
    const slices = blameSlicePlan({
      lineCount: slot.lineCount,
      loaded: slot.loaded,
      window: { start: visibleStart + 1, end: visibleEnd + 1 },
      maxLines,
    })
    for (const slice of slices) onEnsureRange(slice.start, slice.end)
  }, [oversizedMode, visibleStart, visibleEnd, slot.lineCount, slot.loaded, maxLines, onEnsureRange])

  // 分支纯决策（blame-view.blameViewStatus；tests/blame-view.spec 钉子）——
  // D3=B 不变式：分片模式永不落 'empty'（零行 = 首片在途，渲染 blame.loading）。
  const status = blameViewStatus(slot, rows.length)

  return (
    <div className='dsh-git-blame' data-git-blame='' data-git-blame-path={props.path}>
      {status === 'loading' && (
        <p className='dsh-git-blame__status' data-git-blame-status='loading'>{t('blame.loading')}</p>
      )}
      {status === 'oversized-fallback' && (
        <p className='dsh-git-blame__status' data-git-blame-status='oversized'>{t('blame.oversizedFallback')}</p>
      )}
      {status === 'error' && slot.error !== null && (
        <div className='dsh-git-blame__error' data-git-blame-error=''>
          <GitErrorNotice error={slot.error} t={t} />
          <button
            type='button'
            className='dsh-git-blame__retry'
            data-git-blame-retry=''
            onClick={onRetry}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {status === 'empty' && (
        <p className='dsh-git-blame__status' data-git-blame-status='empty'>{t('blame.empty')}</p>
      )}
      {status === 'list' && (
        <>
          {oversizedMode && (
            <p className='dsh-git-blame__hint' data-git-blame-chunk-hint=''>{t('blame.chunkHint')}</p>
          )}
          <div
            className='dsh-git-blame__list'
            data-git-blame-list=''
            ref={scrollRef}
            style={{ height: BLAME_VIEW_HEIGHT }}
          >
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]
                if (row === undefined) return null
                const run = row.run
                const time = run !== null ? relativeTime(run.authoredAt, relativeNow) : null
                return (
                  <div
                    key={row.line}
                    className={row.runStart ? 'dsh-git-blame__row dsh-git-blame__row--run-start' : 'dsh-git-blame__row'}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: 20,
                      transform: `translateY(${item.start}px)`,
                    }}
                    data-git-blame-row={row.line}
                    data-git-blame-run-start={row.runStart ? '' : undefined}
                  >
                    <span className='dsh-git-blame__line' data-git-blame-line=''>{row.line}</span>
                    {run !== null && row.runStart ? (
                      <span className='dsh-git-blame__note' data-git-blame-note={run.oid}>
                        <span className='dsh-git-blame__oid'>{run.shortOid}</span>
                        <span className='dsh-git-blame__author'>{run.authorName}</span>
                        <span className='dsh-git-blame__time'>
                          {time !== null
                            ? t(time.key, { count: 'count' in time.params ? String(time.params.count) : '' })
                            : formatCommitDate(run.authoredAt)}
                        </span>
                      </span>
                    ) : (
                      <span className='dsh-git-blame__continue' data-git-blame-continue=''>{'┊'}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
