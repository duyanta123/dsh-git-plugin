/**
 * Phase 2·host 前置 — auditLog **全 op 快照锁定**（重构前置行为锁定套件）。
 *
 * 对 packages/host/src/index.ts 全部写方法（30 个 @Remote 写方法 + autoFetchOnce）
 * 逐一钉当前行为（先对现状生成期望值、全绿即锁定）：
 *   1. **summary 白名单串**（键序+值逐字）——auditOk 的参数摘要字段面（§6.10 白名单
 *      组装纪律）与 auditFail 的空摘要（意外内容零落环）；
 *   2. **ok/code**——成功 ok:true + code=null；失败 ok:false + 域错误码（§6.5 双出口）；
 *   3. **调用时序**——成功出口 logWrite(logger.info) → auditOk → afterWrite
 *      （statusEngine.invalidate → statusWatcher.notifyMutation）；失败出口
 *      logFailure(logger.warn) → auditFail → 原样抛出。观测面 = logger 替身
 *      （sync.spec 先例：构造后替换 this.logger）+ AuditEngine.record /
 *      StatusEngine.invalidate / StatusWatcher.notifyMutation 三个 spyOn 直通探针。
 *
 * 特例形态（[清单 46/58]）：
 *   - createPr：**无 afterWrite**——创建 PR 是外部可见写动作但不改本仓 status 世界
 *     （index.ts 成功出口只 logWrite + auditOk，零 invalidate/notify）；
 *   - autoFetchOnce：**吞错不抛**——后台任务失败面仅 warn，auditFail 入环后 promise
 *     照常 resolve（§7.4 永不向 UI 报错纪律的 fetch 版）；成功出口无 logWrite
 *     （logRead 走 debug 级——探针只记 info/warn，故时序以 audit→invalidate 为锚）。
 *
 * 断言纪律：形状断言 toEqual（4.4+/例）+ 负路径域码与 details 字段逐条断言；环记账
 * 断言（每次调用恰好新增一条——双出口各记一条，不多不少）。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import type { AuditEngine } from '../src/audit.ts'
import type { GitLoggerFace } from '../src/error-codes.ts'
import type { SubprocessFace } from '../src/git-runner.ts'
import type { GitChangesSummaryFace, GitWorkspaceChangesFace } from '../src/session-watch.ts'
import type { AuditEntry, CheckpointFileDiff } from '../src/types.ts'
import { git, localSubprocess, makeGitService, scratchDir, scratchRepo } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ---------- 装配（support.makeGitService 共用半；audit.spec 同款差异键） ----------

function makeService(
  workspaceOverride: string,
  overrides: { subprocess?: SubprocessFace } = {},
): InstanceType<typeof GitService> {
  return makeGitService(workspaceOverride, {
    commitTimeoutMs: 15_000,
    // 网络档（push/pull/fetch/autoFetch 走 network runner——缺省直构无 schema 面，
    // 不给键 = AbortSignal.timeout(undefined) TypeError；sync.spec 同款）。
    networkTimeoutMs: 20_000,
    autoFetchIntervalMs: 0,
    ...(overrides.subprocess !== undefined ? { subprocess: overrides.subprocess } : {}),
  }).service
}

/** 基础世界：born 仓库（a.txt 一笔 base 提交）+ 探针就位。 */
async function makeWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService>; probe: AuditProbe }> {
  const repo = await scratchRepo(`dshgit-asnap-${name}-`, cleanups)
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'base')
  const service = makeService(repo)
  return { repo, service, probe: installProbes(service) }
}

/** 远端世界：本地仓库 + origin 指向 bare（可选 fixture 预置 upstream）。 */
async function makeRemoteWorld(name: string, presetUpstream = false): Promise<{ repo: string; service: InstanceType<typeof GitService>; probe: AuditProbe; bare: string }> {
  const bare = join(await scratchDir(`dshgit-asnap-${name}-bare-`, cleanups), 'origin.git')
  await mkdir(bare, { recursive: true })
  git(bare, 'init', '--bare', '-q', '-b', 'main')
  const repo = await scratchRepo(`dshgit-asnap-${name}-repo-`, cleanups)
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'a.txt'), 'base\n', 'utf8')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', bare)
  if (presetUpstream) git(repo, 'push', '-q', '-u', 'origin', 'main')
  const service = makeService(repo)
  return { repo, service, probe: installProbes(service), bare }
}

/** 非仓库目录世界（initRepository 成功 / abortOperation no-repository 负路径用）。 */
async function makePlainDirWorld(name: string): Promise<{ dir: string; service: InstanceType<typeof GitService>; probe: AuditProbe }> {
  const dir = await scratchDir(`dshgit-asnap-${name}-plain-`, cleanups)
  const service = makeService(dir)
  return { dir, service, probe: installProbes(service) }
}

/** 夹具 git：追加一笔提交，返回新 HEAD。 */
async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', '--', rel)
  git(repo, 'commit', '-qm', message)
  return worldHead(repo)
}

function worldHead(repo: string): string {
  return git(repo, 'rev-parse', 'HEAD').trim()
}

// ---------- 时序探针（logger 替身 + 三处 spyOn 直通） ----------

interface AuditProbe {
  /** 事件流（info=写日志、warn=失败日志、audit=入环、invalidate/notify-mutation=afterWrite 两步）。 */
  events: string[]
  /** 打点（调用 op 前取，事后 slice）。 */
  mark(): number
}

function installProbes(service: InstanceType<typeof GitService>): AuditProbe {
  const events: string[] = []
  // logger 替身（sync.spec:761 先例——构造后替换，autoFetchOnce/写方法运行时读 this.logger）。
  // debug 级（logRead 与引擎 debug）不入流——探针只锁 info/warn 双出口与失效链。
  ;(service as unknown as { logger: GitLoggerFace }).logger = {
    debug() {},
    info(message: string) { events.push(`log-write ${message}`) },
    warn(message: string) { events.push(`log-fail ${message}`) },
    error() {},
  }
  const audit = (service as unknown as { audit: AuditEngine }).audit
  const realRecord = audit.record.bind(audit)
  vi.spyOn(audit, 'record').mockImplementation((op, ok, code, durationMs, summary) => {
    events.push(`audit ${op} ok=${ok} code=${code ?? 'null'}`)
    realRecord(op, ok, code, durationMs, summary)
  })
  const statusEngine = (service as unknown as { statusEngine: { invalidate(): void } }).statusEngine
  const realInvalidate = statusEngine.invalidate.bind(statusEngine)
  vi.spyOn(statusEngine, 'invalidate').mockImplementation(() => {
    events.push('invalidate')
    realInvalidate()
  })
  const watcher = service.watcherOf()
  const realNotify = watcher.notifyMutation.bind(watcher)
  vi.spyOn(watcher, 'notifyMutation').mockImplementation(() => {
    events.push('notify-mutation')
    realNotify()
  })
  return { events, mark: (): number => events.length }
}

