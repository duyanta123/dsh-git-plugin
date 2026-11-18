/**
 * v3 批次一 — 冲突解决测试（[清单 13]；docs/v3-implementation-plan.md §3.8 host
 * 真仓范式行）。
 *
 * 覆盖：七码×两向命令矩阵逐格 world 重读（resolve 后 porcelain/ls-files 断言 unmerged
 * 清空 + index 内容符合所向）/ conflictList 的 operation 探测四态（cherry-pick/revert/
 * merge/rebase）+ 裸冲突 null/手动标记（含删除侧 rm 路径）/ path-not-conflicted 负路径
 * （零写命令）/ conflicts-remaining 守卫 / operationContinue——cherry-pick 双提交链冲突
 * → resolve → continue → 第二冲突 → resolve → continue → done:true 全链 world 重读
 * （HEAD/序役器状态）/ GIT_EDITOR=true 防挂起断言（spawn 记录 env + 无挂起完成）/
 * abort 扩展（merge 中间态 abort 回原 HEAD；rebase 探测 + rebase abort 回原位）。
 *
 * 夹具：UU/AA/UD/DU 走真 merge/cherry-pick；AU/UA/DD（直连 merge/cherry-pick 无法
 * 自然产出的码）用 `git update-index --index-info` 在真仓 index 上手塑 stage 条目
 * （真实 conflicted index 状态——worktree 文件按 stage 存在性摆放/移除）。断言纪律：
 * 验证世界而非自述——每个写断言后用独立 execFileSync git 重读。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'
import type { SpawnRecord } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeService(workspaceOverride: string, record?: SpawnRecord[]): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess(record))
  return new GitService(ctx, {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000, workspaceOverride,
    autoFetchIntervalMs: 0,
  })
}

async function makeWorld(name: string, record?: SpawnRecord[]): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-cf-${name}-`, cleanups)
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

/**
 * 允许非零退出的 fixture git（冲突命令 exit 1 是夹具的预期结果——execFileSync 会抛，
 * 这里用 spawnSync 拿到 status/stdout/stderr 由调用方断言世界）。
 */
function gitLoose(repo: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: repo, encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ---------- world 重读（独立 git 进程，验证世界而非自述） ----------

function worldHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function worldUnmerged(repo: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function worldClean(repo: string): boolean {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.trim() === ''
}

/** index 中某路径的 stage 行（`ls-files -s`：`<mode> <sha> <stage> <path>`；空 = 无条目）。 */
function worldIndexStages(repo: string, path: string): Array<{ mode: string; sha: string; stage: number }> {
  const out = execFileSync('git', ['ls-files', '-s', '--', path], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.trim().split('\n').filter((line) => line !== '').map((line) => {
    const [mode, sha, stage] = line.trim().split(/\s+/)
    return { mode: mode as string, sha: sha as string, stage: Number(stage) }
  })
}

function hashObject(repo: string, content: string): string {
  // 注意：execFileSync 的 input 只在默认 stdio（stdin=pipe）下真正送达——显式
  // stdio[0]='ignore' 会让 git 收到空 stdin（node spawnSync 语义，实修踩坑）。
  return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, encoding: 'utf8', input: content }).trim()
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
    // --git-path 可能回相对路径（相对 cwd=repo）——必须 resolve 到 repo 下再判存在性
    //（node 进程 cwd ≠ repo，existsSync 相对路径会判错——首跑实修踩坑）。
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

// ---------- 七码夹具（真仓 index 手塑 stage；worktree 按存在性摆放） ----------

/**
 * 在真仓 index 上手塑一条 unmerged 路径（`git update-index --index-info`，TAB 分隔）；
 * worktree 文件按 stage 存在性摆放（stage2/3 之一在场 ⇒ 写入对应内容；全删 ⇒ 不落盘）。
 */
async function craftUnmerged(repo: string, path: string, spec: { s1?: string; s2?: string; s3?: string }): Promise<void> {
  const lines: string[] = []
  if (spec.s1 !== undefined) lines.push(`100644 ${hashObject(repo, spec.s1)} 1\t${path}`)
  if (spec.s2 !== undefined) lines.push(`100644 ${hashObject(repo, spec.s2)} 2\t${path}`)
  if (spec.s3 !== undefined) lines.push(`100644 ${hashObject(repo, spec.s3)} 3\t${path}`)
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repo, encoding: 'utf8', input: `${lines.join('\n')}\n`,
  })
  const worktree = spec.s2 ?? spec.s3 ?? null
  if (worktree === null) return
  await writeFile(join(repo, path), worktree, 'utf8')
}

