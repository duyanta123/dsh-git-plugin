/**
 * @dsh-plugin/git — host 半（node 侧）入口。
 *
 * 服务形态照 research/host-capability-map.md §2.1（对照 dsh 树 HEAD ce7073d512
 * 实读的同类 class 插件 packages/boot/plugin-manager/src/index.ts:311-378：
 * `extends TypertRemoteService` + `static inject` + `static Config` +
 * `@Remote` 方法 + `export default`）。派发机制（gateway
 * packages/api/gateway/src/index.ts:878-889 `resolveDescriptor`）：strict 描述符
 * （构建期 typert-generator 产物 `./typert`，typert-loader 自动注册）优先，
 * SRC 源码反射兜底 —— 因此 `super(ctx, 'git')` 的 serviceKey 必须是字符串字面量
 * （generator gatewayBindingArguments 契约；spec §1.0.1 样例同形）。
 *
 * ⑤ status 引擎模块（2026-10-31）接线：四实例 GitRunner（只读/写/提交/网络，
 * git-runner.ts）+ StatusEngine（status.ts）+ `@Remote status()`（spec §1.1）+
 * Config 超时三档（fastTimeoutMs/commitTimeoutMs/networkTimeoutMs，spec §1.0.2）。
 * ④-C diff 引擎模块（2026-10-31）接线：DiffEngine（diff.ts）+ `@Remote diff()`
 * （spec §1.2，权限 A）+ Config diffFilePatchMaxBytes/diffTotalPatchMaxBytes
 * （spec §1.0.2 默认 262_144 / 2_097_152）。commitDiff 为 DiffEngine 引擎级方法
 * （show 接线模块经它取 CommitDetail 的 files/totalTruncated）。
 * M9 watcher/followStatus 模块（2026-10-31）接线：StatusWatcher（watcher.ts，三目标
 * watch + 防抖 + 轮询兜底 + 引用计数 + R1–R6）+ `@Remote({mode:'stream'})
 * followStatus()`（spec §2 host 推送契约的 v1 落地面——事件转发 allowlist 无 git/*，
 * 推送以 typert stream 流帧承载；上行 `refresh` 命令 = R5 manual）+ Config
 * debounceMs/pollIntervalMs/watchEnabled（spec §1.0.2 默认 150/60_000/true）。
 * ⑤ mutations/commit 模块（2026-10-31）接线：MutationEngine（mutations.ts，stage/
 * unstage/discard 三重守卫）+ CommitEngine（commit.ts，全守卫链/hook 分类/回读）+
 * `@Remote stage()/unstage()/discard()/commit()`（spec §1.3/§1.4）。写后失效统一
 * invalidateStatusCache() + notifyStatusMutation()（R3；status/log/refs/show 的
 * 后三者在 log/refs/show 模块落地时并入此失效点）。
 * M6 remote-ops 模块（2026-10-31）接线：RemoteOpsEngine（remote-ops.ts，上游三态
 * 判定/diverged 预检/stderr 脱敏分类器）+ `@Remote push()/pull()/fetch()`
 * （spec §1.5/§1.6；权限 push/pull C、fetch B）。
 * M7 message-gen 模块（2026-10-31）接线：MessageGenEngine（message-gen.ts，
 * nothing-staged 前置 + 裁剪四上限 + session-title-llm 六步范式）+
 * `@Remote generateCommitMessage()`（spec §1.7，权限 B）+ Config
 * llmTimeoutMs/llmProvider/llmModel/llmMaxInputBytes（spec §1.0.2 + 任务口径
 * 硬顶）。LLM 路由捕获自挂 session/event（request/header）——与 workspace.ts
 * 的 turn/start 监听同机制。
 * F7 提交图数据层模块（2026-10-31）接线：GraphEngine（graph.ts，log 分页
 * over-fetch/refs 单次查询/commitDetail）+ `@Remote log()/refs()/getCommitDetail()`
 * （spec §1.8 [清单 31/32/33]；workflow 任务口径端点名 show → getCommitDetail、
 * 详情带 refs 过滤）+ Config logDefaultLimit/logMaxLimit（spec §1.0.2 默认
 * 500/5_000）。host 对 log/refs/show 无缓存（spec §1.9 三行无失效列）——写后失效
 * 由 client store 的状态订阅（branch.oid 变化 → reload）承担，afterWrite 无需接线。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { GitCommandClass, GitRunner, SubprocessFace } from './git-runner.ts'
import { DEFAULT_OUTPUT_MAX_BYTES, createGitRunners } from './git-runner.ts'
import { gitRunError, logFailure, logRead, logWrite, sanitizeStderr } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import { DiffEngine, DIFF_FILE_PATCH_MAX_BYTES, DIFF_TOTAL_PATCH_MAX_BYTES } from './diff.ts'
import { CommitEngine } from './commit.ts'
import { MutationEngine } from './mutations.ts'
import { RemoteOpsEngine } from './remote-ops.ts'
import { MessageGenEngine, DEFAULT_LLM_MAX_INPUT_BYTES } from './message-gen.ts'
import type { GitLlmFace, GitRouteEventHost } from './message-gen.ts'
import { GraphEngine, DEFAULT_LOG_DEFAULT_LIMIT, DEFAULT_LOG_MAX_LIMIT } from './graph.ts'
import { StatusEngine, STATUS_CACHE_TTL_MS } from './status.ts'
import { StatusWatcher, DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_INTERVAL_MS } from './watcher.ts'
import type { GitFsWatchFace } from './watcher.ts'
import { WorkspaceResolver } from './workspace.ts'
import type { GitSessionEventHost, GitWorkspaceResolution } from './workspace.ts'
import type {
  CommitDetail, CommitOptions, CommitResult, DiffResult, DiffScope, DiscardOptions, DiscardResult,
  FetchOptions, FetchResult, GeneratedCommitMessage, GitFollowCommand, GitIdentityResult, GitIdentityScope, GitPingResult,
  GitStatusFrame, GitStatusSnapshot, LogOptions, LogPage, PullResult, PushOptions, PushResult, RefsSnapshot,
  ShowOptions, StageResult, UnstageResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Git 插件的 host 面 RPC 服务（wire namespace = serviceKey = `git`）。 */
    git: GitService
  }
}

