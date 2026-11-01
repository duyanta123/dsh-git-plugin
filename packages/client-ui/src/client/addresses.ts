/**
 * @dsh-plugin/client-ui-git — 右栏 tab 资源地址（本模块 ask §①；spec §3.1）。
 *
 * **变更审查 tab = 会话域地址**：`dsh-resource://git-changes/session/{sessionId}`——
 * 铸造与严格解析照 ui-deliverables changes.ts:143-165 范本（changesReviewAddress /
 * parseChangesReviewAddress：前缀 + 段数 + 逐段校验 + decode 容错）。同地址幂等
 * （tab-registry claim 的 contentId = address 本身，两次 open 同一 Session 是同一个
 * tab——tab-registry.ts:141-154 实读）；不同 Session 各自一个 tab。
 *
 * 提交图 tab 沿用 spec §3.1 的静态地址（graph 模块接线）。
 *
 * `openResource` 对非 `dsh-resource://` 或无人认领的地址 throw（map §3.3）——认领由
 * tab 定义的 patterns（`dsh-resource://git-changes/**`）+ canOpen（严格解析通过）
 * 共同完成；解析不过的地址不属于本插件（本插件铸造之外的形状一律拒绝）。
 */

/** 变更审查 tab 的地址前缀（会话域；后接 encodeURIComponent(sessionId) 单段）。 */
export const GIT_CHANGES_ADDRESS_PREFIX = 'dsh-resource://git-changes/session/'

/** 提交图 tab 的资源地址（GitGraphTab，graph 模块落 body）。 */
export const GIT_GRAPH_ADDRESS = 'dsh-resource://dsh-plugin.git/graph'

/** 变更审查 tab 的会话坐标（解析产物）。 */
export interface GitChangesCoordinates {
  sessionId: string
}

/**
 * 铸造一个会话的变更审查 tab 地址。
 * @param sessionId - 归属会话（slot 框架注入的 session id）。
 * @returns `dsh-resource://git-changes/session/{encoded}` 地址。
 */
export function gitChangesAddress(sessionId: string): string {
  return `${GIT_CHANGES_ADDRESS_PREFIX}${encodeURIComponent(sessionId)}`
}

/**
 * 严格解析一个变更审查 tab 地址（照 ui-deliverables parseChangesReviewAddress 范本）。
 * 规则：前缀命中 → 恰一段 → 非空 → percent 解码不抛错且解码后非空。
 * @param address - 资源地址。
 * @returns 会话坐标；任何其他地址（含本插件铸造之外的形状）→ undefined。
 */
export function parseGitChangesAddress(address: string): GitChangesCoordinates | undefined {
  if (!address.startsWith(GIT_CHANGES_ADDRESS_PREFIX)) return undefined
  const rest = address.slice(GIT_CHANGES_ADDRESS_PREFIX.length)
  // 恰一段：sessionId 编码后不含裸 '/'；多段/空段都不是本插件铸造的形状。
  if (rest === '' || rest.includes('/')) return undefined
  try {
    const sessionId = decodeURIComponent(rest)
    if (sessionId === '') return undefined
    return { sessionId }
  } catch {
    // 坏 percent 序列不是本插件铸造的地址。
    return undefined
  }
}
