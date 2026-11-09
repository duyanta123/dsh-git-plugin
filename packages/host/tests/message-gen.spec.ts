/**
 * git.generateCommitMessage 测试（spec §6 M7 行 + 任务口径；范式照 support.ts：
 * 真实临时 git 仓库 + 真实 git 子进程；LLM 侧 = prepareCall stub（记录请求组装面，
 * 断言纪律 = 验证 stub 实际收到的 options/请求，而非引擎自述）。
 *
 * 覆盖：
 *   - validateCommitMessage 规则表穷尽（剥壳链：fence/prefix/引号；trim；1k 截断；
 *     empty；CONVENTIONAL_COMMIT_RE 命中/不命中 [清单 17]——11 类型、scope、bang、
 *     subject 100 字符边界、首行判定）；
 *   - 裁剪常量边界（20/8/12k/2k/1k + buildDiffSummary 精确预算推导）；
 *   - prepareCall stub 请求组装：staged diff 裁剪后进 prompt（25 文件 → 摘要 20 行
 *     + 摘录 8 段 + omitted 行）、无 purpose 字段（封闭联合不发明）、system 单行
 *     Conventional subject、config 路由进 prepareCall；
 *   - 无路由 → git/llm-route-unresolved [spec §6 M7]；request/header 捕获路由与
 *     Config 显式优先级；
 *   - 超时 → git/timeout [spec §6 M7]（engine 级 200ms deadline + 挂起流）；
 *   - nothing-staged 前置（born 与 unborn 双态，镜像 commit.spec 口径）；
 *   - conventional 标志不阻断；剥壳管线；空输出/finish error/llm 缺席 →
 *     git/llm-failed 三 stage；llmMaxInputBytes 硬顶 → stage 'trim'；
 *   - 调用方取消原样穿透（不折叠为域错误）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { GenerateOptions, LlmCallConfig, StreamChunk, TextBlock } from '@deepseek-ai/dsh-llm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import {
  CONVENTIONAL_COMMIT_RE,
  DEFAULT_LLM_MAX_INPUT_BYTES,
  LLM_MAX_OUTPUT_TOKENS,
  MAX_COMMIT_MESSAGE_CHARS,
  MAX_DIFF_CHARS,
  MAX_DIFF_CHARS_PER_FILE,
  MAX_DIFF_FILES,
  MAX_PROMPT_FILES,
  MessageGenEngine,
  PR_BODY_MAX_CHARS,
  PR_TITLE_MAX_CHARS,
  buildCommitMessagePrompt,
  buildDiffSummary,
  buildPrDescriptionPrompt,
  validateCommitMessage,
  validatePrDescription,
} from '../src/message-gen.ts'
import type { GitLlmFace, MessageGenEngineOptions } from '../src/message-gen.ts'
import { DiffEngine } from '../src/diff.ts'
import { createGitRunners } from '../src/git-runner.ts'
import { WorkspaceResolver } from '../src/workspace.ts'
import { git, localSubprocess, scratchDir, scratchRepo } from './support.ts'

// 并行负载下的资源裕量（真实 git 子进程；M6 集成 spec 同款先例）。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// ---------- LLM stub（prepareCall 面：记录 config/options，流式按模式产出） ----------

/** stub 流产出模式。 */
type StubMode = 'text' | 'finish-error' | 'no-text' | 'hang'

/** 一次 prepareCall+stream 的记录（请求组装断言用）。 */
interface RecordedRequest {
  config: LlmCallConfig
  options: GenerateOptions
}

/**
 * prepareCall stub：记录 {config, options}，stream 按 mode 产出 BlockAssembler
 * 可组装的 chunk 流（block-start → text-delta → block-end → finish，照 dsh
 * types.ts StreamChunk 形状）；'hang' 模式 = 真实 adapter 的 signal 遵守语义——
 * signal 中止（deadline 或调用方）即以 abort reason reject。
 */
