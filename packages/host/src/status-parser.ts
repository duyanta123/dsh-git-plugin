/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/repo/gitCliRepo.ts（status v2 -z 命令形态 :546-552 与
 *         并发 numstat 双路 :871-892 的编排契约——解析函数本体的 gitCliHelpers.ts 未在
 *         本地参考库（research/ported-sources/SOURCES.md 只抓取 gitCliRepo.ts），porcelain
 *         v2 解析按 spec §1.1 自研，record 字节形状以本机 git 2.55.0.windows.2 实测为准：
 *         1/2/u/?/!/# 六种 record、v2 XY 未变更记 '.'、格式 2 原路径走独立 NUL 段）
 * Ported from cline/cline@f817e59f698f01487920c00ede2dbecad5c0fa50
 *   path: apps/examples/desktop-app/sidecar/source-control.ts:99-164（porcelain v1 解析器
 *         ——v1 回退段的范本：NUL 记录扫描、## 头正则、"No commits yet on "/"HEAD (no
 *         branch)"、重命名原路径吃下一记录、AA/DD/U* 冲突判定、binary '-'）
 * Ported from deepseek-ai/deepseek-harness (dsh 树)
 *   path: packages/deliverables/workspace-changes/src/numstat.ts:20-52（parseNumstat：
 *         -z 记录解析、重命名三段记录、binary '-'、非 NUL 结尾即抛）
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd; Copyright 2026 Cline Bot Inc.
 *           （numstat 段 MIT — Copyright (c) DeepSeek，dsh 源码树许可）
 * Modifications: 2026-10-31（⑤ status 引擎模块）—— v1 解析器改产出本包统一 ParsedStatus
 *   形状（含 sub/recordType），v1 的 [gone] upstream 剥离为新增；v2 解析为自研终态；
 *   numstat 的 diff-tree 参数改为 diff --numstat（spec §1.1），输出契约一致。
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @dsh-plugin/git — status 解析纯函数（无 IO、无时钟；spec §1.1 的 porcelain v2 -z 终态
 * + §5.1 登记的 v1 回退段 + 并发 numstat 双路的解析与合并视图装配）。
 *
 * 实测依据（本机 git 2.55.0.windows.2，win32 临时仓库，2026-10-31）：
 *   - v2 record：`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`、
 *     `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>`、
 *     `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`、`? <path>`、`! <path>`；
 *     v2 的 XY 未变更记 '.'（' ' 兼容接受）；-z 下路径原样字节、不加引号（中文/空格安全）。
 *   - 头部：`# branch.oid <oid|(initial)>`、`# branch.head <name|(detached)>`、
 *     `# branch.upstream <short>`（仅有 upstream 时）、`# branch.ab +<ahead> -<behind>`（同前）。
 *   - numstat -z：`<add>\t<del>\t<path>\0`；重命名三段 `<add>\t<del>\t\0<old>\0<new>\0`；
 *     binary 报 `-\t-\t<path>\0`；输出恒以 \0 结尾。
 *   - 默认 porcelain 不列 ignored（[清单 5]）；`!` record 仅在 --ignored 下出现，解析器
 *     兼容处理（进 ignored，不进任何分组）。
 */

import type { BranchState, ChangeKind, FileChange, GitStatusSnapshot } from './types.ts'

/** 七种 unmerged XY 码（spec §1.0.3 conflicted 定义；v1/v2 同码表）。 */
export const UNMERGED_CODES: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** porcelain 头部解析结果（v1 回退无 oid，恒 null）。 */
export interface ParsedStatusHeader {
  /** branch.oid；'(initial)'（unborn）或 v1 下为 null。 */
  oid: string | null
  /** branch.head；'(detached)' 时 null。 */
  head: string | null
  /** branch.upstream 短名；未设置 null。 */
  upstream: string | null
  /** 无 upstream 时 null。 */
  ahead: number | null
  behind: number | null
  detached: boolean
  /** branch.oid (initial) / v1 "No commits yet on"。 */
  unborn: boolean
}

/** 条目 record 类型（v2 六种 record 的条目子集；'!' 不进 entries，见 {@link ParsedStatus.ignored}）。 */
export type PorcelainRecordType = '1' | '2' | 'u' | '?'

/** 一条 status 条目的原始解析视图（分组装配前的中间形状）。 */
export interface ParsedStatusEntry {
  recordType: PorcelainRecordType
  /** -z 下原样路径（中文/空格安全）。 */
  path: string
  /** 格式 2（重命名/复制）的原路径；其余 null。 */
  origPath: string | null
  /** porcelain XY 首位（index 侧）；untracked 记 '?'。 */
  x: string
  /** porcelain XY 次位（worktree 侧）。 */
  y: string
  /** submodule 状态字段；非 'N' 开头 ⇒ gitlink/submodule（v1 回退恒 'N...'）。 */
  sub: string
}

