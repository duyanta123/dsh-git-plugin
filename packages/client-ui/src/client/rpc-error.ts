/**
 * dsh-gitkit-ui — RPC 失败原因折叠助手（Phase 1 低风险去重提取）。
 *
 * `causeCode`/`causeMessage` 原为六个 store 文件里的逐字私有副本
 * （store/git-status-source.ts、store/git-changes-store.ts、store/git-graph-store.ts、
 * store/git-blame-store.ts、store/git-compare-store.ts、store/checkpoint-store.ts），
 * 本文件收口为唯一定义；函数体逐字节保真，语义不变：
 *  - `cause` 携带字符串 `code`（RemoteError 的域码折叠面，spec §1.0.1）⇒ 原样透传；
 *  - 否则回落载波层折叠码 `gateway/service-unavailable`（GATEWAY_UNAVAILABLE，
 *    remote/mount.ts 的单一权威定义——此处只 import，不复制字面量）；
 *  - `causeMessage`：Error ⇒ message，其余 ⇒ String()。
 * 纯函数、无状态——无模块级句柄。
 */

import { GATEWAY_UNAVAILABLE } from './remote/mount.js'

/** 失败原因的域码：字符串 `code` 原样透传，否则回落 GATEWAY_UNAVAILABLE。 */
export function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

/** 失败原因的消息：Error ⇒ message，其余 ⇒ String(cause)。 */
export function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
