/**
 * dsh-gitkit-ui — GitCrlfBar：CRLF 行尾提示条（V2 批次三 [56]；Phase 2·client 自
 * GitChangesTab 拆出）。
 *
 * 自包含半：repoDiagnostics 的一次性拉取（仓库可用时；cancelled 兜底防串帧）+
 * 折叠/关闭两个本地相位。渲染决策吃 changes-view-model.crlfBarView（纯函数半——
 * changes-view-model.spec 钉子：可见性 = mixedEolFiles 非空，worktreeCrlfCount 不
 * 折算混用数）。条本体可折叠、不阻断。
 *
 * 锚面纪律：data-git-changes-crlf* 六锚与词典键组（changes.crlf.*）原样迁移，
 * verify:load/组合断言依赖不变。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepoDiagnostics } from 'dsh-gitkit/types'
import type { NS } from '../locales.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import { crlfBarView } from '../changes-view-model.js'

export interface GitCrlfBarProps {
  /** 仓库可用投影（false ⇒ 不拉诊断——view.available 直传）。 */
  available: boolean
  /** 变更动作面（repoDiagnostics 消费半——apply 顶层单例闭包）。 */
  ops: GitChangesOpsFace
  /** 词典翻译（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
}

/** CRLF 提示条（autocrlf 生效值 + mixedEolFiles 摘要；可折叠，不阻断）。 */
export function GitCrlfBar(props: GitCrlfBarProps): ReactNode {
  const { available, ops, t } = props
  const [diagnostics, setDiagnostics] = useState<RepoDiagnostics | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // 仓库可用时取一次行尾诊断（只读、可折叠、不阻断；cancelled 兜底防串帧）。
  useEffect(() => {
    if (!available) return
    let cancelled = false
    void ops.repoDiagnostics().then((result) => {
      if (!cancelled) setDiagnostics(result.ok ? result.value : null)
    })
    return () => { cancelled = true }
  }, [available, ops])
  const crlf = crlfBarView(diagnostics)
  if (!crlf.visible || dismissed) return null
  return (
    <div className='dsh-git-changes__crlf' data-git-changes-crlf=''>
      <span className='dsh-git-changes__crlf-title' data-git-changes-crlf-title=''>{t('changes.crlf.title')}</span>
      <span className='dsh-git-changes__crlf-summary' data-git-changes-crlf-summary=''>
        {t('changes.crlf.summary', { value: crlf.unset ? t('changes.crlf.unset') : crlf.value, count: crlf.mixedCount })}
      </span>
      <button
        type='button'
        className='dsh-git-changes__crlf-toggle'
        data-git-changes-crlf-toggle=''
        aria-expanded={expanded}
        onClick={() => { setExpanded(!expanded) }}
      >
        {t('common.details')}
      </button>
      <button
        type='button'
        className='dsh-git-changes__crlf-dismiss'
        data-git-changes-crlf-dismiss=''
        onClick={() => { setDismissed(true) }}
      >
        {t('common.close')}
      </button>
      {expanded && (
        <p className='dsh-git-changes__crlf-files' data-git-changes-crlf-files=''>
          {t('changes.crlf.files', { files: crlf.mixedFiles.length > 0 ? crlf.mixedFiles.join(', ') : '—' })}
        </p>
      )}
    </div>
  )
}
