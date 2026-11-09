/**
 * dsh-gitkit-ui — 命令面板/全局快捷键的 client 注册面（V2 批次四 [51]；plan §6.6）。
 *
 * **spike 结论（found=true，本 ask 权威输入）**：dsh 有三个第三方插件可用的注册面——
 * (A) `ctx.shortcuts.register`（client 全局命令+快捷键，@deepseek-ai/dsh-client-shortcuts）、
 * (B) host 端 human-command 注册表 `ctx.commands.register`（'/' 面板的主目录——
 * **host 半落点**，提交/推送/拉取/获取/stash 等真实宿主动作归 host，本插件 client 半
 * 不注册）、(C) `ctx.commandUi.register`（client 端 '/' 菜单贡献，纯 UI 动作）。
 * 按 plan §6.6「命中 → 注册插件命令集」：client 半注册纯 UI 动作（打开变更面板 /
 * 提交图——spike 建议 ②）+ 全局快捷键（spike 建议 ③，只能 client 半做）。
 *
 * **类型面**：两个服务来自 dsh 客户端模块（宿主进程注入，包名在 package.json
 * `dsh.client.inject` 清单——ui-open-in-app 先例：packages/client/ui-open-in-app
 * /package.json:47）。本仓**不新增 devDependencies**（类型走本文件的结构化局部声明
 * ——零 bundle/锁文件影响，plan §0.4-5 零新增 client 运行期依赖；服务 API 形状按
 * DSH 树 dsh-v0.2.2-rc.1 实读对齐：shortcuts/src/client/types.ts ShortcutCommand、
 * ui-commands/src/client/contract.ts CommandContribution）。不 declare module 合并
 * Context（避免与未来安装的官方类型面冲突），调用点以局部交集类型取服务。
 *
 * **键位选择（v2 批次四评审修复）**：`ShortcutRegistry.register` 对**全部六
 * profile 无条件校验**（DSH 树 shortcuts/src/client/registry.ts:88-97 实读——
 * 与运行时无关，缺 profile 才跳过）且 throw 直接穿出 ctx.effect 打断插件 apply
 * （cordis fiber 语义）——default 绑定必须逐条通过三类规则（**desktop:macos/windows
 * 有无条件提前放行** configuration.ts:96——原生菜单加速器独占桌面双平台键盘，
 * 保留键表只在 web 三 profile 与 desktop:linux 生效）：
 *   ① 保留键（configuration.ts:103-112）：primary(macOS=meta/其余=control) +
 *   KeyC/KeyV/KeyX/KeyZ/KeyY/KeyQ/KeyH 与无修饰键代码（Escape/Tab/Space/Backspace/
 *   Delete/箭头/无 alt 的 Enter 等）一律 reserved——**Ctrl/Cmd+C 已是复制**，
 *   KeyC 不可用；② 浏览器允许规则（binding.ts:92-113 isWebBindingAllowed）：
 *   web:linux 只认三条白名单（Slash+primary / Comma+primary+shift /
 *   Period+primary+shift），其余组合一律 'unsupported-browser'——**web:linux
 *   default 缺省省略**（ui-open-in-app / ui-layout / ui-settings-general 等
 *   dsh 插件的既定约定，缺 profile 即注册跳过）；web:macos/windows 双修饰需
 *   primary+alt 或 primary+shift；③ 与既有 dsh 命令 defaults 重叠（重叠即
 *   'Conflicting shortcut defaults' throw——全量对照见 tests/commands-face.spec）。
 * 终选：Ctrl/Cmd+Shift+E（变更）/ Ctrl/Cmd+Shift+G（提交图），desktop 三
 * profile + web:macos/windows 五 profile。regions/modals 显式声明（漏声明
 * 键盘触发会被 blocked——spike 注记）。
 *
 * 断言面 = tests/commands-face.spec.ts（activeSessionId / 贡献清单形状 /
 * defaults 逐 profile 过 `shortcutDefaultIssue` 镜像校验 / 旧 KeyC 六 profile
 * 组合的回归钉）。
 */

// ── 结构化服务面（dsh-client-shortcuts / dsh-client-ui-commands 的消费子集）────

