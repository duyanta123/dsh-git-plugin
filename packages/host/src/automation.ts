/**
 * dsh-gitkit — 自动化引擎（v3 批次五 [清单 42/43]；docs/v3-implementation-plan.md §7.3）。
 *
 * 职责（会话锚定 = DA=C：session-start 开分支 + turn-end 提交——「每任务一分支、
 * 每回合一提交」的最小组合）：
 *   - **auto-commit [42]**（Config autoCommitMode='turn-end'）：`turn/end`
 *     （reason.kind==='completed'——aborted/blocked/error/max-tokens/interrupted/forked
 *     不触发，§7.6 测试项）→ 会话资格（workspace.ts eligibleSessionCwd——子代理/
 *     被委托/无 cwd 不参与）→ workspace 已解析 → fresh status 非干净 ⇒ `git add -A`
 *     → scanStagedContents（**secret 命中 ⇒ `git reset` 全撤销 + audit，不豁免不重试
 *     ——DD=A，对齐 V2 D5/commit.ts 守卫 3.6 硬阻断语义**）→ commit 引擎落提交
 *     （消息 = 模板插值 `{turn}` 或 message-gen AI 路由（autoCommitMessage='ai'；
 *     未解析/失败 ⇒ 回落模板），trailer 追加 `Auto-committed-by: dsh-git-plugin`）；
 *     hook 失败 = 放弃本次并 audit（不重试不改写）；identity-missing ⇒ 跳过 + audit。
 *   - **auto-branch [43]**（Config autoBranchMode='session-start'）：`turn/start`
 *     （per-session 判重——GitSessionFace.id 投影，workspace.ts:55 批次四成果）→
 *     fresh status：当前分支 ∈ autoBranchProtected + **clean** ⇒ refsAdmin.branchCreate
 *     ({name: prefix+短id, checkout: true})（refs-admin 复用；branch-exists ⇒ 序号
 *     后缀递增 `-2`/`-3`/… 消费 refs-admin 的预检域码——遗留同名分支不阻塞建切）；
 *     非 clean/非受保护（任务分支本身不在受保护表——「已在任务分支不再建」由受保护
 *     检查 + 判重共同承载）⇒ 跳过（不阻塞会话、不报错）+ log。
 *   - **并发纪律**（§7.3）：自动化执行前 fresh status + detectOperation 双检（批次一
 *     conflicts.ts 共享探测——merge/rebase/cherry-pick/revert 中间态在场即跳过）；
 *     全局单飞（in-flight 旗标，status 引擎先例——同时至多一个自动化动作，后到触发
 *     跳过并登记）。自动化**永不向 UI 报错**（§7.4 零新码——无事件通道，域码无处
 *     着陆）：结果经 auditLog + automationStatus 双可查；引擎内任何意外（含
 *     detectOperation/scanStaged 的域错误）收敛为「跳过 + audit + lastActions」，
 *     绝不抛向事件总线（observe 的 fire-and-forget 链自带 catch 双保险）。
 *
 * 触发面 = 构造期 `ctx.on('session/event')`（workspace.ts WorkspaceResolver / 批次四
 * session-watch.ts 同款先例——监听随宿主 fiber 清理，不进 static inject）；
 * `session/disposed` 清该会话的判重记忆。mode='off' 时监听在但 observe 零动作零登记
 * （§7.6「off 全程零动作」的引擎口径）。
 *
 * 判重语义：auto-branch 的 per-session 记忆在「结构性决策」时保留（成功建切 / 非受
 * 保护分支——该会话不再试）；「瞬时性失败」时撤销（脏区 / 中间态 / status 不可用 /
 * 建切命令失败 / 单飞跳过——下回合 turn/start 重试一次机会）。
 *
 * 审计纪律（§1-SOP(b) + audit.ts §6.5 双出口）：auto-commit/auto-branch 是写动作，
 * 成功出口 ok:true + 白名单摘要（turn/branch/oid——不落 message 正文/文件内容），
 * 失败出口 ok:false + 域码 + 空摘要。
 */

