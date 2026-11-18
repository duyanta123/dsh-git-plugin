/**
 * dsh-gitkit-ui — GitMergeDialog：合并分支到当前分支对话框（V3 批次二 [28]；
 * v3-implementation-plan §4.6「分支选择器扩两行：『合并到当前分支…』对话框」）。
 *
 * 字段：branch picker（非当前分支清单——branchPickerEntries 模型，Menu 浮层）+
 * ff 三态单选（auto/ff-only/no-ff——role='radiogroup'，reset 对话框同构）+ message
 * 编辑（**仅 no-ff 显示**——plan §4.6「message 编辑（no-ff 时）」）+ danger 确认
 * 勾选闸（**恒档**：合并提交是对外可见动作，ff-only 纯快进也移动分支指针——
 * mergePlan.severity 恒 'danger'，confirmButtonEnabled 承担勾选闸）。
 *
 * 校验与入参组装收敛在 admin-view-model.mergePlan（纯函数，tests/merge-dialog.spec
 * 断言：ff 三态 → 命令参数映射 / 对话框校验 / danger 闸状态机）；错误面
 * （git/merge-conflict / git/dirty-worktree 等）走 GitErrorNotice——merge-conflict
 * 的「解决冲突…」入口由 error-map 既有 'resolve' 动作路由到变更 tab 冲突面板
 * （plan §4.6「冲突路径零新 UI」）。
 *
 * a11y：data-modal-autofocus 锚在 branch picker 按钮（Modal 初始聚焦——
 * branch-create 对话框同款）；本对话框无自定义快捷键，故无 aria-keyshortcuts
 * 声明面（Escape/焦点归原语 Modal——GitConflictPanel 同口径）。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import type { MergeFastForward } from '../admin-view-model.js'
import { mergePlan } from '../admin-view-model.js'
import { branchPickerEntries, confirmButtonEnabled } from '../ui-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** ff 三态的词典键（单选按钮组渲染序 = host wire 枚举序）。 */
const FF_LABEL_KEYS: Readonly<Record<MergeFastForward, 'merge.ff.auto' | 'merge.ff.ffOnly' | 'merge.ff.noFf'>> = Object.freeze({
  auto: 'merge.ff.auto',
  'ff-only': 'merge.ff.ffOnly',
  'no-ff': 'merge.ff.noFf',
})

const FF_MODES: readonly MergeFastForward[] = ['auto', 'ff-only', 'no-ff']

export interface GitMergeDialogProps {
  open: boolean
  t: TranslateNS<typeof NS>
  face: GitAdminFace
  /** 当前分支短名（null = detached/unborn——picker 空清单，确认禁用）。 */
  headName: string | null
  /** 当前 HEAD oid（baseRevision 乐观并发基线；null ⇒ 确认禁用）。 */
  headOid: string | null
  /** 本地分支清单（picker 数据源——拉起方菜单开框已取的清单直传，避免二次 RPC）。 */
  branches: readonly RefInfo[]
  /** 合并（含冲突外的正常完成）成功——拉起方关框并刷新状态（R5 manual）。 */
  onDone(): void
  onClose(): void
}

