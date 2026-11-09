/**
 * dsh-gitkit-ui — [61] 子模块状态详情的纯视图模型（V2 批次四；plan §6.6）。
 *
 * 交付面：changes tab 文件卡片 submodule 徽标（v1 已渲染布尔位）→「子模块详情」
 * 动作 → 详情面板显示 `submoduleStatus` 列表（path / 当前 oid vs 记录 oid 差异
 * 高亮 / state 徽标）。**只列不递归**（host submodule.ts 同口径，plan §6.5）。
 * 断言面 = tests/submodule-view.spec.ts。
 */

import type { SubmoduleEntry } from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'

/** 子模块详情面板的一行（渲染决策收敛——组件只做 t/渲染）。 */
export interface SubmoduleRow {
  path: string
  /** 当前 HEAD oid（未初始化 ⇒ null——面板展示占位）。 */
  oid: string | null
  /** superproject 记录的 oid（.gitmodules 对应 gitlink；未初始化/缺失 ⇒ null）。 */
  recordedOid: string | null
  /** 当前 oid 与记录 oid 是否不一致（差异高亮的判据——[61] 交付口径）。 */
  mismatch: boolean
  /** state 徽标词条（submodule.state.* 组）。 */
  stateKey: GitLocaleKey
}

/**
 * submoduleStatus 数据 → 详情面板行模型（纯函数；行序保持 host 返回序）。
 * state → 词典键的映射闭合 wire 联合（'clean'|'dirty'|'uninitialized'|'mismatch'|
 * 'unknown'——plan §6.2 SubmoduleEntry.state）；未知形状安全降级 'unknown' 键。
 */
export function submoduleRows(entries: readonly SubmoduleEntry[]): SubmoduleRow[] {
  return entries.map((entry) => ({
    path: entry.path,
    oid: entry.oid,
    recordedOid: entry.recordedOid,
    mismatch: entry.state === 'mismatch'
      || (entry.oid !== null && entry.recordedOid !== null && entry.oid !== entry.recordedOid),
    stateKey: submoduleStateKey(entry.state),
  }))
}

/** state 联合 → 徽标词条（单点映射；漂移形状落 unknown）。 */
export function submoduleStateKey(state: unknown): GitLocaleKey {
  switch (state) {
    case 'clean': return 'submodule.state.clean'
    case 'dirty': return 'submodule.state.dirty'
    case 'uninitialized': return 'submodule.state.uninitialized'
    case 'mismatch': return 'submodule.state.mismatch'
    default: return 'submodule.state.unknown'
  }
}
