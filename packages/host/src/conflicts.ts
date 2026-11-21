/**
 * dsh-gitkit — 冲突解决引擎（v3 批次一：[清单 13] conflictList / conflictResolve /
 * conflictMarkResolved / operationContinue + 中间态探测提共享；
 * docs/v3-implementation-plan.md §3.2–§3.4/§3.6）。
 *
 * 实例纪律：解决/标记/继续是写操作 → **write** runner（WRITE_PREFIX + fastTimeoutMs，
 * time-travel §4.5 同款——commitTimeoutMs 只属 commit runner）；fresh 扫描与中间态探测
 * 走 **readonly** runner。wire 只过 plain JSON；args 数组 spawn 零 shell；路径参数恒在
 * `--` 之后 + env GIT_LITERAL_PATHSPECS=1（git-runner.ts 基础 env）。
 *
 * fresh 扫描纪律（§3.2）：conflictList/conflictResolve/conflictMarkResolved/
 * operationContinue 的守卫世界一律**独立 fresh porcelain v2 扫描**（不经 StatusEngine
 * 的 1.5s TTL 缓存——解决动作必须基于此刻的世界）。v2 porcelain 自 git 2.11 起可用，
 * 本插件目标 git 2.55（README 工具链口径）；不支持 v2 的极老 git 在此落 git-error
 * （StatusEngine 的 v1 回退不复制进本引擎——冲突面的 XY 七码语义以 v2 为准）。
 *
 * 解决命令矩阵（§3.4，**查表实现**——批次二 merge-rebase.ts 消费同一函数，禁止在
 * 调用点散布分支）。**施工第一验证点实测矩阵**（git 2.55.0.windows.2，2026-11-12，
 * 真仓 UD/DU/AU/UA/DD 夹具逐格实跑；方案 §3.4 注记「DD/AU/UA 的 rm 分支语义以 git
 * 2.55 实测为准」）：
 *   - `git rm -- <unmerged>` 无需 -f，七码全部可执行（UD/DU/AU/UA/DD 实测 exit 0）；
 *   - `git checkout --theirs` 在 stage#3 缺席（UD——them 删除侧）**报错**
 *     「path 'f.txt' does not have their version」，故删除侧的 theirs 决议走 rm；
 *   - `git add -- <缺失文件>` 对 unmerged 路径会以「删除」决议（实测 u 记录消除、
 *     落 `1 D.`）——方案注记「add 对缺失文件无效」与实测不符，本引擎仍按方案对删除侧
 *     走 `git rm`（同样有效且语义显式）；
 *   - **方案 §3.4 UD/DU 两行的口径与 git 语义相反**（如实上报，未照抄）：git 官方
 *     porcelain 语义 UD = deleted by **them**（我方修改在场）、DU = deleted by **us**
 *     （对方修改在场）；方案表把 UD 标为「我方删除」、DU 标为「对方删除」，导致两行
 *     命令列互换。实测裁决：UD 的 ours 决议 = `add`（保留我方修改）、theirs = `rm`
 *     （接受对方删除——checkout --theirs 在 UD 上报错）；DU 的 ours = `rm`（保持我方
 *     删除）、theirs = `checkout --theirs + add`。本引擎按 **git 实测语义**落表（ours
 *     = 保持我方状态 / theirs = 采对方状态的两向意图不变）。
 *
 * 多文件中途失败（§3.10「结果如实分列」；独立评审定案 (a)）：conflictResolve /
 * conflictMarkResolved 逐文件执行、已成功项不回滚——中途失败时已成功清单随
 * `git/git-error` details.resolved 分列（rethrowWithResolvedPartial）；resolved 为空
 * 或非 git-error 码时原样重抛（纯失败不是部分成功，details 不带空清单）。
 *
 * 中间态探测 detectOperation（提共享，time-travel.ts 改为消费）：CHERRY_PICK_HEAD /
 * REVERT_HEAD / MERGE_HEAD 伪引用（`rev-parse --verify --quiet`）+ rebase-merge /
 * rebase-apply 目录（`rev-parse --git-path` + fs 存在性——worktree/分离 gitdir 安全）。
 * **rebase 目录优先于伪引用**：rebase 冲突中 sequencer 会写 CHERRY_PICK_HEAD，此 clocks
 * 下 continue/abort 必须经 rebase（cherry-pick --continue 会绕过 sequencer 损坏 rebase
 * 态）；纯 cherry-pick/revert/merge 三者 git 语义互斥，次序无影响。
 *
 * **git am 盲区（批次二评审收口登记，git 2.55.0.windows.2 实测）**：`git am` 停止态
 * （补丁冲突）同样落 `rebase-apply` 目录——本探测对 rebase-apply 在场一律分类
 * 'rebase'，对 am 停止态**错标 op**。后果 fail-closed（中间态无损）：operationContinue /
 * abortOperation 的 `git rebase --continue|--abort` 在 am 态 exit 128「fatal: It looks
 * like 'git am' is in progress. Cannot rebase.」（git 自拒，不误改世界）；conflictList
 * 徽标错显「正在 rebase」。插件不暴露 am（无 am 方法/入口），该态只产生于插件外的手工
 * git am。甄别器实测在场：am 停止态写 `rebase-apply/applying` 标记文件（rebase 的
 * apply 后端不写）——后续扩 am 支持时按此分档，本批仅登记不实现（方案 §4.9）。
 *
 * operationContinue（§3.3）：仍有 unmerged 路径 ⇒ bad-request 'conflicts-remaining'
 * （零命令）；执行 env 追加 **GIT_EDITOR=true**（防 sequencer 打开编辑器挂起——
 * GIT_TERMINAL_PROMPT=0 同纪律的编辑器版）；下一冲突 ⇒ {done:false, conflicted}
 * （**冲突是返回值不是错误**——client 循环驱动需要）；完成 ⇒ {done:true}。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { assertGitOk, gitError, gitRunError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import { signalOf } from './git-runner.ts'
import { probeRepoRoot } from './repo-root.ts'
import { parsePorcelainV2, UNMERGED_CODES } from './status-parser.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type {
  ConflictCode, ConflictEntry, ConflictListResult, ConflictMarkOptions, ConflictMarkResult,
  ConflictResolveOptions, ConflictResolveResult, OperationContinueResult, OperationInProgressOp,
} from './types.ts'

/** 冲突引擎构造项（logger 诊断位，stash.ts 同款）。 */
export interface ConflictsEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许）。 */
  logger?: { debug(message: string): void } | undefined
}

