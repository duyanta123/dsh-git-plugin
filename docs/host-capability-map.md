# dsh 宿主能力地图（dsh-git 插件施工版）

> 收敛自六路读者笔记 + 调研报告，2026-10-29。用途：后续施工（建包 / RPC / UI / 基础设施 / 调试 / 移植）只看这一份即可定位机制与证据。
> 来源材料（除【移植源】外均在**外层工作区 `research/`** 下，未入库、仅本机）：`research/notes/plugin-form.md`（下称【形态】）、`research/notes/rpc-services.md`（【RPC】）、`research/notes/ui-slots.md`（【UI】）、`research/notes/infra.md`（【基建】）、`research/notes/real-host-install-startup-test.md`（【宿主调试】）、`docs/ported-sources/SOURCES.md`（【移植源】）、调研报告 `research/dsh-git-plugin-research-report.md`（【报告】）。

**版本口径**（重要，影响所有行号引用）：

| 材料口径 | commit | 说明 |
|---|---|---|
| 【报告】 | 0.2.1-rc.3（浅克隆，2026-10-23） | 报告的全部行号按 rc.3 |
| 【形态】【UI】 | `687f282e86` = tag `dsh-v0.2.1-rc.2`（经 `git show` pin 读取） | 引用标注 `@687f282e86` |
| 【RPC】【基建】【宿主调试】 | `f3803c9697` = 0.2.2-alpha.2 工作树 HEAD | 引用标注 `@HEAD` |

本会话实测：`git merge-base --is-ancestor 687f282e86 HEAD` 退出码 0 ⇒ **rc.2 是 alpha.2 的祖先**；`git diff --stat 687f282e86 HEAD` 对【基建】所涉 9 个关键文件仅 `fs-local/src/index.ts` 一处无关差异（【基建】§0）。

**引用约定**：`D:\DeepSeekHarness\<path>:<line>`（dsh 源码绝对路径；后缀 `@687f282e86` 表示该行号是 rc.2 pin 的行号，否则为 alpha.2 工作树行号）；`【X】§n` 表示结论出自读者笔记第 n 节。标注 ✅核 的条目为本会话在 alpha.2 工作树实读核对过（命令与位置见各节）；其余行号来自读者笔记、未在本会话重读。

---

## ① 插件形态与加载机制

### 1.1 四层概念【形态】§一

| 层 | 载体 | 关键声明 |
|---|---|---|
| plugin | 一个 npm 包入口模块，导出 `apply/inject/Config/name` | `D:\DeepSeekHarness\vendor\cordis\src\registry.ts@687f282e86:32-74` |
| bundle | package.json 声明 `dsh.bundle.patch` → cordis.patch.yml | `D:\DeepSeekHarness\packages\bundle\base\package.json@687f282e86` |
| profile | `$DSH_HOME/profiles/<name>/`，`dsh.profile.bundles` 有序 bundle 列表 + 自己的 cordis.patch.yml | `D:\DeepSeekHarness\packages\boot\app-boot\README.md@687f282e86:51` |
| client 浏览器插件 | 同一包的 `./client` 导出 + `dsh.client` 清单 | `D:\DeepSeekHarness\packages\client\AGENTS.md@687f282e86:146-148` |

链路：bundle 的 cordis.patch.yml 往配置树插"行"（id+name+config）→ Loader 按 `name`（=包名）导入包入口并校验 Config → 带 `dsh.client` 的包被编入 `window.__DSH_BOOT__` 启动图并经 `/plugins/<id>/client.js` 供浏览器懒加载（【形态】§一）。

### 1.2 包结构决策：单包双导出（【形态】§六，结论）

**采用单包双导出**：一个包 = node 半（GitService + Config）+ `./client` 半（React UI）+ 自带 `dsh.bundle.patch` + locale/icon。依据：
- 官方第三方模板 decoration 即此形态（`D:\DeepSeekHarness\packages\preset\agent-preset\skills\cordis-plugin-development\templates\decoration\package.json@687f282e86`）；plugin-manager 全链路（inspect/install/compatibility，按 `package-name@version` 记豁免，`D:\DeepSeekHarness\packages\boot\plugin-manager\README.md@687f282e86:71`）按单包设计；
- host↔client 线路类型可包内 `import type` 共享；feature 插件禁止 runtime-import 另一 feature 插件的值（`D:\DeepSeekHarness\packages\client\AGENTS.md@687f282e86:40`）；
- 树内三个先例覆盖全部需求：ui-cordis（纯 UI 单包双导出）、decoration 模板（UI+bundle）、dsh-client-connection（双端逻辑单包）（【形态】§6.1）。
- 风险预案：host 半将来要独立交付 headless/TUI 时，沿 `src/index.ts`（node）与 `src/client/`（browser）目录边界拆包（【形态】§6.3）。

### 1.3 package.json 必需字段

**Host-only 最小形态**（【形态】§2.1 + 【宿主调试】§3.A 实测通过的形态）：

```jsonc
{
  "name": "dsh-git", "version": "0.0.1", "private": true, "type": "module",
  "main": "./lib/index.js",                       // 或 exports["."]
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**双导出完整形态**（对照 `D:\DeepSeekHarness\packages\extensions\ui-cordis\package.json@687f282e86`，【形态】§3.1）：

```jsonc
{
  "type": "module", "main": "lib/index.js",
  "exports": {
    ".":        { "types": "...", "default": "./lib/index.js" },
    "./client": { "types": "...", "default": "./lib/client.js" },
    "./locale/*.json": "./locale/*.json", "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",                          // 恒定 web，桌面端也用 web 面
      "inject": ["<依赖的 dsh client 包名，原样全名>"]   // 信息性：仅预检展示与 HMR diff，不决定激活顺序
    }
  },
  "files": ["lib/index.js", "lib/client.js", "lib/types/**/*.d.ts", "locale/*.json", "cordis.patch.yml"]
}
```

硬规则：
- **版本准入**：装到 profile 时检查 DSH 要求——声明 `engines.dsh` 则只看它；否则每个 `peerDependencies` 中 `@deepseek-ai/dsh*` range 都必须匹配（`D:\DeepSeekHarness\packages\boot\app-boot\README.md@687f282e86:52-53`）。树外包 peer 范围写真实 range，不写 `workspace:*`（【形态】§2.1）。
- **声明 `dsh.client` 就必须有 `./client` 导出**，扫描时没有直接抛错：`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`（`D:\DeepSeekHarness\packages\client\modules\src\index.ts:906`，✅核）。
- `files` 必须封闭覆盖所有运行时产物（`AGENTS.md@687f282e86:71`）；client 产物 `lib/client.js` 必须是**闭包工厂**——调用 `window.__ModuleLoader__.load({id, factory})`、external 经注入 require 解析（`D:\DeepSeekHarness\packages\client\tsdown.client.ts@687f282e86:1-8`）。树外不能 import 仓库的 `tsdown.client.ts` 预设，需自写等价 tsdown 配置（【形态】§3.4）。
- 基线 externals（`D:\DeepSeekHarness\packages\client\web\src\platform.ts:8-15`，✅核）：`react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod, @tanstack/react-virtual, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit`——对每个动态 bundle 隐式外部化，**不要**重复声明进 `dsh.client.external`；feature 插件的第三方实现库直接打进自己 bundle（`AGENTS.md@687f282e86:80-85`）。
- 依赖分面：浏览器-only 第三方库进 `devDependencies`（打进 bundle 或作基线 external）；node 半值依赖按类进 `dependencies`（`AGENTS.md@687f282e86:65-71`）；`@deepseek-ai/schemastery` 进 `dependencies`（【形态】§2.2）。插件运行时 import 尽量只有 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`（本机 `C:\Users\duyan\.dsh\profiles\node_modules` 提升树已含，【宿主调试】§3.A）。

### 1.4 cordis.patch.yml 条目（【形态】§四 + 【宿主调试】§3.D）

两类结构：

```yaml
# 1) 插入（bundle 层 / --patch overlay）
- insert:
    - id: dsh-git
      name: 'dsh-git'          # name = 包名 → Loader 导入该包 main
      # config: {...}  disabled: bool/!!js  inject: [服务名] 均可选
# 2) id 覆盖（profile 层 / 覆盖 bundle 行）
- id: tool-bash
  disabled: true
```

三条合并语义（`D:\DeepSeekHarness\packages\bundle\base\cordis.patch.yml:1-14`，✅核）：
1. **整行寻址，last-write-wins**（base patch :1-4）；
2. **config 整块替换、不深合并**（:5-8 "A patch replaces the targeted row's whole `config` rather than merging into it"）——覆盖一个键要复述想保留的其他键，略去的键回落 schema 默认（§1.6）；
3. **行顺序无加载语义**，激活由服务可用性驱动（:12-13）。