import { assertGitOk, errorCodeOf, sanitizeStderr } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import { signalOf } from './git-runner.ts'
import { detectOperation } from './conflicts.ts'
import { reasonKindOf, turnOf } from './shared.ts'
import { DEFAULT_GUARD_LARGE_FILE_BYTES, hardBlockViolations, scanStagedContents } from './guard-scan.ts'
import type { GuardScanOptions } from './guard-scan.ts'
import type { AuditEngine } from './audit.ts'
import type { CommitEngine } from './commit.ts'
import type { MessageGenEngine } from './message-gen.ts'
import type { RefsAdminEngine } from './refs-admin.ts'
import type { StatusEngine } from './status.ts'
import { eligibleSessionCwd } from './workspace.ts'
import type { GitSessionEventFace, GitSessionFace } from './workspace.ts'
import type { SessionWatchHost } from './session-watch.ts'
import type { AutomationActionEntry, AutomationActionKind, AutomationStatusResult } from './types.ts'

/** automationStatus.lastActions 环容量（plan §7.3：环 20 条）。 */
export const AUTOMATION_STATUS_RING = 20

/** autoCommitTemplate 缺省（plan §7.2）。 */
export const DEFAULT_AUTO_COMMIT_TEMPLATE = 'chore: auto-commit session changes (turn {turn})'

/** 自动提交署名 trailer（plan §7.3；CommitEngine 的 TRAILER_RE 形态校验合规——`Key: value`）。 */
export const AUTO_COMMIT_TRAILER = 'Auto-committed-by: dsh-git-plugin'

/** autoBranchPrefix 缺省（plan §7.2）。 */
export const DEFAULT_AUTO_BRANCH_PREFIX = 'dsh/task-'

/** autoBranchProtected 缺省（plan §7.2）。 */
export const DEFAULT_AUTO_BRANCH_PROTECTED: readonly string[] = Object.freeze(['main', 'master'])

/** branch-exists 序号后缀递增上限（防病态同名耗尽；到顶 = 放弃并登记）。 */
export const AUTO_BRANCH_SUFFIX_MAX = 50

/** per-session 判重记忆容量（防长寿宿主下的无界 Map；超出逐出最旧——FIFO）。 */
export const AUTO_BRANCH_SEEN_MAX = 512

/** 自动化引擎构造项（deps = 引擎依赖束；options = Config 六键投影 + logger）。 */
export interface AutomationEngineDeps {
  /** write 实例（`git add -A` / `git reset`——WRITE_PREFIX + fastTimeoutMs）。 */
  gitWrite: GitRunner
  /** 只读实例（detectOperation 伪引用探测——conflicts.ts 同款）。 */
  gitRead: GitRunner
  /** status 引擎（并发纪律的 fresh status 双检半）。 */
  status: StatusEngine
  /** 工作区解析（repoRoot 发现）。 */
  workspace: WorkspaceResolverLike
  /** commit 引擎（守卫链 + `-F -` stdin + hook 分类 + 回读——消息/trailer 在此落地）。 */
  commit: CommitEngine
  /** refs 管理引擎（auto-branch 的 branchCreate 复用——预检/建/切/回读一体）。 */
  refsAdmin: RefsAdminEngine
  /** AI 提交信息引擎（autoCommitMessage='ai' 的路由半；undefined = 面缺席恒回落模板）。 */
  messageGen?: MessageGenEngine | undefined
  /** 写操作审计环（v2 批次四 AuditEngine——自动化动作的双出口入环）。 */
  audit: AuditEngine
  /** 护栏三键（scanStagedContents 的扫描参数——index.ts 与 CommitEngine/GuardScanEngine 共用的同一份归一 guardOptions）。 */
  guard?: Pick<GuardScanOptions, 'largeFileBytes' | 'buildPatterns' | 'secretPatterns'>
  /** 写后失效回调（index.ts afterWrite——status 缓存作废 + R3 帧；自动化成功建/切/提交后触发）。 */
  onWrite?: () => void
}

