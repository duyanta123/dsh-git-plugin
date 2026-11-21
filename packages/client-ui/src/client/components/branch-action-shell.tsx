/**
 * dsh-gitkit-ui — branch-action-shell：GitMergeDialog / GitRebaseDialog 共享的
 * branch picker + radiogroup 壳（Phase 2·client；两对话框约 85% 同构——picker
 * 开合状态/清单/缺省选中/'branch-picker:' 前缀剥装与单选按钮组渲染收敛于此）。
 *
 * 对话框各自的 data-* 锚名、className 词根、文案键、字段排布（merge 的 ff 三态 +
 * message / rebase 的 onto）留在调用方——锚名与视觉结构逐字节保真，本壳只收敛
 * 逻辑同构面：
 *  - `useDialogBranchPicker`：picker 状态机（entries 模型 + 缺省取首个候选 +
 *    选中剥前缀 + 开框 reset）；
 *  - `DialogBranchPickerField`：field-label + Menu 浮层渲染（anchor data 锚由
 *    调用方以字面量传入，TSX 连字符属性逐字保真）；
 *  - `DialogRadioGroup`：role='radiogroup' 按钮组渲染（merge ff 三态消费；
 *    reset 对话框同构面留待后续批次）。
 */

import { useMemo, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo } from 'dsh-gitkit/types'
import { BRANCH_PICKER_PREFIX, branchPickerEntries } from '../ui-model.js'
import type { HeaderSubmenuEntry } from '../ui-model.js'
import type { NS } from '../locales.js'

/** 词典键（t 的合法键面——LocaleKeysOf<'git'>）。 */
type DialogLabelKey = Parameters<TranslateNS<typeof NS>>[0]

/** picker 状态机面（useDialogBranchPicker 返回值）。 */
export interface DialogBranchPickerModel {
  /** branchPickerEntries 模型（当前分支排除 / 无当前分支空清单）。 */
  entries: HeaderSubmenuEntry[]
  /** 选中分支短名（未选时缺省取首个候选；无候选 ⇒ null——确认禁用）。 */
  effective: string | null
  /** Menu 浮层开合。 */
  open: boolean
  setOpen(open: boolean): void
  /** Menu onSelect：剥 'branch-picker:' 前缀并收起浮层。 */
  select(id: string): void
  /** 开框 reset（上一轮选择不延续；浮层收起）。 */
  reset(): void
}

/** 分支动作对话框的 picker 状态机（merge/rebase 共享壳）。 */
export function useDialogBranchPicker(input: {
  branches: readonly RefInfo[]
  headName: string | null
}): DialogBranchPickerModel {
  const { branches, headName } = input
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const entries = useMemo(
    () => branchPickerEntries({ branches, headName }),
    [branches, headName],
  )
  // 缺省取首个候选（picker 未选时）；无候选 ⇒ null（确认禁用）。
  const effective = selected ?? entries[0]?.label ?? null
  return {
    entries,
    effective,
    open,
    setOpen,
    select: (id: string) => {
      setSelected(id.slice(BRANCH_PICKER_PREFIX.length))
      setOpen(false)
    },
    reset: () => {
      setOpen(false)
      setSelected(null)
    },
  }
}

/** anchor data 锚（连字符属性字面量由调用方传入——锚名逐字节保真）。 */
export type DialogBranchPickerAnchorData =
  | { 'data-git-merge-picker': '' }
  | { 'data-git-rebase-picker': '' }

/** 分支 picker 字段（field-label + Menu 浮层——merge/rebase 共享壳）。 */
export function DialogBranchPickerField(props: {
  model: DialogBranchPickerModel
  label: string
  /** className 词根（'dsh-git-merge-dialog' / 'dsh-git-rebase-dialog'）。 */
  classBase: string
  anchorData: DialogBranchPickerAnchorData
  emptyLabel: string
}): ReactNode {
  const { model, label, classBase, anchorData, emptyLabel } = props
  return (
    <div className={`${classBase}__field`}>
      <span className={`${classBase}__field-label`}>{label}</span>
      <Menu
        open={model.open}
        anchor={(
          <button
            type='button'
            className={`${classBase}__picker`}
            {...anchorData}
            aria-haspopup='menu'
            aria-expanded={model.open}
            disabled={model.entries.length === 0}
            data-modal-autofocus=''
            onClick={() => { model.setOpen(!model.open) }}
          >
            {model.effective ?? emptyLabel}
          </button>
        )}
        items={model.entries.map((entry) => ({ id: entry.id, label: entry.label }))}
        selectedId={model.effective === null ? undefined : `${BRANCH_PICKER_PREFIX}${model.effective}`}
        onSelect={(id) => { model.select(id) }}
        onClose={() => { model.setOpen(false) }}
        className={`${classBase}__picker-anchor`}
      />
    </div>
  )
}

/** 单选按钮组（role='radiogroup'；merge ff 三态消费——渲染序 = wire 枚举序）。 */
export function DialogRadioGroup<M extends string>(props: {
  modes: readonly M[]
  value: M
  onChange(value: M): void
  label: string
  labelKeys: Readonly<Record<M, DialogLabelKey>>
  classBase: string
  /** data 锚名（'data-git-merge-ff' / 'data-git-reset-kind'——连字面量保真）。 */
  dataAnchor: string
  t: TranslateNS<typeof NS>
}): ReactNode {
  const { modes, value, onChange, label, labelKeys, classBase, dataAnchor, t } = props
  return (
    <>
      <p className={`${classBase}__kind-label`}>{label}</p>
      <div className={`${classBase}__modes`} role='radiogroup' aria-label={label}>
        {modes.map((mode) => (
          <button
            key={mode}
            type='button'
            className={`${classBase}__mode`}
            {...{ [dataAnchor]: mode }}
            role='radio'
            aria-checked={value === mode}
            onClick={() => { onChange(mode) }}
          >
            {t(labelKeys[mode])}
          </button>
        ))}
      </div>
    </>
  )
}