层序（【宿主调试】§3.D）：bundle 层（按 `dsh.profile.bundles` 顺序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（argv 序）。覆盖不存在的行 → stderr 警告；空 patch 文件会启动失败，禁用某层写 `[]`（`app-boot\README.md@687f282e86:62`）。`dsh.client` 行同时是宿主行与浏览器花名册（`D:\DeepSeekHarness\packages\bundle\web-app\cordis.patch.yml@687f282e86:41-43`）。

### 1.5 安装与组装（【形态】§五 + 【宿主调试】§3.A）

- profile 组装：`dsh.profile.bundles` 有序数组 → 各 bundle 的 `dsh.bundle.patch`（文件或有序列表）按序拼接 → profile patch → home patch → `--patch`（`app-boot\README.md@687f282e86:51,62`）。bundle 失败跳过记 `skippedBundles`，profile/用户 patch 错误仍启动失败（:51）。
- 安装途径：`dsh plugin --profile <name> add <spec>`（本质 = 在 profile 目录跑 pnpm，`D:\DeepSeekHarness\apps\cli\src\plugin.ts:71-108`）；spec 支持 registry/别名/**git 地址**/`file:`/`link:`（`D:\DeepSeekHarness\packages\boot\plugin-manager\src\install-spec.ts:69-92,111-123`；相对路径被拒 :61-77）。安装落点 = profile 目录 `node_modules`（实盘验证）。
- **新依赖自动激活**：`reconcile()` 对每个新依赖读其 `dsh.bundle` 清单并自动追加进 `dsh.profile.bundles`（`D:\DeepSeekHarness\packages\boot\plugin-manager\src\operations.ts:90-122`，【宿主调试】§3.A 实测：file: 安装后 bundles 自动出现包名）。
- 开发态用 `link:<绝对目录>`（改源码即生效，仍需重建 lib+重启，【宿主调试】§3.A）。

### 1.6 插件 Config（schemastery）（【形态】§七）

- 声明：类插件 `static Config: z<Config> = z.object({...})`（范例 `D:\DeepSeekHarness\packages\boot\plugin-manager\src\index.ts@687f282e86:209-218`）；函数插件 `export const Config = z.object({...})`。`z` 来自 `@deepseek-ai/schemastery`；Config 是 Standard Schema V1（`vendor\cordis\src\registry.ts@687f282e86:44-45`）；热更新豁免字段 `.volatile()`（`vendor\loader\src\config\diff.ts@687f282e86:43`）。
- 默认值合并在 **schema 校验时**发生：`resolveConfig`（`vendor\cordis\src\fiber.ts@687f282e86:50-62`）——最终 row config（最高优先层整块写的那份）里缺失的、schema 声明了 `.default()` 的键由 schemastery 填默认。
- **client 半的 Config 不会生效**：启动图 `WebBootEntry = { id, url, rev, inject?, immediately?, external? }` 不携带 config，浏览器行以 `{name: id}` 无 config 创建（`packages\client\modules\src\client\manifest.ts@687f282e86:52-68`；`entries.ts@687f282e86:181-183`）。⇒ **git 插件全部运行期配置放 host 半 Config**；client 要读走 configForms/Remote 投影或由 host RPC 下发（【形态】§7.3）。

### 1.7 浏览器加载链（【形态】§3.3）

node 半扫描 enabled Loader entries 组合 boot graph 注入 `window.__DSH_BOOT__`（`packages\client\modules\README.md@687f282e86:12,34`）→ `apps/web/src/main.ts@687f282e86:20` → `bootClient`（`packages\client\web\src\boot-client.ts@687f282e86:36-56`）对每行 `loader.create({name: id})` → 浏览器懒加载 `/plugins/<id>/client.js` 执行闭包工厂。client bundle 增量装载是**运行时**行为，不需重建 web 前端（`packages\client\modules\src\index.ts:1-25,678-699`，【宿主调试】§3.C）。

---

## ② RPC 契约

### 2.1 服务声明（【RPC】§1）

标准形态（两官方范例同构：`D:\DeepSeekHarness\packages\extensions\cordis-host-runner\src\index.ts:95-162,1290` 与 `D:\DeepSeekHarness\packages\boot\plugin-manager\src\index.ts:312-382,1345`）：

```ts
declare module '@deepseek-ai/cordis' { interface Context { git: GitService } }   // Context 扩充
export class GitService extends TypertRemoteService {   // 基类 D:\DeepSeekHarness\packages\typert\protocol\src\index.ts:250-264 ✅核
  static inject = ['subprocess', 'fs', 'llm']           // fiber 等全部依赖可用才激活（node_modules/@deepseek-ai/cordis/src/fiber.ts:611-623）
  static Config: z<Config> = z.object({...})            // schemastery
  constructor(ctx: Context, config: Config) {
    super(ctx, 'git')   // serviceKey 字面量 = Cordis 注册名 = wire namespace（端点 git/status）
  }
  // @Remote 方法……
}
export default GitService                                // 文件尾，无工厂包装
```

- 基类构造把 `typertRemote = { service, serviceKey, namespace }` frozen 绑定挂上（`packages\typert\protocol\src\index.ts:236-247,250-264`，✅核）；Service 构造即 `ctx.reflect.provide` 完成注册（`node_modules/@deepseek-ai/cordis/src/service.ts:42-59`）。
- serviceKey/namespace 须过 `isTypertRemoteSegment`（`/^[A-Za-z0-9_$.-]+$/`，`packages\typert\protocol\src\index.ts:24,31-33,484-488`）——`git` 合法。
- `this.ctx.invocation` 可读本次调用的 `RemoteInvocation`（peer/signal/request/uplink，`packages\typert\protocol\src\index.ts:272-275,498-524`）。
- **第三方包 strict 描述符自动注册**：包 exports 带 `./typert`（`TYPERT_HOST_EXPORT`，`D:\DeepSeekHarness\packages\typert\loader\src\index.ts:1-16,41`）则 loader 自动把 host 面 TYPERT 清单注册进 `ctx.typert`、卸载时撤销；对照产物 `D:\DeepSeekHarness\packages\extensions\cordis-host-runner\lib\typert.host.js` 与 `lib\typert.remote-client.js`（typert-generator 生成，勿手编）。

### 2.2 方法暴露：只有 `@Remote` 装饰的方法（【RPC】§2，纠正报告）

- **public 方法不会自动暴露**。装饰器 `Remote`（`packages\typert\protocol\src\index.ts:282-317`：裸 / `Remote('导出名')` / `Remote({name?, mode?, resources?})`）把 marker 记到类原型描述符（:224,433-435,446-476）。实证：cordis-host-runner 12 个 `@Remote` 方法与生成产物 `lib\typert.remote-client.js` 的 methods 表精确一一对应（产物行 362/434/…/1113）；未装饰方法（`define/run/stop/snapshot` 等）宿主内部可见、client 不可见。
- 派发两模式（`resolveDescriptor`，`D:\DeepSeekHarness\packages\api\gateway\src\index.ts:878-889`）：strict（`ctx.typert.local` 生成产物）优先；SRC 源码反射兜底（`Function.prototype.toString` 抠参数名，:1586-1628——**参数必须是唯一标识符，禁解构/默认值/rest**；`signal` 作最后参数识别为取消信号且不入 wire，:853,926-937）。**client 只认 strict**（`packages\api\gateway\src\client\index.ts:803-818` `requireStrictInputs`）。
- Host 对象参数（`agent: Agent`）经 lookup 变 wire 身份（如 `agentId`）；**git 方法不需要 agent 归属就不声明 Agent 参数**（【RPC】§2.2）。
- client 端调用（ui-cordis 范例 `D:\DeepSeekHarness\packages\extensions\ui-cordis\src\client\index.ts:37-62`）：`inject = ['slots','locale','remote','remote.<ns>', …]`，`await ctx.remote.git.status(...)` 返回 `RemoteResult<T>` = `{ok:true,value} | {ok:false,error}`。
- ⚠️ **未决缺口**：第三方 profile bundle 的 client 半如何在浏览器里挂载自己的 remote-client 产物，源码未核实到（typert loader 只有 host 面；`@deepseek-ai/dsh-api-remotes/client` 静态挂载的 27 个 contribution 是编译进应用的，`D:\DeepSeekHarness\packages\api\remotes\src\client\index.ts:188-211`）——见【RPC】§8.2 与本文 ⑧。

