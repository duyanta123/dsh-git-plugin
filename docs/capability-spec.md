# dsh Git 插件能力清单（capability-spec）v1

> 日期：2026-10-30。本文是 v1 施工的接口权威：RPC 方法、事件（快照）契约、client 组件与 store、locale、NOTICE、测试、目录结构。
> 输入（本会话全文读过）：
> - `docs/feature-checklist.md`（67 项权威需求，v1 = 分期表第 v1 行，`feature-checklist.md:105`，含多仓库口径注 `feature-checklist.md:109`）
> - `docs/host-capability-map.md`（宿主机制权威，下称【map】，引用格式 `host-capability-map.md:行号`）
> - `docs/dsh-git-plugin-research-report.md` 第 2 章（F1–F6 定义 `:27-34`）与第 5 章（技术方案 `:112-342`）（下称【报告】）
> - `docs/prior-session-conclusions.md`（六条改进意见 `:15-30`；F7 提交图可行性与复用边界 `:46-64`）（下称【前次】）
> - `docs/ported-sources/SOURCES.md`（移植源登记与许可，下称【SRC】，引用格式 `SOURCES.md:行号`）
>
> **用户决议（本 spec 的硬前提）**：host 包名 `dsh-gitkit`，client 包名 `dsh-gitkit-ui`，**pnpm workspace 双包**，本地发布就绪（`file:`/`link:` 安装 + npm publish 均可直接进行）。
>
> **修订记录**：v1.1（2026-10-30）按评审修订六项阻断问题——B1 untracked diff 命令修正 + exit 1 白名单（本机实测 exit 129/1）；B2 client 包预留 remote-client 产物位并写明两种 spike 结局；B3 push 改显式 refspec（裸 `git push` 在 `push.default=matching` 下实测一次推多分支）；B4 status 摘除 `git diff --check` 步（冲突标记展示移交 FileDiffView）；B5 watcher `ignored` 改函数谓词（chokidar@5 内置 matcher 对字符串做整串相等比较，实读其 dist 证实）；B6 refs 取 peeled oid（annotated tag 实测 `objectname`≠`*objectname`）。
> **修订记录**：v1.2（2026-11-07）按实现偏离归真修订（NOTICE.md:42 既定偏离记录）——① watcher 实现为宿主 `ctx.fs.watch` 能力面（三目标 `.git/index`/`.git/HEAD`/`repoRoot`，depth:0 非递归；宿主 watch 回调不带内容路径）：事件路径防线 = 150ms 防抖 + R2 帧内容比对、嵌套目录变更只能靠 R4 兜底轮询捕获、fs 能力缺席降级纯轮询（R6）；§2.3 原案（插件自带 chokidar@5 递归 watcher）废弃、原案引用语保留于 §2.3 主表。② §0.4-9『dependencies 对齐 fs-local chokidar 版本』决议失效——chokidar `^5.0.0` 移入 devDependencies（唯一消费者 tests/support.ts 的 chokidarFsFace 测试替身），运行时依赖零 chokidar（§6 host 模板 dependencies/devDependencies 已同步）。③ vendored `packages/typert-protocol` 的 cordis peer 维持 `~4.0.6-alpha.1` 不动（owner 裁决 2026-11-05：副本零发布面——release.yml 只发 dsh-gitkit/dsh-gitkit-ui 两包、运行时从 registry 装官方同名 npm 包，放宽无生效面且破坏『未改动副本』四处登记）。④ §6 模板 engines 样例同步 0.1.2 定稿口径 `>=0.2.1-rc.5`（下限 = 唯一做过逐符号源码级对照的已发布版本，npm dist-tags latest；真机装载为发版前置门禁）。
>
> dsh 树内源码（`D:\DeepSeekHarness\...`）的行号一律**转引自【map】**，本会话未直接重读 dsh 源码；凡【map】标 ✅核 的条目是该图作者的核对结论，本文沿用并标注出处。

---

## 0. v1 范围与决议

### 0.1 v1 条目枚举（35 项，编号引用）

分期表 v1 行（`feature-checklist.md:105`）逐项展开为 35 项。下表同时给出**承载**（哪个 RPC / 组件 / 机制）与**验收测试锚点**（⑥ 的 spec 文件），全文其余章节用 `[清单 N]` 引用。

| # | 清单条目（`feature-checklist.md` 行） | 承载 | 测试锚点 |
|---|---|---|---|
| 1 | 工作区状态识别（修改/新增/删除/重命名/未跟踪/冲突，`:10`） | `git.status`（porcelain v2 `-z`） | status.spec |
| 2 | 文件级 diff（行级高亮/增删标记，`:11`） | `git.diff` + `FileDiffView`（照抄 ui-deliverables 纯函数，【map】§3.6） | diff.spec |
| 3 | 暂存区 diff（`:12`） | `git.diff('staged')` | diff.spec |
| 4 | 按文件/目录分组（`:13`） | `GitChangesTab` 分组渲染 | stores.spec（分组纯函数） |
| 5 | .gitignore 与未跟踪区分（`:14`） | porcelain v2 默认不列 ignored；untracked 组即"非 ignored 未跟踪" | status.spec |
| 6 | 冲突文件检测与冲突标记（`:15`） | `git.status` XY 码 → `conflicted` 组（文件检测）；`FileDiffView` 高亮 `<<<<<<<`/`=======`/`>>>>>>>` 行（标记展示，§3.1） | status.spec / diff-view.spec |
| 7 | 多仓库（`:16`） | v1 口径：单 session 单仓库做透（§0.2 决议 3） | status.spec（单仓库） |
| 9 | 文件级 stage / unstage（`:20`） | `git.stage` / `git.unstage` | mutations.spec |
| 11 | 部分提交=只提交已暂存内容（`:22`） | `git.commit` 恒提交当前 index（勾选由 stage/unstage 组合完成） | commit.spec |
| 12 | discard 带确认（`:23`） | `git.discard` + `GitConfirmDialog` 双次确认 | mutations.spec |
| 15 | 提交信息编辑（`:28`） | `GitCommitDialog` 文本域 | —（UI） |
| 16 | AI 自动生成提交信息（`:29`） | `git.generateCommitMessage`（prepareCall 范式） | message-gen.spec |
| 17 | Conventional Commits 校验（`:30`） | client 端 `CONVENTIONAL_COMMIT_RE` 警示（不阻断） | message-gen.spec |
| 19 | amend（`:32`） | `git.commit({amend:true})` + 对话框 amend 入口 | commit.spec |
| 20 | pre-commit hook 处理（`:33`） | commit 保留用户 hook；失败→结构化错误；`skipHooks` 可跳过 | commit.spec |
| 24 | ahead/behind 计数（`:39`） | porcelain v2 `# branch.ab` | status.spec |
| 25 | push / pull 基础（`:40`） | `git.push` / `git.pull`（ff-only）/ `git.fetch` | sync.spec |
| 26 | 首推自动 set-upstream（`:41`） | `git.push({setUpstream:true})`（无 upstream 时结构化报错引导） | sync.spec |
| 31 | Commit Graph（`:48`） | `git.log`/`git.refs` + `GitGraphTab` + `computeGraphLayout` | graph-layout.spec |
| 32 | 提交详情（`:49`） | `git.show({oid})` | log-refs-show.spec |
| 33 | 每提交文件变更对比（`:50`） | `git.show({oid, path})` | log-refs-show.spec |
| 44 | 危险操作审批（v1 子集=push/discard 确认，`:63`） | Tier C 权限级 + 二次确认框架 | —（UI + §1.0.4） |
| 47 | 右上角悬浮入口+角标（`:68`） | `GitHeaderButton` @ `conversation.session.header.utilities` | loader-smoke（装载） |
| 48 | 提交/推送按钮（`:69`） | 对话框 Commit / Commit & Push；菜单 Push/Pull/Fetch | —（UI） |
| 49 | 可读错误提示（`:70`） | 错误码体系（§1.0.5）+ `GitErrorNotice` | message-gen.spec（错误路径）+ 各 spec 错误断言 |
| 50 | 可撤销/二次确认（`:71`） | stage/unstage 互逆提示 + 确认框架（§3.4） | —（UI） |
| 51 | 快捷键与命令面板入口（`:72`） | **v1 只交付菜单/tab 入口**；快捷键依赖 dsh 命令面板机制——能力地图未定位到该插槽，列为前置核实项（§0.4-7），**不硬凑** | — |
| 52 | 自动刷新（`:73`） | §2 刷新契约（host watcher + 轮询 + 写后失效） | stores.spec |
| 53 | 暗色主题与国际化（`:74`） | 主题跟随 dsh primitives；i18n = §4 | —（locale 注册测试进 stores.spec） |
| 54 | 无 git/无凭证友好提示（`:75`） | `git/no-repository`、`git/auth-failed` → `GitErrorNotice`/header 空态 | status.spec / sync.spec |
| 55 | 提交前 git 身份检查（`:79`） | `git.commit` 前置校验 → `git/identity-missing` | commit.spec |
| 59 | 二进制/大文件 diff 友好处理（`:83`） | numstat 二进制标记 → `binary:true`、patch 上限 → `oversized`，UI 占位 | diff.spec |
| 64 | 空仓库/首次提交完整流程（`:88`） | unborn 分支路径：status `(initial)`、unstage→`rm --cached`、首提交 | status.spec / mutations.spec / commit.spec |
| 65 | detached HEAD 显示（`:89`） | `BranchState.detached` + header/图高亮 | status.spec |
| 67 | 推送前 diverged 检测（`:91`） | `git.push` 前置 rev-list 计数 → `git/diverged` | sync.spec |

> 枚举实测 **35 项**（分期表自述"约 35 项"，`feature-checklist.md:105`；任务描述"约 30 项"以分期表为准）。

### 0.2 决议记录

1. **双包**（用户决议）：`dsh-gitkit`（host）+ `dsh-gitkit-ui`（client）。与【map】§1.2 的"单包双导出"建议（`host-capability-map.md:33-39`）不同——用户已定，按双包执行。后果：
   - 线路类型放 host 包 `src/types.ts`，经 `exports["./types"]` 暴露；client **只 `import type`**（编译期擦除，不构成 runtime-import，不违反"feature 插件禁止 runtime-import 另一 feature 插件的值"，`host-capability-map.md:37`）。**边界澄清（B2）**：type-only 擦除只解决"对 host 包的值依赖"；client 运行期调用 RPC 还需要**自己包的 strict 描述符产物**（输入/输出 codec——client 只认 strict，`requireStrictInputs`，`host-capability-map.md:149`），该产物位与两种 spike 结局见 §7 与 §0.4-1；
   - 两个包各自携带 `cordis.patch.yml`（各插一行 `insert`），经 `dsh plugin add` 安装时由 reconcile 自动追加进 `dsh.profile.bundles`（`host-capability-map.md:107`）；
   - client 包需要最小 node 入口（Loader 按 `name` 导入 main，`host-capability-map.md:89`），apply 主体在 `./client` 导出。
2. **serviceKey = `'git'`**（wire namespace，端点 `git/status` 等）；通过 `isTypertRemoteSegment` 校验（`/^[A-Za-z0-9_$.-]+$/`，`host-capability-map.md:142`）。
3. **多仓库口径**（`feature-checklist.md:109`）：v1 host 持有**单一 repoRoot**，RPC 不带 cwd/repo 参数；多 session 打开同一仓库视图是可接受的 v1 行为。"不阻碍"的具体预留：所有 wire 类型不带仓库耦合字段，v2 多仓库时在方法签名追加可选 `repoId`（本 spec 不设计）。
4. **事件广播不可用**（【map】§2.5，`host-capability-map.md:176-183`）：外部 profile bundle 无法新增可转发事件（`API_REMOTE_FORWARDED_EVENTS` 静态收口、30 项、无 `git/*`）。**【报告】:254 的"Typert 事件广播 git/status"不成立**（deviation D4，`host-capability-map.md:447`）。v1 传输 = 轮询 + 写后失效（§2）。
5. **权限模型 v1**：v1 无 agent 工具面（[清单 45] 是 v3），所有写 RPC 只由用户在 UI 点击触发；host 端做日志与结构化错误，不做"调用来源鉴别"（【报告】:280 建议的来源校验依赖 `ctx.invocation.peer` 语义，未核实，列为前置核实项 §0.4-6）。