/** 合并分支到当前分支对话框（原语 Modal 浮层；确认 = danger 勾选闸恒档）。 */
export function GitMergeDialog(props: GitMergeDialogProps): ReactNode {
  const { open, t, face, headName, headOid, branches, onDone, onClose } = props
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [fastForward, setFastForward] = useState<MergeFastForward>('auto')
  const [message, setMessage] = useState('')
  const [acked, setAcked] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<GitErrorLike | null>(null)

  // 开框重置草稿（上一轮的选择/勾选/消息不延续）。
  useEffect(() => {
    if (!open) return
    setPickerOpen(false)
    setSelected(null)
    setFastForward('auto')
    setMessage('')
    setAcked(false)
    setPending(false)
    setError(null)
  }, [open])

  const entries = useMemo(
    () => branchPickerEntries({ branches, headName }),
    [branches, headName],
  )
  // 缺省取首个候选（picker 未选时）；无候选 ⇒ null（确认禁用）。
  const effective = selected ?? entries[0]?.label ?? null
  const plan = mergePlan({
    branch: effective ?? '',
    fastForward,
    message,
    headName,
    headOid,
    acked,
  })
  const enabled = plan.valid && plan.options !== null && !pending && confirmButtonEnabled(plan.severity, acked)

  const onConfirm = (): void => {
    if (!enabled || plan.options === null) return
    setPending(true)
    setError(null)
    void face.branchMerge(plan.options).then((result) => {
      if (!result.ok) {
        setPending(false)
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
      title={t('merge.title')}
      closeLabel={t('confirm.cancel')}
      footer={(
        <>
          <Button variant='outline' className='dsh-git-merge-dialog__cancel' onClick={() => { onClose() }}>
            {t('confirm.cancel')}
          </Button>
          <Button
            variant='primary'
            className='dsh-git-merge-dialog__confirm'
            data-git-merge-confirm=''
            data-git-merge-danger=''
            disabled={!enabled}
            onClick={onConfirm}
          >
            {pending ? t('merge.merging') : t('merge.title')}
          </Button>
        </>
      )}
    >
      <div className='dsh-git-merge-dialog' data-git-merge-dialog=''>
        {error !== null && <GitErrorNotice error={error} t={t} />}
        {headName !== null && (
          <p className='dsh-git-merge-dialog__current' data-git-merge-current=''>
            {t('merge.currentBranch', { name: headName })}
          </p>
        )}
        <div className='dsh-git-merge-dialog__field'>
          <span className='dsh-git-merge-dialog__field-label'>{t('merge.branchLabel')}</span>
          <Menu
            open={pickerOpen}
            anchor={
              <button
                type='button'
                className='dsh-git-merge-dialog__picker'
                data-git-merge-picker=''
                aria-haspopup='menu'
                aria-expanded={pickerOpen}
                disabled={entries.length === 0}
                data-modal-autofocus=''
                onClick={() => { setPickerOpen((value) => !value) }}
              >
                {effective ?? t('merge.branchEmpty')}
              </button>
            }
            items={entries.map((entry) => ({ id: entry.id, label: entry.label }))}
            selectedId={effective === null ? undefined : `branch-picker:${effective}`}
            onSelect={(id) => {
              setSelected(id.slice('branch-picker:'.length))
              setPickerOpen(false)
            }}
            onClose={() => { setPickerOpen(false) }}
            className='dsh-git-merge-dialog__picker-anchor'
          />
        </div>
        <p className='dsh-git-merge-dialog__kind-label'>{t('merge.ffLabel')}</p>
        <div className='dsh-git-merge-dialog__modes' role='radiogroup' aria-label={t('merge.ffLabel')}>
          {FF_MODES.map((mode) => (
            <button
              key={mode}
              type='button'
              className='dsh-git-merge-dialog__mode'
              data-git-merge-ff={mode}
              role='radio'
              aria-checked={fastForward === mode}
              onClick={() => { setFastForward(mode) }}
            >
              {t(FF_LABEL_KEYS[mode])}
            </button>
          ))}
        </div>
        {fastForward === 'no-ff' && (
          <>
            <label className='dsh-git-merge-dialog__field-label' htmlFor='dsh-git-merge-message'>
              {t('merge.messageLabel')}
            </label>
            <Input
              id='dsh-git-merge-message'
              className='dsh-git-merge-dialog__message'
              data-git-merge-message=''
              value={message}
              onChange={(event) => { setMessage(event.target.value) }}
            />
          </>
        )}
        <p className='dsh-git-merge-dialog__danger-note' data-git-merge-danger-note=''>
          {t('merge.dangerNote')}
        </p>
        <Checkbox
          className='dsh-git-merge-dialog__checkbox'
          checked={acked}
          label={t('confirm.dangerCheckbox')}
          onChange={setAcked}
        />
      </div>
    </Modal>
  )
}
