/**
 * dsh-gitkit-ui — remote 命名空间挂载与 RPC 面（spec §3.1/§3.2）。
 *
 * 挂载对象 = ④-A 的 typert-generator 生成产物 `dsh-gitkit/remote`
 * （TypertRemoteInfo：package + descriptors + strict codec；勿手编）。挂载机制 =
 * gateway client 的 `ctx.remote.$mount(contribution)`（packages/api/gateway/src/client
 * /index.ts:210-222 实读——$mount 在调用方 fiber 的 effect 内注册 contribution，
 * contribution.descriptors 按 namespace 分组安装；`git` 命名空间的 service fiber 名为
 * `remote.git`，仅在本次 $mount 内创建）。产物以 import 内联进本 bundle，zod 走基线
 * external（scripts/build-client.mjs EXTERNALS）。
 *
 * **inject 不含 `remote.git`**（CONTRACT.md §2 既有决议）：`remote.git` 由本插件自己的
 * $mount 挂上，若声明注入则 fiber 等待一个只有在 apply 内才会出现的服务——装载死锁
 * （boot audit 形态即 "pending (waiting for service: remote.git)"，dsh boot-client.ts
 * assertEntriesActive 实读）。
 *
 * GitRpcFace：spec §3.2 的 client RPC 注入口。**F 变更面板模块（2026-10-31）扩展**：
 * 在 ④-A 已上线方法（status / followStatus / ping / identity / diff）之外声明
 * `stage` / `unstage` / `discard`（spec §1.3/§3.2 GitRpcClient 的写操作切片）——变更
 * 面板的行内动作消费它们。**host 写操作模块（⑤ mutations/commit，2026-10-31）落地**：
 * 三个端点已在生成命名空间上真实存在；discard 的 wire 形状按 host 三重守卫入参
 * （DiscardOptions：paths + acknowledged 二次确认旗标 + baseRevision 乐观并发基线）
 * 对齐。**④-K 提交对话框模块（2026-11-01）扩展**：声明 `commit` / `push` / `pull` /
 * `fetch` / `generateCommitMessage`（提交链路与链式 Commit & Push 的消费面），并把
 * `GitNamespaceFace` 补成 host `REMOTE_METHODS` 的全量镜像（`GIT_NAMESPACE_METHODS`
 * 清单 + tests/loader-composition.spec 的三方对账）。错误统一折叠为
 * `RemoteResult`（ok:false 分支）——gateway 对
 * RemoteError 过线为 {ok:false,error}（map §2.4），载波层异常（连接缺失/服务未就绪）
 * 以 reject 到达，此处折叠为 `gateway/service-unavailable`（spec §1.0.1：UI 显示重试）。
 *
 * **V2 批次一（分支·标签·远端·worktree 管理面，2026-11-08）扩展**：host refs-admin
 * 模块的 9 个新 @Remote 方法（branchCreate/branchSwitch/branchDelete/tagCreate/
 * tagDelete/remoteList/worktreeList/worktreeAdd/worktreeRemove）四处同步——
 * GitNamespaceFace + GitRpcFace + GIT_NAMESPACE_METHODS + createGitRpcClient 逐方法
 * 包装块（变更链 §1 第 4 步；wire 类型 = v2-implementation-plan §3.2，import 面
 * `dsh-gitkit/types`）。
 *
 * **V2 批次二（历史面，2026-11-08）扩展**：host blame/time-travel/graph 扩展的
 * 6 个新 @Remote 方法（blame/compareBranches/cherryPick/revert/reset/abortOperation）
 * 同款四处同步（plan §4.2/§4.3；wire 类型 = plan §4.2，import 面 `dsh-gitkit/types`）。
 *
 * **V2 批次三（提交链路与护栏，2026-11-08）扩展**：host staging-patch/stash/guard-scan/
 * diagnostics 扩展的 7 个新 @Remote 方法（stagePatch/stashPush/stashList/stashPop/
 * stashDrop/scanStaged/repoDiagnostics）同款四处同步（plan §5.2/§5.3；wire 类型 =
 * host types.ts v2 批次三段，import 面 `dsh-gitkit/types`）。D7=B：stagePatch 的
 * `direction` 两态（'unstage' = `apply --cached -R` 反向）；D4=B：stashPush 的
 * `includeUntracked` 显式 boolean（client 缺省传 true）。pop/drop 入参与 host 半
 * 定型 wire 对齐：`StashPopOptions{index?}`（null/缺省 = 最新一条，plan §5.3
 * 「默认最近一条 / 可指定 index」）、`StashDropOptions{index, acknowledged}`
 * （acknowledged = UI danger 勾选闸的 host 半旗标）。
 *
 * **V2 批次四（体验集成与收尾，2026-11-08）扩展**：host admin-repo/submodule/audit/
 * message-gen/pr 扩展的 6 个新 @Remote 方法（initRepository/submoduleStatus/
 * auditLog/generatePrDescription/createPr/prForBranch）同款四处同步（plan §6.2/§6.3；
 * wire 类型 = plan §6.2，import 面 `dsh-gitkit/types`）。D1=A：createPr 的载体 =
 * host 半 gh CLI（client 只消费确认闸与结果展示）。prForBranch 的返回 =
 * `PrLinkResult | null`（null = 无关联/查询失败——[69] UI 静默降级，plan §6.2）；
 * auditLog 为 [66] 的 RPC 查询半（本插件无专属 UI——plan §6.6，client 面只保方法
 * 对账不消费）。[70]（合并策略约定段）在 host generatePrDescription 的 prompt 组装，
 * client 无落点。
 *
 * **V3 批次一（冲突解决，[清单 13]，2026-11-12）扩展**：host conflicts.ts 模块的
 * 4 个新 @Remote 方法（conflictList/conflictResolve/conflictMarkResolved/
 * operationContinue）同款四处同步（v3-implementation-plan §3.2/§3.3；wire 类型 =
 * host types.ts v3 批次一段，import 面 `dsh-gitkit/types`）。语义注记：
 * operationContinue 的**冲突是返回值不是错误**（done:false + conflicted——client
 * 循环驱动需要，plan §3.2）；conflictResolve/conflictMarkResolved 的路径守卫 =
 * `git/bad-request` reason 'path-not-conflicted'（复用既有 error.bad-request 插值，
 * error-map 不加行）。
 *
 * **V3 批次二（merge / rebase，[清单 28/29]，2026-11-13）扩展**：host merge-rebase.ts
 * 模块的 2 个新 @Remote 方法（branchMerge/rebase）同款四处同步（v3-implementation-plan
 * §4.2/§4.3；wire 类型 = host types.ts v3 批次二段，import 面 `dsh-gitkit/types`）。
 * 语义注记：branchMerge 的 `fastForward` 三态（'auto'/'ff-only'/'no-ff'——ff 场景
 * newOid=目标 oid、fastForward=true；up-to-date 是幂等成功不是错误）；rebase 的
 * `done` 恒 true——冲突走 git/merge-conflict 错误路径（op 'merge'|'rebase'），continue
 * 由批次一 operationContinue 驱动（plan §4.2：rebase 引擎自身不做内循环）。零新域码
 * （复用 unknown-revision / operation-in-progress / dirty-worktree / merge-conflict /
 * bad-request——error-map 不加行，plan §4.4）。
 *
 * **V3 批次三（Agent 工具观测面，[清单 45]，2026-11-13）扩展**：host agent-tools.ts
 * 模块的 1 个新 @Remote 方法（agentToolsStatus）同款四处同步（v3-implementation-plan
 * §5.5；wire 类型 = host types.ts v3 批次三段，import 面 `dsh-gitkit/types`）。
 * 观测方法只读不入审计环，registered 白名单面 = host agent-tools.ts §5.4 权威表
 * （off 恒 [] / readonly 8 / readwrite 11）。同批 client 半的 §5.7 header 状态行 UI
 * 落 admin-face.ts（agentToolsStatus 拉取）+ admin-view-model.ts（agentToolsStatusLine
 * 渲染模型）+ GitHeaderButton.tsx（菜单 label 行），本文件只保方法对账。
 *
 * **V3 批次四（检查点 · 归因 · 聚合，[清单 39/40/41]，2026-11-14）扩展**：host
 * session-watch.ts/checkpoints.ts 模块的 4 个新 @Remote 方法（checkpointList/
 * checkpointDiff/checkpointRestore/attributionGet）同款四处同步（v3-implementation-plan
 * §6.2/§6.3；wire 类型 = host types.ts v3 批次四段，import 面 `dsh-gitkit/types`）。
 * 语义注记：checkpointList 的 summary = null 如实呈现 workspaceChanges 无记录（Host
 * 重启/会话处置——DE=A 诚实降级，不伪造）；checkpointRestore 是 danger 写方法
 * （acknowledged + baseRevision 乐观并发 + 逐文件部分成功语义）；checkpointDiff/
 * Restore 对无记录 seq 抛 git/checkpoint-unavailable（error-map 新码行）。同批 client
 * 半的 §6.6 时间线/归因徽标 UI 已落（store/checkpoint-store.ts + checkpoint-view.ts +
 * components/GitCheckpointTimeline.tsx），本文件只保方法对账。
 *
 * **V3 批次五（自动化观测面，[清单 42/43]，2026-11-18）扩展**：host automation.ts
 * 模块的 1 个新 @Remote 方法（automationStatus）同款四处同步（v3-implementation-plan
 * §7.3/§7.5；wire 类型 = host types.ts v3 批次五段，import 面 `dsh-gitkit/types`）。
 * 语义注记：只读观测面（零新域码——自动化失败不抛 RemoteError，结果经 lastActions +
 * auditLog 双可查，plan §7.4）；lastActions 环 20 条 newest-first，detail = 白名单摘要
 * （host 侧已单行化/消毒/200 上限——不落消息正文/stderr 原文）。同批 client 半的
 * §7.5 header「自动化」状态行落 admin-face.ts（拉取面）+ admin-view-model.ts
 * （automationStatusLines 渲染模型）+ GitHeaderButton.tsx（菜单状态行——无操作面，
 * 启停在 profile 配置层），本文件只保方法对账。
 */

