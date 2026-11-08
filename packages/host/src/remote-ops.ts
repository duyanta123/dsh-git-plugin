/*!
 * 对照（C 级语义学习，零代码搬运，PORTING.md 登记）：zai-org/ZCode
 *   packages/services/src/git/repo/gitCliRepo.ts:1641-1672（push 编排：tracking 判定 →
 *   remote 解析 → push → 成功后重读 status）、:674-702（resolvePushRemote：
 *   branch.<name>.remote → remote.pushDefault → origin → 唯一 remote → 报错）、
 *   :499-503（parseTrackingRemoteName：upstream 短名首段拆 remote）。
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-31（M6 remote-ops 模块）—— 语义对照自研实现，与 ZCode 的
 *   关键差异（均为 spec §1.5/§1.6 + workflow 任务口径）：
 *   1. 禁止裸 `git push`：一律显式 remote + 全量 refspec（spec §1.5-3 B3——本机实测
 *      push.default=matching 下裸 push 一次推全部分支，Tier C 动作静默扩权；ZCode
 *      的裸 push 形态不采纳）；ZCode 的 remote.pushDefault 段不在解析链（spec §1.5-1
 *      与任务口径均未列，见 ModuleResult.openIssues）。
 *   2026-11-08（v2 批次一，docs/v2-implementation-plan.md §3.2/§3.5）—— push 扩
 *   force/acknowledged/remote 三入参：force 双闸守卫（bad-request
 *   'force-unacknowledged' 零命令）+ force 跳过 diverged 预检（upstream 三态预检保留）
 *   + 显式 remote 直查存在性（requireRemote；不走缺省解析链）。
 *   2026-11-08（批次一独立评审 medium 修复）—— diverged 预检基线改 = 实际推送目标的
 *   remote-tracking 引用 `<remote>/<remoteBranch>`（原恒按分支配置 upstream 计数，推送
 *   对话框选定非 upstream 远端做非 force 推送时被旧 upstream 的分叉伪拒）；非显式路径
 *   按构造 ≡ upstream 行为不变；diverged details.upstream 随基线指向实际目标。
 *   2. 上游三态判定（无上游 / gone / 正常，任务口径）经 StatusEngine fresh 快照：
 *      porcelain v2 `# branch.upstream` 存在而 `# branch.ab` 缺失 = gone（本机
 *      git 2.55.0.windows.2 实测：gone 态 `rev-parse @{u}` exit 128——因此 **gone 态
 *      严禁 rev-list**，直接走 set-upstream 路径）；spec §1.5-1 的逐命令
 *      `rev-parse --abbrev-ref --symbolic-full-name @{u}` 形态未采用，语义等价性
 *      见文件内注释与 ModuleResult.openIssues。
 *   3. stderr 脱敏分类器四类（authentication / network / push-rejected / diverged，
 *      任务口径）：先 sanitizeStderr（error-codes.ts 的脱敏正则）再分类，分类器导出
 *      供夹具单测；push-rejected 簇含 `[remote rejected]`（本机实测 pre-receive 拒绝
 *      的 stderr 不含字面 `[rejected]`，spec §1.0.5 关键词簇漏该形态——M6 用例补齐）。
 *      2026-11-07：簇正则单一事实源收敛至 error-codes.ts（STDERR_PATTERNS，原
 *      REMOTE_STDERR_PATTERNS 移除），本模块 classifyRemoteStderr 仅做词汇映射消费。
 * SPDX-License-Identifier: MIT
 */

