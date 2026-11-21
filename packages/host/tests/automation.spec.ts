/**
 * v3 批次五 — 自动化测试（[清单 42/43]；docs/v3-implementation-plan.md §7.6）。
 *
 * 覆盖（真仓范式——每个写场景后用独立 execFileSync git 重读外部状态，不信自述）：
 *   auto-commit [42]：turn/end(completed) + 脏区 ⇒ 提交落地（world 重读 HEAD 前进 +
 *     message 模板插值 + trailer 断言 + worktree clean + tree 含 untracked）；secret
 *     staged 样本 ⇒ 无提交 + `git reset` 后 worktree 改动仍在（porcelain 世界重读）+
 *     audit 入环（ok:false git/commit-blocked）；identity 缺失 ⇒ 跳过（零提交 +
 *     audit）；hook 失败（夹具 pre-commit exit 1）⇒ 放弃 + audit；aborted/error/blocked
 *     回合不触发（零动作零登记）；autoCommitMode off 全程零动作；子代理会话不触发
 *     （eligibleSessionCwd 资格）；
 *   auto-branch [43]：受保护分支 + clean ⇒ 建切（world 重读 HEAD + 分支名 + 指向种子
 *     oid + 判重）；非 clean ⇒ 跳过且下回合重试（瞬时性——判重撤销）；已在任务分支
 *     ⇒ 不再建（前缀命中判重）；非受保护分支 ⇒ 跳过；命名冲突序号递增（branch-exists
 *     ⇒ -2 后缀——refs-admin 预检消费）；
 *   竞态：turn/end 与手工 commit 先后 ⇒ 无重复提交（fresh status 判空零动作）；
 *   纯函数/wire 面：shortBranchToken 分支安全化；automationStatus 出参形状（mode 投影
 *     + lastActions newest-first + 环 20 条封顶）+ REMOTE_METHODS 56 计数锚。
 */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GitService, REMOTE_METHODS } from '../src/index.ts'
