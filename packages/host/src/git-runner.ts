/*!
 * Ported from deepseek-ai/deepseek-harness (dsh 树)
 *   path: packages/experimental/client-ui-forge/src/git.ts（runGit：resolveExecutable/
 *         deadline/双流 collect/finally terminate ——【map】§4.1 组装建议）
 *         packages/deliverables/workspace-changes/src/git.ts:55-80（run()：AbortSignal
 *         ⊕ 调用方 signal、argv 数组注入、stdout maxBytes 保尾部、stderr 16KiB、graceMs）
 *         packages/subprocess/subprocess/src/index.ts:133-155 + types.ts:77-107
 *         （resolveExecutable 面与 env 合并到净化父环境的语义，undefined = 墓碑）
 * License: MIT — Copyright (c) DeepSeek（dsh 源码树许可）
 * Modifications: 2026-10-30（最小插件阶段）—— 合并两树内先例为最小 GitRunner；spawn 面改
 *   结构化 SubprocessFace（不依赖 @deepseek-ai/dsh-subprocess 类型包）。
 *   2026-10-31（④-A）补正式文件头。
 *   2026-10-31（⑤ status 引擎模块）按 capability-spec §1.0.7 扩为「只读/写/提交/网络」
 *   四实例：安全参数拆两套前缀（只读套 = --no-optional-locks + core.hooksPath=/dev/null +
 *   core.fsmonitor=false；写套不含——保留用户 hook 与正常锁，map §4.5），Codex
 *   safe.bareRepository=explicit 按参数清单翻译为全部实例共用的 -c 前缀（research/
 *   ported-sources/codex/.../operations.rs:122 run_git 统一前缀，Apache-2.0——登记见
 *   PORTING.md）；GitRunOptions 增 op（域码 git/timeout 与日志的 op 名）、stdin、
 *   maxBytes、env（后置合并，workspace-changes git.ts:69 语义）；超时改抛 git/timeout
 *   域码；resolveExecutable 失败/返回 null → git/git-error op='resolve-git'（spec §1.0.7）。
 * SPDX-License-Identifier: MIT
 */

import { gitError, sanitizeStderr } from './error-codes.ts'
import type { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Milliseconds a git child gets to exit after termination starts; a fixed lifecycle constant. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Default per-command stdout cap, replaceable per runner. */
export const DEFAULT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Clear inherited repository, configuration, and replacement-ref selectors;
 * disable prompts, optional index writes, and lazy fetches of missing objects.
 * （照抄 client-ui-forge git.ts:58-69 的 GIT_ENV；`undefined` 值是 spawn env 的墓碑。
 * GIT_LITERAL_PATHSPECS=1：本插件全部路径参数按字面量处理（spec §1.0.7
 * 「路径参数加 --literal-pathspecs」的环境变量形态，dsh workspace-changes git.ts:195 同款）。）
 */
const GIT_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_LITERAL_PATHSPECS: '1',
  LC_ALL: 'C',
})

/**
 * Safety arguments prepended to every command, all classes alike：Codex
 * `SAFE_BARE_REPOSITORY_CONFIG` 的参数清单翻译（operations.rs:122——`run_git` 对每条命令
 * 统一注入；Rust 不移植，抄注入位置。语义：裸仓库必须显式寻址，禁止从 cwd 隐式发现）。
 */
const SAFE_BARE_PREFIX = ['-c', 'safe.bareRepository=explicit'] as const

/**
 * Read-only hardening prepended to 只读实例 (after {@link SAFE_BARE_PREFIX})：
 * 不刷新 index（--no-optional-locks）、禁用户 hook（core.hooksPath=/dev/null——dsh 全树
 * 一律 /dev/null 无平台分支，map §4.5）、禁文件系统监控 helper（core.fsmonitor=false，
 * codex fsmonitor.rs 的 Disabled 语义）。写/提交/网络实例不含这些（保留用户 hook 与
 * 正常锁——spec §1.0.7：写命令不套 hooksPath 禁用与 --no-optional-locks）。
 */
