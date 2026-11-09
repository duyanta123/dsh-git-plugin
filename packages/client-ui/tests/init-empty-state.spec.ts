/**
 * [8] 初始化空态引导纯视图模型测试（V2 批次四；plan §6.7「新 init-empty-state.spec.ts
 * （空态视图模型 / workspaceOverride 不显示 / 确认流）」）。
 *
 * workspaceOverride 钉死态的判定口径（init-empty-state.ts 头注如实登记）：wire 面无
 * 「钉死且可解析」信号，可判别近似 = 错误码分态——session-workspace-unresolved（含
 * 钉死路径解析不了）⇒ 不显示；no-repository（workspace 已解析、只是不是仓库）⇒ 显示。
 */

import { describe, expect, it } from 'vitest'
import { initEmptyStateView, initMenuEntryVisible } from '../src/client/init-empty-state.ts'
import type { GitErrorLike } from '../src/client/remote/mount.ts'

function errorOf(code: string): GitErrorLike {
  return { code, message: `msg-${code}` }
}

const NO_REPO = { available: false, checking: false, statusError: errorOf('git/no-repository') }

describe('initEmptyStateView — 空态卡片可见性矩阵', () => {
  it('no-repository（workspace 已解析、不是仓库）⇒ 显示卡片', () => {
    const view = initEmptyStateView(NO_REPO)
    expect(view).not.toBeNull()
    expect(view?.titleKey).toBe('init.card.title')
    expect(view?.bodyKey).toBe('init.card.body')
    expect(view?.actionKey).toBe('init.card.action')
    expect(view?.runningKey).toBe('init.card.running')
    expect(view?.intent).toBe('init-and-refresh')
  })

  it('session-workspace-unresolved（无可用目标目录，覆盖 workspaceOverride 钉死解析不了）⇒ 不显示', () => {
    expect(initEmptyStateView({
      available: false,
      checking: false,
      statusError: errorOf('git/session-workspace-unresolved'),
    })).toBeNull()
  })

  it('检查中 / 已可用 / 无错误 ⇒ 不显示（可用仓库空态由 changes.empty 承担）', () => {
    expect(initEmptyStateView({ available: false, checking: true, statusError: null })).toBeNull()
    expect(initEmptyStateView({ available: true, checking: false, statusError: null })).toBeNull()
    expect(initEmptyStateView({ available: false, checking: false, statusError: null })).toBeNull()
    // 可用仓库即使残留错误帧也不显示引导（错误条承担）。
    expect(initEmptyStateView({ available: true, checking: false, statusError: errorOf('git/no-repository') })).toBeNull()
  })

  it('其它域码的不可用帧 ⇒ 不显示（错误条透传）', () => {
    expect(initEmptyStateView({
      available: false,
      checking: false,
      statusError: errorOf('gateway/service-unavailable'),
    })).toBeNull()
  })
})

describe('initMenuEntryVisible — header「初始化 Git 仓库…」行判定', () => {
  it('与卡片同口径：恰 no-repository 可见（单点实现两处消费）', () => {
    expect(initMenuEntryVisible(NO_REPO)).toBe(true)
    expect(initMenuEntryVisible({
      available: false,
      checking: false,
      statusError: errorOf('git/session-workspace-unresolved'),
    })).toBe(false)
    expect(initMenuEntryVisible({ available: true, checking: false, statusError: null })).toBe(false)
    expect(initMenuEntryVisible({ available: false, checking: true, statusError: null })).toBe(false)
  })
})

describe('确认流（plan §6.7）— 成功后 refresh 意图', () => {
  it('卡片 intent 恒 init-and-refresh（组件映射为 runInit 成功分支的 refresh()）', () => {
    const view = initEmptyStateView(NO_REPO)
    expect(view?.intent).toBe('init-and-refresh')
  })
})