/** cordis bundle id，必须与 cordis.patch.yml 的 insert 行一致。 */
export const PLUGIN_ID = 'dsh-plugin-git'

/** npm 包名（host 半）。 */
export const PLUGIN_NAME = '@dsh-plugin/git'

/**
 * serviceKey = Cordis 注册名 = wire namespace（端点 `git/ping` 等）。
 * 必须通过 `isTypertRemoteSegment`（`/^[A-Za-z0-9_$.-]+$/`）校验 —— map §2.1。
 * 注意：wire 值同时以字面量内联在 super(ctx, 'git')（generator 契约）。
 */
export const SERVICE_KEY = 'git'

/** GitRunner bounds 与工作区解析（Config；超时分档照 spec §1.0.2）。 */
export interface Config {
  /** git 可执行文件名或绝对路径；经 `subprocess.resolveExecutable` 解析。 */
  gitCommand?: string
  /** 快速命令超时：status/diff/log/refs/show（spec §1.0.2 fastTimeoutMs）。 */
  fastTimeoutMs?: number
  /** commit 超时：pre-commit hook 可能慢（spec §1.0.2 commitTimeoutMs）。 */
  commitTimeoutMs?: number
  /** 网络命令超时：push/pull/fetch（spec §1.0.2 networkTimeoutMs）。 */
  networkTimeoutMs?: number
  /** 单条 git 命令 stdout 内存上限字节（spec §1.0.2 默认 8 MiB）。 */
  outputMaxBytes?: number
  /**
   * diff/show 单文件 patch 上限字节，超过置 oversized（spec §1.0.2
   * diffFilePatchMaxBytes，默认 262_144；[清单 59]）。
   */
  diffFilePatchMaxBytes?: number
  /**
   * diff/show 单次调用 patch 总预算字节，超过停止追加 patch（spec §1.0.2
   * diffTotalPatchMaxBytes，默认 2_097_152；opencode patchBudget 语义对照）。
   */
  diffTotalPatchMaxBytes?: number
  /**
   * 工作区钉死（绝对目录）。空串 = 自动：最近顶层会话的 `session.header.cwd`
   * （workspace-changes 解析服务面，workspace.ts）；都没有 ⇒ `git/session-workspace-unresolved`。
   */
  workspaceOverride?: string
  /** fs 事件防抖毫秒（spec §1.0.2 debounceMs，默认 150——ZCode fileWatcherService DEBOUNCE_MS）。 */
  debounceMs?: number
  /**
   * 兜底轮询间隔毫秒（spec §1.0.2 pollIntervalMs，默认 60_000）。**必需项**：宿主
   * watch depth:0 不递归，嵌套目录编辑只有轮询能捕获（M9 任务口径）。
   */
  pollIntervalMs?: number
  /** host 文件监听开关（spec §1.0.2 watchEnabled，默认 true；false = 纯轮询）。 */
  watchEnabled?: boolean
  /** AI 提交信息 LLM 调用超时毫秒（spec §1.0.2 llmTimeoutMs，默认 60_000）。 */
  llmTimeoutMs?: number
  /**
   * LLM 路由显式覆盖（spec §1.0.2 llmProvider/llmModel，默认空串）。两者都非空
   * 才成对生效；否则用 host 侧缓存的最近 `request/header` 路由；都没有 ⇒
   * `git/llm-route-unresolved`（spec §1.7）。
   */
  llmProvider?: string
  llmModel?: string
  /**
   * 组装完成的 LLM 输入字节硬顶（任务口径；默认 262_144）。裁剪四上限之内
   * input 天然有界，超此硬顶 ⇒ `git/llm-failed { stage:'trim' }`（不静默二次裁剪）。
   */
  llmMaxInputBytes?: number
  /** log 每页默认条数（spec §1.0.2 logDefaultLimit，默认 500；client 传非有限 limit 时回落）。 */
  logDefaultLimit?: number
  /** log 单页上限（spec §1.0.2 logMaxLimit，默认 5_000——limit 钳制上界）。 */
  logMaxLimit?: number
}

