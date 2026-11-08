/**
 * dsh-gitkit-ui — 图 tab 顶栏搜索纯视图模型（V2 批次二 [35]；plan §4.6）。
 *
 * 「搜索框（query/author）+ 过滤 chip（有过滤时显示清除）」的渲染决策收敛为纯函数
 * （spec §6 纯函数单测纪律；ui-model.ts / graph-view-model.ts 同款收敛），断言面 =
 * tests/graph-search.spec.ts。
 *
 * 数据半：过滤参数组装进 log 命令的附加参数（plan §4.5——`--grep -F` / `--author`
 * 是 log 命令的附加参数，解析与钳制不变；分页状态机不动）。**wire 纪律**：可选字段
 * 省略传递、不传显式 undefined（CLAUDE.md wire types 契约）——null 过滤不产生键，
 * 既有 graph-store.spec 的 `logCalls` 精确形状断言因此不被无过滤路径破坏。
 *
 * 空结果视图：过滤激活 + 窗口为空 + 非加载中 ⇒ 顶栏空态换 `graph.search.emptyResult`
 * （否则保持既有 `graph.noCommits`——无过滤的空仓库语义不变）。
 */

import type { GitLocaleKey } from './locales.js'

/** 顶栏搜索过滤（null = 该维未激活；组装半 trim，空白串视同未激活）。 */
export interface GraphSearchFilter {
  query: string | null
  author: string | null
}

/** 全空过滤（重置态；store 侧默认值同形）。 */
export const EMPTY_SEARCH_FILTER: GraphSearchFilter = { query: null, author: null }

/** 输入草稿 → 过滤（trim + 空白降 null；两维全空 ⇒ null = 无过滤）。 */
export function normalizeSearchFilter(query: string, author: string): GraphSearchFilter | null {
  const q = query.trim()
  const a = author.trim()
  if (q === '' && a === '') return null
  return { query: q === '' ? null : q, author: a === '' ? null : a }
}

/** 过滤是否激活（任一维非 null）。 */
export function isFilterActive(filter: GraphSearchFilter | null): boolean {
  return filter !== null && (filter.query !== null || filter.author !== null)
}

/**
 * 过滤 → log 命令的过滤参数（组装半；limit/skip 分页参数原样透传）。null 维不产生
 * 键（wire 纪律：可选字段省略传递）——`filter: null` 的产出与 v1 形状逐键相等。
 */
export function searchLogOptions(
  filter: GraphSearchFilter | null,
  limit: number,
  skip: number,
): { limit: number; skip: number; query?: string; author?: string } {
  if (filter === null) return { limit, skip }
  return {
    limit,
    skip,
    ...(filter.query !== null ? { query: filter.query } : {}),
    ...(filter.author !== null ? { author: filter.author } : {}),
  }
}

/** 一枚过滤 chip 的渲染模型。 */
export interface SearchFilterChip {
  key: GitLocaleKey
  params: Record<string, string>
}

/** 过滤 chip 装配（有过滤时逐维一枚；组件在 chips 非空时渲染「清除」钮）。 */
export function searchFilterChips(filter: GraphSearchFilter | null): SearchFilterChip[] {
  if (filter === null) return []
  const chips: SearchFilterChip[] = []
  if (filter.query !== null) chips.push({ key: 'graph.search.chipQuery', params: { query: filter.query } })
  if (filter.author !== null) chips.push({ key: 'graph.search.chipAuthor', params: { author: filter.author } })
  return chips
}

/**
 * 顶栏空态判定（GitGraphTab 的纯决策半）：过滤激活且窗口为空且非加载中 ⇒
 * 「没有匹配的提交」替换既有「没有提交」（无过滤路径恒 false——语义不回归）。
 */
export function searchEmptyResult(params: {
  filter: GraphSearchFilter | null
  commitCount: number
  loading: boolean
}): boolean {
  return isFilterActive(params.filter) && params.commitCount === 0 && !params.loading
}
