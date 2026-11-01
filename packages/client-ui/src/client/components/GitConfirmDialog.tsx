/**
 * @dsh-plugin/client-ui-git — C5 GitConfirmDialog：二次确认框架（本模块 ask §④；
 * spec §3.4 [清单 12/44/50]）。
 *
 * - **danger 语义**：`severity='danger'` ⇒ 确认按钮呈危险态（data-git-confirm-danger）
 *   且**确认勾选闸**生效——勾选「不可逆」复选框之前确认按钮禁用（danger 闸的纯逻辑
 *   在 ui-model.confirmButtonEnabled，tests/ui-model.spec 断言）。
 * - **路径全量列表**：`items` 给定时全量列出（滚动区，逐行等宽字体）——discard 的
 *   消费方传全部路径而非计数（[清单 12] 的 UI 半；计数在 message 文案里）。
 * - **确认勾选**：`checkboxLabel` 由调用方经 `t('confirm.dangerCheckbox')` 注入
 *   （本组件不做 locale 依赖——框架组件只吃 props，spec §3.4 的 props 形状加宽一项）。
 * - 浮层：固定定位遮罩 + 对话框卡片（Escape 取消、遮罩点击取消；不注册 root 槽——
 *   root 被 AppFrame 占据，map §3.1；由拉起方在自己的组件树内渲染）。
 */

import { useEffect, useState } from 'react'
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

/** 二次确认对话框（浮层面）。 */
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
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, onCancel])
  if (!open) return null
  const enabled = confirmButtonEnabled(severity, checked)
  return (
    <div
      className='dsh-git-confirm-backdrop'
      data-git-confirm=''
      data-git-confirm-severity={severity}
      onClick={() => { onCancel() }}
    >
      <div
        className='dsh-git-confirm-dialog'
        role='dialog'
        aria-modal='true'
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <h3 className='dsh-git-confirm-dialog__title'>{title}</h3>
        <p className='dsh-git-confirm-dialog__message'>{message}</p>
        {items !== undefined && items.length > 0 && (
          <ul className='dsh-git-confirm-dialog__items' data-git-confirm-items=''>
            {items.map((item) => (
              <li key={item} className='dsh-git-confirm-dialog__item'>{item}</li>
            ))}
          </ul>
        )}
        {severity === 'danger' && (
          <label className='dsh-git-confirm-dialog__checkbox'>
            <input
              type='checkbox'
              checked={checked}
              data-git-confirm-checkbox=''
              onChange={(event) => { setChecked(event.target.checked) }}
            />
            <span>{checkboxLabel ?? ''}</span>
          </label>
        )}
        <div className='dsh-git-confirm-dialog__actions'>
          <button type='button' className='dsh-git-confirm-dialog__cancel' onClick={() => { onCancel() }}>
            {cancelLabel}
          </button>
          <button
            type='button'
            className='dsh-git-confirm-dialog__confirm'
            data-git-confirm-confirm=''
            data-git-confirm-danger={severity === 'danger' ? '' : undefined}
            disabled={!enabled}
            onClick={() => { if (enabled) onConfirm() }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
