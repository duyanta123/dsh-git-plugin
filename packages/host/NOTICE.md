# NOTICE — dsh-git-plugin 署名与移植合规策略

> 依据 `docs/capability-spec.md` 第⑤节起草（下称【spec §⑤】）。登记表的行级权威在
> spec §5.1；本文件是仓库内随施工维护的工作副本。
> 工作流通用约定提到的 PORTING.md 自 ⑤ status 引擎模块（2026-10-31）起建立于本目录
> （A/B/C 级定义与本模块登记行）；历史登记仍以本文件 §2 为准，两表互为镜像索引。
> **当前状态（v0.1.2 / V2 前置口径，2026-11-07）**：v1 全部模块（④-A–④-L）落地并过门禁，代码定稿 0.1.2
> （四 manifest 同版）——尚未打 tag / 未发 npm，**发布随 V2 首版一并打出**；2026-11-07 前置修复批已落
> （P1 client 丢帧修复等，见 `docs/capability-spec.md` 修订记录 v1.2/v1.3）。
> 此前状态（v0.1.0 发布定稿，2026-11-01）：新增 `git-bundle/`（`dsh-gitkit-bundle` 单一 file: 安装薄包，见 §7）；
> 本项目许可自 MIT 改定为 Apache-2.0（发布 ask 决议，见 §4 与 THIRD_PARTY_NOTICES.md §1）。
> 此前状态（F7 提交图全链模块后）：host `graph.ts`（log/refs/getCommitDetail，ZCode A 级 + GitLens C 级对照）与 client `graph/lane-layout.ts`（自研 G1–G5）+ `graph/graph-svg.tsx` + `graph-view-model.ts` + `store/git-graph-store.ts`/`graph-tab-store.ts` + `components/git-graph-tab.tsx`/`commit-detail-panel.tsx` 已落地；此前状态（F 变更面板模块后）：git-runner（四实例扩展）/ status-parser（v2 终态 +
> v1 回退 + numstat）/ status（编排引擎）/ diff（diff 引擎）/ watcher（三目标 watch + 防抖 +
> 引用计数 + R1–R6 流帧）/ support.ts（保尾仿真 + chokidar fs 仿真）/ client-ui
> `diff/patch-hunks.ts`（FileDiff 纯函数照抄）已移植并落文件头；client 组件（变更卡片 B 级、
> tab body / FileDiffView / 地址范式 C 级）已登记；其余行「计划中（未移植）」。

## 1. 总底线（spec §5.1 首段）

- Apache-2.0（ZCode / Codex / Cline）与 MIT（opencode / GitLens MIT 区 / dsh）材料**可移植，但必须保留版权与许可声明**（文件级登记 + 文件头，见 §3）。
- **一行代码不进仓库**的来源：GitLens `packages/plus/**`（LICENSE.plus 约束）、mhutchie/vscode-git-graph、gitamine（均 GPL-3.0）。GitLens `LICENSE.plus` 文本只留在 `docs/ported-sources/` 作合规证据；THIRD_PARTY_NOTICES 中不得出现对 mhutchie 代码的引用式搬运，NOTICE 里仅允许"阅读参考、未使用代码"一行说明（spec §5.2）。
- lane 布局算法：以 pvigier 博客为教材**自研实现**（文章可自由学习）；gitamine（GPL-3.0）代码一行不搬。

## 2. 文件级移植登记表（随施工推进维护；每行都要落 §3 的文件头）