/** unmerged 七码 → kind（status-parser.ts kindOf 同语义：首个非 U 侧码定 kind）。 */
const CONFLICT_CODE_KIND: Readonly<Record<ConflictCode, 'modified' | 'added' | 'deleted'>> = Object.freeze({
  DD: 'deleted',
  AU: 'added',
  UD: 'deleted',
  UA: 'added',
  DU: 'deleted',
  AA: 'added',
  UU: 'modified',
})

/** unmerged 七码 → 两向存在性（删除侧不存在对应 stage；DD 双删、AU/UD 对方删、UA/DU 我方删）。 */
const CONFLICT_CODE_EXISTS: Readonly<Record<ConflictCode, { ours: boolean; theirs: boolean }>> = Object.freeze({
  DD: { ours: false, theirs: false },
  AU: { ours: true, theirs: false },
  UD: { ours: true, theirs: false },
  UA: { ours: false, theirs: true },
  DU: { ours: false, theirs: true },
  AA: { ours: true, theirs: true },
  UU: { ours: true, theirs: true },
})

/** 单个解决步骤（§3.4 矩阵的查表单元；checkout 步骤的 side 即 --ours/--theirs）。 */
export type ResolutionStep =
  | { kind: 'checkout'; side: 'ours' | 'theirs' }
  | { kind: 'add' }
  | { kind: 'rm' }

/**
 * 七码 × 两向命令矩阵（§3.4；**实测口径见文件头**——UD/DU 两行按 git 2.55 实测语义落表，
 * 与方案表格的列互换；方案自注「rm 分支语义以 git 2.55 实测为准」）。批次二 merge-rebase.ts
 * 消费同一函数——禁止在调用点散布分支。
 */