/** ShortcutCommand 的消费子集（shortcuts/src/client/types.ts:20-42 实读对齐）。 */
export interface ShortcutCommandFace {
  /** brand 类型在宿主侧；本面以 string 承载（运行期即字符串 id）。 */
  readonly id: string
  readonly label: () => string
  readonly aliases: readonly string[]
  readonly defaults: Readonly<Partial<Record<string, { code: string; modifiers: readonly string[] }>>>
  readonly regions: readonly ('page' | 'editable' | 'terminal')[]
  readonly modals: readonly string[]
  resolve(context: { readonly modal: string | null }): { status: 'handled'; run(): void } | { status: 'blocked'; reason: string } | { status: 'pass' }
}

/** CommandContribution 的消费子集（ui-commands/src/client/contract.ts:101-127 实读对齐）。 */
export interface CommandContributionFace {
  /** 不带 '/' 的命令名（全贡献唯一；与 host catalog 撞名 fail loud）。 */
  readonly name: string
  label?(): string
  description?(): string
  available(session: { readonly sessionId: string }): boolean
  readonly ui: { readonly kind: 'action'; run(session: { readonly sessionId: string }): void }
}

/** ctx.sessions.list 快照的消费子集（api-session-controller sessions.ts 实读对齐）。 */
export interface SessionsListFace {
  list: {
    getSnapshot(): {
      byId: Readonly<Record<string, { readonly id: string; readonly retainedBy?: { readonly mainView?: number } }>>
    }
  }
}

/** 本插件 client 半实际使用的三个注入服务的交集面（apply 调用点窄化用）。 */
export interface GitPaletteContext {
  readonly shortcuts: {
    register(command: ShortcutCommandFace): () => void
  }
  readonly commandUi: {
    register(contribution: CommandContributionFace): () => void
  }
  readonly sessions: SessionsListFace
}

// ── 纯决策半 ──────────────────────────────────────────────────────────────────

/** 打开变更面板 / 提交图两个贡献的命令名（与 host catalog 撞名 fail loud 的唯一键）。 */
export const GIT_COMMAND_NAMES = {
  openChanges: 'git-changes',
  openGraph: 'git-graph',
} as const

/**
 * '/' 菜单贡献清单装配（纯函数；labels 就地取词条——label() 每次 candidate pass
 * 重读，locale 变化下一开菜单即生效，ui-commands 契约注记）。available 恒 true：
 * 无仓库时打开变更面板恰是空态引导卡片的入口（[8]），禁用反而挡住引导。
 */
export function gitCommandContributions(params: {
  labelOpenChanges: string
  labelOpenGraph: string
  openChanges(sessionId: string): void
  openGraph(): void
}): CommandContributionFace[] {
  return [
    {
      name: GIT_COMMAND_NAMES.openChanges,
      label: () => params.labelOpenChanges,
      available: () => true,
      ui: {
        kind: 'action',
        run: (session) => { params.openChanges(session.sessionId) },
      },
    },
    {
      name: GIT_COMMAND_NAMES.openGraph,
      label: () => params.labelOpenGraph,
      available: () => true,
      ui: {
        kind: 'action',
        run: () => { params.openGraph() },
      },
    },
  ]
}

/** 全局快捷键的两条命令（id 用 dsh 习惯的点分形态；spike 建议 ③ 示例同款）。 */
export const GIT_SHORTCUT_IDS = {
  openChanges: 'git.changes.open',
  openGraph: 'git.graph.open',
} as const

/**
 * 全局快捷键清单装配（纯函数）。defaults = desktop 三 profile + web:macos/windows
 * 五 profile（**web:linux 缺省省略**——dsh 注册器对六 profile 无条件校验、web:linux
 * 只认三条白名单，缺 profile 即注册跳过；dsh 插件既定约定，见头注②）。键位
 * KeyE/KeyG + primary+shift：逐 profile 过 `shortcutDefaultIssue` 镜像校验
 * （保留键/浏览器规则/既有命令重叠三类——tests/commands-face.spec 断言空 issues）。
 * regions 含 'editable'（输入框聚焦时仍可打开面板）；modals 空（无模态内触发面）。
 * resolve 的 no-session 分支：changes 面板地址是会话域（无会话无从打开）⇒ blocked；
 * graph 地址静态 ⇒ 无会话也可打开。
 */
