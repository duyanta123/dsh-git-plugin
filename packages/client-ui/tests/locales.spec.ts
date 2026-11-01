/**
 * locale 词典测试（spec §6 stores.spec 的「zh/en 键集一致（§4）」切片 + M14 判据的
 * 测试面镜像；仓库脚本 check:locale 持同一判据并加 JSX 无裸字符串 grep）。
 * 键集权威 = zh 词典（map §3.5）。
 */

import { describe, expect, it } from 'vitest'
import { NS, gitEn, gitZh } from '../src/client/locales.ts'

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string))
}

describe('locale 词典（NS=git；zh 权威）', () => {
  it('NS = git 且双语词典非空', () => {
    expect(NS).toBe('git')
    expect(Object.keys(gitZh).length).toBeGreaterThan(0)
    expect(Object.keys(gitEn).length).toBeGreaterThan(0)
  })

  it('en 与 zh 键集合相等（双向差集为空）', () => {
    const zhKeys = new Set(Object.keys(gitZh))
    const enKeys = new Set(Object.keys(gitEn))
    const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
    const extraInEn = [...enKeys].filter((key) => !zhKeys.has(key))
    expect(missingInEn, `en 缺键: ${missingInEn.join(', ')}`).toEqual([])
    expect(extraInEn, `en 多键: ${extraInEn.join(', ')}`).toEqual([])
  })

  it('每键 en 与 zh 的 {name} 插位集合一致', () => {
    const zhDict = gitZh as Record<string, string>
    const enDict = gitEn as Record<string, string>
    for (const key of Object.keys(gitZh)) {
      const zh = placeholders(zhDict[key] ?? '')
      const en = placeholders(enDict[key] ?? '')
      expect([...en].filter((name) => !zh.has(name)), `${key}: en 多出插位`).toEqual([])
      expect([...zh].filter((name) => !en.has(name)), `${key}: en 缺插位`).toEqual([])
    }
  })

  it('首批键组到齐（header/errors/confirm/problems/shortcut + menu/tab）', () => {
    const keys = new Set(Object.keys(gitZh))
    for (const prefix of ['header.', 'menu.', 'problems.', 'shortcut.', 'tab.', 'confirm.', 'error.', 'common.']) {
      expect([...keys].some((key) => key.startsWith(prefix)), `缺 ${prefix} 组`).toBe(true)
    }
    // spec §4 error 组的种子键（域码逐键 + common 动作）。
    for (const key of [
      'error.no-repository', 'error.identity-missing', 'error.nothing-staged', 'error.empty-message',
      'error.no-upstream', 'error.no-remote', 'error.diverged', 'error.push-rejected', 'error.auth-failed',
      'error.pull-diverged', 'error.timeout', 'error.git-error', 'error.llm-route-unresolved', 'error.llm-failed',
      'common.retry', 'common.details', 'common.close',
    ]) {
      expect(keys.has(key), `缺 ${key}`).toBe(true)
    }
  })

  it('词典值均为非空字符串（无占位对象/空文案）', () => {
    const enDict = gitEn as Record<string, string>
    for (const [key, value] of Object.entries(gitZh)) {
      expect(typeof value, `${key}: 非字符串`).toBe('string')
      expect(value.length, `${key}: 空文案`).toBeGreaterThan(0)
      expect(typeof enDict[key], `${key}: en 非字符串`).toBe('string')
    }
  })
})
