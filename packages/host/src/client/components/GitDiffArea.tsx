/**
 * dsh-gitkit — GitDiffArea：展开行 diff 装配区（diffOf 的组件半；Phase 2·client
 * 自 GitChangesTab 拆出）。
 *
 * 分支序原样迁移：blame 模式 → diff 缓存缺席/loading → error+重试 → 空差异 →
 * FileDiffView + hunk/行级勾选面 + patch 就地错误条。勾选变化**不在这里组装载荷**：
 * onApplySelection 回调回装配半（assembleSelectedPatch + directionOfScope 依赖当轮
 * selection——组装点留在 GitChangesTab；changes-ops-face.spec 锁定其纯函数半），
 * 本组件只做 hunkLineKeys/parsePatch 的键展开（hunk 勾选 = 整 hunk 全集）。
 *
 * 锚面纪律：data-git-change-diff-modes/-blame-toggle/-diff-status/-diff-retry/
 * -patch-error/-patch-error-dismiss 六锚与词典键组（changes.diffMode/blameMode、
 * diff.*、blame.loading、common.retry/close）原样迁移。
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffFile } from 'dsh-gitkit/types'
import { parsePatch } from '../diff/patch-hunks.js'
import { hunkLineKeys } from '../diff/patch-select.js'
import type { NS } from '../locales.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { BlameSlotState } from '../store/git-blame-store.js'
import type { DiffEntryState } from '../store/git-changes-store.js'
import { FileDiffView } from './FileDiffView.js'
import { GitBlameView } from './GitBlameView.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitDiffAreaProps {
  /** 展开行路径（blame 槽位键 + diff 消费键）。 */
  path: string
  /** 该行 diff 缓存槽（diffCacheKey(revision, path, scope) 键）——blame 模式不消费。 */
  entry: DiffEntryState | undefined
  /** blame 槽位（blame 模式消费；undefined = 首载中）。 */
  blameSlot: BlameSlotState | undefined
  /** blame 模式开关（diff | blame 两态——装配半相位）。 */
  blameMode: boolean
  /** 当前勾选集（patch-select lineKeyOf 产出键；装配半的乐观集）。 */
  selectedLines: ReadonlySet<string>
  /** hunk/行级应用的就地错误（null = 无；失败 → 乐观勾选回滚由装配半承载）。 */
  patchError: GitErrorLike | null
  /** blame 模式切换（模式条 aria-pressed 的另一半）。 */
  onBlameMode(mode: boolean): void
  /** diff 错误重试（loadDiff(row.scope, row.path)——装配半闭包）。 */
  onRetryDiff(): void
  /** blame 整槽重试（blameEnsure(path)——装配半闭包）。 */
  onRetryBlame(): void
  /** blame 分片加载（blameEnsureRange(path, start, end)——装配半闭包）。 */
  onEnsureBlameRange(start: number, end: number): void
  /** 勾选应用（assembleSelectedPatch + directionOfScope + stagePatch 的组件半装配——留在 GitChangesTab）。 */
  onApplySelection(file: DiffFile, keys: readonly string[]): void
  /** patch 就地错误条关闭。 */
  onDismissPatchError(): void
  /** 词典翻译（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
}

/** 展开行的 diff 装配区：模式切换条 + blame/diff 分支渲染。 */
export function GitDiffArea(props: GitDiffAreaProps): ReactNode {
  const {
    path, entry, blameSlot, blameMode, selectedLines, patchError,
    onBlameMode, onRetryDiff, onRetryBlame, onEnsureBlameRange, onApplySelection, onDismissPatchError, t,
  } = props
  // ── blame 模式切换条（V2 批次二 [34]）：diff | blame 两态（aria-pressed）──
  const modeBar = (
    <div className='dsh-git-changes__diff-modes' data-git-change-diff-modes=''>
      <button
        type='button'
        className='dsh-git-changes__diff-mode'
        aria-pressed={!blameMode}
        onClick={() => { onBlameMode(false) }}
      >
        {t('changes.diffMode')}
      </button>
      <button
        type='button'
        className='dsh-git-changes__diff-mode'
        aria-pressed={blameMode}
        data-git-change-blame-toggle=''
        onClick={() => { onBlameMode(true) }}
      >
        {t('changes.blameMode')}
      </button>
    </div>
  )
  if (blameMode) {
    return (
      <>
        {modeBar}
        {blameSlot !== undefined ? (
          <GitBlameView
            path={path}
            slot={blameSlot}
            t={t}
            onEnsureRange={onEnsureBlameRange}
            onRetry={onRetryBlame}
          />
        ) : (
          <p className='dsh-git-changes__diff-status' role='status' data-git-change-diff-status='loading'>{t('blame.loading')}</p>
        )}
      </>
    )
  }
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
            onClick={onRetryDiff}
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
          勾选=unstage 反向——direction 折算（directionOfScope）在装配半。 */}
      <FileDiffView
        file={file}
        t={t}
        selection={{
          selected: selectedLines,
          onToggleLine: (key) => { onApplySelection(file, [key]) },
          onToggleHunk: (hunkIndex) => {
            const hunk = parsePatch(file.patch ?? '')[hunkIndex]
            if (hunk === undefined) return
            onApplySelection(file, hunkLineKeys(hunk))
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
            onClick={onDismissPatchError}
          >
            {t('common.close')}
          </button>
        </div>
      )}
    </>
  )
}
