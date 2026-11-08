/**
 * v2 批次三 — stash 测试（[清单 14] push/list/pop/drop；docs/v2-implementation-plan.md
 * §5.7 host 真仓库范式行）。
 *
 * 覆盖：push/list/pop/drop 全链 world 重读；**缺省 `-u` 含 untracked（D4=B：wire
 * 显式 boolean，client 缺省传 true）+ 显式 false 关闭**；无改动 ⇒ no-paths（op
 * 'stash'）；stale baseRevision（零命令）；**pop 冲突 ⇒ merge-conflict op
 * 'stash-pop' 且 stash 未丢（git 语义，§5.10）**；drop 无 ack 拒绝（零命令）；序号
 * 越界 ⇒ stash-not-found；空 stash ⇒ 空列表不抛错；stash list format 解析器夹具。
 *
 * 断言纪律：验证世界而非自述——每个写断言后用独立 execFileSync git 重读 stash refs
 * 与工作区。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { parseStashList } from '../src/stash.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeService(workspaceOverride: string): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000,
    workspaceOverride, autoFetchIntervalMs: 0,
  })
}

async function makeWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-stash-${name}-`, cleanups)
  git(repo, 'config', 'core.autocrlf', 'false')
  return { repo, service: makeService(repo) }
}

async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', '--', rel)
  git(repo, 'commit', '-qm', message)
  return worldHead(repo)
}

// ---------- world 重读（独立 git 进程，验证世界而非自述） ----------

function worldHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function worldStashSubjects(repo: string): string[] {
  return execFileSync('git', ['stash', 'list', '--format=%s'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter((line) => line !== '')
}

function worldStashCount(repo: string): number {
  return worldStashSubjects(repo).length
}

function worldClean(repo: string): boolean {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === ''
}

function worldUnmerged(repo: string): string[] {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((line) => line.trim()).filter((line) => line !== '')
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

describe('stashPush — D4=B untracked 两态 + 守卫（[清单 14]）', () => {
  it('includeUntracked=true（client 缺省形态）：staged+unstaged+untracked 全入 stash，world 重读干净', async () => {
    const { repo, service } = await makeWorld('push-u')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'modified\n', 'utf8')
    await service.stage(['a.txt'])
    await writeFile(join(repo, 'a.txt'), 'modified+wip\n', 'utf8')
    await writeFile(join(repo, 'untracked.bin'), 'loose\n', 'utf8')
    const result = await service.stashPush({ message: 'wip snapshot', includeUntracked: true })
    expect(result).toEqual({ index: 0 })
    // world：worktree 全净（untracked 也被卷走）；stash 一条；subject 带 -m 消息。
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(porcelain).toBe('')
    expect(existsSync(join(repo, 'untracked.bin'))).toBe(false)
    expect(worldStashCount(repo)).toBe(1)
    expect(worldStashSubjects(repo)[0]).toBe('On main: wip snapshot')
  })

  it('includeUntracked=false：untracked 留在工作区（world 重读），tracked 改动照常入 stash', async () => {
    const { repo, service } = await makeWorld('push-no-u')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'modified\n', 'utf8')
    await writeFile(join(repo, 'stay.txt'), 'stays\n', 'utf8')
    const result = await service.stashPush({ includeUntracked: false })
    expect(result.index).toBe(0)
    // world：untracked 文件还在；tracked 改动已被收进 stash（worktree 只剩 stay.txt）。
    expect(existsSync(join(repo, 'stay.txt'))).toBe(true)
    expect(worldStashCount(repo)).toBe(1)
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(porcelain).toBe('?? stay.txt\n')
  })

  it('仅 untracked 且 includeUntracked=false ⇒ no-paths（op stash）；无任何改动 ⇒ no-paths', async () => {
    const { repo, service } = await makeWorld('push-noop')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'only.txt'), 'untracked only\n', 'utf8')
    const onlyUntracked = await rejectionOf(() => service.stashPush({ includeUntracked: false }))
    expect(onlyUntracked.code).toBe('git/no-paths')
    expect(onlyUntracked.details.op).toBe('stash')
    expect(worldStashCount(repo)).toBe(0)
    // 全净仓库：任一形态都 no-paths。
    await writeFile(join(repo, 'only.txt'), '', 'utf8')
    git(repo, 'clean', '-fdq')
    const cleanRepo = await rejectionOf(() => service.stashPush({ includeUntracked: true }))
    expect(cleanRepo.code).toBe('git/no-paths')
    expect(worldStashCount(repo)).toBe(0)
  })

  it('stale baseRevision ⇒ bad-request stale-base-revision，零命令（stash 未建）', async () => {
    const { repo, service } = await makeWorld('push-stale')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'modified\n', 'utf8')
    const rejection = await rejectionOf(() => service.stashPush({ includeUntracked: true, baseRevision: '1'.repeat(40) }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('stale-base-revision')
    expect(worldStashCount(repo)).toBe(0)
    // 传入当前 HEAD 的基线 → 正常执行。
    const ok = await service.stashPush({ includeUntracked: true, baseRevision: worldHead(repo) })
    expect(ok.index).toBe(0)
    expect(worldStashCount(repo)).toBe(1)
  })
})

describe('stashList — 解析与空态（[清单 14]）', () => {
  it('两条 stash：index 0/1、oid 与 world 重读一致、authoredAt 为 ISO', async () => {
    const { repo, service } = await makeWorld('list-two')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'first\n', 'utf8')
    await service.stashPush({ includeUntracked: true, message: 'first' })
    await writeFile(join(repo, 'a.txt'), 'second\n', 'utf8')
    await service.stashPush({ includeUntracked: true, message: 'second' })
    const list = await service.stashList()
    expect(list.stashes.length).toBe(2)
    expect(list.stashes.map((entry) => entry.index)).toEqual([0, 1])
    for (const entry of list.stashes) {
      expect(entry.oid).toMatch(/^[0-9a-f]{40}$/)
      expect(entry.shortOid).toBe(entry.oid.slice(0, 7))
      expect(entry.message).toBe(`On main: ${entry.index === 0 ? 'second' : 'first'}`)
      expect(Number.isNaN(Date.parse(entry.authoredAt))).toBe(false)
      // world 重读：stash@{N} 的 oid 一致（不信 RPC 自述）。
      const worldOid = execFileSync('git', ['rev-parse', `stash@{${String(entry.index)}}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      expect(worldOid).toBe(entry.oid)
    }
  })

  it('空 stash ⇒ 空数组（不抛错）', async () => {
    const { repo, service } = await makeWorld('list-empty')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    expect(await service.stashList()).toEqual({ stashes: [] })
  })

  it('parseStashList 解析器夹具：记录分隔/字段序/契约破坏要响', () => {
    const oid = 'a'.repeat(40)
    const record = `${oid}\x1f2026-11-08T10:00:00+08:00\x1fOn main: msg\x1fstash@{0}\x1e`
    const parsed = parseStashList(record)
    expect(parsed.stashes.length).toBe(1)
    expect(parsed.stashes[0]).toMatchObject({ index: 0, oid, message: 'On main: msg', shortOid: oid.slice(0, 7) })
    // 记录间 \n（format: 语义）+ 双记录。
    const two = `${record}\n${'b'.repeat(40)}\x1f2026-11-08T11:00:00Z\x1fOn main: two\x1fstash@{1}\x1e`
    expect(parseStashList(two).stashes.length).toBe(2)
    // 契约破坏：缺尾分隔 / 字段不足 / ref 形状错。
    expect(() => parseStashList(`${record}\n`)).toThrow(/record-terminated/)
    expect(() => parseStashList(`${oid}\x1f2026-11-08T10:00:00Z\x1fshort\x1e`)).toThrow(/fields/)
    expect(() => parseStashList(`${oid}\x1f2026-11-08T10:00:00Z\x1fmsg\x1frefs/heads/main\x1e`)).toThrow(/ref name/)
  })
})

describe('stashPop — 默认与指定序号 + 冲突（[清单 14]）', () => {
  it('默认（index 0）：内容恢复、stash 清空（world 重读）', async () => {
    const { repo, service } = await makeWorld('pop-default')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'stashed\n', 'utf8')
    await service.stashPush({ includeUntracked: true })
    expect(worldClean(repo)).toBe(true)
    const result = await service.stashPop({})
    expect(result).toEqual({ index: 0 })
    // world：内容恢复（worktree 回到 stashed）、stash 清空。
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('stashed\n')
    expect(worldStashCount(repo)).toBe(0)
    expect(worldClean(repo)).toBe(false)
  })

  it('指定 index=1（两条 stash 中的旧条）：恢复的是 stash@{1} 的内容', async () => {
    const { repo, service } = await makeWorld('pop-index')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'older\n', 'utf8')
    await service.stashPush({ includeUntracked: true, message: 'older' })
    await writeFile(join(repo, 'a.txt'), 'newer\n', 'utf8')
    await service.stashPush({ includeUntracked: true, message: 'newer' })
    const result = await service.stashPop({ index: 1 })
    expect(result).toEqual({ index: 1 })
    // world：恢复的是旧条目（older），stash 剩 1 条（newer，index 前移为 0）。
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('older\n')
    expect(worldStashCount(repo)).toBe(1)
  })

  it('pop 冲突 ⇒ merge-conflict（op stash-pop、conflicted 与 world 一致）且 **stash 未丢**', async () => {
    const { repo, service } = await makeWorld('pop-conflict')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'stashed\n', 'utf8')
    await service.stashPush({ includeUntracked: true })
    // HEAD 前进到相异的同一行内容 → 应用 stash 的 diff 必冲突。
    await writeFile(join(repo, 'a.txt'), 'mainline\n', 'utf8')
    git(repo, 'add', '--', 'a.txt')
    git(repo, 'commit', '-qm', 'mainline edit')
    const rejection = await rejectionOf(() => service.stashPop({}))
    expect(rejection.code).toBe('git/merge-conflict')
    expect(rejection.details.op).toBe('stash-pop')
    expect(rejection.details.conflicted).toEqual(['a.txt'])
    expect(rejection.details.abortable).toBe(false) // stash-pop 无中间态伪引用
    expect(worldUnmerged(repo)).toEqual(rejection.details.conflicted)
    // **git 语义：冲突时 stash 不丢**（world 重读 stash 仍在——§5.10 UI 明示依据）。
    expect(worldStashCount(repo)).toBe(1)
    // 清理中间态（world 恢复干净，供 cleanups 安全删仓）。
    git(repo, 'reset', '--hard')
  })

  it('序号越界 / 空 stash ⇒ stash-not-found', async () => {
    const { repo, service } = await makeWorld('pop-missing')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    const empty = await rejectionOf(() => service.stashPop({}))
    expect(empty.code).toBe('git/stash-not-found')
    expect(empty.details).toEqual({ index: 0 })
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8')
    await service.stashPush({ includeUntracked: true })
    const outOfRange = await rejectionOf(() => service.stashPop({ index: 5 }))
    expect(outOfRange.code).toBe('git/stash-not-found')
    expect(outOfRange.details).toEqual({ index: 5 })
    const negative = await rejectionOf(() => service.stashPop({ index: -1 }))
    expect(negative.code).toBe('git/bad-request')
    expect(negative.details.reason).toBe('invalid-options')
  })
})

describe('stashDrop — danger 闸（[清单 14]）', () => {
  it('无 acknowledged ⇒ bad-request unacknowledged，零命令（stash 仍在）', async () => {
    const { repo, service } = await makeWorld('drop-no-ack')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8')
    await service.stashPush({ includeUntracked: true })
    const rejection = await rejectionOf(() => service.stashDrop({ index: 0, acknowledged: false }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('unacknowledged')
    // 零命令：world stash 未动。
    expect(worldStashCount(repo)).toBe(1)
  })

  it('acknowledged=true：删除指定条（world 重读 ref 消失）；再删 ⇒ stash-not-found', async () => {
    const { repo, service } = await makeWorld('drop-ok')
    await commitFile(repo, 'a.txt', 'base\n', 'seed a')
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8')
    await service.stashPush({ includeUntracked: true, message: 'victim' })
    const result = await service.stashDrop({ index: 0, acknowledged: true })
    expect(result).toEqual({ index: 0 })
    // world 重读：stash 引用消失（ref 不存在）。
    expect(worldStashCount(repo)).toBe(0)
    const gone = await rejectionOf(() => service.stashDrop({ index: 0, acknowledged: true }))
    expect(gone.code).toBe('git/stash-not-found')
    expect(gone.details).toEqual({ index: 0 })
  })
})
