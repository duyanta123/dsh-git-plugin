/**
 * M1 — git-runner 集成测试（spec §⑥ git-runner.spec 行：runner 契约 §1.0.7 逐条）。
 *
 * 覆盖：只读/写两套前缀（§1.2.3 任务口径）、超时→git/timeout（Windows taskkill 杀树路径，
 * 用真 pre-commit hook sleep 60s 制造确定性挂起）、调用方 abort、stdout 上限→truncated
 * 且保尾部、exitCode 白名单（assertGitOk）、env 墓碑生效（ambient GIT_DIR 不影响结果、
 * 固定项入子进程 env）、resolveExecutable 命中与 null → git/git-error op='resolve-git'、
 * 中文路径 round-trip。
 *
 * 断言纪律（spec §⑥）：验证世界而非自述——写操作后用独立 execFileSync git 重读。
 * SubprocessFace 替身 = 真实子进程（support.ts localSubprocess），record 参数记录每次
 * spawn 的 argv/cwd/env 供前缀与 env 断言。
 */

import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertGitOk } from '../src/error-codes.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, GitRunner, READONLY_PREFIX, WRITE_PREFIX, createGitRunners } from '../src/git-runner.ts'
import type { SubprocessFace } from '../src/git-runner.ts'
import { localSubprocess, scratchRepo, type SpawnRecord } from './support.ts'

// 并行负载下的资源裕量（真实 git 子进程 + taskkill 树路径；diff.spec.ts 同款先例，
// 断言面零改动）。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function neverAborted(): AbortSignal {
  return new AbortController().signal
}

/** 记录型真实替身：spawn facts 追加到传入数组。 */
function recordingSubprocess(record: SpawnRecord[]): SubprocessFace {
  return localSubprocess(record)
}

function makeRunners(record?: SpawnRecord[]) {
  return createGitRunners(record === undefined ? localSubprocess() : recordingSubprocess(record), {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 60_000, networkTimeoutMs: 60_000,
    outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
  })
}

/**
 * 真挂起 pre-commit hook：busy loop 单进程（sh 自旋）。
 * 实测注记（2026-10-31）：`sleep 60` 形态的 hook 在 taskkill /T /F 杀树后仍有存活后代
 * 持有 stdout 管道，libuv 的 close 事件要等它自然退出（60s）才触发——单进程自旋无此问题，
 * 且同样是「hook 真执行 + 树被强杀」的真实路径。
 */
async function installHangingPreCommit(repo: string): Promise<void> {
  // LF 行尾必须显式（CRLF 会破坏 sh 解释）。
  await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nwhile :; do :; done\n', 'utf8')
}

describe('四实例前缀（spec §1.0.7 / 任务口径 §1.2.3）', () => {
  it('只读实例：safe.bareRepository + --no-optional-locks + hooksPath=/dev/null + fsmonitor=false 依序出现在 subcommand 前', async () => {
    const repo = await scratchRepo('dshgit-run-ro-', cleanups, { name: 't', email: 't@e.com' })
    const record: SpawnRecord[] = []
    const result = await makeRunners(record).readonly.run(['status', '--porcelain=v2', '-z'], {
      cwd: repo, op: 'status', signal: neverAborted(),
    })
    expect(result.exitCode).toBe(0)
    expect(record).toHaveLength(1)
    expect([...record[0]!.argv]).toEqual([
      'git',
      '-c', 'safe.bareRepository=explicit',
      '--no-optional-locks',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      'status', '--porcelain=v2', '-z',
    ])
  })

  it('写/提交/网络实例：只有 safe.bareRepository，不含 hooksPath/fsmonitor/--no-optional-locks（保留用户 hook）', async () => {
    const repo = await scratchRepo('dshgit-run-wr-', cleanups, { name: 't', email: 't@e.com' })
    const record: SpawnRecord[] = []
    const runners = makeRunners(record)
    for (const instance of ['write', 'commit', 'network'] as const) {
      await runners[instance].run(['config', '--get', 'user.name'], {
        cwd: repo, op: `probe(${instance})`, signal: neverAborted(),
      })
    }
    expect(record).toHaveLength(3)
    for (const spawn of record) {
      expect([...spawn.argv]).toEqual(['git', '-c', 'safe.bareRepository=explicit', 'config', '--get', 'user.name'])
    }
  })

  it('常量面：READONLY_PREFIX 含四项加固，WRITE_PREFIX 不含（防倒退守卫）', () => {
    expect(READONLY_PREFIX).toContain('--no-optional-locks')
    expect(READONLY_PREFIX).toContain('core.hooksPath=/dev/null')
    expect(READONLY_PREFIX).toContain('core.fsmonitor=false')
    expect(READONLY_PREFIX).toContain('safe.bareRepository=explicit')
    expect(WRITE_PREFIX).toEqual(['-c', 'safe.bareRepository=explicit'])
    expect(WRITE_PREFIX).not.toContain('--no-optional-locks')
  })
})

