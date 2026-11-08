/**
 * dsh-gitkit-ui — client 半（web 面）装配骨架（spec §3.1 组件清单与插槽映射）。
 *
 * 注册形态照 research/host-capability-map.md §3.2/§3.3 + dsh 树 HEAD ce7073d512
 * 实读的活例：
 *   - `packages/client/ui-open-in-app/src/client/index.ts:125-132`（header utilities
 *     注入：`ctx.slots.inject('conversation.session.header.utilities', () =>
 *     ctx.slots.register({ name, id, order, locale, inject }, Comp))`）；
 *   - `packages/client/ui-deliverables/src/client/index.ts:57-103`（tab 定义两段注册的
 *     第一段 `ctx.effect(() => ctx.sidebarRightTabs.register(definition))`；第二段
 *     keyed `sidebar.right.pane.tab` body 注册 `store: createXxxStore()` + inject 面
 *     `hooks` 隔间；`ctx.on('connection/reset')` 重置缓存）；
 *   - `packages/client/ui-deliverables/src/client/host-read-store.ts`（范式 A 数据缓存
 *     的 generation/reset 语义，map §3.4）。
 *
 * inject 清单（map §3.5 + spec §3.1，缺 `remote.git`——其由本插件自己 $mount，
 * 声明注入即装载死锁，见 remote/mount.ts 头注与 CONTRACT.md §2）。
 *
 * **不碰 `conversation.session.header.corner`**：那是 AppFrame header 的自留席位
 * （map §3.2），本插件只注册 `conversation.session.header.utilities`。
 */

// 唯一样式导入点（审查报告 §2.2 P2）：side-effect import 经 build-client.mjs 的
// dsh-git-css-inline 插件虚拟化 → 注入代码编译进 factory 闭包，materialization 时
// 执行、先于任何组件渲染（模块体副作用住在 factory 闭包内的 Lazy CJS 语义）。
import './styles/git.css'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Events['connection/reset'] 官方增强（dsh-client-connection/src/client/index.ts:26-31）——
// npm 发布面需显式引入该模块，声明合并才会进编译程序。
import type {} from '@deepseek-ai/dsh-client-connection/client'
// Context.remote 官方增强（gateway client installNamespace 的类型面，挂载见 remote/mount.ts）。
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// 会话头工具槽的 SlotMap 合并面（'conversation.session.header.utilities' 的声明处，
// ui-conversation/src/client/contract/slots.ts:235-239）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { GIT_GRAPH_ADDRESS, gitChangesAddress, parseGitChangesAddress } from './addresses.js'
import { createGitAdminFace } from './admin-face.js'
import type { GraphInjected } from './components/git-graph-tab.js'
import { GitGraphTab } from './components/git-graph-tab.js'
import { GitChangesTab } from './components/GitChangesTab.js'
import type { ChangesInjected } from './components/GitChangesTab.js'
import { GitHeaderButton } from './components/GitHeaderButton.js'
import { createCommitDialogFace } from './commit-dialog-face.js'
import { gitEn, gitZh, NS } from './locales.js'
import { createGitRpcClient, mountGitRemote } from './remote/mount.js'
import { createChangesTabStore } from './store/changes-tab-store.js'
import { createGitChangesStore } from './store/git-changes-store.js'
import { createGitGraphStore } from './store/git-graph-store.js'
import { createGraphTabStore } from './store/graph-tab-store.js'
import { createGitStatusSource } from './store/git-status-source.js'

/**
 * inject 清单（spec §3.1 的 `['slots','locale','remote','remote.git','sidebarRightTabs',
 * 'sidebarRight']` 去掉 `remote.git`——命名空间由本插件 apply 内 $mount，先声明先死锁；
 * 余项逐一到齐）。规则："may use only the dependencies named by its inject"。
 */
export const inject = ['slots', 'locale', 'remote', 'sidebarRightTabs', 'sidebarRight'] as const

/** locale 命名空间（spec §4；词典与 LocaleNamespaceMap 合并在 locales.ts 单点）。 */
export { NS } from './locales.js'

/**
 * Client 插件体：locale 词典 + Remote 命名空间挂载 + 状态源 + 变更面板缓存 + 提交图
 * 缓存 + tab 定义 + header 按钮 + 两个右栏 tab body（变更审查 / 提交图，多贡献
 * generator 注册）。数据缓存（状态源 / diff 缓存 / 图 log·refs·详情缓存）在 root
 * 作用域（apply 顶层创建 + ctx.effect 清理——map §3.4 句柄-作用域规则）；tab UI 态
 * 随槽位（createChangesTabStore / createGraphTabStore 范式 B，框架按会话铸实例）。
 */
