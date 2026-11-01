# @dsh-plugin/client-ui-git — `dsh.client` 契约字段对照 map（+ 目标清单样例包）

> 骨架阶段产出。权威来源：`docs/capability-spec.md` §⑦（下称【spec §⑦】）与
> `docs/notes/real-host-install-startup-test.md`（下称【runbook】）。凡标「runbook §x」
> 或「manifest.ts:y」者为该 runbook 实读 dsh 源码的转引；【spec §⑦】内再转引
> host-capability-map.md 的行号以「spec 转引」标注。
> 现行 `package.json` 是骨架最小可安装形态；本文件 §4 是「最小插件」阶段的**目标样例清单**
> （spec §⑦ 的 jsonc，range 已按本会话 `npm view` 实测回填可回填项）。

## 1. 字段逐项对照

| 清单字段 | 现行值 | 机制 / 权威 |
|---|---|---|
| `main` | `./lib/index.js` | Loader 按 `name` 导入包 main（spec §0.2-1；spec 转引 host-capability-map.md:89）。node 半最小入口（本包 `src/index.ts`，no-op 常量模块） |
| `exports["."]` | `./lib/index.*` | 同上；types 先行 |
| `exports["./client"]` | `./lib/client.*` | **声明了 `dsh.client` 就必须有 `./client` 导出**（spec §⑦ 清单注意，spec 转引 host-capability-map.md:76）；缺失时宿主直接报错 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`（runbook §3.C，实读 `packages/client/modules/src/index.ts:906`）。骨架阶段 lib/ 未产出 —— 只有把包装进宿主才触发该校验；构建产物随最小插件阶段落地 |
| `exports["./typert"]` | **（不恢复；④-A 落地记录 2026-10-31）** | 骨架阶段预留的 B2 产物位，最小插件阶段实测删除（exports 指向不存在产物会被 typert-loader 拒绝并阻断宿主就绪）。④-A 证实挂载机制存在（结局 A），但**生成产物落在 host 包**（generator 契约：host 面 `./typert` + `./remote`——generator/src/workspace.ts:122,142-148 实读；spec §0.4-1/B2 猜的"client 包 exports ./typert"形状与树内契约不符，按树源为准）：本包 `src/client/index.ts` 改为 `import gitRemote from '@dsh-plugin/git/remote'` 后 `ctx.remote.$mount(gitRemote)`（对照 api-remotes/client 静态挂载形态，packages/api/remotes/src/client/index.ts:14,203 实读），生成描述符内联进本包 bundle（`"git/ping"`/`"git/identity"` 方法键 + package 字段，verify-load 实测 served bundle 含两者） |
| `dsh.bundle.patch` | `./cordis.patch.yml` | `dsh plugin add` 时 reconcile 读该文件并把 insert 行自动追加进 `dsh.profile.bundles`（runbook §3.A 实测；§3.D 层序表） |
| `dsh.client.platform` | `"web"` | **必需字符串**（runbook §3.C，实读 `client/manifest.ts:179-180`）；client 面恒 web（spec §⑦，spec 转引 host-capability-map.md:66） |
| `dsh.client.inject` | 6 个包名（见下） | **信息性**（预检/HMR），不决定激活顺序（spec §⑦，spec 转引 host-capability-map.md:248）；可选字符串数组（runbook §3.C，manifest.ts:182-191）。逐项职责：`@dsh-plugin/git`=线路类型（**只 `import type`**，spec §0.2-1）；`dsh-client-ui-slots`=`ctx.slots.inject/register`（spec §3.1）；`dsh-client-ui-sidebar-right`=`sidebarRightTabs.register` + `openResource`（**注意 D8：包名带 `-right`**，spec 转引 host-capability-map.md:451）；`dsh-client-ui-primitives`=浮层/主题；`dsh-client-locale`=`locale.register/bind`（spec §④）；`dsh-client-store`=`defineStore`/`createSnapshotStore`（spec §3.2） |
| `dsh.client.immediately` | （不设） | 可选布尔（runbook §3.C，manifest.ts:182-191）；v1 无需立即装载 |
| `dsh.client.external` | （不设） | **基线 externals 不要写进来**：react/react-dom/@tanstack/react-virtual/@deepseek-ai/dsh-client-* 属 dsh 预置外部依赖（spec §⑦ 清单注意，spec 转引 host-capability-map.md:78）；`@tanstack/react-virtual` 进 devDependencies 走 npm（spec §3.3.3） |
| `files` | lib / cordis.patch.yml / LICENSE / NOTICE.md / THIRD_PARTY_NOTICES.md | 封闭覆盖全部运行时产物（spec §⑦，spec 转引 host-capability-map.md:77）；三份合规文件 = spec §5.2 发布要求 |
| `engines.dsh` | `>=0.2.1-rc.2` | spec §⑦；精确 range 施工期按宿主实际版本复核（runbook §6.7：树为 0.2.2-alpha.2 滚动版） |

## 2. client 半插槽与注入面（client 地基模块现状，spec §③）

- **现行 inject（client 地基模块 2026-10-31）**：`['slots', 'locale', 'remote', 'sidebarRightTabs', 'sidebarRight']` —— **不含 `remote.git`**：该命名空间由本插件自己 `ctx.remote.$mount` 挂载，声明注入会死锁（fiber 等依赖就绪才跑 apply，而 remote.git 在 apply 内才挂上；boot audit 形态见 dsh boot-client.ts assertEntriesActive 的 "pending (waiting for service…)"）。spec §3.1 清单里的 `remote.git` 项由此缺席（唯一偏差，openIssues 登记）。
- 注册面（已落地）：header 按钮 @ `conversation.session.header.utilities`（`ctx.slots.inject` + `ctx.slots.register({ name, id: 'dsh-plugin.git.header', order: -10, locale: NS, inject }, GitHeaderButton)`，inject 面 `hooks: { gitStatus: source.store }` 供渲染器合成选择器 hook + 三个动作 `openChangesPanel/openCommitDialog/syncNow`——后两个是占位）；两个右栏 tab **定义**已注册（`sidebarRightTabs.register` + `ctx.effect`：changes=git-changes/keepMounted:false、graph=git-graph/keepMounted:true，patterns `dsh-resource://dsh-plugin.git/**` + 逐地址 canOpen 认领）；tab **body**（keyed `sidebar.right.pane.tab` 两段第二段）在后续模块——pane body 缺注册时 sidebarRight 壳渲染自带 unavailable fallback（SidebarRight.tsx:221,243 实读），装配期安全。
- **F 变更面板模块更新（2026-10-31）**：变更审查 tab 的**会话域地址**落地——`dsh-resource://git-changes/session/{encodeURIComponent(sessionId)}`（铸造 `gitChangesAddress` + 严格解析 `parseGitChangesAddress`，照 ui-deliverables changes.ts:143-165 范式；取代 spec §3.1 的字面静态地址——同地址幂等由 contentId=address 承担，不同 Session 各自一个 tab）。changes 定义 patterns 改 `dsh-resource://git-changes/**` + canOpen=解析通过；graph 定义不变（两定义无共同 pattern）。tab **body** 已注册（keyed key=`dsh-plugin.git.changes`，`store: createChangesTabStore()` 范式 B + inject 面 hooks `{gitStatus, gitChanges}` + 动作 `loadDiff/stage/unstage/discard/refresh/dismissMutationError`）；提交图 body 仍缺注册（graph 模块）。header 的 openChangesPanel 改由 inject 工厂以框架解析的 sessionId 闭包铸造会话域地址（ui-renderer registry.ts runInject 实读：session scope 首参 = binding.key）。
- **RPC 面扩展（同上）**：`GitRpcFace` 增 `diff/stage/unstage/discard`（spec §3.2 GitRpcClient 切片）。host 写操作模块（mutations.ts，NOTICE.md「计划中」）落地前，生成 `git` 命名空间尚无后三个端点：调用在方法缺席处抛 TypeError，mount.ts 的 try/catch 折叠为 `gateway/service-unavailable`（诚实失败，UI 显示重试；不预声明行为的变更理由见 mount.ts 文件头）。devDependencies 增 `@deepseek-ai/dsh-client-ui-primitives`（link:D:/DeepSeekHarness/...）——FileDiffView 的 `useCodeHighlighter`/`languageForPath` 基线积木；运行期仍是浏览器注入 require 的基线模块（build-client.mjs EXTERNALS 既有项）。
- locale：`ctx.locale.register('git', { zh, en })`，zh+en 双语齐备强制（locales.ts 词典 + `declare module` 合并 LocaleNamespaceMap）；`check:locale` 门禁把关键集对齐与 JSX 无裸字符串。