/** 一次 porcelain 解析的全部产出（ignored 仅在 --ignored 下非空，v1 为 '!!' 行）。 */
export interface ParsedStatus {
  header: ParsedStatusHeader
  entries: ParsedStatusEntry[]
  ignored: string[]
}

const INITIAL_OID = '(initial)'
const DETACHED_HEAD = '(detached)'

/**
 * 解析 `git status --porcelain=v2 --branch --untracked-files=all -z` 的 stdout（终态解析器）。
 * 未知 record 类型静默跳过（向前兼容 git 新增 record）；已知 record 字段数不足 ⇒ 抛错
 * （契约破坏要响，不静默吞——与 dsh parseNumstat 的 malformed 语义一致）。
 */
export function parsePorcelainV2(stdout: string): ParsedStatus {
  const header: ParsedStatusHeader = {
    oid: null, head: null, upstream: null, ahead: null, behind: null, detached: false, unborn: false,
  }
  const entries: ParsedStatusEntry[] = []
  const ignored: string[] = []
  const records = stdout.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as string
    if (record === '') continue
    if (record.startsWith('#')) {
      applyHeaderLine(header, record)
      continue
    }
    const kind = record.slice(0, record.indexOf(' '))
    if (kind === '1') {
      // token 布局：'1' | XY（单 token 双字符）| sub | mH mI mW | hH hI | path…
      const t = record.split(' ')
      if (t.length < 9) throw new Error(`malformed porcelain v2 record: ${record}`)
      entries.push({
        recordType: '1',
        x: (t[1] as string)[0] as string,
        y: (t[1] as string)[1] as string,
        sub: t[2] as string,
        origPath: null,
        path: t.slice(8).join(' '),
      })
      continue
    }
    if (kind === '2') {
      // token 布局：'2' | XY | sub | mH mI mW | hH hI | X<score> | path…
      const t = record.split(' ')
      if (t.length < 10) throw new Error(`malformed porcelain v2 record: ${record}`)
      // 格式 2 的 origPath 是「本记录后紧随的独立 NUL 段」，必须一并消费。
      const origPath = records[index + 1]
      if (origPath === undefined || origPath === '') throw new Error(`malformed porcelain v2 rename record: ${record}`)
      index += 1
      entries.push({
        recordType: '2',
        x: (t[1] as string)[0] as string,
        y: (t[1] as string)[1] as string,
        sub: t[2] as string,
        origPath,
        path: t.slice(9).join(' '),
      })
      continue
    }
    if (kind === 'u') {
      // token 布局：'u' | XY | sub | m1 m2 m3 mW | h1 h2 h3 | path…
      const t = record.split(' ')
      if (t.length < 11) throw new Error(`malformed porcelain v2 record: ${record}`)
      entries.push({
        recordType: 'u',
        x: (t[1] as string)[0] as string,
        y: (t[1] as string)[1] as string,
        sub: t[2] as string,
        origPath: null,
        path: t.slice(10).join(' '),
      })
      continue
    }
    if (kind === '?') {
      const t = record.split(' ')
      if (t.length < 2) throw new Error(`malformed porcelain v2 record: ${record}`)
      entries.push({ recordType: '?', x: '?', y: '?', sub: 'N...', origPath: null, path: t.slice(1).join(' ') })
      continue
    }
    if (kind === '!') {
      ignored.push(record.slice(2))
      continue
    }
    // 未知 record 类型：向前兼容跳过。
  }
  return { header, entries, ignored }
}

/** `# …` 头部行按键落位；未知键忽略（如 --show-stash 的 `# stash N`）。 */
function applyHeaderLine(header: ParsedStatusHeader, line: string): void {
  // 行形如 '# branch.oid <v>'：'# ' 前缀之后到第二个空格之间是键（'#' 后那个空格是前缀的一部分）。
  const first = line.indexOf(' ', 2)
  if (first < 0) return
  const key = line.slice(2, first)
  const value = line.slice(first + 1)
  if (key === 'branch.oid') {
    if (value === INITIAL_OID) {
      header.oid = null
      header.unborn = true
    } else {
      header.oid = value
    }
    return
  }
  if (key === 'branch.head') {
    if (value === DETACHED_HEAD) {
      header.head = null
      header.detached = true
    } else {
      header.head = value
    }
    return
  }
  if (key === 'branch.upstream') {
    header.upstream = value === '' ? null : value
    return
  }
  if (key === 'branch.ab') {
    const match = /^\+(\d+) -(\d+)$/.exec(value)
    if (match !== null) {
      header.ahead = Number(match[1])
      header.behind = Number(match[2])
    }
    return
  }
}

