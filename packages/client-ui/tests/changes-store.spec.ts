/**
 * createGitChangesStore / createChangesTabStore 单测（本模块 ask §⑤/⑥；spec §6
 * stores 行的「假 GitRpcClient」纪律）：diff 缓存 rev:path:scope、revision 变化整体
 * 失效、in-flight 去重、error 重试、写操作成功→refresh 失效与失败→mutationError、
 * connection/reset 代际丢弃；tab store 的 draft 动作面。
 */

import { describe, expect, it } from 'vitest'
import type {
  DiffResult, DiffScope, DiscardOptions, DiscardResult, GitFollowCommand, GitStatusFrame, StageResult, UnstageResult,
} from 'dsh-gitkit/types'
import type { DiffFile, GitStatusSnapshot } from 'dsh-gitkit/types'
import { createChangesTabStore } from '../src/client/store/changes-tab-store.ts'
import { createGitChangesStore, diffCacheKey } from '../src/client/store/git-changes-store.ts'
import { createGitStatusSource } from '../src/client/store/git-status-source.ts'
import type { GitRpcFace, GitStreamHandle, RemoteResult } from '../src/client/remote/mount.ts'

/** 内存流句柄（推帧驱动状态源；照 tests/git-status-source.spec 的假实现切片）。 */
class FakeStream implements GitStreamHandle<GitStatusFrame, GitFollowCommand> {
  readonly sent: GitFollowCommand[] = []
  disposed = 0
  private readonly queue: GitStatusFrame[] = []
  private readonly waiters: Array<() => void> = []
  private finished = false

