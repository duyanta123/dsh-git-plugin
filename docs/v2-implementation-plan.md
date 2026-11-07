# dsh-git-plugin V2 分期实施方案

> 日期：2026-11-07。状态：**方案定稿（2026-11-08 用户拍板 §8 全表 + 两项评审遗留，待确认后施工）**。
> 输入权威：`docs/feature-checklist.md:106` 的 v2 分期行 24 项（8,10,14,18,21,22,23,27,30,34,35,36,37,38,46,51,56,57,58,60,61,62,63,66）**+ 2026-11-08 D8 拍板新增 3 项（68,69,70，清单已扩）= 27 项**、`README.md` §5 已知限制（`README.md:184-201`）、`CLAUDE.md` 架构契约（全文）。2026-11-07 审查结论已并入并逐条对代码核实（核实记录见附录 A）。
> 读者约定：本文件 self-contained——未见过方案产生过程的读者可只凭本文 + 文内 `file:line` 引用执行施工。v1 现状以 git log `298019b`（spec v1.3 回填）与 `7b1f748`（v0.1.2 修复批）之后的 main 树为准。

---

## 0. 现状基线（v1 交付面，v2 施工的出发点）

### 0.1 RPC 面

- host 服务 `GitService extends TypertRemoteService`：类声明与 `static inject = ['subprocess']` 在 `packages/host/src/index.ts:157-158`；serviceKey 字面量在 `super(ctx, 'git')`（`index.ts:194`，typert-generator 契约）与 `SERVICE_KEY` 常量（`index.ts:92`）；fs/llm 走可选结构切片。
- **16 个 `@Remote` 方法**，权威清单 = `REMOTE_METHODS`（`packages/host/src/index.ts:151`）：`ping / identity / status / diff / followStatus / stage / unstage / discard / commit / push / pull / fetch / generateCommitMessage / log / refs / getCommitDetail`。
- **21 个域错误码**（2026-11-07 实跑 `grep -c "^\s*'git/" packages/host/src/error-codes.ts` = 21），权威 = `RemoteErrorDetailsMap` 的 `git/*` 子集（`packages/host/src/error-codes.ts:41-69`；capability-spec §1.0.5 已同日回填 21——`docs/capability-spec.md:14` 修订记录明记「实数 spec 侧原 14、实现侧 21，两侧各差 1，以键集为准」）：`no-repository / identity-missing / nothing-staged / empty-message / no-upstream / no-remote / diverged / push-rejected / auth-failed / pull-diverged / timeout / git-error / llm-route-unresolved / llm-failed / session-workspace-unresolved / no-paths / bad-request / hook-failed / no-branch / dirty-worktree / choose-remote`（其中 `bad-request.details.reason` 是封闭联合 `'unacknowledged' | 'stale-base-revision' | 'not-discardable'`，`error-codes.ts:57-65`）。
- wire 类型权威 = `packages/host/src/types.ts`（只允许 null/string/bool/有限 number/plain object/array 过线；strict codec 丢弃未声明字段——`CLAUDE.md:95`、`types.ts:7-10` 头注）。

### 0.2 client 面

- 挂载链：`import gitRemote from 'dsh-gitkit/remote'`（typert 生成物，禁手编）→ `mountGitRemote`（`packages/client-ui/src/client/remote/mount.ts:136-138`）→ `createGitRpcClient`（`mount.ts:146-271`，载波 reject 折叠为 `gateway/service-unavailable`，`mount.ts:130`）。
- **三份方法清单必须恒等**（`CLAUDE.md:59`）：host `REMOTE_METHODS` ⇄ 生成描述符 `methods` 键 ⇄ client `GIT_NAMESPACE_METHODS`（`mount.ts:102-107`）/ `GitNamespaceFace`（`mount.ts:75-95`）/ `GitRpcFace`（`mount.ts:110-127`）。对账测试 = `packages/client-ui/tests/loader-composition.spec.ts:47-75`。
- 错误投影：`ERROR_MAP: Record<GitCode, ErrorMapEntry>` Record 穷尽约束（host 增删码即编译错，`packages/client-ui/src/client/error-map.ts:54-113`）；词典 = `packages/client-ui/src/client/locales.ts`（`gitZh` 为键权威，zh/en 双键 + `{placeholder}` 双语强制，`CLAUDE.md:97`）。
- tab 落点：右栏两个 keyed tab（changes `keepMounted:false`、graph `keepMounted:true`，`packages/client-ui/src/client/index.ts:111-160`）；header 入口 @ `conversation.session.header.utilities`（order -10）；header 菜单模型 `headerMenuItems`（`packages/client-ui/src/client/ui-model.ts:99-107`，其中 `sync` 行 `placeholder:true` 是 v1 遗留占位）。
- 确认框架：`GitConfirmDialog` 的 danger 勾选闸（`packages/client-ui/src/client/components/GitConfirmDialog.tsx:93-97` + 纯逻辑 `confirmButtonEnabled` `ui-model.ts:114`）。

### 0.3 可复用件（审查结论，已逐条核实）

| 复用件 | 位置 | v2 去向 |
|---|---|---|
| discard 三重守卫（acknowledged + baseRevision 乐观并发 + 逐路径路由） | `types.ts:223-227`、`packages/host/src/mutations.ts:153-164` | 一切「确认 + 并发基线」写操作的范式：批次二 reset/cherryPick/revert、批次三 stashDrop、批次四 createPr |
| GitConfirmDialog danger 勾选闸 | `GitConfirmDialog.tsx:5-16,93-97`、`ui-model.ts:114` | force push（批次一）、reset --hard（批次二）、stash drop / 护栏豁免（批次三）、PR 创建确认（批次四） |
| `parseForEachRef` 已含 annotated tag peeled | `packages/host/src/graph.ts:150-183` | 批次一 tag 管理的数据面零新增（`refs()` 已列 tag，`RefInfo.type 'tag'`） |
| `revListCounts`（`rev-list --left-right --count`） | `packages/host/src/remote-ops.ts:388-403` | 批次二分支对比：提共享后供 `compareBranches` 双向计数 |
| `LOG_PRETTY_FORMAT` + 分页钳制 `normalizeLogLimit/normalizeLogSkip` | `graph.ts:66,88-97` | 批次二历史搜索 / 单文件历史直接复用（过滤参数只是 log 命令的附加参数，解析与钳制不变） |
| `CommitResult.message` 回读纪律（不信入参） | `types.ts:242-248` | 批次三 trailers 组装后同样回读展示 |
| stderr 单一分类器 `STDERR_PATTERNS` / `sanitizeStderr` | `error-codes.ts:86-126` | 新网络面（gh CLI，批次四）沿用脱敏纪律 |

### 0.4 平台硬约束（不可绕过，v2 全局有效）

1. **无事件通道**：dsh 事件转发 allowlist 静态收口且无 `git/*`（`docs/capability-spec.md:631`，§2.1）→ 审计日志（[66]）只能是 host logger + RPC 查询（环缓冲），不得设计推送。
2. **`shell.overlay` v1 未注册**（`docs/capability-spec.md:720`）；注册范例存在（`docs/host-capability-map.md:206`，ui-chat QuotaNoticeHost）但命令面板机制在 v1 前置核实清单中仍未定位（`capability-spec.md:94`，§0.4-7）→ [51] 带降级预案施工（批次四）。
3. **PR 创建零地基**：本机 gh CLI 已认证可用（`docs/feature-checklist.md:97`），client 直连平台 API 无凭证/CORS 面 → [46] 载体**已拍板 = gh CLI**（§8 D1=A，2026-11-08），批次四按此施工。
4. **单 session 单仓库是 v1 口径**（`capability-spec.md:74`，§0.2-3；[7] 不在 v2 分期行）：**本方案不引入多仓库改造，方法签名一律不追加 `repoId`**。
5. **client 单文件 bundle 协议**：新 npm 依赖要么进 `scripts/build-client.mjs` 的 `EXTERNALS`（`scripts/build-client.mjs:32-44`，现含 react/cordis/zod/@tanstack/react-virtual/dsh-client-* 基线）要么打进 bundle——**v2 计划零新增 client 运行期依赖**，全部解析器（blame/stash/scan/worktree）自研；若施工中确需新依赖，先走 §8 决策点。
6. **嵌套目录 fs watch depth:0 硬限制**（`README.md:184-189`）：嵌套文件编辑只有 R4 轮询（默认 60s，`pollIntervalMs`）能捕获。v2 新写操作（stash/branch/tag/时间旅行）落 `.git` 内部 → `.git/index`/`.git/HEAD` watch 覆盖，准实时；worktree/submodule 列表是按需查询，无刷新诉求。
7. **typert 产物禁手编**（`CLAUDE.md:55`）；`pnpm run typecheck` 先跑 `build:host` 就是为生成描述符（`CLAUDE.md:36`）。
8. **移植合规**：新增移植文件必须登记 `NOTICE.md` §2 / `PORTING.md`（A 级带文件头），禁源（GitLens plus、mhutchie、gitamine）零进入；`tests/licenses.spec.ts` 守卫（`CLAUDE.md:100`）。v2 全部算法自研（对照仅 C 级登记），预期零 A 级新增。
9. **测试范式**：host 测试建真临时 git 仓库 + world 重读断言（`packages/host/tests/support.ts` 提供 `scratchRepo`/`git`/真 spawn face，`CLAUDE.md:106`）；client 测试用假 RPC face + 纯函数视图模型断言。

---

## 1. 新增 `@Remote` 的强制变更链（每批施工 SOP）

每加一个方法/域码，以下链条逐项走完，缺一步 = 批次门禁不过：

1. **wire 类型先行**：`packages/host/src/types.ts` 扩展入参/出参类型（可选字段省略传递，不传显式 `undefined`）。
2. **host 方法**：`GitService` 加 `@Remote` 方法 + `REMOTE_METHODS` 数组同步一行（`index.ts:151`）。
3. **typert 生成**：`pnpm run build:host` 重新生成 `lib/typert.host.js` / `lib/typert.remote-client.js`（禁手编）。
4. **client 面四处同步**（同文件 `mount.ts`）：`GitNamespaceFace` + `GitRpcFace` + `GIT_NAMESPACE_METHODS`（`mount.ts:75-127`）**+ `createGitRpcClient` 的逐方法包装块与类型 import 块**（`mount.ts:146-271` 现为 16 个手写包装块；`mount.ts:35-40` import 面）——漏改兜底 = `loader-composition.spec.ts:60-69` 函数键对账与编译期报错，但属应主动同步项而非可依赖兜底。
5. **三方对账**：`loader-composition.spec.ts:47-75` 三层键集两两相等，自动抓漏行/幽灵面。
6. **域码四件套**（若新增码）：`error-codes.ts` 的 `RemoteErrorDetailsMap` 行（类型化 details）→ `error-map.ts` 的 `ERROR_MAP` 行（Record 穷尽，漏行编译错）→ `locales.ts` 的 `error.*` zh/en 双键 → `error-map.spec` / `locales.spec` 断言。
7. **文档同步**：`docs/capability-spec.md` §1.9 方法总表（`:600`）/ §1.0.5 错误码 / §3.1 组件表 / §4 locale 组各加行；README §1 功能清单补对应能力行。
8. **批次收口**：§4-§7 各批「门禁口径」节的命令全绿。