### 2.3 序列化边界（【RPC】§3）

入参（client → host，`assertJsonValue`，`D:\DeepSeekHarness\packages\api\gateway\src\index.ts:1704-1737`，✅核位置）：
- 允许：`null/string/boolean`、有限 `number`、plain object/array（原型必须 `Object.prototype`/null）；顶层字段缺失 = undefined。
- 拒绝：`undefined` 字段值、`Date/Map/Set/类实例`、循环引用、符号键、NaN/Infinity、访问器属性；strict codec 还会**丢弃编译类型未声明的对象字段**（:1662-1664）；失败码 `gateway/input-invalid`（带 field）。

返回值（host → client，`encodeRpcResult`/`encodeRuntimeResult`，`D:\DeepSeekHarness\packages\api\gateway\src\index.ts:1123-1182`；【RPC】§3.4 已用 node 等价复现）：
- `Date` → 自动 ISO 字符串；`Uint8Array` → 摘为 RPC 附件（`attachments: [{path, bytes}]`，编码机制在 `D:\DeepSeekHarness\packages\api\gateway\src\index.ts:1123-1132`——:1124 `const attachments` 声明、:1126 `attachments.push({ path, bytes })`、:1132 附加进 envelope、:1148 `Uint8Array → writeBytes` 分支；client 侧按 `RemoteDecoded` 重建为 ArrayBuffer 背衬 Uint8Array，类型契约 `D:\DeepSeekHarness\packages\typert\protocol\src\types.ts:335-337`）——**diff/blob 二进制走这条路**；
- **`Map`/`Set` 结果静默拷成 `{}`**（不报错、丢数据）；循环引用 → TypeError；`undefined` 结果 → envelope 无 `value` 字段（:784-786）。
- **硬规则：RPC 方法只返回 plain object/array/string/number/boolean/null；Date→ISO、Map/Set→数组或 plain object**（【RPC】§3.2）。

大小上限（【RPC】§3.3）：
- 请求体 `DEFAULT_MAX_REQUEST_BODY_BYTES = 300MiB`（`D:\DeepSeekHarness\packages\client\connection\src\http-bridge.ts:15`）；unary 结果无显式上限；流式 uplink 256 KiB 窗口（`gateway\src\index.ts:150,161-162`，超限 `gateway/uplink-overflow`）。
- 几千条 commit 记录 ≈ 1-3 MB，两个数量级以内余量，**不会超限**；log 分页（`-n <limit> --skip <offset>`）仍为 UI 渲染/延迟而做。

### 2.4 错误传播（【RPC】§4）

- host 抛 `RemoteError` → code/message/details 原样过线（`rpcFailure`，`D:\DeepSeekHarness\packages\api\gateway\src\index.ts:1516-1529`）；抛普通 `Error` → 折叠为 `gateway/internal`（message 保留）。取消 → `gateway/cancelled`。
- client 侧重建为真 `RemoteError` 实例放进 `{ok:false, error}`，**不 reject**（`packages\api\gateway\src\client\index.ts:461,870-872`）；判别**按 code 不按 instanceof**（`remote-error.ts:8-14,40-49`）；陌生 code 原样透传（client/index.ts:866-869）——client 要容忍。
- 域内错误设计：抛 `RemoteError(code, message, details)` 并在包内 `declare module` 扩 `RemoteErrorDetailsMap`（`packages\typert\protocol\src\index.ts:99-113`），或仿 `DynamicCordisRunnerService.invoke` 返回 `{ok:false, code, message}` 结果联合（`cordis-host-runner\src\index.ts:759-785`）。Gateway 基础错误码全集见 `D:\DeepSeekHarness\packages\api\gateway\src\remote-error-codes.ts`（20 码 + 共享底座三码）。
- 服务未就绪调用 → `gateway/service-unavailable`（`gateway\src\index.ts:829-835`）——UI 重试即可。

### 2.5 事件广播与订阅：外部插件走不通，用轮询（【RPC】§5，纠正报告）

四环节链路：① host `ctx.emit('cordis/…', …)`（事件签名在宿主包 `declare module … Events`）→ ② **转发 allowlist 是 dsh 源码内静态收口**：`API_REMOTE_FORWARDED_EVENTS`（`D:\DeepSeekHarness\packages\api\remotes\src\remote-events.ts:26-57`，✅核：30 项、含 6 个 cordis 系事件、**无任何 `git/*`**；事件源全局唯一，重复注册 throw `gateway\src\index.ts:356-358`）→ ③ Gateway `broadcastRemoteEvent` 分发给 owner client（非 owner 过访问判定，帧参数再过 JSON 校验，:615-637）→ ④ client `ctx.remote.$on(event, handler)`（返回解绑函数、归属调用者 fiber；要求 `interactions === 'answer'`，`gateway\src\client\index.ts:224-230`、`packages\api\gateway\src\client\remote-events.ts:78-184`）。

**结论：以 profile bundle 形态安装的 git 插件无法新增可转发事件**（allowlist 静态 + 无第三方注册 API）。【报告】:254 的"新快照通过 Typert 事件广播 git/status"对外部插件不成立。v1 落地：
- client **轮询** `git/status`（150ms 防抖 + 60s 兜底在 host 侧做）；
- `ctx.on('connection/reset', () => { cache.reset(); refresh() })`——断线重连按 generation 重开事件流并发 `connection/reset`（`gateway\src\client\index.ts:174-187`），**把推送/轮询当触发器、把 RPC 重拉当真值来源**（ui-cordis 范例 `ui-cordis\src\client\index.ts:75-84`）。
- 若未来允许改 dsh 源码（转内建），需三件套：Events 签名声明 + allowlist 值 + `TypertRemoteEventSelection` 类型合并（【RPC】§5.1-5.2）。

### 2.6 启停时机（【RPC】§6）

注册即存在（apply 内 `new GitService(ctx,'git')` 同步注册）；激活受 `static inject` 门控（依赖消失自动卸载，fiber `_unload` 跑全部 disposer）；patch 改 config 触发 fiber 重载；插件清理用 `ctx.effect(() => async () => {...}, 'label')`。

---

## ③ UI 插槽

### 3.1 框架核心【UI】§1

- 类型轴：`SlotKind = 'single'|'list'|'keyed'|'chain'`（`D:\DeepSeekHarness\packages\client\ui-slots\src\index.ts@687f282e86:101`）；`SlotScope = 'root'|'session-maybe'|'session'`（:104）；插槽契约表 `SlotMap` 空接口 + 各包 `declare module` 合并（:26；会话侧示例 `packages\client\ui-conversation\src\client\contract\slots.ts@687f282e86:194-299`）。
- `ctx.slots.register(options, Component)`（纯核重载 `ui-slots\src\index.ts@687f282e86:1161-1206`；运行时 `packages\client\ui-renderer\src\client\registry.ts@687f282e86:120,181`）：`name`（目标插槽键）、list 型 `id/order/label/priority`、keyed 型 `key/priority`、`children`（子插槽声明=独占授权，:825-826）、`store`（共享句柄或独占工厂，:827）、`locale`（声明后组件获得类型化 `t`，:830-835）、`inject`（注入面工厂，参数由 scope 推导，:1188-1198）、`registrant`（诊断标签）。
- **同格遮蔽**：同 cell 按 priority 共存、最低者渲染；同 cell 同 priority 第二次注册 throw（`ui-slots\src\index.ts@687f282e86:1137-1144,1216-1244`）。list 显示顺序由 `order` 精化（:1286-1288）。
- **`ctx.slots.inject(key, callback)` 是跨包注册标准入口**（`registry.ts@687f282e86:194-271`）：等待目标插槽被声明、声明塌缩移除贡献、控制器挂调用方 fiber；callback 返回 disposer 或 generator（yield 多个注册，事务化安装/逆序拆除）。单贡献 thunk 与多贡献 generator 两形态范本：`D:\DeepSeekHarness\packages\client\ui-sidebar-right\src\client\index.ts@687f282e86:204-243`。
- **root 槽警告**：`root` 是 single 槽、被 ui-layout AppFrame 占据；动态注册会以更低 priority 遮蔽整个 AppFrame。要全应用浮动面用 `shell.overlay`（`registry.ts@687f282e86:28-46`）。

### 3.2 三个目标插槽的注册形态【UI】§2

