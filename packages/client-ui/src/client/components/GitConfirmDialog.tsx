/**
 * dsh-gitkit-ui — C5 GitConfirmDialog：二次确认框架（本模块 ask §④；
 * spec §3.4 [清单 12/44/50]）。
 *
 * - **danger 语义**：`severity='danger'` ⇒ 确认按钮呈危险态（data-git-confirm-danger，
 *   git.css 把 primary 族的 fill token 重指向 --dsw-alias-state-error-primary——已装
 *   Button 无 danger variant）且**确认勾选闸**生效——勾选「不可逆」复选框之前确认按钮
 *   禁用（danger 闸的纯逻辑在 ui-model.confirmButtonEnabled，tests/ui-model.spec 断言）。
 * - **路径全量列表**：`items` 给定时全量列出（滚动区，逐行等宽字体）——discard 的
 *   消费方传全部路径而非计数（[清单 12] 的 UI 半；计数在 message 文案里）。
 * - **确认勾选**：`checkboxLabel` 由调用方经 `t('confirm.dangerCheckbox')` 注入
 *   （本组件不做 locale 依赖——框架组件只吃 props，spec §3.4 的 props 形状加宽一项）。
 * - 浮层：**原语 Modal**（审查报告 §2.2 P2）——壳/标题/描述（message → description）/
 *   Escape/遮罩/焦点全归 Modal 的 useModalLayer；closeLabel 复用 cancelLabel（本组件
 *   props 无 t，避免给拉起方扩散新必选 prop）；items 滚动列表保留自定义类；勾选框换
 *   原语 Checkbox（data-git-confirm-checkbox 锚随落地消失——Checkbox 无 rest 透传，
 *   该锚在 verify-load/tests/capability-spec 均无断言）。不注册 root 槽——root 被
 *   AppFrame 占据，map §3.1；由拉起方在自己的组件树内渲染。
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { confirmButtonEnabled } from '../ui-model.js'

/** 严重级（spec §3.4：normal / danger）。 */
export type ConfirmSeverity = 'normal' | 'danger'

export interface GitConfirmDialogProps {
  /** false = 不渲染（null）。 */
  open: boolean
  title: string
  message: string
  /** 全量列出条目（discard 的路径清单；可滚动）。 */
  items?: readonly string[]
  severity: ConfirmSeverity
  confirmLabel: string
  cancelLabel: string
  /** danger 勾选框标签（调用方传 t('confirm.dangerCheckbox')）；danger 时参与闸。 */
  checkboxLabel?: string
  onConfirm(): void
  onCancel(): void
}

/** 二次确认对话框（原语 Modal 浮层面）。 */
export function GitConfirmDialog(props: GitConfirmDialogProps) {
  const {
    open, title, message, items, severity, confirmLabel, cancelLabel, checkboxLabel,
    onConfirm, onCancel,
  } = props
  const [checked, setChecked] = useState(false)
  // 每次打开重置勾选（上一轮的确认不能延续到这一轮危险操作）。
  useEffect(() => {
    if (open) setChecked(false)
  }, [open])
  if (!open) return null
  const enabled = confirmButtonEnabled(severity, checked)
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeLabel={cancelLabel}
      description={message}
      footer={(
        <>
          <Button
            variant='outline'
            className='dsh-git-confirm-dialog__cancel'
            onClick={() => { onCancel() }}
          >
            {cancelLabel}
          </Button>
          <Button
            variant='primary'
            className='dsh-git-confirm-dialog__confirm'
            data-git-confirm-confirm=''
            data-git-confirm-danger={severity === 'danger' ? '' : undefined}
            disabled={!enabled}
            onClick={() => { if (enabled) onConfirm() }}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {items !== undefined && items.length > 0 && (
        <ul className='dsh-git-confirm-dialog__items' data-git-confirm-items=''>
          {items.map((item) => (
            <li key={item} className='dsh-git-confirm-dialog__item'>{item}</li>
          ))}
        </ul>
      )}
      {severity === 'danger' && (
        <Checkbox
          className='dsh-git-confirm-dialog__checkbox'
          checked={checked}
          label={checkboxLabel ?? ''}
          onChange={setChecked}
        />
      )}
    </Modal>
  )
}
