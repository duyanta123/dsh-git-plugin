/*!
 * Ported from deepseek-ai/deepseek-harness (dsh 树)
 *   path: packages/experimental/client-ui-forge/src/git.ts:99-103（repo 发现的
 *         "exit 128 + not a git repository → null/域码" 范式——status.ts 已登记段
 *         在本文件的再应用）
 * License: MIT — Copyright (c) DeepSeek（dsh 源码树许可）
 * Modifications: 2026-10-31（④-C diff 引擎模块）—— 新文件。双路 diff/commitDiff 编排
 *   按 capability-spec §1.2/§1.8 与 workflow 任务口径实现；解析与预算纯函数为本模块
 *   自研。语义对照（C 级，PORTING.md 登记，无代码搬运）：opencode
 *   packages/core/src/git.ts diffGroup（name-status + numstat + patch 三路并发、
 *   patchBudget 预算递减，SOURCES.md:68）。
 *
 * 本机实测修订（git 2.55.0.windows.2，win32 临时仓库，2026-10-31；「spec 与宿主实际
 * 不符时以实测为准」——均已记入 ModuleResult.openIssues）：
 *   1. spec §1.2 patch 命令里的 `--literal-pathspecs` 对 `git diff` 子命令是**非法
 *      选项**（实测 usage exit 129；该旗标只存在于全局位 `git --literal-pathspecs …`）。
 *      字面量语义由 runner 的 GIT_LITERAL_PATHSPECS=1 环境承载（git-runner.ts GIT_ENV），
 *      故 patch/listing 命令不带该旗标。
 *   2. untracked 的 no-index **numstat** 形态在 Windows git 渲染 `nul => <path>`
 *      （重命名式显示，不可解析）——untracked 的 binary/加减计数改从 no-index patch
 *      本体推导：`Binary files ` 标记行 ⇒ binary；hunk 体 `+`/`-` 行计数（对 /dev/null
 *      恒 deletions=0、恒单 hunk，计数精确；零字节文件 header-only patch 记 0/0）。
 *   3. `git show --numstat` 与 `git diff-tree`（含 --first-parent）对 **merge 提交**
 *      默认输出为空（combined-diff 抑制）——commitDiff 改为 `rev-list --parents -n 1`
 *      解析父提交：非根提交（含 merge）用两树形态 `git diff <p1> <oid>`（任务口径
 *      「merge 按第一父对比」），根提交用 `git diff-tree --root`（任务口径「根提交
 *      --root」）。
 *   4. 冲突仓库里 `git diff --numstat/--name-status` 仍 exit 0，但对 unmerged 路径
 *      各输出**两条**记录（U + M）——装配按 path 去重（first-wins），计数取
 *      numstat 末条（worktree 侧）。
 *   5. no-index patch 形态（`git diff --no-index --unified=3 /dev/null -- <path>`）
 *      文本/零字节/二进制文件**都 exit 1**；双 `--` 形态 exit 129（diff.spec 回归守卫）。
 * SPDX-License-Identifier: MIT
 */

/**
 * @dsh-plugin/git — diff 引擎（spec §1.2 [清单 2/3/59] + §1.8 show 的 patch 半
 * [清单 33]）。权限 A 只读（readonly runner 实例）；幂等；无缓存（每次调用实跑，
 * §1.9 diff 行无失效列要求）。
 *
 * 预算语义（spec §1.2 预算段 + [清单 59]）：
 *   - 单文件 patch 超过 `filePatchMaxBytes`（实测手段：runner maxBytes 钉在单文件上限，
 *     truncated ⇒ 全量 patch ≥ 上限）⇒ `oversized:true, patchTruncated:true, patch:null`
 *     （UI 占位；任务口径「补丁超 diffMaxBytes 置 large、runner 截断置 truncated」——
 *     两旗标在 runner 截断时同时成立：patchTruncated 回答「被单文件上限截断了吗」，
 *     oversized 回答「UI 该显示占位吗」）；
 *   - 累计服务 patch 字节超过 `totalPatchMaxBytes` ⇒ 停止为后续文件取 patch
 *     （patch:null），`totalTruncated:true`（只统计「想要 patch 而未取得」的文件；
 *     binary/oversized 文件零预算消耗）；
 *   - 单文件 patch 失败（exit ∉ 白名单 / runner 抛错）不炸整体 ⇒ 该文件 patch:null，
 *     调用仍成功（spec §1.2 错误段）；调用方 signal 取消必须传播，不吞。
 */

