/**
 * dsh-gitkit — GitCheckpointTimeline：会话改动时间线折叠区（V3 批次四 [清单 39/41]；
 * v3-implementation-plan §6.6 的 client 半）。
 *
 * 装配：变更 tab 中部（stash 条与文件组之间，仓库可用时渲染）的**折叠区**——toggle
 * 展开（aria-expanded）才拉 checkpointList（打开才拉、不做常驻轮询——拉取半在
 * store/checkpoint-store.ts 的 HostReadStore 范式，本组件只在 open 且相位 idle 时
 * ensure）。面板结构：
 *   - 归因筛选行（[40]）：五态 aria-pressed 控件（all/agent/user/mixed/unknown），
 *     作用对象 = 主文件卡片列表（过滤半 = checkpoint-view.filterChangesViewModel，
 *     由父层装配——控件渲染在本时间线区）；
 *   - 回合分组列表（[39]）：相对时间 + **reason 徽标**（plan §6.6 三件套；批次四评审
 *     收口交付——wire CheckpointEntry.reason 已过线，checkpointReasonView 已知 kind 走
 *     词典、未知 kind 原样显示、null 不渲染）+ 文件计数；
 *   - 回合展开文件行（±计数）→ 点击看 diff（checkpointDiff → checkpointDiffFile 投影
 *     → 既有 FileDiffView 只读渲染，无 selection）；
 *   - 「恢复此回合」（[39] danger 写）：GitConfirmDialog danger 勾选闸（第一层）+
 *     reduceRestore 状态机 confirm no-op（第二层）+ baseRevision 乐观并发基线
 *     （discard 三重守卫范式——确认时刻由父层传入当前 HEAD oid）；
 *   - summary null 的回合：诚实 unavailable 文案（宿主重启/会话处置后记录不保留，
 *     不伪造）+ 恢复按钮禁用（无记录无从恢复——host 侧同位置硬拒绝
 *     git/checkpoint-unavailable）。
 *
 * 数据面：组件不做 RPC（注入面纪律）——时间线/diff 槽走 GitCheckpointState（父层
 * inject 的 root store 快照），restore 走 GitChangesOpsFace.checkpointRestore 直通；
 * 成功后 onMutated（父层 refresh → R5 manual → revision 递增 → store 自动失效重拉）。
 *
 * a11y：沿用 P3-9 锚标准——折叠 toggle/回合行/文件行 aria-expanded、筛选 role='group'
 * + aria-pressed、加载态 role='status'、区域 role='region' + aria-label；本组件无
 * 自定义快捷键，故无 aria-keyshortcuts 声明面。
 */

import { useEffect, useMemo, useReducer, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitLocaleKey, NS } from '../locales.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import type { GitErrorLike } from '../remote/mount.js'
import {
  ATTRIBUTION_FILTERS, checkpointDiffFile, checkpointReasonView, checkpointTimeView, currentSessionEntries,
  groupCheckpointTurns, initialRestoreState, reduceRestore, restoreWireOptions,
} from '../checkpoint-view.js'
import type { AttributionFilter, RestoreMachineState, TimelineFileRow, TimelineTurnGroup } from '../checkpoint-view.js'
import { checkpointDiffSlotKey } from '../store/checkpoint-store.js'
import type { GitCheckpointState } from '../store/checkpoint-store.js'
import { FileDiffView } from './FileDiffView.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitCheckpointTimelineProps {
  /** false = 折叠（toggle 仍在——计数随数据相位收敛）。 */
  open: boolean
  /** 检查点/归因数据缓存快照（父层 inject 的 root store）。 */
  state: GitCheckpointState
  /** 当前会话 id（环内条目的会话过滤——v1 单会话口径）。 */
  sessionId: string
  /** 确认时刻捕获的乐观并发基线（当前 status 的 HEAD oid；null = 不校验）。 */
  baseRevision: string | null
  /** 归因筛选态（父层持有——过滤作用对象是主文件列表）。 */
  filter: AttributionFilter
  /** 变更动作面（checkpointRestore 直通半）。 */
  ops: GitChangesOpsFace
  /** 词典 t。 */
  t: TranslateNS<typeof NS>
  onToggle(): void
  onFilterChange(filter: AttributionFilter): void
  /** 时间线按需拉取（打开且 idle 时由本组件调——store 半去重）。 */
  ensureTimeline(): void
  /** 懒加载一个回合文件的 diff（sessionId 随行 = wire 判别半——批次四评审收口）。 */
  loadDiff(seq: number, index: number, sessionId: string): void
  /** 恢复成功后的宿主刷新（R5 manual）。 */
  onMutated(): void
}

