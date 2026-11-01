# SOURCES.md — dsh Git 插件移植参考库登记表

> 生成：2026-10-28（重建运行，读者子任务「读者·移植源抓取」产出；本会话对全部 36 个文件**重新执行**了抓取与检查）。
> 本目录是移植参考库：把各参照项目的关键源码**原文**抓回本地（不改写、不重排、保留版权头），
> 供后续开发对照移植。抓取一律经 gh CLI（已认证）：
>
> ```
> gh api -H "Accept: application/vnd.github.raw" repos/<owner>/<repo>/contents/<path>?ref=<branch> > <本地路径>
> gh api repos/<owner>/<repo> --jq .default_branch                  # 默认分支
> gh api repos/<owner>/<repo>/commits/<branch> --jq .sha            # 记录版本
> gh api repos/<owner>/<repo>/git/trees/<branch>?recursive=1        # 定位路径/取仓库侧字节数
> ```
>
> **完整性检查（本会话实测，36/36 通过）**：① 每个文件 `wc -c` 非空，且与 `git/trees` API 报告的
> 仓库侧 blob size **逐字节相等**；② 错误体混入检测 `grep -qiE "<!doctype html|<html|\"message\": \"Not Found|rate limit|Bad credentials"`。
> 注意：GitActionMenu.tsx / GitPane.tsx / web/graph.ts 三文件被该 grep 命中，逐行甄别为**误报**——
> 匹配的是 TS 泛型 `HTMLTextAreaElement`/`HTMLDivElement`/`HTMLElement`（文件头正常、字节数与仓库侧一致），非错误页。
> 行数为 `wc -l` 实测。下表"检查"列即本次检查结果。
> **Claude Code（Anthropic）**：官方未开源（GitHub 仓库仅 CHANGELOG/examples/plugins，CLI 经 npm 发行；
> 调研报告 2026-10-25 已核实），**不作源码参考**，本库不收录其任何文件。

---

## 1. zai-org/ZCode（主移植源）

