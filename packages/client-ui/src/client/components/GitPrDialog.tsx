/**
 * dsh-gitkit-ui — GitPrDialog：创建 PR 对话框（V2 批次四 [46][69]；plan §6.6）。
 *
 * 装配：AI 生成描述按钮（[46]——generatePrDescription 结果填 title/body，有内容时
 * 先经覆盖确认，镜像 GitCommitDialog 的 aiOverwrite 形态）+ title/body 编辑 +
 * base 分支选择（refs 数据——pr-view-model.prBaseChoices，本地/远端分支都可选、
 * 当前分支排除）+ draft 勾选 + **创建 danger 确认**（GitConfirmDialog
 * severity='danger' 勾选闸——创建对外可见 PR 的二次确认，plan §6.6）+ 成功展示
 * PR URL（anchor 打开）。D1=A：创建载体 = host 半 gh CLI，本组件只消费确认闸与
 * 结果；[70] 合并策略约定段在 host prompt 组装，组件无落点。
 *
 * [69] 关联展示的交互面在推送对话框与分支选择器行（pr-view-model.prLinkView）；
 * 本组件的成功 URL 是 PR 链接的主打开面（原语菜单行是 button，不可嵌 anchor）。
 *
 * 浮层：原语 Modal（拉起方在自身组件树内渲染；不注册 root 槽——map §3.1）。
 * 渲染决策收敛在 pr-view-model.prDialogView（tests/pr-dialog.spec 断言）。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo } from 'dsh-gitkit/types'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import type { GitPrFace } from '../pr-face.js'
import { prBaseChoices, prDialogView, prLinkView } from '../pr-view-model.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitPrDialogProps {
  /** false = 不渲染（原语 Modal 亦不挂载）。 */
  open: boolean
  /** 词典 t（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
  /** PR 业务面（listRefs/generateDescription/createPr；apply 顶层单例闭包）。 */
  face: GitPrFace
  /** 当前分支短名（PR 的 head；null = 分支不可用——detached/unborn，创建禁用）。 */
  head: string | null
  /** 创建成功（拉起方关框；URL 展示在框内成功态，关闭即收）。 */
  onDone(): void
  /** 关框（Cancel / Esc / 遮罩点击）。 */
  onClose(): void
}

