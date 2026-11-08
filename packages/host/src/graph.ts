/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/repo/gitCliRepo.ts
 *         （getCommitGraph 分页取参段 :1013-1053：--skip + --max-count=<limit+1>
 *         防御性 over-fetch ⇒ hasMore；exit 128 + "does not have any commits yet"
 *         ⇒ 空页不抛错；normalizeGitGraphMaxCount/normalizeGitGraphSkip :386-400
 *         的钳制语义——非有限数回落默认、floor、min/max 夹逼）
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-31（F7 提交图数据层模块，spec §1.8 [清单 31/32/33]）——
 *   ① 分页入参改 spec §1.0.3 LogOptions {limit, skip}；钳制上界换 Config.logMaxLimit、
 *      非有限数回落 Config.logDefaultLimit（ZCode 的 DEFAULT/MAX 常量）；
 *   ② 记录分隔/字段分隔换 spec §1.8 的 %x1e/%x1f（ZCode 用 %x00 记内分隔 + %x1e 记录
 *      尾），字段集按 CommitInfo（%aI/%cI ISO 日期替代 %at unix；增 %ae/%b）；
 *   ③ 排序只保留 --topo-order、单起点 HEAD（ZCode 叠 --date-order 与 --branches/
 *      --tags/--remotes——spec §1.8 命令形态限定，refs 装饰由 refs() 单独取、client 合并）；
 *   ④ commandProvider/child_process → GitRunner 只读实例；错误改领域错误（RemoteError）；
 *      repo 发现复用 forge "128 + not a git repository → 域码" 范式（diff.ts 同款再应用）；
 *   ⑤ limit+1 的 over-fetch 判 hasMore 后截回 limit（ZCode hasMore 语义同构）。
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * dsh-gitkit — 提交图数据层引擎（spec §1.8 [清单 31/32/33] + workflow M8 任务口径）。
 *
 * 三个只读 RPC 的引擎半（权限 A、fastTimeoutMs、幂等、host 无缓存——spec §1.9
 * log/refs/show 行无失效列，缓存语义由 client store 承担）：
 *   - `log(options)`：`git log --topo-order --pretty=format:<记录> -n <limit+1> --skip <skip>`
 *     ——取 limit+1 条判 hasMore（防御性 over-fetch，A 级 ZCode 语义）；unborn HEAD
 *     返回空页不抛错（[清单 64]）；`limit` 钳到 [1, logMaxLimit]、`skip` 钳 ≥ 0。
 *   - `refs()`：**单次** for-each-ref 查询（refs/heads + refs/remotes + refs/tags，
 *     workflow 任务口径「单次查询」）——format 含 `%(upstream:track)`，本地分支的
 *     upstream 跟踪态（`[gone]` / `[ahead 1]` / `''`）一次取回，逐分支 rev-list 不做；
 *     + symbolic-ref/rev-parse 双命令并行判 head 三态（branch/detached/unborn）。
 *   - `getCommitDetail(options)`：commit 元数据（log -1 同记录格式）+ 文件清单/patch
 *     （DiffEngine.commitDiff：merge 按第一父、根提交 --root、预算语义 §1.2）+ 指向
 *     该提交的 refs 过滤（workflow 任务口径「refs 过滤」——全量单次查询后按 peeled
 *     oid 过滤，annotated tag 经 %(*objectname) 已落到 RefInfo.oid，匹配即命中）。
 *
 * GitLens MIT 区对照（C 级，PORTING.md 登记，零代码搬运）：行头类型
 * `packages/git/src/models/graph.ts` 的 GitGraphRowHead.isCurrentHead / upstream
 * {missing, state:{ahead,behind}} 形状——本模块 refs() 的 head 三态与
 * RefInfo.upstreamTrack 的「跟踪态一次随 refs 取回」即此对照而来；分页 single-writer
 * 契约（graphSession.ts:11-18）与 over-walk/spurious-empty 防护（providers/graph.ts
 * :2487/:1822）不移植（前者在 client store 落地，后者随 ZCode over-fetch 语义达成）。
 * opencode `plugin/vcs/git.ts:260` 的 `symbolic-ref --quiet --short HEAD`（MIT）为
 * head 解析语义来源（C 级）。
 *
 * v2 批次二扩展（2026-11-08，docs/v2-implementation-plan.md §4.5）：
 *   - `log(options)` 接受过滤参数（[清单 35/60]）：`--grep=<q> -F`（固定串）/
 *     `--author=<a>`（正则语义）/ `--follow`（仅单 path 合法——违反 ⇒ bad-request
 *     'follow-without-path' 零命令）/ `-- <path>` / `<ref>` 起点（不可解析 ⇒
 *     unknown-revision 预检）。LOG_PRETTY_FORMAT 与钳制零改动复用；本机实测
 *     `--follow` 与 `--topo-order` 兼容（git 2.55.0.windows.2 exit 0）。
 *   - `compareBranches(options)`（[清单 36]）：revListCounts（rev-count.ts 提共享）
 *     双向计数 + log 两列（base..compare = ahead / compare..base = behind）+
 *     merge-base；计数与列表长度互检。
 */

