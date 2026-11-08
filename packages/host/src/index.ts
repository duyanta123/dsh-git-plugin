/**
 * dsh-gitkit — host 半（node 侧）入口。
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
 * v2 批次一（2026-11-08，docs/v2-implementation-plan.md §3）接线：RefsAdminEngine
 * （refs-admin.ts，分支/标签/remote/worktree 管理面，[清单 23/30/57/62/68]）+
 * `@Remote branchCreate()/branchSwitch()/branchDelete()/tagCreate()/tagDelete()/
 * remoteList()/worktreeList()/worktreeAdd()/worktreeRemove()`（九方法，REMOTE_METHODS
 * 16→25）+ push 的 force/acknowledged/remote 入参（[清单 27/57]，remote-ops.ts 扩展）
 * + Config autoFetchIntervalMs（[清单 58] 定时 fetch，D6=B 默认 300_000、0=关；
 * Cordis effect 挂 interval，失败仅 warn 不投 UI）。
 * v2 批次二（2026-11-08，docs/v2-implementation-plan.md §4）接线：BlameEngine
 * （blame.ts，[清单 34] blame --porcelain + D3=B 的 -L 区间分片与单次 50_000 行
 * 硬顶/outputMaxBytes 互相校验）+ TimeTravelEngine（time-travel.ts，[清单 37]
 * cherry-pick/revert/reset/abortOperation，write runner 档 + 三重守卫 + 中间态
 * 探测）+ GraphEngine 扩 log 过滤参数（[清单 35/60]）与 compareBranches（[清单 36]，
 * revListCounts 提共享 rev-count.ts）+ `@Remote blame()/compareBranches()/cherryPick()/
 * revert()/reset()/abortOperation()`（六方法，REMOTE_METHODS 25→31）+ 域码四码
 * （blame-oversized/merge-conflict/unknown-revision/operation-in-progress）+
 * bad-request reason += 'follow-without-path'。
 * v2 批次三（2026-11-08，docs/v2-implementation-plan.md §5）接线：StagingPatchEngine
 * （staging-patch.ts，[清单 10] `apply --cached --recount` 两态 stage/unstage——D7=B）
 * + StashEngine（stash.ts，[清单 14] push/list/pop/drop——D4=B includeUntracked 显式
 * boolean 缺省 true）+ GuardScanEngine（guard-scan.ts，[清单 21/22] staged 护栏扫描
 * ——密钥模式表自研零新依赖、redactedMatch 脱敏；D5=A secret 硬阻断由 CommitEngine
 * 守卫链消费）+ DiagnosticsEngine（diagnostics.ts，[清单 56] autocrlf/eol/CRLF 抽样）
 * + CommitEngine 扩 trailers（[清单 18]）与 process 捕获（[清单 63]）+ `@Remote
 * stagePatch()/stashPush()/stashList()/stashPop()/stashDrop()/scanStaged()/
 * repoDiagnostics()`（七方法，REMOTE_METHODS 31→38）+ 域码三码（stage-patch-failed/
 * stash-not-found/commit-blocked）+ bad-request reason += 'malformed-trailer' +
 * Config guardLargeFileBytes/guardBuildPatterns/guardSecretPatterns。
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
import { BlameEngine } from './blame.ts'
import { TimeTravelEngine } from './time-travel.ts'
import { RefsAdminEngine } from './refs-admin.ts'
import { StagingPatchEngine } from './staging-patch.ts'
import { StashEngine } from './stash.ts'
import { GuardScanEngine, DEFAULT_BUILD_PATTERNS, DEFAULT_GUARD_LARGE_FILE_BYTES } from './guard-scan.ts'
import { DiagnosticsEngine } from './diagnostics.ts'
import { StatusEngine, STATUS_CACHE_TTL_MS } from './status.ts'
import { StatusWatcher, DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_INTERVAL_MS } from './watcher.ts'
import type { GitFsWatchFace } from './watcher.ts'
import { WorkspaceResolver } from './workspace.ts'
import type { GitSessionEventHost, GitWorkspaceResolution } from './workspace.ts'
import type {
  AbortOperationResult, BlameOptions, BlameResult, BranchCompareResult, BranchCreateOptions, BranchCreateResult,
  BranchDeleteOptions, BranchDeleteResult, BranchSwitchResult, CherryPickOptions,
  CommitDetail, CommitOptions, CommitResult, CommitScanResult, CompareOptions, DiffResult, DiffScope,
  DiscardOptions, DiscardResult, FetchOptions, FetchResult, GeneratedCommitMessage, GitFollowCommand, GitIdentityResult,
  GitIdentityScope, GitPingResult, GitStatusFrame, GitStatusSnapshot, LogOptions, LogPage, PullResult, PushOptions,
  PushResult, RefsSnapshot, RepoDiagnostics, RemoteListResult, ResetOptions, RevertOptions, ShowOptions,
  StagePatchOptions, StagePatchResult, StageResult, StashDropOptions, StashListResult, StashOpResult,
  StashPopOptions, StashPushOptions, TagCreateOptions, TagCreateResult, TagDeleteResult,
  TimeTravelResult, UnstageResult, WorktreeAddOptions, WorktreeAddResult, WorktreeListResult, WorktreeRemoveOptions, WorktreeRemoveResult,
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
export const PLUGIN_NAME = 'dsh-gitkit'

/**
 * serviceKey = Cordis 注册名 = wire namespace（端点 `git/ping` 等）。
 * 必须通过 `isTypertRemoteSegment`（`/^[A-Za-z0-9_$.-]+$/`）校验 —— map §2.1。
 * 注意：wire 值同时以字面量内联在 super(ctx, 'git')（generator 契约）。
 */
