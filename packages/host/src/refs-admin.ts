/*!
 * 对照（C 级语义学习，零代码搬运，PORTING.md 登记）：zai-org/ZCode
 *   packages/services/src/git/repo/gitCliRepo.ts（分支/标签管理命令的编排骨架语义：
 *   先存在性预检再执行变更、写后失效；本模块自研实现同一编排纪律）
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-11-08（v2 批次一 refs-admin 引擎，docs/v2-implementation-plan.md
 *   §3.5）—— 全部解析器自研声明（`git remote -v` 行解析、`git worktree list
 *   --porcelain` 块解析为本模块按 git 文档与 git 2.55.0.windows.2 本机实测自研，无
 *   任何来源代码搬运；C 级对照仅上述编排骨架语义）。与 ZCode 的关键差异：
 *   1. 命令一律带 `--` 分隔符保护（本机实测：`git branch -- --all` ⇒ git 自身
 *      「not a valid branch name」exit 128，选项注入被 git 拒绝）；`git switch` 不支持
 *      `--` 后跟 -c 双位置参数（实测 exit 128 "only one reference expected"），故
 *      checkout = `git branch --` + `git switch --` 两命令（非 `switch -C`）；
 *   2. 存在性预检走 `rev-parse --verify --quiet refs/...`（exit 1 = 缺失），域码化
 *      （branch-exists/tag-exists/branch-not-found/tag-not-found）而非 stderr 特征；
 *   3. worktree porcelain 的 unborn HEAD 全零 oid 归一为 null（BranchState.oid [清单 64]
 *      同语义）；locked reason 自由文本不进 wire（布尔位）。
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * dsh-gitkit — refs 管理引擎（v2 批次一：[清单 23] 分支建/切/删、[清单 30] tag 建/删、
 * [清单 57] remote 列表、[清单 62] worktree 列表、[清单 68] worktree 建/删）。
 *
 * 实例纪律（CLAUDE.md 四实例）：变更类（branch/tag/worktree 写）走 **write** runner
 * （用户 hooks 与本操作无关，但 WRITE_PREFIX 前缀集保持一致；超时 fastTimeoutMs）；
 * 查询类（存在性预检/列表/回读）走 **readonly** runner。解析器全部自研（见文件头对照
 * 声明），解析契约破坏要响（`graph.ts` parseForEachRef 同纪律：缺尾分隔/缺字段即抛）。
 *
 * 守卫纪律：
 *   - force 类动作（`-D` 删分支 / tag `-f` / worktree `--force`）双闸 host 半：
 *     force=true 且 acknowledged!==true ⇒ `git/bad-request`（reason
 *     'force-unacknowledged'），**零命令执行**（mutations discard 守卫同款）；
 *   - branchSwitch 前置脏区拒绝（fresh 扫描，pull 同款 ⇒ git/dirty-worktree）；
 *   - worktreeAdd 的 branch/newBranch 互斥且至少其一（违反 ⇒ bad-request
 *     'invalid-options'，防 `-b` 静默 DWIM 误建分支）。
 */

import { resolve } from 'node:path'
import { assertGitOk, gitError, gitRunError, sanitizeStderr } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { StatusEngine } from './status.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type {
  BranchCreateOptions, BranchCreateResult, BranchDeleteOptions, BranchDeleteResult, BranchSwitchResult,
  RemoteInfo, RemoteListResult, TagCreateOptions, TagCreateResult, TagDeleteResult,
  WorktreeAddOptions, WorktreeAddResult, WorktreeInfo, WorktreeListResult, WorktreeRemoveOptions, WorktreeRemoveResult,
} from './types.ts'
import type { GitStatusSnapshot } from './types.ts'

/** refs-admin 引擎构造项（预留 logger 诊断位，MutationEngine 同款）。 */
export interface RefsAdminEngineOptions {
  logger?: { debug(message: string): void }
}

