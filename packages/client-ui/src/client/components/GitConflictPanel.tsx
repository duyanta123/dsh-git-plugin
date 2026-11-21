/**
 * dsh-gitkit-ui — GitConflictPanel：冲突解决面板（V3 批次一 [清单 13]；
 * v3-implementation-plan §3.7 的 client 半）。
 *
 * 装配：changes tab 顶部冲突条（GitChangesTab 内——status.conflicted 非空常驻入口）
 * 展开本面板。面板结构：
 *   - 文件列表：code（七码原样）/ kind（modified/added/deleted）徽标 + 路径；
 *   - 选中文件的解决动作：ours/theirs 按钮（**由 wire 的 oursExists/theirsExists 驱动
 *     禁用**——「不可向禁用」，plan §3.2）+ DD 两向同效显式确认单钮（§3.4 DD 行：
 *     ours/theirs 在 host 矩阵同命令，两段式点击确认）+「我已手动编辑，标记已解决」行；
 *   - 底部操作条：继续操作（operationContinue——客户端守卫 = 中间态在场且 unmerged
 *     已清空，镜像 host conflicts-remaining 零命令守卫）+ 放弃操作（abortOperation，
 *     **GitConfirmDialog danger 勾选闸**——plan §3.7）。
 *
 * 数据面：组件不做 RPC——消费 `GitChangesOpsFace` 的冲突五方法（changes-ops-face.ts
 * V3 批次一扩面；apply 顶层单例闭包）。清单来自 conflictList 的 **fresh 扫描**（不走
 * status 的 1.5s 缓存——解决动作基于此刻的世界，plan §3.2），每次动作成功后重读 +
 * 通知父层 refresh（R5 manual → 新 status 帧 → 冲突条计数随动）。
 *
 * continue 循环（plan §3.8「done:false→刷新→done:true」）：冲突是返回值不是错误——
 * done:false 携带下一批 conflicted 路径，面板重读进入下一轮；done:true 完成提示。
 * 状态机纯面 = conflict-view-model.continueReducer（tests/conflict-view.spec 断言）。
 *
 * a11y：沿用 P3-9 锚标准——行选择 aria-pressed、加载态 role='status'、放弃确认走
 * GitConfirmDialog（原语 Modal：Escape/遮罩/焦点归 useModalLayer）；本面板无自定义
 * 快捷键，故无 aria-keyshortcuts 声明面。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConflictListResult, OperationInProgressOp } from 'dsh-gitkit/types'
import type { NS } from '../locales.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import type { GitErrorLike } from '../remote/mount.js'
import { useAsyncAction } from '../hooks/useAsyncAction.js'
import {
  conflictRows, continueEnabled, continueHintKey, continueReducer, ddAcceptDeleteChoice,
  initialContinueState, operationActionsEnabled,
} from '../conflict-view-model.js'
import type { ConflictRowView, ContinueState } from '../conflict-view-model.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitConflictPanelProps {
  /** false = 不渲染（父层条件挂载——stash 面板同款；关闭即重置内部状态）。 */
  open: boolean
  /** 词典 t（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
  /** 变更动作面（conflictList/conflictResolve/conflictMarkResolved/operationContinue/
   *  abortOperation 消费半；apply 顶层单例闭包）。 */
  ops: GitChangesOpsFace
  /** 关面板（关闭按钮——冲突条再点同效）。 */
  onClose(): void
  /** 任一写动作成功后的宿主刷新（R5 manual——新 status 帧 → 冲突条计数随动）。 */
  onMutated(): void
  /** 面板每次重读清单后回吐最新结果（父层冲突条 operation 徽标的数据源）。 */
  onSummary(result: ConflictListResult | null): void
}

/** 在途动作类别（busy 闸的判别域；null = 空闲）。 */
type BusyKind = 'resolve' | 'mark' | 'continue' | 'abort' | null

/** 冲突动作任务形态（泛型签名拆行别名——check-locale 行级扫描同款规避）。 */
type ConflictTaskResult = Promise<void>
type ConflictTask = () => ConflictTaskResult

