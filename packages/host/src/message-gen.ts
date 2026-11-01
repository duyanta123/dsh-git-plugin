/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/gitCommitMessageGenerator.ts
 *         （裁剪常量 :10-17 的 v1 子集——20 文件 / 8 diff / 总 12k 字符 / 单文件
 *         2k / 消息上限 1k；会话上下文常量（12 条 4k / 单条 600）与
 *         COMMIT_MESSAGE_QUERY_SOURCE 不取——spec §1.7「v1 不带会话上下文」且
 *         prepareCall 无 querySource 概念）
 *         `CONVENTIONAL_COMMIT_RE` :20（逐字）
 *         `validateGeneratedGitCommitMessage` :239-255 与
 *         `stripGeneratedCommitMessageDecorations` :337-349（逐段移植；
 *         「invalid 即抛错」改「conventional 标志不阻断」——spec §1.7/[清单 17]）
 *         `clipText` :330-335、`buildDiffSummary` :257-277（逐段移植；diff 摘要
 *         数据源从 GitDiffResult 换本包 DiffFile.patch）、prompt 框架 :192-222
 *         （减会话上下文/语言两段；「Hard requirements」段移入 system prompt——
 *         任务口径「system prompt 单行 Conventional subject」）
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 *
 * Paradigm reference (C 级语义对照，零逐行搬运；PORTING.md 登记):
 *   deepseek-ai/deepseek-harness@ce7073d512
 *   packages/session/session-title-llm/src/index.ts:236-291（executeSessionTitleLlm
 *   六步范式：输入字节调用方自检 → using deadline → prepareCall → GenerateOptions
 *   组装（purpose 省略）→ 派发前可观测记录 → BlockAssembler 流式组装 + finish
 *   解释）。deadline/TimeoutReason/BlockAssembler/createUserMessage 是 dsh
 *   基线积木（peer 依赖 @deepseek-ai/dsh-llm / @deepseek-ai/dsh-timeout），非移植。
 * Modifications: 2026-10-31（M7 message-gen 模块）—— 新文件。LLM 调用从 ZCode
 *   generateText 换 dsh `ctx.llm.prepareCall`（GitLlmFace 结构切片，SubprocessFace
 *   先例）；路由解析 = Config.llmProvider/llmModel → 最近 request/header 捕获 →
 *   git/llm-route-unresolved（spec §1.7，D10 口径：路由不在 prepareCall）；
 *   nothing-staged 前置守卫镜像 commit.ts 守卫 2；超时映射 git/timeout；
 *   失败映射 git/llm-failed {stage:'trim'|'call'|'parse'}。
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @dsh-plugin/git — AI 提交信息生成（spec §1.7 [清单 16/17]；§6 M7；权限 B）。
 *
 * 流程：nothing-staged 前置（`diff --cached --quiet`，unborn 同命令可用——commit.ts
 * 本机实测）→ staged diff（DiffEngine 'staged' 路：numstat/name-status 双路 +
 * 逐文件 --unified=3 patch，diff 预算由 diffFilePatchMaxBytes/diffTotalPatchMaxBytes
 * 承担）→ prompt 组装（裁剪四上限）→ 路由解析 → 六步 LLM 调用（session-title-llm
 * 范式）→ validateCommitMessage 规则表 → conventional 标志（不阻断，[清单 17]
 * 由 client 提示）。
 *
 * 裁剪四上限（ZCode gitCommitMessageGenerator.ts:10-17 的 v1 子集）：文件摘要
 * 20 行 / diff 摘录 8 段 / 摘录总 12k 字符 / 单文件 2k 字符；输出 1k 字符。
 * 四上限之内输入天然有界；`llmMaxInputBytes`（Config）是对组装完成品 input 的
 * 硬顶（六步范式第 1 步：调用方自检、超限即 git/llm-failed {stage:'trim'}——
 * session-title-llm :247-250 同语义，不做静默二次裁剪）。
 *
 * 路由解析（spec §1.7，host-capability-map.md:303 D10 纠正口径——路由解析不在
 * prepareCall）：Config.llmProvider/llmModel 显式优先；否则 host 侧缓存的最近
 * `request/header` 路由（session/event 流，payload 形状 dsh core/session
 * index.ts:252-255 实读 = `event.data.header.config.provider/model`，捕获时机与
 * workspace.ts 的 turn/start 监听同机制）；都没有 ⇒ `git/llm-route-unresolved`。
 *
 * `purpose` 省略：dsh GenerateOptions.purpose 是封闭联合
 * （'compaction'|'session-title'，host-capability-map.md:304），插件不能发明新
 * purpose——一次性辅助调用直接不带该字段（session-title-llm 范式的
 * 「省略 purpose」口径）。
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ConfigureCall,
  FinishReason,
  GenerateOptions,
  LlmCallConfig,
  StreamChunk,
  TextBlock,
} from '@deepseek-ai/dsh-llm'
import { TimeoutReason, deadline } from '@deepseek-ai/dsh-timeout'
import { gitError, gitRunError, logFailure, logWrite } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import { DiffEngine } from './diff.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { GeneratedCommitMessage } from './types.ts'

