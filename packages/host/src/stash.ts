/**
 * dsh-gitkit — stash 引擎（v2 批次三：[清单 14] push/list/pop/drop；
 * docs/v2-implementation-plan.md §5.3/§5.5）。
 *
 * 实例纪律：push/pop/drop 是写操作 → **write** runner（WRITE_PREFIX + fastTimeoutMs，
 * refs-admin 变更类同款）；list 与序号预检走 **readonly** runner。解析器自研
 * （`git stash list` 自定义 format 行解析——尾分隔纪律同 graph.ts LOG_PRETTY_FORMAT
 * 的 %x1f/%x1e 方案；无任何来源代码搬运）。
 *
 * 语义要点（git 2.55.0.windows.2 口径）：
 *   - push：无可 stash 改动 ⇒ `git/no-paths`（op 'stash'，复用现码——fresh 扫描
 *     前置判定，不靠 git 的 "No local changes to save" 非零退出兜底）；D4=B：
 *     `includeUntracked` 缺省语义由 wire 显式 boolean 承载（client 缺省传 true），
 *     true ⇒ `-u`；message ⇒ `-m`。baseRevision 乐观基线可选传入（discard 范式
 *     可选沿用——非 null 且 ≠ 最新 HEAD ⇒ bad-request 'stale-base-revision'，零命令）。
 *     新建 stash 落 stash@{0}（index 0，git 语义）。
 *   - pop：序号预检（`rev-parse --verify --quiet stash@{N}` exit 1 ⇒ stash-not-found）
 *     → `git stash pop stash@{N}`；应用冲突（输出含 CONFLICT）⇒ `git/merge-conflict`
 *     （op 'stash-pop'；**git 语义冲突时 stash 不丢**——world 可重读 stash list 仍在）；
 *     其余失败 ⇒ git-error 兜底。abortOperation 治愈不了 stash-pop 冲突
 *     （无中间态伪引用），abortable 如实探测（正常 false）。
 *   - drop：acknowledged danger 闸（**零命令**守卫，discard 同款）→ 序号预检 →
 *     `git stash drop stash@{N}`（删除不可恢复——danger 闸的语义依据）。
 *   - 序号合法性：非负整数守卫（bad-request 'invalid-options'）先行，越界在
 *     rev-parse 预检域码化（stash-not-found）。
 *   - **环境实测（git 2.55.0.windows.2）**：runner 基础 env 的 GIT_LITERAL_PATHSPECS=1
 *     会静默破坏 `git stash push --include-untracked` 的 untracked 收集（tracked 照常
 *     入 stash、untracked 留在工作区）——stashPush 对该单条命令以 env 墓碑摘除该变量
 *     （stash push 不传用户 pathspec，摘除零注入面；git-runner.ts GitRunOptions.env
 *     墓碑语义承载）。
 */

import { assertGitOk, gitError, gitRunError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { StatusEngine } from './status.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type {
  StashDropOptions, StashEntry, StashListResult, StashOpResult, StashPopOptions, StashPushOptions,
} from './types.ts'
import type { GitStatusSnapshot } from './types.ts'

/** stash 引擎构造项（预留 logger 诊断位，MutationEngine 同款）。 */
export interface StashEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许——index.ts 传 this.logger）。 */
  logger?: { debug(message: string): void } | undefined
}

/**
 * `git stash list` 自定义 format（字段分隔 \x1f、记录尾 \x1e——LOG_PRETTY_FORMAT
 * 同方案）：oid、作者时间（ISO）、subject、引用名（stash@{N}）。命令用
 * `--pretty=format:`（format: 无尾换行语义，\n 只在记录之间由 git 插入——
 * parseLogCommits 同口径）。
 */
const STASH_LIST_FORMAT = '%H%x1f%aI%x1f%s%x1f%gd%x1e'

/** 单条 stash 记录的字段数（format 定形）。 */
const STASH_FIELDS = 4

/** `stash@{N}` 引用名形状（index 的权威来源）。 */
const STASH_REF_RE = /^stash@\{(\d+)\}$/u

/** stash 记录解析产物（纯函数，导出供夹具单测）。 */
export interface ParsedStashList {
  stashes: StashEntry[]
}

/**
 * 解析 `git stash list --pretty=format:<STASH_LIST_FORMAT>` 的 stdout。契约破坏要响
 * （graph.ts parseLogCommits 同纪律）：非 \x1e 结尾 / 字段数不足 / %gd 非 stash@{N} 形 /
 * index 非数值 / %aI 非 ISO。
 */
