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
  commitAllowedByGuard,
  commitDialogView,
  commitOptionsOf,
  guardScanView,
  invalidTrailerLine,
  processFromHookError,
  processOutputView,
  pushOptionsOf,
  trailerLines,
  violationsSignature,
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

// ── V2 批次三（plan §5.7「commit-view-model.spec 扩展：blocked→按钮禁用 /
//    违规列表渲染模型 / trailer 行校验 / 豁免状态机」）──

describe('V2 批次三：trailer 行校验（[18]；plan §5.6 ① 非法行警示不阻断）', () => {
  it('合法行 Key: value → 无非法行；空行剔除', () => {
    expect(trailerLines('Co-authored-by: Alice <alice@example.com>\n\nGenerated-by: dsh-gitkit\n'))
      .toEqual(['Co-authored-by: Alice <alice@example.com>', 'Generated-by: dsh-gitkit'])
    expect(invalidTrailerLine('Co-authored-by: Alice')).toBeNull()
    expect(invalidTrailerLine('')).toBeNull()
  })

  it('非法行：缺冒号 / 空 value / 数字开头 Key → 返回第一条非法行文本', () => {
    expect(invalidTrailerLine('no colon line')).toBe('no colon line')
    expect(invalidTrailerLine('Key:')).toBe('Key:')
    expect(invalidTrailerLine('Co-authored-by: \nOK: fine')).toBe('Co-authored-by:')
    expect(invalidTrailerLine('1key: value')).toBe('1key: value')
  })

  it('非法行不阻断提交（commitOptionsOf 原样透传 trailer 清单）', () => {
    const lines = trailerLines('bad line\nCo-authored-by: Alice')
    expect(commitOptionsOf('feat: x', false, false, lines)).toEqual({
      message: 'feat: x', amend: false, skipHooks: false,
      trailers: ['bad line', 'Co-authored-by: Alice'],
    })
  })

  it('commitOptionsOf：trailer 空清单 → 省略字段（wire 纪律：可选输入省略传递）', () => {
    expect(commitOptionsOf('feat: x', true, false)).toEqual({ message: 'feat: x', amend: true, skipHooks: false })
    expect(commitOptionsOf('feat: x', false, false, [])).toEqual({ message: 'feat: x', amend: false, skipHooks: false })
  })
})

describe('V2 批次三：护栏面板视图模型（[21][22]；plan §5.6 ② + D5 豁免语义）', () => {
  // CommitScanResult wire 形状（host types.ts v2 批次三段）：{ blocked, violations }——
  // overridable 不在 wire 上，client 按 D5=A 派生（违规集中无 secret 类）。
  const cleanScan = { blocked: false, violations: [] }
  const envScan = {
    blocked: true,
    violations: [{ kind: 'env-file' as const, path: '.env', detail: 'staged env file', sizeBytes: 120, line: null, redactedMatch: null }],
  }
  const secretScan = {
    blocked: true,
    violations: [
      { kind: 'secret' as const, path: 'keys.txt', detail: 'aws key id', sizeBytes: null, line: 3, redactedMatch: 'AKIA***' },
      { kind: 'large-file' as const, path: 'bundle.js', detail: '2.5 MiB', sizeBytes: 2_621_440, line: null, redactedMatch: null },
    ],
  }

  it('idle → 面板不可见；scanning → 可见 + scanning，零裁决', () => {
    expect(guardScanView('idle', null).visible).toBe(false)
    const scanning = guardScanView('scanning', null)
    expect(scanning.visible).toBe(true)
    expect(scanning.scanning).toBe(true)
    expect(scanning.blocked).toBe(false)
    expect(scanning.violations).toEqual([])
  })

  it('ready + 零违规 → clean（通过行）+ overridable=true（无 secret——vacuous D5 派生）', () => {
    const view = guardScanView('ready', cleanScan)
    expect(view.clean).toBe(true)
    expect(view.blocked).toBe(false)
    expect(view.overridable).toBe(true)
    expect(view.hasSecret).toBe(false)
  })

  it('ready + env-file 拦截 → blocked + overridable（D5 派生）+ 违规清单透传 + hasSecret=false', () => {
    const view = guardScanView('ready', envScan)
    expect(view.blocked).toBe(true)
    expect(view.overridable).toBe(true)
    expect(view.hasSecret).toBe(false)
    expect(view.violations.map((violation) => violation.path)).toEqual(['.env'])
    expect(view.clean).toBe(false)
  })

  it('ready + secret 拦截 → hasSecret=true + overridable=false（D5：硬阻断不可豁免）', () => {
    const view = guardScanView('ready', secretScan)
    expect(view.hasSecret).toBe(true)
    expect(view.overridable).toBe(false)
    expect(view.violations.map((violation) => violation.kind)).toEqual(['secret', 'large-file'])
  })

  it('commitDialogView：blocked 且未豁免 ⇒ commitEnabled/pushEnabled=false + guardBlocked=true', () => {
    const view = commitDialogView({ ...baseInput(), guard: guardScanView('ready', envScan), overrideAcknowledged: false })
    expect(view.guardBlocked).toBe(true)
    expect(view.commitEnabled).toBe(false)
    expect(view.pushEnabled).toBe(false)
  })

  it('豁免状态机：blocked + overridable + 勾选豁免 ⇒ 放行；不可豁免（secret）勾选也不放行', () => {
    const overridable = commitDialogView({ ...baseInput(), guard: guardScanView('ready', envScan), overrideAcknowledged: true })
    expect(overridable.commitEnabled).toBe(true)
    expect(overridable.pushEnabled).toBe(true)
    const hardBlocked = commitDialogView({ ...baseInput(), guard: guardScanView('ready', secretScan), overrideAcknowledged: true })
    expect(hardBlocked.commitEnabled).toBe(false)
  })

  it('commitAllowedByGuard：blocked 未豁免不放行（点提交前最新裁决）；null/零违规放行', () => {
    expect(commitAllowedByGuard(envScan, false)).toBe(false)
    expect(commitAllowedByGuard(envScan, true)).toBe(true)
    expect(commitAllowedByGuard(secretScan, true)).toBe(false)
    expect(commitAllowedByGuard(cleanScan, false)).toBe(true)
    expect(commitAllowedByGuard(null, false)).toBe(true)
  })
})

