/**
 * v3 批次四 — 检查点/归因测试（[清单 39/40/41]；docs/v3-implementation-plan.md §6.7）。
 *
 * 覆盖：
 *   - hunk→patch 序列化六态夹具（新增/修改/删除/binary/oversized/coarse）逐态 patch
 *     文本断言（纯函数面——checkpoints.ts serializeCheckpointPatch/FilePatch）；
 *   - fake session 事件流建索引：turn/end 与 workspace/changes 双先到序、同 turn
 *     替换、session disposed 清理、环容量截断、缺 seq/turn 降级跳过、resolveSeq 三态；
 *   - attribution 求交四态（agent/mixed 走 mtime 近似判定，utimes 确定性控制）；
 *   - 真仓 restore 集成（真 git apply -R 落盘）：turn 内新增 → 文件消失、修改 →
 *     回 turn 前值、turn 后用户再改 → failed 列表部分成功、baseRevision 过期拒绝、
 *     coarse/二进制/超大/工作区外路径/CRLF/子目录 cwd 折算各一、paths 子集与守卫、
 *     审计双出口（world 重读纪律——独立 git 进程验证，不信 RPC 自述）；
 *   - 降级路径：workspaceChanges face 缺失 ⇒ list 的 summary null + unavailable 码；
 *     无事件 ⇒ list 空。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/index.ts'
import { repoRelativePath, serializeCheckpointFilePatch, serializeCheckpointPatch } from '../src/checkpoints.ts'
import { SessionWatch } from '../src/session-watch.ts'
import type { CheckpointIndexEntry, GitChangesSummaryFace, GitWorkspaceChangesFace, SessionWatchHost } from '../src/session-watch.ts'
import type { AttributionResult, CheckpointFileDiff, CheckpointListResult, CheckpointRestoreResult } from '../src/types.ts'
import { git, makeGitService, scratchRepo } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ---------- 事件夹具（fake session 事件流——事件形状照 createAppendEvent 冻结投影） ----------

const SID = 'sess-fixture'
/** 事件时间基准（epoch ms；远大于测试进程的真实 mtime，utimes 控制文件时间即可分档）。 */
const T0 = 2_000_000_000_000

function fakeSession(id: string = SID): { id: string; header: Record<string, never> } {
  return { id, header: {} }
}

function changeEvent(seq: number, turn: number, time: number = T0): { type: string; seq: number; time: number; data: { turn: number } } {
  return { type: 'workspace/changes', seq, time, data: { turn } }
}

function endEvent(turn: number, time: number, reasonKind = 'completed'): { type: string; time: number; data: { turn: number; reason: { kind: string } } } {
  return { type: 'turn/end', time, data: { turn, reason: { kind: reasonKind } } }
}

// ---------- 序列化六态夹具（纯函数——plan §6.4/§6.7 第一项） ----------

describe('serializeCheckpointPatch — hunk→patch 序列化六态（逐态 patch 文本断言）', () => {
  it('新增（before=false, after=true）：/dev/null 头 + new file mode + 零行侧起点归一 @@ -0,0', () => {
    const patch = serializeCheckpointPatch({
      path: 'n.txt', before: false, after: true,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+l1', '+l2'] }],
    })
    expect(patch).toContain('diff --git a/n.txt b/n.txt')
    expect(patch).toContain('new file mode 100644')
    expect(patch).toContain('--- /dev/null')
    expect(patch).toContain('+++ b/n.txt')
    // jsdiff 形状的「1 起 0 行」归一为 git 惯例的 0 起 0 行。
    expect(patch).toContain('@@ -0,0 +1,2 @@')
    expect(patch).toContain('+l1\n+l2')
    expect(patch?.endsWith('\n')).toBe(true)
  })

  it('修改（两侧存在）：a/ b/ 头 + 上下文行计数自 body 重算（上下文两侧都计）', () => {
    const patch = serializeCheckpointPatch({
      path: 'm.txt', before: true, after: true,
      hunks: [{ oldStart: 2, oldLines: 9, newStart: 2, newLines: 9, lines: [' beta', '-old', '+new', ' gamma'] }],
    })
    expect(patch).toContain('diff --git a/m.txt b/m.txt')
    expect(patch).not.toContain('file mode')
    expect(patch).toContain('--- a/m.txt')
    expect(patch).toContain('+++ b/m.txt')
    // 计数 = body 重算（2 上下文 + 1 旧行 = 3；2 上下文 + 1 新行 = 3）——面值漂移不进 patch。
    expect(patch).toContain('@@ -2,3 +2,3 @@')
    expect(patch).toContain(' beta\n-old\n+new\n gamma')
  })

  it('删除（before=true, after=false）：deleted file mode + +++ /dev/null + @@ -1,N +0,0', () => {
    const patch = serializeCheckpointPatch({
      path: 'g.txt', before: true, after: false,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-l1', '-l2'] }],
    })
    expect(patch).toContain('diff --git a/g.txt b/g.txt')
    expect(patch).toContain('deleted file mode 100644')
    expect(patch).toContain('--- a/g.txt')
    expect(patch).toContain('+++ /dev/null')
    expect(patch).toContain('@@ -1,2 +0,0 @@')
    expect(patch).toContain('-l1\n-l2')
  })

  it('binary / oversized：无 hunk 可序列化 ⇒ null（恢复面如实 failed）', () => {
    expect(serializeCheckpointFilePatch({ kind: 'binary', path: 'b.bin', display: 'b.bin' })).toBeNull()
    expect(serializeCheckpointFilePatch({ kind: 'oversized', path: 'h.txt', display: 'h.txt' })).toBeNull()
    expect(serializeCheckpointPatch({ path: 'b.bin', before: true, after: true, hunks: [] })).toBe('')
  })

  it('coarse：零上下文整段替换 hunk 原样过（@@ -1,M +1,N，无 --unidiff-zero 依赖的文本面）', () => {
    const patch = serializeCheckpointFilePatch({
      kind: 'text', path: 'c.txt', display: 'c.txt', before: true, after: true, coarse: true,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-a1', '-a2', '+b1', '+b2'] }],
    })
    expect(patch).toContain('@@ -1,2 +1,2 @@')
    expect(patch).toContain('-a1\n-a2\n+b1\n+b2')
  })

  it('两侧同行（hunks=[]）⇒ 空串 no-op；Windows 反斜杠路径归一正斜杠', () => {
    expect(serializeCheckpointFilePatch({
      kind: 'text', path: 'same.txt', display: 'same.txt', before: true, after: true, coarse: false, hunks: [],
    })).toBe('')
    const patch = serializeCheckpointPatch({
      path: 'nested\\dir\\f.txt', before: true, after: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }],
    })
    expect(patch).toContain('diff --git a/nested/dir/f.txt b/nested/dir/f.txt')
    expect(patch).not.toContain('\\')
  })

  it('病态路径（空串 / /dev/null / 含换行）⇒ null（不产出可注入的 patch 头）', () => {
    expect(serializeCheckpointPatch({ path: '', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }] })).toBeNull()
    expect(serializeCheckpointPatch({ path: '/dev/null', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }] })).toBeNull()
    expect(serializeCheckpointPatch({ path: 'a\nb', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }] })).toBeNull()
  })
})