/** 七码 → 夹具 stage 组合（内容含码名便于断言 blob 归属）。 */
const CODE_STAGE_SPECS: Record<string, { s1?: string; s2?: string; s3?: string }> = {
  DD: { s1: 'base' },
  AU: { s2: 'ours' },
  UD: { s1: 'base', s2: 'ours' },
  UA: { s3: 'theirs' },
  DU: { s1: 'base', s3: 'theirs' },
  AA: { s2: 'ours', s3: 'theirs' },
  UU: { s1: 'base', s2: 'ours', s3: 'theirs' },
}

/** 矩阵期望（§3.4 实测口径——UD/DU 按 git 语义：ours=保持我方 / theirs=采对方）。 */
const MATRIX_EXPECT: Record<string, { ours: 'ours' | 'deleted'; theirs: 'theirs' | 'deleted' }> = {
  UU: { ours: 'ours', theirs: 'theirs' },
  AA: { ours: 'ours', theirs: 'theirs' },
  AU: { ours: 'ours', theirs: 'deleted' },
  UA: { ours: 'deleted', theirs: 'theirs' },
  DU: { ours: 'deleted', theirs: 'theirs' },
  UD: { ours: 'ours', theirs: 'deleted' },
  DD: { ours: 'deleted', theirs: 'deleted' },
}

describe('conflictList — fresh 扫描与七码形状（[13]）', () => {
  for (const [code, spec] of Object.entries(CODE_STAGE_SPECS)) {
    it(`code=${code}：fresh 扫描出 code/kind/oursExists/theirsExists（operation=null 裸冲突）`, async () => {
      const { repo, service } = await makeWorld(`shape-${code}`)
      await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
      await craftUnmerged(repo, 'f.txt', spec)
      const result = await service.conflictList()
      expect(result.conflicts).toHaveLength(1)
      const entry = result.conflicts[0]!
      expect(entry.path).toBe('f.txt')
      expect(entry.code).toBe(code)
      const expectKind: Record<string, string> = { DD: 'deleted', AU: 'added', UD: 'deleted', UA: 'added', DU: 'deleted', AA: 'added', UU: 'modified' }
      expect(entry.kind).toBe(expectKind[code])
      const expectExists: Record<string, [boolean, boolean]> = {
        DD: [false, false], AU: [true, false], UD: [true, false],
        UA: [false, true], DU: [false, true], AA: [true, true], UU: [true, true],
      }
      expect([entry.oursExists, entry.theirsExists]).toEqual(expectExists[code])
      // 裸冲突：无中间态伪引用/rebase 目录 ⇒ operation=null、abortable=false。
      expect(result.operation).toBeNull()
      expect(result.abortable).toBe(false)
      // world 重读：unmerged 集与 conflicts 路径一致。
      expect(worldUnmerged(repo)).toEqual(['f.txt'])
    })
  }

  it('无冲突仓库 ⇒ conflicts 空、operation=null（不抛错）', async () => {
    const { repo, service } = await makeWorld('clean')
    await commitFile(repo, 'a.txt', 'a\n', 'seed')
    const result = await service.conflictList()
    expect(result).toEqual({ conflicts: [], operation: null, abortable: false })
    expect(worldClean(repo)).toBe(true)
  })
})