// ---------- 环记账与形状断言 ----------

async function auditCount(service: InstanceType<typeof GitService>): Promise<number> {
  return (await service.auditLog({})).entries.length
}

/** 断言打点之后恰好新增一条审计记录并返回它（newest-first 环首——双出口各记一条）。 */
async function addedEntry(service: InstanceType<typeof GitService>, before: number): Promise<AuditEntry> {
  const page = await service.auditLog({})
  const added = page.entries.slice(0, Math.max(0, page.entries.length - before))
  expect(added, '本次调用恰好入环一条审计记录').toHaveLength(1)
  return added[0] as AuditEntry
}

function expectOkEntry(entry: AuditEntry, op: string, summary: string): void {
  expect({ op: entry.op, ok: entry.ok, code: entry.code, summary: entry.summary })
    .toEqual({ op, ok: true, code: null, summary })
  expect(Number.isFinite(entry.durationMs)).toBe(true)
  expect(entry.durationMs).toBeGreaterThanOrEqual(0)
  expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
}

function expectFailEntry(entry: AuditEntry, op: string, code: string): void {
  expect({ op: entry.op, ok: entry.ok, code: entry.code, summary: entry.summary })
    .toEqual({ op, ok: false, code, summary: '' })
  expect(Number.isFinite(entry.durationMs)).toBe(true)
  expect(entry.durationMs).toBeGreaterThanOrEqual(0)
  expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
}

/** 成功出口时序：logWrite → auditOk → （afterWrite 语义时）invalidate → notify-mutation。 */
function expectSuccessOrder(probe: AuditProbe, mark: number, op: string, afterWrite: boolean): void {
  const tail = probe.events.slice(mark)
  if (afterWrite) {
    expect(tail).toEqual([
      expect.stringContaining(`log-write git ${op} `),
      `audit ${op} ok=true code=null`,
      'invalidate',
      'notify-mutation',
    ])
  } else {
    expect(tail).toEqual([
      expect.stringContaining(`log-write git ${op} `),
      `audit ${op} ok=true code=null`,
    ])
  }
}

/** 失败出口时序：logFailure(warn 带 code) → auditFail（入环后原样抛出）。 */
function expectFailOrder(probe: AuditProbe, mark: number, op: string, code: string): void {
  expect(probe.events.slice(mark)).toEqual([
    expect.stringContaining(`log-fail git ${op} failed code=${code}`),
    `audit ${op} ok=false code=${code}`,
  ])
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, details: remote!.details as Record<string, unknown> }
}

// ---------- 冲突夹具（conflicts.spec 手塑 unmerged 同款） ----------

function hashObject(repo: string, content: string): string {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, encoding: 'utf8', input: content }).trim()
}

/** 在真仓 index 上手塑一条 UU unmerged 路径（worktree 摆 stage2 内容）。 */
async function craftUnmerged(repo: string, path: string): Promise<void> {
  const lines = [
    `100644 ${hashObject(repo, 'base')} 1\t${path}`,
    `100644 ${hashObject(repo, 'ours')} 2\t${path}`,
    `100644 ${hashObject(repo, 'theirs')} 3\t${path}`,
  ]
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repo, encoding: 'utf8', input: `${lines.join('\n')}\n`,
  })
  await writeFile(join(repo, path), 'ours', 'utf8')
}

/**
 * 真冲突世界（service cherry-pick 制造 UU + CHERRY_PICK_HEAD 中间态）：
 * operationContinue 成功出口的夹具（conflicts.spec 双提交链的单提交版）。
 */
async function makeCherryConflictWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService>; probe: AuditProbe }> {
  const repo = await scratchRepo(`dshgit-asnap-${name}-`, cleanups)
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  await commitFile(repo, 'f.txt', 'base line\n', 'base')
  git(repo, 'checkout', '-qb', 'side')
  const sideOid = await commitFile(repo, 'f.txt', 'side line\n', 'side edit')
  git(repo, 'checkout', '-q', 'main')
  const mainOid = await commitFile(repo, 'f.txt', 'main line\n', 'main edit')
  const service = makeService(repo)
  const probe = installProbes(service)
  const conflict = await rejectionOf(() => service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: mainOid }))
  expect(conflict.code).toBe('git/merge-conflict')
  return { repo, service, probe }
}

// ---------- checkpointRestore 夹具（checkpoints.spec fakeFace 单文件版） ----------

const SNAP_SEQ = 5
const SNAP_TURN = 3

function singleFileChangesFace(repo: string, diff: CheckpointFileDiff): GitWorkspaceChangesFace {
  return {
    summary(_sessionId, target) {
      if (target !== SNAP_SEQ) return undefined
      const summary: GitChangesSummaryFace = {
        turn: SNAP_TURN,
        cwd: repo,
        files: [{ path: diff.path, display: diff.path, added: 1, deleted: 1 }],
        total: 1,
        added: 1,
        deleted: 0,
      }
      return summary
    },
    async diff(_sessionId, target, index) {
      return target === SNAP_SEQ && index === 0 ? diff : undefined
    },
  }
}

// ---------- createPr 夹具（pr.spec 假 gh 的 SubprocessFace 分派版） ----------

interface GhScript {
  /** `gh auth status` 退出码（缺省 0）。 */
  auth?: number
  /** `gh pr create` 应答（缺省成功 + 示例 URL）。 */
  create?: { exitCode: number; stdout?: string; stderr?: string }
}

/**
 * gh/git 双分派 SubprocessFace：argv[0] = 解析出的 gh 路径 → 脚本化应答；
 * 其余（git 四实例）直通真 spawn 替身。gh 调用按序记录（argv + stdin）。
 */
function ghDispatchSubprocess(script: GhScript): SubprocessFace & { calls: Array<{ argv: readonly string[]; stdin: string | undefined }> } {
  const calls: Array<{ argv: readonly string[]; stdin: string | undefined }> = []
  const real = localSubprocess()
  const GH = 'C:/fake/gh'
  const face: SubprocessFace = {
    async resolveExecutable(command) {
      if (command === 'gh') return GH
      return real.resolveExecutable(command)
    },
    spawn(spec) {
      if (spec.argv[0] !== GH) return real.spawn(spec)
      const stdin = spec.stdio.stdin === 'ignore' ? undefined : spec.stdio.stdin.data
      calls.push({ argv: spec.argv, stdin })
      const sub = spec.argv[1] ?? ''
      let exitCode = 0
      let stdout = ''
      let stderr = ''
      if (sub === 'auth') {
        exitCode = script.auth ?? 0
      } else if (spec.argv[1] === 'pr' && spec.argv[2] === 'create') {
        const create = script.create ?? { exitCode: 0, stdout: 'https://github.com/acme/repo/pull/42\n' }
        exitCode = create.exitCode
        stdout = create.stdout ?? ''
        stderr = create.stderr ?? ''
      }
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: (offset: number) => ({ text: stdout.slice(offset), lossy: false }) },
          stderr: { readFrom: (offset: number) => ({ text: stderr.slice(offset), lossy: false }) },
        },
      }
    },
  }
  return { ...face, calls }
}

