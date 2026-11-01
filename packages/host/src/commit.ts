/*!
 * Ported from deepseek-ai/deepseek-harness (dsh 树)
 *   path: packages/experimental/client-ui-forge/src/git.ts:99-103（仓库发现段：
 *         "exit 128 + not a git repository → 域码" 范式——status.ts/diff.ts 已登记段
 *         在本文件的再应用，null 判定改抛 git/no-repository）
 * License: MIT — Copyright (c) DeepSeek（dsh 源码树许可）
 * Modifications: 2026-10-31（⑤ mutations/commit 引擎模块）—— 新文件。守卫链（仓库
 *   发现 → 身份 → 空提交保护 → 消息校验）、`git commit -F -` stdin 执行、hook 失败
 *   分类 git/hook-failed、amend --no-edit/改消息两路与成功后回读为 capability-spec
 *   §1.4 + workflow 任务口径的本模块自研实现（Conventional 警示正则为 C 级语义对照：
 *   ZCode gitCommitMessageGenerator.ts:20，PORTING.md 登记）。
 * SPDX-License-Identifier: MIT
 */

/**
 * dsh-gitkit — 提交引擎（spec §1.4 [清单 11/15/17/19/20/55/64]；权限 C）。
 *
 * 守卫链（顺序执行，任一失败即抛对应码，不执行 commit——spec §1.4 前置校验）：
 *   0. 仓库发现：`rev-parse --show-toplevel`（"exit 128 + not a git repository" 范式）
 *      ⇒ `git/no-repository`（身份查询在仓外也能读到全局配置，须先钉住仓库前提）；
 *   1. 身份检查 [清单 55]：`git config --get user.name|user.email`（exit 1 = 键未设置、
 *      exit 0 + 空串 = 空值，同 identity 查询面语义，index.ts:227-244；任一缺失 ⇒
 *      `git/identity-missing { missing }`）；
 *   2. 空提交保护 [清单 11]：非 amend 时 `git diff --cached --quiet` exit 0（staged 为空）
 *      ⇒ `git/nothing-staged { branch }`；amend 允许空 staged（仅改写 message）。本机
 *      git 2.55.0.windows.2 实测：unborn 仓库同命令可用（有 staged exit 1 / 空 index
 *      exit 0，隐式对空树比较）——无需 unborn 特判；
 *   3. message 校验：空/全空白 ⇒ `git/empty-message`；**但 amend + 全空白 = `--no-edit`
 *      路径（保留原消息），不走该守卫**（amend 两路的任务口径）。格式校验（Conventional
 *      Commits）为**非阻断** warn（[清单 17] 由 client 提示，host 不拒绝）。
 *
 * 执行：`git commit -F -`，message 经 stdin 传入（避免 -m 转义/换行问题，【报告】:265；
 * runner stdin 面由 ④-A 落地）。amend ⇒ --amend（空消息 ⇒ --no-edit；有消息 ⇒ stdin
 * 改写）；skipHooks ⇒ --no-verify（否则保留用户 hook——commit runner 是 WRITE_PREFIX，
 * 不套 hooksPath 禁用，spec §1.0.7 / map §4.5）。失败分类：stderr 含 hook 输出 ⇒
 * `git/hook-failed`（stderr 原样脱敏进 details，UI 可读展示 [清单 20/49]；静默失败
 * 的 hook 无从与普通失败区分——已知限制，见 ModuleResult.openIssues）；其余 ⇒
 * git/git-error 兜底；超时 ⇒ git/timeout { op:'commit' }（commitTimeoutMs 熔断）。
 *
 * 成功后：`git rev-parse --verify HEAD` 取 oid、`git rev-parse --abbrev-ref HEAD` 取
 * 分支（detached 输出 'HEAD' ⇒ null，本机实测）、`git show -s --format=%B HEAD` 回读
 * 最终 message（commit-msg hook 改写 / --no-edit 保留后的权威值，任务口径「回读最终
 * message → 刷新回带」）。写后失效（status + log + refs + show 缓存）由服务面接线
 * （log/refs/show 引擎落地前的缓存面 = status）。
 */

import { assertGitOk, gitError, gitRunError, logFailure, sanitizeStderr } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { CommitOptions, CommitResult } from './types.ts'
import type { WorkspaceResolver } from './workspace.ts'