  push(frame: GitStatusFrame): void {
    this.queue.push(frame)
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  send(item: GitFollowCommand): void { this.sent.push(item) }
  end(): void { /* 半关上行——本套用例不消费 */ }
  dispose(): void {
    this.disposed += 1
    this.finished = true
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  [Symbol.asyncIterator](): AsyncIterator<GitStatusFrame> {
    return {
      next: async (): Promise<IteratorResult<GitStatusFrame>> => {
        for (;;) {
          const frame = this.queue.shift()
          if (frame !== undefined) return { done: false, value: frame }
          if (this.finished) return { done: true, value: undefined }
          await new Promise<void>((resolve) => { this.waiters.push(resolve) })
        }
      },
    }
  }
}

/** 可编程假 RPC（diff/写操作逐路径响应；调用记录供断言）。 */
class FakeRpc implements GitRpcFace {
  readonly streams: FakeStream[] = []
  readonly diffCalls: Array<{ scope: DiffScope; path: string | null }> = []
  /** discard 的 wire 入参（host 三重守卫形状：paths + acknowledged + baseRevision）。 */
  readonly discardCalls: DiscardOptions[] = []
  readonly stageCalls: string[][] = []
  readonly unstageCalls: string[][] = []
  /** path → diff 响应（缺省 = ready 单文件）。 */
  diffPlan: Map<string, RemoteResult<DiffResult> | Error> = new Map()
  /** path → diff 挂起门（出现即挂起；唤醒数组供用例放行）。 */
  diffGates: Map<string, Array<() => void>> = new Map()
  /** 写操作下一次调用的响应（或抛错）。 */
  mutationPlan: RemoteResult<StageResult> | RemoteResult<UnstageResult> | RemoteResult<DiscardResult> | Error | null = null

  async followStatus(): Promise<GitStreamHandle<GitStatusFrame, GitFollowCommand>> {
    const stream = new FakeStream()
    this.streams.push(stream)
    return stream
  }

  /** status 未被状态源消费（数据面走流）——断言守卫。 */
  async status(): Promise<never> {
    throw new Error('FakeRpc.status must not be called by the source')
  }

  async diff(scope: DiffScope, path: string | null): Promise<RemoteResult<DiffResult>> {
    this.diffCalls.push({ scope, path })
    const gate = path !== null ? this.diffGates.get(path) : undefined
    if (gate !== undefined) {
      await new Promise<void>((resolve) => { gate.push(resolve) })
    }
    const plan = path !== null ? this.diffPlan.get(path) : undefined
    if (plan instanceof Error) throw plan
    if (plan !== undefined) return plan
    return {
      ok: true,
      value: {
        scope, path, files: [mkFile(path ?? 'a.ts')], totalTruncated: false,
        generatedAt: '2026-10-31T00:00:00.000Z',
      },
    }
  }

  async stage(paths: string[]): Promise<RemoteResult<StageResult>> {
    this.stageCalls.push([...paths])
    return this.takeMutation()
  }

  async unstage(paths: string[]): Promise<RemoteResult<UnstageResult>> {
    this.unstageCalls.push([...paths])
    return this.takeMutation()
  }

  async discard(options: DiscardOptions): Promise<RemoteResult<DiscardResult>> {
    this.discardCalls.push(options)
    return this.takeMutation()
  }

  // F7 提交图数据层模块扩展 GitRpcFace（log/refs/getCommitDetail）后的适配面：
  // 变更面板 store 不消费这些端点——断言守卫同 status。
  async log(): Promise<never> {
    throw new Error('FakeRpc.log must not be called by the changes store')
  }

  async refs(): Promise<never> {
    throw new Error('FakeRpc.refs must not be called by the changes store')
  }

  async getCommitDetail(): Promise<never> {
    throw new Error('FakeRpc.getCommitDetail must not be called by the changes store')
  }

  // ④-K 提交对话框模块补齐 GitRpcFace 全量镜像（ping/identity/commit/push/pull/fetch/
  // generateCommitMessage）后的适配面：变更面板 store 不消费这些端点——断言守卫同 status。
  async ping(): Promise<never> {
    throw new Error('FakeRpc.ping must not be called by the changes store')
  }

  async identity(): Promise<never> {
    throw new Error('FakeRpc.identity must not be called by the changes store')
  }

  async commit(): Promise<never> {
    throw new Error('FakeRpc.commit must not be called by the changes store')
  }

  async push(): Promise<never> {
    throw new Error('FakeRpc.push must not be called by the changes store')
  }

  async pull(): Promise<never> {
    throw new Error('FakeRpc.pull must not be called by the changes store')
  }

  async fetch(): Promise<never> {
    throw new Error('FakeRpc.fetch must not be called by the changes store')
  }

  async generateCommitMessage(): Promise<never> {
    throw new Error('FakeRpc.generateCommitMessage must not be called by the changes store')
  }

  // V2 批次一管理面扩展 GitRpcFace（9 admin 方法）后的适配面：
  // 变更面板 store 不消费这些端点——断言守卫同 status。
  async branchCreate(): Promise<never> {
    throw new Error('FakeRpc.branchCreate must not be called by the changes store')
  }

  async branchSwitch(): Promise<never> {
    throw new Error('FakeRpc.branchSwitch must not be called by the changes store')
  }

  async branchDelete(): Promise<never> {
    throw new Error('FakeRpc.branchDelete must not be called by the changes store')
  }

  async tagCreate(): Promise<never> {
    throw new Error('FakeRpc.tagCreate must not be called by the changes store')
  }

  async tagDelete(): Promise<never> {
    throw new Error('FakeRpc.tagDelete must not be called by the changes store')
  }

  async remoteList(): Promise<never> {
    throw new Error('FakeRpc.remoteList must not be called by the changes store')
  }

  async worktreeList(): Promise<never> {
    throw new Error('FakeRpc.worktreeList must not be called by the changes store')
  }

  async worktreeAdd(): Promise<never> {
    throw new Error('FakeRpc.worktreeAdd must not be called by the changes store')
  }

  async worktreeRemove(): Promise<never> {
    throw new Error('FakeRpc.worktreeRemove must not be called by the changes store')
  }

  // V2 批次二历史面 6 方法（blame/compareBranches/cherryPick/revert/reset/
  // abortOperation）——变更面板 store 不消费；断言守卫桩（FakeRpc.status 同款）。
  async blame(): Promise<never> {
    throw new Error('FakeRpc.blame must not be called by the changes store')
  }

  async compareBranches(): Promise<never> {
    throw new Error('FakeRpc.compareBranches must not be called by the changes store')
  }

  async cherryPick(): Promise<never> {
    throw new Error('FakeRpc.cherryPick must not be called by the changes store')
  }

  async revert(): Promise<never> {
    throw new Error('FakeRpc.revert must not be called by the changes store')
  }

  async reset(): Promise<never> {
    throw new Error('FakeRpc.reset must not be called by the changes store')
  }

  async abortOperation(): Promise<never> {
    throw new Error('FakeRpc.abortOperation must not be called by the changes store')
  }

  private takeMutation<T>(): RemoteResult<T> {
    const plan = this.mutationPlan
    if (plan instanceof Error) throw plan
    if (plan === null) return { ok: true, value: { staged: 1 } as T }
    return plan as RemoteResult<T>
  }
}

function mkFile(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path, origPath: null, status: 'modified', binary: false,
    additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b', patchTruncated: false, oversized: false,
    ...overrides,
  }
}

function mkSnapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: 'D:/repo',
    generatedAt: new Date().toISOString(),
    branch: {
      name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: null,
      ahead: null, behind: null, detached: false, unborn: false,
    },
    staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
    ...overrides,
  }
}

