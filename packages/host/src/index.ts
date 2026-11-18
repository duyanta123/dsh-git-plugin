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
 * v2 批次四（2026-11-08，docs/v2-implementation-plan.md §6）接线：AdminRepoEngine
 * （admin-repo.ts，[清单 8] 非仓库目录 git init——前置 rev-parse 复核非仓库态）+
 * SubmoduleEngine（submodule.ts，[清单 61] `git submodule status` 只列不递归双读
 * 归并）+ AuditEngine（audit.ts，[清单 66] 写操作审计环缓冲——**双出口挂钩**：
 * 成功出口（logWrite 处）入环 ok:true、catch 出口（logFailure 处）入环 ok:false+code，
 * 只挂 afterWrite 会漏全部失败审计，§6.5）+ PrEngine（pr.ts，[清单 46/69] gh CLI
 * 载体 D1=A——ghCommand Config 经 resolveExecutable 解析（gitCommand 先例），失败
 * ⇒ git/pr-tool-missing；transport 结构切片只在单测可达，§6.7/§6.10）+
 * MessageGenEngine 扩 generatePrDescription（[清单 46] 六步管线共用 dispatch +
 * [清单 70] 合并策略约定段——PR 模板/CONTRIBUTING/git config merge·pull 探测，
 * 缺失即省略）+ `@Remote initRepository()/submoduleStatus()/auditLog()/
 * generatePrDescription()/createPr()/prForBranch()`（六方法，REMOTE_METHODS 38→44）
 * + 域码三码（init-failed/pr-tool-missing/pr-create-failed）+ Config ghCommand/
 * auditMaxEntries。
 * v3 批次一（2026-11-12，docs/v3-implementation-plan.md §3）接线：ConflictsEngine
 * （conflicts.ts，[清单 13] 冲突解决——fresh porcelain v2 扫描 + §3.4 七码×两向命令
 * 矩阵（查表；UD/DU 按 git 2.55 实测语义落表，与方案表格列互换的实测裁决见
 * conflicts.ts 文件头）+ detectOperation 中间态探测提共享）+ TimeTravelEngine 改消费
 * 共享探测（abortOperation 探测面 += MERGE_HEAD/rebase 目录，§3.3）+ `@Remote
 * conflictList()/conflictResolve()/conflictMarkResolved()/operationContinue()`
 * （四方法，REMOTE_METHODS 44→48）+ 域码零新码（operation-in-progress op 联合 +=
 * 'merge'|'rebase'、bad-request reason 联合 += 'path-not-conflicted'|
 * 'conflicts-remaining'）+ operationContinue 执行 env 追加 GIT_EDITOR=true（防
 * sequencer 编辑器挂起）。
 * v3 批次二（2026-11-13，docs/v3-implementation-plan.md §4）接线：MergeRebaseEngine
 * （merge-rebase.ts，[清单 28/29] merge/rebase——守卫链 acknowledged / baseRevision
 * 乐观并发 / rev-parse --verify / detectOperation（批次一共享探测，不重复实现）/
 * dirty-worktree 从严档（git 允许部分脏合并，插件口径要求干净才可预测，README 如实
 * 注明）+ merge ff 三态（auto/ff-only/no-ff；-m msg|--no-edit 命令面防编辑器挂起）+
 * rebase [--onto] upstream（执行 env GIT_EDITOR=true）+ up-to-date 幂等成功 + 冲突 ⇒
 * git/merge-conflict（op 'merge'|'rebase'，conflicted 回读，continue 由批次一
 * operationContinue 驱动））+ `@Remote branchMerge()/rebase()`（两方法，REMOTE_METHODS
 * 48→50）+ 域码零新码。
 * v3 批次三（2026-11-13，docs/v3-implementation-plan.md §5）接线：Agent 工具面
 * （[清单 45]）agent-tools.ts（11 工具定义表——readonly 8 + readwrite 3，plan §5.4
 * 权威表；本地最小结构接口零运行期依赖 dsh-tools；raw JSON Schema 形态；execute
 * 直调引擎层不走 RPC 自调；失败以 `{ok:false,error,message}` 值返回不抛宿主异常）
 * + registerAgentTools 注册面（可选切片 ctx.get('tools') 结构读取——绝不进 static
 * inject；即时尝试 + 'internal/service' 事件跟随 + 宽限期单次降级 warn；逐工具
 * register 包 try/catch——schema 校验拒绝 log + 跳过不炸服务；写工具按批次四双出口
 * 纪律挂 AuditEngine.record，op 名 = 工具名）+ agentToolBlockShellGit 引导 guard
 * （shell 类工具参数的 git 命令模式 deny——文案引导改用 git_* 工具；引导性防线非
 * 安全边界，默认关）+ `@Remote agentToolsStatus()`（观测/verify 断言锚，REMOTE_METHODS
 * 50→51）+ Config agentTools（三档，默认 off——D-γ=A）/agentToolBlockShellGit
 * （默认 false）。零新域码（工具内失败以结果文本表达——plan §5.6）。
 * v3 批次四（2026-11-14，docs/v3-implementation-plan.md §6）接线：检查点·归因·聚合
 * （[清单 39/40/41]，消费式）——SessionWatch（session-watch.ts，构造期挂
 * session/event + session/disposed，workspace.ts 先例；消费 workspace/changes 事件建
 * (sessionId,seq,turn) 环索引 + turn/end 补 endedAt/reason；per-session 环容量
 * Config checkpointMaxTurns 默认 50；事件缺 seq/turn 按降级跳过不炸监听——plan §6.9
 * 残余风险守卫）+ CheckpointsEngine（checkpoints.ts，checkpointList/checkpointDiff/
 * checkpointRestore/attributionGet 四引擎 + hunk→patch 序列化器纯函数；restore =
 * `git apply -R --whitespace=nowarn --unidiff-zero` worktree 应用——DB=A diff hunks
 * 反向应用，私有 tree id 绝不触碰（§0.2-③-1）；逐文件部分成功语义；--unidiff-zero
 * 为施工增补（coarse/整文件替换 hunk 无上下文行，git apply 缺旗标即拒，probe 实测））
 * + workspaceChanges 服务经可选切片 ctx.get('workspaceChanges') 读取（绝不进 static
 * inject——未挂载部署索引照建、summary null / 操作侧 checkpoint-unavailable 降级）
 * + `@Remote checkpointList()/checkpointDiff()/checkpointRestore()/attributionGet()`
 * （四方法，REMOTE_METHODS 51→55）+ 域码一码（checkpoint-unavailable）+
 * checkpointRestore 审计双出口（checkpointDiff/Restore 的 seq 校验硬失败在引擎守卫链）。
 * v3 批次五（2026-11-18，docs/v3-implementation-plan.md §7）接线：自动化（[清单
 * 42/43]，DA=C 会话锚定）——AutomationEngine（automation.ts，构造期挂 session/event
 * + session/disposed——批次四 session-watch.ts 同款接线，消费 GitSessionFace.id 投影）：
 * auto-commit（turn/end reason.kind==='completed' + workspace 已解析 + fresh status
 * 非干净 ⇒ add -A → scanStagedContents（secret 命中 ⇒ git reset 全撤销 + audit——
 * DD=A 不豁免不重试）→ CommitEngine 落提交（模板 `{turn}` 插值或 message-gen AI 路由
 * 未解析/失败回落模板 + trailer 'Auto-committed-by: dsh-git-plugin'；hook 失败放弃
 * + audit；identity-missing 跳过 + audit））+ auto-branch（turn/start per-session
 * 判重 + 当前分支 ∈ autoBranchProtected + fresh status clean ⇒ refsAdmin.branchCreate
 * checkout=true，branch-exists ⇒ 序号后缀递增；非 clean/非受保护 ⇒ 跳过 + log）+
 * 并发纪律（fresh status + detectOperation 双检 + 全局单飞；自动化永不向 UI 报错——
 * §7.4 零新码，结果经 auditLog + automationStatus 双可查）+ `@Remote automationStatus()`
 * （只读观测面，lastActions 环 20 条 newest-first，detail 白名单摘要——REMOTE_METHODS
 * 55→56）+ Config autoCommitMode/autoCommitMessage/autoCommitTemplate/autoBranchMode/
 * autoBranchPrefix/autoBranchProtected 六键（默认全 off/template/['main','master']）。
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
import { ConflictsEngine } from './conflicts.ts'
import { MergeRebaseEngine } from './merge-rebase.ts'
import { registerAgentTools } from './agent-tools.ts'
import type { AgentToolEngines, GitAgentToolsEventHost, GitToolsFace } from './agent-tools.ts'
import { RefsAdminEngine } from './refs-admin.ts'
import { StagingPatchEngine } from './staging-patch.ts'
import { StashEngine } from './stash.ts'
import { GuardScanEngine, DEFAULT_BUILD_PATTERNS, DEFAULT_GUARD_LARGE_FILE_BYTES } from './guard-scan.ts'
import { DiagnosticsEngine } from './diagnostics.ts'
import { AdminRepoEngine } from './admin-repo.ts'
import { SubmoduleEngine } from './submodule.ts'
import { AuditEngine, DEFAULT_AUDIT_MAX_ENTRIES } from './audit.ts'
import { PrEngine, subprocessGhTransport } from './pr.ts'
import { StatusEngine, STATUS_CACHE_TTL_MS } from './status.ts'
import { StatusWatcher, DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_INTERVAL_MS } from './watcher.ts'
import type { GitFsWatchFace } from './watcher.ts'
import { WorkspaceResolver } from './workspace.ts'
import type { GitSessionEventHost, GitWorkspaceResolution } from './workspace.ts'
import { SessionWatch, DEFAULT_CHECKPOINT_MAX_TURNS } from './session-watch.ts'
import type { SessionWatchHost, GitWorkspaceChangesFace } from './session-watch.ts'
import { CheckpointsEngine } from './checkpoints.ts'
import { AutomationEngine, DEFAULT_AUTO_COMMIT_TEMPLATE } from './automation.ts'
import type { AutomationStatusResult } from './types.ts'
import type {
  AbortOperationResult, AgentToolsStatusResult, AgentToolsStatusState, AttributionResult, AuditLogOptions, AuditLogResult, BlameOptions, BlameResult, BranchCompareResult, BranchCreateOptions, BranchCreateResult,
  BranchDeleteOptions, BranchDeleteResult, BranchMergeOptions, BranchMergeResult, BranchSwitchResult, CherryPickOptions,
  CheckpointDiffOptions, CheckpointFileDiff, CheckpointListResult, CheckpointRestoreOptions, CheckpointRestoreResult,
  CommitDetail, CommitOptions, CommitResult, CommitScanResult, CompareOptions, ConflictListResult,
  ConflictMarkOptions, ConflictMarkResult, ConflictResolveOptions, ConflictResolveResult, DiffResult, DiffScope,
  DiscardOptions, DiscardResult, FetchOptions, FetchResult, GeneratedCommitMessage, GitFollowCommand, GitIdentityResult,
  GitIdentityScope, GitPingResult, GitStatusFrame, GitStatusSnapshot, InitResult, LogOptions, LogPage, OperationContinueResult, PrCreateOptions,
  PrDescription, PrLinkResult, PrResult, PullResult, PushOptions,
  PushResult, RebaseOptions, RebaseResult, RefsSnapshot, RepoDiagnostics, RemoteListResult, ResetOptions, RevertOptions, ShowOptions,
  StagePatchOptions, StagePatchResult, StageResult, StashDropOptions, StashListResult, StashOpResult,
  StashPopOptions, StashPushOptions, SubmoduleStatusResult, TagCreateOptions, TagCreateResult, TagDeleteResult,
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
  /**
   * gh CLI 命令名或绝对路径（v2 批次四 [清单 46]，方案 §6.3：D1=A 载体；默认 'gh'，
   * 经 `subprocess.resolveExecutable` 解析——同 gitCommand 先例；解析失败/返回 null
   * ⇒ `git/pr-tool-missing`）。同时是 verify-load 负路径断言的注入点（方案 §6.7：
   * 真宿主进程无 face 注入通道，Config 是唯一可编程面——指向解析不到的固件名 ⇒
   * pr-tool-missing）。
   */
  ghCommand?: string
  /** 写操作审计环缓冲上限条数（v2 批次四 [清单 66]，方案 §6.3：默认 500）。 */
  auditMaxEntries?: number
  /**
   * Agent 工具档位（v3 批次三 [清单 45]，方案 §5.3：默认 `'off'`——工具面默认不改变
   * 既有部署行为，显式开启；D-γ=A 拍板）。`'readonly'` 注册 8 个只读工具、
   * `'readwrite'` 增 3 个写工具（git_stage/git_unstage/git_commit——白名单**不含**
   * merge/rebase/cherry-pick/reset 等历史改写类，§8 DG=A）。注册走 ctx.tools 可选
   * 切片（dsh-tools 未挂载的部署降级不注册，agentToolsStatus.toolsFaceAvailable=false
   * 可查——§5.5/§9）。
   */
  agentTools?: 'off' | 'readonly' | 'readwrite'
  /**
   * shell-git 引导 guard 开关（方案 §5.3：默认 `false`）。true 时对 shell 类工具
   * （名称匹配 bash|shell|pwsh|powershell|cmd——实际词表见 agent-tools.ts
   * SHELL_TOOL_NAME_RE，批次五评审收口对齐）的调用参数做 git 命令模式匹配，命中 ⇒
   * deny（文案引导改用 git_* 工具）。**误报/漏报面如实登记**：多行脚本/间接执行不在
   * 拦截面内；`git -c key=val commit` 形态（旗标后跟配置赋值）会漏拦（批次五评审
   * 登记）——引导性防线非安全边界（README §5 注明）。
   */
  agentToolBlockShellGit?: boolean
  /**
   * 检查点环容量（v3 批次四 [清单 39]，方案 §6.2：per-session 环的条目上限，默认
   * 50）。环只存 (sessionId, seq, turn) 索引行——容量不涉文件内容内存面。
   */
  checkpointMaxTurns?: number
  /**
   * 自动提交档位（v3 批次五 [清单 42]，方案 §7.2：默认 `'off'`——自动化默认不改变
   * 既有部署行为，显式开启；DA=C 会话锚定）。`'turn-end'` = 每回合 turn/end
   * （reason.kind==='completed'）+ 工作区非干净时自动 `add -A` → secret 扫描 →
   * 落一笔署名提交（automation.ts）。
   */
  autoCommitMode?: 'off' | 'turn-end'
  /**
   * 自动提交的消息来源（方案 §7.2：默认 `'template'`——零 LLM 调用；`'ai'` = 每次
   * completed turn 一次 message-gen 路由，未解析/失败回落模板——§7.9 成本注记）。
   */
  autoCommitMessage?: 'ai' | 'template'
  /** 自动提交模板（方案 §7.2：`{turn}` 占位符 = 回合号；默认 'chore: auto-commit session changes (turn {turn})'）。 */
  autoCommitTemplate?: string
  /**
   * 自动开分支档位（v3 批次五 [清单 43]，方案 §7.2：默认 `'off'`）。`'session-start'`
   * = 会话首回合 + 当前分支 ∈ autoBranchProtected + 工作区干净时建切
   * `autoBranchPrefix<短id>`（refs-admin 复用，branch-exists ⇒ 序号后缀递增）。
   */
  autoBranchMode?: 'off' | 'session-start'
  /** 自动分支名前缀（方案 §7.2：默认 'dsh/task-'；后缀 = 会话 id 短 token）。 */
  autoBranchPrefix?: string
  /** 受保护分支表（方案 §7.2：默认 ['main','master']——仅这些分支上才自动开任务分支）。 */
  autoBranchProtected?: string[]
}