/** restore 状态机的 useReducer 初值工厂（useReducer 三参形态）。 */
function restoreReducer(): RestoreMachineState {
  return initialRestoreState()
}

/** 回合时间渲染（复用 checkpoint-view 的复用半——blame.time.* 词典或绝对日期文本）。 */
function timeOf(iso: string): { localeKey: GitLocaleKey | null; text: string; params: Record<string, number> } {
  const view = checkpointTimeView(iso, Date.now())
  return view.kind === 'locale' ? { localeKey: view.key, text: '', params: view.params } : { localeKey: null, text: view.value, params: {} }
}

/**
 * 会话改动时间线折叠区（变更 tab 内嵌区域；非 Modal）。
 * @param props - 数据快照与动作回调。
 */
export function GitCheckpointTimeline(props: GitCheckpointTimelineProps): ReactNode {
  const { open, state, sessionId, baseRevision, filter, ops, t, onToggle, onFilterChange, ensureTimeline, loadDiff, onMutated } = props
  const timeline = state.timeline
  const [expandedTurns, setExpandedTurns] = useState<Record<number, boolean>>({})
  const [selectedFile, setSelectedFile] = useState<TimelineFileRow | null>(null)
  const [restore, dispatchRestore] = useReducer(reduceRestore, undefined, restoreReducer)

  const groups = useMemo(
    () => groupCheckpointTurns(currentSessionEntries(timeline.entries, sessionId)),
    [timeline.entries, sessionId],
  )

  // 打开且相位 idle（含 revision 失效后的自动回落）⇒ 按需拉取（store 半去重）。
  useEffect(() => {
    if (open && timeline.phase === 'idle') ensureTimeline()
  }, [open, timeline.phase, ensureTimeline])

  // 选中文件的首载（缓存命中/在途由 store 半去重；error 态重试走同一入口）。
  // sessionId 随行（wire 判别半——多会话 seq 碰撞防歧义，批次四评审收口）。
  useEffect(() => {
    if (selectedFile === null) return
    loadDiff(selectedFile.seq, selectedFile.index, sessionId)
  }, [selectedFile, loadDiff, sessionId])

  // running 相位 → wire 调用（restoreWireOptions 仅 running 产出——闸的旁路面为零）。
  // 成功（含部分成功）⇒ onMutated（R5 manual）；拒绝 ⇒ error 相位就地显示。
  useEffect(() => {
    if (restore.phase !== 'running' || restore.seq === null) return
    const options = restoreWireOptions(restore, sessionId)
    if (options === null) return
    let cancelled = false
    void ops.checkpointRestore(options).then((result) => {
      if (cancelled) return
      if (result.ok) {
        dispatchRestore({ type: 'succeeded', applied: result.value.applied, failed: result.value.failed })
        onMutated()
        return
      }
      dispatchRestore({ type: 'rejected', error: result.error })
    })
    return () => { cancelled = true }
  }, [restore, ops, onMutated])

  const toggleTurn = (turn: number): void => {
    setExpandedTurns((prev) => ({ ...prev, [turn]: !(prev[turn] ?? false) }))
  }
  const requestRestore = (group: TimelineTurnGroup): void => {
    if (group.allUnavailable) return // 无记录无从恢复（host 同位置硬拒绝——不发起）
    dispatchRestore({ type: 'request', seq: group.seq, turn: group.turn, paths: group.files.map((file) => file.path) })
  }

  const selectedDiff = (() => {
    if (selectedFile === null) return null
    const slot = state.diffs[checkpointDiffSlotKey(sessionId, selectedFile.seq, selectedFile.index)]
    if (slot === undefined || slot.state === 'loading') {
      return <p className='dsh-git-changes__checkpoint-diff-status' role='status' data-git-checkpoint-diff-status='loading'>{t('checkpoint.diffLoading')}</p>
    }
    if (slot.state === 'error' && slot.error !== undefined) {
      const error: GitErrorLike = slot.error
      return (
        <div className='dsh-git-changes__checkpoint-diff-error' data-git-checkpoint-diff-status='error'>
          <GitErrorNotice error={error} t={t} />
          <button
            type='button'
            className='dsh-git-changes__checkpoint-diff-retry'
            data-git-checkpoint-diff-retry=''
            onClick={() => { loadDiff(selectedFile.seq, selectedFile.index, sessionId) }}
          >
            {t('common.retry')}
          </button>
        </div>
      )
    }
    if (slot.diff === undefined) return null
    return <FileDiffView file={checkpointDiffFile(slot.diff)} t={t} />
  })()

  const restoreOutcome = (() => {
    if (restore.phase === 'applied' || restore.phase === 'partial') {
      const failedCount = restore.failed.length
      return (
        <div className='dsh-git-changes__checkpoint-restore-outcome' data-git-checkpoint-restore-outcome={restore.phase}>
          <p className='dsh-git-changes__checkpoint-restore-note' data-git-checkpoint-restore-note=''>
            {failedCount === 0
              ? t('checkpoint.restore.applied', { count: restore.applied.length })
              : t('checkpoint.restore.partial', { applied: restore.applied.length, failed: failedCount })}
          </p>
          {restore.failed.map((entry) => (
            <p key={entry.path} className='dsh-git-changes__checkpoint-restore-failed' data-git-checkpoint-restore-failed={entry.path}>
              {`${entry.path}: ${entry.reason}`}
            </p>
          ))}
          <button
            type='button'
            className='dsh-git-changes__checkpoint-restore-dismiss'
            data-git-checkpoint-restore-dismiss=''
            onClick={() => { dispatchRestore({ type: 'dismiss' }) }}
          >
            {t('common.close')}
          </button>
        </div>
      )
    }
    if (restore.phase === 'error' && restore.error !== null) {
      return (
        <div className='dsh-git-changes__checkpoint-restore-outcome' data-git-checkpoint-restore-outcome='error'>
          <GitErrorNotice error={restore.error} t={t} />
          <button
            type='button'
            className='dsh-git-changes__checkpoint-restore-dismiss'
            data-git-checkpoint-restore-dismiss=''
            onClick={() => { dispatchRestore({ type: 'dismiss' }) }}
          >
            {t('common.close')}
          </button>
        </div>
      )
    }
    return null
  })()

  const restoreBusy = restore.phase === 'running'
  return (
    <section className='dsh-git-changes__checkpoint' data-git-checkpoint-timeline=''>
      <button
        type='button'
        className='dsh-git-changes__checkpoint-toggle'
        data-git-checkpoint-toggle=''
        aria-expanded={open}
        onClick={onToggle}
      >
        {open && timeline.phase === 'ready'
          ? t('checkpoint.toggleCount', { count: groups.length })
          : t('checkpoint.toggle')}
      </button>
      {open && (
        <div className='dsh-git-changes__checkpoint-body' data-git-checkpoint-body='' role='region' aria-label={t('checkpoint.regionAria')}>
          <div className='dsh-git-changes__checkpoint-filter' data-git-checkpoint-filter='' role='group' aria-label={t('checkpoint.filterAria')}>
            {ATTRIBUTION_FILTERS.map((option) => (
              <button
                key={option}
                type='button'
                className='dsh-git-changes__checkpoint-filter-option'
                data-git-checkpoint-filter-option={option}
                aria-pressed={filter === option}
                onClick={() => { onFilterChange(option) }}
              >
                {option === 'all' ? t('checkpoint.filter.all') : t(`checkpoint.attribution.${option}`)}
              </button>
            ))}
          </div>
          {timeline.phase === 'loading' && (
            <p className='dsh-git-changes__checkpoint-status' role='status' data-git-checkpoint-status='loading'>{t('checkpoint.loading')}</p>
          )}
          {timeline.phase === 'error' && timeline.error !== null && (
            <div className='dsh-git-changes__checkpoint-error' data-git-checkpoint-status='error'>
              <GitErrorNotice error={timeline.error} t={t} />
              <button
                type='button'
                className='dsh-git-changes__checkpoint-retry'
                data-git-checkpoint-retry=''
                onClick={() => { ensureTimeline() }}
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {timeline.phase === 'ready' && groups.length === 0 && (
            <p className='dsh-git-changes__checkpoint-status' data-git-checkpoint-status='empty'>{t('checkpoint.empty')}</p>
          )}
          {groups.map((group) => {
            const expanded = expandedTurns[group.turn] ?? false
            const time = timeOf(group.endedAt)
            return (
              <div key={group.turn} className='dsh-git-changes__checkpoint-turn' data-git-checkpoint-turn={group.turn}>
                <button
                  type='button'
                  className='dsh-git-changes__checkpoint-turn-toggle'
                  data-git-checkpoint-turn-toggle=''
                  aria-expanded={expanded}
                  aria-label={t(expanded ? 'checkpoint.collapseAria' : 'checkpoint.expandAria', { turn: group.turn })}
                  onClick={() => { toggleTurn(group.turn) }}
                >
                  <span className='dsh-git-changes__checkpoint-turn-label' data-git-checkpoint-turn-label=''>
                    {t('checkpoint.turn', { turn: group.turn })}
                  </span>
                  {(() => {
                    // turn/end reason 徽标（plan §6.6「相对时间 + reason 徽标 + 文件计数」；
                    // 批次四评审收口交付）。已知 kind 走词典、未知 kind 原样显示、null 不渲染。
                    const reasonView = checkpointReasonView(group.reason)
                    if (reasonView === null) return null
                    return (
                      <span
                        className='dsh-git-changes__checkpoint-turn-reason'
                        data-git-checkpoint-turn-reason={reasonView.kind === 'locale' ? reasonView.key : reasonView.value}
                      >
                        {reasonView.kind === 'locale' ? t(reasonView.key) : reasonView.value}
                      </span>
                    )
                  })()}
                  <span className='dsh-git-changes__checkpoint-turn-time' data-git-checkpoint-turn-time=''>
                    {time.localeKey !== null ? t(time.localeKey, time.params) : time.text}
                  </span>
                  <span className='dsh-git-changes__checkpoint-turn-count' data-git-checkpoint-turn-count=''>
                    {group.allUnavailable ? '' : t('checkpoint.fileCount', { count: group.total })}
                  </span>
                </button>
                {expanded && (
                  <div className='dsh-git-changes__checkpoint-detail' data-git-checkpoint-detail=''>
                    {group.allUnavailable ? (
                      <p className='dsh-git-changes__checkpoint-unavailable' data-git-checkpoint-turn-unavailable=''>
                        {t('checkpoint.turnUnavailable')}
                      </p>
                    ) : (
                      <>
                        <ul className='dsh-git-changes__checkpoint-files' data-git-checkpoint-files=''>
                          {group.files.map((file) => {
                            const selected = selectedFile !== null && selectedFile.seq === file.seq && selectedFile.index === file.index
                            return (
                              <li key={`${file.seq}:${file.index}:${file.path}`} className='dsh-git-changes__checkpoint-file-item'>
                                <button
                                  type='button'
                                  className='dsh-git-changes__checkpoint-file'
                                  data-git-checkpoint-file={file.path}
                                  aria-expanded={selected}
                                  onClick={() => { setSelectedFile(selected ? null : file) }}
                                >
                                  <span className='dsh-git-changes__checkpoint-file-path' data-git-checkpoint-file-path=''>{file.path}</span>
                                  <span className='dsh-git-changes__checkpoint-file-counts' data-git-checkpoint-file-counts=''>
                                    {`+${file.added} -${file.deleted}`}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                        {selectedFile !== null && selectedFile.seq === group.seq && selectedDiff !== null && (
                          <div className='dsh-git-changes__checkpoint-diff' data-git-checkpoint-diff=''>{selectedDiff}</div>
                        )}
                        <div className='dsh-git-changes__checkpoint-actions' data-git-checkpoint-actions=''>
                          <button
                            type='button'
                            className='dsh-git-changes__checkpoint-restore'
                            data-git-checkpoint-restore=''
                            disabled={restoreBusy || group.allUnavailable}
                            onClick={() => { requestRestore(group) }}
                          >
                            {restoreBusy && restore.seq === group.seq ? t('checkpoint.restore.running') : t('checkpoint.restore')}
                          </button>
                        </div>
                      </>
                    )}
                    {restore.seq === group.seq && restoreOutcome}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <GitConfirmDialog
        open={restore.phase === 'confirming'}
        title={t('checkpoint.restore.title')}
        message={restore.turn !== null
          ? t('checkpoint.restore.message', { turn: restore.turn, count: restore.paths.length })
          : ''}
        items={restore.paths}
        severity='danger'
        confirmLabel={t('checkpoint.restore')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={() => { dispatchRestore({ type: 'confirm', baseRevision }) }}
        onCancel={() => { dispatchRestore({ type: 'cancel' }) }}
      />
    </section>
  )
}