describe('V2 批次三：hook 输出折叠区（[63]；redactTail 尾保留——P3-3 复活点）', () => {
  it('process null/undefined ⇒ 不可见（host 空输出置 null，plan §5.2）', () => {
    expect(processOutputView(null).visible).toBe(false)
    expect(processOutputView(undefined).visible).toBe(false)
  })

  it('短输出：stdout/stderr 原样透传 + timedOut/durationMs；空输出未超时 ⇒ 不可见', () => {
    const view = processOutputView({ stdout: 'hooks ran\n', stderr: '', timedOut: false, durationMs: 120 })
    expect(view.visible).toBe(true)
    expect(view.stdout).toBe('hooks ran\n')
    expect(view.stderr).toBe('')
    expect(view.timedOut).toBe(false)
    expect(view.durationMs).toBe(120)
    expect(view.truncated).toBe(false)
    expect(processOutputView({ stdout: '', stderr: '', timedOut: false, durationMs: 1 }).visible).toBe(false)
  })

  it('长输出：尾保留 + truncated + 凭证脱敏（先 redact 再保尾）', () => {
    const long = `token=supersecret ${'x'.repeat(3000)} TAIL-MARKER`
    const view = processOutputView({ stdout: long, stderr: '', timedOut: false, durationMs: 5 })
    expect(view.truncated).toBe(true)
    expect(view.stdout.startsWith('…')).toBe(true)
    expect(view.stdout.endsWith('TAIL-MARKER')).toBe(true)
    expect(view.stdout).not.toContain('supersecret')
    expect(view.stdout.length).toBeLessThanOrEqual(2001)
  })

  it('timedOut 单独可见（即便两侧输出为空）', () => {
    const view = processOutputView({ stdout: '', stderr: '', timedOut: true, durationMs: 30_000 })
    expect(view.visible).toBe(true)
    expect(view.timedOut).toBe(true)
  })

  it('processFromHookError：git/hook-failed details.stderr → stderr 视图（尾保留 + 脱敏）；无 stderr ⇒ null', () => {
    const view = processFromHookError({
      code: 'git/hook-failed',
      message: 'hook rejected',
      details: { op: 'commit', exitCode: 1, stderr: `password=hunter2 ${'y'.repeat(2500)} END`, truncated: false },
    })
    expect(view).not.toBeNull()
    expect(view?.stderr.startsWith('…')).toBe(true)
    expect(view?.stderr.endsWith('END')).toBe(true)
    expect(view?.stderr).not.toContain('hunter2')
    expect(view?.stdout).toBe('')
    expect(processFromHookError({ code: 'git/hook-failed', message: 'x', details: {} })).toBeNull()
    expect(processFromHookError(null)).toBeNull()
  })
})