function statusFrame(snapshot: GitStatusSnapshot) {
  return { kind: 'status' as const, reason: 'change' as const, snapshot }
}

function change(path: string) {
  return { path, origPath: null, kind: 'modified' as const, x: 'M', y: 'M', conflicted: false, binary: false, additions: 1, deletions: 1, submodule: false }
}

/** 排空微任务队列（store 的异步写入落地）。 */
async function settled(): Promise<void> {
  for (let at = 0; at < 4; at++) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** 装配：真实状态源（推帧驱动 revision）+ 假 RPC。 */
function setup() {
  const rpc = new FakeRpc()
  const status = createGitStatusSource(rpc)
  const store = createGitChangesStore(rpc, status)
  return { rpc, status, store }
}

/** 开流 + 首帧（revision=1 基线）。 */
async function openWithFrame(setupResult: ReturnType<typeof setup>, overrides: Partial<GitStatusSnapshot> = {}) {
  const { rpc, status } = setupResult
  status.start()
  await settled()
  rpc.streams[0]?.push(statusFrame(mkSnapshot(overrides)))
  await settled()
}

describe('diffCacheKey — rev:path:scope（ask §⑤）', () => {
  it('键序 = revision:path:scope；任一分量不同 → 键不同', () => {
    expect(diffCacheKey(3, 'a.ts', 'staged')).toBe('3:a.ts:staged')
    expect(diffCacheKey(1, 'a.ts', 'staged')).not.toBe(diffCacheKey(2, 'a.ts', 'staged'))
    expect(diffCacheKey(1, 'a.ts', 'staged')).not.toBe(diffCacheKey(1, 'a.ts', 'worktree'))
    expect(diffCacheKey(1, 'a.ts', 'staged')).not.toBe(diffCacheKey(1, 'b.ts', 'staged'))
  })
})

describe('createGitChangesStore — diff 缓存', () => {
  it('无 status 快照时不发起 diff', async () => {
    const harness = setup()
    await harness.store.loadDiff('worktree', 'a.ts')
    expect(harness.rpc.diffCalls).toEqual([])
    expect(harness.store.store.getSnapshot().diffs).toEqual({})
    harness.store.dispose()
    harness.status.dispose()
  })

  it('首帧后 loadDiff：ready 落缓存；命中缓存不重发', async () => {
    const harness = setup()
    await openWithFrame(harness)
    await harness.store.loadDiff('worktree', 'a.ts')
    expect(harness.rpc.diffCalls).toEqual([{ scope: 'worktree', path: 'a.ts' }])
    const key = diffCacheKey(1, 'a.ts', 'worktree')
    expect(harness.store.store.getSnapshot().diffs[key]?.state).toBe('ready')
    expect(harness.store.store.getSnapshot().diffs[key]?.file?.path).toBe('a.ts')
    await harness.store.loadDiff('worktree', 'a.ts')
    expect(harness.rpc.diffCalls).toHaveLength(1)
    harness.store.dispose()
    harness.status.dispose()
  })

  it('单文件 diff 结果缺该文件 → ready 无 file（raced-away）', async () => {
    const harness = setup()
    await openWithFrame(harness)
    harness.rpc.diffPlan.set('gone.ts', {
      ok: true,
      value: { scope: 'worktree', path: 'gone.ts', files: [], totalTruncated: false, generatedAt: 'x' },
    })
    await harness.store.loadDiff('worktree', 'gone.ts')
    expect(harness.store.store.getSnapshot().diffs[diffCacheKey(1, 'gone.ts', 'worktree')]).toEqual({ state: 'ready' })
    harness.store.dispose()
    harness.status.dispose()
  })

  it('in-flight 去重：并发同键只发一次', async () => {
    const harness = setup()
    await openWithFrame(harness)
    const gate: Array<() => void> = []
    harness.rpc.diffGates.set('a.ts', gate)
    const first = harness.store.loadDiff('worktree', 'a.ts')
    const second = harness.store.loadDiff('worktree', 'a.ts')
    await settled()
    // 第二次调用命中 in-flight：只发过一次。
    expect(harness.rpc.diffCalls).toHaveLength(1)
    for (const wake of gate) wake()
    await Promise.all([first, second])
    expect(harness.rpc.diffCalls).toHaveLength(1)
    harness.store.dispose()
    harness.status.dispose()
  })

  it('error 态可重试（ready 命中缓存不重发）', async () => {
    const harness = setup()
    await openWithFrame(harness)
    harness.rpc.diffPlan.set('bad.ts', { ok: false, error: { code: 'git/git-error', message: 'boom' } })
    await harness.store.loadDiff('worktree', 'bad.ts')
    const key = diffCacheKey(1, 'bad.ts', 'worktree')
    expect(harness.store.store.getSnapshot().diffs[key]?.state).toBe('error')
    expect(harness.store.store.getSnapshot().diffs[key]?.error?.code).toBe('git/git-error')
    await harness.store.loadDiff('worktree', 'bad.ts')
    expect(harness.rpc.diffCalls).toHaveLength(2)
    await harness.store.loadDiff('worktree', 'a.ts')
    await harness.store.loadDiff('worktree', 'a.ts')
    expect(harness.rpc.diffCalls).toHaveLength(3)
    harness.store.dispose()
    harness.status.dispose()
  })

  it('rpc 抛错（载波层）折叠为 error 态（不冒泡）', async () => {
    const harness = setup()
    await openWithFrame(harness)
    harness.rpc.diffPlan.set('boom.ts', new Error('carrier down'))
    await harness.store.loadDiff('worktree', 'boom.ts')
    const entry = harness.store.store.getSnapshot().diffs[diffCacheKey(1, 'boom.ts', 'worktree')]
    expect(entry?.state).toBe('error')
    expect(entry?.error?.code).toBe('gateway/service-unavailable')
    harness.store.dispose()
    harness.status.dispose()
  })

  it('revision 变化整体失效：缓存清空，旧代际在途响应丢弃', async () => {
    const harness = setup()
    await openWithFrame(harness)
    // 挂住 slow.ts 的响应，让它在 revision 变化后才落地。
    harness.rpc.diffGates.set('slow.ts', [])
    const loading = harness.store.loadDiff('worktree', 'slow.ts')
    const key = diffCacheKey(1, 'slow.ts', 'worktree')
    expect(harness.store.store.getSnapshot().diffs[key]?.state).toBe('loading')
    // 新帧（内容签名变化）→ revision 递增 → 缓存整体清空。
    harness.rpc.streams[0]?.push(statusFrame(mkSnapshot({ clean: false, unstaged: [change('m.ts')] })))
    await settled()
    expect(harness.store.store.getSnapshot().diffs[key]).toBeUndefined()
    // 旧代际响应落地：不得写回。
    for (const wake of harness.rpc.diffGates.get('slow.ts') ?? []) wake()
    await loading
    await settled()
    expect(harness.store.store.getSnapshot().diffs[key]).toBeUndefined()
    harness.store.dispose()
    harness.status.dispose()
  })
})

describe('createGitChangesStore — 写操作（ask §⑥ 的 store 半）', () => {
  it('discard 成功：清 mutationError + 乐观清缓存 + 状态源 refresh（R5 上行）', async () => {
    const harness = setup()
    await openWithFrame(harness, { clean: false, unstaged: [change('a.ts')] })
    await harness.store.loadDiff('worktree', 'a.ts')
    expect(Object.keys(harness.store.store.getSnapshot().diffs)).toHaveLength(1)
    const result = await harness.store.discard(['a.ts'])
    expect(result.ok).toBe(true)
    // host 三重守卫的 store 半：acknowledged（C5 确认闸承接）+ baseRevision（当前快照 HEAD）。
    expect(harness.rpc.discardCalls).toEqual([
      { paths: ['a.ts'], acknowledged: true, baseRevision: 'a'.repeat(40) },
    ])
    expect(harness.store.store.getSnapshot().diffs).toEqual({})
    expect(harness.rpc.streams[0]?.sent).toEqual([{ type: 'refresh' }])
    expect(harness.store.store.getSnapshot().mutationError).toBeNull()
    harness.store.dispose()
    harness.status.dispose()
  })

  it('stage 失败：mutationError 承载（kind + paths + error），dismiss 清除', async () => {
    const harness = setup()
    await openWithFrame(harness)
    harness.rpc.mutationPlan = { ok: false, error: { code: 'git/git-error', message: 'deny', details: { op: 'stage' } } }
    const result = await harness.store.stage(['x.ts'])
    expect(result.ok).toBe(false)
    const mutationError = harness.store.store.getSnapshot().mutationError
    expect(mutationError?.kind).toBe('stage')
    expect(mutationError?.paths).toEqual(['x.ts'])
    expect(mutationError?.error.code).toBe('git/git-error')
    harness.store.dismissMutationError()
    expect(harness.store.store.getSnapshot().mutationError).toBeNull()
    harness.store.dispose()
    harness.status.dispose()
  })

  it('失败后的成功写操作清空 mutationError；unstage 同样触发 refresh 上行', async () => {
    const harness = setup()
    await openWithFrame(harness)
    harness.rpc.mutationPlan = { ok: false, error: { code: 'git/git-error', message: 'deny' } }
    await harness.store.unstage(['x.ts'])
    expect(harness.store.store.getSnapshot().mutationError).not.toBeNull()
    harness.rpc.mutationPlan = null
    await harness.store.unstage(['x.ts'])
    expect(harness.store.store.getSnapshot().mutationError).toBeNull()
    expect(harness.rpc.streams[0]?.sent).toEqual([{ type: 'refresh' }])
    harness.store.dispose()
    harness.status.dispose()
  })
})

describe('createGitChangesStore — reset/dispose（connection/reset 语义）', () => {
  it('reset：缓存与错误清空、代际丢弃（reset 前在途响应不落地）', async () => {
    const harness = setup()
    await openWithFrame(harness)
    harness.rpc.diffGates.set('slow.ts', [])
    const loading = harness.store.loadDiff('worktree', 'slow.ts')
    const key = diffCacheKey(1, 'slow.ts', 'worktree')
    harness.store.reset()
    expect(harness.store.store.getSnapshot().diffs).toEqual({})
    for (const wake of harness.rpc.diffGates.get('slow.ts') ?? []) wake()
    await loading
    expect(harness.store.store.getSnapshot().diffs[key]).toBeUndefined()
    harness.store.dispose()
    harness.status.dispose()
  })

  it('dispose 后不再响应状态源 revision 变化（退订）', async () => {
    const harness = setup()
    await openWithFrame(harness)
    await harness.store.loadDiff('worktree', 'a.ts')
    expect(Object.keys(harness.store.store.getSnapshot().diffs)).toHaveLength(1)
    harness.store.dispose()
    harness.rpc.streams[0]?.push(statusFrame(mkSnapshot({ clean: false, unstaged: [change('m.ts')] })))
    await settled()
    // dispose 后缓存保持（退订了状态源；终态由 ctx.effect 清理）。
    expect(Object.keys(harness.store.store.getSnapshot().diffs)).toHaveLength(1)
    harness.status.dispose()
  })
})

describe('createChangesTabStore — 范式 B 动作面（ask §②/⑥）', () => {
  it('toggleDir 缺省展开、点击折叠、再点展开', () => {
    const instance = createChangesTabStore().create()
    expect(instance.getSnapshot().expandedDirs).toEqual({})
    instance.actions.toggleDir('changes:src')
    expect(instance.getSnapshot().expandedDirs['changes:src']).toBe(false)
    instance.actions.toggleDir('changes:src')
    expect(instance.getSnapshot().expandedDirs['changes:src']).toBe(true)
  })

  it('select / requestDiscard / resolveConfirm', () => {
    const instance = createChangesTabStore().create()
    instance.actions.select('a.ts')
    expect(instance.getSnapshot().selectedPath).toBe('a.ts')
    instance.actions.select(null)
    expect(instance.getSnapshot().selectedPath).toBeNull()
    instance.actions.requestDiscard(['a.ts', 'b.ts'])
    expect(instance.getSnapshot().pendingConfirm).toEqual({ kind: 'discard', paths: ['a.ts', 'b.ts'] })
    instance.actions.resolveConfirm(true)
    expect(instance.getSnapshot().pendingConfirm).toBeNull()
  })

  it('工厂多次调用产独立实例（模块级句柄禁止）', () => {
    const left = createChangesTabStore().create()
    const right = createChangesTabStore().create()
    left.actions.select('a.ts')
    expect(right.getSnapshot().selectedPath).toBeNull()
  })
})