describe('repoRelativePath — 会话 cwd → 仓库相对折算', () => {
  it('cwd == repoRoot：相对路径直通', () => {
    expect(repoRelativePath('D:/repo', 'D:/repo', 'a.txt')).toBe('a.txt')
  })
  it('cwd 为子目录：相对路径折算出仓库相对形态', () => {
    expect(repoRelativePath('D:/repo', 'D:/repo/nested', 'f.txt')).toBe('nested/f.txt')
  })
  it('绝对路径在仓库内：折算仓库相对', () => {
    expect(repoRelativePath('D:/repo', undefined, 'D:/repo/nested/f.txt')).toBe('nested/f.txt')
  })
  it('越出仓库根 / 根自身：null', () => {
    expect(repoRelativePath('D:/repo', 'D:/other', 'x.txt')).toBeNull()
    expect(repoRelativePath('D:/repo', undefined, 'D:/repo')).toBeNull()
    expect(repoRelativePath('D:/repo', undefined, '')).toBeNull()
  })
})

// ---------- fake session 事件流建索引（plan §6.7 第二项） ----------

describe('SessionWatch — fake session 事件流建索引', () => {
  it('turn/end 先到 + workspace/changes 后到：endedAt/reason 直接补齐（双向序其一）', () => {
    const watch = new SessionWatch()
    watch.observe(fakeSession(), endEvent(3, T0 + 500, 'completed'))
    watch.observe(fakeSession(), changeEvent(7, 3))
    const entries = watch.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sessionId: SID, seq: 7, turn: 3, reason: 'completed' })
    expect(entries[0]!.endedAt).toBe(new Date(T0 + 500).toISOString())
  })

  it('workspace/changes 先到 + turn/end 后到：endedAt 先用事件时间、turn/end 原位更新', () => {
    const watch = new SessionWatch()
    watch.observe(fakeSession(), changeEvent(7, 3, T0))
    expect(watch.entries()[0]!.endedAt).toBe(new Date(T0).toISOString())
    expect(watch.entries()[0]!.reason).toBeNull()
    watch.observe(fakeSession(), endEvent(3, T0 + 500, 'aborted'))
    expect(watch.entries()[0]!.endedAt).toBe(new Date(T0 + 500).toISOString())
    expect(watch.entries()[0]!.reason).toBe('aborted')
  })

  it('同 turn 的最新 workspace/changes 替换旧行（seq/recordedAt 取最新）', () => {
    const watch = new SessionWatch()
    watch.observe(fakeSession(), changeEvent(7, 3, T0))
    watch.observe(fakeSession(), changeEvent(9, 3, T0 + 100))
    const entries = watch.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ seq: 9, turn: 3 })
    expect(entries[0]!.endedAt).toBe(new Date(T0 + 100).toISOString())
  })

  it('session/disposed 清理该会话全部索引', () => {
    const watch = new SessionWatch()
    watch.observe(fakeSession(), changeEvent(1, 1))
    watch.observe(fakeSession('sess-other'), changeEvent(1, 1))
    expect(watch.entries()).toHaveLength(2)
    watch.forget(SID)
    expect(watch.entries()).toHaveLength(1)
    expect(watch.ringOf(SID)).toEqual([])
    expect(watch.ringOf('sess-other')).toHaveLength(1)
  })

  it('环容量截断：maxTurns=3 时保留最新三回合（newest-first）', () => {
    const watch = new SessionWatch(undefined, { maxTurns: 3 })
    for (let turn = 1; turn <= 5; turn += 1) {
      watch.observe(fakeSession(), changeEvent(turn, turn, T0 + turn * 10))
    }
    expect(watch.ringOf(SID)).toHaveLength(3)
    expect(watch.entries().map((entry: CheckpointIndexEntry) => entry.turn)).toEqual([5, 4, 3])
  })

  it('缺 seq / 缺 turn 的事件降级跳过（不炸监听——plan §6.9 残余风险守卫）', () => {
    const watch = new SessionWatch()
    watch.observe(fakeSession(), { type: 'workspace/changes', data: { turn: 1 } }) // 无 seq
    watch.observe(fakeSession(), { type: 'workspace/changes', seq: 1 }) // 无 data
    watch.observe(fakeSession(), { type: 'workspace/changes', seq: 2, data: { turn: 'nope' } }) // turn 非数
    watch.observe(fakeSession(), endEvent(1, T0))
    expect(watch.entries()).toEqual([])
    // 空 id / 无 id 的会话整体跳过（运行时守卫——面类型必填 id，缺 id 形态经 cast 注入）。
    watch.observe({ id: '', header: {} }, changeEvent(3, 1))
    watch.observe({ header: {} } as unknown as { id: string; header: Record<string, never> }, changeEvent(4, 1))
    expect(watch.entries()).toEqual([])
  })

  it('resolveSeq 三态：唯一命中 / 零命中 / 跨会话歧义；sessionId 判别半收窄到单会话环（评审收口）', () => {
    const watch = new SessionWatch()
    watch.observe(fakeSession(SID), changeEvent(5, 1))
    watch.observe(fakeSession('sess-b'), changeEvent(5, 2))
    expect(watch.resolveSeq(5)).toMatchObject({ kind: 'ambiguous', sessionIds: ['sess-b', SID] })
    // sessionId 判别半（wire 可选回传）：单会话环内解析——碰撞不再歧义；判别半下
    // 'ambiguous' 不可达；未知会话 = missing（诚实拒绝，不跨环寻址）。
    expect(watch.resolveSeq(5, 'sess-b')).toMatchObject({ kind: 'unique', sessionId: 'sess-b' })
    expect(watch.resolveSeq(5, SID)).toMatchObject({ kind: 'unique', sessionId: SID })
    expect(watch.resolveSeq(5, 'no-such-session').kind).toBe('missing')
    watch.forget('sess-b')
    const unique = watch.resolveSeq(5)
    expect(unique).toMatchObject({ kind: 'unique', sessionId: SID })
    expect(unique.kind === 'unique' && unique.entry.seq).toBe(5)
    expect(watch.resolveSeq(999).kind).toBe('missing')
  })

  it('构造期经宿主面自挂 session/event + session/disposed（workspace.ts 先例形态）', () => {
    const registered: Array<{ event: string; invoke: (...args: unknown[]) => void }> = []
    const host: SessionWatchHost = {
      on(event, listener) {
        registered.push({ event, invoke: listener as unknown as (...args: unknown[]) => void })
        return listener
      },
    }
    const watch = new SessionWatch(host, { maxTurns: 2 })
    expect(registered.map((row) => row.event).sort()).toEqual(['session/disposed', 'session/event'])
    registered.find((row) => row.event === 'session/event')!.invoke(fakeSession(), changeEvent(1, 1))
    expect(watch.entries()).toHaveLength(1)
    registered.find((row) => row.event === 'session/disposed')!.invoke(fakeSession())
    expect(watch.entries()).toEqual([])
  })
})

