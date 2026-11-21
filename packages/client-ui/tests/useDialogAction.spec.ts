/**
 * Phase 2·client 前置 — useDialogAction hook 绑定面（**TDD 红**：当前
 * `../src/client/hooks/useDialogAction.ts` 尚不存在，交 Hook 提炼师实现）。
 *
 * 测试台 = react-dom/server `renderToStaticMarkup` **初始渲染探针**（node 环境零
 * DOM 依赖；graph-error-surfaces.spec.ts 仓库先例——"仓库无 jsdom/testing-library
 * 基建"）。hook 的交互半（open 边沿重置 / run 生命周期 / 防重入 / 「先置 pending
 * 再调 onDone」时序）无法在无渲染器环境驱动（act 需 renderer），由
 * dialog-action-core.spec.ts 的纯函数契约 + 提交说明 locked 清单的实现契约承载；
 * 本文件锁可渲染半：**返回面键集恰四（error/pending/run/setError）+ 初值**。
 */

import { createElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '../src/client/remote/mount.ts'
import { useDialogAction } from '../src/client/hooks/useDialogAction.ts'

/**
 * 探针组件：调用真 hook，把返回面编码为管道分隔文本（避免引号/花括号被 React
 * 文本转义干扰 toContain 断言）。键集排序后落盘——多暴露/漏暴露实现键即红。
 */
function DialogActionProbe(props: { open: boolean; run: () => Promise<RemoteResult<string>> }): ReactElement {
  const face = useDialogAction<string>({
    open: props.open,
    run: props.run,
    onDone: (value: string) => { void value },
  })
  const keys = Object.keys(face).sort().join(',')
  const errorPart = face.error === null ? 'null' : face.error.code
  return createElement('pre', null, `face|${keys}|pending=${String(face.pending)}|error=${errorPart}`)
}

describe('useDialogAction — 返回面契约（SSR 初始渲染探针；TDD 红：交 Hook 提炼师实现）', () => {
  it('返回面恰四键 error/pending/run/setError，初始 pending=false、error=null（open:false 挂载）', () => {
    const markup = renderToStaticMarkup(createElement(DialogActionProbe, {
      open: false,
      run: async (): Promise<RemoteResult<string>> => ({ ok: true, value: 'settled' }),
    }))
    expect(markup).toContain('face|error,pending,run,setError|pending=false|error=null')
  })

  it('open:true 首挂同面（初挂无前态——重置语义只认 false→true 边沿，见 dialog-action-core.spec）', () => {
    const markup = renderToStaticMarkup(createElement(DialogActionProbe, {
      open: true,
      run: async (): Promise<RemoteResult<string>> => ({ ok: false, error: { code: 'git/pr-create-failed', message: 'm' } }),
    }))
    expect(markup).toContain('face|error,pending,run,setError|pending=false|error=null')
  })
})