| 插槽 | kind/scope | 声明处 | 注册范本 |
|---|---|---|---|
| `conversation.session.header.utilities`（F1 头部按钮） | list/session | `D:\DeepSeekHarness\packages\client\ui-conversation\src\client\contract\slots.ts@687f282e86:235-239`；渲染点 `skeleton\ConversationSession.tsx@687f282e86:132` | ui-open-in-app：`ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name, id:'open-in-app', order:-10, locale:NS, inject }, Comp))`（`packages\client\ui-open-in-app\src\client\index.ts@687f282e86:95-105`） |
| `shell.overlay`（F1 悬浮胶囊备选） | list/root | `D:\DeepSeekHarness\packages\client\ui-layout\src\client\index.ts@687f282e86:88-105,186`（层 click-through，条目自行开 `pointer-events:auto`） | ui-chat 配额通知：`ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name, id, locale, children:{…}, inject }, QuotaNoticeHost))`（`packages\client\ui-chat\src\client\apply.ts@687f282e86:305-319`；e2e 夹具 `apps\web\tests\fixtures\plugins\fixture-live-client\client.js@687f282e86:50-52` 同款） |
| `sidebar.right.pane.tab`（F3 审查面板 body） | keyed/session | `D:\DeepSeekHarness\packages\client\ui-sidebar-right\src\client\contract\slots.ts@687f282e86:59-64`（keyed、开放字符串键域、key = tab 定义 `id`） | ui-deliverables 变更审查 tab：`ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: CHANGES_REVIEW_ID, locale, store: createReviewStore(), children:{…}, inject }, ReviewTab)))`（`packages\client\ui-deliverables\src\client\index.ts@687f282e86:87-100`） |

### 3.3 右栏 tab 体系：两段注册 + openResource【UI】§3

**第一段——类型注册** `ctx.sidebarRightTabs.register(definition)`（`SidebarRightTabDefinition`，`D:\DeepSeekHarness\packages\client\ui-sidebar-right\src\client\tab-registry.ts@687f282e86:94-139`，✅核结构）：

```ts
{
  id: string            // 全局唯一（包名最自然）；也是第二段 body/title 的 keyed key
  kind: string          // openTab 点名判别式
  multiple?: boolean    // 同 kind 是否各自独立内容
  keepMounted?: boolean // 隐藏/切 Session/停靠时保留挂载（提交图重算昂贵→true）
  patterns?: readonly string[]   // dsh-resource:// 地址 glob（含':'匹配整个地址，否则匹配 URI path）
  priority?: 'extension'|'builtin'|'fallback'   // 缺省 extension（最高档）
  canOpen?: (address) => boolean
  title: (address) => string     // chip 初始文本；thunk 每次重读（跟随语言）
  guide?: readonly SidebarRightGuideEntry[]
}
```

- 优先级带 extension(3) > builtin(2) > fallback(1)（`tab-registry.ts@687f282e86:49-59,350-364`）；**kind 冲突**：一个 kind 最多一个 builtin + 一个 extension，其余冲突与 id 重复一律 throw（:18-22,181-183,253-281）；register 返回 disposer，要求放进自己的 `ctx.effect`（:240-251；实写 `ui-deliverables\src\client\index.ts@687f282e86:86`）。注册表构造必须在 apply 顶层（`ui-sidebar-right\src\client\index.ts@687f282e86:101-110`）。
- 第二段 body/title 见 §3.2 第三行；title 席位可选（`ui-sidebar-right\src\client\index.ts@687f282e86:265-268`），不注册就用注册表捕获的 `title(address)`。

**打开方式**（服务面 `ISidebarRight`，`D:\DeepSeekHarness\packages\client\ui-sidebar-right\src\client\service.ts@687f282e86:186-216`）：
- `openResource(address, { kind?, params?, paneId?, preferNewPane?, revealIfOpened?, replaceTab? })`：address 必须 `dsh-resource://` URI，非该 scheme 或无人认领 throw；打开即认领+放置+展开右栏；同 address 幂等（contentId=address，`tab-registry.ts@687f282e86:141-154`）。
- `openTab(kind, { params })`：页面型 tab（无 patterns，如 guide `tabs\guide\definition.ts@687f282e86:20-26`）。
- body 内部用 `tab.actions.openResource/openTab/close`（`contract\slots.ts@687f282e86:140-161`）；导航参数经 `useTabInfo().tab.navigation = {address, params, revision}` 读取（:108-119；hook 工厂 `packages\client\ui-sidebar-right\src\client\tab-info.ts@687f282e86:29-55`）。实调用例：`ctx.sidebarRight.openResource(changesReviewAddress(...), { params: { index } })`（`ui-deliverables\src\client\index.ts@687f282e86:76-78`；地址铸造 `src\changes.ts@687f282e86:143-165`）。

**多 tab 并存**：两个 tab = 两个 kind（如 `git-changes`、`git-graph`），id 各自唯一即无冲突；自己的地址空间 `dsh-resource://git-*/**` 由自己 patterns 认领；body 在 keyed 席位按 `definition.id` 分发（`SidebarRight.tsx@687f282e86:211`）（【UI】§3.3）。

### 3.4 store 范式（`@deepseek-ai/dsh-client-store`）【UI】§4

- 引擎 `createSnapshotStore<T>(init, opts?)` → `{ getSnapshot, subscribe, update(draft), set(next) }`（zustand vanilla + immer + subscribeWithSelector；flush 'sync'|'raf'；persist 走 localStorage；`D:\DeepSeekHarness\packages\client\store\src\index.ts@687f282e86:103-136`）。引擎产物是裸 observable。
- **范式 A（插件内数据缓存）**：裸 observable + `state.update(s => { s[url] = ... })`，经槽注册 `inject` 的 `hooks` 隔间供组件订阅——ui-deliverables `HostReadStore`（`packages\client\ui-deliverables\src\client\host-read-store.ts@687f282e86:30-81`；子类给 policy：`changes-summary.ts:10-32` 缓存型 / `changes-diff.ts:13-37` 可重试型）。**适合 host 读缓存（status/diff/log）**。
- **范式 B（槽注册 store 席位）**：`defineStore({ init, actions })`，actions 是纯 draft mutator 自动包装成 update（`store\src\index.ts@687f282e86:217-245`；范例 `ui-deliverables\src\client\review-store.ts@687f282e86:47-92`）。组件读 `props.useStore(selector)`、写 `props.actions.*`（`packages\client\AGENTS.md@687f282e86:16`）。
- 句柄-作用域规则：一个共享句柄只能挂一个 scope（root 句柄不得挂 session 槽，反之 throw，`ui-slots\src\index.ts@687f282e86:1253-1263`）；两个 session 席位可共享 session 句柄；实例由渲染器 handle×scopeKey 管理；**模块级 store 句柄禁止**，一律 `createXxxStore()` 工厂（`AGENTS.md@687f282e86:16`）。
- session 域 body 切 Session 会重挂载——提交图跨 Session 存活的状态放 root 域服务或插件内 HostReadStore 式实例（apply 顶层创建 + `ctx.effect` 清理，`ui-deliverables\src\client\index.ts@687f282e86:50-58`）。

### 3.5 client 插件 inject 清单与 locale【UI】§5-6

- 模块级 `export const inject = [...]`（cordis 服务名，fiber 等待就绪）——git 插件 client 至少 `['slots', 'locale', 'remote', 'sidebarRightTabs', 'sidebarRight']`（**报告 :310 漏了 `sidebarRightTabs`**，缺它 `ctx.sidebarRightTabs` 不可达；范本 `ui-deliverables\src\client\index.ts@687f282e86:42-43`：`['slots','locale','uiConversation','remote','remote.session','sidebarRightTabs','sidebarRight','configForms']`）。规则："may use only the dependencies named by its inject"（`AGENTS.md@687f282e86:17`）。
- package.json `dsh.client.inject` 是信息性包名边（预检/HMR），不决定激活顺序（`AGENTS.md@687f282e86:148`；实例 `ui-deliverables\package.json@687f282e86:29-44`）。
- locale：`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'git': GitKey } }`（键集权威 = zh 词典，`ui-deliverables\src\client\index.ts@687f282e86:35-40`）；一个 effect 注册全部语言 `ctx.locale.register(NS, { zh, en })`（**双语齐备强制**，`packages\client\locale\src\client\index.ts@687f282e86:377-437`）；槽注册传 `locale: NS` 组件得类型化 `t`（`ui-slots\src\index.ts@687f282e86:830-835`）；apply 层用 `ctx.locale.bind(NS)`（:439-462）。词典扁平 `Record<string,string>` + `{name}` 插值。详见【基建】§6。

### 3.6 ui-deliverables 组件复用结论：不能直接复用，照抄算法【UI】§7

