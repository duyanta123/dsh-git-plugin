/**
 * git.commit 集成测试（spec §6 commit 行 + M5 任务口径；范式照 support.ts：真实临时
 * git 仓库，断言纪律 = 验证世界而非自述——每个写场景后用独立 execFileSync
 * `git log`/`git cat-file` 重读外部状态）。
 *
 * 覆盖：正常提交（多行中文消息经 `-F -` stdin 往返 + world 重读 %B）；amend 改 oid
 * 保留 tree [清单 19] 与 --no-edit 两路；空 staged 拒绝 [清单 11]（born 与 unborn 双态，
 * 本机实测 unborn 的 `diff --cached --quiet` 对空树隐式比较）；空 message；identity
 * 缺失 → git/identity-missing [清单 55]（GIT_CONFIG_GLOBAL 指向不存在文件隔离本机
 * 全局身份——实测缺失的全局配置文件被 git 静默忽略）；pre-commit hook 失败 stderr
 * 进 details、`skipHooks` 绕过 [清单 20]；commit-msg hook 改写消息 → 回读权威；
 * 超时熔断 → git/timeout { op:'commit' }；首提交 [清单 64]。
 */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { localSubprocess, git, scratchDir, scratchRepo } from './support.ts'

// 并行负载下的资源裕量（真实 git 子进程 + hook 进程；diff.spec.ts 同款先例）。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
const envCleanups: Array<() => Promise<unknown>> = []
let realGlobalConfig: string | undefined
let realNosystem: string | undefined

beforeAll(async () => {
  // 身份隔离（M5 任务口径）：GIT_CONFIG_GLOBAL 指向**不存在**的文件——本机实测 git
  // 对缺失的全局配置静默忽略（不报错、不提供键），本机 ~/.gitconfig 的 user.* 与
  // 仓库 local 的 user.* 从此互不干扰；GIT_CONFIG_NOSYSTEM=1 隔离系统级配置。
  realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  realNosystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = join(await scratchDir('dshgit-commit-isolation-', cleanups), 'does-not-exist')
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

afterEach(async () => {
  // 每用例夹具走 cleanups（afterAll 统一逆序清理）；此处仅为接口对齐 identity.spec。
})

interface Harness {
  service: InstanceType<typeof GitService>
}

function makeService(
  workspaceOverride: string,
  overrides: { commitTimeoutMs?: number } = {},
): Harness {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    commitTimeoutMs: overrides.commitTimeoutMs ?? 15_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
  })
  return { service }
}

/**
 * 独立 git 进程读世界：`git log -1 --format=%B` 的原样 message。
 * 本机实测（git 2.55.0.windows.2）：输出 = 存储 message（恒以单个 \n 结尾）+ 渲染终结
 * \n ⇒ 断言形如 `toBe(stored + '\n')`。
 */
