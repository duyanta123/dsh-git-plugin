/**
 * v2 批次四 — auditLog 测试（[清单 66]；docs/v2-implementation-plan.md §6.7 host
 * 真仓库范式行）。
 *
 * 覆盖：写操作入环（stage/commit 成功出口 ok:true + code null + 参数摘要白名单字段）；
 * **失败路径入环 ok:false + code（双出口挂钩 §6.5——只挂 afterWrite 会漏全部失败
 * 审计）**；只读方法不入环（status/log/scanStaged/auditLog 自身零增量）；上限截断
 * （引擎级 + 服务级 Config.auditMaxEntries，oldest 逐出）；since 过滤（下界 + 非 ISO
 * ⇒ bad-request invalid-options）；limit 钳制；**summary 负断言**（不含 commit
 * message 正文与文件内容——白名单字段组装 §6.10）+ AuditEngine 纯函数面。
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { AUDIT_MAX_ENTRIES_CEILING, AuditEngine, DEFAULT_AUDIT_LOG_LIMIT, DEFAULT_AUDIT_MAX_ENTRIES, summarizeAuditFields } from '../src/audit.ts'
import type { AuditEntry } from '../src/types.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeService(
  workspaceOverride: string,
  overrides: { auditMaxEntries?: number } = {},
): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000,
    workspaceOverride, autoFetchIntervalMs: 0,
    ...overrides,
  })
}

async function makeWorld(name: string, overrides: { auditMaxEntries?: number } = {}): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-audit-${name}-`, cleanups)
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  return { repo, service: makeService(repo, overrides) }
}

async function rejectionCode(run: () => Promise<unknown>): Promise<string> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return remote!.code
}

async function commitFile(repo: string, rel: string, content: string, message: string): Promise<void> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', '--', rel)
  git(repo, 'commit', '-qm', message)
}

describe('auditLog — 写操作审计双出口（[清单 66]，§6.5/§6.7）', () => {
  it('成功出口入环：ok:true + code=null + 摘要白名单字段 + newest-first', async () => {
    const { repo, service } = await makeWorld('ok')
    await writeFile(join(repo, 'a.txt'), 'content\n', 'utf8')
    await service.stage(['a.txt'])
    const page = await service.auditLog({})
    expect(page.entries.length).toBeGreaterThanOrEqual(1)
    const top = page.entries[0] as AuditEntry
    expect(top.op).toBe('stage')
    expect(top.ok).toBe(true)
    expect(top.code).toBeNull()
    expect(top.summary).toBe('pathCount=1')
    expect(Number.isFinite(top.durationMs)).toBe(true)
    expect(Number.isNaN(Date.parse(top.at))).toBe(false)
    // newest-first：第二条（若先有一次 stage 失败）在更早位置——直接二写验证顺序。
    await writeFile(join(repo, 'b.txt'), 'content\n', 'utf8')
    await service.stage(['b.txt'])
    const again = await service.auditLog({})
    expect(again.entries[0]!.summary).toBe('pathCount=1')
    expect(again.entries[0]!.op).toBe('stage')
    expect(Date.parse(again.entries[0]!.at)).toBeGreaterThanOrEqual(Date.parse(page.entries[0]!.at))
  })

  it('失败路径入环 ok:false + code（catch 出口同步挂钩——§6.5 双出口的负断言面）', async () => {
    const { repo, service } = await makeWorld('fail')
    await commitFile(repo, 'a.txt', 'base\n', 'seed')
    // 失败 1：干净仓库上 commit ⇒ git/nothing-staged（守卫域错误）。
    const guardCode = await rejectionCode(() => service.commit({ message: 'x', amend: false, skipHooks: false }))
    expect(guardCode).toBe('git/nothing-staged')
    // 失败 2：stage 不存在的路径 ⇒ git/git-error（命令失败兜底）。
    const cmdCode = await rejectionCode(() => service.stage(['no-such-file.txt']))
    expect(cmdCode).toBe('git/git-error')
    // 成功出口也落一条（验证双出口并存于同一环）。
    await writeFile(join(repo, 'b.txt'), 'content\n', 'utf8')
    await service.stage(['b.txt'])
    const page = await service.auditLog({})
    const failures = page.entries.filter((entry) => entry.ok === false)
    expect(failures.length).toBe(2)
    const ops = new Set(failures.map((entry) => entry.op))
    expect(ops.has('commit')).toBe(true)
    expect(ops.has('stage')).toBe(true)
    for (const failure of failures) {
      expect(failure.code).not.toBeNull()
      expect(failure.code?.startsWith('git/')).toBe(true)
      expect(failure.summary).toBe('')
      expect(failure.ok).toBe(false)
    }
    const commitFailure = failures.find((entry) => entry.op === 'commit') as AuditEntry
    expect(commitFailure.code).toBe('git/nothing-staged')
    const stageFailure = failures.find((entry) => entry.op === 'stage') as AuditEntry
    expect(stageFailure.code).toBe('git/git-error')
    // 双出口在同一环：成功记录 ok:true/code=null 与失败记录并存。
    const okEntries = page.entries.filter((entry) => entry.ok === true)
    expect(okEntries.length).toBeGreaterThanOrEqual(1)
    expect(okEntries.every((entry) => entry.code === null)).toBe(true)
  })

  it('只读方法不入环：status/log/refs/scanStaged/auditLog 自身零增量', async () => {
    const { repo, service } = await makeWorld('readonly')
    await commitFile(repo, 'a.txt', 'base\n', 'seed')
    await service.status()
    await service.log({ limit: 5, skip: 0 })
    await service.refs()
    await service.scanStaged()
    await service.submoduleStatus()
    const before = await service.auditLog({})
    expect(before.entries).toEqual([])
    // 一次写操作后环内只有该写（无任何只读 op 混入）。
    await writeFile(join(repo, 'a.txt'), 'changed\n', 'utf8')
    await service.stage(['a.txt'])
    const after = await service.auditLog({})
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0]!.op).toBe('stage')
    const readOps = ['status', 'log', 'refs', 'scanStaged', 'submoduleStatus', 'auditLog']
    expect(after.entries.every((entry) => !readOps.includes(entry.op))).toBe(true)
  })

  it('上限截断：引擎级（oldest 逐出）+ 服务级 Config.auditMaxEntries', async () => {
    // 引擎级：maxEntries=3 记 5 条 → 保留最新 3 条（newest-first）。
    const engine = new AuditEngine({ maxEntries: 3 })
    for (let index = 0; index < 5; index++) {
      engine.record(`op${String(index)}`, true, null, index, { seq: index })
    }
    const page = engine.query({})
    expect(page.entries.map((entry) => entry.op)).toEqual(['op4', 'op3', 'op2'])
    // 服务级：auditMaxEntries=2，三次写 → 环内 2 条。
    const { repo, service } = await makeWorld('cap', { auditMaxEntries: 2 })
    await writeFile(join(repo, 'a.txt'), '1\n', 'utf8')
    await service.stage(['a.txt'])
    await writeFile(join(repo, 'a.txt'), '2\n', 'utf8')
    await service.stage(['a.txt'])
    await writeFile(join(repo, 'a.txt'), '3\n', 'utf8')
    await service.stage(['a.txt'])
    const page2 = await service.auditLog({})
    expect(page2.entries).toHaveLength(2)
    expect(page2.entries.every((entry) => entry.op === 'stage')).toBe(true)
    // 构造钳制：maxEntries 越上界 → ceiling；缺省 500。
    expect(new AuditEngine({ maxEntries: AUDIT_MAX_ENTRIES_CEILING + 10 }).capacity).toBe(AUDIT_MAX_ENTRIES_CEILING)
    expect(new AuditEngine({}).capacity).toBe(DEFAULT_AUDIT_MAX_ENTRIES)
  })

  it('since 过滤：未来时间戳 ⇒ 空；过去时间戳 ⇒ 全量；limit 钳制；非 ISO ⇒ bad-request invalid-options', async () => {
    const { repo, service } = await makeWorld('since')
    await writeFile(join(repo, 'a.txt'), '1\n', 'utf8')
    await service.stage(['a.txt'])
    const future = new Date(Date.now() + 60_000).toISOString()
    const empty = await service.auditLog({ since: future })
    expect(empty.entries).toEqual([])
    const past = new Date(Date.now() - 60_000).toISOString()
    const all = await service.auditLog({ since: past })
    expect(all.entries.length).toBeGreaterThanOrEqual(1)
    // limit：1 → 恰一条（newest）；超大 → 钳到 maxEntries。
    const limited = await service.auditLog({ limit: 1 })
    expect(limited.entries).toHaveLength(1)
    const over = await service.auditLog({ limit: 100_000 })
    expect(over.entries.length).toBeLessThanOrEqual(new AuditEngine().capacity)
    // 缺省 limit = 100（≤100 条返回面）。
    const def = await service.auditLog({})
    expect(def.entries.length).toBeLessThanOrEqual(DEFAULT_AUDIT_LOG_LIMIT)
    const bad = await rejectionCode(() => service.auditLog({ since: 'not-a-timestamp' }))
    expect(bad).toBe('git/bad-request')
  })

  it('summary 负断言：commit message 正文与文件内容零落环（白名单字段组装，§6.10）', async () => {
    const { repo, service } = await makeWorld('leak')
    const messageBody = 'TOP-SECRET-COMMIT-BODY-7f3a'
    const filePayload = 'PAYLOAD-CONTENT-9b2c-should-not-leak'
    await writeFile(join(repo, 'a.txt'), `${filePayload}\n`, 'utf8')
    const staged = await service.stage(['a.txt'])
    expect(staged.staged).toBe(1)
    await service.commit({ message: messageBody, amend: false, skipHooks: false })
    const page = await service.auditLog({ limit: 1000 })
    const dumped = JSON.stringify(page.entries)
    expect(dumped.includes(messageBody)).toBe(false)
    expect(dumped.includes(filePayload)).toBe(false)
    // commit 摘要只含白名单旗标（amend/skipHooks/trailerCount）。
    const commitEntry = page.entries.find((entry) => entry.op === 'commit') as AuditEntry
    expect(commitEntry.summary).toBe('amend=false skipHooks=false trailerCount=0')
    // 失败出口摘要恒空串。
    await commitFile(repo, 'b.txt', 'x\n', 'seed')
    await rejectionCode(() => service.commit({ message: 'y', amend: false, skipHooks: false }))
    const again = await service.auditLog({ limit: 1000 })
    const failed = again.entries.find((entry) => entry.op === 'commit' && entry.ok === false) as AuditEntry
    expect(failed.summary).toBe('')
  })
})

describe('AuditEngine — 纯函数面（summarizeAuditFields）', () => {
  it('白名单字段串组装：undefined 剔除、标量 String 化、保持键序', () => {
    expect(summarizeAuditFields({})).toBe('')
    expect(summarizeAuditFields({ a: 1, b: undefined, c: 'x', d: true, e: null })).toBe('a=1 c=x d=true e=null')
    expect(summarizeAuditFields({ path: 'a/b.txt', staged: 2 })).toBe('path=a/b.txt staged=2')
  })

  it('record 零抛错（审计不反噬业务路径）', () => {
    const engine = new AuditEngine({ maxEntries: 1 })
    engine.record('op', true, null, 1, {})
    engine.record('op', false, 'git/x', 2, {})
    expect(engine.query({}).entries).toHaveLength(1)
    expect(engine.query({}).entries[0]!.ok).toBe(false)
  })
})