// ---------- 服务级集成（真仓 + 真 git apply；world 重读纪律） ----------

/** workspaceChanges 面替身：records 按 seq 供 summary/diff（形状照 dsh WorkspaceChanges）。 */
interface FakeRecord {
  turn: number
  cwd: string
  files: Array<{ path: string; display: string; added: number; deleted: number }>
  diffs: Map<number, CheckpointFileDiff>
  /** 可选 total 覆写（模拟 workspace-changes 的 maxFiles 封顶——total 计全量、files 截断）。 */
  total?: number
}

function fakeFace(records: Map<number, FakeRecord>): GitWorkspaceChangesFace {
  return {
    summary(sessionId, seq) {
      void sessionId
      const record = records.get(seq)
      if (record === undefined) return undefined
      const summary: GitChangesSummaryFace = {
        turn: record.turn,
        cwd: record.cwd,
        files: record.files,
        total: record.total ?? record.files.length,
        added: record.files.reduce((sum, file) => sum + file.added, 0),
        deleted: record.files.reduce((sum, file) => sum + file.deleted, 0),
      }
      return summary
    },
    async diff(sessionId, seq, index) {
      void sessionId
      return records.get(seq)?.diffs.get(index)
    },
  }
}

function makeService(workspaceOverride: string, face?: GitWorkspaceChangesFace): InstanceType<typeof GitService> {
  // 装配去重：Context+subprocess 面经 support.makeGitService；workspaceChanges 的
  // 构造前注入经 provides（时序不变：subprocess → provides → 构造）。
  return makeGitService(workspaceOverride, {
    commitTimeoutMs: 15_000,
    autoFetchIntervalMs: 0,
    ...(face !== undefined ? { provides: [['workspaceChanges', face] as const] } : {}),
  }).service
}

