/**
 * 推送对话框纯视图模型测试（V2 批次一 [27][57]；plan §3.7 client 纯函数范式）：
 *   - remote picker 可见性纯函数（needsPushDialog：remotes>1 开对话框，≤1 直推）；
 *   - force→danger 闸状态机（pushDialogView.forceGate：force 勾选 → 确认转 danger
 *     二次确认；勾选闸过 → options 组装 force+acknowledged——host 守卫的双闸 UI 半）；
 *   - setUpstream 提示行、分支可用闸、options 组装（remote 目标直传）。
 */

import { describe, expect, it } from 'vitest'
import type { RemoteInfo } from 'dsh-gitkit/types'
import { needsPushDialog, pushDialogView } from '../src/client/admin-view-model.ts'
import type { PushDialogInput } from '../src/client/admin-view-model.ts'

function remote(name: string): RemoteInfo {
  return { name, url: `https://example.com/${name}.git`, pushUrl: null }
}

function input(overrides: Partial<PushDialogInput> = {}): PushDialogInput {
  return {
    remotes: [remote('origin')],
    selectedRemote: null,
    branch: { name: 'main', upstream: 'origin/main', detached: false, unborn: false },
    force: false,
    forceAcked: false,
    pending: false,
    ...overrides,
  }
}

describe('needsPushDialog — remote picker 可见性纯函数', () => {
  it('remotes>1 ⇒ 开对话框（remote picker）；remotes≤1 ⇒ 一步直推（v1 行为不回归）', () => {
    expect(needsPushDialog(2)).toBe(true)
    expect(needsPushDialog(3)).toBe(true)
    expect(needsPushDialog(1)).toBe(false)
    expect(needsPushDialog(0)).toBe(false)
  })
})

describe('pushDialogView — remote picker 渲染模型', () => {
  it('selectedRemote 缺省取首个远端；choices 标记当前选中', () => {
    const view = pushDialogView(input({ remotes: [remote('origin'), remote('upstream')] }))
    expect(view.selectedRemote).toBe('origin')
    expect(view.remoteChoices).toEqual([
      { name: 'origin', url: 'https://example.com/origin.git', current: true },
      { name: 'upstream', url: 'https://example.com/upstream.git', current: false },
    ])
  })

  it('显式 selectedRemote 生效', () => {
    const view = pushDialogView(input({ remotes: [remote('origin'), remote('upstream')], selectedRemote: 'upstream' }))
    expect(view.selectedRemote).toBe('upstream')
    expect(view.remoteChoices.map((choice) => choice.current)).toEqual([false, true])
  })

  it('无远端 ⇒ 选中 null、confirm 禁用（options null）', () => {
    const view = pushDialogView(input({ remotes: [] }))
    expect(view.selectedRemote).toBeNull()
    expect(view.canConfirm).toBe(false)
    expect(view.options).toBeNull()
  })
})

describe('pushDialogView — 分支可用闸与 setUpstream 提示', () => {
  it('upstream 缺失 ⇒ 提示行可见 + options.setUpstream=true', () => {
    const view = pushDialogView(input({ branch: { name: 'main', upstream: null, detached: false, unborn: false } }))
    expect(view.showSetUpstreamNote).toBe(true)
    expect(view.options).toMatchObject({ setUpstream: true, remote: 'origin' })
  })

  it('upstream 在场 ⇒ 无提示行 + setUpstream=false', () => {
    const view = pushDialogView(input())
    expect(view.showSetUpstreamNote).toBe(false)
    expect(view.options).toMatchObject({ setUpstream: false })
  })

  it.each([
    ['null 快照', null],
    ['detached', { name: null, upstream: null, detached: true, unborn: false }],
    ['unborn', { name: 'main', upstream: null, detached: false, unborn: true }],
    ['无名分支', { name: null, upstream: null, detached: false, unborn: false }],
  ])('分支不可用（%s）⇒ confirm 禁用 + options null', (_label, branch) => {
    const view = pushDialogView(input({ branch }))
    expect(view.canConfirm).toBe(false)
    expect(view.options).toBeNull()
  })

  it('pending ⇒ confirm 禁用', () => {
    const view = pushDialogView(input({ pending: true }))
    expect(view.canConfirm).toBe(false)
    expect(view.options).toBeNull()
  })
})

describe('pushDialogView — force→danger 闸状态机（双闸 UI 半）', () => {
  it('force 未勾选 ⇒ 确认直跑（ask=false），options 无 force/acknowledged', () => {
    const view = pushDialogView(input({ force: false }))
    expect(view.forceGate).toEqual({ ask: false, confirmed: false })
    expect(view.options).not.toBeNull()
    expect(view.options).not.toHaveProperty('force')
    expect(view.options).not.toHaveProperty('acknowledged')
  })

  it('force 勾选未过勾选闸 ⇒ ask=true、options null（确认点击转 danger 二次确认）', () => {
    const view = pushDialogView(input({ force: true, forceAcked: false }))
    expect(view.forceGate).toEqual({ ask: true, confirmed: false })
    expect(view.canConfirm).toBe(true) // 对话框确认按钮可点（点它开 danger 框）
    expect(view.options).toBeNull() // 但入参未组装——直跑被闸断
  })

  it('force 勾选 + danger 勾选闸过 ⇒ options 携带 force+acknowledged（host 守卫的 UI 对应物）', () => {
    const view = pushDialogView(input({ force: true, forceAcked: true }))
    expect(view.forceGate).toEqual({ ask: true, confirmed: true })
    expect(view.options).toEqual({ setUpstream: false, force: true, acknowledged: true, remote: 'origin' })
  })

  it('闸未过的 force 组装被禁 ⇔ 任一闸缺失都不产 options', () => {
    expect(pushDialogView(input({ force: true, forceAcked: false, selectedRemote: null })).options).toBeNull()
    expect(pushDialogView(input({ force: false, forceAcked: true })).options).not.toBeNull()
  })
})
