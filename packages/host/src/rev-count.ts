/**
 * dsh-gitkit — rev-list 双向计数（v2 批次二 §4.5：`revListCounts` 从 remote-ops.ts
 * 提共享——方案落点「新 packages/host/src/rev-count.ts（或由 remote-ops 导出）」；
 * remote-ops 改为消费，行为不变，迁移后 sync.spec.ts 回归）。
 *
 * 消费方：
 *   - remote-ops.ts（v1 起）：push/pull 的 diverged 预检（`<upstream>...HEAD`）；
 *   - graph.ts（批次二）：compareBranches 的 ahead/behind 双向计数（base...compare）。
 *
 * 列序语义（本机 git 2.55.0.windows.2 实测）：`rev-list --left-right --count
 * <left>...<right>` 输出 `<left-only>\t<right-only>`——**left = left 侧独有，
 * right = right 侧独有**。本函数归一为 { ahead, behind }：ahead = right 侧独有
 * （right 领先 left 的提交数）、behind = left 侧独有。
 */

import type { GitRunner } from './git-runner.ts'

/** `rev-list --left-right --count <left>...<right>` 的归一计数。 */
export interface RevListCounts {
  /** right 侧独有提交数（right 领先 left）。 */
  ahead: number
  /** left 侧独有提交数。 */
  behind: number
}

/**
 * 双向计数（失败 = null，不抛——调用方自行决定跳过预检或降级，remote-ops 预检
 * 语义保持）：exit ≠ 0（含 gone 态 rev-parse 类失败）或列解析非有限数 ⇒ null。
 * 解析失败不静默当 0（调用方拿到 null 才是不知情路径）。
 */
export async function revListCounts(
  git: GitRunner,
  repoRoot: string,
  left: string,
  right: string,
  op: string,
  signal?: AbortSignal,
): Promise<RevListCounts | null> {
  const active = signal ?? neverAborted()
  const result = await git.run(['rev-list', '--left-right', '--count', `${left}...${right}`], {
    cwd: repoRoot, op: `${op}(rev-list --left-right --count)`, signal: active,
  })
  if (result.exitCode !== 0) return null
  const [leftCount, rightCount] = result.stdout.trim().split(/\s+/)
  const behind = Number(leftCount)
  const ahead = Number(rightCount)
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null
  return { ahead, behind }
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