---

## 2. 批次总览与顺序理由

| 批次 | 主题 | 清单条目 | 新增方法 | 新增域码 | 主要落点 |
|---|---|---|---|---|---|
| **一** | 分支 · 标签 · 远端 · 同步管理面 | 23, 27, 30, 57, 58, 62, 68（7 项） | 9 | 6（+`bad-request` reason 联合扩展） | header 菜单 / 推送对话框 / worktree 对话框 / 图 tab chips |
| **二** | 历史面 | 34, 35, 36, 37, 38, 60（6 项） | 6 | 4 | 图 tab（搜索/对比/WIP/行菜单）/ diff 区 blame 模式（-L 分片） |
| **三** | 提交链路与护栏 | 10, 14, 18, 21, 22, 56, 63（7 项） | 7 | 3 | ChangesTab hunk 勾选（双侧）/ stash 面板 / GitCommitDialog 三块扩展 |
| **四** | 体验集成与收尾 | 8, 46, 51, 61, 66, 69, 70（7 项） | 6 | 3 | 空态引导 / PR 对话框（含 [69] 关联展示）/ 命令面板 spike / P3 清理 / 发布 |

> 2026-11-08 拍板增量：D8 纳入三项 → [68] per-ticket worktree 归批次一（与 [62] worktree 域同引擎，含写方法）、[69] PR↔分支名关联归批次四（随 [46] PR）、[70] 合并策略放 prompt 归批次四（`generatePrDescription` 的 prompt 约定段，零方法零码）。合计 **28 方法 / 15 域码**（§7-5 计数已同步）。

**划分对审查建议（管理面 / 历史面 / 护栏 / 体验集成）的调整说明**：
- 「护栏」并入提交链路成**批次三「提交链路与护栏」**：清单 18/21/22/63/56 全部长在提交对话框与 commit 引擎上，[10]（hunk/行级 stage）与 [14]（stash）是同一条「提交前整理工作区」链路的组成件——拆开会造成两批同时改 `GitCommitDialog`/`GitChangesTab`，回归面重叠。
- [61]（submodule 展示）与 [62]（worktree 列表）分开归批：[62] 归批次一（refs/仓库形态的管理面查询，与分支标签同引擎）；[61] 归批次四（纯展示增强，不阻塞任何人）。
- [14] stash 归批次三而非管理面：stash 的消费场景是「提交前临时挂起」与「分支切换脏区交接」，其 UI（stash 列表）长在 ChangesTab——批次三正在改 ChangesTab。

**顺序理由**（一 → 二 → 三 → 四）：
1. **批次一先行**：纯增量方法 + wire 最小扩展（`PushOptions` 加可选字段），不触碰既有语义；顺手清 v1 两笔可见债（header `sync` 占位转真 = [58]、`REMOTE_METHODS` 对账链在最小变更上热身）；`bad-request` reason 联合扩展在本批定型，二/三/四批直接复用。
2. **批次二次之**：历史面 6 项中 4 项（blame/搜索/对比/单文件历史）是只读，爆炸半径最小；[37]（cherry-pick/revert/reset）虽是写操作但完全复用 v1 discard 三重守卫范式，无前置。需要批次一的分支选择器作为对比入口载体、`bad-request` 扩展 reason。
3. **批次三靠后于二**：提交链路是最高频路径，`CommitOptions`/`CommitResult` wire 扩展一次落齐（trailer + hook 输出），放在读平面稳定之后，回归隔离更好。若用户优先担心密钥泄漏（[22]），可把批次三提前到批次二之前——顺序可换，批次内部结构不变（登记为可选重排，见 §8 D9）。
4. **批次四收尾**：审计日志（[66]）必须最后做才能一批覆盖前三批全部新增写方法；PR（[46]）依赖决策点 D1 与护栏就位；命令面板（[51]）依赖 spike 结论；P3 清理与本批同车避免踩前批功能面。

---

## 3. 批次一：分支 · 标签 · 远端 · 同步管理面（[23][27][30][57][58][62]）

### 3.1 范围拆解

| 清单号 | 内容 | v2 交付形态 |
|---|---|---|
| 23 | 分支列表、新建、切换、删除 | 列表复用 `refs()`（`RefInfo.type 'local-branch'` + `upstreamTrack`，`types.ts:162-181`）；新建/切换/删除 = 新方法 |
| 27 | force push（强保护，必须确认） | `PushOptions` 扩 `force` + host acknowledged 守卫 + UI danger 勾选闸（双闸） |
| 30 | tag 标签管理 | 列表复用 `refs()`（`parseForEachRef` 已解 peeled，`graph.ts:150-175`）；建/删 = 新方法 |
| 57 | 多 remote 管理：remote 列表与 push 目标选择 | `remoteList()` + 推送对话框 remote picker（`git/choose-remote` 错误已有，本批给 UI 对应物） |
| 58 | 手动/定时 fetch 与 behind 刷新 | header `sync` 占位（`ui-model.ts:105`）转真（推送/拉取/获取三行）；fetch 成功 → R5 刷新 behind；定时 fetch **已拍板默认开启**（D6=B：Config `autoFetchIntervalMs` 默认 300_000，0=关） |
| 62 | worktree 列表展示（只读） | `worktreeList()` 解析 `git worktree list --porcelain`，header 菜单 worktree 管理对话框（列表区） |
| 68 | per-ticket git worktree（D8 纳入） | `worktreeAdd()`/`worktreeRemove()`（写）+ 上行只读列表同对话框（新建区/移除入口）；per-ticket 语义 = 按任务在独立 worktree 建分支工作 |

### 3.2 wire 类型扩展（`packages/host/src/types.ts`）

- **`PushOptions` 扩展**（现仅 `setUpstream`，`types.ts:250-253`）：
  `PushOptions { setUpstream: boolean; force?: boolean; acknowledged?: boolean; remote?: string | null }`
  —— host 守卫：`force === true && acknowledged !== true` ⇒ `git/bad-request`（reason `'force-unacknowledged'`）；`force=true` 时跳过 `git/diverged` 预检（语义即覆盖远端），仍保留 upstream 存在性预检。
- 新类型（概要，命名以施工时 `types.ts` 实际为准；**每个新方法的出入参在此一次定形**，不留施工期临时发明）：
  `BranchCreateOptions { name: string; from?: string | null; checkout?: boolean }`、`BranchCreateResult { name: string; oid: string | null; checkedOut: boolean }`、`BranchSwitchResult { from: string | null; to: string }`、`BranchDeleteOptions { name: string; force?: boolean; acknowledged?: boolean }`、`BranchDeleteResult { deleted: string; wasMerged: boolean }`、`TagCreateOptions { name: string; oid?: string | null; message?: string | null; force?: boolean; acknowledged?: boolean }`、`TagCreateResult { name: string; oid: string | null; annotated: boolean }`、`TagDeleteResult { deleted: string }`、`RemoteInfo { name: string; url: string; pushUrl: string | null }`、`RemoteListResult { remotes: RemoteInfo[] }`、`WorktreeInfo { path: string; head: string | null; branch: string | null; bare: boolean; detached: boolean; locked: boolean }`、`WorktreeListResult { worktrees: WorktreeInfo[] }`、`WorktreeAddOptions { path: string; branch?: string | null; newBranch?: string | null }`（检出现有分支与新建分支互斥、至少给其一）、`WorktreeAddResult { path: string; branch: string | null; head: string | null }`、`WorktreeRemoveOptions { path: string; force?: boolean; acknowledged?: boolean }`（脏 worktree 删除需 force+acknowledged）、`WorktreeRemoveResult { removed: string }`。
- `bad-request.details.reason` 联合扩展（`error-codes.ts:57-65`）：`+= 'force-unacknowledged'`（force push / `-D` 删分支 / tag `-f` 共用；client `error-map.ts` 的 params 是文本插值，联合扩值不破坏既有映射）。

### 3.3 新增 `@Remote` 方法（9 个）

| 方法 | 签名要点 | 语义 |
|---|---|---|
| `branchCreate` | `(options: BranchCreateOptions)` | `git branch`（+`checkout` 时 `git switch -C`）；重名 ⇒ **`git/branch-exists`**（现在定死：与 `git/tag-exists` 对称的「已存在」语义，client 可读文案；不复用 `git/branch-not-found`——该码语义是「缺」不是「重」，落 `git/git-error` 则与 tag 侧不对称） |
| `branchSwitch` | `(name: string)` | `git switch`；脏区拦截：前置 status 非空 ⇒ `git/dirty-worktree`（复用现码 `error-codes.ts:68`），UI 文案提示 stash（批次三前为纯文案） |
| `branchDelete` | `(options: BranchDeleteOptions)` | `git branch -d`；未合并 ⇒ `git/branch-not-merged`；`force`（= `-D`）需 acknowledged |
| `tagCreate` | `(options: TagCreateOptions)` | `git tag`（message 非空 = annotated）；已存在 ⇒ `git/tag-exists`；`force` 需 acknowledged |
| `tagDelete` | `(name: string)` | `git tag -d`；不存在 ⇒ `git/tag-not-found` |
| `remoteList` | `()` | `git remote -v` 解析（fetch/push 双 url，push 缺省 = fetch 同值） |
| `worktreeList` | `()` | `git worktree list --porcelain` 解析；字段缺失 = 契约破坏抛错（`graph.ts` 解析器同纪律） |
| `worktreeAdd` | path 已存在非空 / branch 已被另一 worktree 检出 ⇒ `git/worktree-failed`（stderr 特征分类） | `git worktree add <path> (-b <newBranch> \| <branch>)`（D8=[68] per-ticket worktree 写面） |
| `worktreeRemove` | 脏 worktree 无 force+acknowledged 拒绝；path 不存在 ⇒ `git/worktree-failed` | `git worktree remove <path>`（`--force` 仅随 acknowledged 透传） |

### 3.4 新增域码（6 个 + 1 处联合扩展）

| 码 | details |
|---|---|
| `git/branch-not-found` | `{ name: string }` |
| `git/branch-not-merged` | `{ name: string }` |
| `git/branch-exists` | `{ name: string }`（branchCreate 重名专用——与 `git/tag-exists` 对称，评审修订轮定死，不再开放） |
| `git/tag-exists` | `{ name: string }` |
| `git/tag-not-found` | `{ name: string }` |
| `git/worktree-failed` | `{ path: string; stderr: string }`（stderr 过 `sanitizeStderr`；[68] 写面专用） |
| （扩展）`git/bad-request` | reason 联合 `+= 'force-unacknowledged'` |

### 3.5 host 引擎文件

