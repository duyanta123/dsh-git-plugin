/**
 * error-map 测试（本模块 ask §④；spec §3.4）：
 * Record<GitCode, …> 的穷尽在编译面（host 增删域码即编译错）；本文件运行期再锁
 * ① 全域码都有条目且键值恰等；② 条目的词典键在 zh/en 都存在；③ 动作清单 = spec
 * §3.4 的清单；④ 视图模型（params/details 脱敏/陌生码回落/gateway 条目）。
 */

import { describe, expect, it } from 'vitest'
import type { GitCode } from '../src/client/error-map.ts'
import { ERROR_MAP, GATEWAY_MAP, errorMapEntry, errorNoticeView } from '../src/client/error-map.ts'
import { gitEn, gitZh } from '../src/client/locales.ts'

/** host 包声明过的域码全集（GitCode 类型面镜像；host 增删码时先编译错后改此表）。 */
const ALL_GIT_CODES: readonly GitCode[] = [
  'git/no-repository',
  'git/session-workspace-unresolved',
  'git/identity-missing',
  'git/nothing-staged',
  'git/empty-message',
  'git/no-upstream',
  'git/no-remote',
  'git/diverged',
  'git/push-rejected',
  'git/auth-failed',
  'git/pull-diverged',
  'git/timeout',
  'git/git-error',
  'git/llm-route-unresolved',
  'git/llm-failed',
  'git/no-paths',
  'git/bad-request',
  'git/hook-failed',
  'git/no-branch',
  'git/dirty-worktree',
  'git/choose-remote',
]

describe('ERROR_MAP — Record 穷尽约束（运行期镜像）', () => {
  it('键域恰为 host 声明的域码全集（不多不少）', () => {
    const keys = Object.keys(ERROR_MAP).sort()
    expect(keys).toEqual([...ALL_GIT_CODES].sort())
  })

  it('每个条目的词典键在 zh/en 都存在（词条不悬空）', () => {
    for (const [code, entry] of Object.entries(ERROR_MAP)) {
      expect(gitZh[entry.key], `${code} → ${entry.key}: zh 缺词条`).toBeTruthy()
      expect((gitEn as Record<string, string>)[entry.key], `${code} → ${entry.key}: en 缺词条`).toBeTruthy()
    }
  })

  it('词典 error.<name> 键与域码一一对应（去 git/ 前缀的命名规则）', () => {
    for (const code of ALL_GIT_CODES) {
      const expected = `error.${code.slice('git/'.length)}`
      expect(ERROR_MAP[code]?.key).toBe(expected)
    }
  })
})

describe('动作清单 = spec §3.4', () => {
  it('service-unavailable → retry；no-upstream → set-upstream；diverged → fetch/pull', () => {
    expect(errorMapEntry('gateway/service-unavailable')?.actions).toEqual(['retry'])
    expect(errorMapEntry('git/no-upstream')?.actions).toEqual(['set-upstream'])
    expect(errorMapEntry('git/diverged')?.actions).toEqual(['fetch', 'pull'])
  })

  it('说明文案类码不带动作（pull-diverged / auth-failed / no-repository）', () => {
    expect(errorMapEntry('git/pull-diverged')?.actions ?? []).toEqual([])
    expect(errorMapEntry('git/auth-failed')?.actions ?? []).toEqual([])
    expect(errorMapEntry('git/no-repository')?.actions ?? []).toEqual([])
  })

  it('gateway 保留码三键齐备；陌生 code → null（client 容忍陌生码）', () => {
    expect(Object.keys(GATEWAY_MAP).sort()).toEqual([
      'gateway/cancelled', 'gateway/input-invalid', 'gateway/service-unavailable',
    ].sort())
    expect(errorMapEntry('git/__totally-unknown__')).toBeNull()
    expect(errorMapEntry('gateway/not-a-code')).toBeNull()
    expect(errorMapEntry('')).toBeNull()
  })
})

describe('errorNoticeView — 视图模型', () => {
  it('diverged details → 插值参数（ahead/behind 数字直通）', () => {
    const view = errorNoticeView({
      code: 'git/diverged',
      message: 'diverged',
      details: { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3 },
    })
    expect(view.key).toBe('error.diverged')
    expect(view.params).toEqual({ ahead: 2, behind: 3 })
    expect(view.actions).toEqual(['fetch', 'pull'])
    expect(view.fallbackText).toBeNull()
  })

  it('identity-missing 的 missing 数组 → 逗号串参数', () => {
    const view = errorNoticeView({
      code: 'git/identity-missing',
      message: 'missing identity',
      details: { missing: ['user.name', 'user.email'] },
    })
    expect(view.params).toEqual({ missing: 'user.name, user.email' })
  })

  it('details.stderr 进折叠区且过 redact（token=***）', () => {
    const view = errorNoticeView({
      code: 'git/git-error',
      message: 'git push failed',
      details: { op: 'push', exitCode: 128, stderr: 'fatal: token=ghp_secret bad', truncated: false },
    })
    expect(view.detailsText).not.toContain('ghp_secret')
    expect(view.detailsText).toContain('token=***')
  })

  it('details 无 stderr 时回落 message（也过 redact）', () => {
    const view = errorNoticeView({
      code: 'git/timeout',
      message: 'https://u:p@host failed',
      details: { op: 'fetch', timeoutMs: 1000 },
    })
    expect(view.detailsText).toBe('https://***:***@host failed')
  })

  it('陌生 code → key null + fallbackText = redact(message)（透传展示）', () => {
    const view = errorNoticeView({ code: 'gateway/unknown-future', message: 'mystery token=abc' })
    expect(view.key).toBeNull()
    expect(view.fallbackText).toBe('mystery token=***')
    expect(view.actions).toEqual([])
  })

  it('details 形状漂移（undefined/null 字段）不炸 params', () => {
    const view = errorNoticeView({ code: 'git/no-upstream', message: 'no upstream', details: undefined })
    expect(view.params).toEqual({ branch: '' })
    expect(view.key).toBe('error.no-upstream')
  })
})
