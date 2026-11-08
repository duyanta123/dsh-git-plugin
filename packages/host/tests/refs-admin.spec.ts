/**
 * refs 管理面集成测试（v2 批次一 §3.7；docs/v2-implementation-plan.md §3.3/§3.4/§3.5）。
 * 范式照 sync.spec.ts / support.ts：真实临时 git 仓库 + world 重读断言（验证世界而非
 * 自述——每个写场景后用独立 execFileSync git 重读 refs/HEAD/worktree/tag 状态）。
 *
 * 覆盖（§3.7 host 真仓库范式行）：
 *   - branchCreate：新建（含 from 起点 / checkout 双命令形）/ 重名 branch-exists /
 *     空名 invalid-options；
 *   - branchSwitch：切换（world 重读 symbolic-ref HEAD）/ 不存在 branch-not-found /
 *     **脏区拒绝 dirty-worktree**（fresh 扫描）/ 幂等 Already-on；
 *   - branchDelete：已合并 -d 成功（wasMerged=true）/ 未合并 -d 拒绝 branch-not-merged
 *     （ref 仍在）/ `-D` 无 acknowledged ⇒ bad-request 'force-unacknowledged'（零命令）/
 *     `-D` 有 ack 强删（wasMerged=false）/ 不存在 branch-not-found / 删当前分支 git 拒绝；
 *   - tagCreate/tagDelete：annotated（cat-file -t = tag + peeled oid）/ lightweight +
 *     oid 起点 / 重名 tag-exists / force 无 ack 拒绝 + 有 ack 覆盖（world 重读消息）/
 *     删除 + 不存在 tag-not-found；
 *   - remoteList：双 remote + 显式 pushurl（world 对照 `git remote -v`）/ 空 remote / 非仓库；
 *   - worktreeList：主 worktree 常态 / unborn（全零 HEAD 归 null）/ detached / locked
 *     （布尔位）+ parseWorktreePorcelain 纯函数（bare 块 / 未知属性行前向容忍 /
 *     缺锚契约错 / 非 newline 结尾契约错）；
 *   - worktreeAdd/worktreeRemove：`-b` 新建 + world 重读 / 检出现有分支 / branch 被
 *     另一 worktree 占用 ⇒ worktree-failed / 重复 path ⇒ worktree-failed / branch 与
 *     newBranch 互斥且至少其一 ⇒ bad-request 'invalid-options' / 脏 worktree 无 force ⇒
 *     worktree-failed（目录仍在）/ `--force` 无 acknowledged ⇒ bad-request（零命令）/
 *     force 有 ack 移除（目录消失 + list 不含）/ path 不存在 ⇒ worktree-failed；
 *   - safe.bareRepository 前缀与 cwd 纪律：全部 spawn argv 带 `-c
 *     safe.bareRepository=explicit`；写变更的 cwd == repoRoot。
 *
 * 定时 fetch 与 force push 的用例在 sync.spec.ts（§3.7 分工）；ping（P3-7）在 ping.spec.ts。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { parseWorktreePorcelain } from '../src/refs-admin.ts'
import { git, localSubprocess, scratchDir, scratchRepo } from './support.ts'
import type { SpawnRecord } from './support.ts'

// 并行负载下的资源裕量（真实 git 子进程；sync.spec 同款先例）。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []

afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ---------- 夹具设施 ----------

interface Harness {
  service: InstanceType<typeof GitService>
  record: SpawnRecord[]
}

function makeService(
  workspaceOverride: string,
  overrides: { record?: SpawnRecord[] } = {},
): Harness {
  const record = overrides.record ?? []
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess(record))
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    commitTimeoutMs: 15_000,
    networkTimeoutMs: 20_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
    // 本文件不测定时 fetch（sync.spec 分工）——显式关闭，interval 不挂。
    autoFetchIntervalMs: 0,
  })
  return { service, record }
}

/** 标准世界：单提交工作仓库（main），本地身份固定。 */
async function makeWorld(name: string, overrides: { record?: SpawnRecord[] } = {}): Promise<{
  repo: string
  harness: Harness
  head: string
}> {
  const repo = await scratchRepo(`dshgit-refs-${name}-`, cleanups, { name: 't', email: 't@example.com' })
  await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'base')
  const head = headOid(repo)
  return { repo, harness: makeService(repo, overrides), head }
}

