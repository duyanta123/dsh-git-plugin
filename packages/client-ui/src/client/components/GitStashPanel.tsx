/**
 * dsh-gitkit-ui — GitStashPanel：stash 计数 chip → 面板（V2 批次三 [14]；Phase 2·client
 * 自 GitChangesTab 拆出）。
 *
 * 自包含半（stash 相位机与调用时序——组件闭包内，node 无渲染器不可交互驱动，
 * changes-ops-face.spec.ts 文件头同证登记）：面板开合 + 懒加载相位（idle/loading/
 * ready/error——toggle 首开且非 ready 才拉 stashList）+ 三动作闸（useAsyncAction
 * 同步闸——Phase 2·client 收敛）+ D4=B includeUntracked 缺省勾选 + drop danger
 * 确认框（GitConfirmDialog 勾选闸）。成功路径 → refresh()（R5 manual，不等 R3 帧）
 * + reloadStash() 清单重读。
 *
 * 载荷纪律（changes-ops-face.spec 锁定面）：stashPushOptions(includeUntracked,
 * baseRevision) 显式过 wire；stashPop {index} / stashDrop {index, acknowledged:true}
 * 直通——「闸在组件（C5 danger 勾选闸）、本层只承接」；stashList 零参直通。折叠
 * 语义在 createGitRpcClient（loader-composition.spec 已锁），本组件不重组返回值。
 *
 * 渲染决策吃 stash-view-model 纯函数半（stashChipView/stashRows/untrackedHint/
 * popConflictHint/stashDropConfirmView/stashPushDisabled——stash-view.spec 钉子）；
 * 行视图（stashRows）管展示字段，动作载荷仍按 index 回查原始 entry（runStashPop /
 * setPendingDrop 吃 StashEntry）。stash op 错误条的「解决冲突…」经 onResolveConflict
 * 回吐主干（面板开合相位在 GitConflictBar——主干持有）。
 *
 * 锚面纪律：data-git-changes-stashbar/-stash-chip/-stash-panel/-stash-title/
 * -stash-status/-stash-list/-stash-item/-stash-pop/-stash-drop/-stash-popconflict/
 * -stash-push/-stash-push-button/-stash-untracked-hint 十三锚与词典键组（stash.*）
 * 原样迁移。
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitStatusSnapshot, StashEntry } from 'dsh-gitkit/types'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from '../locales.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import { useAsyncAction } from '../hooks/useAsyncAction.js'
import {
  STASH_INCLUDE_UNTRACKED_DEFAULT, popConflictHint, stashChipView, stashDropConfirmView,
  stashPushDisabled, stashPushOptions, stashRows, untrackedHint,
} from '../stash-view-model.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

// ── Phase 2·client：stash 三连的载荷类型（泛型签名拆行别名——check-locale 的行级
// JSX 扫描会把「同一行内 `>`…`<` 相邻」误判成裸文本，拆行规避）。 ──
type StashTaskResult = Promise<RemoteResult<unknown>>
type StashTask = () => StashTaskResult

export interface GitStashPanelProps {
  /** 仓库可用投影（chip/面板渲染闸——view.available 直传）。 */
  available: boolean
  /** 工作区干净（stashPushDisabled 的「无可 stash」判据——view.clean 直传）。 */
  clean: boolean
  /** status 快照（untrackedHint 计数 + stashPush baseRevision 乐观基线）。 */
  status: GitStatusSnapshot | null
  /** 变更动作面（stash 四方法 + abortOperation 消费半——apply 顶层单例闭包）。 */
  ops: GitChangesOpsFace
  /** 任一动作成功后的宿主刷新（R5 manual——stashAction 成功路径调用）。 */
  refresh(): void
  /** stash op 错误条「解决冲突…」→ 就地展开冲突面板（主干相位回调）。 */
  onResolveConflict(): void
  /** 词典翻译（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
}

/** stash 计数 chip → 面板：列表 / 应用=pop / 删除=drop danger 闸 + 「Stash 全部变更」。 */
export function GitStashPanel(props: GitStashPanelProps): ReactNode {
  const { available, clean, status, ops, refresh, onResolveConflict, t } = props
  // ── stash 面板（[14]）：chip/面板/列表/动作态（D4=B includeUntracked 缺省勾选）──
  const [stashOpen, setStashOpen] = useState(false)
  const [stashPhase, setStashPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [stashEntries, setStashEntries] = useState<StashEntry[]>([])
  const [stashError, setStashError] = useState<GitErrorLike | null>(null)
  const [stashOpError, setStashOpError] = useState<GitErrorLike | null>(null)
  const [includeUntracked, setIncludeUntracked] = useState(STASH_INCLUDE_UNTRACKED_DEFAULT)
  const [pendingDrop, setPendingDrop] = useState<StashEntry | null>(null)
  // stash 三连的入参载荷（点击时组装——push 选项/pop 与 drop 的 index 各异）。
  const stashTaskRef = useRef<StashTask | null>(null)
  const stashAction = useAsyncAction<null>({
    run: async () => {
      setStashOpError(null)
      const done = await (stashTaskRef.current as StashTask)()
      if (!done.ok) {
        setStashOpError(done.error)
        return { ok: true, value: null }
      }
      refresh()
      reloadStash()
      return { ok: true, value: null }
    },
  })
  const stashBusy = stashAction.busy

  // ── stash 面板（[14]）：懒加载 + push/pop/drop 三动作（成功 → refresh + 重读清单）──
  const reloadStash = (): void => {
    setStashPhase('loading')
    setStashError(null)
    void ops.stashList().then((result) => {
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
    // D4=B：includeUntracked 显式过 wire（缺省 true——STASH_INCLUDE_UNTRACKED_DEFAULT
    // 初始化勾选态）；baseRevision = 乐观并发基线（discard 范式的可选沿用，plan §5.2）。
    stashTaskRef.current = () => ops.stashPush(stashPushOptions(includeUntracked, status?.branch.oid ?? null))
    void stashAction.trigger()
  }
  const runStashPop = (entry: StashEntry): void => {
    stashTaskRef.current = () => ops.stashPop({ index: entry.index })
    void stashAction.trigger()
  }
  const runStashDrop = (): void => {
    const entry = pendingDrop
    setPendingDrop(null)
    if (entry === null) return
    // acknowledged = 本调用契约「UI 已过 C5 danger 勾选闸」（changes-ops-face 同纪律）。
    stashTaskRef.current = () => ops.stashDrop({ index: entry.index, acknowledged: true })
    void stashAction.trigger()
  }

  const stashChip = stashChipView(stashPhase === 'ready' ? stashEntries.length : null)
  // stash 列表行渲染决策收敛纯函数（stashRows——stash-view-model 的 spec 钉子）；
  // 动作载荷仍按 index 回查原始 entry（runStashPop / setPendingDrop 吃 StashEntry）。
  const stashRowViews = stashRows({ stashes: stashEntries })
  const untrackedHintView = untrackedHint(status)
  const popConflictVisible = popConflictHint(stashOpError)
  const pendingDropView = pendingDrop !== null ? stashDropConfirmView(pendingDrop) : null

  return (
    <>
      {available && (
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
      {available && stashOpen && (
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
          {stashRowViews.length > 0 && (
            <ul className='dsh-git-changes__stash-list' data-git-changes-stash-list=''>
              {stashRowViews.map((row) => {
                // 行视图（stashRows）管展示字段；动作按 index 回查原始 entry（1:1 投影）。
                const entry = stashEntries.find((candidate) => candidate.index === row.index)
                if (entry === undefined) return null
                return (
                  <li key={row.index} className='dsh-git-changes__stash-item' data-git-changes-stash-item={row.index}>
                    <span className='dsh-git-changes__stash-message'>{row.message}</span>
                    <span className='dsh-git-changes__stash-oid'>{row.shortOid}</span>
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
                )
              })}
            </ul>
          )}
          {popConflictVisible && (
            <p className='dsh-git-changes__stash-conflict' data-git-changes-stash-popconflict=''>{t('stash.popConflict')}</p>
          )}
          {/* stash pop 的 merge-conflict 错误条（V2 批次三）：V3 批次一追加「解决冲突…」
              动作 → 就地展开冲突面板（plan §3.7；面板在 stash 面板下方渲染）。 */}
          {stashOpError !== null && (
            <GitErrorNotice
              error={stashOpError}
              t={t}
              onAction={(action) => {
                if (action === 'resolve') onResolveConflict()
                else if (action === 'abort') {
                  // git/merge-conflict（op 'stash-pop'）的 abort 出口——走 stash 同一闸。
                  stashTaskRef.current = () => ops.abortOperation()
                  void stashAction.trigger()
                }
              }}
            />
          )}
          <div className='dsh-git-changes__stash-push' data-git-changes-stash-push=''>
            <button
              type='button'
              className='dsh-git-changes__stash-push-button'
              data-git-changes-stash-push-button=''
              disabled={stashPushDisabled(available, clean, stashBusy)}
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
    </>
  )
}