/**
 * dsh-gitkit — 远端同步引擎（spec §1.5 push / §1.6 pull·fetch；[清单 25/26/67]；
 * 权限 push/pull C、fetch B）。执行一律走 network runner 实例（WRITE_PREFIX +
 * networkTimeoutMs，spec §1.0.2/§1.9）；守卫与预检走 readonly runner + StatusEngine
 * fresh 扫描（绕 TTL 缓存——Tier C 动作用此刻的世界，MutationEngine 同款纪律）。
 *
 * 上游三态（任务口径 ①）——由 fresh 快照的 porcelain v2 branch 头推导：
 *   - no-upstream：`# branch.upstream` 缺失（branch.<name>.remote/merge 未配置）；
 *   - gone：`# branch.upstream` 存在而 `# branch.ab` 缺失（upstream 配置在、
 *     远端跟踪引用不在——远端分支被删后 fetch --prune 的世界。本机实测：此态
 *     `@{u}` 类解析 exit 128，故 **gone 态严禁 rev-list**）；
 *   - normal：两者都在（branch.ab +A -B）。
 *   三态的 push/pull 分派：
 *   - push：no-upstream/gone → set-upstream 路径（setUpstream=false ⇒ git/no-upstream
 *     引导——gone 复用同码同 hint，client 的「设置 upstream 并推送」动作即治愈路径）；
 *     normal → `rev-list --left-right --count <upstream>...HEAD` diverged 前置检测
 *     （输出 behind<TAB>ahead，本机实测列序——左=upstream=behind）。
 *   - pull：no-upstream/gone ⇒ git/no-upstream（gone 的治愈是 fetch 重建跟踪引用，
 *     而非 pull）；normal → diverged 预检 ⇒ git/pull-diverged → `git pull --ff-only
 *     --no-rebase`（--no-rebase 钉死 merge 语义：runner env 只 tombstone ambient
 *     GIT_*，不隔离用户 ~/.gitconfig 的 pull.rebase=true，裸 --ff-only 会被 rebase
 *     改写历史）。运行期 ff 拒绝（"Not possible to fast-forward"，本机实测 exit 128）
 *     重跑一次 rev-list 取真实 ahead/behind 后落 git/pull-diverged——normal 态才走到
 *     运行期，rev-list 合法；重读失败回落 git-error 兜底。
 *
 * remote 解析链（任务口径 ②③；fetch 显式入参优先）：
 *   显式 remote → branch.<name>.remote（gone 态也读——fetch 正是重建跟踪引用的
 *   治愈操作）→ origin（存在即默认）→ 恰一个 remote → 零个 ⇒ git/no-remote →
 *   多个 ⇒ git/choose-remote { remotes }（任务口径 ③；spec §1.5-1 同场景落
 *   git/no-remote——details 同形，deviation 记 ModuleResult.openIssues）。
 *   分支 remote 为 '.'（upstream 指向本仓库内分支）对 fetch 无意义，跳过进链。
 *
 * push 的 remote/远端分支名：normal 路径取 branch.<name>.remote + branch.<name>.merge
 * （剥 refs/heads/ 前缀——权威面；upstream 短名首段拆分为回落，remote 名含 '/' 的
 * 仓库短名拆分会错，ZCode parseTrackingRemoteName 语义仅作回落）；set-upstream 路径
 * 的两侧都用本地分支名（此时无 upstream 可拆，spec §1.5-3）。
 */

import { assertGitOk, classifyStderr, gitError, gitRunError, sanitizeStderr } from './error-codes.ts'
import type { GitStderrClass } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { GitRunResult } from './git-runner.ts'
import type { StatusEngine } from './status.ts'
import type { FetchResult, GitStatusSnapshot, PullResult, PushResult } from './types.ts'
import type { FetchOptions, PushOptions } from './types.ts'

// ---------- stderr 脱敏分类器（任务口径 ①：四类，导出供夹具单测） ----------

/** 远端同步命令的 stderr 关键词类别（undefined = 分类器不认识，git-error 兜底）。 */
export type RemoteStderrClass = 'authentication' | 'network' | 'push-rejected' | 'diverged' | undefined

/**
 * 单一分类器 kind（error-codes.ts 词汇）→ 远端同步词汇：auth-failed → authentication、
 * pull-diverged → diverged；push-rejected / network 同词汇直通。
 */
function toRemoteStderrKind(kind: Exclude<GitStderrClass, undefined>): Exclude<RemoteStderrClass, undefined> {
  switch (kind) {
    case 'auth-failed': return 'authentication'
    case 'pull-diverged': return 'diverged'
    default: return kind
  }
}

/**
 * 对**已脱敏**的 stderr 分类（调用方先过 sanitizeStderr——任务口径 ②「stderr 先
 * 脱敏再分类」）。簇正则单一事实源在 error-codes.ts（STDERR_PATTERNS：/i +
 * `[remote rejected]` + network 簇，M6 实测修订；原 REMOTE_STDERR_PATTERNS 与
 * error-codes 弱版 classifyStderr 事实分叉，已收敛删除），本函数只做词汇映射，
 * 顺序语义（认证最先、rejected 先于 diverged）由该表保证。导出供夹具单测。
 */
export function classifyRemoteStderr(stderr: string): RemoteStderrClass {
  const kind = classifyStderr(stderr)
  return kind === undefined ? undefined : toRemoteStderrKind(kind)
}