function feedChange(service: InstanceType<typeof GitService>, seq: number, turn: number, time = T0, sessionId = SID): void {
  service.sessionWatchOf().observe({ id: sessionId, header: {} }, changeEvent(seq, turn, time))
}

function feedEnd(service: InstanceType<typeof GitService>, turn: number, time = T0, reasonKind = 'completed'): void {
  service.sessionWatchOf().observe({ id: SID, header: {} }, endEvent(turn, time, reasonKind))
}

// ---------- world 重读（独立 git 进程，验证世界而非自述） ----------

function worldHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function worldPorcelain(repo: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const error = await run().then(
    () => { throw new Error('expected rejection') },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(error)
  expect(remote, 'expected a RemoteError with a domain code').not.toBeNull()
  return {
    code: remote!.code,
    message: (error as Error).message,
    details: (remote!.details ?? {}) as Record<string, unknown>,
  }
}

/** 文本 diff 便捷构造（kind: 'text' 的最小合法形状）。 */
function textDiff(
  path: string,
  before: boolean,
  after: boolean,
  hunks: Extract<CheckpointFileDiff, { kind: 'text' }>['hunks'],
  coarse = false,
): CheckpointFileDiff {
  return { kind: 'text', path, display: path, before, after, coarse, hunks }
}

/**
 * restore 世界的公共夹具：HEAD 含 a.txt/d.txt/r.txt（初值），turn-3 之后的工作区状态
 * = a.txt 修改、c.txt 新增、d.txt 删除、r.txt 整文件替换（coarse 形状）。返回
 * service + face records（seq=5, turn=3）。
 */
async function makeRestoreWorld(userChangedA = false): Promise<{
  repo: string
  service: InstanceType<typeof GitService>
  headOid: string
  records: Map<number, FakeRecord>
}> {
  const repo = await scratchRepo('dshgit-ckpt-restore-', cleanups, { name: 't', email: 't@example.com' })
  git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'a.txt'), 'a1\na2\na3\n', 'utf8')
  await writeFile(join(repo, 'd.txt'), 'd1\nd2\n', 'utf8')
  await writeFile(join(repo, 'r.txt'), 'r1\nr2\n', 'utf8')
  git(repo, 'add', '--', 'a.txt', 'd.txt', 'r.txt')
  git(repo, 'commit', '-qm', 'base')
  const headOid = worldHead(repo)
  // turn-3 终态工作区（检查点记录描述的「回合结束后」世界）。
  await writeFile(join(repo, 'a.txt'), userChangedA ? 'a1\nUSER\na3\n' : 'a1\nX2\na3\n', 'utf8')
  await writeFile(join(repo, 'c.txt'), 'c1\nc2\n', 'utf8')
  await rm(join(repo, 'd.txt'))
  await writeFile(join(repo, 'r.txt'), 'R1\nR2\nR3\nR4\n', 'utf8')
  const records = new Map<number, FakeRecord>([[
    5, {
      turn: 3,
      cwd: repo,
      files: [
        { path: 'a.txt', display: 'a.txt', added: 1, deleted: 1 },
        { path: 'c.txt', display: 'c.txt', added: 2, deleted: 0 },
        { path: 'd.txt', display: 'd.txt', added: 0, deleted: 2 },
        { path: 'r.txt', display: 'r.txt', added: 4, deleted: 2 },
      ],
      diffs: new Map<number, CheckpointFileDiff>([
        [0, textDiff('a.txt', true, true, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a1', '-a2', '+X2', ' a3'] }])],
        [1, textDiff('c.txt', false, true, [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+c1', '+c2'] }])],
        [2, textDiff('d.txt', true, false, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-d1', '-d2'] }])],
        // coarse 形状（compareText 超时回退：全部旧行 - 在前、全部新行 + 在后，零上下文）。
        [3, textDiff('r.txt', true, true, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines: ['-r1', '-r2', '+R1', '+R2', '+R3', '+R4'] }], true)],
      ]),
    },
  ]])
  const service = makeService(repo, fakeFace(records))
  feedChange(service, 5, 3)
  return { repo, service, headOid, records }
}

describe('checkpointRestore — 真仓集成（真 git apply -R，world 重读）', () => {
  it('turn 内新增/修改/删除/替换全量恢复：文件消失/回值/重现，worktree 回 HEAD（world 重读）', async () => {
    const { repo, service, headOid } = await makeRestoreWorld()
    const result = await service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid }) as CheckpointRestoreResult
    expect(result.applied.sort()).toEqual(['a.txt', 'c.txt', 'd.txt', 'r.txt'])
    expect(result.failed).toEqual([])
    // world 重读：新增消失、修改回值、删除重现、coarse 替换回值、worktree 干净（== HEAD）。
    expect(existsSync(join(repo, 'c.txt'))).toBe(false)
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'a.txt'), 'utf8'))).toBe('a1\na2\na3\n')
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'd.txt'), 'utf8'))).toBe('d1\nd2\n')
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'r.txt'), 'utf8'))).toBe('r1\nr2\n')
    expect(worldPorcelain(repo)).toBe('')
  })

  it('子目录会话 cwd 的路径折算：summary cwd = repo/nested、path = f.txt ⇒ 折算 nested/f.txt 应用', async () => {
    const repo = await scratchRepo('dshgit-ckpt-nested-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(repo, 'nested'), { recursive: true })
    await writeFile(join(repo, 'nested', 'f.txt'), 'f1\nf2\nf3\n', 'utf8')
    git(repo, 'add', '--', 'nested/f.txt')
    git(repo, 'commit', '-qm', 'base')
    await writeFile(join(repo, 'nested', 'f.txt'), 'f1\nFF2\nf3\n', 'utf8')
    const records = new Map<number, FakeRecord>([[
      9, {
        turn: 2,
        cwd: join(repo, 'nested'), // 会话工作目录 = 仓库子目录
        files: [{ path: 'f.txt', display: 'f.txt', added: 1, deleted: 1 }],
        diffs: new Map<number, CheckpointFileDiff>([
          [0, textDiff('f.txt', true, true, [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [' f1', '-f2', '+FF2', ' f3'] }])],
        ]),
      },
    ]])
    const service = makeService(repo, fakeFace(records))
    feedChange(service, 9, 2)
    const result = await service.checkpointRestore({ seq: 9, paths: null, acknowledged: true, baseRevision: worldHead(repo) }) as CheckpointRestoreResult
    expect(result.applied).toEqual(['f.txt'])
    expect(result.failed).toEqual([])
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'nested', 'f.txt'), 'utf8'))).toBe('f1\nf2\nf3\n')
    expect(worldPorcelain(repo)).toBe('')
  })

  it('turn 后用户再改 a.txt：apply 失败 ⇒ failed 列表（部分成功——已成功项不回滚）', async () => {
    const { repo, service, headOid } = await makeRestoreWorld(true)
    const result = await service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid }) as CheckpointRestoreResult
    expect(result.applied.sort()).toEqual(['c.txt', 'd.txt', 'r.txt'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.path).toBe('a.txt')
    expect(result.failed[0]!.reason).toContain('patch does not apply')
    // world 重读：其余三文件已恢复、a.txt 保留用户改后内容。
    expect(existsSync(join(repo, 'c.txt'))).toBe(false)
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'a.txt'), 'utf8'))).toBe('a1\nUSER\na3\n')
  })

  it('baseRevision 过期拒绝（零命令）+ unacknowledged 零命令 + 未知 seq ⇒ checkpoint-unavailable', async () => {
    const { repo, service, headOid } = await makeRestoreWorld()
    const stale = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: 'f'.repeat(40) }))
    expect(stale.code).toBe('git/bad-request')
    expect(stale.details).toMatchObject({ reason: 'stale-base-revision', expected: 'f'.repeat(40), actual: headOid })
    expect(existsSync(join(repo, 'c.txt'))).toBe(true)
    const unacked = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: null, acknowledged: false, baseRevision: headOid }))
    expect(unacked.code).toBe('git/bad-request')
    expect(unacked.details).toMatchObject({ reason: 'unacknowledged' })
    expect(existsSync(join(repo, 'c.txt'))).toBe(true)
    const unknownSeq = await rejectionOf(() => service.checkpointRestore({ seq: 999, paths: null, acknowledged: true, baseRevision: headOid }))
    expect(unknownSeq.code).toBe('git/checkpoint-unavailable')
    expect(unknownSeq.details).toEqual({ seq: 999 })
    expect(existsSync(join(repo, 'c.txt'))).toBe(true)
  })

  it('paths 子集恢复 + 空数组 no-paths + 记录外路径 bad-request（零命令）', async () => {
    const { repo, service, headOid } = await makeRestoreWorld()
    const subset = await service.checkpointRestore({ seq: 5, paths: ['c.txt'], acknowledged: true, baseRevision: headOid }) as CheckpointRestoreResult
    expect(subset.applied).toEqual(['c.txt'])
    expect(subset.failed).toEqual([])
    expect(existsSync(join(repo, 'c.txt'))).toBe(false)
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'a.txt'), 'utf8'))).toBe('a1\nX2\na3\n')
    const empty = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: [], acknowledged: true, baseRevision: headOid }))
    expect(empty.code).toBe('git/no-paths')
    const alien = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: ['nope.txt'], acknowledged: true, baseRevision: headOid }))
    expect(alien.code).toBe('git/bad-request')
    expect(alien.details).toMatchObject({ reason: 'invalid-options' })
    expect(existsSync(join(repo, 'c.txt'))).toBe(false) // 守卫失败后零命令（c.txt 未复活）
  })

  it('binary/oversized 记录：恢复面 failed（部分成功——其余文本文件照常恢复）', async () => {
    const { service, headOid, records } = await makeRestoreWorld()
    records.get(5)!.files.push({ path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0 })
    records.get(5)!.diffs.set(4, { kind: 'binary', path: 'bin.dat', display: 'bin.dat' })
    records.get(5)!.files.push({ path: 'huge.txt', display: 'huge.txt', added: 0, deleted: 0 })
    records.get(5)!.diffs.set(5, { kind: 'oversized', path: 'huge.txt', display: 'huge.txt' })
    const result = await service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid }) as CheckpointRestoreResult
    expect(result.applied.sort()).toEqual(['a.txt', 'c.txt', 'd.txt', 'r.txt'])
    const reasons = new Map(result.failed.map((row) => [row.path, row.reason]))
    expect(reasons.get('bin.dat')).toContain('binary')
    expect(reasons.get('huge.txt')).toContain('oversized')
  })

  it('CRLF 内容的修改恢复（autocrlf=false 夹具——行尾漂移不阻断）', async () => {
    const repo = await scratchRepo('dshgit-ckpt-crlf-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    await writeFile(join(repo, 'eol.txt'), 'one\r\ntwo\r\n', 'utf8')
    git(repo, 'add', '--', 'eol.txt')
    git(repo, 'commit', '-qm', 'base')
    await writeFile(join(repo, 'eol.txt'), 'one\r\nTWO-CRLF\r\n', 'utf8')
    const records = new Map<number, FakeRecord>([[
      8, {
        turn: 1,
        cwd: repo,
        files: [{ path: 'eol.txt', display: 'eol.txt', added: 1, deleted: 1 }],
        diffs: new Map<number, CheckpointFileDiff>([
          // compareText 的行按 \n 切分、不含 \n 本体——CRLF 行只带尾部 \r。
          [0, textDiff('eol.txt', true, true, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one\r', '-two\r', '+TWO-CRLF\r'] }])],
        ]),
      },
    ]])
    const service = makeService(repo, fakeFace(records))
    feedChange(service, 8, 1)
    const result = await service.checkpointRestore({ seq: 8, paths: null, acknowledged: true, baseRevision: worldHead(repo) }) as CheckpointRestoreResult
    expect(result.failed).toEqual([])
    expect(result.applied).toEqual(['eol.txt'])
    expect(await import('node:fs/promises').then((fs) => fs.readFile(join(repo, 'eol.txt'), 'utf8'))).toBe('one\r\ntwo\r\n')
    expect(worldPorcelain(repo)).toBe('')
  })

  it('审计双出口：成功 ok:true 入环；stale-base 失败 ok:false + code 入环（§6.5 纪律）', async () => {
    const { service, headOid } = await makeRestoreWorld()
    void headOid
    await service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid })
    await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: 'f'.repeat(40) }))
    const log = await service.auditLog({ limit: 10 })
    const rows = log.entries.filter((entry) => entry.op === 'checkpointRestore')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]).toMatchObject({ ok: false, code: 'git/bad-request' })
    expect(rows[rows.length - 1]).toMatchObject({ ok: true, code: null })
    // summary 只含参数摘要（不落文件内容——spec §1.0.6 纪律延伸）。
    expect(rows[rows.length - 1]!.summary).not.toContain('a1')
  })
})

