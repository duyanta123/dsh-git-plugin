/**
 * 会话改动时间线 / 归因徽标纯视图模型单测（V3 批次四 [清单 39/40/41]；
 * v3-implementation-plan §6.7 client 清单「新 checkpoint-view.spec.ts（时间线分组/
 * unavailable 文案状态/徽标四态/筛选）」+ 本批 ask 增补「restore danger 闸状态机」）。
 *
 * 被测面 = src/client/checkpoint-view.ts；danger 勾选闸的 UI 层复用
 * ui-model.confirmButtonEnabled（GitConfirmDialog 同款——本 spec 断言双层闸接线）。
 * 相对时间半复用 blame-view.relativeTime（blame-view.spec 既有覆盖——本 spec 只钉
 * checkpointTimeView 的组合语义：词典半/绝对文本半/解析失败回落）。
 */

import { describe, expect, it } from 'vitest'
import type { AttributionEntry, CheckpointEntry, FileChange } from 'dsh-gitkit/types'
import {
  attributionBadgeView, attributionLabelKey, attributionMap, checkpointDiffFile, checkpointReasonView,
  checkpointTimeView, currentSessionEntries, filterChangesViewModel, groupCheckpointTurns, initialRestoreState,
  reduceRestore, restoreWireOptions, restoreOutcomeView, ATTRIBUTION_FILTERS,
} from '../../src/client/checkpoint-view.ts'
import type { RestoreEvent, RestoreMachineState } from '../../src/client/checkpoint-view.ts'
import { confirmButtonEnabled } from '../../src/client/ui-model.ts'
import type { ChangeGroupModel, ChangeRow, ChangesViewModel } from '../../src/client/changes-view-model.ts'

// ── 夹具 ────────────────────────────────────────────────────────────────────

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

/** 环内条目夹具（wire CheckpointEntry；summary 可缺席 = workspaceChanges 无记录；reason 缺省 null）。 */
function mkEntry(
  seq: number,
  turn: number,
  endedAt: string,
  files: Array<{ path: string; added: number; deleted: number }> | null,
  sessionId: string = SESSION_A,
  reason: string | null = null,
): CheckpointEntry {
  const summary = files === null
    ? null
    : {
        total: files.length,
        added: files.reduce((sum, file) => sum + file.added, 0),
        deleted: files.reduce((sum, file) => sum + file.deleted, 0),
        files,
      }
  return { sessionId, seq, turn, endedAt, reason, summary }
}

/** FileChange 夹具（filterChangesViewModel 的行构造面——porcelain 合并视图形状）。 */
function mkChange(path: string): FileChange {
  return { path, origPath: null, kind: 'modified', x: '.', y: 'M', conflicted: false, binary: false, additions: 1, deletions: 0, submodule: false }
}

/** 双文件单组的视图模型夹具（'changes' 组 a/b 两行）。 */
function mkView(paths: string[]): ChangesViewModel {
  const rows: ChangeRow[] = paths.map((path) => ({
    group: 'changes',
    path,
    change: mkChange(path),
    scope: 'worktree',
    glyph: { letter: 'M', tone: 'modified' },
    actions: { stage: true, unstage: false, discard: true },
  }))
  const rowByPath = new Map(rows.map((row) => [row.path, row]))
  const groups: ChangeGroupModel[] = rows.length > 0 ? [{ id: 'changes', labelKey: 'changes.unstaged', rows }] : []
  return { available: true, checking: false, unborn: false, clean: false, groups, totalRows: rowByPath.size, rowByPath }
}

/** 归因条目夹具。 */
function mkAttribution(path: string, attribution: AttributionEntry['attribution'], turns: number[] = []): AttributionEntry {
  return { path, turns, attribution }
}

// ── 时间线分组 ──────────────────────────────────────────────────────────────

