/**
 * dsh-gitkit-ui — GitBranchCreateDialog：新建分支对话框（V2 批次一 [23]；plan §3.6
 * 「新建分支…」行）。字段：分支名（必填）+ 起点（可选，缺省当前 HEAD——host 侧
 * BranchCreateOptions.from null 语义）+ 创建后切换勾选（checkout，缺省开）。
 * 校验与入参组装收敛在 admin-view-model.branchCreateDraft（纯函数，tests 断言）；
 * 错误面（git/branch-exists 等）走 GitErrorNotice。
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitAdminFace } from '../admin-face.js'
import { branchCreateDraft } from '../admin-view-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitBranchCreateDialogProps {
  open: boolean
  t: TranslateNS<typeof NS>
  face: GitAdminFace
  /** 创建（含 checkout 切换）成功——拉起方关框并刷新状态。 */
  onDone(): void
  onClose(): void
}

/** 新建分支对话框（原语 Modal 浮层）。 */
export function GitBranchCreateDialog(props: GitBranchCreateDialogProps): ReactNode {
  const { open, t, face, onDone, onClose } = props
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [checkout, setCheckout] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<GitErrorLike | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setFrom('')
    setCheckout(true)
    setPending(false)
    setError(null)
  }, [open])

  const draft = branchCreateDraft({ name, from, checkout })

  const onCreate = (): void => {
    if (!draft.valid || draft.options === null || pending) return
    setPending(true)
    setError(null)
    void face.branchCreate(draft.options).then((result) => {
      if (!result.ok) {
        setPending(false)
        setError(result.error)
        return
      }
      setPending(false)
      onDone()
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('branch.create.title')}
      closeLabel={t('common.close')}
      footer={(
        <>
          <Button
            variant='outline'
            className='dsh-git-branch-create__cancel'
            onClick={() => { onClose() }}
          >
            {t('confirm.cancel')}
          </Button>
          <Button
            variant='primary'
            className='dsh-git-branch-create__confirm'
            data-git-branch-create=''
            disabled={!draft.valid || pending}
            onClick={onCreate}
          >
            {t('confirm.ok')}
          </Button>
        </>
      )}
    >
      <div className='dsh-git-branch-create' data-git-branch-create-dialog=''>
        {error !== null && <GitErrorNotice error={error} t={t} />}
        <label className='dsh-git-branch-create__label' htmlFor='dsh-git-branch-create-name'>
          {t('branch.create.nameLabel')}
        </label>
        <Input
          id='dsh-git-branch-create-name'
          className='dsh-git-branch-create__name'
          data-modal-autofocus=''
          value={name}
          onChange={(event) => { setName(event.target.value) }}
        />
        {name.trim() === '' && <p className='dsh-git-branch-create__hint'>{t('branch.create.nameRequired')}</p>}
        <label className='dsh-git-branch-create__label' htmlFor='dsh-git-branch-create-from'>
          {t('branch.create.startLabel')}
        </label>
        <Input
          id='dsh-git-branch-create-from'
          className='dsh-git-branch-create__from'
          value={from}
          onChange={(event) => { setFrom(event.target.value) }}
        />
        <Checkbox
          className='dsh-git-branch-create__checkout'
          checked={checkout}
          label={t('branch.create.checkout')}
          onChange={setCheckout}
        />
      </div>
    </Modal>
  )
}
