/**
 * dsh-gitkit — blame 引擎（v2 批次二：[清单 34] blame 逐行 + D3=B 拍板的 `-L` 区间
 * 分片承载；docs/v2-implementation-plan.md §4.3/§4.5/§4.10）。
 *
 * 实例纪律：blame 是只读操作 → readonly runner（fastTimeoutMs + 只读加固前缀，
 * graph.ts log/refs 同款）；解析器自研——`git blame --porcelain` 输出形态按 git
 * 文档（git-blame.txt porcelain 格式节）与本机 git 2.55.0.windows.2 实测定形（见
 * parseBlamePorcelain 注），无任何外部来源代码搬运（解析契约纪律照本仓 graph.ts
 * parseLogCommits / refs-admin.ts parseWorktreePorcelain 既有先例）。
 *
 * 单次行数硬顶（D3=B / §4.10）：
 *   - `BLAME_MAX_LINES = 50_000` 硬顶（防失控区间）；
 *   - 与 runner 的 outputMaxBytes 互相校验：有效上限 =
 *     min(50_000, floor(outputMaxBytes / BLAME_LINE_BYTES_BUDGET))——上限不得高于
 *     stdout 预算可承载量。BLAME_LINE_BYTES_BUDGET = 128 是**估算**（本机实测 50k
 *     行中等行宽 ≈ 98 B/行；行内容长短不可控），行内容极长的文件超出预算时由
 *     runner 的 truncated 标志兜底（assertGitOk 截断即 git-error，绝不静默解析）。
 *   - 全区请求且总行数 > 上限 ⇒ git/blame-oversized（details.lineCount = 精确总行数，
 *     引导 client 转 `-L` 区间分片）；区间请求跨度 > 上限 ⇒ **同钳**（end 截短，
 *     truncated=true）。
 *
 * 总行数探测（lineCount 与超限判定的权威值，见 probeLineCount）：
 *   - 工作区 blame（ref 缺省）→ node fs 流式计数（路径越界守卫——探测绝不读仓库外
 *     文件；git 自身对仓库外路径也会拒绝，probe 失败即落空由 git 的错误如实兜底）；
 *   - ref blame → `git diff --numstat <空树> <ref> -- <path>`（空树经
 *     `git hash-object -t tree --stdin` 现算——**不带 `-w` 零写入**，hash 算法无关；
 *     added 列 = 文本文件行数，二进制 = '-'）→ 二进制回落
 *     `git show <ref>:<path>` 计数（受 stdout 预算约束，截断 ⇒ 探测不可得）。
 *   - 探测不可得时：全区改走无窗口 blame（输出截断 ⇒ git-error 如实兜底；未截断则
 *     covered 即精确总行数）——blame-oversized 的 lineCount 在全部可达路径上都是
 *     精确值，绝不落估算下界。
 */