/** 拒绝原因提取：`! [remote rejected] main -> main (pre-receive hook declined)` → 括号体。 */
export function rejectionReason(stderr: string): string {
  const match = /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/.exec(stderr)
  return match?.[1] ?? 'rejected'
}

// ---------- 上游三态 ----------

/** 上游三态（任务口径 ①）。 */
export type UpstreamState = 'no-upstream' | 'gone' | 'normal'

/**
 * 由 porcelain v2 branch 头推导三态（依据见文件头注释；本机 git 2.55.0.windows.2
 * 实测：gone 态 `# branch.upstream` 在而 `# branch.ab` 不在）。
 * v1 回退解析器（cline 范本段）把 `[gone]` 剥成 upstream=null——彼态退化为
 * no-upstream，同样走 set-upstream 路径，行为收敛（老 git 的差异记 openIssues）。
 */
export function upstreamStateOf(branch: GitStatusSnapshot['branch']): UpstreamState {
  if (branch.upstream === null) return 'no-upstream'
  if (branch.ahead === null || branch.behind === null) return 'gone'
  return 'normal'
}

/** remote-ops 引擎构造项。 */
export interface RemoteOpsEngineOptions {
  /** 预留 logger 诊断位（写日志由服务面打，MutationEngine 同款）。 */
  logger?: { debug(message: string): void }
}

export class RemoteOpsEngine {
  private readonly logger: RemoteOpsEngineOptions['logger']