// ── 评审修复补测（本批独立评审三条的 view-model 半）──

describe('评审修复①：「已提交」终态闸（[63] 成功路径可达——对话框保持打开）', () => {
  it('succeeded=true ⇒ commitEnabled/pushEnabled false + amendAvailable false + succeeded 位', () => {
    const view = commitDialogView({ ...baseInput(), succeeded: true })
    expect(view.succeeded).toBe(true)
    expect(view.commitEnabled).toBe(false)
    expect(view.pushEnabled).toBe(false)
    expect(view.amendAvailable).toBe(false)
  })

  it('succeeded 缺省（undefined）→ 既有闸语义零变化（成功前路径回归面）', () => {
    const view = commitDialogView(baseInput())
    expect(view.succeeded).toBe(false)
    expect(view.commitEnabled).toBe(true)
    expect(view.pushEnabled).toBe(true)
  })

  it('succeeded=true 时护栏豁免勾选也不放行（终态先于护栏闸）', () => {
    const envScan = {
      blocked: true,
      violations: [{ kind: 'env-file' as const, path: '.env', detail: 'staged env file', sizeBytes: 120, line: null, redactedMatch: null }],
    }
    const view = commitDialogView({
      ...baseInput(), succeeded: true,
      guard: guardScanView('ready', envScan), overrideAcknowledged: true,
    })
    expect(view.commitEnabled).toBe(false)
  })
})

describe('评审修复③：豁免 TOCTOU 闸——violationsSignature + 签名绑定裁决', () => {
  const envViolation = { kind: 'env-file' as const, path: '.env', detail: 'staged env file', sizeBytes: 120, line: null, redactedMatch: null }
  const bigViolation = { kind: 'large-file' as const, path: 'bundle.js', detail: '2.5 MiB', sizeBytes: 2_621_440, line: null, redactedMatch: null }
  const envScan = { blocked: true, violations: [envViolation] }
  const freshScan = { blocked: true, violations: [envViolation, bigViolation] }

  it('violationsSignature：kind:path:line 决定签名；sizeBytes/detail/redactedMatch 不参与', () => {
    expect(violationsSignature([envViolation])).toBe('env-file:.env:')
    expect(violationsSignature([{ ...envViolation, detail: 'changed', sizeBytes: 999, redactedMatch: 'x' }]))
      .toBe(violationsSignature([envViolation]))
    expect(violationsSignature([{ ...envViolation, line: 3 }])).not.toBe(violationsSignature([envViolation]))
    expect(violationsSignature([envViolation, bigViolation]))
      .toBe('env-file:.env:|large-file:bundle.js:')
    expect(violationsSignature([])).toBe('')
  })

  it('fresh 违规集与豁免签名一致 ⇒ 豁免承认（同集重扫不吞豁免）', () => {
    const signature = violationsSignature(envScan.violations)
    expect(commitAllowedByGuard(envScan, true, signature)).toBe(true)
  })

  it('fresh 违规集已变（新增违规）⇒ 上一个集的豁免不承认（TOCTOU 钉死）', () => {
    const staleSignature = violationsSignature(envScan.violations)
    expect(commitAllowedByGuard(freshScan, true, staleSignature)).toBe(false)
    // 重新对新集勾选（签名 = fresh 集）⇒ 放行。
    expect(commitAllowedByGuard(freshScan, true, violationsSignature(freshScan.violations))).toBe(true)
  })

  it('secret 硬阻断与签名无关（签名一致也不放行）；blocked 未豁免不放行不变', () => {
    const secretScan = {
      blocked: true,
      violations: [{ kind: 'secret' as const, path: 'keys.txt', detail: 'aws key id', sizeBytes: null, line: 3, redactedMatch: 'AKIA***' }],
    }
    const signature = violationsSignature(secretScan.violations)
    expect(commitAllowedByGuard(secretScan, true, signature)).toBe(false)
    expect(commitAllowedByGuard(envScan, false)).toBe(false)
  })

  it('overrideSignature 缺省 → 既有两参语义零变化；scan null → 放行不变', () => {
    expect(commitAllowedByGuard(envScan, true)).toBe(true)
    expect(commitAllowedByGuard(null, false)).toBe(true)
  })
})
