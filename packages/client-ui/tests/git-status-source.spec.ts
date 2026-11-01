/**
 * createGitStatusSource 单测（spec §6 stores.spec 的状态源切片 + 本模块 ask §②）：
 * followStatus 消费、R5 上行、connection/reset 重订、代际/revision 丢帧、错误帧投影。
 * 假 GitRpcFace（内存流）——spec §3.2「测试 = 内存假实现」。
 */

import { describe, expect, it, vi } from 'vitest'
import type { GitFollowCommand, GitStatusFrame, GitStatusSnapshot } from 'dsh-gitkit/types'
import { createGitStatusSource, snapshotSignature } from '../src/client/store/git-status-source.ts'
import type { GitErrorLike, GitRpcFace, GitStreamHandle } from '../src/client/remote/mount.ts'
import { GATEWAY_UNAVAILABLE } from '../src/client/remote/mount.ts'

/** 内存流句柄：队列 + 唤醒；记录上行与 dispose。 */
class FakeStream implements GitStreamHandle<GitStatusFrame, GitFollowCommand> {
  readonly sent: GitFollowCommand[] = []
  disposed = 0
  private readonly queue: GitStatusFrame[] = []
  private readonly waiters: Array<() => void> = []
  private finished = false

  push(frame: GitStatusFrame): void {
    this.queue.push(frame)
    this.flushWaiters()
  }

  send(item: GitFollowCommand): void { this.sent.push(item) }
  end(): void { /* 半关上行——假实现只记录语义面之外的行为 */ }
  dispose(): void {
    this.disposed += 1
    this.finished = true
    this.flushWaiters()
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

  private flushWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

/** 假 RPC：followStatus 产新流；可注入拒绝与延迟（挂载等待）。 */
class FakeRpc implements GitRpcFace {
  streams: FakeStream[] = []
  followCalls = 0
  private gate: Promise<void> | null = null
  private openGate: (() => void) | null = null
  failWith: Error | null = null

  // F 变更面板模块扩展 GitRpcFace（diff/stage/unstage/discard）后的适配面：
  // 状态源不消费这些端点——断言守卫同 status。
  async diff(): Promise<never> {
    throw new Error('FakeRpc.diff must not be called by the source')
  }

  async stage(): Promise<never> {
    throw new Error('FakeRpc.stage must not be called by the source')
  }

  async unstage(): Promise<never> {
    throw new Error('FakeRpc.unstage must not be called by the source')
  }

  async discard(): Promise<never> {
    throw new Error('FakeRpc.discard must not be called by the source')
  }

  // ④-K 提交对话框模块补齐 GitRpcFace 全量镜像（ping/identity/commit/push/pull/fetch/
  // generateCommitMessage）后的适配面：状态源不消费这些端点——断言守卫同 status。
  async ping(): Promise<never> {
    throw new Error('FakeRpc.ping must not be called by the source')
  }

  async identity(): Promise<never> {
    throw new Error('FakeRpc.identity must not be called by the source')
  }

  async commit(): Promise<never> {
    throw new Error('FakeRpc.commit must not be called by the source')
  }

  async push(): Promise<never> {
    throw new Error('FakeRpc.push must not be called by the source')
  }

  async pull(): Promise<never> {
    throw new Error('FakeRpc.pull must not be called by the source')
  }

  async fetch(): Promise<never> {
    throw new Error('FakeRpc.fetch must not be called by the source')
  }

  async generateCommitMessage(): Promise<never> {
    throw new Error('FakeRpc.generateCommitMessage must not be called by the source')
  }

  // F7 提交图数据层模块扩展 GitRpcFace（log/refs/getCommitDetail）后的适配面：
  // 状态源不消费这些端点——断言守卫同 status。
  async log(): Promise<never> {
    throw new Error('FakeRpc.log must not be called by the source')
  }

  async refs(): Promise<never> {
    throw new Error('FakeRpc.refs must not be called by the source')
  }

  async getCommitDetail(): Promise<never> {
    throw new Error('FakeRpc.getCommitDetail must not be called by the source')
  }

  /** 门控：followStatus 在 openGate() 前挂起（挂载等待仿真）。 */
  holdCalls(): void {
    this.gate = new Promise<void>((resolve) => { this.openGate = resolve })
  }

  releaseCalls(): void {
    this.openGate?.()
    this.openGate = null
  }

  async followStatus(): Promise<GitStreamHandle<GitStatusFrame, GitFollowCommand>> {
    this.followCalls += 1
    if (this.failWith !== null) throw this.failWith
    if (this.gate !== null) await this.gate
    const stream = new FakeStream()
    this.streams.push(stream)
    return stream
  }

  /** status 未被状态源消费（数据面走流）——断言守卫。 */
  async status(): Promise<never> {
    throw new Error('FakeRpc.status must not be called by the source')
  }

  latest(): FakeStream {
    const stream = this.streams.at(-1)
    if (stream === undefined) throw new Error('FakeRpc: no stream opened')
    return stream
  }
}

function mkSnapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repoRoot: 'D:/repo',
    generatedAt: new Date().toISOString(),
    branch: {
      name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: 'origin/main',
      ahead: 0, behind: 0, detached: false, unborn: false,
    },
    staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
    ...overrides,
  }
}

