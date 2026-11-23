/**
 * Phase 2·client 前置 — changes-ops-face 的 RPC 参数直通对账（stash/hunk 链路行为锁定；
 * must-be-green 现状套件）。
 *
 * 被锁链路（真实模块组装，非替身复制——GitChangesTab 的载荷组装全部收敛在这两个
 * 纯函数 + 本面直通上）：
 *   - stash：`stashPushOptions`（stash-view-model，D4=B includeUntracked 显式 wire +
 *     baseRevision 乐观基线）→ `createChangesOpsFace().stashPush` → rpc；
 *     pop/drop 的 `{index}` / `{index, acknowledged:true}` 载荷经面原样过线；
 *   - hunk：`assembleSelectedPatch`（diff/patch-select，勾选裁剪）+ `directionOfScope`
 *     （D7=B 两态）→ `createChangesOpsFace().stagePatch` → rpc；
 *   - `stashList` 零参直通（reloadStash 的清单重读）。
 *
 * 断言纪律：FakeOpsRpc 用**窄切片**（implements Pick<GitRpcFace, …>——graph-store.spec
 * 的 FakeGraphRpc 同款，禁全量桩）；记录 {method, args} 并按方法回脚本化 RemoteResult；
 * 直通语义用**同一引用**（toBe）锁死——面不得重组/折叠/补字段（折叠语义在
 * createGitRpcClient，loader-composition.spec 已锁）。
 *
 * 范围注记（诚实登记）：stash 面板的相位机（idle/loading/ready/error）与成功后
 * refresh→reloadStash 的调用序、hunk 失败的乐观勾选回滚，均活在 GitChangesTab 组件
 * 闭包内（GitChangesTab.tsx:352-404 / 480-487 / 646-681），本环境（node 无渲染器，
 * jsdom/testing-library 缺位——graph-error-surfaces.spec.ts:13 同证）不可交互驱动，
 * 本 spec 以真实模块组装链 + 纯函数面锁定其全部可锁半；组件半以行号事实登记于提交
 * 说明 locked 清单，渲染基建落地后可升级为断言。
 */

import { describe, expect, it } from 'vitest'
import type {
  DiffFile, StagePatchOptions, StagePatchResult, StashListResult, StashOpResult, StashPopOptions,
  StashDropOptions, StashPushOptions,
} from 'dsh-gitkit/types'
import { createChangesOpsFace } from '../../src/client/changes-ops-face.ts'
import { assembleSelectedPatch, directionOfScope, hunkLineKeys } from '../../src/client/diff/patch-select.ts'
import { parsePatch } from '../../src/client/diff/patch-hunks.ts'
import type { GitRpcFace, RemoteResult } from '../../src/client/remote/mount.ts'
import { STASH_INCLUDE_UNTRACKED_DEFAULT, stashPushOptions } from '../../src/client/stash-view-model.ts'

/** 两 hunk 夹具（hunk-stage.spec 同款——hunk1 全选/部分选的期望 patch 已在该 spec 逐字锁定）。 */
const PATCH = [
  'diff --git a/app.ts b/app.ts',
  'index 1111111..2222222 100644',
  '--- a/app.ts',
  '+++ b/app.ts',
  '@@ -1,3 +1,4 @@ imports',
  ' import { a } from "./a"',
  '-const old = 1',
  '+const fresh = 1',
  '+const extra = 2',
  ' ',
  '@@ -20,3 +21,3 @@ main',
  ' start()',
  '-cleanup()',
  '+finish()',
  ' run()',
].join('\n')

function mkFile(patch: string | null, binary = false): DiffFile {
  return {
    path: 'app.ts', origPath: null, status: 'modified', binary,
    additions: 3, deletions: 2, patch, patchTruncated: false, oversized: false,
  }
}

const OID = 'b'.repeat(40)

/** 一次 rpc 调用的记录（method + 实参逐位——arity 与形状断言用）。 */
interface RecordedCall {
  method: string
  args: unknown[]
}

/**
 * stash/hunk 链路的 rpc 替身（窄切片：只实现本面消费的五方法——GraphRpc 同款纪律）。
 * 每方法回各自脚本化计划（缺省 ok:true 形状），调用按序记录。
 */