// 生成产物（勿手编）：运行期 TypertRemoteInfo + declare module 合并（命名空间方法签名）。
import gitRemote from 'dsh-gitkit/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AbortOperationResult, AgentToolsStatusResult, AttributionResult, AuditLogOptions, AuditLogResult,
  AutomationStatusResult, BlameOptions, BlameResult,
  BranchCompareResult, BranchCreateOptions, BranchCreateResult, BranchDeleteOptions,
  BranchDeleteResult, BranchMergeOptions, BranchMergeResult, BranchSwitchResult, CherryPickOptions,
  CheckpointDiffOptions, CheckpointFileDiff, CheckpointListResult, CheckpointRestoreOptions, CheckpointRestoreResult,
  CommitDetail, CommitOptions, CommitResult, CommitScanResult,
  ConflictListResult, ConflictMarkOptions, ConflictMarkResult, ConflictResolveOptions,
  ConflictResolveResult, CompareOptions, DiffResult, DiffScope,
  DiscardOptions, DiscardResult, FetchOptions, FetchResult, GeneratedCommitMessage,
  GitFollowCommand, GitIdentityResult, GitIdentityScope, GitPingResult, GitStatusFrame,
  GitStatusSnapshot, InitResult, LogOptions, LogPage, OperationContinueResult,
  PrCreateOptions, PrDescription, PrLinkResult,
  PrResult, PullResult, PushOptions, PushResult, RebaseOptions, RebaseResult, RefsSnapshot,
  RemoteListResult, RepoDiagnostics, ResetOptions, RevertOptions, ShowOptions, StagePatchOptions,
  StagePatchResult, StageResult, StashDropOptions, StashListResult, StashOpResult,
  StashPopOptions, StashPushOptions, SubmoduleStatusResult, TagCreateOptions,
  TagCreateResult, TagDeleteResult,
  TimeTravelResult, UnstageResult, WorktreeAddOptions, WorktreeAddResult, WorktreeListResult,
  WorktreeRemoveOptions, WorktreeRemoveResult,
} from 'dsh-gitkit/types'