export const RESOLUTION_MATRIX: Readonly<Record<ConflictCode, Readonly<Record<'ours' | 'theirs', readonly ResolutionStep[]>>>> = Object.freeze({
  UU: { ours: [{ kind: 'checkout', side: 'ours' }, { kind: 'add' }], theirs: [{ kind: 'checkout', side: 'theirs' }, { kind: 'add' }] },
  AA: { ours: [{ kind: 'checkout', side: 'ours' }, { kind: 'add' }], theirs: [{ kind: 'checkout', side: 'theirs' }, { kind: 'add' }] },
  AU: { ours: [{ kind: 'add' }], theirs: [{ kind: 'rm' }] },
  UA: { ours: [{ kind: 'rm' }], theirs: [{ kind: 'checkout', side: 'theirs' }, { kind: 'add' }] },
  DU: { ours: [{ kind: 'rm' }], theirs: [{ kind: 'checkout', side: 'theirs' }, { kind: 'add' }] },
  UD: { ours: [{ kind: 'add' }], theirs: [{ kind: 'rm' }] },
  DD: { ours: [{ kind: 'rm' }], theirs: [{ kind: 'rm' }] },
})

/** 中间态伪引用 → op 词汇（detectOperation 的查表；rev-parse 可解析性即 git 的中间态语义）。 */
const OPERATION_HEADS: ReadonlyArray<{ head: 'CHERRY_PICK_HEAD' | 'REVERT_HEAD' | 'MERGE_HEAD'; op: OperationInProgressOp }> = Object.freeze([
  { head: 'CHERRY_PICK_HEAD', op: 'cherry-pick' },
  { head: 'REVERT_HEAD', op: 'revert' },
  { head: 'MERGE_HEAD', op: 'merge' },
])

/** rebase 中间态目录标记（--git-path 解析——worktree/分离 gitdir 安全）。 */
const REBASE_MARKERS: ReadonlyArray<'rebase-merge' | 'rebase-apply'> = Object.freeze(['rebase-merge', 'rebase-apply'])

/**
 * 中间态操作探测（conflicts / time-travel 共享——time-travel.ts v2 的私有
 * detectPseudoHead 提升为本函数并扩面）。**rebase 目录优先**（文件头注记）。
 * 已知盲区（登记不实现，文件头 am 段）：git am 停止态落 rebase-apply，在此错标
 * 'rebase'——甄别器 `rebase-apply/applying` 标记（实测在场），后续扩 am 再分档。
 * @returns op 词汇；null = 无中间态。
 * @throws git/git-error（rev-parse 非预期退出——契约破坏要响，time-travel v2 同款）。
 */
export async function detectOperation(
  repoRoot: string,
  gitRead: GitRunner,
  signal?: AbortSignal,
): Promise<OperationInProgressOp | null> {
  for (const marker of REBASE_MARKERS) {
    const probe = await gitRead.run(['rev-parse', '--git-path', marker], {
      cwd: repoRoot, op: `conflicts(rev-parse --git-path ${marker})`, signal: signalOf(signal),
    })
    assertGitOk(probe, `conflicts(rev-parse --git-path ${marker})`)
    const markerPath = probe.stdout.trim()
    if (markerPath !== '' && existsSync(resolve(repoRoot, markerPath))) return 'rebase'
  }
  for (const { head, op } of OPERATION_HEADS) {
    const probed = await gitRead.run(['rev-parse', '--verify', '--quiet', head], {
      cwd: repoRoot, op: `conflicts(rev-parse --verify ${head})`, signal: signalOf(signal),
    })
    if (probed.exitCode === 0) return op
    if (probed.exitCode !== 1) {
      throw gitRunError(`conflicts(rev-parse --verify ${head})`, probed.exitCode, probed.stderr, probed.truncated)
    }
  }
  return null
}

/** 一次 fresh 扫描里的单条 unmerged 条目（矩阵查表的键面）。 */
export interface UnmergedEntry {
  path: string
  code: ConflictCode
}