- 默认分支：`main`；抓取版本：commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`（2026-10-20T06:23:05Z，"chore: sync ZCode source"）
- 许可：**Apache-2.0**（repo spdx `Apache-2.0`；LICENSE 为标准 Apache 全文，版权行 `Copyright 2026 Z.AI Co., Ltd` 在 LICENSE:190）
- **移植注意（全局）**：逐文件移植必须保留原 Apache-2.0 版权与许可声明；本项目仓库需加
  NOTICE/THIRD_PARTY_NOTICES 登记来源（prior-session-conclusions 第二节第 1 条）。

| 本地文件（`docs/ported-sources/zcode/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `packages/services/src/git/repo/gitCliRepo.ts` | 58787 | 1711 | ok | ① 全部 git 命令层：`status --porcelain=v2 --branch --untracked-files=… -z`（gitCliRepo.ts:549）、staged/unstaged `diff --numstat -z --find-renames` 并发（:876/:882）、`diff --numstat upstream...HEAD`（:1391-1400）、临时索引部分提交（`GIT_INDEX_FILE` :1547 + `read-tree` :1552）、push 自动 `--set-upstream`（:1654）；超时/字节上限常量自 helpers 导入（:21-25）。② 对应我们 host 端 `git-runner.ts`/`status.ts`/`mutations.ts`。③ child_process 需换成 dsh `ctx.subprocess.spawn`；:549 与调研报告引用行号一致，报告基于 rc.3 但此文件行号吻合。 |
| `packages/services/src/git/gitService.ts` | 11865 | 357 | ok | ① 服务编排状态机：`refresh()`（gitService.ts:321）一次 status 快照切 summary/unstaged/staged 三份数据，`stagePaths` :242 / `unstagePaths` :246 / `discardPaths` :250 / `commit` :301 / `push` :312。② 对应 host 端 `GitService` 骨架与状态管理。③ Electron IPC 事件要换成 Typert remote 事件。 |
| `packages/services/src/git/gitCommitMessageGenerator.ts` | 12321 | 356 | ok | ① AI 提交信息：裁剪上限常量（:10-17：20 文件 / 8 diff / 12k 总量 / 单文件 2k / 上下文 12 条 4k / 单条 600 / 消息上限 1k）+ `CONVENTIONAL_COMMIT_RE`（:20）+ prompt 约束（:197-199）。② 对应 host 端 `message-gen.ts`。③ LLM 调用换成 `ctx.llm.prepareCall`（范式照 dsh session-title-llm）；裁剪常量可直接沿用。 |
| `packages/services/src/fileWatcher/fileWatcherService.ts` | 5383 | 150 | ok | ① 文件监听：Node fs.watch recursive + `DEBOUNCE_MS = 150`（fileWatcherService.ts:13，应用在 :92）+ 引用计数启停。② 对应 host 端 `watcher.ts`。③ 我们改用 dsh `ctx.fs.watch`（chokidar），只抄防抖与引用计数结构。 |
| `packages/ui/src/GitActionMenu.tsx` | 49974 | 1404 | ok | ① header 主按钮 + 提交对话框 + 推送对话框，commit/commitAndPush/push 三动作（表单提交处理 :344/:357/:399）。② 对应 client 端 `GitHeaderButton.tsx`/`GitCommitDialog.tsx`。③ 组件库与样式体系不同（Electron UI → dsh primitives），抄交互逻辑与状态流，不抄样式实现。 |
| `packages/ui/src/GitPane.tsx` | 19369 | 546 | ok | ① 审查面板：来源切换、diff 懒加载、展开状态、文件变更查找联动（文件头注释 :1），列表用 `@tanstack/react-virtual` 虚拟滚动（:2）。② 对应 client 端 `GitChangesTab.tsx`，且虚拟滚动做法可复用到 F7 行列表。③ dsh 侧 diff 渲染可混用 ui-deliverables 的 FileDiff；注意其 props 依赖 ZCode store 形状。 |
| `packages/ui/src/GitPaneChangeCard.tsx` | 9350 | 226 | ok | ① 单文件变更卡片（+/− 行数、状态徽标、勾选）。② 对应 client 端变更列表卡片。③ 纯展示组件，移植最容易，注意 locale key 抽取。 |
| `packages/ui/src/hooks/useGitAutoRefresh.ts` | 6145 | 177 | ok | ① 自动刷新：`GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000`（useGitAutoRefresh.ts:15，应用在 :121）60s 轮询兜底 + 聚焦触发。② 对应 client 端刷新 hook。③ host 侧已有事件推送时仅作兜底路径。 |
| `packages/shared/src/channels.ts` | 59704 | 1343 | ok | ① IPC 通道名全集：`Git: "git"`（channels.ts:97）、`GitCheckpoint: "git-checkpoint"`（:99）、`FileWatcher: "file-watcher"`（:127）等。② 对应 dsh Typert 服务名/事件命名参考。③ 只作命名与契约形状参考，不整文件移植（含大量无关通道）。 |
| `LICENSE` | 11344 | 202 | ok | Apache-2.0 全文，Z.AI Co., Ltd（:190）。**移植其代码时此许可文本须随附。** |

## 2. openai/codex（安全参数参考，Rust）

- 默认分支：`main`；抓取版本：commit `7c11b8074dbdbab2a3afedf30df7c55f0c6907d8`（2026-10-28T15:10:52Z，"Include terminal launch commands in Guardian stdin reviews (#57758)"）
- 许可：**Apache-2.0**（`Copyright 2025 OpenAI` 在 LICENSE:189）
- `codex-rs/file-watcher` 存在（git/trees 核实），已整目录抓取 src（lib.rs + 测试）与 Cargo.toml；`codex-rs/app-server/src/fs_watch.rs` 存在，一并抓取。

