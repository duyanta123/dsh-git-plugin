/**
 * dsh-gitkit — submodule 状态引擎（v2 批次四：[清单 61] 只列不递归；
 * docs/v2-implementation-plan.md §6.3/§6.5）。
 *
 * 语义要点（方案 §6.3 submoduleStatus 行；git 2.55.0.windows.2 口径）：
 *   - 数据面 = `git submodule status`（**不带 --recursive**——只列不递归，对齐 [61]
 *     原文与 v1 不展开口径）。行形 `<prefix><oid> <path>[ (<desc>)]`：
 *       空格 = initialized 且与 index 记录一致（clean）；
 *       `-`   = 未初始化（无检出——默认形态输出的是 index 记录 oid）；
 *       `+`   = 检出 commit ≠ index 记录（HEAD 漂移，mismatch）；
 *       `U`   = submodule 内有合并冲突（映射 'dirty'——枚举无 conflict 档，如实注记）。
 *   - oid/recordedOid 双读：默认形态行给检出侧 oid（'-' 行无检出 ⇒ oid=null）；
 *     `--cached` 形态行给 index 记录 oid（recordedOid）。两条只读命令按 path 归并。
 *   - state 前缀映射（wire 注记）：' '→clean、'-'→uninitialized、'+'→mismatch、
 *     'U'→dirty、其余前缀→unknown（前向兼容，不炸）。
 *   - 无 submodule ⇒ 空数组（exit 0 + 空输出，不抛错）；非仓库 ⇒ git/no-repository。
 *   - 行解析契约破坏要响（graph.ts parseForEachRef 同纪律）：缺前缀/oid/路径即抛。
 *
 * 解析器自研（零来源代码搬运；对照仅 `git submodule status` 文档行形与本机实测）。
 * 不探 submodule 内部工作区脏净（status 只比较 commit；[61] 只列不递归）。
 */

import { assertGitOk, gitError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { SubmoduleEntry, SubmoduleStatusResult } from './types.ts'

/** submodule 引擎构造项（预留 logger 诊断位，MutationEngine 同款）。 */
export interface SubmoduleEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许——index.ts 传 this.logger）。 */
  logger?: { debug(message: string): void } | undefined
}

/** status 行形：`<prefix><40hex> <path>[ (<desc>)]`；prefix ∈ {' ', '-', '+', 'U'}∪未知字母。 */
const SUBMODULE_LINE_RE = /^(.)([0-9a-f]{40}) (.+)$/u

/** 行尾的 ` (<desc>)` 描述段（如 `(heads/main)`；path 内含 " (" 时以最后一个空格+括号切）。 */
const TRAILING_DESC_RE = /\s\([^()]*\)$/u

/**
 * 解析 `git submodule status` 的 stdout（默认形态——prefix + 检出侧 oid + path）。
 * 契约破坏要响：非 newline 结尾 / 缺前缀或 oid / 路径为空。
 */
export function parseSubmoduleLines(stdout: string): Array<{ prefix: string; oid: string; path: string }> {
  if (stdout === '') return []
  if (!stdout.endsWith('\n')) throw new Error('submodule status output is not newline-terminated')
  const parsed: Array<{ prefix: string; oid: string; path: string }> = []
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') continue
    const match = SUBMODULE_LINE_RE.exec(rawLine)
    if (match === null) throw new Error(`malformed submodule status record: ${JSON.stringify(rawLine)}`)
    const path = stripTrailingDesc(match[3] as string)
    if (path === '') throw new Error(`malformed submodule status record: empty path in ${JSON.stringify(rawLine)}`)
    parsed.push({ prefix: match[1] as string, oid: match[2] as string, path })
  }
  return parsed
}

/**
 * 双读归并（默认形态 × --cached 形态）为 wire 条目。state 映射见文件头；
 * '-' 行 oid=null（无检出）；未知前缀 → 'unknown'。
 * @throws 两形态的 path 集合不一致 = 契约破坏要响（读间世界变更/解析缺陷）。
 */