**不能 runtime-import ui-deliverables 的 diff 组件**，四条独立依据：
1. 契约红线：feature 插件禁止 runtime-import 另一 feature 插件的值（`D:\DeepSeekHarness\packages\client\AGENTS.md@687f282e86:40`）；
2. `./client` 只导出 `apply`/`inject`/共享类型，`FileDiff.tsx/ReviewTab.tsx` 是内部实现（`AGENTS.md@687f282e86:38`；`ui-deliverables\src\client\index.ts@687f282e86:42-49`）;
3. 打包面封死：`files` 只含 lib 产物，npm/git 安装拿不到 `src/`（`ui-deliverables\package.json@687f282e86:85-90`）;
4. 耦合面：`FileDiff` 依赖本包私有 CSS、ChangesDiffState、deliverables 命名空间 `t` 席位（键 `diff.*`，`FileDiff.tsx@687f282e86:141-158`）与宿主路由 URL 形状；呈现层被定位"expected to be rewritten wholesale"（`AGENTS.md@687f282e86:52`）。

**替代路线**：语法高亮/`languageForPath`/`useCodeHighlighter`/`Button` 从基线包 `@deepseek-ai/dsh-client-ui-primitives` 取（`FileDiff.tsx@687f282e86:4`；基线表 `platform.ts:13`）；`hunkRows/splitRows/renderedHunks`（MAX_RENDERED_LINES=5000，`FileDiff.tsx@687f282e86:66-125`）是短小纯函数，照抄进自己包；diff 数据获取照 `HostReadStore` 自建。

### 3.7 虚拟滚动设施（F7 提交图）【UI】§8

- `@tanstack/react-virtual` 3.14.10 在基线 `PLATFORM_MODULES`（`D:\DeepSeekHarness\packages\client\web\src\platform.ts:8-15` 第 10 行，✅核）——动态插件直接 `import { useVirtualizer }` 用共享实例，**不得**写进 `dsh.client.external`（`AGENTS.md@687f282e86:82`）；npm 侧进 `devDependencies`。
- 生产用例：ui-trajectory 长表格 `useVirtualizer({ count, estimateSize, getScrollElement, anchorTo:'end', overscan:12, followOnAppend:'auto' …})`（`D:\DeepSeekHarness\packages\client\ui-trajectory\src\client\TrajectoryTable.tsx@687f282e86:2187-2233`，>100 行启用 :49-50）；ui-chat 回合导航（`packages\client\ui-chat\src\client\chat\TurnNavigator.tsx@687f282e86:110-165`）。
- **lane 布局 dsh 没有**——泳道分配需自研或按教材实现（见 ⑥ 移植源与 ⑦ 偏差）；右栏停靠类型可从 `@deepseek-ai/dsh-client-ui-dockkit`（基线表 `platform.ts:14`）经 `ui-sidebar-right\src\client\index.ts@687f282e86:72-77` 转出 `TabId/PaneId/TabRecord` 类型。
- 提交图 tab 落地要点：两个 tab 类型各自两段注册；`keepMounted: true`；从会话行打开用资源地址（幂等）；图数据源放插件内 HostReadStore 式实例（【UI】§8 末）。

---

## ④ 基础设施 API

### 4.1 GitRunner 安全范式（【基建】§1-3）

**基底实现**：`D:\DeepSeekHarness\packages\deliverables\workspace-changes\src\git.ts`（279 行，✅核 wc -l）。`run()`（:55-80，✅核）要点：
- `AbortSignal.timeout(limits.timeoutMs)` ⊕ 调用方 signal（`AbortSignal.any`，:56-57）；
- **argv 数组注入，绝不 shell 解释**（`packages\subprocess\subprocess\src\types.ts:78`）；
- 固定 env：`GIT_CONFIG_COUNT=0`（切断 ambient `GIT_CONFIG_KEY_n`）、`GIT_TERMINAL_PROMPT=0`（禁交互挂起）、`GIT_OPTIONAL_LOCKS=0`（status 不写 index）、`LC_ALL=C`（输出稳定可解析）；`...options.env` **后置合并**可按命令覆盖（git.ts:68-69，✅核）;
- stdout 每命令 `maxBytes`（默认 runner 级 `outputMaxBytes`），溢出**保尾部**、`truncated` 置真；stderr 固定 16 KiB 尾部（git.ts:11）；
- 终止：`graceMs=2000` 宽限 → Windows 一律 `taskkill /PID /T /F` 强杀进程树（`packages\subprocess\subprocess-local\src\spawn.ts:129-130,352-379`；POSIX TERM→KILL 阶梯）；
- `ok()` 辅助（git.ts:89-92）：非零退出抛带 stderr 的 Error；
- `GitRunResult` 定调"nonzero exit is a result, not an exception"（git.ts:14-20）。

**更强的在树先例（推荐手抄组合）**：`D:\DeepSeekHarness\packages\experimental\client-ui-forge\src\git.ts`（【基建】§1.5）——`GIT_ENV`（:58-69）把 15 个 ambient `GIT_*` 显式 tombstone（`GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/…/GIT_ATTR_SOURCE`）再设四固定项 + `GIT_NO_LAZY_FETCH=1`；读命令前缀 `GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']`（:72）；`runGit`（:224-271）= `deadline()` 超时 + `resolveExecutable` + 双流 collect + `allowedExitCodes` 白名单 + `finally terminate/waitForExit`。

**组装建议**（【基建】§8.1）：抄 client-ui-forge `runGit`（~50 行）+ GitRunner 常量/env → 自建 GitRunner；**读命令**套 `GIT_ENV`+`GIT_PREFIX`，**写命令**（add/commit/push）不套 hooksPath 禁用与 `--no-optional-locks`（保留用户 hook）；错误自建保留 `{exitCode, stderr, truncated}` 的领域错误；`truncated` 必须显式降级/报错，不能静默用截断数据。

**禁止复用**：`locateGitWorkspace`（git.ts:127-141）的 `GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES` env 是**快照专用**（tree-hash 进私有对象库）——真实 status/commit/push 直接在仓库 root 跑命令，repo 发现自写 `rev-parse --show-toplevel`（forge git.ts:99-103 有"128 + not a git repository → null"范式）。

**git 发现**：`ctx.subprocess.resolveExecutable('git', undefined, signal)`（`packages\deliverables\workspace-changes\src\index.ts:72-86`；本地实现在 `packages\subprocess\subprocess-local\src\index.ts:155-195`）——Windows 上 `git` 裸名 × `PATHEXT`（缺省 `.COM;.EXE;.BAT;.CMD`）× PATH 逐目录 stat+X_OK，`C:\Program Files\Git\cmd\git.exe` 在 PATH 即命中；失败返回 null → UI 友好提示（PATHEXT 实际命中序未实测，【基建】§10）。环境净化底座：`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i` + 剥 `DSH_*`，凭证形状名字绝不隐式下发（`packages\subprocess\subprocess\src\index.ts:47-80`）。

### 4.2 fs.watch（【基建】§4）

- 签名：`watch(target, changed, signal): Promise<() => Promise<void>>`（`D:\DeepSeekHarness\packages\fs\fs\src\index.ts:100-105`）——`changed` 是**失效回调**（不带内容），`signal` 只取消初始化，已建立 watcher 用返回的 close 关闭；基类默认拒绝（watch 是可选能力）。
- 本地 chokidar 实现（`D:\DeepSeekHarness\packages\fs\fs-local\src\index.ts:70-91`，✅核）：**`depth: 0`——目录目标只监直接子项，不能递归监听仓库树**；**目录目标无 ignore 过滤——监仓库根时无法排除 `.git`**（但 `.git` 内部超出 depth 0 不触发）。文件目标 = 监父目录只留该文件。
- 远端（ssh）provider 无 watch override，**远端执行世界 watch 不可用**（【基建】§4.4）。watcher 必须挂**宿主 ctx**（我们 apply 收到的那个）。
- 唯一生产范式：`packages\api\workspace-files\src\changes.ts:39-109`（【基建】§4.3）——失效 + 重新 stat 推送新元数据；`AbortSignal.any` + abort listener + `finally` close + 宿主级 `ctx.effect` 兜底；不支持时显式降级抛 `RemoteError('workspace-file/watch-unsupported')`。
- **对 git 插件**：递归树监听 `ctx.fs.watch` 做不到 → v1 用 (a) 插件自带 `chokidar@5`（与 fs-local 同版本，`packages\fs\fs-local\package.json:36`）自建递归 watcher（ignored: `.git`, node_modules）+ (b) `ctx.fs.watch`/定时轮询兜底；150ms 防抖 + 60s 轮询兜底是插件层自实现（dsh 没有"git 状态→推送 UI"接线）。

