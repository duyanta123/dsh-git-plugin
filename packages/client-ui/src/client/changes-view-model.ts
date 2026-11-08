/**
 * dsh-gitkit-ui — C2 GitChangesTab 纯视图模型（本模块 ask §②/③）。
 *
 * 渲染决策全部收敛为纯函数（组件只做 t/订阅/事件——spec §6 纯函数单测纪律，与
 * ui-model.ts 的 header 视图模型同纪律）：三组 + 冲突置顶的分组装配（[清单 1]）、
 * 行内动作的按组区分（本模块 ask §②：staged 组仅 unstage；changes/untracked 组
 * stage 与 discard）、状态字母与 +N −M 的展示形状。不依赖 DOM/React 即可断言。
 */

import type { DiffScope, FileChange, GitStatusSnapshot, RepoDiagnostics } from 'dsh-gitkit/types'
import type { GitLocaleKey } from './locales.js'
import type { GitStatusSourceState } from './store/git-status-source.js'

/** 变更组 id（渲染顺序 = 数组顺序：冲突置顶 [清单 1]）。 */
export type ChangesGroupId = 'conflicted' | 'staged' | 'changes' | 'untracked'

/** 状态徽标的色调（data-git-change-glyph-tone 测试锚）。 */
export type StatusTone = 'added' | 'removed' | 'modified' | 'renamed' | 'conflict' | 'untracked'

/** 状态字母徽标（ZCode GitPaneChangeCard 无字母徽标；本项为本插件视觉设计）。 */
export interface StatusGlyph {
  letter: string
  tone: StatusTone
}

/** 卡片行的渲染模型（组上下文 + 行内动作可见性已按 ask §② 折算）。 */
export interface ChangeRow {
  /** 归属组。 */
  group: ChangesGroupId
  /** 文件路径（renamed 显示为 origPath → path，path 取新路径）。 */
  path: string
  /** status 快照的原始条目。 */
  change: FileChange
  /** 该行 diff 的 scope（staged 组看 index 对 HEAD，其余看工作区 [清单 2/3]）。 */
  scope: DiffScope
  /** 状态字母徽标。 */
  glyph: StatusGlyph
  /** 行内动作可见性（ask §②：staged 仅 unstage；其余组 stage + discard）。 */
  actions: { stage: boolean; unstage: boolean; discard: boolean }
}

/** 一个变更组的渲染模型。 */
export interface ChangeGroupModel {
  id: ChangesGroupId
  labelKey: GitLocaleKey
  rows: ChangeRow[]
}

/** 面板整体渲染模型。 */
export interface ChangesViewModel {
  /** 仓库可用投影（false ⇒ 友好空态 [清单 54]）。 */
  available: boolean
  /** 首帧尚未到达。 */
  checking: boolean
  /** unborn 分支提示条（[清单 64]；可与非空组并存——init + add 后有 staged 行）。 */
  unborn: boolean
  /** 工作区干净（四组全空）。 */
  clean: boolean
  /** 组清单（冲突置顶；空组不出现）。 */
  groups: ChangeGroupModel[]
  /** 全部行数（去重路径——UU 同时在 staged/unstaged/conflicted 只算一次）。 */
  totalRows: number
  /** path → 行（含跨组重复的展开定位用；同路径多组时取第一组）。 */
  rowByPath: Map<string, ChangeRow>
}

/** 不可用类域码（与 header 视图模型同口径）。 */
const UNAVAILABLE_CODES = new Set(['git/no-repository', 'git/session-workspace-unresolved'])

/**
 * 状态字母徽标：冲突 '!'；其余按 ChangeKind（A/D/R/C/U/M）。
 * untracked 行在 untracked 组必然出现（kind='untracked'）。
 */
export function statusGlyphOf(change: FileChange): StatusGlyph {
  if (change.conflicted) return { letter: '!', tone: 'conflict' }
  switch (change.kind) {
    case 'added': return { letter: 'A', tone: 'added' }
    case 'deleted': return { letter: 'D', tone: 'removed' }
    case 'renamed': return { letter: 'R', tone: 'renamed' }
    case 'copied': return { letter: 'C', tone: 'renamed' }
    case 'untracked': return { letter: 'U', tone: 'untracked' }
    default: return { letter: 'M', tone: 'modified' }
  }
}

/** 行内动作可见性（ask §②）：staged 组仅 unstage；其余组 stage + discard。 */
function actionsFor(group: ChangesGroupId): ChangeRow['actions'] {
  if (group === 'staged') return { stage: false, unstage: true, discard: false }
  return { stage: true, unstage: false, discard: true }
}