  constructor(
    /** network 实例（WRITE_PREFIX + networkTimeoutMs——push/pull/fetch 执行）。 */
    private readonly gitNetwork: GitRunner,
    /** 只读实例（config --get / git remote / rev-list 预检 / rev-parse 回读）。 */
    private readonly gitRead: GitRunner,
    /** 最新世界读取（fresh 扫描：三态 / 脏区 / repoRoot）。 */
    private readonly status: StatusEngine,
    options: RemoteOpsEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  // ---------- push ----------

  /**
   * push（spec §1.5；权限 C）：force 双闸守卫（v2 批次一 [清单 27]）→ detached/unborn
   * 拒绝 → 上游三态 →（normal 且非 force：diverged 预检）→ 显式 remote + 全量 refspec
   * 执行 → stderr 脱敏分类。
   *
   * v2 批次一扩展（docs/v2-implementation-plan.md §3.2/§3.5）：
   *   - `force=true && acknowledged!==true` ⇒ git/bad-request 'force-unacknowledged'，
   *     **零命令执行**（discard acknowledged 守卫同款纪律）；
   *   - force=true 跳过 diverged 预检（语义即覆盖远端，README §5 注记），upstream
   *     存在性预检（三态判定）保留；
   *   - 显式 `options.remote`：直查该 remote 存在性（不存在 ⇒ git/no-remote，
   *     details.remotes 带全量清单），**不走** origin/唯一 remote 解析链——推送对话框
   *     选定目标后 host 直查（§3.10：预检顺序写死，避免与 git/choose-remote 双轨报错）；
   *     diverged 预检基线同步切到该远端的目标分支跟踪引用 `<remote>/<remoteBranch>`
   *     （与旧 upstream 的分叉不影响推往别的远端；该引用不存在 = 不预检，非 ff 拒绝
   *     由运行期 stderr 分类落 git/push-rejected）。
   * @throws git/bad-request 'force-unacknowledged'、git/no-branch、git/no-upstream、
   *   git/no-remote、git/choose-remote、git/diverged、git/push-rejected、git/auth-failed、
   *   git/session-workspace-unresolved、git/no-repository（fresh 扫描顺带发现）、
   *   git/timeout、git/git-error。
   */
  async push(options: PushOptions, signal?: AbortSignal): Promise<PushResult> {
    // 守卫 0（v2 批次一）：force 的 C 级二次确认旗标——最先判，零命令执行。
    if (options.force === true && options.acknowledged !== true) {
      throw gitError('git/bad-request', 'git push: force push requires acknowledged=true (destructive confirmation gate; force overwrites the remote)', {
        reason: 'force-unacknowledged', paths: [], expected: null, actual: null,
      })
    }
    const { repoRoot, snapshot } = await this.scanFresh('push', signal)
    const branch = this.requireBranch(snapshot)
    const state = upstreamStateOf(snapshot.branch)
    this.logger?.debug(`git push: upstream state=${state} upstream=${String(snapshot.branch.upstream)}`)

    // 显式 remote（v2 批次一 [清单 57]）：非空字符串 = 直查存在性，不走缺省解析链。
    const explicitRemote = typeof options.remote === 'string' && options.remote !== '' ? options.remote : null
    if (explicitRemote !== null) {
      await this.requireRemote(repoRoot, branch, explicitRemote, 'push', signal)
    }

    if (state !== 'normal') {
      // 无上游 / gone → set-upstream 路径（任务口径 ①）；未确认 ⇒ no-upstream 引导
      // （首次推送目标属 Tier C 决策，不静默自动 set-upstream——spec §1.5-1）。
      if (options.setUpstream !== true) {
        throw gitError('git/no-upstream', `git push: branch ${branch} has ${state === 'gone' ? 'a gone upstream (remote-tracking ref missing)' : 'no upstream'}`, {
          branch,
          hint: 'set-upstream',
        })
      }
      const remote = explicitRemote
        ?? (await this.branchRemote(repoRoot, branch, signal))
        ?? (await this.resolveDefaultRemote(repoRoot, branch, 'push', signal))
      const refspec = `refs/heads/${branch}:refs/heads/${branch}`
      const result = await this.gitNetwork.run(
        ['push', ...(options.force === true ? ['--force'] : []), '--set-upstream', remote, refspec],
        { cwd: repoRoot, op: 'push(set-upstream)', signal: active(signal) },
      )
      if (result.exitCode !== 0) this.throwPushFailure(result, remote, branch, 'push(set-upstream)')
      return { remote, branch, upstream: `${remote}/${branch}`, setUpstreamUsed: true }
    }

    // normal：diverged 前置检测（spec §1.5-2 [清单 67]）；force=true 跳过（语义即覆盖
    // 远端——v2 批次一 [清单 27]，upstream 存在性预检已由三态判定承担）。
    // v2 批次一评审修复（medium）：预检基线 = **实际推送目标**的 remote-tracking 引用
    // `<remote>/<remoteBranch>`，而非分支配置的 upstream——推送对话框（[57]）选定非
    // upstream 远端做非 force 推送时，与旧 upstream 的分叉与本次推送无关（旧行为会伪拒
    // 且 diverged 文案指向用户未选的远端）。目标解析与执行段同口径：remote = 显式入参 →
    // branch.<name>.remote（normal 态必非空——porcelain upstream 即由它派生）→ upstream
    // 短名拆分回落；remoteBranch = branch.<name>.merge 剥 refs/heads/ → 显式入参时本地
    // 分支名（upstream 前缀不属于该远端，切片会得垃圾）→ upstream 去前缀回落。非显式
    // 路径下 `<remote>/<remoteBranch>` 按构造 ≡ upstream（行为不变）；显式远端无该分支的
    // tracking 引用（从未 fetch）⇒ revListCounts null ⇒ 不预检（非 ff 拒绝由运行期
    // stderr 分类落 git/push-rejected，与 v1 口径一致）。
    const upstream = snapshot.branch.upstream as string
    const remote = explicitRemote ?? (await this.branchRemote(repoRoot, branch, signal)) ?? splitFirst(upstream, '/')
    const merge = await this.configGet(repoRoot, `branch.${branch}.merge`, signal)
    const remoteBranch = merge !== null && merge.startsWith('refs/heads/')
      ? merge.slice('refs/heads/'.length)
      : (explicitRemote !== null ? branch : (upstream.slice(remote.length + 1) || branch))
    if (options.force !== true) {
      const counts = await this.revListCounts(repoRoot, `${remote}/${remoteBranch}`, 'push', signal)
      if (counts !== null && counts.ahead > 0 && counts.behind > 0) {
        throw gitError('git/diverged', `git push: local and remote have diverged (ahead ${counts.ahead}, behind ${counts.behind})`, {
          branch,
          upstream: `${remote}/${remoteBranch}`,
          ahead: counts.ahead,
          behind: counts.behind,
        })
      }
    }

    // 执行：显式 remote + 全量 refspec（spec §1.5-3 B3；remote/远端分支名取 config
    // 权威面，upstream 短名拆分回落——不用本地分支名，防本地名 ≠ 上游名推错目标）。
    const refspec = `refs/heads/${remoteBranch}:refs/heads/${remoteBranch}`
    const result = await this.gitNetwork.run(
      ['push', ...(options.force === true ? ['--force'] : []), remote, refspec],
      { cwd: repoRoot, op: 'push', signal: active(signal) },
    )
    if (result.exitCode !== 0) this.throwPushFailure(result, remote, branch, 'push')
    return { remote, branch, upstream: `${remote}/${remoteBranch}`, setUpstreamUsed: false }
  }

  /** push 非零退出 → 脱敏分类映射（任务口径 ①；push 上下文的 diverged 类归 push-rejected）。 */
  private throwPushFailure(
    result: GitRunResult,
    remote: string,
    branch: string,
    op: string,
  ): never {
    const clean = sanitizeStderr(result.stderr)
    switch (classifyRemoteStderr(clean)) {
      case 'authentication':
        throw gitError('git/auth-failed', `git ${op}: authentication failed; stderr redacted/tail kept`, { stderr: clean })
      case 'push-rejected':
      case 'diverged':
        throw gitError('git/push-rejected', `git ${op}: rejected by remote (${rejectionReason(clean)})`, {
          remote,
          branch,
          reason: rejectionReason(clean),
          stderr: clean,
        })
      default:
        throw remoteOpFallback(op, result, clean)
    }
  }

  // ---------- pull ----------

  /**
   * pull --ff-only（spec §1.6；权限 C）：detached/unborn 拒绝 → 脏区拒绝（任务口径
   * git/dirty-worktree，含 untracked 的保守口径）→ 上游三态（no-upstream/gone ⇒
   * git/no-upstream，gone 态不跑 rev-list 也不跑 pull）→ diverged 预检 ⇒
   * git/pull-diverged → `git pull --ff-only --no-rebase`。
   * @throws git/no-branch、git/dirty-worktree、git/no-upstream、git/pull-diverged、
   *   git/auth-failed、git/session-workspace-unresolved、git/no-repository、
   *   git/timeout、git/git-error。
   */
  async pull(signal?: AbortSignal): Promise<PullResult> {
    const { repoRoot, snapshot } = await this.scanFresh('pull', signal)
    const branch = this.requireBranch(snapshot)

    // 脏区拒绝（任务口径 ②）：快照非 clean 即拒（staged/unstaged/untracked/conflicted
    // 去重合计；ff 更新会写工作区文件，脏区下失败形态不可读——前置拒绝零副作用）。
    if (!snapshot.clean) {
      const paths = new Set<string>()
      for (const change of [...snapshot.staged, ...snapshot.unstaged, ...snapshot.untracked, ...snapshot.conflicted]) {
        paths.add(change.path)
      }
      throw gitError('git/dirty-worktree', `git pull: working tree is dirty (${paths.size} path(s)); commit or stage first`, {
        branch,
        pathCount: paths.size,
      })
    }

    const state = upstreamStateOf(snapshot.branch)
    if (state !== 'normal') {
      // gone 的治愈路径是 fetch（重建跟踪引用）而非 pull——复用 no-upstream 引导。
      throw gitError('git/no-upstream', `git pull: branch ${branch} has ${state === 'gone' ? 'a gone upstream (remote-tracking ref missing)' : 'no upstream'}`, {
        branch,
        hint: 'set-upstream',
      })
    }
    const upstream = snapshot.branch.upstream as string

    // diverged 预检（spec §1.6 同 §1.5-2；分叉 ⇒ git/pull-diverged）。
    const counts = await this.revListCounts(repoRoot, upstream, 'pull', signal)
    if (counts !== null && counts.ahead > 0 && counts.behind > 0) {
      throw gitError('git/pull-diverged', `git pull: local and remote have diverged (ahead ${counts.ahead}, behind ${counts.behind})`, {
        branch,
        upstream,
        ahead: counts.ahead,
        behind: counts.behind,
      })
    }

    const oldOid = snapshot.branch.oid
    if (oldOid === null) {
      // born 分支必有 oid（porcelain branch.oid）；防御性兜底按 unborn 拒绝。
      throw gitError('git/no-branch', 'git pull: HEAD has no commit', { state: 'unborn' })
    }
    const remote = (await this.branchRemote(repoRoot, branch, signal)) ?? splitFirst(upstream, '/')

    // --no-rebase 钉死 merge 语义（runner 不隔离用户 ~/.gitconfig 的 pull.rebase，
    // 裸 --ff-only 会被 rebase 改写历史——spec §1.6 只做 ff 的安全细化）。
    const result = await this.gitNetwork.run(
      ['pull', '--ff-only', '--no-rebase'],
      { cwd: repoRoot, op: 'pull', signal: active(signal) },
    )
    if (result.exitCode !== 0) await this.throwPullFailure(result, repoRoot, branch, upstream, signal)

    const head = await this.gitRead.run(['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot, op: 'pull(rev-parse --verify HEAD)', signal: active(signal),
    })
    assertGitOk(head, 'pull(rev-parse --verify HEAD)')
    return { fastForwarded: true, oldOid, newOid: head.stdout.trim(), remote }
  }

  /** pull 非零退出 → 脱敏分类映射；ff 拒绝重跑 rev-list 取真实 ahead/behind。 */
  private async throwPullFailure(
    result: GitRunResult,
    repoRoot: string,
    branch: string,
    upstream: string,
    signal?: AbortSignal,
  ): Promise<never> {
    const clean = sanitizeStderr(result.stderr)
    switch (classifyRemoteStderr(clean)) {
      case 'authentication':
        throw gitError('git/auth-failed', 'git pull: authentication failed; stderr redacted/tail kept', { stderr: clean })
      case 'diverged':
      case 'push-rejected': {
        // 运行期拒绝（normal 态才走到这，rev-list 合法）：pull 的 fetch 已刷新跟踪
        // 引用，重读给真实计数；读不到（再次失败的边缘）回落 git-error。
        const counts = await this.revListCounts(repoRoot, upstream, 'pull(health-check)', signal)
        if (counts !== null) {
          throw gitError('git/pull-diverged', `git pull: fast-forward refused (ahead ${counts.ahead}, behind ${counts.behind})`, {
            branch, upstream, ahead: counts.ahead, behind: counts.behind,
          })
        }
        throw remoteOpFallback('pull', result, clean)
      }
      default:
        throw remoteOpFallback('pull', result, clean)
    }
  }

  // ---------- fetch ----------

  /**
   * fetch（spec §1.6；权限 B）：remote 解析链（显式入参 → 上游 remote（gone 也读）→
   * origin → 唯一 → no-remote/choose-remote）→ `git fetch --prune <remote>`；
   * detached/unborn 合法（fetch 不依赖当前分支）。
   * @throws git/no-remote、git/choose-remote、git/auth-failed、
   *   git/session-workspace-unresolved、git/no-repository、git/timeout、git/git-error。
   */
  async fetch(options: FetchOptions, signal?: AbortSignal): Promise<FetchResult> {
    const { repoRoot, snapshot } = await this.scanFresh('fetch', signal)
    const branch = snapshot.branch.detached || snapshot.branch.unborn ? null : snapshot.branch.name

    let remote = typeof options.remote === 'string' && options.remote !== '' ? options.remote : null
    if (remote === null && branch !== null) {
      // 上游 remote（gone 态也读——fetch 正是重建跟踪引用的治愈操作；'.' 无意义跳过）。
      const configured = await this.branchRemote(repoRoot, branch, signal)
      if (configured !== null && configured !== '.') remote = configured
    }
    if (remote === null) {
      remote = await this.resolveDefaultRemote(repoRoot, branch, 'fetch', signal)
    }

    const result = await this.gitNetwork.run(
      ['fetch', '--prune', remote],
      { cwd: repoRoot, op: 'fetch', signal: active(signal) },
    )
    if (result.exitCode !== 0) {
      const clean = sanitizeStderr(result.stderr)
      if (classifyRemoteStderr(clean) === 'authentication') {
        throw gitError('git/auth-failed', 'git fetch: authentication failed; stderr redacted/tail kept', { stderr: clean })
      }
      throw remoteOpFallback('fetch', result, clean)
    }
    // prune 命中判定：`- [deleted] (none) -> origin/x` 行（stdout/stderr 都扫）。
    const pruned = /\[deleted\]/.test(result.stdout) || /\[deleted\]/.test(result.stderr)
    return { remote, pruned }
  }

  // ---------- 守卫与解析助手 ----------

  /** detached/unborn 拒绝（任务口径 ①；git/no-branch 是新域码，注册见 error-codes.ts）。 */
  private requireBranch(snapshot: GitStatusSnapshot): string {
    if (snapshot.branch.unborn) {
      throw gitError('git/no-branch', 'git: repository has no commits yet (unborn branch)', { state: 'unborn' })
    }
    if (snapshot.branch.detached || snapshot.branch.name === null || snapshot.branch.name === '') {
      throw gitError('git/no-branch', 'git: HEAD is detached (no current branch)', { state: 'detached' })
    }
    return snapshot.branch.name
  }

  /** diverged 预检的 rev-list 计数（`<upstream>...HEAD` → behind<TAB>ahead，本机实测列序）。 */
  private async revListCounts(
    repoRoot: string,
    upstream: string,
    op: string,
    signal?: AbortSignal,
  ): Promise<{ ahead: number; behind: number } | null> {
    const result = await this.gitRead.run(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], {
      cwd: repoRoot, op: `${op}(rev-list --left-right --count)`, signal: active(signal),
    })
    if (result.exitCode !== 0) return null
    const [left, right] = result.stdout.trim().split(/\s+/)
    const behind = Number(left)
    const ahead = Number(right)
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null
    return { ahead, behind }
  }

