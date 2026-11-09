/**
 * v2 批次四 — pr 引擎测试（[清单 46/69]；docs/v2-implementation-plan.md §6.7 host
 * 真仓库范式行——**假 gh 替身承载形态 = pr.ts transport 结构切片注入**（方案 §6.10
 * 定案：.cmd shim 直接 spawn 实测 EINVAL、真宿主无 face 注入通道，transport 切片
 * 只在单测可达；真 gh 端到端走 verify:load 人工走查，成功形状由本 spec 假 transport
 * 断言）。
 *
 * 覆盖：createPr 成功形状（argv 序列断言 / body 走 stdin / --base --head --draft
 * 条件拼装 / resolved executable 进 argv[0] / PR URL+number 解析）；无 acknowledged
 * 拒绝（零命令）；title 空与分支参数 '-' 形状守卫（零命令）；gh 解析失败（null/抛）
 * ⇒ pr-tool-missing；auth 预检未过 ⇒ pr-tool-missing；pr create 非零 ⇒
 * pr-create-failed（**stderr 脱敏断言——token=… 明文不落 details**）；超时 ⇒
 * git/timeout；调用方取消原样穿透；prForBranch upstream 推断（真仓 update-ref +
 * --set-upstream-to → head=剥远端前缀）与 null 降级（非零退出 / JSON 不可解析）；
 * 服务级 Config 通道（ghCommand 指向解析不到的名字 ⇒ pr-tool-missing / null 降级）；
 * parsePrUrl 纯函数。
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { PrEngine, parsePrUrl } from '../src/pr.ts'
import { createGitRunners } from '../src/git-runner.ts'
import type { GhTransport } from '../src/pr.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'
import type { SpawnRecord } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ---------- 假 gh transport（transport 结构切片的假实现） ----------

/** 一次 gh 调用的记录（argv 序列/stdin 断言用）。 */
interface GhCall {
  argv: readonly string[]
  cwd: string
  stdin: string | undefined
}

/** 脚本化应答：按 gh 子命令（auth/create/view）分派。 */
interface GhScript {
  /** `gh auth status` 的退出码（缺省 0）。 */
  auth?: number
  /** `gh pr create` 应答（缺省成功 + 示例 URL）。 */
  create?: { exitCode: number; stdout?: string; stderr?: string }
  /** `gh pr view` 应答（缺省成功 + 示例 JSON）。 */
  view?: { exitCode: number; stdout?: string; stderr?: string }
}

function fakeGhTransport(script: GhScript, calls: GhCall[], opts: { resolve: string | null | 'throw'; hangMs?: number } = { resolve: 'C:/fake/gh' }): GhTransport {
  return {
    async resolveExecutable() {
      if (opts.resolve === 'throw') throw new Error('resolver exploded')
      return opts.resolve
    },
    async run(spec) {
      calls.push({ argv: spec.argv, cwd: spec.cwd, stdin: spec.stdin })
      if (opts.hangMs !== undefined) {
        // hang 模式：signal 中止后 reject（真实 adapter 的 signal 遵守语义）。
        await new Promise<never>((_, reject) => {
          const fail = (): void => {
            reject((spec.signal.reason as Error) instanceof Error ? (spec.signal.reason as Error) : new Error('aborted'))
          }
          if (spec.signal.aborted) fail()
          else spec.signal.addEventListener('abort', fail, { once: true })
        })
      }
      const sub = spec.argv[1] ?? ''
      if (sub === 'auth') return { exitCode: script.auth ?? 0, stdout: '', stderr: '', aborted: spec.signal.aborted }
      if (spec.argv[1] === 'pr' && spec.argv[2] === 'create') {
        const create = script.create ?? { exitCode: 0, stdout: 'https://github.com/acme/repo/pull/42\n' }
        return { exitCode: create.exitCode, stdout: create.stdout ?? '', stderr: create.stderr ?? '', aborted: spec.signal.aborted }
      }
      if (spec.argv[1] === 'pr' && spec.argv[2] === 'view') {
        const view = script.view ?? { exitCode: 0, stdout: '{"state":"OPEN","url":"https://github.com/acme/repo/pull/7"}' }
        return { exitCode: view.exitCode, stdout: view.stdout ?? '', stderr: view.stderr ?? '', aborted: spec.signal.aborted }
      }
      return { exitCode: 0, stdout: '', stderr: '', aborted: spec.signal.aborted }
    },
  }
}