### 4.3 prepareCall（AI 提交信息用）（【基建】§5）

- 签名：`ctx.llm.prepareCall(config: LlmCallConfig, signal?, configure?): Promise<PreparedLlmCall>`（`D:\DeepSeekHarness\packages\llm\llm\src\index.ts:960-964`；`LlmCallConfig = {provider, model} & {reasoningEffort?, temperature?, maxTokens?, stop?}`，`call-config.ts:31-34`）。返回**冻结** PreparedLlmCall，`stream` 一次性（重复派发 → `LlmError('INVALID_PREPARED_CALL')`，:1000-1008）。
- **完整范式**照抄 `D:\DeepSeekHarness\packages\session\session-title-llm\src\index.ts:230-285`（【基建】§5.2 全文）：输入字节上限**调用方自检**（:241-244）→ `using deadline(signal, timeoutMs, code)`（`packages\util\timeout\src\index.ts:99-121`）→ `prepareCall` + `BlockAssembler` 流式组装 → finish 解释（:198-213）→ 派发前记可观测事件（:267-275）。
- **路由解析不在 prepareCall**：显式给 provider/model，或自己从 `request/header` 事件 / `session.requestHeader()?.config` 捕获（`packages\session\session-title\src\index.ts:353,541-562`）——【报告】:83 此处不准确（D3）。
- `GenerateOptions.purpose` 是封闭联合 `'compaction'|'session-title'`（`packages\llm\llm\src\types.ts:596`）——插件不能发明新 purpose；一次性辅助调用省略即可。
- 裁剪常量直接沿用 ZCode `gitCommitMessageGenerator.ts:10-20`（20 文件/8 diff/12k 总量/单文件 2k/上下文 12 条 4k/消息上限 1k + `CONVENTIONAL_COMMIT_RE`），见 ⑥。

### 4.4 locale 机制（【基建】§6）

- 包 `@deepseek-ai/dsh-client-locale`：client 侧 `LocaleRuntime` 挂 `ctx.locale`（`D:\DeepSeekHarness\packages\client\locale\src\client\index.ts:84-87,166`）。注册 `ctx.locale.register(ns, {zh, en, …})`：**强制 zh+en 双语齐备**、`(ns, locale)` 唯一占用（重复 throw）、返回幂等 disposer、注册 bump revision 使已挂出口刷新（:377-441,489-495）。查找链：命名空间 fallback 链 → `common` NS → 原样 key；`{name}` 插值（:470-478）。语言切换发 `'locale/change'`（:88-98），**字典注册不发事件**。
- host 包 locale 惯例：`locale/*.json` 8 语种 + `"./locale/*.json"` 导出属包元信息资产（`workspace-changes\package.json:27`）；**UI 运行时文案机制就是 client 侧 `ctx.locale.register`**。

### 4.5 Windows 注意点汇总（【基建】§7 + §2）

| 项 | 结论 | 依据 |
|---|---|---|
| `core.hooksPath` 禁用值 | **跟 dsh 房规：一律 `/dev/null`，无平台分支**（全树 4 处均此写法，grep 实测无 NUL 分支）；codex 在 Windows 用 `NUL`（`docs/ported-sources/codex/codex-rs/git-utils/src/operations.rs:10`）可作保守备选。既有实测结论：Git for Windows 将 `/dev/null` 归一化为 `nul`（prior-session，本会话未重测） | `packages\experimental\client-ui-forge\src\git.ts:72`、`packages\experimental\worktree\src\index.ts:261` 等 |
| 进程终止 | Windows 一律 `taskkill /PID /T /F` 强杀树（信号值无关） | `subprocess-local\src\spawn.ts:129-130` |
| env 合并 | 大小写不敏感；字符串=恢复/覆盖，`undefined`=删除墓碑 | `subprocess-local\src\spawn.ts:44-54`、`subprocess\src\types.ts:99-106` |
| git.exe 发现 | 裸名 × PATHEXT × PATH 枚举（命中序未实测） | `subprocess-local\src\index.ts:155-195` |
| 凭证挂起 | `GIT_TERMINAL_PROMPT=0` 必带；push 凭证失败把 stderr 原样回 UI | git.ts:69、【报告】§八.1 |
| hook 策略 | 只读命令禁 hook（GIT_PREFIX）；用户主动 commit/push **保留用户 hook** | forge git.ts:72、【报告】§八.2 |

---

## ⑤ 安装与真实宿主启动调试（命令级，源自【宿主调试】）

### 5.1 环境事实（该读者本会话逐一实测）

- 源码树 `D:\DeepSeekHarness`（无 `web/deepseek-harness` 层）；版本 0.2.2-alpha.2 `f3803c9697`；本会话另实测 rc.2 `687f282e86` 是其祖先。
- Node v22.21.0（engines 要求 ≥24.9，**宿主启动实测不受限**）；pnpm 树外 11.8.0 / 树内自切换 11.28.5；npm registry 可达（`npm ping` PONG）；git 协议不通（沿 prior-session 结论）。
- 树内已含全部构建产物（`apps/cli/lib`、`apps/web/dist` 等，git 未跟踪）；`C:\Users\duyan\.dsh\profiles\node_modules` 提升树含 `@deepseek-ai/cordis@4.0.2` 等——插件运行时 import 依赖这条解析链。

### 5.2 启动 web 宿主（实测 3 次成功）

```bash
cd /d/DeepSeekHarness
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 31987
# = root package.json:215 start:web；判据：stdout 一行 "dsh web: http://127.0.0.1:31987/?token=..."
# 无 token curl → 401（trust fence，设计行为）；浏览器开日志 URL → 303 进 UI
# 停止：netstat -ano | grep :PORT 找 PID → taskkill //PID <pid> //T //F
```

CLI 参数规则（实测踩坑）：启动器级 flag（`--profile`、`--patch`）**必须在 profile 词之前**；用了启动器 flag 后必须写显式 `--profile web`：

```bash
node --import tsx/esm apps/cli/src/bin.ts --profile web --patch /abs/overlay.yml -- --no-open --port 31990
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 31987   # 纯 app flag 时可用简写
```

app flag：`--host/--port(默认3080)/--no-open/--public-url/--trusted-host/--tls-*`；默认端口 3080 在 `packages\bundle\web-app\cordis.patch.yml:176`。隔离调试：`export DSH_HOME=$(mktemp -d)`——缺名 profile 会被 `initProfile` 自动创建（`packages\boot\app-boot\src\profile.ts:198-217`，实测生成 bundles=[dsh-base, dsh-web-app]）。

### 5.3 三条装载通道

**通道 A（生产形态，全链路实测）——`dsh plugin add file:/link:`**：

```bash
# 包最小结构：package.json(dsh.bundle.patch+main) + cordis.patch.yml(- insert:[{id,name:包名}]) + lib/index.js
DSH_HOME=$TMPHOME node --import tsx/esm apps/cli/src/bin.ts plugin --profile dbg add "file:<绝对路径>/dsh-git-plugin-host"
# 判据：exit 0；profile package.json 记入 dependencies；dsh.profile.bundles 自动追加包名（operations.ts:90-122）
```

开发期建议 `link:<工作区构建产物目录>`（改源码即生效，仍需重建 lib + 重启）；发布期走 npm/git tag。离线兜底就是 file:/link:（file: 安装 0 下载实测）；**git 安装通道不可依赖**（git 协议不通；且 `git-transport.ts` 全文只是 HTTP(S)/SSH 传输探测，无本地路径逻辑——【宿主调试】§3.A，与【形态】§八核对一致）。

**通道 B（迭代最快，host 端）——`--patch` 源码 overlay**（实测通过，带坑）：

```yaml
# /abs/path/overlay.patch.yml
- insert:
    - id: my-plugtest
      name: './myplug/index.js'   # 相对本 patch 文件锚定；经 CLI tsx loader 加载，免安装
```

```bash
node --import tsx/esm apps/cli/src/bin.ts --profile web --patch /abs/path/overlay.patch.yml -- --no-open --port 31993
```

**坑（实测两次复现）**：入口模块旁**必须有 `package.json` 且 `"type":"module"`**，否则 node 22 报 `ERR_REQUIRE_CYCLE_MODULE`、宿主日志 `1 entry did not activate`。适合 host 快速改代码；client 端不适用（需构建 bundle）。

**通道 C（client 端）——运行时动态装载**（代码核查；bundle 构建未实测）：宿主运行时扫描 `dsh.client` 包、增量服务浏览器 bundle，`internal/plugin` 事件驱动刷新（`packages\client\modules\src\index.ts:1-25,678-699,906`）——**重启入口或 patchReload 即生效，不需要重建 web 前端**。判据：页面源码含 `window.__DSH_BOOT__` 且 entries 里有我们的包名。施工第一步：照 ui-cordis 的 tsdown 配置建最小 client 包验证。