const READ_ONLY_HARDENING = [
  '--no-optional-locks',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
] as const

/** 只读实例的完整前缀（spec §1.0.7 GIT_PREFIX + Codex safe.bareRepository）。 */
export const READONLY_PREFIX: readonly string[] = Object.freeze([...SAFE_BARE_PREFIX, ...READ_ONLY_HARDENING])

/** 写/提交/网络实例的前缀：仅 safe.bareRepository（无 hooksPath/fsmonitor/--no-optional-locks）。 */
export const WRITE_PREFIX: readonly string[] = SAFE_BARE_PREFIX

/** 四类命令实例（spec §1.0.2 超时分档 × §1.0.7 前缀两套的交集）。 */
export type GitCommandClass = 'readonly' | 'write' | 'commit' | 'network'

/** Settled git command facts; a nonzero exit is a result, not an exception. */
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when stdout exceeded the output cap and lost its head. */
  truncated: boolean
}

/** Per-command spawn facts. */
export interface GitRunOptions {
  cwd: string
  /**
   * 逻辑操作名：进入 git/timeout 域码 details 与 spawn 失败错误（spec §1.0.5），
   * 如 'status'、'identity(config --get user.name)'。
   */
  op: string
  signal: AbortSignal
  /** Data piped to the child's stdin; absent = /dev/null.（commit -F - 的预留面） */
  stdin?: string
  /** In-memory stdout cap for this command, replacing the runner's `outputMaxBytes`. */
  maxBytes?: number
  /**
   * Per-command env, merged after the scrubbed base env（workspace-changes git.ts:69
   * 后置合并）. `undefined` 值 = 墓碑（从合并结果删除该键——v2 批次三 stashPush 用它
   * 对单条命令摘除 GIT_LITERAL_PATHSPECS：本机 git 2.55.0.windows.2 实测该环境变量
   * 会静默破坏 `git stash push --include-untracked` 的 untracked 收集（tracked 照常
   * 入 stash，untracked 留在工作区——git 内部 pathspec 魔法被字面化）。摘除仅限
   * 无用户 pathspec 输入的命令（stash push 不传 pathspec，零注入面）。
   */
  env?: Readonly<Record<string, string | undefined>>
}

/** Bounds every git command runs under. */
export interface GitLimits {
  /** Milliseconds before a command is terminated. */
  timeoutMs: number
  /** In-memory stdout cap in bytes. */
  outputMaxBytes: number
}

/**
 * The slice of the host's `subprocess` service this runner uses
 * (structural: `@deepseek-ai/dsh-subprocess` 的运行时对象由宿主注入，编译期不依赖其类型包）。
 */
export interface SubprocessFace {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string | null>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore' | { data: string }
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal?: AbortSignal
    env?: Record<string, string | undefined>
  }): {
    done: Promise<{ exitCode: number | null; signal?: unknown }>
    collected: {
      stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }
      stderr?: { readFrom(offset: number): { text: string; lossy: boolean } }
    }
  }
}

/**
 * Runs one resolved git executable with scrubbed environment, timeout, and bounded output.
 * 一个实例绑定一类 {@link GitCommandClass} 的前缀与限额；四实例经 {@link createGitRunners} 组装。
 */
export class GitRunner {
  private executable: string | undefined

  constructor(
    private readonly subprocess: SubprocessFace,
    private readonly command: string,
    private readonly limits: GitLimits,
    private readonly prefix: readonly string[],
  ) {}