- 新 `packages/host/src/refs-admin.ts`：分支/标签/worktree/remote 查询与变更；变更类走 `write` runner（用户 hooks 不相关，但 `write` 前缀集保持一致——四实例纪律 `CLAUDE.md:65`）；解析器自研（C 级对照登记 PORTING.md）。
- `packages/host/src/remote-ops.ts` 扩展：push 的 `force`/`remote` 目标路径（现 `resolveDefaultRemote` 链 `remote-ops.ts:414+` 保持为缺省解析；显式 `options.remote` 时直查该 remote 存在性，不存在 ⇒ `git/no-remote`）。
- **定时 fetch（D6=B，2026-11-08 拍板）**：Config `autoFetchIntervalMs`（**默认 300_000，0 = 关闭**）——service 启动在 Cordis effect 内挂 interval（stop 清理，无模块级句柄纪律）；到点后台 fetch upstream 三态推导复用 remote-ops；**失败仅 `logger.warn` 不投 UI 错误**（后台任务不得弹窗打扰，GCM 弹窗面 README §5 既有注记），成功走 afterWrite 语义刷新 behind（R3 帧）。

### 3.6 client 组件与 tab 落点（无新 tab）

- **header 菜单扩行**（`GitHeaderButton`，菜单模型 `ui-model.ts:99-107`）：分支选择子菜单（当前分支打勾、detached 显短 oid、点击切换——`branchSwitch`）、新建分支…、打标签…、Worktree…、删除分支入口（当前分支除外——git 拒删当前分支，UI 前置禁用）。
- **`sync` 占位转真**：`headerMenuItems` 的 `sync` 行（`ui-model.ts:105`）拆为 推送 / 拉取 / 获取 三行（复用既有 `push`/`pull`/`fetch` RPC）；fetch 成功后 `source.refresh()`（R5 manual，spec §2.3）刷新 ahead/behind。`loader-composition.spec.ts:115-137` 的菜单占位断言相应更新。
- **推送对话框（[27][57]）**：remotes 数 > 1 或用户需要 force 时开「推送…」对话框：remote picker（`remoteList` 数据）+ force 勾选（勾选后 `GitConfirmDialog severity='danger'` 勾选闸二次确认）+ `setUpstream` 状态展示；remotes == 1 且无 force 诉求保持菜单一步直推（v1 行为不回归）。
- **图 tab tag chips**（`GitGraphTab`）：tag chip 增加菜单（删 tag；从该提交打 tag）——数据已有（`CommitDetail.refs` / log 行 refs chips）。
- **Worktree…**：header 菜单拉起的 worktree 管理对话框：列表区（[62]）+ 新建区（[68]：path / 现有分支或新建分支二选一）+ 移除入口（脏 worktree 走 danger 勾选闸）。

### 3.7 测试计划

- **host 真仓库范式**：新 `packages/host/tests/refs-admin.spec.ts`（scratchRepo 建双分支/双 tag/本地 bare 双 remote：列表→新建→切换（world 重读 HEAD）→删除；`-d` 未合并拒绝 / `-D` 无 acknowledged ⇒ `bad-request`；tag 重名 / 不存在；worktree add/remove/list 全链（含重复 path、branch 被占用、脏 worktree 无 ack 拒绝）；safe.bareRepository 场景 cwd 断言）；`sync.spec.ts` 扩展 force push 两例（amend 后 force 成功推 bare 远端；无 ack 拒绝）+ **定时 fetch 用例**（interval 触发 fake 超时面、失败仅 warn 不抛）；`branchSwitch` 脏区拒绝例。
- **client 纯函数范式**：`ui-model.spec` 扩展（sync 占位消失、分支子菜单渲染模型、detached 短 oid）；新 `packages/client-ui/tests/push-dialog.spec.ts`（remote picker 可见性纯函数 / force→danger 闸状态机）；`error-map.spec` / `locales.spec` 随新码扩行；`loader-composition.spec` 自动对账 9 个新方法；**graph keepMounted 重载回归**（§3.10 风险项的测试落点）：branchSwitch 成功 → branch.oid 变化 → graph tab（keepMounted:true）reload 链路用例（graph-store.spec 扩展或新用例）。
- **verify-load 断言面扩展**：`scripts/verify-load.mjs` 断言链 A–K 为固定清单（`scripts/verify-load.mjs:16-54`），新增方法不自动覆盖——本批为 9 个新方法各加一条真宿主 RPC 往返断言（branchCreate/branchSwitch/branchDelete/tagCreate/tagDelete/remoteList/worktreeList/worktreeAdd/worktreeRemove），随 §3.8 一起跑。

### 3.8 门禁口径（批次收口 = 全绿才进下一批）

```bash
pnpm run typecheck && pnpm test && pnpm run build && pnpm run check:locale
pnpm run verify:load        # 断言面已按 §3.7 扩展：本批 9 个新方法各有真宿主 RPC 往返断言
```

> **verify:load 不自动覆盖新方法**：`scripts/verify-load.mjs` 的断言链 A–K 是固定清单（实读 `scripts/verify-load.mjs:16-54`：ping/identity/strict 判别/status/stage-commit 链/generateCommitMessage 负路径/log 等）——新增方法不在其中，**必须先扩脚本断言面再跑**，否则门禁可全绿而新方法端到端零覆盖。此为每批共同前提，§4.7/§5.7/§6.7 各有对应扩展条目。

### 3.9 依赖与先后理由

- 依赖 v1：`refs()` 数据面、`choose-remote`/`no-remote`/`no-upstream`/`diverged` 域码、danger 勾选闸。零跨批依赖，可独立闭环。
- 定型产出供后续批复用：`bad-request.reason` 扩展值（批次二/三/四的 acknowledged 守卫）、分支选择器 UI（批次二对比入口）、`remoteList`（批次四 PR base 选择）。

### 3.10 风险

- 分支切换 = HEAD 变更 → status R2/R3 帧驱动 graph reload（branch.oid 变化链路 spec §2.3 既有）；graph tab `keepMounted:true` 需回归重载路径。
- force push 误用面：双闸（UI danger 勾选 + host acknowledged 守卫）；diverged 预检跳过是语义行为，必须在 README/spec 注明「force 会覆盖远端」。
- worktree porcelain 输出含 locked/reason 自由文本——解析器按行内 tab/空格边界切，尾字段回接（`LOG_PRETTY_FORMAT` 解析同手法）；字段缺失抛契约错。
- remote picker 与 `git/choose-remote` 错误路径并存：对话框选定 remote 后 host 直查，不再走多 remote 分叉——预检顺序在 refs-admin/remote-ops 内写死，避免双轨报错。

---

## 4. 批次二：历史面（[34][35][36][37][38][60]）

### 4.1 范围拆解

| 清单号 | 内容 | v2 交付形态 |
|---|---|---|
| 34 | blame 逐行 | `blame()` porcelain 解析（`-L` 区间参数支持）；UI 挂 diff 区 blame 模式；大文件走 **-L 区间分片加载**（D3=B，2026-11-08 拍板） |
| 35 | 历史搜索（message/作者/文件） | `LogOptions` 扩过滤参数（`--grep -F` / `--author` / pathspec） |
| 36 | 分支对比（两分支差了哪些提交） | `compareBranches()`：`revListCounts` 提共享 + `git log base..compare` 双列 |
| 37 | cherry-pick / revert / reset（软/混合/硬） | 三个写方法 + `abortOperation()`；冲突结构化报错（完整冲突解决 UI 是 v3 [13]，不在本期） |
| 38 | 虚拟「未提交改动」节点 | 图首页合成行，纯 client（status 快照 + graph 首页数据合成，零 host 变更） |
| 60 | 单文件历史（`log -p --follow <path>`） | [35] 的 `path`+`follow` 参数复用；当版 diff 走既有 `getCommitDetail({oid, path})` |

### 4.2 wire 类型扩展

- **`LogOptions` 扩展**（现 `{ limit, skip }`，`types.ts:285`）：`LogOptions { limit: number; skip: number; query?: string; author?: string; path?: string | null; follow?: boolean; ref?: string | null }`
  —— strict codec 丢未声明字段，此扩展必须先于任何 client 调用落库（变更链 §1 第 1 步）；`follow` 仅在 `path` 为单文件时合法，host 校验违反 ⇒ `git/bad-request`（reason `'follow-without-path'`，本批第二个扩展值）。
- **`DiffScope` 不扩**（现 `'worktree' | 'staged'`，`types.ts:108`）：清单 36 只要求提交级对比（「差了哪些提交」）。若施工中对比视图决定加「分支级文件差异」，再扩 `DiffScope += 'range'`（+ DiffOptions 载 from/to）——登记为**条件扩展点，默认不施工、不预设计**。
- 新类型：`BlameOptions { path: string; ref?: string | null; range?: { start: number; end: number } | null }`（`range` = `-L <start>,<end>` 语义，缺省全区；D3=B 区间分片加载的 wire 承载）、`BlameRange { startLine: number; count: number; oid: string; authorName: string; authoredAt: string }`、`BlameCommit { oid: string; shortOid: string; authorName: string; subject: string }`、`BlameResult { path: string; ref: string | null; lineCount: number; truncated: boolean; ranges: BlameRange[]; commits: BlameCommit[] }`、`CompareOptions { base: string; compare: string }`、`BranchCompareResult { base: string; compare: string; mergeBase: string | null; ahead: CommitInfo[]; behind: CommitInfo[]; aheadCount: number; behindCount: number }`、`CherryPickOptions / RevertOptions { oid: string; acknowledged: boolean; baseRevision: string | null }`、`ResetOptions { kind: 'soft' | 'mixed' | 'hard'; target: string | null; acknowledged: boolean; baseRevision: string | null }`、`TimeTravelResult { op: 'cherry-pick' | 'revert' | 'reset'; oldOid: string; newOid: string | null }`、`AbortOperationResult { aborted: 'cherry-pick' | 'revert' | null }`（null = 无中间态，幂等成功）。

### 4.3 新增 `@Remote` 方法（6 个）

| 方法 | 守卫 | 语义 |
|---|---|---|
| `blame` | 单次调用上限 50_000 行（D3=B：全区超限 ⇒ `git/blame-oversized` 引导 client 转 -L 区间分片；区间调用同样受单次上限钳制，与 `outputMaxBytes` 承载量互相校验） | `git blame --porcelain [-L <start>,<end>]` 解析为 ranges（同 oid 连续行合并）+ commits |
| `compareBranches` | 未知 ref ⇒ `git/unknown-revision` | `revListCounts`（提共享，`remote-ops.ts:388-403`）双向计数 + `git log --topo-order <base>..<compare>` / `<compare>..<base>` 两列（`LOG_PRETTY_FORMAT` 复用）+ `git merge-base` |
| `cherryPick` | acknowledged + baseRevision（discard 三重守卫同款） | `git cherry-pick <oid>`；冲突 ⇒ `git/merge-conflict`（仓库留中间态，错误面板给「放弃操作」按钮调 `abortOperation`） |
| `revert` | 同上 | `git revert --no-edit <oid>`；空 revert ⇒ `git/git-error`（op 'revert'） |
| `reset` | 同上；`hard` 额外 danger 勾选闸 | `git reset --soft/--mixed/--hard <target>`；`target` null = HEAD（unstage 场景用 mixed） |
| `abortOperation` | 无（幂等安全） | 探测 `CHERRY_PICK_HEAD`/`REVERT_HEAD` → `git cherry-pick --abort` / `git revert --abort`；无中间态 ⇒ 空成功 |

