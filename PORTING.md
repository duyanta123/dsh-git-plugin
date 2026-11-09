# PORTING.md — 移植登记（A/B/C 级义务）

> 工作流通用约定要求「本模块若移植/对照第三方代码，按 PORTING.md 的 A/B/C 级义务当场更新
> 登记与文件头」。本文件自 ⑤ status 引擎模块（2026-10-31）起建立；此前各模块的登记在
> `NOTICE.md` §2（两表互为镜像索引，行级内容一致，以先建立的 NOTICE §2 为历史权威）。
>
> 许可红线权威：`docs/ported-sources/SOURCES.md`；逐文件来源版本与字节校验记录在彼处。

## 1. 级别定义与义务

| 级 | 定义 | 义务 |
|---|---|---|
| **A** | **代码移植**：源码片段/函数/常量体进入本仓库（逐行或近似逐行） | 目标文件带 §3 移植文件头（来源 repo@commit + path + License + Modifications）+ 本表登记 + NOTICE.md §2 登记行 |
| **B** | **结构/清单移植**：参数清单、常量表、行为语义的翻译或仿真，无逐行代码（如 Rust→TS 参数表、行为仿真） | 本表登记 + 目标文件处就近注明来源（文件头或紧邻注释）；NOTICE.md §2 同步 |
| **C** | **语义学习/对照**：只读源码学语义与形状，零代码搬运 | 本表登记即可（防将来「顺手抄代码」无据可查）；NOTICE.md §2 可选 |

## 2. 登记表（随施工推进；新条目追加在「历史条目」之后）

### v2 批次四 体验集成模块（2026-11-10）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| C | `packages/host/src/admin-repo.ts`（非 git 目录 git init 引导引擎：[清单 8] initRepository） | 无第三方代码来源——`git init`（无 `-b` 旗标，初始分支尊重 init.defaultBranch 用户配置）/init 后 `rev-parse --show-toplevel` + `symbolic-ref --quiet --short HEAD` 回读语义按 git 官方文档 + 本机实测；编排骨架对照仓库内已登记 refs-admin.ts 纪律（先预检再变更后回读） | git 2.55.0.windows.2 实测 | —（无第三方材料入仓） | 自研实现，零代码搬运（docs/v2-implementation-plan.md §6.3/§6.5；文件头自述「解析器自研（零来源代码搬运——对照仅 refs-admin.ts 的编排骨架纪律）」之登记即本行——C 级登记以 git 文档语义对照为据，防将来「顺手抄 init 引导库代码」无据可查）。已是仓库/位于仓库内前置拒绝（init-failed reason='already-a-repository' 零命令）、stderr 脱敏进 message 面、失效链由服务面承担均为任务口径 |
| C | `packages/host/src/submodule.ts`（submodule 状态引擎：[清单 61] submoduleStatus，只列不递归） | 无第三方代码来源——`git submodule status` 行形 `<prefix><oid> <path>[ (<desc>)]` 与前缀语义（空格=clean / `-`=uninitialized / `+`=mismatch / `U`=冲突）按 git 官方文档 + 本机 git 2.55.0.windows.2 实测；默认形态 + `--cached` 双读按 path 归并；行解析器自研（缺前缀/oid/路径契约破坏要响） | git 2.55.0.windows.2 实测 | —（无第三方材料入仓） | 自研实现，零代码搬运（docs/v2-implementation-plan.md §6.3/§6.5；文件头自述「对照仅 `git submodule status` 文档行形与本机实测」之登记即本行）。`U` 前缀映射 'dirty'（wire 枚举无 conflict 档——方案枚举缺口的最贴近映射）、未知前缀 unknown 前向容忍、无 submodule 空数组不抛错均为任务口径 |
| C | `packages/host/src/pr.ts`（PR 引擎：[清单 46] generatePrDescription + createPr、[清单 69] prForBranch；D1=A 载体 = gh CLI） | 无第三方代码来源——`gh auth status` / `gh pr create --title <t> --body-file - [--base][--head][--draft]`（body 走 stdin 不进 argv）/ `gh pr view <branch> --json url,state` 命令形态按 gh CLI 官方文档语义；`rev-parse --abbrev-ref <branch>@{upstream}` head 推断按 git 官方文档；gh 非交互旗标行为未实测（方案 §6.10 如实登记为施工期验证点——真 gh 正路径不进自动门禁，pr.spec 假 transport 承载成功形状） | gh CLI 官方文档语义对照（正路径未实测） | —（无第三方材料入仓） | 自研实现，零代码搬运（docs/v2-implementation-plan.md §6.3/§6.5/§6.10）。守卫链（acknowledged danger 闸 → title 非空 → 分支参数首字符 `-` 拒绝——positioned arg 旗标注入防线，均零命令）、pr-tool-missing（未装/未登录同码）/pr-create-failed（stderr 过 sanitizeStderr）域码、prForBranch 查询失败/无关联/JSON 不可解析返回 null 静默降级、GhTransport 结构切片仅单测可达均为任务口径 |

（v2 批次四对既有已登记文件的续写改动——`message-gen.ts` 的 generatePrDescription 六步管线复用（M7 登记面内续写；[70] 合并策略约定段为任务口径）、`index.ts`/`types.ts`/`error-codes.ts` 的服务面/类型面/域码扩展、client 面空态引导与 PR/submodule/命令面板接线（`init-empty-state.ts`/`pr-face.ts`/`pr-view-model.ts`/`submodule-view-model.ts`/`commands-face.ts`/`GitPrDialog.tsx`/`GitSubmodulePanel.tsx`——均按方案 §6.6 与 dsh 基线积木自研，无第三方对照来源）与 `audit.ts` 写审计环缓冲（纯本仓自研，无对照来源）——均无登记义务。）

