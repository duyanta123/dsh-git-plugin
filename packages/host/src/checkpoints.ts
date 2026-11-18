/**
 * dsh-gitkit — 检查点/归因引擎（v3 批次四 [清单 39/40/41] 消费式；
 * docs/v3-implementation-plan.md §6.3/§6.4）。
 *
 * 消费纪律（plan §0.2-③ 三条硬边界）：
 *   1. **私有 tree id 不可恢复**——快照对象写进 workspace-changes 的私有临时对象库，
 *      summary.snapshot 的 tree id 在宿主 repo 内不可达 ⇒ 恢复只走 diff hunks 反向
 *      应用（DB=A），绝不 checkout 快照 tree；
 *   2. **摘要在 Host 内存**（Session 处置 / Host 重启即失）——summary/diff 在消费点
 *      经 face 逐次现读，记录缺失 ⇒ list 的 summary null（诚实呈现）/ 操作侧
 *      git/checkpoint-unavailable（硬失败防误恢复，plan §6.2/§6.5）；
 *   3. **无 repo 降级**——索引只依赖事件流照建；restore 的 repo 探测失败落
 *      git/no-repository（工作区不是仓库时恢复本无从谈起）。
 *
 * 实例纪律：`git apply` 是改工作区的写命令 → **write** runner（WRITE_PREFIX +
 * fastTimeoutMs，staging-patch 同款）；预检/回读（rev-parse）走只读实例；patch 文本
 * 经 stdin 传入（`-` 路径免临时文件）。
 *
 * 命令形态：`git apply -R --whitespace=nowarn --unidiff-zero`（**worktree 应用，非
 * --cached**——DB=A 语义行）。`--unidiff-zero` 是对方案 §6.3 命令面的施工增补（登记
 * 偏差）：workspace-changes 的 coarse 模式与整文件替换产生的 hunk **无上下文行**——
 * 本机 git 2.55.0.windows.2 实测缺该旗标时 apply 以 "patch failed … patch does not
 * apply" 拒绝（probe 夹具：`@@ -2,1 +2,1 @@` 无上下文 hunk）。位置精确性边界：零上下文
 * hunk 按行号定位，turn 后的并发编辑若只增删了目标区间之后的行，patch 仍会以原行号
 * 应用（恢复的是该回合自身的改动，回合后追加的行保留）——逐文件部分成功语义的固有
 * 近似，README 如实。
 *
 * 归因口径（[清单 40]，plan §6.3）：status 快照全路径 × turn→files 现读映射。
 * 'agent' = 回合记录命中且文件 mtime ≤ 最近命中回合的 endedAt；'mixed' = 命中但回合
 * 结束后又被改动（mtime 近似判定——回合内用户与 agent 交替编辑本就不可区分，§6.9）；
 * 'user' = 快照有但零命中（以「有记录覆盖」为前提）；'unknown' = 无记录覆盖
 * （face 缺失/环空——重启前历史，DE=A 如实降级）。
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assertGitOk, gitError, gitRunError, sanitizeStderr } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { StatusEngine } from './status.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { CheckpointIndexEntry, GitWorkspaceChangesFace } from './session-watch.ts'
import type {
  AttributionEntry, AttributionResult, CheckpointEntry, CheckpointFileDiff, CheckpointDiffOptions,
  CheckpointListResult, CheckpointRestoreOptions, CheckpointRestoreResult,
} from './types.ts'

/** 序列化进 patch 的单文件元数据（六态夹具的构造面——纯函数不触碰引擎态）。 */
export interface PatchFileSpec {
  /** patch 头路径（仓库相对、正斜杠——git apply 的解析形态）。 */
  path: string
  /** turn-start 时文件是否存在（false ⇒ `--- /dev/null` + `new file mode` 头）。 */
  before: boolean
  /** turn-end 时文件是否存在（false ⇒ `+++ /dev/null` + `deleted file mode` 头）。 */
  after: boolean
  /** hunk 本体（unified diff hunk，每行保留 +/-/空格 前缀）。 */
  hunks: ReadonlyArray<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
}

