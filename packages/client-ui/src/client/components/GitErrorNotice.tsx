/**
 * @dsh-plugin/client-ui-git — C6 GitErrorNotice（spec §3.4 [清单 49/54]）。
 *
 * `code` → error-map 条目 → 词典文案（`{name}` 插值吃 details）；`error.message` 与
 * `details.stderr` 过 M13 redact 后折叠进 `<details>`（stderr 原样展示的口径 =
 * redact 后原样——【前次】:23）；按码渲染动作按钮（动作语义由调用方经 onAction 执行，
 * 本组件不做 RPC）。陌生 code → 透传展示 message（client 容忍陌生码，map §2.4）。
 *
 * 组件自身不做数据获取——props 全量注入（范式：槽组件读 props，map §3.4）。
 */

import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitErrorLike } from '../remote/mount.js'
import type { ErrorAction } from '../error-map.js'
import { errorNoticeView } from '../error-map.js'

/** 动作按钮的词典键（error.action.* 组）。 */
const ACTION_KEYS: Record<ErrorAction, 'error.action.setUpstream' | 'error.action.fetch' | 'error.action.pull' | 'common.retry'> = {
  retry: 'common.retry',
  'set-upstream': 'error.action.setUpstream',
  fetch: 'error.action.fetch',
  pull: 'error.action.pull',
}

export interface GitErrorNoticeProps {
  /** 展示的错误（RemoteResult 的 error 分支投影）。 */
  error: GitErrorLike
  /** 词典翻译（注册 locale: NS 后由框架注入，或由父组件 bind 后传入）。 */
  t: TranslateNS<'git'>
  /** 动作执行（retry/set-upstream/fetch/pull 的业务半）。 */
  onAction?(action: ErrorAction): void
}

/** 错误提示（内嵌组件：ChangesTab/对话框/header 的错误面）。 */
export function GitErrorNotice(props: GitErrorNoticeProps) {
  const { error, t, onAction } = props
  const view = errorNoticeView(error)
  const [detailsOpen, setDetailsOpen] = useState(false)
  return (
    <div className='dsh-git-error-notice' data-git-error-notice='' data-git-error-code={error.code} role='alert'>
      <p className='dsh-git-error-notice__message'>
        {view.key === null ? view.fallbackText : t(view.key, view.params)}
      </p>
      {view.detailsText !== '' && (
        <details
          className='dsh-git-error-notice__details'
          open={detailsOpen}
          onToggle={(event) => { setDetailsOpen((event.target as HTMLDetailsElement).open) }}
        >
          <summary>{t('common.details')}</summary>
          <pre className='dsh-git-error-notice__stderr'>{view.detailsText}</pre>
        </details>
      )}
      {view.actions.length > 0 && onAction !== undefined && (
        <div className='dsh-git-error-notice__actions'>
          {view.actions.map((action) => (
            <button
              key={action}
              type='button'
              className='dsh-git-error-notice__action'
              data-git-error-action={action}
              onClick={() => { onAction(action) }}
            >
              {t(ACTION_KEYS[action])}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
