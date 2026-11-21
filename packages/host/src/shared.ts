/**
 * dsh-gitkit — 会话事件载荷窄化助手（Phase 2 杂项助手收口：session-watch.ts ≡
 * automation.ts 的模块私有同款副本提为共享）。
 *
 * 收口纪律：函数体与窄化语义逐字保真——两处原副本（含各自注释口径）合并为一份，
 * 事件形状闸（safe integer / 未知形状 = null）不变；该闸是 session-watch 降级守卫
 * （缺 seq/turn 跳过条目，绝不炸监听）与 automation 退化插值占位（'-'）的共同地基。
 */

/** 单事件载荷的最小判别形状（`workspace/changes` / `turn/start` / `turn/end` 共用 `{ turn }` 骨架）。 */
interface TurnEventData {
  turn?: unknown
  reason?: unknown
}

/**
 * 载荷 `{ turn }` 骨架窄化（safe integer 且 ≥0 才收；缺席/病形 = null）。
 * session-watch：该事件条目跳过（降级 debug）；automation：退化插值占位 '-'。
 */
export function turnOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const turn = (data as TurnEventData).turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

/** turn/end reason 的 kind 提取（dsh TurnEndReason = `{ kind: … }` 和型；未知形状 = null）。 */
export function reasonKindOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const kind = (data as TurnEventData).reason
  if (typeof kind !== 'object' || kind === null) return null
  const value = (kind as { kind?: unknown }).kind
  return typeof value === 'string' ? value : null
}
