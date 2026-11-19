/**
 * dsh-gitkit — Agent 工具面（v3 批次三：[清单 45]；docs/v3-implementation-plan.md
 * §5.3–§5.5）。
 *
 * 平台契约（spike 定案，2026-11-13 实读 D:\DeepSeekHarness 参照树）：
 *   - ToolDefinition = ToolSchema {name, description, parameters: Record<string,unknown>,
 *     deferLoading?}（packages/llm/llm/src/types.ts:517-528）+ 强制 output:
 *     ToolOutputDefinition {schema: JsonSchemaNode, render(args, value): ContentBlock[],
 *     presentationMeta?}（core/tools/src/contracts.ts:17-24）+ execute(args, exec)
 *     （contracts.ts:40）。`ctx.tools.register(definition, options?)` 返回撤销 disposer
 *     （core/tools/src/index.ts:121-153；同层重名抛错、run_code 保留名）。
 *   - **raw JSON Schema 形态**（plan §5.2-2 定案）：parameters/output.schema 直接给
 *     assertSupportedJsonSchema 的子集（type/oneOf/properties/required/
 *     additionalProperties/items/enum/const + 注解；type 单字符串——json-schema.ts:267/
 *     :304）。register() 不经 defineTool 编译（schema.ts:450 的编译产物即本子集），
 *     参数校验由本文件 execute 包装自带（defineTool 是 dsh-tools 运行时函数——
 *     零运行期依赖纪律禁止 import）。
 *   - output.schema 实测坑（spike）：对象节点必须显式 additionalProperties:boolean；
 *     output 侧不写 required（raw 侧亦无需——execute 恒返回全量对象）。
 *   - ToolGuard = (execution) => string | ToolGuardDenial | undefined（contracts.ts:410；
 *     rc.2 加宽后 **string 仍合法**——0.2.1-rc.5 下限路径只用 string，plan §0 批次〇-4
 *     「rc.2 增量身份不得在下限路径引用」）。guard 在 tools/pre-execute 瀑布之后、
 *     工具体之前求值；单调 deny（返回 string = 拒绝理由）。
 *
 * 零运行期依赖纪律（plan §0.2-①）：本文件用**本地最小结构接口**构造工具定义与
 * ctx.tools 切片面（workspace.ts:65-74 最小切片先例；type-only 对齐 dsh-tools
 * contracts.ts 形状，不新增 runtime dependency）。ctx.tools 经可选切片读取
 * （`ctx.get('tools')`，fs/llm 切片先例 index.ts readFsFace/readLlmFace）——
 * **绝不**进 static inject（否则未挂 tools 的部署整个 git 服务拒载）。
 *
 * 可达性时序（cordis fiber 语义，node_modules/@deepseek-ai/cordis/lib/index.js
 * reflect.d.ts:14-20 与 lib/index.js:832-849 实读）：ctx.get(name) 只回**已激活**
 * fiber 提供的实现；git 服务只 inject ['subprocess']，与 tools 服务无依赖边 ⇒
 * 构造时 ctx.get('tools') 可能尚未就绪。注册面 = **即时尝试 + 'internal/service'
 * 事件跟随 + 宽限期单次 warn**：
 *   - 即时 ctx.get 命中 ⇒ 立刻注册（spike probe 的同形路径），并保持事件监听
 *     （tools 服务重载 ⇒ 实例变更重绑）；
 *   - 未命中 ⇒ 监听 `internal/service`（reflect.notify 对每次 provide/变更发射
 *     lib/index.js:849；dispatch 的 hook 过滤按 isolate 键相等放行——兄弟 fiber 的
 *     tools provide 会到达本监听）⇒ 事件到达时注册；
 *   - 宽限期（默认 5s）内始终未观察到 ⇒ log 一次 + toolsFaceAvailable=false（plan
 *     §5.10「降级路径必须静默且可观测」）。事件迟到仍会注册并翻转状态。
 *
 * 白名单（plan §5.4 表，本文件为唯一权威）：readonly 8 个
 * （git_status/git_diff/git_log/git_refs/git_blame/git_commit_detail/
 * git_compare_branches/git_repo_diagnostics）+ readwrite 增 3 个
 * （git_stage/git_unstage/git_commit）。**merge/rebase/cherry-pick/reset 等高危写
 * 不进白名单**（§8 DG=A 定案——模型直接改写历史的口子不开）。工具 execute **直调
 * 引擎层**（不走 RPC 自调——@Remote 方法面不经 wire）；失败以工具结果文本返回
 * （`{ok:false,error,message}` 值，不抛宿主异常——plan §5.4「tools 管线有自己的
 * 错误结果语义」）；返回**纯 JSON**（plain object/无 Date/无 Map——wire 序列化纪律
 * 同源 §0.1）。model-facing 描述固定英文串（模型面非 UI 面，不进 locale——plan
 * §5.4）。
 *
 * 审计（§1-(b) 核对——**与任务口径的「引擎层已有」不符，如实修正**）：审计环的
 * record 只挂在 **index.ts @Remote 方法面**（index.ts:629/635 等——引擎层
 * mutations.ts/commit.ts 零 audit 调用，grep 实证）；工具 execute **绕过** @Remote
 * 面直调引擎 ⇒ 不挂则写操作零审计。本文件对三个写工具（git_stage/git_unstage/
 * git_commit）按批次四双出口纪律挂 AuditEngine.record（成功出口 ok:true+白名单
 * 摘要、catch 出口 ok:false+域码+空摘要——audit.ts §6.5 同款；op 名用工具名，与
 * 同名 RPC op 'stage'/'commit' 区分；autoFetch 非 @Remote op 已在环内合法——
 * index.ts:1828 先例）。任务口径 item 5 的测试（git_commit 全链 audit 入环）以
 * 此为前提。
 *
 * git_commit 内嵌 scanStaged 前检（plan §5.4，DD=A 硬阻断）：commit 引擎守卫 3.6
 * （commit.ts:189-）本就硬阻断 secret（overridable:false），但那是提交路径纵深半；
 * 前检让 secret 命中在**零命令**处拒绝（不进 commit 管线）。前检自身失败 ⇒ 放行
 * 进 commit 引擎（引擎守卫兜底——guard-scan「扫描失败不阻断」降级纪律同源）。
 * 非 secret 违规（large-file/build-artifact/eol/env-file）**不**拒绝（D5=A 豁免语义
 * 属 client danger 闸，host commit 本就不拦——commit.ts 守卫 3.6 注）。
 *
 * git_status 上限裁剪（plan §5.4）：四组文件列表各自封顶（STATUS_TOOL_GROUP_MAX=100），
 * 超限 ⇒ truncated=true + hint 引导缩小 path 过滤（计数仍全量）。patch/对比列表/
 * log 页大小的模型上下文预算见 TOOL_PATCH_MAX_CHARS / TOOL_COMPARE_LIST_MAX /
 * TOOL_LOG_MAX_LIMIT（引擎字节/行数预算之外的二次裁剪，均带 truncated/hint 如实
 * 标记）。
 */