import { createReadStream } from 'node:fs'
import { resolve, sep } from 'node:path'
import { assertGitOk, gitError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { BlameCommit, BlameOptions, BlameRange, BlameResult } from './types.ts'

/** blame 单次调用的行数硬顶（D3=B；§4.10 防失控区间）。 */
export const BLAME_MAX_LINES = 50_000

/**
 * outputMaxBytes 互相校验的单行字节预算（估算值——本机实测 50k 行中等行宽 porcelain
 * 输出 ≈ 4.9 MB ≈ 98 B/行；取 128 留余量。行内容极长时真实体量可超预算，由 runner
 * truncated 标志兜底，见文件头注）。
 */
export const BLAME_LINE_BYTES_BUDGET = 128

/**
 * 有效单次行数上限：min(硬顶, floor(outputMaxBytes / 预算))，至少 1。
 * 默认 outputMaxBytes（8 MiB）下 = 50_000（floor(8 MiB/128) = 65_536 > 硬顶）。
 */
export function effectiveBlameMaxLines(outputMaxBytes: number): number {
  return Math.max(1, Math.min(BLAME_MAX_LINES, Math.floor(outputMaxBytes / BLAME_LINE_BYTES_BUDGET)))
}

// ---------- porcelain 解析（纯函数，导出供夹具单测） ----------

/**
 * blame 条目行（组首 = 四段带组行数；同组续行 = 三段）：
 * `<40hex oid> <origLine> <finalLine>[ <count>]`。
 */
const BLAME_ENTRY_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/u

/** blame 提交头块的键行（author/committer 的 mail/time/tz 变体互不前缀冲突）。 */
const BLAME_HEADER_PREFIXES = [
  'author ', 'author-mail ', 'author-time ', 'author-tz ',
  'committer ', 'committer-mail ', 'committer-time ', 'committer-tz ',
  'summary ', 'previous ', 'filename ', 'boundary',
] as const

/** 解析产物：区间（同 oid 连续行已合并）+ 提交去重清单（首现序）+ 覆盖末行号。 */
export interface ParsedBlamePorcelain {
  ranges: BlameRange[]
  commits: BlameCommit[]
  /** 最后一个条目的 final 行号（空输出 = 0）——本次覆盖的末行。 */
  coveredEnd: number
}

/**
 * 解析 `git blame --porcelain` 的 stdout（输出形态本机 git 2.55.0.windows.2 实测）：
 *   - 条目行：组首 `<oid> <orig> <final> <count>`（组行数恒带）+ 同组续行
 *     `<oid> <orig> <final>`（三段）；**每个输出行**都有一条 TAB 前缀的内容行；
 *   - 提交头块只在提交首现时出现（author、author-mail、author-time、author-tz、
 *     committer 系四行、summary、previous?、boundary?、filename?）；root 提交带 `boundary`、
 *     未提交行 oid 为全零（author = 「Not Committed Yet」）——均为真实世界如实解析；
 *   - 区间合并按解析纪律「同 oid 连续行合并」（§4.3）：git 的组边界与 -L 窗口切分
 *     不影响 wire 区间——连续同 oid 行合并为一段。
 *
 * 契约破坏要响（graph.ts 解析器同纪律）：非 newline 结尾 / 条目行 final 行号不连续
 * 递增 / 首现 oid 无头块 / 头块缺 author·author-time·summary / author-time 非数值 /
 * 无法识别的裸行。
 */
export function parseBlamePorcelain(stdout: string): ParsedBlamePorcelain {
  if (stdout === '') return { ranges: [], commits: [], coveredEnd: 0 }
  if (!stdout.endsWith('\n')) throw new Error('blame porcelain output is not newline-terminated')
  const lines = stdout.split('\n')
  lines.pop() // 尾部空段（newline 终止符）

  const commitsByOid = new Map<string, BlameCommit>()
  const authoredAtByOid = new Map<string, string>()
  const entries: Array<{ oid: string; final: number }> = []
  // 首现提交的头块收集态：四段条目行之后、内容行之前的头块行归属该 oid。
  let pendingOid: string | null = null
  let pendingAuthor: string | null = null
  let pendingAuthorAt: string | null = null
  let pendingSubject: string | null = null

  const closePending = (): void => {
    if (pendingOid === null) return
    if (pendingAuthor === null || pendingAuthorAt === null || pendingSubject === null) {
      throw new Error(`malformed blame record: commit ${pendingOid.slice(0, 12)} header incomplete`)
    }
    if (!commitsByOid.has(pendingOid)) {
      commitsByOid.set(pendingOid, {
        oid: pendingOid,
        shortOid: pendingOid.slice(0, 7),
        authorName: pendingAuthor,
        subject: pendingSubject,
      })
      authoredAtByOid.set(pendingOid, pendingAuthorAt)
    }
    pendingOid = null
    pendingAuthor = null
    pendingAuthorAt = null
    pendingSubject = null
  }

  for (const line of lines) {
    if (line.startsWith('\t')) {
      // 内容行：头块必已收齐（头块在内容行之前——缺头块 = 契约破坏）。
      closePending()
      continue
    }
    const entry = BLAME_ENTRY_RE.exec(line)
    if (entry !== null) {
      const oid = entry[1] as string
      const final = Number(entry[3] as string)
      closePending()
      if (entries.length > 0 && final !== entries[entries.length - 1]!.final + 1) {
        throw new Error(`malformed blame record: final line numbers not consecutive at line ${String(final)}`)
      }
      entries.push({ oid, final })
      if (entry[4] !== undefined && !commitsByOid.has(oid) && pendingOid === null) {
        // 组首条目 + 首现提交：期待头块（随后的头块行）。
        pendingOid = oid
      }
      continue
    }
    if ((BLAME_HEADER_PREFIXES as readonly string[]).some((prefix) => line.startsWith(prefix))) {
      if (pendingOid === null) {
        throw new Error(`malformed blame record: header line outside a commit header block: ${JSON.stringify(line.slice(0, 40))}`)
      }
      // 进 wire 的三键 + 其余头块行（author-mail、author-tz、committer 系、previous、
      // filename、boundary）前向容忍跳过。
      if (line.startsWith('author ')) {
        pendingAuthor = line.slice('author '.length)
      } else if (line.startsWith('author-time ')) {
        const seconds = Number(line.slice('author-time '.length).trim())
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`malformed blame record: author-time value: ${JSON.stringify(line)}`)
        }
        pendingAuthorAt = new Date(seconds * 1000).toISOString()
      } else if (line.startsWith('summary ')) {
        pendingSubject = line.slice('summary '.length)
      }
      continue
    }
    throw new Error(`malformed blame record: unrecognized line: ${JSON.stringify(line.slice(0, 40))}`)
  }
  closePending()

  // 同 oid 连续行合并（§4.3 解析纪律）。
  const ranges: BlameRange[] = []
  for (const entry of entries) {
    const commit = commitsByOid.get(entry.oid)
    const authoredAt = authoredAtByOid.get(entry.oid)
    if (commit === undefined || authoredAt === undefined) {
      throw new Error(`malformed blame record: entry for commit without header: ${entry.oid.slice(0, 12)}`)
    }
    const last = ranges.at(-1)
    if (last !== undefined && last.oid === entry.oid && last.startLine + last.count === entry.final) {
      last.count += 1
    } else {
      ranges.push({
        startLine: entry.final,
        count: 1,
        oid: entry.oid,
        authorName: commit.authorName,
        authoredAt,
      })
    }
  }
  const coveredEnd = entries.length === 0 ? 0 : entries[entries.length - 1]!.final
  return { ranges, commits: [...commitsByOid.values()], coveredEnd }
}