/** 在仓库里追加一个提交（fixture 面），返回新 HEAD。 */
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

function symbolicHead(repo: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** git 输出路径 → 与 realpath 同形的比较形（Windows 反斜杠/正斜杠归一）。 */
function norm(path: string): string {
  return path.replaceAll('\\', '/')
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, message: remote!.message, details: remote!.details as Record<string, unknown> }
}

/** 本地 bare 目录（remoteList/worktree 远端夹具用）。 */
async function makeBare(name: string): Promise<string> {
  const dir = join(await scratchDir(`dshgit-refs-${name}-`, cleanups), 'origin.git')
  await mkdir(dir, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  return dir
}

/**
 * worktree 的宿主目录（**每测一个唯一 scratch 目录**——worktree 不能建在仓库内
 * （untracked 噪声），建在共享 Temp 根的固定名会被并行/残留撞车；父目录挂 cleanups
 * 随收尾删除）。
 */
async function makeWtPath(name: string): Promise<string> {
  return join(await scratchDir(`dshgit-refs-wt-${name}-`, cleanups), 'wt')
}

// ---------- branchCreate ----------

describe('git.branchCreate — [清单 23]', () => {
  it('新建：oid 回读 == HEAD；world 重读 refs/heads 落盘；argv 带 `--` 分隔符', async () => {
    const { repo, harness, head } = await makeWorld('create')
    const result = await harness.service.branchCreate({ name: 'feature' })
    expect(result).toEqual({ name: 'feature', oid: head, checkedOut: false })
    // world 重读：分支存在且指向 HEAD；HEAD 未动。
    expect(refOid(repo, 'refs/heads/feature')).toBe(head)
    expect(symbolicHead(repo)).toBe('main')
    // argv 断言：`branch -- <name>`（-- 保护，B3 同款的选项注入防线）。
    const spawn = harness.record.find(entry => entry.argv.includes('branch'))
    expect(spawn).toBeDefined()
    expect(spawn!.argv.slice(-2)).toEqual(['--', 'feature'])
  })

  it('from 起点：新分支指向指定修订（world 重读），非 HEAD', async () => {
    const { repo, harness, head } = await makeWorld('from')
    const second = await commitFile(repo, 'b.txt', 'second\n', 'feat: second')
    const result = await harness.service.branchCreate({ name: 'old', from: head })
    expect(result.oid).toBe(head)
    expect(result.oid).not.toBe(second)
    expect(refOid(repo, 'refs/heads/old')).toBe(head)
  })

  it('checkout=true：branch + switch 双命令，HEAD 已切换（world 重读 symbolic-ref）', async () => {
    const { repo, harness, head } = await makeWorld('checkout')
    const result = await harness.service.branchCreate({ name: 'feat2', checkout: true })
    expect(result).toEqual({ name: 'feat2', oid: head, checkedOut: true })
    expect(symbolicHead(repo)).toBe('feat2')
    // 双命令形：branch 与 switch 都在场（switch -c 位置参数无 -- 保护，拆两命令）。
    expect(harness.record.find(entry => entry.argv.includes('branch'))).toBeDefined()
    expect(harness.record.find(entry => entry.argv.includes('switch'))).toBeDefined()
  })

  it('重名 → git/branch-exists（details.name），零写副作用', async () => {
    const { repo, harness, head } = await makeWorld('exists')
    const { code, details } = await rejectionOf(() => harness.service.branchCreate({ name: 'main' }))
    expect(code).toBe('git/branch-exists')
    expect(details.name).toBe('main')
    expect(refOid(repo, 'refs/heads/main')).toBe(head)
    // 存在性预检在 create 之前拒绝：无第二个 branch 命令。
    expect(harness.record.filter(entry => entry.argv.includes('branch'))).toHaveLength(0)
  })

  it('空名 → git/bad-request reason=invalid-options（零命令）', async () => {
    const { harness } = await makeWorld('empty-name')
    const { code, details } = await rejectionOf(() => harness.service.branchCreate({ name: '  ' }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('invalid-options')
    expect(harness.record).toHaveLength(0)
  })
})

// ---------- branchSwitch ----------

describe('git.branchSwitch — [清单 23]', () => {
  it('切换：from/to 正确，world 重读 symbolic-ref HEAD == to', async () => {
    const { repo, harness } = await makeWorld('switch')
    git(repo, 'branch', 'feature')
    const result = await harness.service.branchSwitch('feature')
    expect(result).toEqual({ from: 'main', to: 'feature' })
    expect(symbolicHead(repo)).toBe('feature')
    // 回读纪律：to 来自回读而非入参（switch 命令的 argv 仍带 -- 保护）。
    const spawn = harness.record.find(entry => entry.argv.includes('switch'))
    expect(spawn).toBeDefined()
    expect(spawn!.argv.slice(-2)).toEqual(['--', 'feature'])
  })

  it('不存在 → git/branch-not-found（details.name），HEAD 不变', async () => {
    const { repo, harness } = await makeWorld('switch-missing')
    const { code, details } = await rejectionOf(() => harness.service.branchSwitch('ghost'))
    expect(code).toBe('git/branch-not-found')
    expect(details.name).toBe('ghost')
    expect(symbolicHead(repo)).toBe('main')
  })

  it('脏区拒绝 → git/dirty-worktree（[清单 23] 切换前置；details.pathCount 去重合计），HEAD 不变', async () => {
    const { repo, harness } = await makeWorld('switch-dirty')
    git(repo, 'branch', 'feature')
    await writeFile(join(repo, 'a.txt'), 'modified\n', 'utf8') // unstaged
    await writeFile(join(repo, 'untracked.txt'), 'new\n', 'utf8') // untracked
    const { code, details } = await rejectionOf(() => harness.service.branchSwitch('feature'))
    expect(code).toBe('git/dirty-worktree')
    expect(details.branch).toBe('main')
    expect(details.pathCount).toBe(2)
    // world 重读：HEAD 未动、工作区改动未被消费。
    expect(symbolicHead(repo)).toBe('main')
    expect(git(repo, 'status', '--porcelain')).toContain(' M a.txt')
  })

  it('幂等：切换到当前分支成功（git Already-on 语义），from == to', async () => {
    const { harness } = await makeWorld('switch-same')
    const result = await harness.service.branchSwitch('main')
    expect(result).toEqual({ from: 'main', to: 'main' })
  })
})

// ---------- branchDelete ----------

describe('git.branchDelete — [清单 23]', () => {
  it('已合并 -d：wasMerged=true，world 重读 ref 消失', async () => {
    const { repo, harness, head } = await makeWorld('del-merged')
    git(repo, 'branch', 'topic')
    await commitFile(repo, 'b.txt', 'second\n', 'feat: second') // topic(=旧 HEAD) 是 main 祖先
    const result = await harness.service.branchDelete({ name: 'topic' })
    expect(result).toEqual({ deleted: 'topic', wasMerged: true })
    expect(refOid(repo, 'refs/heads/topic')).toBeNull()
    expect(refOid(repo, 'refs/heads/main')).not.toBe(head)
  })

  it('未合并 -d → git/branch-not-merged（details.name），ref 仍在（world 重读）', async () => {
    const { repo, harness } = await makeWorld('del-unmerged')
    const second = await commitFile(repo, 'b.txt', 'second\n', 'feat: second')
    git(repo, 'reset', '-q', '--hard', 'HEAD~1') // main 回退；topic 独占 second
    git(repo, 'branch', 'topic', second)
    const { code, details } = await rejectionOf(() => harness.service.branchDelete({ name: 'topic' }))
    expect(code).toBe('git/branch-not-merged')
    expect(details.name).toBe('topic')
    expect(refOid(repo, 'refs/heads/topic')).toBe(second)
    expect(refOid(repo, 'HEAD')).not.toBe(second)
  })

  it('-D 无 acknowledged → git/bad-request force-unacknowledged，**零命令执行**', async () => {
    const { repo, harness } = await makeWorld('del-noack')
    git(repo, 'branch', 'topic')
    harness.record.length = 0
    const { code, details } = await rejectionOf(() => harness.service.branchDelete({ name: 'topic', force: true }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('force-unacknowledged')
    expect(harness.record).toHaveLength(0)
    // world 重读：ref 仍在。
    expect(refOid(repo, 'refs/heads/topic')).not.toBeNull()
  })

  it('-D 有 acknowledged：未合并也删（wasMerged=false），world 重读 ref 消失', async () => {
    const { repo, harness } = await makeWorld('del-force')
    const second = await commitFile(repo, 'b.txt', 'second\n', 'feat: second')
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    git(repo, 'branch', 'topic', second)
    const result = await harness.service.branchDelete({ name: 'topic', force: true, acknowledged: true })
    expect(result).toEqual({ deleted: 'topic', wasMerged: false })
    expect(refOid(repo, 'refs/heads/topic')).toBeNull()
  })

  it('不存在 → git/branch-not-found（-d/-D 同码）', async () => {
    const { harness } = await makeWorld('del-missing')
    const plain = await rejectionOf(() => harness.service.branchDelete({ name: 'ghost' }))
    expect(plain.code).toBe('git/branch-not-found')
    expect(plain.details.name).toBe('ghost')
    const forced = await rejectionOf(() => harness.service.branchDelete({ name: 'ghost', force: true, acknowledged: true }))
    expect(forced.code).toBe('git/branch-not-found')
  })

  it('删当前分支：git 自身拒绝（exit 1）→ git-error 兜底（UI 前置禁用的 host 侧事实）', async () => {
    const { repo, harness } = await makeWorld('del-current')
    const { code } = await rejectionOf(() => harness.service.branchDelete({ name: 'main' }))
    expect(code).toBe('git/git-error')
    expect(refOid(repo, 'refs/heads/main')).not.toBeNull()
  })
})

// ---------- tagCreate / tagDelete ----------

describe('git.tagCreate / git.tagDelete — [清单 30]', () => {
  it('annotated：cat-file -t = tag，peeled oid == HEAD（world 重读）', async () => {
    const { repo, harness, head } = await makeWorld('tag-annotated')
    const result = await harness.service.tagCreate({ name: 'v1', message: 'release v1' })
    expect(result).toEqual({ name: 'v1', oid: head, annotated: true })
    expect(git(repo, 'cat-file', '-t', 'v1').trim()).toBe('tag')
    expect(refOid(repo, 'v1^{commit}')).toBe(head)
  })

  it('lightweight + oid 起点：tag 直接指向该提交（world 重读）', async () => {
    const { repo, harness, head } = await makeWorld('tag-light')
    await commitFile(repo, 'b.txt', 'second\n', 'feat: second')
    const result = await harness.service.tagCreate({ name: 'start', oid: head })
    expect(result).toEqual({ name: 'start', oid: head, annotated: false })
    expect(refOid(repo, 'refs/tags/start')).toBe(head)
  })

  it('重名（非 force）→ git/tag-exists（details.name）', async () => {
    const { harness } = await makeWorld('tag-exists')
    await harness.service.tagCreate({ name: 'v1', message: 'first' })
    const { code, details } = await rejectionOf(() => harness.service.tagCreate({ name: 'v1' }))
    expect(code).toBe('git/tag-exists')
    expect(details.name).toBe('v1')
  })

  it('force 无 acknowledged → git/bad-request force-unacknowledged；world 重读原消息未被覆盖', async () => {
    const { repo, harness } = await makeWorld('tag-noack')
    await harness.service.tagCreate({ name: 'v1', message: 'first' })
    const { code, details } = await rejectionOf(() => harness.service.tagCreate({ name: 'v1', message: 'rewritten', force: true }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('force-unacknowledged')
    expect(git(repo, 'tag', '-l', '--format=%(contents)', 'v1').trim()).toBe('first')
  })

  it('force 有 acknowledged：覆盖成功，world 重读新消息（annotated peeled 不变时 oid 随起点）', async () => {
    const { repo, harness } = await makeWorld('tag-force')
    await harness.service.tagCreate({ name: 'v1', message: 'first' })
    const second = await commitFile(repo, 'b.txt', 'second\n', 'feat: second')
    const result = await harness.service.tagCreate({ name: 'v1', message: 'rewritten', force: true, acknowledged: true })
    expect(result).toEqual({ name: 'v1', oid: second, annotated: true })
    expect(git(repo, 'tag', '-l', '--format=%(contents)', 'v1').trim()).toBe('rewritten')
    expect(refOid(repo, 'v1^{commit}')).toBe(second)
  })

  it('tagDelete：world 重读 ref 消失；不存在 → git/tag-not-found', async () => {
    const { repo, harness } = await makeWorld('tag-delete')
    await harness.service.tagCreate({ name: 'v1', message: 'x' })
    const result = await harness.service.tagDelete('v1')
    expect(result).toEqual({ deleted: 'v1' })
    expect(refOid(repo, 'refs/tags/v1')).toBeNull()
    const { code, details } = await rejectionOf(() => harness.service.tagDelete('v1'))
    expect(code).toBe('git/tag-not-found')
    expect(details.name).toBe('v1')
  })
})

// ---------- remoteList ----------

describe('git.remoteList — [清单 57]', () => {
  it('双 remote + 显式 pushurl：与 `git remote -v` world 对照（pushUrl=null = 未显式配置）', async () => {
    const { repo, harness } = await makeWorld('remotes')
    const bare1 = await makeBare('remotes-a')
    const bare2 = await makeBare('remotes-b')
    git(repo, 'remote', 'add', 'origin', bare1)
    git(repo, 'remote', 'add', 'upstream', bare2)
    git(repo, 'remote', 'set-url', '--push', 'upstream', `${bare2}-push`)
    const result = await harness.service.remoteList()
    expect(result.remotes).toHaveLength(2)
    const byName = new Map(result.remotes.map(remote => [remote.name, remote]))
    // git remote add 存入的 url 按入参原样回读（Windows 下反斜杠原样），按 norm 比较。
    expect(byName.get('origin')!.name).toBe('origin')
    expect(norm(byName.get('origin')!.url)).toBe(norm(bare1))
    expect(byName.get('origin')!.pushUrl).toBeNull()
    expect(norm(byName.get('upstream')!.url)).toBe(norm(bare2))
    expect(norm(byName.get('upstream')!.pushUrl as string)).toBe(norm(`${bare2}-push`))
    // world 对照：与独立 git remote -v 的一致性（名字集合）。
    const worldNames = git(repo, 'remote').split('\n').map(line => line.trim()).filter(line => line !== '')
    expect(worldNames.sort()).toEqual(['origin', 'upstream'])
  })

  it('空 remote 仓库 → remotes: []', async () => {
    const { harness } = await makeWorld('remotes-empty')
    const result = await harness.service.remoteList()
    expect(result).toEqual({ remotes: [] })
  })

  it('非仓库 → git/no-repository（details.probed = 工作区）', async () => {
    const dir = await scratchDir('dshgit-refs-norepo-', cleanups)
    const harness = makeService(dir)
    const { code, details } = await rejectionOf(() => harness.service.remoteList())
    expect(code).toBe('git/no-repository')
    expect(norm(details.probed as string)).toBe(norm(dir))
  })
})

// ---------- worktreeList ----------

describe('git.worktreeList — [清单 62]', () => {
  it('常态：主 worktree 条目（path/head/branch world 对照），无 bare/detached/locked', async () => {
    const { repo, harness, head } = await makeWorld('wt-list')
    const result = await harness.service.worktreeList()
    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toEqual({
      path: norm(repo),
      head,
      branch: 'main',
      bare: false,
      detached: false,
      locked: false,
    })
  })

  it('unborn 仓库：porcelain 全零 HEAD 归 null（world 重读 unborn 事实），branch 短名在场', async () => {
    const repo = await scratchRepo('dshgit-refs-wt-unborn-', cleanups)
    const harness = makeService(repo)
    const result = await harness.service.worktreeList()
    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toMatchObject({ path: norm(repo), head: null, branch: 'main', bare: false })
  })

  it('多 worktree + detached + locked：porcelain 形状逐项落 wire（world 重读 fixture 建态）', async () => {
    const { repo, harness } = await makeWorld('wt-multi')
    const wtbPath = await makeWtPath('multi-b')
    const wtdPath = await makeWtPath('multi-d')
    const wtlPath = await makeWtPath('multi-l')
    git(repo, 'worktree', 'add', '-b', 'wtb', wtbPath)
    git(repo, 'worktree', 'add', '--detach', wtdPath)
    git(repo, 'worktree', 'add', '-b', 'wtl', wtlPath)
    git(repo, 'worktree', 'lock', '--reason', 'hold for review', wtlPath)
    const result = await harness.service.worktreeList()
    expect(result.worktrees).toHaveLength(4)
    const byBranch = new Map(result.worktrees.map(entry => [entry.branch, entry]))
    expect(byBranch.get('main')).toMatchObject({ detached: false, locked: false, bare: false })
    expect(byBranch.get('wtb')).toMatchObject({ path: norm(wtbPath), detached: false, locked: false })
    const detached = result.worktrees.find(entry => entry.detached)
    expect(detached).toBeDefined()
    expect(detached).toMatchObject({ branch: null, path: norm(wtdPath) })
    const locked = result.worktrees.find(entry => entry.locked)
    expect(locked).toBeDefined()
    expect(locked).toMatchObject({ branch: 'wtl' })
  })

  it('parseWorktreePorcelain 纯函数：bare 块（无 HEAD 行）/ 未知属性行前向容忍 / 缺锚与非 newline 结尾 = 契约错', () => {
    const sample = [
      'worktree C:/repo/main',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/bare.git',
      'bare',
      '',
      'worktree C:/repo/wt',
      'HEAD 0000000000000000000000000000000000000000',
      'branch refs/heads/wt',
      'locked policy says so',
      'prunable check it',
      '',
    ].join('\n')
    const parsed = parseWorktreePorcelain(`${sample}\n`)
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({
      path: 'C:/repo/main', head: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main', bare: false, detached: false, locked: false,
    })
    expect(parsed[1]).toEqual({
      path: 'C:/repo/bare.git', head: null, branch: null, bare: true, detached: false, locked: false,
    })
    // unborn 全零归 null；locked reason 自由文本只落布尔位；未知属性行（prunable）容忍。
    expect(parsed[2]).toEqual({
      path: 'C:/repo/wt', head: null, branch: 'wt', bare: false, detached: false, locked: true,
    })
    // 契约破坏要响：块锚缺失 / 非 newline 结尾。
    expect(() => parseWorktreePorcelain('HEAD 0123456789abcdef0123456789abcdef01234567\n')).toThrow(/before worktree line/)
    expect(() => parseWorktreePorcelain('worktree C:/x')).toThrow(/not newline-terminated/)
  })
})

// ---------- worktreeAdd / worktreeRemove ----------

describe('git.worktreeAdd / git.worktreeRemove — [清单 68]', () => {
  it('newBranch：add 成功 + world 重读（目录存在、HEAD 符号引用为新分支）、list 含新条目', async () => {
    const { harness, head } = await makeWorld('wt-add')
    const wtPath = await makeWtPath('add')
    const result = await harness.service.worktreeAdd({ path: wtPath, newBranch: 'wtb' })
    expect(norm(result.path)).toBe(norm(wtPath))
    expect(result.branch).toBe('wtb')
    expect(result.head).toBe(head)
    // world 重读：目录存在、新 worktree 的 HEAD 在 wtb 上。
    expect(existsSync(wtPath)).toBe(true)
    expect(symbolicHead(wtPath)).toBe('wtb')
    const list = await harness.service.worktreeList()
    expect(list.worktrees.find(entry => entry.branch === 'wtb')).toBeDefined()
  })

  it('branch=现有分支：检出既有分支（world 重读）', async () => {
    const { repo, harness, head } = await makeWorld('wt-add-existing')
    git(repo, 'branch', 'existing')
    const wtPath = await makeWtPath('add-existing')
    const result = await harness.service.worktreeAdd({ path: wtPath, branch: 'existing' })
    expect(norm(result.path)).toBe(norm(wtPath))
    expect(result.branch).toBe('existing')
    expect(result.head).toBe(head)
    expect(symbolicHead(wtPath)).toBe('existing')
  })

  it('branch 已被另一 worktree 检出 → git/worktree-failed（details.path + 脱敏 stderr）', async () => {
    const { harness } = await makeWorld('wt-occupied')
    const first = await makeWtPath('occ-a')
    const second = await makeWtPath('occ-b')
    await harness.service.worktreeAdd({ path: first, newBranch: 'shared' })
    const { code, details } = await rejectionOf(() => harness.service.worktreeAdd({ path: second, branch: 'shared' }))
    expect(code).toBe('git/worktree-failed')
    // details.path = 本次操作的目标路径（add 的第二 worktree），被占用信息在 stderr。
    expect(norm(details.path as string)).toBe(norm(second))
    expect(details.stderr as string).toContain('already used by worktree')
    // world 重读：第二个目录未创建。
    expect(existsSync(second)).toBe(false)
  })

  it('path 已存在非空 → git/worktree-failed', async () => {
    const { harness } = await makeWorld('wt-dup')
    const occupied = await makeWtPath('dup')
    await harness.service.worktreeAdd({ path: occupied, newBranch: 'one' })
    const { code } = await rejectionOf(() => harness.service.worktreeAdd({ path: occupied, branch: 'main' }))
    expect(code).toBe('git/worktree-failed')
  })

  it('branch 与 newBranch 互斥且至少其一 → git/bad-request invalid-options（零命令）', async () => {
    const { harness } = await makeWorld('wt-badopts')
    const both = await rejectionOf(() => harness.service.worktreeAdd({ path: join('x', 'y'), branch: 'main', newBranch: 'n' }))
    expect(both.code).toBe('git/bad-request')
    expect(both.details.reason).toBe('invalid-options')
    const neither = await rejectionOf(() => harness.service.worktreeAdd({ path: join('x', 'y') }))
    expect(neither.code).toBe('git/bad-request')
    expect(neither.details.reason).toBe('invalid-options')
    expect(harness.record).toHaveLength(0)
  })

  it('脏 worktree 无 force → git/worktree-failed（git 自身拒绝），目录与改动仍在（world 重读）', async () => {
    const { harness } = await makeWorld('wt-dirty')
    const wtPath = await makeWtPath('dirty')
    await harness.service.worktreeAdd({ path: wtPath, newBranch: 'dirtyb' })
    await writeFile(join(wtPath, 'a.txt'), 'dirtied\n', 'utf8')
    const { code, details } = await rejectionOf(() => harness.service.worktreeRemove({ path: wtPath }))
    expect(code).toBe('git/worktree-failed')
    expect(details.stderr as string).toContain('--force')
    expect(existsSync(wtPath)).toBe(true)
    expect(await readFile(join(wtPath, 'a.txt'), 'utf8')).toBe('dirtied\n')
  })

  it('force 无 acknowledged → git/bad-request force-unacknowledged，零命令', async () => {
    const { harness } = await makeWorld('wt-noack')
    const wtPath = await makeWtPath('noack')
    await harness.service.worktreeAdd({ path: wtPath, newBranch: 'nb' })
    harness.record.length = 0
    const { code, details } = await rejectionOf(() => harness.service.worktreeRemove({ path: wtPath, force: true }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('force-unacknowledged')
    expect(harness.record).toHaveLength(0)
    expect(existsSync(wtPath)).toBe(true)
  })

  it('force 有 acknowledged：脏 worktree 移除成功，目录消失、list 不含（world 重读）', async () => {
    const { harness } = await makeWorld('wt-force-remove')
    const wtPath = await makeWtPath('force-remove')
    await harness.service.worktreeAdd({ path: wtPath, newBranch: 'forceb' })
    await writeFile(join(wtPath, 'extra.txt'), 'untracked\n', 'utf8')
    const result = await harness.service.worktreeRemove({ path: wtPath, force: true, acknowledged: true })
    expect(norm(result.removed)).toBe(norm(wtPath))
    expect(existsSync(wtPath)).toBe(false)
    const list = await harness.service.worktreeList()
    expect(list.worktrees.find(entry => norm(entry.path) === norm(wtPath))).toBeUndefined()
  })

  it('path 不存在 → git/worktree-failed（details.stderr 含 not a working tree）', async () => {
    const { harness } = await makeWorld('wt-missing')
    const missing = join(await scratchDir('dshgit-refs-wt-missing-', cleanups), 'absent')
    const { code, details } = await rejectionOf(() => harness.service.worktreeRemove({ path: missing }))
    expect(code).toBe('git/worktree-failed')
    expect(details.stderr as string).toContain('not a working tree')
  })
})

// ---------- 横切纪律 ----------

describe('safe.bareRepository 前缀与 cwd 纪律（四实例共用安全前缀）', () => {
  it('refs 管理面全部 spawn argv 带 `-c safe.bareRepository=explicit`；写变更 cwd == repoRoot', async () => {
    const { repo, harness } = await makeWorld('guards')
    await harness.service.branchCreate({ name: 'b1', checkout: true })
    await harness.service.tagCreate({ name: 't1', message: 'm' })
    // b1 已检出，先切回 main 再强删（删当前分支被 git 拒绝——上方用例钉住该行为）。
    await harness.service.branchSwitch('main')
    await harness.service.branchDelete({ name: 'b1', force: true, acknowledged: true })
    await harness.service.tagDelete('t1')
    const wtPath = await makeWtPath('guards')
    await harness.service.worktreeAdd({ path: wtPath, newBranch: 'wtgb' })
    await harness.service.worktreeRemove({ path: wtPath, force: true, acknowledged: true })
    expect(harness.record.length).toBeGreaterThan(0)
    for (const entry of harness.record) {
      expect(entry.argv.slice(1, 3)).toEqual(['-c', 'safe.bareRepository=explicit'])
    }
    // 变更类命令的 cwd == repoRoot（worktree 回读的 rev-parse 除外——cwd 是新 worktree）。
    const writeOps = harness.record.filter(entry => entry.argv.includes('branch') || entry.argv.includes('tag') || entry.argv.includes('worktree'))
    for (const entry of writeOps) {
      const isWorktreeReadback = entry.argv.includes('symbolic-ref') || (entry.argv.includes('rev-parse') && !entry.argv.includes('--show-toplevel'))
      if (!isWorktreeReadback) expect(norm(entry.cwd)).toBe(norm(repo))
    }
  })
})