export function parseStashList(stdout: string): ParsedStashList {
  if (stdout === '') return { stashes: [] }
  const chunks = stdout.split('\x1e')
  if (chunks.at(-1) !== '') throw new Error('stash list output is not record-terminated')
  chunks.pop()
  const stashes: StashEntry[] = []
  for (const [index, raw] of chunks.entries()) {
    // git 以 \n 连接相邻记录（format: 无尾换行）；首记录无前导换行。
    const chunk = index === 0 ? raw : raw.replace(/^\n/, '')
    const fields = chunk.split('\x1f')
    if (fields.length !== STASH_FIELDS) {
      throw new Error(`malformed stash record: expected ${String(STASH_FIELDS)} fields, got ${String(fields.length)}`)
    }
    const oid = fields[0] as string
    const authoredAt = fields[1] as string
    const message = fields[2] as string
    const ref = fields[3] as string
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      throw new Error(`malformed stash record: oid ${JSON.stringify(oid.slice(0, 12))}`)
    }
    if (Number.isNaN(Date.parse(authoredAt))) {
      throw new Error(`malformed stash record: authoredAt ${JSON.stringify(authoredAt)}`)
    }
    const refMatch = STASH_REF_RE.exec(ref)
    if (refMatch === null) {
      throw new Error(`malformed stash record: unexpected ref name ${JSON.stringify(ref)}`)
    }
    stashes.push({
      index: Number(refMatch[1]),
      oid,
      shortOid: oid.slice(0, 7),
      message,
      authoredAt: new Date(authoredAt).toISOString(),
    })
  }
  return { stashes }
}

export class StashEngine {
  private readonly logger: StashEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——stash push/pop/drop 执行）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（list / 序号预检 / 冲突路径回读 / HEAD 回读）。 */
    private readonly gitRead: GitRunner,
    /** 最新世界读取（push 的「无可 stash 改动」前置判定；fresh 扫描）。 */
    private readonly status: StatusEngine,
    /** 工作区解析（repoRoot 发现；graph.ts resolveRepoRoot 同款 probe）。 */
    private readonly workspace: WorkspaceResolver,
    options: StashEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  // ---------- push（[清单 14]；D4=B） ----------

  /**
   * stash push：守卫（baseRevision 乐观基线 → fresh 扫描无可 stash 改动 ⇒ no-paths）
   * → `git stash push [-u] [-m <msg>]`。staged/unstaged 任一非空即可 stash；
   * includeUntracked=false 时 untracked 不计（仅 untracked ⇒ no-paths）。
   * @returns { index: 0 }（新建 stash 恒落 stash@{0}——git 语义）。
   * @throws git/bad-request（'stale-base-revision'）、git/no-paths（op 'stash'）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async stashPush(options: StashPushOptions, signal?: AbortSignal): Promise<StashOpResult> {
    const { repoRoot, snapshot } = await this.scanFresh('stashPush', signal)
    // 守卫：baseRevision 乐观基线（可选沿用——非 null 才参与校验，零命令拒绝）。
    if (options.baseRevision !== null && options.baseRevision !== undefined
      && options.baseRevision !== snapshot.branch.oid) {
      throw gitError('git/bad-request', `stale base revision: request was made against ${options.baseRevision}, HEAD is now ${snapshot.branch.oid ?? '(unborn)'}`, {
        reason: 'stale-base-revision', paths: [], expected: options.baseRevision, actual: snapshot.branch.oid,
      })
    }
    // 守卫：无可 stash 改动 ⇒ git/no-paths（op 'stash'，复用现码——方案 §5.3 语义行）。
    const stashable = snapshot.staged.length + snapshot.unstaged.length > 0
      || (options.includeUntracked === true && snapshot.untracked.length > 0)
    if (!stashable) {
      throw gitError('git/no-paths', 'git stashPush: no local changes to stash', { op: 'stash' })
    }
    const args = ['stash', 'push']
    if (options.includeUntracked === true) args.push('--include-untracked')
    if (typeof options.message === 'string' && options.message !== '') args.push('-m', options.message)
    const pushed = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'stashPush(git stash push)', signal: active(signal),
      // 单条命令摘除 GIT_LITERAL_PATHSPECS（undefined = 墓碑）：本机 git 2.55.0.windows.2
      // 实测该环境变量静默破坏 `-u` 的 untracked 收集（tracked 照常入 stash、untracked
      // 留在工作区——git 内部 pathspec 魔法被字面化）。stash push 不传用户 pathspec
      //（仅 -u/-m），摘除零注入面；git-runner.ts GitRunOptions.env 墓碑语义承载。
      env: { GIT_LITERAL_PATHSPECS: undefined },
    })
    assertGitOk(pushed, 'stashPush(git stash push)')
    this.logger?.debug(`git stashPush: includeUntracked=${String(options.includeUntracked === true)} message=${typeof options.message === 'string' && options.message !== '' ? 'custom' : '(default)'}`)
    return { index: 0 }
  }

  // ---------- list（[清单 14]） ----------

  /**
   * stash 列表（只读）：`git stash list --pretty=format:<STASH_LIST_FORMAT>` 解析；
   * 空 stash ⇒ 空数组（不抛错）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（行解析契约破坏 / 命令失败兜底）。
   */
  async stashList(signal?: AbortSignal): Promise<StashListResult> {
    const repoRoot = await this.resolveRepoRoot('stashList', signal)
    const listed = await this.gitRead.run(['stash', 'list', `--pretty=format:${STASH_LIST_FORMAT}`], {
      cwd: repoRoot, op: 'stashList(git stash list)', signal: signal ?? neverAborted(),
    })
    assertGitOk(listed, 'stashList(git stash list)')
    return { stashes: parseStashList(listed.stdout).stashes }
  }