/**
 * 挂载前可用的最小 remote 服务结构。生产 = cordis Context 的 `ctx.remote`
 * （gateway ClientRemote ⊂ TypertClientRemote ⊂ TypertRemoteNamespaceMap——本文件
 * import 生成产物后，`git` 命名空间经 declare module 合并进该映射，方法签名全型）。
 */
export type GitRemoteContext = {
  remote: TypertClientRemote
}

/** client 侧错误投影（spec §3.2：按 code 判别，不按 instanceof——map §2.4）。 */
export interface GitErrorLike {
  code: string
  message: string
  details?: unknown
}

/** client 侧结果联合（spec §3.2 的 RemoteResult；与协议线形状同构）。 */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: GitErrorLike }

/**
 * 一条逻辑流的 client 句柄（协议 RemoteStreamHandle 的结构投影：AsyncIterable 下行 +
 * send/end/dispose 上行与取消；packages/typert-protocol/src/types.ts:160-184）。
 */
export interface GitStreamHandle<Out, In> extends AsyncIterable<Out> {
  /** 上行一项（开流前排队的上行在 open 帧上线后送达）。 */
  send(item: In): void
  /** 半关上行：host 的 uplink() 迭代结束。幂等；终止后忽略。 */
  end(): void
  /** 取消逻辑流并安静地结束下行迭代（提前跳出 for-await 同效）。 */
  dispose(): void
}

