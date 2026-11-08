/**
 * createGitGraphStore / createGraphTabStore 单测（F7 提交图数据层模块；spec §6
 * stores 行的「假 GitRpcClient」纪律在本模块切片上的落地）：
 *   - log 窗口追加 + single-writer（进行中 loadMore 被拒——GitLens graphSession 契约）；
 *   - 追加去重（乱序页间重复 oid 不进窗口，前缀行引用不变——G2 的 store 半）；
 *   - branch.oid 变化 → reloadLog + refreshRefs；oid 不变的 revision 抖动不动图；
 *   - connection/reset → 清缓存 + 立即按当前快照重载；
 *   - showCommit 列表态/patch 态/splice/in-flight 去重/失败保基座；
 *   - tab store（范式 B）draft 动作面。
 */

import { describe, expect, it } from 'vitest'
import type { CommitDetail, CommitInfo, GitFollowCommand, GitStatusFrame, LogOptions, LogPage, RefsSnapshot, ShowOptions } from 'dsh-gitkit/types'
import { createGraphTabStore } from '../src/client/store/graph-tab-store.ts'
import { createGitGraphStore, GRAPH_PAGE_LIMIT } from '../src/client/store/git-graph-store.ts'
import type { GitGraphRpcFace } from '../src/client/store/git-graph-store.ts'
import { createGitStatusSource } from '../src/client/store/git-status-source.ts'
import type { GitRpcFace, GitStreamHandle, RemoteResult } from '../src/client/remote/mount.ts'

function commitInfo(oid: string, parents: readonly string[] = []): CommitInfo {
  return {
    oid,
    parents: [...parents],
    authorName: 't',
    authorEmail: 't@example.com',
    authoredAt: '2026-01-01T00:00:00Z',
    committedAt: '2026-01-01T00:00:00Z',
    subject: `subject ${oid}`,
    body: '',
  }
}

function page(commits: readonly CommitInfo[], hasMore: boolean): LogPage {
  return { commits: [...commits], hasMore, skipUsed: 0, limitUsed: GRAPH_PAGE_LIMIT }
}

/** 微任务/宏任务双冲刷（reloadLog 链路的异步落地；比逐级 Promise.resolve 稳健）。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** 内存流句柄（照 git-status-source.spec 的假实现切片；本套用例不驱动流）。 */
class FakeStream implements GitStreamHandle<GitStatusFrame, GitFollowCommand> {
  disposed = 0
  private finished = false

  send(): void { /* 本套用例不消费上行 */ }
  end(): void { /* 半关上行 */ }
  dispose(): void {
    this.disposed += 1
    this.finished = true
  }

  async *[Symbol.asyncIterator](): AsyncIterator<GitStatusFrame> {
    while (!this.finished) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
    }
  }
}

/** 可编程假 RPC（log/refs/getCommitDetail 逐路径响应 + 调用记录；状态源切片 no-op）。 */
class FakeGraphRpc implements GitGraphRpcFace, Pick<GitRpcFace, 'followStatus' | 'status'> {
  readonly logCalls: LogOptions[] = []
  readonly detailCalls: ShowOptions[] = []
  refsCalls = 0
  /** 页计划：第 n 次 log 调用的响应。 */
  logPlan: RemoteResult<LogPage>[] = []
  /** log 挂起门：出现即挂起；flushLogGates() 放行。 */
  logGates: Array<() => void> = []
  detailPlan: Map<string, RemoteResult<CommitDetail>[]> = new Map()
  refsPlan: RemoteResult<RefsSnapshot> = { ok: true, value: { refs: [], head: { kind: 'unborn', name: null, oid: null } } }

  async log(options: LogOptions): Promise<RemoteResult<LogPage>> {
    this.logCalls.push({ ...options })
    if (this.logGates.length > 0) {
      await new Promise<void>((resolve) => { this.logGates.push(resolve) })
    }
    const next = this.logPlan.shift()
    if (next === undefined) throw new Error('FakeGraphRpc: unexpected log call')
    return next
  }

  flushLogGates(): void {
    for (const gate of this.logGates.splice(0)) gate()
  }

  async refs(): Promise<RemoteResult<RefsSnapshot>> {
    this.refsCalls += 1
    return this.refsPlan
  }

  async getCommitDetail(options: ShowOptions): Promise<RemoteResult<CommitDetail>> {
    this.detailCalls.push({ ...options })
    const queue = this.detailPlan.get(`${options.oid}|${options.path ?? ''}`)
    const planned = queue?.shift()
    if (planned === undefined) throw new Error(`FakeGraphRpc: unexpected detail call ${options.oid}|${options.path ?? ''}`)
    return planned
  }

  // 状态源切片（本套用例不驱动流；仅构造参数形状需要）。
  async followStatus(): Promise<GitStreamHandle<GitStatusFrame, GitFollowCommand>> {
    return new FakeStream()
  }