/** 工作区解析的最小结构面（真实现 = WorkspaceResolver；测试可注入窄替身）。 */
export interface WorkspaceResolverLike {
  resolve(): Promise<{ root: string; source: string }>
}

/** AutomationEngine 的 Config 投影（index.ts 六键；缺席/非法回落默认——构造期定值）。 */
export interface AutomationEngineOptions {
  autoCommitMode?: 'off' | 'turn-end'
  autoCommitMessage?: 'ai' | 'template'
  autoCommitTemplate?: string
  autoBranchMode?: 'off' | 'session-start'
  autoBranchPrefix?: string
  autoBranchProtected?: readonly string[]
  logger?: GitLoggerFace | undefined
}

/**
 * 自动化引擎：会话事件驱动的 auto-commit / auto-branch（构造期挂监听；测试可直喂
 * {@link observe}——SessionWatch/WorkspaceResolver 先例）。
 */
export class AutomationEngine {
  // —— Config 投影（构造期定值；非 volatile 改动经 fiber 重载生效）——
  private readonly autoCommitMode: 'off' | 'turn-end'
  private readonly autoCommitMessage: 'ai' | 'template'
  private readonly autoCommitTemplate: string
  private readonly autoBranchMode: 'off' | 'session-start'
  private readonly autoBranchPrefix: string
  private readonly autoBranchProtected: readonly string[]
  private readonly logger: GitLoggerFace | undefined

  /** automationStatus.lastActions 环（append + 头部逐出；status() 投影 newest-first）。 */
  private readonly ring: AutomationActionEntry[] = []
  /** auto-branch 判重记忆（sessionId → true；结构性决策保留、瞬时失败撤销）。 */
  private readonly seen = new Map<string, true>()
  /** 全局单飞旗标（同时至多一个自动化动作——§7.9 in-flight dedupe，status 引擎先例）。 */
  private busy = false
  /** 最近一次调度的动作 Promise（settleOf 的等待半；null = 尚无调度）。 */
  private lastRun: Promise<void> | null = null

  constructor(
    deps: AutomationEngineDeps,
    /** 宿主上下文面；提供时注册 session/event + session/disposed 监听（批次四 SessionWatchHost 同形）。 */
    host?: SessionWatchHost,
    options: AutomationEngineOptions = {},
  ) {
    this.autoCommitMode = options.autoCommitMode === 'turn-end' ? 'turn-end' : 'off'
    this.autoCommitMessage = options.autoCommitMessage === 'ai' ? 'ai' : 'template'
    // 模板按 Config 原样收（空串照收——空消息被 commit 引擎 git/empty-message 拒绝并
    // 如实登记；不静默改写用户配置）。
    this.autoCommitTemplate = typeof options.autoCommitTemplate === 'string'
      ? options.autoCommitTemplate
      : DEFAULT_AUTO_COMMIT_TEMPLATE
    this.autoBranchMode = options.autoBranchMode === 'session-start' ? 'session-start' : 'off'
    this.autoBranchPrefix = typeof options.autoBranchPrefix === 'string' && options.autoBranchPrefix !== ''
      ? options.autoBranchPrefix
      : DEFAULT_AUTO_BRANCH_PREFIX
    this.autoBranchProtected = Array.isArray(options.autoBranchProtected) && options.autoBranchProtected.length > 0
      ? [...options.autoBranchProtected]
      : [...DEFAULT_AUTO_BRANCH_PROTECTED]
    this.logger = options.logger
    this.deps = deps
    host?.on('session/event', (session, event) => { this.observe(session, event) })
    host?.on('session/disposed', (session) => {
      const id = session?.id
      if (typeof id === 'string') this.seen.delete(id)
    })
  }

  /** 引擎依赖束（构造项存字段——deps 对象携带八面，避免十个位置参数）。 */
  private readonly deps: AutomationEngineDeps

