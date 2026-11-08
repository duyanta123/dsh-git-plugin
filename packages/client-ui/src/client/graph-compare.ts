/**
 * dsh-gitkit-ui — 分支对比面板 + 单文件历史 path 模式纯视图模型（V2 批次二 [36]/[60]；
 * plan §4.6）。渲染决策收敛为纯函数（spec §6 纪律），断言面 = tests/graph-compare.spec.ts。
 *
 * 对比数据面 = host `compareBranches()`（plan §4.2 BranchCompareResult：ahead =
 * `base..compare` 独有，behind = `compare..base` 独有；mergeBase 单独回传）。面板
 * 两列（ahead/behind）提交行点击复用 commit-detail-panel（由 GitGraphTab 装配）。
 */

import type { BranchCompareResult } from 'dsh-gitkit/types'
import { formatCommitDate } from './graph-view-model.js'

/** 对比面板一列的提交行。 */
export interface CompareColumnRow {
  oid: string
  shortOid: string
  subject: string
  author: string
  /** `YYYY-MM-DD HH:mm`（formatCommitDate；解析失败 ''）。 */
  date: string
}

/** 对比面板渲染模型。 */
export interface ComparePanelView {
  base: string
  /** 对比参照（= 当前分支）。 */
  compare: string
  mergeBase: string | null
  ahead: CompareColumnRow[]
  behind: CompareColumnRow[]
  aheadCount: number
  behindCount: number
}

/** BranchCompareResult → 面板渲染模型（纯函数；行序保持 host 返回序）。 */
export function comparePanelView(result: BranchCompareResult): ComparePanelView {
  const rowOf = (commit: BranchCompareResult['ahead'][number]): CompareColumnRow => ({
    oid: commit.oid,
    shortOid: commit.oid.slice(0, 7),
    subject: commit.subject,
    author: commit.authorName,
    date: formatCommitDate(commit.committedAt),
  })
  return {
    base: result.base,
    compare: result.compare,
    mergeBase: result.mergeBase,
    ahead: result.ahead.map(rowOf),
    behind: result.behind.map(rowOf),
    aheadCount: result.aheadCount,
    behindCount: result.behindCount,
  }
}

/**
 * 对比入口闸（分支选择器「与当前分支比较」行的可用性；plan §4.6）：需要当前分支
 * （detached/unborn/无名 ⇒ 禁用——compare 的 compare 半 = 当前分支）。
 */
export function compareEntryEnabled(branch: {
  name: string | null
  detached: boolean
  unborn: boolean
} | null): boolean {
  return branch !== null && branch.name !== null && !branch.detached && !branch.unborn
}