## 3. 依赖解析现状（runbook §4.2.1 方案：registry 可达已验证 / `link:` 兜底）

本会话 `npm view` 实测（2026-10-31，registry PONG 可达）：

| 包 | dsh 树内版本（实读） | npm 最新（实测） | 决策 |
|---|---|---|---|
| `@dsh-plugin/git` | workspace 内 | —（本地包） | `workspace:*` 链接，仅 `import type`（现行 devDependencies 已含） |
| `react` / `@types/react` / `@tanstack/react-virtual` | 未读树内版本 | 未逐一核实 | **最小插件阶段**随 client 代码进 devDependencies（spec §⑦） |
| `@deepseek-ai/dsh-client-ui-slots` 等 5 个 | 树内 workspace 版 `0.2.2-alpha.2` | `0.0.1-rc.1` | **npm 快照明显落后于树** —— 不足以支撑 spec §③ 的类型面；最小插件阶段按 spec §0.4-2 回填：优先 `link:D:/DeepSeekHarness/packages/client/...`（runbook §4.2.1 方案），registry 快照仅作兜底 |

> 结论（如实）：client 包对 5 个 `dsh-client-*` 的类型依赖**现在不装**（现行 devDependencies 只有 `@dsh-plugin/git`），避免把 0.0.1-rc.1 旧类型面锁进骨架；这是对 spec §0.4-2「npm view 核实后回填」的执行结果，不是遗漏。
>
> **client 地基模块更新（2026-10-31）**：按本表 §4 的 link: 方案落地——devDependencies 新增
> `@deepseek-ai/cordis`（^4.0.6-alpha.1，与 host 对齐）与 5 个 `link:D:/DeepSeekHarness/packages/client/...`
> （store / ui-slots / locale / ui-sidebar-right / ui-renderer / ui-conversation——renderer 提供
> ctx.slots 的 Context 合并面，conversation 提供会话头工具槽的 SlotMap 合并面；运行期这些
> 包仍是浏览器注入 require 的基线模块，link: 只服务 typecheck 与 vitest）。