/** 挂载后的 `git` 命名空间方法面（与生成命名空间签名同构；结构化窄化用）。 */
interface GitNamespaceFace {
  ping(signal?: AbortSignal): Promise<RemoteResult<GitPingResult>>
  identity(scope?: GitIdentityScope, signal?: AbortSignal): Promise<RemoteResult<GitIdentityResult>>
  status(signal?: AbortSignal): Promise<RemoteResult<GitStatusSnapshot>>
  diff(scope: DiffScope, path: string | null, signal?: AbortSignal): Promise<RemoteResult<DiffResult>>
  followStatus(signal?: AbortSignal): GitStreamHandle<GitStatusFrame, GitFollowCommand>
  /** 写操作切片（host ⑤ mutations 模块已上线；discard 形状 = 三重守卫入参）。 */
  stage(paths: string[], signal?: AbortSignal): Promise<RemoteResult<StageResult>>
  unstage(paths: string[], signal?: AbortSignal): Promise<RemoteResult<UnstageResult>>
  discard(options: DiscardOptions, signal?: AbortSignal): Promise<RemoteResult<DiscardResult>>
  /** 提交链路切片（④-K 提交对话框模块）：commit/push + AI 提交信息（host ⑤/⑥/M7 已上线）。 */
  commit(options: CommitOptions, signal?: AbortSignal): Promise<RemoteResult<CommitResult>>
  push(options: PushOptions, signal?: AbortSignal): Promise<RemoteResult<PushResult>>
  pull(signal?: AbortSignal): Promise<RemoteResult<PullResult>>
  fetch(options: FetchOptions, signal?: AbortSignal): Promise<RemoteResult<FetchResult>>
  generateCommitMessage(signal?: AbortSignal): Promise<RemoteResult<GeneratedCommitMessage>>
  /** 提交图数据层（host F7 graph.ts 已上线；spec §1.8 + workflow 任务口径）。 */
  log(options: LogOptions, signal?: AbortSignal): Promise<RemoteResult<LogPage>>
  refs(signal?: AbortSignal): Promise<RemoteResult<RefsSnapshot>>
  getCommitDetail(options: ShowOptions, signal?: AbortSignal): Promise<RemoteResult<CommitDetail>>
  /** V2 批次二历史面切片（host blame/time-travel/graph 扩展；plan §4.3 的 6 方法签名）。 */
  blame(options: BlameOptions, signal?: AbortSignal): Promise<RemoteResult<BlameResult>>
  compareBranches(options: CompareOptions, signal?: AbortSignal): Promise<RemoteResult<BranchCompareResult>>
  cherryPick(options: CherryPickOptions, signal?: AbortSignal): Promise<RemoteResult<TimeTravelResult>>
  revert(options: RevertOptions, signal?: AbortSignal): Promise<RemoteResult<TimeTravelResult>>
  reset(options: ResetOptions, signal?: AbortSignal): Promise<RemoteResult<TimeTravelResult>>
  abortOperation(signal?: AbortSignal): Promise<RemoteResult<AbortOperationResult>>
  /** V2 批次一管理面切片（host refs-admin 模块；plan §3.3 的 9 方法签名）。 */
  branchCreate(options: BranchCreateOptions, signal?: AbortSignal): Promise<RemoteResult<BranchCreateResult>>
  branchSwitch(name: string, signal?: AbortSignal): Promise<RemoteResult<BranchSwitchResult>>
  branchDelete(options: BranchDeleteOptions, signal?: AbortSignal): Promise<RemoteResult<BranchDeleteResult>>
  tagCreate(options: TagCreateOptions, signal?: AbortSignal): Promise<RemoteResult<TagCreateResult>>
  tagDelete(name: string, signal?: AbortSignal): Promise<RemoteResult<TagDeleteResult>>
  remoteList(signal?: AbortSignal): Promise<RemoteResult<RemoteListResult>>
  worktreeList(signal?: AbortSignal): Promise<RemoteResult<WorktreeListResult>>
  worktreeAdd(options: WorktreeAddOptions, signal?: AbortSignal): Promise<RemoteResult<WorktreeAddResult>>
  worktreeRemove(options: WorktreeRemoveOptions, signal?: AbortSignal): Promise<RemoteResult<WorktreeRemoveResult>>
  /** V2 批次三提交链路与护栏切片（host staging-patch/stash/guard-scan/diagnostics；plan §5.3 的 7 方法签名——
   *  与 host 半定型 wire 对齐：stashPop 走 StashPopOptions{index?}（null/缺省 = 最新一条）、stashDrop 走 StashDropOptions）。 */
  stagePatch(options: StagePatchOptions, signal?: AbortSignal): Promise<RemoteResult<StagePatchResult>>
  stashPush(options: StashPushOptions, signal?: AbortSignal): Promise<RemoteResult<StashOpResult>>
  stashList(signal?: AbortSignal): Promise<RemoteResult<StashListResult>>
  stashPop(options: StashPopOptions, signal?: AbortSignal): Promise<RemoteResult<StashOpResult>>
  stashDrop(options: StashDropOptions, signal?: AbortSignal): Promise<RemoteResult<StashOpResult>>
  scanStaged(signal?: AbortSignal): Promise<RemoteResult<CommitScanResult>>
  repoDiagnostics(signal?: AbortSignal): Promise<RemoteResult<RepoDiagnostics>>
  /** V2 批次四体验集成切片（host admin-repo/submodule/audit/message-gen/pr；plan §6.3 的 6 方法签名）。
   *  prForBranch 的 ok 值 = `PrLinkResult | null`（null = 无关联/查询失败——[69] 静默降级）。 */
  initRepository(signal?: AbortSignal): Promise<RemoteResult<InitResult>>
  submoduleStatus(signal?: AbortSignal): Promise<RemoteResult<SubmoduleStatusResult>>
  auditLog(options: AuditLogOptions, signal?: AbortSignal): Promise<RemoteResult<AuditLogResult>>
  generatePrDescription(signal?: AbortSignal): Promise<RemoteResult<PrDescription>>
  createPr(options: PrCreateOptions, signal?: AbortSignal): Promise<RemoteResult<PrResult>>
  prForBranch(branch: string, signal?: AbortSignal): Promise<RemoteResult<PrLinkResult | null>>
  /** V3 批次一冲突解决切片（host conflicts.ts 模块；v3-implementation-plan §3.3 的 4 方法签名）。
   *  operationContinue 的冲突是返回值不是错误（done:false + conflicted——plan §3.2）。 */
  conflictList(signal?: AbortSignal): Promise<RemoteResult<ConflictListResult>>
  conflictResolve(options: ConflictResolveOptions, signal?: AbortSignal): Promise<RemoteResult<ConflictResolveResult>>
  conflictMarkResolved(options: ConflictMarkOptions, signal?: AbortSignal): Promise<RemoteResult<ConflictMarkResult>>
  operationContinue(signal?: AbortSignal): Promise<RemoteResult<OperationContinueResult>>
  /** V3 批次二 merge / rebase 切片（host merge-rebase.ts 模块；v3-implementation-plan §4.3 的 2 方法签名）。
   *  branchMerge.up-to-date 与 rebase done:true 都是幂等成功（plan §4.2）；冲突走
   *  git/merge-conflict 错误路径（op 'merge'|'rebase'），continue 由批次一方法驱动。 */
  branchMerge(options: BranchMergeOptions, signal?: AbortSignal): Promise<RemoteResult<BranchMergeResult>>
  rebase(options: RebaseOptions, signal?: AbortSignal): Promise<RemoteResult<RebaseResult>>
  /** V3 批次三 Agent 工具观测切片（host agent-tools.ts 模块；v3-implementation-plan §5.5）。 */
  agentToolsStatus(signal?: AbortSignal): Promise<RemoteResult<AgentToolsStatusResult>>
  /** V3 批次四检查点切片（host session-watch/checkpoints 模块；v3-implementation-plan §6.3 的 4 方法签名）。
   *  checkpointList 的 summary = null 如实呈现 workspaceChanges 无记录（Host 重启/会话处置——DE=A）。 */
  checkpointList(limit?: number | null, signal?: AbortSignal): Promise<RemoteResult<CheckpointListResult>>
  checkpointDiff(options: CheckpointDiffOptions, signal?: AbortSignal): Promise<RemoteResult<CheckpointFileDiff>>
  checkpointRestore(options: CheckpointRestoreOptions, signal?: AbortSignal): Promise<RemoteResult<CheckpointRestoreResult>>
  attributionGet(signal?: AbortSignal): Promise<RemoteResult<AttributionResult>>
  /** V3 批次五自动化观测切片（host automation.ts 模块；v3-implementation-plan §7.3）。
   *  只读观测面：失败不抛 RemoteError（零新域码——结果经 lastActions 环 + auditLog
   *  双可查，plan §7.4）。 */
  automationStatus(signal?: AbortSignal): Promise<RemoteResult<AutomationStatusResult>>
}