  /** 测试/观测面：lastActions 环快照（newest-first——auditLog 查询序同款）。 */
  status(): AutomationStatusResult {
    return {
      autoCommitMode: this.autoCommitMode,
      autoBranchMode: this.autoBranchMode,
      lastActions: [...this.ring].reverse(),
    }
  }

  /** 测试/观测面：auto-branch 判重记忆（诊断视图）。 */
  seenSessions(): string[] {
    return [...this.seen.keys()]
  }

  /**
   * session/event 处理（构造期监听与测试直喂共用）。mode='off' 或事件形状退化
   * （session 无 id）⇒ 零动作零登记；`turn/end`（completed）⇒ 调度 auto-commit；
   * `turn/start`（per-session 首次）⇒ 调度 auto-branch。其余事件忽略。
   */
  observe(session: GitSessionFace, event: GitSessionEventFace): void {
    const sessionId = typeof session?.id === 'string' && session.id !== '' ? session.id : null
    if (sessionId === null) return
    if (event.type === 'turn/end') {
      if (this.autoCommitMode !== 'turn-end') return
      if (reasonKindOf(event.data) !== 'completed') return
      this.schedule('auto-commit', () => this.runAutoCommit(session, sessionId, turnOf(event.data)))
      return
    }
    if (event.type === 'turn/start') {
      if (this.autoBranchMode !== 'session-start') return
      if (this.seen.has(sessionId)) return
      this.seen.set(sessionId, true)
      this.trimSeen()
      // 单飞跳过 = 瞬时性（本回合未试）——撤销判重，下回合 turn/start 重试。
      const started = this.schedule('auto-branch', () => this.runAutoBranch(session, sessionId))
      if (!started) this.seen.delete(sessionId)
    }
  }

  /**
   * 单飞调度（fire-and-forget——事件总线回调不被自动化阻塞）：busy ⇒ 跳过 + 登记
   * （返回 false 供调用方撤销判重）；启动 ⇒ busy 置位、run 全收敛（内部已逐路径
   * 登记，此处 catch 是意外异常的双保险——automation 永不向事件总线抛错）。
   */
  private schedule(action: AutomationActionKind, run: () => Promise<void>): boolean {
    if (this.busy) {
      this.record(action, false, 'skipped: another automation action is in flight')
      return false
    }
    this.busy = true
    const running = run().catch((cause: unknown) => {
      const detail = oneLine(sanitizeStderr(cause instanceof Error ? cause.message : String(cause))).slice(0, 200)
      this.logger?.warn(`git automation: ${action} failed unexpectedly: ${detail}`)
      this.record(action, false, `unexpected failure: ${detail}`)
      this.deps.audit.record(action, false, 'git/git-error', 0, {})
    }).finally(() => { this.busy = false })
    this.lastRun = running
    return true
  }

  /**
   * 测试/同步面：最近一次调度动作的完成 Promise（无在飞 = 已决 Promise）——
   * observe 的 fire-and-forget 链在测试里的等待半（SessionWatch 全同步故无需此面；
   * 自动化的动作链异步，事件直喂后 await 本面即可对齐世界）。
   */
  settleOf(): Promise<void> {
    return this.lastRun ?? Promise.resolve()
  }

  // ---------- auto-commit [42] ----------

