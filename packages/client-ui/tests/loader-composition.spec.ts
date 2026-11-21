/**
 * M10 loader-composition 测试（④-K 提交对话框模块 ask §③；spec §6 第 11 行「装载冒烟」
 * 的进程内组合半——真宿主往返在 scripts/verify-load.mjs M11）。
 *
 * **模块表三方对账，断言无未加载行**（composition table = 提交链路的装载面）：
 *   1. host `REMOTE_METHODS`（src/index.ts 源面权威）——16 个 @Remote 方法；
 *   2. typert-generator 生成产物 `dsh-gitkit/remote` 的 `methods` 键——生成描述符；
 *   3. client `GIT_NAMESPACE_METHODS` + `createGitRpcClient()` 产物的函数键——client 面。
 * 三层键集必须两两相等：host 声明了而生成产物没有 = 生成器漏行；生成产物有而 client
 * 面没有 = client 落后（调用在方法缺席处 TypeError）；多出的行 = 幽灵面。
 *
 * 另断言提交链路 UI 桩已全部接线（无未加载桩行）：装配面不再有 ④-K 之前的
 * openCommitDialog no-op 占位，两个拉起方（header 菜单 / 变更面板底部按钮）引用
 * GitCommitDialog，快捷键 aria-keyshortcuts 四组锚在位（ask §②）。
 *
 * 位置注记：放在 client-ui/tests（包编译面解析 `dsh-gitkit*` workspace link 与
 * dsh-client-* 类型面；根 tsconfig 无 paths 表，locales.ts 的 declare module 增补也
 * 只在包程序内合法——包级组合测试是对账层的自然归属）。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import gitRemote from 'dsh-gitkit/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { GIT_NAMESPACE_METHODS, createGitRpcClient } from '../src/client/remote/mount.ts'
import { headerMenuItems, headerViewModel } from '../src/client/ui-model.ts'
import type { GitStatusSourceState } from '../src/client/store/git-status-source.ts'
import type { GitStatusSnapshot } from 'dsh-gitkit/types'
import { GATEWAY_UNAVAILABLE } from '../src/client/remote/mount.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const clientSrc = (rel: string): string => path.join(repoRoot, 'packages', 'client-ui', 'src', 'client', rel)

async function readText(abs: string): Promise<string> {
  return readFile(abs, 'utf8')
}

/** host src/index.ts 的 REMOTE_METHODS 字面量解析（源面权威——不依赖构建产物）。 */
async function remoteMethodsOfSource(): Promise<string[]> {
  const source = await readText(path.join(repoRoot, 'packages', 'host', 'src', 'index.ts'))
  const match = source.match(/export const REMOTE_METHODS = \[([^\]]+)\] as const/)
  expect(match, 'host src/index.ts must declare REMOTE_METHODS as a const array').not.toBeNull()
  return (match![1] ?? '').split(',').map((item) => item.trim().replaceAll("'", '')).filter((item) => item.length > 0)
}