describe('超时与终止（spec §⑥：超时→kill 树，Windows taskkill 路径）', () => {
  it('commit 实例遇 pre-commit hook 挂起：git/timeout {op, timeoutMs}，hook 真被执行（hook 禁用则不会超时）', async () => {
    const repo = await scratchRepo('dshgit-run-to-', cleanups, { name: 't', email: 't@e.com' })
    await installHangingPreCommit(repo)
    const runners = createGitRunners(localSubprocess(), {
      gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 1_500, networkTimeoutMs: 60_000,
      outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    })
    const startedAt = Date.now()
    const error = await runners.commit.run(['commit', '--allow-empty', '-m', 'x'], {
      cwd: repo, op: 'commit', signal: neverAborted(),
    }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/timeout')
    expect(remote?.details).toMatchObject({ op: 'commit', timeoutMs: 1_500 })
    // 1.5s 超时 + 2s grace：若 hook 未被杀会等到 sleep 60s 结束。
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  }, 60_000)

  it('只读实例同仓库同 hook：hooksPath=/dev/null 生效，commit 不执行 hook（快速返回）', async () => {
    const repo = await scratchRepo('dshgit-run-roh-', cleanups, { name: 't', email: 't@e.com' })
    await installHangingPreCommit(repo)
    const runner = new GitRunner(localSubprocess(), 'git', {
      timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    }, READONLY_PREFIX)
    const startedAt = Date.now()
    const result = await runner.run(['commit', '--allow-empty', '-m', 'x'], {
      cwd: repo, op: 'commit(readonly probe)', signal: neverAborted(),
    })
    // hook 被 /dev/null 禁用：commit 立即完成（挂起 60s 才是失败信号）。
    expect(result.exitCode).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  }, 30_000)

  it('调用方 abort：抛普通 Error（gateway 侧折叠为取消，非域码）', async () => {
    const repo = await scratchRepo('dshgit-run-ab-', cleanups, { name: 't', email: 't@e.com' })
    await installHangingPreCommit(repo)
    const runners = makeRunners()
    const controller = new AbortController()
    const pending = runners.commit.run(['commit', '--allow-empty', '-m', 'x'], {
      cwd: repo, op: 'commit', signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const error = await pending.then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('aborted')
    expect(remoteErrorOf(error)).toBeUndefined()
  }, 30_000)
})

describe('stdout 上限与白名单（spec §1.0.7 / §1.2）', () => {
  it('溢出 → truncated:true 且保尾部（尾部标记完整、头部丢失）', async () => {
    const repo = await scratchRepo('dshgit-cap-', cleanups, { name: 't', email: 't@e.com' })
    const body = `${'x'.repeat(300 * 1024)}TAIL-MARKER\n`
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo, input: body,
    }).toString('utf8').trim()
    const runner = new GitRunner(localSubprocess(), 'git', {
      timeoutMs: 15_000, outputMaxBytes: 64 * 1024,
    }, READONLY_PREFIX)
    const result = await runner.run(['cat-file', 'blob', blob], {
      cwd: repo, op: 'probe(cat-file)', maxBytes: 64 * 1024, signal: neverAborted(),
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024)
    expect(result.stdout.endsWith('TAIL-MARKER\n')).toBe(true)
  })

  it('assertGitOk 白名单：exit 1 在 [0,1] 内放行；默认白名单/越界 exit → git/git-error（details 全形状）', async () => {
    const repo = await scratchRepo('dshgit-wl-', cleanups, { name: 't', email: 't@e.com' })
    await writeFile(join(repo, 'f.txt'), 'one\n', 'utf8')
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'add', 'f.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'c1'], { cwd: repo })
    await writeFile(join(repo, 'f.txt'), 'one-changed\n', 'utf8')
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'add', 'f.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'c2'], { cwd: repo })
    const runner = new GitRunner(localSubprocess(), 'git', {
      timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    }, READONLY_PREFIX)
    // exit 1（有差异）在白名单内 → 原样放行。
    const diff = await runner.run(['diff', '--quiet', 'HEAD~1', 'HEAD'], {
      cwd: repo, op: 'probe(diff)', signal: neverAborted(),
    })
    expect(diff.exitCode).toBe(1)
    expect(assertGitOk(diff, 'probe(diff)', [0, 1]).exitCode).toBe(1)
    // 默认白名单 [0]：exit 1 → git/git-error。
    try {
      assertGitOk(diff, 'probe(diff-strict)')
      expect.unreachable()
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('git/git-error')
    }
    // 越界白名单：exit 128（坏 oid）不在 [0,1] → git/git-error，stderr 进 details。
    const bad = await runner.run(['cat-file', '-t', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], {
      cwd: repo, op: 'probe(cat-file)', signal: neverAborted(),
    })
    expect(bad.exitCode).toBe(128)
    try {
      assertGitOk(bad, 'probe(cat-file)', [0, 1])
      expect.unreachable()
    } catch (error) {
      const remote = remoteErrorOf(error)
      expect(remote?.code).toBe('git/git-error')
      expect(remote?.details).toMatchObject({ op: 'probe(cat-file)', exitCode: 128, truncated: false })
      expect((remote?.details as { stderr: string }).stderr).toContain('could not get object info')
    }
  })
})

describe('env 墓碑与固定项（spec §⑥：ambient GIT_DIR 不影响结果）', () => {
  it('ambient GIT_DIR 指向另一仓库：被墓碑删除，status 如实反映 cwd 仓库；固定 env 进入 spawn spec', async () => {
    const repoA = await scratchRepo('dshgit-env-a-', cleanups, { name: 't', email: 't@e.com' })
    const repoB = await scratchRepo('dshgit-env-b-', cleanups, { name: 't', email: 't@e.com' })
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'b1'], { cwd: repoB })
    await writeFile(join(repoA, 'a.txt'), 'tracked\n', 'utf8')
    execFileSync('git', ['add', 'a.txt'], { cwd: repoA })
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'a1'], { cwd: repoA })
    await writeFile(join(repoA, 'a.txt'), 'modified\n', 'utf8')

    const record: SpawnRecord[] = []
    const runner = new GitRunner(recordingSubprocess(record), 'git', {
      timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    }, READONLY_PREFIX)
    const previousGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = join(repoB, '.git')
    try {
      const result = await runner.run(['status', '--porcelain=v2', '--untracked-files=all', '-z'], {
        cwd: repoA, op: 'status', signal: neverAborted(),
      })
      expect(result.exitCode).toBe(0)
      // world 断言：状态是 A 的（a.txt 被修改），不是 B 的（B 无 a.txt）。
      expect(result.stdout).toContain('.M')
      expect(result.stdout).toContain('a.txt')
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }
    // spawn spec 的 env：墓碑显式存在 + 固定项齐全。
    const passed = record[0]!.env as Record<string, string | undefined>
    expect(passed.GIT_DIR).toBeUndefined()
    expect(passed.GIT_TERMINAL_PROMPT).toBe('0')
    expect(passed.GIT_CONFIG_COUNT).toBe('0')
    expect(passed.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(passed.GIT_NO_LAZY_FETCH).toBe('1')
    expect(passed.GIT_LITERAL_PATHSPECS).toBe('1')
    expect(passed.LC_ALL).toBe('C')
  })
})