### 4.4 新增域码（4 个 + 1 处联合扩展）

| 码 | details |
|---|---|
| `git/blame-oversized` | `{ path: string; lineCount: number; maxLines: number }` |
| `git/merge-conflict` | `{ op: string; conflicted: string[]; abortable: boolean }`（`op` 定为 **string** 而非窄联合——批次三 stash-pop 冲突复用此码时不再改类型） |
| `git/unknown-revision` | `{ op: string; revision: string }` |
| `git/operation-in-progress` | `{ op: 'cherry-pick' | 'revert' }`（时间旅行引擎写前探测中间态，拒绝叠操作） |
| （扩展）`git/bad-request` | reason 联合 `+= 'follow-without-path'` |

### 4.5 host 引擎文件

- 新 `packages/host/src/blame.ts`：`--porcelain` 增量解析（header 块 + 行块）；行顶钳制照 `normalizeLogLimit` 钳制风格（`graph.ts:88-91`）；二进制文件 git 报错走 `gitRunError` 兜底。
- 新 `packages/host/src/time-travel.ts`：cherry-pick/revert/reset/abort；**超时档 = write runner（fastTimeoutMs）**——四 runner 纪律中 `commitTimeoutMs` 只属 commit runner（`git-runner.ts:238-242` 实读：readonly/write 两实例同 `fastTimeoutMs`；`:246` commit 独占 commit 档），「写 runner + commitTimeoutMs」组合不存在；cherry-pick/revert 触发 commit-msg 类 hook 的慢场景若实测超时，再开独立 `timeTravelTimeoutMs` Config 档（照 commitTimeoutMs 先例），默认不新增档位；操作前 status 前置检查（operation-in-progress / no-branch 复用 `requireBranch` 语义 `remote-ops.ts:377-385`）。
- `packages/host/src/graph.ts` 扩展：`log` 方法接受过滤参数（`--grep -F`、`--author`、`--`、`<path>`、`--follow`、`<ref>` 附加进现有命令形态；`LOG_PRETTY_FORMAT`（`graph.ts:66`）与钳制（`graph.ts:88-97`）零改动复用）；`skip`+过滤组合的分页语义与 v1 相同（over-fetch limit+1）。
- 新 `packages/host/src/rev-count.ts`（或由 remote-ops 导出）：`revListCounts` 从 `remote-ops.ts:388-403` 提共享（remote-ops 改为消费，行为不变——迁移后跑 `sync.spec.ts` 回归）。

### 4.6 client 组件与 tab 落点（无新 tab）

- **图 tab 顶栏**：搜索框（query/author）+ 过滤 chip（有过滤时显示「清除」）；结果走既有分页（`graph-store` 分页状态机不动）。
- **分支对比**：分支选择器（批次一）内「与当前分支比较」→ 图 tab 内对比面板（ahead/behind 两列提交列表，行点击复用 `commit-detail-panel`）；关闭恢复全图。
- **WIP 节点（[38]）**：图首页顶部合成行（虚线/菱形样式区分），数据 = status 快照四组计数 + HEAD oid（纯 client 合成）；点击 → `ctx.sidebarRight.openResource(changes 地址)`；`clean === true` 不渲染。
- **blame（[34]）**：ChangesTab 文件详情区加「Blame」模式切换 → 行号 gutter 注记（短 oid + 作者 + 相对时间，同 range 合并显示）；**大文件分片（D3=B）**：全区超限的文件按虚拟滚动窗口以 `-L` 区间增量加载（区间结果按行号归并进 gutter，跨片同 oid 行仍合并显示）；`git/blame-oversized` 不再是占位终点而是分片引导（占位文案仅保留在无法分片的兜底形态，镜像 `diff.oversized` 占位形态 `FileDiffView.tsx:54`）。
- **单文件历史（[60]）**：文件卡片「文件历史」动作 → 图 tab path 模式（顶栏 path chip + 退出按钮；`log({path, follow:true})`）；提交行点击 `getCommitDetail({oid, path})` 看该文件当版 patch（既有方法）。
- **[37] 入口**：图 tab 提交行菜单（cherry-pick 到当前分支 / revert）+ 分支选择器 reset 子菜单（soft/mixed/hard；hard 走 danger 勾选闸）。

### 4.7 测试计划

- **host 真仓库范式**：新 `blame.spec.ts`（多作者多提交 / 范围合并正确 / **-L 区间往返正确性 / 全区超限 ⇒ blame-oversized / 区间超限同钳 / 区间行号与全区行号一致性** / 对不存在 path 的行为如实断言）；新 `history-search.spec.ts`（`-F` 固定串 / author / path / `--follow` rename 跟踪 / follow 无 path ⇒ bad-request / 未知 ref ⇒ unknown-revision / 过滤 + 分页组合）；新 `compare.spec.ts`（对称差计数与列表 / mergeBase / 同分支零列）；新 `time-travel.spec.ts`（三档 reset 各自 world 重读 / hard 无 ack 拒绝 / cherry-pick 冲突 ⇒ merge-conflict details.conflicted 重读一致 / CHERRY_PICK_HEAD 在场 ⇒ operation-in-progress / abort 后回原 HEAD）；`revListCounts` 提共享迁移后 `sync.spec.ts` 全绿。
- **client 纯函数范式**：新 `graph-search.spec.ts`（过滤参数组装 / 空结果视图）；新 `wip-node.spec.ts`（clean 不渲染 / 计数合成 / 点击意图）；新 `blame-view.spec.ts`（range 合并渲染模型 / oversized 占位 / gutter 注记行折叠）；`ui-model.spec` 扩展（reset 子菜单可见性）；`error-map.spec` / `locales.spec` 新码行。
- **verify-load 断言面扩展**：本批为 6 个新方法各加一条真宿主往返断言（blame/compareBranches/cherryPick/revert/reset/abortOperation——reset 用临时真仓库做三档 world 重读；时间旅行冲突路径断言 `git/merge-conflict` 真宿主形状），随 §4.8 一起跑（前提见 §3.8 注）。

### 4.8 门禁口径

同批次一（§3.8）：四件套 + `verify:load`（断言面已按 §4.7 扩展——新增 6 方法各一条往返断言）。

### 4.9 依赖与先后理由

- 依赖批次一：分支选择器（对比入口）、`bad-request` reason 扩展先例；依赖 v1：discard 三重守卫范式（`types.ts:223-227`、`mutations.ts:153-164`）、danger 闸、`LOG_PRETTY_FORMAT`/钳制、`getCommitDetail` 单文件 patch。
- 排在批次三前：历史面 4/6 只读、爆炸半径小；[37] 复用既有守卫范式无新前置。可交换性说明（D9 **已拍板保持**，2026-11-08）：三↔二整体对调的唯一耦合是 `git/merge-conflict`（§4.4 注册、§5.3 stashPop 消费）——本拍板下不作对调，此段仅留档。

### 4.10 风险

- **cherry-pick/revert 冲突留中间态**：仓库处于 merged-conflict 状态直到 abort/解决——完整解决 UI 是 v3 [13]；v2 必须把「放弃操作」按钮（abortOperation）放进 `git/merge-conflict` 错误面板，README 如实登记半途态。
- **reset --hard 丢工作区**：danger 双闸 + baseRevision；`dirty-worktree` 不拦 reset --hard（其语义即清理），但 UI 需列出将丢弃的文件计数（status 快照已有）。
- **blame 大仓性能（D3=B 分片纪律）**：单次调用仍有 50_000 行硬顶（防失控区间），大文件由 client 按虚拟滚动窗口分片加载——`--porcelain` 输出体量与行数线性，50_000 行 ≈ 数 MB，`outputMaxBytes`（默认 8 MiB，`index.ts:104-105`）内可达——上限不得高于 outputMaxBytes 可承载量，两值在实现时对齐并互相校验；分片边界处的 range 合并逻辑必须有 spec 钉住（跨片同 oid 行合并）。
- **`--follow` 限制**：单路径、git 仅跟踪有限 rename 链——文档如实（[60] 交付口径写「尽力跟踪」）。
- **搜索注入**：args 数组 spawn 无 shell，无注入面；`-F` 固定串避免 grep 语法歧义；author 原样传（`--author` 是正则语义，UI 提示「按子串/正则匹配」）。

---

## 5. 批次三：提交链路与护栏（[10][14][18][21][22][56][63]）

### 5.1 范围拆解

| 清单号 | 内容 | v2 交付形态 |
|---|---|---|
| 10 | hunk 级 / 行级 stage | diff 区 hunk/行勾选 → client 组装选中 patch → `stagePatch()`（`git apply --cached`）；**unstage 侧同批做 hunk/行级**（D7=B，2026-11-08 拍板：`apply --cached -R` 反向，staged diff 区同构勾选） |
| 14 | stash：暂存、列表、弹出、删除 | 四方法 + ChangesTab stash 面板；**默认含 untracked**（D4=B，2026-11-08 拍板：`includeUntracked` 缺省 true，UI 勾选可关） |
| 18 | 作者署名 trailer | `CommitOptions.trailers`（Co-authored-by / Generated-by 等），host 组装进消息体（`-F -` stdin 路径），回读展示（`CommitResult.message` 纪律不变） |
| 21 | 提交护栏：密钥 / .env / 大文件 / 构建产物拦截 | `scanStaged()` 预检 + `git/commit-blocked`；提交按钮禁用 + 违规列表 |
| 22 | 提交前 secret 扫描 | 与 [21] 同一扫描引擎（violation kind `'secret'`）；豁免策略见 §8 D5 |
| 56 | 行尾与编码安全（CRLF/autocrlf 提示；中文路径） | `repoDiagnostics()`（autocrlf/core.eol/CRLF 抽样清单）；中文路径 v1 已处理（`-z` porcelain + `GIT_LITERAL_PATHSPECS=1`，`CLAUDE.md:65`）——v2 补 CRLF 提示条与 stagePatch 的 CRLF 夹具测试 |
| 63 | hook 输出面板 | `CommitResult` 扩输出捕获字段 + GitCommitDialog 折叠区（stdout/stderr 尾保留显示，复用 `redactTail`——P3 复活点） |

### 5.2 wire 类型扩展

- `CommitOptions`（`types.ts:229-235`）`+= trailers?: string[]`（每条需形如 `Key: value`；host 校验不合法条目 ⇒ `git/bad-request` reason `+= 'malformed-trailer'`）。
- `CommitResult`（`types.ts:237-248`）`+= process: { stdout: string; stderr: string; timedOut: boolean; durationMs: number } | null`
  —— **诚实命名**：这是 `git commit` 进程的整体输出（含 hook 输出，git 不做 per-hook 归因），字段注释必须写明；空输出置 null 省 wire。pre-commit 失败路径既有 `git/hook-failed`（stderr 已进 details，`error-codes.ts:66`）不变。
