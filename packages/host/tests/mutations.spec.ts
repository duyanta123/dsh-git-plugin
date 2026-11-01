/**
 * git.stage / git.unstage / git.discard 集成测试（spec §6 mutations 行 + M5 任务口径；
 * 范式照 support.ts：真实临时 git 仓库，断言纪律 = 验证世界而非自述——每个写场景后用
 * 独立 execFileSync `git status --porcelain` / 文件读取重读外部状态）。
 *
 * 守卫矩阵（M5 任务口径）：stage/unstage 空数组 → git/no-paths；字面路径通配符安全
 * （GIT_LITERAL_PATHSPECS=1 + 全局位 --literal-pathspecs，诱饵文件验证不展开）；
 * unborn → rm --cached 兜底 [清单 64]；discard 三重守卫（acknowledged / baseRevision
 * 乐观并发 / 最新 status 逐路径路由：untracked→clean、worktree 变更→restore、
 * 仅暂存条目与冲突文件与未知路径→整请求拒绝 git/bad-request）。
 * 极老 git 的 reset HEAD 兜底无法在本机（git 2.55.0.windows.2）端到端复现——
 * 触发条件 isOldGitRestore 以纯函数单测锁定（见文件尾 describe）。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { isOldGitRestore } from '../src/mutations.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

// 并行负载下的资源裕量（真实 git 子进程 + fresh status 扫描；diff.spec.ts 同款先例）。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Harness {
  service: InstanceType<typeof GitService>
}

function makeService(workspaceOverride: string): Harness {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    commitTimeoutMs: 15_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
  })
  return { service }
}

/**
 * 独立 git 进程读世界：`git status --porcelain`（行排序后断言，与请求次序无关）。
 * 注意：不在 split 前 trim——XY 首位可能是空格（未暂存修改 ` M`），trim 会吃掉首行
 * 状态位；排序按 ASCII：空格 < '?' < 'A'。
 */
function porcelain(repo: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/).filter((line) => line !== '').sort()
}

/** 读工作区文件（restore/clean 的 checkout 会按本机 core.autocrlf 落 CRLF——断言按 LF 归一）。 */
async function readLf(repo: string, rel: string): Promise<string> {
  return (await readFile(join(repo, rel), 'utf8')).replace(/\r\n/g, '\n')
}

/** 写工作区文件（递归建目录）。 */
async function write(repo: string, rel: string, content: string): Promise<void> {
  const target = join(repo, rel)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

/** 造一个 UU 冲突仓库（双分支改同一文件后 merge）。 */
async function makeConflict(repo: string, file = 'c.txt'): Promise<void> {
  await write(repo, file, 'base\n')
  git(repo, 'add', file)
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'side')
  await write(repo, file, 'side\n')
  git(repo, 'commit', '-qam', 'side')
  git(repo, 'checkout', '-q', 'main')
  await write(repo, file, 'main\n')
  git(repo, 'commit', '-qam', 'main')
  try {
    git(repo, 'merge', '--no-edit', 'side') // exit 1 = 冲突（预期）
  } catch {
    // 预期冲突；由调用方以 porcelain 断言 UU。
  }
}