function rowFor(group: ChangesGroupId, change: FileChange): ChangeRow {
  return {
    group,
    path: change.path,
    change,
    scope: group === 'staged' ? 'staged' : 'worktree',
    glyph: statusGlyphOf(change),
    actions: actionsFor(group),
  }
}

const GROUP_LABELS: Record<ChangesGroupId, GitLocaleKey> = {
  conflicted: 'changes.conflicted',
  staged: 'changes.staged',
  changes: 'changes.unstaged',
  untracked: 'changes.untracked',
}

/** 组装配序：冲突置顶（[清单 1]），随后 staged / changes / untracked。 */
function assemble(snapshot: GitStatusSnapshot): ChangeGroupModel[] {
  const rowsOf = (id: ChangesGroupId, changes: readonly FileChange[]): ChangeGroupModel => ({
    id,
    labelKey: GROUP_LABELS[id],
    rows: changes.map((change) => rowFor(id, change)),
  })
  return [
    rowsOf('conflicted', snapshot.conflicted),
    rowsOf('staged', snapshot.staged),
    rowsOf('changes', snapshot.unstaged),
    rowsOf('untracked', snapshot.untracked),
  ].filter((group) => group.rows.length > 0)
}

/** 状态源快照 → 面板渲染模型（纯函数）。 */
export function changesViewModel(state: GitStatusSourceState): ChangesViewModel {
  const snapshot = state.status
  if (snapshot === null) {
    const unavailable = state.statusError !== null && UNAVAILABLE_CODES.has(state.statusError.code)
    return {
      available: !unavailable,
      checking: !unavailable,
      unborn: false,
      clean: false,
      groups: [],
      totalRows: 0,
      rowByPath: new Map(),
    }
  }
  const groups = assemble(snapshot)
  const rowByPath = new Map<string, ChangeRow>()
  for (const group of groups) {
    for (const row of group.rows) {
      if (!rowByPath.has(row.path)) rowByPath.set(row.path, row)
    }
  }
  return {
    available: true,
    checking: false,
    unborn: snapshot.branch.unborn,
    clean: snapshot.clean,
    groups,
    totalRows: rowByPath.size,
    rowByPath,
  }
}

// ── V2 批次三：CRLF 提示条（[56]；plan §5.6——可折叠不阻断）──

/** CRLF 提示条渲染模型。 */
export interface CrlfBarView {
  /** 条可见：确有 CRLF/LF 混用文件才渲染（autocrlf 有值但零混用是常规形态——如
   *  Windows autocrlf=true 的全 CRLF 仓库——不渲染免噪，评审修复②）。 */
  visible: boolean
  /** autocrlf 生效值（autocrlf 缺席回落 core.eol；两者都缺 → 词典 unset 形态）。 */
  value: string
  /** autocrlf 与 core.eol 都未设置（summary 的 {value} 走 changes.crlf.unset）。 */
  unset: boolean
  /** CRLF/LF 混用文件数 = mixedEolFiles.length（评审修复②：worktreeCrlfCount 统计
   *  的是「含 CRLF 的文件」——host diagnostics.ts `if (hasCrlf) crlfCount += 1`，
   *  guard-scan.spec 3 含 CRLF vs 1 混用——与「{count} 个文件 CRLF/LF 混用」文案
   *  语义不同源，不得折算混用数；清单封顶时计数即封顶清单长度，如实少报）。 */
  mixedCount: number
  /** 混用文件清单（封顶形态，原样透传进折叠区）。 */
  mixedFiles: readonly string[]
}

/**
 * repoDiagnostics 结果 → 提示条视图（纯函数）。
 * 语义对齐（评审修复②，host diagnostics.ts 实读）：`worktreeCrlfCount` = 含 CRLF
 * 行尾的抽样文件数（全 CRLF 文件也计入），`mixedEolFiles` = CRLF 与 LF 混用的文件
 * 清单——提示条文案「{count} 个文件 CRLF/LF 混用」只对 mixedEolFiles 成立；用
 * worktreeCrlfCount 会把普通 autocrlf=true 仓库（全 CRLF、零混用）误报成常驻混用
 * 提示条。可见性 = mixedEolFiles 非空。
 */
export function crlfBarView(diagnostics: RepoDiagnostics | null): CrlfBarView {
  if (diagnostics === null) {
    return { visible: false, value: '', unset: true, mixedCount: 0, mixedFiles: [] }
  }
  const configured = diagnostics.autocrlf ?? diagnostics.coreEol
  const mixedCount = diagnostics.mixedEolFiles.length
  return {
    visible: mixedCount > 0,
    value: configured ?? '',
    unset: configured === null,
    mixedCount,
    mixedFiles: diagnostics.mixedEolFiles,
  }
}
