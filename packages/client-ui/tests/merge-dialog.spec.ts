/**
 * merge / rebase 对话框纯视图模型测试（V3 批次二 [28][29]；v3-implementation-plan
 * §4.7 client 纯函数范式「新 merge-dialog.spec.ts（ff 三态→命令参数纯函数/对话框
 * 校验/danger 闸）」）：
 *   - mergePlan：ff 三态 → 命令参数映射（fastForward 原样过线 / message 仅 no-ff 且
 *     非空组装——wire 可选入参省略纪律）/ 对话框校验（headName/headOid/branch 缺席）
 *     / danger 闸状态机（severity 恒 danger、acked 未过 ⇒ options null）；
 *   - rebasePlan：upstream 必填 / onto 可选（空 = omit）/ danger 闸状态机；
 *   - branchPickerEntries：对话框 picker 选项（当前分支排除 / detached 空清单）。
 */

import { describe, expect, it } from 'vitest'
import { branchPickerEntries } from '../src/client/ui-model.ts'
import { mergePlan, rebasePlan } from '../src/client/admin-view-model.ts'
import type { MergeFastForward } from '../src/client/admin-view-model.ts'

function mergeInput(overrides: Partial<Parameters<typeof mergePlan>[0]> = {}): Parameters<typeof mergePlan>[0] {
  return {
    branch: 'feature',
    fastForward: 'auto',
    message: '',
    headName: 'main',
    headOid: 'a'.repeat(40),
    acked: true,
    ...overrides,
  }
}

describe('mergePlan — ff 三态 → 命令参数纯函数', () => {
  it.each(['auto', 'ff-only', 'no-ff'] as const)('fastForward=%s 原样过线；acknowledged/baseRevision 按 time-travel 同款组装', (fastForward) => {
    const plan = mergePlan(mergeInput({ fastForward }))
    expect(plan.valid).toBe(true)
    expect(plan.options).toEqual({
      branch: 'feature',
      fastForward: fastForward as MergeFastForward,
      acknowledged: true,
      baseRevision: 'a'.repeat(40),
    })
  })

  it('no-ff + 非空 message ⇒ message 组装进 options（trim 后过线）', () => {
    const plan = mergePlan(mergeInput({ fastForward: 'no-ff', message: '  feat: merge feature  ' }))
    expect(plan.options).toMatchObject({ fastForward: 'no-ff', message: 'feat: merge feature' })
  })

  it('no-ff + 空白 message ⇒ message 缺省（不产键——wire 可选入参省略纪律，host --no-edit）', () => {
    const plan = mergePlan(mergeInput({ fastForward: 'no-ff', message: '   ' }))
    expect(plan.options).not.toHaveProperty('message')
    expect(plan.options).not.toBeNull()
  })

  it('auto / ff-only 恒不组装 message（编辑面仅在 no-ff——plan §4.6；git 对 ff 不用 -m）', () => {
    for (const fastForward of ['auto', 'ff-only'] as const) {
      const plan = mergePlan(mergeInput({ fastForward, message: 'ignored' }))
      expect(plan.options).not.toHaveProperty('message')
    }
  })
})

describe('mergePlan — 对话框校验', () => {
  it.each([
    ['headName null（detached/unborn）', { headName: null }],
    ['headOid null（基线缺席）', { headOid: null }],
    ['branch 空（picker 未选且无候选）', { branch: '' }],
    ['branch 纯空白', { branch: '   ' }],
  ])('%s ⇒ valid:false + options null', (_label, overrides) => {
    const plan = mergePlan(mergeInput(overrides))
    expect(plan.valid).toBe(false)
    expect(plan.options).toBeNull()
  })

  it('branch 两端空白 trim 后过线（picker 选择恒为短名，防御外部输入）', () => {
    const plan = mergePlan(mergeInput({ branch: ' feature ' }))
    expect(plan.options).toMatchObject({ branch: 'feature' })
  })
})