describe('checkpointRestore — sessionId 判别半 + recorder 封顶如实分列（评审收口）', () => {
  it('多会话 seq 碰撞：裸 seq 歧义硬拒（零命令）；带 sessionId 唯一解析照常恢复（world 重读）', async () => {
    const { repo, service, headOid } = await makeRestoreWorld()
    feedChange(service, 5, 3, T0, 'sess-b') // 第二会话同 seq ⇒ 跨会话碰撞
    const ambiguous = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid }))
    expect(ambiguous.code).toBe('git/checkpoint-unavailable')
    expect(String(ambiguous.message)).toContain('several live sessions')
    expect(existsSync(join(repo, 'c.txt'))).toBe(true) // 歧义拒绝零命令
    const restored = await service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid, sessionId: SID }) as CheckpointRestoreResult
    expect(restored.applied.sort()).toEqual(['a.txt', 'c.txt', 'd.txt', 'r.txt'])
    expect(worldPorcelain(repo)).toBe('')
  })

  it('restore-all 于封顶记录 fail-closed：checkpoint-unavailable 零命令（文案带 N/M 与补救路径）', async () => {
    const { repo, service, headOid, records } = await makeRestoreWorld()
    records.get(5)!.total = 6 // 4 listed / 6 total——workspace-changes maxFiles 封顶形状
    const capped = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: null, acknowledged: true, baseRevision: headOid }))
    expect(capped.code).toBe('git/checkpoint-unavailable')
    expect(String(capped.message)).toContain('capped to 4 of 6')
    expect(existsSync(join(repo, 'c.txt'))).toBe(true) // 静默欠恢复被前置拒绝（零命令）
  })

  it('显式 paths 于封顶记录可点名清单内文件；记录外路径文案区分「封顶截去」与「确不在记录」', async () => {
    const { repo, service, headOid, records } = await makeRestoreWorld()
    records.get(5)!.total = 6
    const subset = await service.checkpointRestore({ seq: 5, paths: ['c.txt'], acknowledged: true, baseRevision: headOid }) as CheckpointRestoreResult
    expect(subset.applied).toEqual(['c.txt'])
    const cappedAway = await rejectionOf(() => service.checkpointRestore({ seq: 5, paths: ['ghost.txt'], acknowledged: true, baseRevision: worldHead(repo) }))
    expect(cappedAway.code).toBe('git/bad-request')
    expect(String(cappedAway.message)).toContain('cut by the recorder file cap')
    // 未截断记录的同形拒绝维持旧文案——两种「不在清单」可区分。
    const plain = await makeRestoreWorld()
    const plainAlien = await rejectionOf(() => plain.service.checkpointRestore({ seq: 5, paths: ['ghost.txt'], acknowledged: true, baseRevision: plain.headOid }))
    expect(plainAlien.code).toBe('git/bad-request')
    expect(String(plainAlien.message)).toContain('not part of the checkpoint record')
  })
})