  /**
   * turn/end(completed) → add -A → scanStaged → commit 引擎落提交（§7.3 全守卫链）。
   * 任何路径都收敛在本方法内（无抛出面——意外由 schedule 的 catch 兜底登记）。
   */
  private async runAutoCommit(session: GitSessionFace, sessionId: string, turn: number | null): Promise<void> {
    const startedAt = Date.now()
    // 会话资格：子代理/被委托/无 cwd 不参与（workspace-changes eligible 同款语义）——
    // 零动作零登记（不是自动化失败，是该会话不在服务范围）。
    if (eligibleSessionCwd(session.header) === undefined) {
      this.logger?.debug(`git automation: auto-commit skipped for ineligible session ${sessionId.slice(0, 8)} (subagent/delegated/no cwd)`)
      return
    }
    const { deps } = this
    // workspace 已解析（Config override 或最近顶层会话 cwd）——未解析 ⇒ 跳过 + 登记。
    try {
      await deps.workspace.resolve()
    } catch (cause) {
      this.record('auto-commit', false, 'skipped: session workspace unresolved')
      deps.audit.record('auto-commit', false, errorCodeOf(cause), Date.now() - startedAt, {})
      return
    }
    // 并发纪律双检（§7.3）：fresh status（绕 TTL 缓存与在飞去重——写守卫的最新世界）
    // + detectOperation（批次一共享中间态探测）。status 三态非 ready / 中间态在场 ⇒ 跳过。
    const state = await deps.status.current(undefined, { fresh: true })
    if (state.availability !== 'ready') {
      const code = errorCodeOf(state.error)
      this.logger?.debug(`git automation: auto-commit skipped (status ${state.availability}: ${code})`)
      this.record('auto-commit', false, `skipped: status ${state.availability}`)
      deps.audit.record('auto-commit', false, code, Date.now() - startedAt, {})
      return
    }
    const snapshot = state.snapshot
    // clean = 无可提交改动。竞态场景（turn/end 前用户手工 commit 先落）在此收敛为
    // 零动作——fresh 判空即退，无重复提交（§7.6 竞态测试项的引擎半）。
    if (snapshot.clean) {
      this.logger?.debug('git automation: auto-commit skipped (worktree clean — nothing to commit)')
      return
    }
    // 裸冲突拒绝（批次五评审收口，fail-closed——§7.3「任何意外 ⇒ 跳过」同口径）：clean
    // 不含 conflicted（conflicted ⇒ clean=false——status-parser.ts clean 语义），而
    // stash pop 等路径的冲突**不留中间态伪引用/目录**（git 2.55.0.windows.2 实测：pop
    // 冲突后 MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD 与 rebase 目录全无 ⇒ detectOperation
    // = null）——放行会让 `git add -A` 静默「代为解决」unmerged 并把冲突标记提交进 HEAD
    // （且 audit ok:true），违反 v3 §3 冲突纪律（冲突必须走解决面板）。零命令拒绝 +
    // audit ok:false（automation.spec 裸冲突夹具断言零提交）。
    if (snapshot.conflicted.length > 0) {
      this.logger?.debug(`git automation: auto-commit skipped (${snapshot.conflicted.length} unmerged path(s) — bare conflict; resolve via the conflict panel)`)
      this.record('auto-commit', false, `skipped: ${snapshot.conflicted.length} unmerged path(s) (bare conflict — resolve first)`)
      deps.audit.record('auto-commit', false, 'git/merge-conflict', Date.now() - startedAt, {})
      return
    }
    let operation: string | null = null
    try {
      operation = await detectOperation(snapshot.repoRoot, deps.gitRead)
    } catch (cause) {
      this.record('auto-commit', false, 'skipped: operation probe failed')
      deps.audit.record('auto-commit', false, errorCodeOf(cause), Date.now() - startedAt, {})
      return
    }
    if (operation !== null) {
      this.record('auto-commit', false, `skipped: ${operation} operation in progress`)
      deps.audit.record('auto-commit', false, 'git/operation-in-progress', Date.now() - startedAt, {})
      return
    }
    // —— 动手段（§1-SOP(b) 写后失效纪律）：add -A 起触碰 index/worktree，无论退出
    // 路径（含意外异常）都走 onWrite（status 失效 + R3 帧——与 RPC 写同刷新口径）。
    let touched = false
    try {
      // `git add -A`（write 实例——WRITE_PREFIX + fastTimeoutMs）。
      touched = true
      const added = await deps.gitWrite.run(['add', '-A'], {
        cwd: snapshot.repoRoot,
        op: 'auto-commit(git add -A)',
        signal: signalOf(),
      })
      assertGitOk(added, 'auto-commit(git add -A)')
      // DD=A secret 硬阻断：staged 扫描（与 commit 引擎守卫 3.6 同一 scanStagedContents
      // 核心 + 同一 guardOptions）；扫描失败不降级放行（自动化 fail-closed——意外 ⇒ 跳过）。
      let violations
      try {
        violations = await scanStagedContents(deps.gitRead, snapshot.repoRoot, {
          largeFileBytes: deps.guard?.largeFileBytes ?? DEFAULT_GUARD_LARGE_FILE_BYTES,
          buildPatterns: deps.guard?.buildPatterns ?? [],
          secretPatterns: deps.guard?.secretPatterns ?? [],
          logger: this.logger,
        })
      } catch (cause) {
        this.record('auto-commit', false, 'skipped: guard scan failed')
        deps.audit.record('auto-commit', false, errorCodeOf(cause), Date.now() - startedAt, {})
        return
      }
      const secrets = hardBlockViolations(violations)
      if (secrets.length > 0) {
        // 不豁免不重试：`git reset`（mixed，无路径 = index 全撤销回 HEAD；worktree 改动
        // 原样保留——§7.6 断言半）→ audit + 登记。
        const reset = await deps.gitWrite.run(['reset'], {
          cwd: snapshot.repoRoot,
          op: 'auto-commit(git reset)',
          signal: signalOf(),
        })
        assertGitOk(reset, 'auto-commit(git reset)')
        this.logger?.warn(`git automation: auto-commit blocked by secret guard (${String(secrets.length)} violation(s)); staged reset, worktree changes kept`)
        this.record('auto-commit', false, `secret block: ${String(secrets.length)} violation(s); staged reset, worktree changes kept`)
        deps.audit.record('auto-commit', false, 'git/commit-blocked', Date.now() - startedAt, {})
        return
      }
      // 消息：autoCommitMessage='ai' ⇒ message-gen 路由（staged 已就绪；未解析/失败 ⇒
      // 回落模板——§7.2/§7.3）；'template' ⇒ `{turn}` 插值（turn 缺席的退化事件以 '-' 占位）。
      let message = this.interpolateTemplate(turn)
      if (this.autoCommitMessage === 'ai' && deps.messageGen !== undefined) {
        try {
          const generated = await deps.messageGen.generate()
          message = generated.message
        } catch (cause) {
          this.logger?.debug(`git automation: ai message route fell back to template (${errorCodeOf(cause)})`)
        }
      }
      // commit 引擎落提交（守卫链全量复用：identity / nothing-staged / message 校验 /
      // 纵深 secret 闸 / hook 分类 / 回读）。skipHooks=false——自动化走用户 hook 体系
      // （hook 失败 = 放弃，不 --no-verify 绕行）。
      try {
        const result = await deps.commit.commit({
          message,
          amend: false,
          skipHooks: false,
          trailers: [AUTO_COMMIT_TRAILER],
        })
        this.logger?.info(`git automation: auto-commit landed ${result.shortOid} on ${result.branch ?? '(detached)'} (turn ${String(turn)})`)
        this.record('auto-commit', true, `committed ${result.shortOid} on ${result.branch ?? '(detached)'} (turn ${String(turn)})`)
        deps.audit.record('auto-commit', true, null, Date.now() - startedAt, {
          turn: turn ?? '-',
          branch: result.branch ?? '(detached)',
          oid: result.shortOid,
        })
      } catch (cause) {
        const code = errorCodeOf(cause)
        // identity-missing ⇒ 跳过 + audit；hook 失败 ⇒ 放弃（不重试不改写）；纵深
        // commit-blocked（预检后竞态落 secret 进 index）⇒ 与预检同口径全撤销；其余域码
        // 原样登记（detail 只落域码，不落 stderr/message 正文）。
        if (code === 'git/commit-blocked') {
          await this.resetStaged(snapshot.repoRoot)
          this.record('auto-commit', false, 'secret block at commit; staged reset, worktree changes kept')
        } else if (code === 'git/identity-missing') {
          this.record('auto-commit', false, 'skipped: git identity missing')
        } else if (code === 'git/hook-failed') {
          this.record('auto-commit', false, 'abandoned: commit hook rejected (no retry, no rewrite)')
        } else {
          this.record('auto-commit', false, `failed: ${code}`)
        }
        deps.audit.record('auto-commit', false, code, Date.now() - startedAt, {})
      }
    } finally {
      if (touched) this.deps.onWrite?.()
    }
  }