- 新类型：`StagePatchOptions { path: string; patch: string; direction?: 'stage' | 'unstage' }`（缺省 `'stage'`；`'unstage'` = `apply --cached -R` 反向——D7=B）、`StagePatchResult { staged: number }`、`StashPushOptions { message?: string | null; includeUntracked: boolean; baseRevision?: string | null }`（`includeUntracked` **wire 保持显式 boolean，client 缺省传 true**——D4=B 默认含 untracked；`baseRevision` = §5.3 语义行的乐观并发基线——discard 范式 `types.ts:223-227` 的可选沿用，wire 一次带齐防静默丢失）、`StashEntry { index: number; oid: string; shortOid: string; message: string; authoredAt: string }`、`StashListResult { stashes: StashEntry[] }`、`StashOpResult { index: number }`、`CommitViolation { kind: 'secret' | 'env-file' | 'large-file' | 'build-artifact' | 'eol-mixed'; path: string; detail: string; sizeBytes: number | null; line: number | null; redactedMatch: string | null }`、`CommitScanResult { blocked: boolean; violations: CommitViolation[] }`、`RepoDiagnostics { autocrlf: string | null; coreEol: string | null; mixedEolFiles: string[]; worktreeCrlfCount: number }`（文件清单封顶，超出仅计数）。
- `bad-request` reason 联合 `+= 'malformed-trailer'`。

### 5.3 新增 `@Remote` 方法（7 个）

| 方法 | 守卫 | 语义 |
|---|---|---|
| `stagePatch` | patch 与 index 冲突 ⇒ `git/stage-patch-failed`；二进制/模式变更 hunk 拒绝 | `git apply --cached --recount --whitespace=nowarn`（patch 文本走 stdin）；`direction='unstage'` 时追加 `-R` 反向应用（D7=B）；hunk 级与行级都是 client 组装 patch（`--recount` 容忍行计数漂移） |
| `stashPush` | 无可 stash 改动 ⇒ `git/no-paths`（op 'stash'，复用现码） | `git stash push [-u] [-m msg]`（`includeUntracked` 缺省 true = `-u`，D4=B）；baseRevision 乐观基线可选传入 |
| `stashList` | — | `git stash list --format` 解析（index = 引用序号） |
| `stashPop` | index 越界 ⇒ `git/stash-not-found`；应用冲突 ⇒ `git/merge-conflict`（op 'stash-pop'；git 语义冲突时 stash 不丢，UI 明示） | `git stash pop`（默认最近一条 / 可指定 index） |
| `stashDrop` | acknowledged（danger 闸）+ index 校验 | `git stash drop` |
| `scanStaged` | —（只读预检） | 扫 staged 内容：密钥模式（token 格式/PEM 头/.env 键值，模式表自研）+ 大文件阈值 + 构建产物 glob + CRLF 抽样；violations 分类返回 |
| `repoDiagnostics` | —（只读） | `git config --get core.autocrlf/core.eol` + 工作区 CRLF 抽样（限顶层 + 已知文本后缀，封顶） |

### 5.4 新增域码（3 个 + 1 处联合扩展）

| 码 | details |
|---|---|
| `git/stage-patch-failed` | `{ path: string; stderr: string }`（stderr 过 `sanitizeStderr`） |
| `git/stash-not-found` | `{ index: number }` |
| `git/commit-blocked` | `{ violations: CommitViolation[]; overridable: boolean }`（`overridable` = 违规集中无 secret 类时的豁免许可，语义见 D5） |
| （扩展）`git/bad-request` | reason 联合 `+= 'malformed-trailer'` |

### 5.5 host 引擎文件

- 新 `packages/host/src/staging-patch.ts`：`apply --cached` 封装（stdin patch、二进制/模式 hunk 拒绝、`--recount`）。
- 新 `packages/host/src/stash.ts`：push/list/pop/drop（`stash list` 自定义 format 解析，记录尾分隔纪律同 `LOG_PRETTY_FORMAT`）。
- 新 `packages/host/src/guard-scan.ts`：[21][22] 扫描引擎（密钥模式表自研——零新依赖；阈值/glob 进 Config：`guardLargeFileBytes` 默认 1 MiB、`guardBuildPatterns` 默认常见产物目录表、`guardSecretPatterns` 可叠加）；staged 内容读取走 readonly runner（`git cat-file`/`git show :path`）；命中密钥的展示文本必须再过 `sanitizeStderr` 同级脱敏（`redactedMatch` 字段）。
- `packages/host/src/commit.ts` 扩展：trailers 组装进 `-F` 消息体（空行分隔 + 尾块）；`process` 字段捕获（现有 GitRunResult 的 stdout/stderr 已在手上，截 16 KiB/侧封顶）；`skipHooks`/amend 语义不动。
- 新 `packages/host/src/diagnostics.ts`（或并入 guard-scan.ts）：repoDiagnostics。

### 5.6 client 组件与 tab 落点（无新 tab）

- **ChangesTab diff 区（[10]）**：worktree 侧与 staged 侧**同构**支持 hunk 头勾选框 + 行级勾选（复用/复活 `splitRows`——`patch-hunks.ts:118`，行选择需要逐行行片）；勾选变化 → client 纯函数组装选中 patch（从既有 `parsePatch` 产物裁剪）→ `stagePatch`（worktree 选中 = `direction:'stage'`，staged 选中 = `direction:'unstage'` 反向还原，D7=B）。
- **GitCommitDialog 三块扩展**：① trailer 编辑区（预设 Co-authored-by / Generated-by 行，可增删；非法行即时警示不阻断——镜像 Conventional 预检形态）；② 护栏结果面板（打开对话框 / 点提交前自动 `scanStaged`；blocked ⇒ 禁用提交按钮 + 违规列表 + 可豁免类的 danger 勾选豁免入口）；③ hook 输出折叠区（提交结果/失败的 `process` 字段与 `git/hook-failed` details；长输出尾保留 = 复活 `redactTail`，`redact.ts:38`）。
- **CRLF 提示条（[56]）**：ChangesTab 顶部信息条（`repoDiagnostics` 返回 autocrlf 生效值与 mixedEolFiles 摘要；可折叠，不阻断）。
- **stash 面板（[14]）**：ChangesTab 顶部 stash 计数 chip → 面板（列表 / 应用=pop / 删除=drop danger 闸）；「Stash 全部变更」动作：`includeUntracked` **默认勾选**（D4=B 含 untracked，可取消；勾选区旁显示 untracked 计数提示——大产物易被卷入，取消路径保持一击可达）。

### 5.7 测试计划

- **host 真仓库范式**：新 `staging-patch.spec.ts`（两 hunk patch 只 stage 一个 → world 重读 index；行级 patch `--recount`；**`direction:'unstage'` 反向应用 → world 重读 index 恢复（D7=B）**；二进制 hunk 拒绝；patch 与 index 不符 ⇒ stage-patch-failed；**CRLF 夹具**（`core.autocrlf=false` 直写 CRLF 文件）与**中文路径夹具**必测）；新 `stash.spec.ts`（push/list/pop/drop 全链、**缺省 `-u` 含 untracked（D4=B）+ 显式 false 关闭**、无改动 ⇒ no-paths、pop 冲突 ⇒ merge-conflict op 'stash-pop' 且 stash 未丢、drop 无 ack 拒绝）；新 `guard-scan.spec.ts`（密钥样例 / .env / 大文件 / 构建产物各命中 + violations 形状 + redactedMatch 无明文断言 + 干净仓库零误报基线）；`commit.spec.ts` 扩展（trailers 组装回读 / process 字段捕获 / skipHooks 与 amend 不回归）；diagnostics（autocrlf 三态 / 空配置）。
- **client 纯函数范式**：新 `hunk-stage.spec.ts`（hunk 选择→patch 裁剪组装 / 行选择计数重算 / **direction 两态组装（stage/unstage 反向）** / 二进制不可选）；`commit-view-model.spec` 扩展（blocked→按钮禁用 / 违规列表渲染模型 / trailer 行校验 / 豁免状态机）；新 `stash-view.spec.ts`（列表 / pop 冲突提示 / drop danger 闸 / **includeUntracked 缺省勾选模型**）；`error-map.spec` / `locales.spec` 新码行。
- **verify-load 断言面扩展**：本批为 7 个新方法各加一条真宿主往返断言（stagePatch/stashPush/stashList/stashPop/stashDrop/scanStaged/repoDiagnostics——stashPop 冲突断言 `git/merge-conflict`（op 'stash-pop'，该码注册批次二，§8 D9 对调时随移）+ commit 链路断言 `CommitResult.process` 字段），随 §5.8 一起跑（前提见 §3.8 注）。

### 5.8 门禁口径

同 §3.8：四件套 + `verify:load`（断言面已按 §5.7 扩展——新增 7 方法 + commit 链路扩展回归）。

### 5.9 依赖与先后理由

- 依赖批次一：`bad-request` reason 扩展机制（本批第 3 个扩展值）。依赖 v1：`git/hook-failed`、`no-paths`、danger 闸、`parsePatch/hunkRows`（`patch-hunks.ts` 既有纯函数）。
- 与批次二的顺序可整体对调（D9）；本批必须在批次四 [46]（PR）之前——PR 描述生成基于受护栏的工作区。
- P3 复活点在本批：`splitRows`（[10] 行选择）、`redactTail`（[63] 长输出）——见 §10。

### 5.10 风险

- **`apply --cached` patch 组装正确性**：行级选择重算 hunk 头计数靠 `--recount`；CRLF 仓库 patch 文本与 index 行尾漂移 ⇒ stage-patch-failed，提示回落文件级 stage；模式变更/二进制 hunk 显式拒绝。真仓测试必须覆盖 CRLF 与中文路径夹具。
- **secret 扫描误报阻塞提交**：violations 携带 `redactedMatch`（不落明文密钥——`sanitizeStderr` 纪律 `error-codes.ts:86-97` 延伸）；豁免策略 = D5 拍板；误报率通过 guard-scan.spec 的干净基线用例控制。
- **stash pop 冲突**：git 语义下 stash 不丢——UI 必须明示「应用失败但 stash 保留」，避免用户误以为丢失。
- **`CommitResult` 扩体量**：每次提交回带输出，空输出置 null；16 KiB/侧封顶。
- **护栏 Config 缺省激进度**：默认规则集太严会拦正常提交——默认集按「高置信度密钥格式 + 明确产物目录」收窄，宽松度调整留给 Config（README §3 配置示例同步）。

---

## 6. 批次四：体验集成与收尾（[8][46][51][61][66] + P3 清理 + 发布）

### 6.1 范围拆解

