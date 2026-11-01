/**
 * M2 — status 解析器快照夹具测试（spec §⑥ status.spec 行的纯函数半）。
 *
 * 夹具 = 本机 git 2.55.0.windows.2（win32 临时仓库）实测字节（2026-10-31 采集，
 * 见 status-parser.ts 头注）：中文/空格路径、格式 2 重命名双段、七种 unmerged（DD/AU/
 * UD/UA/DU/AA/UU 手工 stage 构造 + 实测字节）、untracked/ignored 区分、branch.ab、
 * detached、unborn (initial)、submodule S 字段、numstat -z 三形态（binary/重命名三段/
 * 普通条目）、porcelain v1 回退段（Cline 范本）。
 */

import { describe, expect, it } from 'vitest'
import {
  assembleStatus,
  numstatCounts,
  parseNumstat,
  parsePorcelainV1,
  parsePorcelainV2,
} from '../src/status-parser.ts'
import type { NumstatCounts, ParsedStatusEntry } from '../src/status-parser.ts'
import type { FileChange } from '../src/types.ts'

/** 夹具组装：NUL 记录序列（终尾补 \0，与 git -z 输出一致）。 */
function nul(...records: string[]): string {
  return `${records.join('\0')}\0`
}

const EMPTY_STATS = new Map<string, NumstatCounts>()

function entryOf(parsed: { entries: ParsedStatusEntry[] }, path: string): ParsedStatusEntry {
  const entry = parsed.entries.find(candidate => candidate.path === path)
  if (entry === undefined) throw new Error(`fixture entry missing: ${path}`)
  return entry
}

function changeOf(snapshot: { staged: FileChange[]; unstaged: FileChange[]; untracked: FileChange[]; conflicted: FileChange[] }, path: string): FileChange {
  const all = [...snapshot.staged, ...snapshot.unstaged, ...snapshot.untracked, ...snapshot.conflicted]
  const change = all.find(candidate => candidate.path === path)
  if (change === undefined) throw new Error(`snapshot entry missing: ${path}`)
  return change
}

// 本机实测：renamed file.txt（空格）/ 中文路径.txt / untracked（od -c 逐字节抄录）。
const MIXED_V2 = nul(
  '# branch.oid f39ba7b20391929c235f5fb4d9a2f35dde3360cb',
  '# branch.head main',
  '2 R. N... 100644 100644 100644 422c2b7ab3b3c668038da977e4e93a5fc623169c 422c2b7ab3b3c668038da977e4e93a5fc623169c R100 renamed file.txt',
  'hello world.txt',
  '1 .M N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb 中文路径.txt',
  '? .gitignore',
  '? untracked.txt',
)

// 本机实测：手工 stage 组合（update-index --index-info）造出七种 unmerged 的真实输出。
const SEVEN_UNMERGED_V2 = nul(
  '# branch.oid (initial)',
  '# branch.head main',
  'u AA N... 000000 100644 100644 100644 0000000000000000000000000000000000000000 b19a1e93bec1317dc6097229e12afaffbfa74dc2 950b81b7eee953d050aa05a641f8e056c85dd1bd f_aa',
  'u AU N... 000000 100644 000000 100644 0000000000000000000000000000000000000000 b19a1e93bec1317dc6097229e12afaffbfa74dc2 0000000000000000000000000000000000000000 f_au',
  'u DD N... 100644 000000 000000 000000 df967b96a579e45a18b8251732d16804b2e56a55 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 f_dd',
  'u DU N... 100644 000000 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 0000000000000000000000000000000000000000 950b81b7eee953d050aa05a641f8e056c85dd1bd f_du',
  'u UA N... 000000 000000 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 950b81b7eee953d050aa05a641f8e056c85dd1bd f_ua',
  'u UD N... 100644 100644 000000 100644 df967b96a579e45a18b8251732d16804b2e56a55 b19a1e93bec1317dc6097229e12afaffbfa74dc2 0000000000000000000000000000000000000000 f_ud',
  'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 b19a1e93bec1317dc6097229e12afaffbfa74dc2 950b81b7eee953d050aa05a641f8e056c85dd1bd f_uu',
)

const HEADERS_AB = nul(
  '# branch.oid a85d6e480744f9b68b29e82b029a481398ff6ed4',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
)