### v2 批次三 提交链路与护栏模块（2026-11-08）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| C | `packages/host/src/guard-scan.ts`（提交护栏扫描引擎：[清单 21]/[22] 密钥/.env/大文件/构建产物/CRLF 混行五类违规 + `redactedMatch` 脱敏） | 无第三方代码来源——密钥模式表（PEM 头/AKIA/ghp_/xox/AIza/sk-/authorization 头/.env 键值）按公开 token 格式词汇自研、零新依赖（docs/v2-implementation-plan.md §5.5/§5.10）；staged 内容读取面按 git `cat-file --batch-check`/`--batch` 官方文档语义 | git 2.55.0.windows.2 实测 | —（无第三方材料入仓） | 自研实现，零代码搬运（文件头 `guard-scan.ts:9` 自述「对照仅 C 级登记」之登记即本行——C 级登记以 git 文档语义对照为据，防将来「顺手抄扫描库代码」无据可查）。secret 类 D5=A 硬阻断不可豁免、redactedMatch 脱敏延伸 sanitizeStderr 纪律均为任务口径 |
| C | `packages/host/src/stash.ts`（stash push/list/pop/drop 引擎：[清单 14]） | 无第三方代码来源——命令形态与序号/冲突语义按 git 官方文档 + 本机实测（`GIT_LITERAL_PATHSPECS=1` 静默破坏 `-u` untracked 收集为环境实测发现，env 墓碑摘除）；`stash list` format 行解析自研 | git 2.55.0.windows.2 实测 | —（无第三方材料入仓） | 自研实现，零代码搬运（docs/v2-implementation-plan.md §5.3/§5.5；尾分隔纪律同仓库内 LOG_PRETTY_FORMAT 自研面；D4=B includeUntracked 缺省语义任务口径） |
| C | `packages/host/src/staging-patch.ts`（hunk/行级暂存引擎：[清单 10] stagePatch，D7=B 两态） | 无第三方代码来源——`git apply --cached --recount --whitespace=nowarn [-R]` 命令形态与二进制/模式 hunk 前置拒绝按 git 官方文档 + 本机实测自研 | git 2.55.0.windows.2 实测 | —（无第三方材料入仓） | 自研实现，零代码搬运（docs/v2-implementation-plan.md §5.3/§5.5；patch 文本 stdin 传入免临时文件） |
| C | `packages/host/src/diagnostics.ts`（仓库行尾/编码诊断引擎：[清单 56] repoDiagnostics） | 无第三方代码来源——`config --get core.autocrlf/core.eol` 两键 + 顶层文本后缀 CRLF 抽样按 docs/v2-implementation-plan.md §5.3 收窄口径（TEXT_SUFFIXES 表自研） | git 2.55.0.windows.2 实测 | —（无第三方材料入仓） | 自研实现，零代码搬运（node fs 抽样纪律同 blame.ts 已登记 node 面；mixedEolFiles 清单封顶承载口径类型注已记） |
| C | `packages/client-ui/src/client/diff/patch-select.ts`（行级勾选 → 选中 patch 组装纯函数） | 无第三方代码来源——从既有 `parsePatch` 产物（`diff/patch-hunks.ts` 移植面）裁剪组装自研 | —（git unified patch 文本口径，hunk-stage.spec 覆盖） | —（无第三方材料入仓） | 自研实现，零代码搬运（docs/v2-implementation-plan.md §5.6/§5.7；hunk 头计数重算/整 hunk 原样透传/纯 add/del 块插入点锚为方案口径；消费移植纯函数、本体无搬运） |

（v2 批次三对既有已登记文件的续写改动——`commit.ts` trailers/process 扩展（⑤ mutations/commit A 级行内续写）、client `GitCommitDialog.tsx`/`GitChangesTab.tsx`/`FileDiffView.tsx`/view-model 层的护栏结果面板与 stash 面板接线（④-K/F/B、C 级行内续写）、`locales.ts` 词典组——均为任务口径自研，无新增第三方对照来源，无登记义务。）

### v2 批次一 refs-admin 引擎模块（2026-11-08）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| C | `packages/host/src/refs-admin.ts`（分支/标签/remote/worktree 管理面的变更编排纪律：先存在性预检再执行变更、变更后失效） | zai-org/ZCode `packages/services/src/git/repo/gitCliRepo.ts`（分支/标签管理命令的编排骨架语义：存在性预检 → 执行变更 → 写后失效） | `3c5b2276` | Apache-2.0 | **语义学习，零代码搬运**（docs/v2-implementation-plan.md §3.5；文件头已注明）。与 ZCode 的关键差异：命令一律带 `--` 分隔符（本机 git 2.55.0.windows.2 实测 `git branch -- --all` ⇒ git 自身拒绝非法名——选项注入防线）；存在性预检走 `rev-parse --verify --quiet refs/...`（exit 1 = 缺失）并域码化（branch-exists / tag-exists / branch-not-found / tag-not-found，非 stderr 特征映射）；force 类动作（push `--force` / `-D` 删分支 / tag `-f` / worktree `--force`）双闸 = acknowledged 守卫最前、零命令执行；`git switch` 位置参数无 `--` 保护（实测 `switch -c -- <name> <from>` exit 128 "only one reference expected"），checkout 拆 `git branch --` + `git switch --` 两命令（非 `switch -C`）。**解析器全自研**：`git remote -v` 行解析与 `git worktree list --porcelain` 块解析按 git 文档 + 本机实测自研（unborn 全零 oid 归 null、locked reason 自由文本不进 wire、未知属性行前向容忍、块锚缺失/非 newline 结尾契约错要响），无任何来源代码搬运 |

（v2 批次一的 remote-ops.ts push 扩展（force/acknowledged/显式 remote 直查）、定时 fetch 编排（autoFetchIntervalMs + Cordis effect interval）与九个 `@Remote` 服务面接线为任务口径自研——沿用 M6 行已登记的 remote-ops 语义面内续写，无新增第三方对照来源，无登记义务。）

### ④-K 提交对话框模块（2026-11-01）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| C | `packages/client-ui/src/client/components/GitCommitDialog.tsx` + `src/client/commit-view-model.ts`（三动作启用闸 / 主快捷键语义 / AI 生成 pending 抑制与覆盖前确认的交互语义） | zai-org/ZCode `packages/ui/src/GitActionMenu.tsx`（提交对话框段：`COMMIT_DIALOG_ACTION_IDS = ['commit','commitAndPush','push']` :84、selectedAction 状态机上 Ctrl+Enter 触发选中动作 :363-377、`commitActionDisabled = actionPending ‖ !hasSelectedChanges ‖ (!hasIdentity && identity 已加载)` :227、生成/提交 pending 期间动作全禁用） | `3c5b2276` | Apache-2.0 | **语义对照，零代码搬运**（SOURCES.md:38 登记 scope「client 组件交互」）。与 ZCode 的关键差异（spec §3.1 + 任务口径）：动作集取 Commit / Commit & Push（链式）/ Cancel 三动作（无独立 push-only 与 selectedAction 状态机——Ctrl/Cmd+Enter 直指 `defaultAction`，菜单 提交…/提交并推送… 决定）；身份缺失从「禁用提交」改「身份告警条 + host 域错误兜底」（[清单 55] 的错误驱动展示）；amend 预填/改写已推送历史警示/skipHooks/unborn/diverged 条/staged 只读清单为 spec §3.1 字段全表自有。组件文件头已注明 |
| C | `packages/client-ui/src/client/commit-view-model.ts`（`CONVENTIONAL_HINT_RE` client 镜像与非阻断提示语义） | zai-org/ZCode `packages/services/src/git/gitCommitMessageGenerator.ts:20`（`CONVENTIONAL_COMMIT_RE`） | `3c5b2276` | Apache-2.0 | **语义学习，零代码搬运**：host commit.ts 守卫链第 3 步同语义正则的 client 侧重写（`type(scope)?!?: subject`，首行命中→行内警示不阻断，[清单 17]）；A 级逐字正则已归 host message-gen（M7 登记行）。porting 义务与 ⑤ mutations/commit 模块的 C 级行同源 |

