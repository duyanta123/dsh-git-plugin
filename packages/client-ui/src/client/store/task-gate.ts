/**
 * dsh-gitkit-ui — store 任务闸（Phase 2·client 低风险去重提取）。
 *
 * `createTaskGate()` 原为三个范式 A store 里的逐字同构骨架
 * （store/git-changes-store.ts loadDiff、store/checkpoint-store.ts ensureSection +
 * loadDiff、store/git-graph-store.ts showCommit）：**in-flight 按 key 去重**（同键
 * 在途复用既有任务）+ **代际捕获/比对**（旧代际在途响应一律丢弃——绝不写回新代际）
 * + **finally 清理**（仅当登记未被顶替时删除）。本文件收口为唯一定义。
 *
 * 各 store 的代际/失效**语义差异仍由各 store 自持**（本闸只承接计数与登记机制）：
 *  - revision 订阅失效走 `bump()`（只递增代际，**不在途清空**——checkpoint diff 槽
 *    不随 revision 失效，在途去重面保持原状；旧任务由各自 finally 自清）；
 *  - reset/dispose/写后乐观失效走 `forget()`（递增代际 + 清空在途登记）；
 *  - 非去重面（graph store 的 reloadLog/refreshRefs/loadMore——single-writer 闸或
 *    无条件任务）用 `guard()` 捕获代际。
 * 任务 promise 的错误拓扑（外层 .catch 折叠 vs 内联 try/catch）是各 store 的快照面
 * 语义，留在 fn 半——本闸不吞错、不改写拒绝路径。
 */

/** 迟到响应的丢弃判据：捕获时刻的代际已换代 ⇒ true（旧代际响应不写回）。 */
export type StaleCheck = () => boolean

/** 任务闸面（in-flight 去重 + 代际丢弃 + finally 清理的同构骨架）。 */
export interface TaskGate {
  /**
   * 去重运行：同 key 在途即复用既有任务（不再调用 fn）；否则调用 fn 并登记，任务
   * 结束（含失败）后清理登记。fn 收到本次运行的 `stale()` 谓词——写回快照前比对，
   * 旧代际响应一律丢弃。fn 自持错误拓扑；本闸只在 finally 半清理、不改写拒绝。
   */
  run<T>(key: string, fn: (stale: StaleCheck) => Promise<T>): Promise<T>
  /** 非去重任务的代际捕获（single-writer/无条件面）——返回同款迟到丢弃谓词。 */
  guard(): StaleCheck
  /** 只递增代际（revision 订阅失效半——在途登记保留，去重面不破）。 */
  bump(): void
  /** 递增代际 + 清空在途登记（reset/dispose/写后乐观失效半）。 */
  forget(): void
}

/** 创建任务闸（工厂——模块级句柄禁止，map §3.4；每 store 实例各一把）。 */
export function createTaskGate(): TaskGate {
  let generation = 0
  const pending = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, fn: (stale: StaleCheck) => Promise<T>): Promise<T> {
      const inFlight = pending.get(key)
      if (inFlight !== undefined) return inFlight as Promise<T>
      const gen = generation
      const stale: StaleCheck = () => gen !== generation
      const task = fn(stale).finally(() => {
        if (pending.get(key) === task) pending.delete(key)
      })
      pending.set(key, task)
      return task
    },
    guard(): StaleCheck {
      const gen = generation
      return () => gen !== generation
    },
    bump(): void {
      generation += 1
    },
    forget(): void {
      generation += 1
      pending.clear()
    },
  }
}