### 0.3 明确不做（v2/v3 防膨胀，一律不设计）

`feature-checklist.md:106-107` 的 v2/v3 条目全部不进本 spec，点名常被顺手带入的：hunk/行级 stage（10）、stash（14）、分支新建/切换/删除 UI（23；【前次】:29 明确 v1 不做分支切换）、tag（30）、blame（34）、历史搜索（35）、分支对比（36）、cherry-pick/revert/reset（37）、虚拟未提交节点（38）、检查点/归因/聚合（39–41）、自动提交/自动开分支（42/43）、agent 工具面（45）、PR（46）、force push（27）、多 remote 选择 UI（57）、hook 输出面板（63）、写操作审计事件特性（66；§1.0.6 的 logger 例行日志不算）、三方冲突解决 UI（13）、merge/rebase（28/29）、git init 引导（8）、worktree/submodule 视图（61/62）。

### 0.4 施工期前置核实清单（宿主机制未决项，按优先级）

以下条目是【map】明示未核实或本 spec 无法从输入材料确定的，**施工第一步先做核实/spike，再按结论微调接口**（不改变本 spec 的类型形状）：

1. **client 半 `ctx.remote.git` 浏览器挂载链路**：第三方 profile bundle 的 remote-client 产物如何在浏览器可用，源码未核实到（【map】⑧.2，`host-capability-map.md:469`）；client 只认 strict 描述符（`requireStrictInputs`，`host-capability-map.md:149`）——运行期需要真实 codec，type-only import 提供不了（B2）。→ 施工第 0 步：最小 client 包 + 假 `@Remote` 方法走通道 C 实测（【map】§5.3 通道 C，`host-capability-map.md:379`）；host 包 exports 必须带 `./typert`（TYPERT_HOST_EXPORT 自动注册 host 面，`host-capability-map.md:144`），strict 产物用 typert-generator 生成勿手编。**两种结局的落法都已预留（§7）**：
   - **结局 A（存在挂载机制）**：client 包生成 `lib/typert.remote-client.js`（typert-generator 产物，勿手编），经 `exports["./typert"]` 发布，按 spike 证实的机制挂载（boot graph 注入或既有注册 API——以实测为准）；`files` 已含 `lib`，无需改清单。
   - **结局 B（无挂载机制）**：v1 client 数据面不可用 ⇒ 必须先推动 dsh 侧（开放 client 侧 strict 描述符注册 API，或把插件收编内建以走 `api-remotes/client` 的静态挂载链路）；此时从 client 包 exports 移除 `./typert` 占位。wire 类型与 host 半**不受影响**；受影响的是 client 包结构与构建脚本——§0.4-1 的承诺相应限定为"**RPC 线路类型形状不变**"，client 包结构按 spike 结论重构。
2. **`@deepseek-ai/dsh-typert-protocol` 的 npm 包名与真实版本 range**：【报告】:173 用此名，【map】只给了仓库路径 `packages/typert/protocol`（`host-capability-map.md:141`）。→ `npm view` 核实后回填 package.json。
3. **RPC 端到端序列化行为**：来自源码阅读 + node 等价复现，未对运行中 Gateway 真调用（【map】⑧.4，`host-capability-map.md:471`）。
4. **`ctx.subprocess.spawn` 的 stdin 管道支持**：决定 `git commit -F -`（消息走 stdin）是否可用；不支持则回落临时文件 `-F <tmpfile>`（§1.4）。
5. **`request/header` 事件 payload 形状**（generateCommitMessage 的模型路由捕获，【map】§4.3 `host-capability-map.md:303`）。
6. **`ctx.invocation.peer` 能否鉴别"用户动作 vs 其他来源"**（§0.2 决议 5）。
7. **dsh 命令面板/快捷键注册机制**（[清单 51]）。
8. **dsh 仓库 LICENSE 的版权行原文**（NOTICE 需要，§5）。
9. **fs-local 的 chokidar 精确版本**（`packages/fs/fs-local/package.json:36`，【map】§4.2 `host-capability-map.md:297`——我们 dependencies 里对齐它）；**chokidar@5 `ignored` 的 Matcher 类型与匹配语义**已部分实读核实（dsh 树 `node_modules/.pnpm/chokidar@5.0.0/node_modules/chokidar/index.d.ts:29,40,45`：`Matcher = string | RegExp | MatchFunction | MatcherObject`；`index.js:24-26`：字符串=整串相等、RegExp=test、函数谓词、`{path, recursive}` 对象匹配）——本 spec 统一用函数谓词（三种语义下都正确）；若 fs-local 对齐版本变为 v3（真 anymatch/glob 语义）需复核谓词兼容。**【v1.2 失效注记】『dependencies 对齐 fs-local chokidar 版本』决议失效**——实现按实测偏离改用宿主 `ctx.fs.watch` 能力面（NOTICE.md:42 既定偏离记录；§2.3 v1.2 行），插件运行时依赖零 chokidar（chokidar 仅存 devDependencies，tests/support.ts 测试替身消费）；上段 chokidar@5 Matcher 语义知识保留为背景，不再构成本插件依赖决策依据。

---

## ① RPC 方法清单

### 1.0 接口总则

#### 1.0.1 服务骨架

```ts
// dsh-gitkit src/index.ts —— 形态依据【map】§2.1（host-capability-map.md:124-144）
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol' // 包名待核实（§0.4-2）
import z from '@deepseek-ai/schemastery'
import type { GitPluginConfig } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context { git: GitService }
}

export default class GitService extends TypertRemoteService {
  static inject = ['subprocess', 'fs', 'llm'] as const   // 全部依赖就绪才激活（host-capability-map.md:131）
  static Config: z<GitPluginConfig> = GitConfigSchema

  constructor(ctx: Context, config: GitPluginConfig) {
    super(ctx, 'git')           // serviceKey = Cordis 注册名 = wire namespace
    // …内部模块组装（runner/status/watcher/repo 解析）
  }
  // 只有 @Remote 装饰的方法暴露给 client（host-capability-map.md:146-149；报告 :192 的"public 自动暴露"已被 D3 纠正）
  // …@Remote 方法见 §1.1–1.8
}
```

硬规则（来自【map】，施工时逐条对照）：

- **只有 `@Remote` 方法过线**；辅助方法（repo 解析、watcher、缓存）一律宿主内部（`host-capability-map.md:146-149`）。
- **SRC 反射兜底要求参数是唯一标识符**：禁解构/默认值/rest；`signal` 作最后参数被识别为取消信号且不入 wire（`host-capability-map.md:149`）。本 spec 所有签名遵守：标量参数用位置参数，可选集合收进一个 options 对象；取消信号一律最后一位。
- client **只认 strict 描述符**（`host-capability-map.md:149`）→ host 包必须发布 `./typert` 产物（`host-capability-map.md:144`）。
- Host 方法抛 `RemoteError(code, message, details)`；抛普通 `Error` 会折叠成 `gateway/internal`（message 保留但丢域信息）（`host-capability-map.md:171`）。域错误码在包内 `declare module` 扩 `RemoteErrorDetailsMap`（`host-capability-map.md:173`；模块归属包名按 §0.4-2 核实）。
- 服务未就绪时 client 得 `gateway/service-unavailable` → UI 显示重试（`host-capability-map.md:174`）。

#### 1.0.2 Host Config（schemastery；client 半 Config 不生效——`host-capability-map.md:114`，所以全部运行期配置在 host）

```ts
// dsh-gitkit src/types.ts
export interface GitPluginConfig {
  /** 仓库根。空串 = 自动发现：对宿主进程 cwd 跑 `rev-parse --show-toplevel`（【map】§4.1 禁用 locateGitWorkspace，host-capability-map.md:287） */
  repoRoot: string
  /** 快速命令超时：status/diff/log/refs/show/stage/unstage/discard */
  fastTimeoutMs: number          // 默认 30_000（沿【报告】5.3.1 statusTimeoutMs 量级，dsh-git-plugin-research-report.md:183）
  /** commit 超时：pre-commit hook 可能慢 */
  commitTimeoutMs: number        // 默认 120_000
  /** 网络命令超时：push/pull/fetch */
  networkTimeoutMs: number       // 默认 120_000（沿【报告】pushTimeoutMs，:184）
  /** AI 提交信息 LLM 调用超时 */
  llmTimeoutMs: number           // 默认 60_000
  /** 单条 git 命令 stdout 字节上限（溢出保尾部 + truncated，【map】§4.1，host-capability-map.md:278） */
  outputMaxBytes: number         // 默认 8_388_608
  /** diff/show 单文件 patch 上限（字节），超过置 oversized（[清单 59]） */
  diffFilePatchMaxBytes: number  // 默认 262_144
  /** diff/show 单次调用 patch 总预算（字节），超过截断（opencode patchBudget 语义，SOURCES.md:68） */
  diffTotalPatchMaxBytes: number // 默认 2_097_152
  /** log 每页默认条数（client 可传更小） */
  logDefaultLimit: number        // 默认 500
  /** log 单页上限（GitLens getGraph 默认 5000，SOURCES.md:108） */
  logMaxLimit: number            // 默认 5_000
  /** host 文件监听开关（宿主 ctx.fs.watch 三目标 depth:0 监听 + 兜底轮询，见 §2.3；v1.2 归真） */
  watchEnabled: boolean          // 默认 true
  /** fs 事件防抖（ZCode DEBOUNCE_MS=150，SOURCES.md:36） */
  debounceMs: number             // 默认 150
  /** 兜底轮询间隔（ZCode useGitAutoRefresh 60s，SOURCES.md:40） */
  pollIntervalMs: number         // 默认 60_000
  /** LLM 路由覆盖；空 = 从 request/header 捕获（§0.4-5） */
  llmProvider: string            // 默认 ''
  llmModel: string               // 默认 ''
}

export const GitConfigSchema: z<GitPluginConfig> = z.object({
  repoRoot: z.string().default(''),
  fastTimeoutMs: z.number().default(30_000),
  commitTimeoutMs: z.number().default(120_000),
  networkTimeoutMs: z.number().default(120_000),
  llmTimeoutMs: z.number().default(60_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  diffFilePatchMaxBytes: z.number().default(256 * 1024),
  diffTotalPatchMaxBytes: z.number().default(2 * 1024 * 1024),
  logDefaultLimit: z.number().default(500),
  logMaxLimit: z.number().default(5_000),
  watchEnabled: z.boolean().default(true),
  debounceMs: z.number().default(150),
  pollIntervalMs: z.number().default(60_000),
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
})
```

默认值合并发生在 schema 校验时（`host-capability-map.md:113`）。v1 不用 `.volatile()`（config 变更走 fiber 重载即可，`host-capability-map.md:187`）。

#### 1.0.3 共享线路类型（`dsh-gitkit` `src/types.ts` 全量；client 仅 `import type`）

序列化边界硬规则（【map】§2.3，`host-capability-map.md:154-167`）：**RPC 出入参只允许 null/string/boolean/有限 number/plain object/array**；`Date` 出参自动转 ISO（所以类型里直接写 ISO string）；**出参禁 `Map`/`Set`**（静默拷成 `{}` 丢数据，`host-capability-map.md:162`）；入参可选字段由调用方**省略**而非传显式 `undefined`（`host-capability-map.md:158`）；strict codec 会丢弃编译类型未声明的对象字段（`host-capability-map.md:158`）。二进制不走 RPC 体（Uint8Array 会摘成 attachments，本插件不用，diff 一律文本/占位）。

