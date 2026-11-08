/**
 * 远端同步集成测试（spec §6 M6 行 = sync.spec；本模块 ask ①②③）。范式照 support.ts
 * 与 commit.spec.ts：真实临时 git 仓库 + 本地 bare clone 当远端（离线，不依赖网络），
 * 断言纪律 = 验证世界而非自述——每个写场景后用独立 execFileSync git 重读外部状态
 * （bare 的 refs/heads、本地 branch.* 配置、remote-tracking 引用）。
 *
 * 覆盖（M6 全用例）：无 upstream 引导 → set-upstream 首推 [清单 26]（world 重读
 * upstream 配置 + bare ref）；normal 路径显式 remote + 全量 refspec argv 断言（B3 禁
 * 裸 push）；diverged 拦截 [清单 67]（ahead/behind 进 details，bare 不变）；pre-receive
 * 拒绝 → git/push-rejected（本机实测 stderr 含 `! [remote rejected]` 而非字面
 * `[rejected]`——分类器簇补该形态）；gone 态重推（上游三态：porcelain v2 branch.upstream
 * 在而 branch.ab 缺失 = gone，本机实测；**日志断言无 rev-list / 无 @{u} 探测 = 无
 * exit-128 来源**）+ gone 后 fetch 自愈；detached/unborn → git/no-branch；pull 快进 /
 * 分叉 git/pull-diverged / 脏区 git/dirty-worktree；fetch 后 behind 刷新（status world
 * 重读）与 prune；fetch remote 解析链五态（无 remote → git/no-remote、多 remote 无
 * 默认 → git/choose-remote、origin 默认、唯一 remote、显式入参）；
 * stderr 脱敏分类器夹具（authentication/network/push-rejected/diverged）。
 *
 * v2 批次一扩展（docs/v2-implementation-plan.md §3.7）：force push 两例 [清单 27]
 * （amend 改写历史后非 force ⇒ git/diverged、force+acknowledged 推平 bare 远端 +
 * argv 断言；无 acknowledged ⇒ bad-request 'force-unacknowledged' 零命令）+ 显式
 * remote 直查（[清单 57]：存在即推该远端 world 重读，不存在 ⇒ git/no-remote 带
 * details.remotes 全量）+ 定时 fetch 用例 [清单 58]（短 interval 触发后台 fetch →
 * status world 重读 behind 刷新；autoFetchOnce 失败面仅 warn 不抛——no-remote 确定性）。
 * 批次一独立评审修复（medium）：diverged 预检基线 = 实际推送目标 `<remote>/<remoteBranch>`
 * ——与旧 upstream 分叉不伪拒显式非 upstream 远端的非 force 推送（无 tracking 引用 =
 * 不预检）；对照半：与**选定**远端分叉仍 ⇒ git/diverged 且 details.upstream 指向选定
 * 远端的目标分支。
 *
 * **认证失败未自动化真实凭证**（任务口径如实标注）：真实凭证失败需要响应 401 的
 * HTTP 远端，离线不可复现；认证路径以分类器夹具单测覆盖（真实世界 stderr 文本进
 * 夹具），另以 connection-refused 的 http 远端 E2E 落 network 类 → git-error 兜底
 * （offline 确定：loopback 拒连瞬时返回）。GIT_CONFIG_GLOBAL 隔离（照 commit.spec
 * 先例）确保测试进程的 git 不加载本机凭证管理器。
 */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { sanitizeStderr } from '../src/error-codes.ts'
import { classifyRemoteStderr, rejectionReason, upstreamStateOf } from '../src/remote-ops.ts'
import type { RemoteStderrClass } from '../src/remote-ops.ts'
import { git, localSubprocess, scratchDir, scratchRepo } from './support.ts'
import type { SpawnRecord } from './support.ts'

// 并行负载下的资源裕量（真实 git 子进程；commit.spec 同款先例）。60s：fresh 扫描
// （status + 双 numstat）+ push/pull/fetch 每操作 6-8 条 git spawn，满载轮次的
// Windows spawn 抖动以时间余量吸收（资源裕量，非断言放宽）。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
const envCleanups: Array<() => Promise<unknown>> = []
let realGlobalConfig: string | undefined
let realNosystem: string | undefined

