/**
 * dsh-gitkit — remote 命名空间挂载与 RPC 面（spec §3.1/§3.2）。
 *
 * 本文件挂载 typert-generator 的生成产物 `dsh-gitkit/remote`（TypertRemoteInfo：package
 * + descriptors + strict codec，勿手编）进 gateway client 的 `ctx.remote`（$mount 在调用
 * 方 fiber 的 effect 内按 namespace 安装方法组；`git` 命名空间的 service fiber 名为
 * `remote.git`，仅在本次 $mount 内创建），并把挂载后的命名空间包装成 spec §3.2 的
 * GitRpcFace 注入口。方法面 = host `REMOTE_METHODS` 的全量镜像（host 表 ⇄ 生成描述符 ⇄
 * client 面三方恒等，tests/loader-composition.spec 对账）。历批次（F 变更面板 / V2 批次
 * 一~四 / V3 批次一~五）的逐方法接线史与 D* 决策不在此赘述——以 git 历史为准，规范记载
 * 见 docs/v2-implementation-plan.md、docs/v3-implementation-plan.md 各批次段；分批语义
 * 注记保留在位（GitNamespaceFace 逐切片注记 + GIT_NAMESPACE_METHODS 分段注释）。两条硬
 * 事实：① **inject 不得声明 `remote.git`**——命名空间只在本插件 $mount 内出现，声明注入
 * 即装载死锁（boot audit 形态 "pending (waiting for service: remote.git)"）；② 错误折叠
 * ——gateway 对 RemoteError 过线为 {ok:false,error}（map §2.4），载波层异常（连接缺失/
 * 服务未就绪）折叠为 `gateway/service-unavailable`（spec §1.0.1：UI 显示重试）。产物以
 * import 内联进本 bundle，zod 走基线 external（scripts/build-client.mjs EXTERNALS）。
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
  /**
   * Cordis 反射读（`ctx.get` 的服务查找面）——**无 inject 守卫**。本插件不 inject
   * `remote.git`（声明即装载死锁，见文件头硬事实①），而属性读 `ctx.remote.git` 会被
   * Service 的 traceable 代理按 `associate` 前缀改写成受守卫的 `ctx['remote.git']`，
   * 故命名空间只能经本方法读取（dsh 自身 client-hmr 读自挂命名空间即同款写法）。
   */
  get(name: string): unknown
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

/**
 * 本模块消费的 RPC 面（spec §3.2 GitRpcClient 全量 = host REMOTE_METHODS 镜像；store/组件按切片消费）。
 *
 * **Phase 2·client（RPC 装配面收敛）派生装配**：非流方法与 `GitNamespaceFace`（挂载后
 * 生成命名空间的签名表）同名同形，唯 `followStatus` 是协议形状分叉点——命名空间半
 * `@Remote({mode:'stream'})` 直返 `RemoteStream`（结构投影 `GitStreamHandle`；协议红线：
 * Promise 包装会被 generator 拒绝），RPC 半包装为 `Promise<GitStreamHandle<…>>`（不折叠
 * RemoteResult，直返流句柄）。故以 `Omit` 派生替代第二份手写签名表：两面的签名对账由
 * 编译面构造性保证（旧双表逐字同步的维护面收敛为一），键集运行期对账仍由
 * tests/loader-composition.spec 三方对账锚定（host REMOTE_METHODS ⇄ 生成描述符 ⇄ client 面）。
 */
export type GitRpcFace = Omit<GitNamespaceFace, 'followStatus'> & {
  followStatus(signal?: AbortSignal): Promise<GitStreamHandle<GitStatusFrame, GitFollowCommand>>
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
 *
 * **Phase 2·client（RPC 装配面收敛）动态装配**：55 个同构包装由 GIT_NAMESPACE_METHODS
 * 循环生成（`await ready` → 按名分发命名空间 → try/await/catch→unavailableResult 折叠，
 * 与旧手写逐方法包装逐字节同义），`followStatus` 保持唯一显式实现（`@Remote({mode:'stream'})`
 * 直返流句柄，不走 RemoteResult 折叠——载波 reject 以带码 Error 重组上抛）。新增
 * @Remote 方法只需同步 GitNamespaceFace + GIT_NAMESPACE_METHODS 两处，包装面免改。
 */
export function createGitRpcClient(ctx: GitRemoteContext, ready: Promise<void>): GitRpcFace {
  const namespace = async (): Promise<GitNamespaceFace> => {
    await ready
    // 读法：`ctx.get('remote.git')`（无 inject 守卫的反射读；dsh 自身 client-hmr 读自挂
    // 命名空间同款）。**不能**写 `ctx.remote.git`——Service 的 traceable 代理带
    // `associate = 'remote'`，该属性读会被改写成受守卫的 `ctx['remote.git']` 访问；本插件
    // 刻意不 inject `remote.git`（声明即装载死锁，见文件头硬事实①），于是必抛
    // `cannot get property "remote.git" without inject`（cordis reflect.ts 的 get 陷阱）。
    const git = ctx.get('remote.git') as GitNamespaceFace | undefined
    if (git === undefined) {
      throw new Error('dsh-plugin-git: remote.git namespace is not mounted')
    }
    return git
  }

  // ── 55 个同构包装（GIT_NAMESPACE_METHODS 循环装配；折叠语义与旧手写包装逐字节同义）──
  // rest 形参逐位透传 ⇒ AbortSignal 以同一实例抵达命名空间调用的末位实参（旧手写
  // `(…, signal)` 同 arity——loader-composition 循环断言锚定）。键集对账由编译面半保证：
  // 循环以 GIT_NAMESPACE_METHODS 为源（漏键即缺面），`git[name]` 按名索引要求清单键
  // ⊆ GitNamespaceFace keyof（清单与签名表漂移编译即红）；运行期对账在
  // tests/loader-composition.spec（产物函数键 = 清单键）。
  const forwarders: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const name of GIT_NAMESPACE_METHODS) {
    if (name === 'followStatus') continue // 唯一显式实现（流句柄直返；见返回对象）
    forwarders[name] = async (...args: unknown[]) => {
      try {
        const git = await namespace()
        // 55 个签名共享运行期形（…前置实参, signal?）→ Promise<RemoteResult>；
        // 联合签名不可直接 spread 调用，窄化为统一可调用形（结构收窄——类型面仅此一处
        // 内部分发窄化 + 返回对象一处 as GitRpcFace）。
        const call = git[name] as (...callArgs: unknown[]) => Promise<unknown>
        return await call(...args)
      } catch (cause) {
        return unavailableResult(cause)
      }
    }
  }
  return {
    ...forwarders,
    async followStatus(signal?: AbortSignal) {
      try {
        return await (await namespace()).followStatus(signal)
      } catch (cause) {
        throw unavailableCause(cause)
      }
    },
  } as GitRpcFace
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