```ts
// ---------- 变更条目 ----------
export type ChangeKind =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'

/** porcelain v2 条目行（1 <XY>… 或 2 <XY>…<orig>）+ 并发 numstat 结果的合并视图 */
export interface FileChange {
  path: string                 // -z 下原样字节路径（中文/空格安全，【报告】:237）
  origPath: string | null      // renamed/copied 的原路径（格式 2 行），其余 null
  kind: ChangeKind
  x: string                    // porcelain XY 首位（index 侧状态字符）
  y: string                    // porcelain XY 次位（worktree 侧状态字符）
  conflicted: boolean          // XY ∈ {DD,AU,UD,UA,DU,AA,UU}
  binary: boolean              // numstat 对该路径报 '-'（[清单 59]）
  additions: number | null     // binary 时 null
  deletions: number | null
  submodule: boolean           // porcelain sub 字段非 'N' 时 true；v1 只展示不递归（[清单 61] 为 v2）
}

// ---------- status ----------
export interface BranchState {
  name: string | null          // 当前分支短名；detached 时 null（[清单 65]）
  oid: string | null           // HEAD 全 oid；无提交仓库（branch.oid (initial)）时 null（[清单 64]）
  abbrevOid: string | null     // 短 oid，供 detached 展示
  upstream: string | null      // 如 'origin/main'；无 upstream 为 null
  ahead: number | null         // 无 upstream 时 null（[清单 24]）
  behind: number | null
  detached: boolean
  unborn: boolean              // 无提交仓库
}

/** git.status 的返回值；§2 的"快照"即此类型（未来若 dsh 开放事件转发，git/status 事件 payload 同型） */
export interface GitStatusSnapshot {
  repoRoot: string
  generatedAt: string          // ISO 时间戳（host 打点，用于 client 判新旧）
  branch: BranchState
  staged: FileChange[]         // X ∉ {'.','?'} 的条目（UU 会同时出现在 staged/unstaged，见下）
  unstaged: FileChange[]       // Y ∉ {'.','!'} 的条目
  untracked: FileChange[]      // X == '?' 的条目；porcelain 默认不列 ignored → 即"非 ignored 未跟踪"（[清单 5]）
  conflicted: FileChange[]     // XY ∈ {DD,AU,UD,UA,DU,AA,UU} 的视图分组（与上三组允许重叠）
  clean: boolean               // 以上四组全空
}

// ---------- diff ----------
export type DiffScope = 'worktree' | 'staged'

export interface DiffFile {
  path: string
  origPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  binary: boolean
  additions: number | null     // binary 时 null
  deletions: number | null
  patch: string | null         // unified diff 文本；binary/超预算/加载失败为 null（[清单 59] 占位语义）
  patchTruncated: boolean      // 本文件 patch 被单文件上限截断
  oversized: boolean           // 超过 diffFilePatchMaxBytes，UI 显示占位（[清单 59]）
}

export interface DiffResult {
  scope: DiffScope
  path: string | null          // null = 该 scope 全部变更文件（预算内）；指定路径 = 单文件
  files: DiffFile[]
  totalTruncated: boolean      // diffTotalPatchMaxBytes 触发
  generatedAt: string
}

// ---------- log / refs / show（提交图数据层，[清单 31/32/33]） ----------
export interface CommitInfo {
  oid: string
  parents: string[]            // 全 oid；root 提交为 []
  authorName: string
  authorEmail: string
  authoredAt: string           // ISO（%aI）
  committedAt: string          // ISO（%cI）——lane 布局的 topo 排序键（SOURCES.md:140）
  subject: string
  body: string                 // 可为 ''
}

/** 一页 log；分页契约 = 每次取 limit+1 条，多出 1 条 ⇒ hasMore，其余截去（防御性 over-fetch，GitLens over-walk 模式 SOURCES.md:108） */
export interface LogPage {
  commits: CommitInfo[]        // children-first（git log --topo-order 输出序）
  hasMore: boolean
  skipUsed: number
  limitUsed: number
}

export type RefType = 'local-branch' | 'remote-branch' | 'tag'
export interface RefInfo {
  type: RefType
  fullName: string             // refs/heads/main、refs/remotes/origin/main、refs/tags/v1
  shortName: string            // main、origin/main、v1
  oid: string                  // **peeled 提交 oid**：annotated tag 取 %(*objectname)，其余取 %(objectname)——图装饰按此匹配 commit.oid（§1.8）
}
export interface RefsSnapshot {
  refs: RefInfo[]
  head: {
    kind: 'branch' | 'detached' | 'unborn'
    name: string | null        // branch 时短名
    oid: string | null
  }
}

export interface CommitDetail {
  commit: CommitInfo
  files: DiffFile[]            // numstat（path 模式下含该文件 patch）
  totalTruncated: boolean
}

// ---------- 写操作结果 ----------
export interface StageResult   { staged: number }
export interface UnstageResult { unstaged: number }
export interface DiscardResult { discarded: number }   // tracked restore + untracked clean 合计文件数

export interface CommitOptions {
  message: string
  amend: boolean               // [清单 19]
  skipHooks: boolean           // [清单 20] → --no-verify
}
export interface CommitResult {
  oid: string
  shortOid: string
  branch: string | null
  amended: boolean
}

export interface PushOptions {
  setUpstream: boolean         // [清单 26]；无 upstream 且 false ⇒ git/no-upstream
}
export interface PushResult {
  remote: string
  branch: string
  upstream: string | null      // set-upstream 成功后非空
  setUpstreamUsed: boolean
}

export interface PullResult {
  fastForwarded: boolean       // v1 恒 true（非 ff 直接拒绝）
  oldOid: string
  newOid: string
  remote: string
}

export interface FetchOptions { remote: string | null }  // null = upstream 的 remote，否则 origin，否则报错
export interface FetchResult  { remote: string; pruned: boolean }

export interface GeneratedCommitMessage {
  message: string
  conventional: boolean        // CONVENTIONAL_COMMIT_RE 通过（[清单 17]）
  filesConsidered: number
}

// ---------- log/refs/show 入参 ----------
export interface LogOptions  { limit: number; skip: number }     // limit 钳到 [1, logMaxLimit]；skip ≥ 0
export interface ShowOptions { oid: string; path: string | null } // path=null：仅 meta+numstat；path 给定：含该文件 patch
```

#### 1.0.4 权限分级（对齐【报告】5.3.7，`dsh-git-plugin-research-report.md:275-280`；[清单 44/50]）

| 级 | 定义 | 方法 |
|---|---|---|
| **A 只读静默** | 不改仓库状态；自动刷新轮询可随时调；UI 无提示（后台 loading 指示除外） | `status` `diff` `log` `refs` `show` |
| **B 轻提示** | 改仓库状态但低危/可逆（stage⇄unstage 互逆；fetch 只更新 remote-ref）；UI 触发处给瞬时轻提示（toast/行内状态），无需对话框；结果可从 UI 立即看出并可逆 | `stage` `unstage` `fetch` `generateCommitMessage` |
| **C 必须 UI 显式确认** | 丢弃内容 / 改写历史 / 影响远程；只能由带明确动作语义的按钮触发，按钮文案即确认；其中 discard 还要**二次确认对话框**（[清单 12/44/50]）；diverged push 追加确认（§3.4） | `commit`（含 amend） `push` `pull` `discard` |

v1 无 agent 工具面（§0.2-5），Tier B/C 的 RPC **不允许**被任何自动化路径调用；host 侧以日志留痕（§1.0.6）。

#### 1.0.5 错误码体系（域码 = `git/<name>`；经 `RemoteError` 过线，client 按 `code` 判别不按 instanceof，`host-capability-map.md:172`）

```ts
// host 端 declare module 扩展（模块归属包名按 §0.4-2 核实后回填）
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'git/no-repository':     { probed: string }                       // 探测路径不是 git 仓库（[清单 54]）
    'git/identity-missing':  { missing: string[] }                    // 缺 user.name/user.email（[清单 55]）
    'git/nothing-staged':    { branch: string | null }                // 空提交保护（非 amend 时）
    'git/empty-message':     Record<string, never>
    'git/no-upstream':       { branch: string; hint: 'set-upstream' } // [清单 26] 引导
    'git/no-remote':         { branch: string | null; remotes: string[] }
    'git/diverged':          { branch: string; upstream: string; ahead: number; behind: number } // [清单 67]
    'git/push-rejected':     { remote: string; branch: string; reason: string; stderr: string }
    'git/auth-failed':       { stderr: string }                       // 凭证失败，stderr 原样回传（【前次】:23）
    'git/pull-diverged':     { branch: string; upstream: string; ahead: number; behind: number }
    'git/timeout':           { op: string; timeoutMs: number }
    'git/git-error':         { op: string; exitCode: number | null; stderr: string; truncated: boolean } // 兜底
    'git/llm-route-unresolved': Record<string, never>
    'git/llm-failed':        { stage: 'trim' | 'call' | 'parse'; reason: string }
  }
}
```

分类规则：非零退出先按 stderr 关键词分类（`Authentication failed`/`could not read Username`/`Permission denied (publickey)` → `git/auth-failed`；`[rejected]`/`non-fast-forward` → `git/push-rejected`；`Not possible to fast-forward` → `git/pull-diverged`），其余非零退出 → `git/git-error`（携带 exitCode + stderr 16KiB 尾部 + truncated，沿【map】§4.1 stderr 保留策略 `host-capability-map.md:278`）。gateway 保留码透传：`gateway/service-unavailable`（UI 重试）、`gateway/cancelled`、`gateway/input-invalid`（client 容忍陌生码，`host-capability-map.md:172`）。

#### 1.0.6 日志约定

- 用 `ctx.logger`；读操作 debug 级；写操作 info 级，字段 `{ op, durationMs, exitCode?, code?, pathCount?, amend?, setUpstream? }`；失败 warn 级附 `code`。
- **不落盘**提交 message 正文与文件内容（防密钥泄漏进日志）；stderr 尾部只在 debug 级且截 500 字符。
- 调试注意：`ctx.logger.info` 不出现在控制台（【map】§5.4，`host-capability-map.md:390`）——冒烟调试用 `process.stdout.write` 或 error 级，但这只限调试代码，正式代码仍走 logger。
- [清单 66] 的结构化审计事件是 v2，本节 logger 约定不是它的替代。

#### 1.0.7 执行底座（GitRunner，所有方法的公共实现前提）

- 抄 dsh 树内先例组合：`client-ui-forge/src/git.ts` 的 `runGit`（~50 行）+ `workspace-changes/src/git.ts` 的常量/env（【map】§4.1 组装建议，`host-capability-map.md:283-285`）。
- 读命令前缀 `GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']`（`host-capability-map.md:283`；`/dev/null` 无平台分支，【map】§4.5 `host-capability-map.md:316`）；**写命令不套** hooksPath 禁用与 `--no-optional-locks`（保留用户 hook 与正常锁，`host-capability-map.md:285`）。
- 全部命令 env：`GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` + 15 项 ambient `GIT_*` tombstone + `GIT_NO_LAZY_FETCH=1`（forge `GIT_ENV`，`host-capability-map.md:283`）；Codex `safe.bareRepository=explicit` 注入为 `-c` 参数（SOURCES.md:52）。
- argv 数组注入，绝不 shell；路径参数加 `--literal-pathspecs`（【报告】:247）；超时 `AbortSignal.any(caller, AbortSignal.timeout(cfg))`；stdout 溢出保尾部 + truncated；Windows 终止走 `taskkill /PID /T /F`（`host-capability-map.md:276-279`）。
- git 发现：`ctx.subprocess.resolveExecutable('git', undefined, signal)`（`host-capability-map.md:289`）；失败 → `git/git-error`（op='resolve-git'）+ UI 友好提示（[清单 54]）。
- repo 发现：对 `repoRoot || process.cwd()` 跑 `git rev-parse --show-toplevel`；"exit 128 + not a git repository → null" 范式（forge git.ts:99-103，`host-capability-map.md:287`）。失败 → 各方法抛 `git/no-repository`。
- 已知风险：`GIT_TERMINAL_PROMPT=0` 下 Windows Git Credential Manager 仍可能弹 GUI 窗口（【前次】:23）——写进 push/fetch 错误路径的 UI 提示文案。

---

### 1.1 `git.status` — 工作区快照 [清单 1/5/6/24/64/65]

- 权限 **A**；超时 `fastTimeoutMs`；幂等；并发去重：进行中的扫描共享同一 Promise（Codex status.rs 并发去重语义，SOURCES.md:53）。

```ts
@Remote()
async status(signal?: AbortSignal): Promise<GitStatusSnapshot>
```

实现命令（均读路径，套 GIT_PREFIX）：

1. `git status --porcelain=v2 --branch --untracked-files=all -z`（ZCode gitCliRepo.ts:549，SOURCES.md:33；【报告】:235）。
   - 头行解析：`# branch.oid <oid|(initial)>`、`# branch.head <name|(detached)>`、`# branch.upstream`、`# branch.ab +A -B`；unborn ⇒ `BranchState.unborn=true`，detached ⇒ `branch.head (detached)`（[清单 64/65]）。
   - 条目行：格式 1 与格式 2（重命名双路径）；分组规则按 `GitStatusSnapshot` 注释（UU 同时入 staged/unstaged/conflicted）。