export const SERVICE_KEY = 'git'

/** 定时 fetch 默认间隔毫秒（v2 批次一 [清单 58]，D6=B 拍板默认开启；0 = 关闭）。 */
export const DEFAULT_AUTO_FETCH_INTERVAL_MS = 300_000

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
  /**
   * 定时 fetch 间隔毫秒（v2 批次一 [清单 58]，D6=B 拍板默认**开启**：默认 300_000，
   * 0 = 关闭）。到点后台 fetch（upstream 三态推导复用 remote-ops 缺省解析链）；
   * 失败仅 logger.warn 不投 UI 错误（后台任务不得弹窗打扰），成功走 afterWrite
   * 语义刷新 behind（R3 帧，R2 去重下净零变化不推帧）。
   */
  autoFetchIntervalMs?: number
  /**
   * 提交护栏大文件阈值字节（v2 批次三 [清单 21]，方案 §5.5：默认 1 MiB）。
   * scanStaged 的 large-file 违规判定；commit 的 secret 硬阻断不消费此值。
   */
  guardLargeFileBytes?: number
  /**
   * 提交护栏构建产物目录模式表（v2 批次三 [清单 21]，方案 §5.5：默认常见产物目录表
   * DEFAULT_BUILD_PATTERNS）。段前缀匹配（可叠加默认表）；空串条目被忽略。
   */
  guardBuildPatterns?: string[]
  /**
   * 提交护栏密钥模式**用户叠加表**（v2 批次三 [清单 22]，方案 §5.5「可叠加」）。
   * 每条为**固定串**（大小写不敏感子串扫描——非正则，防 ReDoS/非法正则注入；登记为
   * 方案「模式表可叠加」的施工解释）。内置高置信度模式表（SECRET_PATTERNS）不受
   * 本项影响——本项只叠加。
   */
  guardSecretPatterns?: string[]
}