describe('currentSessionEntries（v1 单会话口径——wire sessionId 注释「client 侧按当前会话过滤」）', () => {
  it('跨会话输入只留当前会话条目（host 环跨会话持有全部——seq/turn 跨会话不可比）', () => {
    const entries = [mkEntry(7, 3, '2026-11-14T09:00:00.000Z', null, SESSION_B), mkEntry(5, 2, '2026-11-14T08:00:00.000Z', null)]
    expect(currentSessionEntries(entries, SESSION_A).map((entry) => entry.seq)).toEqual([5])
    expect(currentSessionEntries(entries, SESSION_B).map((entry) => entry.seq)).toEqual([7])
  })
})

describe('groupCheckpointTurns（时间线 turn 分组——session-watch 同 turn 替换语义，一行一回合）', () => {
  it('newest-first 保持输入序；文件按 path 升序；± 与 total 求和', () => {
    const groups = groupCheckpointTurns([
      mkEntry(9, 4, '2026-11-14T09:00:00.000Z', [
        { path: 'z.ts', added: 2, deleted: 1 },
        { path: 'a.ts', added: 3, deleted: 0 },
      ]),
      mkEntry(5, 2, '2026-11-14T08:00:00.000Z', [{ path: 'm.ts', added: 1, deleted: 4 }]),
    ])
    expect(groups.map((group) => group.turn)).toEqual([4, 2])
    const newer = groups[0]!
    expect(newer.seq).toBe(9)
    expect(newer.files.map((file) => file.path)).toEqual(['a.ts', 'z.ts'])
    expect(newer.files[0]).toMatchObject({ path: 'a.ts', added: 3, deleted: 0, seq: 9, index: 1 })
    expect(newer.total).toBe(2)
    expect(newer.added).toBe(5)
    expect(newer.deleted).toBe(1)
    expect(newer.summaryAvailable).toBe(true)
    expect(newer.allUnavailable).toBe(false)
  })

  it('summary null 条目（Host 重启/会话处置）→ allUnavailable + 无文件行 + 不计入求和——诚实降级', () => {
    const groups = groupCheckpointTurns([
      mkEntry(7, 5, '2026-11-14T10:00:00.000Z', null),
      mkEntry(5, 2, '2026-11-14T08:00:00.000Z', [{ path: 'm.ts', added: 1, deleted: 4 }]),
    ])
    const unavailable = groups[0]!
    expect(unavailable.allUnavailable).toBe(true)
    expect(unavailable.summaryAvailable).toBe(false)
    expect(unavailable.files).toEqual([])
    expect(unavailable.total).toBe(0)
    expect(unavailable.seq).toBe(7)
    expect(groups[1]!.summaryAvailable).toBe(true)
  })

  it('同 turn 多条目（跨会话输入场景）：组内归并、文件 path 去重（最新条目先得）、锚 seq = 组内最新', () => {
    const groups = groupCheckpointTurns([
      mkEntry(11, 3, '2026-11-14T09:00:00.000Z', [{ path: 'a.ts', added: 1, deleted: 0 }], SESSION_A),
      mkEntry(6, 3, '2026-11-14T08:30:00.000Z', [{ path: 'a.ts', added: 9, deleted: 9 }, { path: 'b.ts', added: 2, deleted: 0 }], SESSION_B),
    ])
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group.turn).toBe(3)
    expect(group.seq).toBe(11) // newest-first 输入的首条 = 锚
    expect(group.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(group.files[0]).toMatchObject({ seq: 11, index: 0 }) // a.ts 以最新条目为准
    expect(group.files[1]).toMatchObject({ seq: 6, index: 1 })
  })

  it('空输入 → 空分组（折叠区 ready 态落 checkpoint.empty）', () => {
    expect(groupCheckpointTurns([])).toEqual([])
  })

  it('reason 徽标数据半（评审收口）：组 reason = 组内首个非 null（同 turn 单条替换语义下即该回合的结束原因）；null 保持 null', () => {
    const groups = groupCheckpointTurns([
      mkEntry(11, 3, '2026-11-14T09:00:00.000Z', [{ path: 'a.ts', added: 1, deleted: 0 }], SESSION_A, 'aborted'),
      mkEntry(6, 2, '2026-11-14T08:30:00.000Z', [{ path: 'b.ts', added: 2, deleted: 0 }], SESSION_A, 'completed'),
    ])
    expect(groups[0]!.reason).toBe('aborted')
    expect(groups[1]!.reason).toBe('completed')
    // 跨会话同 turn 组：首个非 null 为准（newest-first 首条先得）。
    const cross = groupCheckpointTurns([
      mkEntry(11, 3, '2026-11-14T09:00:00.000Z', null, SESSION_A, 'completed'),
      mkEntry(6, 3, '2026-11-14T08:30:00.000Z', null, SESSION_B, 'error'),
    ])
    expect(cross[0]!.reason).toBe('completed')
    // 全 null（尚未观察到 turn/end）不冒充任何态。
    expect(groupCheckpointTurns([mkEntry(7, 5, '2026-11-14T10:00:00.000Z', null)])[0]!.reason).toBeNull()
  })
})

