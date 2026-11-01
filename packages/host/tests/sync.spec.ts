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
  overrides: { record?: SpawnRecord[]; networkTimeoutMs?: number } = {},
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
async function makeWorld(name: string, overrides: { record?: SpawnRecord[] } = {}): Promise<World> {
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
