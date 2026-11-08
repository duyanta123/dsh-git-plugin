/**
 * dsh-gitkit-ui — GitTagCreateDialog：打标签对话框（V2 批次一 [30]；plan §3.6
 * 「打标签…」行与图 tab「在此提交打标签」共用——oid null = HEAD（header 拉起），
 * 给定时打在该提交上（graph 拉起）。message 非空 = annotated tag（host 语义）。
 * force（tag -f 重名覆盖）不在本批 UI 面——重名错误 git/tag-exists 走错误条，
 * host acknowledged 守卫仍对 wire 面生效（plan §3.3；UI force 入口记 openIssues）。
 * 校验与入参组装收敛在 admin-view-model.tagCreateDraft（纯函数，tests 断言）。
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitAdminFace } from '../admin-face.js'
import { tagCreateDraft } from '../admin-view-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitTagCreateDialogProps {
  open: boolean
  t: TranslateNS<typeof NS>
  face: GitAdminFace
  /** 打标签的目标提交 oid；null = HEAD（header 入口）。 */
  oid: string | null
  /** 目标提交的短 oid 展示（graph 入口给；header 入口可缺省）。 */
  targetLabel: string | null
  /** 创建成功——拉起方关框并刷新 refs。 */
  onDone(): void
  onClose(): void
}

/** 打标签对话框（原语 Modal 浮层）。 */
export function GitTagCreateDialog(props: GitTagCreateDialogProps): ReactNode {
  const { open, t, face, oid, targetLabel, onDone, onClose } = props
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<GitErrorLike | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setMessage('')
    setPending(false)
    setError(null)
  }, [open])

  const draft = tagCreateDraft({ name, message, oid })

  const onCreate = (): void => {
    if (!draft.valid || draft.options === null || pending) return
    setPending(true)
    setError(null)
    void face.tagCreate(draft.options).then((result) => {
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
      title={t('tag.create.title')}
      closeLabel={t('common.close')}
      footer={(
        <>
          <Button
            variant='outline'
            className='dsh-git-tag-create__cancel'
            onClick={() => { onClose() }}
          >
            {t('confirm.cancel')}
          </Button>
          <Button
            variant='primary'
            className='dsh-git-tag-create__confirm'
            data-git-tag-create=''
            disabled={!draft.valid || pending}
            onClick={onCreate}
          >
            {t('confirm.ok')}
          </Button>
        </>
      )}
    >
      <div className='dsh-git-tag-create' data-git-tag-create-dialog=''>
        {error !== null && <GitErrorNotice error={error} t={t} />}
        {targetLabel !== null && (
          <p className='dsh-git-tag-create__target' data-git-tag-create-target=''>
            {t('tag.create.targetLabel')} · {targetLabel}
          </p>
        )}
        <label className='dsh-git-tag-create__label' htmlFor='dsh-git-tag-create-name'>
          {t('tag.create.nameLabel')}
        </label>
        <Input
          id='dsh-git-tag-create-name'
          className='dsh-git-tag-create__name'
          data-modal-autofocus=''
          value={name}
          onChange={(event) => { setName(event.target.value) }}
        />
        {name.trim() === '' && <p className='dsh-git-tag-create__hint'>{t('tag.create.nameRequired')}</p>}
        <label className='dsh-git-tag-create__label' htmlFor='dsh-git-tag-create-message'>
          {t('tag.create.messageLabel')}
        </label>
        <Input
          id='dsh-git-tag-create-message'
          className='dsh-git-tag-create__message'
          value={message}
          onChange={(event) => { setMessage(event.target.value) }}
        />
      </div>
    </Modal>
  )
}