describe('checkpointList / checkpointDiff — 索引面与投影', () => {
  it('list：环内索引 newest-first + summary 现读投影（files 只带 path/added/deleted）', async () => {
    const { service } = await makeRestoreWorld()
    const list = await service.checkpointList(null) as CheckpointListResult
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0]).toMatchObject({ sessionId: SID, seq: 5, turn: 3 })
    expect(list.entries[0]!.endedAt).toBe(new Date(T0).toISOString())
    expect(list.entries[0]!.summary).toMatchObject({ total: 4 })
    expect(list.entries[0]!.summary?.files[0]).toEqual({ path: 'a.txt', added: 1, deleted: 1 })
    expect(JSON.stringify(list.entries[0]!.summary)).not.toContain('display')
    // limit 切片 + 非法 limit 守卫。
    expect((await service.checkpointList(1)).entries).toHaveLength(1)
    await expect(service.checkpointList(0)).rejects.toMatchObject({ code: 'git/bad-request' })
    await expect(service.checkpointList(1.5)).rejects.toMatchObject({ code: 'git/bad-request' })
  })

  it('diff：合法 index 投影过线（text 形状全字段）；index 越界 ⇒ bad-request', async () => {
    const { service } = await makeRestoreWorld()
    const file = await service.checkpointDiff({ seq: 5, index: 1 }) as CheckpointFileDiff
    expect(file).toEqual({
      kind: 'text', path: 'c.txt', display: 'c.txt', before: false, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+c1', '+c2'] }],
    })
    await expect(service.checkpointDiff({ seq: 5, index: 99 })).rejects.toMatchObject({ code: 'git/bad-request' })
    await expect(service.checkpointDiff({ seq: 999, index: 0 })).rejects.toMatchObject({ code: 'git/checkpoint-unavailable', details: { seq: 999 } })
  })

  it('list 投影 turn/end reason（评审收口：wire CheckpointEntry.reason 过线）；未观察 turn/end ⇒ null', async () => {
    const noEnd = await makeRestoreWorld()
    expect((await noEnd.service.checkpointList(null) as CheckpointListResult).entries[0]!.reason).toBeNull()
    const ended = await makeRestoreWorld()
    feedEnd(ended.service, 3, T0 + 900, 'aborted')
    expect((await ended.service.checkpointList(null) as CheckpointListResult).entries[0]!.reason).toBe('aborted')
  })

  it('diff sessionId 判别半：多会话 seq 碰撞下裸 seq 歧义硬拒、带回 sessionId 唯一解析（评审收口）', async () => {
    const { service } = await makeRestoreWorld()
    feedChange(service, 5, 3, T0, 'sess-b') // 第二会话同 seq ⇒ 跨会话碰撞
    await expect(service.checkpointDiff({ seq: 5, index: 0 }))
      .rejects.toMatchObject({ code: 'git/checkpoint-unavailable' })
    const narrowed = await service.checkpointDiff({ seq: 5, index: 0, sessionId: SID }) as CheckpointFileDiff
    expect(narrowed).toMatchObject({ kind: 'text', path: 'a.txt' })
    // 判别半指向未知会话 ⇒ missing（诚实拒绝，不跨环寻址）；空串错形 ⇒ invalid-options。
    await expect(service.checkpointDiff({ seq: 5, index: 0, sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ code: 'git/checkpoint-unavailable' })
    await expect(service.checkpointDiff({ seq: 5, index: 0, sessionId: '' }))
      .rejects.toMatchObject({ code: 'git/bad-request', details: { reason: 'invalid-options' } })
  })
})

