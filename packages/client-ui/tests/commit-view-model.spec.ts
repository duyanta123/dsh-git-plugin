/**
 * C4 提交对话框纯视图模型 + 业务面折算测试（④-K 提交对话框模块 ask §①；
 * spec §6 纯函数单测纪律：启用闸/警示条/计数/Conventional 判定不依赖 DOM 断言）。
 */

import { describe, expect, it } from 'vitest'
import type { GitStatusSnapshot } from 'dsh-gitkit/types'
import { headCommitOf } from '../src/client/commit-dialog-face.ts'
import type { HeadCommitInfo } from '../src/client/commit-dialog-face.ts'
import {
  CONVENTIONAL_HINT_RE,
  amendRewritesPushedHistory,
  commitDialogView,
  commitOptionsOf,
  pushOptionsOf,
} from '../src/client/commit-view-model.ts'

function mkSnapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: 'D:/repo',
    generatedAt: '2026-11-01T00:00:00.000Z',
    branch: {
      name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: 'origin/main',
      ahead: 1, behind: 0, detached: false, unborn: false,
    },
    staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
    ...overrides,
  }
}

function stagedFile(path: string) {
  return { path, origPath: null, kind: 'added' as const, x: 'A', y: '.', conflicted: false, binary: false, additions: 3, deletions: 0, submodule: false }
}

const HEAD: HeadCommitInfo = { shortOid: 'aaaaaaa', subject: 'feat: init', message: 'feat: init\n\nbody line' }

function baseInput() {
  return {
    snapshot: mkSnapshot({ staged: [stagedFile('a.ts')] }) as GitStatusSnapshot | null,
    identity: { name: 't', email: 't@example.com', missing: [], complete: true, workspace: 'D:/repo', workspaceSource: 'workspace-override' as const },
    message: 'feat: add a.ts',
    amend: false,
    head: HEAD as HeadCommitInfo | null,
    pending: false as const,
  }
}

describe('CONVENTIONAL_HINT_RE — Conventional 非阻断判定（host commit.ts 同语义的 client 镜像）', () => {
  it('命中：type/作用域/感叹号/各 type', () => {
    for (const message of ['feat: add x', 'fix(ui): crash', 'feat!: breaking', 'chore(release): 1.2.3', 'revert: feat: add x']) {
      expect(CONVENTIONAL_HINT_RE.test(message), message).toBe(true)
    }
  })

  it('不命中：无 type / 空主题 / 超长主题 / 非首行匹配不算', () => {
    for (const message of ['added stuff', 'feat:', 'feat: ', 'feat: x'.repeat(30), 'unknown: thing']) {
      expect(CONVENTIONAL_HINT_RE.test(message), message).toBe(false)
    }
    expect(CONVENTIONAL_HINT_RE.test('second line\nfeat: real')).toBe(false)
  })
})

