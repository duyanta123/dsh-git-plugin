/**
 * dsh-gitkit — merge / rebase 引擎（v3 批次二：[清单 28] branchMerge / [清单 29]
 * rebase；docs/v3-implementation-plan.md §4.1–§4.5）。
 *
 * 实例纪律（§4.5 定死）：**执行一律 write runner（fastTimeoutMs）**——四 runner 纪律中
 * `commitTimeoutMs` 只属 commit runner（git-runner.ts：readonly/write 两实例同
 * fastTimeoutMs，commit 独占 commit 档），「写 runner + commitTimeoutMs」组合不存在；
 * rebase 多提交大仓慢场景实测超时再开独立 Config 档（§4.9 风险项——照 V2 time-travel
 * 先例，默认不新增档位）。预检/回读走 readonly 实例；守卫世界走 fresh 扫描
 * （StatusEngine {fresh:true}——绕 TTL 缓存，time-travel runGuards 同款）。
 *
 * 守卫链（§4.3，全过才执行任何写命令；顺序 = 方案表 ①→⑤ + 防御性 unborn 档）：
 *   1. acknowledged=false ⇒ git/bad-request 'unacknowledged'（零命令）；
 *   2. fresh status 扫描（此刻的世界；error 三态就地抛出）；
 *   3. baseRevision 与最新 branch.oid 不一致 ⇒ 'stale-base-revision'（乐观并发）；
 *   4. `rev-parse --verify --quiet <rev>^{commit}` ⇒ git/unknown-revision（branch /
 *      upstream / onto；time-travel requireRevision 同款 + **剥 `^{commit}`**——
 *      annotated tag 回 tag 对象 oid，ff 比对面必须是剥壳 commit oid，评审收口）；
 *   5. detectOperation() 非空 ⇒ git/operation-in-progress（**批次一 conflicts.ts 共享
 *      探测直接消费，本批不重复实现**；拒绝叠操作，治愈路径 = abortOperation /
 *      批次一冲突面板）；
 *   6. fresh status 非干净 ⇒ git/dirty-worktree（**从严档**：git 本身允许部分脏合并，
 *      插件口径要求干净才可预测——§4.9 口径争议项，README 如实注明；snapshot.clean
 *      = staged/unstaged/untracked/conflicted 四组全空，任意非空即拒）；
 *   7. 防御性：unborn HEAD（branch.oid=null）⇒ git/no-branch（无提交可合并/变基——
 *      time-travel 防御兜底同款；detached 按方案不拦，git 语义自答）。
 *   入参形态校验（branch/upstream/onto 非空、fastForward 三态）落在 1 与 4 之间——
 *   同样零命令。
 *
 * 命令面（argv 数组零 shell；§4.3 字面序）：
 *   - merge：`git merge <branch> [--ff-only|--no-ff] [-m <msg>|--no-edit]`——message
 *     null/undefined/'' 一律 `--no-edit`（编辑器挂起防护由命令面钉死，revert --no-edit
 *     先例）；
 *   - rebase：`git rebase [--onto <onto>] <upstream>`（默认分支系 = 当前分支）；执行
 *     env 追加 **GIT_EDITOR=true**（合并后端边缘态的编辑器拉起一律 no-op——挂起防护
 *     是正确性问题，conflicts.ts operationContinue 同纪律；正常路径 git 不开编辑器，
 *     该 env 恒惰性）。
 *
 * 冲突语义（§4.3）：exit 非 0 且输出含 CONFLICT ⇒ git/merge-conflict（op
 * 'merge'|'rebase'，conflicted = `diff --name-only --diff-filter=U -z` 回读——NUL 分隔
 * 路径原样，conflicts.ts scanUnmerged 的 porcelain v2 -z 同口径，评审收口统一），abortable =
 * 中间态探测在场——time-travel throwOpFailure 同款；仓库留中间态直到 abortOperation /
 * 批次一解决面板）。非冲突失败（--ff-only 不可 ff 的 "Not possible to fast-forward"、
 * 空 rebase 等）⇒ git/git-error（classifyStderr 词汇映射照旧——"Not possible to
 * fast-forward" 落 pull-diverged 簇 → fast-forward refused 措辞）。
 *
 * up-to-date 幂等（§4.7）：git "Already up to date." / "Current branch … is up to
 * date." 都是 exit 0 成功路径——不报错，newOid = HEAD 回读（= oldOid，零提交产生）；
 * BranchMergeResult.fastForward 定死 = 「HEAD 真移动且落在目标 oid」（真 ff 恒 true；
 * up-to-date 与 no-ff 合并提交均 false——up-to-date 不谎报 ff）；RebaseResult.done
 * 恒 true（冲突走错误路径，continue 由批次一 operationContinue 驱动——§4.2 注记）。
 */