/** 冲突解决面板（changes tab 内嵌区域；非 Modal）。 */
export function GitConflictPanel(props: GitConflictPanelProps): ReactNode {
  const { open, t, ops, onClose, onMutated, onSummary } = props
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading')
  const [result, setResult] = useState<ConflictListResult | null>(null)
  const [loadError, setLoadError] = useState<GitErrorLike | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // busy 文案类别（resolve/mark/continue/abort——按钮 busy 态查表；闸本身归 hook）。
  const [busyKind, setBusyKind] = useState<Exclude<BusyKind, null> | null>(null)
  const [actionError, setActionError] = useState<GitErrorLike | null>(null)
  // DD 两向同效的两段式确认臂位（armed = 已点一次待确认的 path；换行/收起即撤臂）。
  const [ddArmed, setDdArmed] = useState<string | null>(null)
  const [continueState, setContinueState] = useState<ContinueState>(initialContinueState)
  const [pendingAbort, setPendingAbort] = useState(false)

  const load = (): void => {
    setPhase('loading')
    setLoadError(null)
    void ops.conflictList().then((loaded) => {
      if (loaded.ok) {
        setResult(loaded.value)
        onSummary(loaded.value)
        setPhase('ready')
      } else {
        setLoadError(loaded.error)
        setPhase('ready')
      }
    })
  }

  // 开框即取（fresh 扫描——组件随父层条件挂载，挂载即开框；load 闭包吃 ops/onSummary/
  // onMutated——apply 单例闭包与 setState 引用稳定，不进 deps）。
  useEffect(() => {
    if (open) load()
  }, [open, ops])

  const rows = conflictRows(result?.conflicts ?? [])
  const selected = selectedPath === null ? undefined : rows.find((row) => row.path === selectedPath)
  const operation: OperationInProgressOp | null = result?.operation ?? null

  // 选中行从 fresh 清单消失（已解决/外部改动）→ 收起选中位与 DD 臂位。
  useEffect(() => {
    if (selectedPath !== null && !rows.some((row) => row.path === selectedPath)) {
      setSelectedPath(null)
      setDdArmed(null)
    }
  }, [rows, selectedPath])

  /** 动作成功后的共用收尾：清单重读（fresh）+ 宿主刷新。 */
  const settle = (): void => {
    onMutated()
    load()
  }

  // ── Phase 2·client：四动作共用的在途闸收敛到 useAsyncAction 同步闸（createBusyGate
  // ——判定与置位原子同帧，先于任何 await；原 `if (busy !== null) return` 读的是
  // setState 写的闭包值，同帧二次点击会漏闸）。busy 文案类别（busyKind）保留独立
  // state——闸过闸后由 run 的同步首段置位/finally 复位。──
  const conflictTaskRef = useRef<{ kind: Exclude<BusyKind, null>; task: ConflictTask } | null>(null)
  const conflictAction = useAsyncAction<null>({
    run: async () => {
      const { kind, task } = conflictTaskRef.current!
      setBusyKind(kind)
      try {
        await task()
      } finally {
        setBusyKind(null)
      }
      return { ok: true, value: null }
    },
  })
  const busy = conflictAction.busy

  const runAction = (kind: Exclude<BusyKind, null>, task: ConflictTask): void => {
    conflictTaskRef.current = { kind, task }
    void conflictAction.trigger()
  }

  const runResolve = (row: ConflictRowView, resolution: 'ours' | 'theirs'): void => {
    runAction('resolve', async () => {
      setActionError(null)
      setDdArmed(null)
      const done = await ops.conflictResolve({ choices: [{ path: row.path, resolution }] })
      if (!done.ok) {
        setActionError(done.error)
        return
      }
      settle()
    })
  }

  /** DD「接受删除」：两段式确认——首点武装，再点发 resolve（两向同效，以 'ours' 过线）。 */
  const runDdAccept = (row: ConflictRowView): void => {
    if (ddArmed !== row.path) {
      setDdArmed(row.path)
      return
    }
    runResolve(row, ddAcceptDeleteChoice(row.path).resolution)
  }

  const runMarkResolved = (row: ConflictRowView): void => {
    runAction('mark', async () => {
      setActionError(null)
      const done = await ops.conflictMarkResolved({ paths: [row.path] })
      if (!done.ok) {
        setActionError(done.error)
        return
      }
      settle()
    })
  }

  const runContinue = (): void => {
    runAction('continue', async () => {
      setActionError(null)
      setContinueState((state) => continueReducer(state, { type: 'invoke' }))
      const done = await ops.operationContinue()
      if (!done.ok) {
        setContinueState((state) => continueReducer(state, { type: 'fail', error: done.error }))
        setActionError(done.error)
        return
      }
      setContinueState((state) => continueReducer(state, { type: 'progress', result: done.value }))
      // done:false = sequencer 停在下一批冲突（fresh 重读即新清单）；done:true = 完成
      // （重读后清单空 + 宿主刷新收口）。两支同构收尾，差别只在提示文案。
      settle()
    })
  }

  const runAbort = (): void => {
    setPendingAbort(false)
    runAction('abort', async () => {
      setActionError(null)
      const done = await ops.abortOperation()
      if (!done.ok) {
        setActionError(done.error)
        return
      }
      setContinueState((state) => continueReducer(state, { type: 'reset' }))
      settle()
    })
  }

  if (!open) return null
  const continueHint = continueHintKey(continueState)

  return (
    <div className='dsh-git-conflict' data-git-conflict-panel=''>
      <div className='dsh-git-conflict__head' data-git-conflict-head=''>
        <h3 className='dsh-git-conflict__title' data-git-conflict-title=''>{t('conflict.panelTitle')}</h3>
        <button
          type='button'
          className='dsh-git-conflict__close'
          data-git-conflict-close=''
          onClick={onClose}
        >
          {t('common.close')}
        </button>
      </div>
      {loadError !== null && (
        <GitErrorNotice error={loadError} t={t} onAction={(action) => { if (action === 'retry') load() }} />
      )}
      {phase === 'loading' && (
        <p className='dsh-git-conflict__status' role='status' data-git-conflict-status='loading'>
          {t('conflict.loading')}
        </p>
      )}
      {phase === 'ready' && loadError === null && rows.length === 0 && (
        <p className='dsh-git-conflict__status' data-git-conflict-status='empty'>{t('conflict.empty')}</p>
      )}
      {rows.length > 0 && (
        <ul className='dsh-git-conflict__list' data-git-conflict-list=''>
          {rows.map((row) => (
            <li key={row.path} className='dsh-git-conflict__item' data-git-conflict-item={row.path}>
              <button
                type='button'
                className='dsh-git-conflict__row'
                data-git-conflict-row={row.path}
                aria-pressed={selectedPath === row.path}
                onClick={() => { setSelectedPath(selectedPath === row.path ? null : row.path); setDdArmed(null) }}
              >
                <span className='dsh-git-conflict__code' data-git-conflict-code={row.code}>{row.code}</span>
                <span className='dsh-git-conflict__kind' data-git-conflict-kind={row.kindKey}>
                  {t(row.kindKey)}
                </span>
                <span className='dsh-git-conflict__path'>{row.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected !== undefined ? (
        <div className='dsh-git-conflict__actions' data-git-conflict-actions={selected.path}>
          {selected.ddSymmetric ? (
            <>
              <button
                type='button'
                className='dsh-git-conflict__dd'
                data-git-conflict-dd=''
                disabled={busy}
                onClick={() => { runDdAccept(selected) }}
              >
                {busyKind === 'resolve' ? t('conflict.resolving') : t('conflict.ddAccept')}
              </button>
              {ddArmed === selected.path && (
                <p className='dsh-git-conflict__dd-hint' data-git-conflict-dd-hint=''>
                  {t('conflict.ddConfirmHint')}
                </p>
              )}
            </>
          ) : (
            <>
              <button
                type='button'
                className='dsh-git-conflict__side'
                data-git-conflict-ours=''
                disabled={!selected.oursEnabled || busy}
                onClick={() => { runResolve(selected, 'ours') }}
              >
                {t('conflict.ours')}
              </button>
              <button
                type='button'
                className='dsh-git-conflict__side'
                data-git-conflict-theirs=''
                disabled={!selected.theirsEnabled || busy}
                onClick={() => { runResolve(selected, 'theirs') }}
              >
                {t('conflict.theirs')}
              </button>
            </>
          )}
          <button
            type='button'
            className='dsh-git-conflict__mark'
            data-git-conflict-mark=''
            disabled={busy}
            onClick={() => { runMarkResolved(selected) }}
          >
            {t('conflict.markResolved')}
          </button>
        </div>
      ) : (
        rows.length > 0 && (
          <p className='dsh-git-conflict__status' data-git-conflict-status='select'>
            {t('conflict.selectHint')}
          </p>
        )
      )}
      {continueHint !== null && (
        <p className='dsh-git-conflict__continue-hint' role='status' data-git-conflict-continue-hint={continueState.phase}>
          {continueState.phase === 'next-conflict'
            ? t(continueHint, { count: continueState.conflicted.length })
            : t(continueHint)}
        </p>
      )}
      {actionError !== null && (
        <div className='dsh-git-conflict__action-error' data-git-conflict-action-error=''>
          <GitErrorNotice error={actionError} t={t} />
          <button
            type='button'
            className='dsh-git-conflict__error-dismiss'
            data-git-conflict-error-dismiss=''
            onClick={() => { setActionError(null) }}
          >
            {t('common.close')}
          </button>
        </div>
      )}
      <div className='dsh-git-conflict__footer' data-git-conflict-footer=''>
        <button
          type='button'
          className='dsh-git-conflict__continue'
          data-git-conflict-continue=''
          disabled={!continueEnabled(operation, rows.length) || busy}
          onClick={runContinue}
        >
          {busyKind === 'continue' ? t('conflict.continueRunning') : t('conflict.continue')}
        </button>
        <button
          type='button'
          className='dsh-git-conflict__abort'
          data-git-conflict-abort=''
          disabled={!operationActionsEnabled(operation) || busy}
          onClick={() => { setPendingAbort(true) }}
        >
          {t('conflict.abort')}
        </button>
      </div>
      {/* 放弃操作 danger 闸（plan §3.7）：GitConfirmDialog severity danger ⇒ 确认勾选
          闸生效（confirmButtonEnabled）；Esc/遮罩/焦点归原语 Modal。 */}
      <GitConfirmDialog
        open={pendingAbort}
        title={t('conflict.abort.title')}
        message={t('conflict.abort.message', { op: operation ?? '' })}
        severity='danger'
        confirmLabel={t('conflict.abort')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={runAbort}
        onCancel={() => { setPendingAbort(false) }}
      />
    </div>
  )
}