import { resolve } from 'node:path'
import { assertGitOk, gitError, gitRunError } from './error-codes.ts'
import { revListCounts } from './rev-count.ts'
import type { GitRunner } from './git-runner.ts'
import type { DiffEngine } from './diff.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type {
  BranchCompareResult, CommitDetail, CommitInfo, CompareOptions, LogOptions, LogPage,
  RefInfo, RefType, RefsSnapshot, ShowOptions,
} from './types.ts'

/** spec §1.0.2 默认每页条数（logDefaultLimit；client 可传更小/更大的有限值，钳制见 normalizeLogLimit）。 */
export const DEFAULT_LOG_DEFAULT_LIMIT = 500

/** spec §1.0.2 默认单页上限（logMaxLimit；GitLens getGraph 默认 5000，SOURCES.md:108）。 */
export const DEFAULT_LOG_MAX_LIMIT = 5_000

/**
 * log 记录格式（spec §1.8 命令形态）：字段分隔 0x1f、记录尾 0x1e；%b 内换行不破坏
 * 解析（换行只在记录**之间**由 git 插入，%x1e 之前属于 body）。
 */
export const LOG_PRETTY_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%b%x1e'

/**
 * refs 记录格式（单次查询；workflow 任务口径含 upstream:track）：tab 分隔——
 * objectname / *objectname（annotated tag 的 peeled commit）/ refname / refname:short /
 * upstream:track（无 upstream 或已同步为空串；`[gone]` = upstream 引用已消失）。
 * upstream:track 值含空格/逗号但无 tab，放末字段安全。
 */
export const REF_PRETTY_FORMAT = '%(objectname)%09%(*objectname)%09%(refname)%09%(refname:short)%09%(upstream:track)'

/**
 * unborn HEAD 的 stderr 特征族（spec §1.8 的消息 + A 级 ZCode 守卫族
 * gitCliRepo.ts:1042-1048 的转置；本机 git 2.55.0.windows.2 实测：log 路径 =
 * "does not have any commits yet"、rev-parse --verify HEAD 路径 = "Needed a
 * single revision"，老版 git 为 "bad default revision"）。
 */
const UNBORN_STDERR_PATTERN = /does not have any commits yet|Needed a single revision|bad default revision/i

/**
 * 钳制 log 每页条数（A 级 ZCode normalizeGitGraphMaxCount 语义，gitCliRepo.ts:386-392）：
 * 非有限数 → 默认值；floor 后夹到 [1, max]。
 */
export function normalizeLogLimit(limit: number | undefined, fallback: number, max: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback
  return Math.min(max, Math.max(1, Math.floor(limit)))
}