/** `ping`/`identity`/`status`/`diff`/`followStatus`/写操作之外的可读常量：本服务当前端点清单（诊断用）。 */
export const REMOTE_METHODS = ['ping', 'identity', 'status', 'diff', 'followStatus', 'stage', 'unstage', 'discard', 'commit', 'push', 'pull', 'fetch', 'generateCommitMessage', 'log', 'refs', 'getCommitDetail'] as const

/**
 * Git 插件 host 服务。构造即注册（`ctx.reflect.provide`），
 * 激活受 `static inject` 门控（subprocess 服务就绪才加载）。
 */
export class GitService extends TypertRemoteService {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    gitCommand: z.string().default('git'),
    fastTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(30_000),
    commitTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(120_000),
    networkTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(120_000),
    outputMaxBytes: z.number().step(1).min(1_024).default(DEFAULT_OUTPUT_MAX_BYTES),
    diffFilePatchMaxBytes: z.number().step(1).min(1).default(DIFF_FILE_PATCH_MAX_BYTES),
    diffTotalPatchMaxBytes: z.number().step(1).min(1).default(DIFF_TOTAL_PATCH_MAX_BYTES),
    workspaceOverride: z.string().default(''),
    debounceMs: z.number().step(1).min(0).max(60_000).default(DEFAULT_DEBOUNCE_MS),
    pollIntervalMs: z.number().step(1).min(1).max(3_600_000).default(DEFAULT_POLL_INTERVAL_MS),
    watchEnabled: z.boolean().default(true),
    llmTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(60_000),
    llmProvider: z.string().default(''),
    llmModel: z.string().default(''),
    llmMaxInputBytes: z.number().step(1).min(1_024).max(16 * 1024 * 1024).default(DEFAULT_LLM_MAX_INPUT_BYTES),
    logDefaultLimit: z.number().step(1).min(1).max(100_000).default(DEFAULT_LOG_DEFAULT_LIMIT),
    logMaxLimit: z.number().step(1).min(1).max(100_000).default(DEFAULT_LOG_MAX_LIMIT),
  })

  private readonly runners: Record<GitCommandClass, GitRunner>
  private readonly statusEngine: StatusEngine
  private readonly diffEngine: DiffEngine
  private readonly mutations: MutationEngine
  private readonly commitEngine: CommitEngine
  private readonly remoteOps: RemoteOpsEngine
  private readonly messageGen: MessageGenEngine
  private readonly graph: GraphEngine
  private readonly statusWatcher: StatusWatcher
  private readonly workspace: WorkspaceResolver
  private readonly logger: GitLoggerFace

  constructor(ctx: Context, config: Config) {
    // serviceKey 必须是源码字面量（typert-generator gatewayBindingArguments 契约）。
    super(ctx, 'git')
    const resolved = config as Required<Config>
    // `subprocess` 由宿主的 @deepseek-ai/dsh-subprocess 声明进 Context；本包不依赖其类型面，
    // 经 ctx.get 结构化取用（运行时对象即注入的 SubprocessRuntime）。
    const subprocess = ctx.get('subprocess') as unknown as SubprocessFace
    // 四实例装配：只读/写/提交/网络（spec §1.0.7 前缀两套 × §1.0.2 超时三档）。
    this.runners = createGitRunners(subprocess, {
      gitCommand: resolved.gitCommand,
      fastTimeoutMs: resolved.fastTimeoutMs,
      commitTimeoutMs: resolved.commitTimeoutMs,
      networkTimeoutMs: resolved.networkTimeoutMs,
      outputMaxBytes: resolved.outputMaxBytes,
    })
    this.workspace = new WorkspaceResolver(resolved.workspaceOverride, ctx as unknown as GitSessionEventHost)
    this.statusEngine = new StatusEngine(this.runners.readonly, this.workspace, {
      cacheTtlMs: STATUS_CACHE_TTL_MS,
    })
    this.diffEngine = new DiffEngine(this.runners.readonly, this.workspace, {
      filePatchMaxBytes: resolved.diffFilePatchMaxBytes,
      totalPatchMaxBytes: resolved.diffTotalPatchMaxBytes,
    })
    // 写操作引擎（spec §1.3/§1.4）：discard/unstage 的守卫走 fresh status 扫描，
    // commit 的守卫走只读实例，执行走 write/commit 实例（git-runner.ts 四实例语义）。
    this.mutations = new MutationEngine(this.runners.write, this.statusEngine)
    this.commitEngine = new CommitEngine(this.runners.commit, this.runners.readonly, this.workspace)
    // 远端同步引擎（spec §1.5/§1.6 + M6 任务口径）：守卫/预检走只读实例与 fresh
    // 扫描，push/pull/fetch 执行走 network 实例（networkTimeoutMs 熔断）。
    this.remoteOps = new RemoteOpsEngine(this.runners.network, this.runners.readonly, this.statusEngine)
    this.logger = (ctx as unknown as { logger: GitLoggerFace }).logger
    // AI 提交信息引擎（spec §1.7 + M7 任务口径）：只读实例 + DiffEngine staged 路 +
    // 宿主 ctx.llm 结构切片（缺席不阻断激活——调用时落 git/llm-failed call）；
    // session/event 路由捕获与 workspace 的 turn/start 监听同机制自挂。
    this.messageGen = new MessageGenEngine(
      this.runners.readonly,
      this.diffEngine,
      this.workspace,
      GitService.readLlmFace(ctx),
      ctx as unknown as GitRouteEventHost,
      {
        llmProvider: resolved.llmProvider,
        llmModel: resolved.llmModel,
        llmTimeoutMs: resolved.llmTimeoutMs,
        llmMaxInputBytes: resolved.llmMaxInputBytes,
        logger: this.logger,
      },
    )
    this.statusWatcher = new StatusWatcher(this.statusEngine, GitService.readFsFace(ctx), {
      debounceMs: resolved.debounceMs,
      pollIntervalMs: resolved.pollIntervalMs,
      watchEnabled: resolved.watchEnabled,
      logger: this.logger,
    })
    // 提交图数据层引擎（spec §1.8 + F7 任务口径）：只读实例 + DiffEngine（commitDiff
    // 的 merge 第一父/根提交 --root/预算环复用）+ log 两钳制常量。
    this.graph = new GraphEngine(this.runners.readonly, this.workspace, this.diffEngine, {
      logDefaultLimit: resolved.logDefaultLimit,
      logMaxLimit: resolved.logMaxLimit,
    })
    // 装载标记（runbook §5.4：ctx.logger.info 不出现在控制台，调试标记用 stdout）。
    process.stdout.write('[dsh-plugin-git] GitService active (serviceKey=git)\n')
  }

  /**
   * 存活探测：跑一次 `git --version` 返回本机 git 自述。
   * @returns `{ ok: true, gitVersion }`（序列化边界：plain object + string）。
   * @throws git 不可执行 / 超时 / 被中止时抛错 → gateway 折叠为
   *   `{ ok: false, error }`（map §2.4：普通 Error 折叠为 gateway/internal，message 保留）。
   */
  @Remote
  async ping(): Promise<GitPingResult> {
    // git --version 不依赖工作树；cwd 取临时目录根，避开宿主进程 cwd 的偶然性。
    const result = await this.runners.readonly.run(['--version'], {
      cwd: process.env.TEMP ?? process.cwd(),
      op: 'ping(--version)',
      signal: neverAborted(),
    })
    if (result.exitCode !== 0 || result.truncated) {
      // message 经 gateway 原样回传（gateway/internal 折叠保留 message）——stderr 必须先
      // 脱敏再内嵌，绕过 sanitizeStderr 调用点的明文通道不留（评审 ④-L low 项修复）。
      throw new Error(`git --version failed: exit=${String(result.exitCode)} stderr=${sanitizeStderr(result.stderr).trim().slice(0, 200)}`)
    }
    const gitVersion = result.stdout.trim().split(/\r?\n/, 1)[0] ?? ''
    logRead(this.logger, 'ping', { gitVersion })
    return { ok: true, gitVersion }
  }

  /**
   * git 身份查询（spec §1.4 commit 前置校验第 1 步的独立查询面 [清单 55]）：
   * 对解析到的工作区跑 `git config --get [--local|--global|--system] user.name|user.email`。
   * 退出码语义（任务口径 + 本机 git 2.55.0.windows.2 实测）：0 = 有值（空串值按缺失）；
   * **1 = 键未设置（缺失）**；≥2 = 命令失败（`git/git-error`，stderr 脱敏后进 details）。
   * 这是带参 @Remote 方法：`scope` 经 strict 描述符 codec 过线（verify-load 以
   * 非法 scope 断言 `gateway/input-invalid`，证明 strict 注册链路真实生效）。
   * @param scope 配置作用域；缺省 = 合并视图（与 commit 前置校验同语义）。
   * @returns 两个键的生效值与缺失清单；不抛 identity-missing（查询面返回状态，
   *   抛该码的职责在 commit 前置校验）。
   */
  @Remote
  async identity(scope?: GitIdentityScope, signal?: AbortSignal): Promise<GitIdentityResult> {
    const workspace = await this.workspace.resolve()
    const name = await this.configGet(workspace, scope, 'user.name', signal)
    const email = await this.configGet(workspace, scope, 'user.email', signal)
    const missing = [
      ...(name === null ? ['user.name'] : []),
      ...(email === null ? ['user.email'] : []),
    ]
    logRead(this.logger, 'identity', {
      scope: scope ?? 'merged',
      workspaceSource: workspace.source,
      complete: missing.length === 0,
    })
    return {
      name,
      email,
      missing,
      complete: missing.length === 0,
      workspace: workspace.root,
      workspaceSource: workspace.source,
    }
  }

  /** 单键 `git config --get`；exit 1 = 缺失 → null，其余非零 → git/git-error。 */
  private async configGet(
    workspace: GitWorkspaceResolution,
    scope: GitIdentityScope | undefined,
    key: 'user.name' | 'user.email',
    signal?: AbortSignal,
  ): Promise<string | null> {
    const scopeFlag = scope === 'local' ? ['--local'] : scope === 'global' ? ['--global'] : scope === 'system' ? ['--system'] : []
    const result = await this.runners.readonly.run(['config', ...scopeFlag, '--get', key], {
      cwd: workspace.root, op: `identity(config --get ${key})`, signal: signal ?? neverAborted(),
    })
    if (result.exitCode === 0) {
      const value = result.stdout.trim()
      return value === '' ? null : value
    }
    if (result.exitCode === 1) return null
    logFailure(this.logger, 'identity', 'git/git-error', { key })
    throw gitRunError(`identity(config --get ${key})`, result.exitCode, result.stderr, result.truncated)
  }

  /**
   * 工作区快照（spec §1.1 [清单 1/5/6/24/64/65]）：porcelain v2 `-z` + 并发 numstat 双路。
   * 权限 A；幂等；<2s 快照缓存 + 进行中扫描去重（StatusEngine）。
   * @throws git/no-repository（工作区不是仓库，details.probed = 工作区路径——[清单 54]）、
   *   git/git-error op='resolve-git'（git 不可用）、git/session-workspace-unresolved、
   *   git/timeout、git/git-error（git 失败兜底）。
   */
  @Remote
  async status(signal?: AbortSignal): Promise<GitStatusSnapshot> {
    const startedAt = Date.now()
    const state = await this.statusEngine.current(signal)
    if (state.error !== null) {
      logFailure(this.logger, 'status', state.error.code)
      throw state.error
    }
    const snapshot = state.snapshot
    logRead(this.logger, 'status', {
      durationMs: Date.now() - startedAt,
      pathCount: snapshot.staged.length + snapshot.unstaged.length + snapshot.untracked.length,
    })
    return snapshot
  }

  /**
   * 文件级 diff（spec §1.2 [清单 2/3/59]）：工作区/暂存双路 + untracked no-index 特例。
   * 权限 A；幂等；无缓存（每次实跑）。单文件 patch 失败不炸整体（patch:null，
   * 调用仍成功）；listing 失败/非仓库抛域错误。
   * @param scope 'worktree' = 工作区对 index；'staged' = index 对 HEAD（[清单 3]）。
   * @param path null = 该 scope 全部变更文件（预算内）；给定 = 单文件（不在变更
   *   集合内 ⇒ files: []）。
   * @throws git/no-repository（details.probed）、git/session-workspace-unresolved、
   *   git/timeout、git/git-error（listing 失败兜底）。
   */
  @Remote
  async diff(scope: DiffScope, path: string | null, signal?: AbortSignal): Promise<DiffResult> {
    const startedAt = Date.now()
    const result = await this.diffEngine.diff(scope, path, signal)
    logRead(this.logger, 'diff', {
      scope,
      pathCount: result.files.length,
      totalTruncated: result.totalTruncated,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 暂存路径（spec §1.3 [清单 9]；权限 B）：`git --literal-pathspecs add -- <paths>`，
   * untracked 路径也走 add。空数组 ⇒ git/no-paths（任务口径，不做 `git add -A` 静默
   * 扩权）。写后失效：status 缓存作废 + R3 mutation 帧（§2.3 失效矩阵）。
   * @throws git/no-paths、git/session-workspace-unresolved、git/no-repository、
   *   git/git-error、git/timeout。
   */
  @Remote
  async stage(paths: string[], signal?: AbortSignal): Promise<StageResult> {
    const startedAt = Date.now()
    try {
      const result = await this.mutations.stage(paths, signal)
      logWrite(this.logger, 'stage', { pathCount: result.staged, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'stage', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 取消暂存（spec §1.3 [清单 12]；权限 B）：`git restore --staged -- <paths>`；
   * unborn 分支回落 `git rm --cached`（[清单 64]）、极老 git 回落 `git reset HEAD`。
   * 不在暂存视图内的路径按 no-op 跳过（幂等重击不报错）。
   * @throws git/no-paths、git/session-workspace-unresolved、git/no-repository、
   *   git/git-error、git/timeout。
   */
  @Remote
  async unstage(paths: string[], signal?: AbortSignal): Promise<UnstageResult> {
    const startedAt = Date.now()
    try {
      const result = await this.mutations.unstage(paths, signal)
      logWrite(this.logger, 'unstage', { pathCount: result.unstaged, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'unstage', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 丢弃变更（spec §1.3 [清单 12]；权限 C，UI 二次确认）：三重守卫——acknowledged
   * 旗标、baseRevision 乐观并发、最新 status 逐路径路由（untracked → clean -fd /
   * worktree 变更 → restore / 仅暂存条目与冲突文件 → 整请求拒绝 git/bad-request）。
   * 任一守卫失败零命令执行。
   * @throws git/no-paths、git/bad-request、git/session-workspace-unresolved、
   *   git/no-repository、git/git-error、git/timeout。
   */
  @Remote
  async discard(options: DiscardOptions, signal?: AbortSignal): Promise<DiscardResult> {
    const startedAt = Date.now()
    try {
      const result = await this.mutations.discard(options, signal)
      logWrite(this.logger, 'discard', { pathCount: result.discarded, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'discard', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 提交（spec §1.4 [清单 11/15/17/19/20/55/64]；权限 C）：全守卫链（仓库发现 →
   * 身份 → 空提交保护 → 消息校验，非阻断 Conventional 警示）→ `git commit -F -`
   * （message 经 stdin；amend 空消息 = --no-edit 两路；skipHooks = --no-verify，
   * 否则保留用户 hook）→ hook 失败分类 git/hook-failed（stderr 脱敏进 details）→
   * 回读最终 message 回带（commit-msg hook 改写后的权威值）。超时 commitTimeoutMs
   * 熔断 ⇒ git/timeout { op:'commit' }。
   * @throws git/no-repository、git/identity-missing、git/nothing-staged、
   *   git/empty-message、git/hook-failed、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  @Remote
  async commit(options: CommitOptions, signal?: AbortSignal): Promise<CommitResult> {
    const startedAt = Date.now()
    try {
      const result = await this.commitEngine.commit(options, signal)
      // 日志不含 message 正文（spec §1.0.6）。
      logWrite(this.logger, 'commit', {
        durationMs: Date.now() - startedAt,
        amend: options.amend,
        skipHooks: options.skipHooks,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'commit', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 推送（spec §1.5 [清单 25/26/67]；权限 C）：detached/unborn 拒绝 → 上游三态判定
   * （无上游/gone → set-upstream 路径，gone 态严禁 rev-list；正常 → rev-list diverged
   * 前置检测）→ 显式 remote + 全量 refspec 执行（禁裸 push——B3）→ stderr 脱敏分类
   * （authentication/network/push-rejected/diverged）。超时 networkTimeoutMs 熔断。
   * @throws git/no-branch、git/no-upstream、git/no-remote、git/choose-remote、
   *   git/diverged、git/push-rejected、git/auth-failed、git/session-workspace-unresolved、
   *   git/no-repository、git/timeout、git/git-error。
   */
  @Remote
  async push(options: PushOptions, signal?: AbortSignal): Promise<PushResult> {
    const startedAt = Date.now()
    try {
      const result = await this.remoteOps.push(options, signal)
      logWrite(this.logger, 'push', {
        durationMs: Date.now() - startedAt,
        setUpstream: result.setUpstreamUsed,
        remote: result.remote,
        branch: result.branch,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'push', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 拉取 --ff-only（spec §1.6 [清单 25]；权限 C）：detached/unborn 拒绝 → 脏区拒绝
   * （git/dirty-worktree，任务口径）→ 上游三态（no-upstream/gone ⇒ git/no-upstream）→
   * diverged 预检 ⇒ git/pull-diverged → `git pull --ff-only --no-rebase`（ff 拒绝
   * 运行期重读计数落同码）。
   * @throws git/no-branch、git/dirty-worktree、git/no-upstream、git/pull-diverged、
   *   git/auth-failed、git/session-workspace-unresolved、git/no-repository、
   *   git/timeout、git/git-error。
   */
  @Remote
  async pull(signal?: AbortSignal): Promise<PullResult> {
    const startedAt = Date.now()
    try {
      const result = await this.remoteOps.pull(signal)
      logWrite(this.logger, 'pull', { durationMs: Date.now() - startedAt, remote: result.remote })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'pull', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 获取（spec §1.6 [清单 25/54]；权限 B）：remote 解析链（显式入参 → 上游 remote
   * （gone 也读）→ origin → 唯一 → git/no-remote / git/choose-remote）→
   * `git fetch --prune <remote>`；pruned = stderr/stdout 有 `[deleted]` prune 行。
   * @throws git/no-remote、git/choose-remote、git/auth-failed、
   *   git/session-workspace-unresolved、git/no-repository、git/timeout、git/git-error。
   */
  @Remote
  async fetch(options: FetchOptions, signal?: AbortSignal): Promise<FetchResult> {
    const startedAt = Date.now()
    try {
      const result = await this.remoteOps.fetch(options, signal)
      logWrite(this.logger, 'fetch', { durationMs: Date.now() - startedAt, remote: result.remote, pruned: result.pruned })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'fetch', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * AI 生成提交信息（spec §1.7 [清单 16/17]；权限 B）：nothing-staged 前置 →
   * staged diff（DiffEngine 'staged' 路）→ prompt 裁剪四上限（20 文件/8 段/总
   * 12k 字符/单文件 2k）→ 路由解析（Config.llmProvider/llmModel → 最近
   * request/header 捕获 → git/llm-route-unresolved）→ session-title-llm 六步
   * 范式调用（llmMaxInputBytes 硬顶自检 + `using deadline(signal, llmTimeoutMs)`
   * + prepareCall + BlockAssembler，purpose 省略）→ validateCommitMessage 规则表
   * → conventional 标志（不阻断，[清单 17] client 提示）。不写仓库状态（幂等读）。
   * @throws git/nothing-staged、git/no-repository、git/session-workspace-unresolved、
   *   git/llm-route-unresolved、git/llm-failed {stage:'trim'|'call'|'parse'}、
   *   git/timeout、git/git-error。
   */
  @Remote
  async generateCommitMessage(signal?: AbortSignal): Promise<GeneratedCommitMessage> {
    const startedAt = Date.now()
    try {
      const result = await this.messageGen.generate(signal)
      // 成功日志在引擎内已记（含 conventional/filesConsidered）；此处补服务面耗时。
      logRead(this.logger, 'generateCommitMessage', { durationMs: Date.now() - startedAt })
      return result
    } catch (cause) {
      logFailure(this.logger, 'generateCommitMessage', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 提交分页（spec §1.8 log [清单 31]；权限 A）：`git log --topo-order -n <limit+1>
   * --skip <skip>`——over-fetch 判 hasMore（A 级 ZCode 语义）、limit 钳 [1, logMaxLimit]、
   * skip ≥ 0；unborn HEAD 返回空页不抛错（[清单 64]）。refs 装饰不进 log（refs()
   * 单独取，client 合并）。host 无缓存，幂等。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async log(options: LogOptions, signal?: AbortSignal): Promise<LogPage> {
    const startedAt = Date.now()
    const page = await this.graph.log(options, signal)
    logRead(this.logger, 'log', {
      count: page.commits.length,
      hasMore: page.hasMore,
      skipUsed: page.skipUsed,
      limitUsed: page.limitUsed,
      durationMs: Date.now() - startedAt,
    })
    return page
  }

  /**
   * refs 快照（spec §1.8 refs [清单 31]；权限 A）：单次 for-each-ref（三类前缀 +
   * upstream:track 一次取回）+ symbolic-ref/rev-parse 并行判 head 三态。
   * host 无缓存，幂等。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async refs(signal?: AbortSignal): Promise<RefsSnapshot> {
    const startedAt = Date.now()
    const snapshot = await this.graph.refs(signal)
    logRead(this.logger, 'refs', {
      refCount: snapshot.refs.length,
      head: snapshot.head.kind,
      durationMs: Date.now() - startedAt,
    })
    return snapshot
  }

  /**
   * 提交详情（workflow 任务口径 getCommitDetail；spec §1.8 show [清单 32/33]，权限 A）：
   * 元数据（log -1）+ 文件清单/单文件 patch（DiffEngine.commitDiff——merge 按第一父、
   * 根提交 --root、预算语义同 §1.2）+ 指向该提交的 refs 过滤。host 无缓存，幂等。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（修订无效/记录契约破坏；单文件 patch 失败降级 patch:null 不炸整体）。
   */
  @Remote
  async getCommitDetail(options: ShowOptions, signal?: AbortSignal): Promise<CommitDetail> {
    const startedAt = Date.now()
    const detail = await this.graph.getCommitDetail(options, signal)
    logRead(this.logger, 'getCommitDetail', {
      oid: detail.commit.oid.slice(0, 12),
      pathCount: detail.files.length,
      refCount: detail.refs.length,
      totalTruncated: detail.totalTruncated,
      durationMs: Date.now() - startedAt,
    })
    return detail
  }

  /**
   * 写后失效统一入口：status 缓存作废 + R3 帧。host 对 log/refs/show **无缓存**
   * （spec §1.9 三行无失效列；F7 提交图数据层模块核实无 host 侧缓存需并入）——
   * client 侧的 log/refs/show 缓存失效由其状态订阅承担（branch.oid 变化 → reload，
   * 见 client git-graph-store）。
   */
  private afterWrite(): void {
    this.statusEngine.invalidate()
    this.statusWatcher.notifyMutation()
  }

  /**
   * 状态流（spec §2 host 推送契约的 v1 落地面；M9 任务口径 R1–R6）：事件转发
   * allowlist 无 `git/*`（spec §2.1），「推送」以 typert stream 流帧承载——client
   * 打开一条逻辑流，host 推 `GitStatusFrame`（R1 initial / R2 变化才推 / R3 mutation
   * （写模块经 {@link notifyStatusMutation} 接线）/ R4 poll 兜底 / R5 manual 上行）；
   * fs watch 不可用即 R6 降级纯轮询（仅 warn 一次）。错误以帧通告不断流
   * （`GitFrameError` 投影）；载波终止（client dispose/断连）即订阅清理，
   * 引用计数归零关全部 watch 与定时器。
   *
   * 上行命令（R5）：client 经流的 uplink 通道发 `{type:'refresh'}`（GitFollowCommand）→
   * 重算并**无条件**推一帧 reason='manual'；未知 type 忽略（前向兼容）。
   * strict 描述符注册后 uplink 项由生成 codec 校验；SRC 反射兜底时经 JSON 安全检查后
   * 以 unknown 到达，由 {@link isGitFollowCommand} 判别。
   *
   * 直接调用（测试/进程内）没有 `this.ctx.invocation`——只有帧流，无上行命令。
   *
   * 形状注记：stream 方法的返回类型**直接**写 `RemoteStream<Out, In>`（不可 Promise
   * 包装——生成器 analyzer 只解 Iterable/AsyncIterable/RemoteStream 三种直接返回，
   * dsh 树 workspace-files `changes` 同形；本机 build 实测 Promise 包装会报
   * 「stream Remote methods must return Iterable/AsyncIterable/RemoteStream」）。
   */
  @Remote({ mode: 'stream' })
  followStatus(signal?: AbortSignal): RemoteStream<GitStatusFrame, GitFollowCommand> {
    const stream = this.statusWatcher.follow(signal)
    this.pumpFollowCommands()
    return stream
  }

  /** R5 上行命令泵：读本流 uplink（单消费者），`refresh` → watcher.refresh()。 */
  private pumpFollowCommands(): void {
    const invocation = (this.ctx as unknown as { invocation?: GitInvocationFace }).invocation
    if (invocation === undefined) return
    let upstream: AsyncIterable<unknown>
    try {
      upstream = invocation.uplink()
    } catch {
      // uplink 是单消费者面；已被占用/不可用时放弃（帧流不受影响）。
      return
    }
    void (async () => {
      for await (const item of upstream) {
        if (isGitFollowCommand(item)) this.statusWatcher.refresh()
      }
    })().catch(() => {
      // 载波失败/半关闭：流终止由 invocation.signal 与帧流生成器结束承担，无需处理。
    })
  }

  /**
   * 宿主 llm 能力切片的结构化读取（`ctx.get('llm')`；readFsFace 同款先例）。
   * llm 缺席或形状不符 → undefined（generateCommitMessage 调用时落
   * git/llm-failed call），不阻断服务激活。
   */
  private static readLlmFace(ctx: Context): GitLlmFace | undefined {
    try {
      const candidate: unknown = (ctx as unknown as { get(key: string): unknown }).get('llm')
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const face = candidate as Partial<GitLlmFace>
      if (typeof face.prepareCall !== 'function') return undefined
      return candidate as GitLlmFace
    } catch {
      return undefined
    }
  }

  /** 供测试与后续写操作模块复用的 mutation 失效入口（R3，不影响 wire 面）。 */
  notifyStatusMutation(): void {
    this.statusWatcher.notifyMutation()
  }

  /** 供测试与后续模块复用的 watcher 引擎入口（观测面/接线用，不影响 wire 面）。 */
  watcherOf(): StatusWatcher {
    return this.statusWatcher
  }

  /**
   * 宿主 fs 能力切片的结构化读取（`ctx.get('fs')`；同 constructor 里 subprocess 的
   * 先例）。fs 缺席或形状不符 → undefined（watcher 走 R6 纯轮询），不阻断服务激活。
   */
  private static readFsFace(ctx: Context): GitFsWatchFace | undefined {
    try {
      const candidate: unknown = (ctx as unknown as { get(key: string): unknown }).get('fs')
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const face = candidate as Partial<GitFsWatchFace>
      if (typeof face.resolve !== 'function' || typeof face.watch !== 'function') return undefined
      return candidate as GitFsWatchFace
    } catch {
      return undefined
    }
  }

  /** 供测试与后续模块复用的工作区解析入口（不影响 wire 面）。 */
  resolveWorkspace(): Promise<GitWorkspaceResolution> {
    return this.workspace.resolve()
  }

  /** 供测试与后续模块复用的四实例入口（不影响 wire 面）。 */
  runnerOf(commandClass: GitCommandClass): GitRunner {
    return this.runners[commandClass]
  }

  /** 供测试与后续模块复用的 status 引擎入口（失效用，不影响 wire 面）。 */
  invalidateStatusCache(): void {
    this.statusEngine.invalidate()
  }

  /** 供测试与 show 接线模块复用的 diff 引擎入口（commitDiff 用，不影响 wire 面）。 */
  engineOf(): DiffEngine {
    return this.diffEngine
  }
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}

/** 域错误码提取（logFailure 用；非域错误按 gateway/internal 口径落日志）。 */
function errorCodeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code
  }
  return 'gateway/internal'
}

/** 本服务感知的 Remote 调用上下文切片（gateway 经 `ctx.extend({invocation})` 注入；直接调用时 undefined）。 */
interface GitInvocationFace {
  /** 本流的上行迭代（单消费者）；strict codec 校验或 SRC JSON 安全检查后的项。 */
  uplink(): AsyncIterable<unknown>
}

/** R5 上行命令判别（strict codec 缺席时的形状闸；未知形状忽略——前向兼容）。 */
function isGitFollowCommand(item: unknown): item is GitFollowCommand {
  return typeof item === 'object' && item !== null
    && (item as { type?: unknown }).type === 'refresh'
}

export default GitService