  /** `branch.<name>.remote`（exit 1 / 空值 ⇒ null，调用方进解析链）；坏命令面 git-error。 */
  private async branchRemote(repoRoot: string, branch: string, signal?: AbortSignal): Promise<string | null> {
    return this.configGet(repoRoot, `branch.${branch}.remote`, signal)
  }

  /**
   * 显式 remote 的存在性直查（v2 批次一 [清单 57]；push 专用——fetch 的显式入参保持
   * v1「不做存在性预检，错误如实映射」口径，sync.spec 既有用例钉住）：不存在 ⇒
   * git/no-remote { branch, remotes: 全量清单 }（推送对话框选定目标后 host 直查，
   * §3.10 预检顺序写死——不再进多 remote 分叉）。
   */
  private async requireRemote(
    repoRoot: string,
    branch: string,
    remote: string,
    op: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const listing = await this.gitRead.run(['remote'], {
      cwd: repoRoot, op: `${op}(git remote)`, signal: active(signal),
    })
    assertGitOk(listing, `${op}(git remote)`)
    const remotes = listing.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    if (!remotes.includes(remote)) {
      throw gitError('git/no-remote', `git ${op}: remote '${remote}' does not exist`, { branch, remotes })
    }
  }

  /**
   * 无显式 upstream remote 时的解析链（任务口径 ②③）：origin（存在即默认）→
   * 恰一个 → 零个 ⇒ git/no-remote → 多个 ⇒ git/choose-remote { remotes }。
   */
  private async resolveDefaultRemote(
    repoRoot: string,
    branch: string | null,
    op: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const listing = await this.gitRead.run(['remote'], {
      cwd: repoRoot, op: `${op}(git remote)`, signal: active(signal),
    })
    assertGitOk(listing, `${op}(git remote)`)
    const remotes = listing.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    if (remotes.includes('origin')) return 'origin'
    if (remotes.length === 1) return remotes[0] as string
    if (remotes.length === 0) {
      throw gitError('git/no-remote', `git ${op}: no remote configured`, { branch, remotes: [] })
    }
    throw gitError('git/choose-remote', `git ${op}: multiple remotes and none is the default (${remotes.join(', ')})`, { remotes })
  }