/** Windows 反斜杠 → 正斜杠（patch 头与会话路径的 git 解析形态统一）。 */
function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * hunk 结构 → unified diff patch 文本（**纯函数独立导出**——六态夹具单测面，plan §6.4）。
 *
 * 头部纪律（本机 git 2.55 实测，见 tests/checkpoints.spec.ts 夹具）：
 *   - 必须有 `diff --git a/<p> b/<p>` 行——`new file mode`/`deleted file mode` 扩展头
 *     脱离该行时 git apply 报 "patch fragment without header"；
 *   - 新增（before=false）/删除（after=false）各带 /dev/null 头 + 对应 mode 扩展行
 *     （删除侧缺 mode 行时反向应用报 "dev/null: No such file or directory"）；
 *   - 空侧（0 行）的 hunk 计数按 git 惯例归一 `@@ -0,0 …`（workspace-changes 的
 *     jsdiff 形状可能是 1 起 0 行）；非空侧 oldStart/newStart 取面值原样；
 *   - hunk 行计数自 body 重算（'+-' 计入旧侧、'+' 计入新侧、空格两侧都计）——面值
 *     漂移不进 patch，保证 git 解析的内部一致；
 *   - binary/oversized 无 hunk 可序列化 ⇒ null（恢复面如实 failed）；hunks=[] ⇒ ''
 *     （两侧同行的 no-op，调用面按 applied 处理，零命令）。
 */
export function serializeCheckpointPatch(spec: PatchFileSpec): string | null {
  const p = toPosix(spec.path)
  if (p === '' || p === '/dev/null' || p.includes('\n')) return null
  // 两侧同行（无 hunk）= 恢复 no-op——空串（含头的零 hunk patch 反而是 git 的 corrupt patch）。
  if (spec.hunks.length === 0) return ''
  const lines: string[] = [`diff --git a/${p} b/${p}`]
  if (spec.before === false && spec.after === true) lines.push('new file mode 100644')
  if (spec.before === true && spec.after === false) lines.push('deleted file mode 100644')
  lines.push(`--- ${spec.before ? `a/${p}` : '/dev/null'}`)
  lines.push(`+++ ${spec.after ? `b/${p}` : '/dev/null'}`)
  for (const hunk of spec.hunks) {
    const body = hunk.lines
    const oldCount = body.filter((line) => line.startsWith('-') || line.startsWith(' ')).length
    const newCount = body.filter((line) => line.startsWith('+') || line.startsWith(' ')).length
    // 零行侧起点归一 git 惯例（0 起 0 行）；非空侧面值原样（jsdiff 与 git 的 1 起计数一致）。
    const oldStart = oldCount === 0 ? 0 : hunk.oldStart
    const newStart = newCount === 0 ? 0 : hunk.newStart
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    lines.push(...body)
  }
  return `${lines.join('\n')}\n`
}

/**
 * {@link CheckpointFileDiff} → patch 文本的便捷投影（binary/oversized ⇒ null；
 * text ⇒ serializeCheckpointPatch）。独立导出供单测六态逐态断言。
 */
export function serializeCheckpointFilePatch(file: CheckpointFileDiff): string | null {
  if (file.kind !== 'text') return null
  return serializeCheckpointPatch({
    path: file.path,
    before: file.before === true,
    after: file.after === true,
    hunks: file.hunks ?? [],
  })
}

/** checkpoints 引擎构造项。 */
export interface CheckpointsEngineOptions {
  /** workspaceChanges 可选切片读取（index.ts 注入 ctx.get 闭包——逐次现读，时序跟随）。 */
  readFace: () => GitWorkspaceChangesFace | undefined
  /** 可选 logger（读 debug / 失败 warn 由调用面承担；此处仅 apply 失败诊断）。 */
  logger?: GitLoggerFace | undefined
}

/** apply 失败 reason 的可读封顶（failed[].path/reason 过线——stderr 先脱敏）。 */
const FAILURE_REASON_MAX_CHARS = 300

export class CheckpointsEngine {
  private readonly logger: CheckpointsEngineOptions['logger']