## 4. 目标样例清单（最小插件阶段落地的 package.json 形态；spec §⑦ jsonc + 本表已核实 range）

```jsonc
{
  // …骨架现行字段不变（main/exports/files/dsh/engines 见 §1）…
  "devDependencies": {
    "@types/react": "*",                      // 版本施工期对齐 dsh 树
    "react": "*",
    "@tanstack/react-virtual": "*",           // spec §3.3.3：基线模块直接 import，禁写进 dsh.client.external
    "@deepseek-ai/dsh-client-ui-slots": "link:D:/DeepSeekHarness/packages/client/ui-slots",
    "@deepseek-ai/dsh-client-ui-sidebar-right": "link:D:/DeepSeekHarness/packages/client/ui-sidebar-right", // D8：包名带 -right
    "@deepseek-ai/dsh-client-ui-primitives": "link:D:/DeepSeekHarness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-locale": "link:D:/DeepSeekHarness/packages/client/locale",
    "@deepseek-ai/dsh-client-store": "link:D:/DeepSeekHarness/packages/client/store",
    "@dsh-plugin/git": "workspace:*"          // 仅 import type；构建产物零 runtime 依赖
  }
}
```

> `link:` 目标以 dsh 树实际目录为准（`packages/client/<dir>`，与
> `tsconfig.base.json` paths 表同源，本会话实读）；若 dsh 树位置变化（runbook §6.7
> 滚动树风险），按 `link:` 失败再回落 registry 快照并复核类型面。

## 5. 构建产物与装载链路（预告，最小插件阶段）

- 构建预设：自写 `tsdown.client.config.ts`（闭包工厂产物 `window.__ModuleLoader__.load({id, factory})`，external 经注入 require 解析 —— runbook §3.C，实读 `packages/client/tsdown.client.ts:1-29`；树外不能 import dsh 预设，spec 转引 host-capability-map.md:77）。
- 装载：宿主运行时扫描 `dsh.client` 包并服务浏览器 bundle，重启入口或 patchReload 即生效，无需重建 web 前端（runbook §3.C，`client/modules/src/index.ts:1-25`）。
- 验证路径（runbook §5 作业单）：`dsh plugin --profile dbg add file:<abs>/packages/client-ui-git` → 启动 web 宿主 → 判据：页面源码含 `window.__DSH_BOOT__` 且 entries 含本包名；无 `did not activate`。