/** `ping`/`identity`/`status`/`diff`/`followStatus`/写操作之外的可读常量：本服务当前端点清单（诊断用）。 */
export const REMOTE_METHODS = ['ping', 'identity', 'status', 'diff', 'followStatus', 'stage', 'unstage', 'discard', 'commit', 'push', 'pull', 'fetch', 'generateCommitMessage', 'log', 'refs', 'getCommitDetail', 'branchCreate', 'branchSwitch', 'branchDelete', 'tagCreate', 'tagDelete', 'remoteList', 'worktreeList', 'worktreeAdd', 'worktreeRemove', 'blame', 'compareBranches', 'cherryPick', 'revert', 'reset', 'abortOperation', 'stagePatch', 'stashPush', 'stashList', 'stashPop', 'stashDrop', 'scanStaged', 'repoDiagnostics'] as const

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
    autoFetchIntervalMs: z.number().step(1).min(0).max(86_400_000).default(DEFAULT_AUTO_FETCH_INTERVAL_MS),
    guardLargeFileBytes: z.number().step(1).min(1).max(1024 * 1024 * 1024).default(DEFAULT_GUARD_LARGE_FILE_BYTES),
    guardBuildPatterns: z.array(z.string()).default([...DEFAULT_BUILD_PATTERNS]),
    guardSecretPatterns: z.array(z.string()).default([]),
  })

  private readonly runners: Record<GitCommandClass, GitRunner>
  private readonly statusEngine: StatusEngine
  private readonly diffEngine: DiffEngine
  private readonly mutations: MutationEngine
  private readonly commitEngine: CommitEngine
  private readonly remoteOps: RemoteOpsEngine
  private readonly refsAdmin: RefsAdminEngine
  private readonly blameEngine: BlameEngine
  private readonly timeTravel: TimeTravelEngine
  private readonly stagingPatch: StagingPatchEngine
  private readonly stash: StashEngine
  private readonly guardScan: GuardScanEngine
  private readonly diagnostics: DiagnosticsEngine
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
    // （commitEngine 的构造在 this.logger 赋值之后——护栏守卫需要 logger。）
    this.mutations = new MutationEngine(this.runners.write, this.statusEngine)
    // 远端同步引擎（spec §1.5/§1.6 + M6 任务口径）：守卫/预检走只读实例与 fresh
    // 扫描，push/pull/fetch 执行走 network 实例（networkTimeoutMs 熔断）。
    this.remoteOps = new RemoteOpsEngine(this.runners.network, this.runners.readonly, this.statusEngine)
    // refs 管理引擎（v2 批次一 [清单 23/30/57/62/68]）：变更类走 write 实例（hooks
    // 不相关但 WRITE_PREFIX 前缀集一致），查询/预检/回读走只读实例 + fresh 扫描（脏区
    // 守卫）+ workspace 探测（repoRoot 发现，graph.ts 同款）。
    this.refsAdmin = new RefsAdminEngine(this.runners.write, this.runners.readonly, this.statusEngine, this.workspace)
    // blame 引擎（v2 批次二 [清单 34]）：只读实例 + workspace 探测 + outputMaxBytes
    // 互相校验（单次 50_000 行硬顶 = min(50_000, floor(outputMaxBytes/128))）。
    this.blameEngine = new BlameEngine(this.runners.readonly, this.workspace, {
      outputMaxBytes: resolved.outputMaxBytes,
    })
    // 时间旅行引擎（v2 批次二 [清单 37]）：执行走 write 实例（fastTimeoutMs——§4.5
    // 定死「写 runner 档」，commitTimeoutMs 只属 commit runner），预检/回读走只读
    // 实例，守卫走 fresh 扫描（acknowledged/baseRevision/中间态/no-branch）。
    this.timeTravel = new TimeTravelEngine(this.runners.write, this.runners.readonly, this.statusEngine)
    this.logger = (ctx as unknown as { logger: GitLoggerFace }).logger
    // commit 引擎（spec §1.4 + v2 批次三 [清单 18/22/63]）：trailers 组装、process
    // 捕获与 secret 硬阻断守卫（guard = Config 护栏三键——scanStaged 预检面共用）。
    // 兜底归一：真宿主由 schemastery 默认值填充；直接构造（测试）不带 schema 面时
    // 以常量默认兜底（schemastery .default 只在键缺席时生效，显式 undefined 不触发）。
    const guardOptions = {
      largeFileBytes: resolved.guardLargeFileBytes ?? DEFAULT_GUARD_LARGE_FILE_BYTES,
      buildPatterns: resolved.guardBuildPatterns ?? [...DEFAULT_BUILD_PATTERNS],
      secretPatterns: resolved.guardSecretPatterns ?? [],
    }
    this.commitEngine = new CommitEngine(this.runners.commit, this.runners.readonly, this.workspace, {
      logger: this.logger,
      guard: guardOptions,
    })
    // hunk/行级暂存引擎（v2 批次三 [清单 10]，D7=B 两态）：执行走 write 实例、
    // repoRoot probe 走只读实例（staging-patch.ts）。
    this.stagingPatch = new StagingPatchEngine(this.runners.write, this.runners.readonly, this.workspace, {
      logger: this.logger,
    })
    // stash 引擎（v2 批次三 [清单 14]，D4=B）：push/pop/drop 走 write 实例、list 与
    // 序号预检走只读实例、守卫走 fresh 扫描（stash.ts）。
    this.stash = new StashEngine(this.runners.write, this.runners.readonly, this.statusEngine, this.workspace, {
      logger: this.logger,
    })
    // 提交护栏扫描引擎（v2 批次三 [清单 21/22]）：只读实例（cat-file 面）+ Config
    // 护栏三键（guard-scan.ts；模式表自研零新依赖，redactedMatch 脱敏）——同一
    // guardOptions（与 commit 守卫共用一份归一后的参数源）。
    this.guardScan = new GuardScanEngine(this.runners.readonly, this.workspace, {
      ...guardOptions,
      logger: this.logger,
    })
    // 仓库诊断引擎（v2 批次三 [清单 56]）：只读实例 + node fs 顶层 CRLF 抽样
    // （diagnostics.ts）。
    this.diagnostics = new DiagnosticsEngine(this.runners.readonly, this.workspace, {
      logger: this.logger,
    })
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
    // 定时 fetch（v2 批次一 [清单 58]，D6=B）：Cordis effect 内挂 interval——句柄在
    // effect 体注册、cleanup 返回给宿主（fiber 卸载时清理，无模块级句柄纪律）；
    // 0 = 关闭。到点后台 fetch（{@link autoFetchOnce}），失败仅 warn 不投 UI。
    if (resolved.autoFetchIntervalMs > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => { void this.autoFetchOnce() }, resolved.autoFetchIntervalMs)
        timer.unref()
        this.autoFetchTimer = timer
        return () => {
          clearInterval(timer)
          if (this.autoFetchTimer === timer) this.autoFetchTimer = null
        }
      })
    }
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
   * 推送（spec §1.5 [清单 25/26/67]；权限 C）：force 双闸守卫（v2 批次一 [清单 27]，
   * force=true 需 acknowledged 且跳过 diverged 预检——语义即覆盖远端）→ detached/unborn
   * 拒绝 → 上游三态判定（无上游/gone → set-upstream 路径，gone 态严禁 rev-list；正常
   * 且非 force → rev-list diverged 前置检测）→ 显式 remote（options.remote 直查存在性，
   * 缺省走解析链）+ 全量 refspec 执行（禁裸 push——B3）→ stderr 脱敏分类
   * （authentication/network/push-rejected/diverged）。超时 networkTimeoutMs 熔断。
   * @throws git/bad-request 'force-unacknowledged'、git/no-branch、git/no-upstream、
   *   git/no-remote、git/choose-remote、git/diverged、git/push-rejected、git/auth-failed、
   *   git/session-workspace-unresolved、git/no-repository、git/timeout、git/git-error。
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

  // ── v2 批次一：refs 管理面（[清单 23/30/57/62/68]；引擎半 = refs-admin.ts） ──

  /**
   * 新建分支（[清单 23]；权限 C）：`git branch -- <name> [<from>]`（checkout 时追加
   * `git switch -- <name>`——`switch -c` 位置参数无 `--` 保护，拆两命令）；重名 ⇒
   * git/branch-exists（预检）。oid 为回读值（不信入参）。
   * @throws git/bad-request 'invalid-options'、git/branch-exists、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async branchCreate(options: BranchCreateOptions, signal?: AbortSignal): Promise<BranchCreateResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.branchCreate(options, signal)
      logWrite(this.logger, 'branchCreate', {
        name: result.name,
        checkedOut: result.checkedOut,
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'branchCreate', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 切换分支（[清单 23]；权限 C）：脏区前置拒绝（fresh 扫描 ⇒ git/dirty-worktree，
   * 文案提示 stash——批次三前为纯文案）→ `git switch -- <name>`；to 为回读值。
   * @throws git/bad-request 'invalid-options'、git/dirty-worktree、git/branch-not-found、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async branchSwitch(name: string, signal?: AbortSignal): Promise<BranchSwitchResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.branchSwitch(name, signal)
      logWrite(this.logger, 'branchSwitch', {
        from: result.from ?? '(detached)',
        to: result.to,
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'branchSwitch', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 删除分支（[清单 23]；权限 C）：`git branch -d -- <name>`；未合并 ⇒
   * git/branch-not-merged；force（= `-D`）需 acknowledged（双闸 host 半，零命令守卫）。
   * wasMerged 为删除前的 `merge-base --is-ancestor` 回读。
   * @throws git/bad-request 'force-unacknowledged'、git/branch-not-found、
   *   git/branch-not-merged、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  @Remote
  async branchDelete(options: BranchDeleteOptions, signal?: AbortSignal): Promise<BranchDeleteResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.branchDelete(options, signal)
      logWrite(this.logger, 'branchDelete', {
        name: result.deleted,
        force: options.force === true,
        wasMerged: result.wasMerged,
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'branchDelete', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 新建 tag（[清单 30]；权限 C）：message 非空 = annotated（`-a -m`）；重名 ⇒
   * git/tag-exists（非 force 预检）；force（= `-f` 覆盖）需 acknowledged。oid 为
   * peeled 提交回读值。
   * @throws git/bad-request 'force-unacknowledged'、git/tag-exists、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async tagCreate(options: TagCreateOptions, signal?: AbortSignal): Promise<TagCreateResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.tagCreate(options, signal)
      logWrite(this.logger, 'tagCreate', {
        name: result.name,
        annotated: result.annotated,
        force: options.force === true,
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'tagCreate', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 删除 tag（[清单 30]；权限 C）：`git tag -d -- <name>`；不存在 ⇒ git/tag-not-found。
   * @throws git/bad-request 'invalid-options'、git/tag-not-found、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async tagDelete(name: string, signal?: AbortSignal): Promise<TagDeleteResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.tagDelete(name, signal)
      logWrite(this.logger, 'tagDelete', { name: result.deleted, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'tagDelete', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * remote 列表（[清单 57]；权限 A，只读）：`git remote -v` 行解析（fetch/push 双 url，
   * pushUrl=null = 未显式配置——git 语义下 push 缺省使用 fetch url）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（行解析契约破坏 / 命令失败兜底）。
   */
  @Remote
  async remoteList(signal?: AbortSignal): Promise<RemoteListResult> {
    const startedAt = Date.now()
    const result = await this.refsAdmin.remoteList(signal)
    logRead(this.logger, 'remoteList', { count: result.remotes.length, durationMs: Date.now() - startedAt })
    return result
  }

  /**
   * worktree 列表（[清单 62]；权限 A，只读）：`git worktree list --porcelain` 块解析。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（块解析契约破坏 / 命令失败兜底）。
   */
  @Remote
  async worktreeList(signal?: AbortSignal): Promise<WorktreeListResult> {
    const startedAt = Date.now()
    const result = await this.refsAdmin.worktreeList(signal)
    logRead(this.logger, 'worktreeList', { count: result.worktrees.length, durationMs: Date.now() - startedAt })
    return result
  }

  /**
   * 新建 worktree（[清单 68] per-ticket 写面；权限 C）：branch（检出现有）与
   * newBranch（`-b` 新建）互斥且至少其一（违反 ⇒ git/bad-request 'invalid-options'）；
   * path 已存在非空 / 分支已被另一 worktree 检出 ⇒ git/worktree-failed。branch/head
   * 为新 worktree 内回读值（失败降级 null 不炸整体）。
   * @throws git/bad-request 'invalid-options'、git/worktree-failed、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async worktreeAdd(options: WorktreeAddOptions, signal?: AbortSignal): Promise<WorktreeAddResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.worktreeAdd(options, signal)
      logWrite(this.logger, 'worktreeAdd', {
        path: result.path,
        branch: result.branch ?? '(detached)',
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'worktreeAdd', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 移除 worktree（[清单 68]；权限 C）：`git worktree remove [--force] -- <path>`；
   * 脏 worktree 无 force ⇒ git/worktree-failed（git 自身拒绝，stderr 脱敏进 details）；
   * `--force` 仅随 acknowledged 透传（双闸 host 半，零命令守卫）；path 不存在 ⇒
   * git/worktree-failed。
   * @throws git/bad-request 'force-unacknowledged'、git/worktree-failed、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async worktreeRemove(options: WorktreeRemoveOptions, signal?: AbortSignal): Promise<WorktreeRemoveResult> {
    const startedAt = Date.now()
    try {
      const result = await this.refsAdmin.worktreeRemove(options, signal)
      logWrite(this.logger, 'worktreeRemove', { path: result.removed, force: options.force === true, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'worktreeRemove', errorCodeOf(cause))
      throw cause
    }
  }

  // ── v2 批次二：历史面（[清单 34/35/36/37/60]；引擎半 = blame.ts / time-travel.ts / graph.ts） ──

  /**
   * blame 逐行（[清单 34]；权限 A，只读）：`git blame --porcelain [-L <s>,<e>]
   * [<ref>] -- <path>` 解析为 ranges（同 oid 连续行合并）+ commits。D3=B 分片纪律：
   * 单次 50_000 行硬顶（与 outputMaxBytes 互相校验）——全区超限 ⇒ git/blame-oversized
   * （details.lineCount 引导 client 转 -L 区间分片）；区间超限 ⇒ 同钳（end 截短 +
   * truncated=true）。ref 缺省 = 工作区（未提交行以全零 oid 如实过线）。
   * @throws git/bad-request 'invalid-options'、git/blame-oversized、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async blame(options: BlameOptions, signal?: AbortSignal): Promise<BlameResult> {
    const startedAt = Date.now()
    const result = await this.blameEngine.blame(options, signal)
    logRead(this.logger, 'blame', {
      path: options.path,
      ref: result.ref ?? '(worktree)',
      rangeCount: result.ranges.length,
      lineCount: result.lineCount,
      truncated: result.truncated,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 分支对比（[清单 36]；权限 A，只读）：revListCounts（rev-count.ts 提共享）
   * 双向计数 + `git log --topo-order` 两列 + merge-base；计数与列表长度互检。
   * ahead = compare 独有、behind = base 独有。
   * @throws git/bad-request 'invalid-options'、git/unknown-revision、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async compareBranches(options: CompareOptions, signal?: AbortSignal): Promise<BranchCompareResult> {
    const startedAt = Date.now()
    const result = await this.graph.compareBranches(options, signal)
    logRead(this.logger, 'compareBranches', {
      base: result.base,
      compare: result.compare,
      aheadCount: result.aheadCount,
      behindCount: result.behindCount,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * cherry-pick（[清单 37]；权限 C）：discard 三重守卫同款（acknowledged +
   * baseRevision 乐观并发 + fresh 扫描）+ 中间态探测（git/operation-in-progress）+
   * 修订预检（git/unknown-revision）→ `git cherry-pick <oid>`。冲突 ⇒
   * git/merge-conflict（仓库留中间态，错误面板给「放弃操作」调 abortOperation——
   * 完整解决 UI 是 v3 [13]）。
   * @throws git/bad-request、git/operation-in-progress、git/no-branch、
   *   git/unknown-revision、git/merge-conflict、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async cherryPick(options: CherryPickOptions, signal?: AbortSignal): Promise<TimeTravelResult> {
    const startedAt = Date.now()
    try {
      const result = await this.timeTravel.cherryPick(options, signal)
      logWrite(this.logger, 'cherryPick', {
        oid: options.oid.slice(0, 12),
        oldOid: result.oldOid.slice(0, 12),
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'cherryPick', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * revert（[清单 37]；权限 C）：守卫链同 cherryPick → `git revert --no-edit <oid>`
   * （--no-edit 防编辑器挂起）。空 revert ⇒ git/git-error（op 'revert'）；冲突 ⇒
   * git/merge-conflict（op 'revert'）。
   * @throws 同 cherryPick。
   */
  @Remote
  async revert(options: RevertOptions, signal?: AbortSignal): Promise<TimeTravelResult> {
    const startedAt = Date.now()
    try {
      const result = await this.timeTravel.revert(options, signal)
      logWrite(this.logger, 'revert', {
        oid: options.oid.slice(0, 12),
        oldOid: result.oldOid.slice(0, 12),
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'revert', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * reset（[清单 37]；权限 C）：soft/mixed/hard 三档；target null = HEAD（unstage
   * 场景用 mixed）。守卫链同 cherryPick；脏区不拦（hard 的语义即清理，§4.10；UI 侧
   * hard 另走 danger 勾选闸）。
   * @throws git/bad-request、git/operation-in-progress、git/no-branch、
   *   git/unknown-revision、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  @Remote
  async reset(options: ResetOptions, signal?: AbortSignal): Promise<TimeTravelResult> {
    const startedAt = Date.now()
    try {
      const result = await this.timeTravel.reset(options, signal)
      logWrite(this.logger, 'reset', {
        kind: options.kind,
        target: options.target ?? '(HEAD)',
        oldOid: result.oldOid.slice(0, 12),
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'reset', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 放弃中间态操作（[清单 37]；权限 B，幂等安全）：探测 CHERRY_PICK_HEAD /
   * REVERT_HEAD → `git cherry-pick --abort` / `git revert --abort`；无中间态 ⇒
   * 空成功（{ aborted: null }，零命令）。无 acknowledged 闸——abort 是治愈路径。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error。
   */
  @Remote
  async abortOperation(signal?: AbortSignal): Promise<AbortOperationResult> {
    const startedAt = Date.now()
    try {
      const result = await this.timeTravel.abortOperation(signal)
      logWrite(this.logger, 'abortOperation', {
        aborted: result.aborted ?? '(none)',
        durationMs: Date.now() - startedAt,
      })
      // abort 只在清掉中间态时改仓库状态——null 短路也走 afterWrite（幂等失效无害）。
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'abortOperation', errorCodeOf(cause))
      throw cause
    }
  }

  // ── v2 批次三：提交链路与护栏（[清单 10/14/21/22/56]；引擎半 = staging-patch.ts / stash.ts / guard-scan.ts / diagnostics.ts） ──

  /**
   * hunk/行级暂存（[清单 10]；权限 B）：client 组装选中 patch（hunk 头勾选/行级勾选）
   * → `git apply --cached --recount --whitespace=nowarn`（patch 文本走 stdin）；
   * direction='unstage' 追加 `-R` 反向应用（D7=B 两态——staged diff 区同构勾选）。
   * 二进制/模式变更 hunk 前置拒绝（零命令）；patch 与 index 不符 ⇒
   * git/stage-patch-failed（details.stderr 脱敏，提示回落文件级 stage）。
   * @throws git/bad-request 'invalid-options'、git/stage-patch-failed、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async stagePatch(options: StagePatchOptions, signal?: AbortSignal): Promise<StagePatchResult> {
    const startedAt = Date.now()
    try {
      const result = await this.stagingPatch.stagePatch(options, signal)
      logWrite(this.logger, 'stagePatch', {
        path: options.path,
        direction: options.direction ?? 'stage',
        staged: result.staged,
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'stagePatch', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * stash 暂存（[清单 14]；权限 B）：无可 stash 改动 ⇒ git/no-paths（op 'stash'）；
   * `git stash push [-u] [-m msg]`（D4=B：includeUntracked wire 显式 boolean，client
   * 缺省传 true = `-u`）；baseRevision 乐观基线可选传入（非 null 且 ≠ 最新 HEAD ⇒
   * bad-request 'stale-base-revision'，零命令）。写后失效：worktree/index 被重置。
   * @throws git/bad-request 'stale-base-revision'、git/no-paths、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async stashPush(options: StashPushOptions, signal?: AbortSignal): Promise<StashOpResult> {
    const startedAt = Date.now()
    try {
      const result = await this.stash.stashPush(options, signal)
      logWrite(this.logger, 'stashPush', {
        includeUntracked: options.includeUntracked === true,
        hasMessage: typeof options.message === 'string' && options.message !== '',
        durationMs: Date.now() - startedAt,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'stashPush', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * stash 列表（[清单 14]；权限 A，只读）：`git stash list --format` 自定义解析
   * （index = stash@{N} 引用序号；空 stash ⇒ 空数组不抛错）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（行解析契约破坏 / 命令失败兜底）。
   */
  @Remote
  async stashList(signal?: AbortSignal): Promise<StashListResult> {
    const startedAt = Date.now()
    const result = await this.stash.stashList(signal)
    logRead(this.logger, 'stashList', { count: result.stashes.length, durationMs: Date.now() - startedAt })
    return result
  }

  /**
   * stash 弹出（[清单 14]；权限 B）：index 越界/空 stash ⇒ git/stash-not-found；
   * 应用冲突 ⇒ git/merge-conflict（op 'stash-pop'——git 语义冲突时 stash 不丢，UI
   * 明示「应用失败但 stash 保留」）。
   * @throws git/bad-request 'invalid-options'、git/stash-not-found、git/merge-conflict
   *   （op 'stash-pop'）、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  @Remote
  async stashPop(options: StashPopOptions, signal?: AbortSignal): Promise<StashOpResult> {
    const startedAt = Date.now()
    try {
      const result = await this.stash.stashPop(options, signal)
      logWrite(this.logger, 'stashPop', { index: result.index, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'stashPop', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * stash 删除（[清单 14]；权限 C，danger 闸）：acknowledged（零命令守卫）+ index
   * 校验（越界 ⇒ git/stash-not-found）→ `git stash drop stash@{N}`（删除不可恢复）。
   * @throws git/bad-request（'unacknowledged' / 'invalid-options'）、git/stash-not-found、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async stashDrop(options: StashDropOptions, signal?: AbortSignal): Promise<StashOpResult> {
    const startedAt = Date.now()
    try {
      const result = await this.stash.stashDrop(options, signal)
      logWrite(this.logger, 'stashDrop', { index: result.index, durationMs: Date.now() - startedAt })
      this.afterWrite()
      return result
    } catch (cause) {
      logFailure(this.logger, 'stashDrop', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 提交护栏预检（[清单 21/22]；权限 A，只读）：扫 staged 内容——密钥模式
   * （token 格式/PEM 头/.env 键值，模式表自研零新依赖 + Config.guardSecretPatterns
   * 叠加）+ 大文件阈值（guardLargeFileBytes 默认 1 MiB）+ 构建产物目录
   * （guardBuildPatterns）+ CRLF 混用抽样；violations 分类返回（secret 命中的
   * redactedMatch 已脱敏——不落明文密钥）。blocked = violations 非空；D5=A 豁免
   * 语义 = violations 无 secret 类时可 danger 勾选豁免（client 面）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（清单/cat-file 失败兜底）。
   */
  @Remote
  async scanStaged(signal?: AbortSignal): Promise<CommitScanResult> {
    const startedAt = Date.now()
    const result = await this.guardScan.scanStaged(signal)
    logRead(this.logger, 'scanStaged', {
      blocked: result.blocked,
      violationCount: result.violations.length,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 仓库行尾/编码诊断（[清单 56]；权限 A，只读）：`git config --get
   * core.autocrlf/core.eol` + 顶层文本文件 CRLF 抽样（含 CRLF 文件计数 + 混用清单，
   * 清单封顶）。中文路径由 node fs 原样承载（v1 `-z` 纪律不受影响）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（config 失败兜底）。
   */
  @Remote
  async repoDiagnostics(signal?: AbortSignal): Promise<RepoDiagnostics> {
    const startedAt = Date.now()
    const result = await this.diagnostics.repoDiagnostics(signal)
    logRead(this.logger, 'repoDiagnostics', {
      autocrlf: result.autocrlf ?? '(unset)',
      crlfCount: result.worktreeCrlfCount,
      mixedCount: result.mixedEolFiles.length,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 定时 fetch 的单次执行面（[清单 58] interval 回调复用；测试可直接 await）：
   * 后台 fetch（remote=null 走 upstream 三态缺省解析链，remote-ops 复用）；失败仅
   * logger.warn 不投 UI 错误（后台任务不得弹窗打扰——GCM 弹窗面 README §5 既有注记）；
   * 成功走 afterWrite 语义刷新 behind（R3 帧，R2 去重下净零变化不推帧）。并发防抖：
   * 上一轮未完成则跳过本轮。
   */
  async autoFetchOnce(): Promise<void> {
    if (this.autoFetchInFlight) return
    this.autoFetchInFlight = true
    try {
      const result = await this.remoteOps.fetch({ remote: null })
      logRead(this.logger, 'autoFetch', { remote: result.remote, pruned: result.pruned })
      this.afterWrite()
    } catch (cause) {
      // 后台任务失败面：仅 warn（code 附带），绝不向上抛、不进错误帧/错误面板。
      logFailure(this.logger, 'autoFetch', errorCodeOf(cause))
    } finally {
      this.autoFetchInFlight = false
    }
  }

  private autoFetchInFlight = false
  /** 定时 fetch 的 interval 句柄（真宿主由 ctx.effect 清理；{@link stopAutoFetchTimer} 测试停表用）。 */
  private autoFetchTimer: NodeJS.Timeout | null = null

  /** 供测试停表的入口（真宿主的清理由 ctx.effect 返回的 dispose 承担；不影响 wire 面）。 */
  stopAutoFetchTimer(): void {
    if (this.autoFetchTimer !== null) {
      clearInterval(this.autoFetchTimer)
      this.autoFetchTimer = null
    }
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