/**
 * 命名空间方法键清单（GitNamespaceFace 的运行期镜像——tests/loader-composition.spec
 * 的三方对账行：host `REMOTE_METHODS` ⇄ 生成产物 `methods` 键 ⇄ 本清单。新增/删减
 * @Remote 方法时同步此表，漏项在 M10 组合测试编译/断言面暴露）。
 */
export const GIT_NAMESPACE_METHODS = [
  'ping', 'identity', 'status', 'diff', 'followStatus',
  'stage', 'unstage', 'discard',
  'commit', 'push', 'pull', 'fetch', 'generateCommitMessage',
  'log', 'refs', 'getCommitDetail',
  // V2 批次一管理面（host refs-admin 模块；plan §3.3）。
  'branchCreate', 'branchSwitch', 'branchDelete', 'tagCreate', 'tagDelete',
  'remoteList', 'worktreeList', 'worktreeAdd', 'worktreeRemove',
  // V2 批次二历史面（host blame/time-travel/graph 扩展；plan §4.3）。
  'blame', 'compareBranches', 'cherryPick', 'revert', 'reset', 'abortOperation',
  // V2 批次三提交链路与护栏（host staging-patch/stash/guard-scan/diagnostics；plan §5.3）。
  'stagePatch', 'stashPush', 'stashList', 'stashPop', 'stashDrop', 'scanStaged', 'repoDiagnostics',
  // V2 批次四体验集成（host admin-repo/submodule/audit/message-gen/pr；plan §6.3）。
  'initRepository', 'submoduleStatus', 'auditLog', 'generatePrDescription', 'createPr', 'prForBranch',
  // V3 批次一冲突解决（host conflicts.ts 模块；v3-implementation-plan §3.3）。
  'conflictList', 'conflictResolve', 'conflictMarkResolved', 'operationContinue',
  // V3 批次二 merge / rebase（host merge-rebase.ts 模块；v3-implementation-plan §4.3）。
  'branchMerge', 'rebase',
  // V3 批次三 Agent 工具观测面（host agent-tools.ts 模块；v3-implementation-plan §5.5）。
  'agentToolsStatus',
  // V3 批次四检查点/归因/聚合（host session-watch/checkpoints 模块；v3-implementation-plan §6.3）。
  'checkpointList', 'checkpointDiff', 'checkpointRestore', 'attributionGet',
  // V3 批次五自动化观测面（host automation.ts 模块；v3-implementation-plan §7.3）。
  'automationStatus',
] as const