describe('M10 模块表三方对账（host REMOTE_METHODS ⇄ 生成描述符 ⇄ client 面）', () => {
  it('生成产物 methods 键 = host REMOTE_METHODS（无未生成的行）', async () => {
    const declared = await remoteMethodsOfSource()
    const generated = Object.keys(gitRemote.methods).map((key) => key.replace(/^git\//, '')).sort()
    expect(declared.sort()).toEqual(generated)
    expect(declared.length).toBeGreaterThan(0)
  })

  it('client GIT_NAMESPACE_METHODS = host REMOTE_METHODS（无缺面的行）', async () => {
    const declared = (await remoteMethodsOfSource()).sort()
    expect([...GIT_NAMESPACE_METHODS].sort()).toEqual(declared)
  })

  it('createGitRpcClient 产物的函数键 = GIT_NAMESPACE_METHODS（无幽灵面行）', () => {
    const ready = Promise.resolve()
    const git = Object.fromEntries(GIT_NAMESPACE_METHODS.map((name) => [name, async () => ({ ok: true, value: {} })]))
    const remote = { $mount: async () => async () => {}, git } as unknown as TypertClientRemote
    const rpc = createGitRpcClient({ remote }, ready)
    const produced = Object.keys(rpc)
      .filter((key) => typeof (rpc as unknown as Record<string, unknown>)[key] === 'function')
      .sort()
    expect(produced).toEqual([...GIT_NAMESPACE_METHODS].sort())
  })

  it('生成描述符的 package 字段 = dsh-gitkit（装载身份；spec 面是运行期形状，类型面只有 methods）', () => {
    const spec = (gitRemote as unknown as { spec: { package: string; methods: Record<string, unknown> } }).spec
    expect(spec.package).toBe('dsh-gitkit')
    expect(Object.keys(spec.methods).every((key) => key.startsWith('git/'))).toBe(true)
  })
})

describe('M10 提交链路 UI 桩接线（无未加载桩行，ask ①/②）', () => {
  it('装配面：createCommitDialogFace 已接线，openCommitDialog no-op 占位已移除', async () => {
    const assembly = await readText(clientSrc('index.ts'))
    expect(assembly).toContain('createCommitDialogFace')
    expect(assembly).toContain('commitDialog: commitDialogFace')
    expect(assembly).not.toContain('占位：GitCommitDialog')
    expect(assembly).not.toContain('openCommitDialog')
  })

  it('两个拉起方均引用 GitCommitDialog（header 菜单 / 变更面板底部按钮）', async () => {
    for (const component of ['components/GitHeaderButton.tsx', 'components/GitChangesTab.tsx']) {
      const source = await readText(clientSrc(component))
      expect(source, `${component} must render GitCommitDialog`).toContain('GitCommitDialog')
      expect(source, `${component} must hold the dialog open-intent state`).toContain('commitIntent')
    }
    const changesTab = await readText(clientSrc('components/GitChangesTab.tsx'))
    // 底部提交按钮不再恒禁用（disabled 改由仓库可用性驱动——④-K 之前的恒禁用占位已移除）。
    expect(changesTab).toContain('disabled={!view.available}')
    expect(changesTab).not.toContain('data-git-changes-commit=\'\'\n          disabled\n')
  })

  it('快捷键 aria-keyshortcuts 四组锚在位（对话框 Ctrl/Cmd+Enter+Esc / 列表 Space Enter Delete / 图 ↑↓+Enter）', async () => {
    const dialog = await readText(clientSrc('components/GitCommitDialog.tsx'))
    expect(dialog).toContain("'Control+Enter Meta+Enter'")
    expect(dialog).toContain("aria-keyshortcuts='Escape'")
    expect(dialog).toContain('data-git-commit-dialog=')
    // 原 portal 自建实现已被原语 Modal 取代（初始聚焦锚 = 编辑器上的
    // data-modal-autofocus，Modal useModalLayer querySelector 消费）。
    expect(dialog).toContain('data-modal-autofocus')
    const card = await readText(clientSrc('components/ChangeCard.tsx'))
    expect(card).toContain("'Space Enter Delete'")
    expect(card).toContain("'Space Enter'")
    const graph = await readText(clientSrc('components/git-graph-tab.tsx'))
    expect(graph).toContain("'ArrowDown ArrowUp'")
    expect(graph).toContain("aria-keyshortcuts='Enter'")
  })

  it('命令面板/快捷键注册失败降级锚（批次四评审修复）：apply 内 register 包 try/catch + logger.warn，不穿出 effect', async () => {
    const assembly = await readText(clientSrc('index.ts'))
    // 宿主侧 register 可能 throw（commandUi 撞名 fail loud；shortcuts 保留键/白名单/
    // 重叠校验 registry.ts:88-97）——throw 穿出 ctx.effect = 插件 apply 失败。
    // 装配面必须经 registerPaletteEntry 降级（warn + 跳过该条，其余 UI 照常）。
    expect(assembly).toContain('registerPaletteEntry')
    const guardBody = assembly.slice(assembly.indexOf('registerPaletteEntry'), assembly.indexOf('command palette contributions'))
    expect(guardBody).toContain('try')
    expect(guardBody).toContain('catch')
    expect(guardBody).toContain('ctx.logger.warn')
  })

  it('菜单行已加载：仓库可用时 v1 四动作可点、sync 占位已拆为推送/拉取/获取三真行 + 管理面扩行（V2 批次一）+ 创建 PR 行（批次四）', () => {
    const state: GitStatusSourceState = {
      repo: { available: true, root: 'D:/repo', checking: false },
      status: {
        repoRoot: 'D:/repo',
        generatedAt: '2026-11-01T00:00:00.000Z',
        branch: { name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      } satisfies GitStatusSnapshot,
      statusError: null,
      revision: 1,
      streaming: true,
    }
    const items = headerMenuItems(headerViewModel(state))
    expect(Object.fromEntries(items.map((item) => [item.id, { enabled: item.enabled }])))
      .toEqual({
        'open-changes': { enabled: true },
        'open-graph': { enabled: true },
        'commit': { enabled: true },
        'commit-push': { enabled: true },
        'push': { enabled: true },
        'pull': { enabled: true },
        'fetch': { enabled: true },
        'branches': { enabled: true },
        // V2 批次二：与当前分支比较（[36]）/ 重置当前分支（[37]）两新行。
        'branch-compare': { enabled: true },
        'branch-reset': { enabled: true },
        // V3 批次二：合并到当前分支（[28]）/ 变基到（[29]）两新行（v3-implementation-plan §4.6）。
        'branch-merge': { enabled: true },
        'branch-rebase': { enabled: true },
        'branch-create': { enabled: true },
        'tag-create': { enabled: true },
        'worktree': { enabled: true },
        // V2 批次四：创建 PR（[46]）。
        'pr-create': { enabled: true },
        'branch-delete': { enabled: true },
      })
  })

  it('菜单行已加载（V2 批次四 [8]）：无仓库态整菜单收敛为单行「初始化 Git 仓库…」（可点）', () => {
    const state: GitStatusSourceState = {
      repo: { available: false, root: null, checking: false },
      status: null,
      statusError: { code: 'git/no-repository', message: 'not a repo' },
      revision: 1,
      streaming: true,
    }
    const items = headerMenuItems(headerViewModel(state))
    expect(items.map((item) => item.id)).toEqual(['init-repo'])
    expect(items.every((item) => item.enabled)).toBe(true)
  })
})

// =====================================================================
// Phase 2·client 前置 — RPC 装配对账（GIT_NAMESPACE_METHODS 逐方法可用）。
// 锁定现状：当前 createGitRpcClient 是 mount.ts 的**手写逐方法包装**（每方法
// `await (await namespace()).<name>(…, signal)`），本节循环断言清单每键在产物上
// 存在、调用穿透命名空间、返回 RemoteResult（followStatus 直返流句柄——不是
// TypeError）；并断言 AbortSignal 以**同一实例**透传为命名空间调用的末位实参。
// =====================================================================

/** blame/cherry-pick/revert/getCommitDetail 夹具 oid（形状占位——替身不读内容）。 */
const OID = 'a'.repeat(40)

/** 命名空间替身的一次调用记录（method + 透传实参——passthrough 断言用）。 */
interface RecordedNamespaceCall {
  method: string
  args: unknown[]
}

/**
 * 命名空间替身（GIT_NAMESPACE_METHODS 全键同形，逐方法独立闭包）：记录每次调用并
 * 按方法名回哨兵——RemoteResult 的 ok 值 = 方法名自身（跨线错接的包装会回错名，
 * 逐方法 toEqual 即响）；followStatus 回哨兵流句柄（直返形状，非 RemoteResult）；
 * rejectNames 内的方法回 rejected Promise（载波失败折叠断言用）。
 */
function recordingNamespaceFace(
  calls: RecordedNamespaceCall[],
  rejectNames: ReadonlySet<string> = new Set(),
): Record<string, (...args: unknown[]) => unknown> {
  return Object.fromEntries(GIT_NAMESPACE_METHODS.map((name) => [
    name,
    (...args: unknown[]) => {
      calls.push({ method: name, args })
      if (rejectNames.has(name)) return Promise.reject(new Error(`fake carrier failure: ${name}`))
      if (name === 'followStatus') return { kind: 'stream-handle', method: name }
      return { ok: true, value: name }
    },
  ]))
}

/**
 * 产物逐方法的调用实参表（末位恒为同一 AbortSignal 实例——与手写包装签名
 * `(…, signal)` 同 arity；漏行/多行在编译面由 Record<字面量联合> 键穷举拒绝）。
 */
function callArgs(signal: AbortSignal): Record<(typeof GIT_NAMESPACE_METHODS)[number], unknown[]> {
  return {
    ping: [signal],
    identity: ['merged', signal],
    status: [signal],
    diff: ['worktree', null, signal],
    followStatus: [signal],
    stage: [['a.txt'], signal],
    unstage: [['a.txt'], signal],
    discard: [{ paths: ['a.txt'], acknowledged: true, baseRevision: null }, signal],
    commit: [{ message: 'feat: snap', amend: false, skipHooks: false }, signal],
    push: [{ setUpstream: true }, signal],
    pull: [signal],
    fetch: [{ remote: null }, signal],
    generateCommitMessage: [signal],
    log: [{ limit: 5, skip: 0 }, signal],
    refs: [signal],
    getCommitDetail: [{ oid: OID, path: null }, signal],
    blame: [{ path: 'a.txt' }, signal],
    compareBranches: [{ base: 'main', compare: 'side' }, signal],
    cherryPick: [{ oid: OID, acknowledged: true, baseRevision: null }, signal],
    revert: [{ oid: OID, acknowledged: true, baseRevision: null }, signal],
    reset: [{ kind: 'mixed', target: null, acknowledged: true, baseRevision: null }, signal],
    abortOperation: [signal],
    branchCreate: [{ name: 'feature' }, signal],
    branchSwitch: ['feature', signal],
    branchDelete: [{ name: 'feature' }, signal],
    tagCreate: [{ name: 'v1' }, signal],
    tagDelete: ['v1', signal],
    remoteList: [signal],
    worktreeList: [signal],
    worktreeAdd: [{ path: 'C:/repo/.wt', newBranch: 'wtb' }, signal],
    worktreeRemove: [{ path: 'C:/repo/.wt' }, signal],
    stagePatch: [{ path: 'a.txt', patch: '' }, signal],
    stashPush: [{ includeUntracked: true }, signal],
    stashList: [signal],
    stashPop: [{ index: 0 }, signal],
    stashDrop: [{ index: 0, acknowledged: true }, signal],
    scanStaged: [signal],
    repoDiagnostics: [signal],
    initRepository: [signal],
    submoduleStatus: [signal],
    auditLog: [{}, signal],
    generatePrDescription: [signal],
    createPr: [{ title: 't', body: 'b', acknowledged: true }, signal],
    prForBranch: ['main', signal],
    conflictList: [signal],
    conflictResolve: [{ choices: [{ path: 'a.txt', resolution: 'ours' }] }, signal],
    conflictMarkResolved: [{ paths: ['a.txt'] }, signal],
    operationContinue: [signal],
    branchMerge: [{ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: null }, signal],
    rebase: [{ upstream: 'main', acknowledged: true, baseRevision: null }, signal],
    agentToolsStatus: [signal],
    checkpointList: [null, signal],
    checkpointDiff: [{ seq: 1, index: 0 }, signal],
    checkpointRestore: [{ seq: 1, acknowledged: true, baseRevision: null }, signal],
    attributionGet: [signal],
    automationStatus: [signal],
  }
}

describe('Phase 2·client 前置 — RPC 装配对账（GIT_NAMESPACE_METHODS 逐方法可用，锁定手写包装现状）', () => {
  it('循环：清单每键在产物上存在、调用穿透命名空间、返回 RemoteResult 而非 TypeError（followStatus 直返流句柄）；AbortSignal 逐一以同一实例透传为末位实参', async () => {
    const calls: RecordedNamespaceCall[] = []
    const remote = { $mount: async () => async () => {}, git: recordingNamespaceFace(calls) } as unknown as TypertClientRemote
    const rpc = createGitRpcClient({ remote }, Promise.resolve())
    const signal = new AbortController().signal
    const argsTable = callArgs(signal)
    // 实参表先对账：覆盖清单全键、无多余行（与编译面 Record<字面量联合> 键穷举双保险）。
    expect(Object.keys(argsTable).sort()).toEqual([...GIT_NAMESPACE_METHODS].sort())
    const produced = rpc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    for (const name of GIT_NAMESPACE_METHODS) {
      expect(typeof produced[name], `${name} 必须是产物上的函数键`).toBe('function')
      const pending = produced[name]!(...argsTable[name])
      expect(pending, `${name}(...) 必须返回 Promise`).toBeInstanceOf(Promise)
      if (name === 'followStatus') {
        // followStatus 直返流句柄形状（非 Promise<RemoteResult>——协议红线）。
        await expect(pending).resolves.toEqual({ kind: 'stream-handle', method: 'followStatus' })
      } else {
        // ok 哨兵 = 方法名自身：跨线错接（包装调错命名空间方法）会回错名即红。
        await expect(pending, `${name}(...) 必须折叠返回 RemoteResult`).resolves.toEqual({ ok: true, value: name })
      }
      const received = calls.filter((call) => call.method === name)
      expect(received, `${name} 恰好穿透命名空间一次`).toHaveLength(1)
      const forwarded = received[0]!.args
      expect(forwarded.slice(0, -1), `${name} 前置实参逐位透传`).toEqual(argsTable[name].slice(0, -1))
      expect(forwarded.at(-1), `${name} 的 AbortSignal 以同一实例透传为末位实参`).toBe(signal)
    }
    // 全量穿透对账：每个方法各一次、无遗漏无重复（56 = GIT_NAMESPACE_METHODS.length）。
    expect(calls).toHaveLength(GIT_NAMESPACE_METHODS.length)
    expect(calls.map((call) => call.method).sort()).toEqual([...GIT_NAMESPACE_METHODS].sort())
  })

  it('AbortSignal 透传（代表性两方法，类型面直调）：status（signal-only 形）与 fetch（options+signal 形）的 signal 以同一实例抵达命名空间', async () => {
    const calls: RecordedNamespaceCall[] = []
    const remote = { $mount: async () => async () => {}, git: recordingNamespaceFace(calls) } as unknown as TypertClientRemote
    const rpc = createGitRpcClient({ remote }, Promise.resolve())
    const controller = new AbortController()
    // 类型面直调（rpc: GitRpcFace）——签名声明即行为：signal 缺席/换实例在此即红。
    await rpc.status(controller.signal)
    await rpc.fetch({ remote: null }, controller.signal)
    const statusCall = calls.find((call) => call.method === 'status')
    expect(statusCall).toBeDefined()
    expect(statusCall!.args).toHaveLength(1)
    expect(statusCall!.args[0]).toBe(controller.signal)
    const fetchCall = calls.find((call) => call.method === 'fetch')
    expect(fetchCall).toBeDefined()
    expect(fetchCall!.args[0]).toEqual({ remote: null })
    expect(fetchCall!.args[1]).toBe(controller.signal)
  })

  it('载波失败折叠（现状锁定）：命名空间方法 reject ⇒ 产物 resolve 为 {ok:false, error.code=gateway/service-unavailable}（不 reject、不 TypeError）', async () => {
    const calls: RecordedNamespaceCall[] = []
    const remote = { $mount: async () => async () => {}, git: recordingNamespaceFace(calls, new Set(['status'])) } as unknown as TypertClientRemote
    const rpc = createGitRpcClient({ remote }, Promise.resolve())
    const result = await rpc.status(new AbortController().signal)
    expect(result).toEqual({
      ok: false,
      error: { code: GATEWAY_UNAVAILABLE, message: expect.stringContaining('fake carrier failure: status') },
    })
    expect(calls.map((call) => call.method)).toEqual(['status'])
  })
})