（commit-dialog-face.ts 的 headCommit 折算、GitCommitDialog 的 portal 自建/焦点管理、ChangesTab 行级 Space/Enter/Delete、GraphTab ↑↓/Enter、`GIT_NAMESPACE_METHODS` 三方对账、M10 loader-composition 测试与 verify-load M11 扩展为按 spec §3.1/§3.2/§6 + 任务口径自写，无第三方对照来源，无登记义务。）

### F7 提交图全链模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/host/src/graph.ts`（log 分页取参段：`normalizeLogLimit`/`normalizeLogSkip` 钳制语义、`-n <limit+1>` 防御性 over-fetch ⇒ hasMore、unborn stderr 守卫族 ⇒ 空页不抛错） | zai-org/ZCode `packages/services/src/git/repo/gitCliRepo.ts`（getCommitGraph 分页段 :1013-1053 + normalizeGitGraphMaxCount/normalizeGitGraphSkip :386-400） | `3c5b2276` | Apache-2.0 | spec §1.8 登记行的落地。修改：分页入参换 spec §1.0.3 LogOptions（钳制上界换 Config.logMaxLimit、非有限数回落 Config.logDefaultLimit）；分隔符换 spec §1.8 的 %x1f/%x1e（ZCode %x00/%x1e），字段集按 CommitInfo（%aI/%cI 替代 %at、增 %ae/%b）；排序只留 --topo-order 单起点 HEAD（ZCode 另叠 --date-order 与 --branches/--tags/--remotes）；commandProvider → GitRunner 只读实例；错误改 RemoteError。文件头已落 |
| C | `packages/host/src/graph.ts`（refs 单次 for-each-ref 含 upstream:track、head 三态判定、RefInfo.upstreamTrack 形状；`getCommitDetail` 的 refs 过滤） | GitLens MIT 区 `packages/git/src/models/graph.ts`（GitGraphRowHead.isCurrentHead / upstream {missing, state:{ahead,behind}} 形状——「跟踪态随 refs 一次取回、按行装饰」的对照）+ `packages/git/src/models/graphSession.ts`（single-writer 分页契约 :11-18）+ `packages/git/src/utils/graph.utils.ts`（appendRowsAtCursor 窗口追加） | `020cfc1b` | **MIT 区**（LICENSE:3-5 除外条款） | **语义对照，零代码搬运**：upstreamTrack（`[gone]`/`[ahead N]`）与 head 三态按 GitLens 行头形状自写；single-writer 落在 client git-graph-store 的 loadMoreInFlight 闸；窗口追加简化为「纯 push + oid 去重」（分页窗口是 walk 的无重叠前缀，无需 cursor-trim——偏差记 openIssues）。head 解析的 `symbolic-ref --quiet --short HEAD` 语义另对照 opencode `plugin/vcs/git.ts:260`（MIT，`b6c43a52`）。providers/graph.ts（over-walk :2487 / spurious-empty :1822）未读取未移植——host log 为无状态分页，over-fetch 已由 ZCode A 级段承载（spec §5.1「只摘模式」行的实际落法，见 ModuleResult openIssues） |
| C | `packages/client-ui/src/client/graph/lane-layout.ts`（**自研声明行**：G1–G5 契约的泳道布局纯函数） | pvigier 博客教材 `docs/ported-sources/notes/commit-graph-drawing-algorithms.md`（temporal topological sort、active-branches 直线泳道、最小空闲位/nil 占位防移位、分支/合并子提交二分） | 网页教材（2019-05-06） | 文章可自由学习 | **算法思想自研实现，零代码搬运**：行序 = 拓扑输入直通（G2 前缀稳定）+ 非拓扑输入 temporal 修复（committedAt 降序、输入序 tiebreak——spec §3.3.1 重排语义的修复路径落地）；lane 分配 = 活跃 lane 表 + trunk 偏好取位 + 最小空闲位复用（禁止列 J(c) 未实现——次父边以「独立 travel lane 预约」语义达成同等的可连线性，多一次折返曲线换单遍 O(n)）。**mhutchie/vscode-git-graph、gitamine（GPL-3.0）零触碰零搬运**（本模块未读取 mhutchie 任何代码）；graphamine 教材外的泳道实现均为本模块原创 |

（graph-svg.tsx 行切片渲染、git-graph-store/graph-tab-store、git-graph-tab/commit-detail-panel、graph-view-model、词典 graph 键组为按 spec §3.3/§3.2/§4 与 workflow 任务口径自写，无第三方对照来源，无登记义务。既有文件改动清点见 §4 红线记录。）

### M7 message-gen 模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/host/src/message-gen.ts`（裁剪常量表 / `CONVENTIONAL_COMMIT_RE` / validate 剥壳链 / `clipText` / `buildDiffSummary` / prompt 行框架） | zai-org/ZCode `packages/services/src/git/gitCommitMessageGenerator.ts`（常量 :10-17 的 v1 子集——20 文件/8 diff/12k 总量/单文件 2k/消息 1k；会话上下文常量（12 条 4k/单条 600）与 `COMMIT_MESSAGE_QUERY_SOURCE` 不取；`CONVENTIONAL_COMMIT_RE` :20 逐字；`validateGeneratedGitCommitMessage` :239-255 与 `stripGeneratedCommitMessageDecorations` :337-349 逐段；`clipText` :330-335、`buildDiffSummary` :257-277、prompt 行框架 :192-222） | `3c5b2276` | Apache-2.0 | spec §1.7 登记行的落地。修改：判定产出从 discriminated union 改 flat 规则表（`empty/conventional/subject`）——「invalid 即抛错」改「conventional 标志不阻断」（spec §1.7/[清单 17]）；diff 摘要数据源 GitDiffResult → 本包 `DiffFile.patch`（null ⇒ '(diff unavailable)'，无 summary 回退层）；prompt 减会话上下文/语言段，Hard requirements 段移入 system prompt（任务口径「system prompt 单行 Conventional subject」）。文件头已落 |
| C | `packages/host/src/message-gen.ts`（六步执行范式：输入字节自检 → using deadline → prepareCall → GenerateOptions 组装 → 派发前观测记录 → BlockAssembler 流式组装 + finish 解释） | dsh `packages/session/session-title-llm/src/index.ts:236-291`（executeSessionTitleLlm） | dsh 树 `ce7073d512` | MIT（dsh） | **语义对照，零逐行搬运**：六步结构与「purpose 省略（封闭联合）」语义照范式；`deadline`/`TimeoutReason`/`BlockAssembler`/`createUserMessage` 为 dsh 基线积木（peer 依赖 `@deepseek-ai/dsh-llm`/`@deepseek-ai/dsh-timeout`@0.2.2-alpha.2，npm 发布物），非移植。本模块自研：域错误映射（git/llm-failed 三 stage / git/timeout / 调用方取消穿透）、路由解析链（Config → request/header 捕获 → git/llm-route-unresolved——spec §1.7 D10 口径，路由不在 prepareCall）、request/header 捕获监听（workspace.ts GitSessionEventHost 同机制） |

