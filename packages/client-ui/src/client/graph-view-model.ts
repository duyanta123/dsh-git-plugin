/**
 * dsh-gitkit-ui — 提交图纯视图模型（本模块 ask §③/④；spec §6 纯函数
 * 单测纪律——行 chips 合成与详情装配不依赖 DOM 即可断言；ui-model.ts 同款收敛）。
 *
 * 行 ref chips 的 'HEAD -> main' 形态在此合成（spec §3.3.1：「HEAD→分支用
 * 'HEAD -> main' 形态由渲染层处理」——本模块即渲染层的纯半）：HEAD 分支指向本行
 * ⇒ 以 `HEAD -> <name>` 替换该分支 chip（置首）；detached HEAD 行（无 ref 名）
 * ⇒ 前置 `HEAD` chip。
 */

import type { CommitDetail, DiffFile } from 'dsh-gitkit/types'
import type { GitErrorLike } from './remote/mount.js'

/** 顶部错误条的来源（重试路由的判别面）。 */
export type GraphNoticeSource = 'log' | 'status' | 'refs'

/**
 * 提交图顶部错误条装配 + 重试路由（GitGraphTab 的纯决策半；tests 断言）。
 *
 * 展示优先序与既有 `??` 链一致：log.error → 仓库级 statusError（调用方按
 * unavailable 过滤后传入）→ refsError。重试按**来源**路由（P2 修复）：refs 查询
 * 失败只重取 refs——清窗重载（reload）对 refs 故障是错误动作，log 重拉成功也修
 * 不好 refsError，反而白丢已加载窗口；其余来源（log 失败 / 仓库级不可用）清窗重载。
 */
export function graphNoticeRetry(params: {
  logError: GitErrorLike | null
  statusError: GitErrorLike | null
  refsError: GitErrorLike | null
}): { notice: GitErrorLike | null; source: GraphNoticeSource | null } {
  if (params.logError !== null) return { notice: params.logError, source: 'log' }
  if (params.statusError !== null) return { notice: params.statusError, source: 'status' }
  if (params.refsError !== null) return { notice: params.refsError, source: 'refs' }
  return { notice: null, source: null }
}

/** 行 ref chip 的输入投影（GraphRowLayout 的 isHead/refs 切片）。 */
export interface RowChipSource {
  isHead: boolean
  refs: readonly string[]
}

/**
 * 行 ref chips：HEAD 分支指向本行 ⇒ `HEAD -> <name>` 置首并去重该分支；
 * detached HEAD 行 ⇒ 前置 `HEAD`。其余 ref 短名按原序保留。
 * @param row 行投影。
 * @param headLabel HEAD chip 的合并标签：branch 态 = 分支短名；detached 态 = 'HEAD'；
 *   unborn/null = null。
 */
export function rowRefChips(row: RowChipSource, headLabel: string | null): string[] {
  if (headLabel !== null && headLabel !== 'HEAD' && row.refs.includes(headLabel)) {
    return [`HEAD -> ${headLabel}`, ...row.refs.filter((ref) => ref !== headLabel)]
  }
  if (row.isHead && headLabel === 'HEAD') return ['HEAD', ...row.refs]
  return [...row.refs]
}

/** 详情面板的一条变更文件行。 */
export interface DetailRow {
  path: string
  origPath: string | null
  status: DiffFile['status']
  /** 单字母状态徽标（A/M/D/R/C）。 */
  statusLetter: string
  binary: boolean
  additions: number | null
  deletions: number | null
  /** 该文件是否处于展开 patch 位（detailPath 命中）。 */
  expanded: boolean
}

/** 详情面板的一枚 ref chip。 */
export interface DetailRefChip {
  label: string
  /** HEAD 合成 chip（描边强调）。 */
  head: boolean
  /**
   * tag chip（V2 批次一 [30]）：RefInfo.type === 'tag' ⇒ 渲染层挂 chip 菜单
   * （删 tag / 从该提交打 tag——plan §3.6）；分支/HEAD chip 无菜单。
   */
  tag: boolean
}

/** 详情面板视图模型（CommitDetailPanel 的渲染输入）。 */
export interface DetailViewModel {
  subject: string
  shortOid: string
  author: string
  /** `YYYY-MM-DD HH:mm`（解析失败为 ''）。 */
  date: string
  body: string
  refs: DetailRefChip[]
  files: DetailRow[]
  totalTruncated: boolean
}

/**
 * 详情缓存槽 → 视图模型（纯函数；detail 未就绪时 subject/shortOid 仍可从入参
 * oid 与 commits 表回填——由调用方传 fallbackSubject）。
 * @param params.oid 选中提交 oid。
 * @param params.detail 详情缓存值（未就绪 undefined）。
 * @param params.headLabel HEAD 合并标签（rowRefChips 同语义）。
 * @param params.detailPath 展开的文件路径。
 * @param params.fallbackSubject 详情未就绪时的占位主题（commits 表命中的 subject）。
 */
export function detailViewModel(params: {
  oid: string
  detail: CommitDetail | undefined
  headLabel: string | null
  detailPath: string | null
  fallbackSubject: string
}): DetailViewModel {
  const { oid, detail, headLabel, detailPath, fallbackSubject } = params
  const commit = detail?.commit
  const chips: DetailRefChip[] = []
  if (detail !== undefined) {
    // HEAD chip 合成（rowRefChips 同语义）：branch 态命中本提交的 HEAD 分支 ⇒
    // `HEAD -> <name>` 置首；detached 态（调用方仅在本提交 = HEAD 时传 'HEAD'）⇒
    // 前置 HEAD chip。其余 ref 短名按原序。
    if (headLabel !== null && headLabel !== 'HEAD' && detail.refs.some((ref) => ref.shortName === headLabel)) {
      chips.push({ label: `HEAD -> ${headLabel}`, head: true, tag: false })
    } else if (headLabel === 'HEAD') {
      chips.push({ label: 'HEAD', head: true, tag: false })
    }
    for (const ref of detail.refs) {
      if (headLabel !== null && headLabel !== 'HEAD' && ref.shortName === headLabel) continue
      chips.push({ label: ref.shortName, head: false, tag: ref.type === 'tag' })
    }
  }
  return {
    subject: commit?.subject ?? fallbackSubject,
    shortOid: oid.slice(0, 7),
    author: commit !== undefined ? commit.authorName : '',
    date: commit !== undefined ? formatCommitDate(commit.committedAt) : '',
    body: commit !== undefined ? commit.body.replace(/\n+$/u, '') : '',
    refs: chips,
    files: (detail?.files ?? []).map((file) => ({
      path: file.path,
      origPath: file.origPath,
      status: file.status,
      statusLetter: statusLetterOf(file.status),
      binary: file.binary,
      additions: file.additions,
      deletions: file.deletions,
      expanded: detailPath === file.path,
    })),
    totalTruncated: detail?.totalTruncated ?? false,
  }
}

/** DiffFile.status → 单字母徽标。 */
export function statusLetterOf(status: DiffFile['status']): string {
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  if (status === 'renamed') return 'R'
  if (status === 'copied') return 'C'
  return 'M'
}

/** ISO → `YYYY-MM-DD HH:mm`（本地时区；解析失败为 ''）。 */
export function formatCommitDate(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