import { resolve } from 'node:path'
import { assertGitOk, EXIT_OK_ONLY, gitError } from './error-codes.ts'
import type { GitRunner, GitRunResult } from './git-runner.ts'
import { numstatCounts, parseNumstat } from './status-parser.ts'
import type { NumstatCounts } from './status-parser.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { DiffFile, DiffResult, DiffScope } from './types.ts'

/** spec §1.0.2 默认单文件 patch 上限（diffFilePatchMaxBytes，262_144）。 */
export const DIFF_FILE_PATCH_MAX_BYTES = 256 * 1024

/** spec §1.0.2 默认单次调用 patch 总预算（diffTotalPatchMaxBytes，2_097_152）。 */
export const DIFF_TOTAL_PATCH_MAX_BYTES = 2 * 1024 * 1024

/**
 * no-index 命令的成功退出码白名单（spec §1.2：0 = 无差异、1 = 有差异仍成功；
 * 实测文本/零字节/二进制文件都 exit 1；≥2 才是失败）——严禁走通用「非零即败」。
 */
export const NO_INDEX_ALLOWED_EXIT_CODES: readonly number[] = [0, 1]

/** DiffFile.status 的别名（解析纯函数的产出类型）。 */
export type DiffFileStatus = DiffFile['status']

/** 一条 `git diff --name-status -z` 记录的解析视图（status/origPath 权威）。 */
export interface NameStatusEntry {
  path: string
  /** renamed/copied 的原路径；其余 null。 */
  origPath: string | null
  status: DiffFileStatus
}

/**
 * 解析 `git diff --name-status -z --find-renames` 的 stdout。
 * 实测记录布局（git 2.55.0.windows.2）：普通条目 = 状态 token + 路径两条记录
 * （`M\0path\0`）；重命名/复制 = 状态 token（`R100`/`C079`，分数无空格直接跟随字母）
 * + 原路径 + 新路径三条记录；冲突仓库 unmerged 路径出现 `U\0path\0`（后随 `M\0…`，
 * 由 assembleDiffFiles 折叠）。路径为 -z 原样字节（中文/空格安全）。
 * @throws 记录错位（缺路径/空 token）——契约破坏要响（与 parseNumstat 同纪律）。
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('name-status output is not NUL-terminated')
  queue.pop()
  const entries: NameStatusEntry[] = []
  while (queue.length > 0) {
    const token = queue.shift() as string
    if (token === '') throw new Error('malformed name-status record: empty status token')
    const letter = token[0] as string
    if (letter === 'R' || letter === 'C') {
      const origPath = queue.shift()
      const path = queue.shift()
      if (origPath === undefined || path === undefined || origPath === '' || path === '') {
        throw new Error(`malformed name-status rename record: ${token}`)
      }
      entries.push({ path, origPath, status: letter === 'R' ? 'renamed' : 'copied' })
      continue
    }
    const path = queue.shift()
    if (path === undefined || path === '') throw new Error(`malformed name-status record: ${token}`)
    entries.push({ path, origPath: null, status: nameStatusKind(letter) })
  }
  return entries
}

/** 状态字母 → DiffFile.status（T/typechange 与 U/unmerged 折叠进 modified，与
 * status-parser kindOf 的 T 处理一致；DiffFile.status 无对应枚举值）。 */
function nameStatusKind(letter: string): DiffFileStatus {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  if (letter === 'R') return 'renamed'
  if (letter === 'C') return 'copied'
  return 'modified'
}

