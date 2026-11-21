/*!
 * Phase 1 评审收口（仓库内重构，非新增移植面）：mutations/refs-admin/remote-ops/
 * time-travel/stash 五份逐字相同的 scanFresh 私有副本 + merge-rebase.ts 内联同款
 * 的共享实现。
 * 来源：仓库内上述引擎文件（各自文件头登记其移植出处）——本文件只做同仓去重，
 * 逐字保真「fresh 扫描 → error 就地抛出 → debug 日志 → 返回 repoRoot+snapshot」。
 * SPDX-License-Identifier: MIT
 */

import type { StatusEngine } from './status.ts'
import type { GitStatusSnapshot } from './types.ts'

/**
 * fresh status 扫描（守卫世界读取 + repoRoot；三态的 error 就地抛出）：
 * `status.current({fresh:true})` 绕 TTL 缓存——路由要此刻的世界；三态的 error
 * 非 null 就地抛出；随后一条 debug 日志（op 前缀），返回 repoRoot + snapshot。
 */
export async function scanFresh(
  status: StatusEngine,
  logger: { debug(message: string): void } | undefined,
  op: string,
  signal?: AbortSignal,
): Promise<{ repoRoot: string; snapshot: GitStatusSnapshot }> {
  const state = await status.current(signal, { fresh: true })
  if (state.error !== null) throw state.error
  logger?.debug(`git ${op}: fresh status scan (repoRoot resolved)`)
  return { repoRoot: state.snapshot.repoRoot, snapshot: state.snapshot }
}