2. 并发：`git diff --cached --numstat -z --find-renames`、`git diff --numstat -z --find-renames`（ZCode :876/:882，SOURCES.md:33）——回填 `additions/deletions/binary`。

> **v1.1 修订（B4）**：原第 3 步 `git diff --check`（采集冲突标记路径）已**删除**——strict codec 会丢弃编译类型未声明的字段（`host-capability-map.md:158`），其采集结果无法过线且无 host 内消费者；status 是最热路径（150ms 防抖 + 60s 轮询 + client 3s 轮询，§2.3），不为此多 spawn 一条无产出命令。[清单 6] 的两半分工：**冲突文件检测** = porcelain XY 码（上面第 1 步，权威信号）；**冲突标记展示** = `FileDiffView` 高亮 diff 内容中的 `<<<<<<<` / `=======` / `>>>>>>>` 行（纯函数 `flagConflictRows`，client/tests/diff-view.spec 覆盖）。
- 错误：`git/no-repository`；watcher 未启动时本调用即真值来源（§2）。
- 日志：debug。

### 1.2 `git.diff` — 工作区 / 暂存双路 [清单 2/3/59]

- 权限 **A**；超时 `fastTimeoutMs`；幂等。

```ts
@Remote()
async diff(scope: DiffScope, path: string | null, signal?: AbortSignal): Promise<DiffResult>
```

- `scope='worktree'`：`git diff --numstat -z --find-renames`（列文件）+ 每文件 `git diff --no-ext-diff --unified=3 --literal-pathspecs -- <path>` 取 patch；`scope='staged'`：同形加 `--cached`（"已暂存将要提交什么"，[清单 3]）。
- **untracked 文件**（scope='worktree' 且路径未被跟踪）：`git diff --no-index --unified=3 /dev/null -- <path>`——**恰好一个 `--`，紧邻文件路径**（纯读，不写对象库，符合【报告】2.2"不污染用户仓库" `:39`）。**本机实测（git 2.55.0.windows.2，win32 临时仓库）**：此形式输出正确 patch 且 **exit=1**（`--no-index` 的"有差异"语义；零字节文件也 exit=1——建文件本身就是差异）；而双 `--` 形态（`-- … -- <path>`）exit **129** 并打印 usage（第一个 `--` 后所有参数按路径解析）。⇒ **该命令 `allowedExitCodes = [0, 1]`**（0=无差异、1=有差异即成功，patch 从 stdout 解析；≥2 才是 `git/git-error`）——runner 的通用规则"非零退出=失败"（ok()，`host-capability-map.md:281`）在此命令上按白名单放宽，否则所有 untracked diff 都会被误判为失败（[清单 2] 对 untracked 失效）。stderr 上的非致命告警（本机实测出现 core.autocrlf 的 CRLF 提示）不构成失败。`/dev/null` 在 Git for Windows 作真实路径参数已在本机实测通过（与【map】§4.5 `host-capability-map.md:316` 的归一化结论互证）；仍保留兜底：exit ∉ 白名单 ⇒ 该文件 `patch:null` + `status:'added'` 占位（不重试）。
- 预算：单文件超 `diffFilePatchMaxBytes` ⇒ `oversized:true, patch:null`；总预算触发 ⇒ 停止追加 patch、`totalTruncated:true`（[清单 59]）。
- numstat 对 binary 报 `'-'` ⇒ `binary:true, patch:null`（[清单 59]）。
- 错误：`git/no-repository`、`git/git-error`（单文件 patch 失败不炸整体——该文件 `patch:null`，调用仍成功）。

### 1.3 `git.stage` / `git.unstage` / `git.discard` [清单 9/12]

- 权限：stage/unstage **B**，discard **C**（UI 二次确认）；超时 `fastTimeoutMs`。

```ts
@Remote()
async stage(paths: string[], signal?: AbortSignal): Promise<StageResult>
@Remote()
async unstage(paths: string[], signal?: AbortSignal): Promise<UnstageResult>
@Remote()
async discard(paths: string[], signal?: AbortSignal): Promise<DiscardResult>
```

| 方法 | 命令 | 要点 |
|---|---|---|
| stage | `git add --literal-pathspecs -- <paths...>`；`paths=[]` ⇒ `git add -A`（【报告】:261） | untracked 路径也走 add（暂存新文件） |
| unstage | `git restore --staged --literal-pathspecs -- <paths>`；**unborn 分支回落 `git rm --cached -- <paths>`**（【报告】:262；[清单 64]） | 先用 status 的 unborn 状态选路 |
| discard | tracked ⇒ `git restore --literal-pathspecs -- <paths>`；untracked ⇒ `git clean -fd --literal-pathspecs -- <paths>`（【报告】:263） | 混合列表拆两批；unmerged 路径 restore 会非零退出 → `git/git-error`，UI 文案提示先解决冲突（[清单 49]） |

- 结果计数以命令实际处理为准，写后**立即触发一次内部 refresh**（§2.3 失效矩阵）。
- 错误：`git/no-repository`、`git/git-error`。
- 日志：info（`pathCount`）。

### 1.4 `git.commit` — 含 amend 与空提交保护 [清单 11/15/17/19/20/55/64]

- 权限 **C**（对话框按钮即确认；amend 若改写已推送历史由 UI 追加警示，§3.3）；超时 `commitTimeoutMs`。

```ts
@Remote()
async commit(options: CommitOptions, signal?: AbortSignal): Promise<CommitResult>
```

前置校验（顺序执行，任一失败即抛对应码，不执行 commit）：

1. 身份检查 [清单 55]：`git config --get user.name` 与 `git config --get user.email`，任一为空 ⇒ `git/identity-missing { missing }`（Windows 新机最常见，`feature-checklist.md:79`）。
2. 空提交保护：非 amend 时，`git diff --cached --quiet` 退出码 0（staged 为空）⇒ `git/nothing-staged`；amend 时允许空 staged（仅改写 message）。
3. `message` 为空/全空白 ⇒ `git/empty-message`。

执行：

- 命令 `git commit -F -`，message 经 **stdin** 传入（避免 `-m` 转义/换行问题，【报告】:265）；`ctx.subprocess.spawn` 的 stdin 支持未核实（§0.4-4），**回落方案：`-F <临时文件>`（`ctx.fs` 写入、进程结束后删除）**。
- `options.amend` ⇒ 追加 `--amend`；`options.skipHooks` ⇒ 追加 `--no-verify`；否则**保留用户 hook**（写命令不套 hooksPath 禁用，`host-capability-map.md:285`；[清单 20]）。
- hook 失败：非零退出且 stderr 含 hook 输出 ⇒ `git/git-error`（stderr 原样进 details，UI 可读展示 [清单 20/49]）；hook 超时 ⇒ `git/timeout { op:'commit' }`。
- 成功后 `git rev-parse --verify HEAD` 取 oid，`git rev-parse --abbrev-ref HEAD` 取分支（detached ⇒ null）。
- 写后失效：status + log + refs + show 缓存全部失效（§2.3）。
- 日志：info（op/ durationMs/amend；不含 message 正文）。

### 1.5 `git.push` — set-upstream 与 diverged 检测 [清单 25/26/44/67]

- 权限 **C**；超时 `networkTimeoutMs`。

```ts
@Remote()
async push(options: PushOptions, signal?: AbortSignal): Promise<PushResult>
```

流程（【前次】改进第 3 条的失败路径全覆盖，`:23`）：

1. 解析 upstream：`git rev-parse --abbrev-ref --symbolic-full-name @{u}` 失败 ⇒ 分支无 upstream：
   - `options.setUpstream=false` ⇒ **`git/no-upstream { branch }`**（client 据此提供"设置 upstream 并推送"入口，[清单 26]，不静默自动 set-upstream——首次推送目标属 Tier C 决策）；
   - `options.setUpstream=true` ⇒ 确定 remote/branch：当前分支 `git branch --show-current`；remote 取 `git config --get branch.<name>.remote`，为空时：恰有一个 remote ⇒ 用之；多个 ⇒ `origin` 存在用 `origin`，否则 **`git/no-remote { remotes }`**。
2. diverged 预检 [清单 67]：有 upstream 时 `git rev-list --left-right --count <upstream>...HEAD`（输出 `behind\tahead`，注意列序）；`ahead>0 && behind>0` ⇒ **`git/diverged { ahead, behind }`**，不执行 push（v1 不提供 force push——[清单 27] 是 v2）。client 引导 fetch/pull。
3. 执行——**禁止裸 `git push`，一律显式 remote + 全量 refspec**：`git push <remote> refs/heads/<remoteBranch>:refs/heads/<remoteBranch>`；set-upstream 路径 `git push --set-upstream <remote> refs/heads/<branch>:refs/heads/<branch>`（ZCode :1654，SOURCES.md:33）。**本机实测（git 2.55.0.windows.2，本地 bare 远端）**：裸 `git push origin` 在 `push.default=matching` 下一次 `--dry-run` 输出**两行** ref 更新（`feature -> feature` 与 `master -> master`），即一次"推送按钮"推送全部分支；显式 refspec 只推目标分支。裸 push 属于对 Tier C 动作的静默扩权——runner 的 env 净化只 tombstone ambient `GIT_*` 环境变量，**不隔离用户 `~/.gitconfig`**。`<remote>`/`<remoteBranch>` 从已解析 upstream（形如 `origin/main`）拆分，**不**用本地分支名（防本地名 ≠ 上游名时推错目标）；set-upstream 路径的 `<branch>` 用本地分支名（此时无 upstream 可拆）。
4. 远端拒绝：stderr 含 `[rejected]`/`non-fast-forward` ⇒ `git/push-rejected`；凭证失败关键词 ⇒ `git/auth-failed`（stderr 原样回传；GCM 弹窗风险写进 UI 提示，§1.0.7）。
5. 日志：info（setUpstream）。

### 1.6 `git.pull` / `git.fetch` [清单 25]

- 权限：pull **C**、fetch **B**；超时 `networkTimeoutMs`。

```ts
@Remote()
async pull(signal?: AbortSignal): Promise<PullResult>
@Remote()
async fetch(options: FetchOptions, signal?: AbortSignal): Promise<FetchResult>
```

- **pull**：无 upstream ⇒ `git/no-upstream`；先 diverged 预检（同 §1.5-2）⇒ 分叉即 **`git/pull-diverged`**（v1 只做 ff，merge/rebase UI 是 v3，[清单 28/29] 不设计）；执行 `git pull --ff-only`；`Not possible to fast-forward` ⇒ 同样映射 `git/pull-diverged`。成功返回新旧 oid。
- **fetch**：remote 解析 `options.remote` → upstream 的 remote → 恰一个 remote → `origin` → 否则 `git/no-remote`；执行 `git fetch --prune <remote>`；凭证失败 ⇒ `git/auth-failed`（[清单 58] 的"凭证失败可读提示"部分在 v1 由本错误路径覆盖，定时 fetch 本身是 v2）。

### 1.7 `git.generateCommitMessage` [清单 16/17]

- 权限 **B**；超时 `llmTimeoutMs`（LLM 侧再加 `using deadline(signal, llmTimeoutMs, code)` 双保险，【map】§4.3 `host-capability-map.md:302`）。

```ts
@Remote()
async generateCommitMessage(signal?: AbortSignal): Promise<GeneratedCommitMessage>
```

- 无 staged ⇒ `git/nothing-staged`（生成只基于 staged diff，[清单 16]/【报告】F5 `:33`）。
- 裁剪常量沿用 ZCode（SOURCES.md:35，gitCommitMessageGenerator.ts:10-20）：最多 20 文件 / 8 个 diff / 总 12k 字符 / 单文件 2k / 消息上限 1k。v1 **不带会话上下文**（ZCode 的 12 条 4k 上下文需要会话事件面，未核实，§0.4-5；v1 已知简化）。
- LLM 调用照 `session-title-llm` 范式（【map】§4.3，`host-capability-map.md:302`）：输入字节上限调用方自检 → `prepareCall(config, signal)` → 流式组装 → finish 解释；`purpose` 是封闭联合，一次性辅助调用省略（`host-capability-map.md:304`）。
- 路由解析（【报告】:83 已被 D10 纠正，`host-capability-map.md:303`）：`Config.llmProvider/llmModel` 显式优先；否则用 host 侧缓存的最近 `request/header` 路由（payload 形状 §0.4-5 核实）；都没有 ⇒ `git/llm-route-unresolved`。
- prompt 要求输出单行 Conventional Commits；返回前用移植的 `CONVENTIONAL_COMMIT_RE`（ZCode :20）置 `conventional` 标志，**不阻断**（[清单 17] 由 client 提示）。
- 失败：`git/llm-failed { stage }`；调用前后记可观测日志（对齐标题生成器的 request 事件惯例，【报告】:273）。