/** 钳制 skip（A 级 ZCode normalizeGitGraphSkip 语义，gitCliRepo.ts:394-400）：非有限数 → 0；floor 后 ≥ 0。 */
export function normalizeLogSkip(skip: number | undefined): number {
  if (typeof skip !== 'number' || !Number.isFinite(skip)) return 0
  return Math.max(0, Math.floor(skip))
}

/**
 * 解析 `git log --pretty=format:<LOG_PRETTY_FORMAT>` 的 stdout 为 CommitInfo 列表
 * （spec §1.8 字段序：oid/parents/an/ae/aI/cI/s/b）。空输出 = 空列表（--skip 越界
 * 的合法空页）。body 字段（第 8 段起）以分隔符回接——提交正文内嵌 0x1f 不破坏解析；
 * 记录内嵌 0x1e 仍会破坏记录切分（spec 选定的分隔符边界，正文出现该控制字符时
 * 按契约破坏处理——抛错，与 parseNumstat 同纪律）。
 * @throws 记录缺尾分隔符 / 字段不足 8 / 空 oid（契约破坏要响）。
 */
export function parseLogCommits(stdout: string): CommitInfo[] {
  if (stdout === '') return []
  const chunks = stdout.split('\x1e')
  if (chunks.at(-1) !== '') throw new Error('log output is not record-terminated')
  chunks.pop()
  const records: CommitInfo[] = []
  for (const [index, raw] of chunks.entries()) {
    // git 以 \n 连接相邻记录（format: 无尾换行）；首记录无前导换行。
    const chunk = index === 0 ? raw : raw.replace(/^\n/, '')
    records.push(parseLogRecord(chunk))
  }
  return records
}

/** 单条 log 记录 → CommitInfo（body 回接见 parseLogCommits 注）。 */
function parseLogRecord(chunk: string): CommitInfo {
  const parts = chunk.split('\x1f')
  if (parts.length < 8) {
    throw new Error(`malformed log record: expected 8 fields, got ${parts.length}`)
  }
  const oid = parts[0] as string
  if (oid === '') throw new Error('malformed log record: empty oid')
  const parentsField = parts[1] as string
  return {
    oid,
    parents: parentsField === '' ? [] : parentsField.split(' '),
    authorName: parts[2] as string,
    authorEmail: parts[3] as string,
    authoredAt: parts[4] as string,
    committedAt: parts[5] as string,
    subject: parts[6] as string,
    body: parts.slice(7).join('\x1f'),
  }
}

/**
 * 解析 for-each-ref 单次查询的 stdout（REF_PRETTY_FORMAT，tab 分隔五字段）。
 * `RefInfo.oid` 取 peeled 值（spec §1.8 B6）：annotated tag 的 %(*objectname) 非空
 * （= commit oid）用之，否则回落 %(objectname)；本机实测非 tag ref 的 *objectname
 * 为空串。upstreamTrack 只对 local-branch 非空值放行（remote-branch/tag 无 upstream
 * 语义；空串 = 无 upstream 或已同步，不与 `[gone]` 区分——v1 信息性字段）。
 * @throws 记录字段数 ≠ 5 / refname 前缀不在三类之内（契约破坏要响）。
 */
export function parseForEachRef(stdout: string): RefInfo[] {
  if (stdout === '') return []
  const lines = stdout.split('\n')
  if (lines.at(-1) !== '') throw new Error('for-each-ref output is not newline-terminated')
  lines.pop()
  const refs: RefInfo[] = []
  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length !== 5) throw new Error(`malformed for-each-ref record: expected 5 fields, got ${parts.length}`)
    const objectName = parts[0] as string
    const peeled = parts[1] as string
    const refname = parts[2] as string
    const shortName = parts[3] as string
    const track = parts[4] as string
    if (objectName === '' || refname === '') throw new Error(`malformed for-each-ref record: ${line}`)
    const type = refTypeOf(refname)
    refs.push({
      type,
      fullName: refname,
      shortName,
      oid: peeled !== '' ? peeled : objectName,
      upstreamTrack: type === 'local-branch' && track !== '' ? track : null,
    })
  }
  return refs
}

