/**
 * git-blame-store 测试（V2 批次二 [34]；D3=B -L 区间分片；评审修复钉子）：
 *   - ensure 全区成功 / 全区超限 → 分片模式转换 / details 缺席 → error 兜底 + 重试；
 *   - **区间级在途簿记（pending）**：同区间在途重入被拒（单 RPC——修复前单槽位
 *     pendingToken 会被不同区间并发互相覆盖、同键判等失效导致重复 RPC）；不同区间
 *     并发互不遮蔽、各自完成、结果都归并；reset 后在途写回被 no-op 拦下；
 *   - 覆盖簿记：已覆盖/倒序 no-op；窗口越界钳到文件尾。
 */

import { describe, expect, it } from 'vitest'
import type { BlameOptions, BlameResult } from 'dsh-gitkit/types'
import type { RemoteResult } from '../src/client/remote/mount.ts'
import { createGitBlameStore } from '../src/client/store/git-blame-store.ts'
import type { GitBlameRpcFace } from '../src/client/store/git-blame-store.ts'

type Responder = (options: BlameOptions) => Promise<RemoteResult<BlameResult>>

/** 响应队列式假 blame 面：按调用序 shift 响应器；调用入参全量记录。 */
class FakeBlameRpc implements GitBlameRpcFace {
  readonly calls: BlameOptions[] = []
  private queue: Responder[] = []

  enqueue(responder: Responder): void {
    this.queue.push(responder)
  }

  async blame(options: BlameOptions): Promise<RemoteResult<BlameResult>> {
    this.calls.push(options)
    const responder = this.queue.shift()
    if (responder === undefined) throw new Error('FakeBlameRpc: no queued responder for blame call')
    return responder(options)
  }
}

function ok(overrides: Partial<BlameResult> & { lineCount: number }): RemoteResult<BlameResult> {
  return {
    ok: true,
    value: { path: 'f.txt', ref: null, truncated: false, ranges: [], commits: [], ...overrides },
  }
}

function oversized(lineCount: number, maxLines: number): RemoteResult<BlameResult> {
  return {
    ok: false,
    error: {
      code: 'git/blame-oversized',
      message: 'oversized',
      details: { path: 'f.txt', lineCount, maxLines },
    },
  }
}

function range(startLine: number, count: number, oid = 'a'.repeat(40)) {
  return { startLine, count, oid, authorName: 'Alice', authoredAt: '2026-11-01T00:00:00.000Z' }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((release) => { resolve = release })
  return { promise, resolve }
}

/** 造一个分片模式槽位（全区超限转换后）。 */
async function slicedStore(rpc: FakeBlameRpc, path = 'big.txt'): Promise<ReturnType<typeof createGitBlameStore>> {
  const store = createGitBlameStore(rpc)
  rpc.enqueue(async () => oversized(120_000, 50_000))
  await store.ensure(path)
  return store
}

describe('ensure — 全区一次加载路径', () => {
  it('成功：ranges 展开 + loaded 覆盖整文件；入参无 range', async () => {
    const rpc = new FakeBlameRpc()
    const store = createGitBlameStore(rpc)
    rpc.enqueue(async () => ok({ lineCount: 5, ranges: [range(1, 2), range(3, 3, 'b'.repeat(40))] }))
    await store.ensure('f.txt')
    const slot = store.store.getSnapshot().byPath['f.txt']!
    expect(slot.state).toBe('ready')
    expect(slot.oversized).toBe(false)
    expect(slot.lineCount).toBe(5)
    expect(slot.loaded).toEqual([{ start: 1, end: 5 }])
    expect(slot.runs.map((run) => [run.startLine, run.endLine])).toEqual([[1, 2], [3, 5]])
    expect(slot.pending).toEqual({})
    expect(rpc.calls[0]).toEqual({ path: 'f.txt', ref: null, range: null })
  })

  it('loading/ready 槽位重复 ensure no-op；error 槽重调 = 重试', async () => {
    const rpc = new FakeBlameRpc()
    const store = createGitBlameStore(rpc)
    rpc.enqueue(async () => ({ ok: false, error: { code: 'git/git-error', message: 'x' } }))
    await store.ensure('f.txt')
    expect(store.store.getSnapshot().byPath['f.txt']!.state).toBe('error')
    // error 槽重调 = 重试：队列空 ⇒ fake 抛错 ⇒ error 槽保持（第二次调用确已发出）。
    await store.ensure('f.txt')
    expect(rpc.calls).toHaveLength(2)
    // 重试成功转 ready 后，重复 ensure ⇒ no-op（不重发）。
    rpc.enqueue(async () => ok({ lineCount: 3, ranges: [range(1, 3)] }))
    await store.ensure('f.txt')
    expect(rpc.calls).toHaveLength(3)
    await store.ensure('f.txt')
    expect(rpc.calls).toHaveLength(3)
    expect(store.store.getSnapshot().byPath['f.txt']!.state).toBe('ready')
  })

  it('全区超限（details 在场）⇒ 分片模式转换：ready + oversized + lineCount/maxLines 回填 + runs 留空', async () => {
    const rpc = new FakeBlameRpc()
    const store = createGitBlameStore(rpc)
    rpc.enqueue(async () => oversized(120_000, 50_000))
    await store.ensure('big.txt')
    const slot = store.store.getSnapshot().byPath['big.txt']!
    expect(slot.state).toBe('ready')
    expect(slot.oversized).toBe(true)
    expect(slot.oversizeSignaled).toBe(true)
    expect(slot.lineCount).toBe(120_000)
    expect(slot.maxLines).toBe(50_000)
    expect(slot.runs).toEqual([])
  })

  it('超限但 details 缺席（无法分片）⇒ error 槽兜底', async () => {
    const rpc = new FakeBlameRpc()
    const store = createGitBlameStore(rpc)
    rpc.enqueue(async () => ({ ok: false, error: { code: 'git/blame-oversized', message: 'no details' } }))
    await store.ensure('f.txt')
    const slot = store.store.getSnapshot().byPath['f.txt']!
    expect(slot.state).toBe('error')
    expect(slot.oversized).toBe(false)
    expect(slot.error?.code).toBe('git/blame-oversized')
  })
})