// ---------- 引擎 ----------

/** BlameEngine 构造项。 */
export interface BlameEngineOptions {
  /** runner 的 stdout 预算（互相校验的上限来源；缺省 8 MiB = DEFAULT_OUTPUT_MAX_BYTES 语义）。 */
  outputMaxBytes?: number
}

export class BlameEngine {
  private readonly outputMaxBytes: number

  constructor(
    /** 只读实例（blame 执行 / numstat 探测 / rev-parse probe）。 */
    private readonly git: GitRunner,
    /** 工作区解析（repoRoot 发现；graph.ts resolveRepoRoot 同款 probe）。 */
    private readonly workspace: WorkspaceResolver,
    options: BlameEngineOptions = {},
  ) {
    this.outputMaxBytes = options.outputMaxBytes ?? 8 * 1024 * 1024
  }

  /**
   * blame（[清单 34]；权限 A，只读）：`git blame --porcelain [-L <s>,<e>] [<ref>]
   * -- <path>` 解析为 ranges（同 oid 连续行合并）+ commits；单次行数硬顶见文件头。
   * @throws git/bad-request（'invalid-options'）、git/blame-oversized（全区超限）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（解析契约破坏 / git 失败兜底）。
   */
  async blame(options: BlameOptions, signal?: AbortSignal): Promise<BlameResult> {
    const path = requirePath(options.path)
    const ref = typeof options.ref === 'string' && options.ref !== '' ? options.ref : null
    const range = requireRange(options.range)
    const repoRoot = await this.resolveRepoRoot(signal)
    const maxLines = effectiveBlameMaxLines(this.outputMaxBytes)
    const total = await this.probeLineCount(repoRoot, path, ref, signal)

    // 窗口计算（D3=B）：全区超限 ⇒ blame-oversized（探测可得时零命令前置拒绝）；
    // 区间超限 ⇒ 同钳（end 截短 + truncated）。
    let window: { start: number; end: number } | null
    let truncated = false
    if (range !== null) {
      const endClamped = Math.min(range.end, range.start + maxLines - 1)
      truncated = endClamped < range.end
      window = { start: range.start, end: endClamped }
    } else if (total !== null && total > maxLines) {
      throw gitError('git/blame-oversized', `git blame: file '${path}' has ${String(total)} lines, exceeding the single-call cap of ${String(maxLines)}; load in -L ranges instead`, {
        path, lineCount: total, maxLines,
      })
    } else if (total === null) {
      // 探测不可得：无窗口执行（截断由 assertGitOk 如实兜底；covered 即精确总行数）。
      window = null
    } else {
      window = null
    }

    const args = ['blame', '--porcelain']
    if (window !== null) args.push('-L', `${String(window.start)},${String(window.end)}`)
    if (ref !== null) args.push(ref)
    args.push('--', path)
    const active = signal ?? neverAborted()
    const result = await this.git.run(args, { cwd: repoRoot, op: 'blame', signal: active })
    assertGitOk(result, 'blame')
    const parsed = parseBlamePorcelain(result.stdout)

    // 全区探测不可得路径的兜底判定：covered 即精确总行数（未截断才走到这）。
    if (range === null && total === null && parsed.coveredEnd > maxLines) {
      throw gitError('git/blame-oversized', `git blame: file '${path}' has ${String(parsed.coveredEnd)} lines, exceeding the single-call cap of ${String(maxLines)}; load in -L ranges instead`, {
        path, lineCount: parsed.coveredEnd, maxLines,
      })
    }
    // lineCount：探测精确值优先；探测不可得时 = 覆盖末行（全区 = 总行数、区间 = 下界，
    // 类型注如实）。
    const lineCount = total ?? parsed.coveredEnd
    return {
      path,
      ref,
      lineCount,
      truncated,
      ranges: parsed.ranges,
      commits: parsed.commits,
    }
  }