/** unborn worktree 的 porcelain HEAD 形态（本机 git 2.55.0.windows.2 实测：全零 oid）。 */
const UNBORN_OID_RE = /^0+$/

/** `git remote -v` 行形状：`<name>\t<url> (fetch|push)`；url 贪婪到最后一组括号。 */
const REMOTE_LINE_RE = /^(.*)\t(.*) \((fetch|push)\)$/u

export class RefsAdminEngine {
  private readonly logger: RefsAdminEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——branch/tag/worktree 变更执行）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（存在性预检 / 列表 / 回读）。 */
    private readonly gitRead: GitRunner,
    /** 最新世界读取（branchSwitch 的脏区前置拒绝；fresh 扫描）。 */
    private readonly status: StatusEngine,
    /** 工作区解析（repoRoot 发现；graph.ts resolveRepoRoot 同款 probe）。 */
    private readonly workspace: WorkspaceResolver,
    options: RefsAdminEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  // ---------- 分支（[清单 23]） ----------

  /**
   * 新建分支：`git branch -- <name> [<from>]`；checkout=true 时追加 `git switch -- <name>`
   * （`git switch -c` 的位置参数无 `--` 保护——本机实测 `switch -c -- <name> <from>` exit
   * 128，故拆两命令，见文件头差异 1）。重名 ⇒ git/branch-exists（预检）。
   * @throws git/bad-request 'invalid-options'、git/branch-exists、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async branchCreate(options: BranchCreateOptions, signal?: AbortSignal): Promise<BranchCreateResult> {
    const name = requireName(options.name, 'branchCreate')
    const repoRoot = await this.resolveRepoRoot('branchCreate', signal)
    await this.requireBranchMissing(repoRoot, name, signal)
    const args = options.from !== null && options.from !== undefined && options.from !== ''
      ? ['branch', '--', name, options.from]
      : ['branch', '--', name]
    const created = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'branchCreate(git branch)', signal: active(signal),
    })
    assertGitOk(created, 'branchCreate(git branch)')
    if (options.checkout === true) {
      const switched = await this.gitWrite.run(['switch', '--', name], {
        cwd: repoRoot, op: 'branchCreate(git switch)', signal: active(signal),
      })
      assertGitOk(switched, 'branchCreate(git switch)')
    }
    const oid = await this.peekOid(repoRoot, `refs/heads/${name}`, signal)
    this.logger?.debug(`git branchCreate: name=${name} checkedOut=${options.checkout === true}`)
    return { name, oid, checkedOut: options.checkout === true }
  }

  /**
   * 切换分支：脏区前置拒绝（fresh 扫描非 clean ⇒ git/dirty-worktree）→ 分支存在性预检
   * （缺 ⇒ git/branch-not-found）→ `git switch -- <name>`；to = 回读 symbolic-ref（不信入参）。
   * @throws git/bad-request 'invalid-options'、git/dirty-worktree、git/branch-not-found、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async branchSwitch(name: string, signal?: AbortSignal): Promise<BranchSwitchResult> {
    requireName(name, 'branchSwitch')
    const { repoRoot, snapshot } = await this.scanFresh('branchSwitch', signal)
    if (!snapshot.clean) {
      throw gitError('git/dirty-worktree', `git branchSwitch: working tree is dirty; commit or stash first`, {
        branch: snapshot.branch.name,
        pathCount: dirtyPathCount(snapshot),
      })
    }
    const existing = await this.peekOid(repoRoot, `refs/heads/${name}`, signal)
    if (existing === null) {
      throw gitError('git/branch-not-found', `git branchSwitch: branch '${name}' does not exist`, { name })
    }
    const switched = await this.gitWrite.run(['switch', '--', name], {
      cwd: repoRoot, op: 'branchSwitch(git switch)', signal: active(signal),
    })
    assertGitOk(switched, 'branchSwitch(git switch)')
    const to = await this.currentBranch(repoRoot, signal)
    if (to === null) {
      // 刚成功 switch 到已存在的本地分支后 symbolic-ref 失败 = 契约破坏（要响）。
      throw gitError('git/git-error', 'git branchSwitch: HEAD is not symbolic after a successful switch', {
        op: 'branchSwitch(symbolic-ref)', exitCode: null, stderr: '', truncated: false,
      })
    }
    this.logger?.debug(`git branchSwitch: from=${String(snapshot.branch.name)} to=${to}`)
    return { from: snapshot.branch.name, to }
  }

  /**
   * 删除分支：force（= `-D`）需 acknowledged（零命令守卫）→ 存在性预检（缺 ⇒
   * git/branch-not-found）→ wasMerged 回读（`merge-base --is-ancestor <name> HEAD`）
   * → `git branch -d/-D -- <name>`；未合并拒绝（git 自身）映射 git/branch-not-merged。
   * @throws git/bad-request 'force-unacknowledged'、git/branch-not-found、
   *   git/branch-not-merged、git/no-repository、git/session-workspace-unresolved、
   *   git/timeout、git/git-error。
   */
  async branchDelete(options: BranchDeleteOptions, signal?: AbortSignal): Promise<BranchDeleteResult> {
    const name = requireName(options.name, 'branchDelete')
    if (options.force === true && options.acknowledged !== true) {
      throw badRequest('force-unacknowledged', 'branchDelete with force (-D) requires acknowledged=true (destructive confirmation gate)')
    }
    const repoRoot = await this.resolveRepoRoot('branchDelete', signal)
    const existing = await this.peekOid(repoRoot, `refs/heads/${name}`, signal)
    if (existing === null) {
      throw gitError('git/branch-not-found', `git branchDelete: branch '${name}' does not exist`, { name })
    }
    const wasMerged = await this.isAncestorOfHead(repoRoot, `refs/heads/${name}`, signal)
    const deleted = await this.gitWrite.run(['branch', options.force === true ? '-D' : '-d', '--', name], {
      cwd: repoRoot, op: 'branchDelete(git branch)', signal: active(signal),
    })
    if (deleted.exitCode !== 0 && /not fully merged/i.test(deleted.stderr)) {
      throw gitError('git/branch-not-merged', `git branchDelete: branch '${name}' is not fully merged (use force to delete)`, { name })
    }
    assertGitOk(deleted, 'branchDelete(git branch)')
    this.logger?.debug(`git branchDelete: name=${name} force=${options.force === true} wasMerged=${wasMerged}`)
    return { deleted: name, wasMerged }
  }