export class ConflictsEngine {
  private readonly logger: ConflictsEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——resolve/mark/continue 执行）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（fresh porcelain v2 扫描 / 中间态探测 / repo 发现）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（repoRoot 发现，stash.ts resolveRepoRoot 同款）。 */
    private readonly workspace: WorkspaceResolver,
    options: ConflictsEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  // ---------- conflictList（[13]；只读） ----------

  /**
   * 冲突清单：fresh porcelain v2 扫 unmerged 路径 + 中间态探测，组 ConflictEntry[]。
   * operation = null（裸冲突）时 abortable 恒 false。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（扫描/探测失败兜底）。
   */
  async conflictList(signal?: AbortSignal): Promise<ConflictListResult> {
    const repoRoot = await this.resolveRepoRoot('conflictList', signal)
    const unmerged = await this.scanUnmerged(repoRoot, signal)
    const operation = await detectOperation(repoRoot, this.gitRead, signal)
    const conflicts: ConflictEntry[] = unmerged.map((entry) => ({
      path: entry.path,
      code: entry.code,
      kind: CONFLICT_CODE_KIND[entry.code],
      oursExists: CONFLICT_CODE_EXISTS[entry.code].ours,
      theirsExists: CONFLICT_CODE_EXISTS[entry.code].theirs,
    }))
    this.logger?.debug(`git conflictList: count=${String(conflicts.length)} operation=${operation ?? '(none)'}`)
    return { conflicts, operation, abortable: operation !== null }
  }

  // ---------- conflictResolve（[13]；写） ----------

