/**
 * V2 批次一管理面纯视图模型测试（分支创建 / 标签创建 / worktree 列表与移除两段闸 /
 * worktree 新建草稿；plan §3.7 client 纯函数范式——推送对话框部分在 push-dialog.spec）。
 * V3 批次三扩：Agent 工具状态行渲染模型（agentToolsStatusLine；v3-implementation-plan §5.8）。
 * V3 批次五扩：自动化状态行渲染模型（automationStatusLines；v3-implementation-plan §7.5）。
 */

import { describe, expect, it } from 'vitest'
import type { AutomationActionEntry, AutomationStatusResult, WorktreeInfo } from 'dsh-gitkit/types'
import {
  agentToolsStatusLine, automationStatusLines, branchCreateDraft, resetPlan, tagCreateDraft,
  timeTravelOptions, worktreeAddDraft, worktreeRemovePlan, worktreeRows,
} from '../src/client/admin-view-model.ts'
import { pushRoute } from '../src/client/admin-face.ts'

describe('branchCreateDraft — 新建分支草稿（[23]）', () => {
  it('名字必填（trim）；空白 ⇒ invalid + options null', () => {
    expect(branchCreateDraft({ name: '  ', from: '', checkout: true })).toEqual({ valid: false, options: null })
    expect(branchCreateDraft({ name: 'feature/a', from: '', checkout: true }).valid).toBe(true)
  })

  it('from 缺省 = null（host 语义：基于当前 HEAD）；from 非空 trim 透传', () => {
    expect(branchCreateDraft({ name: 'a', from: '', checkout: false }).options)
      .toEqual({ name: 'a', from: null, checkout: false })
    expect(branchCreateDraft({ name: 'a', from: ' dev ', checkout: false }).options)
      .toEqual({ name: 'a', from: 'dev', checkout: false })
  })

  it('checkout 旗标透传（host 侧 -C 切换语义）', () => {
    expect(branchCreateDraft({ name: 'a', from: '', checkout: true }).options)
      .toMatchObject({ checkout: true })
  })
})

describe('tagCreateDraft — 打标签草稿（[30]）', () => {
  it('名字必填；空白 ⇒ invalid', () => {
    expect(tagCreateDraft({ name: '', message: '', oid: null }).valid).toBe(false)
    expect(tagCreateDraft({ name: ' v1 ', message: '', oid: null }).valid).toBe(true)
  })

  it('message 空 = lightweight（null）；非空 = annotated（trim 后透传）', () => {
    expect(tagCreateDraft({ name: 'v1', message: '', oid: null }).options)
      .toEqual({ name: 'v1', oid: null, message: null })
    expect(tagCreateDraft({ name: 'v1', message: ' release ', oid: null }).options)
      .toEqual({ name: 'v1', oid: null, message: 'release' })
  })

  it('oid null = HEAD（header 入口）；给定时打在该提交（graph「在此提交打标签」入口）', () => {
    expect(tagCreateDraft({ name: 'v1', message: '', oid: null }).options).toMatchObject({ oid: null })
    expect(tagCreateDraft({ name: 'v1', message: '', oid: 'a'.repeat(40) }).options)
      .toMatchObject({ oid: 'a'.repeat(40) })
  })
})

describe('worktreeRows — 列表区渲染模型（[62]）', () => {
  it('字段直传；bare 不可移除（git worktree remove 对主 bare 无效），其余可移除', () => {
    const worktrees: WorktreeInfo[] = [
      { path: 'D:/repo', head: 'a'.repeat(40), branch: 'main', bare: false, detached: false, locked: false },
      { path: 'D:/bare.git', head: null, branch: null, bare: true, detached: false, locked: false },
      { path: 'D:/wt', head: 'b'.repeat(40), branch: null, bare: false, detached: true, locked: true },
    ]
    expect(worktreeRows(worktrees)).toEqual([
      { path: 'D:/repo', branch: 'main', detached: false, bare: false, locked: false, removable: true },
      { path: 'D:/bare.git', branch: null, detached: false, bare: true, locked: false, removable: false },
      { path: 'D:/wt', branch: null, detached: true, bare: false, locked: true, removable: true },
    ])
  })

  it('空清单 ⇒ 空数组（对话框空态文案由词典 worktree.empty 承担）', () => {
    expect(worktreeRows([])).toEqual([])
  })
})