  // ---------- 总行数探测 ----------

  /**
   * blame 目标版本的总行数（探测失败 ⇒ null，调用方降级——见文件头「总行数探测」）。
   * 工作区 = node fs 流式计数；ref = numstat（空树基线）→ `git show` 回落。
   */
  private async probeLineCount(
    repoRoot: string,
    path: string,
    ref: string | null,
    signal?: AbortSignal,
  ): Promise<number | null> {
    return ref === null ? this.countWorktreeLines(repoRoot, path) : this.countRefLines(repoRoot, ref, path, signal)
  }

  /** 工作区文件行数（流式；路径越界 / 读取失败 ⇒ null——git blame 自身会如实报错）。 */
  private async countWorktreeLines(repoRoot: string, path: string): Promise<number | null> {
    // 路径越界守卫：探测只读仓库内文件（wire path 是仓库相对路径——resolve 后必须
    // 落在 repoRoot 之内；越界 = 探测放弃，git 的「outside repository」错误如实兜底）。
    const resolved = resolve(repoRoot, path)
    const rootWithSep = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep
    if (!resolved.toLowerCase().startsWith(rootWithSep.toLowerCase())) return null
    return new Promise((resolveCount) => {
      const stream = createReadStream(resolved)
      let count = 0
      let lastByte = -1
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        for (const byte of bytes) {
          if (byte === 0x0a) count += 1
          lastByte = byte
        }
      })
      stream.on('end', () => {
        // 无尾换行的末行也是一行（git 按行内容切分，"a\nb" = 2 行）；空文件 = 0 行。
        resolveCount(count === 0 ? (lastByte === -1 ? 0 : 1) : (lastByte === 0x0a ? count : count + 1))
      })
      stream.on('error', () => resolveCount(null))
    })
  }

  /** ref 版本行数：numstat（空树基线，added 列）→ 二进制/缺行回落 `git show` 计数。 */
  private async countRefLines(repoRoot: string, ref: string, path: string, signal?: AbortSignal): Promise<number | null> {
    const active = signal ?? neverAborted()
    // 空树现算（`hash-object -t tree --stdin` 不带 `-w`：零写入计算——评审修复。原
    // `git mktree` 实测会向 .git/objects 写入空树对象（本机临时仓 object 数 3→4），
    // 与 blame 只读纪律相悖；hash-object 空 stdin 同 oid 且零落盘，sha256 仓库同样成立。
    // 失败（exit ≠ 0）⇒ 探测降级 null，无错误结果——回落链（numstat 缺基线 → show 计数
    // → null）不受影响。
    const tree = await this.git.run(['hash-object', '-t', 'tree', '--stdin'], {
      cwd: repoRoot, op: 'blame(count hash-object empty tree)', signal: active,
    })
    if (tree.exitCode !== 0) return null
    const emptyTree = tree.stdout.trim()
    const stat = await this.git.run(['diff', '--numstat', emptyTree, ref, '--', path], {
      cwd: repoRoot, op: 'blame(count numstat)', signal: active,
    })
    if (stat.exitCode === 0) {
      const row = stat.stdout.split('\n').find((line) => line !== '')
      if (row !== undefined) {
        const added = row.split('\t')[0] ?? ''
        const lines = Number(added)
        if (added !== '-' && Number.isFinite(lines) && lines >= 0) return lines
      }
    }
    // 二进制（numstat '-'）或文件不在该 ref：`git show <ref>:<path>` 计数回落。
    const shown = await this.git.run(['show', `${ref}:${path}`], {
      cwd: repoRoot, op: 'blame(count show)', signal: active,
    })
    if (shown.exitCode !== 0 || shown.truncated) return null
    return countLinesInText(shown.stdout)
  }

  /** repo 发现（graph.ts resolveRepoRoot 同款：exit 128 + not a git repository ⇒ git/no-repository）。 */
  private async resolveRepoRoot(signal?: AbortSignal): Promise<string> {
    const resolution = await this.workspace.resolve()
    const probe = await this.git.run(['rev-parse', '--show-toplevel'], {
      cwd: resolution.root,
      op: 'blame(rev-parse --show-toplevel)',
      signal: signal ?? neverAborted(),
    })
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${resolution.root}`, { probed: resolution.root })
    }
    assertGitOk(probe, 'blame(rev-parse --show-toplevel)')
    return resolve(resolution.root, probe.stdout.trim())
  }
}

// ---------- 纯函数与守卫 ----------

/** 文本行数（与 git 的行切分同口径：末字节非换行也计一行；空串 = 0）。 */
export function countLinesInText(text: string): number {
  if (text === '') return 0
  const count = (text.match(/\n/g) ?? []).length
  return text.endsWith('\n') ? count : count + 1
}

/** 非空路径守卫（空 ⇒ bad-request 'invalid-options'）。 */
function requirePath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw gitError('git/bad-request', 'git blame: a non-empty path is required', {
      reason: 'invalid-options', paths: [], expected: null, actual: null,
    })
  }
  return path
}

/**
 * `-L` 区间守卫：整数、1 ≤ start ≤ end（违反 ⇒ bad-request 'invalid-options'）；
 * start 超出文件行数由 git 自身拒绝（"file X has only N lines" exit 128 → git-error
 * 如实兜底）。
 */
function requireRange(range: BlameOptions['range']): { start: number; end: number } | null {
  if (range === null || range === undefined) return null
  const { start, end } = range
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw gitError('git/bad-request', 'git blame: range must be integers with 1 <= start <= end', {
      reason: 'invalid-options', paths: [], expected: null, actual: null,
    })
  }
  return { start, end }
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
