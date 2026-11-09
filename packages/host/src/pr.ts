/**
 * dsh-gitkit — PR 引擎（v2 批次四：[清单 46] AI 描述 + 一键创建、[清单 69] PR↔分支
 * 关联；docs/v2-implementation-plan.md §6.3/§6.5；D1=A 载体已拍板 = gh CLI）。
 *
 * 载体语义（方案 §6.3 createPr/prForBranch 行）：
 *   - `ghCommand` Config（默认 'gh'）经 `subprocess.resolveExecutable` 解析——同
 *     gitCommand 先例（index.ts gitCommand 注记 + git-runner.ts resolve-git 分支）；
 *     解析失败/返回 null ⇒ `git/pr-tool-missing`（details.tool='gh'）；
 *   - createPr 守卫链：acknowledged danger 闸（零命令）→ title 非空（零命令）→
 *     branch/base/head 形状守卫（首字符 '-' 拒绝——positioned arg 会被 gh 当旗标
 *     解析，零注入面）→ `gh auth status` 预检（未装/未登录 ⇒ pr-tool-missing，
 *     方案 §6.10「未装/未登录 ⇒ pr-tool-missing 降级文案」）→
 *     `gh pr create --title <t> --body-file - [--base][--head][--draft]`（body 走
 *     stdin——不进 argv/进程清单）→ exit 0 解析 PR URL；非零 ⇒ `git/pr-create-failed`
 *     （stderr 过 sanitizeStderr）；超时 ⇒ git/timeout { op:'createPr' }；
 *   - prForBranch：`gh pr view <branch> --json url,state`；head 推断 = 该分支
 *     upstream 缺省映射（`rev-parse --abbrev-ref <branch>@{upstream}` 剥远端前缀，
 *     无 upstream 回落 branch 本名）；查询失败/无关联/JSON 不可解析 ⇒ **返回 null**
 *     （[69] UI 静默降级——不占位不报错）；gh 缺失仍抛 pr-tool-missing。
 *   - gh 的非交互提示面与 git `GIT_TERMINAL_PROMPT=0` 不同源：本引擎 spawn env 不带
 *     git 专属清洗（GhTransport 真实现只净 `GH_*`/`GIT_*` 凭证挑选面之外不动——
 *     **gh 非交互旗标行为未实测，方案 §6.10 如实登记为施工期验证点**；真 gh 正路径
 *     不进任何自动门禁（会创建真实 PR 且需网络凭证），成功形状由 pr.spec 假 transport
 *     单测承载）。
 *
 * transport 结构切片（§6.5/§6.10 定案）：构造期可选 seam——真实现
 * {@link subprocessGhTransport} 包宿主 SubprocessFace（真 spawn face 复用 subprocess），
 * pr.spec 注入假实现断言成功形状。**该 seam 只在单测可达**：真宿主进程没有 face 注入
 * 通道（Config 是 schemastery JSON 面带不了函数；fs/llm 切片源是宿主能力服务
 * ctx.get，gh 无对应宿主能力源——方案 §6.7/§6.10），verify-load 的 createPr/prForBranch
 * 只断负路径（ghCommand 指向解析不到的固件名 ⇒ pr-tool-missing）。
 */

import { sanitizeStderr } from './error-codes.ts'
import { gitError } from './error-codes.ts'
import type { SubprocessFace } from './git-runner.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { PrCreateOptions, PrLinkResult, PrResult } from './types.ts'

/** gh 单次调用的默认 stdout 上限字节（URL/JSON 输出远小于此——防失控回显）。 */
export const GH_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
/** gh 单次调用 stderr 尾部保留字节（git-runner STDERR_TAIL_BYTES 同口径）。 */
export const GH_STDERR_TAIL_BYTES = 16 * 1024
/** prForBranch 的 upstream 推断探测 op 名。 */
const UPSTREAM_OP = 'prForBranch(rev-parse --abbrev-ref @{upstream})'

/**
 * gh CLI 传输面（transport 结构切片）：resolveExecutable + 一次性 run。
 * 真实现 = {@link subprocessGhTransport}（宿主 SubprocessFace 封装）；测试注入假实现。
 */
