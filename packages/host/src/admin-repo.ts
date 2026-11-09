/**
 * dsh-gitkit — 仓库初始化引擎（v2 批次四：[清单 8] 非 git 目录 git init 引导；
 * docs/v2-implementation-plan.md §6.3/§6.5）。
 *
 * 语义要点（方案 §6.3 initRepository 行）：
 *   - 前置 `git rev-parse` 复核**非仓库态**（§6.5 括注）——目录已是仓库（或位于某
 *     仓库之内）⇒ `git/init-failed`（details.reason='already-a-repository'），
 *     零命令不落 init；
 *   - 非 git 目录（含**非空**目录——[8] 的真实用例即「已打开的项目目录」）执行
 *     `git init`（无 `-b` 旗标——初始分支尊重用户 init.defaultBranch/全局配置）；
 *     `git init` 自身非零退出 ⇒ `git/init-failed`（reason='git-init-failed'，
 *     stderr 脱敏进 message 面——details 只有 path/reason 两键）；
 *   - init 后回读 repoRoot（`rev-parse --show-toplevel`）与初始分支（`symbolic-ref
 *     --quiet --short HEAD`——unborn HEAD 也有符号引用，回读非 null）；
 *   - 失效链由服务面承担（index.ts：afterWrite() = StatusEngine 缓存作废 + R3 帧
 *     ——not-repository 属稳定事实进 TTL 缓存，init 后必须 invalidate 才能就地重探；
 *     WorkspaceResolver 无负缓存，workspace 从 unresolved → resolved 的重解析由
 *     其逐次 realpath 语义天然承担）。
 *
 * 实例纪律（CLAUDE.md 四实例）：init 是写操作 → **write** runner（WRITE_PREFIX +
 * fastTimeoutMs，refs-admin 变更类同款）；预检/回读走 **readonly** runner。
 * 解析器自研（零来源代码搬运——对照仅 refs-admin.ts 的编排骨架纪律：先预检再变更
 * 后回读）。
 */

import { resolve } from 'node:path'
import { gitError, sanitizeStderr } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { InitResult } from './types.ts'

/** admin-repo 引擎构造项（预留 logger 诊断位，MutationEngine 同款）。 */
export interface AdminRepoEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许——index.ts 传 this.logger）。 */
  logger?: { debug(message: string): void } | undefined
}

export class AdminRepoEngine {
  private readonly logger: AdminRepoEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——`git init` 执行）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（rev-parse 预检/回读 + symbolic-ref 分支回读）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（init 目标目录 = 工作区根；解析失败 ⇒ git/session-workspace-unresolved 原样穿透）。 */
    private readonly workspace: WorkspaceResolver,
    options: AdminRepoEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  /**
   * 非仓库目录初始化（[清单 8]）：预检（非仓库态复核）→ `git init` → 回读
   * repoRoot/branch。
   * @throws git/init-failed（已是仓库 / git init 失败）、git/session-workspace-unresolved、
   *   git/no-repository（init 后 rev-parse 反常失败 = 契约破坏）、git/timeout、
   *   git/git-error。
   */
  async initRepository(signal?: AbortSignal): Promise<InitResult> {
    const resolution = await this.workspace.resolve()
    const root = resolution.root
    // 前置复核：非仓库态（§6.5 括注）。exit 128 + not a git repository = 预期放行；
    // exit 0 = 已是仓库（或位于仓库之内）⇒ init-failed；其余失败如实穿透。
    const probe = await this.gitRead.run(['rev-parse', '--show-toplevel'], {
      cwd: root, op: 'initRepository(rev-parse --show-toplevel)', signal: active(signal),
    })
    if (probe.exitCode === 0) {
      const existing = probe.stdout.trim()
      throw gitError('git/init-failed', `git initRepository: '${root}' is already inside the repository '${existing}'`, {
        path: root,
        reason: 'already-a-repository',
      })
    }
    if (!(probe.exitCode === 128 && /not a git repository/i.test(probe.stderr))) {
      throw gitError('git/init-failed', `git initRepository: repository probe failed for '${root}' (exit ${String(probe.exitCode)})`, {
        path: root,
        reason: 'repository-probe-failed',
      })
    }
    const init = await this.gitWrite.run(['init'], {
      cwd: root, op: 'initRepository(git init)', signal: active(signal),
    })
    if (init.exitCode !== 0) {
      // message 内嵌 stderr 先过全仓统一脱敏面（sanitizeStderr——凭证形键值/URL
      // userinfo 打码），再截 200 字符（ping 的 message 内嵌同口径，index.ts ping）。
      throw gitError('git/init-failed', `git initRepository: git init failed for '${root}': ${sanitizeStderr(init.stderr).trim().slice(0, 200)}`, {
        path: root,
        reason: 'git-init-failed',
      })
    }
    // 回读（world 而非自述）：repoRoot 与初始分支。init 刚成功仍探不出仓库 = 契约破坏要响。
    const repoRoot = resolve(root, (await this.gitRead.run(['rev-parse', '--show-toplevel'], {
      cwd: root, op: 'initRepository(rev-parse --show-toplevel re-read)', signal: active(signal),
    })).stdout.trim())
    const branch = await this.currentBranch(repoRoot, signal)
    this.logger?.debug(`git initRepository: branch=${branch}`)
    return { repoRoot, branch }
  }

  /** 当前分支短名（symbolic-ref --quiet --short HEAD；unborn 分支也有符号引用）。 */
  private async currentBranch(cwd: string, signal?: AbortSignal): Promise<string> {
    const probe = await this.gitRead.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd, op: 'initRepository(symbolic-ref HEAD)', signal: active(signal),
    })
    if (probe.exitCode === 0) {
      const name = probe.stdout.trim()
      if (name !== '') return name
    }
    // init 刚成功 HEAD 必为符号引用（unborn 也是）——探不出 = 契约破坏（要响）。
    // details.stderr 与全仓 git-error 形状同纪律：sanitizeStderr 脱敏 + 16 KiB 尾部
    // （本地 trim+slice 面已移除——评审指出的脱敏破例点）。
    throw gitError('git/git-error', 'git initRepository: HEAD is not symbolic after a successful init', {
      op: 'initRepository(symbolic-ref)',
      exitCode: probe.exitCode,
      stderr: sanitizeStderr(probe.stderr),
      truncated: probe.truncated,
    })
  }
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