/**
 * porcelain v1 回退解析器（`git status --porcelain -z --branch --untracked-files=all`）。
 * Ported from cline/cline source-control.ts:99-164（范本；Modifications 见文件头）。
 * 触发条件见 StatusEngine：本机 git 不支持 --porcelain=v2（exit 129/128 + stderr 含
 * porcelain）时使用。v1 无 oid/sub 信息。
 */
export function parsePorcelainV1(stdout: string): ParsedStatus {
  const header: ParsedStatusHeader = {
    oid: null, head: null, upstream: null, ahead: null, behind: null, detached: false, unborn: false,
  }
  const entries: ParsedStatusEntry[] = []
  const ignored: string[] = []
  const records = stdout.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as string
    if (record === '') continue
    if (record.startsWith('## ')) {
      applyV1HeaderLine(header, record.slice(3))
      continue
    }
    if (record.length < 4) continue
    const x = record[0] as string
    const y = record[1] as string
    const path = record.slice(3)
    if (x === '?' && y === '?') {
      entries.push({ recordType: '?', x, y, sub: 'N...', origPath: null, path })
      continue
    }
    if (x === '!' && y === '!') {
      ignored.push(path)
      continue
    }
    // Renames and copies carry the original path in the next record. Only
    // renames keep it: unstaging a copy must not touch its source file.
    const hasOrigin = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    const origin = hasOrigin ? records[++index] : undefined
    const origPath = x === 'R' || y === 'R' ? origin ?? null : null
    entries.push({ recordType: '1', x, y, sub: 'N...', origPath, path })
  }
  return { header, entries, ignored }
}

/** v1 `##` 头：`<branch>[...<upstream>][ [ahead N][, behind M]]`；"No commits yet on X" /
 * "HEAD (no branch)" 语义 + [gone] upstream 剥离（新增修改点）。 */
function applyV1HeaderLine(header: ParsedStatusHeader, line: string): void {
  const goneStripped = line.endsWith(' [gone]') ? line.slice(0, -' [gone]'.length) : line
  const match = /^(.+?)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?$/.exec(goneStripped)
  if (match === null) return
  const branch = match[1] as string
  if (branch.startsWith('No commits yet on ')) {
    header.head = branch.slice('No commits yet on '.length)
    header.unborn = true
  } else if (branch === 'HEAD (no branch)') {
    header.head = null
    header.detached = true
  } else {
    header.head = branch
  }
  header.upstream = match[2] ?? null
  header.ahead = match[3] === undefined ? null : Number(match[3])
  header.behind = match[4] === undefined ? null : Number(match[4])
}

// ---------- numstat（dsh workspace-changes numstat.ts 移植段） ----------

/** 一条 `--numstat` 记录；path 为仓库根相对、斜杠分隔。 */
export interface NumstatEntry {
  path: string
  /** 重命名检测到的原路径；路径不变时缺省。 */
  oldPath?: string
  added: number
  deleted: number
  binary: boolean
}

/** numstat 合并索引的值（FileChange 的 additions/deletions/binary 来源）。 */
export interface NumstatCounts {
  additions: number
  deletions: number
  binary: boolean
}

/**
 * Parse NUL-terminated numstat records. A rename record carries an empty path
 * followed by the old and new paths.
 * @param output - complete stdout of `git diff --numstat -z --find-renames`。
 * @returns records in git's output order.
 * @throws when a record is malformed, which indicates truncated output.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('numstat output is not NUL-terminated')
  queue.pop()
  const entries: NumstatEntry[] = []
  while (queue.length > 0) {
    const record = queue.shift() as string
    // Only the first two tabs separate fields; a file name keeps its own tabs.
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) throw new Error(`malformed numstat record: ${record}`)
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    let target = path
    let oldPath: string | undefined
    if (target === '') {
      oldPath = queue.shift()
      const renamed = queue.shift()
      if (oldPath === undefined || renamed === undefined) throw new Error('malformed numstat rename record')
      target = renamed
    }
    const binary = added === '-'
    entries.push({
      path: target,
      ...oldPath === undefined ? {} : { oldPath },
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return entries
}

/** numstat 记录 → 按新路径索引的计数表（重命名按新路径键，与 porcelain 条目 path 对齐）。 */
export function numstatCounts(entries: readonly NumstatEntry[]): Map<string, NumstatCounts> {
  const counts = new Map<string, NumstatCounts>()
  for (const entry of entries) {
    counts.set(entry.path, { additions: entry.added, deletions: entry.deleted, binary: entry.binary })
  }
  return counts
}

// ---------- 分组装配（spec §1.0.3 分组规则） ----------