function statusFrame(snapshot: GitStatusSnapshot): GitStatusFrame {
  return { kind: 'status', reason: 'change', snapshot }
}

function errorFrame(code: string): GitStatusFrame {
  return { kind: 'error', reason: 'poll', error: { code, message: `boom: ${code}` } }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('createGitStatusSource — followStatus 消费（R1 initial / R2+）', () => {
  it('首帧 status 建立可用态并计数 revision', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(statusFrame(mkSnapshot()))
    await vi.waitFor(() => {
      const state = source.store.getSnapshot()
      expect(state.status).not.toBeNull()
      expect(state.repo.available).toBe(true)
      expect(state.repo.root).toBe('D:/repo')
      expect(state.repo.checking).toBe(false)
      expect(state.revision).toBe(1)
      expect(state.streaming).toBe(true)
      expect(state.statusError).toBeNull()
    })
    source.dispose()
  })

  it('内容重复帧被丢（revision 不计数、status 引用不变）——R5 无条件帧幂等', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    const first = mkSnapshot()
    rpc.latest().push(statusFrame(first))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(1))
    const before = source.store.getSnapshot().status
    // 同内容、新 generatedAt（host 重算必换时间戳）+ manual（R5 无条件推）。
    const duplicate = mkSnapshot({ generatedAt: new Date(Date.now() + 5_000).toISOString() })
    rpc.latest().push({ kind: 'status', reason: 'manual', snapshot: duplicate })
    await settled()
    const state = source.store.getSnapshot()
    expect(state.revision).toBe(1)
    expect(state.status).toBe(before)
    source.dispose()
  })

  it('内容变化帧被接受（revision 递增）', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(statusFrame(mkSnapshot()))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(1))
    rpc.latest().push(statusFrame(mkSnapshot({
      clean: false,
      staged: [{ path: 'a.ts', origPath: null, kind: 'modified', x: 'M', y: '.', conflicted: false, binary: false, additions: 1, deletions: 0, submodule: false }],
    })))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(2))
    expect(source.store.getSnapshot().status?.clean).toBe(false)
    source.dispose()
  })

  it('snapshotSignature 剔除 generatedAt（同内容判等）', () => {
    const base = mkSnapshot()
    const other = mkSnapshot({ generatedAt: new Date(Date.now() + 60_000).toISOString() })
    expect(snapshotSignature(base)).toBe(snapshotSignature(other))
    expect(snapshotSignature(base)).not.toBe(snapshotSignature(mkSnapshot({ clean: false })))
  })
})