function stubLlmFace(mode: StubMode, text: string, records: RecordedRequest[]): GitLlmFace {
  return {
    async prepareCall(config, signal) {
      signal?.throwIfAborted()
      const record: RecordedRequest = { config: { ...config }, options: undefined as unknown as GenerateOptions }
      records.push(record)
      return {
        config: { ...config },
        stream(options): AsyncIterable<StreamChunk> {
          record.options = options
          return (async function* (): AsyncGenerator<StreamChunk, void, unknown> {
            if (mode === 'hang') {
              const streamSignal = options.signal
              await new Promise<never>((_, reject) => {
                const fail = (): void => {
                  reject(streamSignal?.reason instanceof Error ? streamSignal.reason : new Error('aborted'))
                }
                if (streamSignal?.aborted === true) fail()
                else streamSignal?.addEventListener('abort', fail, { once: true })
              })
            }
            if (mode === 'no-text') {
              yield { type: 'block-start', index: 0, blockType: 'reasoning' }
              yield { type: 'reasoning-delta', index: 0, text: 'thinking...' }
              yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking...' } }
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: text.slice(0, Math.ceil(text.length / 2)) }
            yield { type: 'text-delta', index: 0, text: text.slice(Math.ceil(text.length / 2)) }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            if (mode === 'finish-error') {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'PROVIDER_ERROR' } } }
              return
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

// ---------- 服务/引擎装配 ----------

interface ServiceHarness {
  service: InstanceType<typeof GitService>
  ctx: Context
}

function makeService(
  workspaceOverride: string,
  overrides: {
    llm?: GitLlmFace
    llmProvider?: string
    llmModel?: string
    llmMaxInputBytes?: number
  } = {},
): ServiceHarness {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  if (overrides.llm !== undefined) face.provide('llm', overrides.llm)
  const service = new GitService(ctx, {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    outputMaxBytes: 1_048_576,
    workspaceOverride,
    llmProvider: overrides.llmProvider ?? '',
    llmModel: overrides.llmModel ?? '',
    llmMaxInputBytes: overrides.llmMaxInputBytes ?? DEFAULT_LLM_MAX_INPUT_BYTES,
  })
  return { service, ctx }
}

/** 引擎直构（engine 级用例：超时/取消/llm 缺席——不经服务 schema 的 1s 超时下限）。 */
function makeEngine(
  repo: string,
  llm: GitLlmFace | undefined,
  options: MessageGenEngineOptions = {},
): MessageGenEngine {
  const runners = createGitRunners(localSubprocess(), {
    gitCommand: 'git',
    fastTimeoutMs: 15_000,
    commitTimeoutMs: 15_000,
    networkTimeoutMs: 15_000,
    outputMaxBytes: 1_048_576,
  })
  const workspace = new WorkspaceResolver(repo)
  const diffEngine = new DiffEngine(runners.readonly, workspace)
  return new MessageGenEngine(runners.readonly, diffEngine, workspace, llm, undefined, options)
}

/** 造一个带根提交的仓库（born：branch=main，分支断言确定性）。 */
async function bornRepo(prefix: string, cleanups: Array<() => Promise<unknown>>): Promise<string> {
  const repo = await scratchRepo(prefix, cleanups, { name: 't', email: 't@example.com' })
  git(repo, 'commit', '--allow-empty', '-m', 'chore: init')
  return repo
}

/** 写并暂存 count 个文件；返回相对路径清单（f00.txt…）。 */
async function stageFiles(repo: string, count: number, lineBody: (index: number) => string): Promise<string[]> {
  const paths: string[] = []
  for (let index = 0; index < count; index++) {
    const rel = `f${String(index).padStart(2, '0')}.txt`
    await writeFile(join(repo, rel), `${lineBody(index)}\n`, 'utf8')
    paths.push(rel)
  }
  git(repo, 'add', '--', ...paths)
  return paths
}

/** 把错误归一成 {code, details}（remoteErrorOf 面；非域错误返回 undefined）。 */
function asRemote(error: unknown): { code: string; details: Record<string, unknown> } | undefined {
  const remote = remoteErrorOf(error)
  return remote === undefined ? undefined : { code: remote.code, details: remote.details as Record<string, unknown> }
}

// ============================================================
// validateCommitMessage — 纯函数规则表（穷尽）
// ============================================================

describe('validateCommitMessage — 规则表（A 级移植规则链）', () => {
  it('普通 Conventional subject：message/subject 透传、empty=false、conventional=true', () => {
    const result = validateCommitMessage('feat: add login flow')
    expect(result.message).toBe('feat: add login flow')
    expect(result.subject).toBe('feat: add login flow')
    expect(result.empty).toBe(false)
    expect(result.conventional).toBe(true)
  })

  it('11 个类型全命中（CONVENTIONAL_COMMIT_RE 类型清单穷尽）', () => {
    for (const type of ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']) {
      expect(CONVENTIONAL_COMMIT_RE.test(`${type}: subject`)).toBe(true)
    }
  })

  it('scope 与 bang 组合命中：fix(parser)!: …', () => {
    expect(validateCommitMessage('fix(parser)!: handle null input').conventional).toBe(true)
    expect(validateCommitMessage('feat(api)!: breaking change').conventional).toBe(true)
    expect(validateCommitMessage('chore!: drop legacy path').conventional).toBe(true)
  })

  it('subject 长度边界：100 字符命中 / 101 字符不命中', () => {
    expect(validateCommitMessage(`feat: ${'a'.repeat(100)}`).conventional).toBe(true)
    expect(validateCommitMessage(`feat: ${'a'.repeat(101)}`).conventional).toBe(false)
  })

  it('不命中簇：未知类型 / 缺空格 / 缺冒号 / 空主题 / 大小写敏感 / 空 subject', () => {
    expect(validateCommitMessage('feature: x').conventional).toBe(false) // 非法类型
    expect(validateCommitMessage('feat:x').conventional).toBe(false) // 缺空格
    expect(validateCommitMessage('feat').conventional).toBe(false) // 缺冒号
    expect(validateCommitMessage('feat:').conventional).toBe(false) // 空 subject
    expect(validateCommitMessage('feat: ').conventional).toBe(false) // 空白 subject
    expect(validateCommitMessage('Feat: x').conventional).toBe(false) // 大小写敏感
    expect(validateCommitMessage('fix(scope):').conventional).toBe(false) // scope 后空 subject
  })

  it('剥壳链：代码围栏（带/不带语言）、commit message: 前缀（大小写不敏感）、成对引号', () => {
    expect(validateCommitMessage('```\nfeat: fenced\n```').message).toBe('feat: fenced')
    expect(validateCommitMessage('```ts\nfix: fenced with lang\n```').message).toBe('fix: fenced with lang')
    expect(validateCommitMessage('commit message: feat: prefixed').message).toBe('feat: prefixed')
    expect(validateCommitMessage('Commit Message: fix: case-insensitive').message).toBe('fix: case-insensitive')
    expect(validateCommitMessage('"feat: double quoted"').message).toBe('feat: double quoted')
    expect(validateCommitMessage("'chore: single quoted'").message).toBe('chore: single quoted')
    expect(validateCommitMessage('```\n"perf: fence and quotes"\n```').message).toBe('perf: fence and quotes')
  })

  it('trim 与多行：首尾空白剥除；多行消息保留 body、conventional 只看首行', () => {
    expect(validateCommitMessage('  feat: trimmed  \n').message).toBe('feat: trimmed')
    const multi = validateCommitMessage('feat: subject line\n\nbody paragraph\n- bullet\n')
    expect(multi.message).toBe('feat: subject line\n\nbody paragraph\n- bullet')
    expect(multi.subject).toBe('feat: subject line')
    expect(multi.conventional).toBe(true)
    // 首行不合法 ⇒ conventional=false（即便后续行合法——只判首行）。
    expect(validateCommitMessage('普通一句话\nfeat: later').conventional).toBe(false)
  })

  it('1k 字符截断：>1000 字符的消息精确截到 1000（MAX_COMMIT_MESSAGE_CHARS）', () => {
    const result = validateCommitMessage('x'.repeat(1200))
    expect(result.message.length).toBe(MAX_COMMIT_MESSAGE_CHARS)
    expect(result.empty).toBe(false)
    expect(result.conventional).toBe(false) // 截断后的长行不再是合法 subject
    // 截断不改变首行合法性判定：1000 字符多行消息（首行合法）⇒ conventional=true。
    const multi = validateCommitMessage(`feat: ok\n${'x'.repeat(991)}`)
    expect(multi.message.length).toBe(MAX_COMMIT_MESSAGE_CHARS)
    expect(multi.conventional).toBe(true)
    expect(multi.subject).toBe('feat: ok')
  })

  it('空产出：空串/纯空白 ⇒ empty=true（engine 侧唯一致命项）', () => {
    expect(validateCommitMessage('')).toEqual({ message: '', empty: true, conventional: false, subject: '' })
    expect(validateCommitMessage('   \n\t  ').empty).toBe(true)
  })

  it('非 Conventional 文本不阻断：empty=false、conventional=false（[清单 17] 标志语义）', () => {
    const result = validateCommitMessage('随手写的一句话，没有任何类型前缀')
    expect(result.empty).toBe(false)
    expect(result.conventional).toBe(false)
    expect(result.message).toBe('随手写的一句话，没有任何类型前缀')
  })
})

// ============================================================
// 裁剪四上限 — 纯函数边界
// ============================================================

describe('buildDiffSummary — 裁剪边界（8 段 / 单文件 2k / 总 12k）', () => {
  it('diff 段数上限 8：9 个文件只进 8 段（MAX_DIFF_FILES）', () => {
    const files = Array.from({ length: MAX_DIFF_FILES + 1 }, (_, index) => ({
      path: `p${index}.txt`, patch: `patch ${index}`,
    }))
    const { summary, diffsIncluded } = buildDiffSummary(files)
    expect(diffsIncluded).toBe(MAX_DIFF_FILES)
    expect(summary).toContain('--- p0.txt')
    expect(summary).toContain(`--- p${MAX_DIFF_FILES - 1}.txt`)
    expect(summary).not.toContain(`--- p${MAX_DIFF_FILES}.txt`)
  })

  it('单文件 2k 上限：3000 字符 patch 精确裁到 2000 并带截断标记（MAX_DIFF_CHARS_PER_FILE）', () => {
    const { summary } = buildDiffSummary([{ path: 'big.txt', patch: 'a'.repeat(3000) }])
    const body = summary.slice('--- big.txt\n'.length)
    // clipText 精确推导：slice(0, 2000-标记20-1=1979).trimEnd() + '\n' + 标记。
    expect(body).toBe(`${'a'.repeat(MAX_DIFF_CHARS_PER_FILE - 21)}\n...diff truncated...`)
    expect(body.length).toBe(MAX_DIFF_CHARS_PER_FILE)
    expect(summary).not.toContain('a'.repeat(3000))
  })

  it('恰 2000 字符不裁剪（边界内无标记）', () => {
    const { summary } = buildDiffSummary([{ path: 'exact.txt', patch: 'a'.repeat(MAX_DIFF_CHARS_PER_FILE) }])
    expect(summary).not.toContain('...diff truncated...')
    expect(summary.endsWith('a')).toBe(true)
  })

  it('patch null（binary/oversized/失败）⇒ "(diff unavailable)" 占位', () => {
    const { summary } = buildDiffSummary([{ path: 'bin.dat', patch: null }])
    expect(summary).toBe('--- bin.dat\n(diff unavailable)')
  })

  it('总 12k 上限：500 字符路径 × 6 个 3000 字符 patch ⇒ 恰 5 段后预算耗尽（MAX_DIFF_CHARS）', () => {
    expect(MAX_DIFF_CHARS).toBe(12_000)
    // 精确预算推导：header='--- '+500 字符=504，chunk=504+1+min(2000,remaining)。
    // c1..c4 各耗 2505（total 10020）；c5 剩余 1980 ⇒ body 1980（total 12505）；
    // c6 时 remaining=-505 ≤ 0 ⇒ break。diffsIncluded === 5。
    const files = Array.from({ length: 6 }, (_, index) => ({
      path: 'f'.repeat(500) + String(index),
      patch: 'a'.repeat(3000),
    }))
    const { summary, diffsIncluded } = buildDiffSummary(files)
    expect(diffsIncluded).toBe(5)
    const headers = summary.split('\n').filter((line) => line.startsWith('--- '))
    expect(headers.length).toBe(5)
    expect(summary).not.toContain(`${'f'.repeat(500)}5`)
  })
})

describe('buildCommitMessagePrompt — 文件摘要 20 行上限与装配', () => {
  it('20 文件上限：25 文件 ⇒ filesConsidered=20、omittedFileCount=5、omitted 行在 input', () => {
    const files = Array.from({ length: 25 }, (_, index) => ({
      status: 'modified', path: `f${String(index).padStart(2, '0')}.txt`,
      additions: 3, deletions: 1, patch: `diff for ${index}`,
    }))
    const prompt = buildCommitMessagePrompt('main', files)
    expect(prompt.filesConsidered).toBe(MAX_PROMPT_FILES)
    expect(prompt.omittedFileCount).toBe(5)
    expect(prompt.diffsIncluded).toBe(MAX_DIFF_FILES)
    expect(prompt.input).toContain('- ... 5 more files')
    expect(prompt.input).toContain('- modified f19.txt (+3/-1)')
    expect(prompt.input).not.toContain('f20.txt')
    expect(prompt.input).toContain('--- f07.txt')
    expect(prompt.input).not.toContain('--- f08.txt')
    expect(prompt.input).toContain('Current branch: main')
    expect(prompt.system).toContain('one single line')
    expect(prompt.system).toContain('Conventional Commit subject')
  })

  it('branch null ⇒ "(detached or unknown)"；binary 文件计数渲染 (+bin/-bin)', () => {
    const prompt = buildCommitMessagePrompt(null, [
      { status: 'modified', path: 'img.png', additions: null, deletions: null, patch: null },
    ])
    expect(prompt.input).toContain('Current branch: (detached or unknown)')
    expect(prompt.input).toContain('- modified img.png (+bin/-bin)')
    expect(prompt.input).toContain('--- img.png\n(diff unavailable)')
  })
})

// ============================================================
// 服务/引擎集成（真实临时 git 仓库 + prepareCall stub）
// ============================================================

describe('git.generateCommitMessage — nothing-staged 前置（spec §1.7）', () => {
  const cleanups: Array<() => Promise<unknown>> = []

  it('born 仓库无 staged ⇒ git/nothing-staged { branch }', async () => {
    const repo = await bornRepo('dshgit-msg-empty-born-', cleanups)
    const harness = makeService(repo)
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/nothing-staged')
    expect(remote?.details.branch).toBe('main')
  })

  it('unborn 仓库（空 index）⇒ 同码；unborn 无 HEAD ⇒ branch null（rev-parse 失败语义）', async () => {
    const repo = await scratchRepo('dshgit-msg-empty-unborn-', cleanups, { name: 't', email: 't@example.com' })
    const harness = makeService(repo)
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/nothing-staged')
    expect(remote?.details.branch).toBeNull()
  })

  afterAll(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })
})

describe('git.generateCommitMessage — 请求组装与裁剪（prepareCall stub）', () => {
  const cleanups: Array<() => Promise<unknown>> = []

  it('25 个 staged 文件：摘要 20 行 + 摘录 8 段 + omitted 行进 user 消息；无 purpose 字段；config 路由与 maxTokens 进 prepareCall', async () => {
    const repo = await bornRepo('dshgit-msg-assembly-', cleanups)
    await stageFiles(repo, 25, (index) => `file ${index} content line with payload ${'p'.repeat(30)}`)
    const records: RecordedRequest[] = []
    const harness = makeService(repo, {
      llm: stubLlmFace('text', 'feat: summarize staged changes', records),
      llmProvider: 'prov-a',
      llmModel: 'model-a',
    })
    const result = await harness.service.generateCommitMessage()

    // 出参（[清单 16/17]）。
    expect(result.message).toBe('feat: summarize staged changes')
    expect(result.conventional).toBe(true)
    expect(result.filesConsidered).toBe(20)

    // 请求组装（stub 实收，非引擎自述）。
    expect(records.length).toBe(1)
    expect(records[0]!.config).toEqual({ provider: 'prov-a', model: 'model-a', maxTokens: LLM_MAX_OUTPUT_TOKENS })
    const options = records[0]!.options
    expect(options.purpose).toBeUndefined() // 封闭联合——一次性辅助调用省略
    expect(options.sessionId).toBeUndefined()
    expect(options.system).toContain('You write Git commit messages.')
    expect(options.system).toContain('exactly one single line')
    expect(options.messages.length).toBe(1)
    expect(options.messages[0]!.role).toBe('user')
    const source = (options.messages[0] as { source?: { kind?: string } }).source
    expect(source?.kind).toBe('dsh-plugin-git-message-gen')
    const text = (options.messages[0]!.content[0] as TextBlock).text
    expect(options.messages[0]!.content.length).toBe(1)

    // 裁剪后 diff 在请求里：20 行摘要 + 8 段摘录 + omitted 行。
    expect(text).toContain('Current branch: main')
    expect(text).toContain('Changed files:')
    expect(text).toContain('- ... 5 more files')
    expect(text).toContain('--- f00.txt')
    expect(text).toContain('--- f07.txt')
    expect(text).not.toContain('--- f08.txt')
    expect(text).toContain('Diff excerpts:')
    expect(text).toContain('file 0 content line')
    expect(text).not.toContain('file 8 content line')
    // system prompt 不混入 user 文本；user 文本不含 system 硬约束。
    expect(text).not.toContain('Hard requirements:')
  })

  it('conventional 标志不阻断：非 Conventional 产出照常返回（false）', async () => {
    const repo = await bornRepo('dshgit-msg-nonconv-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const harness = makeService(repo, {
      llm: stubLlmFace('text', '随手写的提交说明', records),
      llmProvider: 'prov-a',
      llmModel: 'model-a',
    })
    const result = await harness.service.generateCommitMessage()
    expect(result.message).toBe('随手写的提交说明')
    expect(result.conventional).toBe(false)
  })

  it('剥壳管线端到端：fenced 产出 → message 剥壳后回带', async () => {
    const repo = await bornRepo('dshgit-msg-fence-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const harness = makeService(repo, {
      llm: stubLlmFace('text', '```\nfix: 使用围栏包装的修复\n```', []),
      llmProvider: 'prov-a',
      llmModel: 'model-a',
    })
    const result = await harness.service.generateCommitMessage()
    expect(result.message).toBe('fix: 使用围栏包装的修复')
    expect(result.conventional).toBe(true)
  })

  it('llmMaxInputBytes 硬顶：组装输入超限 ⇒ git/llm-failed { stage: trim }（不静默二次裁剪）', async () => {
    const repo = await bornRepo('dshgit-msg-inputcap-', cleanups)
    await stageFiles(repo, 1, () => 'x'.repeat(4000))
    const records: RecordedRequest[] = []
    const harness = makeService(repo, {
      llm: stubLlmFace('text', 'feat: never reached', records),
      llmProvider: 'prov-a',
      llmModel: 'model-a',
      llmMaxInputBytes: 1_024,
    })
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/llm-failed')
    expect(remote?.details.stage).toBe('trim')
    expect(records.length).toBe(0) // 硬顶在 prepareCall 之前自检——未派发
  })

  it('空产出（无 text block）⇒ git/llm-failed { stage: parse }', async () => {
    const repo = await bornRepo('dshgit-msg-notext-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const harness = makeService(repo, {
      llm: stubLlmFace('no-text', 'irrelevant', []),
      llmProvider: 'prov-a',
      llmModel: 'model-a',
    })
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/llm-failed')
    expect(remote?.details.stage).toBe('parse')
  })

  it('finish error ⇒ git/llm-failed { stage: call, reason }（adapter 级失败分类）', async () => {
    const repo = await bornRepo('dshgit-msg-finerr-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const harness = makeService(repo, {
      llm: stubLlmFace('finish-error', 'feat: partial', []),
      llmProvider: 'prov-a',
      llmModel: 'model-a',
    })
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/llm-failed')
    expect(remote?.details.stage).toBe('call')
    expect(remote?.details.reason).toBe('boom')
  })

  afterAll(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })
})

