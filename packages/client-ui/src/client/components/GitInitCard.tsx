/**
 * dsh-gitkit-ui — [8] 非 git 目录空态引导卡片（共享组件：Phase 1 收口——变更 tab
 * 与提交图 tab 的逐字重复 JSX 消除为单一定义，两处消费）。
 *
 * 纯展示半：渲染决策（title/body/action/running 键）在 init-empty-state.ts 纯函数
 * （initEmptyStateView），本组件只做 t/事件透传（组件纪律同 GitErrorNotice——
 * props 全量注入，不做 RPC）。
 *
 * **锚名不变**：`data-git-init-card` / `data-git-init-title` / `data-git-init-body`
 * / `data-git-init-action` 四锚与 `.dsh-git-init-card*` 类名逐字节保真（verify-load
 * 与 e2e 的断言面）。
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { InitEmptyStateView } from '../init-empty-state.js'
import type { GitErrorLike } from '../remote/mount.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitInitCardProps {
  /** initEmptyStateView 的渲染模型（null = 不渲染——可见性闸门由调用半持有）。 */
  initView: InitEmptyStateView
  /** init 失败错误条（null = 无；git/init-failed 文案带 path/reason）。 */
  initError: GitErrorLike | null
  /** init 在途（按钮禁用 + 文案换 running 键）。 */
  initRunning: boolean
  /** 初始化动作（调用半实现：changes tab 成功 refresh、图 tab 成功后由状态帧驱动）。 */
  runInit: () => void
  /** 词典翻译（注册 locale: NS 后由框架注入，或由父组件 bind 后传入）。 */
  t: TranslateNS<'git'>
}

/** 空态引导卡片（说明 + 初始化按钮；init 失败就地错误条）。 */
export function GitInitCard(props: GitInitCardProps): ReactNode {
  const { initView, initError, initRunning, runInit, t } = props
  return (
    <div className='dsh-git-init-card' data-git-init-card=''>
      <p className='dsh-git-init-card__title' data-git-init-title=''>{t(initView.titleKey)}</p>
      <p className='dsh-git-init-card__body' data-git-init-body=''>{t(initView.bodyKey)}</p>
      {initError !== null && <GitErrorNotice error={initError} t={t} />}
      <button
        type='button'
        className='dsh-git-init-card__action'
        data-git-init-action=''
        disabled={initRunning}
        onClick={runInit}
      >
        {initRunning ? t(initView.runningKey) : t(initView.actionKey)}
      </button>
    </div>
  )
}