| 我们的目标文件 | 来源文件 | 来源版本 | 许可 | 移植方式 | 状态 |
|---|---|---|---|---|---|
| `packages/host/src/git-runner.ts` | dsh `client-ui-forge/src/git.ts`（runGit）+ `workspace-changes/src/git.ts`（常量/env） | dsh 树 `f3803c9697`→`ce7073d512` | MIT（dsh） | 手抄组合（spec §1.0.7） | 已移植（最小插件阶段；④-A 补正式文件头；⑤ 扩展四实例/两套前缀/op/stdin/maxBytes/env——PORTING.md A 级） |
| `packages/host/src/git-runner.ts`（safe.bareRepository 前缀） | codex `git-utils/operations.rs:122` + `fsmonitor.rs`（参数清单） | `7c11b807` | Apache-2.0 | 参数清单翻译成 TS（Rust 不移植） | 已移植（⑤；spec §5.1 原列 sync.ts 行——实际落点 git-runner，B 级） |
| `packages/host/src/workspace.ts` | dsh `workspace-changes/src/index.ts:60-62,84-87`（session.header.cwd 解析服务面 + 资格判定 + turn/start 时机）+ `recorder.ts:136`（realpath 规范化） | dsh 树 `ce7073d512` | MIT（dsh） | 移植；Session 类型面换最小结构接口；优先级 = workspaceOverride → 最近顶层会话 → 域码 | 已移植（④-A，文件头已落） |
| `packages/host/src/status-parser.ts` | ZCode `gitCliRepo.ts`（v2 命令形态/编排契约，解析本体自研——gitCliHelpers 未在参考库，record 形状以本机 git 2.55.0.windows.2 实测为准）+ Cline `sidecar/source-control.ts:99-164`（v1 回退段逐段移植）+ dsh `workspace-changes/src/numstat.ts:20-52`（numstat 逐行移植） | `3c5b2276` / `f817e59f` / dsh `ce7073d512` | Apache-2.0（双来源）+ MIT（dsh） | 逐段移植 + 自研终态；文件头双来源署名 | 已移植（⑤，PORTING.md A 级） |
| `packages/host/src/status.ts` | ZCode `gitCliRepo.ts:857-892,543-597`（getStatus 编排 + in-flight 去重）+ dsh forge `git.ts:99-103`（repo 发现 null 范式） | `3c5b2276` / dsh `ce7073d512` | Apache-2.0 + MIT（dsh） | 逐段移植；commandProvider → GitRunner 只读实例；缓存/三态为本模块设计 | 已移植（⑤，PORTING.md A 级） |
| `packages/host/tests/support.ts`（扩展） | dsh `subprocess-local/src/spawn.ts`（溢出保尾行为语义） | dsh 树 `ce7073d512` | MIT（dsh） | 行为仿真（B 级）：lossy 时 readFrom 保尾 + spawn 记录面 | 已移植（⑤，PORTING.md B 级） |
| `packages/host/src/diff.ts`（repo 发现段） | dsh `client-ui-forge/src/git.ts:99-103`（"exit 128 + not a git repository" 范式——status.ts 同款再应用） | dsh 树 `ce7073d512` | MIT（dsh） | 范式移植（null 判定改抛 `git/no-repository` 域码） | 已移植（④-C，文件头已落，PORTING.md A 级） |
| `packages/host/src/diff.ts`（listing 双路 + 预算环编排语义） | opencode `packages/core/src/git.ts` diffGroup（name-status + numstat + patch 三路并发、patchBudget 预算递减） | `b6c43a52` | MIT | **语义学习，零代码搬运**；解析纯函数自研（record 形状以本机 git 2.55.0.windows.2 实测为准） | 已登记（④-C，PORTING.md C 级） |
| `vitest.config.ts`（standardDecoratorPlugin） | dsh `vitest.shared.ts`（TS 标准装饰器预变换插件） | dsh 树 `ce7073d512` | MIT（dsh） | 照抄（去 v8 ignore 改写一行） | 已移植（④-A） |
| `packages/typert-protocol/`（整包） | npm `@deepseek-ai/dsh-typert-protocol@0.2.2-alpha.2` 发布物（lib/LICENSE/README 未改动副本）+ dsh 树 `packages/typert/protocol/src/*.ts`（同版本源码） | 0.2.2-alpha.2 | MIT（dsh） | 原样再分发（typert-generator 登记包拓扑要求：analyzer 只认根 packages/ 下登记包的 Remote 声明与 src 源平面；**仅构建期/类型面使用**——运行时 profile 从 registry 装同名 npm 包；副本内 LICENSE/README 保留） | 已登记（④-A） |
| `packages/host/src/error-codes.ts`（声明合并形态） | dsh `packages/experimental/client-ui-cot-translation/src/types.ts:23-28`（`declare module '@deepseek-ai/dsh-typert-protocol'` + `RemoteErrorDetailsMap` 的模块说明符形态） | dsh 树 `ce7073d512` | MIT（dsh） | **形态对照**（6 行声明骨架同构；码表内容为 spec §1.0.5 自有定义，无逐行搬运） | 已登记（④-A） |
| `packages/host/tsdown.config.ts` | dsh 根 `tsdown.config.ts` + `packages/typert/generator/src/tsdown-plugin.ts`（typertPlugin 用法与产物契约） | dsh 树 `ce7073d512` | MIT（dsh） | 用法对照；配置为本仓库自写（workspace 模式走 generateContributors，同树 scripts/generate-typert.ts 语义） | 已登记（④-A） |
| `packages/host/src/sync.ts`（安全参数余量：status.rs 并发去重 / fsmonitor 探测翻译） | Codex `git-utils/status.rs` / `fsmonitor.rs` | `7c11b807` | Apache-2.0 | 探测序列翻译成 TS（Rust 不移植）；fsmonitor=false 已随 ⑤ 落进只读前缀，探测型覆盖不做（见 PORTING.md C 级） | 计划中（v1 用静态 false 覆盖） |
| `packages/host/src/mutations.ts` / `commit.ts` | ZCode `gitCliRepo.ts`（写命令段 :1421-1486）+ `gitService.ts`（:242-253 编排）+ dsh forge `git.ts:99-103`（commit.ts 仓库发现段再应用） | `3c5b2276` / dsh 树 `ce7073d512` | Apache-2.0 + MIT（dsh） | C 级语义对照（命令形态/去重/写后失效；守卫、unborn/极老 git 兜底、no-paths 为任务口径自研）+ A 级范式再应用（commit.ts probe 段，文件头已落） | 已登记（⑤ mutations/commit，PORTING.md） |
| `packages/host/src/sync.ts`（push/set-upstream 段） | ZCode `gitCliRepo.ts` :1654 与 :1391-1400 | `3c5b2276` | Apache-2.0 | 逐段移植 | 计划中 |
| `packages/host/src/message-gen.ts` | ZCode `gitCommitMessageGenerator.ts`（裁剪常量 :10-17 子集 + `CONVENTIONAL_COMMIT_RE` :20 + validate 剥壳链 :239-255/:337-349 + clipText/buildDiffSummary/prompt 框架）+ dsh `session-title-llm/src/index.ts:236-291`（六步执行范式，C 级语义对照零逐行搬运） | `3c5b2276` / dsh 树 `ce7073d512` | Apache-2.0 + MIT（dsh） | 逐段移植 + 范式对照；LLM 调用换 `ctx.llm.prepareCall`（A 级，文件头已落，PORTING.md） | 已移植（M7） |
| `packages/host/src/watcher.ts`（防抖结构） | ZCode `fileWatcherService.ts`（`DEBOUNCE_MS=150` :13 + 防抖窗结构 :78-92；登记口径含引用计数语义，SOURCES.md:36） | `3c5b2276` | Apache-2.0 | 只抄结构；node:fs.watch → 宿主 fs 能力面（ctx.fs.watch 三目标：.git/index、.git/HEAD、repoRoot depth:0）；R6 降级（warn 一次转纯轮询）与 R1–R5 帧规则为本模块设计（spec §2.3 的 chokidar 自带 watcher 方案按实测偏离，见 ModuleResult openIssues） | 已移植（M9，PORTING.md A 级） |
| `packages/host/src/watcher.ts`（失效+重算 follow 范式对照） | dsh `workspace-files/src/changes.ts:39-109`（follow() 生命周期范式：resolve→watch→ready→失效重取） | dsh 树 `ce7073d512` | MIT（dsh） | 语义学习，零代码搬运 | 已登记（M9，PORTING.md C 级） |
| `packages/host/tests/support.ts`（扩展：chokidarFsFace） | dsh `fs-local/src/index.ts:70-91`（LocalFileSystem.watch 语义：目录目标 depth:0 无忽略 / 文件目标监父目录 ignored 放行根与目标 / 失效回调不带内容） | dsh 树 `ce7073d512` | MIT（dsh） | 行为仿真（B 级）：fs-local 同形 chokidar@5 watch 面替身（M9 集成测试真实 fs 事件驱动，含嵌套目录无事件已知限制断言） | 已移植（M9，PORTING.md B 级） |
| `packages/client-ui/src/client/diff/*.ts` | dsh `ui-deliverables` FileDiff 纯函数（hunkRows/splitRows/renderedHunks） | dsh 树 `ce7073d512` | MIT（dsh） | 照抄纯函数进自己包（实际落点 `diff/patch-hunks.ts`，hunk 类型换本包自有 PatchHunk + 自研 parsePatch） | 已移植（F 变更面板，PORTING.md A 级，文件头已落） |
| `packages/client-ui/src/client/components/ChangeCard.tsx` | ZCode `GitPaneChangeCard.tsx`（行按钮+计数+展开 diff 区的卡片结构） | `3c5b2276` | Apache-2.0 | 结构对照（B 级）：逻辑重写、视觉随 dsh（dsh-git-* 类名 + data 锚）；勾选/行内动作/徽标为本模块 ask 扩展 | 已登记（F 变更面板，PORTING.md B 级，文件头就近注明） |
| `packages/client-ui/src/client/components/GitChangesTab.tsx` / `FileDiffView.tsx` / `addresses.ts` | ZCode `GitPane.tsx`（单展开+懒加载+消失守卫语义）+ dsh `FileDiff.tsx` 渲染链 + dsh `changes.ts:143-165`（地址铸造/严格解析范式） | `3c5b2276` / dsh `ce7073d512` | Apache-2.0 + MIT（dsh） | 语义学习/范式移植，零逐行搬运（C 级） | 已登记（F 变更面板，PORTING.md C 级） |
| `packages/client-ui/src/client/graph/lane-layout.ts`（类型面）+ `store/git-graph-store.ts`（single-writer） | GitLens MIT 区 `models/graph.ts`（行头/upstream 形状）+ `graphSession.ts`（single-writer 契约）+ `utils/graph.utils.ts`（窗口追加对照） | `020cfc1b` | **MIT 区** | C 级语义对照，零代码搬运；类型/契约按 spec §3.3.1/§3.2 自写（spec 的 graph-types.ts 落点 = lane-layout.ts 类型面；窗口追加简化为 push+oid 去重） | 已登记（F7 提交图数据层，PORTING.md C 级） |
| `packages/host/src/graph.ts`（log 分页取参段） | ZCode `gitCliRepo.ts` getCommitGraph :1013-1053 + normalize :386-400（A 级 over-fetch/钳制/unborn 守卫）；GitLens providers/graph.ts 的 over-walk/spurious-empty 模式未移植（host 无状态分页，spec §5.1「只摘模式」行的实际落法见 PORTING.md） | `3c5b2276` / `020cfc1b` | Apache-2.0 + MIT 区 | A 级逐段移植（文件头已落）+ C 级对照 | 已移植（F7 提交图数据层，PORTING.md） |
| client 组件交互 | ZCode `GitActionMenu/useGitAutoRefresh`（GitPane/GitPaneChangeCard 已随 F 变更面板落地登记；GitActionMenu 提交对话框段已随 ④-K 登记 C 级——三动作闸/主快捷键/生成 pending 语义对照，PORTING.md） | `3c5b2276` | Apache-2.0 | 抄交互逻辑与状态流，不抄样式 | 已登记（④-K C 级；余项：header 菜单 push/pull/fetch 动作/自动刷新兜底） |
| `packages/host/src/sync.ts`（命令选择） | opencode `git.ts` / `vcs/git.ts` | `b6c43a52` | MIT | 语义学习，不整文件移植；逐段搬运时升级登记 | 计划中 |
| `packages/host/src/commit.ts`（语义） | aider `repo.py` | `5dc9490b` | Apache-2.0 | 只学语义，Python 不移植 | 计划中 |
| lane 布局算法 | pvigier 博客（教材） | 网页 | 文章可自由学习 | 自研实现（spec §5.5 声明行——PORTING.md F7 C 级：temporal 修复路径 + 活跃 lane 表 + 最小空闲位；gitamine/mhutchie 零代码） | 已实现（F7——`client-ui/src/client/graph/lane-layout.ts`） |