（`llmMaxInputBytes` 硬顶、`LLM_MAX_OUTPUT_TOKENS` 常量、nothing-staged 前置守卫（镜像 commit.ts 守卫 2）为 spec §1.7/任务口径自研，无第三方来源，无登记义务。）

### M6 remote-ops 引擎模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| C | `packages/host/src/remote-ops.ts`（push 编排 / remote 解析链 / upstream 短名拆分） | zai-org/ZCode `packages/services/src/git/repo/gitCliRepo.ts:1641-1672`（async push：tracking 判定 → remote 解析 → push → 成功后重读 status）+ `:674-702`（resolvePushRemote：branch.<name>.remote → remote.pushDefault → origin → 唯一 remote → 报错）+ `:499-503`（parseTrackingRemoteName：upstream 短名首段拆 remote） | `3c5b2276` | Apache-2.0 | **语义学习，零代码搬运**（SOURCES.md:33 登记 scope「对应 host 端 sync/remote-ops」）。与 ZCode 的关键差异（spec §1.5/§1.6 + 任务口径）：裸 `git push` 禁用，一律显式 remote + 全量 refspec（B3——本机实测 push.default=matching 下裸 push 一次推全部分支）；remote.pushDefault 段不在解析链（spec §1.5-1/任务口径未列）；上游三态判定（无上游/gone/正常）为本模块设计——经 StatusEngine fresh 快照（porcelain v2 `# branch.upstream` 在而 `# branch.ab` 缺 = gone，本机 git 2.55.0.windows.2 实测），gone 态严禁 rev-list；diverged 前置 rev-list 与 stderr 脱敏分类器（authentication/network/push-rejected/diverged 四类，`[remote rejected]` 形态为本机实测补充）为任务口径自研。文件头已注明 |

（`git/no-branch`、`git/dirty-worktree`、`git/choose-remote` 为 workflow 任务口径新增域码（spec §1.0.5 未列；spec §1.5-1/§1.6 同场景落 git/no-remote），无第三方来源，无登记义务。）

### ⑤ mutations/commit 引擎模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/host/src/commit.ts`（仓库发现段 `rev-parse --show-toplevel` 的 "exit 128 + not a git repository → 域码" probe） | dsh `packages/experimental/client-ui-forge/src/git.ts:99-103`（⑤ status.ts / ④-C diff.ts 已登记段在本文件的再应用：null 判定改抛 `git/no-repository` 域码） | dsh 树 `ce7073d512` | MIT（dsh） | 范式移植（locateGitWorkspace 本体按 map §4.1 禁用）。文件头已落 |
| C | `packages/host/src/mutations.ts`（stage/unstage/discard 的命令形态、入参去重、写后失效语义） | zai-org/ZCode `packages/services/src/git/repo/gitCliRepo.ts:1421-1486`（`add -- paths` / `restore --staged -- paths` / tracked `restore --worktree -- paths`）+ `packages/services/src/git/gitService.ts:242-253`（服务编排转发） | `3c5b2276` | Apache-2.0 | **语义学习，零代码搬运**（SOURCES.md:19-20 登记 scope「对应 host 端 mutations.ts」）。本模块自研/任务口径部分：字面路径（全局位 `--literal-pathspecs` + `--` 分隔 + GIT_LITERAL_PATHSPECS=1，ZCode 无）、空数组 `git/no-paths`（ZCode 是静默 no-op——任务口径拒绝整仓副作用）、unstage 的 unborn → `git rm --cached` 与极老 git → `git reset HEAD` 双兜底（spec §1.3【报告】:262）、暂存视图过滤的幂等跳过、discard 三重守卫（acknowledged / baseRevision 乐观并发 / 最新 status 逐路径路由；ZCode 无守卫且 discard 走 `--source=HEAD --staged --worktree` 双区形态——v1 任务口径是 worktree 单侧）。文件头已落 |
| C | `packages/host/src/commit.ts`（守卫链第 3 步的 Conventional Commits 非阻断警示正则语义） | zai-org/ZCode `packages/services/src/git/gitCommitMessageGenerator.ts:20`（`CONVENTIONAL_COMMIT_RE`） | `3c5b2276` | Apache-2.0 | **语义学习，零代码搬运**：按同语义自写 warn-only 正则（`type(scope)?!?: subject`）；A 级逐字移植归 message-gen 模块（spec §1.7 登记行）。commit 引擎其余（守卫链顺序、`-F -` stdin、hook 分类、回读）为 spec §1.4 + 任务口径自研——ZCode 的临时索引部分提交（stagedOnly）不属 v1（spec §0.3 无 hunk 级） |

（失效接线复用 status 引擎模块已登记的 StatusEngine/StatusWatcher；`git/no-paths`、`git/bad-request`、`git/hook-failed` 为 workflow 任务口径新增域码（spec §1.0.5 未列），无第三方来源，无登记义务。）

### M9 watcher/followStatus 模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/host/src/watcher.ts`（防抖结构） | zai-org/ZCode `packages/services/src/fileWatcher/fileWatcherService.ts`（`DEBOUNCE_MS = 150` :13 与「clearTimeout + setTimeout 防抖窗」:78-92；登记口径含引用计数启停语义，SOURCES.md:36） | `3c5b2276` | Apache-2.0 | 结构移植；node:fs.watch → 宿主 fs 能力面（GitFsWatchFace = ctx.fs.resolve/watch 结构切片，map §4.2）；防抖回调无路径可过滤（宿主 watch 语义）→ 去重职责移交 R2 内容比对；监听目标改三目标（.git/index、.git/HEAD、repoRoot depth:0）；R6 降级（warn 一次转纯轮询）与 R1–R5 帧规则为本模块设计。文件头已落 |
| B | `packages/host/tests/support.ts`（扩展：`chokidarFsFace`） | dsh `packages/fs/fs-local/src/index.ts:70-91`（LocalFileSystem.watch：目录目标 depth:0 无忽略 / 文件目标监父目录 ignored 放行根与目标 / 失效回调不带内容） | dsh 树 `ce7073d512` | MIT（dsh） | 行为仿真（B 级）：同形 chokidar@5 watch 面替身供 M9 集成测试（真实 fs 事件驱动，含「嵌套目录编辑不产生事件」的已知限制断言）；resolve 同为路径定型语义。文件头/就近注明已落 |
| C | `packages/host/src/watcher.ts`（失效+重算的 follow 范式对照） | dsh `packages/api/workspace-files/src/changes.ts:39-109`（follow() 生命周期：resolve→watch→ready→失效重取、AbortSignal.any、finally close） | dsh 树 `ce7073d512` | MIT（dsh） | **语义学习，零代码搬运**：watcher 挂宿主 ctx、每代际 close、降级显式化即从此范式对照而来；GitStatusFrame 流帧与引用计数实现为本模块设计 |

