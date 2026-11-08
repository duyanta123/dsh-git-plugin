# dsh Git 插件能力清单（capability-spec）v1

> 日期：2026-10-30。本文是 v1 施工的接口权威：RPC 方法、事件（快照）契约、client 组件与 store、locale、NOTICE、测试、目录结构。
> 输入（本会话全文读过）：
> - `docs/feature-checklist.md`（67 项权威需求，v1 = 分期表第 v1 行，`feature-checklist.md:105`，含多仓库口径注 `feature-checklist.md:109`）
> - `docs/host-capability-map.md`（宿主机制权威，下称【map】，引用格式 `host-capability-map.md:行号`）
> - 外层工作区 `research/dsh-git-plugin-research-report.md`（未入库，仅本机）第 2 章（F1–F6 定义 `:27-34`）与第 5 章（技术方案 `:112-342`）（下称【报告】）
> - 外层工作区 `research/prior-session-conclusions.md`（未入库，仅本机；六条改进意见 `:15-30`；F7 提交图可行性与复用边界 `:46-64`）（下称【前次】）
> - `docs/ported-sources/SOURCES.md`（移植源登记与许可，下称【SRC】，引用格式 `SOURCES.md:行号`）
>
> **用户决议（本 spec 的硬前提）**：host 包名 `dsh-gitkit`，client 包名 `dsh-gitkit-ui`，**pnpm workspace 双包**，本地发布就绪（`file:`/`link:` 安装 + npm publish 均可直接进行）。
>
> **修订记录**：v1.1（2026-10-30）按评审修订六项阻断问题——B1 untracked diff 命令修正 + exit 1 白名单（本机实测 exit 129/1）；B2 client 包预留 remote-client 产物位并写明两种 spike 结局；B3 push 改显式 refspec（裸 `git push` 在 `push.default=matching` 下实测一次推多分支）；B4 status 摘除 `git diff --check` 步（冲突标记展示移交 FileDiffView）；B5 watcher `ignored` 改函数谓词（chokidar@5 内置 matcher 对字符串做整串相等比较，实读其 dist 证实）；B6 refs 取 peeled oid（annotated tag 实测 `objectname`≠`*objectname`）。
> **修订记录**：v1.3（2026-11-07）随 P1 丢帧修复归真 §2.3 client 表「快照比对」行（实现：`packages/client-ui/src/client/store/git-status-source.ts` `snapshotSignature`）——原行规定按 `branch.oid + 分组计数 + generatedAt` 廉价对比：分组计数漏**路径置换**（`staged=[a.ts]→[b.ts]` 计数不变 ⇒ host R2 按全量签名判有变化推新帧、client 判重丢帧 ⇒ 渲染滞后）；`generatedAt` 每次重算必变、按字面入比则永判不等（实现——含修复前——实际始终剔除，原行此半连实现字面都未符合）。现行 = 内容签名比对（剔除 `generatedAt`），字段面 `repoRoot + branch + 四组路径数组（staged/unstaged/untracked/conflicted）+ clean`，与 host `watcher.frameSignature` 的 snapshot 半同粒度。回归：`packages/client-ui/tests/git-status-source.spec.ts`「snapshotSignature 纳入四组路径数组」「路径置换且计数不变 ⇒ 不丢帧、新路径进状态」+「快照比对口径守卫」用例。**同版次（2026-11-07）整体回填：对齐 v0.1.2 实现状态**（逐条核实 2026-11-07 全量审查漂移清单）——① §1.9 方法总表 13→16：补 `ping`/`identity`/`followStatus` 三行、端点名 `show`→`getCommitDetail`（§1.8 标题同改；实现 `packages/host/src/index.ts:151` `REMOTE_METHODS`、`index.ts:619-631`）。② §1.0.5 错误码目录 14→21：补 `session-workspace-unresolved`/`no-paths`/`bad-request`/`hook-failed`/`no-branch`/`dirty-worktree`/`choose-remote` 七码（权威 = `packages/host/src/error-codes.ts:41-69` `RemoteErrorDetailsMap` 键集；任务口径记『13→20』——实数 spec 侧原 14、实现侧 21，两侧各差 1，以键集为准）。③ §2.3 补 followStatus 流帧契约 R1–R6（权威 = `packages/host/src/watcher.ts:33-46` + `index.ts:665-690`；client 侧 = `packages/client-ui/src/client/store/git-status-source.ts:77-87,99-126`——**client 去重签名粒度必须 ≥ host**，两侧现为同粒度的剔除 `generatedAt` 全量内容签名），§2.3 client 表传输行同步归真（流取代 client 自轮询，`git-status-source.ts:90-166`）。④ §1.0.2 Config 归真：`repoRoot` → `workspaceOverride` + session `header.cwd` 记忆、**无 process.cwd 回落**（`packages/host/src/workspace.ts:113-135`；§1.0.7 repo 发现行同改）；补 `gitCommand`/`llmMaxInputBytes` 与 min/max/step 钳制（`index.ts:160-178`；`llmMaxInputBytes` 默认 262_144 = `message-gen.ts:112`）；Config 位置 = `packages/host/src/index.ts:95-148`。⑤ §1.0.1 `inject = ['subprocess']`（`index.ts:158`），fs/llm 为可选结构切片（`readFsFace` `index.ts:723-733` / `readLlmFace` `index.ts:697-707`；fs 缺席降级 R6 纯轮询、llm 缺席调用时落 `git/llm-failed`）。⑥ 已登记偏离并入正文（§1.3/§1.4/§1.5/§1.6/§1.8/§1.0.7，实现证据见各节 v1.3 注记）：paths=[] 拒绝 `git/no-paths`（`mutations.ts:236`）；`discard(options: DiscardOptions)` 三守卫签名（`types.ts:223-227`、`mutations.ts:140-225`）；unmerged 前置拒绝 `git/bad-request`（`mutations.ts:197,211-214`）；`GIT_LITERAL_PATHSPECS=1` 环境形态（`git-runner.ts:52`；`--literal-pathspecs` 子命令位实测非法 `diff.ts:15-17`）；`git/hook-failed` 单列域码（`commit.ts:210-223`）；`CommitResult.message` 回读（`commit.ts:164-178`）；上游解析改 porcelain v2 branch 头三态推导（`remote-ops.ts:121-125`）；多 remote 落 `git/choose-remote`（`remote-ops.ts:430`）；pull 加 `git/dirty-worktree` 前置（`remote-ops.ts:250-261`）；getCommitDetail = log -1 + commitDiff（merge 第一父两树 / 根提交 `--root`，`graph.ts:283-320` + `diff.ts:317-360`）；log/refs/getCommitDetail 无 host 缓存、失效下放 client（`graph.ts:25,195`、`index.ts:634-642`、client `git-graph-store.ts:134-144`）；fetch 解析链 origin 优先 → 恰一个 remote（`remote-ops.ts:410-431`）。
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
| 32 | 提交详情（`:49`） | `git.getCommitDetail({oid})`（v1.3 归真端点名，原 show） | log-refs-show.spec |
| 33 | 每提交文件变更对比（`:50`） | `git.getCommitDetail({oid, path})` | log-refs-show.spec |
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
// dsh-gitkit packages/host/src/index.ts —— 形态依据【map】§2.1（host-capability-map.md:124-144）；v0.1.2 实装同形
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context { git: GitService }
}