describe('checkpointReasonView（turn/end reason 徽标——评审收口交付 plan §6.6）', () => {
  it('已知 kind（dsh TurnEndReasonMap 基础词汇）走 checkpoint.reason.* 词典半', () => {
    expect(checkpointReasonView('completed')).toEqual({ kind: 'locale', key: 'checkpoint.reason.completed' })
    expect(checkpointReasonView('aborted')).toEqual({ kind: 'locale', key: 'checkpoint.reason.aborted' })
    expect(checkpointReasonView('max-tokens')).toEqual({ kind: 'locale', key: 'checkpoint.reason.maxTokens' })
    expect(checkpointReasonView('forked')).toEqual({ kind: 'locale', key: 'checkpoint.reason.forked' })
  })

  it('未知 kind（merge-extensible 并入的新 variant）原样显示——不吞掉不认识的结束原因；null → null', () => {
    expect(checkpointReasonView('plugin-custom-reason')).toEqual({ kind: 'raw', value: 'plugin-custom-reason' })
    expect(checkpointReasonView(null)).toBeNull()
  })
})

describe('checkpointTimeView（回合时间——复用 blame.time.* 词典 + 绝对日期回落）', () => {
  it('相对窗内走词典半（blame-view.relativeTime 既有词汇——不另造相对时间键）', () => {
    const now = Date.parse('2026-11-14T10:00:00.000Z')
    expect(checkpointTimeView('2026-11-14T09:59:30.000Z', now)).toEqual({ kind: 'locale', key: 'blame.time.now', params: {} })
    expect(checkpointTimeView('2026-11-14T09:30:00.000Z', now)).toEqual({ kind: 'locale', key: 'blame.time.minutes', params: { count: 30 } })
    expect(checkpointTimeView('2026-11-14T07:00:00.000Z', now)).toEqual({ kind: 'locale', key: 'blame.time.hours', params: { count: 3 } })
    expect(checkpointTimeView('2026-11-12T10:00:00.000Z', now)).toEqual({ kind: 'locale', key: 'blame.time.days', params: { count: 2 } })
  })

  it('超窗 → 绝对日期文本半（ISO 派生 YYYY-MM-DD HH:mm，中性数字串不走词典）', () => {
    expect(checkpointTimeView('2026-05-01T08:30:12.000Z', Date.parse('2026-11-14T10:00:00.000Z')))
      .toEqual({ kind: 'text', value: '2026-05-01 08:30' })
  })

  it('解析失败 → 原串文本半（总有一行可读时间——不伪造「刚刚」）', () => {
    expect(checkpointTimeView('not-a-timestamp', 0)).toEqual({ kind: 'text', value: 'not-a-timestamp' })
  })
})

// ── unavailable 文案状态 ────────────────────────────────────────────────────

describe('unavailable 文案状态（summary null 的诚实降级——组件以 allUnavailable 分叉）', () => {
  it('全 null 组：allUnavailable=true 驱动 checkpoint.turnUnavailable 文案 + 恢复禁用（无记录无从恢复）', () => {
    const group = groupCheckpointTurns([mkEntry(7, 5, '2026-11-14T10:00:00.000Z', null)])[0]!
    expect(group.allUnavailable).toBe(true)
    expect(group.files).toEqual([])
  })

  it('混合输入（有 summary 与 null 并存）：有 summary 的组照常渲染——降级按回合粒度不扩散', () => {
    const groups = groupCheckpointTurns([
      mkEntry(9, 4, '2026-11-14T09:00:00.000Z', [{ path: 'a.ts', added: 1, deleted: 0 }]),
      mkEntry(7, 3, '2026-11-14T08:00:00.000Z', null),
    ])
    expect(groups.map((group) => group.allUnavailable)).toEqual([false, true])
  })
})

