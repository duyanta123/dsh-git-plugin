/**
 * dsh-gitkit-ui — GitPushDialog：推送对话框（V2 批次一 [27][57]；plan §3.6）。
 *
 * 装配：remote picker（remoteList 数据，原语 Menu 下拉）+ force 勾选（对话框内）
 * + **force danger 双闸**——force 勾选后确认点击不再直跑，先开 GitConfirmDialog
 * severity='danger' 的「不可逆」勾选闸二次确认（勾选前确认按钮禁用，闸的纯逻辑
 * confirmButtonEnabled ui-model.ts:114），确认后才 push({force:true, acknowledged:true})
 * ——host 侧 acknowledged 守卫的 UI 对应物（双闸语义 plan §3.1 [清单 27]）。
 * setUpstream 状态展示：upstream 缺失 ⇒ 提示行「将随推送建立跟踪」。
 *
 * 浮层：原语 Modal（拉起方在自身组件树内渲染；不注册 root 槽——map §3.1）。
 * 渲染决策收敛在 admin-view-model.pushDialogView（tests/push-dialog.spec 断言）。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import type { GitErrorLike } from '../remote/mount.js'
import { pushDialogView } from '../admin-view-model.js'
import type { NS } from '../locales.js'
import { GitErrorNotice } from './GitErrorNotice.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'

/** 当前分支的投影（拉起方从状态快照传入；null = 快照未就绪）。 */
export type PushDialogBranch = {
  name: string | null
  upstream: string | null
  detached: boolean
  unborn: boolean
} | null

export interface GitPushDialogProps {
  /** false = 不渲染（原语 Modal 亦不挂载）。 */
  open: boolean
  /** 词典 t（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
  /** 管理面业务面（push/remoteList 的消费半；apply 顶层单例闭包）。 */
  face: GitAdminFace
  /** 当前分支投影（分支可用性与 upstream 提示的判据）。 */
  branch: PushDialogBranch
  /** 推送成功（拉起方关框）。 */
  onDone(): void
  /** 关框（Cancel / Esc / 遮罩点击）。 */
  onClose(): void
}

/** 推送对话框（remote picker + force danger 双闸；原语 Modal 浮层）。 */
export function GitPushDialog(props: GitPushDialogProps): ReactNode {
  const { open, t, face, branch, onDone, onClose } = props
  const [remotes, setRemotes] = useState<readonly RemoteInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [dangerAsk, setDangerAsk] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<GitErrorLike | null>(null)

  // 开框重置 + 取远端清单（失败进错误条，picker 空——可取消重开）。
  useEffect(() => {
    if (!open) return
    setRemotes([])
    setSelectedRemote(null)
    setPickerOpen(false)
    setForce(false)
    setDangerAsk(false)
    setPending(false)
    setError(null)
    let cancelled = false
    void face.listRemotes().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setRemotes(result.value.remotes)
        setSelectedRemote(result.value.remotes[0]?.name ?? null)
      } else {
        setError(result.error)
      }
    })
    return () => { cancelled = true }
  }, [open, face])

  // 展示层视图（forceAcked 恒 false——force 勾选后的 options 组装只发生在 runPush
  // 的终态重算里；此处 canConfirm 只表达「确认可点」语义，force 时点击转 danger 闸）。
  const view = useMemo(() => pushDialogView({ remotes, selectedRemote, branch, force, forceAcked: false, pending }), [remotes, selectedRemote, branch, force, pending])

  const runPush = (acked: boolean): void => {
    // acked = danger 勾选闸已过（force 路径）或非 force 直推；组装终态入参。
    const final = pushDialogView({ remotes, selectedRemote, branch, force, forceAcked: acked, pending })
    if (final.options === null) return
    setPending(true)
    setError(null)
    void face.push(final.options).then((result) => {
      if (!result.ok) {
        setPending(false)
        setError(result.error)
        return
      }
      setPending(false)
      onDone()
    })
  }

  const onConfirm = (): void => {
    if (!view.canConfirm) return
    if (view.forceGate.ask) {
      setDangerAsk(true) // force 双闸第一闸已过（勾选），进 danger 二次确认
      return
    }
    runPush(false)
  }

  if (!open) return null

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('push.title')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button
              variant='outline'
              className='dsh-git-push-dialog__cancel'
              onClick={() => { onClose() }}
            >
              {t('confirm.cancel')}
            </Button>
            <Button
              variant='primary'
              className='dsh-git-push-dialog__confirm'
              data-git-push-confirm=''
              disabled={!view.canConfirm}
              onClick={onConfirm}
            >
              {pending ? t('commit.pushing') : t('menu.push')}
            </Button>
          </>
        )}
      >
        <div className='dsh-git-push-dialog' data-git-push-dialog=''>
          {error !== null && <GitErrorNotice error={error} t={t} />}
          <div className='dsh-git-push-dialog__field'>
            <span className='dsh-git-push-dialog__field-label'>{t('push.remoteLabel')}</span>
            <Menu
              open={pickerOpen}
              anchor={
                <button
                  type='button'
                  className='dsh-git-push-dialog__picker'
                  data-git-push-picker=''
                  aria-haspopup='menu'
                  aria-expanded={pickerOpen}
                  disabled={remotes.length === 0}
                  onClick={() => { setPickerOpen((value) => !value) }}
                >
                  {view.selectedRemote ?? ''}
                </button>
              }
              items={view.remoteChoices.map((choice) => ({
                id: choice.name,
                label: `${choice.name} — ${choice.url}`,
              }))}
              selectedId={view.selectedRemote ?? undefined}
              onSelect={(id) => {
                setSelectedRemote(id)
                setPickerOpen(false)
              }}
              onClose={() => { setPickerOpen(false) }}
              className='dsh-git-push-dialog__picker-anchor'
            />
          </div>
          {branch !== null && !branch.unborn && (
            <p className='dsh-git-push-dialog__branch' data-git-push-branch=''>
              {branch.name ?? ''}
            </p>
          )}
          {view.showSetUpstreamNote && (
            <p className='dsh-git-push-dialog__note' data-git-push-upstream-note=''>
              {t('push.setUpstreamMissing')}
            </p>
          )}
          <Checkbox
            className='dsh-git-push-dialog__force'
            checked={force}
            disabled={pending}
            label={t('push.force')}
            onChange={setForce}
          />
        </div>
      </Modal>

      {/* force danger 双闸第二闸：severity='danger' + 「不可逆」勾选闸（GitConfirmDialog），
          勾选前确认禁用；确认后 push({force:true, acknowledged:true})。 */}
      <GitConfirmDialog
        open={dangerAsk}
        title={t('push.forceConfirmTitle')}
        message={t('push.forceMessage')}
        severity='danger'
        confirmLabel={t('menu.push')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={() => {
          setDangerAsk(false)
          runPush(true)
        }}
        onCancel={() => { setDangerAsk(false) }}
      />
    </>
  )
}