describe('git 发现（spec §1.0.7 resolveExecutable）', () => {
  it('resolveExecutable 返回 null → git/git-error，details.op = "resolve-git"', async () => {
    const repo = await scratchRepo('dshgit-rg-null-', cleanups, { name: 't', email: 't@e.com' })
    const failing: SubprocessFace = {
      resolveExecutable: async () => null,
      spawn: () => { throw new Error('should not spawn') },
    }
    const runner = new GitRunner(failing, 'git', {
      timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    }, READONLY_PREFIX)
    const error = await runner.run(['status'], { cwd: repo, op: 'status', signal: neverAborted() }).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(error)
    expect(remote?.code).toBe('git/git-error')
    expect(remote?.details).toMatchObject({ op: 'resolve-git' })
  })

  it('resolveExecutable 抛错 → 同映射（cause message 进 details.stderr）', async () => {
    const repo = await scratchRepo('dshgit-rg-throw-', cleanups, { name: 't', email: 't@e.com' })
    const failing: SubprocessFace = {
      resolveExecutable: async () => { throw new Error('PATH has no git') },
      spawn: () => { throw new Error('should not spawn') },
    }
    const runner = new GitRunner(failing, 'git', {
      timeoutMs: 15_000, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES,
    }, READONLY_PREFIX)
    await expect(runner.run(['status'], { cwd: repo, op: 'status', signal: neverAborted() }))
      .rejects.toMatchObject({ code: 'git/git-error', details: { op: 'resolve-git' } })
  })

  it('resolveExecutable 命中（真 PATH）：解析后 spawn 正常进行', async () => {
    const repo = await scratchRepo('dshgit-rg-hit-', cleanups, { name: 't', email: 't@e.com' })
    const record: SpawnRecord[] = []
    await makeRunners(record).readonly.run(['--version'], {
      cwd: repo, op: 'ping(--version)', signal: neverAborted(),
    })
    expect(record).toHaveLength(1) // spawn 一次即证明 resolveExecutable 命中（失败会抛 resolve-git）
  })
})

describe('中文路径 round-trip（spec §⑥：-z 原样字节路径）', () => {
  it('写实例 add + 只读实例 status：中文与空格路径全程保真，world 重读一致', async () => {
    const repo = await scratchRepo('dshgit-cjk-', cleanups, { name: 't', email: 't@e.com' })
    const fileName = '中文 路径 文件.txt'
    await writeFile(join(repo, fileName), '内容\n', 'utf8')
    const runners = makeRunners()
    const added = await runners.write.run(['add', '--', fileName], {
      cwd: repo, op: 'probe(add)', signal: neverAborted(),
    })
    expect(added.exitCode).toBe(0)
    // world 重读（独立 git 进程，-z 原样字节）。
    const lsFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString('utf8')
    expect(lsFiles.split('\0')).toContain(fileName)
    const staged = await runners.readonly.run(['status', '--porcelain=v2', '--untracked-files=all', '-z'], {
      cwd: repo, op: 'status', signal: neverAborted(),
    })
    expect(staged.exitCode).toBe(0)
    expect(staged.stdout).toContain('1 A. N...')
    expect(staged.stdout).toContain(fileName)
  })
})