// 本模块 user 消息的来源身份（MessageSourceMap 可合并扩展面；session-title-llm
// index.ts:19-23 同形态——'dsh-plugin-git-message-gen' 随消息过线供回放归因）。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-plugin-git-message-gen': { kind: 'dsh-plugin-git-message-gen' }
  }
}

// ---------- 裁剪常量（A 级移植：ZCode gitCommitMessageGenerator.ts:10-17 的 v1 子集） ----------

/** 文件摘要最多行数（ZCode MAX_PROMPT_FILES）。 */
export const MAX_PROMPT_FILES = 20
/** diff 摘录最多段数（ZCode MAX_DIFF_FILES）。 */
export const MAX_DIFF_FILES = 8
/** diff 摘录总字符上限（ZCode MAX_DIFF_CHARS）。 */
export const MAX_DIFF_CHARS = 12_000
/** 单文件 diff 摘录字符上限（ZCode MAX_DIFF_CHARS_PER_FILE）。 */
export const MAX_DIFF_CHARS_PER_FILE = 2_000
/** 生成消息字符上限（ZCode MAX_COMMIT_MESSAGE_CHARS）。 */
export const MAX_COMMIT_MESSAGE_CHARS = 1_000

/**
 * 输出 token 上限（本模块常量，非 Config）：产出契约是单行 subject，
 * 1000 token（约 4KB 文本）远超所需，防失控模型长跑；ZCode 无对应概念
 * （其 generateText 用路由默认），dsh prepareCall 的 controls.maxTokens 显式给。
 */
export const LLM_MAX_OUTPUT_TOKENS = 1_000

/**
 * llmMaxInputBytes 默认值：四上限之内 input 最坏 ≈ 20 行文件摘要 + 8×2k 摘录 +
 * 框架 ≈ 21k 字符（CJK ×3B ≈ 63KB UTF-8），256KiB 留足余量；只有明显失配的
 * 调小配置才会触发硬顶。
 */
export const DEFAULT_LLM_MAX_INPUT_BYTES = 256 * 1024

/** 本模块 deadline 的 capability-owned 超时码（session-title 的 SESSION_TITLE_TIMEOUT 同位）。 */
export const GIT_COMMIT_MESSAGE_TIMEOUT_CODE = 'GIT_COMMIT_MESSAGE_TIMEOUT'

/**
 * Conventional Commits subject 正则（A 级逐字移植：ZCode
 * gitCommitMessageGenerator.ts:20；[清单 17] conventional 标志的判定权威）。
 */
export const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/

// ---------- LLM 面（结构切片：运行时对象来自宿主 ctx.llm，SubprocessFace 先例） ----------

/**
 * 本插件感知的最小 LLM 调用面：dsh LlmRuntime.prepareCall 的结构切片
 * （config/stream 两成员投影；宿主 llm 服务即 @deepseek-ai/dsh-llm 运行时对象，
 * 结构兼容）。engine 只消费 config 与一次性 stream。
 */