export default class GitService extends TypertRemoteService {
  static inject = ['subprocess'] as const   // 仅 subprocess 门控激活（v1.3 归真，index.ts:158）；fs/llm 见下方切片注
  static Config: z<Config> = z.object({ /* …见 §1.0.2（Config 与服务同类同文件，index.ts:95-178） */ })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'git')           // serviceKey = Cordis 注册名 = wire namespace（源码字面量——typert-generator 契约，index.ts:192-194）
    // …内部模块组装（四实例 runner/workspace/status/diff/mutations/commit/remote-ops/message-gen/graph/watcher）
  }
  // 只有 @Remote 装饰的方法暴露给 client（host-capability-map.md:146-149；报告 :192 的"public 自动暴露"已被 D3 纠正）
  // …@Remote 方法见 §1.1–1.9（16 个，REMOTE_METHODS index.ts:151）
}
```

**inject 归真（v1.3）**：`static inject = ['subprocess']`（`packages/host/src/index.ts:158`）。fs/llm **不进 inject**——以可选结构切片在构造期 `ctx.get('fs')` / `ctx.get('llm')` 结构化读取（`ctx.get` 先例同 subprocess 的取用，`index.ts:196-198`），缺席或形状不符返回 undefined、**不阻断服务激活**：fs 缺席 → watcher 直接走 R6 纯轮询（`readFsFace` `index.ts:723-733`、`watcher.ts:314-316`）；llm 缺席 → `generateCommitMessage` 调用时落 `git/llm-failed {stage:'call'}`（`readLlmFace` `index.ts:697-707`、`message-gen.ts:479-485`）。

硬规则（来自【map】，施工时逐条对照）：

- **只有 `@Remote` 方法过线**；辅助方法（repo 解析、watcher、缓存）一律宿主内部（`host-capability-map.md:146-149`）。
- **SRC 反射兜底要求参数是唯一标识符**：禁解构/默认值/rest；`signal` 作最后参数被识别为取消信号且不入 wire（`host-capability-map.md:149`）。本 spec 所有签名遵守：标量参数用位置参数，可选集合收进一个 options 对象；取消信号一律最后一位。
- client **只认 strict 描述符**（`host-capability-map.md:149`）→ host 包必须发布 `./typert` 产物（`host-capability-map.md:144`）。
- Host 方法抛 `RemoteError(code, message, details)`；抛普通 `Error` 会折叠成 `gateway/internal`（message 保留但丢域信息）（`host-capability-map.md:171`）。域错误码在包内 `declare module` 扩 `RemoteErrorDetailsMap`（`host-capability-map.md:173`；模块归属包名按 §0.4-2 核实）。
- 服务未就绪时 client 得 `gateway/service-unavailable` → UI 显示重试（`host-capability-map.md:174`）。

#### 1.0.2 Host Config（schemastery；client 半 Config 不生效——`host-capability-map.md:114`，所以全部运行期配置在 host）

```ts
// dsh-gitkit packages/host/src/index.ts（v1.3 归真：Config 与服务同类同文件——
// interface index.ts:95-148 + static Config schema index.ts:160-178；不再放 types.ts）
export interface Config {
  /** git 可执行文件名或绝对路径；经 `subprocess.resolveExecutable` 解析（index.ts:96-97）。 */
  gitCommand?: string                    // 默认 'git'
  /** 快速命令超时：status/diff/log/refs/getCommitDetail/stage/unstage/discard/identity/ping */
  fastTimeoutMs?: number                 // 默认 30_000（沿【报告】5.3.1 statusTimeoutMs 量级）；step(1) min 1_000 max 3_600_000
  /** commit 超时：pre-commit hook 可能慢 */
  commitTimeoutMs?: number               // 默认 120_000；step(1) min 1_000 max 3_600_000
  /** 网络命令超时：push/pull/fetch */
  networkTimeoutMs?: number              // 默认 120_000（沿【报告】pushTimeoutMs）；step(1) min 1_000 max 3_600_000
  /** 单条 git 命令 stdout 字节上限（溢出保尾部 + truncated，【map】§4.1，host-capability-map.md:278） */
  outputMaxBytes?: number                // 默认 8_388_608；step(1) min 1_024
  /** diff/getCommitDetail 单文件 patch 上限（字节），超过置 oversized（[清单 59]） */
  diffFilePatchMaxBytes?: number         // 默认 262_144；step(1) min 1
  /** diff/getCommitDetail 单次调用 patch 总预算（字节），超过截断（opencode patchBudget 语义，SOURCES.md:68） */
  diffTotalPatchMaxBytes?: number        // 默认 2_097_152；step(1) min 1
  /**
   * 工作区钉死（绝对目录）。空串 = 自动：最近顶层会话回合的 `session.header.cwd`
   * （`turn/start` 时机记忆、realpath 规范化，workspace.ts:100-105）。
   * 都没有 ⇒ `git/session-workspace-unresolved`。**无 process.cwd 回落**（v1.3 归真——
   * 原「repoRoot，空串对宿主进程 cwd 自动发现」语义废弃：解析链只有两级，workspace.ts:113-135）。
   */
  workspaceOverride?: string             // 默认 ''
  /** fs 事件防抖（ZCode DEBOUNCE_MS=150，SOURCES.md:36） */
  debounceMs?: number                    // 默认 150；step(1) min 0 max 60_000
  /** 兜底轮询间隔（ZCode useGitAutoRefresh 60s，SOURCES.md:40）。**必需项**：宿主 watch depth:0 不递归，嵌套目录编辑只有轮询能捕获（index.ts:123-127） */
  pollIntervalMs?: number                // 默认 60_000；step(1) min 1 max 3_600_000
  /** host 文件监听开关（宿主 ctx.fs.watch 三目标 depth:0 监听 + 兜底轮询，见 §2.3；v1.2 归真）。false = 纯轮询，info 级日志不算 R6 故障（watcher.ts:308-312） */
  watchEnabled?: boolean                 // 默认 true
  /** AI 提交信息 LLM 调用超时 */
  llmTimeoutMs?: number                  // 默认 60_000；step(1) min 1_000 max 3_600_000
  /** LLM 路由覆盖；**两者都非空才成对生效**，否则用 host 侧缓存的最近 request/header 路由（§0.4-5；index.ts:132-138） */
  llmProvider?: string                   // 默认 ''
  llmModel?: string                      // 默认 ''
  /** 组装完成的 LLM 输入字节硬顶（任务口径；超限 ⇒ `git/llm-failed {stage:'trim'}`，不静默二次裁剪——message-gen.ts:469-478；默认值常量 message-gen.ts:112） */
  llmMaxInputBytes?: number              // 默认 262_144；step(1) min 1_024 max 16_777_216
  /** log 每页默认条数（client 传非有限 limit 时回落） */
  logDefaultLimit?: number               // 默认 500；step(1) min 1 max 100_000
  /** log 单页上限（GitLens getGraph 默认 5000，SOURCES.md:108；limit 钳制上界） */
  logMaxLimit?: number                   // 默认 5_000；step(1) min 1 max 100_000
}

// schema = `static Config`（index.ts:160-178）：全部字段可选 + .default()；数值字段
// 带 .step(1) 与上表 min/max 钳制（v1.3 补录——原 spec 无钳制）。
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
  upstreamTrack: string | null // 本地分支的 upstream 跟踪态（`%(upstream:track)` 原文：'[gone]'/'[ahead N]'/'[behind N]'；null = 无 upstream/已同步/非 local-branch）——v1.3 补录（任务口径扩展，一次随 refs 取回、逐分支 rev-list 不做；信息性字段 v1 图 UI 不渲染；types.ts:172-181）
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
  refs: RefInfo[]              // 指向本提交的 refs（peeled oid == commit.oid 过滤）——v1.3 补录（任务口径扩展；详情面板 ref chips，types.ts:193-205）
}

// ---------- 写操作结果 ----------
export interface StageResult   { staged: number }
export interface UnstageResult { unstaged: number }
export interface DiscardResult { discarded: number }   // tracked restore + untracked clean 合计文件数

/** git.discard 入参（v1.3 归真——原单参 `discard(paths)` 签名废弃；三重守卫见 §1.3。types.ts:214-227、mutations.ts:140-225） */
export interface DiscardOptions {
  paths: string[]
  acknowledged: boolean        // C 级二次确认旗标（[清单 12]）；false ⇒ git/bad-request（'unacknowledged'），零命令执行
  baseRevision: string | null  // 乐观并发基线 = 发起请求时持有的 HEAD 全 oid；null = 不参与校验；过期 ⇒ git/bad-request（'stale-base-revision'），零命令执行
}