// 本机实测：远端领先一提交（fetch 后 origin/main 前移）+ 本地两空提交。
const HEADERS_AHEAD_BEHIND = nul(
  '# branch.oid 4c33073cc913ac713598e9acf06237a78424cc4c',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
)

const DETACHED_V2 = nul(
  '# branch.oid 4ec20f55029a9282aaf29c7d53a5ce7cf3d9e262',
  '# branch.head (detached)',
)

// 本机实测：--ignored=matching 下的 `!` record（默认 porcelain 不列 ignored——解析器兼容面）。
const IGNORED_V2 = nul(
  '1 .M N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb a.txt',
  '! ign.txt',
)

// 本机实测：git add 嵌套仓库（gitlink）的 S 字段 record。
const SUBMODULE_V2 = nul(
  '1 A. S... 000000 160000 160000 0000000000000000000000000000000000000000 c5f2336891e352a34b01425f8a7b49a65cf15b86 sub',
)

// 本机实测：MM 双侧修改（staged+worktree 同文件）。
const BOTH_SIDES_V2 = nul(
  '1 MM N... 100644 100644 100644 4cb29ea38f70d7c61b2a3a25b02e3bdf44905402 943f5f058704102b611b7739817ab09d894cffe1 both.txt',
)

// 本机实测 numstat -z：binary '-'、重命名三段（0\t0\t\0old\0new\0）、普通条目。
// （用 nul() 组装——字面量里 \0 后接数字会被 JS 当八进制转义吃掉，实测踩坑。）
const NUMSTAT_MIXED = nul('-\t-\tbin.dat', '0\t0\t', 'old.txt', 'new.txt', '1\t0\tnew.txt')

// 本机实测 porcelain v1 -z（真 merge 冲突 AA 场景 + untracked）。
const MIXED_V1 = nul('## main', 'AA c.txt', '?? .gitignore', '?? new untracked.txt')

