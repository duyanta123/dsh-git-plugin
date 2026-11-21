/**
 * v3 批次二 — merge / rebase 测试（[清单 28/29]；docs/v3-implementation-plan.md §4.7
 * host 真仓范式行）。
 *
 * 覆盖：merge——ff-only 可 ff 成功 / ff-only 不可 ff 拒绝（git-error，world 不动）/
 * no-ff 合并提交（parents=2 world 重读 + 自定消息落 subject）/ auto 两态（可 ff ⇒
 * fastForward=true；分叉 ⇒ 合并提交）/ 冲突 ⇒ merge-conflict op 'merge' + conflicted
 * 回读一致 + abortable + MERGE_HEAD 在场 + 叠加拒绝（operation-in-progress）+ abort 回
 * 原 HEAD / continue 链（批次一 conflictResolve + operationContinue 组合——merge 提交
 * parents=2 且第二父 = side tip）/ dirty 拒绝（零命令）/ baseRevision 过期拒绝（零命
 * 令）/ unacknowledged / unknown-revision / up-to-date 幂等（Already up to date 是成功
 * 不是错误，fastForward=false 不谎报）；rebase——线性三提交变基 world 重读（subjects/
 * 计数/merge-base/文件内容 + GIT_EDITOR=true env）/ onto 变基（--onto 语义：upstream..
 * HEAD 重放到新基）/ 冲突→resolve→continue 循环至 done（双文件两轮冲突的真循环）/
 * abort 回原 HEAD（rebase 目录清除）/ unknown-upstream / up-to-date 幂等。
 *
 * 断言纪律：验证世界而非自述——每个写断言后用独立 execFileSync git 重读（HEAD/parents/
 * log subjects/porcelain/unmerged/merge-base）；守卫负路径断言零命令（HEAD 不动 +
 * 无 MERGE_HEAD/rebase 目录 + unmerged 不变）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/index.ts'
import { git, makeGitService, scratchRepo } from './support.ts'
import type { SpawnRecord } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeService(workspaceOverride: string, record?: SpawnRecord[]): InstanceType<typeof GitService> {
  // 装配去重：Context+subprocess 面经 support.makeGitService；spawn 记录经 record 设施键。
  return makeGitService(workspaceOverride, {
    commitTimeoutMs: 15_000,
    autoFetchIntervalMs: 0,
    ...(record !== undefined ? { record } : {}),
  }).service
}

async function makeWorld(name: string, record?: SpawnRecord[]): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-mr-${name}-`, cleanups)
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  return { repo, service: makeService(repo, record) }
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

function worldRev(repo: string, ref: string): string {
  return execFileSync('git', ['rev-parse', '--verify', ref], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** HEAD 提交的 [oid, ...parents]（merge 提交 parents=2 的 world 断言面）。 */
function worldHeadParents(repo: string): string[] {
  return execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split(/\s+/)
}