  /** 单键 `git config --get`（exit 0+非空 ⇒ 值；exit 1 / 空值 ⇒ null；其余 git-error）。 */
  private async configGet(repoRoot: string, key: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.gitRead.run(['config', '--get', key], {
      cwd: repoRoot, op: `config --get ${key}`, signal: active(signal),
    })
    if (result.exitCode === 0) {
      const value = result.stdout.trim()
      return value === '' ? null : value
    }
    if (result.exitCode === 1) return null
    throw gitRunError(`config --get ${key}`, result.exitCode, result.stderr, result.truncated)
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

/** network/未知类的兜底域错误（git-error；message 带分类注记）。 */
function remoteOpFallback(op: string, result: GitRunResult, clean: string): never {
  const kind = classifyRemoteStderr(clean)
  const note = kind === 'network' ? ' (network)' : ''
  throw gitError('git/git-error', `git ${op} failed${note} (exit ${String(result.exitCode)})`, {
    op,
    exitCode: result.exitCode,
    stderr: clean,
    truncated: result.truncated,
  })
}

/** 首个分隔符前的段（upstream 短名拆 remote 的回落语义，ZCode parseTrackingRemoteName 对照）。 */
function splitFirst(value: string, separator: string): string {
  const index = value.indexOf(separator)
  return index === -1 ? value : value.slice(0, index)
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