  constructor(
    /** write 实例（`apply -R` 改工作区）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（repoRoot 探测 / HEAD 基线回读）。 */
    private readonly gitRead: GitRunner,
    /** status 引擎（attributionGet 的快照面——TTL 缓存语义，展示面不强制 fresh）。 */
    private readonly statusEngine: StatusEngine,
    /** 工作区解析（repoRoot 发现；staging-patch 同款 probe）。 */
    private readonly workspace: WorkspaceResolver,
    /** session-watch 环（seq 解析与 turn→files 的索引面）。 */
    private readonly watch: CheckpointsWatch,
    options: CheckpointsEngineOptions,
  ) {
    this.logger = options.logger
    this.readFace = options.readFace
  }

  /** workspaceChanges 可选切片读取（构造项存字段——逐次现读）。 */
  private readonly readFace: () => GitWorkspaceChangesFace | undefined

  /**
   * seq 解析共用半（checkpointDiff/checkpointRestore；批次四评审收口）：sessionId
   * 判别半（wire 可选项）非空字符串时把解析**收窄到单会话环**——多会话并发下 seq
   * 碰撞不再歧义（client 回传条目自带的 sessionId）；判别半下 'ambiguous' 不可达。
   * 缺席（undefined/null）= 现状口径（唯一放行/歧义硬拒）。在场但非法（非字符串/
   * 空串）⇒ invalidOptions 零命令拒绝——判别半是寻址信息，错形即调用方契约破坏。
   */
  private resolveSeqFor(
    seq: number,
    sessionId: string | null | undefined,
  ): ReturnType<CheckpointsWatch['resolveSeq']> {
    if (sessionId !== undefined && sessionId !== null) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw invalidOptions('sessionId must be a non-empty string when present')
      }
      return this.watch.resolveSeq(seq, sessionId)
    }
    return this.watch.resolveSeq(seq)
  }

  /**
   * 检查点清单（[清单 39] 只读）：环内索引 → 逐条 face.summary 现读补 summary
   * （服务缺失/记录缺失 ⇒ null——plan §6.3）。limit 缺省全量（受环容量天然钳制）。
   * @throws git/bad-request 'invalid-options'（limit 非 safe 正整数）。
   */
  async checkpointList(limit?: number | null): Promise<CheckpointListResult> {
    if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw invalidOptions('limit must be a positive integer or null')
    }
    const face = this.readFace()
    const entries = this.watch.entries()
    const clamped = limit === undefined || limit === null ? entries : entries.slice(0, limit)
    const out: CheckpointEntry[] = clamped.map((entry) => {
      const summary = face !== undefined ? face.summary(entry.sessionId, entry.seq) : undefined
      return {
        sessionId: entry.sessionId,
        seq: entry.seq,
        turn: entry.turn,
        endedAt: entry.endedAt,
        // turn/end reason.kind 过线（批次四评审收口——§6.6 时间线 reason 徽标的数据半；
        // dsh TurnEndReasonMap 基础词汇 + merge-extensible 未知 kind 客户端原样显示）。
        reason: entry.reason,
        summary: summary === undefined ? null : {
          total: summary.total,
          added: summary.added,
          deleted: summary.deleted,
          files: summary.files.map((file) => ({ path: file.path, added: file.added, deleted: file.deleted })),
        },
      }
    })
    return { entries: out }
  }

  /**
   * 检查点逐文件 diff（[清单 41] 点击看 diff 的数据面；只读）：seq 校验（不在环 /
   * 跨会话歧义 / face 缺 / summary 缺 ⇒ git/checkpoint-unavailable）→ index 越界 ⇒
   * git/bad-request → face.diff 投影过线（宿主快照读失败收编为 git/git-error）。
   * @throws git/bad-request、git/checkpoint-unavailable、git/git-error、
   *   git/timeout（face 内部的快照读取超时以普通错误到达时同收编）。
   */
  async checkpointDiff(options: CheckpointDiffOptions, signal?: AbortSignal): Promise<CheckpointFileDiff> {
    const seq = options.seq
    if (!Number.isSafeInteger(seq) || seq < 0) throw invalidOptions('seq must be a non-negative integer')
    const index = options.index
    if (!Number.isSafeInteger(index) || index < 0) throw invalidOptions('index must be a non-negative integer')
    const resolved = this.resolveSeqFor(seq, options.sessionId)
    if (resolved.kind !== 'unique') throw checkpointUnavailable(seq, resolved.kind === 'missing'
      ? 'no checkpoint record for this seq in the session ring'
      : `seq ${seq} matches several live sessions (${resolved.sessionIds.join(', ')}); the checkpoint is ambiguous`)
    const face = this.readFace()
    if (face === undefined) throw checkpointUnavailable(seq, 'the workspaceChanges service is not mounted on this deployment')
    const summary = face.summary(resolved.sessionId, seq)
    if (summary === undefined) throw checkpointUnavailable(seq, 'the workspaceChanges service holds no record for this seq')
    if (index >= summary.files.length) throw invalidOptions(`index ${index} is out of range (the summary lists ${summary.files.length} files)`)
    let diff: CheckpointFileDiff | undefined
    try {
      diff = await face.diff(resolved.sessionId, seq, index, signal ?? neverAborted())
    } catch (cause) {
      // workspace-changes diff 契约：live Session 的快照读取失败会抛宿主错误（非域码）——
      // 收编为 git/git-error（message 通道脱敏，不裸抛非 JSON 安全的宿主异常）。
      throw gitError('git/git-error', 'git checkpointDiff: the checkpoint snapshot read failed', {
        op: 'checkpointDiff',
        exitCode: null,
        stderr: sanitizeStderr(cause instanceof Error ? cause.message : String(cause)),
        truncated: false,
      })
    }
    if (diff === undefined) throw checkpointUnavailable(seq, 'the checkpoint record was disposed between listing and diff')
    return projectFileDiff(diff)
  }

  /**
   * 检查点恢复（[清单 39] DB=A）：acknowledged danger 闸（零命令）→ seq 校验（同
   * checkpointDiff，硬失败防误恢复）→ paths 校验（不属该 turn 记录 ⇒ bad-request
   * 零命令；空数组 ⇒ git/no-paths）→ baseRevision 乐观并发 → 逐文件 face.diff →
   * 序列化 → `git apply -R --whitespace=nowarn --unidiff-zero`（逐文件单独调用 =
   * 部分成功语义，已成功项不回滚）。
   * @throws git/bad-request（'unacknowledged' / 'stale-base-revision' / 'invalid-options'）、
   *   git/no-paths、git/checkpoint-unavailable、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async checkpointRestore(options: CheckpointRestoreOptions, signal?: AbortSignal): Promise<CheckpointRestoreResult> {
    // —— 守卫链（全部零命令失败前置）——
    if (options.acknowledged !== true) {
      throw gitError('git/bad-request', 'git checkpointRestore: this is a danger action and requires acknowledged=true', {
        reason: 'unacknowledged', paths: [], expected: null, actual: null,
      })
    }
    const seq = options.seq
    if (!Number.isSafeInteger(seq) || seq < 0) throw invalidOptions('seq must be a non-negative integer')
    const resolved = this.resolveSeqFor(seq, options.sessionId)
    if (resolved.kind !== 'unique') throw checkpointUnavailable(seq, resolved.kind === 'missing'
      ? 'no checkpoint record for this seq in the session ring'
      : `seq ${seq} matches several live sessions (${resolved.sessionIds.join(', ')}); the checkpoint is ambiguous`)
    const face = this.readFace()
    if (face === undefined) throw checkpointUnavailable(seq, 'the workspaceChanges service is not mounted on this deployment')
    const summary = face.summary(resolved.sessionId, seq)
    if (summary === undefined) throw checkpointUnavailable(seq, 'the workspaceChanges service holds no record for this seq')
    // paths 校验：给定清单必须逐条命中该 turn 记录（客户端以 list/diff 面的 path 取值；
    // 环外/过期清单 = 调用方状态过期，硬拒绝防半吊子恢复）。
    const requested = options.paths ?? null
    if (requested !== null && requested.length === 0) {
      throw gitError('git/no-paths', 'git checkpointRestore: an empty path list restores nothing', { op: 'checkpointRestore' })
    }
    // —— recorder 文件封顶的 restore 侧如实分列（批次四评审收口）——
    // summary.files 受 workspace-changes 的 maxFiles 封顶（默认 500，total 仍计全量）：
    // restore-all 对截断记录会**静默欠恢复**（被封顶截去的文件既不恢复也不进 failed、
    // 结果无任何截断标记）——恰是本批「部分成功如实分列」的反例。fail-closed：restore-all
    // 必须看得到全貌才许动手（checkpoint-unavailable 零命令，文案给 N/M 与补救路径）；
    // 显式 paths 只能点名清单内文件（封顶截去的文件在 summary 内无 index 可寻址，
    // face.diff 取不回——reject 文案区分「封顶截去」与「确不在记录」）。
    const files = summary.files
    const truncated = summary.total > files.length
    if (requested === null && truncated) {
      throw checkpointUnavailable(seq,
        `the checkpoint summary was capped to ${files.length} of ${summary.total} changed files; a full-turn restore would silently skip the rest — restore by explicit paths from the checkpointList, or raise the recorder file cap`)
    }
    const wanted = new Set<string>()
    if (requested !== null) {
      for (const path of requested) {
        if (typeof path !== 'string' || path === '' || !files.some((file) => file.path === path)) {
          throw invalidOptions(truncated
            ? `path ${JSON.stringify(path ?? null)} is not in the checkpoint summary (the record lists ${files.length} of ${summary.total} changed files — the rest were cut by the recorder file cap; it may belong to the turn but cannot be addressed from the truncated summary)`
            : `path ${JSON.stringify(path ?? null)} is not part of the checkpoint record`)
        }
        wanted.add(path)
      }
    }
    // —— repo 发现 + 乐观并发基线（stash.ts 同款语义：非 null 且 ≠ 最新 HEAD ⇒ 零命令拒绝）——
    const repoRoot = await this.resolveRepoRoot('checkpointRestore', signal)
    const headOid = await this.readHeadOid(repoRoot, signal)
    if (options.baseRevision !== null && options.baseRevision !== undefined && options.baseRevision !== headOid) {
      throw gitError('git/bad-request',
        `stale base revision: request was made against ${options.baseRevision}, HEAD is now ${headOid ?? '(unborn)'}`,
        { reason: 'stale-base-revision', paths: [], expected: options.baseRevision, actual: headOid })
    }
    // —— 逐文件部分成功（DB=A：diff hunks 反向应用，私有 tree id 绝不触碰——§0.2-③-1）——
    const applied: string[] = []
    const failed: Array<{ path: string; reason: string }> = []
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!
      if (requested !== null && !wanted.has(file.path)) continue
      await this.restoreOne(repoRoot, resolved.sessionId, seq, index, file.path,
        typeof summary.cwd === 'string' && summary.cwd !== '' ? summary.cwd : undefined,
        { applied, failed }, signal)
    }
    this.logger?.debug(`git checkpointRestore: seq=${String(seq)} applied=${String(applied.length)} failed=${String(failed.length)}`)
    return { applied, failed }
  }

  /** 单文件恢复（diff 现读 → 序列化 → apply -R；任何一步失败落 failed，不炸整请求）。 */
  private async restoreOne(
    repoRoot: string,
    sessionId: string,
    seq: number,
    index: number,
    recordedPath: string,
    cwd: string | undefined,
    sink: { applied: string[]; failed: Array<{ path: string; reason: string }> },
    signal?: AbortSignal,
  ): Promise<void> {
    const fail = (reason: string): void => {
      sink.failed.push({ path: recordedPath, reason })
    }
    const face = this.readFace()
    if (face === undefined) return fail('the workspaceChanges service disappeared mid-restore')
    let diff: CheckpointFileDiff | undefined
    try {
      diff = await face.diff(sessionId, seq, index, signal ?? neverAborted())
    } catch (cause) {
      return fail(sanitizeStderr(cause instanceof Error ? cause.message : String(cause)).trim().slice(-FAILURE_REASON_MAX_CHARS))
    }
    if (diff === undefined) return fail('the file diff is no longer available (record disposed)')
    if (diff.kind === 'binary') return fail('binary diffs cannot be restored from hunks (no content side is served)')
    if (diff.kind === 'oversized') return fail('oversized diffs cannot be restored from hunks (the file exceeded the capture cap)')
    // 会话 cwd 与 repoRoot 的路径折算：summary.path 相对会话工作目录，patch 头路径必须
    // 仓库相对（git apply 的解析形态）；越出仓库根的记录路径不属于本仓库，如实 failed。
    const repoRel = repoRelativePath(repoRoot, cwd, diff.path)
    if (repoRel === null) return fail('the recorded path lies outside the repository')
    const patch = serializeCheckpointPatch({
      path: repoRel,
      before: diff.before === true,
      after: diff.after === true,
      hunks: diff.hunks ?? [],
    })
    if (patch === null) return fail('the diff is not serializable to a patch')
    if (patch === '') {
      sink.applied.push(recordedPath) // 两侧同行的 no-op——零命令、如实计入 applied
      return
    }
    const args = ['apply', '-R', '--whitespace=nowarn', '--unidiff-zero']
    const result = await this.gitWrite.run(args, {
      cwd: repoRoot,
      op: 'checkpointRestore(git apply -R)',
      signal: signal ?? neverAborted(),
      stdin: patch,
    })
    if (result.exitCode !== 0) {
      // apply 失败 = turn 后内容又被改 / 行尾漂移等——不静默跳过，stderr 脱敏后可读。
      const reason = sanitizeStderr(result.stderr).trim().slice(-FAILURE_REASON_MAX_CHARS)
      return fail(reason !== '' ? reason : `git apply exited with ${String(result.exitCode)}`)
    }
    sink.applied.push(recordedPath)
  }

  /**
   * 归因（[清单 40] 只读）：status 快照全路径 × turn→files 现读映射（口径见文件头）。
   * 输出按 path 排序；turns 升序。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（status 扫描失败兜底——与 `git.status` 同面的错误）。
   */
  async attributionGet(signal?: AbortSignal): Promise<AttributionResult> {
    const state = await this.statusEngine.current(signal)
    if (state.error !== null) throw state.error
    const snapshot = state.snapshot
    const repoRoot = snapshot.repoRoot
    const face = this.readFace()
    const entries = this.watch.entries()
    // turn→(repo 相对路径)：每条环目经 face 现读 summary（记录缺失跳过）；路径经
    // 会话 cwd 折算到仓库相对——工作区外的文件不参与本仓库归因。
    const pathTurns = new Map<string, { turns: number[]; lastEndedAtMs: number }>()
    for (const entry of entries) {
      const summary = face !== undefined ? face.summary(entry.sessionId, entry.seq) : undefined
      if (summary === undefined) continue
      const endedAtMs = Date.parse(entry.endedAt)
      for (const file of summary.files) {
        const repoRel = repoRelativePath(repoRoot, typeof summary.cwd === 'string' ? summary.cwd : undefined, file.path)
        if (repoRel === null) continue
        const seen = pathTurns.get(repoRel)
        if (seen === undefined) {
          pathTurns.set(repoRel, { turns: [entry.turn], lastEndedAtMs: Number.isNaN(endedAtMs) ? 0 : endedAtMs })
        } else if (!seen.turns.includes(entry.turn)) {
          seen.turns.push(entry.turn)
          if (!Number.isNaN(endedAtMs) && endedAtMs > seen.lastEndedAtMs) seen.lastEndedAtMs = endedAtMs
        }
      }
    }
    // status 全路径（四组去重；porcelain 路径 = 仓库相对 posix）。
    const statusPaths = new Set<string>()
    for (const change of [...snapshot.staged, ...snapshot.unstaged, ...snapshot.untracked, ...snapshot.conflicted]) {
      statusPaths.add(change.path)
    }
    // 覆盖前提：face 在场且环内至少一条记录——否则「零命中」无从谈起，全部 unknown
    // （重启前历史 / 服务未挂载，DE=A 如实降级）。
    const hasCoverage = face !== undefined && entries.length > 0
    const out: AttributionEntry[] = []
    for (const path of [...statusPaths].sort()) {
      const covered = pathTurns.get(path)
      if (covered === undefined) {
        out.push({ path, turns: [], attribution: hasCoverage ? 'user' : 'unknown' })
        continue
      }
      // mixed 近似判定：文件 mtime 晚于最近命中回合的 endedAt ⇒ 回合结束后又被改动。
      let attribution: AttributionEntry['attribution'] = 'agent'
      if (covered.lastEndedAtMs > 0) {
        try {
          const info = await stat(join(repoRoot, ...path.split('/')))
          if (info.mtimeMs > covered.lastEndedAtMs) attribution = 'mixed'
        } catch {
          // 文件此刻不可 stat（已消失/权限）——无法证明回合后改动，按 agent 如实保守。
        }
      }
      out.push({ path, turns: [...covered.turns].sort((a, b) => a - b), attribution })
    }
    return { entries: out }
  }

  /** repo 发现（staging-patch 同款：exit 128 + not a git repository ⇒ git/no-repository）。 */
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

  /** HEAD 基线回读：exit 128 = unborn/broken HEAD ⇒ null（乐观并发按不匹配处理）；其余失败抛域错误。 */
  private async readHeadOid(repoRoot: string, signal?: AbortSignal): Promise<string | null> {
    const probe = await this.gitRead.run(['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      op: 'checkpointRestore(rev-parse --verify HEAD)',
      signal: signal ?? neverAborted(),
    })
    if (probe.exitCode === 0 && !probe.truncated) return probe.stdout.trim()
    if (probe.exitCode === 128) return null
    throw gitRunError('checkpointRestore(rev-parse --verify HEAD)', probe.exitCode, probe.stderr, probe.truncated)
  }
}

