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
  // V2 批次一管理面新码（host refs-admin 模块；plan §3.4）。
  'git/branch-not-found',
  'git/branch-not-merged',
  'git/branch-exists',
  'git/tag-exists',
  'git/tag-not-found',
  'git/worktree-failed',
  // V2 批次二历史面新码（host blame/time-travel/graph 扩展；plan §4.4）。
  'git/blame-oversized',
  'git/merge-conflict',
  'git/unknown-revision',
  'git/operation-in-progress',
  // V2 批次三提交链路与护栏新码（host staging-patch/stash/guard-scan；plan §5.4）。
  'git/stage-patch-failed',
  'git/stash-not-found',
  'git/commit-blocked',
  // V2 批次四体验集成新码（host admin-repo/pr；plan §6.4）。
  'git/init-failed',
  'git/pr-tool-missing',
  'git/pr-create-failed',
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

  it('V2 批次一管理面码：name/path 进插值；worktree-failed 的 stderr 进折叠区', () => {
    const branch = errorNoticeView({
      code: 'git/branch-exists', message: 'exists', details: { name: 'feature/a' },
    })
    expect(branch.key).toBe('error.branch-exists')
    expect(branch.params).toEqual({ name: 'feature/a' })
    const worktree = errorNoticeView({
      code: 'git/worktree-failed', message: 'wt failed', details: { path: 'D:/wt', stderr: 'fatal: token=abc dirty' },
    })
    expect(worktree.key).toBe('error.worktree-failed')
    expect(worktree.params).toEqual({ path: 'D:/wt' })
    expect(worktree.detailsText).toContain('token=***')
    expect(worktree.detailsText).not.toContain('token=abc')
  })

  it('V2 批次二历史面码：blame-oversized 三参 / unknown-revision / operation-in-progress', () => {
    const blame = errorNoticeView({
      code: 'git/blame-oversized', message: 'oversized',
      details: { path: 'big.txt', lineCount: 120_000, maxLines: 50_000 },
    })
    expect(blame.key).toBe('error.blame-oversized')
    expect(blame.params).toEqual({ path: 'big.txt', lineCount: 120_000, maxLines: 50_000 })
    const unknown = errorNoticeView({
      code: 'git/unknown-revision', message: 'unknown', details: { op: 'compareBranches', revision: 'nope' },
    })
    expect(unknown.key).toBe('error.unknown-revision')
    expect(unknown.params).toEqual({ op: 'compareBranches', revision: 'nope' })
    const inProgress = errorNoticeView({
      code: 'git/operation-in-progress', message: 'busy', details: { op: 'cherry-pick' },
    })
    expect(inProgress.key).toBe('error.operation-in-progress')
    expect(inProgress.params).toEqual({ op: 'cherry-pick' })
  })

  it('merge-conflict：op + conflicted 计数进插值；动作 = abort（放弃操作按钮——plan §4.10）', () => {
    const conflict = errorNoticeView({
      code: 'git/merge-conflict', message: 'conflict',
      details: { op: 'cherry-pick', conflicted: ['a.ts', 'b.ts'], abortable: true },
    })
    expect(conflict.key).toBe('error.merge-conflict')
    expect(conflict.params).toEqual({ op: 'cherry-pick', count: 2 })
    expect(conflict.actions).toEqual(['abort'])
    // details 形状漂移（conflicted 缺席）⇒ 计数安全降级 0。
    const drifted = errorNoticeView({ code: 'git/merge-conflict', message: 'conflict', details: undefined })
    expect(drifted.params).toEqual({ op: '', count: 0 })
  })

  it('V2 批次三新码：stage-patch-failed path 插值 + stderr 折叠区（脱敏）；stash-not-found index；commit-blocked 计数', () => {
    const stage = errorNoticeView({
      code: 'git/stage-patch-failed', message: 'patch failed',
      details: { path: 'app.ts', stderr: 'error: patch does not apply, token=abc leaked' },
    })
    expect(stage.key).toBe('error.stage-patch-failed')
    expect(stage.params).toEqual({ path: 'app.ts' })
    expect(stage.detailsText).toContain('token=***')
    expect(stage.detailsText).not.toContain('token=abc')
    const stash = errorNoticeView({
      code: 'git/stash-not-found', message: 'gone', details: { index: 2 },
    })
    expect(stash.key).toBe('error.stash-not-found')
    expect(stash.params).toEqual({ index: 2 })
    // details 形状漂移（index 缺席）⇒ 0。
    const stashDrifted = errorNoticeView({ code: 'git/stash-not-found', message: 'gone', details: undefined })
    expect(stashDrifted.params).toEqual({ index: 0 })
    const blocked = errorNoticeView({
      code: 'git/commit-blocked', message: 'blocked',
      details: {
        violations: [
          { kind: 'secret', path: 'keys.txt', detail: 'aws key id', sizeBytes: null, line: 3, redactedMatch: 'AKIA***' },
          { kind: 'env-file', path: '.env', detail: 'staged env file', sizeBytes: 120, line: null, redactedMatch: null },
        ],
        overridable: false,
      },
    })
    expect(blocked.key).toBe('error.commit-blocked')
    expect(blocked.params).toEqual({ count: 2 })
  })

  it('V2 批次四新码：init-failed path+reason 双插值；pr-tool-missing tool；pr-create-failed stderr 折叠区（脱敏）', () => {
    const init = errorNoticeView({
      code: 'git/init-failed', message: 'init failed',
      details: { path: 'D:/proj', reason: 'directory is not empty' },
    })
    expect(init.key).toBe('error.init-failed')
    expect(init.params).toEqual({ path: 'D:/proj', reason: 'directory is not empty' })
    const missing = errorNoticeView({
      code: 'git/pr-tool-missing', message: 'gh missing',
      details: { tool: 'gh' },
    })
    expect(missing.key).toBe('error.pr-tool-missing')
    expect(missing.params).toEqual({ tool: 'gh' })
    const failed = errorNoticeView({
      code: 'git/pr-create-failed', message: 'create failed',
      details: { stderr: 'GraphQL: Bad credentials (github.com), token=abc leaked' },
    })
    expect(failed.key).toBe('error.pr-create-failed')
    expect(failed.params).toEqual({})
    expect(failed.detailsText).toContain('token=***')
    expect(failed.detailsText).not.toContain('token=abc')
    // details 形状漂移（path/reason/tool 缺席）⇒ 空串插值不炸。
    const drifted = errorNoticeView({ code: 'git/init-failed', message: 'init failed', details: undefined })
    expect(drifted.params).toEqual({ path: '', reason: '' })
  })
})
