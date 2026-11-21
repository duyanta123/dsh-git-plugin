/**
 * dsh-gitkit-ui — GitConflictBar：变更 tab 顶部冲突条 + 内嵌冲突面板（V3 批次一 [13]；
 * Phase 2·client 自 GitChangesTab 拆出）。
 *
 * 自包含半：conflictList 摘要的拉取/裁决——conflicted 计数变化（含落到 0）即 fresh
 * 重取；计数归零**不清摘要**而是以 fresh 结果裁决（中间态在场 operation ≠ null 则
 * 保条——continue 循环的可驱性；终结即清；仓库不可用直接清）。渲染决策吃
 * conflict-view-model.conflictBarView（纯函数半——conflict-view.spec 钉子）。
 *
 * 面板开合相位（open）由拉起方（GitChangesTab 主干）持有：status/mutation/stash 三
 * 处错误条的「解决冲突…」入口要能从外面打开面板——条自身只回吐开合意图。
 *
 * 锚面纪律：data-git-changes-conflict-{bar,toggle,op} 三锚与词典键组
 * （conflict.bar.* / conflict.operation.*）原样迁移。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConflictListResult } from 'dsh-gitkit/types'
import type { NS } from '../locales.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import { conflictBarView } from '../conflict-view-model.js'
import { GitConflictPanel } from './GitConflictPanel.js'

export interface GitConflictBarProps {
  /** 仓库可用投影（false ⇒ 清摘要撤条——view.available 直传）。 */
  available: boolean
  /** status 快照 conflicted 计数（条可见性的常驻判据；变化即 fresh 重取）。 */
  conflictedCount: number
  /** 面板开合相位（主干持有——三处错误条入口要能打开面板）。 */
  open: boolean
  /** 面板开合意图回吐（条按钮 toggle / 面板 onClose）。 */
  onOpenChange(open: boolean): void
  /** 变更动作面（conflictList + 面板五方法消费半——apply 顶层单例闭包）。 */
  ops: GitChangesOpsFace
  /** 面板写动作成功后的宿主刷新（R5 manual 直传——新 status 帧 → 计数随动）。 */
  refresh(): void
  /** 词典翻译（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
}

/** 冲突条（conflicted 非空常驻——不依赖错误路径；中间态在场计数归零也不撤条）。 */
export function GitConflictBar(props: GitConflictBarProps): ReactNode {
  const { available, conflictedCount, open, onOpenChange, ops, refresh, t } = props
  const [summary, setSummary] = useState<ConflictListResult | null>(null)
  // 摘要重取：conflicted 计数变化（含落到 0）即重取一次 conflictList（只读、fresh
  // 扫描）供 operation 徽标与可见性判定。计数归零**不清摘要**而是以 fresh 结果裁决：
  // 中间态仍在场（operation ≠ null——continue 循环待续）则保留（条不撤、面板不卸，
  // 「继续操作」保持可达）；中间态已终结（外部完成/abort）即清。仓库不可用直接清。
  // 面板动作后的精确回吐走 GitConflictPanel 的 onSummary。
  useEffect(() => {
    if (!available) {
      setSummary(null)
      return
    }
    let cancelled = false
    void ops.conflictList().then((result) => {
      if (cancelled) return
      const keep = result.ok && (result.value.conflicts.length > 0 || result.value.operation !== null)
      setSummary(keep ? result.value : null)
    })
    return () => { cancelled = true }
  }, [available, conflictedCount, ops])
  const bar = conflictBarView(conflictedCount, summary?.operation ?? null)
  if (!bar.visible) return null
  return (
    <>
      <div className='dsh-git-changes__conflict-bar' data-git-changes-conflict-bar=''>
        <button
          type='button'
          className='dsh-git-changes__conflict-toggle'
          data-git-changes-conflict-toggle=''
          aria-expanded={open}
          onClick={() => { onOpenChange(!open) }}
        >
          {t(bar.labelKey, bar.params)}
        </button>
        {bar.operationKey !== null && (
          <span className='dsh-git-changes__conflict-op' data-git-changes-conflict-op=''>
            {t(bar.operationKey)}
          </span>
        )}
      </div>
      {open && (
        <GitConflictPanel
          open
          t={t}
          ops={ops}
          onClose={() => { onOpenChange(false) }}
          onMutated={refresh}
          onSummary={setSummary}
        />
      )}
    </>
  )
}