export interface GhTransport {
  /** 解析 ghCommand 为可执行路径；null = 解析不到（⇒ git/pr-tool-missing）。 */
  resolveExecutable(command: string, signal?: AbortSignal): Promise<string | null>
  /**
   * 跑一条 gh 命令到结束。stdin 给定时经管道喂入（--body-file -）；超时/取消由
   * signal 承载（实现方在 signal 中止后终止子进程并以 exitCode=null 结算或 reject）。
   */
  run(spec: {
    argv: readonly string[]
    cwd: string
    stdin?: string | undefined
    signal: AbortSignal
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string; aborted: boolean }>
}

/** 真传输：宿主 SubprocessFace 封装（真 spawn face 复用 subprocess——§6.5）。 */
export function subprocessGhTransport(subprocess: SubprocessFace): GhTransport {
  return {
    async resolveExecutable(command, signal) {
      return subprocess.resolveExecutable(command, undefined, signal ?? neverAborted())
    },
    async run(spec) {
      const handle = subprocess.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        stdio: {
          stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
          stdout: { maxBytes: GH_OUTPUT_MAX_BYTES },
          stderr: { maxBytes: GH_STDERR_TAIL_BYTES },
        },
        graceMs: 2_000,
        signal: spec.signal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
      const stderr = handle.collected.stderr?.readFrom(0) ?? { text: '', lossy: false }
      return {
        exitCode: outcome.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        aborted: spec.signal.aborted,
      }
    },
  }
}

/** pr 引擎构造项。 */
export interface PrEngineOptions {
  /** Config.ghCommand（默认 'gh'；经 resolveExecutable 解析，失败 ⇒ pr-tool-missing）。 */
  ghCommand?: string
  /** gh 网络调用的超时毫秒（复用 Config.networkTimeoutMs 档）。 */
  networkTimeoutMs?: number
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许）。 */
  logger?: { debug(message: string): void } | undefined
}

/** 默认 gh 调用超时毫秒（networkTimeoutMs 未传时的兜底——服务面恒传真值）。 */
const DEFAULT_GH_TIMEOUT_MS = 120_000

export class PrEngine {
  private readonly ghCommand: string
  private readonly networkTimeoutMs: number
  private readonly logger: PrEngineOptions['logger']

  constructor(
    /** gh 传输面（结构切片——真实现包 SubprocessFace，测试注入假实现）。 */
    private readonly transport: GhTransport,
    /** 只读 git 实例（prForBranch 的 upstream 推断探测）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（gh 的 cwd = 仓库根；解析失败 ⇒ session-workspace-unresolved 穿透）。 */
    private readonly workspace: WorkspaceResolver,
    options: PrEngineOptions = {},
  ) {
    this.ghCommand = options.ghCommand ?? 'gh'
    this.networkTimeoutMs = options.networkTimeoutMs ?? DEFAULT_GH_TIMEOUT_MS
    this.logger = options.logger
  }

  // ---------- createPr（[清单 46]；D1=A） ----------

