/**
 * v2 批次四 — initRepository 测试（[清单 8]；docs/v2-implementation-plan.md §6.7
 * host 真仓库范式行）。
 *
 * 覆盖：空目录 init 成功（world 重读 HEAD 符号引用 / rev-parse）；**已仓库拒绝
 * ⇒ git/init-failed reason='already-a-repository'（零命令，world 不变）**；仓库内
 * 子目录拒绝（位于仓库之内）；非空非仓库目录 init 成功（[8] 真实用例 = 已打开的
 * 项目目录，预置文件保留）；**watcher 重探测**（§6.10 风险项测试落点）：init 前
 * 仓库不存在（status 错误帧态——not-repository 稳定事实进 TTL 缓存；followStatus
 * 订阅即 error 帧）→ init 后 status() 就绪（缓存失效链）+ 流内转 status 帧；
 * workspace 解析不出 ⇒ session-workspace-unresolved。
 *
 * 断言纪律：验证世界而非自述——init 后用独立 execFileSync git 重读仓库状态。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest'
import { AdminRepoEngine } from '../src/admin-repo.ts'
import { GitService } from '../src/index.ts'
import { createGitRunners } from '../src/git-runner.ts'
import type { SubprocessFace } from '../src/git-runner.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import type { GitStatusFrame } from '../src/types.ts'
import { git, localSubprocess, scratchDir, scratchRepo } from './support.ts'

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

/** Windows %TEMP% 8.3 短名/大小写规范化（support.ts scratchDir 同款纪律——git 输出同形）。 */
function nativeDir(dir: string): string {
  return realpathSync.native(dir)
}

function norm(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase()
}

function worldIsInsideWorkTree(dir: string): boolean {
  return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim() === 'true'
}