beforeAll(async () => {
  // 凭证环境隔离（照 commit.spec 先例）：GIT_CONFIG_GLOBAL 指向不存在文件 + 系统级
  // 配置关闭——测试进程的 git 无凭证管理器（push/fetch 不会弹 GCM），夹具可离线确定。
  realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  realNosystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = join(await scratchDir('dshgit-sync-isolation-', cleanups), 'does-not-exist')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(async () => {
  if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig
  if (realNosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = realNosystem
  while (envCleanups.length > 0) await envCleanups.pop()!()
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ---------- 夹具设施 ----------

interface Harness {
  service: InstanceType<typeof GitService>
  record: SpawnRecord[]
}

function makeService(
  workspaceOverride: string,
  overrides: { record?: SpawnRecord[]; networkTimeoutMs?: number; autoFetchIntervalMs?: number } = {},
): Harness {
  const record = overrides.record ?? []
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess(record))
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    commitTimeoutMs: 15_000,
    networkTimeoutMs: overrides.networkTimeoutMs ?? 20_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
    // 缺省 0 = 定时 fetch 关闭（既有用例语义不变）；定时 fetch 用例显式给短间隔。
    autoFetchIntervalMs: overrides.autoFetchIntervalMs ?? 0,
  })
  return { service, record }
}

/** 本地 bare 远端（`git init --bare -b main`；离线 remote——git 协议不通，spec §⑥）。 */
async function makeBare(name: string): Promise<string> {
  const dir = join(await scratchDir(`dshgit-sync-${name}-`, cleanups), 'origin.git')
  await mkdir(dir, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  return dir
}

/** 写一个 bare 仓库 hook（LF + chmod；commit.spec writeHook 同款范式）。 */
async function writeHook(dir: string, name: string, body: string): Promise<void> {
  const hook = join(dir, 'hooks', name)
  await mkdir(join(hook, '..'), { recursive: true })
  await writeFile(hook, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(hook, 0o755)
}

interface World {
  repo: string
  bare: string
  harness: Harness
}

/** 标准世界：bare 远端 + 单提交工作仓库（origin 指向 bare，无 upstream）。 */
async function makeWorld(
  name: string,
  overrides: { record?: SpawnRecord[]; autoFetchIntervalMs?: number } = {},
): Promise<World> {
  const bare = await makeBare(name)
  const repo = await scratchRepo(`dshgit-sync-${name}-repo-`, cleanups, { name: 't', email: 't@example.com' })
  await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', bare)
  return { repo, bare, harness: makeService(repo, overrides) }
}

/** 在仓库里追加一个提交（fixture 面；文件名作区分）。 */
async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', rel)
  git(repo, 'commit', '-qm', message)
  return headOid(repo)
}

// ---------- world 重读（独立 git 进程，验证世界而非自述） ----------

function headOid(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function refOid(repo: string, ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', ref], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function branchConfig(repo: string, key: string): string | null {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** 一次 spawn 的 argv 是否含给定片段（push/fetch/rev-list 断言用）。 */
function findArgv(record: SpawnRecord[], needle: string): SpawnRecord | undefined {
  return record.find(entry => entry.argv.some(arg => arg === needle || arg.includes(needle)))
}

/** 含给定片段的**最后一次** spawn（同一 record 累积多次命令时取最新）。 */
function lastArgv(record: SpawnRecord[], needle: string): SpawnRecord | undefined {
  for (let index = record.length - 1; index >= 0; index--) {
    const entry = record[index] as SpawnRecord
    if (entry.argv.some(arg => arg === needle || arg.includes(needle))) return entry
  }
  return undefined
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: unknown }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, message: remote!.message, details: remote!.details }
}

// ---------- 分类器与三态纯函数（夹具单测；任务口径 ①「分类器导出供夹具单测」） ----------

describe('stderr 脱敏分类器（remote-ops.ts 夹具单测）', () => {
  it('authentication 簇：真实世界 stderr 文本三条', () => {
    const samples: Array<[string, RemoteStderrClass]> = [
      ["fatal: Authentication failed for 'https://git.example.com/team/repo.git/'", 'authentication'],
      ["fatal: could not read Username for 'https://git.example.com': terminal prompts disabled", 'authentication'],
      ['git@git.example.com: Permission denied (publickey).', 'authentication'],
    ]
    for (const [sample, expected] of samples) {
      expect(classifyRemoteStderr(sample), sample).toBe(expected)
    }
  })

  it('network 簇：解析失败 / 拒连 / 超时', () => {
    const samples: Array<[string, RemoteStderrClass]> = [
      ["fatal: unable to access 'https://nonexistent.invalid/repo.git/': Could not resolve host: nonexistent.invalid", 'network'],
      ["fatal: unable to access 'http://127.0.0.1:9/repo.git/': Failed to connect to 127.0.0.1 port 9 after 2 ms: Couldn't connect to server", 'network'],
      ['fatal: unable to access ...: Connection timed out', 'network'],
    ]
    for (const [sample, expected] of samples) {
      expect(classifyRemoteStderr(sample), sample).toBe(expected)
    }
  })

  it('push-rejected 簇：[rejected] 与 [remote rejected]（pre-receive 实际形态）', () => {
    expect(classifyRemoteStderr(' ! [rejected]        main -> main (non-fast-forward)')).toBe('push-rejected')
    expect(classifyRemoteStderr(' ! [remote rejected] main -> main (pre-receive hook declined)')).toBe('push-rejected')
    expect(classifyRemoteStderr('error: failed to push some refs')).toBe(undefined) // 无关键词不误判
  })

  it('diverged 簇与未知回落 undefined', () => {
    expect(classifyRemoteStderr('fatal: Not possible to fast-forward, aborting.')).toBe('diverged')
    expect(classifyRemoteStderr('fatal: something entirely different')).toBe(undefined)
  })

  it('先脱敏后分类：URL userinfo 被清、分类照常（任务口径「stderr 先脱敏」）', () => {
    const raw = "fatal: unable to access 'https://user:hunter2@git.example.com/repo.git/': Authentication failed"
    const sanitized = sanitizeStderr(raw)
    expect(sanitized).not.toContain('hunter2')
    expect(classifyRemoteStderr(sanitized)).toBe('authentication')
  })

  it('rejectionReason：括号体提取与无匹配回落', () => {
    expect(rejectionReason(' ! [remote rejected] main -> main (pre-receive hook declined)')).toBe('pre-receive hook declined')
    expect(rejectionReason(' ! [rejected]        main -> main (non-fast-forward)')).toBe('non-fast-forward')
    expect(rejectionReason('no rejection marker')).toBe('rejected')
  })

  it('上游三态推导：porcelain branch 头三形（gone = upstream 在而 branch.ab 缺，本机实测）', () => {
    const branchOf = (over: Record<string, unknown>) => upstreamStateOf({
      name: 'main', oid: 'x'.repeat(40), abbrevOid: 'xxxxxxx',
      upstream: null, ahead: null, behind: null, detached: false, unborn: false, ...over,
    })
    expect(branchOf({})).toBe('no-upstream')
    expect(branchOf({ upstream: 'origin/main' })).toBe('gone')
    expect(branchOf({ upstream: 'origin/main', ahead: 0, behind: 0 })).toBe('normal')
    expect(branchOf({ upstream: 'origin/main', ahead: 1, behind: 1 })).toBe('normal')
  })
})

// ---------- push（spec §1.5；任务口径 ①） ----------

describe('git.push — 上游三态与 set-upstream（spec §1.5）', () => {
  it('无 upstream + setUpstream=false → git/no-upstream（details.branch/hint），零副作用', async () => {
    const world = await makeWorld('no-up')
    const { code, details } = await rejectionOf(() => world.harness.service.push({ setUpstream: false }))
    expect(code).toBe('git/no-upstream')
    expect((details as { branch: string }).branch).toBe('main')
    expect((details as { hint: string }).hint).toBe('set-upstream')
    // world 重读：bare 无 main、本地无 upstream 配置。
    expect(refOid(world.bare, 'refs/heads/main')).toBeNull()
    expect(branchConfig(world.repo, 'branch.main.remote')).toBeNull()
  })

  it('首推 set-upstream [清单 26]：成功 + world 重读 upstream 配置与 bare ref；argv 为显式 refspec（B3）', async () => {
    const world = await makeWorld('first-push')
    const result = await world.harness.service.push({ setUpstream: true })
    expect(result).toEqual({ remote: 'origin', branch: 'main', upstream: 'origin/main', setUpstreamUsed: true })
    // world 重读：bare 的 main == 本地 HEAD；branch.main.remote/merge 落盘。
    expect(refOid(world.bare, 'refs/heads/main')).toBe(headOid(world.repo))
    expect(branchConfig(world.repo, 'branch.main.remote')).toBe('origin')
    expect(branchConfig(world.repo, 'branch.main.merge')).toBe('refs/heads/main')
    // argv 断言（B3）：全量 refspec + --set-upstream，绝非裸 push。
    const pushSpawn = findArgv(world.harness.record, 'refs/heads/main:refs/heads/main')
    expect(pushSpawn).toBeDefined()
    expect(pushSpawn!.argv.filter(arg => arg === 'push' || arg === '--set-upstream' || arg.startsWith('refs/heads/')))
      .toEqual(['push', '--set-upstream', 'refs/heads/main:refs/heads/main'])
  })

  it('normal 路径：显式 remote + 全量 refspec argv（无 --set-upstream）；setUpstreamUsed=false', async () => {
    const world = await makeWorld('normal-push')
    await world.harness.service.push({ setUpstream: true })
    world.harness.record.length = 0
    const local = await commitFile(world.repo, 'b.txt', 'second\n', 'feat: second')
    const result = await world.harness.service.push({ setUpstream: false })
    expect(result).toEqual({ remote: 'origin', branch: 'main', upstream: 'origin/main', setUpstreamUsed: false })
    // world 重读：bare main 前进到本地 HEAD。
    expect(refOid(world.bare, 'refs/heads/main')).toBe(local)
    expect(refOid(world.bare, 'refs/heads/main')).toBe(headOid(world.repo))
    // argv 断言：`push <remote> <full refspec>`，无 --set-upstream。
    const pushSpawn = findArgv(world.harness.record, 'refs/heads/main:refs/heads/main')
    expect(pushSpawn).toBeDefined()
    expect(pushSpawn!.argv.filter(arg => arg === 'push' || arg === '--set-upstream' || arg === 'origin' || arg.startsWith('refs/heads/')))
      .toEqual(['push', 'origin', 'refs/heads/main:refs/heads/main'])
  })

  it('diverged 拦截 [清单 67]：git/diverged 带 ahead/behind，bare 不变（零副作用）', async () => {
    const world = await makeWorld('diverged')
    await world.harness.service.push({ setUpstream: true })
    // 第二 clone 推进 bare，本地推进自身并 fetch 刷新跟踪引用 → ahead 1 behind 1。
    const clone2 = join(await scratchDir('dshgit-sync-diverged-clone-', cleanups), 'clone')
    git(world.repo, 'clone', world.bare, clone2)
    await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
    git(clone2, 'add', 'remote.txt')
    git(clone2, 'commit', '-qm', 'feat: remote side')
    git(clone2, 'push', '-q', 'origin', 'main')
    const remoteOid = refOid(clone2, 'HEAD') as string
    const localOid = await commitFile(world.repo, 'c.txt', 'local\n', 'feat: local side')
    git(world.repo, 'fetch', '-q', 'origin')

    const { code, details } = await rejectionOf(() => world.harness.service.push({ setUpstream: false }))
    expect(code).toBe('git/diverged')
    expect((details as { branch: string }).branch).toBe('main')
    expect((details as { upstream: string }).upstream).toBe('origin/main')
    expect((details as { ahead: number }).ahead).toBe(1)
    expect((details as { behind: number }).behind).toBe(1)
    // world 重读：bare main 仍是第二 clone 的提交（拦截 = 未执行 push）。
    expect(refOid(world.bare, 'refs/heads/main')).toBe(remoteOid)
    expect(refOid(world.bare, 'refs/heads/main')).not.toBe(localOid)
  })

  it('pre-receive 拒绝 → git/push-rejected（reason=括号体，stderr 原样脱敏进 details），bare 不变', async () => {
    const bare = await makeBare('pre-receive')
    await writeHook(bare, 'pre-receive', 'echo "changes to protected paths are not allowed" >&2\nexit 1\n')
    const repo = await scratchRepo('dshgit-sync-prereceive-repo-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'remote', 'add', 'origin', bare)
    const harness = makeService(repo)

    const { code, details } = await rejectionOf(() => harness.service.push({ setUpstream: true }))
    expect(code).toBe('git/push-rejected')
    expect((details as { remote: string }).remote).toBe('origin')
    expect((details as { branch: string }).branch).toBe('main')
    expect((details as { reason: string }).reason).toBe('pre-receive hook declined')
    expect((details as { stderr: string }).stderr).toContain('[remote rejected]')
    // world 重读：拒绝后 bare 无 main（首推未落地）。
    expect(refOid(bare, 'refs/heads/main')).toBeNull()
  })

  it('gone 态：重推走 set-upstream 路径成功；**日志断言无 rev-list / 无 @{u}（无 exit-128 来源）**；fetch 自愈跟踪引用', async () => {
    const world = await makeWorld('gone')
    await world.harness.service.push({ setUpstream: true })
    // 造 gone：删 bare 的 main + 删本地跟踪引用（porcelain v2：branch.upstream 在、branch.ab 缺）。
    git(world.bare, 'update-ref', '-d', 'refs/heads/main')
    git(world.repo, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(refOid(world.repo, 'refs/remotes/origin/main')).toBeNull()

    // gone + 未确认 ⇒ no-upstream 引导（gone 复用同码同 hint——client 动作即治愈路径）。
    const guided = await rejectionOf(() => world.harness.service.push({ setUpstream: false }))
    expect(guided.code).toBe('git/no-upstream')
    expect((guided.details as { branch: string }).branch).toBe('main')

    // gone 重推（setUpstream=true）→ set-upstream 路径成功。
    world.harness.record.length = 0
    const result = await world.harness.service.push({ setUpstream: true })
    expect(result.setUpstreamUsed).toBe(true)
    expect(result.upstream).toBe('origin/main')
    // world 重读：bare main 重建 == 本地 HEAD。
    expect(refOid(world.bare, 'refs/heads/main')).toBe(headOid(world.repo))
    // **日志断言（任务口径「gone 态严禁 rev-list」）**：全程无 rev-list 命令、无 @{u}
    // 解析——两者在 gone 态都必然 exit 128，不出现即无 exit-128 来源。
    expect(world.harness.record.find(entry => entry.argv.some(arg => arg.includes('rev-list')))).toBeUndefined()
    expect(world.harness.record.find(entry => entry.argv.some(arg => arg.includes('@{u}')))).toBeUndefined()
    const pushSpawn = findArgv(world.harness.record, '--set-upstream')
    expect(pushSpawn).toBeDefined()

    // gone 自愈路径：fetch 重建跟踪引用（world 重读 remote-tracking ref 恢复）。
    const fetched = await world.harness.service.fetch({ remote: null })
    expect(fetched.remote).toBe('origin')
    expect(refOid(world.repo, 'refs/remotes/origin/main')).toBe(headOid(world.repo))
  })

  it('detached/unborn 拒绝 → git/no-branch（details.state）', async () => {
    const unborn = await scratchRepo('dshgit-sync-unborn-', cleanups)
    const unbornHarness = makeService(unborn)
    const unbornError = await rejectionOf(() => unbornHarness.service.push({ setUpstream: true }))
    expect(unbornError.code).toBe('git/no-branch')
    expect((unbornError.details as { state: string }).state).toBe('unborn')

    const world = await makeWorld('detached')
    git(world.repo, 'checkout', '-q', '--detach')
    const detachedError = await rejectionOf(() => world.harness.service.push({ setUpstream: false }))
    expect(detachedError.code).toBe('git/no-branch')
    expect((detachedError.details as { state: string }).state).toBe('detached')
  })

  it('网络失败 E2E（offline connection refused）→ network 类 → git-error 兜底（message 带 network 注记）', async () => {
    const repo = await scratchRepo('dshgit-sync-netfail-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'remote', 'add', 'origin', 'http://127.0.0.1:9/nonexistent.git')
    const harness = makeService(repo)
    const { code, message, details } = await rejectionOf(() => harness.service.push({ setUpstream: true }))
    // 真实凭证失败不可离线自动化（需要 401 响应的 HTTP 远端）——此处以 loopback 拒连
    // 落 network 类（offline 确定），认证映射由上方分类器夹具覆盖。
    expect(code).toBe('git/git-error')
    expect(message).toContain('(network)')
    expect((details as { op: string }).op).toBe('push(set-upstream)')
    expect((details as { stderr: string }).stderr).toContain('127.0.0.1')
  })
})

// ---------- push force / 显式 remote（v2 批次一 [清单 27/57]） ----------

describe('git.push force 与显式 remote — [清单 27/57]（v2 批次一）', () => {
  it('force 无 acknowledged → git/bad-request force-unacknowledged，零命令、bare 不变', async () => {
    const world = await makeWorld('force-noack')
    await world.harness.service.push({ setUpstream: true })
    const bareBefore = refOid(world.bare, 'refs/heads/main')
    world.harness.record.length = 0
    const { code, details } = await rejectionOf(() => world.harness.service.push({ setUpstream: false, force: true }))
    expect(code).toBe('git/bad-request')
    expect((details as { reason: string }).reason).toBe('force-unacknowledged')
    // 守卫在最前：零命令执行（B3/discard acknowledged 同款纪律）。
    expect(world.harness.record).toHaveLength(0)
    // world 重读：bare main 未动。
    expect(refOid(world.bare, 'refs/heads/main')).toBe(bareBefore)
  })

  it('amend 改写历史：非 force ⇒ git/diverged（预检在场）；force+acknowledged 推平 bare 远端（world 重读 + argv 含 --force）', async () => {
    const world = await makeWorld('force-amend')
    await world.harness.service.push({ setUpstream: true })
    const originalHead = headOid(world.repo)
    await writeFile(join(world.repo, 'a.txt'), 'amended\n', 'utf8')
    git(world.repo, 'add', 'a.txt')
    git(world.repo, 'commit', '-q', '--amend', '-m', 'base (amended)')
    const amendedHead = headOid(world.repo)
    expect(amendedHead).not.toBe(originalHead)

    // 非 force：diverged 预检拦截（证明 force 跳过的是真实存在的预检）。
    const diverged = await rejectionOf(() => world.harness.service.push({ setUpstream: false }))
    expect(diverged.code).toBe('git/diverged')
    expect(refOid(world.bare, 'refs/heads/main')).toBe(originalHead)

    // force + acknowledged：成功推平；world 重读 bare main == amend 后 HEAD。
    const result = await world.harness.service.push({ setUpstream: false, force: true, acknowledged: true })
    expect(result.remote).toBe('origin')
    expect(result.setUpstreamUsed).toBe(false)
    expect(refOid(world.bare, 'refs/heads/main')).toBe(amendedHead)
    expect(refOid(world.bare, 'refs/heads/main')).toBe(headOid(world.repo))
    // argv 断言：--force 在场（仍是显式 remote + 全量 refspec，非裸 push）。
    const pushSpawn = findArgv(world.harness.record, '--force')
    expect(pushSpawn).toBeDefined()
    expect(pushSpawn!.argv.filter(arg => arg === 'push' || arg === '--force' || arg === 'origin' || arg.startsWith('refs/heads/')))
      .toEqual(['push', '--force', 'origin', 'refs/heads/main:refs/heads/main'])
  })

  it('显式 remote 直查（[清单 57]）：存在即推该远端（world 重读）；不存在 ⇒ git/no-remote（details.remotes 全量）', async () => {
    const world = await makeWorld('push-explicit')
    await world.harness.service.push({ setUpstream: true })
    const second = await makeBare('push-explicit-second')
    git(world.repo, 'remote', 'add', 'upstream', second)
    world.harness.record.length = 0
    const local = await commitFile(world.repo, 'b.txt', 'second\n', 'feat: second')

    const result = await world.harness.service.push({ setUpstream: false, remote: 'upstream' })
    expect(result.remote).toBe('upstream')
    // world 重读：second bare 的 main == 本地 HEAD（origin bare 未动）。
    expect(refOid(second, 'refs/heads/main')).toBe(local)
    expect(refOid(world.bare, 'refs/heads/main')).not.toBe(local)
    const pushSpawn = lastArgv(world.harness.record, 'push')
    expect(pushSpawn).toBeDefined()
    expect(pushSpawn!.argv).toContain('upstream')

    // 不存在的 remote：直查拒绝（不走 choose-remote 分叉，§3.10 预检顺序写死）。
    const missing = await rejectionOf(() => world.harness.service.push({ setUpstream: false, remote: 'ghost' }))
    expect(missing.code).toBe('git/no-remote')
    expect((missing.details as { branch: string }).branch).toBe('main')
    expect((missing.details as { remotes: string[] }).remotes.sort()).toEqual(['origin', 'upstream'])
  })

  it('评审修复：与旧 upstream 分叉不伪拒显式非 upstream 远端的非 force 推送（预检基线 = 实际目标），无 tracking 引用 = 不预检', async () => {
    const world = await makeWorld('explicit-keep-diverged')
    await world.harness.service.push({ setUpstream: true })
    // 造「与旧 upstream（origin/main）分叉」：第二 clone 推进 origin bare，本地推进自身，
    // fetch 刷新跟踪引用 → ahead 1 behind 1。
    const clone2 = join(await scratchDir('dshgit-sync-expldiv-clone-', cleanups), 'clone')
    git(world.repo, 'clone', world.bare, clone2)
    await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
    git(clone2, 'add', 'remote.txt')
    git(clone2, 'commit', '-qm', 'feat: remote side')
    git(clone2, 'push', '-q', 'origin', 'main')
    const localOid = await commitFile(world.repo, 'c.txt', 'local\n', 'feat: local side')
    git(world.repo, 'fetch', '-q', 'origin')

    // 钉住默认路径的预检仍在：无显式 remote ⇒ git/diverged（基线 = 配置的 origin/main）。
    const diverged = await rejectionOf(() => world.harness.service.push({ setUpstream: false }))
    expect(diverged.code).toBe('git/diverged')
    expect((diverged.details as { upstream: string }).upstream).toBe('origin/main')

    // 修复面：显式选定另一远端（真实 bare、其 main 尚不存在 ⇒ 无 tracking 引用）⇒
    // 非 force 推送不被旧 upstream 的分叉伪拒，推平选定远端（world 重读）。
    const second = await makeBare('explicit-keep-diverged-second')
    git(world.repo, 'remote', 'add', 'upstream', second)
    const result = await world.harness.service.push({ setUpstream: false, remote: 'upstream' })
    expect(result.remote).toBe('upstream')
    expect(result.setUpstreamUsed).toBe(false)
    expect(refOid(second, 'refs/heads/main')).toBe(localOid)
    // world 重读：origin bare 未被本次显式推送波及。
    expect(refOid(world.bare, 'refs/heads/main')).not.toBe(localOid)
    // argv：显式 remote + 全量 refspec，无 --force（非 force 路径）。
    const pushSpawn = lastArgv(world.harness.record, 'push')
    expect(pushSpawn).toBeDefined()
    expect(pushSpawn!.argv).toContain('upstream')
    expect(pushSpawn!.argv).not.toContain('--force')
  })

  it('评审修复对照：与**选定**远端的跟踪引用分叉 ⇒ git/diverged（details.upstream 指向选定远端的目标分支），拦截零副作用', async () => {
    const world = await makeWorld('explicit-diverged-selected')
    // 先把分支置于 normal 态（upstream 配置在——diverged 预检只在 normal 路径存在）。
    await world.harness.service.push({ setUpstream: true })
    const second = await makeBare('explicit-selected-second')
    git(world.repo, 'remote', 'add', 'upstream', second)
    // 首推到 upstream：成功且本地建立 refs/remotes/upstream/main 跟踪引用（world 重读）。
    const first = await world.harness.service.push({ setUpstream: false, remote: 'upstream' })
    expect(first.remote).toBe('upstream')
    expect(refOid(second, 'refs/heads/main')).toBe(headOid(world.repo))
    expect(refOid(world.repo, 'refs/remotes/upstream/main')).toBe(headOid(world.repo))

    // 造与 upstream/main 的分叉：本地前进 A；第二 clone 推进 second bare 到 B；fetch upstream。
    const localOid = await commitFile(world.repo, 'c.txt', 'local\n', 'feat: local side')
    const clone2 = join(await scratchDir('dshgit-sync-explsel-clone-', cleanups), 'clone')
    git(world.repo, 'clone', second, clone2)
    await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
    git(clone2, 'add', 'remote.txt')
    git(clone2, 'commit', '-qm', 'feat: remote side')
    git(clone2, 'push', '-q', 'origin', 'main')
    const remoteOid = refOid(second, 'refs/heads/main') as string
    git(world.repo, 'fetch', '-q', 'upstream')

    const { code, details } = await rejectionOf(() => world.harness.service.push({ setUpstream: false, remote: 'upstream' }))
    expect(code).toBe('git/diverged')
    expect((details as { upstream: string }).upstream).toBe('upstream/main')
    expect((details as { branch: string }).branch).toBe('main')
    expect((details as { ahead: number }).ahead).toBe(1)
    expect((details as { behind: number }).behind).toBe(1)
    // world 重读：second bare 仍是第二 clone 的提交（拦截 = 未执行 push）。
    expect(refOid(second, 'refs/heads/main')).toBe(remoteOid)
    expect(refOid(second, 'refs/heads/main')).not.toBe(localOid)
  })
})

// ---------- pull（spec §1.6；任务口径 ②） ----------

describe('git.pull — ff-only 与拒绝路径（spec §1.6）', () => {
  it('快进：pull --ff-only 成功（oldOid/newOid world 重读一致；argv = ff-only + --no-rebase）', async () => {
    const world = await makeWorld('pull-ff')
    await world.harness.service.push({ setUpstream: true })
    const baseOid = headOid(world.repo)
    const clone2 = join(await scratchDir('dshgit-sync-pullff-clone-', cleanups), 'clone')
    git(world.repo, 'clone', world.bare, clone2)
    await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
    git(clone2, 'add', 'remote.txt')
    git(clone2, 'commit', '-qm', 'feat: remote side')
    git(clone2, 'push', '-q', 'origin', 'main')
    const secondOid = refOid(clone2, 'HEAD') as string

    const result = await world.harness.service.pull()
    expect(result.fastForwarded).toBe(true)
    expect(result.remote).toBe('origin')
    expect(result.oldOid).toBe(baseOid)
    expect(result.newOid).toBe(secondOid)
    // world 重读：本地 HEAD 前进到 bare main。
    expect(headOid(world.repo)).toBe(secondOid)
    expect(refOid(world.bare, 'refs/heads/main')).toBe(secondOid)
    const pullSpawn = findArgv(world.harness.record, '--ff-only')
    expect(pullSpawn).toBeDefined()
    expect(pullSpawn!.argv.filter(arg => arg === 'pull' || arg === '--ff-only' || arg === '--no-rebase'))
      .toEqual(['pull', '--ff-only', '--no-rebase'])
  })

  it('分叉 → git/pull-diverged（预检 ahead/behind 进 details），HEAD 不变', async () => {
    const world = await makeWorld('pull-diverged')
    await world.harness.service.push({ setUpstream: true })
    const clone2 = join(await scratchDir('dshgit-sync-pulldiv-clone-', cleanups), 'clone')
    git(world.repo, 'clone', world.bare, clone2)
    await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
    git(clone2, 'add', 'remote.txt')
    git(clone2, 'commit', '-qm', 'feat: remote side')
    git(clone2, 'push', '-q', 'origin', 'main')
    const baseOid = headOid(world.repo)
    await commitFile(world.repo, 'c.txt', 'local\n', 'feat: local side')
    git(world.repo, 'fetch', '-q', 'origin')

    const { code, details } = await rejectionOf(() => world.harness.service.pull())
    expect(code).toBe('git/pull-diverged')
    expect((details as { branch: string }).branch).toBe('main')
    expect((details as { upstream: string }).upstream).toBe('origin/main')
    expect((details as { ahead: number }).ahead).toBe(1)
    expect((details as { behind: number }).behind).toBe(1)
    // world 重读：HEAD 未动（v1 无 merge UI，分叉即拒）。
    expect(refOid(world.repo, 'HEAD')).not.toBe(baseOid)
    expect(git(world.repo, 'log', '-1', '--format=%s').trim()).toBe('feat: local side')
  })

  it('脏区拒绝 → git/dirty-worktree（pathCount 去重合计），零命令副作用', async () => {
    const world = await makeWorld('pull-dirty')
    await world.harness.service.push({ setUpstream: true })
    await writeFile(join(world.repo, 'a.txt'), 'modified\n', 'utf8') // unstaged
    await writeFile(join(world.repo, 'untracked.txt'), 'new\n', 'utf8') // untracked

    const { code, details } = await rejectionOf(() => world.harness.service.pull())
    expect(code).toBe('git/dirty-worktree')
    expect((details as { branch: string }).branch).toBe('main')
    expect((details as { pathCount: number }).pathCount).toBe(2)
    // world 重读：工作区改动未被消费。
    expect(git(world.repo, 'status', '--porcelain')).toContain(' M a.txt')
  })

  it('pull detached → git/no-branch（push/pull 同守卫）', async () => {
    const world = await makeWorld('pull-detached')
    await world.harness.service.push({ setUpstream: true })
    git(world.repo, 'checkout', '-q', '--detach')
    const error = await rejectionOf(() => world.harness.service.pull())
    expect(error.code).toBe('git/no-branch')
    expect((error.details as { state: string }).state).toBe('detached')
  })
})

// ---------- fetch（spec §1.6；任务口径 ②③） ----------

describe('git.fetch — prune、behind 刷新与 remote 解析链（spec §1.6）', () => {
  it('fetch 后 behind 刷新：status world 重读 behind=1（写后失效生效）', async () => {
    const world = await makeWorld('fetch-behind')
    await world.harness.service.push({ setUpstream: true })
    const clone2 = join(await scratchDir('dshgit-sync-fetchbehind-clone-', cleanups), 'clone')
    git(world.repo, 'clone', world.bare, clone2)
    await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
    git(clone2, 'add', 'remote.txt')
    git(clone2, 'commit', '-qm', 'feat: remote side')
    git(clone2, 'push', '-q', 'origin', 'main')

    const result = await world.harness.service.fetch({ remote: null })
    expect(result.remote).toBe('origin')
    expect(result.pruned).toBe(false)
    // world 重读（经服务 status）：跟踪引用已前进 → behind=1。
    const snapshot = await world.harness.service.status()
    expect(snapshot.branch.upstream).toBe('origin/main')
    expect(snapshot.branch.ahead).toBe(0)
    expect(snapshot.branch.behind).toBe(1)
  })

  it('prune：远端分支被删后 fetch 报 pruned=true，tracking ref 消失（world 重读）', async () => {
    const world = await makeWorld('fetch-prune')
    await world.harness.service.push({ setUpstream: true })
    // 建远端分支再删（fixture 面）。
    git(world.repo, 'push', '-q', 'origin', 'main:refs/heads/feature')
    git(world.bare, 'update-ref', '-d', 'refs/heads/feature')
    expect(refOid(world.repo, 'refs/remotes/origin/feature')).not.toBeNull()

    const result = await world.harness.service.fetch({ remote: null })
    expect(result.pruned).toBe(true)
    // world 重读：tracking ref 被 prune 清除；main 跟踪引用不受影响。
    expect(refOid(world.repo, 'refs/remotes/origin/feature')).toBeNull()
    expect(refOid(world.repo, 'refs/remotes/origin/main')).toBe(headOid(world.repo))
  })

  it('解析链：零 remote → git/no-remote { remotes: [] }', async () => {
    const repo = await scratchRepo('dshgit-fetch-noremote-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    const harness = makeService(repo)
    const { code, details } = await rejectionOf(() => harness.service.fetch({ remote: null }))
    expect(code).toBe('git/no-remote')
    expect((details as { branch: string | null }).branch).toBe('main')
    expect((details as { remotes: string[] }).remotes).toEqual([])
  })

  it('解析链：多 remote 无 origin → git/choose-remote { remotes }（任务口径 ③）', async () => {
    const repo = await scratchRepo('dshgit-fetch-choose-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'remote', 'add', 'alpha', join(repo, '..', 'nowhere-alpha'))
    git(repo, 'remote', 'add', 'beta', join(repo, '..', 'nowhere-beta'))
    const harness = makeService(repo)
    const { code, details } = await rejectionOf(() => harness.service.fetch({ remote: null }))
    expect(code).toBe('git/choose-remote')
    expect((details as { remotes: string[] }).remotes.sort()).toEqual(['alpha', 'beta'])
    // world 重读：零命令执行（解析在 git remote 列表后即拒）。
    expect(harness.record.find(entry => entry.argv.includes('fetch'))).toBeUndefined()
  })

  it('解析链：多 remote 含 origin → 默认 origin；唯一非 origin remote → 用之；显式入参最优先', async () => {
    // 多 remote 含 origin：fetch(null) 落 origin（argv 断言）。
    const world = await makeWorld('fetch-origin-default')
    git(world.repo, 'remote', 'add', 'alpha', join(world.repo, '..', 'nowhere-alpha'))
    const viaOrigin = await world.harness.service.fetch({ remote: null })
    expect(viaOrigin.remote).toBe('origin')
    expect(lastArgv(world.harness.record, 'fetch')!.argv.at(-1)).toBe('origin')

    // 唯一 remote 非 origin：fetch(null) 用之。
    const single = await makeBare('fetch-single')
    const repo2 = await scratchRepo('dshgit-fetch-single-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo2, 'a.txt'), 'base\n', 'utf8')
    git(repo2, 'add', 'a.txt')
    git(repo2, 'commit', '-qm', 'base')
    git(repo2, 'remote', 'add', 'upstream', single)
    const harness2 = makeService(repo2)
    const viaUpstream = await harness2.service.fetch({ remote: null })
    expect(viaUpstream.remote).toBe('upstream')
    expect(lastArgv(harness2.record, 'fetch')!.argv.at(-1)).toBe('upstream')

    // 显式入参最优先：给出即用，不走解析链（beta 指向真实 bare → 成功）。
    const beta = await makeBare('fetch-beta')
    git(world.repo, 'remote', 'add', 'beta', beta)
    git(world.repo, 'push', '-q', 'beta', 'main:refs/heads/main')
    const explicit = await world.harness.service.fetch({ remote: 'beta' })
    expect(explicit.remote).toBe('beta')
    expect(lastArgv(world.harness.record, 'fetch')!.argv.at(-1)).toBe('beta')
    // alpha 指向不存在的目录：git 失败 → git-error 兜底（显式入参不做存在性预检，
    // 错误如实映射，不伪造成功）。
    const failed = await rejectionOf(() => world.harness.service.fetch({ remote: 'alpha' }))
    expect(['git/git-error', 'git/auth-failed', 'git/timeout']).toContain(failed.code)
  })
})

// ---------- 定时 fetch（v2 批次一 [清单 58]，D6=B） ----------

describe('定时 fetch — autoFetchIntervalMs（[清单 58]；失败仅 warn 不投 UI）', () => {
  it('短 interval 触发后台 fetch：bare 前进后 status world 重读 behind=1（afterWrite 刷新生效），成功路径零 warn', async () => {
    const world = await makeWorld('auto-fetch', { autoFetchIntervalMs: 60 })
    try {
      await world.harness.service.push({ setUpstream: true })
      // 第二 clone 推进 bare（后台 fetch 的目标增量）。
      const clone2 = join(await scratchDir('dshgit-sync-autofetch-clone-', cleanups), 'clone')
      git(world.repo, 'clone', world.bare, clone2)
      await writeFile(join(clone2, 'remote.txt'), 'remote\n', 'utf8')
      git(clone2, 'add', 'remote.txt')
      git(clone2, 'commit', '-qm', 'feat: remote side')
      git(clone2, 'push', '-q', 'origin', 'main')

      // logger 替身（构造后替换——autoFetchOnce 运行时读取 this.logger）。
      const warns: string[] = []
      ;(world.harness.service as unknown as { logger: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void } }).logger = {
        debug() {}, info() {}, warn: (m: string) => { warns.push(m) }, error() {},
      }

      // 构造期最早的 tick 在 clone2 推进前就 fetch 过——清掉 record，等**推进之后**的
      // 后台 fetch。等第 2 条 fetch 记录：record 在 spawn 起点写入，且 autoFetchInFlight
      // 闩保证不重叠——出现第 2 条 ⇒ 第 1 条（推进后的）必然已完成、跟踪引用已落盘。
      world.harness.record.length = 0
      await vi.waitFor(() => {
        expect(world.harness.record.filter(entry => entry.argv.includes('fetch')).length).toBeGreaterThanOrEqual(2)
      }, { timeout: 15_000, interval: 60 })

      // world 重读（经服务 status）：跟踪引用已前进 → behind=1。invalidate 掉引擎
      // fresh 扫描可能回填的推进前快照（TTL 1.5s 内），强制重扫。
      world.harness.service.invalidateStatusCache()
      const snapshot = await world.harness.service.status()
      expect(snapshot.branch.upstream).toBe('origin/main')
      expect(snapshot.branch.ahead).toBe(0)
      expect(snapshot.branch.behind).toBe(1)
      // 成功路径零 warn（失败仅 warn 的对照半在下一用例）。
      expect(warns).toEqual([])
    } finally {
      // 停表：短 interval 的后台轮不得泄漏进本文件其余用例。
      world.harness.service.stopAutoFetchTimer()
    }
  })

  it('autoFetchOnce 失败面：无 remote 仓库 → 仅 warn（code=git/no-remote 附带）不抛、不投 UI', async () => {
    const repo = await scratchRepo('dshgit-sync-autofail-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    const harness = makeService(repo)
    const warns: string[] = []
    ;(harness.service as unknown as { logger: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void } }).logger = {
      debug() {}, info() {}, warn: (m: string) => { warns.push(m) }, error() {},
    }
    // 不抛（await 直接观察），warn 携带 autoFetch 与 no-remote 域码。
    await expect(harness.service.autoFetchOnce()).resolves.toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('git autoFetch failed')
    expect(warns[0]).toContain('code=git/no-remote')
  })

  it('并发防抖：上一轮未完成时本轮跳过（autoFetchInFlight 闩），不叠加 git spawn', async () => {
    const repo = await scratchRepo('dshgit-sync-autoflight-', cleanups, { name: 't', email: 't@example.com' })
    await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'remote', 'add', 'origin', 'http://127.0.0.1:9/nonexistent.git') // 拒连：拉长单轮耗时
    const harness = makeService(repo)
    const record = harness.record
    // 同步连发两轮：第二轮因 in-flight 闩直接跳过。
    const first = harness.service.autoFetchOnce()
    const second = harness.service.autoFetchOnce()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    // 两轮只产生一轮的 git 命令面（status/fetch 各一次；无第二次 fetch）。
    const fetchSpawns = record.filter(entry => entry.argv.includes('fetch'))
    expect(fetchSpawns).toHaveLength(1)
  })
})