/** refname 前缀 → RefType（未知前缀 = 契约破坏）。 */
function refTypeOf(refname: string): RefType {
  if (refname.startsWith('refs/heads/')) return 'local-branch'
  if (refname.startsWith('refs/remotes/')) return 'remote-branch'
  if (refname.startsWith('refs/tags/')) return 'tag'
  throw new Error(`unexpected refname outside heads/remotes/tags: ${refname}`)
}

/** GraphEngine 构造项（缺省 = spec §1.0.2 log 两默认值）。 */
export interface GraphEngineOptions {
  /** 每页默认条数（非有限 limit 的回落值；spec logDefaultLimit）。 */
  logDefaultLimit?: number
  /** 单页上限（limit 钳制上界；spec logMaxLimit）。 */
  logMaxLimit?: number
}

/**
 * 提交图数据层引擎：log / refs / getCommitDetail（权限 A 只读，readonly runner 实例，
 * fastTimeoutMs 熔断）。host 无缓存（spec §1.9 三行均无失效列）——写后失效由
 * client store 的状态订阅承担（branch.oid 变化 → reload）。
 */
export class GraphEngine {
  private readonly logDefaultLimit: number
  private readonly logMaxLimit: number

  constructor(
    private readonly git: GitRunner,
    private readonly workspace: WorkspaceResolver,
    private readonly diff: DiffEngine,
    options: GraphEngineOptions = {},
  ) {
    this.logDefaultLimit = options.logDefaultLimit ?? DEFAULT_LOG_DEFAULT_LIMIT
    this.logMaxLimit = options.logMaxLimit ?? DEFAULT_LOG_MAX_LIMIT
  }

  /**
   * 提交分页（spec §1.8 log [清单 31]）。取 limit+1 条判 hasMore（A 级 ZCode
   * over-fetch 语义）后截回 limit；unborn HEAD ⇒ 空页（[清单 64]，不抛错）。
   *
   * v2 批次二过滤参数扩展（docs/v2-implementation-plan.md §4.5，[清单 35/60]）：
   * `--grep=<query> -F`（固定串）/ `--author=<author>`（正则语义）/ `--follow`（仅
   * 单 path 合法，违反 ⇒ bad-request 'follow-without-path' 零命令）/ `-- <path>` /
   * `<ref>` 起点。`LOG_PRETTY_FORMAT` 与钳制零改动复用；`skip`+过滤组合的分页语义
   * 与 v1 相同（--skip 由 git 在过滤结果上滑动，over-fetch limit+1 不变）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/bad-request（'follow-without-path'）、git/unknown-revision（ref 不可解析）、
   *   git/git-error（记录解析契约破坏 / git 失败兜底）。
   */
  async log(options: LogOptions, signal?: AbortSignal): Promise<LogPage> {
    const limit = normalizeLogLimit(options.limit, this.logDefaultLimit, this.logMaxLimit)
    const skip = normalizeLogSkip(options.skip)
    const repoRoot = await this.resolveRepoRoot('log', signal)
    // 过滤参数组装（§4.5）：空串/null 一律按缺省（不进命令）。
    const path = typeof options.path === 'string' && options.path !== '' ? options.path : null
    const ref = typeof options.ref === 'string' && options.ref !== '' ? options.ref : null
    if (options.follow === true && path === null) {
      // 守卫零命令（--follow 无单 path 是 git 自身也会拒绝的用法，但这里前置拒绝
      // 才能给出可读域码——reason 'follow-without-path'）。
      throw gitError('git/bad-request', 'git log: follow=true requires a single path (path is missing)', {
        reason: 'follow-without-path', paths: [], expected: null, actual: null,
      })
    }
    const args = ['log', '--topo-order', `--pretty=format:${LOG_PRETTY_FORMAT}`, '-n', String(limit + 1), '--skip', String(skip)]
    if (typeof options.query === 'string' && options.query !== '') args.push(`--grep=${options.query}`, '-F')
    if (typeof options.author === 'string' && options.author !== '') args.push(`--author=${options.author}`)
    if (options.follow === true) args.push('--follow')
    if (ref !== null) {
      // 起点 revision 预检（exit 1 = 不可解析 ⇒ unknown-revision，details 带原词）。
      const probed = await this.git.run(['rev-parse', '--verify', '--quiet', ref], {
        cwd: repoRoot, op: 'log(rev-parse --verify ref)', signal: signal ?? neverAborted(),
      })
      if (probed.exitCode !== 0) {
        throw gitError('git/unknown-revision', `git log: revision '${ref}' could not be resolved`, {
          op: 'log', revision: ref,
        })
      }
      args.push(ref)
    }
    if (path !== null) args.push('--', path)
    const result = await this.git.run(args, { cwd: repoRoot, op: 'log', signal: signal ?? neverAborted() })
    if (result.exitCode === 128 && UNBORN_STDERR_PATTERN.test(result.stderr)) {
      return { commits: [], hasMore: false, skipUsed: skip, limitUsed: limit }
    }
    assertGitOk(result, 'log')
    const records = parseLogCommits(result.stdout)
    return {
      commits: records.slice(0, limit),
      hasMore: records.length > limit,
      skipUsed: skip,
      limitUsed: limit,
    }
  }