class FakeOpsRpc implements Pick<GitRpcFace, 'stashList' | 'stashPush' | 'stashPop' | 'stashDrop' | 'stagePatch'> {
  readonly calls: RecordedCall[] = []
  stashListPlan: RemoteResult<StashListResult> = { ok: true, value: { stashes: [] } }
  stashPushPlan: RemoteResult<StashOpResult> = { ok: true, value: { index: 0 } }
  stashPopPlan: RemoteResult<StashOpResult> = { ok: true, value: { index: 0 } }
  stashDropPlan: RemoteResult<StashOpResult> = { ok: true, value: { index: 1 } }
  stagePatchPlan: RemoteResult<StagePatchResult> = { ok: true, value: { staged: 1 } }

  async stashList(): Promise<RemoteResult<StashListResult>> {
    this.calls.push({ method: 'stashList', args: [] })
    return this.stashListPlan
  }

  async stashPush(options: StashPushOptions): Promise<RemoteResult<StashOpResult>> {
    this.calls.push({ method: 'stashPush', args: [options] })
    return this.stashPushPlan
  }

  async stashPop(options: StashPopOptions): Promise<RemoteResult<StashOpResult>> {
    this.calls.push({ method: 'stashPop', args: [options] })
    return this.stashPopPlan
  }

  async stashDrop(options: StashDropOptions): Promise<RemoteResult<StashOpResult>> {
    this.calls.push({ method: 'stashDrop', args: [options] })
    return this.stashDropPlan
  }

  async stagePatch(options: StagePatchOptions): Promise<RemoteResult<StagePatchResult>> {
    this.calls.push({ method: 'stagePatch', args: [options] })
    return this.stagePatchPlan
  }

  /** 最后一次某方法的实参（缺失即 fail loud——用例自证调用发生）。 */
  argsOf(method: string): unknown[] {
    const row = [...this.calls].reverse().find((call) => call.method === method)
    expect(row, `FakeOpsRpc: ${method} must have been called`).toBeDefined()
    return row!.args
  }
}

function wired(): { face: ReturnType<typeof createChangesOpsFace>; rpc: FakeOpsRpc } {
  const rpc = new FakeOpsRpc()
  return { face: createChangesOpsFace(rpc as unknown as GitRpcFace), rpc }
}

describe('changes-ops-face — stash 链路 RPC 参数直通（fake RPC 窄切片；组件载荷 = 真实 view-model 组装）', () => {
  it('stashPush：组件真实组装链 stashPushOptions(缺省勾选, branch.oid) → rpc 恰收该对象（arity 1、无 signal）', async () => {
    const { face, rpc } = wired()
    // runStashPush 的载荷 = stashPushOptions(includeUntracked, status?.branch.oid ?? null)——
    // 这里用真实 view-model 函数组装（非手抄字面量）。
    const payload = stashPushOptions(STASH_INCLUDE_UNTRACKED_DEFAULT, OID)
    const result = await face.stashPush(payload)
    expect(result).toBe(rpc.stashPushPlan) // 返回值同一引用（面零重组）
    expect(rpc.argsOf('stashPush')).toHaveLength(1)
    expect(rpc.argsOf('stashPush')[0]).toEqual({ includeUntracked: true, baseRevision: OID })
  })

  it('stashPush 形状中立：baseRevision 缺省载荷原样过线（面不补字段、不归一——wire 显式纪律）', async () => {
    const { face, rpc } = wired()
    await face.stashPush(stashPushOptions(false, null))
    expect(rpc.argsOf('stashPush')[0]).toEqual({ includeUntracked: false })
  })

  it('stashPop：{index} 载荷直通（runStashPop 的 entry.index；plan §5.3「默认最近一条 / 可指定 index」）', async () => {
    const { face, rpc } = wired()
    const plan: RemoteResult<StashOpResult> = { ok: true, value: { index: 2 } }
    rpc.stashPopPlan = plan
    const result = await face.stashPop({ index: 2 })
    expect(result).toBe(plan)
    expect(rpc.argsOf('stashPop')).toHaveLength(1)
    expect(rpc.argsOf('stashPop')[0]).toEqual({ index: 2 })
  })

  it('stashDrop：{index, acknowledged:true} 载荷直通（danger 勾选闸在组件、面只承接）；acknowledged:false 不被改写', async () => {
    const { face, rpc } = wired()
    await face.stashDrop({ index: 1, acknowledged: true })
    expect(rpc.argsOf('stashDrop')).toHaveLength(1)
    expect(rpc.argsOf('stashDrop')[0]).toEqual({ index: 1, acknowledged: true })
    await face.stashDrop({ index: 1, acknowledged: false })
    expect(rpc.argsOf('stashDrop')[0]).toEqual({ index: 1, acknowledged: false })
  })

  it('stashList：零参直通（reloadStash 的清单重读调用形状——arity 0、无 signal）；ok:false 原样返回不抛', async () => {
    const { face, rpc } = wired()
    const failure: RemoteResult<StashListResult> = {
      ok: false,
      error: { code: 'git/no-repository', message: 'not a repo', details: { probed: 'D:/repo' } },
    }
    rpc.stashListPlan = failure
    const result = await face.stashList()
    expect(result).toBe(failure) // 错误结果同一引用——面不折叠不抛（折叠在 createGitRpcClient）
    expect(rpc.argsOf('stashList')).toHaveLength(0)
  })

  it('五方法调用按序记录于同一 rpc（面无状态直通、无第二份连接）', async () => {
    const { face, rpc } = wired()
    await face.stashList()
    await face.stashPush({ includeUntracked: true })
    await face.stashPop({ index: 0 })
    await face.stashDrop({ index: 0, acknowledged: true })
    await face.stagePatch({ path: 'a.txt', patch: PATCH, direction: 'stage' })
    expect(rpc.calls.map((call) => call.method)).toEqual(['stashList', 'stashPush', 'stashPop', 'stashDrop', 'stagePatch'])
  })
})