  // ---------- auto-branch [43] ----------

  /**
   * turn/start（per-session 首次）→ fresh status（分支 ∈ 受保护表 + clean + 非任务
   * 分支）⇒ refsAdmin.branchCreate（checkout=true，branch-exists ⇒ 序号后缀递增）。
   * 瞬时性失败撤销判重（下回合重试），结构性决策保留判重（该会话不再试）。
   */
  private async runAutoBranch(session: GitSessionFace, sessionId: string): Promise<void> {
    const startedAt = Date.now()
    const { deps } = this
    if (eligibleSessionCwd(session.header) === undefined) {
      // 会话无资格（子代理/委托/无 cwd）——结构性（该会话永远不会在服务范围），
      // 保留判重，零登记。
      this.logger?.debug(`git automation: auto-branch skipped for ineligible session ${sessionId.slice(0, 8)}`)
      return
    }
    const state = await deps.status.current(undefined, { fresh: true })
    if (state.availability !== 'ready') {
      const code = errorCodeOf(state.error)
      this.logger?.debug(`git automation: auto-branch skipped (status ${state.availability}: ${code})`)
      this.record('auto-branch', false, `skipped: status ${state.availability}`)
      deps.audit.record('auto-branch', false, code, Date.now() - startedAt, {})
      this.seen.delete(sessionId) // 瞬时——重试
      return
    }
    const snapshot = state.snapshot
    const branch = snapshot.branch.name
    // 非受保护分支（含 detached；任务分支 dsh/task-* 本身不在受保护表——「已在任务
    // 分支不再建」由受保护检查 + per-session 判重共同承载，§7.3 条件表无前缀命中项）
    // ⇒ 跳过 + log（不阻塞会话不报错；结构性，保留判重）。
    if (branch === null || !this.autoBranchProtected.includes(branch)) {
      this.logger?.debug(`git automation: auto-branch skipped (branch ${branch ?? '(detached)'} is not in autoBranchProtected)`)
      return
    }
    // 非 clean ⇒ 跳过 + log（§7.3；瞬时——下回合重试）。
    if (!snapshot.clean) {
      this.logger?.debug('git automation: auto-branch skipped (worktree dirty)')
      this.seen.delete(sessionId)
      return
    }
    // 并发纪律双检（§7.3）：中间态在场 ⇒ 跳过（瞬时——重试）。
    let operation: string | null = null
    try {
      operation = await detectOperation(snapshot.repoRoot, deps.gitRead)
    } catch (cause) {
      this.record('auto-branch', false, 'skipped: operation probe failed')
      deps.audit.record('auto-branch', false, errorCodeOf(cause), Date.now() - startedAt, {})
      this.seen.delete(sessionId)
      return
    }
    if (operation !== null) {
      this.record('auto-branch', false, `skipped: ${operation} operation in progress`)
      deps.audit.record('auto-branch', false, 'git/operation-in-progress', Date.now() - startedAt, {})
      this.seen.delete(sessionId)
      return
    }
    // 建切：prefix + 会话短 id（分支安全 token 化）；refs-admin branch-exists 预检命中
    // ⇒ `-2`/`-3`/… 递增（§7.6 命名冲突测试项）。branchCreate 触碰 refs/HEAD（创建成
    // 功但 switch 失败的半途也改了 refs）——退出统一走 onWrite。
    const base = `${this.autoBranchPrefix}${shortBranchToken(sessionId)}`
    for (let attempt = 1; attempt <= AUTO_BRANCH_SUFFIX_MAX; attempt += 1) {
      const name = attempt === 1 ? base : `${base}-${String(attempt)}`
      try {
        const created = await deps.refsAdmin.branchCreate({ name, checkout: true })
        this.logger?.info(`git automation: auto-branch created ${created.name} for session ${sessionId.slice(0, 8)}`)
        this.record('auto-branch', true, `created ${created.name} (from ${branch})`)
        deps.audit.record('auto-branch', true, null, Date.now() - startedAt, {
          name: created.name,
          from: branch,
        })
        return
      } catch (cause) {
        if (errorCodeOf(cause) !== 'git/branch-exists') {
          const code = errorCodeOf(cause)
          this.record('auto-branch', false, `failed: ${code}`)
          deps.audit.record('auto-branch', false, code, Date.now() - startedAt, {})
          this.seen.delete(sessionId) // 命令失败 = 瞬时——重试
          return
        }
        // branch-exists ⇒ 序号后缀递增（循环继续；attempt=1 的 base 命中后从 -2 起）。
      } finally {
        this.deps.onWrite?.()
      }
    }
    this.record('auto-branch', false, `failed: no free ${this.autoBranchPrefix}<id> name within ${String(AUTO_BRANCH_SUFFIX_MAX)} suffixes`)
    deps.audit.record('auto-branch', false, 'git/branch-exists', Date.now() - startedAt, {})
    this.seen.delete(sessionId)
  }