  /**
   * 创建 PR（写操作）：守卫链（零命令段）→ auth 预检 → `gh pr create`。
   * @throws git/bad-request（'unacknowledged' / 'invalid-options'）、
   *   git/pr-tool-missing、git/pr-create-failed、git/session-workspace-unresolved、
   *   git/timeout。
   */
  async createPr(options: PrCreateOptions, signal?: AbortSignal): Promise<PrResult> {
    // 守卫 1：danger 闸（最先判，零命令执行——创建 PR 是外部可见写动作）。
    if (options.acknowledged !== true) {
      throw gitError('git/bad-request', 'git createPr requires acknowledged=true (destructive confirmation gate)', {
        reason: 'unacknowledged', paths: [], expected: null, actual: null,
      })
    }
    // 守卫 2：title 非空 + 分支参数形状（零命令）。
    const title = typeof options.title === 'string' ? options.title : ''
    if (title.trim() === '') {
      throw badRequestInvalid('git createPr: a non-empty title is required')
    }
    const base = requireBranchArg(options.base, 'base')
    const head = requireBranchArg(options.head, 'head')
    const { root } = await this.workspace.resolve()
    const executable = await this.resolveGh('createPr', signal)
    await this.requireGhAuth('createPr', executable, root, signal)

    const args = ['pr', 'create', '--title', title, '--body-file', '-']
    if (base !== null) args.push('--base', base)
    if (head !== null) args.push('--head', head)
    if (options.draft === true) args.push('--draft')
    const result = await this.runGh('createPr', executable, args, root, options.body, signal)
    if (result.exitCode !== 0) {
      throw gitError('git/pr-create-failed', `git createPr: gh pr create failed (exit ${String(result.exitCode)}); stderr redacted/tail kept`, {
        stderr: sanitizeStderr(result.stderr),
      })
    }
    if (result.aborted) throw aborted('createPr')
    const parsed = parsePrUrl(result.stdout)
    this.logger?.debug(`git createPr: number=${String(parsed.number)} draft=${String(options.draft === true)}`)
    return parsed
  }

  // ---------- prForBranch（[69]） ----------

  /**
   * 查询分支关联 PR（[69]，只读）：gh 缺失 ⇒ pr-tool-missing；查询失败/无关联/
   * 不可解析 ⇒ **null**（UI 静默降级）。
   * @throws git/bad-request 'invalid-options'（branch 形状）、git/pr-tool-missing、
   *   git/session-workspace-unresolved、git/timeout。
   */
  async prForBranch(branch: string, signal?: AbortSignal): Promise<PrLinkResult | null> {
    const headBranch = requireBranchArg(branch, 'branch')
    if (headBranch === null) {
      throw badRequestInvalid('git prForBranch: a non-empty branch name is required')
    }
    const { root } = await this.workspace.resolve()
    const executable = await this.resolveGh('prForBranch', signal)
    const head = await this.inferUpstreamHead(root, headBranch, signal)
    const result = await this.runGh('prForBranch', executable, ['pr', 'view', head, '--json', 'url,state'], root, undefined, signal)
    if (result.exitCode !== 0 || result.aborted) {
      // 无关联 / 查询失败：静默降级为 null（[69]——不占位不报错）。
      this.logger?.debug(`git prForBranch: no pr for ${JSON.stringify(head)} (exit ${String(result.exitCode)})`)
      return null
    }
    let parsed: { url?: unknown; state?: unknown }
    try {
      parsed = JSON.parse(result.stdout) as { url?: unknown; state?: unknown }
    } catch {
      // gh --json 恒输出单个 JSON 对象；不可解析 = 查询失败态——静默降级 null（§6.3）。
      this.logger?.debug('git prForBranch: unparseable gh --json output; degrading to null')
      return null
    }
    if (typeof parsed.url !== 'string' || parsed.url === '') return null
    const state = typeof parsed.state === 'string' && parsed.state !== '' ? parsed.state : null
    this.logger?.debug(`git prForBranch: state=${String(state)} for ${JSON.stringify(head)}`)
    return { url: parsed.url, state }
  }

  // ---------- gh 解析与执行 ----------

