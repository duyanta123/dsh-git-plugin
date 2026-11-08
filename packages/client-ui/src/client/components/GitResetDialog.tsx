/**
 * dsh-gitkit-ui — GitResetDialog：重置当前分支对话框（V2 批次二 [37]；plan §4.6
 * 「分支选择器 reset 子菜单（soft/mixed/hard；hard 走 danger 勾选闸）」）。
 *
 * 入口：header 菜单「重置当前分支…」子菜单选中目标分支后拉起；soft/mixed/hard 三档
 * 在本对话框内选择（mode 按钮组，worktree 对话框同构）。hard 的确认走 danger 勾选闸
 * （confirmButtonEnabled('danger', checked)——ui-model 纯逻辑一处实现两处消费），
 * 并按 plan §4.10「UI 需列出将丢弃的文件计数」展示 status 快照的去重路径计数。
 *
 * 守卫纯半 = admin-view-model.resetPlan（acknowledged + baseRevision——discard 三重
 * 守卫同款；baseRevision = 当前 HEAD oid，null ⇒ 确认禁用）。成功后走 status 流的
 * R3 帧（host afterWrite）驱动图/状态刷新，调用方再补一次 refresh()（R5 manual）。
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitAdminFace } from '../admin-face.js'
import type { ResetKind } from '../admin-view-model.js'
import { resetPlan } from '../admin-view-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import { confirmButtonEnabled } from '../ui-model.js'
import { GitErrorNotice } from './GitErrorNotice.js'

const RESET_KINDS: readonly ResetKind[] = ['soft', 'mixed', 'hard']

const KIND_LABEL_KEYS = {
  soft: 'timeTravel.reset.soft',
  mixed: 'timeTravel.reset.mixed',
  hard: 'timeTravel.reset.hard',
} as const

export interface GitResetDialogProps {
  open: boolean
  /** 重置目标分支（子菜单选中的非当前分支；null = 关）。 */
  target: string | null
  /** 当前 HEAD oid（baseRevision 乐观并发基线；null ⇒ 确认禁用）。 */
  headOid: string | null
  /** hard 档将丢弃的文件计数（status 快照去重路径——badgeCount 同口径）。 */
  discardCount: number
  t: TranslateNS<typeof NS>
  face: GitAdminFace
  /** 成功回调（调用方补 refresh）。 */
  onDone(): void
  onClose(): void
}

/** 重置当前分支对话框（原语 Modal 浮层；hard = danger 勾选闸）。 */
export function GitResetDialog(props: GitResetDialogProps): ReactNode {
  const { open, target, headOid, discardCount, t, face, onDone, onClose } = props
  const [kind, setKind] = useState<ResetKind>('mixed')
  const [acked, setAcked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GitErrorLike | null>(null)

  // 每次打开重置草稿（上一轮的选择/勾选不延续）。
  useEffect(() => {
    if (open) {
      setKind('mixed')
      setAcked(false)
      setBusy(false)
      setError(null)
    }
  }, [open])

  const plan = resetPlan({ kind, target: target ?? '', baseRevision: headOid, acked })
  const enabled = plan.valid && plan.options !== null && !busy && confirmButtonEnabled(plan.severity, acked)

  const onConfirm = (): void => {
    if (!enabled || plan.options === null) return
    setBusy(true)
    setError(null)
    void face.reset(plan.options).then((result) => {
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onClose()
      onDone()
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('timeTravel.reset.title', { target: target ?? '' })}
      closeLabel={t('confirm.cancel')}
      footer={(
        <>
          <Button variant='outline' className='dsh-git-reset-dialog__cancel' onClick={() => { onClose() }}>
            {t('confirm.cancel')}
          </Button>
          <Button
            variant='primary'
            className='dsh-git-reset-dialog__confirm'
            data-git-reset-confirm=''
            data-git-reset-danger={plan.severity === 'danger' ? '' : undefined}
            disabled={!enabled}
            onClick={onConfirm}
          >
            {t('confirm.ok')}
          </Button>
        </>
      )}
    >
      <div className='dsh-git-reset-dialog' data-git-reset-dialog=''>
        {error !== null && <GitErrorNotice error={error} t={t} />}
        <p className='dsh-git-reset-dialog__kind-label'>{t('timeTravel.reset.kindLabel')}</p>
        <div className='dsh-git-reset-dialog__modes' role='radiogroup' aria-label={t('timeTravel.reset.kindLabel')}>
          {RESET_KINDS.map((option) => (
            <button
              key={option}
              type='button'
              className='dsh-git-reset-dialog__mode'
              data-git-reset-kind={option}
              role='radio'
              aria-checked={kind === option}
              onClick={() => { setKind(option) }}
            >
              {t(KIND_LABEL_KEYS[option])}
            </button>
          ))}
        </div>
        {kind === 'hard' && (
          <p className='dsh-git-reset-dialog__hard-warning' data-git-reset-hard-warning=''>
            {t('timeTravel.reset.hardMessage', { count: discardCount })}
          </p>
        )}
        {kind === 'hard' && (
          <Checkbox
            className='dsh-git-reset-dialog__checkbox'
            checked={acked}
            label={t('confirm.dangerCheckbox')}
            onChange={setAcked}
          />
        )}
      </div>
    </Modal>
  )
}