/**
 * name-status（status/origPath 权威，序保留）⊕ numstat 计数表（additions/deletions/
 * binary 权威）→ DiffFile 初稿（patch 三字段待预算环回填）。
 * 按 path 去重（实测：冲突仓库 unmerged 路径 name-status 出 U+M 两条——first-wins）；
 * numstat 侧同名多记录由 numstatCounts 的 Map 后写覆盖天然折叠（worktree 侧计数）。
 * binary 条目 additions/deletions 置 null（spec §1.0.3 DiffFile「binary 时 null」；
 * numstatCounts 把 '-' 归一为 0，此处按 wire 契约覆盖，不透传 0）。计数表缺项
 * （两路并发间隙的极端失同步）⇒ additions/deletions null、binary false。
 */
export function assembleDiffFiles(
  entries: readonly NameStatusEntry[],
  counts: ReadonlyMap<string, NumstatCounts>,
): DiffFile[] {
  const files: DiffFile[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    const stat = counts.get(entry.path)
    const binary = stat?.binary ?? false
    files.push({
      path: entry.path,
      origPath: entry.origPath,
      status: entry.status,
      binary,
      additions: binary ? null : stat?.additions ?? null,
      deletions: binary ? null : stat?.deletions ?? null,
      patch: null,
      patchTruncated: false,
      oversized: false,
    })
  }
  return files
}

/** untracked no-index patch 的分析产出（binary/加减计数从 patch 本体推导——文件头实测修订 2）。 */
export interface UntrackedPatchAnalysis {
  binary: boolean
  additions: number | null
  deletions: number | null
  /** binary 时 null；否则完整 no-index patch 文本（零字节文件为 header-only patch）。 */
  patch: string | null
}

/**
 * 分析 `git diff --no-index --unified=3 /dev/null -- <path>` 的 stdout：
 * `Binary files ` 标记行 ⇒ binary:true, patch:null（git 对二进制文件的 no-index 渲染）；
 * 否则 patch = 原文，additions/deletions = 首个 `@@` hunk 头之后的 `+`/`-` 行计数
 * （`+++ b/…` 头在 @@ 之前不会误计；对 /dev/null 的 diff 恒无上下文合并问题）。
 * 零字节文件（实测 exit 1 + header-only patch）⇒ 0/0。
 */
export function analyzeUntrackedPatch(output: string): UntrackedPatchAnalysis {
  const lines = output.split('\n')
  if (lines.some(line => line.startsWith('Binary files '))) {
    return { binary: true, additions: null, deletions: null, patch: null }
  }
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of lines) {
    if (!inHunk) {
      inHunk = line.startsWith('@@')
      continue
    }
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { binary: false, additions, deletions, patch: output }
}

/** 单文件 patch 取回结果（预算环的中间形状；「失败」含 exit ∉ 白名单与 runner 抛错）。 */
type PatchOutcome = { outcome: 'ok'; text: string } | { outcome: 'truncated' } | { outcome: 'failed' }

/** fillPatches 对单文件发出的 patch 命令描述。 */
interface PatchCommand {
  argv: readonly string[]
  /** git/timeout 与 git-error details 的 op 名。 */
  op: string
  allowedExitCodes: readonly number[]
  /** untracked 命令：patch 本体需做 binary 标记/加减行推导（analyzeUntrackedPatch）。 */
  untracked?: boolean
}

/** commitDiff 的返回（spec CommitDetail 的 diff 半——commit 元数据由 show 接线时并入）。 */
export interface CommitDiffResult {
  files: DiffFile[]
  totalTruncated: boolean
}

/** DiffEngine 构造项（缺省 = spec §1.0.2 预算默认值）。 */
export interface DiffEngineOptions {
  /** 单文件 patch 上限字节（spec diffFilePatchMaxBytes）。 */
  filePatchMaxBytes?: number
  /** 单次调用 patch 总预算字节（spec diffTotalPatchMaxBytes）。 */
  totalPatchMaxBytes?: number
}

/**
 * 双路 diff + 提交 diff 引擎。所有命令走只读 runner 实例（READONLY_PREFIX +
 * fastTimeoutMs，spec §1.9 diff/show 行）；路径字面量由 runner 的
 * GIT_LITERAL_PATHSPECS=1 环境保证（文件头实测修订 1）。
 */