export interface GitPreparedLlmCall {
  /** Detached resolved call config（provider/model + 物化后的 controls）。 */
  readonly config: LlmCallConfig
  /** 一次性派发入口（options 的 call-config 字段须与 config 全等）。 */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 本插件感知的最小 `ctx.llm` 面。configure 回调本模块不用（无 reasoning 选择）。 */
export interface GitLlmFace {
  prepareCall(
    config: LlmCallConfig,
    signal?: AbortSignal,
    configure?: ConfigureCall,
  ): Promise<GitPreparedLlmCall>
}

// ---------- 路由捕获（session/event → request/header） ----------

/** 一次已解析的 LLM 路由（prepareCall 的 provider/model 对）。 */
export interface LlmRoute {
  provider: string
  model: string
}

/**
 * 本插件感知的最小 request/header 事件投影（dsh core/session index.ts:252-255
 * 实读：`event.type === 'request/header'`，`event.data.header.config` 必含
 * provider/model——seed 校验强制，运行期事件同型）。
 */
export interface GitRequestHeaderEventFace {
  readonly type: string
  readonly data?: {
    readonly header?: {
      readonly config?: {
        readonly provider?: unknown
        readonly model?: unknown
      }
    }
  }
}

/**
 * 宿主事件面切片：`ctx.on('session/event', listener)`（workspace.ts 的
 * GitSessionEventHost 同机制；事件面随宿主 fiber 清理）。event 参数形状取
 * request/header 投影，与 workspace 侧的最小 `GitSessionEventFace` 相容
 * （多字段只读投影）。
 */
export interface GitRouteEventHost {
  on(
    event: 'session/event',
    listener: (session: unknown, event: GitRequestHeaderEventFace) => void,
  ): unknown
}

// ---------- validateCommitMessage：纯函数规则表 ----------

/**
 * validateCommitMessage 的产出（规则表）：
 *   - message：剥壳（代码围栏 / `commit message:` 前缀 / 成对引号）→ trim →
 *     1k 字符截断 → 再 trim 的规范化结果（'' = 全空）；
 *   - empty：message 为空（模型没给出可用文本——engine 侧唯一致命项，
 *     git/llm-failed {stage:'parse'}）；
 *   - conventional：首行命中 CONVENTIONAL_COMMIT_RE（[清单 17] 标志——
 *     **不阻断**，false 也照常返回，client 负责提示；与 ZCode「invalid 即抛错」
 *     的差异即此，spec §1.7 口径）；
 *   - subject：首行原文（诊断 preview 用，对应 ZCode 的 preview 字段）。
 */
export interface CommitMessageValidation {
  message: string
  empty: boolean
  conventional: boolean
  subject: string
}

/**
 * 提交消息规则表（A 级移植：ZCode validateGeneratedGitCommitMessage :239-255 的
 * 规则链，判定产出从 discriminated union 改 flat 规则表——「invalid 不阻断」后
 * conventional 是数据不是错误）。
 */
export function validateCommitMessage(raw: string): CommitMessageValidation {
  const message = stripGeneratedCommitMessageDecorations(raw)
    .trim()
    .slice(0, MAX_COMMIT_MESSAGE_CHARS)
    .trim()
  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return {
    message,
    empty: message === '',
    conventional: CONVENTIONAL_COMMIT_RE.test(subject),
    subject,
  }
}

/**
 * 剥掉模型输出的常见包装（A 级移植：ZCode stripGeneratedCommitMessageDecorations
 * :337-349）：```fenced``` 代码围栏、`commit message:` 前缀、成对单/双引号。
 */
function stripGeneratedCommitMessageDecorations(value: string): string {
  const trimmed = value.trim()
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const withoutFence = fenced?.[1] ?? trimmed
  const withoutPrefix = withoutFence.replace(/^commit message:\s*/i, '').trim()
  if (
    (withoutPrefix.startsWith('"') && withoutPrefix.endsWith('"')) ||
    (withoutPrefix.startsWith("'") && withoutPrefix.endsWith("'"))
  ) {
    return withoutPrefix.slice(1, -1)
  }
  return withoutPrefix
}

// ---------- prompt 组装（裁剪四上限） ----------

/**
 * 截断一段文本到 maxChars 并以 marker 行收尾（A 级移植：ZCode clipText :330-335）。
 */
function clipText(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxChars - marker.length - 1)).trimEnd()}\n${marker}`
}

/** diff 摘录的一行段头 + 裁剪后 patch 体（或占位）。 */
function diffChunk(file: { path: string; patch: string | null }, remainingChars: number): string {
  const header = `--- ${file.path}`
  const body = file.patch?.trim() || '(diff unavailable)'
  const clippedBody = clipText(body, Math.min(MAX_DIFF_CHARS_PER_FILE, remainingChars), '...diff truncated...')
  return `${header}\n${clippedBody}`
}

/**
 * diff 摘录组装（A 级移植：ZCode buildDiffSummary :257-277——最多 8 段、总 12k
 * 字符、单文件 2k；按序服务、预算耗尽即停）。patch 为 null（binary/oversized/
 * 预算外/取 patch 失败）⇒ '(diff unavailable)' 占位（ZCode 的 summary 回退层
 * 不存在——本包 DiffFile 无 summary 字段）。
 */
export function buildDiffSummary(files: readonly { path: string; patch: string | null }[]): {
  summary: string
  diffsIncluded: number
} {
  let totalChars = 0
  const chunks: string[] = []
  for (const file of files.slice(0, MAX_DIFF_FILES)) {
    const remainingChars = MAX_DIFF_CHARS - totalChars
    if (remainingChars <= 0) {
      break
    }
    const chunk = diffChunk(file, remainingChars)
    chunks.push(chunk)
    totalChars += chunk.length
  }
  return { summary: chunks.join('\n\n'), diffsIncluded: chunks.length }
}

/** 文件摘要行（ZCode :187 格式：`- ${kind} ${path} (+a/-d)`；binary 计数 null ⇒ 'bin'）。 */
function fileSummaryLine(file: { status: string; path: string; additions: number | null; deletions: number | null }): string {
  const count = (value: number | null): string => (value === null ? 'bin' : String(value))
  return `- ${file.status} ${file.path} (+${count(file.additions)}/-${count(file.deletions)})`
}

/** prompt 组装产出：system/user 两段 + 观测计数。 */
export interface CommitMessagePrompt {
  /** system prompt：单行 Conventional subject 的硬约束（任务口径）。 */
  system: string
  /** user 消息文本：分支 + 文件摘要 + diff 摘录（四上限裁剪后的成品）。 */
  input: string
  /** 文件摘要实际进入 prompt 的文件数（≤ MAX_PROMPT_FILES——GeneratedCommitMessage.filesConsidered）。 */
  filesConsidered: number
  /** diff 摘录实际进入 prompt 的段数（≤ MAX_DIFF_FILES）。 */
  diffsIncluded: number
  /** 因 20 行上限未进摘要的文件数。 */
  omittedFileCount: number
}

/**
 * system prompt（任务口径「system prompt 单行 Conventional subject」）：ZCode
 * prompt 的 Hard requirements 段（:197-199 的单行化改编——单行约束替代
 * 「first line + body」双段约束；语言指令与「不提会话」指令随会话上下文一并
 * 移除，spec §1.7 v1 无会话面）。
 */
const SYSTEM_PROMPT = [
  'You write Git commit messages.',
  'Return only the commit message text: exactly one single line, no body, no explanation.',
  '',
  'Hard requirements:',
  '- The message must be one single line: a valid Conventional Commit subject.',
  '- Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
  '- Keep the Conventional Commit type and optional scope in English.',
  '- Keep the subject under 72 characters.',
  '- Do not explain your reasoning.',
  '- Do not repeat these instructions.',
].join('\n')

/**
 * 组装提交信息 prompt（A 级移植框架：ZCode buildGitCommitMessageGenerationPrompt
 * :175-222 减会话上下文/语言段；files 与 diffs 同源——本包 staged diff 的
 * DiffFile[] 既是文件摘要源也是 patch 摘录源）。
 */
export function buildCommitMessagePrompt(
  branchName: string | null,
  files: readonly { status: string; path: string; additions: number | null; deletions: number | null; patch: string | null }[],
): CommitMessagePrompt {
  const normalizedBranchName = branchName?.trim() || '(detached or unknown)'
  const visibleFiles = files.slice(0, MAX_PROMPT_FILES)
  const omittedFileCount = Math.max(0, files.length - visibleFiles.length)
  const fileSummary = visibleFiles.map(fileSummaryLine).join('\n')
  const { summary, diffsIncluded } = buildDiffSummary(files)

  // ZCode :192-222 的行框架（减会话上下文/语言行；omitted 行沿用条件拼接）。
  const input = [
    'Write exactly one Git commit message for the staged changes below.',
    'Return only the commit message text.',
    '',
    `Current branch: ${normalizedBranchName}`,
    '',
    'Changed files:',
    fileSummary || '- (no file summary available)',
    omittedFileCount > 0 ? `- ... ${omittedFileCount} more files` : '',
    '',
    'Diff excerpts:',
    summary || '(diff unavailable; infer only from the changed file summary)',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return {
    system: SYSTEM_PROMPT,
    input,
    filesConsidered: visibleFiles.length,
    diffsIncluded,
    omittedFileCount,
  }
}

// ---------- 引擎 ----------

/** MessageGenEngine 构造项（Config 值在服务面解析后传入）。 */
export interface MessageGenEngineOptions {
  /** Config.llmProvider；空串 = 未显式配置（走捕获路由）。 */
  llmProvider?: string
  /** Config.llmModel；空串 = 未显式配置（走捕获路由）。 */
  llmModel?: string
  /** Config.llmTimeoutMs（LLM 侧 deadline，spec §1.7/§1.0.2 默认 60_000）。 */
  llmTimeoutMs?: number
  /** Config.llmMaxInputBytes（输入字节硬顶，六步范式第 1 步）。 */
  llmMaxInputBytes?: number
  logger?: GitLoggerFace
}

/** 引擎内 logFailure 的空实现（logger 可选注入的兜底面；commit.ts 同款）。 */
const nullLogger: GitLoggerFace = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * AI 提交信息引擎（spec §1.7）。只读 git 实例 + DiffEngine（staged 路）+
 * 宿主 llm 面；session/event 监听由构造期自挂（workspace.ts 先例）。
 */
export class MessageGenEngine {
  private readonly llmProvider: string
  private readonly llmModel: string
  private readonly llmTimeoutMs: number
  private readonly llmMaxInputBytes: number
  private readonly logger: GitLoggerFace | undefined
  /** 最近一次 request/header 捕获的路由（null = 尚未观察到）。 */
  private capturedRoute: LlmRoute | null = null

  constructor(
    /** 只读实例（nothing-staged 守卫 / 分支查询——fastTimeoutMs）。 */
    private readonly gitRead: GitRunner,
    private readonly diffEngine: DiffEngine,
    private readonly workspace: WorkspaceResolver,
    /** 宿主 ctx.llm 结构切片；undefined = llm 服务缺席（git/llm-failed call）。 */
    private readonly llm: GitLlmFace | undefined,
    /** 宿主上下文面；提供时注册 session/event 路由捕获（监听随宿主 fiber 清理）。 */
    host?: GitRouteEventHost,
    options: MessageGenEngineOptions = {},
  ) {
    this.llmProvider = options.llmProvider ?? ''
    this.llmModel = options.llmModel ?? ''
    this.llmTimeoutMs = options.llmTimeoutMs ?? 60_000
    this.llmMaxInputBytes = options.llmMaxInputBytes ?? DEFAULT_LLM_MAX_INPUT_BYTES
    this.logger = options.logger
    host?.on('session/event', (_session, event) => { this.observeRoute(event) })
  }

  /**
   * session/event 处理：`request/header` 事件缓存最近路由（spec §1.7「host 侧
   * 缓存的最近 request/header 路由」；形状不符的事件静默跳过——形状闸，前向兼容）。
   */
  observeRoute(event: GitRequestHeaderEventFace): void {
    if (event.type !== 'request/header') return
    const config = event.data?.header?.config
    const provider = config?.provider
    const model = config?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
    this.capturedRoute = { provider, model }
  }

  /** 测试/调试视图：当前捕获的路由。 */
  get observedRoute(): LlmRoute | null {
    return this.capturedRoute
  }

  /**
   * 生成提交信息（spec §1.7）。
   * @throws git/nothing-staged（无 staged 前置）、git/no-repository、
   *   git/session-workspace-unresolved、git/llm-route-unresolved、
   *   git/llm-failed {stage:'trim'|'call'|'parse'}、git/timeout、
   *   git/git-error（diff listing 失败兜底）。
   */
  async generate(signal?: AbortSignal): Promise<GeneratedCommitMessage> {
    const active = signal ?? neverAborted()
    const startedAt = Date.now()
    const { root } = await this.workspace.resolve()

    // 前置守卫：无 staged ⇒ git/nothing-staged（镜像 commit.ts 守卫 2；unborn
    // 仓库同命令可用——本机实测，diff --cached 对空树隐式比较）。exit 128 + 非
    // 仓库 ⇒ git/no-repository（diff.ts resolveRepoRoot 同判据，提前到守卫处暴露）。
    const staged = await this.gitRead.run(['diff', '--cached', '--quiet'], {
      cwd: root, op: 'generateCommitMessage(diff --cached --quiet)', signal: active,
    })
    if (staged.exitCode === 128 && /not a git repository/i.test(staged.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${root}`, { probed: root })
    }
    if (staged.exitCode === 0) {
      const branch = await this.currentBranch(root, active)
      logFailure(this.logger ?? nullLogger, 'generateCommitMessage', 'git/nothing-staged')
      throw gitError('git/nothing-staged', 'git generateCommitMessage: nothing is staged', { branch })
    }
    if (staged.exitCode !== 1) {
      throw gitRunError('generateCommitMessage(diff --cached --quiet)', staged.exitCode, staged.stderr, staged.truncated)
    }

    const branch = await this.currentBranch(root, active)
    const diff = await this.diffEngine.diff('staged', null, active)
    const prompt = buildCommitMessagePrompt(branch, diff.files)
    const route = this.resolveRoute()

    // 六步范式第 1 步：输入字节上限调用方自检（超限 ⇒ git/llm-failed trim，不静默二次裁剪）。
    const inputBytes = Buffer.byteLength(prompt.input, 'utf8')
    if (inputBytes > this.llmMaxInputBytes) {
      logFailure(this.logger ?? nullLogger, 'generateCommitMessage', 'git/llm-failed', { stage: 'trim' })
      throw gitError(
        'git/llm-failed',
        `git generateCommitMessage: assembled input is ${inputBytes} bytes, exceeding llmMaxInputBytes ${this.llmMaxInputBytes}`,
        { stage: 'trim', reason: `input ${inputBytes} bytes > llmMaxInputBytes ${this.llmMaxInputBytes}` },
      )
    }
    if (this.llm === undefined) {
      logFailure(this.logger ?? nullLogger, 'generateCommitMessage', 'git/llm-failed', { stage: 'call' })
      throw gitError('git/llm-failed', 'git generateCommitMessage: llm service is not available on this host context', {
        stage: 'call',
        reason: 'llm-service-unavailable',
      })
    }

    // 六步范式第 2 步：using deadline(signal, llmTimeoutMs, code)（spec §1.7 双保险
    // 之外 LLM 侧的主超时面——spec §1.9 行超时列 llmTimeoutMs 即此）。
    using callDeadline = deadline(active, this.llmTimeoutMs, GIT_COMMIT_MESSAGE_TIMEOUT_CODE)

    // 六步范式第 3 步：prepareCall（路由显式给定；无 reasoning 选择 ⇒ 不传 configure）。
    let call: GitPreparedLlmCall
    try {
      call = await this.llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: LLM_MAX_OUTPUT_TOKENS },
        callDeadline.signal,
      )
    } catch (cause) {
      throw llmCallFailure(cause, callDeadline.signal, active, this.llmTimeoutMs)
    }

    // 六步范式第 4 步：GenerateOptions 组装——purpose 省略（封闭联合，插件不能
    // 发明新 purpose；一次性辅助调用），sessionId 省略（v1 无会话面）。
    const options: GenerateOptions = {
      ...call.config,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt.input }],
          source: { kind: 'dsh-plugin-git-message-gen' },
        }),
      ],
      system: prompt.system,
      signal: callDeadline.signal,
    }

    // 六步范式第 5 步：派发前可观测记录（route/计数/字节——不含 prompt 与 diff
    // 正文，spec §1.0.6）。
    this.logger?.info(
      `git generateCommitMessage dispatch route=${route.provider}/${route.model}`
        + ` files=${prompt.filesConsidered} omittedFiles=${prompt.omittedFileCount}`
        + ` diffs=${prompt.diffsIncluded} inputBytes=${inputBytes} maxTokens=${LLM_MAX_OUTPUT_TOKENS}`,
    )

    // 六步范式第 6 步：BlockAssembler 流式组装 + finish 解释。
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of call.stream(options)) {
        callDeadline.signal.throwIfAborted()
        assembler.push(chunk)
      }
    } catch (cause) {
      throw llmCallFailure(cause, callDeadline.signal, active, this.llmTimeoutMs)
    }
    this.interpretFinish(assembler.finish, callDeadline.signal, active)

    const raw = assembler.blocks()
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const validation = validateCommitMessage(raw)
    if (validation.empty) {
      logFailure(this.logger ?? nullLogger, 'generateCommitMessage', 'git/llm-failed', { stage: 'parse' })
      throw gitError('git/llm-failed', 'git generateCommitMessage: model returned no usable text', {
        stage: 'parse',
        reason: 'empty-output',
      })
    }
    // conventional 标志（[清单 17]）：false 不阻断照常返回——client 负责警示。
    logWrite(this.logger ?? nullLogger, 'generateCommitMessage', {
      durationMs: Date.now() - startedAt,
      conventional: validation.conventional,
      filesConsidered: prompt.filesConsidered,
      messageChars: validation.message.length,
    })
    return {
      message: validation.message,
      conventional: validation.conventional,
      filesConsidered: prompt.filesConsidered,
    }
  }

  /**
   * 路由解析（spec §1.7）：Config.llmProvider/llmModel 显式优先（两者都非空才
   * 成对生效）；否则最近捕获路由；都没有 ⇒ git/llm-route-unresolved。
   */
  private resolveRoute(): LlmRoute {
    if (this.llmProvider !== '' && this.llmModel !== '') {
      return { provider: this.llmProvider, model: this.llmModel }
    }
    if (this.capturedRoute !== null) return this.capturedRoute
    logFailure(this.logger ?? nullLogger, 'generateCommitMessage', 'git/llm-route-unresolved')
    throw gitError(
      'git/llm-route-unresolved',
      'git generateCommitMessage: no llm route (configure llmProvider/llmModel, or run a model request to capture the request/header route)',
      {},
    )
  }

  /**
   * finish 解释（session-title-llm terminalFinish :198-213 的域错误改编）：
   * stop/tool-calls/max-tokens 都放行（max-tokens 的截断文本交给规则表裁 1k）；
   * aborted/error 走 llmCallFailure 映射；未知 finish 种类（FinishReason 可合并
   * 扩展）按非致命放行——文本产出交给规则表判定。
   */
  private interpretFinish(finish: FinishReason, deadlineSignal: AbortSignal, callerSignal: AbortSignal): void {
    switch (finish.kind) {
      case 'stop':
      case 'tool-calls':
      case 'max-tokens':
        return
      case 'aborted':
      case 'error':
        throw llmCallFailure(
          new Error(finish.failure.message),
          deadlineSignal,
          callerSignal,
          this.llmTimeoutMs,
        )
      default:
        return
    }
  }

  /** 当前分支短名；detached（输出 'HEAD'）⇒ null（commit.ts 同语义）。 */
  private async currentBranch(root: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.gitRead.run(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root, op: 'generateCommitMessage(rev-parse --abbrev-ref HEAD)', signal,
    })
    if (result.exitCode !== 0) return null
    const name = result.stdout.trim()
    return name === '' || name === 'HEAD' ? null : name
  }
}