describe('conflictList — operation 探测四态（[13] §3.3）', () => {
  /** 双分支同改 f.txt 的冲突夹具（cherry-pick/merge/revert 复用）。 */
  async function makeConflictBase(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService>; sideOid: string; mainOid: string }> {
    const { repo, service } = await makeWorld(name)
    await commitFile(repo, 'f.txt', 'base line\n', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideOid = await commitFile(repo, 'f.txt', 'side line\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'f.txt', 'main line\n', 'main edit')
    return { repo, service, sideOid, mainOid }
  }

  it('cherry-pick 冲突 ⇒ operation=cherry-pick、abortable=true', async () => {
    const { repo, service, sideOid, mainOid } = await makeConflictBase('op-cp')
    await service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: mainOid }).then(
      () => { throw new Error('expected conflict') },
      (cause: unknown) => { expect(remoteErrorOf(cause)?.code).toBe('git/merge-conflict') },
    )
    const result = await service.conflictList()
    expect(result.operation).toBe('cherry-pick')
    expect(result.abortable).toBe(true)
    expect(result.conflicts.map((entry) => entry.code)).toEqual(['UU'])
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(true)
  })

  it('revert 冲突 ⇒ operation=revert、abortable=true', async () => {
    const { repo, service, mainOid } = await makeConflictBase('op-revert')
    const sideOid = execFileSync('git', ['rev-parse', 'side'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const rejected = await rejectionOf(() => service.revert({ oid: sideOid, acknowledged: true, baseRevision: mainOid }))
    expect(rejected.code).toBe('git/merge-conflict')
    const result = await service.conflictList()
    expect(result.operation).toBe('revert')
    expect(result.abortable).toBe(true)
    expect(pseudoHeadExists(repo, 'REVERT_HEAD')).toBe(true)
  })

  it('merge 冲突 ⇒ operation=merge（MERGE_HEAD）、abortable=true', async () => {
    const { repo, service, mainOid } = await makeConflictBase('op-merge')
    const merge = gitLoose(repo, 'merge', 'side', '-m', 'merge')
    expect(merge.status).toBe(1)
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
    const result = await service.conflictList()
    expect(result.operation).toBe('merge')
    expect(result.abortable).toBe(true)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(true)
    expect(worldHead(repo)).toBe(mainOid)
  })

  it('rebase 冲突 ⇒ operation=rebase（rebase-merge/rebase-apply 目录）', async () => {
    const { repo, service } = await makeConflictBase('op-rebase')
    git(repo, 'checkout', '-q', 'side')
    const rebase = gitLoose(repo, 'rebase', 'main')
    expect(rebase.status).toBe(1)
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
    const result = await service.conflictList()
    expect(result.operation).toBe('rebase')
    expect(result.abortable).toBe(true)
    expect(gitDirState(repo, 'rebase-merge') || gitDirState(repo, 'rebase-apply')).toBe(true)
  })
})

describe('conflictResolve — 七码×两向矩阵逐格 world 重读（[13] §3.4）', () => {
  for (const [code, spec] of Object.entries(CODE_STAGE_SPECS)) {
    for (const resolution of ['ours', 'theirs'] as const) {
      it(`${code} × ${resolution}：unmerged 清空、index/worktree 符合所向`, async () => {
        const { repo, service } = await makeWorld(`matrix-${code}-${resolution}`)
        await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
        await craftUnmerged(repo, 'f.txt', spec)
        const before = await service.conflictList()
        expect(before.conflicts[0]?.code).toBe(code)

        const result = await service.conflictResolve({ choices: [{ path: 'f.txt', resolution }] })
        expect(result.resolved).toEqual(['f.txt'])

        // world 重读 1：unmerged 清空。
        expect(worldUnmerged(repo)).toEqual([])
        // world 重读 2：index 单 stage-0 条目且 blob 符合所向（rm ⇒ 无条目）。
        const expectSide = MATRIX_EXPECT[code]![resolution]
        const stages = worldIndexStages(repo, 'f.txt')
        if (expectSide === 'deleted') {
          expect(stages).toEqual([])
          expect(existsSync(join(repo, 'f.txt'))).toBe(false)
        } else {
          expect(stages).toHaveLength(1)
          expect(stages[0]!.stage).toBe(0)
          expect(stages[0]!.sha).toBe(hashObject(repo, expectSide))
          expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe(expectSide)
        }
      })
    }
  }

  it('多文件逐条解决：七码夹具并存一轮全清（矩阵查表无调用点分支）', async () => {
    const { repo, service } = await makeWorld('matrix-multi')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    for (const [code, spec] of Object.entries(CODE_STAGE_SPECS)) {
      await craftUnmerged(repo, `${code}.txt`, spec)
    }
    const before = await service.conflictList()
    expect(before.conflicts).toHaveLength(7)
    const result = await service.conflictResolve({
      choices: Object.keys(CODE_STAGE_SPECS).map((code) => ({ path: `${code}.txt`, resolution: 'ours' as const })),
    })
    expect(result.resolved).toEqual(Object.keys(CODE_STAGE_SPECS).map((code) => `${code}.txt`))
    expect(worldUnmerged(repo)).toEqual([])
  })

  it('多文件中途失败 ⇒ git-error details.resolved 分列已成功项（§3.10 如实分列；已执行项不回滚）', async () => {
    const { repo, service } = await makeWorld('resolve-partial')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await craftUnmerged(repo, 'a.txt', CODE_STAGE_SPECS.UU!)
    await craftUnmerged(repo, 'g.txt', CODE_STAGE_SPECS.UU!)
    // 中途失败夹具：g.txt 钉 required 失败 clean filter（filter.failing.clean=exit 1 +
    // required=true）——第二个文件的矩阵 checkout 步骤真失败（smudge required ⇒ exit
    // 128，git 2.55.0.windows.2 实测）。unmerged 扫描（porcelain v2 u 记录直接来自
    // index）不走 filter——守卫面健康，失败精确落在矩阵步骤内（真仓可确定性构造的
    // 唯一中途失败注入点；矩阵七码对有效 unmerged 输入逐格 exit 0——文件头实测）。
    await writeFile(join(repo, '.gitattributes'), 'g.txt filter=failing\n', 'utf8')
    git(repo, 'config', 'filter.failing.clean', 'exit 1')
    git(repo, 'config', 'filter.failing.required', 'true')
    const rejection = await rejectionOf(() => service.conflictResolve({
      choices: [
        { path: 'a.txt', resolution: 'theirs' },
        { path: 'g.txt', resolution: 'theirs' },
      ],
    }))
    expect(rejection.code).toBe('git/git-error')
    expect(rejection.details.resolved).toEqual(['a.txt'])
    // world 重读（ls-files 纯 index 读——unmerged 是 index 属性）：a.txt 已按 theirs
    // 落 stage-0（不回滚——已执行项保留），g.txt 三 stage 仍 unmerged。**不走
    // worldUnmerged 的 diff 面**：required filter 夹具下 `git diff` 对 stat-dirty 的
    // unmerged 路径做内容比对会跑 clean filter 而 fatal（checkout fatal 部分刷新过
    // stat 缓存故 resolve 支路能过——add fatal 不刷新，mark 支路必炸；实测 2026-11-12）。
    const aStages = worldIndexStages(repo, 'a.txt')
    expect(aStages).toHaveLength(1)
    expect(aStages[0]!.stage).toBe(0)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('theirs')
    expect(worldIndexStages(repo, 'g.txt').map((s) => s.stage).sort()).toEqual([1, 2, 3])
  })

  it('conflictMarkResolved 中途失败同款：details.resolved 分列（§3.10）', async () => {
    const { repo, service } = await makeWorld('mark-partial')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await craftUnmerged(repo, 'a.txt', CODE_STAGE_SPECS.UU!)
    await craftUnmerged(repo, 'g.txt', CODE_STAGE_SPECS.UU!)
    await writeFile(join(repo, '.gitattributes'), 'g.txt filter=failing\n', 'utf8')
    git(repo, 'config', 'filter.failing.clean', 'exit 1')
    git(repo, 'config', 'filter.failing.required', 'true')
    const rejection = await rejectionOf(() => service.conflictMarkResolved({ paths: ['a.txt', 'g.txt'] }))
    expect(rejection.code).toBe('git/git-error')
    expect(rejection.details.resolved).toEqual(['a.txt'])
    // world 重读（index 真相 + fs 直读——理由同上）：a.txt stage-0、g.txt 仍 unmerged。
    expect(worldIndexStages(repo, 'a.txt').map((s) => s.stage)).toEqual([0])
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('ours')
    expect(worldIndexStages(repo, 'g.txt').map((s) => s.stage).sort()).toEqual([1, 2, 3])
  })

  it('path 非 unmerged ⇒ bad-request path-not-conflicted（零写命令——clean 文件未被触碰）', async () => {
    const { repo, service } = await makeWorld('neg-resolve')
    const seed = await commitFile(repo, 'clean.txt', 'clean\n', 'seed')
    await craftUnmerged(repo, 'f.txt', CODE_STAGE_SPECS.UU!)
    const rejection = await rejectionOf(() => service.conflictResolve({ choices: [{ path: 'clean.txt', resolution: 'ours' }] }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('path-not-conflicted')
    expect(rejection.details.paths).toEqual(['clean.txt'])
    // 零写命令：world 不动（clean.txt 无 index 变化、f.txt 仍 unmerged）。
    expect(worldIndexStages(repo, 'clean.txt')).toHaveLength(1)
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
    expect(worldHead(repo)).toBe(seed)
  })

  it('choices 空 ⇒ git/no-paths（mutations empty-array 纪律同款）', async () => {
    const { repo, service } = await makeWorld('empty-resolve')
    await commitFile(repo, 'a.txt', 'a\n', 'seed')
    const rejection = await rejectionOf(() => service.conflictResolve({ choices: [] }))
    expect(rejection.code).toBe('git/no-paths')
    expect(rejection.details.op).toBe('conflictResolve')
    expect(worldClean(repo)).toBe(true)
  })
})

describe('conflictMarkResolved — 手动标记（含删除侧 rm 路径）（[13]）', () => {
  it('手动编辑后 add：index 落编辑后的 blob（world 重读）', async () => {
    const { repo, service } = await makeWorld('mark-add')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await craftUnmerged(repo, 'f.txt', CODE_STAGE_SPECS.UU!)
    await writeFile(join(repo, 'f.txt'), 'manually merged\n', 'utf8')
    const result = await service.conflictMarkResolved({ paths: ['f.txt'] })
    expect(result.resolved).toEqual(['f.txt'])
    expect(worldUnmerged(repo)).toEqual([])
    const stages = worldIndexStages(repo, 'f.txt')
    expect(stages).toHaveLength(1)
    expect(stages[0]!.stage).toBe(0)
    expect(stages[0]!.sha).toBe(hashObject(repo, 'manually merged\n'))
    // 标记已解决 = add（改动进暂存区）——porcelain 显示 staged 条目而非干净（world 重读；
    // f.txt 不在 HEAD ⇒ staged 形态为 'A '，历史有该文件时为 'M '）。
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(porcelain).toMatch(/^(A|M)  f\.txt$/m)
  })

  it('删除侧（用户已删文件）⇒ rm 路径：index 条目消失、unmerged 清空', async () => {
    const { repo, service } = await makeWorld('mark-rm')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    // DD：worktree 本就无文件（双删侧）。
    await craftUnmerged(repo, 'dd.txt', CODE_STAGE_SPECS.DD!)
    expect(existsSync(join(repo, 'dd.txt'))).toBe(false)
    // UD：我方修改在场，用户手动删除文件（接受删除的手动路径）。
    await craftUnmerged(repo, 'ud.txt', CODE_STAGE_SPECS.UD!)
    const rmTarget = join(repo, 'ud.txt')
    await unlink(rmTarget)
    const result = await service.conflictMarkResolved({ paths: ['dd.txt', 'ud.txt'] })
    expect(result.resolved).toEqual(['dd.txt', 'ud.txt'])
    expect(worldUnmerged(repo)).toEqual([])
    expect(worldIndexStages(repo, 'dd.txt')).toEqual([])
    expect(worldIndexStages(repo, 'ud.txt')).toEqual([])
    expect(worldClean(repo)).toBe(true)
  })

  it('path 非 unmerged ⇒ bad-request path-not-conflicted（零写命令）', async () => {
    const { repo, service } = await makeWorld('neg-mark')
    await commitFile(repo, 'clean.txt', 'clean\n', 'seed')
    await craftUnmerged(repo, 'f.txt', CODE_STAGE_SPECS.UU!)
    const rejection = await rejectionOf(() => service.conflictMarkResolved({ paths: ['clean.txt'] }))
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('path-not-conflicted')
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
    expect(worldIndexStages(repo, 'clean.txt')).toHaveLength(1)
  })
})

describe('operationContinue — 守卫与 cherry-pick 双提交链全链（[13] §3.3/§3.8）', () => {
  it('仍有 unmerged ⇒ bad-request conflicts-remaining（零命令）', async () => {
    const { repo, service } = await makeWorld('guard-remaining')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await craftUnmerged(repo, 'f.txt', CODE_STAGE_SPECS.UU!)
    const head = worldHead(repo)
    const rejection = await rejectionOf(() => service.operationContinue())
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('conflicts-remaining')
    expect(rejection.details.paths).toEqual(['f.txt'])
    // 零命令：世界不动。
    expect(worldHead(repo)).toBe(head)
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
  })

  it('无中间态且无冲突 ⇒ bad-request invalid-options', async () => {
    const { repo, service } = await makeWorld('guard-none')
    await commitFile(repo, 'a.txt', 'a\n', 'seed')
    const rejection = await rejectionOf(() => service.operationContinue())
    expect(rejection.code).toBe('git/bad-request')
    expect(rejection.details.reason).toBe('invalid-options')
    expect(worldClean(repo)).toBe(true)
  })

  it('双提交链：冲突→resolve→continue(done:false)→第二冲突→resolve→continue(done:true) 全链 world 重读 + GIT_EDITOR=true env', async () => {
    const records: SpawnRecord[] = []
    const { repo, service } = await makeWorld('chain', records)
    // base：f.txt 在基线就存在（S1 对它是修改 ⇒ UU；若基线缺失会变 AA）+ seed 提交。
    const baseOid = await commitFile(repo, 'f.txt', 'base f\n', 'base')
    await commitFile(repo, 'base.txt', 'base\n', 'seed')
    git(repo, 'checkout', '-qb', 'side')
    const s1 = await commitFile(repo, 'f.txt', 'side f\n', 'side one')
    const s2 = await commitFile(repo, 'g.txt', 'side g2\n', 'side two')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'f.txt', 'main f\n', 'main edit')
    await writeFile(join(repo, 'g.txt'), 'main g\n', 'utf8')
    git(repo, 'add', 'g.txt')
    git(repo, 'commit', '-qm', 'main g edit')
    // 夹具侧直接起双提交序役（@Remote cherryPick 是单 oid 面——序役由夹具真实制造）。
    const sequencer = gitLoose(repo, 'cherry-pick', s1, s2)
    expect(sequencer.status).toBe(1)
    expect(sequencer.stdout + sequencer.stderr).toContain('CONFLICT')
    expect(worldUnmerged(repo)).toEqual(['f.txt'])
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(true)

    // 第一冲突：conflictList 探到 cherry-pick + UU。
    const listed = await service.conflictList()
    expect(listed.operation).toBe('cherry-pick')
    expect(listed.conflicts.map((entry) => [entry.path, entry.code])).toEqual([['f.txt', 'UU']])

    // 守卫：冲突未解 ⇒ conflicts-remaining。
    const guard = await rejectionOf(() => service.operationContinue())
    expect(guard.details.reason).toBe('conflicts-remaining')

    // resolve（theirs = 'side f'——ours 会把这笔 pick 变成空提交，git 会拒绝 continue）。
    const resolved1 = await service.conflictResolve({ choices: [{ path: 'f.txt', resolution: 'theirs' }] })
    expect(resolved1.resolved).toEqual(['f.txt'])
    expect(worldUnmerged(repo)).toEqual([])
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe('side f\n')

    // continue #1：S1 落一笔提交，序役推进到 S2 ⇒ 第二冲突 {done:false, conflicted}。
    const first = await service.operationContinue()
    expect(first).toEqual({ op: 'cherry-pick', done: false, conflicted: ['g.txt'] })
    // world：HEAD 已推进一笔（S1 的 message），CHERRY_PICK_HEAD 仍在（S2 待处理）。
    expect(worldHead(repo)).not.toBe(mainOid)
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('side one')
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(true)
    expect(worldUnmerged(repo)).toEqual(['g.txt'])

    // 第二冲突解决 + continue #2：done:true、序役清空。
    const resolved2 = await service.conflictResolve({ choices: [{ path: 'g.txt', resolution: 'theirs' }] })
    expect(resolved2.resolved).toEqual(['g.txt'])
    const second = await service.operationContinue()
    expect(second).toEqual({ op: 'cherry-pick', done: true, conflicted: [] })
    // world：HEAD 前进第二笔（S2 的 message）、序役伪引用清空、工作区干净、内容符合所向。
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('side two')
    expect(await readFile(join(repo, 'g.txt'), 'utf8')).toBe('side g2\n')
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe('side f\n')
    expect(pseudoHeadExists(repo, 'CHERRY_PICK_HEAD')).toBe(false)
    expect(worldClean(repo)).toBe(true)
    // world：链上两笔新提交都在（s1/s2 的 pick 副本）。
    const logSubjects = git(repo, 'log', '--format=%s', '-n', '5').trim().split('\n')
    expect(logSubjects).toEqual(['side two', 'side one', 'main g edit', 'main edit', 'seed'])
    void baseOid

    // GIT_EDITOR=true 防挂起：continue 命令的 spawn 记录里 env 必须带 GIT_EDITOR=true
    // （防挂起是正确性问题——若无该 env，git 会拉起编辑器直至测试超时）。
    const continueRuns = records.filter((rec) => rec.argv.includes('--continue') && rec.argv.includes('cherry-pick'))
    expect(continueRuns).toHaveLength(2)
    for (const run of continueRuns) {
      expect(run.env.GIT_EDITOR).toBe('true')
    }
  })

  it('revert 链：冲突→resolve→continue⇒done:true（GIT_EDITOR=true，world 重读）', async () => {
    const records: SpawnRecord[] = []
    const { repo, service } = await makeWorld('revert-chain', records)
    await commitFile(repo, 'f.txt', 'base line\n', 'base')
    git(repo, 'checkout', '-qb', 'topic')
    const topicOid = await commitFile(repo, 'f.txt', 'topic line\n', 'topic edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = await commitFile(repo, 'f.txt', 'main line\n', 'main edit')
    const rejected = await rejectionOf(() => service.revert({ oid: topicOid, acknowledged: true, baseRevision: mainOid }))
    expect(rejected.code).toBe('git/merge-conflict')
    const resolved = await service.conflictResolve({ choices: [{ path: 'f.txt', resolution: 'theirs' }] })
    expect(resolved.resolved).toEqual(['f.txt'])
    const continued = await service.operationContinue()
    expect(continued).toEqual({ op: 'revert', done: true, conflicted: [] })
    // world：revert 提交落地（theirs 决议 = topic 提交的父版本 'base line'——逆向应用
    // 的真实结果）、REVERT_HEAD 清空、干净。
    expect(pseudoHeadExists(repo, 'REVERT_HEAD')).toBe(false)
    expect(await readFile(join(repo, 'f.txt'), 'utf8')).toBe('base line\n')
    expect(worldClean(repo)).toBe(true)
    expect(worldHead(repo)).not.toBe(mainOid)
    const continueRuns = records.filter((rec) => rec.argv.includes('--continue') && rec.argv.includes('revert'))
    expect(continueRuns).toHaveLength(1)
    expect(continueRuns[0]!.env.GIT_EDITOR).toBe('true')
  })
})

describe('abortOperation 扩展 — merge/rebase 中间态（[13] §3.3）', () => {
  it('merge 中间态 abort ⇒ aborted=merge、回原 HEAD（world 重读）', async () => {
    const { repo, service, mainOid } = await makeConflictWorld('abort-merge')
    const merge = gitLoose(repo, 'merge', 'side', '-m', 'merge')
    expect(merge.status).toBe(1)
    expect(worldUnmerged(repo)).toEqual(['a.txt'])
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(true)

    const aborted = await service.abortOperation()
    expect(aborted).toEqual({ aborted: 'merge' })
    // world：HEAD 回原位、MERGE_HEAD 清除、工作区干净、a.txt 复原为 main 版本。
    expect(worldHead(repo)).toBe(mainOid)
    expect(pseudoHeadExists(repo, 'MERGE_HEAD')).toBe(false)
    expect(worldUnmerged(repo)).toEqual([])
    expect(worldClean(repo)).toBe(true)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('main line\n')
    // 幂等：无中间态 ⇒ 空成功（零命令）。
    const idempotent = await service.abortOperation()
    expect(idempotent).toEqual({ aborted: null })
  })

  it('rebase 中间态探测 + abort ⇒ aborted=rebase、回到原分支原提交（world 重读）', async () => {
    const { repo, service, sideOid } = await makeConflictWorld('abort-rebase')
    git(repo, 'checkout', '-q', 'side')
    const rebase = gitLoose(repo, 'rebase', 'main')
    expect(rebase.status).toBe(1)
    expect(worldUnmerged(repo)).toEqual(['a.txt'])
    const listed = await service.conflictList()
    expect(listed.operation).toBe('rebase')

    const aborted = await service.abortOperation()
    expect(aborted).toEqual({ aborted: 'rebase' })
    // world：回 side 原提交、rebase 目录清除、干净。
    expect(worldHead(repo)).toBe(sideOid)
    expect(gitDirState(repo, 'rebase-merge') || gitDirState(repo, 'rebase-apply')).toBe(false)
    expect(worldUnmerged(repo)).toEqual([])
    expect(worldClean(repo)).toBe(true)
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('side')
  })
})

/** 双分支同改 a.txt 的冲突世界（abort 组共用）。 */
async function makeConflictWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService>; sideOid: string; mainOid: string }> {
  const { repo, service } = await makeWorld(name)
  await commitFile(repo, 'a.txt', 'base line\n', 'base')
  git(repo, 'checkout', '-qb', 'side')
  const sideOid = await commitFile(repo, 'a.txt', 'side line\n', 'side edit')
  git(repo, 'checkout', '-q', 'main')
  const mainOid = await commitFile(repo, 'a.txt', 'main line\n', 'main edit')
  return { repo, service, sideOid, mainOid }
}