  /**
   * Run `git <prefix> <args>` to completion. Executable lookup happens once per
   * instance and is cached（dsh 范式：`ctx.subprocess.resolveExecutable('git',
   * undefined, signal)`，workspace-changes/src/index.ts:72-86 的 git 发现面）。
   * @throws git/timeout（超时终止后）、git/git-error（op='resolve-git' 或 spawn 失败）
   *   或普通 Error（调用方 abort——gateway 侧按取消折叠，map §2.4）。
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    if (this.executable === undefined) {
      let resolved: string | null
      try {
        resolved = await this.subprocess.resolveExecutable(this.command, undefined, options.signal)
      } catch (cause) {
        throw resolveGitFailed(options.op, cause)
      }
      if (resolved === null || resolved === '') {
        throw resolveGitFailed(options.op, undefined)
      }
      this.executable = resolved
    }
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...this.prefix, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      // The subprocess credential scrub removes ambient sensitive entries; the
      // tombstones here cut inherited git repository/config selectors.
      env: { ...GIT_ENV, ...options.env },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      if (timeout.aborted) {
        throw gitError('git/timeout', `git ${options.op} timed out after ${this.limits.timeoutMs}ms`, {
          op: options.op,
          timeoutMs: this.limits.timeoutMs,
        })
      }
      throw new Error(`git ${options.op} was aborted`)
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    if (outcome.exitCode === null) {
      // 子进程没能启动/被信号带走（非本 runner 的终止路径）——按域码兜底（spec §1.0.5）。
      // stderr 与非零退出路径同规：先 sanitizeStderr 再进 details（spawn 失败的
      // stderr 可含宿主 shell/路径回显，不脱敏会绕过全部下游脱敏点直达客户端）。
      throw gitError('git/git-error', `git ${options.op} could not be spawned`, {
        op: options.op,
        exitCode: null,
        stderr: sanitizeStderr(stderr.trim()),
        truncated: stdout.lossy,
      })
    }
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/** 四实例装配（spec §1.0.2 超时分档 × §1.0.7 两套前缀）。 */
export interface GitRunnerConfig {
  gitCommand: string
  fastTimeoutMs: number
  commitTimeoutMs: number
  networkTimeoutMs: number
  outputMaxBytes: number
}

/** 按 spec §1.9 的方法分档预装配的四实例。 */
export type GitRunners = Record<GitCommandClass, GitRunner>

export function createGitRunners(subprocess: SubprocessFace, config: GitRunnerConfig): GitRunners {
  return {
    // A 级只读：status/diff/log/refs/show（spec §1.0.4 权限 A）
    readonly: new GitRunner(subprocess, config.gitCommand, {
      timeoutMs: config.fastTimeoutMs, outputMaxBytes: config.outputMaxBytes,
    }, READONLY_PREFIX),
    // B/C 级轻写：stage/unstage/discard/fetch —— 保留用户 hook 与正常锁
    write: new GitRunner(subprocess, config.gitCommand, {
      timeoutMs: config.fastTimeoutMs, outputMaxBytes: config.outputMaxBytes,
    }, WRITE_PREFIX),
    // commit：pre-commit hook 可能慢（spec §1.0.2 commitTimeoutMs）
    commit: new GitRunner(subprocess, config.gitCommand, {
      timeoutMs: config.commitTimeoutMs, outputMaxBytes: config.outputMaxBytes,
    }, WRITE_PREFIX),
    // push/pull/fetch：网络往返（spec §1.0.2 networkTimeoutMs）
    network: new GitRunner(subprocess, config.gitCommand, {
      timeoutMs: config.networkTimeoutMs, outputMaxBytes: config.outputMaxBytes,
    }, WRITE_PREFIX),
  }
}

/** git 可执行文件解析失败 → git/git-error op='resolve-git'（spec §1.0.7；[清单 54] 的来源）。 */
function resolveGitFailed(op: string, cause: unknown): RemoteError {
  const reason = cause instanceof Error ? cause.message : cause === undefined ? 'git executable not found' : String(cause)
  return gitError('git/git-error', `git executable could not be resolved for ${op}: ${reason}`, {
    op: 'resolve-git',
    exitCode: null,
    stderr: reason,
    truncated: false,
  })
}