// ── 归因徽标四态 ────────────────────────────────────────────────────────────

describe('attributionBadgeView（徽标四态 + 诚实 tooltip——plan §6.6 DE=A 口径）', () => {
  it('agent：回合号清单进 tooltip 插值（升序 join）', () => {
    const badge = attributionBadgeView(mkAttribution('a.ts', 'agent', [3, 7, 12]))
    expect(badge).toMatchObject({
      state: 'agent',
      turns: [3, 7, 12],
      labelKey: 'checkpoint.attribution.agent',
      tipKey: 'checkpoint.attribution.agentTip',
      tipParams: { turns: '3, 7, 12' },
    })
  })

  it('user / mixed / unknown：四态齐备，mixed/unknown 带各自诚实说明', () => {
    expect(attributionBadgeView(mkAttribution('a.ts', 'user'))).toMatchObject({ state: 'user', tipKey: 'checkpoint.attribution.userTip' })
    expect(attributionBadgeView(mkAttribution('a.ts', 'mixed', [2]))).toMatchObject({ state: 'mixed', tipKey: 'checkpoint.attribution.mixedTip' })
    expect(attributionBadgeView(mkAttribution('a.ts', 'unknown'))).toMatchObject({ state: 'unknown', tipKey: 'checkpoint.attribution.unknownTip' })
  })

  it('条目缺席（attributionGet 未就绪/路径不在快照）→ null：徽标不渲染，不把「尚未加载」冒充「无记录」', () => {
    expect(attributionBadgeView(undefined)).toBeNull()
  })

  it('attributionMap：entries → path 查询面；attributionLabelKey 与 wire 四态一一对应', () => {
    const map = attributionMap([mkAttribution('a.ts', 'agent', [1]), mkAttribution('b.ts', 'unknown')])
    expect(map.get('a.ts')?.attribution).toBe('agent')
    expect(map.get('b.ts')?.attribution).toBe('unknown')
    for (const state of ['agent', 'user', 'mixed', 'unknown'] as const) {
      expect(attributionLabelKey(state)).toBe(`checkpoint.attribution.${state}`)
    }
  })
})

// ── 按归因筛选 ──────────────────────────────────────────────────────────────

describe('filterChangesViewModel（时间线区筛选 → 主文件列表过滤——plan §6.6）', () => {
  const view = mkView(['a.ts', 'b.ts', 'c.ts'])
  const attribution = attributionMap([
    mkAttribution('a.ts', 'agent', [3]),
    mkAttribution('b.ts', 'user'),
    mkAttribution('c.ts', 'mixed', [5]),
  ])

  it("'all' 原样返回同引用（筛选未启用零开销）", () => {
    expect(filterChangesViewModel(view, attribution, 'all')).toBe(view)
  })

  it("按归因过滤：'agent' 只留 a.ts；组内计数随动", () => {
    const filtered = filterChangesViewModel(view, attribution, 'agent')
    expect(filtered.groups).toHaveLength(1)
    expect(filtered.groups[0]!.rows.map((row) => row.path)).toEqual(['a.ts'])
    expect(filtered.totalRows).toBe(1)
    expect(filtered.rowByPath.get('a.ts')).toBeDefined()
    expect(filtered.rowByPath.has('b.ts')).toBe(false)
  })

  it("unknown 筛选：映射内 unknown 态命中；映射缺席路径不留（不冒充任何态）", () => {
    const withUnknown = attributionMap([
      mkAttribution('a.ts', 'agent', [3]),
      mkAttribution('b.ts', 'unknown'),
      mkAttribution('c.ts', 'mixed', [5]),
    ])
    const filtered = filterChangesViewModel(view, withUnknown, 'unknown')
    expect(filtered.groups[0]!.rows.map((row) => row.path)).toEqual(['b.ts'])
    const filteredAbsent = filterChangesViewModel(view, attributionMap([mkAttribution('a.ts', 'agent', [3])]), 'unknown')
    expect(filteredAbsent.groups).toEqual([])
    expect(filteredAbsent.rowByPath.size).toBe(0)
  })

  it('全过滤空 → 空组清单（组件落 checkpoint.filter.empty）+ available 等面板字段保持', () => {
    const filtered = filterChangesViewModel(view, attributionMap([mkAttribution('zz.ts', 'agent', [1])]), 'agent')
    expect(filtered.groups).toEqual([])
    expect(filtered.available).toBe(true)
    expect(filtered.clean).toBe(false)
    expect(filtered.unborn).toBe(false)
  })

  it('筛选五态控件域恒定（all + wire 四态）', () => {
    expect(ATTRIBUTION_FILTERS).toEqual(['all', 'agent', 'user', 'mixed', 'unknown'])
  })
})