import { assertGitOk, gitError, gitRunError, sanitizeStderr } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import { detectOperation } from './conflicts.ts'
import type { StatusEngine } from './status.ts'
import type {
  BranchMergeOptions, BranchMergeResult, GitStatusSnapshot, RebaseOptions, RebaseResult,
} from './types.ts'

/** merge/rebase 引擎构造项（logger 诊断位，conflicts.ts 同款）。 */
export interface MergeRebaseEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许）。 */
  logger?: { debug(message: string): void } | undefined
}

export class MergeRebaseEngine {
  private readonly logger: MergeRebaseEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——merge/rebase 执行）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（修订预检 / 中间态探测 / 冲突路径回读 / HEAD 回读）。 */
    private readonly gitRead: GitRunner,
    /** 最新世界读取（fresh 扫描：守卫世界 + repoRoot）。 */
    private readonly status: StatusEngine,
    options: MergeRebaseEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  // ---------- branchMerge（[清单 28]；写） ----------

  /**
   * 分支合并（§4.3）：守卫链（文件头 1→7）→ `git merge <branch> [--ff-only|--no-ff]
   * [-m <msg>|--no-edit]` → HEAD 回读。冲突 ⇒ git/merge-conflict（op 'merge'，仓库留
   * 中间态，abortOperation 治愈）；up-to-date ⇒ 幂等成功（零提交，fastForward=false）。
   * @throws git/bad-request（'unacknowledged' / 'stale-base-revision' /
   *   'invalid-options'）、git/unknown-revision、git/operation-in-progress、
   *   git/dirty-worktree、git/no-branch、git/merge-conflict、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async branchMerge(options: BranchMergeOptions, signal?: AbortSignal): Promise<BranchMergeResult> {
    const op = 'branchMerge'
    const { repoRoot, snapshot, oldOid } = await this.runGuards(op, options.acknowledged, options.baseRevision, signal)
    if (typeof options.branch !== 'string' || options.branch.trim() === '') {
      throw gitError('git/bad-request', `git ${op}: branch must be a non-empty string`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    const ff = options.fastForward
    if (ff !== 'auto' && ff !== 'ff-only' && ff !== 'no-ff') {
      throw gitError('git/bad-request', `git ${op}: fastForward must be 'auto' | 'ff-only' | 'no-ff', got ${JSON.stringify(ff)}`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    const targetOid = await this.requireRevision(repoRoot, op, options.branch, signal)
    await this.rejectOverlapsAndDirty(op, repoRoot, snapshot, signal)
    const args = ['merge', options.branch]
    if (ff === 'ff-only') args.push('--ff-only')
    if (ff === 'no-ff') args.push('--no-ff')
    if (typeof options.message === 'string' && options.message !== '') args.push('-m', options.message)
    else args.push('--no-edit')
    const result = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'branchMerge(git merge)', signal: active(signal),
    })
    if (result.exitCode !== 0) await this.throwOpFailure(result, 'merge', repoRoot, signal)
    const newOid = await this.readHead(repoRoot, op, signal)
    // fastForward = HEAD 真移动且落在目标 oid（up-to-date 与 no-ff 合并提交均 false——
    // up-to-date 不谎报 ff；文件头注记）。
    const fastForward = newOid !== oldOid && newOid === targetOid
    this.logger?.debug(`git ${op}: branch=${options.branch} ff=${ff} oldOid=${oldOid.slice(0, 12)} newOid=${newOid.slice(0, 12)} fastForward=${String(fastForward)}`)
    return { oldOid, newOid, fastForward }
  }

  // ---------- rebase（[清单 29]；写） ----------

  /**
   * 变基（§4.3）：守卫链同 branchMerge（branch 换 upstream + onto 双预检）→
   * `git rebase [--onto <onto>] <upstream>` → HEAD 回读。冲突 ⇒ git/merge-conflict
   * （op 'rebase'——continue 由批次一 operationContinue 驱动）；up-to-date ⇒ 幂等成功。
   * @throws 同 branchMerge。
   */
  async rebase(options: RebaseOptions, signal?: AbortSignal): Promise<RebaseResult> {
    const op = 'rebase'
    const { repoRoot, snapshot, oldOid } = await this.runGuards(op, options.acknowledged, options.baseRevision, signal)
    if (typeof options.upstream !== 'string' || options.upstream.trim() === '') {
      throw gitError('git/bad-request', `git ${op}: upstream must be a non-empty string`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    if (options.onto !== null && options.onto !== undefined
      && (typeof options.onto !== 'string' || options.onto.trim() === '')) {
      throw gitError('git/bad-request', `git ${op}: onto must be a non-empty string when present`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    await this.requireRevision(repoRoot, op, options.upstream, signal)
    if (typeof options.onto === 'string' && options.onto !== '') {
      await this.requireRevision(repoRoot, op, options.onto, signal)
    }
    await this.rejectOverlapsAndDirty(op, repoRoot, snapshot, signal)
    const args = typeof options.onto === 'string' && options.onto !== ''
      ? ['rebase', '--onto', options.onto, options.upstream]
      : ['rebase', options.upstream]
    const result = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'rebase(git rebase)', signal: active(signal),
      // GIT_EDITOR=true：rebase 中途的编辑器拉起一律 no-op——挂起防护是正确性问题
      // （conflicts.ts operationContinue 同纪律；正常路径 git 不开编辑器，恒惰性）。
      env: { GIT_EDITOR: 'true' },
    })
    if (result.exitCode !== 0) await this.throwOpFailure(result, 'rebase', repoRoot, signal)
    const newOid = await this.readHead(repoRoot, op, signal)
    this.logger?.debug(`git ${op}: upstream=${options.upstream} onto=${options.onto ?? '(none)'} oldOid=${oldOid.slice(0, 12)} newOid=${newOid.slice(0, 12)} done=true`)
    // done 恒 true：冲突走错误路径，continue 由批次一 operationContinue 驱动（§4.2）。
    return { oldOid, newOid, done: true }
  }

  // ---------- 守卫与回读 ----------

  /**
   * 守卫链 1-3 + 7（branchMerge/rebase 共用；顺序 = 文件头）：acknowledged → fresh 扫描
   * → baseRevision 乐观并发 → 防御性 unborn 档。修订预检（4）与叠操作/脏区拒绝（5/6）
   * 由各方法在入参校验后调 requireRevision + rejectOverlapsAndDirty（方案的 ③ 在 ④⑤ 前）。
   */
  private async runGuards(
    op: string,
    acknowledged: boolean,
    baseRevision: string | null,
    signal?: AbortSignal,
  ): Promise<{ repoRoot: string; snapshot: GitStatusSnapshot; oldOid: string }> {
    // 守卫 1：C 级二次确认旗标（最先判，零命令执行）。
    if (acknowledged !== true) {
      throw gitError('git/bad-request', `git ${op} requires acknowledged=true (destructive confirmation gate)`, {
        reason: 'unacknowledged', paths: [], expected: null, actual: null,
      })
    }
    // 守卫 2：fresh status 扫描（绕 TTL 缓存——此刻的世界；error 三态就地抛出）。
    const state = await this.status.current(signal, { fresh: true })
    if (state.error !== null) throw state.error
    const snapshot = state.snapshot
    const repoRoot = snapshot.repoRoot
    this.logger?.debug(`git ${op}: fresh status scan (repoRoot resolved)`)
    // 守卫 3：baseRevision 乐观并发（客户端视角的 HEAD 未变才许执行）。
    if (baseRevision !== null && baseRevision !== snapshot.branch.oid) {
      throw gitError('git/bad-request', `stale base revision: request was made against ${baseRevision}, HEAD is now ${snapshot.branch.oid ?? '(unborn)'}`, {
        reason: 'stale-base-revision', paths: [], expected: baseRevision, actual: snapshot.branch.oid,
      })
    }
    const oldOid = snapshot.branch.oid
    if (oldOid === null) {
      // 守卫 7（防御性）：unborn HEAD 无提交可合并/变基（time-travel 防御兜底同款）。
      throw gitError('git/no-branch', `git ${op}: repository has no commits yet (unborn branch)`, { state: 'unborn' })
    }
    return { repoRoot, snapshot, oldOid }
  }

  /**
   * 守卫 5-6（各方法在 requireRevision 后调用）：中间态探测（批次一共享
   * detectOperation——拒绝叠操作，治愈路径 = abortOperation）→ 从严档脏区拒绝
   * （snapshot.clean 四组全空才过——git 允许部分脏合并，插件口径要求干净才可预测，
   * §4.9；守卫世界 = runGuards 的同一 fresh 快照，不二次扫描）。
   */
  private async rejectOverlapsAndDirty(
    op: string,
    repoRoot: string,
    snapshot: GitStatusSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    const inProgress = await detectOperation(repoRoot, this.gitRead, signal)
    if (inProgress !== null) {
      throw gitError('git/operation-in-progress', `git ${op}: ${inProgress} is in progress (CHERRY_PICK_HEAD/REVERT_HEAD/MERGE_HEAD present or a rebase is in progress); abort or resolve it first`, {
        op: inProgress,
      })
    }
    if (snapshot.clean !== true) {
      const pathCount = snapshot.staged.length + snapshot.unstaged.length
        + snapshot.untracked.length + snapshot.conflicted.length
      throw gitError('git/dirty-worktree', `git ${op}: worktree is not clean (${String(pathCount)} path(s)); the plugin requires a clean worktree for predictable merges/rebases (git itself allows partial-dirty merges — stash first)`, {
        branch: snapshot.branch.name,
        pathCount,
      })
    }
  }

  /**
   * 目标修订可解析预检（`rev-parse --verify --quiet <rev>^{commit}`；exit 1 ⇒
   * git/unknown-revision）。**剥 `^{commit}`**（评审收口）：annotated tag 名经裸
   * rev-parse 回 **tag 对象 oid**（git 2.55.0.windows.2 实测），而 ff merge 后 HEAD
   * 落在剥壳 commit——branchMerge 的 fastForward 比对面（newOid === 目标 oid）必须用
   * commit oid，否则经 tag 名的可 ff 合并恒误报 false；tree/blob 路径修订在此一并拒
   * （merge/rebase 目标必须是 commit）。
   */
  private async requireRevision(repoRoot: string, op: string, revision: string, signal?: AbortSignal): Promise<string> {
    const probed = await this.gitRead.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
      cwd: repoRoot, op: `${op}(rev-parse --verify ^{commit})`, signal: active(signal),
    })
    if (probed.exitCode !== 0) {
      throw gitError('git/unknown-revision', `git ${op}: revision '${revision}' could not be resolved`, {
        op, revision,
      })
    }
    const oid = probed.stdout.trim()
    if (oid === '') {
      // --verify 成功但输出为空是契约破坏——按域码兜底，不静默用空 oid。
      // stderr 先过 sanitizeStderr 再进 details（stderr 脱敏纪律——git-runner.ts 同款）。
      throw gitError('git/git-error', `git ${op}: empty rev-parse output for '${revision}'`, {
        op: `${op}(rev-parse --verify)`, exitCode: probed.exitCode, stderr: sanitizeStderr(probed.stderr), truncated: probed.truncated,
      })
    }
    return oid
  }