  async status(): Promise<never> {
    throw new Error('FakeGraphRpc.status must not be called')
  }
}

/** 装配：真状态源 + 假 RPC 的图 store；用 pushStatus 推帧驱动 branch.oid 变化。 */
function makeHarness() {
  const rpc = new FakeGraphRpc()
  const source = createGitStatusSource(rpc as unknown as GitRpcFace)
  const store = createGitGraphStore(rpc, source)
  return { rpc, source, store }
}

describe('log 窗口（分页追加 / single-writer / 去重）', () => {
  it('branch.oid 首帧触发首页加载；hasMore 逐页追加且 loadedCount 累计 walk 游标', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a'), commitInfo('b')], true) },
      { ok: true, value: page([commitInfo('c')], false) },
    ]
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    source.store.update(() => { /* 第二次 update 触发订阅（同 oid 不重载） */ })
    await flush()
    let snapshot = store.store.getSnapshot()
    expect(snapshot.log.commits.map((commit) => commit.oid)).toEqual(['a', 'b'])
    expect(snapshot.log.hasMore).toBe(true)
    expect(snapshot.log.loadedCount).toBe(2)
    expect(rpc.logCalls[0]).toEqual({ limit: GRAPH_PAGE_LIMIT, skip: 0 })

    await store.loadMore()
    snapshot = store.store.getSnapshot()
    expect(snapshot.log.commits.map((commit) => commit.oid)).toEqual(['a', 'b', 'c'])
    expect(snapshot.log.hasMore).toBe(false)
    expect(snapshot.log.loadedCount).toBe(3)
    expect(rpc.logCalls[1]).toEqual({ limit: GRAPH_PAGE_LIMIT, skip: 2 })
    store.dispose()
  })

  it('single-writer：loadMore 进行中再触发被忽略（一次 RPC）', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a')], true) },
      { ok: true, value: page([commitInfo('b')], false) },
    ]
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    rpc.logGates.push(() => {}) // 下一页挂起
    const first = store.loadMore()
    const second = store.loadMore() // single-writer：直接忽略
    expect(store.store.getSnapshot().log.loadMoreInFlight).toBe(true)
    rpc.flushLogGates()
    await Promise.all([first, second])
    expect(rpc.logCalls).toHaveLength(2) // 首页 + 一页 more（第二次触发没有产生调用）
    expect(store.store.getSnapshot().log.loadMoreInFlight).toBe(false)
    store.dispose()
  })

  it('追加去重：页间重复 oid 不进窗口，前缀行引用不变（G2 的 store 半）', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a'), commitInfo('b')], true) },
      { ok: true, value: page([commitInfo('b'), commitInfo('c')], false) }, // b 重复（历史在两页间变化）
    ]
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    const before = store.store.getSnapshot().log.commits
    await store.loadMore()
    const after = store.store.getSnapshot().log.commits
    expect(after.map((commit) => commit.oid)).toEqual(['a', 'b', 'c'])
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    // loadedCount 按 walk 游标累计（重复也消耗 walk 名额）。
    expect(store.store.getSnapshot().log.loadedCount).toBe(4)
    store.dispose()
  })

  it('branch.oid 变化 → 清窗重载 + refs 重取；oid 不变的 revision 抖动不动图', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a')], false) },
      { ok: true, value: page([commitInfo('x')], false) },
    ]
    const frame = (oid: string): void => {
      source.store.update((draft) => {
        draft.status = {
          repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid, abbrevOid: oid, upstream: null, ahead: null, behind: null, detached: false, unborn: false },
          staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
        }
      })
    }
    frame('a')
    await flush()
    expect(store.store.getSnapshot().log.commits.map((commit) => commit.oid)).toEqual(['a'])
    const refsAfterFirst = rpc.refsCalls
    // 同 oid 的 revision 抖动（工作区变化）：不重载、不重取 refs。
    source.store.update((draft) => {
      if (draft.status !== null) draft.status.generatedAt = 'changed'
    })
    await flush()
    expect(store.store.getSnapshot().log.commits.map((commit) => commit.oid)).toEqual(['a'])
    expect(rpc.logCalls).toHaveLength(1)
    expect(rpc.refsCalls).toBe(refsAfterFirst)
    // oid 变化（提交）：清窗重载。
    frame('x')
    await flush()
    expect(store.store.getSnapshot().log.commits.map((commit) => commit.oid)).toEqual(['x'])
    expect(rpc.logCalls).toHaveLength(2)
    expect(rpc.refsCalls).toBeGreaterThan(refsAfterFirst)
    store.dispose()
  })

  it('keepMounted 图 tab 的 branchSwitch 重载回归：切分支新帧（branch 名+oid 变）→ 同一 store 实例清窗重载 + refs 重取（§3.10 风险项落点）', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a'), commitInfo('b')], false) },
      { ok: true, value: page([commitInfo('x')], false) },
    ]
    rpc.detailPlan.set('a|', [{ ok: true, value: {
      commit: commitInfo('a'), files: [], totalTruncated: false, refs: [],
    } }])
    const frame = (name: string | null, oid: string, detached = false): void => {
      source.store.update((draft) => {
        draft.status = {
          repoRoot: '/r', generatedAt: '', branch: { name, oid, abbrevOid: oid.slice(0, 7), upstream: null, ahead: null, behind: null, detached, unborn: false },
          staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
        }
      })
    }
    // 切换前：main@a 的窗口已加载，且选中提交的详情缓存就绪（keepMounted 下的常态）。
    frame('main', 'a')
    await flush()
    expect(store.store.getSnapshot().log.commits.map((commit) => commit.oid)).toEqual(['a', 'b'])
    await store.showCommit('a')
    expect(store.store.getSnapshot().details.a?.state).toBe('ready')
    const refsBefore = rpc.refsCalls
    // branchSwitch 成功（host 侧 HEAD 变更 → R3/R5 帧）：branch 名与 oid 同帧变化。
    frame('feature/a', 'x')
    await flush()
    // 同一 store 实例（tab keepMounted 不重铸）：窗口替换为新分支历史，refs 重取。
    expect(store.store.getSnapshot().log.commits.map((commit) => commit.oid)).toEqual(['x'])
    expect(rpc.logCalls).toHaveLength(2)
    expect(rpc.refsCalls).toBeGreaterThan(refsBefore)
    // oid 键的详情缓存按 store 契约保留（ready 槽不随 reload 失效——切回旧分支仍命中）。
    expect(store.store.getSnapshot().details.a?.state).toBe('ready')
    store.dispose()
  })

  it('connection/reset → reset 清缓存并按当前快照立即重载', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a')], false) },
      { ok: true, value: page([commitInfo('a')], false) },
    ]
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    expect(store.store.getSnapshot().log.commits).toHaveLength(1)
    store.reset()
    await flush()
    // reset 后 lastBranchOid 回到哨兵 → 立即按当前快照重载（同 oid 也重载）。
    expect(rpc.logCalls).toHaveLength(2)
    expect(store.store.getSnapshot().log.commits.map((commit) => commit.oid)).toEqual(['a'])
    store.dispose()
  })

  it('log 失败落 log.error（可 reload 重试）；dispose 后迟到响应丢弃', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: false, error: { code: 'git/no-repository', message: 'not a repo' } },
    ]
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    expect(store.store.getSnapshot().log.error?.code).toBe('git/no-repository')
    store.dispose()
    // dispose 后 frame 也不触发新调用（订阅已退）。
    const calls = rpc.logCalls.length
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'z', abbrevOid: 'z', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await Promise.resolve()
    expect(rpc.logCalls.length).toBe(calls)
  })
})