| 本地文件（`docs/ported-sources/codex/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `codex-rs/git-utils/src/operations.rs` | 4985 | 171 | ok | ① 统一注入安全参数：`SAFE_BARE_REPOSITORY_CONFIG`（operations.rs:122）与 `core.hooksPath={DISABLED_HOOKS_PATH}`（:126）；`DISABLED_HOOKS_PATH` 定义（:10）：Windows 为 `"NUL"`、其余 `"/dev/null"`——与 prior-session 的 Windows 实测结论（`/dev/null` 归一化为 `nul`）互证。② 对应我们 GitRunner 的 SAFE_ARGS 常量设计。③ Rust 语法不可移植，抄参数清单与注入位置（每条命令统一前缀）。 |
| `codex-rs/git-utils/src/status.rs` | 2551 | 83 | ok | ① `status --porcelain`（status.rs:36）+ 并发去重读取。② 对应 status() 性能参考。③ 只读参考，逻辑简单，我们的 v2 解析以 ZCode 为准。 |
| `codex-rs/git-utils/src/fsmonitor.rs` | 5175 | 129 | ok | ① fsmonitor 策略：探测仓库 `core.fsmonitor` 配置（fsmonitor.rs:58），按结果用 `core.fsmonitor=false/true` 覆盖（:26-27），保留内置 daemon、禁用仓库级 helper，防止执行未知代码。② 对应 GitRunner 环境参数与风险章 8.5。③ 探测命令序列可直接翻译成 TS。 |
| `codex-rs/file-watcher/src/lib.rs` | 31618 | 932 | ok | ① notify crate 封装的通用 watch 服务。② 对应 watcher 设计参考。③ 我们走 dsh `ctx.fs.watch`，仅参考其 watch 过滤与生命周期。 |
| `codex-rs/file-watcher/src/file_watcher_tests.rs` | 23714 | 694 | ok | ① 上述 watch 服务的测试集。② 测试用例设计参考（事件去抖、关闭语义）。③ 语言不通，仅借鉴用例清单。 |
| `codex-rs/file-watcher/Cargo.toml` | 474 | 22 | ok | ① crate 清单。② 无直接用途。③ 仅作来源完整性记录。 |
| `codex-rs/app-server/src/fs_watch.rs` | 12801 | 377 | ok | ① JSON-RPC fs watch：`FS_CHANGED_NOTIFICATION_DEBOUNCE = Duration::from_millis(200)`（fs_watch.rs:27，`DebouncedWatchReceiver` :112）。② 对应 watcher 防抖取值参考。③ 200ms 与 ZCode 150ms 二选一即可，建议 150ms。 |
| `LICENSE` | 10926 | 201 | ok | Apache-2.0 全文，OpenAI（:189）。 |

## 3. sst/opencode（命令语义与性能参考）

- 默认分支：**`dev`**（不是 main，本会话经 API 确认）；抓取版本：commit `b6c43a524265496086fc0fdd83180bfa47d4d22e`（2026-10-28T15:17:47Z，"chore(deps): bump vite to 8.2.4 (#59830)"）
- 许可：**MIT**（LICENSE 1065 字节，与 API size 一致；`Copyright (c) 2025 opencode`）

| 本地文件（`docs/ported-sources/opencode/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `packages/core/src/git.ts` | 67211 | 1613 | ok | ① 只读 git 服务：仓库发现、`diff-files --name-only -z`（git.ts:553）/`ls-files -m -o` 快速路径（:555，:538 注释解释为何快）、numstat 双路拼补丁、patchBudget（:1023-1025）、索引自愈 `rebuildIndex`（:942，触发点 :915-919）、worktree 发现（:244）。② 对应 status/diff 的命令选择与性能边界教材。③ Effect-TS 范式不移植，只抄命令与参数语义；**行数 1613 与调研报告"约 1421/1423"不符——报告后文件有增长，见 deviations。** |
| `packages/core/src/plugin/vcs/git.ts` | 29763 | 825 | ok | ① 对外 VCS 抽象：`symbolic-ref --quiet --short HEAD`（vcs/git.ts:260）、默认分支发现 `symbolic-ref refs/remotes/<remote>/HEAD`（:287）、`merge-base --is-ancestor` 祖先判断（:313）、`merge-base ref HEAD`（:368）。② 对应分支/ahead-behind 与祖先判断参考。③ 同上，只学语义；**行数 825 与报告"752"不符，同因。** |
| `packages/core/src/util/git-executable.ts` | 1773 | 59 | ok | ① git 可执行文件定位：`which`（:4/:57），win32 直接 `path.resolve`（:40），darwin `/usr/bin/git` shim 规避（:6/:49-50）。② 对应 GitRunner 的 resolveGit 参考（dsh 侧 workspace-changes 已有更简实现）。③ Windows 发现策略可参考其顺序。 |
| `packages/core/src/vcs.ts` | 10327 | 262 | ok | ① VCS 接口契约与注册。② 对应我们服务接口切片设计。③ 仅类型形状参考。 |
| `packages/core/src/worktree/git.ts` | 1964 | 39 | ok | ① worktree Strategy 适配器（create/remove/list，list 在 :33，委托 `git.worktree.list`）；`worktree list --porcelain` 的解析本体在 `packages/core/src/git.ts` 服务内。② 对应需求 62（worktree 列表，v2）。③ 结构小，语义参考即可；porcelain 解析以 git.ts 为准。 |
| `LICENSE` | 1065 | 21 | ok | MIT 全文（API size 1065 核对一致）。 |

