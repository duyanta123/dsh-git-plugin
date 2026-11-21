/**
 * v3 批次三 — Agent 工具面测试（[清单 45]；docs/v3-implementation-plan.md §5.8
 * host 单测 + 真仓集成行）。
 *
 * 覆盖：
 *   - 三档白名单表断言：定义名集 = readonly 8 + readwrite 3（READONLY_TOOL_NAMES/
 *     READWRITE_TOOL_NAMES 权威序）、parameters schema 可 JSON 化 + raw 形状
 *     （type object / required 数组 / 属性 spec 带 type）、output.schema 显式
 *     additionalProperties（spike 坑）+ render 单 text 块；
 *   - registerAgentTools 注册面：readwrite 全 11 / readonly 8 / off 零注册（观测面
 *     仍在，toolsFaceAvailable 与 mode 解耦）/ 事件跟随（'internal/service'——真
 *     Context provide 路径）/ disposer 撤销 / face 缺失降级（不 throw、宽限期单次
 *     warn、registered=[]）/ 逐工具注册被 face 校验拒绝 ⇒ log + 跳过不炸服务；
 *   - guard：blockShellGit 开启时 shell+git 参数 deny 文案引导（含 git_* 工具名）、
 *     非 git 命令与非 shell 工具放行、关闭零注册、face 缺 guard 方法 warn 降级；
 *   - service 集成：agentToolsStatus @Remote 三态投影（readonly 8 / off [] /
 *     face 后挂事件跟随到位）；
 *   - readwrite 真仓全链（真仓 world 重读纪律）：git_status 投影（branch/counts/
 *     clean）→ git_stage → git_commit → world 重读（log subject/porcelain clean）+
 *     audit 入环（git_stage/git_commit ok:true；summary 不落 message 正文）；
 *   - scanStaged 前检（DD=A 硬阻断）：staged secret 样本 ⇒ git/commit-blocked 拒绝
 *     （redactedMatch 无明文）、world 零提交、audit 失败出口 ok:false 入环；
 *     无 staged ⇒ git/nothing-staged 拒绝。
 *
 * 断言纪律：真仓断言一律独立 execFileSync git 重读世界（HEAD/porcelain/rev-list
 * count），不信工具返回值自述。
 */

import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditEngine } from '../src/audit.ts'
import { buildAgentToolDefinitions, registerAgentTools, shellGitGuard, READONLY_TOOL_NAMES, READWRITE_TOOL_NAMES } from '../src/agent-tools.ts'
import type { AgentToolEngines, GitToolDefinition, GitToolsFace } from '../src/agent-tools.ts'
import { GitService } from '../src/index.ts'
import type { GitLoggerFace } from '../src/error-codes.ts'
import { git, makeGitService, scratchDir, scratchRepo } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ---------- 测试替身 ----------

/** 引擎束替身（定义表构造不调用引擎——表测试够用）。 */
function stubEngines(): AgentToolEngines {
  return {
    status: {} as AgentToolEngines['status'],
    diff: {} as AgentToolEngines['diff'],
    graph: {} as AgentToolEngines['graph'],
    blame: {} as AgentToolEngines['blame'],
    mutations: {} as AgentToolEngines['mutations'],
    commit: {} as AgentToolEngines['commit'],
    guardScan: {} as AgentToolEngines['guardScan'],
    diagnostics: {} as AgentToolEngines['diagnostics'],
  }
}

interface FakeToolsFace {
  face: GitToolsFace
  registered: GitToolDefinition[]
  unregisteredCount: number
  guards: Array<(execution: { readonly name: string; readonly arguments: unknown }) => string | undefined>
  guardsUnregisteredCount: number
}