### 5.4 验证判据（每次改完跑，【宿主调试】§3.A/§5）

```bash
DSH_HOME=$TMPHOME node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 31987 > boot.log 2>&1 &
grep -c "HELLO-FROM-TEST-PLUGIN" boot.log        # ≥1 = 插件已激活
# 反向：日志出现 "N entry did not activate" + "failed to import" = 装载失败
curl -s http://127.0.0.1:31987/ | head -1        # 401 = fence 正常
```

⚠️ `ctx.logger.info` **不出现在控制台**（实测）——调试标记用 `process.stdout.write` 或 `ctx.logger.error`。

### 5.5 集成测试模板（【宿主调试】§4）

范本 `packages\deliverables\workspace-changes\tests\git.spec.ts` + `tests\support.ts`：真实临时 git 仓库（`git init -q -b main` + `execFileSync('git', ['-c','user.email=t@example.com', …])`）、`mkdtemp` + cleanups + afterEach 逆序清理、真实 Cordis Context + `LocalSubprocessRuntime` 注入、超时/abort/截断断言、`it.skipIf(process.platform === 'win32')`。我们自建于 `D:\deep seek harness\dsh-git-plugin`（不动 dsh 树）：三层 = 纯函数单测（porcelain/lane）+ GitRunner 集成（照抄 support.ts）+ 装载冒烟（spawn 真 bin + 临时 DSH_HOME + 上述判据，loader-smoke 的自包含版）。断言纪律：验证世界而非自述——写操作后重读外部 git 状态。

### 5.6 风险清单（【宿主调试】§6，摘要）

Node 22 vs ≥24.9（装载全通但 overlay 有 type:module 坑；诡异装载错误优先怀疑 node 版本）；logger.info 不可见；token fence（自动化用日志 URL 与 API 判据）；git 协议不通（spec 一律 file:/link:/registry）；pnpm 版本分身；提升树是本机现状（新机器包必须自己声明 dependencies）；树是滚动版（每次施工前 `git log -1` 复核）；profile 命名避开 `desktop`（Electron 独占，`apps\cli\src\args.ts:83-86`）与 shipped 名，用 `dbg` 等；每次实验后 taskkill + 删临时 DSH_HOME。

---

## ⑥ 移植源清单（`docs/ported-sources/`，全部 36 文件 + 1 教材，36/36 完整性检查通过）

> 抓取方式与逐文件字节级校验见【移植源】头部。**总合规底线**：Apache-2.0 与 MIT 材料可移植但必须保留版权与许可声明，本仓库加 NOTICE/THIRD_PARTY_NOTICES；专有/GPL 材料一行代码不进仓库。

| 来源（许可） | 本地文件（行数） | 用途（对应我们的模块） | 移植方式 |
|---|---|---|---|
| **zai-org/ZCode**（Apache-2.0，commit `3c5b2276`，版权 Z.AI Co., Ltd） | `zcode/packages/services/src/git/repo/gitCliRepo.ts`（1711） | 全部 git 命令层：status v2 `-z`（:549）、numstat 并发（:876/:882）、`upstream...HEAD`（:1391-1400）、临时索引部分提交 `GIT_INDEX_FILE`+`read-tree`（:1547,:1552）、push `--set-upstream`（:1654）→ host `git-runner/status/mutations` | 逐行移植；child_process → `ctx.subprocess.spawn` |
| 同上 | `zcode/.../git/gitService.ts`（357） | 服务编排状态机 refresh/stage/unstage/discard/commit/push → host `GitService` 骨架 | 移植；IPC 事件 → Typert（注意：外部插件不能广播事件，见 ②⑤） |
| 同上 | `zcode/.../git/gitCommitMessageGenerator.ts`（356） | AI 提交信息裁剪常量（:10-17）+ `CONVENTIONAL_COMMIT_RE`（:20）+ prompt 约束 → host `message-gen` | 移植；LLM 调用换 `ctx.llm.prepareCall`（范式 session-title-llm） |
| 同上 | `zcode/.../fileWatcher/fileWatcherService.ts`（150） | `DEBOUNCE_MS=150`（:13,:92）+ 引用计数启停 → host `watcher` | 只抄防抖与引用计数结构；watch 换 dsh 方案（§4.2） |
| 同上 | `zcode/packages/ui/src/GitActionMenu.tsx`（1404）/ `GitPane.tsx`（546）/ `GitPaneChangeCard.tsx`（226）/ `hooks/useGitAutoRefresh.ts`（177，60s 轮询兜底 :15,:121） | header 按钮+提交/推送对话框、审查面板（含虚拟滚动 :2）、变更卡片、自动刷新 → client 各组件 | 抄交互逻辑与状态流，不抄样式（组件库不同）；虚拟滚动做法可复用到 F7 |
| 同上 | `zcode/packages/shared/src/channels.ts`（1343） | IPC 通道命名参考（`Git:"git"` :97 等） | 只作命名参考，不整文件移植 |
| **openai/codex**（Apache-2.0，commit `7c11b807`） | `codex/codex-rs/git-utils/src/operations.rs`（171） | 安全参数：`safe.bareRepository=explicit`（:122 附近）、`DISABLED_HOOKS_PATH`（:10，Win `NUL` else `/dev/null`）、`GIT_CONFIG_COUNT` 注入（:13-27）→ GitRunner SAFE 前缀 | 抄参数清单与注入位置（Rust 不移植） |
| 同上 | `codex-rs/git-utils/src/status.rs`（83）/ `fsmonitor.rs`（129） | status 并发去重；fsmonitor 探测仓库配置、保留内置 daemon、禁仓库级 helper | 翻译成 TS |
| 同上 | `codex-rs/file-watcher/src/lib.rs`（932）+ 测试（694）+ `app-server/src/fs_watch.rs`（377，200ms 防抖 :27） | watch 过滤/生命周期参考；防抖取值 150ms（ZCode）优先 | 仅参考 |
| **sst/opencode**（**MIT**，commit `b6c43a52`，分支 `dev`） | `opencode/packages/core/src/git.ts`（1613）/ `plugin/vcs/git.ts`（825）/ `util/git-executable.ts`（59）/ `vcs.ts`（262）/ `worktree/git.ts`（39） | 只读 git 服务教材：`diff-files --name-only -z`/`ls-files -m -o` 快速路径、patchBudget、索引自愈、分支/祖先判断、worktree | Effect-TS 不移植，只抄命令与参数语义 |
| **cline/cline**（Apache-2.0，commit `f817e59f`） | `cline/apps/examples/desktop-app/sidecar/source-control.ts`（681） | porcelain **v1** 解析（staged/unstaged 分流、"No commits yet"、重命名双行）——MVP status 快速跑通 | 移植解析器；v2 再升级 |
| **Aider-AI/aider**（Apache-2.0 模板，commit `5dc9490b`） | `aider/aider/repo.py`（622） | auto-commit 语义：署名 trailer、dirty 检测、提交时机（需求 42/18） | Python 不移植，学语义 |
| **gitkraken/vscode-gitlens**（**双许可**：MIT + LICENSE.plus 专有，commit `020cfc1b`） | `vscode-gitlens/packages/git/src/models/graph.ts`（452）/ `graphSession.ts`（230，SINGLE-WRITER 分页契约 :11-18）/ `utils/graph.utils.ts`（107）/ `packages/git-cli/src/providers/graph.ts`（2561） | F7 提交图数据层：行/头类型、增量窗口、spurious-empty 守卫（:1822）、防御性 over-walk（:2487） | **只抓了 MIT 区**（packages/git 与 git-cli）；`packages/plus/**` 主动未抓、不得抓不得移植；graph.ts 主体只摘增量与分页模式 |
| **mhutchie/vscode-git-graph**（自定义许可，commit `d7f43f42`，分支 `develop`） | `vscode-git-graph/web/graph.ts`（913） | ⛔ **REFERENCE-ONLY**：泳道渲染阅读参考（Branch/Vertex/Graph 类） | **禁止复制任何代码进仓库**——LICENSE:9 "Permission is NOT GRANTED to publish, distribute, sublicense, and/or sell derivative works"；THIRD_PARTY_NOTICES 不得出现对其代码的引用式搬运 |
| 网页教材 | `ported-sources/notes/commit-graph-drawing-algorithms.md`（pvigier 博客全文） | F7 泳道布局教材：temporal topological sort、active-branches 泳道分配、merge-children 列清单（274ms）vs 区间树（482ms）、可视区优化 | 文章可自由学习；**作者原型 gitamine 是 GPL-3.0，其代码一行不得移植**；lane 布局纯函数 ~200-400 行 TS 自行实现 |