import { shortBranchToken } from '../src/automation.ts'
import type { GitSessionEventFace, GitSessionFace } from '../src/workspace.ts'
import type { AutomationStatusResult } from '../src/types.ts'
import { git, makeGitService, scratchDir, scratchRepo } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// 身份隔离（commit.spec.ts 同款）：GIT_CONFIG_GLOBAL 指向**不存在**的文件——本机实测
// git 对缺失的全局配置静默忽略；GIT_CONFIG_NOSYSTEM=1 隔离系统级配置。需要身份的夹具
// 显式 scratchRepo(…, {name, email}) 写 local 配置（不受全局隔离影响）。
const envCleanups: Array<() => Promise<unknown>> = []
let realGlobalConfig: string | undefined
let realNosystem: string | undefined
beforeAll(async () => {
  realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  realNosystem = process.env.GIT_CONFIG_NOSYSTEM
  const isolationDir = await scratchDir('dshgit-auto-isolation-', envCleanups)
  process.env.GIT_CONFIG_GLOBAL = join(isolationDir, 'does-not-exist')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(async () => {
  if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig
  if (realNosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = realNosystem
  while (envCleanups.length > 0) await envCleanups.pop()!()
})

// ---------- 夹具 ----------

const T0 = 2_000_000_000_000

function makeService(
  workspaceOverride: string,
  automation: {
    autoCommitMode?: 'off' | 'turn-end'
    autoCommitMessage?: 'ai' | 'template'
    autoCommitTemplate?: string
    autoBranchMode?: 'off' | 'session-start'
    autoBranchPrefix?: string
    autoBranchProtected?: string[]
  } = {},
): InstanceType<typeof GitService> {
  // 装配去重：Context+subprocess 面经 support.makeGitService；差异键照旧逐键表达。
  return makeGitService(workspaceOverride, {
    commitTimeoutMs: 15_000,
    autoFetchIntervalMs: 0,
    ...automation,
  }).service
}

/** 顶层会话夹具（header.cwd 在场 = eligibleSessionCwd 资格成立）。 */
function session(id: string, cwd: string): GitSessionFace {
  return { id, header: { cwd } }
}

function startEvent(turn: number, time = T0): GitSessionEventFace {
  return { type: 'turn/start', time, data: { turn } }
}

function endEvent(turn: number, reasonKind = 'completed', time = T0): GitSessionEventFace {
  return { type: 'turn/end', time, data: { turn, reason: { kind: reasonKind } } }
}

/** 事件直喂（observe + settleOf——fire-and-forget 动作链在测试里的等待半）。 */
async function feed(
  service: InstanceType<typeof GitService>,
  who: GitSessionFace,
  event: GitSessionEventFace,
): Promise<void> {
  service.automationOf().observe(who, event)
  await service.automationOf().settleOf()
}

// ---------- world 重读（独立 git 进程——验证世界而非自述） ----------

function headOid(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** HEAD 短分支名（detached = 'HEAD'）。 */
function headBranch(repo: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function headMessage(repo: string): string {
  return execFileSync('git', ['log', '-1', '--format=%B'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commitCount(repo: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', '--all'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
}

function porcelain(repo: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function headTreeNames(repo: string): string {
  return execFileSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 分支引用存在性（world 重读；--quiet exit 1 = 缺失——execFileSync 抛错按缺省 false）。 */
function branchExists(repo: string, name: string): boolean {
  try {
    const probe = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return probe.trim() !== ''
  } catch {
    return false
  }
}

/** 写一个可执行的 repo hook（commit.spec.ts 同款——LF only + node chmod）。 */
async function writeHook(repo: string, name: string, body: string): Promise<void> {
  const hook = join(repo, '.git', 'hooks', name)
  await mkdir(join(hook, '..'), { recursive: true })
  await writeFile(hook, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(hook, 0o755)
}

/** 种子仓库（main 上一笔提交 + 干净工作区 + local 身份）。 */
async function seededRepo(prefix: string): Promise<string> {
  const repo = await scratchRepo(prefix, cleanups, { name: 't', email: 't@example.com' })
  git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'seed.txt'), 'seed\n', 'utf8')
  git(repo, 'add', 'seed.txt')
  git(repo, 'commit', '-qm', 'chore: seed')
  return repo
}

/** 自动化动作环的首条（newest-first；无动作 = null）。 */
function lastAction(service: InstanceType<typeof GitService>): AutomationStatusResult['lastActions'][number] | null {
  const status = service.automationOf().status()
  return status.lastActions[0] ?? null
}

// ---------- auto-commit [42] ----------

describe('auto-commit [42] — turn/end(completed) + 脏区', () => {
  it('提交落地：world 重读 HEAD 前进、模板 {turn} 插值、署名 trailer、worktree clean、tree 含 untracked', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-ok-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-qm', 'chore: tracked base')
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8') // 修改 tracked
    await writeFile(join(repo, 'new.txt'), 'brand new\n', 'utf8') // untracked
    const before = headOid(repo)

    await feed(service, session('sess-turn7', repo), endEvent(7))

    // world 重读：HEAD 前进一笔；消息 = 默认模板插值 + trailer 尾块；worktree clean。
    expect(commitCount(repo)).toBe(3)
    expect(headOid(repo)).not.toBe(before)
    expect(headMessage(repo)).toContain('chore: auto-commit session changes (turn 7)')
    expect(headMessage(repo)).toContain('Auto-committed-by: dsh-git-plugin')
    expect(porcelain(repo)).toBe('')
    // add -A 全量面：untracked 文件进了新提交的 tree。
    const tree = headTreeNames(repo)
    expect(tree).toContain('new.txt')
    expect(tree).toContain('tracked.txt')
    // lastActions 首条 = 本次成功（newest-first）。
    const action = lastAction(service)
    expect(action?.action).toBe('auto-commit')
    expect(action?.ok).toBe(true)
    expect(action?.detail).toContain('(turn 7)')
    // audit 入环：ok 出口 + 白名单摘要（turn/branch——无 message 正文）。
    const log = await service.auditLog({})
    expect(log.entries[0]?.op).toBe('auto-commit')
    expect(log.entries[0]?.ok).toBe(true)
    expect(log.entries[0]?.code).toBeNull()
    expect(log.entries[0]?.summary).toContain('turn=7')
    expect(log.entries[0]?.summary).toContain('branch=main')
  })

  it('secret staged ⇒ 无提交 + git reset 后 worktree 改动仍在 + audit 入环（DD=A 不豁免不重试）', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-sec-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    const before = headOid(repo)
    await writeFile(join(repo, 'secret.txt'), 'provider token = ghp_ABCDEFGHIJKLMNOPQRSTUVWX\n', 'utf8')

    await feed(service, session('sess-sec', repo), endEvent(2))

    // world 重读：零新提交；改动仍在 worktree（reset 后 unstaged untracked，不在 index）。
    expect(commitCount(repo)).toBe(1)
    expect(headOid(repo)).toBe(before)
    expect(porcelain(repo)).toContain('secret.txt')
    expect(porcelain(repo)).not.toMatch(/^A  /)
    // lastActions + audit 双路如实。
    const action = lastAction(service)
    expect(action?.ok).toBe(false)
    expect(action?.detail).toContain('secret block')
    expect(action?.detail).toContain('staged reset')
    const log = await service.auditLog({})
    expect(log.entries[0]?.op).toBe('auto-commit')
    expect(log.entries[0]?.ok).toBe(false)
    expect(log.entries[0]?.code).toBe('git/commit-blocked')
  })

  it('裸冲突（stash pop 式：UU 无中间态文件）⇒ 零提交零动作 + audit git/merge-conflict（评审收口）', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-barecf-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    // stash pop 冲突夹具（评审实证路径）：add -A 会静默「代为解决」unmerged 并把冲突
    // 标记提交进 HEAD——自动化必须在动手段前拒绝。用 seededRepo 的跟踪文件 seed.txt。
    await writeFile(join(repo, 'seed.txt'), 'seed\nmine\n', 'utf8')
    git(repo, 'stash', 'push', '-qm', 'wip')
    await writeFile(join(repo, 'seed.txt'), 'seed\ntheirs\n', 'utf8')
    git(repo, 'commit', '-qam', 'chore: mainline')
    try {
      git(repo, 'stash', 'pop') // exit 1（冲突）——execFileSync 抛错即预期
    } catch { /* 冲突退出是夹具的预期结果 */ }
    // 夹具自证：UU 在场 + 零中间态伪引用/目录（detectOperation 将返回 null）。
    expect(porcelain(repo)).toBe('UU seed.txt\n')
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      expect(() => execFileSync('git', ['rev-parse', '--verify', '--quiet', marker], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })).toThrow()
    }
    // 零提交基线在夹具（含 mainline 提交）之后捕获。
    const before = headOid(repo)

    await feed(service, session('sess-barecf', repo), endEvent(9))

    // world 重读：HEAD 零提交（headOid == before；commitCount 是 --all 面——stash 冲突
    // 保留的两枚内部提交会计入，不用它断言本仓提交数）、UU 原样（未被 add -A 代为解决）。
    expect(headOid(repo)).toBe(before)
    expect(Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())).toBe(2)
    expect(porcelain(repo)).toBe('UU seed.txt\n')
    expect(execFileSync('git', ['show', 'HEAD:seed.txt'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).not.toContain('<<<<<<<')
    // lastActions + audit 双路如实（fail-closed 记 skip，非成功）。
    const action = lastAction(service)
    expect(action?.ok).toBe(false)
    expect(action?.detail).toContain('bare conflict')
    const log = await service.auditLog({})
    expect(log.entries[0]?.op).toBe('auto-commit')
    expect(log.entries[0]?.ok).toBe(false)
    expect(log.entries[0]?.code).toBe('git/merge-conflict')
  })

  it('identity 缺失 ⇒ 跳过（零提交 + audit git/identity-missing）', async () => {
    const repo = await scratchRepo('dshgit-auto-cmt-idl-', cleanups) // 无 local 身份；全局已被隔离
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    await writeFile(join(repo, 'x.txt'), 'x\n', 'utf8')

    await feed(service, session('sess-idless', repo), endEvent(1))

    // world 重读：unborn 保持（零提交）；lastActions/audit 双路登记。
    expect(commitCount(repo)).toBe(0)
    const action = lastAction(service)
    expect(action?.ok).toBe(false)
    expect(action?.detail).toContain('identity missing')
    const log = await service.auditLog({})
    expect(log.entries[0]?.op).toBe('auto-commit')
    expect(log.entries[0]?.ok).toBe(false)
    expect(log.entries[0]?.code).toBe('git/identity-missing')
  })

  it('hook 失败（pre-commit exit 1）⇒ 放弃 + audit git/hook-failed（不重试不改写）', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-hook-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    // 夹具 exit 1 + stderr 发声——本机 git 2.55 实测裸 exit 1 的 hook 零输出（commit.ts
    // 文件头「静默失败的 hook 无从与普通失败区分」已知限制），分类器无从落
    // git/hook-failed；commit.spec.ts:264 同款发声夹具（exit 1 语义不变）。
    await writeHook(repo, 'pre-commit', 'echo "auto-commit hook rejects this change" >&2\nexit 1\n')
    await writeFile(join(repo, 'y.txt'), 'y\n', 'utf8')
    const before = headOid(repo)

    await feed(service, session('sess-hook', repo), endEvent(3))

    // world 重读：零新提交（放弃——不 --no-verify 绕行、不改写重试）。
    expect(commitCount(repo)).toBe(1)
    expect(headOid(repo)).toBe(before)
    const action = lastAction(service)
    expect(action?.ok).toBe(false)
    expect(action?.detail).toContain('hook')
    const log = await service.auditLog({})
    expect(log.entries[0]?.op).toBe('auto-commit')
    expect(log.entries[0]?.ok).toBe(false)
    expect(log.entries[0]?.code).toBe('git/hook-failed')
  })

  it('aborted / error / blocked 回合不触发（零提交零动作零登记）', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-abort-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    await writeFile(join(repo, 'z.txt'), 'z\n', 'utf8')

    await feed(service, session('sess-abort', repo), endEvent(1, 'aborted'))
    await feed(service, session('sess-abort', repo), endEvent(2, 'error'))
    await feed(service, session('sess-abort', repo), endEvent(3, 'blocked'))

    expect(commitCount(repo)).toBe(1)
    expect(service.automationOf().status().lastActions).toEqual([])
  })

  it('autoCommitMode off 全程零动作（监听在场但 observe 即退）', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-off-')
    const service = makeService(repo) // 默认 off
    await writeFile(join(repo, 'w.txt'), 'w\n', 'utf8')

    await feed(service, session('sess-off', repo), endEvent(1))

    expect(commitCount(repo)).toBe(1)
    expect(service.automationOf().status().lastActions).toEqual([])
    expect(service.automationOf().status().autoCommitMode).toBe('off')
  })

  it('子代理会话不触发（eligibleSessionCwd 资格——origin=subagent 跳过，零动作零登记）', async () => {
    const repo = await seededRepo('dshgit-auto-cmt-sub-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    await writeFile(join(repo, 's.txt'), 's\n', 'utf8')

    await feed(service, { id: 'sess-sub', header: { cwd: repo, origin: 'subagent' } }, endEvent(1))

    expect(commitCount(repo)).toBe(1)
    expect(service.automationOf().status().lastActions).toEqual([])
  })
})

// ---------- auto-branch [43] ----------

describe('auto-branch [43] — turn/start（per-session 判重）', () => {
  it('受保护分支 + clean ⇒ 建切：world 重读 HEAD 分支名与指向；同会话后续回合判重', async () => {
    const repo = await seededRepo('dshgit-auto-br-ok-')
    const service = makeService(repo, { autoBranchMode: 'session-start' })
    const seedOid = headOid(repo)

    await feed(service, session('worker-a1b2c3d4', repo), startEvent(1))

    // world 重读：HEAD 已切到 dsh/task-worker-a（短 id 8 字符），分支指向种子 oid。
    expect(headBranch(repo)).toBe('dsh/task-worker-a')
    expect(headOid(repo)).toBe(seedOid)
    expect(branchExists(repo, 'dsh/task-worker-a')).toBe(true)
    const action = lastAction(service)
    expect(action?.action).toBe('auto-branch')
    expect(action?.ok).toBe(true)
    expect(action?.detail).toContain('created dsh/task-worker-a')
    const log = await service.auditLog({})
    expect(log.entries[0]?.op).toBe('auto-branch')
    expect(log.entries[0]?.ok).toBe(true)
    // 判重：同会话后续 turn/start 不再建（零新分支 + 判重记忆在）。
    await feed(service, session('worker-a1b2c3d4', repo), startEvent(2))
    await feed(service, session('worker-a1b2c3d4', repo), startEvent(3))
    expect(branchExists(repo, 'dsh/task-worker-a-2')).toBe(false)
    expect(service.automationOf().seenSessions()).toEqual(['worker-a1b2c3d4'])
  })

  it('非 clean ⇒ 跳过；下回合重试（瞬时性——判重撤销，变干净后同会话再触发即建）', async () => {
    const repo = await seededRepo('dshgit-auto-br-dirty-')
    const service = makeService(repo, { autoBranchMode: 'session-start' })
    await writeFile(join(repo, 'dirty.txt'), 'dirty\n', 'utf8')

    await feed(service, session('sess-dirty', repo), startEvent(1))

    // world 重读：仍在 main，无新分支，无动作登记（§7.3 跳过 + log）。
    expect(headBranch(repo)).toBe('main')
    expect(branchExists(repo, 'dsh/task-sess-dir')).toBe(false)
    expect(service.automationOf().status().lastActions).toEqual([])

    // 判重已撤销：同一会话把工作区变干净后再来一个 turn/start ⇒ 重试成功建切。
    git(repo, 'add', 'dirty.txt')
    git(repo, 'commit', '-qm', 'chore: manual dirty fix')
    await feed(service, session('sess-dirty', repo), startEvent(2))
    expect(headBranch(repo)).toBe('dsh/task-sess-dir')
  })

  it('已在任务分支 ⇒ 不再建（任务分支不在受保护表——§7.3 条件表；本会话回合内判重在建切用例覆盖）', async () => {
    const repo = await seededRepo('dshgit-auto-br-task-')
    git(repo, 'switch', '-qc', 'dsh/task-xyz')
    const service = makeService(repo, { autoBranchMode: 'session-start' })

    await feed(service, session('sess-ontask', repo), startEvent(1))

    // world 重读：仍在原任务分支，未新建（非受保护分支跳过——零动作零登记）。
    expect(headBranch(repo)).toBe('dsh/task-xyz')
    expect(branchExists(repo, 'dsh/task-sess-ont')).toBe(false)
    expect(service.automationOf().status().lastActions).toEqual([])
  })

  it('非受保护分支 ⇒ 跳过（feature/* 不建任务分支，零动作零登记）', async () => {
    const repo = await seededRepo('dshgit-auto-br-feat-')
    git(repo, 'switch', '-qc', 'feature/x')
    const service = makeService(repo, { autoBranchMode: 'session-start' })

    await feed(service, session('sess-feat', repo), startEvent(1))

    expect(headBranch(repo)).toBe('feature/x')
    expect(branchExists(repo, 'dsh/task-sess-fea')).toBe(false)
    expect(service.automationOf().status().lastActions).toEqual([])
  })

  it('命名冲突 ⇒ 序号后缀递增（branch-exists ⇒ -2 —— refs-admin 预检消费）', async () => {
    const repo = await seededRepo('dshgit-auto-br-clash-')
    const service = makeService(repo, { autoBranchMode: 'session-start' })
    // 遗留同名分支（上一宿主周期同 token 会话建过、当前回到 main——碰撞的真实路径）。
    git(repo, 'branch', 'dsh/task-worker-c')
    const who = session('worker-cafe02', repo)
    expect(shortBranchToken('worker-cafe02')).toBe('worker-c')

    await feed(service, who, startEvent(1))

    // world 重读：base 名被预检拒绝 ⇒ -2 后缀建切成功；两分支并存。
    expect(headBranch(repo)).toBe('dsh/task-worker-c-2')
    expect(branchExists(repo, 'dsh/task-worker-c')).toBe(true)
    expect(branchExists(repo, 'dsh/task-worker-c-2')).toBe(true)
    const action = lastAction(service)
    expect(action?.ok).toBe(true)
    expect(action?.detail).toContain('created dsh/task-worker-c-2')
  })
})

// ---------- 竞态（§7.6：turn/end 与手工 commit 先后 ⇒ 无重复提交） ----------

describe('auto-commit 竞态', () => {
  it('手工 commit 先落、turn/end 后到 ⇒ fresh status 判空零动作（无重复提交）', async () => {
    const repo = await seededRepo('dshgit-auto-race-')
    const service = makeService(repo, { autoCommitMode: 'turn-end' })
    await writeFile(join(repo, 'race.txt'), 'race\n', 'utf8')
    // 用户手工路径先落（world 写）。
    git(repo, 'add', 'race.txt')
    git(repo, 'commit', '-qm', 'feat: manual race commit')
    const manualOid = headOid(repo)
    const manualCount = commitCount(repo)

    await feed(service, session('sess-race', repo), endEvent(9))

    // world 重读：HEAD 仍是手工提交，零自动化提交，零动作登记（clean 判空即退）。
    expect(commitCount(repo)).toBe(manualCount)
    expect(headOid(repo)).toBe(manualOid)
    expect(headMessage(repo)).toContain('feat: manual race commit')
    expect(service.automationOf().status().lastActions).toEqual([])
  })
})

// ---------- 纯函数与 wire 面 ----------

describe('shortBranchToken — 会话 id → 分支安全短 token', () => {
  it('常规 id 截 8 字符；非法字符折叠；git 禁区（前导 -/.、尾 .、.lock）剥除；空 = session', () => {
    expect(shortBranchToken('worker-a1b2c3d4')).toBe('worker-a')
    expect(shortBranchToken('ab')).toBe('ab')
    expect(shortBranchToken('a b:c*d')).toBe('a-b-c-d')
    expect(shortBranchToken('-lead.ing.')).toBe('lead.ing')
    expect(shortBranchToken('x.lock')).toBe('x')
    expect(shortBranchToken('..--')).toBe('session')
  })
})

describe('automationStatus @Remote — 观测面与 Config 投影', () => {
  it('off 档默认：双 mode = off、lastActions 空环；REMOTE_METHODS 含 automationStatus（56）', async () => {
    const repo = await seededRepo('dshgit-auto-status-')
    const service = makeService(repo)
    const status = await service.automationStatus()
    expect(status.autoCommitMode).toBe('off')
    expect(status.autoBranchMode).toBe('off')
    expect(status.lastActions).toEqual([])
    expect(REMOTE_METHODS).toContain('automationStatus')
    expect(REMOTE_METHODS).toHaveLength(56)
  })

  it('Config 投影：开启档位经构造 plumb-through；环 newest-first 且 20 条封顶', { timeout: 180_000 }, async () => {
    const repo = await seededRepo('dshgit-auto-status2-')
    const service = makeService(repo, {
      autoCommitMode: 'turn-end',
      autoCommitMessage: 'template',
      autoCommitTemplate: 'chore: auto (turn {turn})',
      autoBranchMode: 'session-start',
      autoBranchPrefix: 'dsh/task-',
      autoBranchProtected: ['main', 'master'],
    })
    // 连发 21 个 completed turn（各自落地一笔提交——环 20 条封顶 + newest-first 断言）。
    for (let turn = 1; turn <= 21; turn += 1) {
      await writeFile(join(repo, `f${String(turn)}.txt`), `${String(turn)}\n`, 'utf8')
      await feed(service, session('sess-burst', repo), endEvent(turn))
    }
    expect(commitCount(repo)).toBe(22) // seed + 21 笔自动提交
    const status = await service.automationStatus()
    expect(status.autoCommitMode).toBe('turn-end')
    expect(status.autoBranchMode).toBe('session-start')
    expect(status.lastActions).toHaveLength(20)
    expect(status.lastActions.every((entry) => entry.ok && entry.action === 'auto-commit')).toBe(true)
    // newest-first：首条 = turn 21，末条 = turn 2。
    expect(status.lastActions[0]?.detail).toContain('(turn 21)')
    expect(status.lastActions[19]?.detail).toContain('(turn 2)')
  })
})
