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
 *   3.5 [清单 18] trailers 校验（v2 批次三）：每条需形如 `Key: value`（TRAILER_RE），
 *      违反 ⇒ `git/bad-request`（reason 'malformed-trailer'，零命令）；amend --no-edit
 *      路径（保留原消息）与 trailers 同给 ⇒ 'invalid-options'（--no-edit 不改写消息，
 *      trailer 无从附着，零命令）。合法条目组装进 -F 消息体（空行分隔尾块，git
 *      trailer 语义），回读展示纪律不变。
 *   3.6 [清单 22] secret 硬阻断（v2 批次三，D5=A）：guard-scan.ts 的 staged 扫描在
 *      消息校验后执行，**仅 secret 类拦截**——`git/commit-blocked`（overridable:false，
 *      零命令）；env-file/large-file/build-artifact 不拦 host commit（D5=A：可 danger
 *      勾选豁免——豁免语义由 client 闸承载，host 无 bypass wire 字段，登记为方案
 *      空白的施工解释）。扫描失败不阻断提交（护栏降级为不拦——如实 warn，预检面
 *      scanStaged 仍是 UI 主通道）。
 *
 * 执行：`git commit -F -`，message 经 stdin 传入（避免 -m 转义/换行问题，【报告】:265；
 * runner stdin 面由 ④-A 落地）。amend ⇒ --amend（空消息 ⇒ --no-edit；有消息 ⇒ stdin
 * 改写）；skipHooks ⇒ --no-verify（否则保留用户 hook——commit runner 是 WRITE_PREFIX，
 * 不套 hooksPath 禁用，spec §1.0.7 / map §4.5）。失败分类：stderr 含 hook 输出 ⇒
 * `git/hook-failed`（stderr 原样脱敏进 details，UI 可读展示 [清单 20/49]；静默失败
 * 的 hook 无从与普通失败区分——已知限制，见 ModuleResult.openIssues）；其余 ⇒
 * git/git-error 兜底；超时 ⇒ git/timeout { op:'commit' }（commitTimeoutMs 熔断）。
 *
 * [清单 63] process 捕获（v2 批次三）：成功路径回带 `git commit` 进程整体输出
 * （含 hook 输出——git 不做 per-hook 归因；stdout/stderr 两侧 sanitizeStderr 脱敏 +
 * 16 KiB 尾部封顶；空输出置 null 省 wire）。hook 失败路径不返回（stderr 进
 * git/hook-failed details——既有纪律）；超时路径抛 git/timeout。
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
import type { CommitOptions, CommitProcessOutput, CommitResult, CommitViolation } from './types.ts'
import type { WorkspaceResolver } from './workspace.ts'
import { DEFAULT_GUARD_LARGE_FILE_BYTES, hardBlockViolations, scanStagedContents } from './guard-scan.ts'
import type { GuardScanOptions } from './guard-scan.ts'

/**
 * Conventional Commits 非阻断警示正则（commit 守卫链第 3 步的 warn 面）。
 * 语义对照（C 级，PORTING.md 登记）：ZCode gitCommitMessageGenerator.ts:20 的
 * `CONVENTIONAL_COMMIT_RE`——`type(scope)?!?: subject`；A 级逐字移植归 message-gen
 * 模块（spec §1.7 登记行），此处按同语义自写（命中与否只影响 logger 级别）。
 */
const CONVENTIONAL_COMMIT_HINT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/

/**
 * [清单 18] trailer 条目形状（v2 批次三）：`Key: value`——Key = 字母开头的字母/数字/
 * 连字符 token（git trailers 的 token 语义），冒号 + 空白 + 非空 value。
 */
const TRAILER_RE = /^[A-Za-z][A-Za-z0-9-]*:\s\S/u

/** [清单 63] process 两侧封顶字节（方案 §5.2/§5.10：16 KiB/侧；sanitizeStderr 同口径）。 */
const PROCESS_TAIL_CHARS = 16 * 1024

/** commit 引擎构造项。 */
export interface CommitEngineOptions {
  logger?: GitLoggerFace
  /**
   * [清单 22] secret 硬阻断的护栏参数（v2 批次三；缺省 = 默认表——大文件阈值在
   * secret-only 消费面不参与判定，此处只为 scanStagedContents 的形状完整性）。
   */
  guard?: Pick<GuardScanOptions, 'largeFileBytes' | 'buildPatterns' | 'secretPatterns'>
}

export class CommitEngine {
  private readonly logger: GitLoggerFace | undefined
  private readonly guard: CommitEngineOptions['guard']

  constructor(
    /** commit 实例（WRITE_PREFIX + commitTimeoutMs——hook 可能慢，spec §1.0.2）。 */
    private readonly gitCommit: GitRunner,
    /** 只读实例（身份查询 / diff --cached / rev-parse / show 回读 / 护栏扫描——fastTimeoutMs）。 */
    private readonly gitRead: GitRunner,
    private readonly workspace: WorkspaceResolver,
    options: CommitEngineOptions = {},
  ) {
    this.logger = options.logger
    this.guard = options.guard
  }