// ── checkpointDiff → FileDiff 只读投影 ─────────────────────────────────────

describe('checkpointDiffFile（既有 FileDiff 只读渲染的输入投影——parsePatch 可无损往返）', () => {
  it('text 修改：patch 头 + hunk 计数自 body 重算；± 计数 = +/- 行数', () => {
    const file = checkpointDiffFile({
      kind: 'text',
      path: 'src/a.ts',
      display: 'src/a.ts',
      before: true,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' context', '-old line', '+new line 1', '+new line 2'] }],
    })
    expect(file.binary).toBe(false)
    expect(file.oversized).toBe(false)
    expect(file.status).toBe('modified')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)
    expect(file.patch).toBe([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,3 @@',
      ' context',
      '-old line',
      '+new line 1',
      '+new line 2',
    ].join('\n') + '\n')
    expect(file.patchTruncated).toBe(false)
    expect(file.origPath).toBeNull()
  })

  it('新增：/dev/null 头 + new file mode 行；status added（parsePatch 的 ---/+++ 头行在首个 hunk 前被剔除）', () => {
    const file = checkpointDiffFile({
      kind: 'text',
      path: 'new.ts',
      display: 'new.ts',
      before: false,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+line one', '+line two'] }],
    })
    expect(file.status).toBe('added')
    expect(file.patch).toContain('new file mode 100644')
    expect(file.patch).toContain('--- /dev/null')
    expect(file.patch).toContain('+++ b/new.ts')
    expect(file.patch).toContain('@@ -0,0 +1,2 @@')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(0)
  })

  it('删除：deleted file mode 行；status deleted；零行侧起点归一 0（host serializeCheckpointPatch 同纪律）', () => {
    const file = checkpointDiffFile({
      kind: 'text',
      path: 'gone.ts',
      display: 'gone.ts',
      before: true,
      after: false,
      coarse: false,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-gone one', '-gone two'] }],
    })
    expect(file.status).toBe('deleted')
    expect(file.patch).toContain('deleted file mode 100644')
    expect(file.patch).toContain('--- a/gone.ts')
    expect(file.patch).toContain('+++ /dev/null')
    expect(file.patch).toContain('@@ -1,2 +0,0 @@')
  })

  it('coarse（零上下文 hunk）：逐行替换体原样过线——FileDiffView 的渲染面不依赖上下文行', () => {
    const file = checkpointDiffFile({
      kind: 'text',
      path: 'c.ts',
      display: 'c.ts',
      before: true,
      after: true,
      coarse: true,
      hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-before content', '+after content'] }],
    })
    expect(file.patch).toContain('@@ -2,1 +2,1 @@')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
  })

  it('hunks 空（两侧同行 no-op）→ patch 空串（FileDiffView 落 diff.empty 占位——host 零 hunk patch 同纪律）', () => {
    const file = checkpointDiffFile({ kind: 'text', path: 'same.ts', display: 'same.ts', before: true, after: true, coarse: false, hunks: [] })
    expect(file.patch).toBe('')
    expect(file.additions).toBe(0)
    expect(file.deletions).toBe(0)
  })

  it('binary / oversized：对应旗标 + patch null（FileDiffView 占位分支先行——additions/deletions null）', () => {
    const binary = checkpointDiffFile({ kind: 'binary', path: 'bin.dat', display: 'bin.dat' })
    expect(binary.binary).toBe(true)
    expect(binary.patch).toBeNull()
    expect(binary.additions).toBeNull()
    const oversized = checkpointDiffFile({ kind: 'oversized', path: 'big.log', display: 'big.log' })
    expect(oversized.oversized).toBe(true)
    expect(oversized.patch).toBeNull()
    expect(oversized.binary).toBe(false)
  })
})