| 清单号 | 内容 | v2 交付形态 |
|---|---|---|
| 8 | 非 git 目录 git init 引导 | `initRepository()` + header/changes/graph 空态卡片引导 |
| 46 | AI 生成 PR 描述 + 一键创建 PR | `generatePrDescription()`（复用 message-gen LLM 路由）+ `createPr()`（载体**已拍板 = gh CLI**，D1=A） |
| 69 | PR↔分支名关联（D8 纳入） | `prForBranch(branch)`（gh 查询该分支关联 PR）+ 分支选择器 / 推送对话框 PR 链接展示；无关联 / 查询失败 ⇒ UI 静默降级（不占位不报错） |
| 70 | 合并策略放 prompt（D8 纳入） | `generatePrDescription()` 的 LLM prompt 附带**仓库合并策略约定段**（只读检测：PR 模板 / CONTRIBUTING / `git config` merge 相关项；缺失即省略）——零新方法零新码，是 [46] 的 prompt 组成件。原始出处 `docs/003-execution.md` 已不可考（外层检索结论 §11-2）；若用户原意与此最小解释不符，批次四施工前修正本行 |
| 51 | 快捷键与命令面板入口 | 先 spike dsh 命令面板机制（§0.4-7 仍未定位）；有机制 → 注册命令集；无 → 降级 = 组件内快捷键维持扩展 + header 菜单入口（如实登记） |
| 61 | submodule/gitlink 状态展示（只列不递归） | `submoduleStatus()` + changes tab 卡片徽标与详情（v1 已有 `FileChange.submodule` 布尔位，`types.ts:66`） |
| 66 | 写操作审计日志 | host 环缓冲 + `auditLog()` 查询（无事件通道 → logger + RPC 查询两路，§0.4-1）；无专属 UI |

### 6.2 wire 类型扩展

- 新类型：`InitResult { repoRoot: string; branch: string }`、`SubmoduleEntry { path: string; oid: string | null; recordedOid: string | null; state: 'clean' | 'dirty' | 'uninitialized' | 'mismatch' | 'unknown' }`、`SubmoduleStatusResult { submodules: SubmoduleEntry[] }`、`AuditEntry { at: string; op: string; ok: boolean; code: string | null; durationMs: number; summary: string }`（summary 只含 op 参数摘要——不落 message 正文/文件内容/密钥，spec §1.0.6 纪律）、`AuditLogOptions { limit?: number; since?: string | null }`、`AuditLogResult { entries: AuditEntry[] }`、`PrDescription { title: string; body: string; conventional: boolean }`、`PrCreateOptions { title: string; body: string; base?: string | null; head?: string | null; draft?: boolean; acknowledged: boolean }`、`PrResult { url: string; number: number | null }`、`PrLinkResult { url: string; state: string | null }`（[69] prForBranch 的返回；null = 无关联/查询失败，UI 静默降级）。

### 6.3 新增 `@Remote` 方法（6 个）

| 方法 | 守卫 | 语义 |
|---|---|---|
| `initRepository` | 目录已是非空非仓库 ⇒ `git/init-failed` | `git init`（init 后触发 StatusEngine 缓存失效 + workspace 重解析 + afterWrite 通知——workspace 从 unresolved → resolved） |
| `submoduleStatus` | —（只读） | `git submodule status` 前缀解析（空格=clean、`-`=未初始化、`+`=HEAD 漂移、`U`=冲突）；只列不递归 |
| `auditLog` | —（只读） | 环缓冲查询（`auditMaxEntries` Config 默认 500；limit/since 过滤） |
| `generatePrDescription` | 复用 `git/llm-route-unresolved` / `git/llm-failed` | 基于 staged+未提交 diff 与最近提交生成 PR 标题/描述；LLM 调用复用 message-gen 管线（purpose 省略口径不变——dsh `GenerateOptions.purpose` 是封闭联合，插件不能发明新 purpose，`packages/host/src/message-gen.ts:502-503` 已核实） |
| `createPr` | acknowledged（danger 闸） | **gh CLI 载体**（D1=A 已拍板）：`gh auth status` 预检 → `gh pr create --title … --body-file -（stdin）[--base][--head][--draft]`；gh 缺失 ⇒ `git/pr-tool-missing`；API 失败 ⇒ `git/pr-create-failed`（stderr 脱敏）。gh 路径 Config 化 = **`ghCommand`**（默认 'gh'，经 `subprocess.resolveExecutable` 解析——同 `gitCommand` 先例 `index.ts:96`；解析失败/返回 null ⇒ `git/pr-tool-missing`，语义对照 `git-runner.ts:20` 的 resolve-git 分支；此 Config 同时是 verify-load 负路径断言的注入点，§6.7） |
| `prForBranch` | gh 缺失 ⇒ `git/pr-tool-missing`；查询失败/无关联 ⇒ 返回 null（UI 静默降级） | `gh pr view <branch> --json url,state`（[69]，D8 纳入）；head 推断 = 该分支 upstream 缺省映射 |

### 6.4 新增域码（3 个）

| 码 | details |
|---|---|
| `git/init-failed` | `{ path: string; reason: string }` |
| `git/pr-tool-missing` | `{ tool: 'gh' }` |
| `git/pr-create-failed` | `{ stderr: string }`（脱敏后） |

### 6.5 host 引擎文件

- 新 `packages/host/src/admin-repo.ts`：initRepository（前置 `git rev-parse` 复核非仓库态）。
- 新 `packages/host/src/submodule.ts`：submoduleStatus 解析（只列不递归——对齐 [61] 原文与 v1 不展开口径）。
- 新 `packages/host/src/audit.ts`：写操作**双出口**挂钩——v1 写方法的 `afterWrite()` 只在 try **成功分支**（实读 `index.ts:391-399` stage / `index.ts:411-420` unstage：结构为 `try{…afterWrite();return}catch{logFailure;throw}`），失败路径不经过它；审计须在 catch 侧（`logFailure` 处）同步入环 `ok:false + code`，成功侧入环 `ok:true`——只挂 `afterWrite()` 会漏全部失败审计，与 `AuditEntry.ok/code` 字段语义（§6.2）矛盾。记录字段 op/参数摘要/结果码/时长/时间戳；环缓冲上限可配；只读方法不入审计。
- 新 `packages/host/src/pr.ts`：gh CLI 封装（真 spawn face 复用 `subprocess`；`ghCommand` Config 经 `resolveExecutable` 解析，失败 ⇒ `git/pr-tool-missing`；stderr 过 `sanitizeStderr`；**transport 结构切片** = 构造期可选 seam，缺省真 spawn、pr.spec 单测注入假实现——注意该 seam 只在单测可达，真宿主无注入通道，§6.10；gh 的认证提示面与 git `GIT_TERMINAL_PROMPT=0` 不同源——`gh` 调用需自带非交互旗标，实现时以 `gh` 实测为准，未验证点如实登记）。
- `packages/host/src/message-gen.ts` 扩展：PR 描述生成复用六步管线（trim/LLM 路由/校验），输出 shape 换 PR title+body。

### 6.6 client 组件与 tab 落点

- **空态引导（[8]）**：`git/no-repository` 状态下 header 菜单「初始化 Git 仓库…」行 + changes/graph tab 空态卡片（说明 + 初始化按钮 + `workspaceOverride` 已钉死时不显示）；成功后 `source.refresh()`。
- **PR 对话框（[46]）**：分支选择器 / 推送成功引导「创建 PR…」→ 对话框（AI 生成描述按钮（[70]：prompt 附带合并策略约定段）+ title/body 编辑 + base 分支选择（`remoteList`+`refs` 数据）+ draft 勾选 + 创建 danger 确认）；成功展示 PR URL。D1 已拍板 A（gh CLI）。**[69] 关联展示**：分支选择器行与推送对话框显示 `prForBranch` 结果的 PR 链接（无关联/失败不占位）。
- **命令面板（[51]）**：批次四第一步 spike——在 dsh 树（`DSH_TREE`，只读）定位命令注册/面板机制；命中 → 注册插件命令集（打开变更/图/提交/推送/拉取/获取/切换分支/stash）；未命中 → 降级交付：组件内快捷键维持并扩展（aria-keyshortcuts 锚已有，`loader-composition.spec.ts:99-113`）+ header 菜单即入口，README §5 如实登记。
- **submodule 徽标（[61]）**：changes tab 文件卡片 submodule 徽标（v1 已渲染布尔位）→ 点击详情面板显示 `submoduleStatus` 列表（path / 当前 oid vs 记录 oid 差异高亮 / state 徽标）。
- **审计日志（[66]）**：无专属 UI（logger + `auditLog` RPC 满足「可观测」）；header 菜单「操作日志…」只读对话框登记为可选实现，默认不做。
- **P3：mountGitRemote reject 投影**：`client/index.ts:100-105` 的 mount effect 加 catch → `statusError` 投影（`gateway/service-unavailable` 同形）+ `logger.warn`，不再裸 reject 打断 fiber。

### 6.7 测试计划