  // ---------- pop（[清单 14]） ----------

  /**
   * stash pop：序号预检（越界/空 stash ⇒ git/stash-not-found）→
   * `git stash pop stash@{N}`；冲突 ⇒ git/merge-conflict（op 'stash-pop'）。
   * @returns { index }（弹出的序号——成功路径 git 会把后续条目前移，回传入参语义）。
   * @throws git/bad-request 'invalid-options'、git/stash-not-found、git/merge-conflict
   *   （op 'stash-pop'）、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  async stashPop(options: StashPopOptions, signal?: AbortSignal): Promise<StashOpResult> {
    const index = normalizeIndex(options.index, 'stashPop')
    const repoRoot = await this.resolveRepoRoot('stashPop', signal)
    await this.requireStashEntry(repoRoot, index, signal)
    const popped = await this.gitWrite.run(['stash', 'pop', stashRef(index)], {
      cwd: repoRoot, op: 'stashPop(git stash pop)', signal: active(signal),
    })
    if (popped.exitCode !== 0) {
      await this.throwStashFailure(popped, 'stash-pop', repoRoot, signal)
    }
    this.logger?.debug(`git stashPop: index=${String(index)}`)
    return { index }
  }

  // ---------- drop（[清单 14]；danger 闸） ----------

  /**
   * stash drop：acknowledged danger 闸（零命令）→ 序号预检 → `git stash drop stash@{N}`。
   * @returns { index }。
   * @throws git/bad-request（'unacknowledged' / 'invalid-options'）、
   *   git/stash-not-found、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  async stashDrop(options: StashDropOptions, signal?: AbortSignal): Promise<StashOpResult> {
    // 守卫 1：danger 闸（最先判，零命令执行——删除不可恢复）。
    if (options.acknowledged !== true) {
      throw gitError('git/bad-request', 'git stashDrop requires acknowledged=true (destructive confirmation gate)', {
        reason: 'unacknowledged', paths: [], expected: null, actual: null,
      })
    }
    const index = normalizeIndex(options.index, 'stashDrop')
    const repoRoot = await this.resolveRepoRoot('stashDrop', signal)
    await this.requireStashEntry(repoRoot, index, signal)
    const dropped = await this.gitWrite.run(['stash', 'drop', stashRef(index)], {
      cwd: repoRoot, op: 'stashDrop(git stash drop)', signal: active(signal),
    })
    assertGitOk(dropped, 'stashDrop(git stash drop)')
    this.logger?.debug(`git stashDrop: index=${String(index)}`)
    return { index }
  }

  // ---------- 守卫与回读 ----------

  /** stash@{N} 存在性预检（`rev-parse --verify --quiet`；exit 1 ⇒ git/stash-not-found）。 */
  private async requireStashEntry(repoRoot: string, index: number, signal?: AbortSignal): Promise<void> {
    const probed = await this.gitRead.run(['rev-parse', '--verify', '--quiet', stashRef(index)], {
      cwd: repoRoot, op: `stash(rev-parse --verify ${stashRef(index)})`, signal: signal ?? neverAborted(),
    })
    if (probed.exitCode !== 0) {
      throw gitError('git/stash-not-found', `git stash: no stash entry at stash@{${String(index)}}`, { index })
    }
  }