  /** gh 可执行解析（resolveExecutable 先例；失败/返回 null ⇒ pr-tool-missing）。 */
  private async resolveGh(op: string, signal?: AbortSignal): Promise<string> {
    let resolved: string | null
    try {
      resolved = await this.transport.resolveExecutable(this.ghCommand, signal)
    } catch (cause) {
      throw prToolMissing(`git ${op}: gh command could not be resolved: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (resolved === null || resolved === '') {
      throw prToolMissing(`git ${op}: gh command '${this.ghCommand}' not found on this machine (install gh or set the ghCommand config)`)
    }
    return resolved
  }

  /** `gh auth status` 预检：非零退出（未装/未登录/token 失效）⇒ pr-tool-missing。 */
  private async requireGhAuth(op: string, executable: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const auth = await this.runGh(op, executable, ['auth', 'status'], cwd, undefined, signal)
    if (auth.exitCode !== 0) {
      throw prToolMissing(`git ${op}: gh is not authenticated (gh auth status exit ${String(auth.exitCode)}); run 'gh auth login' first`)
    }
  }

  /**
   * 单条 gh 调用（超时档 = networkTimeoutMs）。竞态口径照 GitRunner：await 归来后
   * 调用方中止优先（取消原样穿透、不折叠域错误），其次时限（⇒ git/timeout），
   * 最后结果（完成早于时限触发则如实收结果）。
   */
  private async runGh(
    op: string,
    executable: string,
    args: readonly string[],
    cwd: string,
    stdin: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; aborted: boolean }> {
    const timeout = AbortSignal.timeout(this.networkTimeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let result: { exitCode: number | null; stdout: string; stderr: string; aborted: boolean }
    try {
      result = await this.transport.run({
        argv: [executable, ...args],
        cwd,
        ...(stdin === undefined ? {} : { stdin }),
        signal: composed,
      })
    } catch (cause) {
      if (signal?.aborted === true) throw cause
      if (composed.aborted) throw ghTimeout(op, this.networkTimeoutMs)
      throw cause
    }
    if (signal?.aborted === true) throw aborted(op)
    if (composed.aborted) throw ghTimeout(op, this.networkTimeoutMs)
    return result
  }

  /** head 推断（§6.3 prForBranch 行：该分支 upstream 缺省映射）：`rev-parse --abbrev-ref <branch>@{upstream}` 剥远端前缀；无 upstream/探测失败回落 branch 本名。 */
  private async inferUpstreamHead(root: string, branch: string, signal?: AbortSignal): Promise<string> {
    const probe = await this.gitRead.run(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      cwd: root, op: UPSTREAM_OP, signal: active(signal),
    })
    if (probe.exitCode === 0) {
      const upstream = probe.stdout.trim()
      const slash = upstream.indexOf('/')
      if (slash > 0) {
        const stripped = upstream.slice(slash + 1)
        if (stripped !== '') return stripped
      }
    }
    // 无 upstream / 输出形状异常：回落 branch 本名（gh 自行按当前仓库解析）。
    return branch
  }
}

/** 从 gh pr create 的 stdout 解析 PR URL 与编号（`/pull/<n>` 尾段；非 GitHub 形态 ⇒ number null；无 URL ⇒ stdout 首个非空行兜底）。 */
export function parsePrUrl(stdout: string): PrResult {
  const urlMatch = /https:\/\/[^\s"']+/u.exec(stdout)
  const url = urlMatch?.[0] ?? stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
  const numberMatch = /\/pull\/(\d+)(?:[/?#]|$)/u.exec(url)
  return { url, number: numberMatch === null ? null : Number(numberMatch[1]) }
}

/** pr-tool-missing 域错误（details.tool 定死 'gh'——D1=A 唯一载体）。 */
function prToolMissing(message: string): never {
  throw gitError('git/pr-tool-missing', message, { tool: 'gh' })
}

/** 分支参数形状守卫：非空且首字符非 '-'（gh 的 positioned arg / --base 值面）；null/缺省/空串 = 缺省语义放行（createPr 侧），prForBranch 侧自行判空。 */
function requireBranchArg(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw badRequestInvalid(`git pr: ${name} must be a string`)
  if (value.startsWith('-')) throw badRequestInvalid(`git pr: ${name} must not start with '-' (flag-shaped arguments are rejected)`)
  return value
}

function badRequestInvalid(message: string): never {
  throw gitError('git/bad-request', message, { reason: 'invalid-options', paths: [], expected: null, actual: null })
}

function aborted(op: string): Error {
  return new Error(`git ${op} was aborted`)
}

/** gh 调用超时 ⇒ git/timeout（op 名进 details——git/timeout details 形状 {op, timeoutMs}）。 */
function ghTimeout(op: string, timeoutMs: number): never {
  throw gitError('git/timeout', `git ${op}: gh call exceeded the network timeout (${String(timeoutMs)}ms)`, {
    op,
    timeoutMs,
  })
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