GitLens lane/swimmer 复核（【移植源】§6）：MIT 区**不存在** lane/swimmer 命中（全树 3458 项检索核实）；泳道分配在专有区 `packages/plus/commit-graph/src/lanes/*`——未抓取，泳道必须自研。

---

## ⑦ 与调研报告的偏差表

### 7.1 版本口径差异（环境前提）

| 维度 | 【报告】 | 读者笔记核实 |
|---|---|---|
| 版本 | 0.2.1-rc.3（浅克隆） | 本地树为 `D:\DeepSeekHarness` @ 0.2.2-alpha.2（`f3803c9697`）；任务口径 rc.2 `687f282e86` 是其祖先（本会话 `git merge-base --is-ancestor` 退出码 0） |
| 路径 | `D:/DeepSeekHarness/web/deepseek-harness` | **不存在**（`ls` 无 `web/` 层）；实际根即 `D:\DeepSeekHarness`（全体读者一致核实） |
| Node | 报告口径 Node ≥ 24.9 | rc.2 根 package.json `engines.node: "^22.19.0 || >=24.0.0"`（【形态】§八）；alpha.2 engines ≥24.9 但 22.21.0 宿主启动实测不受限（【宿主调试】§1） |
| 【形态】§九 漂移扫描 | — | rc.2→alpha.2 对两个 cordis.patch.yml 为纯行级增删；形态/声明/打包契约稳定，结论对 HEAD 成立；按 HEAD 调试时 patch 行名以 HEAD 为准 |
| 【基建】§0 漂移扫描 | — | 所涉 9 个关键文件 rc.2↔HEAD 仅 `fs-local/src/index.ts` 一处无关差异（`~` 前缀展开），结论对两版同时成立 |

### 7.2 读者 deviations 汇总（对【报告】的修正）

| # | 报告论断（行号） | 核实结论 | 出处 |
|---|---|---|---|
| D1 | `git-transport.ts` 负责 git 安装（:84） | 该包只有 HTTP(S)/SSH 传输探测，**无本地路径安装逻辑**；实际拉取由 `pnpm add` 完成 | 【形态】§八、【宿主调试】§3.A |
| D2 | git 安装落到 `~/.dsh`（:70） | 落点是 profile 目录 `~/.dsh/profiles/<name>/node_modules` | 【形态】§八 |
| D3 | "public 方法即自动暴露给 client"（:82,:192） | **不成立**：只有 `@Remote` 装饰的方法暴露（12/12 产物对应实证）；client 描述符来自构建期 `lib/typert.remote-client.*`，且 client 只认 strict | 【RPC】§2.1 |
| D4 | "新快照通过 Typert 事件广播 git/status，client 订阅"（:254） | **对外部插件不成立**：`API_REMOTE_FORWARDED_EVENTS` 是静态收口、事件源全局唯一、无第三方注册 API；v1 用轮询 + `connection/reset` 重置 | 【RPC】§5.1-5.2 |
| D5 | remote-events "声明即可订阅"（:468） | 实为三件套（Events 签名 + allowlist 值 + `TypertRemoteEventSelection` 合并），client 编译面必须 import `api-remotes/client` | 【RPC】§5.1 |
| D6 | 序列化未提硬约束 | Map/Set 结果静默丢成 `{}`、Date 自动转 ISO、二进制走 attachments 旁路、参数禁 undefined/类实例 | 【RPC】§3 |
| D7 | `inject = ['slots','locale','remote','sidebarRight']`（:310） | 漏 `sidebarRightTabs`（缺它 `ctx.sidebarRightTabs` 不可达） | 【UI】§9 |
| D8 | 包名 `@deepseek-ai/dsh-client-ui-sidebar`（:297） | 实为 `@deepseek-ai/dsh-client-ui-sidebar-right` | 【UI】§9 |
| D9 | `ctx.fs.watch` 可"监听仓库根但排除 .git/node_modules"（:79,:251） | fs-local watch `depth:0` 且目录目标无 ignore——**既不能递归也不能排除 .git**；要报告形态需插件自带 chokidar | 【基建】§4.2、D-观察 |
| D10 | prepareCall "解析当前会话模型路由"（:83） | 路由解析不在 prepareCall：显式 provider/model 或自捕 `session.requestHeader()?.config`；`purpose` 是封闭联合 | 【基建】§5、D3 |
| D11 | GitRunner 前缀三条即可（:212-230） | dsh 在树先例还有一层 env tombstone（15 项 `GIT_*`）+ `GIT_NO_LAZY_FETCH=1`，建议并入；hooksPath 值 dsh 全用 `/dev/null` 无平台分支 | 【基建】§1.5、D4 |
| D12 | `resolveGit` 在 git.ts 41-141（:76） | `resolveGit` 在 `workspace-changes/src/index.ts:72-86`；git.ts:41-141 只有 GitRunner/ok/locateGitWorkspace | 【基建】D1 |
| D13 | 双包结构（§5.2 :139） | 两形态都有先例；**建议单包双导出**（官方模板即此形态） | 【形态】§6 |
| D14 | opencode git.ts 约 1421/1423 行、vcs/git.ts 752 行 | 实测 1613 / 825 行（文件在报告后增长） | 【移植源】§3 |
| D15 | 附录 A 行号索引（rc.3 口径） | 部分行号在 rc.2/alpha.2 已漂移（如 `resolveGit` 位置、client-modules 报错行）；施工以本文引用为准 | 本文全体 |

### 7.3 报告核对一致项（抽样）

ui-cordis 双端清单字段（:84 ↔ `ui-cordis/package.json`）；插件插槽表 :93-96、两段注册、openResource 签名、createSnapshotStore 归属、pointer-events 警示——均与源码一致（【UI】§9）；GitRunner env 四项/超时/上限/AbortSignal（:77 ↔ git.ts）；session-title-llm 范式（:83 ↔ 源码）；能力缺口 G1-G5 定性成立。

---

## ⑧ 数据缺口

1. **`docs/notes/host-debug-runbook.md` 不存在**（本次逐一核对）。第⑤节改以内容正对的 `docs/notes/real-host-install-startup-test.md`（真实宿主调试与验证施工方案）为底本精炼；若原计划另有 runbook 文件，其内容未进入本地图。
2. **第三方 client 包的 remote-client 挂载链路未核实**：typert loader 只有 host 面（`packages/typert/loader/package.json` exports 仅 `.`）；`@deepseek-ai/dsh-api-remotes/client` 静态挂载的 27 个 contribution 编译进应用；git 插件 client 半的 `ctx.remote.git` 在浏览器侧如何可用**未在源码中找到机制**（【RPC】§8.2）。施工期首件事：最小 client 包实测（通道 C，§5.3）。
3. **client bundle 构建未实测**：`tsdown.client.ts` 闭包工厂格式有代码依据，但未实际构建一个 client bundle 验证图组合（【宿主调试】§3.C）。
4. **RPC 端到端未运行**：序列化行为来自源码阅读 + node 等价算法复现，非对运行中 Gateway 的真调用（【RPC】§3.4,§8.3）。
5. **Windows 具体行为未实测**：GitRunner 在真实 Windows 宿主跑通、`/dev/null` 在本机 Git for Windows 的归一化（沿 prior-session 实测）、`resolveExecutable` 的 PATHEXT 命中序——均为代码推断或沿既有结论（【基建】§10）。
6. **Node 22/24 vendored loader 行为差异未知**（`vendor/loader/src/internal.ts:136` 用 node 内部加载 API）；node 24 备选未安装（【宿主调试】§6.1）。
7. **事件流断线重试细节**未深入 `packages/client/connection` 实现（仅确认 onConnected/`connection/reset` 行为，【RPC】§8.4）。
8. **`sidebarRightTabs.register` 内部 fiber 归属**未深挖 cordis 内核；照抄 ui-deliverables 的 `ctx.effect` 外层包装即可（【UI】§10）。
9. 【形态】§8 全树 grep 曾在含 node_modules 镜像的目录上长时间未完成，改用排除目录的有界 grep（7 行命中，与结论一致）；node_modules 内镜像副本未逐一清点（【RPC】§8.1）。
10. 本会话对能力地图的核对为 9 项只读抽查（见各节 ✅核），未运行任何 dsh 测试/构建/宿主启动；未在本会话重跑【宿主调试】的启动命令。