/** session-watch 的引擎消费面（真实现 = SessionWatch；测试可注入更窄替身）。 */
export interface CheckpointsWatch {
  entries(): CheckpointIndexEntry[]
  resolveSeq(seq: number, sessionId?: string): { kind: 'unique'; sessionId: string; entry: CheckpointIndexEntry }
    | { kind: 'ambiguous'; sessionIds: string[] }
    | { kind: 'missing' }
}

/** git/checkpoint-unavailable 工厂（details.seq = 请求 seq）。 */
function checkpointUnavailable(seq: number, detail: string) {
  return gitError('git/checkpoint-unavailable', `git checkpoint: no restorable record for seq ${String(seq)} (${detail})`, { seq })
}

/** git/bad-request 'invalid-options' 工厂（bad-request details 全形）。 */
function invalidOptions(detail: string) {
  return gitError('git/bad-request', `git checkpoint: ${detail}`, {
    reason: 'invalid-options', paths: [], expected: null, actual: null,
  })
}

/**
 * 会话 cwd + 记录路径 → 仓库相对 posix 路径（patch 头形态）。记录路径可为绝对
 * （workspace-changes 对工作区外文件记绝对路径）或相对会话 cwd；越出仓库根 ⇒ null。
 */
export function repoRelativePath(repoRoot: string, cwd: string | undefined, recordedPath: string): string | null {
  if (typeof recordedPath !== 'string' || recordedPath === '') return null
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : repoRoot
  const absolute = isAbsolute(recordedPath) ? recordedPath : resolve(base, recordedPath)
  const rel = relative(repoRoot, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return toPosix(rel)
}

/** CheckpointFileDiff 的 wire 投影（逐字段挑拣——plain JSON 纪律，多余宿主字段不过线）。 */
function projectFileDiff(file: CheckpointFileDiff): CheckpointFileDiff {
  if (file.kind === 'text') {
    return {
      kind: 'text',
      path: file.path,
      display: file.display,
      before: file.before === true,
      after: file.after === true,
      coarse: file.coarse === true,
      hunks: (file.hunks ?? []).map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: [...hunk.lines],
      })),
    }
  }
  return { kind: file.kind, path: file.path, display: file.display }
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