describe('parsePorcelainV2（终态解析器）', () => {
  it('混合夹具：重命名双段（格式 2 + 独立 NUL 原路径段）、中文路径原样、untracked ?', () => {
    const parsed = parsePorcelainV2(MIXED_V2)
    expect(parsed.header).toEqual({
      oid: 'f39ba7b20391929c235f5fb4d9a2f35dde3360cb',
      head: 'main',
      upstream: null,
      ahead: null,
      behind: null,
      detached: false,
      unborn: false,
    })
    expect(parsed.entries).toHaveLength(4)
    expect(entryOf(parsed, 'renamed file.txt')).toEqual({
      recordType: '2', x: 'R', y: '.', sub: 'N...',
      path: 'renamed file.txt', origPath: 'hello world.txt',
    })
    expect(entryOf(parsed, '中文路径.txt')).toEqual({
      recordType: '1', x: '.', y: 'M', sub: 'N...',
      path: '中文路径.txt', origPath: null,
    })
    expect(entryOf(parsed, '.gitignore').recordType).toBe('?')
    expect(entryOf(parsed, 'untracked.txt')).toMatchObject({ x: '?', y: '?' })
    expect(parsed.ignored).toEqual([])
  })

  it('七种 unmerged record（u 类型）：全部进 conflicted，且 XY 非未变更位 → staged/unstaged 同落', () => {
    const snapshot = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed: parsePorcelainV2(SEVEN_UNMERGED_V2),
      stagedStats: EMPTY_STATS, unstagedStats: EMPTY_STATS,
    })
    expect(snapshot.branch.unborn).toBe(true)
    expect(snapshot.branch.oid).toBeNull()
    expect(snapshot.conflicted.map(change => change.path).sort()).toEqual([
      'f_aa', 'f_au', 'f_dd', 'f_du', 'f_ua', 'f_ud', 'f_uu',
    ])
    expect(snapshot.staged).toHaveLength(7)
    expect(snapshot.unstaged).toHaveLength(7)
    expect(snapshot.untracked).toEqual([])
    expect(snapshot.clean).toBe(false)
    // kind 映射：AU/UA→added（首个有意义侧码），DD/DU/UD→deleted，UU→modified 兜底。
    expect(changeOf(snapshot, 'f_au').kind).toBe('added')
    expect(changeOf(snapshot, 'f_ua').kind).toBe('added')
    expect(changeOf(snapshot, 'f_dd').kind).toBe('deleted')
    expect(changeOf(snapshot, 'f_du').kind).toBe('deleted')
    expect(changeOf(snapshot, 'f_ud').kind).toBe('deleted')
    expect(changeOf(snapshot, 'f_uu').kind).toBe('modified')
    // conflicted 标志七码全真；XY 原样保留。
    for (const path of ['f_aa', 'f_au', 'f_dd', 'f_du', 'f_ud', 'f_uu', 'f_ua']) {
      expect(changeOf(snapshot, path).conflicted).toBe(true)
    }
    expect(changeOf(snapshot, 'f_uu')).toMatchObject({ x: 'U', y: 'U', submodule: false })
  })

  it('branch 头：branch.ab +N -M 与 upstream（ahead/behind）', () => {
    expect(parsePorcelainV2(HEADERS_AB).header).toMatchObject({
      upstream: 'origin/main', ahead: 1, behind: 0, detached: false, unborn: false,
    })
    const snapshot = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed: parsePorcelainV2(HEADERS_AHEAD_BEHIND),
      stagedStats: EMPTY_STATS, unstagedStats: EMPTY_STATS,
    })
    expect(snapshot.branch).toEqual({
      name: 'main',
      oid: '4c33073cc913ac713598e9acf06237a78424cc4c',
      abbrevOid: '4c33073',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      detached: false,
      unborn: false,
    })
  })

  it('detached：branch.head (detached) → name null / detached true；abbrevOid 取 oid 前 7 位', () => {
    const snapshot = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed: parsePorcelainV2(DETACHED_V2),
      stagedStats: EMPTY_STATS, unstagedStats: EMPTY_STATS,
    })
    expect(snapshot.branch.name).toBeNull()
    expect(snapshot.branch.detached).toBe(true)
    expect(snapshot.branch.abbrevOid).toBe('4ec20f5')
    expect(snapshot.clean).toBe(true)
  })

  it('unborn：branch.oid (initial) → oid null / unborn true（[清单 64]）', () => {
    const parsed = parsePorcelainV2(nul('# branch.oid (initial)', '# branch.head main'))
    expect(parsed.header.unborn).toBe(true)
    expect(parsed.header.oid).toBeNull()
    expect(parsed.header.head).toBe('main')
  })

  it('ignored：`!` record 不进任何分组，收进 ignored（untracked ≠ ignored，[清单 5]）', () => {
    const parsed = parsePorcelainV2(IGNORED_V2)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.ignored).toEqual(['ign.txt'])
    const snapshot = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed, stagedStats: EMPTY_STATS, unstagedStats: EMPTY_STATS,
    })
    expect(snapshot.untracked).toEqual([])
    expect(snapshot.unstaged.map(change => change.path)).toEqual(['a.txt'])
  })

  it('submodule：sub 字段非 N 开头 ⇒ submodule true（[清单 61] v1 只展示）', () => {
    const snapshot = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed: parsePorcelainV2(SUBMODULE_V2),
      stagedStats: EMPTY_STATS, unstagedStats: EMPTY_STATS,
    })
    const change = changeOf(snapshot, 'sub')
    expect(change.submodule).toBe(true)
    expect(change.kind).toBe('added')
    expect(change.x).toBe('A')
  })

  it('numstat 合并视图：untracked 无记录 → null；staged 记录回填；MM 双侧记录 worktree 侧为先', () => {
    const mixed = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed: parsePorcelainV2(MIXED_V2),
      stagedStats: numstatCounts(parseNumstat('0\t0\t\0hello world.txt\0renamed file.txt\0')),
      unstagedStats: numstatCounts(parseNumstat('1\t2\t中文路径.txt\0')),
    })
    expect(changeOf(mixed, 'renamed file.txt')).toMatchObject({ additions: 0, deletions: 0, binary: false })
    expect(changeOf(mixed, '中文路径.txt')).toMatchObject({ additions: 1, deletions: 2, binary: false })
    expect(changeOf(mixed, 'untracked.txt')).toMatchObject({ additions: null, deletions: null, binary: false })

    const both = assembleStatus({
      repoRoot: 'R:/', generatedAt: '2026-10-31T00:00:00.000Z',
      parsed: parsePorcelainV2(BOTH_SIDES_V2),
      stagedStats: numstatCounts(parseNumstat('2\t3\tboth.txt\0')),
      unstagedStats: numstatCounts(parseNumstat('10\t20\tboth.txt\0')),
    })
    // MM 文件同时出现在 staged 与 unstaged 组（spec §1.0.3 分组注释），合并视图取 worktree 侧。
    expect(both.staged).toHaveLength(1)
    expect(both.unstaged).toHaveLength(1)
    expect(changeOf(both, 'both.txt')).toMatchObject({ additions: 10, deletions: 20, x: 'M', y: 'M' })
  })

  it('binary numstat：`-` → binary:true 且计数归 0（[清单 59]）', () => {
    const entries = parseNumstat(NUMSTAT_MIXED)
    expect(entries).toEqual([
      { path: 'bin.dat', added: 0, deleted: 0, binary: true },
      { path: 'new.txt', oldPath: 'old.txt', added: 0, deleted: 0, binary: false },
      { path: 'new.txt', added: 1, deleted: 0, binary: false },
    ])
    const counts = numstatCounts(entries)
    expect(counts.get('bin.dat')).toEqual({ additions: 0, deletions: 0, binary: true })
    expect(counts.get('new.txt')).toEqual({ additions: 1, deletions: 0, binary: false }) // 同路径后记录覆盖
  })

  it('健壮性：路径含前导空格（分隔后单空格歧义）与未知 record 类型跳过；malformed 已知类型抛错', () => {
    // 文件名 " leading.txt"：hI 与路径间恰一个分隔空格 + 文件名自带一个前导空格。
    const parsed = parsePorcelainV2(nul(
      '1 .M N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb  leading.txt',
      '9 forward-compat-record',
    ))
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]!.path).toBe(' leading.txt')
    expect(() => parsePorcelainV2(nul('1 .M'))).toThrow(/malformed porcelain v2 record/)
    expect(() => parsePorcelainV2(nul('u UU N... 100644'))).toThrow(/malformed porcelain v2 record/)
  })
})

