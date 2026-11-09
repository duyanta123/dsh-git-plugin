/**
 * PR 对话框与 [69] 关联展示纯视图模型测试（V2 批次四 [46][69]；plan §6.7「PR 对话框
 * 视图模型（校验 / draft / danger 闸）」）。
 */

import { describe, expect, it } from 'vitest'
import type { PrLinkResult, RefInfo } from 'dsh-gitkit/types'
import {
  prBaseChoices, prDialogView, prLinkView, prUrlNumber,
} from '../src/client/pr-view-model.ts'

function ref(partial: Partial<RefInfo> & Pick<RefInfo, 'type' | 'shortName'>): RefInfo {
  return { fullName: `refs/x/${partial.shortName}`, oid: 'a'.repeat(40), upstreamTrack: null, ...partial }
}

function view(overrides: Partial<Parameters<typeof prDialogView>[0]> = {}) {
  return prDialogView({
    title: 'feat: add thing',
    body: 'Some body.',
    base: 'main',
    head: 'feature/x',
    draft: false,
    acked: false,
    pending: false,
    ...overrides,
  }, prBaseChoices({ refs: [
    ref({ type: 'local-branch', shortName: 'main' }),
    ref({ type: 'local-branch', shortName: 'feature/x' }),
    ref({ type: 'remote-branch', shortName: 'origin/main' }),
  ], headName: 'feature/x' }))
}

describe('prDialogView — 校验', () => {
  it('标题 trim 后非空才 valid；canConfirm = 标题合法 + head 可用 + 空闲', () => {
    expect(view().titleValid).toBe(true)
    expect(view({ title: '   ' }).titleValid).toBe(false)
    expect(view({ title: '   ' }).canConfirm).toBe(false)
    expect(view({ head: null }).canConfirm).toBe(false)
    expect(view({ pending: true }).canConfirm).toBe(false)
    expect(view().canConfirm).toBe(true)
  })

  it('base 选项排除当前分支；本地 + 远端分支都在清单', () => {
    const choices = prBaseChoices({ refs: [
      ref({ type: 'local-branch', shortName: 'main' }),
      ref({ type: 'local-branch', shortName: 'feature/x' }),
      ref({ type: 'remote-branch', shortName: 'origin/main' }),
      ref({ type: 'tag', shortName: 'v1.0.0' }),
    ], headName: 'feature/x' })
    expect(choices).toEqual([
      { name: 'main', kind: 'local' },
      { name: 'origin/main', kind: 'remote' },
    ])
  })

  it('base 未选 ⇒ options.base = null（wire 可选——host 半 gh 缺省推断远端默认分支）', () => {
    const assembled = view({ base: null, acked: true })
    expect(assembled.options?.base).toBeNull()
  })

  it('options 组装：title trim、body 直传、draft 直传、acknowledged 恒 true（调用契约）', () => {
    const assembled = view({ title: '  feat: x  ', draft: true, acked: true })
    expect(assembled.options).toEqual({
      title: 'feat: x',
      body: 'Some body.',
      base: 'main',
      head: 'feature/x',
      draft: true,
      acknowledged: true,
    })
  })
})

describe('prDialogView — danger 闸（plan §6.6「创建 danger 确认」）', () => {
  it('确认可点 ≠ 可发起：acknowledged false（勾选闸未过）⇒ options null', () => {
    const state = view({ acked: false })
    expect(state.canConfirm).toBe(true)
    expect(state.dangerGate.ask).toBe(true)
    expect(state.dangerGate.confirmed).toBe(false)
    expect(state.options).toBeNull()
  })

  it('勾选闸过（acked=true）⇒ confirmed 且 options 就绪', () => {
    const state = view({ acked: true })
    expect(state.dangerGate.confirmed).toBe(true)
    expect(state.options).not.toBeNull()
  })

  it('pending 期间闸关闭（不可重复发起）', () => {
    const state = view({ acked: true, pending: true })
    expect(state.dangerGate.ask).toBe(false)
    expect(state.options).toBeNull()
  })
})

describe('prUrlNumber — PR 号解析', () => {
  it('GitHub /pull/<n> 形态优先', () => {
    expect(prUrlNumber('https://github.com/org/repo/pull/123')).toBe(123)
    expect(prUrlNumber('https://github.com/org/repo/pull/45/files')).toBe(45)
  })

  it('其它形态取末段整数；无整数 ⇒ null', () => {
    expect(prUrlNumber('https://git.example.com/repo/merge_requests/9')).toBe(9)
    expect(prUrlNumber('https://git.example.com/repo')).toBeNull()
  })
})

describe('prLinkView — [69] 静默降级', () => {
  it('ok:true value:null（无关联）⇒ null 不占位', () => {
    expect(prLinkView({ ok: true, value: null })).toBeNull()
  })

  it('ok:false（查询失败/gh 缺失）⇒ null 不占位不报错', () => {
    expect(prLinkView({ ok: false, error: { code: 'git/pr-tool-missing' } })).toBeNull()
    expect(prLinkView(null)).toBeNull()
  })

  it('关联结果 → url + 解析号 + state', () => {
    const link: PrLinkResult = { url: 'https://github.com/org/repo/pull/12', state: 'OPEN' }
    expect(prLinkView({ ok: true, value: link })).toEqual({
      url: 'https://github.com/org/repo/pull/12',
      number: 12,
      state: 'OPEN',
    })
  })
})