export class DiffEngine {
  private readonly filePatchMaxBytes: number
  private readonly totalPatchMaxBytes: number

  constructor(
    private readonly git: GitRunner,
    private readonly workspace: WorkspaceResolver,
    options: DiffEngineOptions = {},
  ) {
    this.filePatchMaxBytes = options.filePatchMaxBytes ?? DIFF_FILE_PATCH_MAX_BYTES
    this.totalPatchMaxBytes = options.totalPatchMaxBytes ?? DIFF_TOTAL_PATCH_MAX_BYTES
  }

  /**
   * 工作区 / 暂存双路 diff（spec §1.2 [清单 2/3/59]）。
   * scope='worktree'：worktree numstat+name-status 双路 + untracked（no-index）；
   * scope='staged'：--cached 双路，untracked 不在 staged（[清单 3]「已暂存将要提交什么」）。
   * @param path null = 该 scope 全部变更文件（预算内）；给定 = 单文件
   *   （不在任何变更集合内 ⇒ files: []）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/git-error、
   *   git/timeout（listing 失败炸整体；单文件 patch 失败降级 patch:null）。
   */
  async diff(scope: DiffScope, path: string | null, signal?: AbortSignal): Promise<DiffResult> {
    const repoRoot = await this.resolveRepoRoot('diff', signal)
    const active = signal ?? neverAborted()
    const cachedFlags = scope === 'staged' ? ['--cached'] as const : [] as const
    const pathTail = path !== null ? ['--', path] as const : ['--'] as const

    // listing 双路并发（ZCode numstat 双路的并发形态 + opencode name-status/numstat
    // 拼装语义对照，SOURCES.md:68）：name-status 定 status/origPath，numstat 定
    // counts/binary（[清单 59] 的 binary 判定权威）。
    const [numstatResult, nameStatusResult] = await Promise.all([
      this.git.run(['diff', ...cachedFlags, '--numstat', '-z', '--find-renames', ...pathTail], {
        cwd: repoRoot, op: `diff(${scope} numstat)`, signal: active,
      }),
      this.git.run(['diff', ...cachedFlags, '--name-status', '-z', '--find-renames', ...pathTail], {
        cwd: repoRoot, op: `diff(${scope} name-status)`, signal: active,
      }),
    ])
    assertGitOk(numstatResult, `diff(${scope} numstat)`)
    assertGitOk(nameStatusResult, `diff(${scope} name-status)`)
    const files = assembleDiffFiles(
      parseNameStatus(nameStatusResult.stdout),
      numstatCounts(parseNumstat(numstatResult.stdout)),
    )

    // untracked 仅 worktree scope（spec §1.2 untracked 段）。单文件且已在 tracked
    // listing 里 ⇒ 跳过 untracked 探测（一个路径不可能同时 tracked 与 untracked）。
    const untrackedPaths = new Set<string>()
    if (scope === 'worktree') {
      const found = path !== null && files.some(file => file.path === path)
        ? []
        : await this.listUntracked(repoRoot, path, active)
      for (const untrackedPath of found) {
        untrackedPaths.add(untrackedPath)
        files.push({
          path: untrackedPath,
          origPath: null,
          status: 'added',
          binary: false,
          additions: null,
          deletions: null,
          patch: null,
          patchTruncated: false,
          oversized: false,
        })
      }
    }

    const totalTruncated = await this.fillPatches(files, (file) => {
      return untrackedPaths.has(file.path)
        ? untrackedPatchCommand(file.path)
        : trackedPatchCommand(scope === 'staged', file.path)
    }, repoRoot, active)

    return { scope, path, files, totalTruncated, generatedAt: new Date().toISOString() }
  }