export interface CommitOptions {
  message: string
  amend: boolean               // [清单 19]；amend + 全空白 message = --no-edit 路（保留原消息，不走 empty-message 守卫——commit.ts:129-135）
  skipHooks: boolean           // [清单 20] → --no-verify
}
export interface CommitResult {
  oid: string
  shortOid: string
  branch: string | null
  amended: boolean
  message: string              // 提交后回读的最终 message（`git show -s --format=%B` 去尾换行——commit-msg hook 改写/--no-edit 后的权威值；v1.3 补录，commit.ts:164-178、types.ts:237-248）
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
export interface LogOptions  { limit: number; skip: number }     // limit 钳到 [1, logMaxLimit]（非有限数回落 logDefaultLimit，graph.ts:83-90）；skip ≥ 0
export interface ShowOptions { oid: string; path: string | null } // path=null：仅 meta+numstat；path 给定：含该文件 patch

// ---------- ping / identity / followStatus 流帧（v1.3 回填；types.ts:17-40, 289-320） ----------
export interface GitPingResult { ok: true; gitVersion: string }   // `git --version` stdout 首行（index.ts:262-278）
export type GitIdentityScope = 'merged' | 'local' | 'global' | 'system'
export interface GitIdentityResult {
  name: string | null; email: string | null  // 未设置（exit 1 / 空串值）⇒ null
  missing: string[]; complete: boolean       // 不抛 identity-missing——查询面返回状态，抛码职责在 commit 前置校验（index.ts:288-289）
  workspace: string; workspaceSource: 'workspace-override' | 'session'
}
/** 帧推送原因（R1–R5；R6 是降级模式非帧——types.ts:289-297、watcher.ts:33-46） */
export type GitStatusFrameReason = 'initial' | 'change' | 'mutation' | 'poll' | 'manual'
export type GitStatusFrame =
  | { kind: 'status'; reason: GitStatusFrameReason; snapshot: GitStatusSnapshot }
  | { kind: 'error';  reason: GitStatusFrameReason; error: GitFrameError }  // 错误以帧通告不断流
export interface GitFrameError { code: string; message: string }            // wire 面 code+message；完整 details 走 `git status` 的 RemoteError
export type GitFollowCommand = { type: 'refresh' }                          // R5 上行命令；未知 type 被 host 忽略（前向兼容）
```

#### 1.0.4 权限分级（对齐【报告】5.3.7，`dsh-git-plugin-research-report.md:275-280`；[清单 44/50]）

| 级 | 定义 | 方法 |
|---|---|---|
| **A 只读静默** | 不改仓库状态；自动刷新轮询可随时调；UI 无提示（后台 loading 指示除外） | `status` `diff` `log` `refs` `getCommitDetail`（v1.3 归真：端点名 show）+ `ping` `identity` `followStatus`（v1.3 补录，`index.ts:151,262-313,665`） |
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
    // —— v1.3 补录七码（权威键集 = packages/host/src/error-codes.ts:41-69 RemoteErrorDetailsMap；目录 14→21）——
    'git/session-workspace-unresolved': Record<string, never>                // workspaceOverride 与 session cwd 都解析不出（workspace.ts:113-135）
    'git/no-paths':          { op: string }                                  // stage/unstage/discard 空路径数组——拒绝整仓副作用（mutations.ts:236）
    'git/bad-request':       {                                               // 守卫失败（mutations.ts:211-225 + v2 批次一 refs-admin/remote-ops + v2 批次二 graph.ts）
      reason: 'unacknowledged' | 'stale-base-revision' | 'not-discardable' | 'force-unacknowledged' | 'invalid-options' | 'follow-without-path'
      /** not-discardable 时 = 被拒的路径清单；其余守卫为 []。 */
      paths: string[]
      /** stale-base-revision 时 = 请求基线（baseRevision），其余 null。 */
      expected: string | null
      /** stale-base-revision 时 = 最新 HEAD oid（unborn 为 null），其余 null。 */
      actual: string | null
    }
    'git/hook-failed':       { op: string; exitCode: number | null; stderr: string; truncated: boolean } // commit 的 hook 拒绝（details 与 git-error 同构；commit.ts:210-223）
    'git/no-branch':         { state: 'detached' | 'unborn' }                // push/pull 的 detached/unborn 前置拒绝（remote-ops.ts:376-385）
    'git/dirty-worktree':    { branch: string | null; pathCount: number }    // pull 脏区前置拒绝（remote-ops.ts:250-261）
    'git/choose-remote':     { remotes: string[] }                           // 多 remote 且无 origin（remote-ops.ts:430）
    // —— v2 批次一补录六码（2026-11-08；权威键集 = packages/host/src/error-codes.ts RemoteErrorDetailsMap，
    //    目录 21→27；docs/v2-implementation-plan.md §3.4）——
    'git/branch-not-found':  { name: string }                                // branchSwitch/branchDelete 的缺失预检（refs-admin.ts）
    'git/branch-not-merged': { name: string }                                // `git branch -d` 未合并拒绝（git 自身 stderr 映射；refs-admin.ts）
    'git/branch-exists':     { name: string }                                // branchCreate 重名预检（与 git/tag-exists 对称的「已存在」语义——评审修订轮定死）
    'git/tag-exists':        { name: string }                                // tagCreate 非 force 重名预检（refs-admin.ts）
    'git/tag-not-found':     { name: string }                                // tagDelete 缺失预检（refs-admin.ts）
    'git/worktree-failed':   { path: string; stderr: string }                // worktree add/remove 的 git 拒绝（[清单 68] 写面专用；stderr 过 sanitizeStderr）
    // bad-request reason 联合 v2 批次一扩值：'force-unacknowledged'（force push / `-D` 删分支 /
    // tag `-f` / worktree `--force` 共用的「危险动作未确认」闸，方案 §3.2）+ 'invalid-options'
    // （worktreeAdd 的 branch/newBranch 互斥与至少其一契约守卫——方案 §3.2 类型注记要求该契约
    // 生效而未指认承载码，施工取 bad-request 最贴近语义，登记为偏差）。
    // —— v2 批次二补录四码（2026-11-08；权威键集 = packages/host/src/error-codes.ts RemoteErrorDetailsMap，
    //    目录 27→31；docs/v2-implementation-plan.md §4.4）——
    'git/blame-oversized':   { path: string; lineCount: number; maxLines: number } // blame 全区超单次 50_000 行硬顶（D3=B；lineCount = 精确总行数，引导 client 转 -L 区间分片，blame.ts）
    'git/merge-conflict':    { op: string; conflicted: string[]; abortable: boolean } // cherry-pick/revert 冲突的结构化报错（批次三 stash-pop 复用；op 定为 **string** 不再改类型——方案 §4.4 定死）；conflicted = diff --name-only --diff-filter=U 回读、abortable = 中间态伪引用在场（true 时错误面板给「放弃操作」入口调 abortOperation）
    'git/unknown-revision':  { op: string; revision: string }                // compareBranches 的 base/compare、log 的 ref、时间旅行的 oid/target 解析失败（rev-parse --verify --quiet 预检）
    'git/operation-in-progress': { op: 'cherry-pick' | 'revert' }            // CHERRY_PICK_HEAD/REVERT_HEAD 在场 ⇒ 拒绝叠操作（治愈路径 = abortOperation；批次三 stash-pop 冲突时 op 词汇随 §5.3 复用面再议）
    // bad-request reason 联合 v2 批次二扩值：'follow-without-path'（log 的 follow=true 而无单 path——方案 §4.2，零命令守卫）。
    // —— v2 批次三补录三码（2026-11-08；权威键集 = packages/host/src/error-codes.ts RemoteErrorDetailsMap，
    //    目录 31→34；docs/v2-implementation-plan.md §5.4）——
    'git/stage-patch-failed': { path: string; stderr: string }               // stagePatch 的 apply --cached 失败（patch 与 index 冲突）与二进制/模式变更 hunk 前置拒绝（stderr 过 sanitizeStderr）
    'git/stash-not-found':    { index: number }                              // stashPop/stashDrop 的序号越界与空 stash 预检（rev-parse --verify --quiet stash@{N}）
    'git/commit-blocked':     { violations: CommitViolation[]; overridable: boolean } // 提交护栏拦截（[21][22]，CommitViolation 权威 = packages/host/src/types.ts）；overridable 按 D5=A 语义 = 违规集中无 secret 类才有豁免许可（**secret 硬阻断不可豁免**——host commit 守卫强制 overridable:false，零命令）
    // bad-request reason 联合 v2 批次三扩值：'malformed-trailer'（CommitOptions.trailers 条目不合法——方案 §5.2，零命令守卫）。
  }
}
```

分类规则（簇表单一事实源 = `STDERR_PATTERNS`，`packages/host/src/error-codes.ts:115-126`；**stderr 先脱敏再分类/入 details**——凭证形 token/password 键值与 URL userinfo 打码，`sanitizeStderr` `error-codes.ts:86-97`，v1.3 补录）：`Authentication failed`/`could not read Username`/`Permission denied (publickey)` → auth-failed 簇；`[rejected]`/`[remote rejected]`（pre-receive 拒绝的实际 stderr 不含字面 `[rejected]`，M6 本机实测补齐）/`non-fast-forward` → push-rejected 簇；`Not possible to fast-forward` → pull-diverged 簇；传输层措辞（`Could not resolve host`/`Failed to connect`/`Connection timed out`/`Network is unreachable`/`Connection reset by peer`/`SSL connect error`）→ network 簇（v1.3 补录）。簇到域码的映射分语境（v1.3 归真）：commit 的非零退出先测 hook 输出（stderr 含 `hook` 措辞 ⇒ `git/hook-failed`，`commit.ts:210-223`）；sync 引擎把 push-rejected/diverged 簇落 `git/push-rejected`/`git/pull-diverged`（`remote-ops.ts:212-233,306-333`）；通用 `gitRunError` 工厂只把 auth-failed 落独立码，rejected/diverged/network 簇仍落 `git/git-error` 兜底（message 带簇注记，`error-codes.ts:137-159`）。其余非零退出 → `git/git-error`（携带 exitCode + stderr 16KiB 尾部 + truncated，沿【map】§4.1 stderr 保留策略 `host-capability-map.md:278`）。gateway 保留码透传：`gateway/service-unavailable`（UI 重试）、`gateway/cancelled`、`gateway/input-invalid`（client 容忍陌生码，`host-capability-map.md:172`）。

#### 1.0.6 日志约定

- 用 `ctx.logger`；读操作 debug 级；写操作 info 级，字段 `{ op, durationMs, exitCode?, code?, pathCount?, amend?, setUpstream? }`；失败 warn 级附 `code`。
- **不落盘**提交 message 正文与文件内容（防密钥泄漏进日志）；stderr 尾部只在 debug 级且截 500 字符。
- 调试注意：`ctx.logger.info` 不出现在控制台（【map】§5.4，`host-capability-map.md:390`）——冒烟调试用 `process.stdout.write` 或 error 级，但这只限调试代码，正式代码仍走 logger。
- [清单 66] 的结构化审计事件是 v2，本节 logger 约定不是它的替代。

#### 1.0.7 执行底座（GitRunner，所有方法的公共实现前提）

- 抄 dsh 树内先例组合：`client-ui-forge/src/git.ts` 的 `runGit`（~50 行）+ `workspace-changes/src/git.ts` 的常量/env（【map】§4.1 组装建议，`host-capability-map.md:283-285`）。
- 读命令前缀 `GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']`（`host-capability-map.md:283`；`/dev/null` 无平台分支，【map】§4.5 `host-capability-map.md:316`）；**写命令不套** hooksPath 禁用与 `--no-optional-locks`（保留用户 hook 与正常锁，`host-capability-map.md:285`）。
- 全部命令 env：`GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` + 15 项 ambient `GIT_*` tombstone + `GIT_NO_LAZY_FETCH=1` + `GIT_OPTIONAL_LOCKS=0` + **`GIT_LITERAL_PATHSPECS=1`**（v1.3 补录后两项；GIT_ENV 全表 `git-runner.ts:41-54`；forge `GIT_ENV`，`host-capability-map.md:283`）；Codex `safe.bareRepository=explicit` 注入为 `-c` 参数且为**全部实例共用**（`SAFE_BARE_PREFIX` `git-runner.ts:56-61`；SOURCES.md:52）。**四实例装配**（v1.3 补录）：readonly（READONLY_PREFIX + fastTimeoutMs）/ write（WRITE_PREFIX + fast）/ commit（WRITE_PREFIX + commit）/ network（WRITE_PREFIX + network）——写/提交/网络实例不套 hooksPath 禁用与 `--no-optional-locks`（`git-runner.ts:64-79`、`index.ts:199-206`）。
- argv 数组注入，绝不 shell；路径字面量以 env `GIT_LITERAL_PATHSPECS=1` 承载（v1.3 归真——`git-runner.ts:52`，dsh workspace-changes git.ts:195 同款；`--literal-pathspecs` 写在**子命令位**对 `git diff` 实测非法 exit 129，`diff.ts:15-17`；mutations 另在 **git 全局位**（`git --literal-pathspecs add --`）加挂旗标双保险，`mutations.ts:23-25,43-44`）；超时 `AbortSignal.any(caller, AbortSignal.timeout(cfg))`；stdout 溢出保尾部 + truncated；Windows 终止走 `taskkill /PID /T /F`（`host-capability-map.md:276-279`）。
- git 发现：`ctx.subprocess.resolveExecutable('git', undefined, signal)`（`host-capability-map.md:289`）；失败 → `git/git-error`（op='resolve-git'）+ UI 友好提示（[清单 54]）。
- repo 发现（v1.3 归真）：工作区解析两级链——`Config.workspaceOverride`（非空 ⇒ 钉死；路径不存在 = 解析失败，不回落）→ 最近顶层会话 `session.header.cwd`（`turn/start` 时机记忆，realpath 规范化）→ 都没有 ⇒ `git/session-workspace-unresolved`（`workspace.ts:113-135`）——**无 process.cwd 回落**（原「repoRoot || process.cwd()」语义废弃）；"exit 128 + not a git repository" 范式（forge git.ts:99-103，`host-capability-map.md:287`）仍适用，命中 ⇒ 各方法抛 `git/no-repository`（commit 先显式探测，`commit.ts:89-97`）。
- 已知风险：`GIT_TERMINAL_PROMPT=0` 下 Windows Git Credential Manager 仍可能弹 GUI 窗口（【前次】:23）——写进 push/fetch 错误路径的 UI 提示文案。

---

### 1.1 `git.status` — 工作区快照 [清单 1/5/6/24/64/65]

- 权限 **A**；超时 `fastTimeoutMs`；幂等；<2s TTL 快照缓存（`STATUS_CACHE_TTL_MS=1_500`，`status.ts:61`）+ 在飞扫描去重：进行中的扫描共享同一 Promise（Codex status.rs 并发去重语义，SOURCES.md:53；写守卫的 `fresh` 读取绕 TTL 缓存且不参与在飞去重——`status.ts:97-121`，v1.3 补录）。

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
- 错误：`git/no-repository`、`git/session-workspace-unresolved`、`git/timeout`、`git/git-error`；watcher 未订阅时本调用即真值来源（§2.3）。
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

- 权限：stage/unstage **B**，discard **C**（UI 二次确认）；超时 `fastTimeoutMs`（write 实例，WRITE_PREFIX）。

```ts
@Remote()
async stage(paths: string[], signal?: AbortSignal): Promise<StageResult>
@Remote()
async unstage(paths: string[], signal?: AbortSignal): Promise<UnstageResult>
@Remote()
async discard(options: DiscardOptions, signal?: AbortSignal): Promise<DiscardResult>   // v1.3 归真：单参 paths 签名废弃（DiscardOptions 见 §1.0.3）
```

| 方法 | 命令（路径字面量 = env `GIT_LITERAL_PATHSPECS=1` + git 全局位 `--literal-pathspecs` 双保险，§1.0.7） | 要点 |
|---|---|---|
| stage | `git --literal-pathspecs add -- <paths...>`（去重保序） | untracked 路径也走 add（暂存新文件）；**`paths=[]` ⇒ `git/no-paths {op}`**（v1.3 归真——拒绝整仓副作用，**不做 `git add -A` 静默扩权**【报告】:261 原案废弃；任务口径，`mutations.ts:76-79,236`） |
| unstage | `git --literal-pathspecs restore --staged -- <paths>`；**unborn 分支回落 `git rm --cached -- <paths>`**（[清单 64]）；极老 git（restore 缺失）回落 `git reset HEAD -- <paths>`（v1.3 补录，`mutations.ts:104-138`） | 先 fresh status 的 unborn 状态选路；不在暂存视图内的路径按 no-op 跳过（幂等重击不报错——本机实测 restore --staged 对未知路径 exit 1 "did not match"） |
| discard | 三重守卫全过后：tracked ⇒ `git --literal-pathspecs restore --worktree -- <paths>`、untracked ⇒ `git --literal-pathspecs clean -fd -- <paths>`（混合列表拆两批，**先 restore 后 clean**——不可逆删除只在实际回退成功后发生） | **三重守卫**（v1.3 归真，`mutations.ts:140-225`）：① `acknowledged === true`（C 级确认旗标，[清单 12]）；② `baseRevision` == 最新 HEAD oid（乐观并发，unborn/null 不参与）；③ 逐路径路由（fresh status：untracked → clean / worktree 变更 → restore / 其余拒绝）。任一守卫失败 ⇒ `git/bad-request`，**零命令执行** |

- **unmerged（conflicted）路径前置拒绝**（v1.3 归真——原案「restore 非零退出 → git/git-error」废弃）：守卫 ③ 把 conflicted / 仅暂存条目（Y='.'）/ 未知路径归入 `git/bad-request { reason:'not-discardable', paths }`（`mutations.ts:197,211-214`），UI 文案提示先解决冲突（[清单 49]）。
- 结果计数以命令实际处理为准，写后失效：status 缓存作废 + R3 mutation 帧（§2.3）。
- 错误：`git/no-paths`、`git/bad-request`（discard 守卫）、`git/no-repository`、`git/session-workspace-unresolved`、`git/timeout`、`git/git-error`。
- 日志：info（`pathCount`）。

### 1.4 `git.commit` — 含 amend 与空提交保护 [清单 11/15/17/19/20/55/64]

- 权限 **C**（对话框按钮即确认；amend 若改写已推送历史由 UI 追加警示，§3.3）；超时 `commitTimeoutMs`。

```ts
@Remote()
async commit(options: CommitOptions, signal?: AbortSignal): Promise<CommitResult>
```

前置校验（顺序执行，任一失败即抛对应码，不执行 commit；v0.1.2 实测顺序 = 仓库发现 → 身份 → 空提交 → 消息，`commit.ts:86-139`）：

0. 仓库发现（v1.3 补录）：先跑 `git rev-parse --show-toplevel`，"exit 128 + not a git repository" ⇒ `git/no-repository { probed }`（`commit.ts:89-97`——身份查询在仓外也能读到全局配置，须先钉住仓库前提）。
1. 身份检查 [清单 55]：`git config --get user.name` 与 `git config --get user.email`（exit 1 = 键未设置、exit 0 + 空串值 = 空值，同 `identity` 查询面语义），任一缺失 ⇒ `git/identity-missing { missing }`（Windows 新机最常见，`feature-checklist.md:79`）。
2. 空提交保护：非 amend 时，`git diff --cached --quiet` 退出码 0（staged 为空）⇒ `git/nothing-staged`；amend 时允许空 staged（仅改写 message）。unborn 仓库同命令可用（对空树隐式比较，本机实测——无需 unborn 特判，`commit.ts:113-127`）。
3. `message` 为空/全空白 ⇒ `git/empty-message`；**但 amend + 全空白 = `--no-edit` 路（保留原消息不改写），不走该守卫**（v1.3 归真，`commit.ts:129-135`）。Conventional Commits 格式校验为非阻断 warn（[清单 17] 由 client 提示，host 不拒绝）。

执行：

- 命令 `git commit -F -`，message 经 **stdin** 传入（避免 `-m` 转义/换行问题，【报告】:265；runner stdin 面已实装，`commit.ts:153-159`）。`--no-edit` 路不带 `-F`（本机实测：两者同给时 stdin 空消息会覆盖 `--no-edit` 并以 "Aborting commit due to empty commit message" 中止，`commit.ts:141-151`）。
- `options.amend` ⇒ 追加 `--amend`；`options.skipHooks` ⇒ 追加 `--no-verify`；否则**保留用户 hook**（commit 实例不套 hooksPath 禁用，`host-capability-map.md:285`；[清单 20]）。
- hook 失败（v1.3 归真——**单列域码 `git/hook-failed`**，不再落 git-error）：非零退出且 stderr 含 hook 措辞 ⇒ `git/hook-failed`（details 与 git-error 同构 `{op, exitCode, stderr, truncated}`，stderr 脱敏后进 details，UI 可读展示 [清单 20/49]；`commit.ts:210-223`）；hook 超时 ⇒ `git/timeout { op:'commit' }`。
- 成功后回读三件（v1.3 补录）：`git rev-parse --verify HEAD` 取 oid、`git rev-parse --abbrev-ref HEAD` 取分支（输出 'HEAD' ⇒ null）、**`git show -s --format=%B HEAD` 回读最终 message**（commit-msg hook 改写 / `--no-edit` 保留后的权威值，去尾换行进 `CommitResult.message`——不信入参；`commit.ts:164-178`）。
- 写后失效（v1.3 归真）：status 缓存作废 + R3 mutation 帧（§2.3）——log/refs/getCommitDetail **无 host 缓存**，其失效由 client 状态订阅承担（branch.oid 变化 → reload，§1.8）。
- 日志：info（op/ durationMs/amend；不含 message 正文）。

### 1.5 `git.push` — set-upstream 与 diverged 检测 [清单 25/26/44/67]

- 权限 **C**；超时 `networkTimeoutMs`。

```ts
@Remote()
async push(options: PushOptions, signal?: AbortSignal): Promise<PushResult>
```

流程（【前次】改进第 3 条的失败路径全覆盖，`:23`）：

0. detached/unborn 前置拒绝（v1.3 补录）：⇒ **`git/no-branch { state: 'detached'|'unborn' }`**（`remote-ops.ts:376-385`——`git/no-upstream` 的 hint 'set-upstream' 对该态是误导动作）。
1. 上游三态判定（v1.3 归真——原逐命令 `git rev-parse --abbrev-ref --symbolic-full-name @{u}` 形态废弃）：由 fresh status 快照的 **porcelain v2 branch 头三态推导**（`remote-ops.ts:121-125`）——`# branch.upstream` 缺失 = **no-upstream**；存在而 `# branch.ab` 缺失 = **gone**（upstream 配置在、远端跟踪引用不在；本机实测 gone 态 `@{u}` 类解析 exit 128 ⇒ **gone 态严禁 rev-list**）；两者都在 = **normal**。分派：
   - no-upstream / gone：`options.setUpstream=false` ⇒ **`git/no-upstream { branch, hint:'set-upstream' }`**（gone 复用同码同 hint——client 的"设置 upstream 并推送"动作即治愈路径，[清单 26]，不静默自动 set-upstream——首次推送目标属 Tier C 决策）；`setUpstream=true` ⇒ set-upstream 路：remote 取 `git config --get branch.<name>.remote`，为空时进 remote 解析链（**origin 存在即默认 → 恰一个 remote** → 零个 ⇒ `git/no-remote` / 多个 ⇒ **`git/choose-remote { remotes }`**——v1.3 归真：原「多个 ⇒ origin 存在用 origin，否则 git/no-remote」中多 remote 且无 origin 的分支改落 choose-remote，`remote-ops.ts:410-431`）。
2. diverged 预检 [清单 67]（仅 normal 态）：`git rev-list --left-right --count <upstream>...HEAD`（输出 `behind\tahead`，注意列序）；`ahead>0 && behind>0` ⇒ **`git/diverged { branch, upstream, ahead, behind }`**，不执行 push（v1 不提供 force push——[清单 27] 是 v2）。client 引导 fetch/pull。
3. 执行——**禁止裸 `git push`，一律显式 remote + 全量 refspec**：`git push <remote> refs/heads/<remoteBranch>:refs/heads/<remoteBranch>`；set-upstream 路径 `git push --set-upstream <remote> refs/heads/<branch>:refs/heads/<branch>`（ZCode :1654，SOURCES.md:33）。**本机实测（git 2.55.0.windows.2，本地 bare 远端）**：裸 `git push origin` 在 `push.default=matching` 下一次 `--dry-run` 输出**两行** ref 更新（`feature -> feature` 与 `master -> master`），即一次"推送按钮"推送全部分支；显式 refspec 只推目标分支。裸 push 属于对 Tier C 动作的静默扩权——runner 的 env 净化只 tombstone ambient `GIT_*` 环境变量，**不隔离用户 `~/.gitconfig`**。normal 路径的 `<remote>`/`<remoteBranch>` 取 `branch.<name>.remote` + `branch.<name>.merge`（剥 `refs/heads/` 前缀——权威配置面；**upstream 短名首段拆分仅作回落**——remote 名含 '/' 时短名拆分会错，v1.3 补录，`remote-ops.ts:195-202`），**不**用本地分支名（防本地名 ≠ 上游名时推错目标）；set-upstream 路径的两侧都用本地分支名（此时无 upstream 可拆）。ZCode 的 `remote.pushDefault` 段不在解析链（任务口径未列，`remote-ops.ts:12-13`）。
4. 远端拒绝（v1.3 归真——脱敏后分类）：rejected 簇（`[rejected]`/`[remote rejected]`/`non-fast-forward`）⇒ `git/push-rejected`（reason 取括号体）；凭证失败簇 ⇒ `git/auth-failed`（脱敏 stderr 回传；GCM 弹窗风险写进 UI 提示，§1.0.7）；network 簇 ⇒ `git/git-error` message 带 (network) 注记（`remote-ops.ts:212-233`）。
5. 日志：info（setUpstream/remote/branch）。

### 1.6 `git.pull` / `git.fetch` [清单 25]

- 权限：pull **C**、fetch **B**；超时 `networkTimeoutMs`。

```ts
@Remote()
async pull(signal?: AbortSignal): Promise<PullResult>
@Remote()
async fetch(options: FetchOptions, signal?: AbortSignal): Promise<FetchResult>
```

- **pull**：detached/unborn ⇒ `git/no-branch`（v1.3 补录）；**脏区前置拒绝 ⇒ `git/dirty-worktree { branch, pathCount }`**（v1.3 补录，任务口径——fresh 快照非 clean 即拒，pathCount = staged/unstaged/untracked/conflicted 去重合计；ff 更新会写工作区文件，脏区下失败形态不可读——前置拒绝零副作用，`remote-ops.ts:250-261`）；无 upstream / gone ⇒ `git/no-upstream`（gone 的治愈是 fetch 重建跟踪引用，而非 pull）；先 diverged 预检（同 §1.5-2，仅 normal 态）⇒ 分叉即 **`git/pull-diverged`**（v1 只做 ff，merge/rebase UI 是 v3，[清单 28/29] 不设计）；执行 `git pull --ff-only --no-rebase`（`--no-rebase` 钉死 merge 语义：runner 不隔离用户 `~/.gitconfig` 的 `pull.rebase=true`，裸 `--ff-only` 会被 rebase 改写历史——v1.3 补录，`remote-ops.ts:291-296`）；运行期 `Not possible to fast-forward` ⇒ 重跑一次 rev-list 取真实 ahead/behind 后落同码 `git/pull-diverged`（重读失败回落 git-error 兜底，`remote-ops.ts:306-333`）。成功返回新旧 oid。
- **fetch**（remote 解析链次序 v1.3 归真——**origin 优先于「恰一个」**）：`options.remote` 显式 → `branch.<name>.remote`（**gone 态也读**——fetch 正是重建跟踪引用的治愈操作；值为 '.' 指向本仓库内分支，对 fetch 无意义跳过）→ **`origin` 存在即默认** → 恰一个 remote → 零个 ⇒ `git/no-remote` / 多个 ⇒ **`git/choose-remote { remotes }`**（`remote-ops.ts:344-356,410-431`）；detached/unborn 合法（fetch 不依赖当前分支）。执行 `git fetch --prune <remote>`；`pruned` = stdout/stderr 含 `[deleted]` prune 行；凭证失败 ⇒ `git/auth-failed`（[清单 58] 的"凭证失败可读提示"部分在 v1 由本错误路径覆盖，定时 fetch 本身是 v2）。

### 1.7 `git.generateCommitMessage` [清单 16/17]

- 权限 **B**；超时 `llmTimeoutMs`（LLM 侧再加 `using deadline(signal, llmTimeoutMs, code)` 双保险，【map】§4.3 `host-capability-map.md:302`）。

```ts
@Remote()
async generateCommitMessage(signal?: AbortSignal): Promise<GeneratedCommitMessage>
```

- 无 staged ⇒ `git/nothing-staged`（生成只基于 staged diff，[清单 16]/【报告】F5 `:33`）。
- 裁剪常量沿用 ZCode（SOURCES.md:35，gitCommitMessageGenerator.ts:10-20）：最多 20 文件 / 8 个 diff / 总 12k 字符 / 单文件 2k / 消息上限 1k。v1 **不带会话上下文**（ZCode 的 12 条 4k 上下文需要会话事件面，未核实，§0.4-5；v1 已知简化）。
- LLM 调用照 `session-title-llm` 范式（【map】§4.3，`host-capability-map.md:302`）：输入字节上限调用方自检 → `prepareCall(config, signal)` → 流式组装 → finish 解释；`purpose` 是封闭联合，一次性辅助调用省略（`host-capability-map.md:304`）。v1.3 补录：自检对象 = **组装完成品 input** 的字节长，硬顶 = `Config.llmMaxInputBytes`（默认 262_144），超限 ⇒ `git/llm-failed {stage:'trim'}` **不静默二次裁剪**（`message-gen.ts:469-478`）；llm 服务缺席同码落 `{stage:'call'}`（§1.0.1 切片注）。
- 路由解析（【报告】:83 已被 D10 纠正，`host-capability-map.md:303`）：`Config.llmProvider/llmModel` 显式优先；否则用 host 侧缓存的最近 `request/header` 路由（payload 形状 §0.4-5 核实）；都没有 ⇒ `git/llm-route-unresolved`。
- prompt 要求输出单行 Conventional Commits；返回前用移植的 `CONVENTIONAL_COMMIT_RE`（ZCode :20）置 `conventional` 标志，**不阻断**（[清单 17] 由 client 提示）。
- 失败：`git/llm-failed { stage }`；调用前后记可观测日志（对齐标题生成器的 request 事件惯例，【报告】:273）。

### 1.8 `git.log` / `git.refs` / `git.getCommitDetail` — 提交图数据层 [清单 31/32/33]

（v1.3 归真：wire 端点名 `show` → **`getCommitDetail`**——workflow 任务口径，`index.ts:619-631`；本节标题与签名同步。）

- 权限 **A**；超时 `fastTimeoutMs`；**host 无缓存、幂等实跑**（v1.3 补录，`graph.ts:25,195`——§1.9 三行无失效列）；分页 single-writer 语义在 client store 层实施（§3.3.4，GitLens graphSession 契约 SOURCES.md:106）。

```ts
@Remote()
async log(options: LogOptions, signal?: AbortSignal): Promise<LogPage>
@Remote()
async refs(signal?: AbortSignal): Promise<RefsSnapshot>
@Remote()
async getCommitDetail(options: ShowOptions, signal?: AbortSignal): Promise<CommitDetail>
```

- **log**：`git log --topo-order --pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%b%x1e -n <limit+1> --skip <skip>`（字段分隔 0x1f、记录分隔 0x1e，`%b` 内换行不破坏解析；命令形态对齐【前次】F7 数据层 `:51`）。`limit` 钳到 `[1, logMaxLimit]`；取 `limit+1` 条判 `hasMore`。unborn HEAD：git 退出非零且 stderr 含 `does not have any commits yet` ⇒ 返回空页（`commits:[], hasMore:false`，不抛错——[清单 64]）。refs 装饰不进 log（`refs()` 单独取，client 合并）。
- **refs**：`git for-each-ref --format=%(objectname)%09%(*objectname)%09%(refname)%09%(refname:short)%09%(upstream:track) refs/heads refs/remotes refs/tags`（v1.3 归真：**单次查询含第 5 字段 `%(upstream:track)`**——`REF_PRETTY_FORMAT` `graph.ts:74`；local-branch 的 upstream 跟踪态 `[gone]`/`[ahead N]`/`[behind N]` 一次取回，逐分支 rev-list 不做，进 `RefInfo.upstreamTrack`）+ symbolic-ref/rev-parse 双命令并行判 head 三态（branch/detached/unborn；`index.ts:594-599`、opencode vcs/git.ts:260，SOURCES.md:69）。**`RefInfo.oid` 必须取 peeled 值**：`%(*objectname)` 非空（annotated tag ⇒ tag 对象而非 commit）用之，否则回落 `%(objectname)`——**本机实测（annotated `git tag -a v1`）**：`objectname`=tag 对象、`*objectname`=commit，两者不等；非 tag ref 的 `*objectname` 为空串。只取 `%(objectname)` 会让 annotated tag 永远装饰不到提交图（`GraphGraphTab` 按 `ref.oid == commit.oid` 匹配 chips，[清单 31] 失败）。symbolic-ref 失败 ⇒ detached（oid 取 `git rev-parse HEAD`）；unborn ⇒ `head.kind='unborn'`。
- **getCommitDetail**（v1.3 归真命令形态；原 `git show --numstat` 单命令形态废弃）：meta = `git log -1 --pretty=format:<LOG_PRETTY_FORMAT> <oid>`（同 log 记录格式，`graph.ts:283-320`）；文件清单/单文件 patch = DiffEngine.commitDiff（`diff.ts:317-360`）：先 `git rev-list --parents -n 1 <oid>` 判父——非根提交（含 merge）取**第一父两树** `git diff <p1> <oid> --numstat/--name-status -z --find-renames`（merge 对比第一父即避开 combined-diff 默认空输出）、根提交取 `git diff-tree --root -r … --no-commit-id`；`options.path` 非空时 patch 只取该文件（预算同 §1.2，[清单 33]）。binary/超大处理同 `DiffFile` 语义。**refs 过滤**（任务口径）：全量单次 for-each-ref 后按 peeled oid == commit.oid 过滤进 `CommitDetail.refs`（annotated tag 已在解析时落到 RefInfo.oid，直接相等匹配；`graph.ts:34-36`）。单文件 patch 失败降级 `patch:null` 不炸整体；修订无效（128 bad revision）⇒ `git/git-error`。

### 1.9 方法总表

v1.3 归真：总表 13 → **16** 行（权威 = `REMOTE_METHODS`，`packages/host/src/index.ts:151`）；「写后失效」列按实现归真——host 只缓存 status（diff/getCommitDetail 无缓存实跑、log/refs 无缓存），写后失效 = status 缓存作废 + R3 帧（§2.3），log/refs/getCommitDetail 的缓存失效在 client 侧（§1.8）。

| 方法 | 权限 | 超时 | 写后失效（§2.3） | 主要错误码 |
|---|---|---|---|---|
| ping | A | fast | — | gateway/internal（非域码路径——失败抛普通 Error 折叠，message 保留；`index.ts:262-278`） |
| identity | A | fast | — | session-workspace-unresolved, timeout, git-error（**不抛 identity-missing**——查询面返回状态） |
| status | A | fast | —（自身即真值；<2s TTL 缓存 + 在飞去重） | no-repository, session-workspace-unresolved, timeout, git-error |
| diff | A | fast | —（无缓存） | no-repository, session-workspace-unresolved, timeout, git-error |
| followStatus | A | —（流生命周期） | —（自身即真值） | 帧错误投影 no-repository / session-workspace-unresolved / git-error（**不断流**，§2.3） |
| stage | B | fast | status 缓存作废 + R3 帧 | no-paths, no-repository, session-workspace-unresolved, timeout, git-error |
| unstage | B | fast | status 缓存作废 + R3 帧 | no-paths, no-repository, session-workspace-unresolved, timeout, git-error |
| discard | C | fast | status 缓存作废 + R3 帧 | no-paths, bad-request, no-repository, session-workspace-unresolved, timeout, git-error |
| commit | C | commit | status 缓存作废 + R3 帧（log/refs/getCommitDetail 无 host 缓存） | no-repository, identity-missing, nothing-staged, empty-message, hook-failed, session-workspace-unresolved, timeout, git-error |
| push | C | network | status 缓存作废 + R3 帧 | bad-request（v2 批次一 'force-unacknowledged'——force=true 需 acknowledged，零命令守卫）, no-branch, no-upstream, no-remote（v2 批次一：显式 options.remote 直查存在性）, choose-remote, diverged（force=true 跳过——语义即覆盖远端；v2 评审修复：预检基线 = 实际推送目标 `<remote>/<remoteBranch>` 的跟踪引用，显式 options.remote 选定非 upstream 远端时不按旧 upstream 计数、该引用不存在即不预检，details.upstream 随基线指向实际目标）, push-rejected, auth-failed, session-workspace-unresolved, no-repository, timeout, git-error |
| pull | C | network | status 缓存作废 + R3 帧 | no-branch, dirty-worktree, no-upstream, pull-diverged, auth-failed, session-workspace-unresolved, no-repository, timeout, git-error |
| fetch | B | network | status 缓存作废 + R3 帧 | no-remote, choose-remote, auth-failed, session-workspace-unresolved, no-repository, timeout, git-error |
| generateCommitMessage | B | llm | — | nothing-staged, no-repository, session-workspace-unresolved, llm-route-unresolved, llm-failed, timeout, git-error |
| log | A | fast | —（无 host 缓存；client 状态订阅失效） | no-repository, session-workspace-unresolved, timeout, git-error（unborn 返回空页不抛错） |
| refs | A | fast | —（无 host 缓存；client 状态订阅失效） | no-repository, session-workspace-unresolved, timeout, git-error |
| getCommitDetail | A | fast | —（无 host 缓存；client 状态订阅失效） | no-repository, session-workspace-unresolved, timeout, git-error（单文件 patch 失败降级 patch:null 不炸整体） |
| branchCreate | C | fast | status 缓存作废 + R3 帧 | bad-request（'invalid-options' 空名）, branch-exists（预检）, no-repository, session-workspace-unresolved, timeout, git-error |
| branchSwitch | C | fast | status 缓存作废 + R3 帧 | bad-request, dirty-worktree（fresh 扫描脏区前置拒绝）, branch-not-found（预检）, no-repository, session-workspace-unresolved, timeout, git-error |
| branchDelete | C | fast | status 缓存作废 + R3 帧 | bad-request（'force-unacknowledged'——`-D` 需 acknowledged，零命令守卫）, branch-not-found（预检）, branch-not-merged（git 拒绝映射）, no-repository, session-workspace-unresolved, timeout, git-error |
| tagCreate | C | fast | status 缓存作废 + R3 帧 | bad-request（'force-unacknowledged'——`-f` 需 acknowledged）, tag-exists（非 force 预检）, no-repository, session-workspace-unresolved, timeout, git-error |
| tagDelete | C | fast | status 缓存作废 + R3 帧 | bad-request, tag-not-found（预检）, no-repository, session-workspace-unresolved, timeout, git-error |
| remoteList | A | fast | —（只读） | no-repository, session-workspace-unresolved, timeout, git-error（`remote -v` 行解析契约破坏要响） |
| worktreeList | A | fast | —（只读） | no-repository, session-workspace-unresolved, timeout, git-error（porcelain 块解析契约破坏要响） |
| worktreeAdd | C | fast | status 缓存作废 + R3 帧 | bad-request（'invalid-options'——branch/newBranch 互斥且至少其一）, worktree-failed（path 已存在非空 / 分支被占用；stderr 脱敏）, no-repository, session-workspace-unresolved, timeout, git-error |
| worktreeRemove | C | fast | status 缓存作废 + R3 帧 | bad-request（'force-unacknowledged'——`--force` 需 acknowledged，零命令守卫）, worktree-failed（path 不存在 / 脏 worktree 无 force；stderr 脱敏）, no-repository, session-workspace-unresolved, timeout, git-error |
| blame | A | fast | —（只读；host 无缓存） | bad-request（'invalid-options'——空 path / 非法 `-L` 区间）, blame-oversized（全区超单次硬顶，details.lineCount 引导 `-L` 区间分片）, no-repository, session-workspace-unresolved, timeout, git-error（porcelain 解析契约破坏要响 / git 失败兜底） |
| compareBranches | A | fast | —（只读；host 无缓存） | bad-request（'invalid-options'——空 base/compare）, unknown-revision（rev-parse 预检）, no-repository, session-workspace-unresolved, timeout, git-error（rev-list 失败 / 计数与列表互检不一致 / merge-base 失败兜底） |
| cherryPick | C | fast | status 缓存作废 + R3 帧 | bad-request（'unacknowledged' / 'stale-base-revision'——discard 三重守卫同款）, operation-in-progress（中间态伪引用在场）, no-branch（detached/unborn）, unknown-revision（oid 预检）, merge-conflict（冲突留中间态；错误面板「放弃操作」= abortOperation）, no-repository, session-workspace-unresolved, timeout, git-error（空 pick 等非冲突失败兜底） |
| revert | C | fast | status 缓存作废 + R3 帧 | 同 cherryPick（冲突 details.op='revert'；空 revert ⇒ git-error op 'revert'——方案 §4.3 指认） |
| reset | C | fast | status 缓存作废 + R3 帧 | 同 cherryPick（含 target 预检 unknown-revision；脏区**不拦**——hard 语义即清理，方案 §4.10；UI 侧 hard 另走 danger 勾选闸） |
| abortOperation | B | fast | status 缓存作废 + R3 帧（幂等 null 短路同走失效） | no-repository, session-workspace-unresolved, timeout, git-error（abort 命令失败兜底） |
| stagePatch | B | fast | status 缓存作废 + R3 帧 | bad-request（'invalid-options'——空 path/patch、direction 越界）, stage-patch-failed（二进制/模式变更 hunk **前置拒绝**零命令；apply 失败兜底——patch 与 index 不符，stderr 脱敏提示回落文件级 stage）, no-repository, session-workspace-unresolved, timeout, git-error |
| stashPush | B | fast | status 缓存作废 + R3 帧 | bad-request（'stale-base-revision'——baseRevision 可选乐观基线）, no-paths（op 'stash'——无可 stash 改动 fresh 扫描前置）, no-repository, session-workspace-unresolved, timeout, git-error |
| stashList | A | fast | —（只读） | no-repository, session-workspace-unresolved, timeout, git-error（format 解析契约破坏要响） |
| stashPop | B | fast | status 缓存作废 + R3 帧 | bad-request（'invalid-options'——序号非负整数）, stash-not-found（序号越界/空 stash 预检）, merge-conflict（op 'stash-pop'；**git 语义冲突时 stash 不丢**——UI 明示；abortable 如实探测——stash-pop 无中间态伪引用）, no-repository, session-workspace-unresolved, timeout, git-error |
| stashDrop | C | fast | status 缓存作废 + R3 帧 | bad-request（'unacknowledged'——danger 闸零命令 / 'invalid-options'）, stash-not-found, no-repository, session-workspace-unresolved, timeout, git-error |
| scanStaged | A | fast | —（只读） | no-repository, session-workspace-unresolved, timeout, git-error（清单/cat-file 失败兜底；返回 CommitScanResult 不抛 commit-blocked——该码由 commit 守卫投） |
| repoDiagnostics | A | fast | —（只读） | no-repository, session-workspace-unresolved, timeout, git-error（config 失败兜底） |

> v2 批次一补录（2026-11-08，docs/v2-implementation-plan.md §3.3/§3.5；权威 = `REMOTE_METHODS`，`packages/host/src/index.ts:151`，16→25 行）：九行 refs 管理面（引擎半 = `packages/host/src/refs-admin.ts`，变更类走 write runner、查询/预检走 readonly）。形态注记：① 命令一律带 `--` 分隔符（本机 git 2.55.0.windows.2 实测 `git branch -- --all` ⇒ git 自身拒绝非法名）；`git switch` 不支持 `--` 后跟 `-c` 双位置参数（exit 128 "only one reference expected"），故 branchCreate 的 checkout = `git branch --` + `git switch --` 两命令（非 `switch -C`）。② 存在性预检 = `rev-parse --verify --quiet refs/...`（exit 1 = 缺失），域码化而非 stderr 特征。③ force 类动作（push --force / `-D` / tag `-f` / worktree `--force`）双闸 host 半 = acknowledged 守卫最前、零命令执行；force push 跳过 diverged 预检（语义即覆盖远端），upstream 三态预检保留。④ worktreeList 的 unborn HEAD 全零 oid 归 null（BranchState.oid [清单 64] 同语义）；locked reason 自由文本不进 wire（布尔位）。⑤ 定时 fetch（[清单 58] D6=B）：Config `autoFetchIntervalMs` 默认 300_000、0=关，Cordis effect 挂 interval（stop 清理），失败仅 logger.warn 不投 UI，成功走 afterWrite（R3 帧）。

> v2 批次二补录（2026-11-08，docs/v2-implementation-plan.md §4.3/§4.5；权威 = `REMOTE_METHODS`，`packages/host/src/index.ts:151`，25→31 行）：六行历史面。形态注记：① blame = `git blame --porcelain [-L <s>,<e>] [<ref>] -- <path>` 解析为 ranges（**同 oid 连续行合并**——git 的组边界与 `-L` 窗口切分不影响 wire 区间）+ commits 去重清单；ref 缺省 = 工作区（未提交行以全零 oid + 「Not Committed Yet」如实过线）。单次 **50_000 行硬顶**与 outputMaxBytes 互相校验（有效上限 = min(50_000, floor(outputMaxBytes/128))，`blame.ts` `effectiveBlameMaxLines`；行内容极长时由 runner truncated 兜底）；全区超限 ⇒ `git/blame-oversized`（details.lineCount **精确值**：工作区 = node fs 流式计数（仓库内路径越界守卫）、ref = `git diff --numstat <空树> <ref> -- <path>`（空树经 `git hash-object -t tree --stdin` 现算——不带 `-w` 零写入，独立评审修复：原 `git mktree` 会向 .git/objects 落空树对象，违背 blame 只读纪律）→ 二进制回落 `git show` 计数；探测不可得时改走无窗口 blame，covered 即精确值）；区间超限 ⇒ **同钳**（end 钳到 start+maxLines-1，truncated=true）。② log 过滤参数（[清单 35/60]，§1.8 同批扩展）：`--grep=<q> -F`（固定串）/ `--author=<a>`（正则语义）/ `--follow`（仅单 path 合法，违反 ⇒ bad-request 'follow-without-path' 零命令）/ `-- <path>` / `<ref>` 起点（`rev-parse --verify --quiet` 预检，不可解析 ⇒ unknown-revision）；`LOG_PRETTY_FORMAT` 与 limit/skip 钳制零改动复用，分页语义不变。③ compareBranches = `rev-list --left-right --count base...compare`（`rev-count.ts` 自 remote-ops.ts 提共享——push/pull 消费行为不变，sync.spec 回归绿）双向计数 + `git log --topo-order` 两列（base..compare = ahead / compare..base = behind）+ merge-base（exit 1 不相交 ⇒ null），计数与列表长度互检（不一致 = 契约破坏要响）。④ 时间旅行四方法执行走 **write runner（fastTimeoutMs）**——`commitTimeoutMs` 只属 commit runner，方案 §4.5 定死「写 runner 档」；守卫链 = acknowledged（零命令）→ fresh 扫描 → baseRevision 乐观并发 → 中间态探测（CHERRY_PICK_HEAD/REVERT_HEAD，`rev-parse --verify --quiet` 在场 ⇒ operation-in-progress）→ detached/unborn 拒绝（no-branch）→ 修订预检（unknown-revision）；冲突（exit 1 输出含 CONFLICT）⇒ `git/merge-conflict`（conflicted = `diff --name-only --diff-filter=U` 回读、abortable = 中间态在场）——仓库留中间态直到 abort/解决（完整解决 UI 是 v3 [13]）；非冲突失败（空 pick / 空 revert 的 "nothing to commit"）⇒ git-error；abortOperation 幂等安全（无中间态 ⇒ `{aborted:null}` 零命令），reset 脏区不拦（hard 语义即清理）。

> v1.3 补录三行的形态注记：`ping` = `git --version` 存活探测（cwd 取临时目录根，避开宿主进程 cwd 偶然性；`index.ts:262-278`）；`identity` = user.name/email 作用域查询（`scope?: 'merged'|'local'|'global'|'system'`，缺省合并视图；exit 1 = 缺失 → null；`index.ts:291-333`）；`followStatus` = **stream 模式**（`@Remote({mode:'stream'})`，返回类型直接写 `RemoteStream<GitStatusFrame, GitFollowCommand>`、**不可 Promise 包装**——生成器 analyzer 只解 Iterable/AsyncIterable/RemoteStream 三种直接返回，本机 build 实测；上行 `refresh` 命令 = R5 manual；`index.ts:665-690`），帧契约 R1–R6 见 §2.3。

> v2 批次三补录（2026-11-08，docs/v2-implementation-plan.md §5.3/§5.5；权威 = `REMOTE_METHODS`，`packages/host/src/index.ts:151`，31→38 行）：七行提交链路与护栏（引擎半 = `packages/host/src/staging-patch.ts` / `stash.ts` / `guard-scan.ts` / `diagnostics.ts`；commit 引擎同批扩 trailers 与 process）。形态注记：① stagePatch（[清单 10]，D7=B 两态）= `git apply --cached --recount --whitespace=nowarn [-R]`（patch 文本走 stdin；client 从 parsePatch 产物裁剪组装）；**前置拒绝零命令**：patch 含 `GIT binary patch`/`Binary files differ` 或 `old mode` 行 ⇒ stage-patch-failed（`new file mode`/`deleted file mode` 是新增/删除文件的正常 diff 头**不拒**）；apply 失败（patch 与 index 不符）同码，stderr 脱敏；`staged` 返回值 = 应用的 **hunk 数**（`@@` 头计数）。② stashPush（[清单 14]，D4=B）：wire 显式 boolean `includeUntracked`（client 缺省传 true = `-u`）；无可 stash 改动 fresh 扫描前置 ⇒ no-paths（op 'stash'）；baseRevision 可选乐观基线（非 null 且 ≠ HEAD ⇒ 'stale-base-revision' 零命令）；**环境实测**：runner 基础 env 的 `GIT_LITERAL_PATHSPECS=1` 会静默破坏 `-u` 的 untracked 收集——stashPush 对该单条命令以 env 墓碑摘除（stash push 不传用户 pathspec，零注入面）。③ stashList = `git stash list --pretty=format:%H%x1f%aI%x1f%s%x1f%gd%x1e`（LOG_PRETTY_FORMAT 同分隔方案；index 取自 %gd 的 `stash@{N}`；空 stash 空数组不抛错）。④ stashPop 序号预检（`rev-parse --verify --quiet stash@{N}` exit 1 ⇒ stash-not-found）→ `git stash pop stash@{N}`；冲突（输出含 CONFLICT）⇒ merge-conflict（op 'stash-pop'——批次二注册的 string op 词表在本批消费；**stash 不丢**）；stashDrop = acknowledged danger 闸（零命令）+ 同款序号预检 + `git stash drop`。⑤ scanStaged（[清单 21/22]）只读预检：`diff --cached --raw -z`（staged 清单 + blob oid）→ `cat-file --batch-check`（尺寸）→ `cat-file --batch`（≤256 KiB 内容；NUL 探测跳二进制）；违规五类 = secret（内置高置信度模式表自研零新依赖：PEM 头/AKIA/ghp_/xox/AIza/sk-/authorization 头 + .env 凭据键值（仅 env 形态文件内）+ Config.guardSecretPatterns 用户叠加**固定串**非正则）/ env-file（.env 家族路径，.env.example 不误伤）/ large-file（Config.guardLargeFileBytes 默认 1 MiB）/ build-artifact（Config.guardBuildPatterns 默认表叠加）/ eol-mixed（CRLF+LF 混用行号）；命中展示文本按「安全前缀 + 掩码」规则脱敏进 `redactedMatch`（绝不落明文密钥——sanitizeStderr 纪律延伸）；文件数 200/违规数 200 引擎级封顶（不注入占位 violation）。⑥ commit 守卫链扩两步：trailers 形状校验（`Key: value` 正则，违反 ⇒ bad-request 'malformed-trailer' 零命令；--no-edit 路径与 trailers 同给 ⇒ 'invalid-options'）+ **secret 硬阻断（D5=A）**——scanStagedContents 复用（同一 repoRoot）后 secret 类 ⇒ git/commit-blocked（overridable:false，零命令）；env-file/large-file/build-artifact 不拦 host commit（豁免 = client danger 勾选闸；host 无 bypass wire 字段，登记为方案空白的施工解释）；扫描失败不阻断提交（护栏降级如实 warn——scanStaged 预检面是 UI 主通道）。trailers 组装进 `-F -` 消息体（空行分隔尾块，git trailer 语义），`CommitResult.message` 回读权威值不变。⑦ process 捕获（[清单 63]）：成功路径回带 `git commit` 进程**整体输出**（含 hook 输出——git 不做 per-hook 归因，诚实命名见 `CommitProcessOutput` 注）；两侧 sanitizeStderr 脱敏 + 16 KiB 尾部封顶；空输出置 null；`timedOut` 恒 false（超时路径抛 git/timeout）；hook 失败路径不返回（stderr 进 git/hook-failed details 不变）。⑧ repoDiagnostics（[清单 56]）：`config --get core.autocrlf/core.eol`（exit 1 = 未设置 null）+ 顶层文本后缀文件 CRLF 抽样（`worktreeCrlfCount` 计数 + `mixedEolFiles` 混用清单，清单封顶 50——方案「超出仅计数」在现 wire 形状以截断清单 + 计数量级承载，类型注已记）；中文路径由 node fs 原样承载。

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

**followStatus 流帧契约（R1–R6，v1.3 回填；权威 = `packages/host/src/watcher.ts:33-46` 与 `index.ts:665-690`）**——「host 推送」的 v1 承载是 `followStatus` 流方法（typert stream 模式；事件转发 allowlist 无 `git/*` 依旧成立，§2.1）：client 打开一条逻辑流，host 按以下规则推 `GitStatusFrame`（`status` 帧 / `error` 帧——**错误以帧通告不断流**，仓库后续就绪照常推 status 帧；`GitFrameError` 只带 wire 面 code+message，完整 details 走 `git status` 的 RemoteError；流帧类型见 §1.0.3，types.ts:289-320）：

| 帧 | 触发 | 规则 |
|---|---|---|
| R1 initial | 订阅建立 | 无条件推当前快照/错误帧（不经 R2 门），并充当 R2 首个基线（`watcher.ts:345-352`） |
| R2 change | watch 防抖触发 | 重算后与上一帧**内容签名**比对（剔除 `generatedAt` 的全量结构比对——`frameSignature` 字段面 = repoRoot + branch + 四组路径数组 + clean，`watcher.ts:100-115`），未变化不推 |
| R3 mutation | 本插件写操作完成 | 写 RPC 尾部 `afterWrite()` → `notifyMutation()` → 重算推帧（reason='mutation'，同样受 R2 约束——净效果为零的写不产生帧；`index.ts:639-642`、`watcher.ts:242-248`） |
| R4 poll | `pollIntervalMs` 定时兜底 | 定时重算推帧（reason='poll'；**嵌套目录内文件编辑只能靠它捕获**——宿主 watch depth:0 不递归） |
| R5 manual | client 上行 `{type:'refresh'}` | 重算并**无条件**推帧（reason='manual'——唯一旁路 R2 的原因，客户端失步重同步用；上行经流 uplink 单消费者面，未知 type 忽略前向兼容；`watcher.ts:237-240`、`index.ts:672-690`） |
| R6（降级模式，非帧） | fs watch 不可用 | 能力缺失 / watch 拒绝 / 抛错 / 回调报错 ⇒ 仅 warn 一次 → 关全部 watch 转纯轮询（后续失效回调被忽略，不再产生 'change' 帧——只剩 R4）；`watchEnabled=false` 是显式意图，info 级日志不算 R6 故障（`watcher.ts:308-316,432-479,490-499`） |

同防抖窗内多触发合并为一次重算时取最强原因落帧（优先序 mutation > manual > change > poll，`watcher.ts:97-98`）。订阅引用计数：0→1 启动（轮询定时器 + 首个 ready 帧解析出 repoRoot 后开三目标 watch），1→0 全关（`watcher.ts:265-335`）。

**client 侧消费契约**（`packages/client-ui/src/client/store/git-status-source.ts`）——代际丢帧（`reset()`/`dispose()` 递增代际并 dispose 旧句柄，旧流迟到帧一律丢弃，绝不覆盖新代际状态）、revision 去重（**内容签名与上一接受帧相同的帧被丢弃**：不写 store、不 bump revision、不触发渲染——R5 无条件帧与 R1 重放由此幂等；错误帧落 `statusError` + `repo.available` 投影，`git/no-repository`/`git/session-workspace-unresolved` ⇒ 不可用，流不断开）、R5 = `refresh()` 走上行 `{type:'refresh'}`（流未开退化为重开流）、connection/reset = 全清（回到 checking）+ 立即重订（`git-status-source.ts:9-25,99-126,168-203`）。**client 去重签名粒度必须 ≥ host 帧签名粒度**（client 粗于 host 会把 host 判「有变化」的帧误判重复丢弃 ⇒ 渲染滞后——P1 丢帧修复的教训，见修订记录 v1.3 首段）：两侧现为**同粒度**——同为剔除 `generatedAt` 的全量内容签名（client `snapshotSignature` `git-status-source.ts:77-87` ≡ host `frameSignature` 的 snapshot 半 `watcher.ts:100-115`）。

**client 侧传输归真**（v1.3——transport = 常开 followStatus 流，**client 不再自设 3s/30s 轮询**，兜底轮询在 host 侧 R4；实现 = `git-status-source.ts:90-166`）：

| 触发 | 动作 |
|---|---|
| apply 挂载完成（remote.git 命名空间就绪后） | 打开首代流（`start()`；流正常收尾保持既有状态，等 reset/refresh 重开） |
| 任一 Tier B/C RPC 成功返回 | 状态源 `refresh()`（上行 R5 manual——host 重算无条件推帧；先本地乐观失效 diff 缓存不等网络，`git-changes-store.ts:172-180`）+ 按 §1.9 失效列清 client 缓存（log/refs/getCommitDetail 的失效 = 状态订阅 branch.oid 变化 → reload，§1.8） |
| `ctx.on('connection/reset')` | 全缓存清空（回到 checking）+ 立即重开流（新代际；旧代际帧全部丢弃；`index.ts:88-92`） |
| 窗口聚焦 | `refresh()`（R5 manual）——**v0.1.2 未实装聚焦监听**（原案行，保留为设计意图；实测无 focus/visibilitychange 监听） |
| 帧去重（revision 丢帧） | 见上方 client 侧消费契约——内容签名相同不写不计数；粒度必须 ≥ host（同上） |

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
| `GitPushDialog` | header 菜单 push 行拉起（remotes 数 > 1 时；单 remote 一步直推——v1 行为不回归，`pushRoute` 纯函数 `admin-view-model.ts`） | 普通组件（remote picker = `remoteList` 数据；force 勾选后 `GitConfirmDialog severity='danger'` 勾选闸二次确认） | 27/57 |
| `GitBranchCreateDialog` | header 菜单 branch-create 行拉起 | 普通组件（name/from/checkout 三字段；重名 ⇒ `git/branch-exists` 错误面板） | 23 |
| `GitTagCreateDialog` | header 菜单 tag-create 行拉起（图 tab tag chip 菜单「从该提交打 tag」复用） | 普通组件（name/oid/message 三字段；重名 ⇒ `git/tag-exists`） | 30 |
| `GitWorktreeDialog` | header 菜单 worktree 行拉起 | 普通组件（列表区 [62] + 新建区 path/现有分支或新建分支二选一 [68] + 移除入口——脏 worktree 强制移除走 danger 勾选闸） | 62/68 |

> v2 批次一补录（2026-11-08，docs/v2-implementation-plan.md §3.6；组件行为面以实落代码为准）：① header 菜单 `sync` 占位行（v1 `placeholder:true`）转真为 push/pull/fetch 三行（复用既有 RPC；fetch 成功后 R5 manual 刷新 behind）；新增 branches（子菜单：当前分支打勾、detached 显短 oid、点击切换 + 删除分支入口——当前分支前置禁用）/branch-create/tag-create/worktree/branch-delete 行（`ui-model.ts` `headerMenuItems`）。② 组件不做 RPC 纪律的承载 = `admin-face.ts` `createGitAdminFace`（apply 顶层铸一次、root rpc 注入，commit-dialog-face 同构）+ `admin-view-model.ts` 纯视图模型（渲染决策纯函数化，spec §6 纪律）。③ 图 tab tag chip 增菜单（删 tag / 从该提交打 tag，数据面 `CommitDetail.refs` 既有）。④ danger 双闸：force push 与脏 worktree 强制移除共用 `GitConfirmDialog severity='danger'`（`confirmButtonEnabled` 一处实现两处消费，`ui-model.ts:114`）。

> v2 批次二补录（2026-11-08，docs/v2-implementation-plan.md §4.6；组件行为面以实落代码为准）：① **blame（[34]，D3=B）**：`GitChangesTab` diff 区增「追溯/差异」双态切换（`changes.blameMode`/`changes.diffMode`，aria-pressed）⇒ `GitBlameView`（行号 gutter 注记：短 oid + 作者 + 相对时间，同 range 合并显示；`@tanstack/react-virtual` 基线虚拟化——EXTERNALS 既有依赖零新增）。数据半 = `git-blame-store.ts`（范式 A，root 作用域，工厂函数）：先全区一次（`blame({path})`），全区超限（`git/blame-oversized`）⇒ 槽位转**分片模式**（oversized=true），按虚拟滚动可视窗口（± `BLAME_WINDOW_MARGIN`=80 行余量）以 `blameSlicePlan` 规划缺口经 `ensureRange` 增量 `-L` 加载，store 以覆盖簿记去重、区间结果按行号归并（跨片同 oid 合并——`blame-view.ts` 纯半 `blameGutterRows`/`mergeBlameRuns`，`blame-view.spec` 钉）；「无法分片」兜底占位（`blame.oversizedFallback`）镜像 `diff.oversized` 形态。② **分支对比（[36]）**：header 菜单 branch-compare 行（`menu.branchCompare`，挂非当前分支子菜单——`ui-model.ts` `branchCompareEntries` 渲染纯半）→ `graph-intent-store`（root 作用域**跨槽位意图通道**：header/changes 拉起方 `request` + `openResource` 图 tab、图 tab `consume` 清除，nonce 单调防重）→ `GitGraphTab` 内 `GitComparePanel`（ahead/behind 两列提交行，行点击复用 commit-detail-panel；关闭恢复全图）——数据半 `git-compare-store.ts`（范式 A；compare 半 = 当前分支，open(base) 幂等，detached/unborn 入口闸拦截）。③ **单文件历史（[60]）**：变更卡片「文件历史」动作（`changes.fileHistory`）→ `openFileHistory` → 意图通道 path 模式（图 tab 顶栏 `graph.path.chip` + 退出按钮；`log({path, follow:true})`）；提交行点击 `getCommitDetail({oid, path})` 看当版 patch（既有方法）。④ **WIP 节点（[38]）**：`wip-node.ts` 纯 client 合成（status 四组计数 + HEAD oid；clean 不渲染）→ 图首页顶部合成行（`data-git-graph-wip` 锚），点击 openResource 变更 tab。⑤ **时间旅行（[37]）**：图 tab 提交行菜单 cherry-pick/revert（`menu.commitCherryPick`/`menu.commitRevert`；`GitConfirmDialog` normal 档确认即 acknowledged，`runTravel` 组装 baseRevision）+ header 菜单 branch-reset 行（`menu.branchReset`，`branchResetEntries` 子菜单）→ `GitResetDialog`（`GitHeaderButton` 拉起；soft/mixed/hard 按钮组，hard 走 danger 勾选闸 `confirmButtonEnabled('danger', …)` + 将丢弃文件计数展示；守卫纯半 `admin-view-model.resetPlan`——acknowledged + baseRevision，baseRevision=null ⇒ 确认禁用）。⑥ **历史搜索（[35]）**：图 tab 顶栏 query/author 双输入 + 过滤 chip（`graph-search.ts` 纯半：null 过滤不产生 wire 键——可选字段省略传递纪律；空结果视图换 `graph.search.emptyResult`，无过滤空仓语义不变）。对应 spec：`blame-view` / `graph-compare` / `graph-search` / `wip-node` 四新 spec + `ui-model.spec`/`error-map.spec`/`locales.spec` 扩展。

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

> v2 批次一补录（2026-11-08；**键集权威 = zh 词典** `packages/client-ui/src/client/locales.ts`，本表为分组索引非权威）：① menu 组扩展 = `menu.push` `menu.pull` `menu.fetch`（sync 占位转真）+ `menu.branches` `menu.branchCreate` `menu.branchDelete` `menu.tagCreate` `menu.worktree`；`menu.sync` 与 `menu.placeholderHint` 随占位移除删除。② 新组 = `branch.create.*`（title/nameLabel/nameRequired/startLabel/checkout）+ `branch.delete.*`（title/message）+ `branch.detached` + `tag.create.*`（title/nameLabel/nameRequired/targetLabel/messageLabel）+ `tag.delete.*` + `tag.menuCreateHere`/`tag.menuDelete` + `push.*`（title/remoteLabel/force/forceConfirmTitle/forceMessage/setUpstreamMissing）+ `worktree.*`（title/add/addTitle/pathLabel/pathRequired/branchLabel/branchRequired/existingBranch/newBranch/detached/bare/locked/empty/remove/removeTitle/removeMessage/removeForce/removeForceMessage）。③ error 组新键（随 §1.0.5 六码）：`error.branch-not-found` `error.branch-not-merged` `error.branch-exists` `error.tag-exists` `error.tag-not-found` `error.worktree-failed`。④ P3-4/P3-5 死键同批删除：`graph.head`、`changes.oversized`（实际占位走 `diff.oversized`）——`pnpm run check:locale` 与 locales.spec 复跑绿。规则不变：新增键必须 zh/en 同步；locales.spec 键集一致断言守卫。

> v2 批次二补录（2026-11-08；键集权威 = zh 词典，本表为分组索引非权威；键集实测自 locales.ts 工作树 diff）：① menu 组新键 = `menu.branchCompare` `menu.branchReset` `menu.commitCherryPick` `menu.commitRevert`。② graph 组新键 = `graph.search.*`（placeholder/authorPlaceholder/authorHint/chipQuery {query}/chipAuthor {author}/clear/emptyResult）+ `graph.wip.*`（label/counts {staged} {unstaged} {untracked} {conflicted}）+ `graph.compare.*`（title {compare} {base}/ahead {base} {count}/behind {base} {count}/mergeBase {oid}/empty/pending/close）+ `graph.path.*`（chip {path}/exit）。③ changes 组新键 = `changes.blameMode` `changes.diffMode` `changes.fileHistory`。④ 新组 = `blame.*`（loading/empty/chunkHint/oversizedFallback/time.now/time.minutes {count}/time.hours {count}/time.days {count}）+ `timeTravel.cherryPick.*`（title/message {shortOid} {subject}）+ `timeTravel.revert.*`（title/message）+ `timeTravel.reset.*`（title {target}/kindLabel/soft/mixed/hard/hardMessage {count}）。⑤ error 组新键（随 §1.0.5 四码）：`error.blame-oversized`（{path} {lineCount} {maxLines}）`error.merge-conflict`（{op} {count}）`error.unknown-revision`（{op} {revision}）`error.operation-in-progress`（{op}）+ `error.action.abort`（merge-conflict 面板的「放弃操作」入口）；reason 扩值 'follow-without-path' 复用既有 `error.bad-request` 插值不新增键。规则不变：新增键必须 zh/en 同步；本轮 `pnpm run check:locale`（202 键 zh 权威、en aligned、17 .tsx 裸串扫描）与 locales.spec（6 用例）复跑绿。

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