来源许可与版本细节以 `docs/ported-sources/SOURCES.md` 为准。

## 3. 移植文件头模板（每个登记文件必须带；spec §5.3 原文）

```ts
/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/repo/gitCliRepo.ts
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-xx — child_process 换 dsh ctx.subprocess；错误类型改领域错误（RemoteError）
 * SPDX-License-Identifier: Apache-2.0
 */
```

（MIT 来源同构：`Ported from gitkraken/vscode-gitlens@020cfc1b… — packages/git/src/models/graph.ts — MIT — Copyright (c) 2021-2026 Axosoft, LLC dba GitKraken; Copyright (c) 2016-2021 Eric Amodio`。Apache-2.0 第 4(b) 条要求修改文件带显著变更说明，Modifications 行即此。）

## 4. 仓库级合规文件（spec §5.2）

- `LICENSE`（本项目 **Apache-2.0**：`Copyright 2026 dsh-git-plugin contributors`；发布 ask 改定——spec §5.2 原写「本项目 MIT」，见 THIRD_PARTY_NOTICES.md §1 版本注记）与 `THIRD_PARTY_NOTICES.md`（全文附 Apache-2.0 ×3：Z.AI Co., Ltd / OpenAI / Cline Bot Inc.；MIT ×3：opencode / GitLens Axosoft+Eric Amodio / dsh；本项目 Apache-2.0）：**已定稿（2026-11-01 评审整改；发布模块改本项目许可为 Apache-2.0）**——dsh LICENSE 版权行原文经 `packages/typert-protocol/LICENSE` 副本核实（`Copyright (c) 2026 DeepSeek`，spec §0.4-8 落实）；根与各包各放一份三件套，`tests/licenses.spec.ts`（§5.4）守卫齐备与同文性。
- 发布就绪：各包的 `files` 必须包含 `LICENSE` `NOTICE.md` `THIRD_PARTY_NOTICES.md`（已按此配置，licenses.spec 断言）。