（stream 方法形状依据 dsh 树 workspace-files `changes` 实读与生成器 analyzer.ts:1467-1503 实读：返回类型直接写 `RemoteStream<Out, In>`、不可 Promise 包装——本机 build 实测验证。）

### ④-C diff 引擎模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/host/src/diff.ts`（repo 发现段 `resolveRepoRoot`） | dsh `packages/experimental/client-ui-forge/src/git.ts:99-103`（"exit 128 + not a git repository → null" 范式——⑤ status.ts 已登记段在本文件的再应用：null 判定改抛 `git/no-repository` 域码） | dsh 树 `ce7073d512` | MIT（dsh） | 范式移植（locateGitWorkspace 本体按 map §4.1 禁用）。文件头已落 |
| C | `packages/host/src/diff.ts`（listing 双路 + 预算环的编排语义） | opencode `packages/core/src/git.ts` diffGroup（name-status + numstat + patch 三路并发拼装、patchBudget 预算递减/截断清零） | `b6c43a52` | MIT | **语义学习，零代码搬运**（SOURCES.md:68 登记 scope「diff 的命令选择与性能边界」）：三路并发改两路 listing（numstat+name-status）+ 逐文件 patch；patchBudget 递减语义改写为「按序服务、耗尽即停、binary/oversized 零消耗」；Effect-TS/路径分组不移植。解析纯函数（parseNameStatus/analyzeUntrackedPatch）为本模块自研，record 形状以本机 git 2.55.0.windows.2 实测为准（见文件头实测修订 1-5） |

（numstat 解析复用 ⑤ 已登记的 status-parser.ts parseNumstat/numstatCounts，无新登记；untracked no-index 命令形态与 exit 1 白名单为 spec §1.2 权威口径，非第三方移植。）

### client 地基模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| C | `packages/client-ui/src/client/index.ts`（装配骨架：inject 清单、locale 注册、header utilities 注入形态、tab 定义注册、connection/reset 接线） | dsh `packages/client/ui-open-in-app/src/client/index.ts:125-132`（header utilities 注入范本）+ `packages/client/ui-deliverables/src/client/index.ts:57-88`（`ctx.sidebarRightTabs.register` + `ctx.effect`、inject 面 hooks 隔间、`ctx.on('connection/reset')` 缓存重置） | dsh 树 `ce7073d512` | MIT（dsh） | **语义学习，零代码搬运**：注册调用形态逐点对照（slot name/id/order/locale/inject 字段、两段注册第一段）；组件、词典、tab 定义、状态源为本模块按 spec §3.1 自写。id/order 取 spec §3.1 值（`dsh-plugin.git.header`/-10，非范本的 open-in-app/-5） |
| C | `packages/client-ui/src/client/store/git-status-source.ts`（范式 A 数据缓存 + generation/reset 语义） | dsh `packages/client/ui-deliverables/src/client/host-read-store.ts:30-81`（裸 createSnapshotStore + generation controller + reset 清缓存）+ `packages/client/ui-renderer/src/client/scoped-slots.tsx`（cachedSlotInject：inject 面 `hooks` 条目 → `useXxx` 选择器 hook 的合成语义） | dsh 树 `ce7073d512` | MIT（dsh） | **语义学习，零代码搬运**：数据缓存走范式 A（map §3.4）；代际丢帧/revision 丢帧/R5 上行/错误帧投影为本模块设计（④-D 流帧消费面）；hooks 合成语义实读后按其约定投 `hooks: { gitStatus: source.store }` |
| C | `packages/client-ui/src/client/remote/mount.ts`（$mount 形态与 TypertClientRemote 结构面） | dsh `packages/api/gateway/src/client/index.ts:210-222,254-311`（$mount/mountContribution/installNamespace——`git` 命名空间 service fiber 在 $mount 内创建，故 inject `remote.git` 死锁）+ `packages/typert/protocol/src/types.ts:620`（TypertClientRemote extends TypertRemoteNamespaceMap） | dsh 树 `ce7073d512` | MIT（dsh） | **语义学习，零代码搬运**：挂载机制与死锁结论的依据实读；适配器/ready 门/错误折叠（gateway/service-unavailable）为本模块设计 |

（host `package.json` 新增 `./errors` types-only 导出——导出本包自有的 error-codes.d.ts，非第三方移植无登记义务；client error-map 以 `Record<GitCode, …>` 消费该类型面做 Record 穷尽约束。）