  // ---------- 标签（[清单 30]） ----------

  /**
   * 新建 tag：message 非空 = annotated（`tag -a -m`），否则 lightweight；oid 非空 =
   * 指定起点。force（= `-f` 覆盖）需 acknowledged；非 force 重名 ⇒ git/tag-exists（预检）。
   * 返回 oid = peeled 提交（`<tag>^{commit}` 回读，annotated/lightweight 同口径）。
   * @throws git/bad-request 'force-unacknowledged'、git/tag-exists、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async tagCreate(options: TagCreateOptions, signal?: AbortSignal): Promise<TagCreateResult> {
    const name = requireName(options.name, 'tagCreate')
    if (options.force === true && options.acknowledged !== true) {
      throw badRequest('force-unacknowledged', 'tagCreate with force (-f) requires acknowledged=true (destructive confirmation gate)')
    }
    const repoRoot = await this.resolveRepoRoot('tagCreate', signal)
    if (options.force !== true) {
      const existing = await this.peekOid(repoRoot, `refs/tags/${name}`, signal)
      if (existing !== null) {
        throw gitError('git/tag-exists', `git tagCreate: tag '${name}' already exists (use force to overwrite)`, { name })
      }
    }
    const annotated = typeof options.message === 'string' && options.message.trim() !== ''
    const args = ['tag']
    if (annotated) args.push('-a', '-m', options.message as string)
    if (options.force === true) args.push('-f')
    args.push('--', name)
    if (options.oid !== null && options.oid !== undefined && options.oid !== '') args.push(options.oid)
    const created = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'tagCreate(git tag)', signal: active(signal),
    })
    assertGitOk(created, 'tagCreate(git tag)')
    const oid = await this.peekOid(repoRoot, `refs/tags/${name}^{commit}`, signal)
    this.logger?.debug(`git tagCreate: name=${name} annotated=${annotated} force=${options.force === true}`)
    return { name, oid, annotated }
  }

  /**
   * 删除 tag：存在性预检（缺 ⇒ git/tag-not-found）→ `git tag -d -- <name>`。
   * @throws git/bad-request 'invalid-options'、git/tag-not-found、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async tagDelete(name: string, signal?: AbortSignal): Promise<TagDeleteResult> {
    requireName(name, 'tagDelete')
    const repoRoot = await this.resolveRepoRoot('tagDelete', signal)
    const existing = await this.peekOid(repoRoot, `refs/tags/${name}`, signal)
    if (existing === null) {
      throw gitError('git/tag-not-found', `git tagDelete: tag '${name}' does not exist`, { name })
    }
    const deleted = await this.gitWrite.run(['tag', '-d', '--', name], {
      cwd: repoRoot, op: 'tagDelete(git tag -d)', signal: active(signal),
    })
    assertGitOk(deleted, 'tagDelete(git tag -d)')
    this.logger?.debug(`git tagDelete: name=${name}`)
    return { deleted: name }
  }

  // ---------- remote / worktree 查询（[清单 57]/[清单 62]） ----------

  /**
   * remote 列表（[清单 57]）：`git remote -v` 行解析——`<name>\t<url> (fetch|push)`；
   * pushUrl = 显式 push 行的 url（与 fetch 相同也如实带回），缺 push 行 = null
   * （git 语义下 push 缺省使用 fetch url）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（行解析契约破坏 / 命令失败兜底）。
   */
  async remoteList(signal?: AbortSignal): Promise<RemoteListResult> {
    const repoRoot = await this.resolveRepoRoot('remoteList', signal)
    const listing = await this.gitRead.run(['remote', '-v'], {
      cwd: repoRoot, op: 'remoteList(git remote -v)', signal: active(signal),
    })
    assertGitOk(listing, 'remoteList(git remote -v)')
    if (listing.stdout !== '' && !listing.stdout.endsWith('\n')) {
      throw new Error('remote -v output is not newline-terminated')
    }
    const remotes = new Map<string, RemoteInfo>()
    for (const line of listing.stdout.split('\n')) {
      if (line === '') continue
      const match = REMOTE_LINE_RE.exec(line)
      if (match === null) throw new Error(`malformed remote -v record: ${JSON.stringify(line)}`)
      const name = match[1] as string
      const url = match[2] as string
      const direction = match[3] as 'fetch' | 'push'
      const entry = remotes.get(name) ?? { name, url: '', pushUrl: null }
      if (direction === 'fetch') {
        if (entry.url !== '') throw new Error(`duplicate fetch url record for remote '${name}'`)
        entry.url = url
      } else {
        if (entry.pushUrl !== null) throw new Error(`duplicate push url record for remote '${name}'`)
        entry.pushUrl = url
      }
      remotes.set(name, entry)
    }
    const list = [...remotes.values()]
    for (const remote of list) {
      if (remote.url === '') throw new Error(`remote '${remote.name}' has no fetch url record`)
      // git 语义（本机实测）：未显式配置 push url 时 `git remote -v` 也输出与 fetch
      // 同值的 push 行——归一为 null（wire 注记「null = push 缺省使用 fetch url」），
      // 显式配置且不同才如实带回。
      if (remote.pushUrl === remote.url) remote.pushUrl = null
    }
    this.logger?.debug(`git remoteList: count=${list.length}`)
    return { remotes: list }
  }