### 1.8 `git.log` / `git.refs` / `git.show` — 提交图数据层 [清单 31/32/33]

- 权限 **A**；超时 `fastTimeoutMs`；分页 single-writer 语义在 client store 层实施（§3.3.4，GitLens graphSession 契约 SOURCES.md:106）。

```ts
@Remote()
async log(options: LogOptions, signal?: AbortSignal): Promise<LogPage>
@Remote()
async refs(signal?: AbortSignal): Promise<RefsSnapshot>
@Remote()
async show(options: ShowOptions, signal?: AbortSignal): Promise<CommitDetail>
```

- **log**：`git log --topo-order --pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%b%x1e -n <limit+1> --skip <skip>`（字段分隔 0x1f、记录分隔 0x1e，`%b` 内换行不破坏解析；命令形态对齐【前次】F7 数据层 `:51`）。`limit` 钳到 `[1, logMaxLimit]`；取 `limit+1` 条判 `hasMore`。unborn HEAD：git 退出非零且 stderr 含 `does not have any commits yet` ⇒ 返回空页（`commits:[], hasMore:false`，不抛错——[清单 64]）。refs 装饰不进 log（`refs()` 单独取，client 合并）。
- **refs**：`git for-each-ref --format=%(objectname)%09%(*objectname)%09%(refname)%09%(refname:short) refs/heads refs/remotes refs/tags` + `git symbolic-ref --quiet --short HEAD`（opencode vcs/git.ts:260，SOURCES.md:69）。**`RefInfo.oid` 必须取 peeled 值**：`%(*objectname)` 非空（annotated tag ⇒ tag 对象而非 commit）用之，否则回落 `%(objectname)`——**本机实测（annotated `git tag -a v1`）**：`objectname`=tag 对象、`*objectname`=commit，两者不等；非 tag ref 的 `*objectname` 为空串。只取 `%(objectname)` 会让 annotated tag 永远装饰不到提交图（`GraphGraphTab` 按 `ref.oid == commit.oid` 匹配 chips，[清单 31] 失败）。symbolic-ref 失败 ⇒ detached（oid 取 `git rev-parse HEAD`）；unborn ⇒ `head.kind='unborn'`。
- **show**：meta + `git show --no-color --numstat -z --find-renames --format=… <oid>`（numstat → `files`）；`options.path` 非空时追加该文件 patch（预算同 §1.2，[清单 33]）。binary/超大处理同 `DiffFile` 语义。

### 1.9 方法总表

| 方法 | 权限 | 超时 | 写后失效（§2.3） | 主要错误码 |
|---|---|---|---|---|
| status | A | fast | —（自身即真值） | no-repository |
| diff | A | fast | — | no-repository, git-error |
| stage | B | fast | status+diff | no-repository, git-error |
| unstage | B | fast | status+diff | no-repository, git-error |
| discard | C | fast | status+diff | no-repository, git-error |
| commit | C | commit | status+diff+log+refs+show | identity-missing, nothing-staged, empty-message, timeout, git-error |
| push | C | network | status+refs | no-upstream, no-remote, diverged, push-rejected, auth-failed, timeout |
| pull | C | network | status+diff+log+refs+show | no-upstream, pull-diverged, auth-failed, timeout |
| fetch | B | network | status+refs | no-remote, auth-failed, timeout |
| generateCommitMessage | B | llm | — | nothing-staged, llm-route-unresolved, llm-failed, timeout |
| log | A | fast | — | no-repository（unborn 返回空页不抛错） |
| refs | A | fast | — | no-repository |
| show | A | fast | — | no-repository, git-error |

---

## ② 事件契约（快照类型 + 刷新时机）

### 2.1 与宿主机制的冲突声明（如实标注，不硬凑）

任务原案"host 广播 `git/status` 事件、client 订阅"**对外部 profile bundle 不可实现**：事件转发 allowlist 是 dsh 源码内静态收口（`API_REMOTE_FORWARDED_EVENTS`，30 项，无任何 `git/*`），无第三方注册 API；事件源全局唯一，重复注册直接 throw（【map】§2.5，`host-capability-map.md:176-183`；deviation D4 `:447`）。因此 **v1 的"事件契约"落实为：快照类型（§1.0.3 的 `GitStatusSnapshot`）+ 刷新触发契约（本节）**。`ctx.remote.$on` 只能订阅 allowlist 内事件，本插件不使用；client 断线重连监听 `connection/reset`（该事件在 allowlist 语义内由 gateway 发出，ui-cordis 范例 `host-capability-map.md:182`）。

### 2.2 快照类型

即 §1.0.3 的 `GitStatusSnapshot`（唯一权威定义处）。client 侧缓存于 HostReadStore（§3.2），`generatedAt` 用于丢弃过期乱序响应。

### 2.3 刷新触发与失效矩阵

**host 侧**（StatusEngine）：

| 触发 | 动作 | 出处 |
|---|---|---|
| 仓库文件变化 | 宿主 fs 能力面监听三目标——`.git/index`、`.git/HEAD`、`repoRoot`（`ctx.fs.watch`，**depth:0 非递归**；【map】§4.2 D9，`host-capability-map.md:294-297`；宿主 watch 回调不带内容路径）。事件路径的防线因此**不是路径过滤，而是 150ms 防抖（`debounceMs`）+ R2 帧内容比对**（新旧快照按签名比对，未变化不渲染）→ 重算快照缓存。**已知限制：嵌套目录内文件编辑不触发任何 watch 事件**，只能靠 R4 兜底轮询（`pollIntervalMs`）捕获；fs 能力缺席时 R6 降级纯轮询。**原案（插件自带 chokidar@5 递归 watch `repoRoot` + 函数谓词过滤 `.git`/`node_modules`）未采用**——按实现偏离归真（NOTICE.md:42 既定偏离记录；谓词 matcher 语义等原案知识见 v1.1 修订行与 git 历史 v1.1 版本文本） | ZCode fileWatcherService 防抖与引用计数**结构**（SOURCES.md:36）；dsh fs-local watch 实读（depth:0，`host-capability-map.md:294-297`） |
| 自身写操作完成 | 对应方法内部立即重算（§1.9 失效列） | 【报告】:253 |
| 定时兜底 | `pollIntervalMs`（默认 60s）轮询重算 | ZCode useGitAutoRefresh 60s（SOURCES.md:40） |
| 生命周期 | watcher 与定时器挂宿主 ctx，`ctx.effect` 清理（`host-capability-map.md:187`） | 【map】§4.2 |

**client 侧**（host 快照不推送，所以轮询是 transport；【map】§2.5 结论 `host-capability-map.md:181-182`）：

| 触发 | 动作 |
|---|---|
| 周期轮询 | 前台每 3s、页面隐藏每 30s 调 `git.status()`（常量在 client 包；header 角标"秒级"目标【前次】:36 的量级） |
| 任一 Tier B/C RPC 成功返回 | 立即重拉 status + 按 §1.9 失效列清缓存 |
| `ctx.on('connection/reset')` | 全缓存清空 + 立即重拉（`host-capability-map.md:182`） |
| 窗口聚焦 | 立即重拉 status |
| 快照比对 | 新旧快照按 `branch.oid + 分组计数 + generatedAt` 做廉价对比，未变化不触发渲染 |

### 2.4 未来事件迁移预案（不做实现）

若 dsh 未来开放第三方事件注册（需 Events 签名 + allowlist + `TypertRemoteEventSelection` 三件套，`host-capability-map.md:183`），`git/status` 事件 payload 直接采用 `GitStatusSnapshot`，client 只需把轮询循环替换为 `$on` 订阅——store 与组件层零改动。本预案不产生任何 v1 代码。

---

## ③ client 组件清单、插槽映射与 store

### 3.1 组件清单与插槽映射

client 包 `inject = ['slots', 'locale', 'remote', 'remote.git', 'sidebarRightTabs', 'sidebarRight']`（**必须含 `sidebarRightTabs`**，缺它 `ctx.sidebarRightTabs` 不可达——D7，`host-capability-map.md:247`；`remote.git` 使调用等待 git 服务就绪，ui-cordis 同款 `remote.<ns>` 形态 `host-capability-map.md:151`）。

| 组件 | 插槽 / 机制 | 注册形态（全部照【map】§3.2/3.3 范本） | 对应清单 |
|---|---|---|---|
| `GitHeaderButton` | `conversation.session.header.utilities`（list/session） | `ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name, id: 'dsh-plugin.git.header', order: -10, locale: NS, inject }, GitHeaderButton))`（ui-open-in-app 范本 `host-capability-map.md:205`） | 47/48/54/65 |
| `GitChangesTab` | `sidebar.right.pane.tab`（keyed/session），key=`dsh-plugin.git.changes` | 两段注册：先 `ctx.sidebarRightTabs.register(changesDefinition)`（apply 顶层 + `ctx.effect`，`host-capability-map.md:227`），再 `ctx.slots.inject('sidebar.right.pane.tab', function* () { yield ctx.slots.register({ name, key: 'dsh-plugin.git.changes', locale: NS, store: createChangesTabStore(), inject }, GitChangesTab); yield …graph… })`（多贡献 generator 范本 `host-capability-map.md:198`） | 1–6/9/11/12/2/3/4/5 |
| `GitGraphTab` | 同上，key=`dsh-plugin.git.graph`，**`keepMounted: true`**（图重算昂贵，【map】§3.3 `host-capability-map.md:219`） | 同上 generator 第二个 yield | 31/32/33 |
| `GitCommitDialog` | 由 `GitHeaderButton` 菜单 / ChangesTab 按钮拉起（浮层用 dsh primitives，**不注册 root 槽**——root 被AppFrame 占据，`host-capability-map.md:199`） | 普通组件 | 11/15/16/17/19/48/55 |
| `GitErrorNotice` | 各组件内嵌错误展示 | 普通组件 | 49/54 |
| `GitConfirmDialog` | 二次确认框架 | 普通组件 | 12/44/50 |
| `FileDiffView` | ChangesTab/GraphTab 内嵌 | 普通组件（照抄 ui-deliverables 纯函数，禁 runtime-import，【map】§3.6 `host-capability-map.md:251-259`） | 2/3/59 |

两个 tab 类型定义（kind 不同 ⇒ 无冲突；自己的地址空间自己认领，【map】§3.3 `host-capability-map.md:235`）：

```ts
// 地址铸造仿 ui-deliverables changes.ts:143-165（【map】§3.3，host-capability-map.md:233）
export const gitChangesAddress = 'dsh-resource://dsh-plugin.git/changes'
export const gitGraphAddress   = 'dsh-resource://dsh-plugin.git/graph'

const changesDefinition: SidebarRightTabDefinition = {
  id: 'dsh-plugin.git.changes',
  kind: 'git-changes',                 // openTab 判别式
  keepMounted: false,
  patterns: ['dsh-resource://dsh-plugin.git/**'],
  priority: 'extension',               // 缺省即此档
  title: () => t('tab.changes.title'),
}
const graphDefinition: SidebarRightTabDefinition = {
  id: 'dsh-plugin.git.graph',
  kind: 'git-graph',
  keepMounted: true,
  patterns: ['dsh-resource://dsh-plugin.git/**'],
  priority: 'extension',
  title: () => t('tab.graph.title'),
}
```

打开：`ctx.sidebarRight.openResource(gitChangesAddress)`（同地址幂等；非 `dsh-resource://` 或无人认领会 throw，`host-capability-map.md:231`）。v1 不注册 `shell.overlay`（header 按钮已覆盖 [清单 47]；悬浮胶囊是备选形态【报告】:94）。

**组件行为要点**：