/** `ping`/`identity`/`status`/`diff`/`followStatus`/写操作之外的可读常量：本服务当前端点清单（诊断用）。 */
export const REMOTE_METHODS = ['ping', 'identity', 'status', 'diff', 'followStatus', 'stage', 'unstage', 'discard', 'commit', 'push', 'pull', 'fetch', 'generateCommitMessage', 'log', 'refs', 'getCommitDetail', 'branchCreate', 'branchSwitch', 'branchDelete', 'tagCreate', 'tagDelete', 'remoteList', 'worktreeList', 'worktreeAdd', 'worktreeRemove', 'blame', 'compareBranches', 'cherryPick', 'revert', 'reset', 'abortOperation', 'stagePatch', 'stashPush', 'stashList', 'stashPop', 'stashDrop', 'scanStaged', 'repoDiagnostics', 'initRepository', 'submoduleStatus', 'auditLog', 'generatePrDescription', 'createPr', 'prForBranch', 'conflictList', 'conflictResolve', 'conflictMarkResolved', 'operationContinue', 'branchMerge', 'rebase', 'agentToolsStatus', 'checkpointList', 'checkpointDiff', 'checkpointRestore', 'attributionGet', 'automationStatus'] as const

/** `REMOTE_METHODS` 的权威注释口径：16（v1）→25（批次一）→31（批次二）→38（批次三）→44（批次四：+initRepository/submoduleStatus/auditLog/generatePrDescription/createPr/prForBranch）→**48**（v3 批次一：+conflictList/conflictResolve/conflictMarkResolved/operationContinue）→**50**（v3 批次二：+branchMerge/rebase）→**51**（v3 批次三：+agentToolsStatus）→**55**（v3 批次四：+checkpointList/checkpointDiff/checkpointRestore/attributionGet）→**56**（v3 批次五：+automationStatus）。 */

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
    ghCommand: z.string().default('gh'),
    auditMaxEntries: z.number().step(1).min(1).max(10_000).default(DEFAULT_AUDIT_MAX_ENTRIES),
    // v3 批次三 [清单 45]：z.union(z.const) 联合 = dsh 树 gateway websocketCompression
    // 先例（packages/api/gateway/src/index.ts:219 同款三 const 形态）。
    agentTools: z.union([z.const('off'), z.const('readonly'), z.const('readwrite')]).default('off'),
    agentToolBlockShellGit: z.boolean().default(false),
    // v3 批次四 [清单 39]：per-session 检查点环容量（方案 §6.2 默认 50）。
    checkpointMaxTurns: z.number().step(1).min(1).max(10_000).default(DEFAULT_CHECKPOINT_MAX_TURNS),
    // v3 批次五 [清单 42/43]（方案 §7.2）：自动化六键——z.union(z.const) 联合 =
    // agentTools 三档同款先例（index.ts 构造期读取 + automation.ts 归一兜底双保险）。
    autoCommitMode: z.union([z.const('off'), z.const('turn-end')]).default('off'),
    autoCommitMessage: z.union([z.const('ai'), z.const('template')]).default('template'),
    autoCommitTemplate: z.string().default(DEFAULT_AUTO_COMMIT_TEMPLATE),
    autoBranchMode: z.union([z.const('off'), z.const('session-start')]).default('off'),
    autoBranchPrefix: z.string().default('dsh/task-'),
    autoBranchProtected: z.array(z.string()).default(['main', 'master']),
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
  private readonly conflicts: ConflictsEngine
  private readonly mergeRebase: MergeRebaseEngine
  private readonly stagingPatch: StagingPatchEngine
  private readonly stash: StashEngine
  private readonly guardScan: GuardScanEngine
  private readonly diagnostics: DiagnosticsEngine
  private readonly adminRepo: AdminRepoEngine
  private readonly submodule: SubmoduleEngine
  private readonly audit: AuditEngine
  private readonly pr: PrEngine
  private readonly messageGen: MessageGenEngine
  private readonly graph: GraphEngine
  private readonly statusWatcher: StatusWatcher
  private readonly workspace: WorkspaceResolver
  private readonly logger: GitLoggerFace
  /** Agent 工具面运行态（v3 批次三 [清单 45]——agentToolsStatus 投影宿主；registerAgentTools 原地更新）。 */
  private readonly agentToolsState: AgentToolsStatusState
  /** 会话事件观察（v3 批次四 [清单 39/40/41]——检查点环索引宿主；session-watch.ts 构造期挂监听）。 */
  private readonly sessionWatch: SessionWatch
  /** 检查点/归因引擎（v3 批次四——checkpointList/checkpointDiff/checkpointRestore/attributionGet）。 */
  private readonly checkpoints: CheckpointsEngine
  /** 自动化引擎（v3 批次五 [清单 42/43]——auto-commit/auto-branch 的会话事件驱动半）。 */
  private readonly automation: AutomationEngine

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
    // 冲突解决引擎（v3 批次一 [清单 13]）：resolve/mark/continue 执行走 write 实例、
    // fresh porcelain v2 扫描与中间态探测（共享 detectOperation）走只读实例；repo 发现
    // 走 workspace 探测（stash.ts 同款）。fresh 扫描不经 StatusEngine TTL 缓存（§3.2）。
    this.conflicts = new ConflictsEngine(this.runners.write, this.runners.readonly, this.workspace, {
      logger: this.logger,
    })
    // merge/rebase 引擎（v3 批次二 [清单 28/29]）：执行走 write 实例（fastTimeoutMs——
    // §4.5 定死「写 runner 档」；rebase 多提交慢场景实测超时再开独立档，§4.9），预检/
    // 回读走只读实例，守卫走 fresh 扫描 + 批次一共享 detectOperation + 从严档脏区拒绝。
    this.mergeRebase = new MergeRebaseEngine(this.runners.write, this.runners.readonly, this.statusEngine, {
      logger: this.logger,
    })
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
    // 写操作审计环缓冲引擎（v2 批次四 [清单 66]，§6.5 双出口挂钩）：不依赖 git 实例
    // ——服务面在写方法的成功/失败两出口调 record（auditOk/auditFail）。
    // 兜底归一：真宿主由 schemastery 默认值填充；直接构造（测试）不带 schema 面时
    // 以常量默认兜底（commitEngine guardOptions 同款注记）。
    this.audit = new AuditEngine({ maxEntries: resolved.auditMaxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES })
    // 仓库初始化引擎（v2 批次四 [清单 8]）：init 走 write 实例、非仓库态预检/回读
    // 走只读实例（admin-repo.ts）。
    this.adminRepo = new AdminRepoEngine(this.runners.write, this.runners.readonly, this.workspace, {
      logger: this.logger,
    })
    // submodule 状态引擎（v2 批次四 [清单 61]，只列不递归）：只读实例双读归并
    // （submodule.ts）。
    this.submodule = new SubmoduleEngine(this.runners.readonly, this.workspace, {
      logger: this.logger,
    })
    // PR 引擎（v2 批次四 [清单 46/69]，D1=A gh CLI 载体）：transport 结构切片缺省
    // 包真 SubprocessFace（单测可注入假实现——pr.ts；真宿主无 face 注入通道），
    // ghCommand 经 resolveExecutable 解析（gitCommand 先例），超时档 = network。
    this.pr = new PrEngine(subprocessGhTransport(subprocess), this.runners.readonly, this.workspace, {
      ghCommand: resolved.ghCommand ?? 'gh',
      networkTimeoutMs: resolved.networkTimeoutMs,
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
    // Agent 工具面（v3 批次三 [清单 45]，plan §5.5）：可选切片注册 effect——全档位
    // 观测（toolsFaceAvailable 与 mode 解耦），注册面在 'off' 时零工具、guard 关时
    // 零 guard（工具面默认不改变既有部署行为，D-γ=A；宽限期 warn 仅在功能启用时
    // 发声——agent-tools.ts）。state 先建（agentToolsStatus 投影宿主），
    // registerAgentTools 即时尝试 + 'internal/service' 事件跟随 + 宽限期降级 warn
    // （agent-tools.ts 文件头时序注；ctx.tools 结构读取**绝不进 static inject**——
    // 未挂 tools 的部署整个 git 服务拒载是禁区）。写工具的 audit 双出口在工具体内
    // （引擎层无 audit——agent-tools.ts 文件头审计注）。Config 热更 = 非 volatile
    // 改动 ⇒ fiber 重载 ⇒ 构造期重挂（plan §5.5 天然满足）。
    this.agentToolsState = {
      mode: resolved.agentTools ?? 'off',
      toolsFaceAvailable: false,
      registered: [],
    }
    {
      const engines: AgentToolEngines = {
        status: this.statusEngine,
        diff: this.diffEngine,
        graph: this.graph,
        blame: this.blameEngine,
        mutations: this.mutations,
        commit: this.commitEngine,
        guardScan: this.guardScan,
        diagnostics: this.diagnostics,
      }
      const mode = this.agentToolsState.mode
      const blockShellGit = resolved.agentToolBlockShellGit === true
      ctx.effect(() => {
        const registration = registerAgentTools({
          mode,
          blockShellGit,
          engines,
          audit: this.audit,
          host: ctx as unknown as GitAgentToolsEventHost,
          readFace: () => GitService.readAgentToolsFace(ctx),
          logger: this.logger,
          state: this.agentToolsState,
        })
        return () => { registration.dispose() }
      })
    }
    // 会话事件观察（v3 批次四 [清单 39/40/41]，plan §6.4）：构造期挂 session/event +
    // session/disposed（workspace.ts WorkspaceResolver 先例——监听随宿主 fiber 清理，
    // 绝不进 static inject）；per-session 环容量 Config.checkpointMaxTurns。消费面 =
    // workspace/changes 事件（事件自身携带 seq，data.turn）建索引 + turn/end 补
    // endedAt/reason；workspaceChanges 服务经可选切片逐次现读（未挂载部署索引照建、
    // summary null / 操作侧 checkpoint-unavailable 降级——plan §0.2-②③）。
    this.sessionWatch = new SessionWatch(ctx as unknown as SessionWatchHost, {
      maxTurns: resolved.checkpointMaxTurns ?? DEFAULT_CHECKPOINT_MAX_TURNS,
      logger: this.logger,
    })
    // 检查点/归因引擎（v3 批次四）：restore 的 apply 走 write 实例、repoRoot/HEAD 探测
    // 走只读实例（staging-patch 同款 probe 面）、attribution 走 StatusEngine 快照，
    // 环索引走 SessionWatch；readFace 闭包逐次现读（服务 fiber 时序跟随——ctx.tools 同款）。
    this.checkpoints = new CheckpointsEngine(this.runners.write, this.runners.readonly, this.statusEngine, this.workspace, this.sessionWatch, {
      readFace: () => GitService.readWorkspaceChangesFace(ctx),
      logger: this.logger,
    })
    // 自动化引擎（v3 批次五 [清单 42/43]，plan §7.3）：构造期挂 session/event +
    // session/disposed（批次四 session-watch.ts 同款接线——绝不进 static inject），
    // 消费 turn/end(completed) 走 auto-commit、turn/start（per-session 判重）走
    // auto-branch；add -A/reset 走 write 实例、中间态探测走只读实例、fresh status
    // 双检走 StatusEngine、落提交复用 CommitEngine、建切复用 RefsAdminEngine、AI 消息
    // 路由复用 MessageGenEngine（'ai' 档且未解析/失败回落模板）、审计双出口复用
    // AuditEngine（§1-SOP(b)）；guardOptions 与 commit 引擎共用同一份归一参数源；
    // onWrite = 服务面 afterWrite（status 失效 + R3 帧——自动化写后与 RPC 写同刷新）。
    // 并发纪律 + 永不报错（§7.4 零新码）在引擎内收敛——automation.ts 文件头。
    this.automation = new AutomationEngine({
      gitWrite: this.runners.write,
      gitRead: this.runners.readonly,
      status: this.statusEngine,
      workspace: this.workspace,
      commit: this.commitEngine,
      refsAdmin: this.refsAdmin,
      messageGen: this.messageGen,
      audit: this.audit,
      guard: guardOptions,
      onWrite: () => { this.afterWrite() },
    }, ctx as unknown as SessionWatchHost, {
      autoCommitMode: resolved.autoCommitMode ?? 'off',
      autoCommitMessage: resolved.autoCommitMessage ?? 'template',
      autoCommitTemplate: resolved.autoCommitTemplate ?? DEFAULT_AUTO_COMMIT_TEMPLATE,
      autoBranchMode: resolved.autoBranchMode ?? 'off',
      autoBranchPrefix: resolved.autoBranchPrefix ?? 'dsh/task-',
      autoBranchProtected: resolved.autoBranchProtected ?? ['main', 'master'],
      logger: this.logger,
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
      this.auditOk('stage', startedAt, { pathCount: result.staged })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'stage', code)
      this.auditFail('stage', startedAt, code)
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
      this.auditOk('unstage', startedAt, { pathCount: result.unstaged })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'unstage', code)
      this.auditFail('unstage', startedAt, code)
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
      this.auditOk('discard', startedAt, { pathCount: result.discarded })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'discard', code)
      this.auditFail('discard', startedAt, code)
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
      this.auditOk('commit', startedAt, {
        amend: options.amend,
        skipHooks: options.skipHooks,
        trailerCount: options.trailers?.length ?? 0,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'commit', code)
      this.auditFail('commit', startedAt, code)
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
      this.auditOk('push', startedAt, {
        remote: result.remote,
        branch: result.branch,
        setUpstream: result.setUpstreamUsed,
        force: options.force === true,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'push', code)
      this.auditFail('push', startedAt, code)
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
      this.auditOk('pull', startedAt, { remote: result.remote })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'pull', code)
      this.auditFail('pull', startedAt, code)
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
      this.auditOk('fetch', startedAt, { remote: result.remote, pruned: result.pruned })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'fetch', code)
      this.auditFail('fetch', startedAt, code)
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

  // ── 写操作审计双出口挂钩（v2 批次四 [清单 66]，§6.5） ──

  /**
   * 审计**成功出口**入环（ok:true + code=null + op 参数摘要白名单字段——调用点逐 op
   * 传固定标量，不落 message 正文/文件内容/密钥，§6.10）。
   */
  private auditOk(op: string, startedAt: number, summary: Readonly<Record<string, unknown>>): void {
    this.audit.record(op, true, null, Date.now() - startedAt, summary)
  }

  /**
   * 审计**catch 出口**入环（ok:false + 域错误码 + 空摘要——logFailure 处同步挂钩；
   * 只挂 afterWrite 会漏全部失败审计，§6.5）。
   */
  private auditFail(op: string, startedAt: number, code: string): void {
    this.audit.record(op, false, code, Date.now() - startedAt, {})
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
      this.auditOk('branchCreate', startedAt, { name: result.name, checkedOut: result.checkedOut })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'branchCreate', code)
      this.auditFail('branchCreate', startedAt, code)
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
      this.auditOk('branchSwitch', startedAt, { from: result.from ?? '(detached)', to: result.to })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'branchSwitch', code)
      this.auditFail('branchSwitch', startedAt, code)
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
      this.auditOk('branchDelete', startedAt, { name: result.deleted, force: options.force === true, wasMerged: result.wasMerged })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'branchDelete', code)
      this.auditFail('branchDelete', startedAt, code)
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
      this.auditOk('tagCreate', startedAt, { name: result.name, annotated: result.annotated, force: options.force === true })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'tagCreate', code)
      this.auditFail('tagCreate', startedAt, code)
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
      this.auditOk('tagDelete', startedAt, { name: result.deleted })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'tagDelete', code)
      this.auditFail('tagDelete', startedAt, code)
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
      this.auditOk('worktreeAdd', startedAt, { path: result.path, branch: result.branch ?? '(detached)' })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'worktreeAdd', code)
      this.auditFail('worktreeAdd', startedAt, code)
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
      this.auditOk('worktreeRemove', startedAt, { path: result.removed, force: options.force === true })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'worktreeRemove', code)
      this.auditFail('worktreeRemove', startedAt, code)
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
      this.auditOk('cherryPick', startedAt, { oid: options.oid.slice(0, 12), newOid: result.newOid?.slice(0, 12) ?? '(null)' })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'cherryPick', code)
      this.auditFail('cherryPick', startedAt, code)
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
      this.auditOk('revert', startedAt, { oid: options.oid.slice(0, 12), newOid: result.newOid?.slice(0, 12) ?? '(null)' })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'revert', code)
      this.auditFail('revert', startedAt, code)
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
      this.auditOk('reset', startedAt, { kind: options.kind, target: options.target ?? '(HEAD)' })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'reset', code)
      this.auditFail('reset', startedAt, code)
      throw cause
    }
  }

  /**
   * 放弃中间态操作（[清单 37]；权限 B，幂等安全；v3 批次一 §3.3 探测面扩展）：探测
   * CHERRY_PICK_HEAD / REVERT_HEAD / MERGE_HEAD / rebase-merge|apply 目录（共享
   * detectOperation）→ `git cherry-pick|revert|merge|rebase --abort`；无中间态 ⇒
   * 空成功（{ aborted: null }，零命令）。aborted 联合 += 'merge'|'rebase'（§3.2）。
   * 无 acknowledged 闸——abort 是治愈路径。
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
      this.auditOk('abortOperation', startedAt, { aborted: result.aborted ?? '(none)' })
      // abort 只在清掉中间态时改仓库状态——null 短路也走 afterWrite（幂等失效无害）。
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'abortOperation', code)
      this.auditFail('abortOperation', startedAt, code)
      throw cause
    }
  }

  // ── v3 批次一：冲突解决面（[清单 13]；docs/v3-implementation-plan.md §3.3；引擎半 = conflicts.ts） ──

  /**
   * 冲突清单（[清单 13]；权限 A，只读）：fresh porcelain v2 扫描（独立于 status 的
   * 1.5s TTL 缓存——§3.2 解决动作必须基于此刻的世界）unmerged 七码路径 + 中间态探测
   * （共享 detectOperation：伪引用/rebase 目录），组 ConflictEntry[]（code/kind/
   * oursExists/theirsExists 由七码查表推导——UI 禁用不可向）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error。
   */
  @Remote
  async conflictList(signal?: AbortSignal): Promise<ConflictListResult> {
    const startedAt = Date.now()
    const result = await this.conflicts.conflictList(signal)
    logRead(this.logger, 'conflictList', {
      count: result.conflicts.length,
      operation: result.operation ?? '(none)',
      abortable: result.abortable,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 逐文件两向解决（[清单 13]；权限 C）：守卫（全部 path ∈ fresh unmerged 集，违反 ⇒
   * git/bad-request 'path-not-conflicted' 零写命令）→ 逐条按 §3.4 七码×两向命令矩阵
   * 执行 checkout/rm + add（查表——引擎文件内矩阵函数，禁止调用点散布分支）。部分
   * 失败不回滚已成功项（§3.10 逐文件语义，结果如实）。写后失效 + 审计双出口。
   * @throws git/no-paths、git/bad-request（'path-not-conflicted' / 'invalid-options'）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async conflictResolve(options: ConflictResolveOptions, signal?: AbortSignal): Promise<ConflictResolveResult> {
    const startedAt = Date.now()
    try {
      const result = await this.conflicts.conflictResolve(options, signal)
      logWrite(this.logger, 'conflictResolve', {
        resolvedCount: result.resolved.length,
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('conflictResolve', startedAt, { resolvedCount: result.resolved.length })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'conflictResolve', code)
      this.auditFail('conflictResolve', startedAt, code)
      throw cause
    }
  }

  /**
   * 手动编辑后标记已解决（[清单 13]；权限 B）：守卫同 conflictResolve → 逐路径
   * `git add -- <path>`（删除侧用户已删文件 ⇒ `git rm -- <path>`——工作区实况判定）。
   * 写后失效 + 审计双出口。
   * @throws git/no-paths、git/bad-request 'path-not-conflicted'、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async conflictMarkResolved(options: ConflictMarkOptions, signal?: AbortSignal): Promise<ConflictMarkResult> {
    const startedAt = Date.now()
    try {
      const result = await this.conflicts.conflictMarkResolved(options, signal)
      logWrite(this.logger, 'conflictMarkResolved', {
        resolvedCount: result.resolved.length,
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('conflictMarkResolved', startedAt, { resolvedCount: result.resolved.length })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'conflictMarkResolved', code)
      this.auditFail('conflictMarkResolved', startedAt, code)
      throw cause
    }
  }

  /**
   * 继续中间态操作（[清单 13]；权限 C）：守卫（仍有 unmerged 路径 ⇒ git/bad-request
   * 'conflicts-remaining' 零命令；无中间态 ⇒ 'invalid-options'）→ `git cherry-pick|
   * revert|merge|rebase --continue`（执行 env 追加 GIT_EDITOR=true——防 sequencer
   * 打开编辑器挂起，GIT_TERMINAL_PROMPT=0 同纪律的编辑器版）。**冲突是返回值不是
   * 错误**：下一冲突 ⇒ {done:false, conflicted}（client 循环驱动刷新面板）；完成 ⇒
   * {done:true}。写后失效 + 审计双出口。
   * @throws git/bad-request（'conflicts-remaining' / 'invalid-options'）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async operationContinue(signal?: AbortSignal): Promise<OperationContinueResult> {
    const startedAt = Date.now()
    try {
      const result = await this.conflicts.operationContinue(signal)
      logWrite(this.logger, 'operationContinue', {
        op: result.op,
        done: result.done,
        conflicted: result.conflicted.length,
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('operationContinue', startedAt, { op: result.op, done: result.done, conflicted: result.conflicted.length })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'operationContinue', code)
      this.auditFail('operationContinue', startedAt, code)
      throw cause
    }
  }

  // ── v3 批次二：merge / rebase（[清单 28/29]；docs/v3-implementation-plan.md §4.3；引擎半 = merge-rebase.ts） ──

  /**
   * 分支合并（[清单 28]；权限 C）：守卫链（acknowledged C 级闸 + baseRevision 乐观并发
   * + rev-parse 预检 + 批次一共享 detectOperation + dirty-worktree 从严档——§4.3 ①→⑤）
   * → `git merge <branch> [--ff-only|--no-ff] [-m <msg>|--no-edit]`。ff 场景
   * newOid=目标 oid、fastForward=true；up-to-date 幂等成功（零提交，fastForward=false）；
   * 冲突 ⇒ git/merge-conflict（op 'merge'，conflicted 回读，仓库留中间态——错误面板给
   * 批次一冲突面板 + abortOperation）。写后失效 + 审计双出口。
   * @throws git/bad-request（'unacknowledged' / 'stale-base-revision' /
   *   'invalid-options'）、git/unknown-revision、git/operation-in-progress、
   *   git/dirty-worktree、git/no-branch、git/merge-conflict、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async branchMerge(options: BranchMergeOptions, signal?: AbortSignal): Promise<BranchMergeResult> {
    const startedAt = Date.now()
    try {
      const result = await this.mergeRebase.branchMerge(options, signal)
      logWrite(this.logger, 'branchMerge', {
        branch: options.branch,
        fastForward: options.fastForward,
        resultFastForward: result.fastForward,
        oldOid: result.oldOid.slice(0, 12),
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('branchMerge', startedAt, {
        branch: options.branch,
        fastForward: options.fastForward,
        merged: result.fastForward,
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
      })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'branchMerge', code)
      this.auditFail('branchMerge', startedAt, code)
      throw cause
    }
  }

  /**
   * 变基（[清单 29]；权限 C）：守卫链同 branchMerge → `git rebase [--onto <onto>]
   * <upstream>`（非 interactive；默认分支系 = 当前分支；执行 env GIT_EDITOR=true 防编辑器
   * 挂起）。done 恒 true——冲突 ⇒ git/merge-conflict（op 'rebase'），continue 由批次一
   * operationContinue 驱动（§4.2 注记）；up-to-date 幂等成功。写后失效 + 审计双出口。
   * @throws 同 branchMerge。
   */
  @Remote
  async rebase(options: RebaseOptions, signal?: AbortSignal): Promise<RebaseResult> {
    const startedAt = Date.now()
    try {
      const result = await this.mergeRebase.rebase(options, signal)
      logWrite(this.logger, 'rebase', {
        upstream: options.upstream,
        onto: options.onto ?? '(none)',
        oldOid: result.oldOid.slice(0, 12),
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('rebase', startedAt, {
        upstream: options.upstream,
        onto: options.onto ?? '(none)',
        newOid: result.newOid?.slice(0, 12) ?? '(null)',
      })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'rebase', code)
      this.auditFail('rebase', startedAt, code)
      throw cause
    }
  }

  // ── v3 批次三：Agent 工具观测面（[清单 45]；docs/v3-implementation-plan.md §5.5；注册半 = agent-tools.ts） ──

  /**
   * Agent 工具状态（[清单 45]；权限 A，只读）：`{ mode, toolsFaceAvailable, registered }`
   * 观测/verify 断言锚（plan §5.5）。mode = Config.agentTools（fiber 构造期定值——
   * 非 volatile 改动经 fiber 重载生效）；toolsFaceAvailable = ctx.tools 可选切片是否
   * 已观察到（dsh-tools 未挂载的部署恒 false——降级口径 §5.10）；registered = 已注册
   * 工具名白名单子集（'off' 恒 []、readonly 8 个、readwrite 11 个——§5.4 表；逐工具
   * 注册被 tools face 校验拒绝时跳过该名）。只读不入审计环。
   */
  @Remote
  async agentToolsStatus(): Promise<AgentToolsStatusResult> {
    const state = this.agentToolsState
    logRead(this.logger, 'agentToolsStatus', {
      mode: state.mode,
      toolsFaceAvailable: state.toolsFaceAvailable,
      registeredCount: state.registered.length,
    })
    return { mode: state.mode, toolsFaceAvailable: state.toolsFaceAvailable, registered: [...state.registered] }
  }

  // ── v3 批次四：检查点 · 归因 · 聚合（[清单 39/40/41]；docs/v3-implementation-plan.md §6.3；引擎半 = session-watch.ts / checkpoints.ts） ──

  /**
   * 检查点清单（[清单 39]；权限 A，只读）：session-watch 环内索引 → 逐条
   * workspaceChanges.summary 现读补 summary（服务缺失/记录缺失 ⇒ summary null——
   * Host 重启/Session 处置后如实呈现 unavailable，不伪造，plan §6.2）。newest-first；
   * limit 缺省全量（受环容量 Config checkpointMaxTurns 钳制）。只读不入审计环。
   * @throws git/bad-request 'invalid-options'（limit 非 safe 正整数）。
   */
  @Remote
  async checkpointList(limit?: number | null): Promise<CheckpointListResult> {
    const startedAt = Date.now()
    const result = await this.checkpoints.checkpointList(limit)
    logRead(this.logger, 'checkpointList', {
      count: result.entries.length,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 检查点逐文件 diff（[清单 41] 点击看 diff 的数据面；权限 A，只读）：seq 校验
   * （不在环/跨会话歧义/workspaceChanges 缺/summary 缺 ⇒ git/checkpoint-unavailable
   * ——操作侧显式拒绝防误恢复，plan §6.2/§6.5）→ index 越界 ⇒ git/bad-request →
   * face.diff 投影过线（与 workspace-changes WorkspaceFileDiff 同形，纯 JSON 安全）。
   * @throws git/checkpoint-unavailable、git/bad-request 'invalid-options'、
   *   git/git-error（宿主快照读失败收编）、git/no-repository。
   */
  @Remote
  async checkpointDiff(options: CheckpointDiffOptions, signal?: AbortSignal): Promise<CheckpointFileDiff> {
    const startedAt = Date.now()
    const result = await this.checkpoints.checkpointDiff(options, signal)
    logRead(this.logger, 'checkpointDiff', {
      seq: options.seq,
      index: options.index,
      kind: result.kind,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /**
   * 检查点恢复（[清单 39]；权限 C，danger 闸 + DB=A 拍板）：acknowledged 闸 →
   * seq 校验（同 checkpointDiff 硬失败）→ paths 校验（非该 turn 记录成员 ⇒
   * bad-request 零命令；空数组 ⇒ git/no-paths）→ baseRevision 乐观并发 → 逐文件
   * diff 现读 → hunk 序列化 → `git apply -R --whitespace=nowarn --unidiff-zero`
   * （worktree 应用非 --cached；逐文件单独调用 = 部分成功语义——apply 失败项进
   * failed 列表，已成功项不回滚，stderr 脱敏进 reason）。写后失效 + 审计双出口。
   * @throws git/bad-request（'unacknowledged' / 'stale-base-revision' / 'invalid-options'）、
   *   git/no-paths、git/checkpoint-unavailable、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  @Remote
  async checkpointRestore(options: CheckpointRestoreOptions, signal?: AbortSignal): Promise<CheckpointRestoreResult> {
    const startedAt = Date.now()
    try {
      const result = await this.checkpoints.checkpointRestore(options, signal)
      logWrite(this.logger, 'checkpointRestore', {
        seq: options.seq,
        applied: result.applied.length,
        failed: result.failed.length,
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('checkpointRestore', startedAt, {
        seq: options.seq,
        applied: result.applied.length,
        failed: result.failed.length,
      })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'checkpointRestore', code)
      this.auditFail('checkpointRestore', startedAt, code)
      throw cause
    }
  }

  /**
   * 变更归因（[清单 40]；权限 A，只读）：当前 status 全路径 × turn→files 现读映射
   * 四态求交——agent（回合记录命中且文件仍处于回合窗口内，mtime 近似判定）/ mixed
   * （命中但回合结束后又被改动）/ user（快照有但零命中，以有记录覆盖为前提）/
   * unknown（无记录覆盖——重启前历史，DE=A 如实降级）。只读不入审计环。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（status 扫描失败兜底）。
   */
  @Remote
  async attributionGet(signal?: AbortSignal): Promise<AttributionResult> {
    const startedAt = Date.now()
    const result = await this.checkpoints.attributionGet(signal)
    logRead(this.logger, 'attributionGet', {
      count: result.entries.length,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  // ── v3 批次五：自动化观测面（[清单 42/43]；docs/v3-implementation-plan.md §7.3–§7.5；引擎半 = automation.ts） ──

  /**
   * 自动化状态（[清单 42/43]；权限 A，只读）：`{ autoCommitMode, autoBranchMode,
   * lastActions }` 观测/verify 断言锚 + client 可选状态行数据面（plan §7.3/§7.5）。
   * mode = Config.autoCommitMode/autoBranchMode（fiber 构造期定值——非 volatile 改动
   * 经 fiber 重载生效）；lastActions = 自动化最近动作环（≤20 条 newest-first，
   * automation.ts record 面——detail 白名单摘要，不落 message 正文/文件内容/stderr
   * 原文）。自动化失败不抛 RemoteError（§7.4 零新码——无 UI 报错通道），本面 +
   * auditLog 是失败的两条可查路。只读不入审计环。
   */
  @Remote
  async automationStatus(): Promise<AutomationStatusResult> {
    const result = this.automation.status()
    logRead(this.logger, 'automationStatus', {
      autoCommitMode: result.autoCommitMode,
      autoBranchMode: result.autoBranchMode,
      lastActionCount: result.lastActions.length,
    })
    return result
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
      this.auditOk('stagePatch', startedAt, { path: options.path, direction: options.direction ?? 'stage', staged: result.staged })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'stagePatch', code)
      this.auditFail('stagePatch', startedAt, code)
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
      this.auditOk('stashPush', startedAt, {
        includeUntracked: options.includeUntracked === true,
        hasMessage: typeof options.message === 'string' && options.message !== '',
      })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'stashPush', code)
      this.auditFail('stashPush', startedAt, code)
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
      this.auditOk('stashPop', startedAt, { index: result.index })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'stashPop', code)
      this.auditFail('stashPop', startedAt, code)
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
      this.auditOk('stashDrop', startedAt, { index: result.index })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'stashDrop', code)
      this.auditFail('stashDrop', startedAt, code)
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

  // ── v2 批次四：体验集成与收尾（[清单 8/46/61/66/69]；引擎半 = admin-repo.ts / submodule.ts / audit.ts / pr.ts / message-gen.ts） ──

  /**
   * 非仓库目录初始化（[清单 8]；权限 C）：前置 `git rev-parse` 复核**非仓库态**
   * （已是仓库/位于仓库之内 ⇒ git/init-failed reason='already-a-repository'，零命令）
   * → `git init`（无 -b 旗标——初始分支尊重 init.defaultBranch/用户配置；非空目录
   * 合法——[8] 的真实用例即已打开的项目目录）→ 回读 repoRoot/branch。init 后触发
   * StatusEngine 缓存失效 + afterWrite 通知（not-repository 稳定态进 TTL 缓存，
   * init 后必须 invalidate 才能就地重探——R1 首帧就绪；workspace 从 unresolved →
   * resolved 的重解析由 WorkspaceResolver 逐次 realpath 语义天然承担）。
   * @throws git/init-failed、git/session-workspace-unresolved、git/no-repository
   *   （init 后 rev-parse 反常失败 = 契约破坏）、git/timeout、git/git-error。
   */
  @Remote
  async initRepository(signal?: AbortSignal): Promise<InitResult> {
    const startedAt = Date.now()
    try {
      const result = await this.adminRepo.initRepository(signal)
      logWrite(this.logger, 'initRepository', { branch: result.branch, durationMs: Date.now() - startedAt })
      this.auditOk('initRepository', startedAt, { repoRoot: result.repoRoot, branch: result.branch })
      this.afterWrite()
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'initRepository', code)
      this.auditFail('initRepository', startedAt, code)
      throw cause
    }
  }

  /**
   * submodule 状态列表（[清单 61]；权限 A，只读）：`git submodule status`（默认形态
   * + --cached 双读归并）前缀解析——空格=clean、`-`=未初始化（oid null）、`+`=检出
   * 与 index 记录漂移（mismatch）、`U`=冲突（映射 dirty）；**只列不递归**（不带
   * --recursive，对齐 [61] 原文与 v1 不展开口径）；无 submodule ⇒ 空数组不抛错。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（行解析契约破坏 / 命令失败兜底）。
   */
  @Remote
  async submoduleStatus(signal?: AbortSignal): Promise<SubmoduleStatusResult> {
    const startedAt = Date.now()
    const result = await this.submodule.submoduleStatus(signal)
    logRead(this.logger, 'submoduleStatus', { count: result.submodules.length, durationMs: Date.now() - startedAt })
    return result
  }

  /**
   * 写操作审计查询（[清单 66]；权限 A，只读）：环缓冲查询（auditMaxEntries Config
   * 默认 500；limit 钳 [1, maxEntries] 缺省 100、since ISO 下界过滤）——newest-first。
   * 本方法自身是只读，不入环（audit.ts 只记录写方法双出口）。
   * @throws git/bad-request 'invalid-options'（since 非 ISO）。
   */
  @Remote
  async auditLog(options: AuditLogOptions): Promise<AuditLogResult> {
    const startedAt = Date.now()
    const result = this.audit.query(options ?? {})
    logRead(this.logger, 'auditLog', { count: result.entries.length, durationMs: Date.now() - startedAt })
    return result
  }

  /**
   * AI 生成 PR 描述（[清单 46]；权限 B）：输入 = staged+未提交 diff（双 scope 归并
   * 去重）+ 最近提交（10 条）+ [清单 70] 合并策略约定段（只读检测：PR 模板 /
   * CONTRIBUTING / `git config` merge·pull 相关项；缺失即省略——零方法零码）。
   * LLM 调用复用 message-gen 六步管线（共用 dispatch，purpose 省略口径不变——
   * dsh GenerateOptions.purpose 是封闭联合，插件不能发明新 purpose）。clean born
   * 仓库（提交完待建 PR 的常态）合法；unborn 且无 diff ⇒ git/nothing-staged。
   * @throws git/nothing-staged、git/no-repository、git/session-workspace-unresolved、
   *   git/llm-route-unresolved、git/llm-failed {stage:'trim'|'call'|'parse'}、
   *   git/timeout、git/git-error。
   */
  @Remote
  async generatePrDescription(signal?: AbortSignal): Promise<PrDescription> {
    const startedAt = Date.now()
    try {
      const result = await this.messageGen.generatePrDescription(signal)
      logRead(this.logger, 'generatePrDescription', { durationMs: Date.now() - startedAt })
      return result
    } catch (cause) {
      logFailure(this.logger, 'generatePrDescription', errorCodeOf(cause))
      throw cause
    }
  }

  /**
   * 创建 PR（[清单 46]；权限 C，D1=A 载体已拍板 = gh CLI）：acknowledged danger 闸
   * （零命令）→ title 非空/分支参数形状守卫（零命令——首字符 '-' 拒绝，防旗标注入）
   * → `gh auth status` 预检（gh 缺失/未登录 ⇒ git/pr-tool-missing——ghCommand Config
   * 经 resolveExecutable 解析，gitCommand 先例）→ `gh pr create --title … --body-file -
   * （stdin）[--base][--head][--draft]`；API 失败 ⇒ git/pr-create-failed（stderr 脱敏）；
   * 超时 networkTimeoutMs ⇒ git/timeout。成功解析 PR URL/编号。创建 PR 是外部可见
   * 写动作——入审计环（双出口）。
   * @throws git/bad-request（'unacknowledged' / 'invalid-options'）、git/pr-tool-missing、
   *   git/pr-create-failed、git/session-workspace-unresolved、git/timeout。
   */
  @Remote
  async createPr(options: PrCreateOptions, signal?: AbortSignal): Promise<PrResult> {
    const startedAt = Date.now()
    try {
      const result = await this.pr.createPr(options, signal)
      logWrite(this.logger, 'createPr', {
        draft: options.draft === true,
        number: result.number,
        durationMs: Date.now() - startedAt,
      })
      this.auditOk('createPr', startedAt, {
        base: options.base ?? '(default)',
        head: options.head ?? '(current)',
        draft: options.draft === true,
        titleChars: options.title.length,
      })
      return result
    } catch (cause) {
      const code = errorCodeOf(cause)
      logFailure(this.logger, 'createPr', code)
      this.auditFail('createPr', startedAt, code)
      throw cause
    }
  }

  /**
   * 查询分支关联 PR（[69]；权限 A，只读）：head 推断 = 该分支 upstream 缺省映射
   * （`rev-parse --abbrev-ref <branch>@{upstream}` 剥远端前缀，无 upstream 回落本名）
   * → `gh pr view <branch> --json url,state`；gh 缺失 ⇒ git/pr-tool-missing；查询
   * 失败/无关联 ⇒ **返回 null**（[69] UI 静默降级——不占位不报错）。只读不入审计环。
   * @throws git/bad-request 'invalid-options'（branch 形状）、git/pr-tool-missing、
   *   git/session-workspace-unresolved、git/timeout。
   */
  @Remote
  async prForBranch(branch: string, signal?: AbortSignal): Promise<PrLinkResult | null> {
    const startedAt = Date.now()
    try {
      const result = await this.pr.prForBranch(branch, signal)
      logRead(this.logger, 'prForBranch', { found: result !== null, durationMs: Date.now() - startedAt })
      return result
    } catch (cause) {
      logFailure(this.logger, 'prForBranch', errorCodeOf(cause))
      throw cause
    }
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
    const startedAt = Date.now()
    try {
      const result = await this.remoteOps.fetch({ remote: null })
      logRead(this.logger, 'autoFetch', { remote: result.remote, pruned: result.pruned })
      // 后台 fetch 也是写操作（remote-tracking 引用面变更）——双出口同入审计环。
      this.auditOk('autoFetch', startedAt, { remote: result.remote, pruned: result.pruned })
      this.afterWrite()
    } catch (cause) {
      const code = errorCodeOf(cause)
      // 后台任务失败面：仅 warn（code 附带），绝不向上抛、不进错误帧/错误面板。
      logFailure(this.logger, 'autoFetch', code)
      this.auditFail('autoFetch', startedAt, code)
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

  /** 供测试与批次五自动化复用的会话事件观察入口（直喂 observe/断言环——不影响 wire 面）。 */
  sessionWatchOf(): SessionWatch {
    return this.sessionWatch
  }

  /** 供测试复用的自动化引擎入口（直喂 observe/断言 lastActions 环与判重记忆——不影响 wire 面）。 */
  automationOf(): AutomationEngine {
    return this.automation
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

  /**
   * 宿主 tools 能力切片的结构化读取（`ctx.get('tools')`；readFsFace/readLlmFace 同款
   * 先例——**可选切片，绝不进 static inject**，plan §0.2-① 可达性口径）。tools 缺席
   * 或形状不符 → undefined（agent-tools.ts 注册面降级），不阻断服务激活。注意 cordis
   * ctx.get 只回已激活 fiber 的实现（lib/index.js reflect get strict 默认 true）——
   * 注册面的事件跟随补齐时序（agent-tools.ts 文件头）。
   */
  private static readAgentToolsFace(ctx: Context): GitToolsFace | undefined {
    try {
      const candidate: unknown = (ctx as unknown as { get(key: string): unknown }).get('tools')
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const face = candidate as Partial<GitToolsFace>
      if (typeof face.register !== 'function') return undefined
      return candidate as GitToolsFace
    } catch {
      return undefined
    }
  }

  /**
   * 宿主 workspaceChanges 能力切片的结构化读取（`ctx.get('workspaceChanges')`；
   * readAgentToolsFace/readLlmFace 同款先例——**可选切片，绝不进 static inject**，
   * plan §0.2-② 可达性口径）。切片缺席或形状不符 → undefined（检查点索引照建、
   * summary null / 操作侧 git/checkpoint-unavailable 降级），不阻断服务激活。
   * 逐次现读（闭包经 CheckpointsEngine 消费）——workspaceChanges 服务 fiber 可能晚于
   * 本服务激活，ctx.get 每次重取天然跟随（ctx.tools 时序同款）。
   */
  private static readWorkspaceChangesFace(ctx: Context): GitWorkspaceChangesFace | undefined {
    try {
      const candidate: unknown = (ctx as unknown as { get(key: string): unknown }).get('workspaceChanges')
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const face = candidate as Partial<GitWorkspaceChangesFace>
      if (typeof face.summary !== 'function' || typeof face.diff !== 'function') return undefined
      return candidate as GitWorkspaceChangesFace
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
