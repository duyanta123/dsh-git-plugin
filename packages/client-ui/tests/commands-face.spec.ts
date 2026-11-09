/**
 * 命令面板/全局快捷键装配纯函数测试（V2 批次四 [51]；plan §6.6 命中分支——spike
 * 结论 found=true）。注册的服务面（ctx.commandUi / ctx.shortcuts）为宿主注入，
 * 本文件断言装配纯函数：贡献清单形状、活跃会话解析，以及**批次四评审修复**的
 * 快捷键 defaults 注册校验——dsh ShortcutRegistry 对六 profile 无条件校验
 * （registry.ts:88-97 实读），保留键/浏览器白名单/重叠任一命中即 throw 且穿出
 * ctx.effect 打断插件 apply；`shortcutDefaultIssue` 镜像（configuration.ts:94-115
 * / binding.ts:92-113 实读对齐）逐 profile 钉空 + 旧 KeyC/KeyG 组合回归钉。
 */

import { describe, expect, it } from 'vitest'
import {
  GIT_COMMAND_NAMES, GIT_SHORTCUT_IDS, activeSessionId, bindingsOverlap,
  gitCommandContributions, gitShortcutCommands, shortcutDefaultIssue,
} from '../src/client/commands-face.ts'
import type { ShortcutProfileName } from '../src/client/commands-face.ts'

describe('gitCommandContributions — \'/\' 菜单贡献（spike 结论 C）', () => {
  const contributions = gitCommandContributions({
    labelOpenChanges: '打开变更面板',
    labelOpenGraph: '提交图',
    openChanges: () => { /* 断言面不消费 */ },
    openGraph: () => { /* 断言面不消费 */ },
  })

  it('恰两条纯 UI 动作贡献，名字唯一且不带 \'/\'（与 host catalog 撞名 fail loud 的键）', () => {
    expect(contributions.map((item) => item.name)).toEqual([
      GIT_COMMAND_NAMES.openChanges,
      GIT_COMMAND_NAMES.openGraph,
    ])
    expect(contributions.every((item) => !item.name.startsWith('/'))).toBe(true)
    expect(contributions.every((item) => item.ui.kind === 'action')).toBe(true)
  })

  it('available 恒 true（无仓库时打开变更面板恰是 [8] 空态引导入口）', () => {
    expect(contributions.every((item) => item.available({ sessionId: 's1' }))).toBe(true)
  })

  it('run 以 session.sessionId 驱动 openChanges / 无参驱动 openGraph', () => {
    const seen: string[] = []
    const wired = gitCommandContributions({
      labelOpenChanges: 'changes',
      labelOpenGraph: 'graph',
      openChanges: (sessionId) => { seen.push(`changes:${sessionId}`) },
      openGraph: () => { seen.push('graph') },
    })
    wired[0]?.ui.run({ sessionId: 'abc' })
    wired[1]?.ui.run({ sessionId: 'abc' })
    expect(seen).toEqual(['changes:abc', 'graph'])
  })
})