export function assembleSubmoduleEntries(
  checkedOut: Array<{ prefix: string; oid: string; path: string }>,
  recorded: Array<{ prefix: string; oid: string; path: string }>,
): SubmoduleEntry[] {
  const recordedByPath = new Map(recorded.map((row) => [row.path, row]))
  const checkedOutPaths = new Set(checkedOut.map((row) => row.path))
  for (const row of recorded) {
    if (!checkedOutPaths.has(row.path)) {
      throw new Error(`submodule status mismatch: path ${JSON.stringify(row.path)} present in --cached output only`)
    }
  }
  return checkedOut.map((row) => {
    const cached = recordedByPath.get(row.path)
    if (cached === undefined) {
      throw new Error(`submodule status mismatch: path ${JSON.stringify(row.path)} absent from --cached output`)
    }
    return {
      path: row.path,
      oid: row.prefix === '-' ? null : row.oid,
      recordedOid: cached.oid,
      state: stateOfPrefix(row.prefix),
    }
  })
}

/** 前缀 → wire state（'U' → dirty：枚举无 conflict 档；未知前缀 → unknown 前向兼容）。 */
function stateOfPrefix(prefix: string): SubmoduleEntry['state'] {
  if (prefix === ' ') return 'clean'
  if (prefix === '-') return 'uninitialized'
  if (prefix === '+') return 'mismatch'
  if (prefix === 'U') return 'dirty'
  return 'unknown'
}

/** 剥行尾 ` (<desc>)` 描述段（无括号段 = 原样）。 */
function stripTrailingDesc(path: string): string {
  return path.replace(TRAILING_DESC_RE, '').trim()
}

export class SubmoduleEngine {
  private readonly logger: SubmoduleEngineOptions['logger']

  constructor(
    /** 只读实例（status 双读 + repo 发现）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（repoRoot 发现；graph.ts resolveRepoRoot 同款 probe）。 */
    private readonly workspace: WorkspaceResolver,
    options: SubmoduleEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  /**
   * submodule 状态列表（[清单 61] 只读，只列不递归）：`git submodule status` 与
   * `--cached` 双读归并。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（行解析契约破坏 / 命令失败兜底）。
   */
  async submoduleStatus(signal?: AbortSignal): Promise<SubmoduleStatusResult> {
    const repoRoot = await this.resolveRepoRoot('submoduleStatus', signal)
    const checkedOut = await this.gitRead.run(['submodule', 'status'], {
      cwd: repoRoot, op: 'submoduleStatus(git submodule status)', signal: active(signal),
    })
    assertGitOk(checkedOut, 'submoduleStatus(git submodule status)')
    const recorded = await this.gitRead.run(['submodule', 'status', '--cached'], {
      cwd: repoRoot, op: 'submoduleStatus(git submodule status --cached)', signal: active(signal),
    })
    assertGitOk(recorded, 'submoduleStatus(git submodule status --cached)')
    const entries = assembleSubmoduleEntries(parseSubmoduleLines(checkedOut.stdout), parseSubmoduleLines(recorded.stdout))
    this.logger?.debug(`git submoduleStatus: count=${String(entries.length)}`)
    return { submodules: entries }
  }

  /** repo 发现（blame.ts 同款：exit 128 + not a git repository ⇒ git/no-repository）。 */
  private async resolveRepoRoot(op: string, signal?: AbortSignal): Promise<string> {
    const resolution = await this.workspace.resolve()
    const probe = await this.gitRead.run(['rev-parse', '--show-toplevel'], {
      cwd: resolution.root,
      op: `${op}(rev-parse --show-toplevel)`,
      signal: signal ?? active(signal),
    })
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${resolution.root}`, { probed: resolution.root })
    }
    assertGitOk(probe, `${op}(rev-parse --show-toplevel)`)
    return probe.stdout.trim()
  }
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