/**
 * LLM 侧失败 → 域错误（或调用方取消原样穿透）：
 *   - 调用方 signal 已中止 ⇒ 原样回抛原始 cause（取消必须传播，不折叠为域错误——
 *     diff.ts runPatch 同纪律）；
 *   - deadline 赢得竞态（AbortSignal.any 采纳先中止方 reason；TimeoutReason 且码
 *     相符 ⇒ 本模块的 deadline 到期）⇒ git/timeout { op, timeoutMs }；
 *   - 其余 ⇒ git/llm-failed { stage:'call', reason }。
 */
function llmCallFailure(cause: unknown, deadlineSignal: AbortSignal, callerSignal: AbortSignal, timeoutMs: number): unknown {
  if (callerSignal.aborted) return cause
  const reason = deadlineSignal.reason
  if (reason instanceof TimeoutReason && reason.code === GIT_COMMIT_MESSAGE_TIMEOUT_CODE) {
    return gitError(
      'git/timeout',
      `git generateCommitMessage: llm call exceeded llmTimeoutMs (${String(timeoutMs)}ms)`,
      { op: 'generateCommitMessage', timeoutMs },
    )
  }
  return gitError('git/llm-failed', 'git generateCommitMessage: llm call failed', {
    stage: 'call',
    reason: cause instanceof Error ? cause.message : String(cause),
  })
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
