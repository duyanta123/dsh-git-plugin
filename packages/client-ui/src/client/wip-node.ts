/**
 * dsh-gitkit-ui — 图首页「未提交改动」合成节点纯视图模型（V2 批次二 [38]；plan §4.6）。
 *
 * **纯 client 合成，零 host 变更**（plan §4.1 [38] 行）：数据 = status 快照四组
 * 计数 + HEAD oid；图首页顶部渲染一条虚线/菱形样式的合成行（样式区分由组件承担，
 * data-git-graph-wip 锚）。`clean === true` 不渲染（[38] 交付口径）；无仓库/检查中
 * 同样不渲染（无快照即无合成依据）。
 *
 * 断言面 = tests/wip-node.spec.ts（clean 不渲染 / 计数合成 / 点击意图）。
 */

import type { GitStatusSnapshot } from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'
import { badgeCount } from './ui-model.js'

/** WIP 节点的渲染模型（null = 不渲染）。 */
export interface WipNodeView {
  /** HEAD oid（合成锚数据；unborn 为 null——unborn 时四组可有 untracked 行）。 */
  headOid: string | null
  /** 四组计数（条目数；UU 同文件跨组重叠按组内条目数原样展示）。 */
  counts: { staged: number; unstaged: number; untracked: number; conflicted: number }
  /** 去重路径总数（badgeCount 同口径——角标一致）。 */
  total: number
  /** 主文案键（graph.wip.label）。 */
  labelKey: GitLocaleKey
  /** 计数行键（graph.wip.counts）与插值。 */
  countsKey: GitLocaleKey
  params: Record<string, number>
  /** 点击意图（打开变更面板——组件映射为 openChanges 回调；模型仅声明语义）。 */
  intent: 'open-changes'
}

/**
 * 状态源快照 → WIP 节点渲染模型（纯函数）。仓库不可用/检查中/快照未就绪/干净工作区
 * ⇒ null（不渲染）。
 */
export function wipNodeViewModel(params: {
  available: boolean
  checking: boolean
  status: GitStatusSnapshot | null
}): WipNodeView | null {
  const snapshot = params.status
  if (!params.available || params.checking || snapshot === null) return null
  if (snapshot.clean) return null
  const counts = {
    staged: snapshot.staged.length,
    unstaged: snapshot.unstaged.length,
    untracked: snapshot.untracked.length,
    conflicted: snapshot.conflicted.length,
  }
  return {
    headOid: snapshot.branch.oid,
    counts,
    total: badgeCount(snapshot),
    labelKey: 'graph.wip.label',
    countsKey: 'graph.wip.counts',
    params: {
      staged: counts.staged,
      unstaged: counts.unstaged,
      untracked: counts.untracked,
      conflicted: counts.conflicted,
    },
    intent: 'open-changes',
  }
}