import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { AuditEngine } from './audit.ts'
import type { BlameEngine } from './blame.ts'
import type { CommitEngine } from './commit.ts'
import type { DiagnosticsEngine } from './diagnostics.ts'
import type { DiffEngine } from './diff.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { GraphEngine } from './graph.ts'
import type { GuardScanEngine } from './guard-scan.ts'
import type { MutationEngine } from './mutations.ts'
import type { StatusEngine } from './status.ts'
import type { AgentToolsMode, AgentToolsStatusState, CommitViolation, DiffFile, FileChange } from './types.ts'

// ── 本地最小结构接口（零运行期依赖 dsh-tools；形状对齐见文件头契约注记） ──

/** ContentBlock 的工具 render 投影（dsh-llm types.ts:69 TextBlock——工具输出只用 text 块）。 */
export interface GitToolTextBlock {
  type: 'text'
  text: string
}

/** ToolRunContext 最小面（core/tools/src/contracts.ts:245-262——工具体只消费 signal）。 */
export interface GitToolRunContext {
  /** 调用方取消信号（异步工作必须 observe/forward——contracts.ts execute 契约）。 */
  readonly signal: AbortSignal
  readonly name?: string
  readonly arguments?: unknown
}

/** ToolOutputDefinition 最小面（contracts.ts:17-24）。 */
export interface GitToolOutputDefinition {
  /** raw JSON Schema（assertSupportedJsonSchema 子集；对象节点显式 additionalProperties）。 */
  readonly schema: Record<string, unknown>
  /** 纯投影：canonical 值 → ContentBlock[]（本工具面恒单 text 块）。 */
  render(args: unknown, value: unknown): GitToolTextBlock[]
}

/** ToolDefinition 最小面（llm/types.ts:517-528 ToolSchema + contracts.ts ToolDefinition）。 */
export interface GitToolDefinition {
  readonly name: string
  readonly description: string
  /** raw JSON Schema（implicit open object root——schema.ts:450 编译产物同形）。 */
  readonly parameters: Record<string, unknown>
  readonly output: GitToolOutputDefinition
  execute(args: unknown, exec: GitToolRunContext): Promise<unknown>
}

/** ctx.tools 注册面最小切片（core/tools/src/index.ts:121-153 register / :384 guard）。 */
export interface GitToolsFace {
  register(definition: GitToolDefinition, options?: unknown): () => void
  /** ToolGuard 形状（contracts.ts:410——本面收窄为 string 理由，0.2.1-rc.5 下限合法）。 */
  guard?(guard: (execution: { readonly name: string; readonly arguments: unknown }) => string | undefined): () => void
}

/** 宿主上下文的事件面切片（'internal/service' 反射事件——cordis lib/index.js:849）。 */
export interface GitAgentToolsEventHost {
  on(event: 'internal/service', listener: (name: string, value: unknown) => void): unknown
}

// ── 白名单权威表（plan §5.4） ──

/** readonly 档 8 工具（顺序 = 注册序 = registered 断言序）。 */
export const READONLY_TOOL_NAMES: readonly string[] = Object.freeze([
  'git_status', 'git_diff', 'git_log', 'git_refs', 'git_blame',
  'git_commit_detail', 'git_compare_branches', 'git_repo_diagnostics',
])

/** readwrite 档追加 3 工具。 */
export const READWRITE_TOOL_NAMES: readonly string[] = Object.freeze([
  'git_stage', 'git_unstage', 'git_commit',
])

// ── 常量 ──

/** git_status 单组文件列表封顶（plan §5.4「单次返回上限，超限引导缩小 path 过滤」）。 */
export const STATUS_TOOL_GROUP_MAX = 100

/** 工具面 patch 文本单文件字符封顶（模型上下文预算——引擎字节预算之外的二次裁剪）。 */
export const TOOL_PATCH_MAX_CHARS = 20_000