// ── 恢复此回合：danger 闸状态机 ─────────────────────────────────────────────

describe('reduceRestore（恢复流程状态机——discard 三重守卫范式的组件半）', () => {
  const REQUEST: RestoreEvent = { type: 'request', seq: 9, turn: 4, paths: ['a.ts', 'z.ts'] }
  const CONFIRMED_BASE = 'a'.repeat(40)

  it('request → confirming（勾选复位 false、载荷固化；confirming/running 在途时 request no-op）', () => {
    const confirming = reduceRestore(initialRestoreState(), REQUEST)
    expect(confirming).toMatchObject({
      phase: 'confirming', seq: 9, turn: 4, paths: ['a.ts', 'z.ts'],
      checkboxChecked: false, baseRevision: null, applied: [], failed: [], error: null,
    })
    // 路径快照复制——后续外部改数组不串扰确认框。
    const paths: string[] = ['a.ts']
    const snapshot = reduceRestore(initialRestoreState(), { type: 'request', seq: 1, turn: 1, paths })
    paths.push('intruder.ts')
    expect(snapshot.paths).toEqual(['a.ts'])
    // 在途不可重入。
    expect(reduceRestore(confirming, REQUEST)).toBe(confirming)
    const running = reduceRestore(confirming, { type: 'confirm', baseRevision: CONFIRMED_BASE })
    expect(reduceRestore(running, REQUEST)).toBe(running)
  })

  it('danger 闸逻辑层：勾选未置 confirm no-op（UI 层 confirmButtonEnabled 禁用——双层闸）', () => {
    const confirming = reduceRestore(initialRestoreState(), REQUEST)
    expect(confirmButtonEnabled('danger', confirming.checkboxChecked)).toBe(false)
    expect(reduceRestore(confirming, { type: 'confirm', baseRevision: CONFIRMED_BASE })).toBe(confirming)
    const checked = reduceRestore(confirming, { type: 'toggleCheckbox' })
    expect(confirmButtonEnabled('danger', checked.checkboxChecked)).toBe(true)
    const running = reduceRestore(checked, { type: 'confirm', baseRevision: CONFIRMED_BASE })
    expect(running.phase).toBe('running')
    expect(running.baseRevision).toBe(CONFIRMED_BASE) // 基线在确认时刻捕获
    // wire 入参仅 running 相位产出（旁路面为零）：paths null = 该回合全部 + acknowledged。
    expect(restoreWireOptions(running)).toEqual({ seq: 9, paths: null, acknowledged: true, baseRevision: CONFIRMED_BASE })
    expect(restoreWireOptions(confirming)).toBeNull()
    expect(restoreWireOptions(initialRestoreState())).toBeNull()
    // sessionId 判别半（评审收口）：非空回传进 wire；空串不传（host 对空形 invalid-options）。
    expect(restoreWireOptions(running, SESSION_A))
      .toEqual({ seq: 9, paths: null, acknowledged: true, baseRevision: CONFIRMED_BASE, sessionId: SESSION_A })
    expect(restoreWireOptions(running, '')).toEqual({ seq: 9, paths: null, acknowledged: true, baseRevision: CONFIRMED_BASE })
  })

  it('running 相位 baseRevision null 显式过 wire（乐观并发不校验形态——host options.baseRevision null）', () => {
    const running = reduceRestore(
      reduceRestore(reduceRestore(initialRestoreState(), REQUEST), { type: 'toggleCheckbox' }),
      { type: 'confirm', baseRevision: null },
    )
    expect(restoreWireOptions(running)?.baseRevision).toBeNull()
  })

  it('succeeded：零失败 → applied；有失败 → partial（已成功项不回滚——host 逐文件部分成功语义）', () => {
    const running = reduceRestore(
      reduceRestore(reduceRestore(initialRestoreState(), REQUEST), { type: 'toggleCheckbox' }),
      { type: 'confirm', baseRevision: CONFIRMED_BASE },
    )
    const applied = reduceRestore(running, { type: 'succeeded', applied: ['a.ts', 'z.ts'], failed: [] })
    expect(applied.phase).toBe('applied')
    expect(restoreOutcomeView({ applied: ['a.ts', 'z.ts'], failed: [] })).toEqual({ key: 'checkpoint.restore.applied', params: { count: 2 } })
    const partial = reduceRestore(running, { type: 'succeeded', applied: ['a.ts'], failed: [{ path: 'z.ts', reason: 'patch does not apply' }] })
    expect(partial.phase).toBe('partial')
    expect(partial.failed).toEqual([{ path: 'z.ts', reason: 'patch does not apply' }])
    expect(restoreOutcomeView({ applied: ['a.ts'], failed: [{ path: 'z.ts', reason: 'x' }] }))
      .toEqual({ key: 'checkpoint.restore.partial', params: { applied: 1, failed: 1 } })
    // 非 running 相位的 succeeded no-op（重复结果事件不重写）。
    expect(reduceRestore(applied, { type: 'succeeded', applied: [], failed: [] })).toBe(applied)
  })

  it('rejected → error（域码保留——checkpoint-unavailable/stale-base-revision 就地显示）；dismiss → idle', () => {
    const running = reduceRestore(
      reduceRestore(reduceRestore(initialRestoreState(), REQUEST), { type: 'toggleCheckbox' }),
      { type: 'confirm', baseRevision: CONFIRMED_BASE },
    )
    const rejected = reduceRestore(running, { type: 'rejected', error: { code: 'git/checkpoint-unavailable', message: 'no record' } })
    expect(rejected.phase).toBe('error')
    expect(rejected.error?.code).toBe('git/checkpoint-unavailable')
    expect(reduceRestore(rejected, { type: 'dismiss' }).phase).toBe('idle')
    expect(reduceRestore(rejected, { type: 'dismiss' }).seq).toBeNull()
    // running 在途不可 dismiss（wire 已发出——结果事件收束）。
    expect(reduceRestore(running, { type: 'dismiss' })).toBe(running)
  })

  it('cancel / dismiss（confirming）→ idle 全清；已出结果相位可再 request（新一轮确认勾选复位）', () => {
    const confirming = reduceRestore(initialRestoreState(), REQUEST)
    const cancelled = reduceRestore(confirming, { type: 'cancel' })
    expect(cancelled).toEqual(initialRestoreState())
    expect(reduceRestore(confirming, { type: 'dismiss' })).toEqual(initialRestoreState())
    const done: RestoreMachineState = reduceRestore(
      reduceRestore(reduceRestore(reduceRestore(initialRestoreState(), REQUEST), { type: 'toggleCheckbox' }), { type: 'confirm', baseRevision: CONFIRMED_BASE }),
      { type: 'succeeded', applied: ['a.ts', 'z.ts'], failed: [] },
    )
    const again = reduceRestore(done, REQUEST)
    expect(again.phase).toBe('confirming')
    expect(again.checkboxChecked).toBe(false)
  })

  it('toggleCheckbox 仅 confirming 相位生效（idle/running 的勾选事件 no-op）', () => {
    const idle = initialRestoreState()
    expect(reduceRestore(idle, { type: 'toggleCheckbox' })).toBe(idle)
    const running = reduceRestore(
      reduceRestore(reduceRestore(initialRestoreState(), REQUEST), { type: 'toggleCheckbox' }),
      { type: 'confirm', baseRevision: CONFIRMED_BASE },
    )
    expect(reduceRestore(running, { type: 'toggleCheckbox' })).toBe(running)
  })
})