/** ctx.tools 注册面替身：记录注册/撤销（可选拒绝名单——模拟 schema 校验拒绝）。 */
function fakeToolsFace(rejectNames: readonly string[] = []): FakeToolsFace {
  const state: FakeToolsFace = {
    face: undefined as unknown as GitToolsFace,
    registered: [],
    unregisteredCount: 0,
    guards: [],
    guardsUnregisteredCount: 0,
  }
  state.face = {
    register(definition: GitToolDefinition): () => void {
      if (rejectNames.includes(definition.name)) {
        throw new Error(`schema rejected for ${definition.name} (fake face)`)
      }
      state.registered.push(definition)
      return () => { state.unregisteredCount += 1 }
    },
    guard(guard: (execution: { readonly name: string; readonly arguments: unknown }) => string | undefined): () => void {
      state.guards.push(guard)
      return () => { state.guardsUnregisteredCount += 1 }
    },
  }
  return state
}

/** 无 guard 方法的旧代 face（plan §5.10 降级注）。 */
function faceWithoutGuard(base: FakeToolsFace): GitToolsFace {
  return { register: (definition) => base.face.register(definition) }
}

/** 手工事件宿主（'internal/service' 记录面——事件跟随的直接驱动测试）。 */
interface ManualEventHost {
  readonly removed: boolean
  on(event: 'internal/service', listener: (name: string, value: unknown) => void): unknown
  fire(name: string, value: unknown): void
}

function manualEventHost(): ManualEventHost {
  let listener: ((name: string, value: unknown) => void) | undefined
  const removed = { value: false }
  return {
    get removed() { return removed.value },
    on(_event: 'internal/service', callback: (name: string, value: unknown) => void): unknown {
      listener = callback
      return () => {
        removed.value = true
        listener = undefined
      }
    },
    fire(name: string, value: unknown): void {
      listener?.(name, value)
    },
  }
}

/** 可编程 face 缺席/在场的取面函数（GitService.readAgentToolsFace 的 spec 侧同形）。 */
function readFaceOf(holder: { face: GitToolsFace | undefined }): () => GitToolsFace | undefined {
  return () => holder.face
}

function fakeLogger(): GitLoggerFace & { warns: string[]; debugs: string[] } {
  const logger = {
    warns: [] as string[],
    debugs: [] as string[],
    debug(message: string): void { logger.debugs.push(message) },
    info(_message: string): void {},
    warn(message: string): void { logger.warns.push(message) },
    error(_message: string): void {},
  }
  return logger
}

function makeRegistration(holder: { face: GitToolsFace | undefined }, overrides?: {
  mode?: 'off' | 'readonly' | 'readwrite'
  blockShellGit?: boolean
  host?: ManualEventHost
  graceMs?: number
  logger?: GitLoggerFace
}): { state: { mode: 'off' | 'readonly' | 'readwrite'; toolsFaceAvailable: boolean; registered: string[] }; registration: ReturnType<typeof registerAgentTools> } {
  const state = {
    mode: overrides?.mode ?? 'readwrite',
    toolsFaceAvailable: false,
    registered: [] as string[],
  }
  const registration = registerAgentTools({
    mode: overrides?.mode ?? 'readwrite',
    blockShellGit: overrides?.blockShellGit ?? false,
    engines: stubEngines(),
    audit: new AuditEngine({ maxEntries: 10 }),
    host: overrides?.host ?? manualEventHost(),
    readFace: readFaceOf(holder),
    logger: overrides?.logger ?? fakeLogger(),
    state,
    graceMs: overrides?.graceMs ?? 20,
  })
  return { state, registration }
}

// ---------- 定义表三档白名单（§5.4 权威表） ----------