export function apply(ctx: ClientContext): void {
  // ── locale 词典（zh+en 双语齐备强制，map §4.4）──
  ctx.effect(() => ctx.locale.register(NS, { zh: { ...gitZh }, en: { ...gitEn } }), 'dsh-plugin-git: dictionaries')
  const t = ctx.locale.bind(NS)

  // ── 数据面（范式 A，root 作用域）：状态源 + 变更面板 diff 缓存 + 提交图缓存 ──
  let rpcReady: (() => void) | null = null
  const mounted = new Promise<void>((resolve) => { rpcReady = resolve })
  const rpc = createGitRpcClient(ctx, mounted)
  const source = createGitStatusSource(rpc)
  const changesStore = createGitChangesStore(rpc, source)
  // 提交图缓存（F7 模块）：log 窗口 + refs + 详情；失效 = 状态订阅 branch.oid 变化。
  const graphStore = createGitGraphStore(rpc, source)
  // 提交对话框业务面（④-K）：commit/push/AI 生成/身份/HEAD 预取——header 与变更面板
  // 两个拉起方共享同一闭包（apply 顶层单例，无第二份状态）。
  const commitDialogFace = createCommitDialogFace(rpc)
  // 管理面业务面（V2 批次一）：分支/标签/worktree/远端/推送路由——header 按钮与
  // 提交图 tab（tag chip 菜单）共享同一闭包（commitDialogFace 同款单例纪律）。
  const adminFace = createGitAdminFace(rpc)
  ctx.on('connection/reset', () => {
    source.reset()
    changesStore.reset()
    graphStore.reset()
  })
  ctx.effect(() => async () => {
    source.dispose()
    changesStore.dispose()
    graphStore.dispose()
  }, 'dsh-plugin-git: client data stores')

  // ── remote.git 命名空间（④-A 生成产物）挂载；完成后开首代状态流 ──
  ctx.effect(async () => {
    const dispose = await mountGitRemote(ctx)
    rpcReady?.()
    source.start()
    return dispose
  }, 'dsh-plugin-git: remote.git mount')

  // ── 右栏 tab 定义（两段注册第一段；kind 不同 ⇒ 无冲突——spec §3.1）──
  // 变更审查 = 会话域地址 `dsh-resource://git-changes/session/{id}`：patterns 空间
  // `dsh-resource://git-changes/**`，canOpen 用严格解析认领（本插件铸造之外的形状
  // 一律拒绝；与提交图定义无共同 pattern，无 tie 问题）。
  const changesDefinition: SidebarRightTabDefinition = {
    id: 'dsh-plugin.git.changes',
    kind: 'git-changes',
    keepMounted: false,
    patterns: ['dsh-resource://git-changes/**'],
    priority: 'extension',
    canOpen: (address) => parseGitChangesAddress(address) !== undefined,
    title: () => t('tab.changes.title'),
  }
  const graphDefinition: SidebarRightTabDefinition = {
    id: 'dsh-plugin.git.graph',
    kind: 'git-graph',
    keepMounted: true, // 图重算昂贵（map §3.3；spec §3.1）
    patterns: ['dsh-resource://dsh-plugin.git/**'],
    priority: 'extension',
    canOpen: (address) => address === GIT_GRAPH_ADDRESS,
    title: () => t('tab.graph.title'),
  }
  ctx.effect(() => ctx.sidebarRightTabs.register(changesDefinition), 'dsh-plugin-git: changes tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register(graphDefinition), 'dsh-plugin-git: graph tab type')

  // ── C2/C3 两个 tab body @ sidebar.right.pane.tab（keyed；两段注册第二段）──
  // 多贡献 generator 形态（map §3.3 范本：ui-sidebar-right client/index.ts:204-243
  // ——单 inject 事务化安装两个 keyed 席位、逆序拆除）。graph 定义 keepMounted: true
  // （图重算昂贵，隐藏不卸载——map §3.3/spec §3.1）。
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', function* () {
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: 'dsh-plugin.git.changes',
      locale: NS,
      store: createChangesTabStore(),
      inject: (): ChangesInjected => ({
        hooks: {
          gitStatus: source.store,
          gitChanges: changesStore.store,
        },
        loadDiff: (scope, path) => { void changesStore.loadDiff(scope, path) },
        stage: (paths) => { void changesStore.stage(paths) },
        unstage: (paths) => { void changesStore.unstage(paths) },
        discard: (paths) => { void changesStore.discard(paths) },
        refresh: () => { source.refresh() },
        dismissMutationError: () => { changesStore.dismissMutationError() },
        commitDialog: commitDialogFace,
      }),
    }, GitChangesTab)
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: 'dsh-plugin.git.graph',
      locale: NS,
      store: createGraphTabStore(),
      inject: (): GraphInjected => ({
        hooks: {
          gitGraph: graphStore.store,
          gitStatus: source.store,
        },
        loadMore: () => { void graphStore.loadMore() },
        reload: () => { void graphStore.reloadLog() },
        refreshRefs: () => { void graphStore.refreshRefs() },
        showCommit: (oid, path) => { void graphStore.showCommit(oid, path) },
        // V2 批次一：tag chip 菜单（删 tag / 在该提交打标签）消费的管理面。
        admin: adminFace,
      }),
    }, GitGraphTab)
  }), 'dsh-plugin-git: tab bodies')

  // ── C1 GitHeaderButton @ conversation.session.header.utilities（spec §3.1 范本行）──
  // inject 工厂首参 = 框架解析的 sessionId（registry.ts runInject 实读：session scope
  // 传入 binding.key）——用它铸造会话域变更面板地址。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-plugin.git.header',
    order: -10,
    locale: NS,
    inject: (sessionId: string) => ({
      hooks: { gitStatus: source.store },
      openChangesPanel: () => { ctx.sidebarRight.openResource(gitChangesAddress(sessionId)) },
      openGraphPanel: () => { ctx.sidebarRight.openResource(GIT_GRAPH_ADDRESS) },
      // ④-K：提交…/提交并推送… 菜单项拉起 GitCommitDialog（portal 浮层，组件内开合）。
      commitDialog: commitDialogFace,
      // V2 批次一：管理面业务面 + R5 manual 刷新（fetch/branchSwitch 成功后的
      // ahead/behind 与图重载链路刷新——v1 的 syncNow 占位行已随批次一拆真移除）。
      admin: adminFace,
      refresh: () => { source.refresh() },
    }),
  }, GitHeaderButton))
}
