/**
 * Phase 2·client 前置 — useAsyncAction hook 绑定面（**TDD 红**：当前
 * `../src/client/hooks/useAsyncAction.ts` 尚不存在，交 Hook 提炼师实现）。
 *
 * 测试台 = react-dom/server `renderToStaticMarkup` **初始渲染探针**（node 环境零
 * DOM 依赖；graph-error-surfaces.spec.ts 仓库先例）。hook 交互半（同帧防重入 /
 * busy 翻转 / 错误折叠 / 「busy=false 先于 onDone」时序）由 async-action-core.spec.ts
 * 的纯函数契约（createBusyGate + stepAsyncAction）+ 提交说明 locked 清单的实现契约
 * 承载；本文件锁可渲染半：**返回面键集恰四（busy/error/setError/trigger）+ 初值**。
 */

import { createElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '../src/client/remote/mount.ts'
import { useAsyncAction } from '../src/client/hooks/useAsyncAction.ts'

/**
 * 探针组件：调用真 hook，把返回面编码为管道分隔文本（避免引号/花括号被 React
 * 文本转义干扰 toContain 断言）。键集排序后落盘——多暴露/漏暴露实现键即红。
 */
function AsyncActionProbe(props: { run: () => Promise<RemoteResult<string>>; withOnDone: boolean }): ReactElement {
  const face = useAsyncAction<string>({
    run: props.run,
    ...(props.withOnDone ? { onDone: (value: string) => { void value } } : {}),
  })
  const keys = Object.keys(face).sort().join(',')
  const errorPart = face.error === null ? 'null' : face.error.code
  return createElement('pre', null, `face|${keys}|busy=${String(face.busy)}|error=${errorPart}`)
}

describe('useAsyncAction — 返回面契约（SSR 初始渲染探针；TDD 红：交 Hook 提炼师实现）', () => {
  it('返回面恰四键 busy/error/setError/trigger，初始 busy=false、error=null', () => {
    const markup = renderToStaticMarkup(createElement(AsyncActionProbe, {
      run: async (): Promise<RemoteResult<string>> => ({ ok: true, value: 'settled' }),
      withOnDone: true,
    }))
    expect(markup).toContain('face|busy,error,setError,trigger|busy=false|error=null')
  })

  it('onDone 可省（optional）：只传 run 初渲染不炸、返回面同形', () => {
    const markup = renderToStaticMarkup(createElement(AsyncActionProbe, {
      run: async (): Promise<RemoteResult<string>> => ({ ok: false, error: { code: 'git/timeout', message: 'm' } }),
      withOnDone: false,
    }))
    expect(markup).toContain('face|busy,error,setError,trigger|busy=false|error=null')
  })
})