describe('定义表三档白名单（[45] §5.4）', () => {
  it('定义名集 = readonly 8 + readwrite 3（声明序 = 注册序 = 权威表序）', () => {
    const definitions = buildAgentToolDefinitions(stubEngines(), new AuditEngine({ maxEntries: 10 }))
    expect(definitions.map((definition) => definition.name)).toEqual([...READONLY_TOOL_NAMES, ...READWRITE_TOOL_NAMES])
    expect(READONLY_TOOL_NAMES).toEqual([
      'git_status', 'git_diff', 'git_log', 'git_refs', 'git_blame',
      'git_commit_detail', 'git_compare_branches', 'git_repo_diagnostics',
    ])
    expect(READWRITE_TOOL_NAMES).toEqual(['git_stage', 'git_unstage', 'git_commit'])
  })

  it('parameters schema 可 JSON 化 + raw 形状（type object / required 数组 / 属性 spec 带 type）', () => {
    const definitions = buildAgentToolDefinitions(stubEngines(), new AuditEngine({ maxEntries: 10 }))
    for (const definition of definitions) {
      const roundTripped = JSON.parse(JSON.stringify(definition.parameters)) as unknown
      expect(roundTripped, `${definition.name} parameters must survive a JSON round-trip`).toEqual(definition.parameters)
      expect(definition.parameters.type).toBe('object')
      expect(typeof definition.parameters.properties).toBe('object')
      const properties = definition.parameters.properties as Record<string, { type?: string; enum?: string[] }>
      for (const [key, spec] of Object.entries(properties)) {
        expect(typeof spec.type === 'string' || Array.isArray(spec.enum), `${definition.name}.${key} must carry a type`).toBe(true)
      }
      const required = definition.parameters.required as string[] | undefined
      expect(required === undefined || (Array.isArray(required) && required.every((item) => typeof item === 'string'))).toBe(true)
      expect(typeof definition.description).toBe('string')
      expect(definition.description.length).toBeGreaterThan(0)
    }
    // requiredness 的逐工具锚（raw JSON Schema 形态落 required 数组——spike 契约）。
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    expect(byName.get('git_blame')!.parameters.required).toEqual(['path'])
    expect(byName.get('git_commit_detail')!.parameters.required).toEqual(['oid'])
    expect(byName.get('git_compare_branches')!.parameters.required).toEqual(['base', 'compare'])
    expect(byName.get('git_stage')!.parameters.required).toEqual(['paths'])
    expect(byName.get('git_unstage')!.parameters.required).toEqual(['paths'])
    expect(byName.get('git_commit')!.parameters.required).toEqual(['message'])
    expect(byName.get('git_status')!.parameters.required).toBeUndefined()
    expect(byName.get('git_refs')!.parameters.required).toBeUndefined()
  })

  it('output.schema 显式 additionalProperties + render 单 text 块（canonical 值原样回读）', () => {
    const definitions = buildAgentToolDefinitions(stubEngines(), new AuditEngine({ maxEntries: 10 }))
    for (const definition of definitions) {
      const schema = definition.output.schema as Record<string, unknown>
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(true)
      expect((schema.properties as Record<string, { type: string }>).ok?.type).toBe('boolean')
    }
    const value = { ok: true, nested: { list: [1, 2, 3], when: null } }
    const rendered = definitions[0]!.output.render({ any: 'args' }, value)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]!.type).toBe('text')
    expect(JSON.parse(rendered[0]!.text)).toEqual(value)
  })
})

// ---------- registerAgentTools 注册面（plan §5.5） ----------