export function gitShortcutCommands(params: {
  labelOpenChanges: string
  labelOpenGraph: string
  blockedNoSession: string
  /** 打开变更面板（apply 半已解析 active session；null = 无会话）。 */
  openChanges(sessionId: string | null): void
  openGraph(): void
  /** 活跃会话解析（apply 半注入——activeSessionId 消费 ctx.sessions 快照）。 */
  activeSessionId(): string | null
}): ShortcutCommandFace[] {
  const changesDefaults = { code: 'KeyE', modifiers: ['primary', 'shift'] } as const
  const graphDefaults = { code: 'KeyG', modifiers: ['primary', 'shift'] } as const
  return [
    {
      id: GIT_SHORTCUT_IDS.openChanges,
      label: () => params.labelOpenChanges,
      aliases: ['open git changes', 'git changes panel'],
      defaults: {
        'desktop:macos': changesDefaults,
        'desktop:windows': changesDefaults,
        'desktop:linux': changesDefaults,
        'web:macos': changesDefaults,
        'web:windows': changesDefaults,
      },
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => {
        const sessionId = params.activeSessionId()
        if (sessionId === null) return { status: 'blocked', reason: params.blockedNoSession }
        return { status: 'handled', run: () => { params.openChanges(sessionId) } }
      },
    },
    {
      id: GIT_SHORTCUT_IDS.openGraph,
      label: () => params.labelOpenGraph,
      aliases: ['open git graph', 'commit graph'],
      defaults: {
        'desktop:macos': graphDefaults,
        'desktop:windows': graphDefaults,
        'desktop:linux': graphDefaults,
        'web:macos': graphDefaults,
        'web:windows': graphDefaults,
      },
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => { params.openGraph() } }),
    },
  ]
}

// ── dsh ShortcutRegistry 注册校验的 client 侧镜像（评审修复回归钉）────────────
// 规则源 = DSH 树 shortcuts/src（configuration.ts:94-115 bindingIssue——**含 :96 的
// desktop windows/macos 无条件提前放行**、binding.ts:92-113 isWebBindingAllowed、
// client/registry.ts:88-97 逐 profile 校验）。本插件 defaults 只用「单键 + modifiers」
// 形态（无 secondCode/chord——镜像仍覆盖 :97 的 unsupported-key 判，前向完备）；
// dsh 规则演进时同步此处与 tests/commands-face.spec 的钉。

/** ShortcutRegistry 逐 profile 校验的六 profile 键域（本文件 defaults 的子集面）。 */
export type ShortcutProfileName = 'desktop:macos' | 'desktop:windows' | 'desktop:linux' | 'web:macos' | 'web:windows' | 'web:linux'

/** profile 的主修饰键（dsh binding.ts：macos=meta，其余=control）。 */
function primaryModifierOf(profile: ShortcutProfileName): string {
  return profile === 'desktop:macos' || profile === 'web:macos' ? 'meta' : 'control'
}

/** modifiers 规范展开（'primary' → profile 主修饰键——registry 先 normalize 再校验）。 */
function expandedModifiers(profile: ShortcutProfileName, modifiers: readonly string[]): string[] {
  const primary = primaryModifierOf(profile)
  return modifiers.map((modifier) => (modifier === 'primary' ? primary : modifier))
}

/** isWebBindingAllowed 镜像（binding.ts:92-113；本镜像单键子集——secondCode 恒无）。 */
function webBindingAllowed(profile: ShortcutProfileName, expanded: readonly string[], code: string): boolean {
  const platform = profile.split(':')[1] ?? 'linux'
  const primary = primaryModifierOf(profile)
  if (platform === 'windows' || platform === 'macos') {
    if (expanded.length >= 3) return true
    if (expanded.length === 1
      && ((['Comma', 'Backslash'].includes(code) && expanded[0] === primary)
        || (code === 'Backquote' && expanded[0] === 'control'))) return true
    if (expanded.length === 2 && expanded.includes(primary)
      && (expanded.includes('alt') || expanded.includes('shift'))) return true
  }
  // web:linux（与 windows/macos 的落名单路径）只认三条白名单——primary 按 profile 展开。
  const whitelist: ReadonlyArray<{ code: string; modifiers: readonly string[] }> = [
    { code: 'Slash', modifiers: [primary] },
    { code: 'Comma', modifiers: [primary, 'shift'] },
    { code: 'Period', modifiers: [primary, 'shift'] },
  ]
  return whitelist.some((candidate) => candidate.code === code
    && candidate.modifiers.length === expanded.length
    && candidate.modifiers.every((modifier) => expanded.includes(modifier)))
}