- `GitHeaderButton`：分支名（detached ⇒ 短 oid [清单 65]；无仓库 ⇒ 友好空态 [清单 54]，**无 init 引导**——[清单 8] 是 v2）+ 变更角标（staged+unstaged+untracked+conflicted 总数，ZCode `main ●3` 形态【报告】F1 `:29`）。点击开菜单：变更审查 / 提交图 / 提交… / 提交并推送… / 推送 / 拉取 / 获取（[清单 48]）。
- `GitChangesTab`：三组列表 staged / changes(unstaged) / untracked + 冲突组置顶（[清单 1]）；文件/目录树分组（[清单 4]）；变更卡片 `+N −M`、状态徽标、勾选（ZCode GitPaneChangeCard 交互，SOURCES.md:39）；勾选 ⇄ stage/unstage（[清单 9]）；discard 走二次确认（[清单 12]）；点文件懒加载 diff（[清单 2/3]）；底部"提交…"按钮开对话框；二进制/超大文件占位（[清单 59]）。
- `GitGraphTab`：见 §3.3。点击提交行 → 行内详情（`git.show`）→ 文件点击 → `FileDiffView`（[清单 32/33]）；HEAD/当前分支高亮、refs chips（【前次】F7 v1 交互范围 `:55`）。
- `GitCommitDialog`：message 文本域（[清单 15]）+ "AI 生成"按钮（[清单 16]，生成中可取消）+ 非 Conventional 时行内警示不阻断（[清单 17]）+ staged 文件计数 + **amend 入口**：勾选框"修订上一次提交 (shortOid subject)"；当 status 显示有 upstream 且 ahead==0 时附"将改写已推送历史，之后推送需强制"警示（[清单 19]，v1 不提供 force push 故只警示）；Commit / Commit & Push 两动作（[清单 48]）；`git/identity-missing` 错误时展示缺失字段与配置指引（[清单 55]）；staged 为空时禁用 Commit（[清单 11] 保护的前端镜像）。

### 3.2 store 设计

范式依据【map】§3.4（`host-capability-map.md:237-243`）：数据缓存用**范式 A**（裸 `createSnapshotStore` observable，仿 ui-deliverables HostReadStore `host-read-store.ts:30-81`），槽位 UI 状态用**范式 B**（`defineStore` draft mutator）；**模块级 store 句柄禁止**，一律工厂函数；root 句柄不得挂 session 槽（`host-capability-map.md:242`）。session 域 body 切 Session 会重挂载 ⇒ 数据缓存必须放 root 域（apply 顶层创建 + `ctx.effect` 清理，`host-capability-map.md:243`）。

```ts
// —— 范式 A：插件内数据缓存（root 作用域，apply 顶层 createGitHostReadStore()，ctx.effect 清理） ——
export interface GitHostReadState {
  repo: { available: boolean; root: string | null; checking: boolean }
  status: GitStatusSnapshot | null
  statusInFlight: boolean
  statusError: GitErrorLike | null          // { code, message, details }
  refs: RefsSnapshot | null
  log: {
    commits: CommitInfo[]                   // 追加式窗口（appendRowsAtCursor 语义，GitLens graph.utils.ts:14 SOURCES.md:107）
    hasMore: boolean
    loadedCount: number
    loadMoreInFlight: boolean               // single-writer：进行中拒绝新的 more 请求（graphSession.ts:11-18 SOURCES.md:106）
    refreshing: boolean
    error: GitErrorLike | null
  }
  diffs: Record<string, DiffEntryState>     // key = `${scope}:${path}`；{ state:'idle'|'loading'|'ready'|'error', file?: DiffFile, error? }
  details: Record<string, CommitDetailState> // key = oid；show 缓存
}

export interface GitHostReadStore {
  getState(): GitHostReadState
  subscribe(selector: (s: GitHostReadState) => unknown, fn: () => void): () => void
  refreshStatus(): Promise<void>            // in-flight 去重
  loadDiff(scope: DiffScope, path: string): Promise<void>
  loadMoreLog(): Promise<void>              // skip = loadedCount；single-writer
  reloadLog(): Promise<void>                // 清窗重载（commit 后）
  showCommit(oid: string, path?: string): Promise<void>
  refreshRefs(): Promise<void>
  invalidate(kind: 'status' | 'diff' | 'log' | 'refs' | 'show' | 'all'): void
  reset(): void                             // connection/reset
}

// RPC 注入口：生产 = ctx.remote.git 适配器；测试 = 内存假实现（§⑥）
export interface GitRpcClient {
  status(): Promise<RemoteResult<GitStatusSnapshot>>
  diff(scope: DiffScope, path: string | null): Promise<RemoteResult<DiffResult>>
  stage(paths: string[]): Promise<RemoteResult<StageResult>>
  unstage(paths: string[]): Promise<RemoteResult<UnstageResult>>
  discard(paths: string[]): Promise<RemoteResult<DiscardResult>>
  commit(options: CommitOptions): Promise<RemoteResult<CommitResult>>
  push(options: PushOptions): Promise<RemoteResult<PushResult>>
  pull(): Promise<RemoteResult<PullResult>>
  fetch(options: FetchOptions): Promise<RemoteResult<FetchResult>>
  generateCommitMessage(): Promise<RemoteResult<GeneratedCommitMessage>>
  log(options: LogOptions): Promise<RemoteResult<LogPage>>
  refs(): Promise<RemoteResult<RefsSnapshot>>
  show(options: ShowOptions): Promise<RemoteResult<CommitDetail>>
}
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: GitErrorLike }
export interface GitErrorLike { code: string; message: string; details?: unknown } // 按 code 判别，不按 instanceof（host-capability-map.md:172）
```

轮询循环（§2.3 client 侧表）作为 root 作用域对象在 apply 顶层启动，`ctx.effect` 清理；写操作成功后的失效由调用组件（经 tab store action）触发 `invalidate` + `refreshStatus`。

```ts
// —— 范式 B：槽位 UI 状态（随槽注册，session 作用域） ——
export interface ChangesTabState {
  expandedDirs: Record<string, boolean>
  selectedPath: string | null
  pendingConfirm: { kind: 'discard'; paths: string[] } | null
}
export interface ChangesTabActions {
  toggleDir(path: string): void
  select(path: string | null): void
  requestDiscard(paths: string[]): void
  resolveConfirm(ok: boolean): void
}
export interface GraphTabState {
  selectedOid: string | null
  detailPath: string | null
}
export interface GraphTabActions {
  select(oid: string | null): void
  openDetailPath(path: string | null): void
}
```

### 3.3 提交图（[清单 31/32/33]；可行性依据【前次】§三点五 `:46-64`）

#### 3.3.1 lane 布局纯函数（可快照单测；算法教材 = pvigier 博客，SOURCES.md:140；GitLens MIT 区只提供数据层类型与契约——MIT 区无 lane 实现，`SOURCES.md:112-118`）

```ts
// dsh-gitkit-ui src/client/graph/computeGraphLayout.ts（纯函数，~200–400 行，不依赖 React/DOM）
import type { CommitInfo, RefInfo } from 'dsh-gitkit/types'   // 仅 type

export interface GraphLayoutInput {
  commits: readonly CommitInfo[]   // children-first（git log --topo-order 输出序）；函数内部按 committedAt
                                   // 做确定性 topo 重排（temporal topological sort，tiebreak 保持输入序）
  headOid: string | null           // unborn / detached 时由调用方传入（detached 传 HEAD oid）
  refs: readonly RefInfo[]         // 仅用于行上 ref 装饰与 tip 标记，不影响 lane 分配
}
export interface GraphEdge {
  fromRow: number; fromLane: number
  toRow: number;   toLane: number  // toRow === rows.length 表示悬垂边（父不在已加载窗口，分页边界）
  toOid: string | null             // 悬垂边为 null
  kind: 'parent' | 'dangling'
}
export interface GraphRowLayout {
  row: number
  oid: string
  lane: number                     // 本提交所在泳道（0 起，稠密化）
  isHead: boolean
  refs: string[]                   // 指向本提交的 ref 短名（HEAD→分支 用 'HEAD -> main' 形态由渲染层处理）
  passthrough: number[]            // 穿过本行的边所在 lane（不含自身）
  edges: GraphEdge[]               // 本提交 → 各父提交
}
export interface GraphLayoutResult {
  rows: GraphRowLayout[]
  laneCount: number                // 窗口内最大泳道数（渲染列宽）
}
export function computeGraphLayout(input: GraphLayoutInput): GraphLayoutResult
```

契约：**确定性**（同输入同输出，快照单测）；悬垂父（分页边界）→ `dangling` 边画到窗口底边；octopus（>2 parents）、root 提交、unborn（空输入→空结果）都必须定义良好。泳道分配规则（教材语义自研）：活跃 lane 集合 + 每提交取最小空闲 lane；merge 提交的多父边折返。

#### 3.3.2 SVG 渲染

- 行内 gutter：每行一个 `<svg>` 切片（宽 = `laneCount * LANE_W`，动态），节点圆点在 `(lane→x, ROW_H/2)`，边用直线/贝塞尔连接上下行切片（虚拟滚动友好——只渲染可见行）。
- 颜色：lane 序号取模 8 色 CSS 变量调色板（跟随 dsh 暗色主题 [清单 53]）；tip/HEAD 特殊描边。不用 GitLens WebGPU 路线（那是十万级优化，【前次】:53）。

#### 3.3.3 行虚拟化

- `@tanstack/react-virtual` 基线模块直接 import，**不得**写进 `dsh.client.external`（【map】§3.7，`host-capability-map.md:263`）；npm 侧进 devDependencies。
- `useVirtualizer({ count: rows.length, estimateSize: () => ROW_H(28), getScrollElement, overscan: 12 })`（ui-trajectory 生产参数范式，`host-capability-map.md:264`）。

#### 3.3.4 分页加载

- 底部"加载更多"按钮（v1 不做无限滚动，交互最简）：`store.loadMore()` → `git.log({ limit, skip: loadedCount })` → 追加。
- **single-writer**：同一时刻只允许一个 more 请求，进行中再触发直接忽略（GitLens graphSession 契约，SOURCES.md:106）。
- commit/pull 后 `reloadLog()` 清窗重载（旧窗口对新历史无意义）。

### 3.4 可读错误提示与二次确认框架（[清单 49/50/12/44/67]）

- `GitErrorNotice({ error }: { error: GitErrorLike })`：`code` → locale 键 `error.<code 去 'git/' 前缀>`；`error.message`（host 诊断信息）与 `details.stderr` 折叠进 `<details>`（stderr 原样展示，【前次】:23）；按 code 提供动作按钮：
  - `gateway/service-unavailable` → 重试；
  - `git/no-upstream` → "设置 upstream 并推送"（确认后 `push({setUpstream:true})`）；
  - `git/diverged` → "获取(fetch)" / "拉取(pull)"；
  - `git/pull-diverged` → 说明文案（v1 无 merge UI，引导用户在终端处理）；
  - `git/auth-failed` → 凭证指引文案 + GCM 弹窗提示（[清单 54]）；
  - 陌生 code → 透传展示 message（client 容忍陌生码，`host-capability-map.md:172`）。
- `GitConfirmDialog`：`{ title, message, items?: string[], severity: 'normal' | 'danger', confirmLabel, cancelLabel }`；`severity='danger'` 时确认按钮红色且需 1.5s 延迟可用（防手滑）。使用点：discard（列出文件数与不可逆警示 [清单 12]）、diverged 后的 push（列 ahead/behind）、amend 已推送历史的对话框内警示确认。
  - **施工修订（2026-11-01，评审整改）**：danger 的「1.5s 延迟可用」实现为**确认勾选闸**——确认按钮在勾选「不可逆」复选框（`checkboxLabel`，props 形状加宽一项）之前禁用（`ui-model.confirmButtonEnabled` 纯逻辑 + `GitConfirmDialog` 组件，每次打开重置）。不采用延迟计时器的理由：显式勾选对键盘/辅助技术用户语义更明确（无定时竞速、无时序耦合），且同时承担「已知晓不可逆」的确认记录；闸强度不低于 1.5s 延迟。偏差登记于 PORTING.md ④-K 红线段。

---

## ④ locale 计划（en/zh，[清单 53]）

机制依据【map】§4.4（`host-capability-map.md:307-310`）：client 侧 `ctx.locale.register(NS, { zh, en })`，**zh+en 双语齐备强制**（缺一注册 throw）；槽注册传 `locale: NS` 组件获得类型化 `t`；词典扁平 `Record<string,string>` + `{name}` 插值；apply 层 `ctx.locale.bind(NS)`。