export interface StatusAssembleInput {
  repoRoot: string
  /** ISO 时间戳（host 打点）。 */
  generatedAt: string
  parsed: ParsedStatus
  /** `git diff --cached --numstat` 的计数表。 */
  stagedStats: ReadonlyMap<string, NumstatCounts>
  /** `git diff --numstat`（worktree）的计数表。 */
  unstagedStats: ReadonlyMap<string, NumstatCounts>
}

/** XY 的「未变更」位（v2 用 '.'，' ' 兼容；'?'/'!' 有专属分组）。 */
const UNMODIFIED = new Set(['.', ' '])

/**
 * 把 porcelain 解析结果与 numstat 双路合并为 GitStatusSnapshot。
 *
 * 分组规则（spec §1.0.3 注释，实测 '.' 形态）：
 *   - untracked = record '?'；ignored 不进任何组（默认 porcelain 不列 ignored）；
 *   - staged = X ∉ {'.','?'}；unstaged = Y ∉ {'.','!'}；unmerged（七码）恒同时落
 *     staged+unstaged+conflicted（DD/AU/UD/UA/DU/AA/UU 的 X/Y 都非未变更位）；
 *   - additions/deletions/binary 取 numstat：有 worktree 侧记录用之，否则用 staged 侧
 *     （同一 MM/RM 文件两路都有：以 worktree 视图为先——diff() 的默认 scope）；
 *     untracked 无 numstat 记录 ⇒ null/false。
 */
export function assembleStatus(input: StatusAssembleInput): GitStatusSnapshot {
  const { repoRoot, generatedAt, parsed, stagedStats, unstagedStats } = input
  const staged: FileChange[] = []
  const unstaged: FileChange[] = []
  const untracked: FileChange[] = []
  const conflicted: FileChange[] = []
  for (const entry of parsed.entries) {
    const change = toFileChange(entry, stagedStats, unstagedStats)
    const xy = entry.x + entry.y
    const isConflicted = UNMERGED_CODES.has(xy)
    if (isConflicted) conflicted.push(change)
    if (entry.recordType === '?') {
      untracked.push(change)
      continue
    }
    if (!UNMODIFIED.has(entry.x) && entry.x !== '?') staged.push(change)
    if (!UNMODIFIED.has(entry.y) && entry.y !== '!' && entry.y !== '?') unstaged.push(change)
  }
  return {
    repoRoot,
    generatedAt,
    branch: toBranchState(parsed.header),
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && conflicted.length === 0,
  }
}

function toFileChange(
  entry: ParsedStatusEntry,
  stagedStats: ReadonlyMap<string, NumstatCounts>,
  unstagedStats: ReadonlyMap<string, NumstatCounts>,
): FileChange {
  // untracked 无 numstat 记录；其余优先 worktree 侧、回落 staged 侧（见 assembleStatus 注）。
  const counts = entry.recordType === '?'
    ? undefined
    : unstagedStats.get(entry.path) ?? stagedStats.get(entry.path)
  return {
    path: entry.path,
    origPath: entry.origPath,
    kind: kindOf(entry),
    x: entry.x,
    y: entry.y,
    conflicted: UNMERGED_CODES.has(entry.x + entry.y),
    binary: counts?.binary ?? false,
    additions: counts?.additions ?? null,
    deletions: counts?.deletions ?? null,
    submodule: !entry.sub.startsWith('N'),
  }
}

/** 条目 → ChangeKind：untracked 专属；格式 2 按 R/C；其余取第一个有意义的侧码
 * （T/typechange 折叠进 modified——spec ChangeKind 无该值；'U' 是 unmerged 位、不承载
 * kind 语义，跳过取另一侧——AU/UA→added、UD/DU→deleted，UU 双 U → modified 兜底）。 */
function kindOf(entry: ParsedStatusEntry): ChangeKind {
  if (entry.recordType === '?') return 'untracked'
  if (entry.origPath !== null) {
    if (entry.x === 'R' || entry.y === 'R') return 'renamed'
    return 'copied'
  }
  for (const code of [entry.x, entry.y]) {
    if (code === '.' || code === ' ' || code === '?' || code === '!' || code === 'U') continue
    if (code === 'A') return 'added'
    if (code === 'D') return 'deleted'
    if (code === 'R') return 'renamed'
    if (code === 'C') return 'copied'
    return 'modified' // M/T 及未知码
  }
  return 'modified'
}

function toBranchState(header: ParsedStatusHeader): BranchState {
  const hasUpstream = header.upstream !== null
  return {
    name: header.detached ? null : header.head,
    oid: header.oid,
    abbrevOid: header.oid === null ? null : header.oid.slice(0, 7),
    upstream: header.upstream,
    ahead: hasUpstream ? header.ahead : null,
    behind: hasUpstream ? header.behind : null,
    detached: header.detached,
    unborn: header.unborn,
  }
}