/**
 * 单条 default 绑定在一个 profile 上的注册校验（bindingIssue 镜像，返回与 dsh 同名
 * 的 issue 串；null = 通过）。registry 对六 profile 无条件逐个校验（缺 profile 跳过），
 * 任一非 null 即注册 throw、穿出 ctx.effect 打断插件 apply——装配半必须保证全空。
 * **判定序含 dsh 的 desktop windows/macos 无条件提前放行**（configuration.ts:96，
 * 批次四评审二修复——原生菜单加速器独占桌面双平台键盘，校验只对 web/linux 生效）。
 */
export function shortcutDefaultIssue(
  profile: ShortcutProfileName,
  binding: { code: string; modifiers: readonly string[]; secondCode?: string },
): string | null {
  const runtime = profile.startsWith('desktop') ? 'desktop' : 'web'
  const platform = profile.split(':')[1] ?? 'linux'
  // desktop + windows/macos 无条件放行（configuration.ts:96——bindingIssue 首行）。
  if (runtime === 'desktop' && (platform === 'windows' || platform === 'macos')) return null
  // chord 双键（configuration.ts:97）。
  if (binding.secondCode !== undefined) return 'unsupported-key'
  const modifiers = expandedModifiers(profile, binding.modifiers)
  const hasPrimary = modifiers.includes(primaryModifierOf(profile))
  // modifier-required（configuration.ts:100）。
  if (modifiers.length === 0 || modifiers.every((modifier) => modifier === 'shift')) return 'modifier-required'
  // windows/macos 三修饰以上直接放行（configuration.ts:101）。
  if ((platform === 'windows' || platform === 'macos') && modifiers.length >= 3) return null
  // web + windows/macos + 允许规则放行（configuration.ts:102）。
  if (runtime === 'web' && (platform === 'windows' || platform === 'macos') && webBindingAllowed(profile, modifiers, binding.code)) return null
  // 保留键（configuration.ts:103-112——判定序照抄 bindingIssue）。
  if (['Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(binding.code)
    || (binding.code === 'Enter' && !modifiers.includes('alt'))
    || (hasPrimary && ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH'].includes(binding.code))
    || (hasPrimary && binding.code === 'KeyA' && !modifiers.includes('shift'))
    || (platform !== 'macos' && (modifiers.includes('meta') || (modifiers.includes('alt') && ['F4', 'F2'].includes(binding.code))))
    || (platform === 'macos' && modifiers.includes('control') && modifiers.includes('meta'))
    || (platform === 'macos' && modifiers.includes('alt') && !hasPrimary)) return 'reserved'
  // 浏览器允许规则（configuration.ts:113——web:linux 白名单外的组合一律拒绝）。
  if (runtime === 'web' && !webBindingAllowed(profile, modifiers, binding.code)) return 'unsupported-browser'
  return null
}

/**
 * 活跃会话解析（ui-open-in-app/ui-workspace 同款判据：retainedBy.mainView > 0 =
 * 主视图保留中的会话；无 ⇒ null）。纯函数——输入是快照投影，便于测试。
 */
export function activeSessionId(byId: Readonly<Record<string, { readonly id: string; readonly retainedBy?: { readonly mainView?: number } }>>): string | null {
  for (const row of Object.values(byId)) {
    if ((row.retainedBy?.mainView ?? 0) > 0) return row.id
  }
  return null
}

/**
 * 两条 default 绑定是否重叠（纯判定——registry.register 的重叠 throw 的 client 侧
 * 预检，tests/commands-face.spec 用它断言本插件两条快捷键互不重叠；跨插件重叠由
 * 宿主注册时 fail loud 兜底）。形状 = 规范化 index 同法（modifiers + codes 排序拼接）。
 */
export function bindingsOverlap(
  a: { code: string; modifiers: readonly string[] },
  b: { code: string; modifiers: readonly string[] },
): boolean {
  const key = (binding: { code: string; modifiers: readonly string[] }): string =>
    [...binding.modifiers].slice().sort().join('+') + '+' + [binding.code].sort().join('+')
  return key(a) === key(b)
}