  /**
   * refs 快照（spec §1.8 refs [清单 31]）：**单次** for-each-ref（三类前缀一次取全，
   * 含 upstream:track）+ symbolic-ref/rev-parse 并行判 head 三态。
   * head 判定：symbolic-ref exit 0 → 分支短名；exit ≠ 0（--quiet 下 detached 的
   * exit 1）→ detached。rev-parse exit 0 → oid；exit 128 + unborn 消息 → unborn
   * （unborn 时 symbolic-ref 仍成功——HEAD 指向尚未诞生的分支引用）；其余 → git-error。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（记录解析契约破坏 / rev-parse 非 unborn 失败兜底）。
   */
  async refs(signal?: AbortSignal): Promise<RefsSnapshot> {
    const repoRoot = await this.resolveRepoRoot('refs', signal)
    const active = signal ?? neverAborted()
    const [refsResult, symbolicResult, headResult] = await Promise.all([
      this.git.run(
        ['for-each-ref', `--format=${REF_PRETTY_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'],
        { cwd: repoRoot, op: 'refs(for-each-ref)', signal: active },
      ),
      this.git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: repoRoot, op: 'refs(symbolic-ref)', signal: active,
      }),
      this.git.run(['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot, op: 'refs(rev-parse HEAD)', signal: active,
      }),
    ])
    assertGitOk(refsResult, 'refs(for-each-ref)')
    const refs = parseForEachRef(refsResult.stdout)
    // symbolic-ref 非零 = HEAD 非 symbolic（detached；--quiet 抑制消息）。
    const branchName = symbolicResult.exitCode === 0 ? symbolicResult.stdout.trim() || null : null
    if (headResult.exitCode === 0) {
      const oid = headResult.stdout.trim()
      return {
        refs,
        head: branchName !== null
          ? { kind: 'branch', name: branchName, oid }
          : { kind: 'detached', name: null, oid },
      }
    }
    if (headResult.exitCode === 128 && UNBORN_STDERR_PATTERN.test(headResult.stderr)) {
      return { refs, head: { kind: 'unborn', name: branchName, oid: null } }
    }
    // rev-parse 非 unborn 的失败（损坏仓库等）→ git-error 兜底（GitService 层记 warn）。
    throw gitRunError('refs(rev-parse HEAD)', headResult.exitCode, headResult.stderr, headResult.truncated)
  }

  /**
   * 提交详情（workflow 任务口径 getCommitDetail；spec §1.8 show [清单 32/33] 的
   * 引擎半）：meta（log -1 同记录格式）+ 文件清单/单文件 patch（DiffEngine.commitDiff
   * ——merge 按第一父、根提交 --root、预算语义同 §1.2）+ refs 过滤（全量单次查询
   * 后按 peeled oid 过滤——annotated tag 已在解析时落到 RefInfo.oid，直接相等匹配）。
   * @param options.oid 全 oid（或 rev-list 可解析的修订；无效修订 → git 128
   *   bad revision → git/git-error）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（修订无效 / 记录契约破坏 / patch 预算外的命令失败——patch 失败
   *   在 DiffEngine 内降级 patch:null 不炸整体）。
   */
  async getCommitDetail(options: ShowOptions, signal?: AbortSignal): Promise<CommitDetail> {
    const repoRoot = await this.resolveRepoRoot('getCommitDetail', signal)
    const active = signal ?? neverAborted()
    const [metaResult, refsResult, diffResult] = await Promise.all([
      this.git.run(['log', '-1', `--pretty=format:${LOG_PRETTY_FORMAT}`, options.oid], {
        cwd: repoRoot, op: `getCommitDetail(log -1 ${options.oid.slice(0, 12)})`, signal: active,
      }),
      this.git.run(
        ['for-each-ref', `--format=${REF_PRETTY_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'],
        { cwd: repoRoot, op: 'getCommitDetail(for-each-ref)', signal: active },
      ),
      this.diff.commitDiff(options.oid, options.path, signal),
    ])
    assertGitOk(metaResult, 'getCommitDetail(log -1)')
    const commits = parseLogCommits(metaResult.stdout)
    const commit = commits[0]
    if (commit === undefined) {
      throw gitError('git/git-error', `git getCommitDetail: empty meta for ${options.oid.slice(0, 12)}`, {
        op: 'getCommitDetail(log -1)', exitCode: metaResult.exitCode, stderr: '', truncated: false,
      })
    }
    assertGitOk(refsResult, 'getCommitDetail(for-each-ref)')
    const refs = parseForEachRef(refsResult.stdout).filter((ref) => ref.oid === commit.oid)
    return { commit, files: diffResult.files, totalTruncated: diffResult.totalTruncated, refs }
  }

  /**
   * 分支对比（v2 批次二 [清单 36]，docs/v2-implementation-plan.md §4.3）：
   * revListCounts（rev-count.ts 提共享，`base...compare` 双向计数）+ `git log
   * --topo-order` 两列（base..compare = ahead / compare..base = behind，
   * LOG_PRETTY_FORMAT 复用）+ merge-base。计数与列表长度互检（rev-list 与 log
   * 的语义应恒等——不一致 = 契约破坏要响）。
   * @throws git/bad-request（'invalid-options'）、git/unknown-revision（base/compare
   *   不可解析）、git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（rev-list 失败 / 计数列表互检不一致 / merge-base 失败兜底）。
   */
  async compareBranches(options: CompareOptions, signal?: AbortSignal): Promise<BranchCompareResult> {
    const base = requireRevision(options.base, 'compareBranches', 'base')
    const compare = requireRevision(options.compare, 'compareBranches', 'compare')
    const repoRoot = await this.resolveRepoRoot('compareBranches', signal)
    const active = signal ?? neverAborted()
    await this.requireRevisionResolvable(repoRoot, 'compareBranches', base, active)
    await this.requireRevisionResolvable(repoRoot, 'compareBranches', compare, active)

    const counts = await revListCounts(this.git, repoRoot, base, compare, 'compareBranches', active)
    if (counts === null) {
      // 预检已证两修订可解析，rev-list 失败 = 仓库状态异常（浅克隆截断等），如实兜底。
      throw gitError('git/git-error', 'git compareBranches: rev-list --left-right --count failed', {
        op: 'compareBranches(rev-list --left-right --count)', exitCode: null, stderr: '', truncated: false,
      })
    }
    const [ahead, behind] = await Promise.all([
      this.logRange(repoRoot, `${base}..${compare}`, 'compareBranches(log base..compare)', active),
      this.logRange(repoRoot, `${compare}..${base}`, 'compareBranches(log compare..base)', active),
    ])
    // rev-list 计数与 log 列表长度互检（两者对同一集合的不同命令面，应恒等）。
    if (ahead.length !== counts.ahead || behind.length !== counts.behind) {
      throw gitError('git/git-error', `git compareBranches: rev-list counts (${String(counts.ahead)}/${String(counts.behind)}) disagree with log lists (${String(ahead.length)}/${String(behind.length)})`, {
        op: 'compareBranches(count cross-check)', exitCode: null, stderr: '', truncated: false,
      })
    }
    const mergeBase = await this.mergeBase(repoRoot, base, compare, active)
    return {
      base, compare, mergeBase, ahead, behind,
      aheadCount: ahead.length, behindCount: behind.length,
    }
  }

  /** `git log --topo-order --pretty=format:<LOG_PRETTY_FORMAT> <range>`（对比单列）。 */
  private async logRange(repoRoot: string, range: string, op: string, active: AbortSignal): Promise<CommitInfo[]> {
    const result = await this.git.run(
      ['log', '--topo-order', `--pretty=format:${LOG_PRETTY_FORMAT}`, range],
      { cwd: repoRoot, op, signal: active },
    )
    assertGitOk(result, op)
    return parseLogCommits(result.stdout)
  }

  /** `git merge-base <base> <compare>`（exit 0 = oid；exit 1 = 不相交 ⇒ null；其余要响）。 */
  private async mergeBase(repoRoot: string, base: string, compare: string, active: AbortSignal): Promise<string | null> {
    const result = await this.git.run(['merge-base', base, compare], {
      cwd: repoRoot, op: 'compareBranches(merge-base)', signal: active,
    })
    if (result.exitCode === 0) return result.stdout.trim()
    if (result.exitCode === 1) return null
    throw gitRunError('compareBranches(merge-base)', result.exitCode, result.stderr, result.truncated)
  }

  /** 修订可解析预检（`rev-parse --verify --quiet`；exit 1 ⇒ unknown-revision）。 */
  private async requireRevisionResolvable(repoRoot: string, op: string, revision: string, active: AbortSignal): Promise<void> {
    const probed = await this.git.run(['rev-parse', '--verify', '--quiet', revision], {
      cwd: repoRoot, op: `${op}(rev-parse --verify)`, signal: active,
    })
    if (probed.exitCode !== 0) {
      throw gitError('git/unknown-revision', `git ${op}: revision '${revision}' could not be resolved`, {
        op, revision,
      })
    }
  }

  /**
   * repo 发现（dsh forge git.ts:99-103 范式，diff.ts/status.ts 同款再应用）：
   * exit 128 + "not a git repository" ⇒ git/no-repository（details.probed = 工作区）。
   */
  private async resolveRepoRoot(op: string, signal?: AbortSignal): Promise<string> {
    const resolution = await this.workspace.resolve()
    const probe = await this.git.run(['rev-parse', '--show-toplevel'], {
      cwd: resolution.root,
      op: `${op}(rev-parse --show-toplevel)`,
      signal: signal ?? neverAborted(),
    })
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${resolution.root}`, { probed: resolution.root })
    }
    assertGitOk(probe, `${op}(rev-parse --show-toplevel)`)
    return resolve(resolution.root, probe.stdout.trim())
  }
}

/** 未取消信号（调用方 signal 缺席时的占位；diff.ts 同款）。 */
function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}

/** 非空修订守卫（compareBranches 的 base/compare；空 ⇒ bad-request 'invalid-options'）。 */
function requireRevision(value: string, op: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw gitError('git/bad-request', `git ${op}: a non-empty ${field} revision is required`, {
      reason: 'invalid-options', paths: [], expected: null, actual: null,
    })
  }
  return value
}