describe('worktreeRemovePlan — 移除两段闸（脏 worktree 走 danger 勾选闸）', () => {
  it('ask 段：normal 确认、不传 force（host 对脏 worktree 拒绝）', () => {
    expect(worktreeRemovePlan('ask')).toEqual({ severity: 'normal', force: false, acknowledged: false })
  })

  it('force 段：danger + force + acknowledged 透传（host 守卫的解锁路径）', () => {
    expect(worktreeRemovePlan('force')).toEqual({ severity: 'danger', force: true, acknowledged: true })
  })
})

describe('worktreeAddDraft — 新建区草稿（[68]：现有分支/新建分支互斥二选一）', () => {
  it('path 必填（trim）；空白 ⇒ missing path', () => {
    expect(worktreeAddDraft({ path: '  ', mode: 'existing', branch: 'dev', newBranch: '' }))
      .toEqual({ valid: false, missing: 'path', options: null })
  })

  it('existing 模式 ⇒ branch 给定（newBranch 不传）；分支空白 ⇒ missing branch', () => {
    expect(worktreeAddDraft({ path: 'D:/wt', mode: 'existing', branch: ' dev ', newBranch: '' }))
      .toEqual({ valid: true, missing: null, options: { path: 'D:/wt', branch: 'dev' } })
    expect(worktreeAddDraft({ path: 'D:/wt', mode: 'existing', branch: ' ', newBranch: '' }))
      .toEqual({ valid: false, missing: 'branch', options: null })
  })

  it('new 模式 ⇒ newBranch 给定（branch 不传）；空白 ⇒ missing branch', () => {
    expect(worktreeAddDraft({ path: 'D:/wt', mode: 'new', branch: '', newBranch: ' ticket-7 ' }))
      .toEqual({ valid: true, missing: null, options: { path: 'D:/wt', newBranch: 'ticket-7' } })
    expect(worktreeAddDraft({ path: 'D:/wt', mode: 'new', branch: 'dev', newBranch: '' }))
      .toEqual({ valid: false, missing: 'branch', options: null })
  })
})

describe('pushRoute — 推送行路由（菜单直推 vs 对话框）', () => {
  it('多远端走对话框；单/零远端直推（v1 行为不回归）', () => {
    expect(pushRoute(2)).toBe('dialog')
    expect(pushRoute(5)).toBe('dialog')
    expect(pushRoute(1)).toBe('direct')
    expect(pushRoute(0)).toBe('direct')
  })
})

describe('resetPlan — 重置当前分支的确认计划（V2 批次二 [37]）', () => {
  it('soft/mixed ⇒ normal 档 + acknowledged/baseRevision 组装（discard 三重守卫同款）', () => {
    expect(resetPlan({ kind: 'soft', target: 'dev', baseRevision: 'a'.repeat(40), acked: false }))
      .toEqual({ valid: true, severity: 'normal', options: { kind: 'soft', target: 'dev', acknowledged: true, baseRevision: 'a'.repeat(40) } })
    expect(resetPlan({ kind: 'mixed', target: 'dev', baseRevision: 'a'.repeat(40), acked: false }).severity).toBe('normal')
  })

  it('hard 未过勾选闸 ⇒ 不可发起（severity danger + options null）；勾选后放行', () => {
    const blocked = resetPlan({ kind: 'hard', target: 'dev', baseRevision: 'a'.repeat(40), acked: false })
    expect(blocked).toEqual({ valid: false, severity: 'danger', options: null })
    const allowed = resetPlan({ kind: 'hard', target: 'dev', baseRevision: 'a'.repeat(40), acked: true })
    expect(allowed.valid).toBe(true)
    expect(allowed.options).toEqual({ kind: 'hard', target: 'dev', acknowledged: true, baseRevision: 'a'.repeat(40) })
  })

  it('baseRevision 缺席（detached/unborn 的 HEAD oid null）⇒ 不可发起（乐观并发基线缺失）', () => {
    expect(resetPlan({ kind: 'mixed', target: 'dev', baseRevision: null, acked: false }).options).toBeNull()
    expect(resetPlan({ kind: 'hard', target: 'dev', baseRevision: null, acked: true }).options).toBeNull()
    expect(resetPlan({ kind: 'mixed', target: '', baseRevision: 'a'.repeat(40), acked: false }).options).toBeNull()
  })
})

