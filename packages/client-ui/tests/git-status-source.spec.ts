/**
 * createGitStatusSource 单测（spec §6 stores.spec 的状态源切片 + 本模块 ask §②）：
 * followStatus 消费、R5 上行、connection/reset 重订、代际/revision 丢帧、错误帧投影。
 * 假 GitRpcFace（内存流）——spec §3.2「测试 = 内存假实现」。
 */

import { readFile } from 'node:fs/promises'
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

  // V2 批次一管理面扩展 GitRpcFace（9 admin 方法）后的适配面：
  // 状态源不消费这些端点——断言守卫同 status。
  async branchCreate(): Promise<never> {
    throw new Error('FakeRpc.branchCreate must not be called by the source')
  }

  async branchSwitch(): Promise<never> {
    throw new Error('FakeRpc.branchSwitch must not be called by the source')
  }

  async branchDelete(): Promise<never> {
    throw new Error('FakeRpc.branchDelete must not be called by the source')
  }

  async tagCreate(): Promise<never> {
    throw new Error('FakeRpc.tagCreate must not be called by the source')
  }

  async tagDelete(): Promise<never> {
    throw new Error('FakeRpc.tagDelete must not be called by the source')
  }

  async remoteList(): Promise<never> {
    throw new Error('FakeRpc.remoteList must not be called by the source')
  }

  async worktreeList(): Promise<never> {
    throw new Error('FakeRpc.worktreeList must not be called by the source')
  }

  async worktreeAdd(): Promise<never> {
    throw new Error('FakeRpc.worktreeAdd must not be called by the source')
  }

  async worktreeRemove(): Promise<never> {
    throw new Error('FakeRpc.worktreeRemove must not be called by the source')
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

/** 一条 staged 变更（路径置换回归用；形状照 host GitStatusChange 的 wire 面）。 */
function stagedChange(path: string): GitStatusSnapshot['staged'][number] {
  return { path, origPath: null, kind: 'modified', x: 'M', y: '.', conflicted: false, binary: false, additions: 1, deletions: 0, submodule: false }
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

  it('snapshotSignature 纳入四组路径数组（与 host frameSignature 同粒度）', () => {
    // 路径置换（计数不变）⇒ 签名不等——P1 丢帧修复的字段面。
    const base = mkSnapshot({ clean: false, staged: [stagedChange('a.ts')] })
    const permuted = mkSnapshot({ clean: false, staged: [stagedChange('b.ts')] })
    expect(snapshotSignature(base)).not.toBe(snapshotSignature(permuted))
    // 同内容（generatedAt 不同）⇒ 签名相等（剔除口径不变）。
    expect(snapshotSignature(base)).toBe(
      snapshotSignature(mkSnapshot({ clean: false, staged: [stagedChange('a.ts')], generatedAt: new Date(Date.now() + 60_000).toISOString() })),
    )
    // 其余三组（unstaged/untracked/conflicted）同口径纳入。
    expect(snapshotSignature(base)).not.toBe(snapshotSignature(mkSnapshot({ clean: false, staged: [stagedChange('a.ts')], untracked: [stagedChange('n.ts')] })))
  })

  it('路径置换且计数不变 ⇒ 不丢帧、新路径进状态', async () => {
    const rpc = new FakeRpc()
    const source = createGitStatusSource(rpc)
    source.start()
    await settled()
    rpc.latest().push(statusFrame(mkSnapshot({ clean: false, staged: [stagedChange('a.ts')] })))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(1))
    // staged=[a.ts] → [b.ts]：计数不变（1→1）、generatedAt 更新（host 重算必换）。
    // 修复前：签名只含 oid+计数+clean ⇒ 判重丢帧；修复后：路径数组入签 ⇒ 帧被接受。
    rpc.latest().push(statusFrame(mkSnapshot({
      clean: false,
      staged: [stagedChange('b.ts')],
      generatedAt: new Date(Date.now() + 5_000).toISOString(),
    })))
    await vi.waitFor(() => expect(source.store.getSnapshot().revision).toBe(2))
    const state = source.store.getSnapshot()
    expect(state.status?.staged.map((change) => change.path)).toEqual(['b.ts'])
    expect(state.repo.available).toBe(true)
    source.dispose()
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

describe('spec §2.3 快照比对口径守卫（权威 spec 与实现字段面一致——v1.3 归真）', () => {
  /**
   * 独立评审（第 1 轮）spec 失败项的回归守卫：§2.3 client 侧曾权威性地规定按
   * `branch.oid + 分组计数 + generatedAt` 廉价对比——正是 P1 修复证明有损并替换掉的
   * 公式（分组计数漏路径置换：host 按全量签名推新帧、client 判重丢帧 ⇒ 渲染滞后）。
   * v1.3 归真后（同版次整体回填随之把 client 表改为 followStatus 流传输），该口径的
   * 权威规定位置 = §2.3 流帧契约「client 侧消费契约」块 + host R2 行的字段面 + v1.3
   * 修订记录。本守卫钉住三处，防有损公式随 spec 回改复活。
   */
  it('快照比对口径规定全量内容签名（剔除 generatedAt、粒度 ≥ host），有损公式不得回归', async () => {
    const spec = await readFile(new URL('../../../docs/capability-spec.md', import.meta.url), 'utf8')
    const lines = spec.split('\n')
    // ① §2.3「client 侧消费契约」块：粒度规则（client ≥ host）+ 剔除 generatedAt +
    //    两侧同粒度锚点（client snapshotSignature ≡ host frameSignature 的 snapshot 半）。
    const clientContract = lines.find((line) => line.startsWith('**client 侧消费契约**'))
    if (clientContract === undefined) throw new Error('§2.3「client 侧消费契约」块缺失——权威 spec 必须规定 client 侧快照比对（去重签名）口径')
    for (const token of ['client 去重签名粒度必须 ≥ host', 'generatedAt', '同粒度', 'snapshotSignature', 'frameSignature']) {
      expect(clientContract, `client 消费契约块须含「${token}」`).toContain(token)
    }
    // ② host R2 行的字段面：frameSignature = repoRoot + branch + 四组路径数组 + clean。
    expect(
      lines.find((line) => line.includes('四组路径数组') && line.includes('frameSignature')),
      '§2.3 须有一处规定 frameSignature 字段面（四组路径数组，非分组计数）',
    ).toBeDefined()
    // ③ 修订记录 v1.3：归真记录（路径置换教训）在场。
    const v13 = lines.find((line) => line.includes('**修订记录**：v1.3'))
    if (v13 === undefined) throw new Error('spec 头部须有 v1.3 修订记录行（记录快照比对公式归真）')
    expect(v13).toContain('快照比对')
    expect(v13).toContain('路径置换')
    // ④ 有损公式不得以现行口径回归：「分组计数」只许出现在修订记录（历史引述），
    //    正文一律全量内容签名（路径置换 staged=[a.ts]→[b.ts] 计数不变 ⇒ 丢帧渲染滞后）。
    for (const line of lines) {
      if (!line.includes('分组计数')) continue
      expect(line.startsWith('> **修订记录**'), '「分组计数」只许出现在修订记录（历史引述），不得回到正文口径').toBe(true)
    }
  })
})
