/**
 * dsh-gitkit — GitMergeDialog：合并分支到当前分支对话框（V3 批次二 [28]；
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

import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import type { MergeFastForward } from '../admin-view-model.js'
import type { BranchMergeResult } from 'dsh-gitkit/types'
import { mergePlan } from '../admin-view-model.js'
import { confirmButtonEnabled } from '../ui-model.js'
import { useDialogAction } from '../hooks/useDialogAction.js'
import type { NS } from '../locales.js'
import { GitErrorNotice } from './GitErrorNotice.js'
import { DialogBranchPickerField, DialogRadioGroup, useDialogBranchPicker } from './branch-action-shell.js'

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
  // picker 状态机（entries/缺省选中/前缀剥装）收敛到共享壳。
  const picker = useDialogBranchPicker({ branches, headName })
  const [fastForward, setFastForward] = useState<MergeFastForward>('auto')
  const [message, setMessage] = useState('')
  const [acked, setAcked] = useState(false)

  // 开框重置草稿（上一轮的选择/勾选/消息不延续）；pending/error 的 open 重置
  // + 防重入 + 「先置 pending=false 再调 onDone」时序收敛到 useDialogAction。
  useEffect(() => {
    if (!open) return
    picker.reset()
    setFastForward('auto')
    setMessage('')
    setAcked(false)
    // picker 的状态机对象每渲染新建，但 reset 只依赖 open 边沿——依赖只留 open。
  }, [open])

  // run 闭包在调用时读取当轮渲染的 plan（propsRef 每渲染捕获最新 props）。
  const { pending, error, run } = useDialogAction<BranchMergeResult>({
    open,
    run: async () => face.branchMerge(plan.options!),
    onDone: () => {
      onClose()
      onDone()
    },
  })

  const plan = mergePlan({
    branch: picker.effective ?? '',
    fastForward,
    message,
    headName,
    headOid,
    acked,
  })
  const enabled = plan.valid && plan.options !== null && !pending && confirmButtonEnabled(plan.severity, acked)

  const onConfirm = (): void => {
    if (!enabled || plan.options === null) return
    void run()
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
        <DialogBranchPickerField
          model={picker}
          label={t('merge.branchLabel')}
          classBase='dsh-git-merge-dialog'
          anchorData={{ 'data-git-merge-picker': '' }}
          emptyLabel={t('merge.branchEmpty')}
        />
        <DialogRadioGroup
          modes={FF_MODES}
          value={fastForward}
          onChange={setFastForward}
          label={t('merge.ffLabel')}
          labelKeys={FF_LABEL_KEYS}
          classBase='dsh-git-merge-dialog'
          dataAnchor='data-git-merge-ff'
          t={t}
        />
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