describe('git.generateCommitMessage — 路由解析（Config 显式 → request/header 捕获 → 无路由）', () => {
  const cleanups: Array<() => Promise<unknown>> = []

  /** 向服务 ctx 发一个 request/header session 事件（cordis emit 同步派发）。 */
  function emitRequestHeader(ctx: Context, provider: string, model: string): void {
    ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(
      'session/event',
      { header: {} },
      { type: 'request/header', data: { header: { config: { provider, model } } } },
    )
  }

  it('无 Config 路由且无捕获 ⇒ git/llm-route-unresolved（spec §6 M7；prepareCall 未触达）', async () => {
    const repo = await bornRepo('dshgit-msg-noroute-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const harness = makeService(repo, { llm: stubLlmFace('text', 'feat: unreachable', records) })
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/llm-route-unresolved')
    expect(records.length).toBe(0)
  })

  it('request/header 捕获路由：session/event 事件喂进服务 ctx → generate 使用捕获路由', async () => {
    const repo = await bornRepo('dshgit-msg-capture-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const harness = makeService(repo, { llm: stubLlmFace('text', 'fix: captured route works', records) })
    emitRequestHeader(harness.ctx, 'captured-prov', 'captured-model')
    const result = await harness.service.generateCommitMessage()
    expect(result.message).toBe('fix: captured route works')
    expect(records.length).toBe(1)
    expect(records[0]!.config.provider).toBe('captured-prov')
    expect(records[0]!.config.model).toBe('captured-model')
  })

  it('捕获路由「最近」语义：两次 request/header，后到者胜', async () => {
    const repo = await bornRepo('dshgit-msg-latest-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const harness = makeService(repo, { llm: stubLlmFace('text', 'fix: latest', records) })
    emitRequestHeader(harness.ctx, 'prov-old', 'model-old')
    emitRequestHeader(harness.ctx, 'prov-new', 'model-new')
    await harness.service.generateCommitMessage()
    expect(records[0]!.config.provider).toBe('prov-new')
    expect(records[0]!.config.model).toBe('model-new')
  })

  it('Config 显式优先：Config 路由与捕获路由并存 ⇒ 用 Config', async () => {
    const repo = await bornRepo('dshgit-msg-precedence-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const harness = makeService(repo, {
      llm: stubLlmFace('text', 'feat: explicit wins', records),
      llmProvider: 'cfg-prov',
      llmModel: 'cfg-model',
    })
    emitRequestHeader(harness.ctx, 'captured-prov', 'captured-model')
    await harness.service.generateCommitMessage()
    expect(records[0]!.config.provider).toBe('cfg-prov')
    expect(records[0]!.config.model).toBe('cfg-model')
  })

  it('畸形 request/header（缺 model）被形状闸跳过：捕获面不产出半截路由', async () => {
    const repo = await bornRepo('dshgit-msg-badevent-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const harness = makeService(repo, { llm: stubLlmFace('text', 'feat: unused', records) })
    ;(harness.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(
      'session/event',
      { header: {} },
      { type: 'request/header', data: { header: { config: { provider: 'only-provider' } } } },
    )
    const remote = asRemote(await harness.service.generateCommitMessage().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/llm-route-unresolved')
    expect(records.length).toBe(0)
  })

  afterAll(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })
})

describe('MessageGenEngine — 超时/取消/llm 缺席（engine 级直构，200ms deadline）', () => {
  const cleanups: Array<() => Promise<unknown>> = []

  it('deadline 到期 ⇒ git/timeout { op, timeoutMs }（挂起流遵守 signal——真实 adapter 语义）', async () => {
    const repo = await bornRepo('dshgit-msg-timeout-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const engine = makeEngine(repo, stubLlmFace('hang', 'feat: never', records), {
      llmProvider: 'prov-a',
      llmModel: 'model-a',
      llmTimeoutMs: 200,
    })
    const remote = asRemote(await engine.generate().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/timeout')
    expect(remote?.details.op).toBe('generateCommitMessage')
    expect(remote?.details.timeoutMs).toBe(200)
  })

  it('调用方取消原样穿透：abort reason 原样抛出，不折叠为域错误', async () => {
    const repo = await bornRepo('dshgit-msg-cancel-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const controller = new AbortController()
    const engine = makeEngine(repo, stubLlmFace('hang', 'feat: never', records), {
      llmProvider: 'prov-a',
      llmModel: 'model-a',
      llmTimeoutMs: 30_000,
    })
    const pending = engine.generate(controller.signal).then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    )
    // 等 prepareCall 记录落地（LLM 阶段在途），再取消——取消点落在流挂起上。
    // F7 提交图全链模块（2026-10-31）补显式超时裕量：套件加量后的重负载轮次把
    // 该 1s 默认 waitFor 顶穿（全量门禁实测；单文件跑恒绿）——M6 同款资源裕量
    // 处置，纯上限放宽零断言改动。
    await vi.waitFor(() => { if (records.length !== 1) throw new Error('prepareCall not reached') }, { timeout: 15_000 })
    controller.abort(new Error('caller-cancel'))
    const cause = await pending
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('caller-cancel')
    expect(asRemote(cause)).toBeUndefined()
  })

  it('llm 服务缺席（路由已解析）⇒ git/llm-failed { stage: call, reason: llm-service-unavailable }', async () => {
    const repo = await bornRepo('dshgit-msg-nollm-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const engine = makeEngine(repo, undefined, { llmProvider: 'prov-a', llmModel: 'model-a' })
    const remote = asRemote(await engine.generate().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(remote?.code).toBe('git/llm-failed')
    expect(remote?.details.stage).toBe('call')
    expect(remote?.details.reason).toBe('llm-service-unavailable')
  })

  it('observeRoute 形状闸：非 request/header 事件不产出路由（engine 级直证）', () => {
    const engine = makeEngine('irrelevant', undefined)
    engine.observeRoute({ type: 'user/message' })
    engine.observeRoute({ type: 'request/header' })
    engine.observeRoute({ type: 'request/header', data: { header: { config: { provider: 42, model: 'm' } } } })
    expect(engine.observedRoute).toBeNull()
    engine.observeRoute({ type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
    expect(engine.observedRoute).toEqual({ provider: 'p', model: 'm' })
  })

  afterAll(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })
})

// ============================================================
// v2 批次四 — generatePrDescription（[清单 46] + [清单 70] 合并策略约定段）
// ============================================================

describe('generatePrDescription — 输出 shape / [70] 约定段 / 守卫（stub LLM）', () => {
  const cleanups: Array<() => Promise<unknown>> = []
  let realGlobalConfig: string | undefined
  let realNosystem: string | undefined

  beforeAll(async () => {
    // [70] 探针读 `git config --get-regexp ^(merge|pull)\.`——本机全局/系统配置的
    // merge.*|pull.* 键会污染「三探全缺」负用例（sync.spec GIT_CONFIG_GLOBAL 隔离
    // 同款先例）。指向空文件 + NOSYSTEM=1 → 探针只见仓库本地配置。
    realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    realNosystem = process.env.GIT_CONFIG_NOSYSTEM
    const dir = await scratchDir('dshgit-msg-pr-gitconfig-', cleanups)
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig-empty')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
  })

  afterAll(async () => {
    if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig
    if (realNosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = realNosystem
    while (cleanups.length > 0) await cleanups.pop()!()
  })

  function writeRepoFile(repo: string, rel: string, body: string): void {
    const target = join(repo, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }

  it('validatePrDescription 规则表：首行 title + body、Title:/Body: 前缀剥壳、截断与 conventional 标志', () => {
    const plain = validatePrDescription('feat: add login flow\n\n## What\n\nAdds login.')
    expect(plain).toEqual({ title: 'feat: add login flow', body: '## What\n\nAdds login.', empty: false, conventional: true })
    const prefixed = validatePrDescription('Title: fix(api): handle null\nBody: The parser used to throw.')
    expect(prefixed.title).toBe('fix(api): handle null')
    expect(prefixed.body).toBe('The parser used to throw.')
    expect(prefixed.conventional).toBe(true)
    const unconvention = validatePrDescription('Update the thing\n\nSome body.')
    expect(unconvention.conventional).toBe(false)
    expect(unconvention.empty).toBe(false)
    const noBody = validatePrDescription('chore: tidy')
    expect(noBody.body).toBe('')
    const empty = validatePrDescription('   \n\n  ')
    expect(empty.title).toBe('')
    expect(empty.empty).toBe(true)
    // 截断上限（256/4000）。
    const longTitle = validatePrDescription(`${'t'.repeat(300)}\n\nbody`)
    expect(longTitle.title.length).toBe(256)
    const longBody = validatePrDescription(`feat: x\n\n${'b'.repeat(5000)}`)
    expect(longBody.body.length).toBe(4000)
    expect(PR_TITLE_MAX_CHARS).toBe(256)
    expect(PR_BODY_MAX_CHARS).toBe(4000)
    // CRLF 规范化。
    const crlf = validatePrDescription('feat: x\r\n\r\nBody line.')
    expect(crlf.body).toBe('Body line.')
  })

  it('buildPrDescriptionPrompt：约定段缺失整段省略；给定时入 prompt；提交/文件计数面', () => {
    const commits = Array.from({ length: 12 }, (_, index) => ({ shortOid: `abcd${String(index).padStart(3, '0')}`, subject: `s${String(index)}` }))
    const files = [{ status: 'modified', path: 'a.txt', additions: 1, deletions: 2, patch: null }]
    const without = buildPrDescriptionPrompt('main', commits, files, null)
    expect(without.conventionsIncluded).toBe(false)
    expect(without.input.includes('Repository conventions')).toBe(false)
    expect(without.commitsConsidered).toBe(10)
    expect(without.filesConsidered).toBe(1)
    expect(without.system.includes('pull request titles')).toBe(true)
    const withConventions = buildPrDescriptionPrompt('main', commits.slice(0, 2), files, 'Repository conventions for merges and pull requests (detected; follow them):\n- git config: merge.ff=only')
    expect(withConventions.conventionsIncluded).toBe(true)
    expect(withConventions.input.includes('merge.ff=only')).toBe(true)
    expect(withConventions.commitsConsidered).toBe(2)
  })

  it('服务级成功路径：stub LLM 产出 title+body → PrDescription（system 为 PR prompt、purpose 省略、[70] 约定段进 prompt）', async () => {
    const repo = await bornRepo('dshgit-msg-pr-ok-', cleanups)
    await stageFiles(repo, 2, (index) => `content ${String(index)}`)
    writeRepoFile(repo, '.github/PULL_REQUEST_TEMPLATE.md', '## Summary\n## Checklist')
    git(repo, 'config', 'merge.ff', 'only')
    const records: RecordedRequest[] = []
    const { service } = makeService(repo, { llm: stubLlmFace('text', 'feat: add pair of files\n\n## What\n\nTwo files.', records), llmProvider: 'prov-a', llmModel: 'model-a' })
    const description = await service.generatePrDescription()
    expect(description).toEqual({ title: 'feat: add pair of files', body: '## What\n\nTwo files.', conventional: true })
    // 请求组装面（验证 stub 实际收到，而非引擎自述）：system 是 PR prompt；purpose
    // 字段省略（封闭联合口径）；[70] 约定段进了 user input。
    const request = records[0]!
    expect(request.options.system?.includes('pull request titles')).toBe(true)
    expect('purpose' in request.options).toBe(false)
    const userText = (request.options.messages?.[0] as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content?.find((c) => c.type === 'text')?.text ?? ''
    expect(userText.includes('Recent commits:')).toBe(true)
    expect(userText.includes('Repository conventions for merges and pull requests')).toBe(true)
    expect(userText.includes('PR template (.github/PULL_REQUEST_TEMPLATE.md)')).toBe(true)
    expect(userText.includes('merge.ff=only')).toBe(true)
  })

  it('[70] 三探全缺 ⇒ 约定段整段省略（缺失即省略）', async () => {
    const repo = await bornRepo('dshgit-msg-pr-noconv-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    const records: RecordedRequest[] = []
    const { service } = makeService(repo, { llm: stubLlmFace('text', 'feat: single file\n\nBody.', records), llmProvider: 'prov-a', llmModel: 'model-a' })
    const description = await service.generatePrDescription()
    expect(description.title).toBe('feat: single file')
    const request = records[0]!
    const userText = (request.options.messages?.[0] as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content?.find((c) => c.type === 'text')?.text ?? ''
    expect(userText.includes('Repository conventions')).toBe(false)
  })

  it('unborn 且无 diff ⇒ git/nothing-staged；clean born 仓库合法（提交面兜底）', async () => {
    const unborn = await scratchRepo('dshgit-msg-pr-unborn-', cleanups, { name: 't', email: 't@example.com' })
    const unbornRecords: RecordedRequest[] = []
    const unbornService = makeService(unborn, { llm: stubLlmFace('text', 'feat: x', unbornRecords), llmProvider: 'p', llmModel: 'm' }).service
    const unbornRejection = asRemote(await unbornService.generatePrDescription().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(unbornRejection?.code).toBe('git/nothing-staged')
    expect(unbornRecords).toHaveLength(0)
    // clean born：无 staged/unstaged，但最近提交提供材料 → 正常到 LLM。
    const clean = await bornRepo('dshgit-msg-pr-clean-', cleanups)
    const cleanRecords: RecordedRequest[] = []
    const cleanService = makeService(clean, { llm: stubLlmFace('text', 'feat: from commits\n\nFrom the seed commit.', cleanRecords), llmProvider: 'p', llmModel: 'm' }).service
    const description = await cleanService.generatePrDescription()
    expect(description.title).toBe('feat: from commits')
    const request = cleanRecords[0]!
    const userText = (request.options.messages?.[0] as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content?.find((c) => c.type === 'text')?.text ?? ''
    expect(userText.includes('(no file summary available)')).toBe(true)
    expect(userText.includes('chore: init')).toBe(true)
  })

  it('无 LLM 路由 ⇒ git/llm-route-unresolved；路由已解析但 llm 缺席 ⇒ llm-failed call；空产出 ⇒ llm-failed parse', async () => {
    const repo = await bornRepo('dshgit-msg-pr-neg-', cleanups)
    await stageFiles(repo, 1, () => 'content')
    // 无路由（llmProvider/llmModel 空 + 无捕获）。
    const noRoute = makeService(repo, { llm: stubLlmFace('text', 'feat: x', []) })
    const routeRejection = asRemote(await noRoute.service.generatePrDescription().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(routeRejection?.code).toBe('git/llm-route-unresolved')
    // 路由已解析但 llm 服务缺席。
    const noLlm = makeEngine(repo, undefined, { llmProvider: 'p', llmModel: 'm' })
    const noLlmRejection = asRemote(await noLlm.generatePrDescription().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(noLlmRejection?.code).toBe('git/llm-failed')
    expect(noLlmRejection?.details.stage).toBe('call')
    // 空产出 ⇒ parse。
    const parse = makeEngine(repo, stubLlmFace('no-text', '', []), { llmProvider: 'p', llmModel: 'm' })
    const parseRejection = asRemote(await parse.generatePrDescription().then(
      (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
      (cause: unknown) => cause,
    ))
    expect(parseRejection?.code).toBe('git/llm-failed')
    expect(parseRejection?.details.stage).toBe('parse')
  })
})