function makeEngine(
  repo: string,
  transport: GhTransport,
  overrides: { ghCommand?: string; networkTimeoutMs?: number } = {},
): PrEngine {
  const runners = createGitRunners(localSubprocess(), {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000, networkTimeoutMs: 15_000,
    outputMaxBytes: 1_048_576,
  })
  return new PrEngine(transport, runners.readonly, new WorkspaceResolver(repo), {
    ghCommand: overrides.ghCommand ?? 'gh',
    networkTimeoutMs: overrides.networkTimeoutMs ?? 15_000,
  })
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string | null; message: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  if (remote === null || remote === undefined) {
    // 非 RemoteError（调用方取消等）——code null 供穿透断言。
    return { code: null, message: cause instanceof Error ? cause.message : String(cause), details: {} }
  }
  return { code: remote.code, message: remote.message, details: remote.details as Record<string, unknown> }
}

async function bornRepo(prefix: string): Promise<string> {
  const repo = await scratchRepo(prefix, cleanups)
  git(repo, 'commit', '--allow-empty', '-m', 'seed')
  return repo
}

describe('createPr — [清单 46]（transport 切片假 gh）', () => {
  it('成功形状：auth 预检 → pr create（argv 序列 / body 走 stdin / --base --head --draft 条件拼装）→ URL+number', async () => {
    const repo = await bornRepo('dshgit-pr-ok-')
    const calls: GhCall[] = []
    const engine = makeEngine(repo, fakeGhTransport({}, calls))
    const result = await engine.createPr({
      title: 'feat: add login',
      body: '## What\n\nAdds login.',
      base: 'main',
      head: 'feature',
      draft: true,
      acknowledged: true,
    })
    expect(result).toEqual({ url: 'https://github.com/acme/repo/pull/42', number: 42 })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.argv).toEqual(['C:/fake/gh', 'auth', 'status'])
    expect(calls[0]!.cwd).toBe(repo)
    expect(calls[1]!.argv).toEqual([
      'C:/fake/gh', 'pr', 'create',
      '--title', 'feat: add login',
      '--body-file', '-',
      '--base', 'main',
      '--head', 'feature',
      '--draft',
    ])
    // body 不进 argv（进程清单面）——经 stdin 过线。
    expect(calls[1]!.stdin).toBe('## What\n\nAdds login.')
    expect(calls[1]!.argv.join(' ')).not.toContain('Adds login')
  })

  it('base/head 缺省 = 不传旗标（gh 自行推断）；draft=false 不传 --draft', async () => {
    const repo = await bornRepo('dshgit-pr-defaults-')
    const calls: GhCall[] = []
    const engine = makeEngine(repo, fakeGhTransport({}, calls))
    await engine.createPr({ title: 'chore: tidy', body: '', acknowledged: true })
    expect(calls[1]!.argv).toEqual(['C:/fake/gh', 'pr', 'create', '--title', 'chore: tidy', '--body-file', '-'])
  })

  it('无 acknowledged ⇒ git/bad-request unacknowledged（零命令——danger 闸最前）', async () => {
    const repo = await bornRepo('dshgit-pr-unack-')
    const calls: GhCall[] = []
    const engine = makeEngine(repo, fakeGhTransport({}, calls))
    const rejection = await rejectionOf(() => engine.createPr({ title: 't', body: 'b', acknowledged: false }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('unacknowledged')
    expect(calls).toHaveLength(0)
  })

  it('title 空白 / branch 参数首字符 - ⇒ bad-request invalid-options（零命令——防旗标注入）', async () => {
    const repo = await bornRepo('dshgit-pr-shape-')
    const calls: GhCall[] = []
    const engine = makeEngine(repo, fakeGhTransport({}, calls))
    const emptyTitle = await rejectionOf(() => engine.createPr({ title: '   ', body: '', acknowledged: true }))
    expect(emptyTitle.code).toBe('git/bad-request')
    expect(emptyTitle.details.reason).toBe('invalid-options')
    const dashBase = await rejectionOf(() => engine.createPr({ title: 't', body: '', base: '--exec', acknowledged: true }))
    expect(dashBase.details.reason).toBe('invalid-options')
    const dashHead = await rejectionOf(() => engine.createPr({ title: 't', body: '', head: '-x', acknowledged: true }))
    expect(dashHead.details.reason).toBe('invalid-options')
    expect(calls).toHaveLength(0)
  })

  it('gh 解析失败（null / 抛错）⇒ git/pr-tool-missing details.tool=gh', async () => {
    const repo = await bornRepo('dshgit-pr-resolve-')
    const nullEngine = makeEngine(repo, fakeGhTransport({}, [], { resolve: null }))
    const nullRejection = await rejectionOf(() => nullEngine.createPr({ title: 't', body: '', acknowledged: true }))
    expect(nullRejection.code).toBe('git/pr-tool-missing')
    expect(nullRejection.details.tool).toBe('gh')
    const throwEngine = makeEngine(repo, fakeGhTransport({}, [], { resolve: 'throw' }))
    const throwRejection = await rejectionOf(() => throwEngine.createPr({ title: 't', body: '', acknowledged: true }))
    expect(throwRejection.code).toBe('git/pr-tool-missing')
  })

  it('auth 预检未过（未装/未登录）⇒ git/pr-tool-missing；pr create 非零 ⇒ git/pr-create-failed（stderr 脱敏）', async () => {
    const repo = await bornRepo('dshgit-pr-auth-')
    const calls: GhCall[] = []
    const authFail = makeEngine(repo, fakeGhTransport({ auth: 1 }, calls))
    const authRejection = await rejectionOf(() => authFail.createPr({ title: 't', body: '', acknowledged: true }))
    expect(authRejection.code).toBe('git/pr-tool-missing')
    expect(calls).toHaveLength(1)
    // pr create 失败：stderr 含凭证形态 → details.stderr 过 sanitizeStderr（明文不落）。
    const failCalls: GhCall[] = []
    const createFail = makeEngine(repo, fakeGhTransport({
      create: { exitCode: 4, stdout: '', stderr: 'gh: validation failed token=ghp_supersecretvalue value' },
    }, failCalls))
    const createRejection = await rejectionOf(() => createFail.createPr({ title: 't', body: '', acknowledged: true }))
    expect(createRejection.code).toBe('git/pr-create-failed')
    expect(createRejection.details.stderr).not.toContain('ghp_supersecretvalue')
    expect(createRejection.details.stderr).toContain('***')
  })

  it('超时 ⇒ git/timeout op=createPr；调用方取消原样穿透（不折叠域错误）', async () => {
    const repo = await bornRepo('dshgit-pr-timeout-')
    // hang transport：直到 signal 中止才 reject（真实 adapter 的 signal 遵守语义）。
    const hangRun = async (spec: Parameters<GhTransport['run']>[0]): Promise<never> => {
      await new Promise<never>((_, reject) => {
        const fail = (): void => reject(spec.signal.reason instanceof Error ? spec.signal.reason : new Error('aborted'))
        if (spec.signal.aborted) fail()
        else spec.signal.addEventListener('abort', fail, { once: true })
      })
      throw new Error('unreachable')
    }
    const calls: GhCall[] = []
    const hanging = makeEngine(repo, {
      async resolveExecutable() { return 'C:/fake/gh' },
      async run(spec) {
        calls.push({ argv: spec.argv, cwd: spec.cwd, stdin: spec.stdin })
        await hangRun(spec)
        throw new Error('unreachable')
      },
    }, { networkTimeoutMs: 250 })
    const outcome = await rejectionOf(() => hanging.createPr({ title: 't', body: '', acknowledged: true }))
    expect(outcome.code).toBe('git/timeout')
    expect(outcome.details.op).toBe('createPr')
    expect(outcome.details.timeoutMs).toBe(250)
    // 调用方取消：外部 AbortController 先中止 → 原始 cause 穿透（非 RemoteError）。
    const controller = new AbortController()
    const cancelling = makeEngine(repo, {
      async resolveExecutable() { return 'C:/fake/gh' },
      async run(spec) {
        await hangRun(spec)
        throw new Error('unreachable')
      },
    }, { networkTimeoutMs: 15_000 })
    const pending = cancelling.createPr({ title: 't', body: '', acknowledged: true }, controller.signal)
    setTimeout(() => controller.abort(), 50)
    const cancelOutcome = await rejectionOf(() => pending)
    expect(cancelOutcome.code).toBeNull()
  })

  it('prForBranch：upstream 推断（真仓 remote-tracking 引用 + branch.* 配置 → head 剥远端前缀）+ 成功 JSON', async () => {
    const repo = await bornRepo('dshgit-pr-view-')
    git(repo, 'switch', '-qc', 'topic')
    git(repo, 'update-ref', 'refs/remotes/origin/topic-x', 'HEAD')
    // remote origin 配置（url 为哑路径——@{upstream} 校验 fetch refspec 映射，缺它拒
    // 判 'not stored as a remote-tracking branch'）+ branch.<name>.remote/merge 两键
    //（--set-upstream-to 在无 remote 配置的仓里同判 'not a branch'）。
    git(repo, 'remote', 'add', 'origin', join(repo, 'origin-dummy'))
    git(repo, 'config', 'branch.topic.remote', 'origin')
    git(repo, 'config', 'branch.topic.merge', 'refs/heads/topic-x')
    // 夹具自检：world 侧 @{upstream} 确实解析为 origin/topic-x。
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'topic@{upstream}'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()).toBe('origin/topic-x')
    git(repo, 'switch', '-q', 'main')
    const calls: GhCall[] = []
    const engine = makeEngine(repo, fakeGhTransport({}, calls))
    const result = await engine.prForBranch('topic')
    expect(result).toEqual({ url: 'https://github.com/acme/repo/pull/7', state: 'OPEN' })
    expect(calls[0]!.argv).toEqual(['C:/fake/gh', 'pr', 'view', 'topic-x', '--json', 'url,state'])
    expect(calls).toHaveLength(1)
    // 无 upstream：head 回落 branch 本名。
    const fallbackCalls: GhCall[] = []
    const fallback = makeEngine(repo, fakeGhTransport({}, fallbackCalls))
    await fallback.prForBranch('main')
    expect(fallbackCalls[0]!.argv).toEqual(['C:/fake/gh', 'pr', 'view', 'main', '--json', 'url,state'])
  })

  it('prForBranch：gh 解析失败 ⇒ pr-tool-missing；查询失败/不可解析 ⇒ null（[69] 静默降级）', async () => {
    const repo = await bornRepo('dshgit-pr-view-null-')
    const nullEngine = makeEngine(repo, fakeGhTransport({}, [], { resolve: null }))
    const missing = await rejectionOf(() => nullEngine.prForBranch('main'))
    expect(missing.code).toBe('git/pr-tool-missing')
    // gh 在但查询失败（非零退出——无关联 PR/网络失败）⇒ null。
    const notFound = await makeEngine(repo, fakeGhTransport({ view: { exitCode: 1, stdout: '', stderr: 'no pull requests found' } }, [])).prForBranch('main')
    expect(notFound).toBeNull()
    // exit 0 但 JSON 不可解析 ⇒ null（查询失败态降级）。
    const garbage = await makeEngine(repo, fakeGhTransport({ view: { exitCode: 0, stdout: 'not json at all' } }, [])).prForBranch('main')
    expect(garbage).toBeNull()
    // 无 url 字段 ⇒ null。
    const noUrl = await makeEngine(repo, fakeGhTransport({ view: { exitCode: 0, stdout: '{"state":"OPEN"}' } }, [])).prForBranch('main')
    expect(noUrl).toBeNull()
  })

  it('prForBranch branch 形状守卫：空串/首字符 - ⇒ bad-request invalid-options（零命令）', async () => {
    const repo = await bornRepo('dshgit-pr-view-shape-')
    const calls: GhCall[] = []
    const engine = makeEngine(repo, fakeGhTransport({}, calls))
    const empty = await rejectionOf(() => engine.prForBranch(''))
    expect(empty.details.reason).toBe('invalid-options')
    const dash = await rejectionOf(() => engine.prForBranch('-evil'))
    expect(dash.details.reason).toBe('invalid-options')
    expect(calls).toHaveLength(0)
  })
})