/** 本模块消费的 RPC 面（spec §3.2 GitRpcClient 全量 = host REMOTE_METHODS 镜像；store/组件按切片消费）。 */
export interface GitRpcFace {
  ping(signal?: AbortSignal): Promise<RemoteResult<GitPingResult>>
  identity(scope?: GitIdentityScope, signal?: AbortSignal): Promise<RemoteResult<GitIdentityResult>>
  status(signal?: AbortSignal): Promise<RemoteResult<GitStatusSnapshot>>
  followStatus(signal?: AbortSignal): Promise<GitStreamHandle<GitStatusFrame, GitFollowCommand>>
  diff(scope: DiffScope, path: string | null, signal?: AbortSignal): Promise<RemoteResult<DiffResult>>
  stage(paths: string[], signal?: AbortSignal): Promise<RemoteResult<StageResult>>
  unstage(paths: string[], signal?: AbortSignal): Promise<RemoteResult<UnstageResult>>
  discard(options: DiscardOptions, signal?: AbortSignal): Promise<RemoteResult<DiscardResult>>
  commit(options: CommitOptions, signal?: AbortSignal): Promise<RemoteResult<CommitResult>>
  push(options: PushOptions, signal?: AbortSignal): Promise<RemoteResult<PushResult>>
  pull(signal?: AbortSignal): Promise<RemoteResult<PullResult>>
  fetch(options: FetchOptions, signal?: AbortSignal): Promise<RemoteResult<FetchResult>>
  generateCommitMessage(signal?: AbortSignal): Promise<RemoteResult<GeneratedCommitMessage>>
  log(options: LogOptions, signal?: AbortSignal): Promise<RemoteResult<LogPage>>
  refs(signal?: AbortSignal): Promise<RemoteResult<RefsSnapshot>>
  getCommitDetail(options: ShowOptions, signal?: AbortSignal): Promise<RemoteResult<CommitDetail>>
  /** V2 批次二历史面切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  blame(options: BlameOptions, signal?: AbortSignal): Promise<RemoteResult<BlameResult>>
  compareBranches(options: CompareOptions, signal?: AbortSignal): Promise<RemoteResult<BranchCompareResult>>
  cherryPick(options: CherryPickOptions, signal?: AbortSignal): Promise<RemoteResult<TimeTravelResult>>
  revert(options: RevertOptions, signal?: AbortSignal): Promise<RemoteResult<TimeTravelResult>>
  reset(options: ResetOptions, signal?: AbortSignal): Promise<RemoteResult<TimeTravelResult>>
  abortOperation(signal?: AbortSignal): Promise<RemoteResult<AbortOperationResult>>
  /** V2 批次一管理面切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  branchCreate(options: BranchCreateOptions, signal?: AbortSignal): Promise<RemoteResult<BranchCreateResult>>
  branchSwitch(name: string, signal?: AbortSignal): Promise<RemoteResult<BranchSwitchResult>>
  branchDelete(options: BranchDeleteOptions, signal?: AbortSignal): Promise<RemoteResult<BranchDeleteResult>>
  tagCreate(options: TagCreateOptions, signal?: AbortSignal): Promise<RemoteResult<TagCreateResult>>
  tagDelete(name: string, signal?: AbortSignal): Promise<RemoteResult<TagDeleteResult>>
  remoteList(signal?: AbortSignal): Promise<RemoteResult<RemoteListResult>>
  worktreeList(signal?: AbortSignal): Promise<RemoteResult<WorktreeListResult>>
  worktreeAdd(options: WorktreeAddOptions, signal?: AbortSignal): Promise<RemoteResult<WorktreeAddResult>>
  worktreeRemove(options: WorktreeRemoveOptions, signal?: AbortSignal): Promise<RemoteResult<WorktreeRemoveResult>>
  /** V2 批次三提交链路与护栏切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  stagePatch(options: StagePatchOptions, signal?: AbortSignal): Promise<RemoteResult<StagePatchResult>>
  stashPush(options: StashPushOptions, signal?: AbortSignal): Promise<RemoteResult<StashOpResult>>
  stashList(signal?: AbortSignal): Promise<RemoteResult<StashListResult>>
  stashPop(options: StashPopOptions, signal?: AbortSignal): Promise<RemoteResult<StashOpResult>>
  stashDrop(options: StashDropOptions, signal?: AbortSignal): Promise<RemoteResult<StashOpResult>>
  scanStaged(signal?: AbortSignal): Promise<RemoteResult<CommitScanResult>>
  repoDiagnostics(signal?: AbortSignal): Promise<RemoteResult<RepoDiagnostics>>
  /** V2 批次四体验集成切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  initRepository(signal?: AbortSignal): Promise<RemoteResult<InitResult>>
  submoduleStatus(signal?: AbortSignal): Promise<RemoteResult<SubmoduleStatusResult>>
  auditLog(options: AuditLogOptions, signal?: AbortSignal): Promise<RemoteResult<AuditLogResult>>
  generatePrDescription(signal?: AbortSignal): Promise<RemoteResult<PrDescription>>
  createPr(options: PrCreateOptions, signal?: AbortSignal): Promise<RemoteResult<PrResult>>
  prForBranch(branch: string, signal?: AbortSignal): Promise<RemoteResult<PrLinkResult | null>>
  /** V3 批次一冲突解决切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  conflictList(signal?: AbortSignal): Promise<RemoteResult<ConflictListResult>>
  conflictResolve(options: ConflictResolveOptions, signal?: AbortSignal): Promise<RemoteResult<ConflictResolveResult>>
  conflictMarkResolved(options: ConflictMarkOptions, signal?: AbortSignal): Promise<RemoteResult<ConflictMarkResult>>
  operationContinue(signal?: AbortSignal): Promise<RemoteResult<OperationContinueResult>>
  /** V3 批次二 merge / rebase 切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  branchMerge(options: BranchMergeOptions, signal?: AbortSignal): Promise<RemoteResult<BranchMergeResult>>
  rebase(options: RebaseOptions, signal?: AbortSignal): Promise<RemoteResult<RebaseResult>>
  /** V3 批次三 Agent 工具观测切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  agentToolsStatus(signal?: AbortSignal): Promise<RemoteResult<AgentToolsStatusResult>>
  /** V3 批次四检查点切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  checkpointList(limit?: number | null, signal?: AbortSignal): Promise<RemoteResult<CheckpointListResult>>
  checkpointDiff(options: CheckpointDiffOptions, signal?: AbortSignal): Promise<RemoteResult<CheckpointFileDiff>>
  checkpointRestore(options: CheckpointRestoreOptions, signal?: AbortSignal): Promise<RemoteResult<CheckpointRestoreResult>>
  attributionGet(signal?: AbortSignal): Promise<RemoteResult<AttributionResult>>
  /** V3 批次五自动化观测切片（与 GitNamespaceFace 同形——store/组件按切片消费）。 */
  automationStatus(signal?: AbortSignal): Promise<RemoteResult<AutomationStatusResult>>
}