describe('createGitStatusSource — 错误帧与投影', () => {
  it('no-repository 错误帧 ⇒ repo 不可用 + statusError；流不断', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(errorFrame('git/no-repository'))
    await vi.waitFor(() => {
      const state = source.store.getSnapshot()
      expect(state.statusError?.code).toBe('git/no-repository')
      expect(state.repo.available).toBe(false)
      expect(state.repo.checking).toBe(false)
      expect(state.revision).toBe(1)
    })
    // 仓库就绪后的下一帧自然恢复（错误以帧通告不断流）。
    rpc.latest().push(statusFrame(mkSnapshot()))
    await vi.waitFor(() => {
      const state = source.store.getSnapshot()
      expect(state.statusError).toBeNull()
      expect(state.repo.available).toBe(true)
    })
    source.dispose()
  })

  it('非仓库类错误帧保留可用投影', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(errorFrame('git/git-error'))
    await vi.waitFor(() => expect(source.store.getSnapshot().statusError?.code).toBe('git/git-error'))
    expect(source.store.getSnapshot().repo.checking).toBe(true)
    source.dispose()
  })

  it('followStatus 载波拒绝 ⇒ gateway/service-unavailable 状态 + 流未开', async () => {
    const rpc = new FakeRpc()
    rpc.failWith = new Error('no connection')
    const source = createGitStatusSource(rpc)
    source.start()
    await vi.waitFor(() => {
      const state = source.store.getSnapshot()
      expect(state.statusError?.code).toBe(GATEWAY_UNAVAILABLE)
      expect(state.streaming).toBe(false)
    })
    expect(rpc.followCalls).toBe(1)
    source.dispose()
  })
})

describe('createGitStatusSource — R5 refresh / connection/reset / dispose', () => {
  it('refresh() 在流开着时走上行 {type:refresh}', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    source.refresh()
    expect(rpc.latest().sent).toEqual([{ type: 'refresh' }])
    source.dispose()
  })

  it('refresh() 在流未开时重开流（重试路径）', async () => {
    const rpc = new FakeRpc()
    rpc.failWith = new Error('down')
    const source = createGitStatusSource(rpc)
    source.start()
    await vi.waitFor(() => expect(source.store.getSnapshot().streaming).toBe(false))
    rpc.failWith = null
    source.refresh()
    await settled()
    expect(rpc.followCalls).toBe(2)
    expect(source.store.getSnapshot().streaming).toBe(true)
    source.dispose()
  })

  it('reset() 清空 + 重订：旧代际迟到帧丢弃，新代际帧生效', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(statusFrame(mkSnapshot()))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(1))
    const firstStream = rpc.latest()
    source.reset()
    await settled()
    expect(firstStream.disposed).toBe(1)
    const state = source.store.getSnapshot()
    expect(state.status).toBeNull()
    expect(state.revision).toBe(0)
    expect(state.repo.checking).toBe(true)
    // 旧代际流迟到帧：代际已递增 ⇒ 丢帧（状态不得回退）。
    firstStream.push(statusFrame(mkSnapshot()))
    await settled()
    expect(source.store.getSnapshot().revision).toBe(0)
    expect(source.store.getSnapshot().status).toBeNull()
    // 新代际帧生效。
    rpc.latest().push(statusFrame(mkSnapshot()))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(1))
    expect(source.store.getSnapshot().repo.available).toBe(true)
    source.dispose()
  })

  it('dispose() 关流且后续帧不再进入', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    const stream = rpc.latest()
    source.dispose()
    expect(stream.disposed).toBe(1)
    stream.push(statusFrame(mkSnapshot()))
    await settled()
    expect(source.store.getSnapshot().revision).toBe(0)
    expect(source.store.getSnapshot().streaming).toBe(false)
  })

  it('start() 幂等：已开着不重开', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    source.start()
    source.start()
    await settled()
    expect(rpc.followCalls).toBe(1)
    source.dispose()
  })
})

describe('createGitStatusSource — 状态源工厂纪律', () => {
  it('每次工厂调用产独立实例（模块级句柄禁止）', async () => {
    const rpcA = new FakeRpc()
    const rpcB = new FakeRpc()
    const a = createGitStatusSource(rpcA)
    const b = createGitStatusSource(rpcB)
    expect(a.store).not.toBe(b.store)
    a.start()
    b.start()
    await settled()
    rpcA.latest().push(statusFrame(mkSnapshot()))
    await vi.waitFor(() => expect(a.store.getSnapshot().revision).toBe(1))
    expect(b.store.getSnapshot().revision).toBe(0)
    a.dispose()
    b.dispose()
  })
})

describe('GitErrorLike 形状（spec §3.2 按 code 判别的投影面）', () => {
  it('错误帧投影只带 code/message（details 不上投影）', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(errorFrame('git/no-repository'))
    await vi.waitFor(() => expect(source.store.getSnapshot().statusError).not.toBeNull())
    const error: GitErrorLike = source.store.getSnapshot().statusError as GitErrorLike
    expect(Object.keys(error).sort()).toEqual(['code', 'message'])
    source.dispose()
  })
})
