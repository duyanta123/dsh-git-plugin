/**
 * client 侧测试公共设施（收纳三份 spec 的内联假实现副本——只做收纳，行为面不变）：
 *   - FakeStream 内存流：原 git-status-source.spec:15± 与 changes-store.spec:19± 的
 *     队列驱动版两份 + graph-store.spec:44± 的不驱动精简版一份。队列版是超集
 *     （push 推帧 / sent 上行记录 / disposed 计数齐备）；graph-store 的套件不驱动流，
 *     收敛后「dispose 后迭代器 done」的外显行为与原精简版一致。
 *   - 假快照工厂 mkSnapshot/statusFrame/errorFrame：原 git-status-source 与
 *     changes-store 各持一份副本。两文件的 mkSnapshot 缺省 branch 三键不同
 *     （upstream 'origin/main'/0/0 vs null）——两文件均不断言这三键的值，且
 *     snapshotSignature 只做同文件内一致性比较，收敛为 status-source 侧原形后
 *     观测等价（changes-store 的 revision 流内部自洽不变）。
 * 断言纪律不变：spec §3.2「测试 = 内存假实现」。
 */

import type { GitFollowCommand, GitStatusFrame, GitStatusSnapshot } from 'dsh-gitkit/types'
import type { GitStreamHandle } from '../../src/client/remote/mount.ts'

/** 内存流句柄：队列 + 唤醒；记录上行（sent）与 dispose 次数；push 供用例推帧驱动源。 */
export class FakeStream implements GitStreamHandle<GitStatusFrame, GitFollowCommand> {
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

/** 假快照（GitStatusSnapshot 全量形状；overrides 就地覆盖缺省）。 */
export function mkSnapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
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

/** status 帧（R2 change 推送形状）。 */
export function statusFrame(snapshot: GitStatusSnapshot): GitStatusFrame {
  return { kind: 'status', reason: 'change', snapshot }
}

/** error 帧（不可用投影/R6 降级用例）。 */
export function errorFrame(code: string): GitStatusFrame {
  return { kind: 'error', reason: 'poll', error: { code, message: `boom: ${code}` } }
}