function worldHeadBranch(dir: string): string {
  return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function worldHead(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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

describe('initRepository — [清单 8] 非 git 目录引导（§6.7）', () => {
  it('空目录 init 成功：InitResult 回读 + world 重读（is-inside-work-tree / HEAD 符号引用）', async () => {
    const dir = await scratchDir('dshgit-admin-empty-', cleanups)
    const service = makeService(dir)
    const result = await service.initRepository()
    expect(result.branch).toBe(worldHeadBranch(dir))
    expect(result.branch).not.toBe('')
    expect(worldIsInsideWorkTree(dir)).toBe(true)
    expect(norm(result.repoRoot)).toBe(norm(dir))
    // init 后 status 引擎缓存失效链：直接可读 ready 快照（无 TTL 等待）。
    const snapshot = await service.status()
    expect(snapshot.branch.unborn).toBe(true)
    expect(norm(snapshot.repoRoot)).toBe(norm(dir))
  })

  it('已仓库拒绝 ⇒ git/init-failed reason=already-a-repository（零命令——world 重读仓库原样）', async () => {
    const repo = await scratchRepo('dshgit-admin-existing-', cleanups)
    git(repo, 'commit', '--allow-empty', '-qm', 'seed')
    const headBefore = worldHead(repo)
    const service = makeService(repo)
    const rejection = await rejectionOf(() => service.initRepository())
    expect(rejection.code).toBe('git/init-failed')
    expect(rejection.details.path).toBe(repo)
    expect(rejection.details.reason).toBe('already-a-repository')
    // world 重读：仓库未被改动（HEAD 不变、分支原样）。
    expect(worldHead(repo)).toBe(headBefore)
    expect(worldHeadBranch(repo)).toBe('main')
  })

  it('仓库内子目录拒绝（位于仓库之内 ⇒ already-a-repository）', async () => {
    const repo = await scratchRepo('dshgit-admin-nested-', cleanups)
    git(repo, 'commit', '--allow-empty', '-qm', 'seed')
    const sub = join(repo, 'nested')
    mkdirSync(sub, { recursive: true })
    const service = makeService(sub)
    const rejection = await rejectionOf(() => service.initRepository())
    expect(rejection.code).toBe('git/init-failed')
    expect(rejection.details.reason).toBe('already-a-repository')
    expect(worldHeadBranch(repo)).toBe('main')
  })

  it('非空非仓库目录 init 成功（[8] 真实用例 = 已打开的项目目录；预置文件保留）', async () => {
    const raw = mkdtempSync(join(tmpdir(), 'dshgit-admin-nonempty-'))
    cleanups.push(async () => rmSync(raw, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
    const dir = nativeDir(raw)
    writeFileSync(join(dir, 'README.md'), 'project files before init\n', 'utf8')
    const service = makeService(dir)
    const result = await service.initRepository()
    expect(result.branch).toBe(worldHeadBranch(dir))
    expect(worldIsInsideWorkTree(dir)).toBe(true)
    // 预置文件原样保留（init 不清理工作区）。
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('project files before init\n')
  })

  it('watcher 重探测（§6.10 风险项测试落点）：init 前 error 帧态 → init 后 R3 帧 + status RPC 就绪', async () => {
    const dir = await scratchDir('dshgit-admin-reprobe-', cleanups)
    const service = makeService(dir)
    // init 前：not-repository 稳定事实（status RPC 抛 no-repository 且进 TTL 缓存）。
    const before = await rejectionOf(() => service.status())
    expect(before.code).toBe('git/no-repository')
    // followStatus 流帧面：订阅即 error 帧（仓库不存在）。
    const controller = new AbortController()
    const frames: GitStatusFrame[] = []
    const stream = service.followStatus(controller.signal)
    const pump = (async () => {
      for await (const frame of stream) {
        frames.push(frame)
        if (frame.kind === 'status') break
      }
    })().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 500))
    // init 后：缓存失效 + R3 mutation 帧 → 流内 status 帧（R1 error → R3 status）。
    const result = await service.initRepository()
    expect(result.branch).toBe(worldHeadBranch(dir))
    await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 4_000))])
    controller.abort()
    await pump.catch(() => {})
    const kinds = frames.map((frame) => frame.kind)
    expect(kinds[0]).toBe('error')
    expect(kinds).toContain('status')
    const statusFrame = frames.find((frame) => frame.kind === 'status') as Extract<GitStatusFrame, { kind: 'status' }> | undefined
    expect(statusFrame?.snapshot.branch.unborn).toBe(true)
    expect(norm(statusFrame?.snapshot.repoRoot ?? '')).toBe(norm(dir))
    // init 后 status RPC 直接 ready（缓存失效就地重探，无 TTL 等待）。
    const after = await service.status()
    expect(after.branch.unborn).toBe(true)
  })

  it('workspace 解析不出 ⇒ git/session-workspace-unresolved（无目录可 init）', async () => {
    // workspaceOverride 指向已删除目录（realpath 失败 ⇒ 解析失败，不回落）。
    const ghost = join(tmpdir(), `dshgit-admin-ghost-${String(Date.now())}`)
    const service = makeService(ghost)
    const rejection = await rejectionOf(() => service.initRepository())
    expect(rejection.code).toBe('git/session-workspace-unresolved')
  })
})

// ============================================================
// 评审修复回归 —— stderr 脱敏契约（sanitizeStderr 统一面）
//   admin-repo.ts 的 init-failed message 内嵌与 symbolic-ref 契约破坏
//   details.stderr 此前走本地 trim+slice（评审指出的脱敏破例点），现统一过
//   sanitizeStderr（error-codes.ts）。测试 = 脚本化 SubprocessFace 直构引擎
//   （GitRunner 面），脚本返回凭证形 stderr 断言明文零落 message/details。
// ============================================================