### ⑤ status 引擎模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/host/src/status-parser.ts`（v2 终态解析器） | zai-org/ZCode `packages/services/src/git/repo/gitCliRepo.ts`（status 命令形态 :546-552、并发 numstat 双路 :871-892 的编排契约） | `3c5b2276` | Apache-2.0 | 命令形态与编排契约移植；**解析函数本体为自研**——ZCode 的 gitCliHelpers.ts（parseStatusPorcelain 所在）不在本地参考库（SOURCES.md 只抓取 gitCliRepo.ts），record 字节形状以本机 git 2.55.0.windows.2 实测为准（1/2/u/?/!/# 六种 record、XY 单 token 双字符、'.' 未变更位）。文件头已落（双来源署名） |
| A | `packages/host/src/status-parser.ts`（v1 回退段） | cline/cline `apps/examples/desktop-app/sidecar/source-control.ts:99-164` | `f817e59f` | Apache-2.0 | parsePorcelainV1 逐段移植（## 头正则、"No commits yet on"/"HEAD (no branch)"、重命名原路径吃下一 NUL 段、AA/DD/U* 判定）；修改：改产出统一 ParsedStatus 形状、[gone] 剥离为新增。文件头已落 |
| A | `packages/host/src/status-parser.ts`（numstat 段） | dsh `packages/deliverables/workspace-changes/src/numstat.ts:20-52` | dsh 树 `ce7073d512` | MIT（dsh） | parseNumstat/NumstatEntry 逐行移植（diff-tree → diff --numstat，输出契约一致）。文件头已落 |
| A | `packages/host/src/status.ts` | zai-org/ZCode `gitCliRepo.ts:857-892`（getStatus 编排：status + 并发 numstat 双路 + 成功断言）+ `:543-597`（in-flight 去重 reuseInFlightRequest 语义） | `3c5b2276` | Apache-2.0 | 编排移植；commandProvider → GitRunner 只读实例；缓存/三态为本模块设计（workflow 任务口径）；大仓库 untracked 折叠降级未采纳（见 openIssues）。文件头已落 |
| A | `packages/host/src/status.ts`（repo 发现段） | dsh `packages/experimental/client-ui-forge/src/git.ts:99-103`（"exit 128 + not a git repository → null" 范式） | dsh 树 `ce7073d512` | MIT（dsh） | 范式移植（locateGitWorkspace 本体按 map §4.1 禁用）。文件头已落 |
| A | `packages/host/src/git-runner.ts`（④-A 行的扩展：四实例 + 两套前缀 + op/timeout 域码 + stdin/maxBytes/env） | dsh `workspace-changes/src/git.ts:55-80` + `client-ui-forge/src/git.ts:58-72`（既有 A 级基底的扩展） | dsh 树 `ce7073d512` | MIT（dsh） | GitRunOptions 增 op/stdin/maxBytes/env（workspace-changes run() 同面）；超时 → git/timeout 域码；resolveExecutable null/抛错 → git/git-error op='resolve-git'。文件头已更新 |
| B | `packages/host/src/git-runner.ts`（SAFE_BARE_PREFIX） | openai/codex `codex-rs/git-utils/src/operations.rs:122`（run_git 统一前缀注入 safe.bareRepository）+ `fsmonitor.rs`（core.fsmonitor=false 的 Disabled 语义） | `7c11b807` | Apache-2.0 | Rust 参数清单与注入位置翻译成 TS 常量（SAFE_BARE_PREFIX 全实例共用；READ_ONLY_HARDENING 只读专属）。文件头已注明 |
| B | `packages/host/tests/support.ts`（扩展：stdout/stderr 溢出保尾仿真 + spawn 记录面） | dsh `packages/subprocess/subprocess-local/src/spawn.ts` 的溢出保尾行为语义 | dsh 树 `ce7073d512` | MIT（dsh） | 行为仿真（B 级）：lossy 时 readFrom 只留最后 maxBytes 字节（对齐 dsh「溢出保尾部」）；localSubprocess(record?) 记录 argv/cwd/env 供前缀断言。来源在文件头注注明 |
| C | `packages/host/src/types.ts`（FileChange/分组注释） | ZCode `gitCliRepo.ts` 的 GitStatusSnapshot 形状对照（stagedStats/unstagedStats 双 Map 语义） | `3c5b2276` | Apache-2.0 | 分组语义与 spec §1.0.3 对照；类型体为 spec 自有定义，无代码搬运 |
| C | v1 porcelain 触发条件（StatusEngine 回退判定 exit 129/128 + /porcelain/i） | cline `source-control.ts`（v1 命令形态）+ git usage 退出码语义 | `f817e59f` | Apache-2.0 | 判定条件为本模块设计，语义对照 |

### F 变更面板模块（2026-10-31）

| 级 | 本仓库目标文件 | 来源 | 来源版本 | 许可 | 移植内容与修改 |
|---|---|---|---|---|---|
| A | `packages/client-ui/src/client/diff/patch-hunks.ts` | dsh `packages/client/ui-deliverables/src/client/FileDiff.tsx`（:14 `MAX_RENDERED_LINES=5000`、:66-77 `hunkRows`、:86-109 `splitRows`、:116-125 `renderedHunks`、:165-167 `hunkHeader`） | dsh 树 `ce7073d512` | MIT（dsh） | 纯函数逐行移植（spec §5.1 登记行的落地）；修改：hunk 类型从宿主 `WorkspaceDiffHunk`（@deepseek-ai/dsh-workspace-changes/types）换成本包自有 `PatchHunk`（字段同形）——本插件 diff 过线形状是 unified patch 文本，由本模块自研 `parsePatch` 解析产出同形 hunk。文件头已落 |
| B | `packages/client-ui/src/client/components/ChangeCard.tsx` | zai-org/ZCode `packages/ui/src/GitPaneChangeCard.tsx`（行按钮=文件名区+右侧计数区、展开后懒加载 diff 区的卡片结构） | `3c5b2276` | Apache-2.0 | **结构对照，逻辑重写、视觉随 dsh**（本模块 ask §③；SOURCES.md:39）：不引入其 ContextMenu/Chevron/shadcn 类名体系，改 dsh-git-* 类名 + data-* 锚；交互面按 ask 扩展（状态字母徽标、binary/submodule 徽标、重命名 old→new、勾选 ⇄ stage/unstage、行内动作按组区分）。来源已在文件头就近注明 |
| C | `packages/client-ui/src/client/components/GitChangesTab.tsx` | ZCode `packages/ui/src/GitPane.tsx`（单展开位 + diff 懒加载 in-flight 去重 + 「展开行从变更集消失即收起」守卫的交互语义；revision 变化清 diff 缓存） | `3c5b2276` | Apache-2.0 | **语义学习，零代码搬运**：单展开/懒加载/消失守卫的交互语义对照；组件体为 spec §3.1/§3.2 自写（dsh keyed `sidebar.right.pane.tab` 范本，ui-deliverables ReviewTab 形态，client 地基模块已登记） |
| C | `packages/client-ui/src/client/components/FileDiffView.tsx` | dsh `ui-deliverables/src/client/FileDiff.tsx` 的渲染链结构（parse→renderedHunks 预算截断→逐行 token 高亮与展示序对齐回填、占位分支顺序） | dsh 树 `ce7073d512` | MIT（dsh） | **语义对照，零逐行搬运**（A 级条目只覆盖纯函数本体）：组件按本插件 `DiffFile`（patch 文本）输入与 dsh-git-* 类名自写；`useCodeHighlighter`+`languageForPath` 为 dsh 基线积木直接 import（基线 external，非移植） |
| C | `packages/client-ui/src/client/addresses.ts`（会话域地址铸造/严格解析） | dsh `ui-deliverables/src/changes.ts:143-165`（`changesReviewAddress`/`parseChangesReviewAddress`：前缀 + 段数 + 逐段校验 + decode 容错范式） | dsh 树 `ce7073d512` | MIT（dsh） | 范式移植（零逐行搬运）：单段 `{sessionId}` 坐标 + decode try/catch；本模块 ask §① 的会话域方案（`dsh-resource://git-changes/session/{id}`）取代 spec §3.1 字面静态地址（见 ModuleResult openIssues） |