- 命名空间：`'git'`；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'git': GitLocaleKey } }`——**键集权威 = zh 词典**（`host-capability-map.md:249`）。
- host 端错误 `message` 用英文诊断风格；用户可见文案全部在 client locale（错误码 → `error.*` 键），host `locale/*.json` 仅作为包资产惯例保留 en/zh 两份（[清单 53] 不做八语种）。
- 键分组（全扁平，`git.` 由 namespace 承担，键内不再带前缀）：

| 组 | 键（种子） |
|---|---|
| header | `header.branch {name}`、`header.detached {oid}`、`header.noRepo`、`header.unborn`、`header.badge {count}` |
| menu | `menu.review` `menu.graph` `menu.commit` `menu.commitPush` `menu.push` `menu.pull` `menu.fetch` |
| tab | `tab.changes.title` `tab.graph.title` |
| changes | `changes.staged` `changes.unstaged` `changes.untracked` `changes.conflicted` `changes.empty` `changes.emptyRepo` `changes.binary` `changes.oversized` `changes.truncated` `changes.loadFailed` |
| commit dialog | `commit.title` `commit.placeholder` `commit.generate` `commit.generating` `commit.amend {shortOid} {subject}` `commit.amendWarning` `commit.stagedCount {count}` `commit.notConventional` `commit.commit` `commit.commitPush` |
| graph | `graph.loadMore` `graph.noCommits` `graph.head` `graph.loading` |
| confirm | `confirm.discard.title` `confirm.discard.message {count}` `confirm.push.diverged {ahead} {behind}` `confirm.ok` `confirm.cancel` |
| error | 每个域错误码一键：`error.no-repository` `error.identity-missing` `error.nothing-staged` `error.empty-message` `error.no-upstream` `error.no-remote` `error.diverged` `error.push-rejected` `error.auth-failed` `error.pull-diverged` `error.timeout` `error.git-error` `error.llm-route-unresolved` `error.llm-failed`；`common.retry` `common.details` `common.close` |

样例（终稿以 zh 词典为准逐键补齐 en）：`header.badge` zh `"{count} 处变更"` / en `"{count} changes"`；`confirm.discard.message` zh `"将丢弃 {count} 个文件的工作区改动，且无法撤销。"` / en `"Discard working-tree changes of {count} file(s)? This cannot be undone."`；`error.diverged` zh `"本地与远程已分叉（领先 {ahead} 落后 {behind}），请先拉取。"` / en `"Local and remote have diverged (ahead {ahead}, behind {behind}). Pull first."`。

规则：新增键必须 zh/en 同步；纯函数单测断言两词典键集一致（进 stores.spec）。

---

## ⑤ NOTICE 与署名策略

**总底线**（SOURCES.md:151）：Apache-2.0（ZCode/Codex/Cline）与 MIT（opencode/GitLens MIT 区、dsh）材料可移植但**必须保留版权与许可声明**；GitLens `packages/plus/**`、mhutchie/vscode-git-graph、gitamine（GPL-3.0）**一行代码不进仓库**。

### 5.1 文件级移植登记表（随施工推进维护；每行都要落 5.3 的文件头）

| 我们的目标文件 | 来源文件 | 来源版本 | 许可 | 移植方式 |
|---|---|---|---|---|
| `host/src/git-runner.ts` | dsh `packages/experimental/client-ui-forge/src/git.ts`（runGit）+ `packages/deliverables/workspace-changes/src/git.ts`（GitRunner 常量/env） | dsh 树 `f3803c9697` | MIT（dsh） | 手抄组合（【map】§4.1 `host-capability-map.md:283-285`） |
| `host/src/status.ts` | ZCode `packages/services/src/git/repo/gitCliRepo.ts`（status v2 -z 与 numstat 并发段） | `3c5b2276` | Apache-2.0 | 逐段移植；child_process → `ctx.subprocess`（SOURCES.md:33） |
| `host/src/status.ts`（v1 解析器回退段） | Cline `apps/examples/desktop-app/sidecar/source-control.ts`（porcelain v1，"No commits yet"、重命名双行） | `f817e59f` | Apache-2.0 | 移植解析器（SOURCES.md:82） |
| `host/src/sync.ts`（安全参数） | Codex `codex-rs/git-utils/src/operations.rs`（SAFE_BARE_REPOSITORY_CONFIG、DISABLED_HOOKS_PATH）+ `status.rs`/`fsmonitor.rs` | `7c11b807` | Apache-2.0 | 参数清单与注入位置翻译成 TS（Rust 不移植，SOURCES.md:52-55） |
| `host/src/mutations.ts` / `commit.ts` | ZCode `gitCliRepo.ts`（写命令段）+ `gitService.ts`（编排状态机） | `3c5b2276` | Apache-2.0 | 移植；IPC → RPC/轮询（SOURCES.md:34） |
| `host/src/sync.ts` | ZCode push `--set-upstream`（:1654）与 `upstream...HEAD`（:1391-1400）段 | `3c5b2276` | Apache-2.0 | 逐段移植（SOURCES.md:33） |
| `host/src/message-gen.ts` | ZCode `gitCommitMessageGenerator.ts`（裁剪常量 :10-17、`CONVENTIONAL_COMMIT_RE` :20、prompt 约束 :197-199） | `3c5b2276` | Apache-2.0 | 移植；LLM 调用换 `ctx.llm.prepareCall`（SOURCES.md:35） |
| `host/src/watcher.ts` | ZCode `fileWatcherService.ts`（防抖 150ms 与引用计数**结构**） | `3c5b2276` | Apache-2.0 | 只抄结构；watch 换宿主 `ctx.fs.watch` 三目标 depth:0（v1.2 归真，NOTICE.md:42；SOURCES.md:36） |
| `client/src/client/diff/hunkRows.ts` 等 | dsh `packages/client/ui-deliverables/src/client/.../FileDiff.tsx:66-125`（hunkRows/splitRows/renderedHunks，MAX_RENDERED_LINES=5000） | dsh 树 | MIT（dsh） | 照抄纯函数进自己包（【map】§3.6 `host-capability-map.md:259`） |
| `client/src/client/graph/graph-types.ts` | GitLens `packages/git/src/models/graph.ts`（行/头类型收敛）+ `graphSession.ts`（single-writer 契约）+ `graph.utils.ts`（窗口追加 reducer） | `020cfc1b` | **MIT 区**（LICENSE:3-5 除外条款，SOURCES.md:99） | 类型收敛 + 契约移植；逐文件登记（SOURCES.md:105-107） |
| `host/src/log.ts`（分页/增量模式） | GitLens `packages/git-cli/src/providers/graph.ts`（over-walk :2487、spurious-empty :1822 **模式**） | `020cfc1b` | MIT 区 | 只摘模式不整体移植（2561 行含 GitLens 基建耦合，SOURCES.md:108） |
| client 组件交互 | ZCode `GitActionMenu.tsx` / `GitPane.tsx` / `GitPaneChangeCard.tsx` / `useGitAutoRefresh.ts` | `3c5b2276` | Apache-2.0 | 抄交互逻辑与状态流，不抄样式（组件库不同，SOURCES.md:38-40） |
| `host/src/sync.ts`（命令选择） | opencode `packages/core/src/git.ts` / `plugin/vcs/git.ts` | `b6c43a52` | MIT | **语义学习，不整文件移植**；若日后逐段搬运，升级为文件级登记并保留 MIT 头（SOURCES.md:68-69） |
| `host/src/commit.ts`（语义） | aider `repo.py` | `5dc9490b` | Apache-2.0（模板） | 只学语义，Python 不移植（SOURCES.md:92） |
| lane 布局算法 | pvigier 博客（temporal topo sort / active-branches / merge-children） | 网页教材 | 文章可自由学习（SOURCES.md:140） | 自研实现；**gitamine（GPL-3.0）代码一行不搬** |

### 5.2 仓库级文件

- 根与两个包都放：`LICENSE`（本项目 MIT，版权行写法待 §0.4-8 核实后定）、`NOTICE.md`（来源与决议摘要 + 上表）、`THIRD_PARTY_NOTICES.md`（全文附 Apache-2.0 ×3（Z.AI Co., Ltd / OpenAI / Cline Bot Inc.）+ MIT ×3（opencode / GitLens Axosoft+Eric Amodio / dsh）+ 本项目 MIT）。
- **禁止出现在包内**：GitLens `LICENSE.plus` 约束下的任何内容（其文本只留在 `docs/ported-sources/` 作合规证据，SOURCES.md:110）；mhutchie 项目的任何代码——THIRD_PARTY_NOTICES 中**不得出现对其代码的引用式搬运**（SOURCES.md:133），NOTICE 里仅允许"阅读参考、未使用代码"一行说明。
- 发布就绪：两个包的 `files` 字段必须包含 `LICENSE` `NOTICE.md` `THIRD_PARTY_NOTICES.md`（§⑦）。

### 5.3 移植文件头模板（每个登记文件必须带）

```ts
/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/repo/gitCliRepo.ts
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-xx — child_process 换 dsh ctx.subprocess；错误类型改领域错误（RemoteError）
 * SPDX-License-Identifier: Apache-2.0
 */