## 4. cline/cline（porcelain v1 解析参考）

- 默认分支：`main`；抓取版本：commit `f817e59f698f01487920c00ede2dbecad5c0fa50`（2026-10-28T00:34:58Z，"fix(hub): stop re-sending a rejected Cline refresh token on every cloud poll (#15369)"）
- 许可：**Apache-2.0**（`Copyright 2026 Cline Bot Inc.` 在 LICENSE:189）

| 本地文件（`docs/ported-sources/cline/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `apps/examples/desktop-app/sidecar/source-control.ts` | 19426 | 681 | ok | ① 刻意脱离 VS Code API 的独立 sidecar：文件头明示"提供 stage/unstage/discard 变更操作 + 后台 fetch；commit/push/pull 留给 agent"（source-control.ts:3-4）；`status --porcelain=v1 -z --branch --untracked-files=all` 解析（:99 注释 + :259 参数，含 "No commits yet" :120-121、重命名双行、staged/unstaged 分流），fetch 动作（:597/:623）。② 对应我们 status v1 先行实现（MVP 快速跑通），681 行与报告一致。③ 提交链路回 ZCode；Apache-2.0 署名同 ZCode 要求。 |
| `LICENSE` | 11344 | 201 | ok | Apache-2.0 全文，Cline Bot Inc.（:189）。 |

## 5. Aider-AI/aider（auto-commit 语义参考，Python）

- 默认分支：`main`；抓取版本：commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`（2026-05-22T14:02:20Z，"Merge pull request #5173 from Cyberfilo/feat/anthropic_models-list-add-opus-4-5"）
- 许可：**Apache-2.0**（根目录文件名是 **LICENSE.txt** 而非 LICENSE——本会话经 contents 根目录列表再次确认仅 `LICENSE.txt`（11358B）命中；注意其 LICENSE.txt 是未填署名的 Apache 模板，`Copyright [yyyy] [name of copyright owner]` 在 :190）