describe('parsePorcelainV1（回退段，Cline 范本）', () => {
  it('v1 混合夹具（本机实测真 merge AA）：XY 两字符 + 单空格 + 路径；?? 单独分组', () => {
    const parsed = parsePorcelainV1(MIXED_V1)
    expect(parsed.header).toMatchObject({ head: 'main', upstream: null, detached: false, unborn: false })
    expect(parsed.entries).toHaveLength(3)
    expect(entryOf(parsed, 'c.txt')).toEqual({
      recordType: '1', x: 'A', y: 'A', sub: 'N...', origPath: null, path: 'c.txt',
    })
    expect(entryOf(parsed, 'new untracked.txt')).toMatchObject({ recordType: '?', x: '?', y: '?' })
  })

  it('v1 头四态：upstream[ahead N, behind M]、No commits yet on、HEAD (no branch)、[gone] 剥离', () => {
    expect(parsePorcelainV1(nul('## main...origin/main [ahead 1]')).header)
      .toMatchObject({ head: 'main', upstream: 'origin/main', ahead: 1, behind: null })
    expect(parsePorcelainV1(nul('## main...origin/main [ahead 1, behind 2]')).header)
      .toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 2 })
    const unborn = parsePorcelainV1(nul('## No commits yet on main'))
    expect(unborn.header).toMatchObject({ head: 'main', unborn: true, oid: null })
    expect(parsePorcelainV1(nul('## HEAD (no branch)')).header)
      .toMatchObject({ head: null, detached: true })
    expect(parsePorcelainV1(nul('## main...origin/main [gone]')).header)
      .toMatchObject({ upstream: 'origin/main', ahead: null, behind: null })
  })

  it('v1 重命名双记录与 v1 ignored：原路径吃下一 NUL 段；!! 进 ignored', () => {
    const parsed = parsePorcelainV1(nul(
      '## main',
      'R  new.txt',
      'old.txt',
      ' M work-mod.txt',
      '!! ignored.log',
    ))
    expect(entryOf(parsed, 'new.txt')).toMatchObject({ x: 'R', y: ' ', origPath: 'old.txt' })
    expect(entryOf(parsed, 'work-mod.txt')).toMatchObject({ x: ' ', y: 'M', origPath: null })
    expect(parsed.ignored).toEqual(['ignored.log'])
  })
})