describe('registerAgentTools — 三档注册与撤销', () => {
  it('readwrite：全 11 注册 + 事件跟随 bind/unbind + disposer 撤销（零残留）', () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const fake = fakeToolsFace()
    const host = manualEventHost()
    const { state, registration } = makeRegistration(holder, { mode: 'readwrite', host })
    // face 未挂：零注册、观测 false。
    expect(state.registered).toEqual([])
    expect(state.toolsFaceAvailable).toBe(false)
    // 事件跟随：tools provide ⇒ 11 注册。
    holder.face = fake.face
    host.fire('tools', fake.face)
    expect(state.registered).toEqual([...READONLY_TOOL_NAMES, ...READWRITE_TOOL_NAMES])
    expect(state.toolsFaceAvailable).toBe(true)
    expect(fake.registered).toHaveLength(11)
    // 非 tools 名的事件无副作用；同实例重复事件不重注册（live 计数守恒）。
    host.fire('logger', {})
    host.fire('tools', fake.face)
    expect(fake.registered).toHaveLength(11)
    expect(fake.unregisteredCount).toBe(0)
    // 服务移除（value undefined）⇒ 撤销 + 观测复位。
    host.fire('tools', undefined)
    expect(fake.unregisteredCount).toBe(11)
    expect(state.registered).toEqual([])
    expect(state.toolsFaceAvailable).toBe(false)
    // 重新提供（同实例）⇒ 再注册（撤销先于重绑）。
    host.fire('tools', fake.face)
    expect(state.registered).toEqual([...READONLY_TOOL_NAMES, ...READWRITE_TOOL_NAMES])
    expect(fake.registered).toHaveLength(22)
    // dispose：全部撤销 + 监听移除 + 事后事件惰性。
    registration.dispose()
    expect(fake.unregisteredCount).toBe(22)
    expect(state.toolsFaceAvailable).toBe(false)
    expect(state.registered).toEqual([])
    expect(host.removed).toBe(true)
    host.fire('tools', fake.face)
    expect(fake.registered).toHaveLength(22)
  })

  it('readonly：8 注册、write 类不在 registered', () => {
    const holder: { face: GitToolsFace | undefined } = { face: fakeToolsFace().face }
    const { state } = makeRegistration(holder, { mode: 'readonly' })
    expect(state.registered).toEqual([...READONLY_TOOL_NAMES])
    expect(state.toolsFaceAvailable).toBe(true)
    expect(state.registered).not.toContain('git_stage')
    expect(state.registered).not.toContain('git_unstage')
    expect(state.registered).not.toContain('git_commit')
  })

  it('off：零注册但观测面在（toolsFaceAvailable 与 mode 解耦）', () => {
    const holder: { face: GitToolsFace | undefined } = { face: fakeToolsFace().face }
    const { state } = makeRegistration(holder, { mode: 'off' })
    expect(state.registered).toEqual([])
    expect(state.toolsFaceAvailable).toBe(true)
  })

  it('tools face 缺失：不 throw、宽限期后单次 warn、registered=[]（降级可观测）', async () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const logger = fakeLogger()
    const { state } = makeRegistration(holder, { mode: 'readwrite', graceMs: 20, logger })
    expect(state.registered).toEqual([])
    expect(state.toolsFaceAvailable).toBe(false)
    await new Promise((resolveWait) => setTimeout(resolveWait, 60))
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toContain('tools face not observed within 20ms')
    expect(state.toolsFaceAvailable).toBe(false)
  })

  it('off 档 face 缺失：静默（宽限期不发声——用户未启用工具面，warn 属噪声）', async () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const logger = fakeLogger()
    makeRegistration(holder, { mode: 'off', graceMs: 20, logger })
    await new Promise((resolveWait) => setTimeout(resolveWait, 60))
    expect(logger.warns).toHaveLength(0)
  })

  it('注册被 face 校验拒绝：log + 跳过该工具，其余照常（不炸服务）', () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const fake = fakeToolsFace(['git_diff'])
    const logger = fakeLogger()
    const host = manualEventHost()
    const { state } = makeRegistration(holder, { mode: 'readwrite', host, logger })
    holder.face = fake.face
    host.fire('tools', fake.face)
    expect(state.registered).toEqual([...READONLY_TOOL_NAMES, ...READWRITE_TOOL_NAMES].filter((name) => name !== 'git_diff'))
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toContain('git_diff')
    expect(logger.warns[0]).toContain('rejected')
  })
})

// ---------- guard（agentToolBlockShellGit，plan §5.3） ----------

