/**
 * dsh-gitkit — GitRebaseDialog：变基当前分支对话框（V3 批次二 [29]；
 * v3-implementation-plan §4.6「分支选择器扩两行：『变基到…』对话框」）。
 *
 * 字段：upstream picker（必填，非当前分支清单——branchPickerEntries 模型，缺省首个
 * 候选）+ onto 输入（**可选**，空 = 不使用 `--onto`——wire 可选入参省略纪律，
 * branch-create 起点输入同款）+ danger 确认勾选闸（**恒档**：重写历史语义——
 * rebasePlan.severity 恒 'danger'；重写历史文案明示于 rebase.rewriteNote）。
 *
 * 校验与入参组装收敛在 admin-view-model.rebasePlan（纯函数，tests/merge-dialog.spec
 * 断言）；冲突路径零新 UI——git/merge-conflict（op 'rebase'）错误面板的
 * 「解决冲突…」/'abort' 动作由 error-map 既有行路由（plan §4.6），continue 循环由
 * 变更 tab 冲突面板驱动。
 *
 * a11y：data-modal-autofocus 锚在 upstream picker 按钮（Modal 初始聚焦——
 * branch-create 对话框同款）；本对话框无自定义快捷键，故无 aria-keyshortcuts
 * 声明面（Escape/焦点归原语 Modal——GitConflictPanel 同口径）。
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import type { RebaseResult } from 'dsh-gitkit/types'
import { rebasePlan } from '../admin-view-model.js'
import { confirmButtonEnabled } from '../ui-model.js'
import { useDialogAction } from '../hooks/useDialogAction.js'
import type { NS } from '../locales.js'
import { GitErrorNotice } from './GitErrorNotice.js'
import { DialogBranchPickerField, useDialogBranchPicker } from './branch-action-shell.js'

export interface GitRebaseDialogProps {
  open: boolean
  t: TranslateNS<typeof NS>
  face: GitAdminFace
  /** 当前分支短名（null = detached/unborn——picker 空清单，确认禁用）。 */
  headName: string | null
  /** 当前 HEAD oid（baseRevision 乐观并发基线；null ⇒ 确认禁用）。 */
  headOid: string | null
  /** 本地分支清单（picker 数据源——拉起方菜单开框已取的清单直传，避免二次 RPC）。 */
  branches: readonly RefInfo[]
  /** 变基（含冲突外的正常完成）成功——拉起方关框并刷新状态（R5 manual）。 */
  onDone(): void
  onClose(): void
}

/** 变基当前分支对话框（原语 Modal 浮层；确认 = danger 勾选闸恒档——重写历史语义）。 */
export function GitRebaseDialog(props: GitRebaseDialogProps): ReactNode {
  const { open, t, face, headName, headOid, branches, onDone, onClose } = props
  // picker 状态机（entries/缺省选中/前缀剥装）收敛到共享壳。
  const picker = useDialogBranchPicker({ branches, headName })
  const [onto, setOnto] = useState('')
  const [acked, setAcked] = useState(false)

  // 开框重置草稿（上一轮的选择/勾选/onto 不延续）；pending/error 的 open 重置
  // + 防重入 + 「先置 pending=false 再调 onDone」时序收敛到 useDialogAction。
  useEffect(() => {
    if (!open) return
    picker.reset()
    setOnto('')
    setAcked(false)
    // picker 的状态机对象每渲染新建，但 reset 只依赖 open 边沿——依赖只留 open。
  }, [open])

  // run 闭包在调用时读取当轮渲染的 plan（propsRef 每渲染捕获最新 props）。
  const { pending, error, run } = useDialogAction<RebaseResult>({
    open,
    run: async () => face.rebase(plan.options!),
    onDone: () => {
      onClose()
      onDone()
    },
  })

  const plan = rebasePlan({ upstream: picker.effective ?? '', onto, headOid, acked })
  const enabled = plan.valid && plan.options !== null && !pending && confirmButtonEnabled(plan.severity, acked)

  const onConfirm = (): void => {
    if (!enabled || plan.options === null) return
    void run()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('rebase.title')}
      closeLabel={t('confirm.cancel')}
      footer={(
        <>
          <Button variant='outline' className='dsh-git-rebase-dialog__cancel' onClick={() => { onClose() }}>
            {t('confirm.cancel')}
          </Button>
          <Button
            variant='primary'
            className='dsh-git-rebase-dialog__confirm'
            data-git-rebase-confirm=''
            data-git-rebase-danger=''
            disabled={!enabled}
            onClick={onConfirm}
          >
            {pending ? t('rebase.rebasing') : t('rebase.title')}
          </Button>
        </>
      )}
    >
      <div className='dsh-git-rebase-dialog' data-git-rebase-dialog=''>
        {error !== null && <GitErrorNotice error={error} t={t} />}
        {headName !== null && (
          <p className='dsh-git-rebase-dialog__current' data-git-rebase-current=''>
            {t('rebase.currentBranch', { name: headName })}
          </p>
        )}
        <DialogBranchPickerField
          model={picker}
          label={t('rebase.upstreamLabel')}
          classBase='dsh-git-rebase-dialog'
          anchorData={{ 'data-git-rebase-picker': '' }}
          emptyLabel={t('rebase.upstreamEmpty')}
        />
        <label className='dsh-git-rebase-dialog__field-label' htmlFor='dsh-git-rebase-onto'>
          {t('rebase.ontoLabel')}
        </label>
        <Input
          id='dsh-git-rebase-onto'
          className='dsh-git-rebase-dialog__onto'
          data-git-rebase-onto=''
          value={onto}
          onChange={(event) => { setOnto(event.target.value) }}
        />
        <p className='dsh-git-rebase-dialog__rewrite-note' data-git-rebase-rewrite-note=''>
          {t('rebase.rewriteNote')}
        </p>
        <Checkbox
          className='dsh-git-rebase-dialog__checkbox'
          checked={acked}
          label={t('confirm.dangerCheckbox')}
          onChange={setAcked}
        />
      </div>
    </Modal>
  )
}