  /**
   * 提交 diff（spec §1.8 show 的 patch 半 [清单 33]；workflow 任务口径：merge 按第一父
   * 对比、根提交 --root）。返回 CommitDetail 的 files/totalTruncated，commit 元数据由
   * show 接线模块并入。
   * @param commitId 全 oid 或任意 rev-list 可解析的修订。
   * @param path null = 该提交全部变更文件（预算内）；给定 = 单文件（不在提交内 ⇒ []）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/git-error
   *   （rev-list 128 = 修订不存在）、git/timeout。
   */
  async commitDiff(commitId: string, path: string | null, signal?: AbortSignal): Promise<CommitDiffResult> {
    const repoRoot = await this.resolveRepoRoot('commitDiff', signal)
    const active = signal ?? neverAborted()

    const parentsResult = await this.git.run(['rev-list', '--parents', '-n', '1', commitId], {
      cwd: repoRoot, op: 'commitDiff(rev-list --parents)', signal: active,
    })
    assertGitOk(parentsResult, 'commitDiff(rev-list --parents)')
    const tokens = parentsResult.stdout.trim().split(/\s+/).filter(token => token !== '')
    const firstParent = tokens.length > 1 ? (tokens[1] as string) : null
    const pathTail = path !== null ? ['--', path] as const : [] as const

    // listing 双路：非根提交（含 merge）= 两树形态 `git diff <p1> <oid>`（merge 即第一父，
    // 实测修订 3）；根提交 = `git diff-tree --root`（任务口径；实测 --numstat/-p 均需
    // -r 递归与 --no-commit-id 抑制首行 oid 记录）。
    const numstatArgs = firstParent !== null
      ? ['diff', firstParent, commitId, '--numstat', '-z', '--find-renames', '--', ...pathTail]
      : ['diff-tree', '--root', '-r', '--numstat', '-z', '--no-commit-id', '--find-renames', commitId, ...pathTail]
    const nameStatusArgs = firstParent !== null
      ? ['diff', firstParent, commitId, '--name-status', '-z', '--find-renames', '--', ...pathTail]
      : ['diff-tree', '--root', '-r', '--name-status', '-z', '--no-commit-id', '--find-renames', commitId, ...pathTail]
    const opSuffix = firstParent !== null ? 'first-parent' : 'root'
    const [numstatResult, nameStatusResult] = await Promise.all([
      this.git.run(numstatArgs, { cwd: repoRoot, op: `commitDiff(numstat ${opSuffix})`, signal: active }),
      this.git.run(nameStatusArgs, { cwd: repoRoot, op: `commitDiff(name-status ${opSuffix})`, signal: active }),
    ])
    assertGitOk(numstatResult, `commitDiff(numstat ${opSuffix})`)
    assertGitOk(nameStatusResult, `commitDiff(name-status ${opSuffix})`)
    const files = assembleDiffFiles(
      parseNameStatus(nameStatusResult.stdout),
      numstatCounts(parseNumstat(numstatResult.stdout)),
    )

    const totalTruncated = await this.fillPatches(files, (file) => {
      const op = `commitDiff(patch ${opSuffix} ${file.path})`
      return firstParent !== null
        ? {
            argv: ['diff', firstParent, commitId, '--no-ext-diff', '--unified=3', '--find-renames', '--', file.path],
            op,
            allowedExitCodes: EXIT_OK_ONLY,
          }
        : {
            argv: ['diff-tree', '--root', '-r', '-p', '--no-commit-id', '--no-ext-diff', '--unified=3',
              '--find-renames', commitId, '--', file.path],
            op,
            allowedExitCodes: EXIT_OK_ONLY,
          }
    }, repoRoot, active)

    return { files, totalTruncated }
  }