  // ---------- 共享半 ----------

  /** lastActions 环登记（append + 容量逐出最旧；status() 投影 newest-first）。 */
  private record(action: AutomationActionKind, ok: boolean, detail: string): void {
    this.ring.push({ at: new Date().toISOString(), action, ok, detail })
    if (this.ring.length > AUTOMATION_STATUS_RING) {
      this.ring.splice(0, this.ring.length - AUTOMATION_STATUS_RING)
    }
  }

  /** 纵深 commit-blocked 的全撤销（与预检 secret 同口径；reset 自身失败不掩盖原码——不抛）。 */
  private async resetStaged(repoRoot: string): Promise<void> {
    try {
      const reset = await this.deps.gitWrite.run(['reset'], {
        cwd: repoRoot,
        op: 'auto-commit(git reset)',
        signal: signalOf(),
      })
      assertGitOk(reset, 'auto-commit(git reset)')
    } catch (cause) {
      this.logger?.warn(`git automation: post-block reset failed: ${oneLine(sanitizeStderr(cause instanceof Error ? cause.message : String(cause)))}`)
    }
  }

  /** 模板插值：`{turn}` → 回合号（退化事件无 turn 以 '-' 占位——不静默吞占位符）。 */
  private interpolateTemplate(turn: number | null): string {
    return this.autoCommitTemplate.replaceAll('{turn}', turn !== null ? String(turn) : '-')
  }

