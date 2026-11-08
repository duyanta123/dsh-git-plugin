/**
 * dsh-gitkit — 时间旅行引擎（v2 批次二：[清单 37] cherry-pick / revert / reset +
 * abortOperation；docs/v2-implementation-plan.md §4.3/§4.5）。
 *
 * 实例纪律（§4.5 定死）：**执行一律走 write runner（fastTimeoutMs）**——四 runner
 * 纪律中 `commitTimeoutMs` 只属 commit runner（git-runner.ts：readonly/write 两实例
 * 同 fastTimeoutMs，commit 独占 commit 档），「写 runner + commitTimeoutMs」组合不
 * 存在；cherry-pick/revert 触发 commit-msg 类 hook 的慢场景若实测超时，再开独立
 * timeTravelTimeoutMs Config 档（照 commitTimeoutMs 先例），默认不新增档位。预检/
 * 回读走 readonly 实例。_abort 完成后走 afterWrite 语义（服务面接线）。
 *
 * 守卫链（三重守卫 discard 同款 + 中间态探测）——全过才执行任何写命令：
 *   1. acknowledged=false ⇒ git/bad-request 'unacknowledged'（零命令）；
 *   2. fresh status 扫描（绕 TTL 缓存——此刻的世界）；
 *   3. baseRevision 与最新 branch.oid 不一致 ⇒ 'stale-base-revision'（乐观并发）；
 *   4. CHERRY_PICK_HEAD / REVERT_HEAD 在场 ⇒ git/operation-in-progress（拒绝叠操作；
 *      治愈路径 = abortOperation）；
 *   5. detached/unborn ⇒ git/no-branch（requireBranch 语义，remote-ops.ts 同款——
 *      cherry-pick/revert/reset 都在分支上落子）；
 *   6. 目标修订不可解析 ⇒ git/unknown-revision（rev-parse --verify --quiet 预检）。
 *
 * 冲突语义（§4.10 风险项）：cherry-pick/revert 冲突（exit 1 且输出含 CONFLICT）⇒
 * git/merge-conflict（details.op = 'cherry-pick'|'revert'，conflicted =
 * `diff --name-only --diff-filter=U` 回读，abortable = 中间态伪引用在场）——仓库
 * 留中间态直到 abort/解决（完整解决 UI 是 v3 [13]）；非冲突失败（空 cherry-pick /
 * 空 revert 的 "nothing to commit" 等）⇒ git/git-error（方案 §4.3 对空 revert 的
 * 指认；cherry-pick 空态同映射——git 语义两者同形）。
 */