describe('initRepository — stderr 脱敏契约（评审修复回归）', () => {
  const cleanups: Array<() => Promise<unknown>> = []

  afterAll(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })

  /** 脚本化 SubprocessFace：按 argv 尾段分派（GitRunner 前缀在 argv 头部——取尾部匹配）。 */
  function scriptedSubprocess(script: {
    revParse: Array<{ exitCode: number; stdout?: string; stderr?: string }>
    init?: { exitCode: number; stderr?: string }
    symbolicRef?: { exitCode: number; stderr?: string }
  }): SubprocessFace {
    const calls = { revParse: 0 }
    return {
      async resolveExecutable() {
        return 'git'
      },
      spawn(spec) {
        const argv = spec.argv as readonly string[]
        // 按 argv 全量分派（runner 前缀在头部，token 无碰撞面：rev-parse/--show-toplevel
        // 与 init/symbolic-ref 互不重叠）。
        const has = (token: string): boolean => argv.includes(token)
        const text = (value: string | undefined) => ({
          readFrom: () => ({ text: value ?? '', lossy: false }),
        })
        if (has('init')) {
          const init = script.init ?? { exitCode: 0 }
          return {
            done: Promise.resolve({ exitCode: init.exitCode }),
            collected: { stdout: text(''), stderr: text(init.stderr) },
          }
        }
        if (has('symbolic-ref')) {
          const ref = script.symbolicRef ?? { exitCode: 1 }
          return {
            done: Promise.resolve({ exitCode: ref.exitCode }),
            collected: { stdout: text(''), stderr: text(ref.stderr) },
          }
        }
        // rev-parse --show-toplevel：按调用次序出脚本（预检 → init 后回读）。
        const revParse = script.revParse[Math.min(calls.revParse, script.revParse.length - 1)]!
        calls.revParse += 1
        return {
          done: Promise.resolve({ exitCode: revParse.exitCode }),
          collected: { stdout: text(revParse.stdout), stderr: text(revParse.stderr) },
        }
      },
    }
  }

  function makeScriptedEngine(face: SubprocessFace, workspace: string): AdminRepoEngine {
    const runners = createGitRunners(face, {
      gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000, networkTimeoutMs: 15_000,
      outputMaxBytes: 1_048_576,
    })
    return new AdminRepoEngine(runners.write, runners.readonly, new WorkspaceResolver(workspace))
  }

  it('git init 失败：message 内嵌 stderr 过 sanitizeStderr（凭证形明文不落 message）', async () => {
    const dir = await scratchDir('dshgit-admin-sanitize-init-', cleanups)
    const engine = makeScriptedEngine(scriptedSubprocess({
      revParse: [{ exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }],
      init: { exitCode: 1, stderr: 'fatal: cannot set token=ghp_supersecretvalue for ownership' },
    }), dir)
    const cause = await engine.initRepository().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(cause)
    expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
    expect(remote!.code).toBe('git/init-failed')
    expect(remote!.message).toContain('token=***')
    expect(remote!.message).not.toContain('ghp_supersecretvalue')
    expect(remote!.details as Record<string, unknown>).toMatchObject({ reason: 'git-init-failed' })
  })

  it('symbolic-ref 契约破坏：details.stderr 过 sanitizeStderr（git-error 形状纪律）', async () => {
    const dir = await scratchDir('dshgit-admin-sanitize-ref-', cleanups)
    const engine = makeScriptedEngine(scriptedSubprocess({
      revParse: [
        { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' },
        { exitCode: 0, stdout: 'C:/fake/repo' },
      ],
      init: { exitCode: 0 },
      symbolicRef: { exitCode: 1, stderr: 'error: api_key=AIzaSyBadsf9ExampleKey123 refused' },
    }), dir)
    const cause = await engine.initRepository().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    const remote = remoteErrorOf(cause)
    expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
    expect(remote!.code).toBe('git/git-error')
    const details = remote!.details as Record<string, unknown>
    expect(details.stderr).toContain('api_key=***')
    expect(details.stderr).not.toContain('AIzaSyBadsf9ExampleKey123')
    expect(details.op).toBe('initRepository(symbolic-ref)')
  })
})
