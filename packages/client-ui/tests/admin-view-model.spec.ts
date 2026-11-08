/**
 * V2 批次一管理面纯视图模型测试（分支创建 / 标签创建 / worktree 列表与移除两段闸 /
 * worktree 新建草稿；plan §3.7 client 纯函数范式——推送对话框部分在 push-dialog.spec）。
 */

import { describe, expect, it } from 'vitest'
import type { WorktreeInfo } from 'dsh-gitkit/types'
import {
  branchCreateDraft, resetPlan, tagCreateDraft, timeTravelOptions, worktreeAddDraft,
  worktreeRemovePlan, worktreeRows,
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