```

（MIT 来源同构：`Ported from gitkraken/vscode-gitlens@020cfc1b… — packages/git/src/models/graph.ts — MIT — Copyright (c) 2021-2026 Axosoft, LLC dba GitKraken; Copyright (c) 2016-2021 Eric Amodio`。Apache-2.0 第 4(b) 条要求修改文件带显著变更说明，Modifications 行即此。）*

### 5.4 合规守卫（进测试）

`tests/licenses.spec.ts`：扫描 `packages/*/src` 与 `packages/*/lib`，断言 (a) 每个登记表内文件有对应来源头；(b) 全库 grep 不出现 `packages/plus`、`vscode-git-graph` 的标识符、gitamine 路径；(c) `THIRD_PARTY_NOTICES.md` 不含 mhutchie 代码文本。

---

## ⑥ 测试计划（按【map】§5.5 的 dsh 测试约定，`host-capability-map.md:392-394`）

**三层**：① 解析器/布局/裁剪纯函数单测（fixture 快照）② GitRunner + 真实临时 git 仓库集成测试 ③ 装载冒烟。断言纪律：**验证世界而非自述**——每个写操作后用独立 `git log`/`git status`（execFileSync）重读外部状态断言。

**support.ts**（照 `workspace-changes/tests/support.ts` 范式）：`mkdtemp` + cleanups + afterEach 逆序清理；真实 Cordis Context + `LocalSubprocessRuntime` 注入；`git init -q -b main` + `execFileSync('git', ['-c','user.email=t@example.com','-c','user.name=t',…])` 造提交；bare 远端 helper（本地路径 remote，**不依赖网络**——git 协议不通，【前次】:74）；`it.skipIf(process.platform === 'win32')` 机制保留——v1 无需 skip（Windows 是目标环境，【前次】:27）。

| spec 文件（每模块一条） | 层 | 覆盖与验收判据 |
|---|---|---|
| `host/tests/git-runner.spec.ts` | 集成 | 超时→kill 树（Windows taskkill 路径）；abort；stdout 上限→`truncated:true` 且保尾部；exitCode 白名单；env tombstone 生效（ambient `GIT_DIR` 不影响结果）；`resolveExecutable` 命中。验收：runner 契约（§1.0.7）逐条 |
| `host/tests/status.spec.ts` | 单测+集成 | porcelain v2 `-z` fixture 快照（中文/空格路径、重命名双行、conflict XY、submodule 行不炸）；集成七类变更识别 [清单 1]、untracked vs ignored [清单 5]、ahead/behind [清单 24]、detached [清单 65]、unborn `(initial)` [清单 64]、`--check` 冲突标记检测 [清单 6] |
| `host/tests/diff.spec.ts` | 单测+集成 | numstat `-z` 解析；worktree/staged 双路一致性 [清单 2/3]；binary→`binary:true,patch:null` [清单 59]；超大文件→`oversized`；**untracked `--no-index`：断言 exit=1 进 allowedExitCodes 白名单且 patch 有内容（零字节文件也 exit=1）、补一条"双 `--` 形态 exit 129"回归守卫防倒退**；中文路径全程 round-trip |
| `host/tests/mutations.spec.ts` | 集成 | stage/unstage（含 unborn→`rm --cached` [清单 64]）；discard tracked/untracked 混合；**写后 world 重读**；unmerged 路径 discard → `git/git-error` |
| `host/tests/commit.spec.ts` | 集成 | 正常提交（world 重读 `git log`）；amend 改 oid 保留 tree [清单 19]；空 staged 拒绝 [清单 11]；空 message；identity 缺失→`git/identity-missing` [清单 55]；pre-commit hook 失败 stderr 进 details、`skipHooks` 绕过 [清单 20]；首提交 [清单 64] |
| `host/tests/sync.spec.ts` | 集成 | bare 远端：无 upstream→`git/no-upstream`；set-upstream 首推成功 [清单 26]（world 重读 upstream 配置）；双侧提交→`git/diverged` 带 ahead/behind [清单 67]；pre-receive 拒绝→`git/push-rejected`；凭证失败分类（`GIT_TERMINAL_PROMPT=0` 下 stderr 断言）→`git/auth-failed`；pull ff 成功 / 非 ff→`git/pull-diverged`；fetch prune |
| `host/tests/log-refs-show.spec.ts` | 单测+集成 | format 解析（含含分隔符的 body）；分页 limit+1/hasMore/skip；topo 序；unborn→空页 [清单 64]；refs 三类 + detached/unborn head + **annotated tag 装饰命中（peeled oid == commit.oid，轻量 tag 与分支不受影响）**；show meta+numstat+单文件 patch [清单 32/33] |
| `host/tests/message-gen.spec.ts` | 单测 | 裁剪常量边界（20/8/12k/2k/1k）；`CONVENTIONAL_COMMIT_RE` 命中/不命中 [清单 17]；mock LLM：route 未解析→`git/llm-route-unresolved`；超时→`git/timeout` |
| `client/tests/graph-layout.spec.ts` | 快照单测 | 线性/分叉/合并/octopus/悬挂父（分页边界）/detached/unborn 输入 → `computeGraphLayout` 快照；确定性（同输入两次全等）[清单 31] |
| `client/tests/diff-view.spec.ts` | 快照单测 | 照抄的 hunkRows/renderedHunks 回归；**冲突标记行（`<<<<<<<`/`=======`/`>>>>>>>`）识别与高亮标记**（[清单 6] 的"标记"半边，B4 修订后的消费者） |
| `client/tests/stores.spec.ts` | 单测（假 GitRpcClient） | in-flight status 去重；失效矩阵（§1.9）逐格断言；log single-writer（进行中 loadMore 被拒）；快照比对去渲染；zh/en 键集一致（§4） |
| `tests/loader-smoke.spec.ts` | 冒烟 | spawn 真 dsh bin + 临时 `DSH_HOME` + `plugin --profile dbg add file:<包>` + 启动 → 判据：日志出现插件激活（grep `HELLO-FROM` 标记或 bundles 含包名）、无 `entry did not activate`；curl 401 fence 正常（【map】§5.2/5.4 `host-capability-map.md:335-390`） |

---

## ⑦ 目录结构（pnpm workspace 双包）

```
dsh-git-plugin/                          # workspace 根（本仓库，构建于 D:\deep seek harness\dsh-git-plugin，不动 dsh 树——【map】§5.5）
├── package.json                         # private:true；scripts: build/test/lint/publish:local
├── pnpm-workspace.yaml                  # packages: ['packages/*']
├── tsconfig.base.json
├── LICENSE  NOTICE.md  THIRD_PARTY_NOTICES.md   # §5；两包 files 里再含一份（npm 发布合规）
├── packages/
│   ├── git/                             # dsh-gitkit —— host（node 半）
│   │   ├── package.json                 # 见下
│   │   ├── cordis.patch.yml             # - insert: [{ id: 'dsh-plugin-git', name: 'dsh-gitkit' }]
│   │   ├── tsdown.config.ts             # 自写（树外不能 import dsh 的预设，host-capability-map.md:77）
│   │   ├── locale/en.json  locale/zh.json
│   │   ├── src/
│   │   │   ├── index.ts                 # GitService（@Remote 方法）+ default export（文件尾，无工厂包装，host-capability-map.md:138）
│   │   │   ├── config.ts                # GitConfigSchema
│   │   │   ├── types.ts                 # §1.0.3 全部线路类型 + Config（client 唯一 type 依赖面）
│   │   │   ├── errors.ts                # RemoteError 工厂 + RemoteErrorDetailsMap 扩展
│   │   │   ├── git-runner.ts            # §1.0.7（抄 forge runGit + workspace-changes env）
│   │   │   ├── repo.ts                  # repoRoot 解析/发现
│   │   │   ├── status.ts                # porcelain v2 -z 解析 + StatusEngine（缓存/去重）
│   │   │   ├── diff.ts                  # 双路 diff + 预算
│   │   │   ├── mutations.ts             # stage/unstage/discard
│   │   │   ├── commit.ts                # commit/amend/身份/hook
│   │   │   ├── sync.ts                  # push/pull/fetch + diverged/auth 分类
│   │   │   ├── log.ts                   # log/refs/show 解析与分页
│   │   │   ├── message-gen.ts           # §1.7
│   │   │   └── watcher.ts               # 宿主 ctx.fs.watch 三目标（depth:0）+ 防抖 + 轮询兜底（§2.3）
│   │   ├── lib/                         # 构建产物（gitignore）
│   │   └── tests/                       # host 侧 7 个 spec + support.ts + fixtures/
│   └── client-ui-git/                   # dsh-gitkit-ui —— client（web 面）
│       ├── package.json                 # 见下
│       ├── cordis.patch.yml             # - insert: [{ id: 'dsh-plugin-client-ui-git', name: 'dsh-gitkit-ui' }]
│       ├── tsdown.client.config.ts      # 闭包工厂格式：window.__ModuleLoader__.load({id, factory})，external 经注入 require（host-capability-map.md:77）
│       ├── src/typert.ts                # client 半 strict 描述符源（typert-generator 输入；结局 A 才生成产物，见 §0.4-1）
│       ├── src/
│       │   ├── index.ts                 # node 半最小入口（no-op apply；Loader 按 name 导入 main）
│       │   └── client/
│       │       ├── index.ts             # apply + inject 声明 + 全部注册（§3.1）
│       │       ├── locales.ts           # register(NS, {zh, en}) + LocaleNamespaceMap 扩展
│       │       ├── rpc.ts               # ctx.remote.git → GitRpcClient 适配器 + unwrap
│       │       ├── store/git-host-read-store.ts
│       │       ├── store/changes-tab-store.ts
│       │       ├── store/graph-tab-store.ts
│       │       ├── components/GitHeaderButton.tsx
│       │       ├── components/GitChangesTab.tsx
│       │       ├── components/GitGraphTab.tsx
│       │       ├── components/GitCommitDialog.tsx
│       │       ├── components/GitErrorNotice.tsx
│       │       ├── components/GitConfirmDialog.tsx
│       │       ├── components/FileDiffView.tsx
│       │       ├── diff/hunkRows.ts  diff/splitRows.ts  diff/renderedHunks.ts   # 照抄 ui-deliverables 纯函数（§5.1 登记）
│       │       └── graph/computeGraphLayout.ts  graph/GraphSvg.tsx  graph/graph-types.ts
│       ├── lib/                         # 构建产物（lib/client.js；结局 A 另含 lib/typert.remote-client.js——§0.4-1）
│       └── tests/                       # graph-layout.spec / diff-view.spec / stores.spec
└── tests/
    └── loader-smoke.spec.ts             # 装载冒烟（§⑥ 第 11 行）
```

**`packages/git/package.json`**（本地发布就绪；版本准入走 `engines.dsh`，peer 不写 `workspace:*`——`host-capability-map.md:75`）：

```jsonc
{
  "name": "dsh-gitkit",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "main": "./lib/index.js",
  "exports": {
    ".":      { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./types": { "types": "./lib/types.d.ts", "default": "./lib/types.js" },
    "./typert": "./lib/typert.host.js",              // TYPERT_HOST_EXPORT：strict 描述符自动注册（host-capability-map.md:144）
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": ["lib", "locale", "cordis.patch.yml", "LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.1-rc.5" },              // 0.1.2 定稿口径：下限 = 唯一做过逐符号源码级对照的已发布版本（npm dist-tags latest；静态对照，真机装载为发版前置门禁——README §2 兼容性口径段）
  "dependencies": {
    "@deepseek-ai/schemastery": "<真实 range，npm view 核实>"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "<真实 range>",
    "@deepseek-ai/dsh-typert-protocol": "<真实 range>"
  },
  "devDependencies": { "vitest": "*", "typescript": "*", "@types/node": "*", "chokidar": "^5.0.0" } // chokidar 仅 tests/support.ts 测试替身消费（v1.2 归真：运行时监听走宿主 ctx.fs.watch，§2.3）；版本对齐 dsh 树
}
```

**`packages/client-ui-git/package.json`**：

```jsonc
{
  "name": "dsh-gitkit-ui",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "main": "./lib/index.js",                          // node 半 no-op（Loader 会导入）
  "exports": {
    ".":        { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/client/index.d.ts", "default": "./lib/client.js" },
    "./typert": "./lib/typert.remote-client.js",   // ⚠️ 产物位预留（B2，§0.4-1）：结局 A=保留（client 半 strict codec，typert-generator 生成勿手编）；结局 B=移除该行
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",                             // 恒 web（host-capability-map.md:66）
      "inject": ["dsh-gitkit", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-sidebar-right",
                  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-locale",
                  "@deepseek-ai/dsh-client-store"]   // 信息性（预检/HMR），不决定激活顺序（host-capability-map.md:248）
    }
  },
  "engines": { "dsh": ">=0.2.1-rc.5" },
  "devDependencies": {
    // 浏览器-only 第三方库进 devDependencies（打进 bundle 或作基线 external，host-capability-map.md:78）
    "@types/react": "*", "react": "*", "@tanstack/react-virtual": "*",
    "@deepseek-ai/dsh-client-ui-slots": "<type 用，真实 range>",
    "@deepseek-ai/dsh-client-ui-sidebar-right": "<真实 range>",   // 注意 D8：包名带 -right（host-capability-map.md:451）
    "@deepseek-ai/dsh-client-ui-primitives": "<真实 range>",
    "@deepseek-ai/dsh-client-locale": "<真实 range>",
    "@deepseek-ai/dsh-client-store": "<真实 range>",
    "dsh-gitkit": "workspace:*"                 // 仅 import type；构建产物零 runtime 依赖
  }
}
```

清单注意：`react/react-dom/@tanstack/react-virtual/@deepseek-ai/dsh-client-*` 属基线 externals，**不要**写进 `dsh.client.external`（`host-capability-map.md:78`）；声明了 `dsh.client` 就必须有 `./client` 导出（`host-capability-map.md:76`）；`files` 封闭覆盖全部运行时产物（`host-capability-map.md:77`）。

**安装/验证路径**（§⑥ loader-smoke 的命令依据，【map】§5.2-5.3）：

```bash
dsh plugin --profile dbg add "file:<abs>/packages/git"       # 或 link:<abs>（开发态，改源码需重建 lib + 重启）
dsh plugin --profile dbg add "file:<abs>/packages/client-ui-git"
# 判据：profile 的 dsh.profile.bundles 自动出现两个包名（reconcile，host-capability-map.md:107）
```

---

## 附：报告 F1–F6/F7 → 本 spec 映射

| 报告功能 | 清单条目 | spec 承载 |
|---|---|---|
| F1 右上角入口（:29） | 47/48 | `GitHeaderButton`（§3.1） |
| F2 自动识别变更（:30） | 1/5/24/52 | `git.status` + §2 刷新契约 |
| F3 变更审查（:31） | 2/3/4/9/12 | `git.diff`/`stage`/`unstage`/`discard` + `GitChangesTab` |
| F4 一键提交（:32） | 11/15/48 | `git.commit` + `GitCommitDialog` |
| F5 AI 提交信息（:33） | 16/17 | `git.generateCommitMessage` |
| F6 推送（:34） | 25/26/49/67 | `git.push` + 错误码体系 |
| F7 提交图（【前次】§三点五） | 31/32/33 | `git.log`/`refs`/`show` + `GitGraphTab` + `computeGraphLayout` |

（完）