describe('mergePlan — danger 闸状态机（合并提交是对外可见动作——severity 恒 danger）', () => {
  it('severity 恒 danger（ff-only 纯快进也移动分支指针——不降档）', () => {
    for (const fastForward of ['auto', 'ff-only', 'no-ff'] as const) {
      expect(mergePlan(mergeInput({ fastForward })).severity).toBe('danger')
    }
  })

  it('acked 未过（勾选闸未确认）⇒ valid:false + options null——host acknowledged 守卫的 UI 对应物', () => {
    const plan = mergePlan(mergeInput({ acked: false }))
    expect(plan.valid).toBe(false)
    expect(plan.severity).toBe('danger')
    expect(plan.options).toBeNull()
  })

  it('闸过（acked）⇒ options 组装且 acknowledged=true 过线', () => {
    const plan = mergePlan(mergeInput())
    expect(plan.valid).toBe(true)
    expect(plan.options).toMatchObject({ acknowledged: true })
  })
})

describe('rebasePlan — upstream 必填 / onto 可选', () => {
  it('upstream 空（picker 未选且无候选）⇒ valid:false + options null', () => {
    const plan = rebasePlan({ upstream: '', onto: '', headOid: 'a'.repeat(40), acked: true })
    expect(plan.valid).toBe(false)
    expect(plan.options).toBeNull()
  })

  it('onto 空 ⇒ omit（不产 onto 键——wire 可选入参省略纪律，plan §4.2「null/缺省 = 不使用 onto」）', () => {
    const plan = rebasePlan({ upstream: 'base', onto: '', headOid: 'a'.repeat(40), acked: true })
    expect(plan.valid).toBe(true)
    expect(plan.options).toEqual({ upstream: 'base', acknowledged: true, baseRevision: 'a'.repeat(40) })
  })

  it('onto 非空 ⇒ trim 后组装 --onto', () => {
    const plan = rebasePlan({ upstream: 'base', onto: ' topic ', headOid: 'a'.repeat(40), acked: true })
    expect(plan.options).toMatchObject({ upstream: 'base', onto: 'topic' })
  })

  it('upstream 两端空白 trim 后过线', () => {
    const plan = rebasePlan({ upstream: ' base ', onto: '', headOid: 'a'.repeat(40), acked: true })
    expect(plan.options).toMatchObject({ upstream: 'base' })
  })
})

describe('rebasePlan — danger 闸状态机（重写历史语义——severity 恒 danger）', () => {
  it('severity 恒 danger；acked 未过 ⇒ valid:false + options null', () => {
    const blocked = rebasePlan({ upstream: 'base', onto: '', headOid: 'a'.repeat(40), acked: false })
    expect(blocked.severity).toBe('danger')
    expect(blocked.valid).toBe(false)
    expect(blocked.options).toBeNull()
  })

  it('headOid null（乐观并发基线缺席）⇒ valid:false + options null', () => {
    const plan = rebasePlan({ upstream: 'base', onto: '', headOid: null, acked: true })
    expect(plan.valid).toBe(false)
    expect(plan.options).toBeNull()
  })

  it('闸过 ⇒ options 组装且 acknowledged=true 过线', () => {
    const plan = rebasePlan({ upstream: 'base', onto: 'topic', headOid: 'a'.repeat(40), acked: true })
    expect(plan.valid).toBe(true)
    expect(plan.options).toMatchObject({ acknowledged: true, baseRevision: 'a'.repeat(40) })
  })
})

describe('branchPickerEntries — 对话框 picker 选项模型', () => {
  const branches = [{ shortName: 'main' }, { shortName: 'feature' }, { shortName: 'topic' }]

  it('当前分支排除（合并/变基自身 = up-to-date 空转——branchCompare/branchReset 同口径）', () => {
    const entries = branchPickerEntries({ branches, headName: 'feature' })
    expect(entries.map((entry) => entry.label)).toEqual(['main', 'topic'])
    expect(entries.every((entry) => entry.id.startsWith('branch-picker:'))).toBe(true)
  })

  it('无当前分支（detached/unborn）⇒ 空清单（装配半以 length 判整行禁用）', () => {
    expect(branchPickerEntries({ branches, headName: null })).toEqual([])
  })
})
