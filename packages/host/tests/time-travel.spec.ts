/**
 * v2 批次二 — 时间旅行测试（[清单 37] cherry-pick / revert / reset / abortOperation；
 * docs/v2-implementation-plan.md §4.7 host 真仓库范式行）。
 *
 * 覆盖：三档 reset 各自 world 重读（HEAD / staged / unstaged / 工作区文件独立 git
 * 进程重读）/ hard 无 ack 拒绝（零命令）/ stale baseRevision / cherry-pick 冲突 ⇒
 * merge-conflict（details.conflicted 与 world diff-filter=U 重读一致、abortable）/
 * **CHERRY_PICK_HEAD 在场 ⇒ operation-in-progress**（含 reset 叠加拒绝）/
 * **abort 后回原 HEAD**（world 重读）+ abort 幂等（无中间态 ⇒ null）/ cherry-pick 与
 * revert 的成功路径 / 空 revert ⇒ git-error op 'revert' / revert 冲突（REVERT_HEAD
 * 探测）/ unknown-revision / unborn·detached ⇒ no-branch。
 *
 * 断言纪律：验证世界而非自述——每个写断言后用独立 execFileSync git 重读世界。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
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
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000, workspaceOverride,
    autoFetchIntervalMs: 0,
  })
}

async function makeWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-tt-${name}-`, cleanups)
  // 本机全局 autocrlf=true 会把 reset/checkout 的检出文件 smudge 成 CRLF——fixture
  // 钉死 false 让 world 重读的文件内容断言确定（LF 原样）。
  git(repo, 'config', 'core.autocrlf', 'false')
  // 引擎侧 cherry-pick/revert 以仓库身份创建提交——钉死 repo 本地 identity，
  // 免依赖开发机的全局配置（CI runner 无全局 identity ⇒ "Committer identity unknown"）。
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  return { repo, service: makeService(repo) }
}

/** 在仓库里追加一个提交（fixture 面），返回新 HEAD。 */
async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', rel)
  git(repo, 'commit', '-qm', message)
  return worldHead(repo)
}

// ---------- world 重读（独立 git 进程，验证世界而非自述） ----------

function worldHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function worldStaged(repo: string): string[] {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function worldUnmerged(repo: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function worldClean(repo: string): boolean {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.trim() === ''
}

function pseudoHeadExists(repo: string, head: 'CHERRY_PICK_HEAD' | 'REVERT_HEAD'): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', head], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
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

describe('reset — 三档 world 重读（[清单 37]）', () => {
  it('soft：HEAD 后退、改动进暂存区（world 重读）', async () => {
    const { repo, service } = await makeWorld('soft')
    const c0 = await commitFile(repo, 'a.txt', 'a\n', 'seed a')
    const c1 = await commitFile(repo, 'b.txt', 'b\n', 'add b')
    const result = await service.reset({ kind: 'soft', target: 'HEAD~1', acknowledged: true, baseRevision: c1 })
    expect(result).toEqual({ op: 'reset', oldOid: c1, newOid: c0 })
    // world：HEAD 回到 c0；b.txt 的改动在暂存区。
    expect(worldHead(repo)).toBe(c0)
    expect(worldStaged(repo)).toEqual(['b.txt'])
    expect(worldClean(repo)).toBe(false)
  })

  it('mixed（target null = HEAD）：暂存清空、改动退回工作区（world 重读）', async () => {
    const { repo, service } = await makeWorld('mixed')
    await commitFile(repo, 'a.txt', 'a\n', 'seed a')
    const c1 = await commitFile(repo, 'b.txt', 'b\n', 'add b')
    await service.reset({ kind: 'soft', target: 'HEAD~1', acknowledged: true, baseRevision: c1 })
    // 此刻 staged=[b.txt]，HEAD=c0。mixed target=null（= HEAD）只重置 index。
    const result = await service.reset({ kind: 'mixed', target: null, acknowledged: true, baseRevision: worldHead(repo) })
    expect(result.op).toBe('reset')
    expect(result.oldOid).toBe(result.newOid)
    expect(worldStaged(repo)).toEqual([])
    // git 真实语义：b.txt 从未在 HEAD（c0）中存在——index 重置后工作区文件成为
    // untracked（'??'），不是 ' M'（那是对已跟踪文件的修改态）。
    const unstaged = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(unstaged).toContain('?? b.txt')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('hard：工作区改动被清理（其语义即清理，脏区不拦——§4.10）', async () => {
    const { repo, service } = await makeWorld('hard')
    await commitFile(repo, 'a.txt', 'a\n', 'seed a')
    const c1 = await commitFile(repo, 'b.txt', 'b\n', 'add b')
    await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n', 'utf8')
    const result = await service.reset({ kind: 'hard', target: null, acknowledged: true, baseRevision: c1 })
    expect(result.op).toBe('reset')
    expect(result.oldOid).toBe(c1)
    expect(result.newOid).toBe(c1)
    // world：a.txt 脏改动被清回 HEAD 版本；untracked 不动（git reset --hard 不删
    // untracked——真实 git 语义如实断言，所以 porcelain 只剩 untracked 一行）；
    // b.txt（tracked at HEAD）仍在。
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(porcelain).toBe('?? untracked.txt\n')
    expect(existsSync(join(repo, 'b.txt'))).toBe(true)
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true)
  })

  it('hard 后退一提交：工作区回到旧树（world 重读 HEAD 与文件消失）', async () => {
    const { repo, service } = await makeWorld('hard-back')
    const c0 = await commitFile(repo, 'a.txt', 'a\n', 'seed a')
    const c1 = await commitFile(repo, 'b.txt', 'b\n', 'add b')
    const result = await service.reset({ kind: 'hard', target: 'HEAD~1', acknowledged: true, baseRevision: c1 })
    expect(result).toEqual({ op: 'reset', oldOid: c1, newOid: c0 })
    expect(worldHead(repo)).toBe(c0)
    expect(worldClean(repo)).toBe(true)
    expect(existsSync(join(repo, 'b.txt'))).toBe(false)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })

  it('无 acknowledged（soft 与 hard）⇒ bad-request unacknowledged，零命令（HEAD 不动）', async () => {
    const { repo, service } = await makeWorld('no-ack')
    const c0 = await commitFile(repo, 'a.txt', 'a\n', 'seed a')
    const c1 = await commitFile(repo, 'b.txt', 'b\n', 'add b')
    for (const kind of ['soft', 'mixed', 'hard'] as const) {
      const rejection = await rejectionOf(() => service.reset({ kind, target: 'HEAD~1', acknowledged: false, baseRevision: c1 }))
      expect(rejection.code).toBe('git/bad-request')
      expect(rejection.details.reason).toBe('unacknowledged')
    }
    // 零命令：world HEAD 未动、无中间态。
    expect(worldHead(repo)).toBe(c1)
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(false)
    expect(pseudoHeadExists(repo, 'REVERT_HEAD')).toBe(false)
    // c0 只用于类型收窄引用检查（HEAD 未动即零命令的证明）。
    expect(c0).not.toBe(c1)
  })

  it('stale baseRevision ⇒ bad-request stale-base-revision（乐观并发）', async () => {
    const { repo, service } = await makeWorld('stale')
    await commitFile(repo, 'a.txt', 'a\n', 'seed a')
    const c1 = await commitFile(repo, 'b.txt', 'b\n', 'add b')
    const stale = '1'.repeat(40)
    const rejection = await rejectionOf(() => service.reset({ kind: 'soft', target: 'HEAD~1', acknowledged: true, baseRevision: stale }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details).toMatchObject({ reason: 'stale-base-revision', expected: stale, actual: c1 })
    expect(worldHead(repo)).toBe(c1)
  })
})

describe('cherryPick / revert — 冲突与成功路径（[清单 37]）', () => {
  /** 冲突夹具：main 与 side 各改 a.txt 同一行（内容相异），sideOid 摘到 main 必冲突。 */
  async function makeConflictWorld(name: string): Promise<{
    repo: string; service: InstanceType<typeof GitService>; baseOid: string; sideOid: string; mainOid: string
  }> {
    const { repo, service } = await makeWorld(name)
    const baseOid = await commitFile(repo, 'a.txt', 'base line\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideOid = await commitFile(repo, 'a.txt', 'side line\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'a.txt', 'main line\n', 'main edit')
    return { repo, service, baseOid, sideOid, mainOid }
  }

  it('cherry-pick 冲突 ⇒ merge-conflict（conflicted 与 world 重读一致、abortable）', async () => {
    const { repo, service, sideOid, mainOid } = await makeConflictWorld('cp-conflict')
    const rejection = await rejectionOf(() => service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/merge-conflict')
    expect(rejection.details).toEqual({ op: 'cherry-pick', conflicted: ['a.txt'], abortable: true })
    // world 重读：中间态在场，未合并集 == details.conflicted。
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(true)
    expect(pseudoHeadExists(repo, 'REVERT_HEAD')).toBe(false)
    expect(worldUnmerged(repo)).toEqual(rejection.details.conflicted)
    expect(worldHead(repo)).toBe(mainOid) // HEAD 未被冲突推进
  })

  it('CHERRY_PICK_HEAD 在场 ⇒ operation-in-progress（cherryPick 与 reset 叠加皆拒）', async () => {
    const { repo, service, sideOid, mainOid } = await makeConflictWorld('cp-overlap')
    const conflict = await rejectionOf(() => service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: mainOid }))
    expect(conflict.code).toBe('git/merge-conflict')
    const head = worldHead(repo)
    const again = await rejectionOf(() => service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: head }))
    expect(again.code).toBe('git/operation-in-progress')
    expect(again.details).toEqual({ op: 'cherry-pick' })
    const overlapReset = await rejectionOf(() => service.reset({ kind: 'soft', target: null, acknowledged: true, baseRevision: head }))
    expect(overlapReset.code).toBe('git/operation-in-progress')
    expect(overlapReset.details.op).toBe('cherry-pick')
  })

  it('abort 后回原 HEAD（world 重读：HEAD/中间态/工作区复原）；再 abort 幂等 null', async () => {
    const { repo, service, mainOid } = await makeConflictWorld('cp-abort')
    const sideOid = execFileSync('git', ['rev-parse', 'side'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const conflict = await rejectionOf(() => service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: worldHead(repo) }))
    expect(conflict.code).toBe('git/merge-conflict')
    expect(worldUnmerged(repo)).toEqual(['a.txt'])

    const aborted = await service.abortOperation()
    expect(aborted).toEqual({ aborted: 'cherry-pick' })
    // world：HEAD 回原位、中间态清除、工作区干净、a.txt 复原为 main 版本。
    expect(worldHead(repo)).toBe(mainOid)
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(false)
    expect(worldClean(repo)).toBe(true)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('main line\n')
    // 幂等：无中间态 ⇒ 空成功（零命令）。
    const idempotent = await service.abortOperation()
    expect(idempotent).toEqual({ aborted: null })
  })

  it('cherry-pick 成功路径：HEAD 前进、新文件落盘（world 重读 oldOid/newOid）', async () => {
    const { repo, service, mainOid, sideOid } = await makeConflictWorld('cp-ok')
    // side 分支加一个不冲突的新文件提交（side.txt），摘到 main。
    git(repo, 'checkout', '-q', 'side')
    const side2 = await commitFile(repo, 'side.txt', 'side file\n', 'side adds file')
    git(repo, 'checkout', '-q', 'main')
    expect(side2).not.toBe(sideOid)
    const result = await service.cherryPick({ oid: side2, acknowledged: true, baseRevision: worldHead(repo) })
    expect(result.op).toBe('cherry-pick')
    expect(result.oldOid).toBe(mainOid)
    const newHead = worldHead(repo)
    expect(result.newOid).toBe(newHead)
    expect(existsSync(join(repo, 'side.txt'))).toBe(true)
    expect(worldClean(repo)).toBe(true)
    // world：新提交的 message 来自被摘提交（git 语义如实）。
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('side adds file')
  })

  it('revert 成功：改动被逆向（world 重读文件消失）；空 revert ⇒ git-error op revert', async () => {
    const { repo, service, mainOid } = await makeConflictWorld('revert-ok')
    // revert main edit：逆向补丁把 a.txt 从 'main line' 退回 'base line'（无冲突——
    // 工作区内容与 main edit 的父版本一致）。
    const result = await service.revert({ oid: mainOid, acknowledged: true, baseRevision: mainOid })
    expect(result.op).toBe('revert')
    expect(result.oldOid).toBe(mainOid)
    expect(result.newOid).toBe(worldHead(repo))
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('base line\n')
    expect(worldClean(repo)).toBe(true)
    const revertHead = worldHead(repo)
    // 空 revert：同一提交再 revert 一次 ⇒ git-error（op 'revert'），world 不动、无 REVERT_HEAD。
    const empty = await rejectionOf(() => service.revert({ oid: mainOid, acknowledged: true, baseRevision: revertHead }))
    expect(empty.code).toBe('git/git-error')
    expect(empty.details.op).toBe('revert')
    expect(worldHead(repo)).toBe(revertHead)
    expect(pseudoHeadExists(repo, 'REVERT_HEAD')).toBe(false)
    expect(worldClean(repo)).toBe(true)
  })

  it('revert 冲突 ⇒ merge-conflict op revert + REVERT_HEAD 探测 + abort 回原', async () => {
    const { repo, service } = await makeWorld('revert-conflict')
    await commitFile(repo, 'a.txt', 'base line\n', 'base')
    git(repo, 'checkout', '-qb', 'topic')
    const topicOid = await commitFile(repo, 'a.txt', 'topic line\n', 'topic edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'a.txt', 'main line\n', 'main edit')
    // revert topic edit：其逆向补丁基于 topic 父版本，main 的 a.txt 已相异 ⇒ 冲突。
    const rejection = await rejectionOf(() => service.revert({ oid: topicOid, acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/merge-conflict')
    expect(rejection.details).toEqual({ op: 'revert', conflicted: ['a.txt'], abortable: true })
    expect(pseudoHeadExists(repo, 'REVERT_HEAD')).toBe(true)
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(false)
    expect(worldUnmerged(repo)).toEqual(['a.txt'])
    // REVERT_HEAD 在场 ⇒ 叠加拒绝（op 'revert'）→ abort 复原。
    const overlap = await rejectionOf(() => service.cherryPick({ oid: topicOid, acknowledged: true, baseRevision: worldHead(repo) }))
    expect(overlap.code).toBe('git/operation-in-progress')
    expect(overlap.details.op).toBe('revert')
    const aborted = await service.abortOperation()
    expect(aborted).toEqual({ aborted: 'revert' })
    expect(worldHead(repo)).toBe(mainOid)
    expect(worldClean(repo)).toBe(true)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('main line\n')
  })
})

describe('time-travel — 守卫', () => {
  it('unknown revision ⇒ unknown-revision（cherryPick oid / reset target）', async () => {
    const { repo, service } = await makeWorld('unknown-rev')
    const head = await commitFile(repo, 'a.txt', 'a\n', 'seed')
    const badOid = await rejectionOf(() => service.cherryPick({ oid: 'no-such-rev', acknowledged: true, baseRevision: head }))
    expect(badOid.code).toBe('git/unknown-revision')
    expect(badOid.details).toEqual({ op: 'cherryPick', revision: 'no-such-rev' })
    const badTarget = await rejectionOf(() => service.reset({ kind: 'hard', target: 'no-such-target', acknowledged: true, baseRevision: head }))
    expect(badTarget.code).toBe('git/unknown-revision')
    expect(badTarget.details.op).toBe('reset')
    expect(worldHead(repo)).toBe(head)
  })

  it('unborn ⇒ no-branch（state unborn）；detached ⇒ no-branch（state detached）', async () => {
    const { repo, service } = await makeWorld('branches')
    const unborn = await rejectionOf(() => service.reset({ kind: 'mixed', target: null, acknowledged: true, baseRevision: null }))
    expect(unborn.code).toBe('git/no-branch')
    expect(unborn.details.state).toBe('unborn')
    await commitFile(repo, 'a.txt', 'a\n', 'seed')
    const head = worldHead(repo)
    git(repo, 'checkout', '-q', '--detach', head)
    const detached = await rejectionOf(() => service.cherryPick({ oid: head, acknowledged: true, baseRevision: head }))
    expect(detached.code).toBe('git/no-branch')
    expect(detached.details.state).toBe('detached')
  })
})