/**
 * Conventional Commits 非阻断警示正则（commit 守卫链第 3 步的 warn 面）。
 * 语义对照（C 级，PORTING.md 登记）：ZCode gitCommitMessageGenerator.ts:20 的
 * `CONVENTIONAL_COMMIT_RE`——`type(scope)?!?: subject`；A 级逐字移植归 message-gen
 * 模块（spec §1.7 登记行），此处按同语义自写（命中与否只影响 logger 级别）。
 */
const CONVENTIONAL_COMMIT_HINT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/

/** commit 引擎构造项。 */
export interface CommitEngineOptions {
  logger?: GitLoggerFace
}

export class CommitEngine {
  private readonly logger: GitLoggerFace | undefined

  constructor(
    /** commit 实例（WRITE_PREFIX + commitTimeoutMs——hook 可能慢，spec §1.0.2）。 */
    private readonly gitCommit: GitRunner,
    /** 只读实例（身份查询 / diff --cached / rev-parse / show 回读——fastTimeoutMs）。 */
    private readonly gitRead: GitRunner,
    private readonly workspace: WorkspaceResolver,
    options: CommitEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  /**
   * 提交（含 amend 两路与空提交保护；spec §1.4）。
   * @throws git/identity-missing、git/nothing-staged、git/empty-message、
   *   git/hook-failed、git/session-workspace-unresolved、git/no-repository（身份查询
   *   顺带发现出仓）、git/timeout、git/git-error。
   */
  async commit(options: CommitOptions, signal?: AbortSignal): Promise<CommitResult> {
    const active = signal ?? neverAborted()
    const { root } = await this.workspace.resolve()
    // 步骤 0：仓库发现（"exit 128 + not a git repository" 范式，status.ts 同源）——
    // 把「会话 cwd 不是仓库」显式落 git/no-repository，而不是让 config/diff 间接失败。
    const probe = await this.gitRead.run(['rev-parse', '--show-toplevel'], {
      cwd: root, op: 'commit(rev-parse --show-toplevel)', signal: active,
    })
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${root}`, { probed: root })
    }
    assertGitOk(probe, 'commit(rev-parse --show-toplevel)')

    // 守卫 1：身份检查（合并视图；缺失键进 details.missing，[清单 55]）。
    const [name, email] = await Promise.all([
      this.configGet(root, 'user.name', active),
      this.configGet(root, 'user.email', active),
    ])
    const missing = [
      ...(name === null ? ['user.name'] : []),
      ...(email === null ? ['user.email'] : []),
    ]
    if (missing.length > 0) {
      logFailure(this.logger ?? nullLogger, 'commit', 'git/identity-missing')
      throw gitError('git/identity-missing', `git commit: identity is not configured (${missing.join(', ')})`, { missing })
    }

    // 守卫 2：空提交保护（仅非 amend；amend 允许空 staged 仅改写消息）。
    // 本机实测：unborn 仓库 diff --cached --quiet 可用（对空树隐式比较）。
    if (!options.amend) {
      const staged = await this.gitRead.run(['diff', '--cached', '--quiet'], {
        cwd: root, op: 'commit(diff --cached --quiet)', signal: active,
      })
      if (staged.exitCode === 0) {
        const branch = await this.currentBranch(root, active)
        logFailure(this.logger ?? nullLogger, 'commit', 'git/nothing-staged')
        throw gitError('git/nothing-staged', 'git commit: nothing is staged', { branch })
      }
      if (staged.exitCode !== 1) {
        throw gitRunError('commit(diff --cached --quiet)', staged.exitCode, staged.stderr, staged.truncated)
      }
    }

    // 守卫 3：消息校验。空/全空白 ⇒ git/empty-message；amend + 全空白 = --no-edit
    // 路径（保留原消息，不改写）。格式校验为非阻断 warn（[清单 17] 由 client 提示）。
    const trimmed = options.message.trim()
    const noEdit = options.amend && trimmed === ''
    if (!options.amend && trimmed === '') {
      logFailure(this.logger ?? nullLogger, 'commit', 'git/empty-message')
      throw gitError('git/empty-message', 'git commit: message is empty or whitespace-only', {})
    }
    if (trimmed !== '' && !CONVENTIONAL_COMMIT_HINT_RE.test(firstLine(trimmed))) {
      this.logger?.warn('git commit: message does not match Conventional Commits format (non-blocking hint)')
    }

    // 执行：-F - + stdin（amend 两路；skipHooks ⇒ --no-verify）。
    // --no-edit 路径不带 -F（本机实测：`-F -` 与 --no-edit 同给时 stdin 的空消息会
    // 覆盖 --no-edit 并以 "Aborting commit due to empty commit message" 中止）——
    // 消息沿用 HEAD（amend 必有 HEAD）。
    const args: string[] = ['commit']
    if (noEdit) {
      args.push('--amend', '--no-edit')
    } else {
      args.push('-F', '-')
      if (options.amend) args.push('--amend')
    }
    if (options.skipHooks) args.push('--no-verify')
    const result = await this.gitCommit.run(args, {
      cwd: root,
      op: 'commit',
      signal: active,
      // exactOptionalPropertyTypes：--no-edit 路径不给 stdin 键（/dev/null），改写路径传消息。
      ...(noEdit ? {} : { stdin: options.message }),
    })
    if (result.exitCode !== 0) {
      throw commitFailure(result)
    }

    // 成功后回读（oid / branch / 最终 message——hook 或 --no-edit 之后的权威值）。
    const oidResult = await this.gitRead.run(['rev-parse', '--verify', 'HEAD'], {
      cwd: root, op: 'commit(rev-parse --verify HEAD)', signal: active,
    })
    assertGitOk(oidResult, 'commit(rev-parse --verify HEAD)')
    const oid = oidResult.stdout.trim()
    const branch = await this.currentBranch(root, active)
    const messageResult = await this.gitRead.run(['show', '-s', '--format=%B', 'HEAD'], {
      cwd: root, op: 'commit(show -s --format=%B)', signal: active,
    })
    assertGitOk(messageResult, 'commit(show -s --format=%B)')
    // 本机实测：%B 输出 = 存储 message（git 规范化后恒以单个 \n 结尾）+ 渲染终结 \n——
    // 剥掉全部尾部换行得到无尾换行的最终 message（commit-msg hook 追加行保留在内）。
    const message = messageResult.stdout.replace(/(?:\r?\n)+$/, '')
    return { oid, shortOid: oid.slice(0, 7), branch, amended: options.amend, message }
  }

  /** 当前分支短名；detached（`--abbrev-ref HEAD` 输出 'HEAD'，本机实测）⇒ null。 */
  private async currentBranch(root: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.gitRead.run(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root, op: 'commit(rev-parse --abbrev-ref HEAD)', signal,
    })
    if (result.exitCode !== 0) return null
    const name = result.stdout.trim()
    return name === '' || name === 'HEAD' ? null : name
  }

  /**
   * 单键 `git config --get`（exit 语义同 index.ts configGet：0=有值/空串按缺失、
   * 1=键未设置 ⇒ null、其余非零 ⇒ git/git-error）。
   */
  private async configGet(root: string, key: 'user.name' | 'user.email', signal: AbortSignal): Promise<string | null> {
    const result = await this.gitRead.run(['config', '--get', key], {
      cwd: root, op: `commit(config --get ${key})`, signal,
    })
    if (result.exitCode === 0) {
      const value = result.stdout.trim()
      return value === '' ? null : value
    }
    if (result.exitCode === 1) return null
    logFailure(this.logger ?? nullLogger, 'commit', 'git/git-error', { key })
    throw gitRunError(`commit(config --get ${key})`, result.exitCode, result.stderr, result.truncated)
  }
}

/** commit 非零退出 → hook 分类或 git-error 兜底（spec §1.4 hook 失败段 + 任务口径）。 */
function commitFailure(result: { exitCode: number | null; stderr: string; truncated: boolean }): never {
  const clean = sanitizeStderr(result.stderr)
  // hook 输出（hook 本体 stdout 也被 git 转发进 stderr，本机实测）含 'hook' 字样，
  // 或 husky/git 自身的 hook 失败措辞 ⇒ git/hook-failed；stderr 原样（脱敏）进 details。
  if (/\bhook\b/i.test(clean)) {
    throw gitError('git/hook-failed', `git commit: a hook rejected the commit (exit ${String(result.exitCode)})`, {
      op: 'commit',
      exitCode: result.exitCode,
      stderr: clean,
      truncated: result.truncated,
    })
  }
  throw gitRunError('commit', result.exitCode, result.stderr, result.truncated)
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? ''
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}

/** 引擎内 logFailure 的空实现（logger 可选注入的兜底面）。 */
const nullLogger: GitLoggerFace = { debug() {}, info() {}, warn() {}, error() {} }