  /**
   * pop 非零退出 → 域错误映射：输出含 CONFLICT ⇒ git/merge-conflict（op 'stash-pop'，
   * conflicted = diff-filter=U 回读、abortable = 中间态伪引用如实探测——stash-pop 冲突
   * 通常无伪引用即 false）；其余 ⇒ git-error 兜底。
   */
  private async throwStashFailure(
    result: { exitCode: number | null; stdout: string; stderr: string; truncated: boolean },
    op: 'stash-pop',
    repoRoot: string,
    signal?: AbortSignal,
  ): Promise<never> {
    if (/CONFLICT/.test(result.stdout) || /CONFLICT/.test(result.stderr)) {
      const conflicted = await this.conflictedPaths(repoRoot, signal)
      const pseudoHead = await this.detectPseudoHead(repoRoot, signal)
      throw gitError('git/merge-conflict', `git stash pop: conflict applying the stash; the stash entry is kept (resolve the conflicts or reset)`, {
        op,
        conflicted,
        abortable: pseudoHead !== null,
      })
    }
    throw gitRunError('stashPop(git stash pop)', result.exitCode, result.stderr, result.truncated)
  }

  /** 未合并路径回读（`diff --name-only --diff-filter=U`，time-travel.ts 同款）。 */
  private async conflictedPaths(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
    const listing = await this.gitRead.run(['diff', '--name-only', '--diff-filter=U'], {
      cwd: repoRoot, op: 'stash(diff --diff-filter=U)', signal: active(signal),
    })
    assertGitOk(listing, 'stash(diff --diff-filter=U)')
    return listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  }

  /** 中间态伪引用探测（time-travel.ts 同款——abortable 的如实来源）。 */
  private async detectPseudoHead(repoRoot: string, signal?: AbortSignal): Promise<string | null> {
    for (const head of ['CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const) {
      const probed = await this.gitRead.run(['rev-parse', '--verify', '--quiet', head], {
        cwd: repoRoot, op: `stash(rev-parse --verify ${head})`, signal: active(signal),
      })
      if (probed.exitCode === 0) return head
    }
    return null
  }

  /** fresh status 扫描（守卫世界读取 + repoRoot；三态 error 就地抛出）。 */
  private async scanFresh(
    op: string,
    signal?: AbortSignal,
  ): Promise<{ repoRoot: string; snapshot: GitStatusSnapshot }> {
    const state = await this.status.current(signal, { fresh: true })
    if (state.error !== null) throw state.error
    this.logger?.debug(`git ${op}: fresh status scan (repoRoot resolved)`)
    return { repoRoot: state.snapshot.repoRoot, snapshot: state.snapshot }
  }

  /** repo 发现（blame.ts 同款：exit 128 + not a git repository ⇒ git/no-repository）。 */
  private async resolveRepoRoot(op: string, signal?: AbortSignal): Promise<string> {
    const resolution = await this.workspace.resolve()
    const probe = await this.gitRead.run(['rev-parse', '--show-toplevel'], {
      cwd: resolution.root,
      op: `${op}(rev-parse --show-toplevel)`,
      signal: signal ?? neverAborted(),
    })
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${resolution.root}`, { probed: resolution.root })
    }
    assertGitOk(probe, `${op}(rev-parse --show-toplevel)`)
    return probe.stdout.trim()
  }
}

/** stash@{N} 引用名（argv 直传——花括号无 shell 展开，runner 无 shell 语义）。 */
function stashRef(index: number): string {
  return `stash@{${String(index)}}`
}

/** 序号守卫：非负整数（违反 ⇒ bad-request 'invalid-options'）；null/缺省 = 0。 */
function normalizeIndex(index: number | null | undefined, op: string): number {
  const value = index ?? 0
  if (!Number.isInteger(value) || value < 0) {
    throw gitError('git/bad-request', `git ${op}: stash index must be a non-negative integer, got ${JSON.stringify(index ?? null)}`, {
      reason: 'invalid-options', paths: [], expected: null, actual: null,
    })
  }
  return value
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