describe('createPr/prForBranch — 服务级 Config 通道（真宿主无 face 注入通道的对应面）', () => {
  function makeService(workspaceOverride: string, overrides: { ghCommand?: string } = {}, record?: SpawnRecord[]): InstanceType<typeof GitService> {
    const ctx = new Context() as never
    const face = ctx as { provide(name: string, value: unknown): void }
    face.provide('subprocess', localSubprocess(record))
    return new GitService(ctx, {
      gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000,
      workspaceOverride, autoFetchIntervalMs: 0,
      ghCommand: overrides.ghCommand ?? 'gh',
    })
  }

  it('ghCommand 指向解析不到的固件名 ⇒ createPr 抛 pr-tool-missing / prForBranch 静默降级 null', async () => {
    const repo = await scratchRepo('dshgit-pr-svc-', cleanups)
    git(repo, 'commit', '--allow-empty', '-m', 'seed')
    const record: SpawnRecord[] = []
    const service = makeService(repo, { ghCommand: 'dshgit-fixture-no-such-gh' }, record)
    // createPr：auth 预检的 spawn 失败（exitCode null）⇒ pr-tool-missing（serviceKey 级可复现）。
    const createOutcome = await rejectionOf(() => service.createPr({ title: 't', body: 'b', acknowledged: true }))
    expect(createOutcome.code).toBe('git/pr-tool-missing')
    // prForBranch：查询失败态（spawn 失败）⇒ null 降级（[69]）。
    const viewOutcome = await service.prForBranch('main')
    expect(viewOutcome).toBeNull()
    expect(record.length).toBeGreaterThanOrEqual(2)
  })

  it('服务级 danger 闸：无 acknowledged ⇒ bad-request unacknowledged（零 spawn）', async () => {
    const repo = await scratchRepo('dshgit-pr-svc-unack-', cleanups)
    git(repo, 'commit', '--allow-empty', '-m', 'seed')
    const record: SpawnRecord[] = []
    const service = makeService(repo, {}, record)
    const outcome = await rejectionOf(() => service.createPr({ title: 't', body: 'b', acknowledged: false }))
    expect(outcome.code).toBe('git/bad-request')
    expect(outcome.details.reason).toBe('unacknowledged')
    expect(record).toHaveLength(0)
  })
})

describe('parsePrUrl — 纯函数', () => {
  it('GitHub URL → number；非 /pull/ URL → number null；空输出 → 空串', () => {
    expect(parsePrUrl('Creating pull request for feature...\nhttps://github.com/acme/repo/pull/42\n')).toEqual({
      url: 'https://github.com/acme/repo/pull/42', number: 42,
    })
    expect(parsePrUrl('https://example.com/acme/repo/merge-requests/7\n')).toEqual({
      url: 'https://example.com/acme/repo/merge-requests/7', number: null,
    })
    expect(parsePrUrl('')).toEqual({ url: '', number: null })
  })
})