describe('timeTravelOptions — cherry-pick/revert 入参组装（V2 批次二 [37]）', () => {
  it('oid + baseRevision 在场 ⇒ acknowledged:true + 基线透传（按 kind 收窄返回型）', () => {
    expect(timeTravelOptions('cherry-pick', { oid: 'b'.repeat(40), baseRevision: 'a'.repeat(40) }))
      .toEqual({ oid: 'b'.repeat(40), acknowledged: true, baseRevision: 'a'.repeat(40) })
    expect(timeTravelOptions('revert', { oid: 'b'.repeat(40), baseRevision: 'a'.repeat(40) }))
      .toEqual({ oid: 'b'.repeat(40), acknowledged: true, baseRevision: 'a'.repeat(40) })
  })

  it('baseRevision null / oid 空 ⇒ 不可发起（入口闸）', () => {
    expect(timeTravelOptions('cherry-pick', { oid: 'b'.repeat(40), baseRevision: null })).toBeNull()
    expect(timeTravelOptions('revert', { oid: '', baseRevision: 'a'.repeat(40) })).toBeNull()
  })
})

describe('agentToolsStatusLine — header 菜单「Agent 工具」状态行（V3 批次三 [45]；v3-plan §5.7）', () => {
  it('off 档 ⇒ 关闭行（agentTools.status.off，无插值参数）', () => {
    expect(agentToolsStatusLine({ mode: 'off', toolsFaceAvailable: true, registered: [] }))
      .toEqual({ labelKey: 'agentTools.status.off', params: {} })
  })

  it('on 档（face 在场）⇒ on 行：mode 配置字面量词条 + registered 数（readonly 8 / readwrite 11——host §5.4 表）', () => {
    expect(agentToolsStatusLine({ mode: 'readonly', toolsFaceAvailable: true, registered: readonlyTools() }))
      .toEqual({ labelKey: 'agentTools.status.on', params: { mode: 'readonly', count: 8 } })
    expect(agentToolsStatusLine({ mode: 'readwrite', toolsFaceAvailable: true, registered: [...readonlyTools(), 'git_stage', 'git_unstage', 'git_commit'] }))
      .toEqual({ labelKey: 'agentTools.status.on', params: { mode: 'readwrite', count: 11 } })
  })

  it('降级档（mode 开而 toolsFaceAvailable=false）⇒ 关闭行（有效态无可用工具——"readonly (0 tools)" 会把不可用宣成可用）', () => {
    expect(agentToolsStatusLine({ mode: 'readonly', toolsFaceAvailable: false, registered: [] }))
      .toEqual({ labelKey: 'agentTools.status.off', params: {} })
    expect(agentToolsStatusLine({ mode: 'readwrite', toolsFaceAvailable: false, registered: [] }))
      .toEqual({ labelKey: 'agentTools.status.off', params: {} })
  })

  it('null（未拉取/拉取失败）⇒ null——状态行整行缺席（观测行不进错误卡）', () => {
    expect(agentToolsStatusLine(null)).toBeNull()
  })
})

