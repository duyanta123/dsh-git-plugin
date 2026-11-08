/**
 * 图 tab 顶栏搜索纯视图模型测试（V2 批次二 [35]；plan §4.7 client 纯函数范式）：
 *   - 过滤参数组装（normalizeSearchFilter trim/空降 null + searchLogOptions 只在
 *     非空维产键——wire 纪律「可选字段省略传递」，无过滤产出与 v1 形状逐键相等，
 *     graph-store.spec 的 logCalls 精确断言因此不被破坏）；
 *   - 过滤 chip 装配（逐维一枚；无过滤空数组）；
 *   - 空结果视图（过滤激活 + 窗口空 + 非加载中；无过滤路径恒 false）。
 */

import { describe, expect, it } from 'vitest'
import {
  isFilterActive, normalizeSearchFilter, searchEmptyResult, searchFilterChips, searchLogOptions,
} from '../src/client/graph-search.ts'

describe('normalizeSearchFilter — 输入草稿归一', () => {
  it('trim 后非空 ⇒ 两维组装；空白串降 null', () => {
    expect(normalizeSearchFilter('  fix bug  ', '  ')).toEqual({ query: 'fix bug', author: null })
    expect(normalizeSearchFilter('', 'Alice')).toEqual({ query: null, author: 'Alice' })
    expect(normalizeSearchFilter('fix', 'Alice')).toEqual({ query: 'fix', author: 'Alice' })
  })

  it('两维全空（含纯空白）⇒ null = 无过滤', () => {
    expect(normalizeSearchFilter('', '')).toBeNull()
    expect(normalizeSearchFilter('   ', '\t')).toBeNull()
  })
})

describe('isFilterActive / searchFilterChips — chip 装配', () => {
  it('null/全空 ⇒ 未激活 + 空 chips', () => {
    expect(isFilterActive(null)).toBe(false)
    expect(isFilterActive({ query: null, author: null })).toBe(false)
    expect(searchFilterChips(null)).toEqual([])
    expect(searchFilterChips({ query: null, author: null })).toEqual([])
  })

  it('逐维一枚 chip（键 + 插值参数）；两维同开两枚', () => {
    expect(searchFilterChips({ query: 'fix bug', author: null })).toEqual([
      { key: 'graph.search.chipQuery', params: { query: 'fix bug' } },
    ])
    const both = searchFilterChips({ query: 'fix', author: 'Alice' })
    expect(both.map((chip) => chip.key)).toEqual(['graph.search.chipQuery', 'graph.search.chipAuthor'])
    expect(both[1]?.params).toEqual({ author: 'Alice' })
  })
})

describe('searchLogOptions — 过滤参数组装（wire 纪律）', () => {
  it('无过滤 ⇒ 恰 {limit, skip}（不产 query/author 键——v1 logCalls 形状不回归）', () => {
    expect(searchLogOptions(null, 500, 0)).toEqual({ limit: 500, skip: 0 })
    expect(searchLogOptions({ query: null, author: null }, 500, 40)).toEqual({ limit: 500, skip: 40 })
    expect(Object.keys(searchLogOptions(null, 500, 0))).toEqual(['limit', 'skip'])
  })

  it('单维/双维激活 ⇒ 只产非空维的键', () => {
    expect(searchLogOptions({ query: 'fix', author: null }, 500, 0)).toEqual({ limit: 500, skip: 0, query: 'fix' })
    expect(searchLogOptions({ query: null, author: 'Alice' }, 500, 0)).toEqual({ limit: 500, skip: 0, author: 'Alice' })
    expect(searchLogOptions({ query: 'fix', author: 'Alice' }, 500, 20)).toEqual({
      limit: 500, skip: 20, query: 'fix', author: 'Alice',
    })
    expect(Object.keys(searchLogOptions({ query: 'fix', author: null }, 500, 0)).sort())
      .toEqual(['limit', 'query', 'skip'])
  })
})

describe('searchEmptyResult — 空结果视图判定', () => {
  it('过滤激活 + 窗口空 + 非加载中 ⇒ true（「没有匹配的提交」）', () => {
    expect(searchEmptyResult({ filter: { query: 'x', author: null }, commitCount: 0, loading: false })).toBe(true)
  })

  it('加载中/有结果/无过滤 ⇒ false（「没有提交」语义不回归）', () => {
    expect(searchEmptyResult({ filter: { query: 'x', author: null }, commitCount: 0, loading: true })).toBe(false)
    expect(searchEmptyResult({ filter: { query: 'x', author: null }, commitCount: 3, loading: false })).toBe(false)
    expect(searchEmptyResult({ filter: null, commitCount: 0, loading: false })).toBe(false)
    expect(searchEmptyResult({ filter: { query: null, author: null }, commitCount: 0, loading: false })).toBe(false)
  })
})