/** 载波层异常的折叠码（spec §1.0.1：服务未就绪 → gateway/service-unavailable → UI 重试）。 */
export const GATEWAY_UNAVAILABLE = 'gateway/service-unavailable'

/**
 * 挂载 ④-A 生成产物。返回卸载 disposer（$mount 的语义：resolve 前等待
 * mountContribution 完成——命名空间 service fiber 与方法组同步安装）。
 */
export async function mountGitRemote(ctx: GitRemoteContext): Promise<() => Promise<void>> {
  return ctx.remote.$mount(gitRemote)
}

/**
 * 构造 spec §3.2 的 RPC 注入口（生产半）。`ready` 为挂载完成信号——每次调用先等待它，
 * 使 store 顶层即刻 start() 的首次 followStatus 自然等到命名空间就绪（无竞态）。
 * 命名空间方法返回的 RemoteResult 原样透传；载波 reject 折叠为
 * `{ ok:false, error:{ code: gateway/service-unavailable } }`。
 */
export function createGitRpcClient(ctx: GitRemoteContext, ready: Promise<void>): GitRpcFace {
  const namespace = async (): Promise<GitNamespaceFace> => {
    await ready
    // 挂载完成后 `git` 命名空间已在 TypertRemoteNamespaceMap 合并面可用
    // （生成产物的 declare module）。以结构面窄化，隔离协议类型别名差异。
    const git = ctx.remote['git'] as GitNamespaceFace | undefined
    if (git === undefined) {
      throw new Error('dsh-plugin-git: remote.git namespace is not mounted')
    }
    return git
  }
  return {
    async ping(signal) {
      try {
        return await (await namespace()).ping(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async identity(scope, signal) {
      try {
        return await (await namespace()).identity(scope, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async status(signal) {
      try {
        return await (await namespace()).status(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async followStatus(signal) {
      try {
        return await (await namespace()).followStatus(signal)
      } catch (cause) {
        throw unavailableCause(cause)
      }
    },
    async diff(scope, path, signal) {
      try {
        return await (await namespace()).diff(scope, path, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async stage(paths, signal) {
      try {
        return await (await namespace()).stage(paths, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async unstage(paths, signal) {
      try {
        return await (await namespace()).unstage(paths, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async discard(options, signal) {
      try {
        return await (await namespace()).discard(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async commit(options, signal) {
      try {
        return await (await namespace()).commit(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async push(options, signal) {
      try {
        return await (await namespace()).push(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async pull(signal) {
      try {
        return await (await namespace()).pull(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async fetch(options, signal) {
      try {
        return await (await namespace()).fetch(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async generateCommitMessage(signal) {
      try {
        return await (await namespace()).generateCommitMessage(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async log(options, signal) {
      try {
        return await (await namespace()).log(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async refs(signal) {
      try {
        return await (await namespace()).refs(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async getCommitDetail(options, signal) {
      try {
        return await (await namespace()).getCommitDetail(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V2 批次一管理面（host refs-admin 模块；plan §3.3）──
    async branchCreate(options, signal) {
      try {
        return await (await namespace()).branchCreate(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async branchSwitch(name, signal) {
      try {
        return await (await namespace()).branchSwitch(name, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async branchDelete(options, signal) {
      try {
        return await (await namespace()).branchDelete(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async tagCreate(options, signal) {
      try {
        return await (await namespace()).tagCreate(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async tagDelete(name, signal) {
      try {
        return await (await namespace()).tagDelete(name, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async remoteList(signal) {
      try {
        return await (await namespace()).remoteList(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async worktreeList(signal) {
      try {
        return await (await namespace()).worktreeList(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async worktreeAdd(options, signal) {
      try {
        return await (await namespace()).worktreeAdd(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async worktreeRemove(options, signal) {
      try {
        return await (await namespace()).worktreeRemove(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V2 批次二历史面（host blame/time-travel/graph 扩展；plan §4.3）──
    async blame(options, signal) {
      try {
        return await (await namespace()).blame(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async compareBranches(options, signal) {
      try {
        return await (await namespace()).compareBranches(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async cherryPick(options, signal) {
      try {
        return await (await namespace()).cherryPick(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async revert(options, signal) {
      try {
        return await (await namespace()).revert(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async reset(options, signal) {
      try {
        return await (await namespace()).reset(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async abortOperation(signal) {
      try {
        return await (await namespace()).abortOperation(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V2 批次三提交链路与护栏（host staging-patch/stash/guard-scan/diagnostics；plan §5.3）──
    async stagePatch(options, signal) {
      try {
        return await (await namespace()).stagePatch(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async stashPush(options, signal) {
      try {
        return await (await namespace()).stashPush(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async stashList(signal) {
      try {
        return await (await namespace()).stashList(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async stashPop(options, signal) {
      try {
        return await (await namespace()).stashPop(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async stashDrop(options, signal) {
      try {
        return await (await namespace()).stashDrop(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async scanStaged(signal) {
      try {
        return await (await namespace()).scanStaged(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async repoDiagnostics(signal) {
      try {
        return await (await namespace()).repoDiagnostics(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V2 批次四体验集成（host admin-repo/submodule/audit/message-gen/pr；plan §6.3）──
    async initRepository(signal) {
      try {
        return await (await namespace()).initRepository(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async submoduleStatus(signal) {
      try {
        return await (await namespace()).submoduleStatus(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async auditLog(options, signal) {
      try {
        return await (await namespace()).auditLog(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async generatePrDescription(signal) {
      try {
        return await (await namespace()).generatePrDescription(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async createPr(options, signal) {
      try {
        return await (await namespace()).createPr(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async prForBranch(branch, signal) {
      try {
        return await (await namespace()).prForBranch(branch, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V3 批次一冲突解决（host conflicts.ts 模块；v3-implementation-plan §3.3）──
    async conflictList(signal) {
      try {
        return await (await namespace()).conflictList(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async conflictResolve(options, signal) {
      try {
        return await (await namespace()).conflictResolve(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async conflictMarkResolved(options, signal) {
      try {
        return await (await namespace()).conflictMarkResolved(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async operationContinue(signal) {
      try {
        return await (await namespace()).operationContinue(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V3 批次二 merge / rebase（host merge-rebase.ts 模块；v3-implementation-plan §4.3）──
    async branchMerge(options, signal) {
      try {
        return await (await namespace()).branchMerge(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async rebase(options, signal) {
      try {
        return await (await namespace()).rebase(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V3 批次三 Agent 工具观测面（host agent-tools.ts 模块；v3-implementation-plan §5.5）──
    async agentToolsStatus(signal) {
      try {
        return await (await namespace()).agentToolsStatus(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    // ── V3 批次五自动化观测面（host automation.ts 模块；v3-implementation-plan §7.3）──
    async automationStatus(signal) {
      try {
        return await (await namespace()).automationStatus(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async checkpointList(limit, signal) {
      try {
        return await (await namespace()).checkpointList(limit, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async checkpointDiff(options, signal) {
      try {
        return await (await namespace()).checkpointDiff(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async checkpointRestore(options, signal) {
      try {
        return await (await namespace()).checkpointRestore(options, signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
    async attributionGet(signal) {
      try {
        return await (await namespace()).attributionGet(signal)
      } catch (cause) {
        return unavailableResult(cause)
      }
    },
  }
}

function unavailableCause(cause: unknown): Error & { code: string } {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(`dsh-plugin-git: ${GATEWAY_UNAVAILABLE} — ${message}`) as Error & { code: string }
  error.name = 'GitRpcUnavailable'
  error.code = GATEWAY_UNAVAILABLE
  return error
}

function unavailableResult(cause: unknown): RemoteResult<never> {
  return {
    ok: false,
    error: { code: GATEWAY_UNAVAILABLE, message: unavailableCause(cause).message },
  }
}