describe('changes-ops-face — hunk 勾选链路 stagePatch 参数（applyPatchSelection 的真实组装链）', () => {
  it('组装链全真实件：assembleSelectedPatch(hunk1 全选) + directionOfScope(worktree)=stage → rpc 恰收 {path, patch, direction:"stage"}', async () => {
    const { face, rpc } = wired()
    const file = mkFile(PATCH)
    const selected = new Set<string>(hunkLineKeys(parsePatch(PATCH)[0]!))
    const patch = assembleSelectedPatch(file, selected)
    expect(patch).not.toBeNull()
    const payload: StagePatchOptions = { path: file.path, patch: patch as string, direction: directionOfScope('worktree') }
    const result = await face.stagePatch(payload)
    expect(result).toBe(rpc.stagePatchPlan)
    expect(rpc.argsOf('stagePatch')).toHaveLength(1)
    expect(rpc.argsOf('stagePatch')[0]).toEqual({
      path: 'app.ts',
      // hunk1 整选 = 文件头 + 原 hunk1（hunk-stage.spec:87 逐字锁定的期望文本）。
      patch: [
        'diff --git a/app.ts b/app.ts',
        'index 1111111..2222222 100644',
        '--- a/app.ts',
        '+++ b/app.ts',
        '@@ -1,3 +1,4 @@ imports',
        ' import { a } from "./a"',
        '-const old = 1',
        '+const fresh = 1',
        '+const extra = 2',
        ' ',
      ].join('\n') + '\n',
      direction: 'stage',
    })
  })

  it('staged 选中 = unstage 反向（D7=B）：directionOfScope 折算进 stagePatch 载荷原样过线', async () => {
    const { face, rpc } = wired()
    const patch = assembleSelectedPatch(mkFile(PATCH), new Set<string>(['add:2']))
    expect(patch).not.toBeNull()
    const payload: StagePatchOptions = { path: 'app.ts', patch: patch as string, direction: directionOfScope('staged') }
    await face.stagePatch(payload)
    expect(rpc.argsOf('stagePatch')[0]).toEqual({
      path: 'app.ts',
      // 部分行选 = 重算 hunk 头（hunk-stage.spec:122 期望 @@ -1,2 +1,3 @@ 的同链产物）。
      patch: expect.stringContaining('@@ -1,2 +1,3 @@'),
      direction: 'unstage',
    })
  })
})