describe('gitShortcutCommands — 全局快捷键（spike 结论 A）', () => {
  const commands = gitShortcutCommands({
    labelOpenChanges: 'changes',
    labelOpenGraph: 'graph',
    blockedNoSession: '没有打开的会话。',
    openChanges: () => { /* 断言面不消费 */ },
    openGraph: () => { /* 断言面不消费 */ },
    activeSessionId: () => null,
  })

  it('两条命令 id 点分形态；defaults 覆盖五 profile（web:linux 缺省省略）；regions/modals 显式', () => {
    expect(commands.map((command) => command.id)).toEqual([
      GIT_SHORTCUT_IDS.openChanges,
      GIT_SHORTCUT_IDS.openGraph,
    ])
    for (const command of commands) {
      // 评审修复（registry.ts:88-97 对六 profile 无条件校验）：web:linux 不在
      // isWebBindingAllowed 白名单（binding.ts:92-113 只认 Slash+primary /
      // Comma+primary+shift / Period+primary+shift）——default 缺省省略（缺 profile
      // 即注册跳过），与 ui-open-in-app/ui-layout 等 dsh 插件约定一致。
      expect(Object.keys(command.defaults).sort()).toEqual([
        'desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows',
      ].sort())
      expect(command.defaults['web:linux']).toBeUndefined()
      expect(command.regions.length).toBeGreaterThan(0)
      expect(Array.isArray(command.modals)).toBe(true)
    }
  })

  it('defaults 逐 profile 过 shortcutDefaultIssue 镜像校验（保留键/浏览器规则——全空才可注册）', () => {
    for (const command of commands) {
      for (const [profile, binding] of Object.entries(command.defaults)) {
        expect(shortcutDefaultIssue(profile as ShortcutProfileName, binding!)).toBeNull()
      }
    }
  })

  it('回归钉：旧 KeyC/KeyG 六 profile 组合的注册 throw 形态（评审二修正——首轮 throw 仅 desktop:linux/web:linux）', () => {
    // 旧 defaults（评审一修复前）：KeyC/KeyG + primary+shift × 六 profile。
    const oldChanges = { code: 'KeyC', modifiers: ['primary', 'shift'] } as const
    const oldGraph = { code: 'KeyG', modifiers: ['primary', 'shift'] } as const
    // **desktop:macos/windows 无条件提前放行**（configuration.ts:96——原生菜单加速器
    // 独占桌面双平台键盘）：保留键表在桌面双平台不生效，旧 KeyC 组合首轮 throw 只来自
    // desktop:linux（primary+KeyC 保留键——Ctrl+C 系统复制）。
    expect(shortcutDefaultIssue('desktop:macos', oldChanges)).toBeNull()
    expect(shortcutDefaultIssue('desktop:windows', oldChanges)).toBeNull()
    expect(shortcutDefaultIssue('desktop:linux', oldChanges)).toBe('reserved')
    // KeyG：web:linux 不在浏览器白名单 ⇒ registry 'Unsupported Web shortcut'
    // （binding.ts:92-113——其余五 profile 合法）。
    expect(shortcutDefaultIssue('web:linux', oldGraph)).toBe('unsupported-browser')
    expect(shortcutDefaultIssue('web:macos', oldGraph)).toBeNull()
    expect(shortcutDefaultIssue('web:windows', oldGraph)).toBeNull()
  })

  it('镜像校验的保留键表与白名单（configuration.ts:94-115 / binding.ts:92-113 对齐）', () => {
    // **desktop:macos/windows 旁路**（configuration.ts:96）：保留键/modifier-required
    // 对桌面双平台一律不判——无修饰、仅 shift、保留键族全部放行。
    for (const profile of ['desktop:macos', 'desktop:windows'] as const) {
      expect(shortcutDefaultIssue(profile, { code: 'KeyC', modifiers: ['primary'] })).toBeNull()
      expect(shortcutDefaultIssue(profile, { code: 'Enter', modifiers: [] })).toBeNull()
      expect(shortcutDefaultIssue(profile, { code: 'KeyE', modifiers: ['shift'] })).toBeNull()
      expect(shortcutDefaultIssue(profile, { code: 'Escape', modifiers: ['primary'] })).toBeNull()
      // chord 判在旁路之后（configuration.ts:97）——桌面双平台 chord 仍放行。
      expect(shortcutDefaultIssue(profile, { code: 'KeyE', modifiers: ['primary'], secondCode: 'KeyG' })).toBeNull()
    }
    // 校验真正生效的三个 profile：
    // primary + 系统保留字母族（C/V/X/Z/Y/Q/H）逐个 reserved；KeyA 无 shift 同保留。
    for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH']) {
      expect(shortcutDefaultIssue('desktop:linux', { code, modifiers: ['primary', 'shift'] })).toBe('reserved')
    }
    expect(shortcutDefaultIssue('desktop:linux', { code: 'KeyA', modifiers: ['primary'] })).toBe('reserved')
    expect(shortcutDefaultIssue('desktop:linux', { code: 'KeyA', modifiers: ['primary', 'shift'] })).toBeNull()
    // 无修饰键代码族；Enter 无 alt；仅 shift = modifier-required（desktop:linux/web:linux）。
    expect(shortcutDefaultIssue('desktop:linux', { code: 'Escape', modifiers: ['primary'] })).toBe('reserved')
    expect(shortcutDefaultIssue('desktop:linux', { code: 'Enter', modifiers: ['primary'] })).toBe('reserved')
    expect(shortcutDefaultIssue('desktop:linux', { code: 'KeyE', modifiers: ['shift'] })).toBe('modifier-required')
    // macos：alt 缺 primary 保留（Cmd 缺席的 Option 组合归系统）——桌面端被旁路掩盖，
    // 该规则只在 web:macos 可观测；web:macos 该组合不在双修允许规则内（缺 primary）。
    expect(shortcutDefaultIssue('web:macos', { code: 'KeyE', modifiers: ['alt', 'shift'] })).toBe('reserved')
    expect(shortcutDefaultIssue('web:macos', { code: 'KeyE', modifiers: ['primary', 'alt'] })).toBeNull()
    // web:linux 白名单恰三条；白名单外一律 unsupported-browser。
    expect(shortcutDefaultIssue('web:linux', { code: 'Slash', modifiers: ['primary'] })).toBeNull()
    expect(shortcutDefaultIssue('web:linux', { code: 'Comma', modifiers: ['primary', 'shift'] })).toBeNull()
    expect(shortcutDefaultIssue('web:linux', { code: 'Period', modifiers: ['primary', 'shift'] })).toBeNull()
    expect(shortcutDefaultIssue('web:linux', { code: 'KeyE', modifiers: ['primary', 'shift'] })).toBe('unsupported-browser')
    // web:macos/windows 双修 primary+shift 走允许规则（≥3 修饰亦放行）。
    expect(shortcutDefaultIssue('web:windows', { code: 'KeyE', modifiers: ['primary', 'shift'] })).toBeNull()
    expect(shortcutDefaultIssue('web:windows', { code: 'KeyE', modifiers: ['primary', 'shift', 'alt'] })).toBeNull()
    // chord（configuration.ts:97）：web/linux 形态判 unsupported-key。
    expect(shortcutDefaultIssue('web:linux', { code: 'KeyE', modifiers: ['primary'], secondCode: 'KeyG' })).toBe('unsupported-key')
  })

  it('本插件两条 default 绑定互不重叠（重叠 = 宿主注册 throw 的 client 侧预检）', () => {
    expect(commands).toHaveLength(2)
    const changes = commands[0]!
    const graph = commands[1]!
    const changesBinding = Object.values(changes.defaults)[0]!
    const graphBinding = Object.values(graph.defaults)[0]!
    expect(bindingsOverlap(changesBinding, graphBinding)).toBe(false)
    // 同命令跨 profile 同形——键位一致（user 改键前的缺省面）。Partial Record 的
    // values 含 undefined 型位（装配恒填满——非空断言只对齐类型面）。
    for (const binding of Object.values(changes.defaults)) {
      expect(bindingsOverlap(binding!, changesBinding)).toBe(true)
    }
    for (const binding of Object.values(graph.defaults)) {
      expect(bindingsOverlap(binding!, graphBinding)).toBe(true)
    }
  })

  it('changes 无活跃会话 ⇒ blocked（会话域地址无从打开）；graph 无会话也可打开', () => {
    expect(commands[0]?.resolve({ modal: null })).toEqual({
      status: 'blocked',
      reason: '没有打开的会话。',
    })
    expect(commands[1]?.resolve({ modal: null })).toEqual({ status: 'handled', run: expect.any(Function) })
  })

  it('有活跃会话 ⇒ changes handled 并以该会话运行', () => {
    let opened: string | null = null
    const wired = gitShortcutCommands({
      labelOpenChanges: 'changes',
      labelOpenGraph: 'graph',
      blockedNoSession: '没有打开的会话。',
      openChanges: (sessionId) => { opened = sessionId },
      openGraph: () => { /* 断言面不消费 */ },
      activeSessionId: () => 'sess-1',
    })
    const resolution = wired[0]?.resolve({ modal: null })
    expect(resolution).toEqual({ status: 'handled', run: expect.any(Function) })
    if (resolution?.status === 'handled') resolution.run()
    expect(opened).toBe('sess-1')
  })
})

describe('activeSessionId — 活跃会话解析（ui-open-in-app 同判据）', () => {
  it('retainedBy.mainView > 0 的行胜出；无 ⇒ null', () => {
    expect(activeSessionId({
      a: { id: 'a', retainedBy: { mainView: 1 } },
      b: { id: 'b', retainedBy: {} },
    })).toBe('a')
    expect(activeSessionId({
      b: { id: 'b', retainedBy: {} },
    })).toBeNull()
    expect(activeSessionId({})).toBeNull()
  })
})