  /**
   * 逐条两向解决：守卫（全部 path ∈ fresh unmerged 集，违反 ⇒ 'path-not-conflicted'
   * 零写命令）→ 按 §3.4 矩阵查表执行 checkout/rm + add。部分失败不回滚已成功项
   * （逐文件语义，§3.10；结果如实——成功路径走 {resolved} 回包，中途失败时已成功
   * 清单随 git-error details.resolved 分列）。
   * @throws git/no-paths（choices 空）、git/bad-request（'path-not-conflicted' /
   *   'invalid-options'）、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error（矩阵命令失败兜底）。
   */
  async conflictResolve(options: ConflictResolveOptions, signal?: AbortSignal): Promise<ConflictResolveResult> {
    const choices = options?.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      throw gitError('git/no-paths', 'git conflictResolve: choices must be a non-empty array', { op: 'conflictResolve' })
    }
    const repoRoot = await this.resolveRepoRoot('conflictResolve', signal)
    const unmerged = await this.scanUnmerged(repoRoot, signal)
    const byPath = new Map(unmerged.map((entry) => [entry.path, entry]))
    // 守卫先行（零写命令）：每条 choice 的 path 必须此刻 unmerged，resolution 必须合法。
    for (const choice of choices) {
      if (typeof choice?.path !== 'string' || choice.path === '') {
        throw gitError('git/bad-request', 'git conflictResolve: each choice requires a non-empty path', {
          reason: 'invalid-options', paths: [], expected: null, actual: null,
        })
      }
      if (choice.resolution !== 'ours' && choice.resolution !== 'theirs') {
        throw gitError('git/bad-request', `git conflictResolve: resolution must be 'ours' | 'theirs', got ${JSON.stringify(choice.resolution)}`, {
          reason: 'invalid-options', paths: [], expected: null, actual: null,
        })
      }
      if (!byPath.has(choice.path)) {
        throw gitError('git/bad-request', `git conflictResolve: '${choice.path}' is not currently unmerged (fresh scan)`, {
          reason: 'path-not-conflicted', paths: [choice.path], expected: null, actual: null,
        })
      }
    }
    const resolved: string[] = []
    try {
      for (const choice of choices) {
        const entry = byPath.get(choice.path)!
        const steps = RESOLUTION_MATRIX[entry.code][choice.resolution]
        for (const step of steps) {
          const result = await this.gitWrite.run(resolveStepArgs(step, choice.path), {
            cwd: repoRoot, op: `conflictResolve(git ${resolveStepOp(step)})`, signal: signalOf(signal),
          })
          assertGitOk(result, `conflictResolve(git ${resolveStepOp(step)})`)
        }
        resolved.push(choice.path)
        this.logger?.debug(`git conflictResolve: path=${choice.path} code=${entry.code} resolution=${choice.resolution}`)
      }
    } catch (error) {
      // 已执行项不回滚——已成功清单随错误如实分列（§3.10）。
      rethrowWithResolvedPartial(error, resolved)
    }
    return { resolved }
  }

  // ---------- conflictMarkResolved（[13]；写） ----------

  /**
   * 手动编辑后标记已解决：守卫同 conflictResolve（'path-not-conflicted' 零写命令）→
   * 逐路径 `git add -- <path>`；**删除侧用户已删文件 ⇒ `git rm -- <path>`**（§3.3——
   * 文件存在性以工作区实况判定；实测 add 对缺失 unmerged 文件亦可决议，rm 为方案
   * 指定且语义显式）。中途失败的分列纪律同 conflictResolve（details.resolved）。
   * @throws git/no-paths（paths 空）、git/bad-request（'path-not-conflicted'）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async conflictMarkResolved(options: ConflictMarkOptions, signal?: AbortSignal): Promise<ConflictMarkResult> {
    const paths = options?.paths
    if (!Array.isArray(paths) || paths.length === 0) {
      throw gitError('git/no-paths', 'git conflictMarkResolved: paths must be a non-empty array', { op: 'conflictMarkResolved' })
    }
    const repoRoot = await this.resolveRepoRoot('conflictMarkResolved', signal)
    const unmerged = await this.scanUnmerged(repoRoot, signal)
    const unmergedPaths = new Set(unmerged.map((entry) => entry.path))
    for (const path of paths) {
      if (typeof path !== 'string' || path === '') {
        throw gitError('git/bad-request', 'git conflictMarkResolved: paths must be non-empty strings', {
          reason: 'invalid-options', paths: [], expected: null, actual: null,
        })
      }
      if (!unmergedPaths.has(path)) {
        throw gitError('git/bad-request', `git conflictMarkResolved: '${path}' is not currently unmerged (fresh scan)`, {
          reason: 'path-not-conflicted', paths: [path], expected: null, actual: null,
        })
      }
    }
    const resolved: string[] = []
    try {
      for (const path of paths) {
        const missing = !existsSync(resolve(repoRoot, path))
        const args = missing ? ['rm', '--', path] : ['add', '--', path]
        const result = await this.gitWrite.run(args, {
          cwd: repoRoot, op: `conflictMarkResolved(git ${missing ? 'rm' : 'add'})`, signal: signalOf(signal),
        })
        assertGitOk(result, `conflictMarkResolved(git ${missing ? 'rm' : 'add'})`)
        resolved.push(path)
        this.logger?.debug(`git conflictMarkResolved: path=${path} via=${missing ? 'rm' : 'add'}`)
      }
    } catch (error) {
      // 同 conflictResolve：已执行项不回滚——已成功清单随错误如实分列（§3.10）。
      rethrowWithResolvedPartial(error, resolved)
    }
    return { resolved }
  }

  // ---------- operationContinue（[13]；写） ----------

  /**
   * 继续中间态操作：守卫（unmerged 非空 ⇒ 'conflicts-remaining' 零命令；无中间态 ⇒
   * 'invalid-options'）→ `git <op> --continue`（执行 env 追加 GIT_EDITOR=true——文件头
   * 注记）。continue 触发下一冲突（exit 非 0 且输出含 CONFLICT）⇒ {done:false,
   * conflicted}（冲突是返回值不是错误）；完成 ⇒ {done:true, conflicted:[]}。
   * @throws git/bad-request（'conflicts-remaining' / 'invalid-options'）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error
   *   （continue 非冲突失败兜底）。
   */
  async operationContinue(signal?: AbortSignal): Promise<OperationContinueResult> {
    const repoRoot = await this.resolveRepoRoot('operationContinue', signal)
    const unmerged = await this.scanUnmerged(repoRoot, signal)
    if (unmerged.length > 0) {
      throw gitError('git/bad-request', `git operationContinue: ${String(unmerged.length)} unmerged path(s) remain; resolve them first`, {
        reason: 'conflicts-remaining', paths: unmerged.map((entry) => entry.path), expected: null, actual: null,
      })
    }
    const operation = await detectOperation(repoRoot, this.gitRead, signal)
    if (operation === null) {
      throw gitError('git/bad-request', 'git operationContinue: no operation is in progress (no pseudo-ref and no rebase state)', {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    const result = await this.gitWrite.run([operation, '--continue'], {
      cwd: repoRoot, op: `operationContinue(git ${operation} --continue)`, signal: signalOf(signal),
      // GIT_EDITOR=true：sequencer 的 continue 面会拉起编辑器确认提交信息——挂起防护
      // 是正确性问题非性能问题（§3.10；GIT_TERMINAL_PROMPT=0 不覆盖编辑器拉起）。
      env: { GIT_EDITOR: 'true' },
    })
    if (result.exitCode !== 0 && /CONFLICT/.test(result.stdout) === false && /CONFLICT/.test(result.stderr) === false) {
      throw gitRunError(`operationContinue(git ${operation} --continue)`, result.exitCode, result.stderr, result.truncated)
    }
    const conflicted = result.exitCode === 0 ? [] : (await this.scanUnmerged(repoRoot, signal)).map((entry) => entry.path)
    this.logger?.debug(`git operationContinue: op=${operation} done=${String(result.exitCode === 0)} conflicted=${String(conflicted.length)}`)
    return { op: operation, done: result.exitCode === 0, conflicted }
  }

  // ---------- 扫描与解析 ----------

  /**
   * fresh porcelain v2 扫描（独立于 StatusEngine 的 TTL 缓存——此刻的世界）并过滤出
   * unmerged 七码条目（u record）。
   */
  private async scanUnmerged(repoRoot: string, signal?: AbortSignal): Promise<UnmergedEntry[]> {
    const status = await this.gitRead.run(['status', '--porcelain=v2', '--untracked-files=all', '-z'], {
      cwd: repoRoot, op: 'conflicts(status --porcelain=v2)', signal: signalOf(signal),
    })
    assertGitOk(status, 'conflicts(status --porcelain=v2)')
    const parsed = parsePorcelainV2(status.stdout)
    const entries: UnmergedEntry[] = []
    for (const entry of parsed.entries) {
      const code = (entry.x + entry.y) as ConflictCode
      if (!UNMERGED_CODES.has(entry.x + entry.y)) continue
      entries.push({ path: entry.path, code })
    }
    return entries
  }

  /** repo 发现（共享实现 probeRepoRoot——repo-root.ts：exit 128 + not a git repository ⇒ git/no-repository）。 */
  private async resolveRepoRoot(op: string, signal?: AbortSignal): Promise<string> {
    const resolution = await this.workspace.resolve()
    return probeRepoRoot(this.gitRead, resolution.root, op, signal)
  }
}

/** 矩阵步骤 → git argv（args 数组，零 shell；路径恒在 `--` 之后）。 */
function resolveStepArgs(step: ResolutionStep, path: string): string[] {
  if (step.kind === 'checkout') return ['checkout', `--${step.side}`, '--', path]
  if (step.kind === 'add') return ['add', '--', path]
  return ['rm', '--', path]
}

/** 矩阵步骤 → op 名（域错误 details 与日志）。 */
function resolveStepOp(step: ResolutionStep): string {
  if (step.kind === 'checkout') return `checkout --${step.side}`
  return step.kind
}

/**
 * 多文件中途失败 ⇒「结果如实分列」（§3.10；独立评审定案 (a)）：逐文件执行、已成功项
 * 不回滚（git 级别也难回滚）——失败时把已成功清单并入 `git/git-error` details.resolved。
 * resolved 为空（守卫失败/首文件即败）或非 git-error 码时原样重抛——纯失败不是部分
 * 成功，details 不带空清单。
 */
function rethrowWithResolvedPartial(error: unknown, resolved: readonly string[]): never {
  if (resolved.length === 0) throw error
  const remote = remoteErrorOf(error)
  if (remote === undefined || remote.code !== 'git/git-error') throw error
  throw new RemoteError('git/git-error', remote.message, { ...remote.details, resolved: [...resolved] })
}