  /**
   * worktree 列表（[清单 62]）：`git worktree list --porcelain` 块解析（空行分块，
   * 首行 `worktree <path>` 为块锚——缺失 = 契约破坏；locked/prunable 的 reason 自由
   * 文本只取布尔位，未知属性行前向容忍跳过；unborn 的全零 HEAD 归一 null）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（块解析契约破坏 / 命令失败兜底）。
   */
  async worktreeList(signal?: AbortSignal): Promise<WorktreeListResult> {
    const repoRoot = await this.resolveRepoRoot('worktreeList', signal)
    const listing = await this.gitRead.run(['worktree', 'list', '--porcelain'], {
      cwd: repoRoot, op: 'worktreeList(git worktree list --porcelain)', signal: active(signal),
    })
    assertGitOk(listing, 'worktreeList(git worktree list --porcelain)')
    const worktrees = parseWorktreePorcelain(listing.stdout)
    this.logger?.debug(`git worktreeList: count=${worktrees.length}`)
    return { worktrees }
  }

  // ---------- worktree 写面（[清单 68]） ----------

  /**
   * 新建 worktree：branch（检出现有）与 newBranch（`-b` 新建）互斥且至少其一（违反 ⇒
   * bad-request 'invalid-options'）→ `git worktree add [-b <newBranch>] -- <path> [<branch>]`
   * → 新 worktree 内回读 branch/head（失败降级 null 不炸整体）。
   * path 已存在非空 / 分支已被另一 worktree 检出等 git 拒绝 ⇒ git/worktree-failed
   * （stderr 过 sanitizeStderr）。
   * @throws git/bad-request 'invalid-options'、git/worktree-failed、git/no-repository、
   *   git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async worktreeAdd(options: WorktreeAddOptions, signal?: AbortSignal): Promise<WorktreeAddResult> {
    const rawPath = requirePath(options.path, 'worktreeAdd')
    const hasBranch = options.branch !== null && options.branch !== undefined && options.branch !== ''
    const hasNew = options.newBranch !== null && options.newBranch !== undefined && options.newBranch !== ''
    if (hasBranch === hasNew) {
      throw badRequest('invalid-options', 'worktreeAdd requires exactly one of branch (check out existing) or newBranch (create new)')
    }
    const repoRoot = await this.resolveRepoRoot('worktreeAdd', signal)
    const absPath = resolve(repoRoot, rawPath)
    const args = ['worktree', 'add']
    if (hasNew) args.push('-b', options.newBranch as string)
    args.push('--', absPath)
    if (hasBranch) args.push(options.branch as string)
    const added = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'worktreeAdd(git worktree add)', signal: active(signal),
    })
    if (added.exitCode !== 0) {
      throw gitError('git/worktree-failed', `git worktreeAdd: worktree add failed for '${absPath}'`, {
        path: absPath,
        stderr: sanitizeStderr(added.stderr),
      })
    }
    // 回读（world 而非自述）：新 worktree 的 branch/head；回读失败降级 null 不炸整体。
    const branch = await this.currentBranch(absPath, signal, { lenient: true })
    const head = await this.peekOid(absPath, 'HEAD', signal, { lenient: true })
    this.logger?.debug(`git worktreeAdd: path=${absPath} branch=${String(branch)}`)
    return { path: absPath, branch, head }
  }

  /**
   * 移除 worktree：force（`--force`，脏 worktree 也删）需 acknowledged（零命令守卫）→
   * `git worktree remove [--force] -- <path>`；path 不存在 / 主 worktree / git 拒绝 ⇒
   * git/worktree-failed（stderr 过 sanitizeStderr）。
   * @throws git/bad-request 'force-unacknowledged'、git/worktree-failed、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async worktreeRemove(options: WorktreeRemoveOptions, signal?: AbortSignal): Promise<WorktreeRemoveResult> {
    const rawPath = requirePath(options.path, 'worktreeRemove')
    if (options.force === true && options.acknowledged !== true) {
      throw badRequest('force-unacknowledged', 'worktreeRemove with force requires acknowledged=true (destructive confirmation gate)')
    }
    const repoRoot = await this.resolveRepoRoot('worktreeRemove', signal)
    const absPath = resolve(repoRoot, rawPath)
    const args = ['worktree', 'remove']
    if (options.force === true) args.push('--force')
    args.push('--', absPath)
    const removed = await this.gitWrite.run(args, {
      cwd: repoRoot, op: 'worktreeRemove(git worktree remove)', signal: active(signal),
    })
    if (removed.exitCode !== 0) {
      throw gitError('git/worktree-failed', `git worktreeRemove: worktree remove failed for '${absPath}'`, {
        path: absPath,
        stderr: sanitizeStderr(removed.stderr),
      })
    }
    this.logger?.debug(`git worktreeRemove: path=${absPath} force=${options.force === true}`)
    return { removed: absPath }
  }

  // ---------- 守卫与解析助手 ----------

  /** fresh status 扫描（branchSwitch 脏区守卫 + repoRoot；三态 error 就地抛出）。 */
  private async scanFresh(
    op: string,
    signal?: AbortSignal,
  ): Promise<{ repoRoot: string; snapshot: GitStatusSnapshot }> {
    const state = await this.status.current(signal, { fresh: true })
    if (state.error !== null) throw state.error
    this.logger?.debug(`git ${op}: fresh status scan (repoRoot resolved)`)
    return { repoRoot: state.snapshot.repoRoot, snapshot: state.snapshot }
  }