  /**
   * repo 发现（dsh forge git.ts:99-103 范式，status.ts 同款再应用）：
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

  /** untracked 枚举（--others --exclude-standard = 非 ignored 未跟踪，[清单 5] 同语义）。 */
  private async listUntracked(repoRoot: string, path: string | null, signal: AbortSignal): Promise<string[]> {
    const result = await this.git.run(
      ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(path !== null ? [path] : [])],
      { cwd: repoRoot, op: 'diff(ls-files untracked)', signal },
    )
    assertGitOk(result, 'diff(ls-files untracked)')
    return result.stdout.split('\0').filter(record => record !== '')
  }

  /**
   * 预算环：按 listing 序为每个非 binary 文件取 patch，回填 patch/patchTruncated/
   * oversized 三字段。返回 totalTruncated（「想要 patch 而未取得」文件是否出现——
   * 含预算耗尽后的跳过；binary/oversized 文件零预算消耗，不触发）。
   * 单文件失败（exit ∉ 白名单 / runner 抛错）⇒ patch:null 继续整体（spec §1.2）；
   * 调用方 signal 取消穿透不吞（runPatch）。
   */
  private async fillPatches(
    files: DiffFile[],
    build: (file: DiffFile) => PatchCommand,
    repoRoot: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let remaining = this.totalPatchMaxBytes
    let totalTruncated = false
    for (const file of files) {
      if (file.binary) continue // numstat '-' ⇒ patch:null（[清单 59]，listing 阶段已定）
      const command = build(file)
      if (remaining <= 0) {
        totalTruncated = true
        continue
      }
      const outcome = await this.runPatch(command, repoRoot, signal)
      if (outcome.outcome === 'truncated') {
        // runner maxBytes = 单文件上限下截断 ⇒ 全量 patch 超上限（实测手段，见类注）。
        file.oversized = true
        file.patchTruncated = true
        file.patch = null
        continue
      }
      if (outcome.outcome === 'failed') {
        file.patch = null
        continue
      }
      if (command.untracked === true) {
        const analysis = analyzeUntrackedPatch(outcome.text)
        file.binary = analysis.binary
        file.additions = analysis.additions
        file.deletions = analysis.deletions
        file.patch = analysis.patch
        if (analysis.patch !== null) remaining -= Buffer.byteLength(analysis.patch, 'utf8')
        continue
      }
      file.patch = outcome.text
      remaining -= Buffer.byteLength(outcome.text, 'utf8')
    }
    return totalTruncated
  }

  /** 单条 patch 命令的软失败执行（白名单 + 截断判别；caller 取消必须穿透）。 */
  private async runPatch(command: PatchCommand, repoRoot: string, signal: AbortSignal): Promise<PatchOutcome> {
    let result: GitRunResult
    try {
      result = await this.git.run(command.argv, {
        cwd: repoRoot,
        op: command.op,
        signal,
        maxBytes: this.filePatchMaxBytes,
      })
    } catch (cause) {
      if (signal.aborted) throw cause // 调用方取消必须传播，不能折叠成 patch:null
      return { outcome: 'failed' }
    }
    if (result.exitCode === null || !command.allowedExitCodes.includes(result.exitCode)) {
      return { outcome: 'failed' }
    }
    if (result.truncated) return { outcome: 'truncated' }
    return { outcome: 'ok', text: result.stdout }
  }
}

/** tracked 单文件 patch 命令（spec §1.2 形态；--literal-pathspecs 非法已实测——
 * 字面量由 runner env 保证；--find-renames 使重命名条目产出 rename from/to 补丁头）。 */
function trackedPatchCommand(cached: boolean, path: string): PatchCommand {
  return {
    argv: [
      'diff',
      ...(cached ? ['--cached'] : []),
      '--no-ext-diff',
      '--unified=3',
      '--find-renames',
      '--',
      path,
    ],
    op: `diff(patch ${path})`,
    allowedExitCodes: EXIT_OK_ONLY,
  }
}

/**
 * untracked 单文件 patch 命令（spec §1.2 untracked 段原文形态）：恰好一个 `--`，
 * 紧邻文件路径；`/dev/null` 作为空侧真实路径参数（Git for Windows 实测通过）。
 * exit 1 = 有差异仍成功（NO_INDEX_ALLOWED_EXIT_CODES）；双 `--` 形态 exit 129
 * （diff.spec 回归守卫钉死本形态）。
 */
function untrackedPatchCommand(path: string): PatchCommand {
  return {
    argv: ['diff', '--no-index', '--unified=3', '/dev/null', '--', path],
    op: `diff(no-index ${path})`,
    allowedExitCodes: NO_INDEX_ALLOWED_EXIT_CODES,
    untracked: true,
  }
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