describe('ensureRange — 区间级在途簿记（评审修复钉子）', () => {
  it('同区间在途重入被拒（单 RPC）；完成后 pending 清空、loaded/runs 落位', async () => {
    const rpc = new FakeBlameRpc()
    const store = await slicedStore(rpc)
    const gate = deferred()
    rpc.enqueue(async () => {
      await gate.promise
      return ok({ lineCount: 120_000, ranges: [range(1, 100)] })
    })
    const first = store.ensureRange('big.txt', 1, 100)
    // 同步前缀已完成：调用已发出、在途键已入簿记。
    expect(rpc.calls).toHaveLength(2)
    expect(store.store.getSnapshot().byPath['big.txt']!.pending).toEqual({ '1:100': true })
    // 在途重入同区间 ⇒ no-op（修复前：单槽位 pendingToken 判等在并发下失效会重发）。
    const repeat = store.ensureRange('big.txt', 1, 100)
    expect(rpc.calls).toHaveLength(2)
    expect(store.store.getSnapshot().byPath['big.txt']!.pending).toEqual({ '1:100': true })
    gate.resolve()
    await Promise.all([first, repeat])
    const slot = store.store.getSnapshot().byPath['big.txt']!
    expect(slot.pending).toEqual({})
    expect(slot.loaded).toEqual([{ start: 1, end: 100 }])
    expect(slot.runs.map((run) => [run.startLine, run.endLine])).toEqual([[1, 100]])
  })

  it('不同区间并发互不遮蔽：各自在途、各自完成、结果都归并；A 完成后 A 区间已覆盖不再重发', async () => {
    const rpc = new FakeBlameRpc()
    const store = await slicedStore(rpc)
    const gateA = deferred()
    const gateB = deferred()
    rpc.enqueue(async () => {
      await gateA.promise
      return ok({ lineCount: 120_000, ranges: [range(1, 100)] })
    })
    rpc.enqueue(async () => {
      await gateB.promise
      return ok({ lineCount: 120_000, ranges: [range(101, 100, 'b'.repeat(40))] })
    })
    const a = store.ensureRange('big.txt', 1, 100)
    const b = store.ensureRange('big.txt', 101, 200)
    expect(rpc.calls).toHaveLength(3) // 全区 + A + B（两键并存于簿记——修复前互相覆盖）
    expect(store.store.getSnapshot().byPath['big.txt']!.pending)
      .toEqual({ '1:100': true, '101:200': true })
    gateA.resolve()
    await a
    // A 完成、B 仍在途：A 键已清、B 键保留；A 区间已覆盖 ⇒ 再调 no-op（B 在途不妨碍判覆盖）。
    expect(store.store.getSnapshot().byPath['big.txt']!.pending).toEqual({ '101:200': true })
    await store.ensureRange('big.txt', 1, 100)
    expect(rpc.calls).toHaveLength(3)
    gateB.resolve()
    await b
    const slot = store.store.getSnapshot().byPath['big.txt']!
    expect(slot.pending).toEqual({})
    expect(slot.loaded).toEqual([{ start: 1, end: 100 }, { start: 101, end: 200 }])
    expect(slot.runs.map((run) => [run.startLine, run.endLine])).toEqual([[1, 100], [101, 200]])
  })

  it('覆盖簿记：已覆盖 no-op；倒序 no-op；分片模式窗口越界钳到文件尾且完成后不重发', async () => {
    const rpc = new FakeBlameRpc()
    const store = createGitBlameStore(rpc)
    rpc.enqueue(async () => ok({ lineCount: 5, ranges: [range(1, 5)] }))
    await store.ensure('f.txt')
    await store.ensureRange('f.txt', 1, 5) // 已覆盖
    await store.ensureRange('f.txt', 3, 2) // 倒序
    expect(rpc.calls).toHaveLength(1)

    const big = await slicedStore(rpc, 'huge.txt')
    // 计数口径：f.txt 全区 1 次 + huge.txt 全区（slicedStore）1 次 + 首片 1 次 = 3。
    // 越界钳制：end 200_000 → 120_000（文件尾）。
    await big.ensureRange('huge.txt', 119_000, 200_000)
    expect(rpc.calls).toHaveLength(3)
    expect(rpc.calls[rpc.calls.length - 1]).toEqual({ path: 'huge.txt', ref: null, range: { start: 119_000, end: 120_000 } })
    await big.ensureRange('huge.txt', 119_000, 120_000) // 已覆盖
    expect(rpc.calls).toHaveLength(3)
  })

  it('reset 清空槽位；在途请求完成后的写回被 no-op 拦下（不复活槽位）', async () => {
    const rpc = new FakeBlameRpc()
    const store = await slicedStore(rpc)
    const gate = deferred()
    rpc.enqueue(async () => {
      await gate.promise
      return ok({ lineCount: 120_000, ranges: [range(1, 100)] })
    })
    const flight = store.ensureRange('big.txt', 1, 100)
    store.reset()
    expect(store.store.getSnapshot().byPath).toEqual({})
    gate.resolve()
    await flight
    expect(store.store.getSnapshot().byPath).toEqual({})
    expect(rpc.calls).toHaveLength(2)
  })
})