function headMessage(repo: string): string {
  return execFileSync('git', ['log', '-1', '--format=%B'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 独立 git 进程读世界：HEAD 全 oid。 */
function headOid(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 独立 git 进程读世界：HEAD 指向的 tree oid（amend 保留断言用）。 */
function headTreeOid(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 提交计数（world 重读：hook 失败/守卫拒绝后不得新增提交；--all 兼容 unborn=0）。 */
function commitCount(repo: string): number {
  const out = execFileSync('git', ['rev-list', '--count', '--all'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return Number(out.trim())
}

/** 写一个可执行的 repo hook（node 写文件 + node chmod；不用外部 chmod 可执行文件）。 */
async function writeHook(repo: string, name: string, body: string): Promise<void> {
  const hook = join(repo, '.git', 'hooks', name)
  await mkdir(join(hook, '..'), { recursive: true })
  // LF only：hook 由 sh 逐行解释；CRLF 会进参数（Windows 亦然）。
  await writeFile(hook, `#!/bin/sh\n${body}\n`, 'utf8')
  // 只用 node:fs/promises 的 chmod（POSIX 真置位；Windows 上近 no-op）——**不调外部
  // `chmod`**：门禁 worker 的 PATH 不含 Git usr/bin（spawnSync chmod ENOENT 实测），
  // 而 git-for-windows 对 hook 文件默认按可执行执行（本机无 chmod 探针 + 
  // git-runner.spec.ts:58 同款裸 writeFile hook 两处实证）。
  await chmod(hook, 0o755)
}

/** 暂存一个文件再走服务提交的便捷路径。 */
async function stageViaService(harness: Harness, repo: string, rel: string, content: string): Promise<void> {
  await writeFile(join(repo, rel), content, 'utf8')
  await harness.service.stage([rel])
}

describe('git.commit — 正常路径（spec §1.4）', () => {
  it('多行中文消息经 stdin 往返：result.message 与 world 重读 %B 一致；branch/shortOid 正确', async () => {
    const repo = await scratchRepo('dshgit-commit-ok-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await stageViaService(harness, repo, 'a.txt', '内容一\n')
    const message = 'feat(scope): 支持中文提交主题\n\n正文第一行：多行体。\n正文第二行：含特殊字符 "quotes" 与 $dollar。\n'
    const result = await harness.service.commit({ message, amend: false, skipHooks: false })
    expect(result.amended).toBe(false)
    expect(result.branch).toBe('main')
    expect(result.shortOid).toBe(result.oid.slice(0, 7))
    expect(result.message).toBe(message.replace(/\r?\n$/, ''))
    // world 重读：独立 git 进程的 %B 与回读一致（stdin 往返无转义/换行损耗）。
    expect(headMessage(repo)).toBe(`${message}\n`)
    expect(headOid(repo)).toBe(result.oid)
  })

  it('首提交 [清单 64]：unborn 仓库 + staged 文件 → 成功，branch=main', async () => {
    const repo = await scratchRepo('dshgit-commit-first-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await stageViaService(harness, repo, 'first.txt', 'initial\n')
    const result = await harness.service.commit({ message: 'feat: 首提交\n', amend: false, skipHooks: false })
    expect(result.branch).toBe('main')
    // world 重读：仓库恰有一个提交（根提交）。
    expect(commitCount(repo)).toBe(1)
    expect(headMessage(repo)).toBe('feat: 首提交\n\n')
  })

  it('Conventional 格式警示为非阻断：不合格式消息照常成功', async () => {
    const repo = await scratchRepo('dshgit-commit-conv-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await stageViaService(harness, repo, 'a.txt', 'x\n')
    const result = await harness.service.commit({ message: '随手写的消息（非 conventional）\n', amend: false, skipHooks: false })
    expect(result.oid).toBe(headOid(repo)) // world 重读：提交真实存在
  })
})

describe('git.commit — 守卫链（spec §1.4 顺序：身份 → 空提交保护 → 消息校验）', () => {
  it('identity 缺失 [清单 55]：GIT_CONFIG_GLOBAL 隔离后无 local/全局身份 → git/identity-missing', async () => {
    const repo = await scratchRepo('dshgit-commit-idless-', cleanups) // 无本地身份
    const harness = makeService(repo)
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8')
    const error = await harness.service.commit({ message: 'feat: x\n', amend: false, skipHooks: false }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/identity-missing')
    expect((remote?.details as { missing: string[] }).missing).toEqual(['user.name', 'user.email'])
    // world 重读：守卫拒绝后仓库仍 unborn（零提交）。
    const count = execFileSync('git', ['rev-list', '--count', '--all'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(count.trim()).toBe('0')
  })

  it('空提交保护 [清单 11]：born 仓库无 staged → git/nothing-staged（details.branch），零副作用', async () => {
    const repo = await scratchRepo('dshgit-commit-empty-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    const before = commitCount(repo)
    const error = await harness.service.commit({ message: 'feat: nothing\n', amend: false, skipHooks: false }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/nothing-staged')
    expect((remote?.details as { branch: string | null }).branch).toBe('main')
    expect(commitCount(repo)).toBe(before) // world 重读：无新提交
  })

  it('空提交保护：unborn 且 index 为空 → 同样 git/nothing-staged（unborn 对空树隐式比较，本机实测）', async () => {
    const repo = await scratchRepo('dshgit-commit-unborn-empty-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await expect(harness.service.commit({ message: 'feat: x\n', amend: false, skipHooks: false }))
      .rejects.toMatchObject({ code: 'git/nothing-staged' })
  })

  it('空 message → git/empty-message；全空白同；且先于空提交保护之后的消息守卫位（零副作用）', async () => {
    const repo = await scratchRepo('dshgit-commit-msg-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    await writeFile(join(repo, 'a.txt'), 'two\n', 'utf8')
    git(repo, 'add', 'a.txt') // staged 非空：越守卫 2，落守卫 3
    await expect(harness.service.commit({ message: '', amend: false, skipHooks: false }))
      .rejects.toMatchObject({ code: 'git/empty-message' })
    await expect(harness.service.commit({ message: '   \n\t  \n', amend: false, skipHooks: false }))
      .rejects.toMatchObject({ code: 'git/empty-message' })
    // world 重读：staged 仍在（未消费），无新提交。
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('a.txt')
  })
})

describe('git.commit — amend 两路 [清单 19]（spec §1.4）', () => {
  it('amend 改消息：oid 变、tree 保留、amended=true、回读 = 新消息（world 重读 %B/%T）', async () => {
    const repo = await scratchRepo('dshgit-commit-amend-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'original')
    const originalOid = headOid(repo)
    const originalTree = headTreeOid(repo)
    const result = await harness.service.commit({ message: 'feat: rewritten subject\n', amend: true, skipHooks: false })
    expect(result.amended).toBe(true)
    expect(result.oid).not.toBe(originalOid)
    expect(headTreeOid(repo)).toBe(originalTree) // world 重读：tree 未变（仅 message 改写）
    expect(headMessage(repo)).toBe('feat: rewritten subject\n\n')
    expect(result.message).toBe('feat: rewritten subject')
    expect(commitCount(repo)).toBe(1)
  })

  it('amend --no-edit（message 全空白）：保留原消息（回读与 world 重读一致），允许空 staged', async () => {
    const repo = await scratchRepo('dshgit-commit-noedit-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'original subject\n\noriginal body\n')
    const result = await harness.service.commit({ message: '   \n', amend: true, skipHooks: false })
    expect(result.amended).toBe(true)
    // 不断言 oid 变化（M6 模块修正的既有 flake，HEAD 上 stash 后 3/3 复现）：
    // --no-edit 未改任何内容时，同一秒内的 amend 产出**同一提交对象**（tree/parents/
    // author/committer 时间戳全部不变，git 按内容寻址去重）——oid 是否变化不是本
    // 用例的语义面。消息保留由回读与 world 重读 %B 断言；oid 变化路径由上一用例
    // （amend 改消息）覆盖。
    expect(result.message).toBe('original subject\n\noriginal body')
    expect(headMessage(repo)).toBe('original subject\n\noriginal body\n\n')
  })
})

describe('git.commit — hook 面 [清单 20]（失败分类 / 绕过 / 改写回读 / 超时熔断）', () => {
  it('pre-commit hook 失败 → git/hook-failed：hook 输出进 details.stderr，零副作用', async () => {
    const repo = await scratchRepo('dshgit-commit-hook-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeHook(repo, 'pre-commit', 'echo "pre-commit hook rejects this change" >&2\nexit 1\n')
    await stageViaService(harness, repo, 'a.txt', 'one\n')
    const before = commitCount(repo)
    const error = await harness.service.commit({ message: 'feat: hooked\n', amend: false, skipHooks: false }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/hook-failed')
    const details = remote?.details as { op: string; exitCode: number | null; stderr: string; truncated: boolean }
    expect(details.op).toBe('commit')
    expect(details.exitCode).toBe(1)
    expect(details.stderr).toContain('pre-commit hook rejects this change') // 失败 hook 输出捕获
    expect(details.truncated).toBe(false)
    expect(commitCount(repo)).toBe(before) // world 重读：无新提交
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('a.txt') // staged 未被消费
  })

  it('skipHooks=true → --no-verify 绕过同一 hook：提交成功（world 重读）', async () => {
    const repo = await scratchRepo('dshgit-commit-skip-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeHook(repo, 'pre-commit', 'exit 1\n')
    await stageViaService(harness, repo, 'a.txt', 'one\n')
    const result = await harness.service.commit({ message: 'chore: skip hooks\n', amend: false, skipHooks: true })
    expect(result.branch).toBe('main')
    expect(headMessage(repo)).toBe('chore: skip hooks\n\n')
  })

  it('commit-msg hook 改写消息 → 回读最终 message 为 hook 改写后的权威值（world 重读一致）', async () => {
    const repo = await scratchRepo('dshgit-commit-msg-hook-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    await writeHook(repo, 'commit-msg', 'printf "[hook-signed]\\n" >> "$1"\nexit 0\n')
    await stageViaService(harness, repo, 'a.txt', 'one\n')
    const result = await harness.service.commit({ message: 'feat: signed\n', amend: false, skipHooks: false })
    expect(result.message).toBe('feat: signed\n[hook-signed]')
    expect(headMessage(repo)).toBe('feat: signed\n[hook-signed]\n\n')
  })

  it('超时熔断：hook 挂起超过 commitTimeoutMs → git/timeout { op: "commit" }，零副作用', async () => {
    const repo = await scratchRepo('dshgit-commit-slow-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo, { commitTimeoutMs: 1_000 })
    // busy loop（sh 自旋、零外部命令）——不依赖 sleep（usr/bin），门禁 worker PATH 无
    // Git usr/bin 也成立；git-runner.spec.ts:51-58 同款范式（taskkill /T /F 杀树）。
    await writeHook(repo, 'pre-commit', 'while :; do :; done\n')
    await stageViaService(harness, repo, 'a.txt', 'one\n')
    const before = commitCount(repo)
    const error = await harness.service.commit({ message: 'feat: slow\n', amend: false, skipHooks: false }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/timeout')
    expect((remote?.details as { op: string; timeoutMs: number }).op).toBe('commit')
    expect((remote?.details as { timeoutMs: number }).timeoutMs).toBe(1_000)
    expect(commitCount(repo)).toBe(before) // world 重读：无新提交
  }, 20_000)
})