describe('git.stage（spec §1.3）', () => {
  it('混合 tracked/untracked：全部进 index（world 重读 + 计数）', async () => {
    const repo = await scratchRepo('dshgit-mut-stage-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'one modified\n')
    await write(repo, 'b.txt', 'new\n')
    const { service } = makeService(repo)
    const result = await service.stage(['a.txt', 'b.txt'])
    expect(result).toEqual({ staged: 2 })
    // world 重读：a.txt 暂存修改、b.txt 暂存新增，worktree 侧无残留未暂存项。
    expect(porcelain(repo)).toEqual(['A  b.txt', 'M  a.txt'])
  })

  it('字面路径通配符安全：a[1].txt 只暂存自身，诱饵 a1.txt 不被通配展开', async () => {
    const repo = await scratchRepo('dshgit-mut-wild-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a[1].txt', 'literal target\n')
    await write(repo, 'a1.txt', 'decoy\n')
    const { service } = makeService(repo)
    const result = await service.stage(['a[1].txt'])
    expect(result).toEqual({ staged: 1 })
    // world 重读：只有字面名进 index；glob 语义会把 [1] 匹配到 a1.txt（诱饵必须在场）。
    expect(porcelain(repo)).toEqual(['?? a1.txt', 'A  a[1].txt'])
  })

  it('重复路径去重计数（一次命令处理）', async () => {
    const repo = await scratchRepo('dshgit-mut-dedupe-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'x\n')
    const { service } = makeService(repo)
    const result = await service.stage(['a.txt', 'a.txt'])
    expect(result).toEqual({ staged: 1 })
    expect(porcelain(repo)).toEqual(['A  a.txt'])
  })

  it('空数组 → git/no-paths（任务口径：不做 git add -A 静默扩权）', async () => {
    const repo = await scratchRepo('dshgit-mut-nopaths-', cleanups, { name: 't', email: 't@example.com' })
    const { service } = makeService(repo)
    const error = await service.stage([]).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    expect(remoteErrorOf(error)?.code).toBe('git/no-paths')
  })
})

describe('git.unstage（spec §1.3；unborn [清单 64]）', () => {
  it('born 分支：restore --staged 回退 index，worktree 保留（world 重读）', async () => {
    const repo = await scratchRepo('dshgit-mut-unstage-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'one modified\n')
    await write(repo, 'b.txt', 'new\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'add', 'b.txt')
    const { service } = makeService(repo)
    const result = await service.unstage(['a.txt', 'b.txt'])
    expect(result).toEqual({ unstaged: 2 })
    // world 重读：index 回到 HEAD，改动保留在 worktree（M→未暂存、新增→untracked）。
    expect(porcelain(repo)).toEqual([' M a.txt', '?? b.txt'])
    await expect(readFile(join(repo, 'a.txt'), 'utf8')).resolves.toBe('one modified\n')
  })

  it('unborn 分支 → git rm --cached：index 清空且文件转 untracked（world 重读）', async () => {
    const repo = await scratchRepo('dshgit-mut-unborn-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'f.txt', 'first\n')
    git(repo, 'add', 'f.txt') // 无提交仓库的暂存（A.）
    const { service } = makeService(repo)
    const result = await service.unstage(['f.txt'])
    expect(result).toEqual({ unstaged: 1 })
    // world 重读：index 空了，文件还在（untracked），仓库仍 unborn（--verify -q 非零退出）。
    expect(porcelain(repo)).toEqual(['?? f.txt'])
    const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    expect(head.status).not.toBe(0)
    await expect(readFile(join(repo, 'f.txt'), 'utf8')).resolves.toBe('first\n')
  })

  it('不在暂存视图内的路径按 no-op 跳过（幂等：不触发 restore 的 pathspec 报错）', async () => {
    const repo = await scratchRepo('dshgit-mut-idem-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    const { service } = makeService(repo)
    const result = await service.unstage(['a.txt', 'never-added.txt'])
    expect(result).toEqual({ unstaged: 0 })
    expect(porcelain(repo)).toEqual([])
  })

  it('空数组 → git/no-paths', async () => {
    const repo = await scratchRepo('dshgit-mut-unst-empty-', cleanups, { name: 't', email: 't@example.com' })
    const { service } = makeService(repo)
    await expect(service.unstage([])).rejects.toMatchObject({ code: 'git/no-paths' })
  })
})

describe('git.discard 三重守卫（M5 任务口径）', () => {
  it('守卫 1：acknowledged=false → git/bad-request（unacknowledged），零命令执行', async () => {
    const repo = await scratchRepo('dshgit-mut-d-ack-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'precious local edit\n')
    const { service } = makeService(repo)
    const error = await service.discard({ paths: ['a.txt'], acknowledged: false, baseRevision: null }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/bad-request')
    expect((remote?.details as { reason: string }).reason).toBe('unacknowledged')
    // world 重读：本地改动原样保留。
    await expect(readFile(join(repo, 'a.txt'), 'utf8')).resolves.toBe('precious local edit\n')
  })

  it('守卫 2：baseRevision 过期 → git/bad-request（stale-base-revision，expected/actual），零命令执行', async () => {
    const repo = await scratchRepo('dshgit-mut-d-stale-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'precious local edit\n')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    const staleOid = snapshot.branch.oid as string
    // 外部世界前进（独立 git 进程提交），客户端视角过期。
    await write(repo, 'moved.txt', 'advanced\n')
    git(repo, 'add', 'moved.txt')
    git(repo, 'commit', '-qm', 'advance')
    const error = await service.discard({ paths: ['a.txt'], acknowledged: true, baseRevision: staleOid }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/bad-request')
    const details = remote?.details as { reason: string; expected: string | null; actual: string | null }
    expect(details.reason).toBe('stale-base-revision')
    expect(details.expected).toBe(staleOid)
    expect(details.actual).not.toBe(staleOid)
    // world 重读：改动保留。
    await expect(readFile(join(repo, 'a.txt'), 'utf8')).resolves.toBe('precious local edit\n')
  })

  it('守卫 2：baseRevision 与当前 HEAD 一致 → 执行成功', async () => {
    const repo = await scratchRepo('dshgit-mut-d-fresh-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'modified\n')
    const { service } = makeService(repo)
    const snapshot = await service.status()
    const result = await service.discard({ paths: ['a.txt'], acknowledged: true, baseRevision: snapshot.branch.oid })
    expect(result).toEqual({ discarded: 1 })
    await expect(readLf(repo, 'a.txt')).resolves.toBe('one\n')
  })

  it('守卫 3：仅暂存条目（Y=.）→ not-discardable 整请求拒绝；同请求的可 discard 路径也不执行', async () => {
    const repo = await scratchRepo('dshgit-mut-d-stagedonly-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'modified\n')        // 可 discard（worktree 侧）
    await write(repo, 'new.txt', 'staged only\n')
    git(repo, 'add', 'new.txt')                      // 仅暂存条目（A.）
    const { service } = makeService(repo)
    const error = await service.discard({ paths: ['new.txt', 'a.txt'], acknowledged: true, baseRevision: null }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/bad-request')
    const details = remote?.details as { reason: string; paths: string[] }
    expect(details.reason).toBe('not-discardable')
    expect(details.paths).toEqual(['new.txt'])
    // world 重读：整请求拒绝——a.txt 的 worktree 改动保留、new.txt 仍在暂存区。
    expect(porcelain(repo)).toEqual([' M a.txt', 'A  new.txt'])
  })

  it('守卫 3：冲突文件（UU）→ not-discardable 整请求拒绝（spec §1.3 的 git-error 升级为前置拒绝）', async () => {
    const repo = await scratchRepo('dshgit-mut-d-conflict-', cleanups, { name: 't', email: 't@example.com' })
    await makeConflict(repo)
    expect(porcelain(repo)).toEqual(['UU c.txt']) // 夹具自检：冲突确实在
    const { service } = makeService(repo)
    const error = await service.discard({ paths: ['c.txt'], acknowledged: true, baseRevision: null }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/bad-request')
    const details = remote?.details as { reason: string; paths: string[] }
    expect(details.reason).toBe('not-discardable')
    expect(details.paths).toEqual(['c.txt'])
    // world 重读：冲突状态原样保留（未做任何 restore/clean）。
    expect(porcelain(repo)).toEqual(['UU c.txt'])
  })

  it('守卫 3：status 全组皆无的未知路径 → not-discardable', async () => {
    const repo = await scratchRepo('dshgit-mut-d-unknown-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    const { service } = makeService(repo)
    await expect(service.discard({ paths: ['ghost.txt'], acknowledged: true, baseRevision: null }))
      .rejects.toMatchObject({ code: 'git/bad-request', details: { reason: 'not-discardable', paths: ['ghost.txt'] } })
  })

  it('tracked modified → restore：worktree 内容回到 HEAD（world 重读文件内容）', async () => {
    const repo = await scratchRepo('dshgit-mut-d-restore-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'modified\n')
    const { service } = makeService(repo)
    const result = await service.discard({ paths: ['a.txt'], acknowledged: true, baseRevision: null })
    expect(result).toEqual({ discarded: 1 })
    expect(porcelain(repo)).toEqual([])
    await expect(readLf(repo, 'a.txt')).resolves.toBe('one\n')
  })

  it('tracked worktree 删除（.D）→ restore 找回文件', async () => {
    const repo = await scratchRepo('dshgit-mut-d-delete-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await rm(join(repo, 'a.txt'))
    const { service } = makeService(repo)
    const result = await service.discard({ paths: ['a.txt'], acknowledged: true, baseRevision: null })
    expect(result).toEqual({ discarded: 1 })
    expect(porcelain(repo)).toEqual([])
    await expect(readLf(repo, 'a.txt')).resolves.toBe('one\n')
  })

  it('untracked → clean -fd：文件消失（world 重读）', async () => {
    const repo = await scratchRepo('dshgit-mut-d-clean-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'junk.txt', 'untracked\n')
    const { service } = makeService(repo)
    const result = await service.discard({ paths: ['junk.txt'], acknowledged: true, baseRevision: null })
    expect(result).toEqual({ discarded: 1 })
    expect(porcelain(repo)).toEqual([])
  })

  it('混合列表拆两批：一次调用 restore tracked + clean untracked（计数合计，双效果 world 重读）', async () => {
    const repo = await scratchRepo('dshgit-mut-d-mixed-', cleanups, { name: 't', email: 't@example.com' })
    await write(repo, 'a.txt', 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await write(repo, 'a.txt', 'modified\n')
    await write(repo, 'junk.txt', 'untracked\n')
    const { service } = makeService(repo)
    const result = await service.discard({ paths: ['junk.txt', 'a.txt'], acknowledged: true, baseRevision: null })
    expect(result).toEqual({ discarded: 2 })
    expect(porcelain(repo)).toEqual([])
    await expect(readLf(repo, 'a.txt')).resolves.toBe('one\n')
    await expect(readFile(join(repo, 'junk.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('空数组 → git/no-paths', async () => {
    const repo = await scratchRepo('dshgit-mut-d-empty-', cleanups, { name: 't', email: 't@example.com' })
    const { service } = makeService(repo)
    await expect(service.discard({ paths: [], acknowledged: true, baseRevision: null }))
      .rejects.toMatchObject({ code: 'git/no-paths' })
  })
})

describe('isOldGitRestore（极老 git 兜底的触发条件；无旧 git 可端到端，条件单测锁定）', () => {
  it('exit 129（usage 错误）→ true；"is not a git command"/"unknown switch" → true', () => {
    expect(isOldGitRestore({ exitCode: 129, stdout: 'usage: git ...', stderr: '', truncated: false })).toBe(true)
    expect(isOldGitRestore({
      exitCode: 1, stdout: '', stderr: "git: 'restore' is not a git command. See 'git --help'.", truncated: false,
    })).toBe(true)
    expect(isOldGitRestore({
      exitCode: 129, stdout: '', stderr: "error: unknown switch `s'", truncated: false,
    })).toBe(true)
  })

  it('pathspec 未命中（exit 1 + did not match）与非零失败不触发兜底', () => {
    expect(isOldGitRestore({
      exitCode: 1, stdout: '', stderr: "error: pathspec 'x' did not match any file(s) known to git", truncated: false,
    })).toBe(false)
    expect(isOldGitRestore({ exitCode: 0, stdout: '', stderr: '', truncated: false })).toBe(false)
    expect(isOldGitRestore({
      exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', truncated: false,
    })).toBe(false)
  })
})