（group-paths.ts / changes-view-model.ts / git-changes-store.ts / changes-tab-store.ts / GitConfirmDialog·GitErrorNotice 复用面为按 spec 自写，无第三方对照来源，无登记义务。）

### 历史条目（④-A 及以前）

见 `NOTICE.md` §2（git-runner 最小版、workspace.ts、vitest.config 装饰器预变换、
error-codes.ts 声明合并形态、tsdown.config.ts、typert-protocol 副本——级别与义务已在彼处履行）。

## 3. 移植文件头模板（A 级义务；spec §5.3 原文）

```ts
/*!
 * Ported from zai-org/ZCode@3c5b227649371507ddc4eb46ac5133afe6db1cab
 *   path: packages/services/src/git/repo/gitCliRepo.ts
 * License: Apache-2.0 — Copyright 2026 Z.AI Co., Ltd
 * Modifications: 2026-10-xx — child_process 换 dsh ctx.subprocess；错误类型改领域错误（RemoteError）
 * SPDX-License-Identifier: Apache-2.0
 */
```

（MIT 来源同构；多来源文件逐来源列 Ported from 块，License 行并列各版权。）

## 4. 红线重申（本模块执行记录）

### ④-K 提交对话框模块（2026-11-01）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（移植/对照源仅 ZCode GitActionMenu.tsx 提交对话框段与 gitCommitMessageGenerator.ts:20 正则语义，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。
- 既有文件改动 = `packages/client-ui/src/client/remote/mount.ts`（GitNamespaceFace/GitRpcFace 补齐 host REMOTE_METHODS 全量镜像 + GIT_NAMESPACE_METHODS 清单——spec §3.2 GitRpcClient 全量的落地）、`src/client/ui-model.ts`（菜单五动作：commit/commit-push 接通、sync 保持占位——[清单 48] 余项 push/pull/fetch 菜单动作随同步模块，openIssues）、`src/client/components/GitHeaderButton.tsx`（对话框拉起接线 + GitCommitDialog 渲染）、`src/client/components/GitChangesTab.tsx`（底部提交按钮解禁 + 对话框拉起 + 行级 Space/Enter/Delete）、`src/client/components/ChangeCard.tsx`（行 keydown 面 + aria-keyshortcuts）、`src/client/components/git-graph-tab.tsx`（列表 ↑↓/Enter + aria-keyshortcuts + scrollToIndex）、`src/client/index.ts`（commitDialogFace apply 顶层单例 + 两个拉起方 inject 接线）、`src/client/locales.ts`（commit.* 键组 + menu.commitPush，zh/en 对齐）、`packages/client-ui/tests/ui-model.spec.ts`（菜单断言随五动作更新）、`scripts/verify-load.mjs`（M11：夹具仓库改带种子提交 + status ready/分支字段断言 + 提交链路闭环 + J 段 bundle 断言；④-E 的 unborn 真宿主断言按 ask ④ 口径替换——unborn 形状仍由 host tests/status.spec [清单 64] 覆盖）。均为按 spec/任务口径自写，无第三方对照来源。
- **评审整改（2026-11-01，独立评审 medium 两项）**：
  - **danger 确认偏差补记录**：spec §3.4 的「1.5s 延迟可用」实际实现为**确认勾选闸**（`ui-model.confirmButtonEnabled` + `GitConfirmDialog` 的不可逆复选框，每次打开重置），原偏差无文档——已同步 spec §3.4 施工修订注记。不采用延迟计时器的理由：显式勾选对键盘/辅助技术用户语义更明确（无定时竞速），且承担「已知晓不可逆」的确认记录，闸强度不低于 1.5s 延迟。
  - **spec §3.4 错误动作接线**（原 set-upstream/fetch/pull 零消费方）：`components/GitCommitDialog.tsx` 两条 GitErrorNotice 接 `onAction`——`retry` = 重放失败步（identity 预检 / commit（保留原链意图）/ push 尾段，`lastFailureRef`）；`set-upstream` = `GitConfirmDialog` 确认后 `push({setUpstream:true})`（host no-upstream/gone 预检是唯一触发面——链式 push 对 missing-upstream 已按 [清单 26] 静默设上游，见 `pushOptionsOf`）；`fetch`/`pull` = `face.fetch({remote:null})`/`face.pull()`（diverged → host 预检/`pull-diverged` 说明文案兜底）。配套：`commit-view-model.ts`（`CommitPending` 扩 `'fetch'|'pull'`）、`commit-dialog-face.ts`（face 补 fetch/pull）、`locales.ts`（`confirm.setUpstreamTitle/Message` + `commit.fetching/pulling` 四键 zh/en）。header 菜单 push/pull/fetch 占位维持 openIssues（[清单 48] 余项随同步模块）；`GitChangesTab`/`git-graph-tab` 的错误面可达码不含 no-upstream/diverged，retry/reload 既有接线已完备。均为自写，无第三方对照来源。

### F7 提交图全链模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零代码搬运**——reading 口径勘误（2026-11-01 评审整改，统一 lane-layout.ts:8-9 自我声明 / SOURCES.md §7 / 本段三处记录）：research 期（SOURCES.md §7）曾抓取并**阅读过** `web/graph.ts`（33883 字节，仅作行内 lane 状态机思路对照，⛔ 不复制任何代码）；本模块 F7 施工未再读取其代码，产出（`graph/lane-layout.ts`）为按 pvigier 教材自研的实现。零代码搬运由机械比对实证（注释剥离后 8-gram shingle 交集 0/805；无 Vertex/Branch/determinePath 等任何专有标识符）。`packages/plus/**` 与 gitamine 则为全程未读取（读取面仅 ZCode gitCliRepo.ts 的 getCommitGraph/normalize 段、GitLens MIT 区 graph.ts 类型面 + graphSession.ts 契约面 + graph.utils.ts 全文、opencode vcs/git.ts symbolic-ref 段、pvigier 教材全文——均在已登记来源内）。
- 本模块读取的 GitLens 文件全部位于 MIT 区（`packages/git/src/models/graph.ts`、`packages/git/src/models/graphSession.ts`、`packages/git/src/utils/graph.utils.ts`——SOURCES.md:105-107 登记三文件）；`packages/git-cli/src/providers/graph.ts` 未读取（spec §5.1 的 over-walk/spurious-empty「只摘模式」行按 openIssues 记录的实际落法处理，见上表 C 级行）。
- 既有文件改动 = `packages/host/src/types.ts`（RefInfo.upstreamTrack + CommitDetail.refs——workflow 任务口径扩展，spec §1.0.3 未列）、`packages/host/src/index.ts`（Config logDefaultLimit/logMaxLimit + @Remote log/refs/getCommitDetail 接线 + REMOTE_METHODS + afterWrite 注释核实更新）、`packages/client-ui/src/client/remote/mount.ts`（GitNamespaceFace/GitRpcFace 扩 log/refs/getCommitDetail）、`packages/client-ui/src/client/locales.ts`（graph 键组 + menu.graph）、`packages/client-ui/src/client/ui-model.ts`（菜单四动作）、`packages/client-ui/src/client/components/GitHeaderButton.tsx`（openGraphPanel）、`packages/client-ui/src/client/index.ts`（graph store 接线 + 两 tab body 多贡献 generator 注册——spec §3.1 范本形态）、`packages/client-ui/tests/ui-model.spec.ts`（菜单断言随四动作更新）、`packages/client-ui/tests/changes-store.spec.ts` 与 `tests/git-status-source.spec.ts`（FakeRpc 补 log/refs/getCommitDetail 三 no-op——F 变更面板模块同款适配）、`packages/client-ui/package.json` + pnpm-lock.yaml（devDependencies 增 `@tanstack/react-virtual@3.14.10`——dsh 基线 PLATFORM_MODULES 版本对齐，map §3.7）、`packages/host/tests/watcher.spec.ts`（m9it 预算 20s→60s）与 `packages/host/tests/message-gen.spec.ts`（一处 vi.waitFor 补显式 15s 超时）——两处为本模块三个真 git spec 加量后的重负载资源裕量处置（全量门禁各实测 1 次顶穿、单文件跑恒绿；M6 remote-ops 模块同款先例），纯上限放宽零断言改动。均为按 spec/任务口径自写，无第三方对照来源。