describe('automationStatusLines — header 菜单「自动化」状态行（V3 批次五 [42][43]；v3-plan §7.5）', () => {
  /** automationStatus 出参夹具（默认档 = off/off + 空动作环）。 */
  function automation(overrides: Partial<AutomationStatusResult> = {}): AutomationStatusResult {
    return { autoCommitMode: 'off', autoBranchMode: 'off', lastActions: [], ...overrides }
  }

  it('两模式全 off ⇒ 关闭行（automation.status.off，无插值参数）；空动作环 ⇒ 摘要行缺席', () => {
    expect(automationStatusLines(automation())).toEqual({
      status: { labelKey: 'automation.status.off', params: {} },
      latest: null,
    })
  })

  it('任一开 ⇒ 档位行：{commit}/{branch} = Config 档位字面量（配置 token 原样——agentTools {mode} 同款纪律）', () => {
    expect(automationStatusLines(automation({ autoCommitMode: 'turn-end' }))).toEqual({
      status: { labelKey: 'automation.status.on', params: { commit: 'turn-end', branch: 'off' } },
      latest: null,
    })
    expect(automationStatusLines(automation({ autoBranchMode: 'session-start' }))).toEqual({
      status: { labelKey: 'automation.status.on', params: { commit: 'off', branch: 'session-start' } },
      latest: null,
    })
    expect(automationStatusLines(automation({ autoCommitMode: 'turn-end', autoBranchMode: 'session-start' }))).toEqual({
      status: { labelKey: 'automation.status.on', params: { commit: 'turn-end', branch: 'session-start' } },
      latest: null,
    })
  })

  it('最近动作 = lastActions 首条（host newest-first 环）：kind → 词条键映射 + ok/detail 原样透传', () => {
    const ring: AutomationActionEntry[] = [
      { at: '2026-11-18T06:30:00.000Z', action: 'auto-commit', ok: true, detail: 'committed a1b2c3d on main (turn 5)' },
      { at: '2026-11-18T06:00:00.000Z', action: 'auto-branch', ok: false, detail: 'skipped: worktree dirty' },
    ]
    expect(automationStatusLines(automation({ autoCommitMode: 'turn-end', lastActions: ring }))).toEqual({
      status: { labelKey: 'automation.status.on', params: { commit: 'turn-end', branch: 'off' } },
      latest: { kindKey: 'automation.action.commit', ok: true, detail: 'committed a1b2c3d on main (turn 5)' },
    })
  })

  it('首条 auto-branch 且未成功 ⇒ branch 词条键 + ok:false（detail = host 白名单摘要原样——已消毒/200 上限，client 不再截断）', () => {
    const ring: AutomationActionEntry[] = [
      { at: '2026-11-18T06:00:00.000Z', action: 'auto-branch', ok: false, detail: 'failed: no free dsh/task-<id> name within 16 suffixes' },
    ]
    const lines = automationStatusLines(automation({ autoBranchMode: 'session-start', lastActions: ring }))
    expect(lines?.latest).toEqual({
      kindKey: 'automation.action.branch', ok: false,
      detail: 'failed: no free dsh/task-<id> name within 16 suffixes',
    })
  })

  it('全 off 但动作环非空 ⇒ 关闭行 + 摘要行并存（重取覆盖档位切换前的动作历史——诚实呈现）', () => {
    const ring: AutomationActionEntry[] = [
      { at: '2026-11-18T06:30:00.000Z', action: 'auto-commit', ok: false, detail: 'secret block: 2 violation(s); staged reset, worktree changes kept' },
    ]
    expect(automationStatusLines(automation({ lastActions: ring }))).toEqual({
      status: { labelKey: 'automation.status.off', params: {} },
      latest: { kindKey: 'automation.action.commit', ok: false, detail: 'secret block: 2 violation(s); staged reset, worktree changes kept' },
    })
  })

  it('null（未拉取/拉取失败）⇒ null——开关态行与摘要行整组缺席（观测行不进错误卡）', () => {
    expect(automationStatusLines(null)).toBeNull()
  })
})

/** host agent-tools.ts §5.4 表的 readonly 8 工具名（registered 白名单断言样本）。 */
function readonlyTools(): string[] {
  return [
    'git_status', 'git_diff', 'git_log', 'git_refs', 'git_blame', 'git_commit_detail',
    'git_compare_branches', 'git_repo_diagnostics',
  ]
}