describe('showCommit（详情列表态 / 文件 patch 态 splice）', () => {
  const baseDetail: CommitDetail = {
    commit: commitInfo('a', []),
    files: [
      { path: 'f1.txt', origPath: null, status: 'modified', binary: false, additions: 1, deletions: 0, patch: null, patchTruncated: false, oversized: false },
      { path: 'f2.txt', origPath: null, status: 'added', binary: false, additions: 2, deletions: 0, patch: null, patchTruncated: false, oversized: false },
    ],
    totalTruncated: false,
    refs: [],
  }

  it('列表态缓存命中不重发；path 态 splice 带 patch 文件回缓存', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [{ ok: true, value: page([commitInfo('a')], false) }]
    rpc.detailPlan.set('a|', [{ ok: true, value: baseDetail }])
    rpc.detailPlan.set('a|f1.txt', [{
      ok: true,
      value: {
        ...baseDetail,
        files: [{ ...baseDetail.files[0]!, patch: 'patch-f1' }],
      },
    }])
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    await store.showCommit('a')
    expect(store.store.getSnapshot().details['a']?.state).toBe('ready')
    await store.showCommit('a') // 命中缓存：不重发
    expect(rpc.detailCalls).toHaveLength(1)

    await store.showCommit('a', 'f1.txt')
    expect(rpc.detailCalls).toHaveLength(2)
    expect(rpc.detailCalls[1]).toEqual({ oid: 'a', path: 'f1.txt' })
    const slot = store.store.getSnapshot().details['a']
    expect(slot?.state).toBe('ready')
    expect(slot?.detail?.files[0]?.patch).toBe('patch-f1')
    expect(slot?.detail?.files[1]?.patch).toBeNull() // 其余文件不动
    await store.showCommit('a', 'f1.txt') // 已有 patch：不重发
    expect(rpc.detailCalls).toHaveLength(2)
    store.dispose()
  })

  it('path 态失败保基座（文件行回落占位）；基座未就绪时先等基座', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [{ ok: true, value: page([commitInfo('a')], false) }]
    rpc.detailPlan.set('a|', [{ ok: true, value: baseDetail }])
    rpc.detailPlan.set('a|f1.txt', [{ ok: false, error: { code: 'git/git-error', message: 'boom' } }])
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    // 基座未就绪时点文件：先等基座再取 patch。
    const pending = store.showCommit('a', 'f1.txt')
    await pending
    const slot = store.store.getSnapshot().details['a']
    expect(slot?.state).toBe('ready')
    expect(slot?.detail?.files[0]?.patch).toBeNull() // patch 失败：保基座 null patch
    expect(slot?.pendingPath).toBeNull()
    store.dispose()
  })

  it('error 槽可重试：再次 showCommit 清失败槽并重发拉取；成功后回到缓存命中（P2 卡死修复）', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [{ ok: true, value: page([commitInfo('a')], false) }]
    rpc.detailPlan.set('a|', [
      { ok: false, error: { code: 'git/git-error', message: 'boom' } },
      { ok: true, value: baseDetail },
    ])
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    await store.showCommit('a')
    const failed = store.store.getSnapshot().details['a']
    expect(failed?.state).toBe('error')
    expect(failed?.error?.code).toBe('git/git-error')
    expect(rpc.detailCalls).toHaveLength(1)
    // 重试：缓存命中守卫对 error 槽放行 → 失败槽被清除（置 loading 后落地）+ 重发。
    await store.showCommit('a')
    expect(rpc.detailCalls).toHaveLength(2)
    const retried = store.store.getSnapshot().details['a']
    expect(retried?.state).toBe('ready')
    expect(retried?.error).toBeUndefined()
    expect(retried?.detail).toBe(baseDetail)
    // 重试成功后的 ready 槽恢复缓存命中（不重发）。
    await store.showCommit('a')
    expect(rpc.detailCalls).toHaveLength(2)
    store.dispose()
  })

  it('reloadLog 清理失败详情槽（成功缓存保留）；重选失败行重新拉取（P2 配套半）', async () => {
    const { rpc, source, store } = makeHarness()
    rpc.logPlan = [
      { ok: true, value: page([commitInfo('a'), commitInfo('b')], false) },
      { ok: true, value: page([commitInfo('a'), commitInfo('b')], false) },
    ]
    rpc.detailPlan.set('a|', [{ ok: true, value: baseDetail }])
    rpc.detailPlan.set('b|', [
      { ok: false, error: { code: 'git/timeout', message: 'slow' } },
      { ok: true, value: { ...baseDetail, commit: commitInfo('b') } },
    ])
    source.store.update((draft) => {
      draft.status = {
        repoRoot: '/r', generatedAt: '', branch: { name: 'main', oid: 'a', abbrevOid: 'a', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      }
    })
    await flush()
    await store.showCommit('a') // ready 缓存
    await store.showCommit('b') // 失败槽
    expect(store.store.getSnapshot().details['a']?.state).toBe('ready')
    expect(store.store.getSnapshot().details['b']?.state).toBe('error')
    await store.reloadLog()
    const details = store.store.getSnapshot().details
    expect(details['a']?.state).toBe('ready')
    expect(details['a']?.detail).toBe(baseDetail) // 成功缓存保留（同引用，不失效）
    expect(details['b']).toBeUndefined() // 失败槽已清
    // 重选失败行：槽缺席 → 重新拉取成功（「失败后重选不再触发」的 store 半）。
    await store.showCommit('b')
    expect(rpc.detailCalls.filter((call) => call.oid === 'b')).toHaveLength(2)
    expect(store.store.getSnapshot().details['b']?.state).toBe('ready')
    store.dispose()
  })
})

describe('createGraphTabStore（范式 B draft 动作面）', () => {
  it('select 切换选中并收起文件位；openDetailPath 切换展开', () => {
    const instance = createGraphTabStore().create()
    expect(instance.getSnapshot().selectedOid).toBeNull()
    expect(instance.getSnapshot().detailPath).toBeNull()
    instance.actions.select('abc')
    instance.actions.openDetailPath('f1.txt')
    expect(instance.getSnapshot().selectedOid).toBe('abc')
    expect(instance.getSnapshot().detailPath).toBe('f1.txt')
    instance.actions.select(null)
    expect(instance.getSnapshot().selectedOid).toBeNull()
    expect(instance.getSnapshot().detailPath).toBeNull() // 换选即收起文件位
  })

  it('工厂多次调用产独立实例（模块级句柄禁止）', () => {
    const left = createGraphTabStore().create()
    const right = createGraphTabStore().create()
    left.actions.select('abc')
    expect(right.getSnapshot().selectedOid).toBeNull()
  })
})