/** git_log 工具单页提交封顶（模型上下文预算；引擎 logMaxLimit 钳制仍生效）。 */
export const TOOL_LOG_MAX_LIMIT = 200

/** git_compare_branches ahead/behind 列表各侧封顶。 */
export const TOOL_COMPARE_LIST_MAX = 50

/** tools 面宽限期毫秒（超时未观察到 ⇒ 单次 warn + toolsFaceAvailable=false）。 */
export const AGENT_TOOLS_GRACE_MS = 5_000

/** guard 的 shell 类工具名匹配（plan §5.3：名称匹配 bash|shell|pwsh）。 */
const SHELL_TOOL_NAME_RE = /bash|shell|pwsh|powershell|cmd/i

/**
 * guard 的 git 命令模式（「git + 子命令词表」——仅 `git` 裸词不足：注释/文案里的
 * "git" 会误伤；子命令词表把误报压到「真在调 git 子命令」的形态。启发式防线，
 * 误报/绕过面如实登记 plan §5.3/§5.10/§9——默认关）。
 */
const GIT_SUBCOMMAND_RE = /\bgit\b(?:\s+(?:-{1,2}[\w-]+|"[^"]*"))*\s+(status|diff|log|blame|show|add|commit|push|pull|fetch|branch|checkout|switch|merge|rebase|tag|stash|reset|restore|rm|mv|clean|cherry-pick|revert|am|apply|rev-parse|rev-list|remote|worktree|init|clone|config|reflog|describe|shortlog|ls-files|for-each-ref|symbolic-ref|submodule|bisect|grep|gc|fsck|archive|bundle|notes|range-diff|whatchanged)\b/i

/** guard 参数串化上限（防病态巨型参数；超出截断——匹配是启发式，截断无损其定位）。 */
const GUARD_ARGS_TEXT_MAX = 100_000

/** guard 参数递归收集深度上限。 */
const GUARD_ARGS_DEPTH_MAX = 4

// ── 引擎依赖束与注册项 ──

/** 工具 execute 消费的引擎束（全部为 index.ts 已装配的引擎实例——直调，非 RPC）。 */
export interface AgentToolEngines {
  status: StatusEngine
  diff: DiffEngine
  graph: GraphEngine
  blame: BlameEngine
  mutations: MutationEngine
  commit: CommitEngine
  guardScan: GuardScanEngine
  diagnostics: DiagnosticsEngine
}

/** registerAgentTools 构造项。 */
export interface RegisterAgentToolsOptions {
  /** 工具档位（Config.agentTools；'off' 时仍可仅注册 guard）。 */
  mode: AgentToolsMode
  /** Config.agentToolBlockShellGit——true 时注册 shell-git 引导 guard。 */
  blockShellGit: boolean
  /** 引擎束（直调）。 */
  engines: AgentToolEngines
  /** 审计环（写工具双出口 record）。 */
  audit: AuditEngine
  /** 宿主上下文事件面（'internal/service' 跟随）。 */
  host: GitAgentToolsEventHost
  /** 即时读取 ctx.tools 的取面函数（返回 undefined = 未就绪/未挂载）。 */
  readFace(): GitToolsFace | undefined
  logger: GitLoggerFace
  /** 状态宿主（index.ts 持有、agentToolsStatus 投影——本模块原地更新）。 */
  state: AgentToolsStatusState
  /** 宽限期毫秒（缺省 AGENT_TOOLS_GRACE_MS；测试可缩短）。 */
  graceMs?: number
  /** 写后刷新回调（index.ts afterWrite——status 缓存作废 + R3 帧；写工具成功后触发，automation.ts onWrite 同口径——写后与 RPC 写同刷新）。 */
  onWrite?: () => void
}

/** 注册句柄：dispose = 撤销全部注册与监听（ctx.effect 清理纪律）。 */
export interface AgentToolsRegistration {
  dispose(): void
}

/**
 * 注册面（plan §5.5）：即时尝试 + 'internal/service' 事件跟随 + 宽限期单次 warn。
 * 每工具 register 包 try/catch（schema 校验拒绝 ⇒ log + 跳过该工具，**不炸服务**——
 * plan §5.10）；同层重名同理（事件跟随的重注册先撤销旧面，重名不可能，防御性兜底）。
 */
export function registerAgentTools(options: RegisterAgentToolsOptions): AgentToolsRegistration {
  const { mode, blockShellGit, engines, audit, host, logger, state, onWrite } = options
  const graceMs = options.graceMs ?? AGENT_TOOLS_GRACE_MS
  const definitions = mode === 'readwrite'
    ? buildAgentToolDefinitions(engines, audit, onWrite)
    : mode === 'readonly'
      ? buildAgentToolDefinitions(engines, audit, onWrite).filter((definition) => (READONLY_TOOL_NAMES as readonly string[]).includes(definition.name))
      : []
  let boundFace: GitToolsFace | undefined
  let disposers: Array<() => void> = []
  let listenerDisposer: (() => void) | undefined
  let observed = false
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  const setState = (faceAvailable: boolean, names: readonly string[]): void => {
    state.toolsFaceAvailable = faceAvailable
    state.registered = [...names]
  }

  const runDisposer = (dispose: () => void): void => {
    try {
      dispose()
    } catch (error) {
      logger.warn(`agent-tools: disposer threw (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const unbind = (): void => {
    for (const dispose of disposers) runDisposer(dispose)
    disposers = []
    boundFace = undefined
  }

  const bind = (candidate: GitToolsFace): void => {
    unbind()
    boundFace = candidate
    observed = true
    const names: string[] = []
    // 逐工具注册（schema 校验拒绝/重名 ⇒ log + 跳过，不炸服务——plan §5.10）。
    for (const definition of definitions) {
      try {
        disposers.push(candidate.register(definition))
        names.push(definition.name)
      } catch (error) {
        logger.warn(`agent-tools: registering ${definition.name} rejected by the tools face (${error instanceof Error ? error.message : String(error)}); skipped`)
      }
    }
    // guard（plan §5.3；face 缺 guard 方法 = 旧代宿主——log + 跳过，不影响工具注册）。
    if (blockShellGit) {
      if (typeof candidate.guard === 'function') {
        try {
          disposers.push(candidate.guard(shellGitGuard))
        } catch (error) {
          logger.warn(`agent-tools: guard registration rejected (${error instanceof Error ? error.message : String(error)})`)
        }
      } else {
        logger.warn('agent-tools: agentToolBlockShellGit is enabled but the tools face has no guard() method; guard skipped')
      }
    }
    setState(true, names)
    logger.debug(`agent-tools: ${String(names.length)} tool(s) registered on the tools face (mode=${mode})`)
  }

  // 事件跟随：tools 服务的 provide/变更/移除（reflect.notify 每次发射——文件头时序注）。
  const offListener = host.on('internal/service', (name, value) => {
    if (name !== 'tools') return
    if (value === undefined || value === null) {
      unbind()
      observed = false
      setState(false, [])
      return
    }
    const candidate = value as Partial<GitToolsFace>
    if (typeof candidate.register !== 'function' || candidate === boundFace) return
    bind(candidate as GitToolsFace)
  })
  if (typeof offListener === 'function') listenerDisposer = offListener as () => void

  const initialFace = options.readFace()
  if (initialFace !== undefined) {
    // 即时命中：立刻注册（事件监听保持——服务重载 ⇒ 实例变更重绑）。
    bind(initialFace)
  } else {
    setState(false, [])
    // 宽限期：始终未观察到 ⇒ 单次 warn + toolsFaceAvailable=false（降级可观测）。
    // **off 档且 guard 关时静默**（用户未启用工具面，warn 属噪声）——观测面照常
    // （toolsFaceAvailable 与 mode 解耦：off 档在已挂 tools 的部署如实回 true）。
    const featureEnabled = mode !== 'off' || blockShellGit
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (observed || !featureEnabled) return
      logger.warn(`agent-tools: tools face not observed within ${String(graceMs)}ms (mode=${mode}); no tools registered (agentToolsStatus.toolsFaceAvailable=false)`)
    }, graceMs)
    if (typeof graceTimer.unref === 'function') graceTimer.unref()
  }

  return {
    dispose(): void {
      if (graceTimer !== null) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      unbind()
      observed = false
      setState(false, [])
      if (listenerDisposer !== undefined) {
        runDisposer(listenerDisposer)
        listenerDisposer = undefined
      }
    },
  }
}

// ── guard（plan §5.3；引导性防线非安全边界——误报面如实登记） ──

/**
 * shell-git 引导 guard：shell 类工具的调用参数含 git 命令模式 ⇒ deny（文案引导改用
 * git_* 工具）。单调 deny（返回 string = 拒绝理由，ToolGuard rc.2 加宽后仍合法）。
 * **误报面如实登记**（plan §5.3/§5.10）：多行脚本/间接执行/编码绕过不在拦截面内
 * ——本 guard 是引导性防线不是安全边界，默认关（Config.agentToolBlockShellGit）。
 */
export function shellGitGuard(execution: { readonly name: string; readonly arguments: unknown }): string | undefined {
  if (!SHELL_TOOL_NAME_RE.test(execution.name)) return undefined
  const text = collectArgStrings(execution.arguments, 0).join('\n').slice(0, GUARD_ARGS_TEXT_MAX)
  if (!GIT_SUBCOMMAND_RE.test(text)) return undefined
  return [
    'Blocked: shell invocations of git are disabled in this deployment (agentToolBlockShellGit).',
    'Use the dedicated git tools instead: git_status, git_diff, git_log, git_refs, git_blame,',
    'git_commit_detail, git_compare_branches, git_repo_diagnostics (read-only) and, when the',
    "deployment enables 'readwrite', git_stage, git_unstage, git_commit. The guard is a",
    'guidance fence, not a security boundary.',
  ].join(' ')
}

/** 递归收集参数中的字符串叶（深度/总量有界——guard 只做启发式匹配）。 */
function collectArgStrings(value: unknown, depth: number): string[] {
  if (depth > GUARD_ARGS_DEPTH_MAX) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) parts.push(...collectArgStrings(item, depth + 1))
    return parts
  }
  if (typeof value === 'object' && value !== null) {
    const parts: string[] = []
    for (const item of Object.values(value as Record<string, unknown>)) parts.push(...collectArgStrings(item, depth + 1))
    return parts
  }
  return []
}

// ── 工具值形状（纯 JSON——wire 序列化纪律同源） ──

/** 全工具统一的失败值（plan §5.4「失败以工具结果文本返回，不抛宿主异常」）。 */
export interface ToolErrorValue {
  ok: false
  /** 域错误码（`git/<name>`；非域错误 = 'gateway/internal'——index.ts errorCodeOf 同口径）。 */
  error: string
  /** 英文诊断文本（域错误 message 原样——stderr 已在引擎侧脱敏；不落文件内容）。 */
  message: string
}

/** 全工具统一的 output schema（对象 + ok 旗标；open 对象——spike 坑：显式 additionalProperties）。 */
const TOOL_OUTPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' } },
})

/** 投影 FileChange 的模型面字段（path 必有；其余非 null 才落——无 undefined 值键）。 */
function projectChange(change: FileChange): Record<string, unknown> {
  const projected: Record<string, unknown> = { path: change.path, kind: change.kind }
  if (change.origPath !== null) projected.origPath = change.origPath
  if (change.binary) projected.binary = true
  if (change.additions !== null) projected.additions = change.additions
  if (change.deletions !== null) projected.deletions = change.deletions
  return projected
}

/** DiffFile 的模型面投影（patch 走 TOOL_PATCH_MAX_CHARS 二次裁剪）。 */
function projectDiffFile(file: DiffFile): Record<string, unknown> {
  const capped = capPatch(file.patch)
  const projected: Record<string, unknown> = {
    path: file.path,
    status: file.status,
    binary: file.binary,
    additions: file.additions,
    deletions: file.deletions,
    oversized: file.oversized,
    patchTruncated: capped.patchTruncated,
  }
  if (file.origPath !== null) projected.origPath = file.origPath
  if (capped.patch !== null) projected.patch = capped.patch
  return projected
}

/** patch 文本二次裁剪（引擎字节预算外的模型上下文预算——TOOL_PATCH_MAX_CHARS）。 */
function capPatch(patch: string | null): { patch: string | null; patchTruncated: boolean } {
  if (patch === null || patch.length <= TOOL_PATCH_MAX_CHARS) return { patch, patchTruncated: false }
  return { patch: patch.slice(0, TOOL_PATCH_MAX_CHARS), patchTruncated: true }
}

/** 域错误 → 工具失败值（remoteErrorOf 判别；非域错误收敛 gateway/internal）。 */
function toolError(cause: unknown): ToolErrorValue {
  const remote = remoteErrorOf(cause)
  if (remote === undefined) {
    return { ok: false, error: 'gateway/internal', message: cause instanceof Error ? cause.message : String(cause) }
  }
  return { ok: false, error: remote.code, message: remote.message }
}

/** 工具定义工厂的公共包装：render = 单 text 块 JSON 投影；参数 defensively 归一。 */
function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown> | ToolErrorValue>,
): GitToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): GitToolTextBlock[] {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args: unknown, exec: GitToolRunContext): Promise<unknown> {
      // 参数 defensively 归一（无 defineTool 校验——本工具面自带最小校验：只接受
      // plain object 参数，字段级校验在各 run 内以域语义承担）。
      const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      // 失败以工具结果文本返回（文件头/plan §5.4 契约「不抛宿主异常」——评审收口）：
      // read 工具的引擎域错误（no-repository / unknown-revision / blame-oversized 等）
      // 就地转 {ok:false,error,message}；write 工具体内已有 try/catch + audit 失败
      // 出口，语义不变——本层 catch 是全工具统一的兜底（双保险不重复审计）。
      try {
        return await run(record, exec.signal)
      } catch (cause) {
        return toolError(cause)
      }
    },
  }
}

// ── 定义表（plan §5.4 权威表） ──

/**
 * 11 工具定义表（声明序 = 注册序 = READONLY_TOOL_NAMES/READWRITE_TOOL_NAMES 断言序）。
 * 每工具：parameters raw JSON Schema（requiredness 落 properties 旁的 required 数组）、
 * execute 直调引擎、失败收敛 `{ok:false,error,message}`。三个写工具成功路径尾部触发
 * `onWrite`（index.ts afterWrite——status 失效 + R3 帧，automation.ts onWrite 同口径；
 * 失败路径不触发——world 未变，watcher 无需惊动）。
 */
export function buildAgentToolDefinitions(engines: AgentToolEngines, audit: AuditEngine, onWrite?: () => void): GitToolDefinition[] {
  return [
    // ── readonly 8 ──
    makeTool(
      'git_status',
      'Show the working-tree status of the repository: current branch, clean flag, per-group change counts and capped file lists (staged/unstaged/untracked/conflicted). Set fresh=true to bypass the short TTL cache.',
      {
        type: 'object',
        properties: {
          fresh: { type: 'boolean', description: 'Bypass the ~1.5s status cache and rescan now (default false).' },
          path: { type: 'string', description: "Repo-relative path prefix filter for the file lists (e.g. 'src/')." },
        },
      },
      async (args, signal) => {
        const state = await engines.status.current(signal, { fresh: args.fresh === true })
        if (state.error !== null) return toolError(state.error)
        const snapshot = state.snapshot
        const filter = typeof args.path === 'string' && args.path !== '' ? args.path : null
        const group = (changes: FileChange[]): { files: Record<string, unknown>[]; truncated: boolean } => {
          const matched = filter === null ? changes : changes.filter((change) => change.path.startsWith(filter))
          return { files: matched.slice(0, STATUS_TOOL_GROUP_MAX).map(projectChange), truncated: matched.length > STATUS_TOOL_GROUP_MAX }
        }
        const staged = group(snapshot.staged)
        const unstaged = group(snapshot.unstaged)
        const untracked = group(snapshot.untracked)
        const conflicted = group(snapshot.conflicted)
        const truncated = staged.truncated || unstaged.truncated || untracked.truncated || conflicted.truncated
        const value: Record<string, unknown> = {
          ok: true,
          repoRoot: snapshot.repoRoot,
          branch: {
            name: snapshot.branch.name,
            oid: snapshot.branch.oid,
            upstream: snapshot.branch.upstream,
            ahead: snapshot.branch.ahead,
            behind: snapshot.branch.behind,
            detached: snapshot.branch.detached,
            unborn: snapshot.branch.unborn,
          },
          clean: snapshot.clean,
          counts: {
            staged: snapshot.staged.length,
            unstaged: snapshot.unstaged.length,
            untracked: snapshot.untracked.length,
            conflicted: snapshot.conflicted.length,
          },
          staged: staged.files,
          unstaged: unstaged.files,
          untracked: untracked.files,
          conflicted: conflicted.files,
          truncated,
        }
        if (truncated) {
          value.hint = `File lists are capped at ${String(STATUS_TOOL_GROUP_MAX)} entries per group; narrow the 'path' filter to see the rest.`
        }
        return value
      },
    ),
    makeTool(
      'git_diff',
      "Show file-level diffs. scope='worktree' diffs the worktree against the index; scope='staged' diffs the index against HEAD. Pass path for a single file. Patches are size-capped; oversized files carry a flag instead of text.",
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['worktree', 'staged'], description: "Diff direction (default 'worktree')." },
          path: { type: 'string', description: 'Single repo-relative path; omitted = all changed files in the scope.' },
        },
      },
      async (args, signal) => {
        const scope = args.scope === 'staged' ? 'staged' : 'worktree'
        const path = typeof args.path === 'string' && args.path !== '' ? args.path : null
        const result = await engines.diff.diff(scope, path, signal)
        let truncated = result.totalTruncated
        const files = result.files.map((file) => {
          const projected = projectDiffFile(file)
          if (projected.patchTruncated === true) truncated = true
          return projected
        })
        const value: Record<string, unknown> = { ok: true, scope, path: result.path, totalTruncated: truncated, files }
        if (truncated) value.hint = 'Patch output was capped (diff budget or tool cap); pass a single path or read specific files.'
        return value
      },
    ),
    makeTool(
      'git_log',
      'List recent commits of the current branch (topo order, children first), newest first. Optional message-substring query, author filter, path filter, and start revision.',
      {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: `Page size (default 50, max ${String(TOOL_LOG_MAX_LIMIT)}).` },
          skip: { type: 'integer', description: 'Number of commits to skip before the page.' },
          query: { type: 'string', description: 'Fixed-substring filter on the commit message.' },
          author: { type: 'string', description: 'Author filter (git regex semantics).' },
          path: { type: 'string', description: 'Only commits touching this repo-relative path.' },
          ref: { type: 'string', description: 'Start revision (branch/tag/oid); omitted = HEAD.' },
        },
      },
      async (args, signal) => {
        const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 50
        const limit = Math.min(Math.max(requested, 1), TOOL_LOG_MAX_LIMIT)
        const skip = typeof args.skip === 'number' && Number.isFinite(args.skip) && args.skip > 0 ? Math.trunc(args.skip) : 0
        const page = await engines.graph.log({
          limit,
          skip,
          ...(typeof args.query === 'string' && args.query !== '' ? { query: args.query } : {}),
          ...(typeof args.author === 'string' && args.author !== '' ? { author: args.author } : {}),
          ...(typeof args.path === 'string' && args.path !== '' ? { path: args.path } : {}),
          ...(typeof args.ref === 'string' && args.ref !== '' ? { ref: args.ref } : {}),
        }, signal)
        return {
          ok: true,
          hasMore: page.hasMore,
          limitUsed: page.limitUsed,
          commits: page.commits.map((commit) => {
            const projected: Record<string, unknown> = {
              oid: commit.oid,
              shortOid: commit.oid.slice(0, 7),
              subject: commit.subject,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              authoredAt: commit.authoredAt,
              committedAt: commit.committedAt,
            }
            if (commit.body !== '') {
              const sliced = commit.body.slice(0, 2_000)
              projected.body = sliced
              // 截断如实登记（文件头纪律「二次裁剪均带 truncated/hint」——批次五评审收口）：
              if (commit.body.length > 2_000) projected.bodyTruncated = true
            }
            return projected
          }),
        }
      },
    ),
    makeTool(
      'git_refs',
      'List branches, remote branches and tags with their peeled commit oids, plus the current HEAD state (branch/detached/unborn).',
      { type: 'object', properties: {} },
      async (_args, signal) => {
        const snapshot = await engines.graph.refs(signal)
        return {
          ok: true,
          head: { kind: snapshot.head.kind, name: snapshot.head.name, oid: snapshot.head.oid },
          refs: snapshot.refs.map((ref) => ({
            type: ref.type,
            shortName: ref.shortName,
            fullName: ref.fullName,
            oid: ref.oid,
            upstreamTrack: ref.upstreamTrack,
          })),
        }
      },
    ),
    makeTool(
      'git_blame',
      'Blame a file line by line: merged ranges of consecutive lines sharing one commit. Works on the worktree (default) or a revision. Large files need a startLine/endLine range (single-call line cap).',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file path.' },
          ref: { type: 'string', description: 'Blame this revision instead of the worktree.' },
          startLine: { type: 'integer', description: 'Range start (1-based, inclusive); give together with endLine.' },
          endLine: { type: 'integer', description: 'Range end (1-based, inclusive); give together with startLine.' },
        },
        required: ['path'],
      },
      async (args, signal) => {
        if (typeof args.path !== 'string' || args.path === '') {
          return { ok: false, error: 'git/bad-request', message: "git_blame: 'path' must be a non-empty repo-relative path." }
        }
        const hasStart = typeof args.startLine === 'number' && Number.isFinite(args.startLine)
        const hasEnd = typeof args.endLine === 'number' && Number.isFinite(args.endLine)
        if (hasStart !== hasEnd) {
          return { ok: false, error: 'git/bad-request', message: 'git_blame: startLine and endLine must be given together.' }
        }
        const range = hasStart && hasEnd
          ? { start: Math.trunc(args.startLine as number), end: Math.trunc(args.endLine as number) }
          : null
        if (range !== null && (range.start < 1 || range.end < range.start)) {
          return { ok: false, error: 'git/bad-request', message: 'git_blame: range must satisfy 1 <= startLine <= endLine.' }
        }
        const result = await engines.blame.blame({
          path: args.path,
          ref: typeof args.ref === 'string' && args.ref !== '' ? args.ref : null,
          range,
        }, signal)
        return {
          ok: true,
          path: result.path,
          ref: result.ref,
          lineCount: result.lineCount,
          truncated: result.truncated,
          ranges: result.ranges,
          commits: result.commits,
        }
      },
    ),
    makeTool(
      'git_commit_detail',
      'Show one commit: metadata (author, dates, subject, body), the refs pointing at it, and its file list with per-file numstat (patch text for a single path on request).',
      {
        type: 'object',
        properties: {
          oid: { type: 'string', description: 'Commit oid (full or any rev-parse-resolvable form).' },
          path: { type: 'string', description: 'Include the unified diff patch for this one path.' },
        },
        required: ['oid'],
      },
      async (args, signal) => {
        if (typeof args.oid !== 'string' || args.oid === '') {
          return { ok: false, error: 'git/bad-request', message: "git_commit_detail: 'oid' must be a non-empty revision." }
        }
        const detail = await engines.graph.getCommitDetail({
          oid: args.oid,
          path: typeof args.path === 'string' && args.path !== '' ? args.path : null,
        }, signal)
        return {
          ok: true,
          commit: {
            oid: detail.commit.oid,
            shortOid: detail.commit.oid.slice(0, 7),
            parents: detail.commit.parents,
            authorName: detail.commit.authorName,
            authorEmail: detail.commit.authorEmail,
            authoredAt: detail.commit.authoredAt,
            committedAt: detail.commit.committedAt,
            subject: detail.commit.subject,
            body: detail.commit.body,
          },
          refs: detail.refs.map((ref) => ({ type: ref.type, shortName: ref.shortName, fullName: ref.fullName })),
          totalTruncated: detail.totalTruncated,
          files: detail.files.map(projectDiffFile),
        }
      },
    ),
    makeTool(
      'git_compare_branches',
      'Compare two revisions: commits unique to each side (ahead/behind), with counts and the merge base. Lists are capped; counts stay exact.',
      {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base revision (behind side).' },
          compare: { type: 'string', description: 'Compare revision (ahead side).' },
        },
        required: ['base', 'compare'],
      },
      async (args, signal) => {
        if (typeof args.base !== 'string' || args.base === '' || typeof args.compare !== 'string' || args.compare === '') {
          return { ok: false, error: 'git/bad-request', message: "git_compare_branches: 'base' and 'compare' must be non-empty revisions." }
        }
        const result = await engines.graph.compareBranches({ base: args.base, compare: args.compare }, signal)
        const summarize = (commits: Array<{ oid: string; subject: string; authorName: string; committedAt: string }>): { entries: Record<string, unknown>[]; truncated: boolean } => ({
          entries: commits.slice(0, TOOL_COMPARE_LIST_MAX).map((commit) => ({
            oid: commit.oid,
            shortOid: commit.oid.slice(0, 7),
            subject: commit.subject,
            authorName: commit.authorName,
            committedAt: commit.committedAt,
          })),
          truncated: commits.length > TOOL_COMPARE_LIST_MAX,
        })
        const ahead = summarize(result.ahead)
        const behind = summarize(result.behind)
        const value: Record<string, unknown> = {
          ok: true,
          base: result.base,
          compare: result.compare,
          mergeBase: result.mergeBase,
          aheadCount: result.aheadCount,
          behindCount: result.behindCount,
          ahead: ahead.entries,
          behind: behind.entries,
          truncated: ahead.truncated || behind.truncated,
        }
        if (value.truncated === true) {
          value.hint = `Lists are capped at ${String(TOOL_COMPARE_LIST_MAX)} entries per side; counts are exact.`
        }
        return value
      },
    ),
    makeTool(
      'git_repo_diagnostics',
      'Show repository line-ending diagnostics: core.autocrlf/core.eol config values, a CRLF sample count over top-level text files, and the capped list of files with mixed EOLs.',
      { type: 'object', properties: {} },
      async (_args, signal) => {
        const result = await engines.diagnostics.repoDiagnostics(signal)
        return { ok: true, ...result }
      },
    ),
    // ── readwrite 3 ──
    makeTool(
      'git_stage',
      'Stage files (git add): accepts repo-relative paths including untracked files. Refuses an empty list.',
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to stage.' },
        },
        required: ['paths'],
      },
      async (args, signal) => {
        const startedAt = Date.now()
        // 形状拒绝也入审计失败出口（与 RPC 面 auditFail 覆盖全部失败出口同纪律——§6.5）。
        if (!isNonEmptyStringArray(args.paths)) {
          audit.record('git_stage', false, 'git/bad-request', Date.now() - startedAt, {})
          return { ok: false, error: 'git/bad-request', message: "git_stage: 'paths' must be a non-empty array of non-empty repo-relative strings." }
        }
        try {
          const result = await engines.mutations.stage(args.paths as string[], signal)
          audit.record('git_stage', true, null, Date.now() - startedAt, { pathCount: result.staged })
          onWrite?.()
          return { ok: true, staged: result.staged }
        } catch (cause) {
          const failure = toolError(cause)
          audit.record('git_stage', false, failure.error, Date.now() - startedAt, {})
          return failure
        }
      },
    ),
    makeTool(
      'git_unstage',
      'Unstage files (git restore --staged): accepts repo-relative paths; paths that are not staged are skipped silently (idempotent).',
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths to unstage.' },
        },
        required: ['paths'],
      },
      async (args, signal) => {
        const startedAt = Date.now()
        if (!isNonEmptyStringArray(args.paths)) {
          audit.record('git_unstage', false, 'git/bad-request', Date.now() - startedAt, {})
          return { ok: false, error: 'git/bad-request', message: "git_unstage: 'paths' must be a non-empty array of non-empty repo-relative strings." }
        }
        try {
          const result = await engines.mutations.unstage(args.paths as string[], signal)
          audit.record('git_unstage', true, null, Date.now() - startedAt, { pathCount: result.unstaged })
          onWrite?.()
          return { ok: true, unstaged: result.unstaged }
        } catch (cause) {
          const failure = toolError(cause)
          audit.record('git_unstage', false, failure.error, Date.now() - startedAt, {})
          return failure
        }
      },
    ),
    makeTool(
      'git_commit',
      'Commit the staged changes with the given message (Conventional Commits recommended). A pre-commit guard scan runs first: staged secrets are a hard block (non-waivable). Optional author trailers ("Key: value" lines).',
      {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (first line = subject).' },
          trailers: { type: 'array', items: { type: 'string' }, description: 'Author trailers, each "Key: value".' },
        },
        required: ['message'],
      },
      async (args, signal) => {
        const startedAt = Date.now()
        // 形状拒绝/前检拒绝也入审计失败出口（与 RPC 面 auditFail 覆盖全部失败出口
        // 同纪律——§6.5；summary 恒空串，AuditEngine.record ok=false 路径）。
        const refuse = (error: string, message: string, extra?: Record<string, unknown>): Record<string, unknown> => {
          audit.record('git_commit', false, error, Date.now() - startedAt, {})
          return { ok: false, error, message, ...extra }
        }
        if (typeof args.message !== 'string' || args.message.trim() === '') {
          return refuse('git/empty-message', 'git_commit: message must be a non-empty string.')
        }
        if (args.trailers !== undefined && !isStringArray(args.trailers)) {
          return refuse('git/bad-request', "git_commit: 'trailers' must be an array of strings when present.")
        }
        // 内嵌 scanStaged 前检（plan §5.4，DD=A）：secret 命中 ⇒ 零命令拒绝（硬阻断
        // 不可豁免——commit 引擎守卫 3.6 是纵深半，本前检拒绝在进管线之前）。前检
        // 自身失败 ⇒ 放行（引擎守卫兜底——护栏降级纪律同源）。
        try {
          const scan = await engines.guardScan.scanStaged(signal)
          if (scan.blocked) {
            const secrets = scan.violations.filter((violation) => violation.kind === 'secret')
            if (secrets.length > 0) {
              return refuse(
                'git/commit-blocked',
                `git_commit: staged content matches ${String(secrets.length)} secret pattern(s); this is a hard block and cannot be waived. Remove the secret(s) and restage.`,
                { violations: scan.violations.map(redactViolation) },
              )
            }
          }
        } catch {
          // 前检降级：进 commit 引擎——引擎守卫 3.6 自带同类扫描（护栏降级纪律）。
        }
        try {
          const trailers = isStringArray(args.trailers) ? args.trailers as string[] : undefined
          const result = await engines.commit.commit({
            message: args.message,
            amend: false,
            skipHooks: false,
            ...(trailers !== undefined && trailers.length > 0 ? { trailers } : {}),
          }, signal)
          audit.record('git_commit', true, null, Date.now() - startedAt, { trailerCount: trailers?.length ?? 0 })
          onWrite?.()
          return {
            ok: true,
            oid: result.oid,
            shortOid: result.shortOid,
            branch: result.branch,
            message: result.message,
          }
        } catch (cause) {
          const failure = toolError(cause)
          audit.record('git_commit', false, failure.error, Date.now() - startedAt, {})
          return failure
        }
      },
    ),
  ]
}

/** 非空字符串数组判别（stage/unstage paths 参数的最小校验）。 */
function isNonEmptyStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item !== '')
}

/** 字符串数组判别（trailers 参数的最小校验；空数组合法）。 */
function isStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 违规条目的工具面投影（redactedMatch 已脱敏——guard-scan 纪律；只取诊断字段）。 */
function redactViolation(violation: CommitViolation): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    kind: violation.kind,
    path: violation.path,
    detail: violation.detail,
  }
  if (violation.redactedMatch !== null) projected.redactedMatch = violation.redactedMatch
  if (violation.line !== null) projected.line = violation.line
  return projected
}