- **host 真仓库范式**：新 `admin-repo.spec.ts`（空目录 init 成功 → status ready / 已仓库拒绝 / 非空非仓库拒绝 / **watcher 重探测**：init 前仓库不存在（错误帧态）→ init 后 R1 首帧就绪——§6.10 风险项的测试落点）；新 `submodule.spec.ts`（真仓嵌 submodule：clean/uninitialized/mismatch 三态解析 + 不递归断言）；新 `audit.spec.ts`（写操作入环 / **失败路径入环 `ok:false + code`**（双出口挂钩，§6.5）/ 只读不入 / 上限截断 / since 过滤 / summary 不含 message 正文与文件内容的负断言）；新 `pr.spec.ts`（假 gh 替身承载形态见 §6.10 实测登记：**默认 = pr.ts 暴露可注入 transport 结构切片**——`readLlmFace`/`readFsFace` 可选切片先例——测试注入 fake transport 断言成功 url 解析 / gh 缺失 ⇒ pr-tool-missing / 无 acknowledged 拒绝 / stderr 脱敏；真 gh 端到端走 verify:load 人工走查，v1 push 真实网络路径同口径，README §5 末条）；`message-gen.spec.ts` 扩展 PR 描述路径。
- **client 纯函数范式**：新 `init-empty-state.spec.ts`（空态视图模型 / workspaceOverride 不显示 / 确认流）；PR 对话框视图模型（校验 / draft / danger 闸）；`error-map.spec` / `locales.spec` 新码行；`loader-composition.spec` 随 5 方法自动对账。
- **verify-load 断言面扩展**：本批为 6 个新方法各加真宿主断言——initRepository/submoduleStatus/auditLog 正路径；`generatePrDescription` 负路径（无 LLM 路由 ⇒ `git/llm-route-unresolved`，同 generateCommitMessage 的既有负往返形态）；`prForBranch` 同 `createPr` 的负路径形态（`ghCommand` 指向解析不到的固件名 ⇒ `git/pr-tool-missing`）；`createPr` **只断负路径**：profile 补丁设 `ghCommand` 指向解析不到的固件名 ⇒ `git/pr-tool-missing`（真宿主进程**没有 face 注入通道**——Config 是 schemastery JSON 面带不了函数，fs/llm 切片先例的源是宿主能力服务 `ctx.get('fs')/`ctx.get('llm')`，`index.ts:693-733`，gh 无对应宿主能力源，`capability-spec.md:14` v1.3 ⑤；transport 切片注入只在 pr.spec 单测可达）。**createPr / prForBranch 成功形状留在 pr.spec 单测**（prForBranch：假 transport 注入断言 url/state 解析与 null 降级）；真 gh 正路径不进任何自动门禁（会创建真实 PR 且需网络凭证），人工走查。随 §6.8 一起跑（前提见 §3.8 注）。

### 6.8 门禁口径

四件套 + `verify:load`（断言面已按 §6.7 扩展——新增 6 方法）；批次收口即进入 §7 发布门禁全链（v0.2.0 唯一发布轮）。

### 6.9 依赖与先后理由

- 审计（[66]）最后实现才一批覆盖前三批全部写方法（分支/标签/时间旅行/stash/stagePatch/…）；PR（[46]）依赖 D1 已拍板（A=gh CLI）+ 批次三护栏 + 批次一 `remoteList`；[69] 随 PR 同引擎；命令面板依赖 spike 结论；init 引导（[8]）是全链路空态补全，放收尾批。
- P3 清理归本批（§10）——死代码复活项（splitRows/redactTail）例外，随批次三落位。

### 6.10 风险

- **gh CLI 是外部依赖**：用户机未装/未登录 ⇒ `git/pr-tool-missing` 降级文案；gh 非交互行为未实测（登记为施工期第一个验证点）。
- **init 后 workspace 解析链变化**：`workspaceOverride` 钉死路径不显示引导（已是仓库）；session cwd 解析失败的仓库 init 后需重探——watcher R6→R1 重启路径要测。
- **审计内存上限与脱敏**：环缓冲定长 + summary 白名单字段组装（非自由拼接），audit.spec 负断言兜底。
- **命令面板 spike 可能无果**：降级预案明确（§6.6），不硬凑（spec §0.4-7 纪律）。
- **假 gh 测试替身的 win32 承载形态（已定案，修订轮 2 接通两节机制）**：本仓库平台 win32、CI windows-latest；实测（2026-11-07，node v22.21.0，mktemp 临时目录 `spawnSync` 三形态）：`spawnSync('fake.cmd', {shell:false})` ⇒ **EINVAL**、`shell:true` ⇒ 可用、`process.execPath + js 脚本` ⇒ 可用——生产 spawn 无 shell 语义，`.cmd` shim 直接 spawn 不可行。**分层落定**：① **单测层** = pr.ts transport 结构切片注入假实现，pr.spec 断 createPr 成功形状（与 fs/llm 切片先例同构）；② **verify-load 层** = 真宿主进程无 face 注入通道（Config 是 schemastery JSON 面带不了函数；fs/llm 切片源是宿主能力服务 `ctx.get`——`index.ts:693-733`，gh 无对应宿主能力源；候选②「ghCommand 指向 node 包装」也不可行：单字符串 Config 带不了 node+脚本双 argv，`.cmd` shim 已实测 EINVAL，dsh subprocess face 是否带 shell 语义未核实、不赌）——故 createPr 在 verify-load **只断负路径**：`ghCommand`（`index.ts:96` gitCommand 同款 resolveExecutable 先例）指向解析不到的固件名 ⇒ `git/pr-tool-missing`（§6.7）。真 gh 非交互旗标行为仍需真机验证（既有登记不变）。

---

## 7. 发布口径：v0.2.0（含 v0.1.2 全部内容，一次性发布）

用户已决：v0.1.2 不单独发布（代码定稿在 main，`README.md:4`、git log `7b1f748`/`298019b`），随 V2 首版以 **v0.2.0** 一次发布。发布前置门禁清单（全过才打 tag）：

1. **兼容快查（已做，不重跑）**：0.2.2-rc.1（npm next）与 0.2.2-alpha.3 逐符号快查均 pass（2026-11-07，`README.md:53-69` 兼容性口径段）——dsh 再出新版时对新版重跑同口径快查，否则不放开声明。
2. **本仓库门禁全链（本机执行并回填）**——注意 `check:locale` 不在 CI 发布门禁内：release.yml 步清单 = Typecheck/Test/Build/Verify install matrix/Publish/Verify tarballs（实读 `.github/workflows/release.yml:73-104`），grep workflows `check:locale` 零命中（exit 1）——而 JSX 裸串与 locales.ts import-free 检查只在 check-locale.mjs（locales.spec 只覆盖键位对齐），必须本机补跑：
   - `pnpm run check:locale`；
   - `pnpm run verify:load`（全断言联调：构建 → 双包直装 → web 启动 → RPC 往返；断言面含四批扩展——§3.7/§4.7/§5.7/§6.7）；
   - `pnpm run verify:install` dev-tree 列两相（working-copy + clean-clone）；
   - npm 列：`DSH_SPEC=@deepseek-ai/dsh@0.2.1-rc.5 node scripts/verify-install.mjs`（`DSH_VERIFY_ALLOW_SKIP` 不设，失败即停）；可选加跑 0.2.2-rc.1 列；
   - 结果**实跑回填** README §6 门禁表（0.1.2 起不预设通过的纪律，`README.md:204-205`）。
3. **四 manifest 升版 + 锚同步**：根 / `packages/host` / `packages/client-ui` / `git-bundle` 的 `package.json` `version` 同升 `0.2.0`（现为 0.1.2，实测四份同值）；根 `description` 与 `README.md` 版本锚同文（`pnpm run build` 内 fail-closed 断言，`CLAUDE.md:44`；README:4 现锚 v0.1.2 需改 v0.2.0）。
4. **tag 主通道**：推 `v0.2.0` 标签 → `release.yml`（typecheck/test/build + verify 安装矩阵 npm 列 → 仅发布 `dsh-gitkit`/`dsh-gitkit-ui` → `verify-release-tarball.mjs` 字节比对）；**不走 workflow_dispatch**（手动通道只留事故补发）。
5. **文档面收口**：capability-spec v2 增补（§1.9 方法总表 16→**44**（28 个新方法 = 9+6+7+6，D8 纳入项已计）、§1.0.5 错误码 **21→37**——v1 基线 21 = `error-codes.ts:41-69` 键集实数，16 个新码 = 6+4+3+3（branch-exists 评审修订轮定死；worktree-failed 随 [68]）；§3.1 组件表、§4 locale 组——每批已随批维护，此处为终检）；README §1 功能清单 + §5 已知限制更新（§9 对照表）；PORTING.md/NOTICE.md 新文件行（批次内已登记，终检 `tests/licenses.spec.ts` 绿）。
6. **P3 清理确认**：§10 表全部行已处置（复活或删除，无悬置）。

---

## 8. 决策点（**2026-11-08 用户已全部拍板**，下表为定案记录；落点均已写回对应节）

| # | 决策点 | 拍板结果 | 落点（已写回） |
|---|---|---|---|
| D1 | **PR 载体（[46]）** | **A：host 依赖 gh CLI**（B 无凭证/CORS 面、C 明文凭证安全倒退的否决理由保留） | §0.4-3、§6.1/§6.3/§6.5/§6.6 |
| D2 | **shell.overlay（[51]/[46] 浮层）** | **A：不注册**——批次四 spike 若命中命令面板机制则 B 永不必要；未命中且要全局快捷动作时届时再议 | §6.6 |
| D3 | **blame 大文件（[34]）** | **B：`-L` 行区间增量加载**——单次 50_000 行硬顶保留（超限 ⇒ `git/blame-oversized` 引导分片），client 按虚拟滚动窗口分片 | §4.1/§4.2/§4.3/§4.6/§4.7/§4.10 |
| D4 | **stash untracked（[14]）** | **B：默认含 untracked**——wire 显式 boolean、client 缺省传 true、UI 勾选可关 + untracked 计数提示 | §5.1/§5.2/§5.3/§5.6/§5.7 |
| D5 | **secret 拦截豁免（[22]）** | **A：secret 类硬阻断不可豁免，env-file/大文件/构建产物可 danger 勾选豁免**（`commit-blocked.details.overridable` 按 A 语义） | §5.4 |
| D6 | **自动定时 fetch（[58]）** | **B：Config `autoFetchIntervalMs` 默认 300_000 开启**（0=关；后台失败仅 `logger.warn` 不投 UI；GCM 弹窗面注记保留） | §3.1/§3.5 |
| D7 | **hunk 级 unstage（[10]）** | **B：`apply --cached -R` 反向同批做**——`stagePatch` 加 `direction` 两态，staged 区同构勾选 | §5.1/§5.2/§5.3/§5.6/§5.7 |
| D8 | **三项 prompt 候选纳入** | **纳入 v2**：清单新增 **68**（per-ticket worktree→批次一，+2 方法 +1 码）/ **69**（PR↔分支名关联→批次四，+1 方法）/ **70**（合并策略放 prompt→批次四，[46] 的 prompt 组成件，零方法零码）；分期 24→27 项 | §2/§3.1/§6.1；`docs/feature-checklist.md` 已扩 |
| D9 | **批次二/三顺序** | **保持 一→二→三→四**（历史面只读先行；对调耦合说明留档 §4.9） | §2/§4.9 |
| D10 | **已决项备案** | ① C1 维持三层（与官方样本的已知有意分歧）② v0.2.0 发布口径（§7） | 全局 |

---

## 9. v1 已知限制（README §5）在 v2 的去向

| README §5 条目 | v2 去向 |
|---|---|
| 嵌套目录角标刷新最迟 60s | **保留**——平台硬限（§0.4-6），v2 不改 |
| GCM 认证弹窗 | **保留**——`gh`（若 D1=A）引入同类提示面，README 同段补注 |
| AI 提交信息需 LLM 路由 | **保留**——PR 描述生成同路由（批次四） |
| 事件传输 = 轮询 + 写后失效 | **保留**——无事件通道（§0.4-1） |
| 单 session 单仓库 | **保留**——口径不破（§0.4-4） |
| 命令面板/全局快捷键未做（[51]） | **批次四交付或降级**（§6.6）——完成后此行改写 |
| push 真实凭证/网络失败未自动化 | **保留**——测试口径沿用本地 bare 远端 + stderr 分类器夹具；v2 新网络面（gh）同口径 |

---

## 10. P3 遗留小项归批（2026-11-07 审查遗留）

| # | 项 | 位置（已核实） | 归批 | 处置 |
|---|---|---|---|---|
| P3-1 | 死代码 `splitRows` | `packages/client-ui/src/client/diff/patch-hunks.ts:118`（仅测试消费，`diff-view.spec.ts:88-91`；src 零运行期调用） | **批次三** | [10] 行级勾选需要逐行行片——**复活**；若实现改走 host 侧补丁构造则改批次四删除（含测试），二选一在批次三收口时定案 |
| P3-2 | 死代码 `scanConflictLines` | `packages/client-ui/src/client/m13/conflict-markers.ts:51`（仅 `m13.spec.ts` 消费；`markConflictRows` 走的是 `classifyConflictLine`，`patch-hunks.ts:168`） | **批次四** | **删除**导出与对应测试行（`classifyConflictLine` 保留）；v3 冲突 UI（[13]）若需可从 git 历史找回 |
| P3-3 | 死代码 `redactTail` | `packages/client-ui/src/client/m13/redact.ts:38`（仅 `m13.spec.ts` 消费；错误面板走 `redact`，`error-map.ts:142-144`） | **批次三** | [63] hook 输出面板长输出「尾保留」显示——**复活**；若面板沿用 `redact` 则改批次四删除 |
| P3-4 | 死 locale 键 `graph.head` | `packages/client-ui/src/client/locales.ts:56`（zh）、`:178`（en）——无 `t('graph.head')` 调用 | **批次一** | zh+en 双键同删；`check:locale` + `locales.spec` 复跑 |
| P3-5 | 死 locale 键 `changes.oversized` | `locales.ts:68`（zh）、`:190`（en）——实际占位走 `diff.oversized`（`FileDiffView.tsx:54`） | **批次一** | 同上双删 |
| P3-6 | CSS token 无断言防线 | `packages/client-ui/src/client/styles/git.css`（头注约定颜色只引 `--dsw-*` token）与 `graph/graph-svg.tsx:133` 的 `var(--dsw-git-graph-head-ring, <hex>)` fallback；**tests 中零 CSS 断言**（本方案核实：tests 目录 grep `--dsw` 零命中） | **批次一** | 新增守卫测试：读取 git.css 断言零色值字面量（hex/rgb()/hsl()）且自定义属性值只引 `--dsw-*`/`--dsh-git-*` 变量；graph-svg 的 fallback hex 列入允许清单并逐个注释来源 |
| P3-7 | `ping` 零测试 | host `ping` 方法无专项测试（tests 中仅 FakeRpc 占位与 logRead 断言提及：`git-status-source.spec.ts:81`、`changes-store.spec.ts:128`、`error-codes.spec.ts:153`） | **批次一** | 补 host 测试：ping 走 readonly runner 执行 `git --version`，断言 `GitPingResult` 形状与失败路径 |
| P3-8 | `mountGitRemote` reject 无错误投影 | `packages/client-ui/src/client/index.ts:100-105`——mount effect 无 catch，`$mount` reject 直接打断 fiber，UI 不落 `statusError` | **批次四** | catch → `statusError` 投影（`gateway/service-unavailable` 同形）+ `logger.warn`；client 测试补 mount 失败路径 |
| P3-9 | a11y | 既有锚标准 = aria-keyshortcuts 四组（`loader-composition.spec.ts:99-113`）+ Modal autofocus（`:106`） | **全批次约束 + 批次四收口** | 每批新组件沿用锚标准（进各批测试计划）；批次四集中走查键盘可达 / aria-live / 焦点陷阱 |

---

## 11. 待决事项备案（审查移交，非本方案新设）

1. **C1 单包 vs 三包**：已按审查结论定案维持三层，登记为与官方 superagent 样本的已知有意分歧（书面位置：外层 `research/notes/superagent-prototype-crosscheck.md` §C1 行；官方样本单包双导出证据 §A1 行）——见 §8 D10，无返工义务。
2. **三项 prompt 候选**（per-ticket `git worktree` / PR↔分支名关联 / 合并策略放 prompt）：唯一书面记录曾 = `research/notes/superagent-prototype-crosscheck.md` §D 末行；**2026-11-08 D8 拍板纳入 v2**——清单新增 68/69/70 并排期（§2/§3.1/§6.1），分期 24→27 项；`docs/003-execution.md` 原始出处已不可考（2026-11-07 检索结论），[70] 按 §6.1 的最小可执行解释落地、施工前可修正。
3. **`DiffScope` ref-range**：审查列为 wire 缺口；经核对 v2 清单 36 仅要求提交级对比 → 默认不扩，登记为批次二条件扩展点（§4.2）——若后续要求分支级文件差异，先扩协议再施工（变更链 §1 第 1 步）。

---

## 附录 A. 本方案引用核实记录（2026-11-07 本会话实读/实跑）

**实读文件**（行号为当日快照）：
`packages/host/src/index.ts:100-179`（REMOTE_METHODS:151、Config）、`packages/host/src/types.ts` 全文（DiffScope:108、DiscardOptions:223-227、CommitOptions:229-235、CommitResult:237-248、PushOptions:250-253、LogOptions:285、FileChange.submodule:66）、`packages/host/src/error-codes.ts` 全文（RemoteErrorDetailsMap:40-70、sanitizeStderr:86-97、STDERR_PATTERNS:115-126）、`packages/host/src/graph.ts:40-190`（LOG_PRETTY_FORMAT:66、normalizeLogLimit/Skip:88-97、parseForEachRef:150-183）、`packages/host/src/remote-ops.ts:375-420`（revListCounts:388-403、requireBranch:377-385）、`packages/host/src/mutations.ts`（守卫:153-164，grep 定位）、`packages/client-ui/src/client/remote/mount.ts` 全文（GIT_NAMESPACE_METHODS:102-107、GitNamespaceFace:75-95、GitRpcFace:110-127、mountGitRemote:136-138）、`packages/client-ui/src/client/error-map.ts` 全文（ERROR_MAP:54-113）、`packages/client-ui/src/client/index.ts:85-160`（mount:100-105、tab:111-160）、`packages/client-ui/src/client/ui-model.ts`（菜单:99-107、confirmButtonEnabled:114，grep 定位）、`packages/client-ui/src/client/components/GitConfirmDialog.tsx`（danger 闸:5-16,93-97，grep 定位）、`packages/client-ui/src/client/locales.ts`（死键:56/68/178/190、键组:26-150）、`packages/client-ui/tests/loader-composition.spec.ts` 全文、`packages/client-ui/src/client/diff/patch-hunks.ts:118` / `m13/conflict-markers.ts:51` / `m13/redact.ts:38`（死代码，grep 定位）、`scripts/build-client.mjs`（EXTERNALS:32-44）、`docs/capability-spec.md`（§0.1/0.2/0.4:21-97、§2:627-676、§3.1:679-728、shell.overlay:720、命令面板:55/94）、`docs/host-capability-map.md`（shell.overlay 行:206、root 槽警告:199）、`docs/feature-checklist.md` 全文（v2 行:106、gh 注:97、多仓库口径:109）、`README.md` 全文（§5:184-201、§6:203-214、兼容段:42-71）、`CLAUDE.md` 全文、外层 `research/notes/superagent-prototype-crosscheck.md` 全文（C1:49、§D:55-64）。

**实跑命令与结论**：
1. `git log --oneline -5`（dsh-git-plugin）→ `298019b`（spec v1.3 回填）/`7b1f748`（v0.1.2 修复批）在 main。
2. `node -e` 读四份 `package.json` → 四份 `version` 均 `0.1.2`（发布升版基线）。
3. grep `splitRows|scanConflictLines|redactTail` → 三个导出仅测试消费、src 零运行期调用（P3-1/2/3 事实）。
4. grep（固定串）`t('graph.head')` / `'changes.oversized'` → 双键零调用（P3-4/5 事实）；`FileDiffView.tsx:54` 实际用 `diff.oversized`。
5. grep `-w ping` tests → ping 无专项测试（P3-7 事实）。
6. grep `--dsw` 于 tests 目录 → 零命中（P3-6 事实：CSS token 零断言）。
7. grep `mountGitRemote` src → 唯一调用点 `client/index.ts:101` 无 catch（P3-8 事实）。
8. grep `purpose` message-gen.ts → purpose 省略口径（封闭联合，`message-gen.ts:502-503`）——PR 描述生成无需扩 purpose 面。
9. `sed` `build-client.mjs` EXTERNALS → 11 项基线清单（§0.4-5 事实）。

**修订轮（2026-11-07 评审 12 条）补跑核实**：
10. `grep -c "^\s*'git/" packages/host/src/error-codes.ts` → **21**（§0.1 基线计数修正依据）；`sed -n '12,16p' docs/capability-spec.md` → v1.3 修订记录明记「§1.0.5 错误码目录 14→21……以键集为准」（`:14`）。
11. `sed -n '1,60p' scripts/verify-load.mjs` → 断言链 A–K 为**固定清单**（ping/identity/strict 判别/status/stage-commit 链/log 等，新增方法不自动覆盖）→ 各批测试计划补「verify-load 断言面扩展」条目、§3.8 加注。
12. `sed -n '60,110p' .github/workflows/release.yml` + `grep -n "check-locale\|check:locale" .github/workflows/*.yml` → 步清单 = Typecheck/Test/Build/Verify install matrix/Publish/Verify tarballs，**无 check:locale**（grep exit 1）→ §7-2 补本机补跑项。
13. `sed -n '90,96p'` / `'190,196p'` / `'388,422p'` `packages/host/src/index.ts` → `SERVICE_KEY = 'git'` 在 `:92`、`super(ctx, 'git')` 字面量在 `:194`、写方法结构 = `try{…afterWrite();return}catch{logFailure;throw}`（`afterWrite` 仅成功分支）→ §0.1 引用修正、§6.5 改双出口挂钩、§6.7 audit.spec 补失败入环用例。
14. spawn 实验（mktemp 临时目录，`node -e` spawnSync 三形态）→ `.cmd` shell:false = **EINVAL**、shell:true 可用、`process.execPath + js` 可用（node v22.21.0 win32）→ §6.10 新增假 gh 承载形态风险 + §6.7 pr.spec 改 transport 切片注入。
15. `grep` `git-runner.ts` 超时档 → `:238/:242` readonly/write 两实例同 `fastTimeoutMs`、`:246` commit 独占 → §4.5 修正 time-travel 超时档表述。

**修订轮 3（评审 2 条）补跑核实**：
16. `grep -n "施工时按 stderr 特征定\|个 + 1 处联合扩展\|4+4+3+3\|21→35"`（方案文件）→ 定位 §3.3:115 开放分支、§3.4:123 固定「4 个」、§7-5:430 固定算术 → branchCreate 重名定死为 `git/branch-exists`，§3.4/§2 总览/§7-5 三处计数同步（4→5、21→35→21→36）。
17. `grep -n "readFsFace\|readLlmFace\|ctx.get('fs')\|ctx.get('llm')"` `packages/host/src/index.ts` → `:693-733` 切片源 = 宿主能力服务 `ctx.get`（fs/llm 是宿主能力面，gh 无对应能力源——verify-load 真宿主无注入通道的前提）；`grep resolveExecutable` → `index.ts:96`（gitCommand 先例注释）+ `git-runner.ts:124/:20`（解析失败 → 域码的既有分支）→ `ghCommand` Config 走同款解析、失败落 `git/pr-tool-missing`；`sed -n '14p' docs/capability-spec.md` ⑤ 段复述同口径 → §6.3/§6.5/§6.7/§6.10 四处接通（createPr verify-load 只断负路径，成功形状留 pr.spec 单测）。

**未验证/如实登记**：`gh` CLI 非交互旗标行为未实测（批次四施工期第一个验证点，§6.10）；`shell.overlay` 注册面从未在本插件实装（仅有 dsh 树范例引用）；命令面板机制仍未在 dsh 树定位（v1 §0.4-7 未决，批次四 spike 处理）。本方案不预设任何未实跑的「门禁已过」结论。