function worldSubjects(repo: string, count: number): string[] {
  return execFileSync('git', ['log', '--format=%s', '-n', String(count)], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split('\n')
}

function worldUnmerged(repo: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function worldClean(repo: string): boolean {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.trim() === ''
}

function worldMergeBase(repo: string, a: string, b: string): string {
  return execFileSync('git', ['merge-base', a, b], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function worldCount(repo: string, range: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', range], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
}

function pseudoHeadExists(repo: string, head: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', head], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

function gitDirState(repo: string, marker: 'rebase-merge' | 'rebase-apply' | 'MERGE_HEAD'): boolean {
  try {
    const path = execFileSync('git', ['rev-parse', '--git-path', marker], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    // --git-path 可能回相对路径——必须 resolve 到 repo 下再判存在性（conflicts.spec 同款踩坑）。
    return existsSync(resolve(repo, path))
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

/** 双侧各自改动不同文件的干净分叉世界（auto 的合并提交侧/守卫组共用）。 */
async function makeForkWorld(name: string, record?: SpawnRecord[]): Promise<{ repo: string; service: InstanceType<typeof GitService>; sideOid: string; mainOid: string }> {
  const { repo, service } = await makeWorld(name, record)
  await commitFile(repo, 'base.txt', 'base\n', 'base')
  git(repo, 'checkout', '-qb', 'side')
  const sideOid = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
  git(repo, 'checkout', '-q', 'main')
  const mainOid = await commitFile(repo, 'main.txt', 'main\n', 'main edit')
  return { repo, service, sideOid, mainOid }
}

/** 双分支同改 f.txt 的冲突世界（merge 冲突组共用）。 */
async function makeConflictWorld(name: string, record?: SpawnRecord[]): Promise<{ repo: string; service: InstanceType<typeof GitService>; sideOid: string; mainOid: string }> {
  const { repo, service } = await makeWorld(name, record)
  await commitFile(repo, 'f.txt', 'base f\n', 'base')
  await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
  git(repo, 'checkout', '-qb', 'side')
  const sideOid = await commitFile(repo, 'f.txt', 'side f\n', 'side edit')
  git(repo, 'checkout', '-q', 'main')
  const mainOid = await commitFile(repo, 'f.txt', 'main f\n', 'main edit')
  return { repo, service, sideOid, mainOid }
}

// ---------- branchMerge（[清单 28]） ----------

describe('branchMerge — ff 三态（[28] §4.7）', () => {
  it('ff-only 可 ff 成功：fastForward=true、newOid=目标 oid、无合并提交（world 重读）', async () => {
    const records: SpawnRecord[] = []
    const { repo, service } = await makeWorld('ff-only-ok', records)
    const baseOid = await commitFile(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideOid = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = worldHead(repo)
    expect(mainOid).toBe(baseOid)

    const result = await service.branchMerge({ branch: 'side', fastForward: 'ff-only', acknowledged: true, baseRevision: mainOid })
    expect(result).toEqual({ oldOid: mainOid, newOid: sideOid, fastForward: true })
    // world 重读：HEAD 前进到 side、无合并提交（parents=1）、干净、文件落盘。
    expect(worldHead(repo)).toBe(sideOid)
    expect(worldHeadParents(repo)).toEqual([sideOid, baseOid])
    expect(worldClean(repo)).toBe(true)
    expect(await readFile(join(repo, 'side.txt'), 'utf8')).toBe('side\n')
    // spawn 记录：merge 命令面字面序（§4.3）——'--ff-only' 在场、无 -m（write runner argv 数组零 shell）。
    const mergeRun = records.find((rec) => rec.argv.includes('merge'))
    expect(mergeRun).toBeDefined()
    expect(mergeRun!.argv.slice(mergeRun!.argv.indexOf('merge'))).toEqual(['merge', 'side', '--ff-only', '--no-edit'])
  })

  it('annotated tag 目标：rev-parse 剥 ^{commit}，经 tag 名的 ff 合并 fastForward=true（评审收口回归）', async () => {
    const { repo, service } = await makeWorld('tag-ff')
    const baseOid = await commitFile(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideOid = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'tag', '-a', 'v1', '-m', 'tag at side') // annotated tag——裸 rev-parse 回 tag 对象 oid
    git(repo, 'checkout', '-q', 'main')
    const mainOid = worldHead(repo)
    expect(mainOid).toBe(baseOid)
    // 夹具自证（评审收口实证，git 2.55.0.windows.2）：裸 rev-parse 的 tag 名 ≠ 剥壳
    // commit——旧实现（不剥）拿 tag 对象 oid 比对面，可 ff 合并恒误报 fastForward=false。
    expect(worldRev(repo, 'v1')).not.toBe(sideOid)
    expect(worldRev(repo, 'v1^{commit}')).toBe(sideOid)

    const result = await service.branchMerge({ branch: 'v1', fastForward: 'ff-only', acknowledged: true, baseRevision: mainOid })
    expect(result).toEqual({ oldOid: mainOid, newOid: sideOid, fastForward: true })
    // world 重读：HEAD 前进到剥壳 commit（tag 指向提交）、无合并提交、干净。
    expect(worldHead(repo)).toBe(sideOid)
    expect(worldHeadParents(repo)).toEqual([sideOid, baseOid])
    expect(worldClean(repo)).toBe(true)
  })

  it('ff-only 不可 ff 拒绝：git-error（fast-forward refused）、world 不动（零命令）', async () => {
    const { repo, service, sideOid, mainOid } = await makeForkWorld('ff-only-refused')
    const rejection = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'ff-only', acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/git-error')
    expect(rejection.details.op).toBe('merge')
    expect(String(rejection.message)).toContain('fast-forward refused')
    // world：HEAD 不动、无中间态、干净（拒绝是零改动）。
    expect(worldHead(repo)).toBe(mainOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(false)
    expect(worldClean(repo)).toBe(true)
    expect(worldRev(repo, 'side')).toBe(sideOid)
  })

  it('no-ff 合并提交：parents=2、自定消息落 subject（world 重读）', async () => {
    const records: SpawnRecord[] = []
    const { repo, service } = await makeWorld('no-ff', records)
    await commitFile(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideTip = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = worldHead(repo)

    const result = await service.branchMerge({
      branch: 'side', fastForward: 'no-ff', message: 'verify-load merge msg', acknowledged: true, baseRevision: mainOid,
    })
    expect(result.fastForward).toBe(false)
    expect(result.oldOid).toBe(mainOid)
    // world 重读：合并提交 parents=2（main tip + side tip）、subject=自定消息、干净。
    const parents = worldHeadParents(repo)
    expect(parents).toHaveLength(3)
    expect(parents[0]).toBe(result.newOid)
    expect(parents).toContain(mainOid)
    expect(parents).toContain(sideTip)
    expect(worldSubjects(repo, 1)).toEqual(['verify-load merge msg'])
    expect(worldClean(repo)).toBe(true)
    const mergeRun = records.find((rec) => rec.argv.includes('--no-ff'))
    expect(mergeRun).toBeDefined()
    expect(mergeRun!.argv.slice(mergeRun!.argv.indexOf('merge'))).toEqual(['merge', 'side', '--no-ff', '-m', 'verify-load merge msg'])
  })

  it('auto 两态：可 ff ⇒ fastForward=true（HEAD=目标）；分叉 ⇒ 合并提交（fastForward=false、--no-edit 命令面）', async () => {
    // 态 1：side 领先 main（ff 可达）。
    const ff = await makeWorld('auto-ff')
    await commitFile(ff.repo, 'base.txt', 'base\n', 'base')
    git(ff.repo, 'checkout', '-qb', 'side')
    const ffSide = await commitFile(ff.repo, 'side.txt', 'side\n', 'side edit')
    git(ff.repo, 'checkout', '-q', 'main')
    const ffMain = worldHead(ff.repo)
    const autoFf = await ff.service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: ffMain })
    expect(autoFf).toEqual({ oldOid: ffMain, newOid: ffSide, fastForward: true })
    expect(worldHead(ff.repo)).toBe(ffSide)
    expect(worldHeadParents(ff.repo)).toHaveLength(2) // [commit, base]——无合并提交

    // 态 2：分叉（干净双文件改动）⇒ 合并提交。
    const records: SpawnRecord[] = []
    const fork = await makeForkWorld('auto-commit', records)
    const autoCommit = await fork.service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: fork.mainOid })
    expect(autoCommit.fastForward).toBe(false)
    expect(autoCommit.oldOid).toBe(fork.mainOid)
    const parents = worldHeadParents(fork.repo)
    expect(parents).toHaveLength(3)
    expect(parents).toContain(fork.mainOid)
    expect(parents).toContain(fork.sideOid)
    expect(worldClean(fork.repo)).toBe(true)
    // auto 无显式消息 ⇒ --no-edit（spawn 记录；无 --ff-only/--no-ff 旗标）。
    const mergeRun = records.find((rec) => rec.argv.includes('merge'))
    expect(mergeRun).toBeDefined()
    expect(mergeRun!.argv.slice(mergeRun!.argv.indexOf('merge'))).toEqual(['merge', 'side', '--no-edit'])
  })

  it('up-to-date 幂等成功：已合并分支再 merge ⇒ 成功、HEAD 不动、fastForward=false（不谎报 ff）', async () => {
    const { repo, service, sideOid } = await makeForkWorld('up-to-date')
    const first = await service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: worldHead(repo) })
    expect(first.fastForward).toBe(false)
    const mergedHead = worldHead(repo)
    // 再 merge 同一分支：git "Already up to date."——exit 0 成功路径，零提交。
    const again = await service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: mergedHead })
    expect(again).toEqual({ oldOid: mergedHead, newOid: mergedHead, fastForward: false })
    expect(worldHead(repo)).toBe(mergedHead)
    expect(worldHeadParents(repo)).toHaveLength(3) // 仍是那一笔合并提交
    expect(worldRev(repo, 'side')).toBe(sideOid)
    expect(worldClean(repo)).toBe(true)
  })
})

describe('branchMerge — 冲突与 continue 链（[28] × 批次一组合）', () => {
  it('冲突 ⇒ merge-conflict op merge + conflicted 回读一致 + abortable + MERGE_HEAD；abort 回原 HEAD', async () => {
    const { repo, service, mainOid } = await makeConflictWorld('merge-conflict')
    const rejection = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/merge-conflict')
    expect(rejection.details.op).toBe('merge')
    expect(rejection.details.conflicted).toEqual(['f.txt'])
    expect(rejection.details.abortable).toBe(true)
    // world：HEAD 不动、MERGE_HEAD 在场、unmerged 与 details.conflicted 一致。
    expect(worldHead(repo)).toBe(mainOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(true)
    expect(worldUnmerged(repo)).toEqual(rejection.details.conflicted)

    // 叠加拒绝：中间态在场 ⇒ operation-in-progress op 'merge'（零命令）。
    const overlap = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: worldHead(repo) }))
    expect(overlap.code).toBe('git/operation-in-progress')
    expect(overlap.details.op).toBe('merge')
    expect(worldHead(repo)).toBe(mainOid)
    expect(worldUnmerged(repo)).toEqual(['f.txt'])

    // abort 治愈：aborted=merge、回原 HEAD、MERGE_HEAD 清空、干净、内容复原。
    const aborted = await service.abortOperation()
    expect(aborted).toEqual({ aborted: 'merge' })
    expect(worldHead(repo)).toBe(mainOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(false)
    expect(worldUnmerged(repo)).toEqual([])
    expect(worldClean(repo)).toBe(true)
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe('main f\n')
  })

  it('冲突 conflicted 回读 -z 口径：非 ASCII 路径原样字节不 C-引号化（评审收口）', async () => {
    const { repo, service } = await makeWorld('merge-conflict-cjk')
    await commitFile(repo, '文档.txt', 'base f\n', 'base')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    git(repo, 'checkout', '-qb', 'side')
    await commitFile(repo, '文档.txt', 'side f\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, '文档.txt', 'main f\n', 'main edit')
    const rejection = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/merge-conflict')
    expect(rejection.details.op).toBe('merge')
    // -z 口径：NUL 分隔、路径原样字节——行分割口径（旧实现）在 core.quotepath 缺省下
    // 会把该路径 C-引号化成 "\346\226\207..." 失真形态。
    expect(rejection.details.conflicted).toEqual(['文档.txt'])
    // world 重读（-z 同口径）：details.conflicted == NUL 分割的裸路径集。
    const worldZ = execFileSync('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(worldZ.split('\0').filter((entry) => entry !== '')).toEqual(['文档.txt'])
    expect(rejection.details.abortable).toBe(true)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(true)
  })

  it('continue 链：冲突→conflictResolve(theirs)→operationContinue⇒done:true，merge 提交 parents=2 且第二父=side tip', async () => {
    const { repo, service, sideOid, mainOid } = await makeConflictWorld('merge-continue')
    const rejection = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'no-ff', acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/merge-conflict')

    // 批次一组合：面板解决（theirs）→ continue（GIT_EDITOR=true 防挂起——conflicts.ts）。
    const resolved = await service.conflictResolve({ choices: [{ path: 'f.txt', resolution: 'theirs' }] })
    expect(resolved.resolved).toEqual(['f.txt'])
    const continued = await service.operationContinue()
    expect(continued).toEqual({ op: 'merge', done: true, conflicted: [] })

    // world：合并提交落地（parents = [merge, main, side]）、中间态清空、干净、内容=theirs。
    const parents = worldHeadParents(repo)
    expect(parents).toHaveLength(3)
    expect(parents[1]).toBe(mainOid)
    expect(parents[2]).toBe(sideOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(false)
    expect(worldUnmerged(repo)).toEqual([])
    expect(worldClean(repo)).toBe(true)
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe('side f\n')
  })
})

describe('branchMerge — 守卫负路径（零命令；[28] §4.3 ①②③⑤⑥）', () => {
  it('dirty 拒绝：untracked 在场 ⇒ dirty-worktree（pathCount=1、branch=main；零命令）', async () => {
    const { repo, service, mainOid } = await makeForkWorld('merge-dirty')
    await writeFile(join(repo, 'loose.txt'), 'loose\n', 'utf8')
    const rejection = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/dirty-worktree')
    expect(rejection.details.branch).toBe('main')
    expect(rejection.details.pathCount).toBe(1)
    // 零命令：world 不动、无 MERGE_HEAD。
    expect(worldHead(repo)).toBe(mainOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(false)
    expect(worldClean(repo)).toBe(false)
  })

  it('baseRevision 过期拒绝：stale-base-revision（expected/actual 如实；零命令）', async () => {
    const { repo, service, sideOid, mainOid } = await makeForkWorld('merge-stale')
    const stale = await commitFile(repo, 'late.txt', 'late\n', 'main late edit')
    expect(stale).not.toBe(mainOid)
    const rejection = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: mainOid }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('stale-base-revision')
    expect(rejection.details.expected).toBe(mainOid)
    expect(rejection.details.actual).toBe(stale)
    // 零命令：world 不动（side 仍指原 tip、无中间态）。
    expect(worldHead(repo)).toBe(stale)
    expect(worldRev(repo, 'side')).toBe(sideOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(false)
  })

  it('unacknowledged ⇒ bad-request unacknowledged（零命令）；unknown branch ⇒ unknown-revision', async () => {
    const { repo, service, mainOid } = await makeForkWorld('merge-guards')
    const unack = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: false, baseRevision: mainOid }))
    expect(unack.code).toBe('git/bad-request')
    expect(unack.details.reason).toBe('unacknowledged')
    expect(worldHead(repo)).toBe(mainOid)

    const unknown = await rejectionOf(() => service.branchMerge({ branch: 'no-such-branch', fastForward: 'auto', acknowledged: true, baseRevision: mainOid }))
    expect(unknown.code).toBe('git/unknown-revision')
    expect(unknown.details.op).toBe('branchMerge')
    expect(unknown.details.revision).toBe('no-such-branch')
    expect(worldHead(repo)).toBe(mainOid)
    expect(worldClean(repo)).toBe(true)
  })
})

// ---------- rebase（[清单 29]） ----------

describe('rebase — 线性与 onto（[29] §4.7）', () => {
  it('线性三提交变基：world 重读（subjects/计数/merge-base/文件内容）+ GIT_EDITOR=true env', async () => {
    const records: SpawnRecord[] = []
    const { repo, service } = await makeWorld('rb-linear', records)
    await commitFile(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    await commitFile(repo, 'rb1.txt', 'rb one\n', 'side one')
    await commitFile(repo, 'rb2.txt', 'rb two\n', 'side two')
    const sideTip = await commitFile(repo, 'rb3.txt', 'rb three\n', 'side three')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'mainline.txt', 'mainline\n', 'main advance')
    expect(worldCount(repo, 'main..side')).toBe(3)
    // 变基作用于当前分支——回到 side（默认分支系 = 当前分支，§4.3）。
    git(repo, 'checkout', '-q', 'side')

    const result = await service.rebase({ upstream: 'main', acknowledged: true, baseRevision: sideTip })
    expect(result.done).toBe(true)
    expect(result.oldOid).toBe(sideTip)
    expect(result.newOid).not.toBe(sideTip)
    expect(result.newOid).toBe(worldHead(repo))
    // world 重读：side = main + 三笔重放（subjects 顺序/计数/merge-base/内容/干净）。
    expect(worldCount(repo, 'main..side')).toBe(3)
    expect(worldMergeBase(repo, 'main', 'side')).toBe(mainOid)
    expect(worldSubjects(repo, 5)).toEqual(['side three', 'side two', 'side one', 'main advance', 'base'])
    expect(await readFile(join(repo, 'rb1.txt'), 'utf8')).toBe('rb one\n')
    expect(await readFile(join(repo, 'rb3.txt'), 'utf8')).toBe('rb three\n')
    expect(await readFile(join(repo, 'mainline.txt'), 'utf8')).toBe('mainline\n')
    expect(worldClean(repo)).toBe(true)
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('side')
    // 防挂起纪律：rebase 执行 spawn 的 env 必须带 GIT_EDITOR=true（恒惰性的挂起防护）。
    const rebaseRuns = records.filter((rec) => rec.argv.includes('rebase'))
    expect(rebaseRuns).toHaveLength(1)
    expect(rebaseRuns[0]!.env.GIT_EDITOR).toBe('true')
  })

  it('onto 变基：--onto <newbase> <upstream> 重放 upstream..HEAD 到新基（world 重读）', async () => {
    const { repo, service } = await makeWorld('rb-onto')
    const baseOid = await commitFile(repo, 'base.txt', 'base\n', 'onto base')
    git(repo, 'checkout', '-qb', 'side')
    await commitFile(repo, 'side1.txt', 'side one\n', 'side one')
    const sideTip = await commitFile(repo, 'side2.txt', 'side two\n', 'side two')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'mainline.txt', 'mainline\n', 'main advance')
    // 变基作用于当前分支——回到 side（默认分支系 = 当前分支，§4.3）。
    git(repo, 'checkout', '-q', 'side')

    const result = await service.rebase({ upstream: baseOid, onto: 'main', acknowledged: true, baseRevision: sideTip })
    expect(result.done).toBe(true)
    expect(result.newOid).toBe(worldHead(repo))
    // world 重读：side = main + 两笔重放（upstream..HEAD = side 两笔落新基 main）。
    expect(worldCount(repo, 'main..side')).toBe(2)
    expect(worldMergeBase(repo, 'main', 'side')).toBe(mainOid)
    expect(worldSubjects(repo, 4)).toEqual(['side two', 'side one', 'main advance', 'onto base'])
    expect(await readFile(join(repo, 'side1.txt'), 'utf8')).toBe('side one\n')
    expect(await readFile(join(repo, 'side2.txt'), 'utf8')).toBe('side two\n')
    expect(await readFile(join(repo, 'mainline.txt'), 'utf8')).toBe('mainline\n')
    expect(worldClean(repo)).toBe(true)
  })

  it('up-to-date 幂等成功：分支已是基底后代 ⇒ done=true、HEAD 不动（git up-to-date 语义）', async () => {
    const { repo, service } = await makeWorld('rb-up-to-date')
    const mainOid = await commitFile(repo, 'base.txt', 'base\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideTip = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    // main 未动：side 已是 main 的线性后代 ⇒ "Current branch ... is up to date"（零重写）。
    const result = await service.rebase({ upstream: 'main', acknowledged: true, baseRevision: sideTip })
    expect(result).toEqual({ oldOid: sideTip, newOid: sideTip, done: true })
    expect(worldHead(repo)).toBe(sideTip)
    expect(worldCount(repo, 'main..side')).toBe(1)
    expect(worldMergeBase(repo, 'main', 'side')).toBe(mainOid)
    expect(worldClean(repo)).toBe(true)
  })
})

describe('rebase — 冲突循环与 abort（[29] × 批次一组合）', () => {
  /** 双文件两轮冲突世界：main 改 f.txt+g.txt；side 两笔各改其一 ⇒ 变基两轮都冲突。 */
  async function makeRebaseConflictWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService>; sideTip: string; mainOid: string }> {
    const { repo, service } = await makeWorld(name)
    await commitFile(repo, 'f.txt', 'base f\n', 'base f')
    await commitFile(repo, 'g.txt', 'base g\n', 'base g')
    git(repo, 'checkout', '-qb', 'side')
    await commitFile(repo, 'f.txt', 'side f\n', 'side one')
    const sideTip = await commitFile(repo, 'g.txt', 'side g\n', 'side two')
    git(repo, 'checkout', '-q', 'main')
    await commitFile(repo, 'f.txt', 'main f\n', 'main f edit')
    const mainOid = await commitFile(repo, 'g.txt', 'main g\n', 'main g edit')
    return { repo, service, sideTip, mainOid }
  }

  it('冲突→resolve→continue 循环至 done:true（两轮真循环；world 重读 subjects/内容/干净）', async () => {
    const { repo, service, mainOid } = await makeRebaseConflictWorld('rb-loop')
    const sideTip = worldRev(repo, 'side')
    // 变基作用于当前分支——回到 side（默认分支系 = 当前分支，§4.3）。
    git(repo, 'checkout', '-q', 'side')
    const first = await rejectionOf(() => service.rebase({ upstream: 'main', acknowledged: true, baseRevision: sideTip }))
    expect(first.code).toBe('git/merge-conflict')
    expect(first.details.op).toBe('rebase')
    expect(first.details.conflicted).toEqual(['f.txt'])
    expect(first.details.abortable).toBe(true)
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
    expect(gitDirState(repo, 'rebase-merge') || gitDirState(repo, 'rebase-apply')).toBe(true)

    // 第一轮：resolve f.txt（theirs）→ continue #1 ⇒ 提交第一笔、推进到第二笔 ⇒ 第二冲突。
    await service.conflictResolve({ choices: [{ path: 'f.txt', resolution: 'theirs' }] })
    const second = await service.operationContinue()
    expect(second).toEqual({ op: 'rebase', done: false, conflicted: ['g.txt'] })
    expect(worldUnmerged(repo)).toEqual(['g.txt'])
    // 第一笔已重放落盘（world：f.txt = theirs 内容）。
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe('side f\n')

    // 第二轮：resolve g.txt（theirs）→ continue #2 ⇒ done:true。
    await service.conflictResolve({ choices: [{ path: 'g.txt', resolution: 'theirs' }] })
    const third = await service.operationContinue()
    expect(third).toEqual({ op: 'rebase', done: true, conflicted: [] })

    // world：side = main + 两笔重放、subjects/内容/中间态清空/干净。
    //（main 两笔同秒提交——git log 日期并列序不稳定，主行断言与顺序无关。）
    expect(worldCount(repo, 'main..side')).toBe(2)
    expect(worldMergeBase(repo, 'main', 'side')).toBe(mainOid)
    const subjects = worldSubjects(repo, 4)
    expect(subjects.slice(0, 2)).toEqual(['side two', 'side one'])
    expect(subjects.slice(2).sort()).toEqual(['main f edit', 'main g edit'])
    expect(await readFile(join(repo, 'g.txt'), 'utf8')).toBe('side g\n')
    expect(gitDirState(repo, 'rebase-merge') || gitDirState(repo, 'rebase-apply')).toBe(false)
    expect(worldClean(repo)).toBe(true)
    void sideTip
  })

  it('abort 回原 HEAD：rebase 目录清除、side 原提交复原（world 重读）', async () => {
    const { repo, service, sideTip, mainOid } = await makeRebaseConflictWorld('rb-abort')
    git(repo, 'checkout', '-q', 'side')
    const rejection = await rejectionOf(() => service.rebase({ upstream: 'main', acknowledged: true, baseRevision: sideTip }))
    expect(rejection.code).toBe('git/merge-conflict')
    expect(worldUnmerged(repo)).toEqual(['f.txt'])

    const aborted = await service.abortOperation()
    expect(aborted).toEqual({ aborted: 'rebase' })
    // world：回 side 原 tip、rebase 目录清除、干净、内容复原为 side 版。
    expect(worldHead(repo)).toBe(sideTip)
    expect(worldHead(repo)).not.toBe(mainOid)
    expect(gitDirState(repo, 'rebase-merge') || gitDirState(repo, 'rebase-apply')).toBe(false)
    expect(worldUnmerged(repo)).toEqual([])
    expect(worldClean(repo)).toBe(true)
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('side')
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('side two')
  })

  it('守卫：unacknowledged / unknown upstream（零命令）', async () => {
    const { repo, service, sideTip } = await makeRebaseConflictWorld('rb-guards')
    git(repo, 'checkout', '-q', 'side')
    const unack = await rejectionOf(() => service.rebase({ upstream: 'main', acknowledged: false, baseRevision: sideTip }))
    expect(unack.code).toBe('git/bad-request')
    expect(unack.details.reason).toBe('unacknowledged')
    const unknown = await rejectionOf(() => service.rebase({ upstream: 'no-such-ref', acknowledged: true, baseRevision: sideTip }))
    expect(unknown.code).toBe('git/unknown-revision')
    expect(unknown.details.op).toBe('rebase')
    expect(unknown.details.revision).toBe('no-such-ref')
    // 零命令：HEAD 仍在 side tip、无 rebase 目录。
    expect(worldHead(repo)).toBe(sideTip)
    expect(gitDirState(repo, 'rebase-merge') || gitDirState(repo, 'rebase-apply')).toBe(false)
  })
})