describe('attributionGet — 四态求交（mtime 近似判定的确定性控制）', () => {
  it('unknown（face 缺失 / 环空）→ user（有覆盖零命中）→ agent → mixed（utimes 分档）→ 多回合累积', async () => {
    const repo = await scratchRepo('dshgit-ckpt-attr-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    await writeFile(join(repo, 'base.txt'), 'v1\n', 'utf8')
    await writeFile(join(repo, 'userfile.txt'), 'u1\n', 'utf8')
    git(repo, 'add', '--', 'base.txt', 'userfile.txt')
    git(repo, 'commit', '-qm', 'base')
    // 工作区变更：base.txt 修改（回合内由 agent 改）、userfile.txt 修改（回合外用户改）。
    await writeFile(join(repo, 'base.txt'), 'v2\n', 'utf8')
    await writeFile(join(repo, 'userfile.txt'), 'u2\n', 'utf8')

    // ① face 缺失 ⇒ 全部 unknown（重启前历史 / 服务未挂载）。
    const noFace = makeService(repo)
    const unknown = await noFace.attributionGet() as AttributionResult
    expect(Object.fromEntries(unknown.entries.map((entry) => [entry.path, entry.attribution])))
      .toEqual({ 'base.txt': 'unknown', 'userfile.txt': 'unknown' })

    // ② face 在场但环空 ⇒ 仍 unknown（零命中无从谈起）。
    const emptyRing = makeService(repo, fakeFace(new Map()))
    expect((await emptyRing.attributionGet() as AttributionResult).entries.every((entry) => entry.attribution === 'unknown')).toBe(true)

    // ③ 回合记录命中 base.txt（不命中 userfile.txt）：agent / user 分档。
    const records = new Map<number, FakeRecord>([[
      2, {
        turn: 4,
        cwd: repo,
        files: [{ path: 'base.txt', display: 'base.txt', added: 1, deleted: 1 }],
        diffs: new Map(),
      },
    ]])
    const served = makeService(repo, fakeFace(records))
    feedChange(served, 2, 4, T0)
    feedEnd(served, 4, T0 + 500)
    // base.txt mtime 早于回合结束 ⇒ agent；userfile.txt 零命中（有覆盖）⇒ user。
    await utimes(join(repo, 'base.txt'), new Date(T0 - 1_000), new Date(T0 - 1_000))
    const servedResult = await served.attributionGet() as AttributionResult
    expect(Object.fromEntries(servedResult.entries.map((entry) => [entry.path, entry.attribution])))
      .toEqual({ 'base.txt': 'agent', 'userfile.txt': 'user' })
    expect(servedResult.entries.find((entry) => entry.path === 'base.txt')?.turns).toEqual([4])

    // ④ base.txt 回合结束后又被改动（mtime 晚于 endedAt）⇒ mixed。
    await utimes(join(repo, 'base.txt'), new Date(T0 + 60_000), new Date(T0 + 60_000))
    const mixed = await served.attributionGet() as AttributionResult
    expect(mixed.entries.find((entry) => entry.path === 'base.txt')?.attribution).toBe('mixed')

    // ⑤ 多回合同路径累积 turns（升序）。
    const records2 = new Map<number, FakeRecord>([
      [2, { turn: 4, cwd: repo, files: [{ path: 'base.txt', display: 'base.txt', added: 1, deleted: 1 }], diffs: new Map() }],
      [3, { turn: 6, cwd: repo, files: [{ path: 'base.txt', display: 'base.txt', added: 1, deleted: 1 }], diffs: new Map() }],
    ])
    const multi = makeService(repo, fakeFace(records2))
    feedChange(multi, 2, 4, T0)
    feedChange(multi, 3, 6, T0 + 1_000)
    feedEnd(multi, 6, T0 + 2_000)
    await utimes(join(repo, 'base.txt'), new Date(T0), new Date(T0))
    const multiResult = await multi.attributionGet() as AttributionResult
    expect(multiResult.entries.find((entry) => entry.path === 'base.txt')).toMatchObject({
      turns: [4, 6], attribution: 'agent',
    })
  })
})

describe('降级路径 — workspaceChanges face 缺失（plan §6.7 降级行）', () => {
  it('face 缺失：事件照建索引（list 有行但 summary null）+ diff/restore ⇒ checkpoint-unavailable', async () => {
    const repo = await scratchRepo('dshgit-ckpt-degraded-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    await writeFile(join(repo, 'x.txt'), 'x1\n', 'utf8')
    git(repo, 'add', '--', 'x.txt')
    git(repo, 'commit', '-qm', 'base')
    const service = makeService(repo) // 不 provide workspaceChanges ⇒ 可选切片读取 undefined
    feedChange(service, 4, 2)
    feedEnd(service, 2)
    const list = await service.checkpointList(null) as CheckpointListResult
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0]).toMatchObject({ sessionId: SID, seq: 4, turn: 2, summary: null })
    const diff = await rejectionOf(() => service.checkpointDiff({ seq: 4, index: 0 }))
    expect(diff.code).toBe('git/checkpoint-unavailable')
    expect(diff.details).toEqual({ seq: 4 })
    const restore = await rejectionOf(() => service.checkpointRestore({ seq: 4, paths: null, acknowledged: true, baseRevision: worldHead(repo) }))
    expect(restore.code).toBe('git/checkpoint-unavailable')
  })

  it('无事件（索引空）：checkpointList ⇒ entries []（list 空形态）', async () => {
    const repo = await scratchRepo('dshgit-ckpt-empty-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    const service = makeService(repo, fakeFace(new Map()))
    expect((await service.checkpointList(null)).entries).toEqual([])
    const unavailable = await rejectionOf(() => service.checkpointDiff({ seq: 0, index: 0 }))
    expect(unavailable.code).toBe('git/checkpoint-unavailable')
  })
})