import { assertGitOk, gitError, gitRunError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { StatusEngine } from './status.ts'
import type {
  AbortOperationResult, CherryPickOptions, RevertOptions, ResetOptions,
  TimeTravelResult,
} from './types.ts'
import type { GitStatusSnapshot } from './types.ts'

/** 时间旅行引擎构造项（预留 logger 诊断位，MutationEngine 同款）。 */
export interface TimeTravelEngineOptions {
  logger?: { debug(message: string): void }
}

/** git 的中间态伪引用（cherry-pick 与 revert 二选一在场——git 互斥语义）。 */
type PseudoHead = 'CHERRY_PICK_HEAD' | 'REVERT_HEAD'

/** 伪引用 → wire 的 op 词汇（operation-in-progress/merge-conflict/AbortOperationResult 共用）。 */
function opOfPseudoHead(head: PseudoHead): 'cherry-pick' | 'revert' {
  return head === 'CHERRY_PICK_HEAD' ? 'cherry-pick' : 'revert'
}

export class TimeTravelEngine {
  private readonly logger: TimeTravelEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——cherry-pick/revert/reset/abort 执行）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（中间态探测 / 修订预检 / 冲突路径回读 / HEAD 回读）。 */
    private readonly gitRead: GitRunner,
    /** 最新世界读取（fresh 扫描：守卫世界 + repoRoot）。 */
    private readonly status: StatusEngine,
    options: TimeTravelEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  // ---------- cherry-pick / revert（[清单 37]） ----------

  /**
   * cherry-pick：守卫链（文件头）→ `git cherry-pick <oid>` → HEAD 回读。
   * 冲突 ⇒ git/merge-conflict（仓库留中间态，abortOperation 治愈）。
   * @throws git/bad-request、git/operation-in-progress、git/no-branch、
   *   git/unknown-revision、git/merge-conflict、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async cherryPick(options: CherryPickOptions, signal?: AbortSignal): Promise<TimeTravelResult> {
    const { repoRoot, oldOid } = await this.runGuards(options.acknowledged, options.baseRevision, 'cherryPick', signal)
    const oid = await this.requireRevision(repoRoot, 'cherryPick', options.oid, signal)
    const result = await this.gitWrite.run(['cherry-pick', oid], {
      cwd: repoRoot, op: 'cherryPick(git cherry-pick)', signal: active(signal),
    })
    // await：throwOpFailure 是 async（冲突回读）——漏 await 会把 merge-conflict 变成
    // 未处理 rejection 而主流程继续走到 readHead（首跑实修）。
    if (result.exitCode !== 0) await this.throwOpFailure(result, 'cherry-pick', repoRoot, signal)
    const newOid = await this.readHead(repoRoot, 'cherryPick', signal)
    this.logger?.debug(`git cherryPick: oid=${oid.slice(0, 12)} oldOid=${oldOid.slice(0, 12)} newOid=${newOid.slice(0, 12)}`)
    return { op: 'cherry-pick', oldOid, newOid }
  }

  /**
   * revert（`--no-edit` 钉死不进编辑器——runner env GIT_TERMINAL_PROMPT=0 不覆盖
   * 编辑器拉起，命令面显式防挂）：守卫链同 cherryPick；空 revert（exit 1 无
   * CONFLICT）⇒ git/git-error（方案 §4.3 指认）。
   * @throws 同 cherryPick。
   */
  async revert(options: RevertOptions, signal?: AbortSignal): Promise<TimeTravelResult> {
    const { repoRoot, oldOid } = await this.runGuards(options.acknowledged, options.baseRevision, 'revert', signal)
    const oid = await this.requireRevision(repoRoot, 'revert', options.oid, signal)
    const result = await this.gitWrite.run(['revert', '--no-edit', oid], {
      cwd: repoRoot, op: 'revert(git revert)', signal: active(signal),
    })
    if (result.exitCode !== 0) await this.throwOpFailure(result, 'revert', repoRoot, signal)
    const newOid = await this.readHead(repoRoot, 'revert', signal)
    this.logger?.debug(`git revert: oid=${oid.slice(0, 12)} oldOid=${oldOid.slice(0, 12)} newOid=${newOid.slice(0, 12)}`)
    return { op: 'revert', oldOid, newOid }
  }

  // ---------- reset（[清单 37]） ----------

  /**
   * reset（soft/mixed/hard；target null = HEAD）：守卫链同 cherryPick；脏区**不拦**
   * ——hard 的语义即清理（§4.10），soft/mixed 不触工作区。命令形
   * `git reset --<kind> <target|HEAD>`（target 经 rev-parse 预检，`-` 开头的注入词
   * 无法通过预检）。
   * @throws git/bad-request、git/operation-in-progress、git/no-branch、
   *   git/unknown-revision、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  async reset(options: ResetOptions, signal?: AbortSignal): Promise<TimeTravelResult> {
    const { repoRoot, oldOid } = await this.runGuards(options.acknowledged, options.baseRevision, 'reset', signal)
    const kind = options.kind
    if (kind !== 'soft' && kind !== 'mixed' && kind !== 'hard') {
      throw gitError('git/bad-request', `git reset: unknown reset kind ${JSON.stringify(kind)}`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    const target = typeof options.target === 'string' && options.target !== '' ? options.target : 'HEAD'
    await this.requireRevision(repoRoot, 'reset', target, signal)
    const result = await this.gitWrite.run(['reset', `--${kind}`, target], {
      cwd: repoRoot, op: `reset(git reset --${kind})`, signal: active(signal),
    })
    if (result.exitCode !== 0) throw gitRunError(`reset(git reset --${kind})`, result.exitCode, result.stderr, result.truncated)
    const newOid = await this.readHead(repoRoot, 'reset', signal)
    this.logger?.debug(`git reset: kind=${kind} target=${target} oldOid=${oldOid.slice(0, 12)} newOid=${newOid.slice(0, 12)}`)
    return { op: 'reset', oldOid, newOid }
  }

  // ---------- abortOperation（[清单 37]） ----------

  /**
   * 放弃中间态操作（幂等安全，无 acknowledged 闸——abort 是治愈路径不是危险动作）：
   * 探测 CHERRY_PICK_HEAD → `git cherry-pick --abort`；REVERT_HEAD →
   * `git revert --abort`；无中间态 ⇒ 空成功（{ aborted: null }，零命令）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（abort 命令失败兜底）。
   */
  async abortOperation(signal?: AbortSignal): Promise<AbortOperationResult> {
    const { repoRoot } = await this.scanFresh('abortOperation', signal)
    const head = await this.detectPseudoHead(repoRoot, signal)
    if (head === null) {
      this.logger?.debug('git abortOperation: no operation in progress (idempotent no-op)')
      return { aborted: null }
    }
    const command = head === 'CHERRY_PICK_HEAD' ? 'cherry-pick' : 'revert'
    const result = await this.gitWrite.run([command, '--abort'], {
      cwd: repoRoot, op: `abortOperation(git ${command} --abort)`, signal: active(signal),
    })
    assertGitOk(result, `abortOperation(git ${command} --abort)`)
    this.logger?.debug(`git abortOperation: aborted=${opOfPseudoHead(head)}`)
    return { aborted: opOfPseudoHead(head) }
  }

  // ---------- 守卫与回读 ----------

  /**
   * 守卫链（cherryPick/revert/reset 共用；顺序 = 文件头 1→6）：返回 fresh 快照的
   * repoRoot 与操作前 HEAD（born 分支回读值）。revision 预检由各方法自做（oid 与
   * target 的 op 词汇不同）。
   */
  private async runGuards(
    acknowledged: boolean,
    baseRevision: string | null,
    op: string,
    signal?: AbortSignal,
  ): Promise<{ repoRoot: string; snapshot: GitStatusSnapshot; oldOid: string }> {
    // 守卫 1：C 级二次确认旗标（最先判，零命令执行）。
    if (acknowledged !== true) {
      throw gitError('git/bad-request', `git ${op} requires acknowledged=true (destructive confirmation gate)`, {
        reason: 'unacknowledged', paths: [], expected: null, actual: null,
      })
    }
    const { repoRoot, snapshot } = await this.scanFresh(op, signal)
    // 守卫 3：baseRevision 乐观并发（客户端视角的 HEAD 未变才许执行）。
    if (baseRevision !== null && baseRevision !== snapshot.branch.oid) {
      throw gitError('git/bad-request', `stale base revision: request was made against ${baseRevision}, HEAD is now ${snapshot.branch.oid ?? '(unborn)'}`, {
        reason: 'stale-base-revision', paths: [], expected: baseRevision, actual: snapshot.branch.oid,
      })
    }
    // 守卫 4：中间态探测（拒绝叠操作——治愈路径 = abortOperation）。
    const pseudoHead = await this.detectPseudoHead(repoRoot, signal)
    if (pseudoHead !== null) {
      throw gitError('git/operation-in-progress', `git ${op}: ${opOfPseudoHead(pseudoHead)} is in progress (CHERRY_PICK_HEAD/REVERT_HEAD present); abort or resolve it first`, {
        op: opOfPseudoHead(pseudoHead),
      })
    }
    // 守卫 5：detached/unborn 拒绝（requireBranch 语义，remote-ops.ts 同款）。
    if (snapshot.branch.unborn) {
      throw gitError('git/no-branch', `git ${op}: repository has no commits yet (unborn branch)`, { state: 'unborn' })
    }
    if (snapshot.branch.detached || snapshot.branch.name === null || snapshot.branch.name === '') {
      throw gitError('git/no-branch', `git ${op}: HEAD is detached (no current branch)`, { state: 'detached' })
    }
    const oldOid = snapshot.branch.oid
    if (oldOid === null) {
      // born 分支必有 oid（porcelain branch.oid）；防御性兜底按 unborn 拒绝。
      throw gitError('git/no-branch', `git ${op}: HEAD has no commit`, { state: 'unborn' })
    }
    return { repoRoot, snapshot, oldOid }
  }

  /** 目标修订可解析预检（`rev-parse --verify --quiet`；exit 1 ⇒ git/unknown-revision）。 */
  private async requireRevision(repoRoot: string, op: string, revision: string, signal?: AbortSignal): Promise<string> {
    if (typeof revision !== 'string' || revision.trim() === '') {
      throw gitError('git/bad-request', `git ${op}: a non-empty revision is required`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    const probed = await this.gitRead.run(['rev-parse', '--verify', '--quiet', revision], {
      cwd: repoRoot, op: `${op}(rev-parse --verify)`, signal: active(signal),
    })
    if (probed.exitCode !== 0) {
      throw gitError('git/unknown-revision', `git ${op}: revision '${revision}' could not be resolved`, {
        op, revision,
      })
    }
    return revision
  }

  /**
   * 中间态伪引用探测（CHERRY_PICK_HEAD 优先、REVERT_HEAD 次之——git 语义互斥）：
   * `rev-parse --verify --quiet <head>` exit 0 = 在场、exit 1 = 缺席、其余 = 契约破坏。
   */
  private async detectPseudoHead(repoRoot: string, signal?: AbortSignal): Promise<PseudoHead | null> {
    for (const head of ['CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const) {
      const probed = await this.gitRead.run(['rev-parse', '--verify', '--quiet', head], {
        cwd: repoRoot, op: `time-travel(rev-parse --verify ${head})`, signal: active(signal),
      })
      if (probed.exitCode === 0) return head
      if (probed.exitCode !== 1) {
        throw gitRunError(`time-travel(rev-parse --verify ${head})`, probed.exitCode, probed.stderr, probed.truncated)
      }
    }
    return null
  }

  /**
   * cherry-pick/revert 非零退出 → 域错误映射：输出含 CONFLICT ⇒ git/merge-conflict
   * （conflicted = diff-filter=U 回读；abortable = 中间态伪引用在场——冲突路径恒
   * true，防御性探测如实回值）；其余（空 cherry-pick / 空 revert 等）⇒ git-error。
   */
  private async throwOpFailure(
    result: { exitCode: number | null; stdout: string; stderr: string; truncated: boolean },
    op: 'cherry-pick' | 'revert',
    repoRoot: string,
    signal?: AbortSignal,
  ): Promise<never> {
    if (/CONFLICT/.test(result.stdout) || /CONFLICT/.test(result.stderr)) {
      const conflicted = await this.conflictedPaths(repoRoot, signal)
      const pseudoHead = await this.detectPseudoHead(repoRoot, signal)
      throw gitError('git/merge-conflict', `git ${op}: conflict; the repository is left in an intermediate state (abort or resolve it)`, {
        op,
        conflicted,
        abortable: pseudoHead !== null,
      })
    }
    throw gitRunError(op, result.exitCode, result.stderr, result.truncated)
  }

  /** 未合并路径回读（`diff --name-only --diff-filter=U`）。 */
  private async conflictedPaths(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
    const listing = await this.gitRead.run(['diff', '--name-only', '--diff-filter=U'], {
      cwd: repoRoot, op: 'time-travel(diff --diff-filter=U)', signal: active(signal),
    })
    assertGitOk(listing, 'time-travel(diff --diff-filter=U)')
    return listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  }

  /** 操作后 HEAD 回读（`rev-parse --verify HEAD`；时间旅行三操作均不产生 unborn）。 */
  private async readHead(repoRoot: string, op: string, signal?: AbortSignal): Promise<string> {
    const head = await this.gitRead.run(['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot, op: `${op}(rev-parse --verify HEAD)`, signal: active(signal),
    })
    assertGitOk(head, `${op}(rev-parse --verify HEAD)`)
    const oid = head.stdout.trim()
    if (oid === '') {
      throw gitError('git/git-error', `git ${op}: empty HEAD after a successful operation`, {
        op: `${op}(rev-parse --verify HEAD)`, exitCode: head.exitCode, stderr: '', truncated: false,
      })
    }
    return oid
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
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