  /**
   * 提交（含 amend 两路、空提交保护、trailers 与 secret 硬阻断；spec §1.4 + 方案 §5.3）。
   * @throws git/identity-missing、git/nothing-staged、git/empty-message、
   *   git/bad-request（'malformed-trailer' / 'invalid-options'）、git/commit-blocked
   *   （D5=A secret 硬阻断）、git/hook-failed、git/session-workspace-unresolved、
   *   git/no-repository（身份查询顺带发现出仓）、git/timeout、git/git-error。
   */
  async commit(options: CommitOptions, signal?: AbortSignal): Promise<CommitResult> {
    const active = signal ?? neverAborted()
    // 守卫 3.5：[清单 18] trailers 形状校验（最先判——零命令面）。
    const trailers = options.trailers ?? []
    if (trailers.length > 0) {
      for (const trailer of trailers) {
        if (typeof trailer !== 'string' || !TRAILER_RE.test(trailer)) {
          this.logger?.debug('git commit: malformed trailer rejected (zero commands)')
          throw gitError('git/bad-request', `git commit: trailer ${JSON.stringify(trailer)} must be 'Key: value' (letter-start key, non-empty value)`, {
            reason: 'malformed-trailer', paths: [], expected: null, actual: null,
          })
        }
      }
    }
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
    // 守卫 3.5b：--no-edit 路径与 trailers 互斥（--no-edit 保留原消息，trailer 无从
    // 附着——零命令拒绝，防静默丢弃 trailer）。
    if (noEdit && trailers.length > 0) {
      throw gitError('git/bad-request', 'git commit: trailers cannot be combined with amend+empty message (--no-edit preserves the original message; provide a message to attach trailers)', {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }

    // 守卫 3.6：[清单 22] secret 硬阻断（D5=A，零命令）。扫描失败不阻断提交（护栏
    // 降级如实 warn——预检面 scanStaged 是 UI 主通道，本守卫是纵深半）；仅 secret 类
    // 拦截，env-file/large-file/build-artifact 不拦 host commit（D5=A：可 danger 勾选
    // 豁免——豁免语义由 client 闸承载，host 无 bypass wire 字段，文件头注已登记）。
    let violations: CommitViolation[] = []
    try {
      violations = await scanStagedContents(this.gitRead, root, {
        largeFileBytes: this.guard?.largeFileBytes ?? DEFAULT_GUARD_LARGE_FILE_BYTES,
        buildPatterns: this.guard?.buildPatterns ?? [],
        secretPatterns: this.guard?.secretPatterns ?? [],
        logger: this.logger,
      }, active)
    } catch (cause) {
      this.logger?.warn(`git commit: guard scan degraded (commit proceeds without the secret gate): ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const secrets = hardBlockViolations(violations)
    if (secrets.length > 0) {
      this.logger?.debug(`git commit: secret hard block (${String(secrets.length)} violation(s))`)
      throw gitError('git/commit-blocked', `git commit: staged content contains ${String(secrets.length)} secret violation(s); remove the secret(s) and restage (secret violations cannot be exempted)`, {
        violations,
        overridable: false,
      })
    }

    // 组装 -F 消息体：message + 空行分隔的 trailer 尾块（git trailer 语义——最后一个
    // 段落按 trailer 解析；方案 §5.5「空行分隔 + 尾块」）。
    const composed = trailers.length > 0
      ? `${options.message.replace(/\s+$/, '')}\n\n${trailers.join('\n')}`
      : options.message

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
    const startedAt = Date.now()
    const result = await this.gitCommit.run(args, {
      cwd: root,
      op: 'commit',
      signal: active,
      // exactOptionalPropertyTypes：--no-edit 路径不给 stdin 键（/dev/null），改写路径传消息。
      ...(noEdit ? {} : { stdin: composed }),
    })
    if (result.exitCode !== 0) {
      throw commitFailure(result)
    }

    // [清单 63] process 捕获：`git commit` 进程整体输出（含 hook 输出——git 不做
    // per-hook 归因，诚实命名见 CommitProcessOutput 注）脱敏 + 16 KiB 尾部封顶；
    // 空输出置 null 省 wire。超时路径已抛 git/timeout（timedOut 恒 false，wire 形状位）。
    const stdout = sanitizeStderr(result.stdout, PROCESS_TAIL_CHARS)
    const stderr = sanitizeStderr(result.stderr, PROCESS_TAIL_CHARS)
    const process: CommitProcessOutput | null = stdout.trim() === '' && stderr.trim() === ''
      ? null
      : { stdout, stderr, timedOut: false, durationMs: Date.now() - startedAt }

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
    // 剥掉全部尾部换行得到无尾换行的最终 message（commit-msg hook 追加行/trailers
    // 尾块保留在内——回读纪律）。
    const message = messageResult.stdout.replace(/(?:\r?\n)+$/, '')
    return { oid, shortOid: oid.slice(0, 7), branch, amended: options.amend, message, process }
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
