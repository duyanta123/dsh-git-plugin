/**
 * 提交图错误面回归（P2 审查修复三处中的两处 UI 面）：
 *   - graphNoticeRetry —— 顶部错误条的装配优先序 + 重试按来源路由
 *     （refsError ⇒ refreshRefs；log/仓库级 ⇒ reload。修复前 retry 一律 reload）；
 *   - CommitDetailPanel 失败详情重试位 —— 修复前一次失败整会话卡死（error 槽
 *     无重试入口、重选不触发 effect）。断言面：
 *       · GitErrorNotice 的 onAction 只在错误码映射动作全为 retry 时传入——
 *         gateway/service-unavailable 据此渲染动作位，未传则不渲染（评审第 1 轮：
 *         无条件传会让 set-upstream/fetch/pull 码渲染出点击无效的死按钮）；
 *       · 其余失败码（大多数 git/* + set-upstream/fetch/pull 码）由面板自备
 *         重试位承担（GitChangesTab diff-error 既有范式），任意码恰一处重试入口。
 *
 * 渲染断言用 react-dom/server 的 renderToStaticMarkup（node 环境，零 DOM 依赖；
 * 仓库无 jsdom/testing-library 基建，其余用例遵循纯函数纪律）。store 半的
 * 重试/清槽语义在 tests/graph-store.spec.ts。
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CommitDetailPanel } from '../src/client/components/commit-detail-panel.tsx'
import type { CommitDetailPanelProps } from '../src/client/components/commit-detail-panel.tsx'
import { graphNoticeRetry } from '../src/client/graph-view-model.ts'
import type { DetailViewModel } from '../src/client/graph-view-model.ts'
import type { GitErrorLike } from '../src/client/remote/mount.ts'
import { gitZh } from '../src/client/locales.ts'

// commit-detail-panel 的传递 import（FileDiffView → @deepseek-ai/dsh-client-ui-primitives）
// 在真机走注入 require 的 externals（clsx 等 peer 本仓未安装）——工厂 mock 顶住模块
// 装载即可；本套用例不渲染 FileDiffView（view.files 恒空）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  languageForPath: () => null,
  useCodeHighlighter: () => () => undefined,
}))

/** 真词典 t（zh；locales.ts 零 import，进程内直接求值安全）。 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const template = (gitZh as Record<string, string>)[key] ?? key
  return template.replaceAll(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}) as unknown as TranslateNS<'git'>

const errorOf = (code: string, message = 'boom'): GitErrorLike => ({ code, message })

const emptyView: DetailViewModel = {
  subject: 'subject a', shortOid: 'aaaaaaa', author: 't', date: '', body: '', refs: [], files: [], totalTruncated: false,
}

function renderPanel(state: CommitDetailPanelProps['state']): string {
  return renderToStaticMarkup(createElement(CommitDetailPanel, {
    oid: 'a'.repeat(40),
    state,
    view: emptyView,
    t,
    onRetry: vi.fn(),
    onFileClick: vi.fn(),
    onClose: vi.fn(),
  }))
}

describe('graphNoticeRetry — 顶部错误条装配 + 重试来源路由（P2）', () => {
  it('refsError 单独失败 ⇒ source=refs（重试路由到 refreshRefs）', () => {
    const refsError = errorOf('git/git-error', 'refs boom')
    expect(graphNoticeRetry({ logError: null, statusError: null, refsError }))
      .toEqual({ notice: refsError, source: 'refs' })
  })

  it('仓库级 statusError（unavailable 投影）⇒ source=status（清窗重载）', () => {
    const statusError = errorOf('git/no-repository', 'not a repo')
    expect(graphNoticeRetry({ logError: null, statusError, refsError: null }))
      .toEqual({ notice: statusError, source: 'status' })
  })

  it('log 失败优先（与既有 ?? 链同序）：log > status > refs', () => {
    const logError = errorOf('git/timeout', 'slow')
    const statusError = errorOf('git/session-workspace-unresolved', 'unresolved')
    const refsError = errorOf('git/git-error', 'refs boom')
    expect(graphNoticeRetry({ logError, statusError, refsError }).source).toBe('log')
    expect(graphNoticeRetry({ logError: null, statusError, refsError }).source).toBe('status')
    // log 与 status 都缺席才轮到 refs。
    expect(graphNoticeRetry({ logError: null, statusError: null, refsError }).notice).toBe(refsError)
  })

  it('全部为 null ⇒ 无错误条', () => {
    expect(graphNoticeRetry({ logError: null, statusError: null, refsError: null }))
      .toEqual({ notice: null, source: null })
  })
})

describe('CommitDetailPanel — 失败详情重试位（P2 卡死修复）', () => {
  it('映射表无 retry 动作的失败码（git/git-error）⇒ 面板自备重试位（zh 文案复用 common.retry）', () => {
    const markup = renderPanel({ state: 'error', error: errorOf('git/git-error'), pendingPath: null })
    expect(markup).toContain('data-git-graph-detail-error')
    expect(markup).toContain('data-git-graph-detail-retry')
    expect(markup).toContain('>重试</button>')
    // 该码映射无动作 ⇒ notice 自身不出动作位（重试入口恰一处）。
    expect(markup).not.toContain('data-git-error-action')
  })

  it('映射表含 retry 动作的失败码（gateway/service-unavailable）⇒ notice 动作位承担（证明 onAction 已传）且不重复出钮', () => {
    const markup = renderPanel({ state: 'error', error: errorOf('gateway/service-unavailable'), pendingPath: null })
    // GitErrorNotice 只在 onAction !== undefined 时渲染动作位——动作位在场即 onAction 已接线。
    expect(markup).toContain('data-git-error-action="retry"')
    expect(markup).toContain('>重试</button>')
    // 已有 notice 动作位 ⇒ 面板自备重试位不重复渲染。
    expect(markup).not.toContain('data-git-graph-detail-retry')
  })

  it('携带 set-upstream/fetch/pull 动作的码（git/no-upstream、git/diverged）不渲染动作位（死按钮封堵）、重试走面板自备位', () => {
    // 评审第 1 轮：onAction 只在映射动作全为 retry 时传入——这些码 onAction 缺席，
    // GitErrorNotice 的动作行（set-upstream / fetch / pull 按钮）根本不渲染；
    // 可重试性由面板自备重试位保证（评审第 2 轮补的回归锚）。
    for (const code of ['git/no-upstream', 'git/diverged']) {
      const markup = renderPanel({ state: 'error', error: errorOf(code), pendingPath: null })
      expect(markup, code).not.toContain('data-git-error-action')
      expect(markup, code).toContain('data-git-graph-detail-retry')
      expect(markup, code).toContain('>重试</button>')
    }
  })

  it('ready / loading 槽不渲染重试面', () => {
    expect(renderPanel({ state: 'ready', pendingPath: null })).not.toContain('data-git-graph-detail-retry')
    expect(renderPanel({ state: 'loading', pendingPath: null })).not.toContain('data-git-graph-detail-retry')
    expect(renderPanel(undefined)).not.toContain('data-git-graph-detail-retry')
  })
})