| 本地文件（`docs/ported-sources/aider/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `aider/repo.py` | 22954 | 622 | ok | ① auto-commit 语义：`commit()`（repo.py:131，`aider_edits` 参数区分 agent/用户提交，:140/:152）、署名策略（`attribute_author` :69/:84、`attribute_committer` :70/:85、`attribute_co_authored_by` :76）、dirty 检测与提交信息生成重试。② 对应需求 42（自动提交）与 18（署名 trailer）的语义教材。③ Python 不可移植，只学语义与时机；622 行与报告一致。 |
| `LICENSE.txt` | 11358 | 202 | ok | Apache-2.0 模板全文（版权行未填，:190）。 |

## 6. gitkraken/vscode-gitlens（Commit Graph 数据层参考）⚠️ 双许可

- 默认分支：`main`；抓取版本：commit `020cfc1b7daf29da1f0c6f916a550559b7a552b2`（2026-10-27T21:13:20Z，"Lists Azure DevOps pull requests in the Commit Graph sidebar"）
- 许可：**双许可结构**——仓库 spdx 为 `NOASSERTION`（本会话 API 确认）：
  - `LICENSE`（1466 字节，30 行）：**MIT**，开头明示"applies to all files in this repository, **except for those in or under any directory named "plus"**, which are covered by LICENSE.plus"（LICENSE:3-5），MIT 版权行 `Copyright (c) 2021-2026 Axosoft, LLC dba GitKraken`（:11）+ `Copyright (c) 2016-2021 Eric Amodio`（:12）。
  - `LICENSE.plus`（2448 字节，40 行）：**GitLens Pro License（专有）**——须 GitKraken EULA（:13）+ 有效订阅（:15/:22），"it is forbidden to copy, merge, publish, distribute, sublicense, and/or sell the Software"（:25 起）。
  - **边界：本库只抓取了 `packages/git/` 与 `packages/git-cli/`（MIT 区）；`packages/plus/` 下任何文件一律未抓、不得抓、不得移植。**

| 本地文件（`docs/ported-sources/vscode-gitlens/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `packages/git/src/models/graph.ts` | 23872 | 452 | ok | ① 图数据模型：`GitGraphRowKind`（graph.ts:8：commit/merge/stash/workdir）、`GitGraphRowHead`（:10，含 in/out-degree、incoming/outgoing、current 标记）、`GitGraphRow`（:150）、`GitGraph`（:176）、`GraphIncrementalSeed`（:297）、`IncrementalGraphOutcome`（:374）、`GraphReachabilityTable`（:141）。② 对应 F7 数据层行/头类型设计。③ MIT，署名 Axosoft/GitKraken；类型可参照收敛，注意它不含 lane 字段——lane 属渲染层。 |
| `packages/git/src/models/graphSession.ts` | 11984 | 230 | ok | ① 有状态图窗口：**SINGLE-WRITER** 契约——refresh/rebind/more 串行化、分页 superseded 拒绝语义（graphSession.ts:11-18 注释明示）。② 对应 F7 分页加载与会话内状态管理。③ MIT；并发/分页契约值得原样借鉴进我们的 store 设计。 |
| `packages/git/src/utils/graph.utils.ts` | 4039 | 107 | ok | ① 窗口行追加 reducer `appendRowsAtCursor`（graph.utils.ts:14）+ 头像前向合并（:38）+ 行 id 重钉（:63）。② 对应 F7 增量窗口维护。③ MIT；小而精，可对照写单测。 |
| `packages/git-cli/src/providers/graph.ts` | 107649 | 2561 | ok | ① 图数据构建主实现：`getGraph()`（graph.ts:377，limit 默认 5000、ordering `date/author-date/topo` :411 与 walk shape :344、parser :61/:418、增量 seed 快慢路径、**spurious-empty 守卫** :1822、**防御性 over-walk** :2487）。② 对应 F7 host 端 log() 的工程化参考（分页/增量/取消/错误降级）。③ MIT；**这是数据层最核心文件**，但 2561 行含大量 GitLens 基建耦合，建议只摘增量与分页模式，不整体移植。 |
| `LICENSE` | 1466 | 30 | ok | MIT（除 plus/ 外；例外条款 :3-5，版权行 :11-12）。 |
| `LICENSE.plus` | 2448 | 40 | ok | GitLens Pro License 专有文本（EULA :13、订阅 :15/:22、禁 copy/merge/publish :25）。**留作合规证据，禁止其约束下的任何复制。** |

**lane/swimmer 定位结论（本会话重新核实，重要）**：任务要求"在 MIT 区（packages/git 与 packages/git-cli）定位 lane/swimmer
泳道布局计算的具体文件"。经 `git/trees/main?recursive=1`（3458 项，`truncated=false`，无截断）全树检索 +
已抓文件 grep：**MIT 区不存在任何 lane/swimmer 命中**。全仓库含 lane/swimmer 的文件全部位于专有区：
`packages/plus/commit-graph/src/lanes/{collapse,colors,window}.ts`（25703/6528/19632 字节）与
`packages/plus/commit-graph-ui/src/gutter/{chainLane,chainLaneOverlay,laneSeed}.ts`、
`packages/plus/commit-graph-ui/src/extensions/laneCollapse*` 等——**按边界一律未抓取**。
GitLens MIT 区提供的是图数据层（行/头/增量机制），泳道分配必须自研（教材见 `notes/commit-graph-drawing-algorithms.md`）。

## 7. mhutchie/vscode-git-graph — ⛔ REFERENCE-ONLY，只能阅读参考

> ## ⛔⛔ 只能阅读参考，不得复制任何代码进我们的仓库 ⛔⛔
> 其 LICENSE 明文："Permission is NOT GRANTED to **publish, distribute, sublicense, and/or sell
> derivative works** of the Software."（实测在 LICENSE 第 9 行）——允许使用/修改/合并，但**禁止发布衍生作品**。
> 因此本仓库内不得出现该项目的任何代码片段（连同构衍生再发布也不许）。仅作算法阅读参考；
> 算法思想可自行实现（另见 pvigier 博客教材）。