describe('guard — shell-git 引导防线', () => {
  it('开启：guard 注册 + shell 工具 git 命令 deny 文案引导 git_* 工具', () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const fake = fakeToolsFace()
    const host = manualEventHost()
    makeRegistration(holder, { mode: 'readonly', blockShellGit: true, host })
    holder.face = fake.face
    host.fire('tools', fake.face)
    expect(fake.guards).toHaveLength(1)
    const denial = fake.guards[0]!({ name: 'bash', arguments: { command: 'git status --short' } })
    expect(typeof denial).toBe('string')
    expect(String(denial)).toContain('git_status')
    expect(String(denial)).toContain('guidance fence, not a security boundary')
    // 带旗标的形态与多行脚本同样命中（git+子命令词表模式）。
    expect(fake.guards[0]!({ name: 'pwsh', arguments: { command: 'cd repo\ngit add -A\ngit commit -m x' } })).toBeDefined()
    expect(fake.guards[0]!({ name: 'shell', arguments: { command: 'git rev-parse --show-toplevel' } })).toBeDefined()
  })

  it('非 git 命令 / 非 shell 类工具放行（undefined）', () => {
    const guard = shellGitGuard
    expect(guard({ name: 'bash', arguments: { command: 'ls -la && npm test' } })).toBeUndefined()
    // 'digit' 含 git 子串但 \b 边界不命中；子命令词表缺失同样放行。
    expect(guard({ name: 'bash', arguments: { command: 'echo a digit reminder' } })).toBeUndefined()
    expect(guard({ name: 'todo_write', arguments: { command: 'git status' } })).toBeUndefined()
    expect(guard({ name: 'bash', arguments: null })).toBeUndefined()
  })

  it('关闭：零 guard 注册', () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const fake = fakeToolsFace()
    const host = manualEventHost()
    makeRegistration(holder, { mode: 'readwrite', blockShellGit: false, host })
    holder.face = fake.face
    host.fire('tools', fake.face)
    expect(fake.guards).toHaveLength(0)
  })

  it('face 缺 guard 方法（旧代宿主）：warn + 工具注册不受影响', () => {
    const holder: { face: GitToolsFace | undefined } = { face: undefined }
    const fake = fakeToolsFace()
    const logger = fakeLogger()
    const host = manualEventHost()
    makeRegistration(holder, { mode: 'readonly', blockShellGit: true, host, logger })
    holder.face = faceWithoutGuard(fake)
    host.fire('tools', holder.face)
    expect(fake.registered).toHaveLength(8)
    expect(logger.warns.some((message) => message.includes('no guard() method'))).toBe(true)
  })
})

// ---------- service 集成（agentToolsStatus @Remote） ----------

function makeServiceWithTools(repo: string, config: { agentTools?: 'off' | 'readonly' | 'readwrite'; agentToolBlockShellGit?: boolean }, tools: GitToolsFace | undefined, provideToolsFirst: boolean): InstanceType<typeof GitService> & { attachTools(): void } {
  // 装配去重：Context+subprocess 面经 support.makeGitService；tools 的构造前注入经
  // provides（时序不变），attachTools 走同 ctx 的后置 provide。
  const { service, ctx } = makeGitService(repo, {
    commitTimeoutMs: 15_000,
    autoFetchIntervalMs: 0,
    ...(config.agentTools !== undefined ? { agentTools: config.agentTools } : {}),
    ...(config.agentToolBlockShellGit !== undefined ? { agentToolBlockShellGit: config.agentToolBlockShellGit } : {}),
    ...(provideToolsFirst && tools !== undefined ? { provides: [['tools', tools] as const] } : {}),
  })
  const face = ctx as unknown as { provide(name: string, value: unknown): void }
  const withAttach = service as InstanceType<typeof GitService> & { attachTools(): void }
  withAttach.attachTools = () => {
    if (tools !== undefined) face.provide('tools', tools)
  }
  // provideToolsFirst=false ⇒ 由测试显式调 attachTools()（真「后挂」时序——事件跟随路径）。
  return withAttach
}