// =====================================================================
// 成功出口 — 全 op 快照（30 个 @Remote 写方法逐一）
// =====================================================================

describe('全 RPC 写方法成功出口 — auditOk 快照（summary/ok/code + logWrite→audit→afterWrite 时序）', () => {
  it('stage：summary=pathCount=1；时序 logWrite→audit→invalidate→notify-mutation', async () => {
    const { repo, service, probe } = await makeWorld('stage-ok')
    await writeFile(join(repo, 'b.txt'), 'content\n', 'utf8')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.stage(['b.txt'])
    expect(result.staged).toBe(1)
    expectOkEntry(await addedEntry(service, before), 'stage', 'pathCount=1')
    expectSuccessOrder(probe, mark, 'stage', true)
  })

  it('unstage：summary=pathCount=1（同形字段名 unstaged 源）', async () => {
    const { repo, service, probe } = await makeWorld('unstage-ok')
    await writeFile(join(repo, 'b.txt'), 'content\n', 'utf8')
    await service.stage(['b.txt'])
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.unstage(['b.txt'])
    expect(result.unstaged).toBe(1)
    expectOkEntry(await addedEntry(service, before), 'unstage', 'pathCount=1')
    expectSuccessOrder(probe, mark, 'unstage', true)
  })

  it('discard：summary=pathCount=1（restore 路由）', async () => {
    const { repo, service, probe } = await makeWorld('discard-ok')
    await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.discard({ paths: ['a.txt'], acknowledged: true, baseRevision: worldHead(repo) })
    expect(result.discarded).toBe(1)
    expectOkEntry(await addedEntry(service, before), 'discard', 'pathCount=1')
    expectSuccessOrder(probe, mark, 'discard', true)
  })

  it('commit：summary=amend/skipHooks/trailerCount 旗标三元（message 正文零落环）', async () => {
    const { repo, service, probe } = await makeWorld('commit-ok')
    await writeFile(join(repo, 'b.txt'), 'content\n', 'utf8')
    await service.stage(['b.txt'])
    const before = await auditCount(service)
    const mark = probe.mark()
    await service.commit({ message: 'feat: snapshot', amend: false, skipHooks: false })
    expectOkEntry(await addedEntry(service, before), 'commit', 'amend=false skipHooks=false trailerCount=0')
    expectSuccessOrder(probe, mark, 'commit', true)
  })

  it('push：summary=remote/branch/setUpstream/force 四元（首次推送 set-upstream 路径）', async () => {
    const { service, probe } = await makeRemoteWorld('push-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.push({ setUpstream: true })
    expect(result.setUpstreamUsed).toBe(true)
    expect(result.remote).toBe('origin')
    expect(result.branch).toBe('main')
    expectOkEntry(await addedEntry(service, before), 'push', 'remote=origin branch=main setUpstream=true force=false')
    expectSuccessOrder(probe, mark, 'push', true)
  })

  it('pull：summary=remote 单字段', async () => {
    const { service, probe } = await makeRemoteWorld('pull-ok', true)
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.pull()
    expect(result.remote).toBe('origin')
    expectOkEntry(await addedEntry(service, before), 'pull', 'remote=origin')
    expectSuccessOrder(probe, mark, 'pull', true)
  })

  it('fetch：summary=remote/pruned 二元', async () => {
    const { service, probe } = await makeRemoteWorld('fetch-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.fetch({ remote: null })
    expect(result.pruned).toBe(false)
    expectOkEntry(await addedEntry(service, before), 'fetch', 'remote=origin pruned=false')
    expectSuccessOrder(probe, mark, 'fetch', true)
  })

  it('branchCreate：summary=name/checkedOut 二元', async () => {
    const { service, probe } = await makeWorld('branchcreate-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.branchCreate({ name: 'feature' })
    expect(result.checkedOut).toBe(false)
    expectOkEntry(await addedEntry(service, before), 'branchCreate', 'name=feature checkedOut=false')
    expectSuccessOrder(probe, mark, 'branchCreate', true)
  })

  it('branchSwitch：summary=from/to 二元', async () => {
    const { repo, service, probe } = await makeWorld('branchswitch-ok')
    git(repo, 'branch', 'feature')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.branchSwitch('feature')
    expect(result.to).toBe('feature')
    expectOkEntry(await addedEntry(service, before), 'branchSwitch', 'from=main to=feature')
    expectSuccessOrder(probe, mark, 'branchSwitch', true)
  })

  it('branchDelete：summary=name/force/wasMerged 三元（已合并 -d）', async () => {
    const { repo, service, probe } = await makeWorld('branchdelete-ok')
    git(repo, 'branch', 'topic')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.branchDelete({ name: 'topic' })
    expect(result.wasMerged).toBe(true)
    expectOkEntry(await addedEntry(service, before), 'branchDelete', 'name=topic force=false wasMerged=true')
    expectSuccessOrder(probe, mark, 'branchDelete', true)
  })

  it('tagCreate：summary=name/annotated/force 三元（lightweight）', async () => {
    const { service, probe } = await makeWorld('tagcreate-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.tagCreate({ name: 'v1' })
    expect(result.annotated).toBe(false)
    expectOkEntry(await addedEntry(service, before), 'tagCreate', 'name=v1 annotated=false force=false')
    expectSuccessOrder(probe, mark, 'tagCreate', true)
  })

  it('tagDelete：summary=name 单字段', async () => {
    const { repo, service, probe } = await makeWorld('tagdelete-ok')
    git(repo, 'tag', 'v1')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.tagDelete('v1')
    expect(result.deleted).toBe('v1')
    expectOkEntry(await addedEntry(service, before), 'tagDelete', 'name=v1')
    expectSuccessOrder(probe, mark, 'tagDelete', true)
  })

  it('worktreeAdd：summary=path/branch 二元（newBranch 路径）', async () => {
    const { service, probe } = await makeWorld('wtadd-ok')
    const wtPath = join(await scratchDir('dshgit-asnap-wtadd-', cleanups), 'wt')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.worktreeAdd({ path: wtPath, newBranch: 'wtb' })
    expect(result.branch).toBe('wtb')
    expectOkEntry(await addedEntry(service, before), 'worktreeAdd', `path=${result.path} branch=wtb`)
    expectSuccessOrder(probe, mark, 'worktreeAdd', true)
  })

  it('worktreeRemove：summary=path/force 二元（净 worktree 免 force）', async () => {
    const { service, probe } = await makeWorld('wtrm-ok')
    const wtPath = join(await scratchDir('dshgit-asnap-wtrm-', cleanups), 'wt')
    await service.worktreeAdd({ path: wtPath, newBranch: 'wtb' })
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.worktreeRemove({ path: wtPath })
    expect(result.removed).toBe(wtPath)
    expectOkEntry(await addedEntry(service, before), 'worktreeRemove', `path=${result.removed} force=false`)
    expectSuccessOrder(probe, mark, 'worktreeRemove', true)
  })

  it('cherryPick：summary=oid/newOid（12 位短 oid）', async () => {
    const { repo, service, probe } = await makeWorld('cp-ok')
    await writeFile(join(repo, 'f.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', 'side')
    const sideOid = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.cherryPick({ oid: sideOid, acknowledged: true, baseRevision: mainOid })
    expect(result.newOid).not.toBeNull()
    expectOkEntry(await addedEntry(service, before), 'cherryPick', `oid=${sideOid.slice(0, 12)} newOid=${result.newOid!.slice(0, 12)}`)
    expectSuccessOrder(probe, mark, 'cherryPick', true)
  })

  it('revert：summary=oid/newOid（12 位短 oid）', async () => {
    const { repo, service, probe } = await makeWorld('rv-ok')
    await writeFile(join(repo, 'f.txt'), 'base\n', 'utf8')
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', 'side')
    await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'cherry-pick', 'side')
    const pickOid = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.revert({ oid: pickOid, acknowledged: true, baseRevision: pickOid })
    expect(result.newOid).not.toBeNull()
    expectOkEntry(await addedEntry(service, before), 'revert', `oid=${pickOid.slice(0, 12)} newOid=${result.newOid!.slice(0, 12)}`)
    expectSuccessOrder(probe, mark, 'revert', true)
  })

  it('reset：summary=kind/target（null 目标落 (HEAD) 字面）', async () => {
    const { repo, service, probe } = await makeWorld('reset-ok')
    await writeFile(join(repo, 'a.txt'), 'changed\n', 'utf8')
    await service.stage(['a.txt'])
    const before = await auditCount(service)
    const mark = probe.mark()
    await service.reset({ kind: 'mixed', target: null, acknowledged: true, baseRevision: worldHead(repo) })
    expectOkEntry(await addedEntry(service, before), 'reset', 'kind=mixed target=(HEAD)')
    expectSuccessOrder(probe, mark, 'reset', true)
  })

  it('abortOperation：summary=aborted（无中间态 → (none) 字面，幂等空成功）', async () => {
    const { service, probe } = await makeWorld('abort-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.abortOperation()
    expect(result.aborted).toBeNull()
    expectOkEntry(await addedEntry(service, before), 'abortOperation', 'aborted=(none)')
    expectSuccessOrder(probe, mark, 'abortOperation', true)
  })

  it('conflictResolve：summary=resolvedCount（手塑 UU 的 ours 向）', async () => {
    const { repo, service, probe } = await makeWorld('cresolve-ok')
    await craftUnmerged(repo, 'f.txt')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.conflictResolve({ choices: [{ path: 'f.txt', resolution: 'ours' }] })
    expect(result.resolved).toEqual(['f.txt'])
    expectOkEntry(await addedEntry(service, before), 'conflictResolve', 'resolvedCount=1')
    expectSuccessOrder(probe, mark, 'conflictResolve', true)
  })

  it('conflictMarkResolved：summary=resolvedCount（手动编辑 add 路）', async () => {
    const { repo, service, probe } = await makeWorld('cmark-ok')
    await craftUnmerged(repo, 'g.txt')
    await writeFile(join(repo, 'g.txt'), 'manually merged\n', 'utf8')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.conflictMarkResolved({ paths: ['g.txt'] })
    expect(result.resolved).toEqual(['g.txt'])
    expectOkEntry(await addedEntry(service, before), 'conflictMarkResolved', 'resolvedCount=1')
    expectSuccessOrder(probe, mark, 'conflictMarkResolved', true)
  })

  it('operationContinue：summary=op/done/conflicted 三元（cherry-pick 单提交链收尾）', async () => {
    const { repo, service, probe } = await makeCherryConflictWorld('cont-ok')
    // theirs 向解决（ours 向会使 pick 相对 main 变空提交——continue 以
    // "previous cherry-pick is now empty" exit 1；theirs 保留 side 改动，可收尾）。
    await service.conflictResolve({ choices: [{ path: 'f.txt', resolution: 'theirs' }] })
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.operationContinue()
    expect(result.done).toBe(true)
    expect(result.conflicted).toEqual([])
    expectOkEntry(await addedEntry(service, before), 'operationContinue', 'op=cherry-pick done=true conflicted=0')
    expectSuccessOrder(probe, mark, 'operationContinue', true)
    // world 重读：continue 落了 pick 提交（side edit 内容进 HEAD）。
    expect(worldHead(repo)).not.toBe('')
  })

  it('branchMerge：summary=branch/fastForward/merged/newOid 四元（auto 可 ff → merged=true）', async () => {
    const { repo, service, probe } = await makeWorld('merge-ok')
    git(repo, 'checkout', '-qb', 'side')
    const sideTip = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    const mainOid = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: true, baseRevision: mainOid })
    expect(result.fastForward).toBe(true)
    expect(result.newOid).toBe(sideTip)
    expectOkEntry(await addedEntry(service, before), 'branchMerge', `branch=side fastForward=auto merged=true newOid=${result.newOid!.slice(0, 12)}`)
    expectSuccessOrder(probe, mark, 'branchMerge', true)
  })

  it('rebase：summary=upstream/onto/newOid 三元（onto 缺省落 (none) 字面）', async () => {
    const { repo, service, probe } = await makeWorld('rebase-ok')
    git(repo, 'checkout', '-qb', 'side')
    const sideTip = await commitFile(repo, 'side.txt', 'side\n', 'side edit')
    git(repo, 'checkout', '-q', 'main')
    await commitFile(repo, 'main.txt', 'main\n', 'main edit')
    git(repo, 'checkout', '-q', 'side')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.rebase({ upstream: 'main', acknowledged: true, baseRevision: sideTip })
    expect(result.done).toBe(true)
    expect(result.newOid).not.toBeNull()
    expectOkEntry(await addedEntry(service, before), 'rebase', `upstream=main onto=(none) newOid=${result.newOid!.slice(0, 12)}`)
    expectSuccessOrder(probe, mark, 'rebase', true)
  })

  it('checkpointRestore：summary=seq/applied/failed 三元（单文件反向应用全成功）', async () => {
    const { repo } = await makeWorld('ckpt-ok')
    const headOid = worldHead(repo)
    await writeFile(join(repo, 'a.txt'), 'a1\nX2\na3\n', 'utf8')
    const diff: CheckpointFileDiff = {
      kind: 'text', path: 'a.txt', display: 'a.txt', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a1', '-a2', '+X2', ' a3'] }],
    }
    const face = singleFileChangesFace(repo, diff)
    const assembled = makeGitService(repo, {
      commitTimeoutMs: 15_000, autoFetchIntervalMs: 0,
      provides: [['workspaceChanges', face] as const],
    })
    const ckptService = assembled.service
    ckptService.sessionWatchOf().observe(
      { id: 'sess-snap', header: {} },
      { type: 'workspace/changes', seq: SNAP_SEQ, time: 2_000_000_000_000, data: { turn: SNAP_TURN } },
    )
    const ckptProbe = installProbes(ckptService)
    const before = await auditCount(ckptService)
    const mark = ckptProbe.mark()
    const result = await ckptService.checkpointRestore({ seq: SNAP_SEQ, paths: null, acknowledged: true, baseRevision: headOid })
    expect(result.applied).toEqual(['a.txt'])
    expect(result.failed).toEqual([])
    expectOkEntry(await addedEntry(ckptService, before), 'checkpointRestore', 'seq=5 applied=1 failed=0')
    expectSuccessOrder(ckptProbe, mark, 'checkpointRestore', true)
  })

  it('stagePatch：summary=path/direction/staged 三元（缺省方向落 stage 字面）', async () => {
    const { repo, service, probe } = await makeWorld('stagepatch-ok')
    const lines = Array.from({ length: 17 }, (_, i) => `l${String(i + 1)}`)
    await commitFile(repo, 'big.txt', `${lines.join('\n')}\n`, 'seed big')
    const mutated = [...lines]
    mutated[1] = 'HUNK1'
    mutated[16] = 'HUNK2'
    await writeFile(join(repo, 'big.txt'), `${mutated.join('\n')}\n`, 'utf8')
    const hunk1 = [
      'diff --git a/big.txt b/big.txt',
      '--- a/big.txt',
      '+++ b/big.txt',
      '@@ -1,5 +1,5 @@',
      ' l1',
      '-l2',
      '+HUNK1',
      ' l3',
      ' l4',
      ' l5',
      '',
    ].join('\n')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.stagePatch({ path: 'big.txt', patch: hunk1 })
    expect(result.staged).toBe(1)
    expectOkEntry(await addedEntry(service, before), 'stagePatch', 'path=big.txt direction=stage staged=1')
    expectSuccessOrder(probe, mark, 'stagePatch', true)
  })

  it('stashPush：summary=includeUntracked/hasMessage 二元（无消息形态）', async () => {
    const { repo, service, probe } = await makeWorld('stashpush-ok')
    await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.stashPush({ includeUntracked: true })
    expect(result.index).toBe(0)
    expectOkEntry(await addedEntry(service, before), 'stashPush', 'includeUntracked=true hasMessage=false')
    expectSuccessOrder(probe, mark, 'stashPush', true)
  })

  it('stashPop：summary=index 单字段', async () => {
    const { repo, service, probe } = await makeWorld('stashpop-ok')
    await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
    await service.stashPush({ includeUntracked: true })
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.stashPop({ index: 0 })
    expect(result.index).toBe(0)
    expectOkEntry(await addedEntry(service, before), 'stashPop', 'index=0')
    expectSuccessOrder(probe, mark, 'stashPop', true)
  })

  it('stashDrop：summary=index 单字段（acknowledged danger 闸过闸）', async () => {
    const { repo, service, probe } = await makeWorld('stashdrop-ok')
    await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
    await service.stashPush({ includeUntracked: true })
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.stashDrop({ index: 0, acknowledged: true })
    expect(result.index).toBe(0)
    expectOkEntry(await addedEntry(service, before), 'stashDrop', 'index=0')
    expectSuccessOrder(probe, mark, 'stashDrop', true)
  })

  it('initRepository：summary=repoRoot/branch 二元（非仓库目录就地 init）', async () => {
    const { service, probe } = await makePlainDirWorld('init-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.initRepository()
    expect(result.branch).not.toBe('')
    expectOkEntry(await addedEntry(service, before), 'initRepository', `repoRoot=${result.repoRoot} branch=${result.branch}`)
    expectSuccessOrder(probe, mark, 'initRepository', true)
  })

  it('createPr：summary=base/head/draft/titleChars 四元；【特例】无 afterWrite（零 invalidate/notify）', async () => {
    const { repo } = await makeWorld('pr-ok')
    const gh = ghDispatchSubprocess({})
    const prService = makeService(repo, { subprocess: gh })
    const prProbe = installProbes(prService)
    const before = await auditCount(prService)
    const mark = prProbe.mark()
    const result = await prService.createPr({ title: 'feat: demo', body: 'body text', acknowledged: true })
    expect(result.url).toBe('https://github.com/acme/repo/pull/42')
    expect(result.number).toBe(42)
    expectOkEntry(await addedEntry(prService, before), 'createPr', 'base=(default) head=(current) draft=false titleChars=10')
    // 特例形态锁定：createPr 成功出口只有 logWrite + auditOk——零 afterWrite 两步。
    expectSuccessOrder(prProbe, mark, 'createPr', false)
  })
})

// =====================================================================
// 失败出口 — 全 op 快照（auditFail：ok=false + 域码 + 空 summary + logFailure→audit 时序）
// =====================================================================

describe('全 RPC 写方法失败出口 — auditFail 快照（域码/details + 空 summary + logFailure→audit 时序）', () => {
  it('stage：空数组 ⇒ git/no-paths（details.op）', async () => {
    const { service, probe } = await makeWorld('stage-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.stage([]))
    expect(code).toBe('git/no-paths')
    expect(details.op).toBe('stage')
    expectFailEntry(await addedEntry(service, before), 'stage', 'git/no-paths')
    expectFailOrder(probe, mark, 'stage', 'git/no-paths')
  })

  it('unstage：空数组 ⇒ git/no-paths', async () => {
    const { service, probe } = await makeWorld('unstage-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code } = await rejectionOf(() => service.unstage([]))
    expect(code).toBe('git/no-paths')
    expectFailEntry(await addedEntry(service, before), 'unstage', 'git/no-paths')
    expectFailOrder(probe, mark, 'unstage', 'git/no-paths')
  })

  it('discard：无 acknowledged ⇒ git/bad-request unacknowledged（零命令）', async () => {
    const { service, probe } = await makeWorld('discard-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.discard({ paths: ['a.txt'], acknowledged: false, baseRevision: null }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('unacknowledged')
    expectFailEntry(await addedEntry(service, before), 'discard', 'git/bad-request')
    expectFailOrder(probe, mark, 'discard', 'git/bad-request')
  })

  it('commit：干净仓库 ⇒ git/nothing-staged（details.branch）', async () => {
    const { service, probe } = await makeWorld('commit-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.commit({ message: 'x', amend: false, skipHooks: false }))
    expect(code).toBe('git/nothing-staged')
    expect(details.branch).toBe('main')
    expectFailEntry(await addedEntry(service, before), 'commit', 'git/nothing-staged')
    expectFailOrder(probe, mark, 'commit', 'git/nothing-staged')
  })

  it('push：无 upstream + setUpstream=false ⇒ git/no-upstream（details.branch/hint）', async () => {
    const { service, probe } = await makeWorld('push-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.push({ setUpstream: false }))
    expect(code).toBe('git/no-upstream')
    expect(details.branch).toBe('main')
    expect(details.hint).toBe('set-upstream')
    expectFailEntry(await addedEntry(service, before), 'push', 'git/no-upstream')
    expectFailOrder(probe, mark, 'push', 'git/no-upstream')
  })

  it('pull：无 upstream ⇒ git/no-upstream（details.branch/hint）', async () => {
    const { service, probe } = await makeWorld('pull-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.pull())
    expect(code).toBe('git/no-upstream')
    expect(details.branch).toBe('main')
    expect(details.hint).toBe('set-upstream')
    expectFailEntry(await addedEntry(service, before), 'pull', 'git/no-upstream')
    expectFailOrder(probe, mark, 'pull', 'git/no-upstream')
  })

  it('fetch：零 remote ⇒ git/no-remote（details.remotes=[]）', async () => {
    const { service, probe } = await makeWorld('fetch-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.fetch({ remote: null }))
    expect(code).toBe('git/no-remote')
    expect(details.remotes).toEqual([])
    expectFailEntry(await addedEntry(service, before), 'fetch', 'git/no-remote')
    expectFailOrder(probe, mark, 'fetch', 'git/no-remote')
  })

  it('branchCreate：空名 ⇒ git/bad-request invalid-options（零命令）', async () => {
    const { service, probe } = await makeWorld('bc-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.branchCreate({ name: '  ' }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('invalid-options')
    expectFailEntry(await addedEntry(service, before), 'branchCreate', 'git/bad-request')
    expectFailOrder(probe, mark, 'branchCreate', 'git/bad-request')
  })

  it('branchSwitch：不存在 ⇒ git/branch-not-found（details.name）', async () => {
    const { service, probe } = await makeWorld('bs-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.branchSwitch('ghost'))
    expect(code).toBe('git/branch-not-found')
    expect(details.name).toBe('ghost')
    expectFailEntry(await addedEntry(service, before), 'branchSwitch', 'git/branch-not-found')
    expectFailOrder(probe, mark, 'branchSwitch', 'git/branch-not-found')
  })

  it('branchDelete：不存在 ⇒ git/branch-not-found（details.name）', async () => {
    const { service, probe } = await makeWorld('bd-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.branchDelete({ name: 'ghost' }))
    expect(code).toBe('git/branch-not-found')
    expect(details.name).toBe('ghost')
    expectFailEntry(await addedEntry(service, before), 'branchDelete', 'git/branch-not-found')
    expectFailOrder(probe, mark, 'branchDelete', 'git/branch-not-found')
  })

  it('tagCreate：重名 ⇒ git/tag-exists（details.name）', async () => {
    const { repo, service, probe } = await makeWorld('tc-fail')
    git(repo, 'tag', 'v1')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.tagCreate({ name: 'v1' }))
    expect(code).toBe('git/tag-exists')
    expect(details.name).toBe('v1')
    expectFailEntry(await addedEntry(service, before), 'tagCreate', 'git/tag-exists')
    expectFailOrder(probe, mark, 'tagCreate', 'git/tag-exists')
  })

  it('tagDelete：不存在 ⇒ git/tag-not-found（details.name）', async () => {
    const { service, probe } = await makeWorld('td-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.tagDelete('ghost'))
    expect(code).toBe('git/tag-not-found')
    expect(details.name).toBe('ghost')
    expectFailEntry(await addedEntry(service, before), 'tagDelete', 'git/tag-not-found')
    expectFailOrder(probe, mark, 'tagDelete', 'git/tag-not-found')
  })

  it('worktreeAdd：branch/newBranch 双缺 ⇒ git/bad-request invalid-options（零命令）', async () => {
    const { service, probe } = await makeWorld('wta-fail')
    const wtPath = join(await scratchDir('dshgit-asnap-wta-fail-', cleanups), 'wt')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.worktreeAdd({ path: wtPath }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('invalid-options')
    expectFailEntry(await addedEntry(service, before), 'worktreeAdd', 'git/bad-request')
    expectFailOrder(probe, mark, 'worktreeAdd', 'git/bad-request')
  })

  it('worktreeRemove：路径不存在 ⇒ git/worktree-failed（details.path）', async () => {
    const { repo, service, probe } = await makeWorld('wtr-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.worktreeRemove({ path: join(repo, 'ghost-wt') }))
    expect(code).toBe('git/worktree-failed')
    expect(details.path).toBe(join(repo, 'ghost-wt'))
    expectFailEntry(await addedEntry(service, before), 'worktreeRemove', 'git/worktree-failed')
    expectFailOrder(probe, mark, 'worktreeRemove', 'git/worktree-failed')
  })

  it('cherryPick：未知修订 ⇒ git/unknown-revision（details.op/revision）', async () => {
    const { repo, service, probe } = await makeWorld('cp-fail')
    const head = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.cherryPick({ oid: 'no-such-rev', acknowledged: true, baseRevision: head }))
    expect(code).toBe('git/unknown-revision')
    expect(details.op).toBe('cherryPick')
    expect(details.revision).toBe('no-such-rev')
    expectFailEntry(await addedEntry(service, before), 'cherryPick', 'git/unknown-revision')
    expectFailOrder(probe, mark, 'cherryPick', 'git/unknown-revision')
  })

  it('revert：未知修订 ⇒ git/unknown-revision（details.op）', async () => {
    const { repo, service, probe } = await makeWorld('rv-fail')
    const head = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.revert({ oid: 'no-such-rev', acknowledged: true, baseRevision: head }))
    expect(code).toBe('git/unknown-revision')
    expect(details.op).toBe('revert')
    expectFailEntry(await addedEntry(service, before), 'revert', 'git/unknown-revision')
    expectFailOrder(probe, mark, 'revert', 'git/unknown-revision')
  })

  it('reset：未知 target ⇒ git/unknown-revision（details.op）', async () => {
    const { repo, service, probe } = await makeWorld('reset-fail')
    const head = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.reset({ kind: 'hard', target: 'no-such-target', acknowledged: true, baseRevision: head }))
    expect(code).toBe('git/unknown-revision')
    expect(details.op).toBe('reset')
    expectFailEntry(await addedEntry(service, before), 'reset', 'git/unknown-revision')
    expectFailOrder(probe, mark, 'reset', 'git/unknown-revision')
  })

  it('abortOperation：非仓库工作区 ⇒ git/no-repository（details.probed=工作区）', async () => {
    const { dir, service, probe } = await makePlainDirWorld('abort-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.abortOperation())
    expect(code).toBe('git/no-repository')
    expect(details.probed).toBe(dir)
    expectFailEntry(await addedEntry(service, before), 'abortOperation', 'git/no-repository')
    expectFailOrder(probe, mark, 'abortOperation', 'git/no-repository')
  })

  it('conflictResolve：path 非 unmerged ⇒ git/bad-request path-not-conflicted（零命令）', async () => {
    const { service, probe } = await makeWorld('cresolve-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.conflictResolve({ choices: [{ path: 'clean.txt', resolution: 'ours' }] }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('path-not-conflicted')
    expectFailEntry(await addedEntry(service, before), 'conflictResolve', 'git/bad-request')
    expectFailOrder(probe, mark, 'conflictResolve', 'git/bad-request')
  })

  it('conflictMarkResolved：path 非 unmerged ⇒ git/bad-request path-not-conflicted（零命令）', async () => {
    const { service, probe } = await makeWorld('cmark-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.conflictMarkResolved({ paths: ['clean.txt'] }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('path-not-conflicted')
    expectFailEntry(await addedEntry(service, before), 'conflictMarkResolved', 'git/bad-request')
    expectFailOrder(probe, mark, 'conflictMarkResolved', 'git/bad-request')
  })

  it('operationContinue：无中间态无冲突 ⇒ git/bad-request invalid-options（零命令）', async () => {
    const { service, probe } = await makeWorld('cont-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.operationContinue())
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('invalid-options')
    expectFailEntry(await addedEntry(service, before), 'operationContinue', 'git/bad-request')
    expectFailOrder(probe, mark, 'operationContinue', 'git/bad-request')
  })

  it('branchMerge：无 acknowledged ⇒ git/bad-request unacknowledged（零命令）', async () => {
    const { repo, service, probe } = await makeWorld('merge-fail')
    const head = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.branchMerge({ branch: 'side', fastForward: 'auto', acknowledged: false, baseRevision: head }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('unacknowledged')
    expectFailEntry(await addedEntry(service, before), 'branchMerge', 'git/bad-request')
    expectFailOrder(probe, mark, 'branchMerge', 'git/bad-request')
  })

  it('rebase：未知 upstream ⇒ git/unknown-revision（details.op/revision）', async () => {
    const { repo, service, probe } = await makeWorld('rebase-fail')
    git(repo, 'checkout', '-qb', 'side')
    const sideTip = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.rebase({ upstream: 'no-such-ref', acknowledged: true, baseRevision: sideTip }))
    expect(code).toBe('git/unknown-revision')
    expect(details.op).toBe('rebase')
    expect(details.revision).toBe('no-such-ref')
    expectFailEntry(await addedEntry(service, before), 'rebase', 'git/unknown-revision')
    expectFailOrder(probe, mark, 'rebase', 'git/unknown-revision')
  })

  it('checkpointRestore：未知 seq ⇒ git/checkpoint-unavailable（details={seq}）', async () => {
    const { repo, service, probe } = await makeWorld('ckpt-fail')
    const head = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.checkpointRestore({ seq: 999, paths: null, acknowledged: true, baseRevision: head }))
    expect(code).toBe('git/checkpoint-unavailable')
    expect(details).toEqual({ seq: 999 })
    expectFailEntry(await addedEntry(service, before), 'checkpointRestore', 'git/checkpoint-unavailable')
    expectFailOrder(probe, mark, 'checkpointRestore', 'git/checkpoint-unavailable')
  })

  it('stagePatch：空 path ⇒ git/bad-request invalid-options（零命令）', async () => {
    const { service, probe } = await makeWorld('sp-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.stagePatch({ path: '', patch: 'diff --git a/e.txt b/e.txt\n' }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('invalid-options')
    expectFailEntry(await addedEntry(service, before), 'stagePatch', 'git/bad-request')
    expectFailOrder(probe, mark, 'stagePatch', 'git/bad-request')
  })

  it('stashPush：净仓库 ⇒ git/no-paths（details.op=stash）', async () => {
    const { service, probe } = await makeWorld('stashpush-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.stashPush({ includeUntracked: true }))
    expect(code).toBe('git/no-paths')
    expect(details.op).toBe('stash')
    expectFailEntry(await addedEntry(service, before), 'stashPush', 'git/no-paths')
    expectFailOrder(probe, mark, 'stashPush', 'git/no-paths')
  })

  it('stashPop：空 stash ⇒ git/stash-not-found（details={index}）', async () => {
    const { service, probe } = await makeWorld('stashpop-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.stashPop({ index: 0 }))
    expect(code).toBe('git/stash-not-found')
    expect(details).toEqual({ index: 0 })
    expectFailEntry(await addedEntry(service, before), 'stashPop', 'git/stash-not-found')
    expectFailOrder(probe, mark, 'stashPop', 'git/stash-not-found')
  })

  it('stashDrop：无 acknowledged ⇒ git/bad-request unacknowledged（零命令）', async () => {
    const { service, probe } = await makeWorld('stashdrop-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.stashDrop({ index: 0, acknowledged: false }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('unacknowledged')
    expectFailEntry(await addedEntry(service, before), 'stashDrop', 'git/bad-request')
    expectFailOrder(probe, mark, 'stashDrop', 'git/bad-request')
  })

  it('initRepository：已是仓库 ⇒ git/init-failed already-a-repository（零命令，details.path/reason）', async () => {
    const { repo, service, probe } = await makeWorld('init-fail')
    const headBefore = worldHead(repo)
    const before = await auditCount(service)
    const mark = probe.mark()
    const { code, details } = await rejectionOf(() => service.initRepository())
    expect(code).toBe('git/init-failed')
    expect(details.path).toBe(repo)
    expect(details.reason).toBe('already-a-repository')
    expectFailEntry(await addedEntry(service, before), 'initRepository', 'git/init-failed')
    expectFailOrder(probe, mark, 'initRepository', 'git/init-failed')
    // world 重读：仓库原样。
    expect(worldHead(repo)).toBe(headBefore)
  })

  it('createPr：无 acknowledged ⇒ git/bad-request unacknowledged（零命令）', async () => {
    const { repo } = await makeWorld('pr-fail')
    const gh = ghDispatchSubprocess({})
    const prService = makeService(repo, { subprocess: gh })
    const prProbe = installProbes(prService)
    const before = await auditCount(prService)
    const mark = prProbe.mark()
    const { code, details } = await rejectionOf(() => prService.createPr({ title: 't', body: 'b', acknowledged: false }))
    expect(code).toBe('git/bad-request')
    expect(details.reason).toBe('unacknowledged')
    // gh 零调用（danger 闸最先判）。
    expect(gh.calls).toEqual([])
    expectFailEntry(await addedEntry(prService, before), 'createPr', 'git/bad-request')
    expectFailOrder(prProbe, mark, 'createPr', 'git/bad-request')
  })
})

// =====================================================================
// 特例形态 — autoFetchOnce（吞错不抛 / 成功出口 logRead 走 debug）
// =====================================================================

describe('特例形态 — autoFetchOnce（[清单 58]：后台任务永不向 UI 报错，双出口同入审计环）', () => {
  it('成功出口：summary=remote/pruned；时序 audit→invalidate→notify-mutation（logRead 在 debug 级不入探针）', async () => {
    const { service, probe } = await makeRemoteWorld('af-ok')
    const before = await auditCount(service)
    const mark = probe.mark()
    await expect(service.autoFetchOnce()).resolves.toBeUndefined()
    expectOkEntry(await addedEntry(service, before), 'autoFetch', 'remote=origin pruned=false')
    // op 名是 autoFetch（非 fetch）——后台通道与显式 fetch 在环内可辨。
    expect(probe.events.slice(mark)).toEqual([
      'audit autoFetch ok=true code=null',
      'invalidate',
      'notify-mutation',
    ])
  })

  it('失败出口【吞错不抛】：无 remote ⇒ git/no-remote 入环（ok=false 空 summary）、promise 照常 resolve、仅 warn', async () => {
    const { service, probe } = await makeWorld('af-fail')
    const before = await auditCount(service)
    const mark = probe.mark()
    // 吞错形态本体：不抛——resolve(undefined)。
    await expect(service.autoFetchOnce()).resolves.toBeUndefined()
    expectFailEntry(await addedEntry(service, before), 'autoFetch', 'git/no-remote')
    expectFailOrder(probe, mark, 'autoFetch', 'git/no-remote')
  })
})

// =====================================================================
// summary 白名单字段变体（条件字段随输入形态落串——字段面按输入快照）
// =====================================================================

describe('summary 白名单字段变体 — 条件字段随输入形态（§6.10 白名单组装）', () => {
  it('commit 带 trailers ⇒ trailerCount=1', async () => {
    const { repo, service, probe } = await makeWorld('v-commit')
    await writeFile(join(repo, 'b.txt'), 'content\n', 'utf8')
    await service.stage(['b.txt'])
    const before = await auditCount(service)
    const mark = probe.mark()
    await service.commit({ message: 'feat: trailer', amend: false, skipHooks: false, trailers: ['Reviewed-by: r'] })
    expectOkEntry(await addedEntry(service, before), 'commit', 'amend=false skipHooks=false trailerCount=1')
    expectSuccessOrder(probe, mark, 'commit', true)
  })

  it('tagCreate 带 message ⇒ annotated=true', async () => {
    const { service, probe } = await makeWorld('v-tag')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.tagCreate({ name: 'v1', message: 'release v1' })
    expect(result.annotated).toBe(true)
    expectOkEntry(await addedEntry(service, before), 'tagCreate', 'name=v1 annotated=true force=false')
    expectSuccessOrder(probe, mark, 'tagCreate', true)
  })

  it('branchDelete force+acknowledged ⇒ force=true', async () => {
    const { repo, service, probe } = await makeWorld('v-bd')
    git(repo, 'branch', 'topic')
    const before = await auditCount(service)
    const mark = probe.mark()
    await service.branchDelete({ name: 'topic', force: true, acknowledged: true })
    expectOkEntry(await addedEntry(service, before), 'branchDelete', 'name=topic force=true wasMerged=true')
    expectSuccessOrder(probe, mark, 'branchDelete', true)
  })

  it('stashPush 带 message ⇒ hasMessage=true', async () => {
    const { repo, service, probe } = await makeWorld('v-stash')
    await writeFile(join(repo, 'a.txt'), 'dirty\n', 'utf8')
    const before = await auditCount(service)
    const mark = probe.mark()
    await service.stashPush({ includeUntracked: true, message: 'wip note' })
    expectOkEntry(await addedEntry(service, before), 'stashPush', 'includeUntracked=true hasMessage=true')
    expectSuccessOrder(probe, mark, 'stashPush', true)
  })

  it('stagePatch direction=unstage ⇒ direction 字面随入参（反向应用一 hunk）', async () => {
    const { repo, service, probe } = await makeWorld('v-sp')
    await commitFile(repo, 'u.txt', 'u1\nu2\nu3\nu4\n', 'seed u')
    await writeFile(join(repo, 'u.txt'), 'u1\nV2\nu3\nu4\n', 'utf8')
    await service.stage(['u.txt'])
    const stagedPatch = [
      'diff --git a/u.txt b/u.txt',
      '--- a/u.txt',
      '+++ b/u.txt',
      '@@ -1,4 +1,4 @@',
      ' u1',
      '-u2',
      '+V2',
      ' u3',
      ' u4',
      '',
    ].join('\n')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.stagePatch({ path: 'u.txt', patch: stagedPatch, direction: 'unstage' })
    expect(result.staged).toBe(1)
    expectOkEntry(await addedEntry(service, before), 'stagePatch', 'path=u.txt direction=unstage staged=1')
    expectSuccessOrder(probe, mark, 'stagePatch', true)
  })

  it('branchCreate checkout=true ⇒ checkedOut=true', async () => {
    const { service, probe } = await makeWorld('v-bc')
    const before = await auditCount(service)
    const mark = probe.mark()
    const result = await service.branchCreate({ name: 'feat2', checkout: true })
    expect(result.checkedOut).toBe(true)
    expectOkEntry(await addedEntry(service, before), 'branchCreate', 'name=feat2 checkedOut=true')
    expectSuccessOrder(probe, mark, 'branchCreate', true)
  })
})