describe('commitDialogView — 字段全表（ask §①）', () => {
  it('正常路径：staged 只读清单 + 计数 + Conventional 命中 → 无警示，两动作启用', () => {
    const view = commitDialogView(baseInput())
    expect(view.available).toBe(true)
    expect(view.staged.map((change) => change.path)).toEqual(['a.ts'])
    expect(view.stagedCount).toBe(1)
    expect(view.chars).toBe('feat: add a.ts'.length)
    expect(view.messageEmpty).toBe(false)
    expect(view.conventional).toBe(true)
    expect(view.showConventionalHint).toBe(false)
    expect(view.commitEnabled).toBe(true)
    expect(view.pushEnabled).toBe(true)
  })

  it('消息为空（非 amend）：实时校验提示 + 提交禁用（[清单 11] 镜像的闸半边）', () => {
    const view = commitDialogView({ ...baseInput(), message: '' })
    expect(view.messageEmpty).toBe(true)
    expect(view.commitEnabled).toBe(false)
    expect(view.pushEnabled).toBe(false)
  })

  it('staged 为空（非 amend）：提交禁用（[清单 11] 前端镜像）', () => {
    const view = commitDialogView({ ...baseInput(), snapshot: mkSnapshot() })
    expect(view.stagedCount).toBe(0)
    expect(view.commitEnabled).toBe(false)
  })

  it('非 Conventional：行内警示可见但不阻断（[清单 17]）', () => {
    const view = commitDialogView({ ...baseInput(), message: 'just some text' })
    expect(view.conventional).toBe(false)
    expect(view.showConventionalHint).toBe(true)
    expect(view.commitEnabled).toBe(true)
  })

  it('amend：staged 为空 + 消息为空仍可提交（host --no-edit 路的镜像）+ amendNoEdit 信息位', () => {
    const view = commitDialogView({ ...baseInput(), snapshot: mkSnapshot(), amend: true, message: '' })
    expect(view.amendAvailable).toBe(true)
    expect(view.commitEnabled).toBe(true)
    expect(view.amendNoEdit).toBe(true)
    expect(view.amendParams).toEqual({ shortOid: 'aaaaaaa', subject: 'feat: init' })
  })

  it('amend + upstream + ahead==0 → 改写已推送历史警示；ahead>0 → 不警示', () => {
    const pushed = commitDialogView({ ...baseInput(), amend: true, snapshot: mkSnapshot({ branch: { name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: 'origin/main', ahead: 0, behind: 0, detached: false, unborn: false } }) })
    expect(pushed.showAmendWarning).toBe(true)
    const unpushed = commitDialogView({ ...baseInput(), amend: true, snapshot: mkSnapshot() })
    expect(unpushed.showAmendWarning).toBe(false)
  })

  it('amend 无 HEAD（unborn/未取回）→ 勾选禁用（amendAvailable=false）', () => {
    const view = commitDialogView({ ...baseInput(), head: null })
    expect(view.amendAvailable).toBe(false)
  })

  it('身份缺失 → 身份告警条 + 缺失键插值串（[清单 55]）', () => {
    const view = commitDialogView({
      ...baseInput(),
      identity: { name: null, email: null, missing: ['user.name', 'user.email'], complete: false, workspace: 'D:/repo', workspaceSource: 'workspace-override' },
    })
    expect(view.showIdentityBar).toBe(true)
    expect(view.identityMissing).toBe('user.name, user.email')
  })

  it('unborn → unborn 提示条；diverged（behind>0）→ diverged 告警条带 behind', () => {
    const unborn = commitDialogView({
      ...baseInput(),
      snapshot: mkSnapshot({
        branch: { name: 'main', oid: null, abbrevOid: null, upstream: null, ahead: null, behind: null, detached: false, unborn: true },
        staged: [stagedFile('b.ts')], clean: false,
      }),
    })
    expect(unborn.showUnbornBar).toBe(true)
    expect(unborn.commitEnabled).toBe(true) // 首提交路径
    const diverged = commitDialogView({
      ...baseInput(),
      snapshot: mkSnapshot({ branch: { name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: 'origin/main', ahead: 2, behind: 3, detached: false, unborn: false } }),
    })
    expect(diverged.showDivergedBar).toBe(true)
    expect(diverged.divergedBehind).toBe(3)
  })

  it('快照未就绪 / 动作进行中 → 全禁用', () => {
    expect(commitDialogView({ ...baseInput(), snapshot: null }).commitEnabled).toBe(false)
    expect(commitDialogView({ ...baseInput(), pending: 'commit' }).commitEnabled).toBe(false)
    expect(commitDialogView({ ...baseInput(), pending: 'push' }).pushEnabled).toBe(false)
  })
})

describe('commitOptionsOf / pushOptionsOf — 动作入参折算', () => {
  it('commit 入参三字段直传（amend/skipHooks 由组件状态折算）', () => {
    expect(commitOptionsOf('feat: x', true, false)).toEqual({ message: 'feat: x', amend: true, skipHooks: false })
  })

  it('push 入参：无 upstream ⇒ setUpstream:true（首推设上游）；有 upstream ⇒ false', () => {
    expect(pushOptionsOf({ upstream: null })).toEqual({ setUpstream: true })
    expect(pushOptionsOf({ upstream: 'origin/main' })).toEqual({ setUpstream: false })
    expect(pushOptionsOf(null)).toEqual({ setUpstream: false })
  })

  it('amendRewritesPushedHistory：upstream 且 ahead==0；无 upstream / ahead>0 为 false', () => {
    expect(amendRewritesPushedHistory({ upstream: 'origin/main', ahead: 0 })).toBe(true)
    expect(amendRewritesPushedHistory({ upstream: 'origin/main', ahead: 2 })).toBe(false)
    expect(amendRewritesPushedHistory({ upstream: null, ahead: 0 })).toBe(false)
    expect(amendRewritesPushedHistory(null)).toBe(false)
  })
})

describe('headCommitOf — LogPage 首条 → amend 预填形状', () => {
  it('有 body：message = subject + 空行 + body；短 oid 7 位', () => {
    const head = headCommitOf({ commits: [{ oid: 'a'.repeat(40), subject: 'feat: init', body: 'body line' }] })
    expect(head).toEqual({ shortOid: 'aaaaaaa', subject: 'feat: init', message: 'feat: init\n\nbody line' })
  })

  it('无 body：message = subject；空页（unborn）→ null', () => {
    expect(headCommitOf({ commits: [{ oid: 'b'.repeat(40), subject: 'chore: solo', body: '' }] })).toEqual({
      shortOid: 'bbbbbbb', subject: 'chore: solo', message: 'chore: solo',
    })
    expect(headCommitOf({ commits: [] })).toBeNull()
  })
})