describe('service 集成 — agentToolsStatus（[45] §5.5 观测锚）', () => {
  it('readonly + 预挂 face：registered = 8 只读白名单（mode/available 如实）', async () => {
    const repo = await scratchRepo('dshgit-at-status-ro-', cleanups)
    const fake = fakeToolsFace()
    const service = makeServiceWithTools(repo, { agentTools: 'readonly' }, fake.face, true)
    const status = await service.agentToolsStatus()
    expect(status.mode).toBe('readonly')
    expect(status.toolsFaceAvailable).toBe(true)
    expect(status.registered).toEqual([...READONLY_TOOL_NAMES])
    expect(fake.registered).toHaveLength(8)
  })

  it('off + face 在场：registered=[]、toolsFaceAvailable=true（观测与档位解耦）', async () => {
    const repo = await scratchRepo('dshgit-at-status-off-', cleanups)
    const fake = fakeToolsFace()
    const service = makeServiceWithTools(repo, { agentTools: 'off' }, fake.face, true)
    const status = await service.agentToolsStatus()
    expect(status.mode).toBe('off')
    expect(status.toolsFaceAvailable).toBe(true)
    expect(status.registered).toEqual([])
    expect(fake.registered).toHaveLength(0)
  })

  it('face 后挂（事件跟随）：首次观测为空 → provide → registered 到位 + guard 同挂', async () => {
    const repo = await scratchRepo('dshgit-at-status-late-', cleanups)
    const fake = fakeToolsFace()
    const service = makeServiceWithTools(repo, { agentTools: 'readonly', agentToolBlockShellGit: true }, fake.face, false)
    // 后挂前：即时读取未命中、事件未到达 ⇒ 观测空（宽限期 warn 未发声——事件迟到
    // 后注册翻转状态）。
    const before = await service.agentToolsStatus()
    expect(before.registered).toEqual([])
    expect(before.toolsFaceAvailable).toBe(false)
    // 真「后挂」：provide 触发 'internal/service' ⇒ registerAgentTools 事件跟随绑定。
    service.attachTools()
    const after = await service.agentToolsStatus()
    expect(after.mode).toBe('readonly')
    expect(after.toolsFaceAvailable).toBe(true)
    expect(after.registered).toEqual([...READONLY_TOOL_NAMES])
    expect(fake.guards).toHaveLength(1)
  })
})

// ---------- readwrite 真仓全链（[45] §5.8 真仓集成行） ----------

interface WorldWithTools {
  repo: string
  service: InstanceType<typeof GitService>
  tools: Map<string, GitToolDefinition>
}

async function makeToolWorld(name: string, config: { agentTools: 'readwrite' | 'readonly' }): Promise<WorldWithTools> {
  const repo = await scratchRepo(`dshgit-at-${name}-`, cleanups)
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@example.com')
  const fake = fakeToolsFace()
  const service = makeServiceWithTools(repo, config, fake.face, true)
  return {
    repo,
    service,
    tools: new Map(fake.registered.map((definition) => [definition.name, definition])),
  }
}

function runTool(definition: GitToolDefinition, args: unknown): Promise<unknown> {
  const controller = new AbortController()
  return definition.execute(args, { signal: controller.signal, name: definition.name, arguments: args })
}

function worldHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function worldPorcelain(repo: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function worldCommitCount(repo: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
}

describe('readwrite 真仓全链 — git_commit 工具（[45] §5.8）', () => {
  it('git_status 工具投影：branch/counts/clean + path 过滤（真仓 world 对照）', async () => {
    const world = await makeToolWorld('status', { agentTools: 'readwrite' })
    const value = await runTool(world.tools.get('git_status')!, { fresh: true }) as Record<string, unknown>
    expect(value.ok).toBe(true)
    expect((value.branch as Record<string, unknown>).name).toBe('main')
    expect((value.branch as Record<string, unknown>).unborn).toBe(true)
    expect(value.clean).toBe(true)
    expect(value.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
    // path 过滤：计数保持全量，列表按前缀过滤。
    await writeFile(join(world.repo, 'src.txt'), 'hello\n', 'utf8')
    const filtered = await runTool(world.tools.get('git_status')!, { fresh: true, path: 'no-such-prefix/' }) as Record<string, unknown>
    expect(filtered.counts).toEqual({ staged: 0, unstaged: 0, untracked: 1, conflicted: 0 })
    expect(filtered.untracked).toEqual([])
    const listed = await runTool(world.tools.get('git_status')!, { fresh: true }) as Record<string, unknown>
    expect((listed.untracked as Array<Record<string, unknown>>)[0]?.path).toBe('src.txt')
  })

  it('全链：git_stage → git_commit → world 重读（HEAD/subject/clean）+ audit 入环（summary 无 message 正文）', async () => {
    const world = await makeToolWorld('chain', { agentTools: 'readwrite' })
    await writeFile(join(world.repo, 'a.txt'), 'agent chain\n', 'utf8')

    const staged = await runTool(world.tools.get('git_stage')!, { paths: ['a.txt'] }) as Record<string, unknown>
    expect(staged).toEqual({ ok: true, staged: 1 })
    // world 重读：index 落条目。
    expect(worldPorcelain(world.repo)).toBe('A  a.txt\n')

    const committed = await runTool(world.tools.get('git_commit')!, { message: 'feat: agent tool chain' }) as Record<string, unknown>
    expect(committed.ok).toBe(true)
    expect(committed.branch).toBe('main')
    expect(committed.shortOid).toBe((committed.oid as string).slice(0, 7))
    // world 重读：HEAD 前进、subject 落地、worktree 干净。
    const worldOid = worldHead(world.repo)
    expect(committed.oid).toBe(worldOid)
    const worldSubject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: world.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    expect(worldSubject).toBe('feat: agent tool chain')
    expect(worldPorcelain(world.repo)).toBe('')
    // 回读 message = 权威值（commit 引擎 show -s %B 去尾换行）。
    expect(committed.message).toBe('feat: agent tool chain')

    // audit 入环：git_stage/git_commit 成功出口 ok:true；summary 不落 message 正文
    //（audit 纪律 §6.10——工具体同纪律）。
    const audit = await world.service.auditLog({ limit: 50 })
    const ops = audit.entries.map((entry) => entry.op)
    expect(ops).toContain('git_stage')
    expect(ops).toContain('git_commit')
    const stageEntry = audit.entries.find((entry) => entry.op === 'git_stage')!
    const commitEntry = audit.entries.find((entry) => entry.op === 'git_commit')!
    expect(stageEntry.ok).toBe(true)
    expect(stageEntry.summary).toContain('pathCount=1')
    expect(commitEntry.ok).toBe(true)
    const auditDump = JSON.stringify(audit.entries)
    expect(auditDump).not.toContain('feat: agent tool chain')
    expect(auditDump).not.toContain('agent chain')
  })

  it('scanStaged 前检：staged secret ⇒ git/commit-blocked 硬拒绝（零命令、redactedMatch 无明文、audit 失败出口）', async () => {
    const world = await makeToolWorld('secret', { agentTools: 'readwrite' })
    // 一笔种子提交（world commit 计数基线）。
    await writeFile(join(world.repo, 'seed.txt'), 'seed\n', 'utf8')
    git(world.repo, 'add', 'seed.txt')
    git(world.repo, 'commit', '-qm', 'chore: seed')
    const baseCount = worldCommitCount(world.repo)
    const baseHead = worldHead(world.repo)

    await writeFile(join(world.repo, 'leak.txt'), 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n', 'utf8')
    const staged = await runTool(world.tools.get('git_stage')!, { paths: ['leak.txt'] }) as Record<string, unknown>
    expect(staged).toEqual({ ok: true, staged: 1 })

    const blocked = await runTool(world.tools.get('git_commit')!, { message: 'feat: sneak the key' }) as Record<string, unknown>
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('git/commit-blocked')
    expect(String(blocked.message)).toContain('hard block')
    const violations = blocked.violations as Array<Record<string, unknown>>
    const secret = violations.find((violation) => violation.kind === 'secret')
    expect(secret).toBeDefined()
    expect(String(secret!.redactedMatch)).toMatch(/^AKIA/)
    expect(String(secret!.redactedMatch)).not.toContain('IOSFODNN7EXAMPLE')

    // world 重读：零命令——HEAD/commit 计数不动（拒绝在进 commit 管线之前）。
    expect(worldCommitCount(world.repo)).toBe(baseCount)
    expect(worldHead(world.repo)).toBe(baseHead)
    expect(worldPorcelain(world.repo)).toBe('A  leak.txt\n')

    // audit 失败出口：ok:false + code（§6.5 双出口——工具体同纪律）。
    const audit = await world.service.auditLog({ limit: 50 })
    const failed = audit.entries.find((entry) => entry.op === 'git_commit' && entry.ok === false)
    expect(failed).toBeDefined()
    expect(failed!.code).toBe('git/commit-blocked')
    expect(failed!.summary).toBe('')
  })

  it('无 staged ⇒ git/nothing-staged 拒绝（[清单 11] 守卫的工具面）', async () => {
    const world = await makeToolWorld('nothing-staged', { agentTools: 'readwrite' })
    const rejected = await runTool(world.tools.get('git_commit')!, { message: 'feat: nothing staged' }) as Record<string, unknown>
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('git/nothing-staged')
    // 零命令：unborn HEAD 无提交产生（rev-list 对 unborn 报错 ⇒ 空输出）。
    let headOutput = ''
    try {
      headOutput = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: world.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      headOutput = ''
    }
    expect(headOutput.trim()).toBe('')
  })
})

// ---------- read 失败面（评审收口）：引擎域错误 ⇒ 工具结果文本（文件头/plan §5.4 契约） ----------

describe('read 工具失败以工具结果文本返回 — 不抛宿主异常（评审收口）', () => {
  it('git_log 不可解析 ref ⇒ {ok:false, error:git/unknown-revision}（旧实现原样穿出 execute）', async () => {
    const world = await makeToolWorld('log-bad-ref', { agentTools: 'readonly' })
    await writeFile(join(world.repo, 'seed.txt'), 'seed\n', 'utf8')
    git(world.repo, 'add', 'seed.txt')
    git(world.repo, 'commit', '-qm', 'seed')
    // graph 引擎对不可解析 ref 抛 git/unknown-revision——makeTool.execute 的统一
    // try/catch 把它转成工具失败值，而非让宿主异常穿出工具面。
    const rejected = await runTool(world.tools.get('git_log')!, { ref: 'nope' }) as Record<string, unknown>
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('git/unknown-revision')
    // message = 英文诊断文本（域错误 message 原样——不落文件内容/工作区数据）。
    expect(typeof rejected.message).toBe('string')
    expect((rejected.message as string).length).toBeGreaterThan(0)
    expect(rejected.message).not.toContain('seed')
  })

  it('git_log body 超 2000 字 ⇒ 截断 + bodyTruncated=true（二次裁剪如实登记——批次五评审收口）', async () => {
    const world = await makeToolWorld('log-body-truncated', { agentTools: 'readonly' })
    await writeFile(join(world.repo, 'seed.txt'), 'seed\n', 'utf8')
    git(world.repo, 'add', 'seed.txt')
    const longBody = Array.from({ length: 120 }, () => 'line of body text padding the commit message').join('\n')
    git(world.repo, 'commit', '-qm', 'seed subject', '-m', longBody)
    const page = await runTool(world.tools.get('git_log')!, {}) as Record<string, unknown>
    const commits = page.commits as Array<Record<string, unknown>>
    const first = commits[0]!
    expect(first.bodyTruncated).toBe(true)
    expect(first.body).toBe(longBody.slice(0, 2_000))
    expect(String(first.body).length).toBe(2_000)
  })

  it('git_diff 于 no-repository 场景 ⇒ 失败值不抛（read 兜底第二抽测——7 个 read 工具同层覆盖）', async () => {
    // scratchRepo 产出的是已 init 仓库——no-repository 面用纯临时目录
    // （scratchDir，非仓库）作 workspaceOverride：diff 引擎 resolveRepoRoot 抛
    // git/no-repository（admin-repo.spec.ts:143 同款稳定事实）。
    const nonRepo = await scratchDir('dshgit-at-nonrepo-', cleanups)
    const fake = fakeToolsFace()
    const service = makeServiceWithTools(nonRepo, { agentTools: 'readonly' }, fake.face, true)
    // 观测锚同核对（face 已挂 ⇒ 即时注册）：mode=readonly、toolsFaceAvailable=true。
    const status = await service.agentToolsStatus()
    expect(status.mode).toBe('readonly')
    expect(status.toolsFaceAvailable).toBe(true)
    const tools = new Map(fake.registered.map((definition) => [definition.name, definition]))
    const rejected = await runTool(tools.get('git_diff')!, { scope: 'worktree' }) as Record<string, unknown>
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('git/no-repository')
  })
})