  /** repo 发现（graph.ts resolveRepoRoot 同款：exit 128 + not a git repository ⇒ git/no-repository）。 */
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
    return resolve(resolution.root, probe.stdout.trim())
  }

  /**
   * 引用存在性与指向（`rev-parse --verify --quiet <ref>`；exit 1 = 缺失 ⇒ null）。
   * lenient（worktree 回读降级）时 128（引用表达式损坏）同落 null；其余非零要响。
   */
  private async peekOid(
    cwd: string,
    ref: string,
    signal?: AbortSignal,
    opts: { lenient?: boolean } = {},
  ): Promise<string | null> {
    const probe = await this.gitRead.run(['rev-parse', '--verify', '--quiet', ref], {
      cwd, op: `refs-admin(rev-parse --verify ${ref})`, signal: active(signal),
    })
    if (probe.exitCode === 0) {
      const oid = probe.stdout.trim()
      return oid === '' ? null : oid
    }
    // --quiet 下缺失 = exit 1；128 等 = 引用表达式损坏——lenient（worktree 回读降级 null）
    // 之外要响。
    if (opts.lenient === true && (probe.exitCode === 1 || probe.exitCode === 128)) return null
    if (probe.exitCode === 1) return null
    throw gitRunError(`refs-admin(rev-parse --verify ${ref})`, probe.exitCode, probe.stderr, probe.truncated)
  }

  /** 当前分支短名（symbolic-ref --quiet --short HEAD；detached ⇒ null）。 */
  private async currentBranch(
    cwd: string,
    signal?: AbortSignal,
    opts: { lenient?: boolean } = {},
  ): Promise<string | null> {
    const probe = await this.gitRead.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd, op: 'refs-admin(symbolic-ref HEAD)', signal: active(signal),
    })
    if (probe.exitCode === 0) {
      const name = probe.stdout.trim()
      return name === '' ? null : name
    }
    if (opts.lenient === true) return null
    // 非 lenient 场景（branchSwitch）调用方对 null 另行抛契约错；detached 语义 = null。
    return null
  }

  /** `merge-base --is-ancestor <ref> HEAD`（exit 0 = 祖先；1 = 否；其余要响）。 */
  private async isAncestorOfHead(repoRoot: string, ref: string, signal?: AbortSignal): Promise<boolean> {
    const probe = await this.gitRead.run(['merge-base', '--is-ancestor', ref, 'HEAD'], {
      cwd: repoRoot, op: 'refs-admin(merge-base --is-ancestor)', signal: active(signal),
    })
    if (probe.exitCode === 0) return true
    if (probe.exitCode === 1) return false
    throw gitRunError('refs-admin(merge-base --is-ancestor)', probe.exitCode, probe.stderr, probe.truncated)
  }

  /** 分支不存在预检（存在 ⇒ git/branch-exists）。 */
  private async requireBranchMissing(repoRoot: string, name: string, signal?: AbortSignal): Promise<void> {
    const existing = await this.peekOid(repoRoot, `refs/heads/${name}`, signal)
    if (existing !== null) {
      throw gitError('git/branch-exists', `git branchCreate: branch '${name}' already exists`, { name })
    }
  }
}