- 默认分支：**`develop`**（不是 main，本会话经 API 确认）；抓取版本：commit `d7f43f429a9e024e896bac9fc65fdc530935c812`（2021-09-19T08:29:55Z，"#557 Improved context menu click event handling."，最后提交）
- 许可：**自定义（spdx NOASSERTION）**，1365 字节，如上引用。

| 本地文件（`docs/ported-sources/vscode-git-graph/`） | 字节 | 行数 | 检查 | 摘要 |
|---|---|---|---|---|
| `web/graph.ts` | 33883 | 913 | ok | ① Webview 图渲染：`Branch` 类（graph.ts:38）、`Vertex`（:165）、`Graph`（:337），SVG 顶点/连线/泳道布局与 tooltip。② 仅 F7 泳道渲染的**阅读参考**（vertex 复用、行内 lane 状态机思路）。③ ⛔ 不得复制任何代码；本文件留在本地仅佐证阅读过，SOURCES.md 与 THIRD_PARTY_NOTICES 中不得出现对其代码的引用式搬运。 |
| `LICENSE` | 1365 | 26 | ok | 自定义许可全文（禁再发布衍生作品条款在 :9）。 |

## 8. notes/（网页教材）

| 本地文件 | 来源 | 摘要 |
|---|---|---|
| `notes/commit-graph-drawing-algorithms.md` | https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html （mcp__tavily__tavily_extract 全文；本会话重抓全文比对一致；首次 429 限流，等 45s 重试成功） | ① 泳道布局算法教材：temporal topological sort（O(n log n + m)，保证拓扑序且确定性、committer date 异常安全）、active-branches 直线泳道分配（nil 占位防移位）、merge-children 禁止列 J(c) 引理与两种求法（列清单 274ms vs 区间树 482ms，React 仓库基准）、可视区渲染优化（只画可见行 + 区间树找可见边，106ms→0.580ms）。② 对应 F7 布局层（lane assignment 纯函数约 200–400 行 TS）与渲染层虚拟滚动。③ 文章可自由学习；**作者原型 gitamine 仓库是 GPL-3.0，其代码一行不得移植**；抓取时仅省略站点导航样板（文件头有注明）。 |

## 9. 汇总

- 抓取文件总数：**36**（zcode 10 / codex 8 / opencode 6 / cline 2 / aider 2 / vscode-gitlens 6 / vscode-git-graph 2）+ 笔记 1（notes/commit-graph-drawing-algorithms.md）。
- 完整性检查：36/36 通过（非空、字节数与 GitHub `git/trees` blob size 逐字节相等、无 HTML 错误页混入；3 个 grep 误报甄别记录见文首；检查方式见文首）。
- 未能抓取/不抓取清单：
  - GitLens `packages/plus/**`：专有，按边界**主动不抓**（非失败）。
  - Claude Code：未开源，无源码可抓（调研报告已核实）。
  - 无 404 失败遗留：本会话全部路径一次抓取成功；aider 按历史经验直接抓 `LICENSE.txt`（本轮已再核实根目录无 `LICENSE`）。
- 与调研报告/背景的偏差（详见 ReaderResult deviations）：opencode `git.ts` 实测 1613 行（报告 1421/1423）、`plugin/vcs/git.ts` 实测 825 行（报告 752）；mhutchie "NOT GRANTED" 条款实测在 LICENSE:9；**dsh 本地源码树实际为 `D:/DeepSeekHarness`（0.2.2-alpha.2，HEAD f3803c9697），背景所述 `D:/DeepSeekHarness/web/deepseek-harness`（0.2.1-rc.2）不存在**——本任务不依赖 dsh 源码，但后续阶段读者需知。
- 许可合规底线（汇总）：Apache-2.0（ZCode/Codex/Cline）与 MIT（opencode/GitLens MIT 区）可移植但**必须保留版权与许可声明**，仓库加 NOTICE/THIRD_PARTY_NOTICES；GitLens LICENSE.plus 与 mhutchie/vscode-git-graph **一行代码都不进仓库**；gitamine（GPL-3.0）同理；算法本身（泳道布局）按教材自行实现。
