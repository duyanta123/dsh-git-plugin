/**
 * dsh-gitkit-ui — stash 面板纯视图模型（V2 批次三 [14]；plan §5.6/§5.7）。
 *
 * 渲染决策收敛为纯函数（组件只做 t/订阅/事件——spec §6 纯函数纪律）：
 * 计数 chip、面板列表行、D4=B 的 includeUntracked 缺省勾选模型与 untracked 计数
 * 提示、pop 冲突提示（plan §5.10「UI 必须明示『应用失败但 stash 保留』」）、drop 的
 * danger 确认载荷（复用 C5 GitConfirmDialog 勾选闸，闸逻辑本身 =
 * ui-model.confirmButtonEnabled）。不依赖 DOM/React 即可断言（tests/stash-view.spec.ts）。
 */

import type { GitStatusSnapshot, StashEntry, StashListResult, StashPushOptions } from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'
import type { GitErrorLike } from './remote/mount.js'

/** D4=B（2026-11-08 拍板）：includeUntracked 缺省 true——wire 显式 boolean，UI 勾选可关。 */
export const STASH_INCLUDE_UNTRACKED_DEFAULT = true

/** 「Stash 全部变更」动作入参（D4=B：includeUntracked 显式过 wire；baseRevision =
 *  discard 三重守卫范式的乐观并发基线可选沿用，plan §5.2）。 */
export function stashPushOptions(includeUntracked: boolean, baseRevision: string | null): StashPushOptions {
  const options: StashPushOptions = { includeUntracked }
  if (baseRevision !== null) options.baseRevision = baseRevision
  return options
}

/** 顶部 stash 计数 chip 的渲染模型（计数未知/为 0 → 无计数形态）。 */
export interface StashChipView {
  labelKey: GitLocaleKey
  params: Record<string, number>
}

export function stashChipView(count: number | null): StashChipView {
  if (count === null || count === 0) return { labelKey: 'stash.chip', params: {} }
  return { labelKey: 'stash.chipCount', params: { count } }
}

/** 面板列表行渲染模型。 */
export interface StashRowView {
  index: number
  message: string
  shortOid: string
}

/** StashListResult → 面板列表行（stashList 为空 → 空清单 → 面板显示 stash.empty）。 */
export function stashRows(result: StashListResult): StashRowView[] {
  return result.stashes.map((entry) => ({
    index: entry.index,
    message: entry.message,
    shortOid: entry.shortOid,
  }))
}

/** untracked 计数提示（D4=B：勾选区旁的计数提示——大产物易被卷入，取消路径一击可达）。 */
export function untrackedHint(snapshot: GitStatusSnapshot | null): { visible: boolean; count: number } {
  const count = snapshot?.untracked.length ?? 0
  return { visible: count > 0, count }
}

/** pop 冲突提示：git/merge-conflict（op 'stash-pop'）⇒ 面板明示「stash 保留未丢失」。 */
export function popConflictHint(error: GitErrorLike | null): boolean {
  return error?.code === 'git/merge-conflict'
}

/** drop 的 danger 确认框载荷（severity danger ⇒ GitConfirmDialog 勾选闸生效）。 */
export interface StashDropConfirmView {
  entry: StashEntry
  severity: 'danger'
  /** message 插值参数（{index}/{message}）。 */
  params: { index: number; message: string }
}

export function stashDropConfirmView(entry: StashEntry): StashDropConfirmView {
  return { entry, severity: 'danger', params: { index: entry.index, message: entry.message } }
}

/** 「Stash 全部变更」按钮的禁用闸：仓库可用 + 无在途动作 + 工作区干净时无可 stash（host ⇒ no-paths）。 */
export function stashPushDisabled(available: boolean, clean: boolean, busy: boolean): boolean {
  return !available || clean || busy
}