  /** 判重记忆容量钳制（超出逐出最旧——FIFO，Map 插入序）。 */
  private trimSeen(): void {
    while (this.seen.size > AUTO_BRANCH_SEEN_MAX) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
    }
  }
}

// ---------- 事件载荷窄化与域错误码提取（收口） ----------

// turnOf/reasonKindOf 已收口至 shared.ts（本模块 ≡ session-watch.ts 同款私有副本——
// 形状闸语义不变：缺席/病形 = null，auto-commit 退化插值占位 '-'）。
// codeOf 已收口至 error-codes.ts errorCodeOf（index.ts 同形副本；非域错误按
// gateway/internal）——本文件全部调用点改名引用，行为逐字保真。

/**
 * 会话 id → 分支安全短 token（prefix 后缀）：白名单字符保留、其余折叠 '-'，去首部
 * `-.`/尾部 `.`（git check-ref-format 的分支命名禁区），`.lock` 尾一并剥（refs 禁区），
 * 截 8 字符；空结果 = 'session'。
 */
export function shortBranchToken(sessionId: string): string {
  const cleaned = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/\.lock$/i, '')
    .replace(/[.]+$/, '')
  const token = cleaned.slice(0, 8).replace(/[-.]+$/, '')
  return token !== '' ? token : 'session'
}

/** 诊断单行化（detail/log 面——换行折叠，防多行 stderr 进环）。 */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