## 5. 合规守卫（进测试；spec §5.4）

施工期新增 `tests/licenses.spec.ts`：扫描 `packages/*/src` 与 `packages/*/lib`，断言 (a) 登记表内文件均有对应来源头；(b) 全库 grep 不出现 `packages/plus`、`vscode-git-graph` 的标识符、gitamine 路径；(c) `THIRD_PARTY_NOTICES.md` 不含 mhutchie 代码文本。

## 6. 本仓库自身的第三方声明

- 除 §2 登记行外，代码为原创；`lib/typert.*.js` 为 typert-generator 生成物（自带 Generated-by 头），不属人工移植登记范围。
- 依赖项许可随各包自身声明；`packages/typert-protocol/` 是 §2 登记的 dsh MIT 再分发副本（上游文件零改动；另新增我们自己的 tsconfig.build.json——上游 npm 发布物自带 lib/，本仓库 .gitignore 排除 lib/，全新 checkout 需经它重建完整 lib/types 产物（*.js + *.d.ts，入口 exports[\".\"] 对齐 lib/types/index.js——上游 lib/index.js 为打包产物、本构建以 tsc 平铺等价替代）。

## 7. `dsh-gitkit-bundle`（发布薄包，v0.1.0 新增）

- 落点 `git-bundle/`（workspace `packages/*` 之外——发布产物，不入 workspace 拓扑）：**零代码**薄包——只有 `package.json`（`dsh.bundle.patch` 指向自带
  `cordis.patch.yml`）、`cordis.patch.yml`（insert 两行：`dsh-plugin-git` → `dsh-gitkit`、
  `dsh-plugin-client-ui-git` → `dsh-gitkit-ui`）与三件套副本；无 src/lib。
- 作用：`dsh plugin --profile <p> add file:<repo>/packages/git-bundle` 一次安装即把 host/client
  两包经 `file:` 依赖带入 profile（宿主 profile 用 `nodeLinker: hoisted`，`app-boot/src/profile.ts`
  `PROFILE_PNPM_WORKSPACE`），reconcile 按 git-bundle 的 `dsh.bundle` 把两行 insert 追加进
  `dsh.profile.bundles`（`plugin-manager/src/operations.ts` reconcile——按 profile 顶层 dependencies
  扫描，git-bundle 是唯一顶层依赖，两行补丁随它的 bundle 层进入）。许可随本项目（Apache-2.0）。

## 8. 商业授权与联系（Apache-2.0 之外的双许可通道）

Apache-2.0 已授予的使用、修改、再分发（含商业用途）权利不受本节影响——义务仅为保留
许可文本与本 NOTICE（被动署名：发行包携带本文件与仓库链接，即"向我说明"的实现形式）。
需要**去除/替换署名**、**闭源商业集成**、**优先支持或定制开发**等替代授权的，联系：

**GitHub @duyanta123 · 3351868726@qq.com**

本节为授权要约通道，不构成对 Apache-2.0 授予权利的任何限制；上游第三方代码
（THIRD_PARTY_NOTICES.md 所列）按其原许可独立授权。