### M7 message-gen 模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（移植/对照源仅 ZCode gitCommitMessageGenerator.ts 与 dsh session-title-llm 范式，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。
- 既有文件改动 = `packages/host/src/index.ts`（Config 四字段 + @Remote generateCommitMessage 接线 + readLlmFace 切片 + REMOTE_METHODS）、`packages/host/package.json`（peer/dev 增 `@deepseek-ai/dsh-llm`/`@deepseek-ai/dsh-timeout`@0.2.2-alpha.2——npm 发布物，运行时由宿主 profile node_modules 提供）、`NOTICE.md` §2 message-gen 行状态更新（均为按 spec/任务口径自写，无第三方对照来源）。

### M6 remote-ops 引擎模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（对照源仅 ZCode push/resolvePushRemote/parseTrackingRemoteName 语义，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。
- 既有文件改动 = `packages/host/src/error-codes.ts`（任务口径三域码注册）、`packages/host/src/index.ts`（@Remote push/pull/fetch 接线）、`packages/host/tests/commit.spec.ts`（**既有 flake 修正**：「amend --no-edit 保留原消息」用例断言 `oid ≠ originalOid`，但 --no-edit 未改任何内容时同一秒内的 amend 产出同一提交对象（tree/parents/author/committer 时间戳全同，git 按内容寻址去重）——stash 本模块改动后 HEAD 上 3/3 复现，与本模块无关的既有时序断言；修正 = 移除该断言，用例意图（消息保留回读 + world 重读 %B）不动，oid 变化路径由「amend 改消息」用例覆盖）、**host 集成 spec 超时裕量**（`git-runner`/`mutations`/`commit`/`status`/`diff`/`watcher`/`sync` 七个 spec 的 testTimeout/hookTimeout 统一 60s——纯上限放宽零断言改动；实测重负载轮次（同机并行施工的外部负载）把既有 30s/20s/10s-hook 用例顶到超时，7 轮门禁 3 轮复现且失败全为资源类；`vitest.config.ts` 仅加注释，maxWorkers 维持 6——4 worker 对照轮未见收益）、client 面 `error-map.ts`/`locales.ts` 及 `tests/error-map.spec.ts` 的码表镜像（wire 形状随 host 新端点对齐，均为按 spec/任务口径自写，无第三方对照来源）。

### M9 watcher/followStatus 模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（移植/对照源仅 ZCode fileWatcherService 结构、dsh fs-local watch 语义与 workspace-files follow 范式，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。

### ④-C diff 引擎模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（移植/对照源仅 dsh forge 范式与 opencode diffGroup 语义，均在本地参考库/已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。

### ⑤ status 引擎模块（2026-10-31）

（登记表见 §2；红线记录补记如下。）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：零触碰（对照源仅 ZCode status/编排段、cline v1 解析器、dsh numstat/forge 范式与 codex 参数表，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。

### client 地基模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（对照源仅 dsh 树 client 包的注册/store/挂载语义，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。
- 本模块全部 client 源码为按 spec 自写；`packages/host/tests/diff.spec.ts` 唯一改动 = `vi.setConfig({ testTimeout: 15_000 })`（并行负载下的资源裕量，断言面零改动，非移植）。

### F 变更面板模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（移植/对照源仅 dsh ui-deliverables FileDiff 纯函数与渲染链、ZCode GitPaneChangeCard 结构与 GitPane 交互语义、dsh changes.ts 地址范式，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。
- 既有测试文件唯一改动 = `packages/client-ui/tests/git-status-source.spec.ts` 的 FakeRpc 补四个 no-op 方法（本模块把 GitRpcFace 扩到 diff/stage/unstage/discard 后 `implements GitRpcFace` 的类型适配；断言面零改动）。
- `scripts/verify-load.mjs` 断言更新：变更面板地址断言从 spec §3.1 字面静态地址改为本模块 ask §① 的会话域前缀（`dsh-resource://git-changes/session/`），并新增 F 模块产物断言（tab body key / data 锚 / ui-primitives require / changes·diff 词典）——门禁脚本随实现口径更新，非移植。

### ⑤ mutations/commit 引擎模块（2026-10-31）

- mhutchie/vscode-git-graph、GitLens `packages/plus/**`、gitamine（GPL-3.0）：**零触碰**——本模块未读取其任何代码（对照源仅 ZCode gitCliRepo 写命令段 / gitService 编排段 / gitCommitMessageGenerator 的 CONVENTIONAL_COMMIT_RE 语义、dsh forge 仓库发现范式，均在已登记来源内）。
- GitLens MIT 区四文件：本模块未涉及（属 F7 提交图模块）。
- 既有文件改动 = `types.ts`（DiscardOptions / CommitResult.message 扩展）、`error-codes.ts`（任务口径三域码注册）、`status.ts`（current() fresh 扫描选项）、`index.ts`（@Remote 写操作接线）、client 面 `mount.ts`/`git-changes-store.ts`/`error-map.ts`/`locales.ts` 及其两份测试镜像（wire 形状随 host 新端点对齐，均为按 spec/任务口径自写，无第三方对照来源）。