/** PR 创建对话框（AI 描述 + base picker + draft + danger 闸；原语 Modal 浮层）。 */
export function GitPrDialog(props: GitPrDialogProps): ReactNode {
  const { open, t, face, head, onDone, onClose } = props
  const [refs, setRefs] = useState<readonly RefInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedBase, setSelectedBase] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [pending, setPending] = useState(false)
  const [dangerAsk, setDangerAsk] = useState(false)
  const [overwriteAsk, setOverwriteAsk] = useState(false)
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [error, setError] = useState<GitErrorLike | null>(null)

  // 开框重置 + 取 refs（base picker 数据；失败进错误条——可取消重开）。
  useEffect(() => {
    if (!open) return
    setRefs([])
    setSelectedBase(null)
    setPickerOpen(false)
    setTitle('')
    setBody('')
    setDraft(false)
    setGenerating(false)
    setPending(false)
    setDangerAsk(false)
    setOverwriteAsk(false)
    setCreatedUrl(null)
    setError(null)
    let cancelled = false
    void face.listRefs().then((result) => {
      if (cancelled) return
      if (result.ok) setRefs(result.value)
      else setError(result.error)
    })
    return () => { cancelled = true }
  }, [open, face])

  const baseChoices = useMemo(() => prBaseChoices({ refs, headName: head }), [refs, head])
  const effectiveBase = selectedBase ?? baseChoices[0]?.name ?? null
  const view = useMemo(
    () => prDialogView({ title, body, base: effectiveBase, head, draft, acked: true, pending }, baseChoices),
    [title, body, effectiveBase, head, draft, pending, baseChoices],
  )

  /** AI 生成落地（覆盖确认后调用；生成结果整体替换标题与描述）。 */
  const applyGenerate = (signal?: AbortSignal): void => {
    setGenerating(true)
    setError(null)
    void face.generateDescription(signal).then((result) => {
      setGenerating(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setTitle(result.value.title)
      setBody(result.value.body)
    })
  }

  const onGenerate = (): void => {
    // 有内容先经覆盖确认（normal 闸——GitCommitDialog aiOverwrite 同形态）。
    if (title.trim() !== '' || body.trim() !== '') {
      setOverwriteAsk(true)
      return
    }
    applyGenerate()
  }

  const runCreate = (): void => {
    // acked = danger 勾选闸已过（GitConfirmDialog 的「不可逆」复选框承担）。
    const final = prDialogView({ title, body, base: effectiveBase, head, draft, acked: true, pending }, baseChoices)
    if (final.options === null) return
    setPending(true)
    setError(null)
    void face.createPr(final.options).then((result) => {
      if (!result.ok) {
        setPending(false)
        setError(result.error)
        return
      }
      setPending(false)
      setCreatedUrl(result.value.url)
      onDone()
    })
  }

  const onConfirm = (): void => {
    if (createdUrl !== null) {
      onDone()
      return
    }
    if (!view.canConfirm) return
    setDangerAsk(true) // 创建恒走 danger 二次确认（对外可见动作——plan §6.6）
  }

  if (!open) return null

  const successLink = prLinkView({ ok: true, value: createdUrl !== null ? { url: createdUrl, state: null } : null })

  return (
    <>
      <Modal
        open={open}
        onClose={createdUrl !== null ? onDone : onClose}
        title={t('pr.title')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button
              variant='outline'
              className='dsh-git-pr-dialog__cancel'
              onClick={() => {
                if (createdUrl !== null) onDone()
                else onClose()
              }}
            >
              {t('common.close')}
            </Button>
            {createdUrl === null && (
              <Button
                variant='primary'
                className='dsh-git-pr-dialog__confirm'
                data-git-pr-confirm=''
                disabled={!view.canConfirm}
                onClick={onConfirm}
              >
                {pending ? t('pr.creating') : t('pr.create')}
              </Button>
            )}
          </>
        )}
      >
        <div className='dsh-git-pr-dialog' data-git-pr-dialog=''>
          {error !== null && <GitErrorNotice error={error} t={t} />}
          {createdUrl !== null ? (
            <div className='dsh-git-pr-dialog__success' data-git-pr-success=''>
              <p className='dsh-git-pr-dialog__success-line'>{t('pr.success')}</p>
              {successLink !== null && (
                <a
                  className='dsh-git-pr-dialog__success-link'
                  data-git-pr-link=''
                  href={successLink.url}
                  target='_blank'
                  rel='noreferrer'
                >
                  {successLink.number !== null
                    ? t('pr.link.badge', { number: successLink.number })
                    : successLink.url}
                </a>
              )}
            </div>
          ) : (
            <>
              <div className='dsh-git-pr-dialog__title-row'>
                <button
                  type='button'
                  className='dsh-git-pr-dialog__generate'
                  data-git-pr-generate=''
                  disabled={generating || pending || head === null}
                  onClick={onGenerate}
                >
                  {generating ? t('pr.generating') : t('pr.generate')}
                </button>
              </div>
              <label className='dsh-git-pr-dialog__field'>
                <span className='dsh-git-pr-dialog__field-label'>{t('pr.titleLabel')}</span>
                <input
                  type='text'
                  className='dsh-git-pr-dialog__title-input'
                  data-git-pr-title=''
                  value={title}
                  onChange={(event) => { setTitle(event.target.value) }}
                  disabled={pending}
                />
              </label>
              <label className='dsh-git-pr-dialog__field'>
                <span className='dsh-git-pr-dialog__field-label'>{t('pr.bodyLabel')}</span>
                <textarea
                  className='dsh-git-pr-dialog__body-input'
                  data-git-pr-body=''
                  rows={8}
                  value={body}
                  onChange={(event) => { setBody(event.target.value) }}
                  disabled={pending}
                />
              </label>
              <div className='dsh-git-pr-dialog__field'>
                <span className='dsh-git-pr-dialog__field-label'>{t('pr.baseLabel')}</span>
                <Menu
                  open={pickerOpen}
                  anchor={
                    <button
                      type='button'
                      className='dsh-git-pr-dialog__picker'
                      data-git-pr-picker=''
                      aria-haspopup='menu'
                      aria-expanded={pickerOpen}
                      disabled={baseChoices.length === 0}
                      onClick={() => { setPickerOpen((value) => !value) }}
                    >
                      {effectiveBase ?? ''}
                    </button>
                  }
                  items={view.baseChoices.map((choice) => ({
                    id: choice.name,
                    label: choice.name,
                  }))}
                  selectedId={effectiveBase ?? undefined}
                  onSelect={(id) => {
                    setSelectedBase(id)
                    setPickerOpen(false)
                  }}
                  onClose={() => { setPickerOpen(false) }}
                  className='dsh-git-pr-dialog__picker-anchor'
                />
              </div>
              <Checkbox
                className='dsh-git-pr-dialog__draft'
                checked={draft}
                disabled={pending}
                label={t('pr.draft')}
                onChange={setDraft}
              />
            </>
          )}
        </div>
      </Modal>

      {/* 创建 danger 二次确认（severity='danger' ⇒ 「不可逆」勾选闸生效——对外可见
          动作的确认；勾选前确认禁用，确认后 createPr({acknowledged:true})）。 */}
      <GitConfirmDialog
        open={dangerAsk}
        title={t('pr.createConfirmTitle')}
        message={t('pr.createConfirmMessage', {
          head: head ?? '',
          base: effectiveBase ?? t('pr.baseDefault'),
        })}
        severity='danger'
        confirmLabel={t('pr.create')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={() => {
          setDangerAsk(false)
          runCreate()
        }}
        onCancel={() => { setDangerAsk(false) }}
      />

      {/* AI 覆盖前确认（GitCommitDialog 同形态——normal 闸，确认后整体替换）。 */}
      <GitConfirmDialog
        open={overwriteAsk}
        title={t('pr.aiOverwriteTitle')}
        message={t('pr.aiOverwriteMessage')}
        severity='normal'
        confirmLabel={t('confirm.ok')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => {
          setOverwriteAsk(false)
          applyGenerate()
        }}
        onCancel={() => { setOverwriteAsk(false) }}
      />
    </>
  )
}