// ---------- 纯函数（导出供夹具单测） ----------

/**
 * 解析 `git worktree list --porcelain` 的 stdout（空行分块；首行 `worktree <path>` 为
 * 块锚，缺失 = 契约破坏要响；`HEAD <oid>` 全零归 null（unborn）、bare 无 HEAD 行同 null；
 * `branch refs/heads/<x>` 剥前缀得短名；detached/bare/locked 取布尔位（locked 的 reason
 * 自由文本不进 wire）；未知属性行（如未来 git 新增 prunable 扩展）前向容忍跳过）。
 * @throws 非 newline 结尾 / 块首行非 worktree 行（契约破坏要响）。
 */
export function parseWorktreePorcelain(stdout: string): WorktreeInfo[] {
  if (stdout === '') return []
  if (!stdout.endsWith('\n')) throw new Error('worktree list --porcelain output is not newline-terminated')
  const worktrees: WorktreeInfo[] = []
  let current: WorktreeInfo | null = null
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') {
      if (current !== null) worktrees.push(current)
      current = null
      continue
    }
    if (rawLine.startsWith('worktree ')) {
      if (current !== null) throw new Error('malformed worktree record: nested worktree line without blank separator')
      current = { path: rawLine.slice('worktree '.length), head: null, branch: null, bare: false, detached: false, locked: false }
      continue
    }
    if (current === null) throw new Error(`malformed worktree record: attribute line before worktree line: ${JSON.stringify(rawLine)}`)
    if (rawLine.startsWith('HEAD ')) {
      const oid = rawLine.slice('HEAD '.length).trim()
      current.head = oid === '' || UNBORN_OID_RE.test(oid) ? null : oid
      continue
    }
    if (rawLine.startsWith('branch ')) {
      const ref = rawLine.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      continue
    }
    if (rawLine === 'detached') { current.detached = true; continue }
    if (rawLine === 'bare') { current.bare = true; continue }
    if (rawLine.startsWith('locked')) { current.locked = true; continue }
    // 未知属性行（prunable [reason] 等）前向容忍：跳过。
  }
  if (current !== null) worktrees.push(current)
  return worktrees
}

/** 脏区路径计数（pull 的 dirty-worktree details 同口径：四组去重合计）。 */
function dirtyPathCount(snapshot: GitStatusSnapshot): number {
  const paths = new Set<string>()
  for (const change of [...snapshot.staged, ...snapshot.unstaged, ...snapshot.untracked, ...snapshot.conflicted]) {
    paths.add(change.path)
  }
  return paths.size
}

/** 非空名字守卫（branch/tag 名；空 ⇒ bad-request 'invalid-options'）。 */
function requireName(name: string, op: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw badRequest('invalid-options', `git ${op}: a non-empty name is required`)
  }
  return name
}

/** 非空路径守卫（worktreeAdd/Remove；空 ⇒ bad-request 'invalid-options'）。 */
function requirePath(path: string, op: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw badRequest('invalid-options', `git ${op}: a non-empty path is required`)
  }
  return path
}

function badRequest(reason: 'force-unacknowledged' | 'invalid-options', message: string): never {
  throw gitError('git/bad-request', message, { reason, paths: [], expected: null, actual: null })
}

function active(signal?: AbortSignal): AbortSignal {
  if (signal !== undefined) return signal
  const controller = new AbortController()
  return controller.signal
}