  /**
   * 未合并路径回读（`diff --name-only --diff-filter=U -z`）：**-z 口径**——NUL 分隔、
   * 路径原样字节不加引号（conflicts.ts scanUnmerged 的 porcelain v2 -z 同口径；
   * status-parser.ts「-z 下路径原样」纪律）。评审收口：原行分割口径在 core.quotepath
   * 缺省下会把非 ASCII 路径 C-引号化（中文/空格路径失真），且路径内嵌换行会被拆行。
   * 不 trim——`-z` 输出无填充，条目即路径本身（路径尾空格合法）。
   */
  private async conflictedPaths(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
    const listing = await this.gitRead.run(['diff', '--name-only', '--diff-filter=U', '-z'], {
      cwd: repoRoot, op: 'merge-rebase(diff --diff-filter=U -z)', signal: active(signal),
    })
    assertGitOk(listing, 'merge-rebase(diff --diff-filter=U -z)')
    return listing.stdout.split('\0').filter((entry) => entry !== '')
  }

  /**
   * merge/rebase 非零退出 → 域错误映射：输出含 CONFLICT ⇒ git/merge-conflict（conflicted
   * = diff-filter=U 回读；abortable = 共享 detectOperation 在场——冲突路径恒 true，
   * 防御性探测如实回值）；其余（--ff-only 不可 ff、空 rebase 等）⇒ git-error。
   */
  private async throwOpFailure(
    result: { exitCode: number | null; stdout: string; stderr: string; truncated: boolean },
    op: 'merge' | 'rebase',
    repoRoot: string,
    signal?: AbortSignal,
  ): Promise<never> {
    if (/CONFLICT/.test(result.stdout) || /CONFLICT/.test(result.stderr)) {
      const conflicted = await this.conflictedPaths(repoRoot, signal)
      const inProgress = await detectOperation(repoRoot, this.gitRead, signal)
      throw gitError('git/merge-conflict', `git ${op}: conflict; the repository is left in an intermediate state (abort or resolve it)`, {
        op,
        conflicted,
        abortable: inProgress !== null,
      })
    }
    throw gitRunError(op, result.exitCode, result.stderr, result.truncated)
  }

  /** 操作后 HEAD 回读（`rev-parse --verify HEAD`；merge/rebase 成功路径均不产生 unborn）。 */
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
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
