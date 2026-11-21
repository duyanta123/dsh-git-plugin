# dsh-git-plugin V3 分期实施方案

> 日期：2026-11-11。状态：**定案（§8 决策点 DA–DF 已于 2026-11-11 按推荐选项定案，定案说明见 §8；施工随批次推进）**。
> 输入权威：`docs/feature-checklist.md:115` 的 v3 分期行 9 项（13, 28, 29, 39(消费式), 40, 41, 42, 43, 45）、
> `docs/v2-implementation-plan.md`（V2 定案与遗留接收，§10）、`CLAUDE.md` 架构契约（全文）、
> 2026-11-11 V3 前审查结论（附录 A 为本方案全部引用的当日实读/实跑记录）。
> 读者约定：本文件 self-contained——未见过方案产生过程的读者可只凭本文 + 文内 `file:line` 引用执行施工。
> v2 现状基线以 tag `v0.2.0`（f1c92f7）与 HEAD `3a662ac` 之后的 main 树为准（820 用例，2026-11-11 实跑全绿）。

---

## 0. 现状基线（v0.2.0 交付面，V3 施工的出发点）

### 0.1 RPC 面

- host 服务 `GitService extends TypertRemoteService`，serviceKey `'git'`；**44 个 `@Remote` 方法**
  （权威 = `REMOTE_METHODS`，`packages/host/src/index.ts:246`）；**37 个域错误码**
  （权威 = `RemoteErrorDetailsMap` 的 `git/*` 键集，`packages/host/src/error-codes.ts`）。
- V3 直接消费的既有件：
  - **`git/merge-conflict`** details `{ op: string; conflicted: string[]; abortable: boolean }`
    （`error-codes.ts:131`——`op` 在 V2 定为 string，正是为 V3 merge/rebase 扩展预留）；
  - **`git/operation-in-progress`** details `{ op: 'cherry-pick' | 'revert' }`（`error-codes.ts:134`）——
    V3 扩联合 `+= 'merge' | 'rebase'`；
  - **`abortOperation`**（`index.ts:1251-1273`）现只探测 `CHERRY_PICK_HEAD`/`REVERT_HEAD`
    （`time-travel.ts:50-60` 伪引用抽象）——V3 扩 `MERGE_HEAD` 与 rebase 中间态；
  - **四 runner 纪律**（`CLAUDE.md:65`）：readonly/write 同 `fastTimeoutMs`、commit 独占
    `commitTimeoutMs`、network 独占——merge/rebase 执行走 write runner（V2 time-travel 先例，
    `time-travel.ts:17-19`）；
  - **audit 双出口**（V2 批次四 `audit.ts`）：V3 全部新写方法（冲突解决/继续操作/merge/rebase/
    自动化）逐方法挂 `auditOk`/`auditFail`；
  - **status 快照 conflicted 类目**：porcelain v2 七码
    `UNMERGED_CODES = {DD, AU, UD, UA, DU, AA, UU}`（`status-parser.ts:43`），聚合进
    `snapshot.conflicted: FileChange[]`（`types.ts:101`），kind 语义 AU/UA→added、UD/DU→deleted、
    UU→modified（`status-parser.ts:423`）——冲突面板的数据源在 v1 就绪。
- client 面：三份方法清单恒等（`CLAUDE.md:59`，对账测试 `loader-composition.spec.ts`）；
  `error-map.ts` Record 穷尽约束（host 增删码即编译错）；`redaction/conflict-markers.ts`（原 `m13/`，收尾更名）的
  `classifyConflictLine`（`:26,33`）在位——diff 视图已高亮冲突标记行（`markConflictRows`，
  `patch-hunks.ts:168`）；`scanConflictLines` 已按 V2 P3-2 删除（git 历史可找回，批次一评估复活）。

### 0.2 V3 平台契约（2026-11-11 于 dsh 树 `D:\DeepSeekHarness` 两轮实读——首查 @ fcc0ad46（0.2.2-rc.1）；树更新至 e8f7b93a（0.2.2-rc.2，923 提交）后全量漂移复核，附录 A；下述条目已按 rc.2 现行树成立，rc.2 增量单列）

**① Agent 工具面（[45]）——`@deepseek-ai/dsh-tools`，正规注册通道**：
- `ctx.tools.register(definition)`：注册即自动进 system-prompt 组装（工具可见零额外接线）；
  定义含 model-facing `name/description/parameters`（统一 schema DSL 或 raw JSON Schema）、
  `output`（canonical 值 + render）与 `execute(args, exec)`；
- 政策面：`ctx.tools.guard(guard)`（单调 deny，`tools/pre-execute` 瀑布之后）、
  `tools/pre-execute` 事件（allow/deny/**ask**）、`ctx.tools.restrict(filter)`（per-agent mask）；
- 官方先例：`tool-goal` 包即「registers on `ctx.tools`」；`dsh-tool-bash/fs/todo/...` 全家都是
  现成实现范本（本地树即达，无需远端）；
- **rc.2 增量（2026-11-11 漂移复核）**：`ToolGuard` 返回类型加宽为
  `string | ToolGuardDenial | undefined`（**string 仍合法**——V3 guard 写法不受影响；可选用
  `ToolGuardDenial` 附结构化错误身份）；新增 `ToolContextUnavailableError`（工具体缺上下文
  时抛——git 工具的 workspace 未解析等场景可对齐此语义而非裸返回错误文本）；新增审批码
  `APPROVAL_REJECTED / APPROVAL_CANCELLED / APPROVAL_UNAVAILABLE`（`tools/pre-execute` ask
  的审批通道已有正式错误身份——D-γ 选项 C 的可行性增强，是否走 ask 仍以 spike 定案）。
- **可达性口径**：dsh-tools 是否挂载取决于部署组合——插件侧走**可选切片**（`ctx.get('tools')`
  结构读取，fs/llm 切片先例 `index.ts:693-733`），未挂载 ⇒ 降级不注册 + log 一次，**绝不**
  把 `tools` 加进 `static inject`（否则未挂 tools 的部署整个 git 服务拒载）；
- **零运行期依赖纪律**：工具定义用**本地最小结构接口**构造（workspace.ts 最小切片先例，
  `workspace.ts:65-74`），type-only 对齐 dsh-tools `contracts.ts` 形状；不新增 runtime dependency。

**② 会话/回合事件面（[39]-[43]）——宿主事件总线，消费先例已在产**：
- `ctx.on('session/event', (session, event) => …)`：核心事件全集见
  `packages/core/session/src/types.ts:287`（SessionEventMap）——`turn/start {turn}`、
  `turn/end {turn, reason}`（reason.kind ∈ completed/aborted/blocked/error/max-tokens/
  interrupted/forked，`:199-232`）、`user/message`（`source` 区分真人/synthetic/goal 续轮）；
  **rc.2 增量**：Session 新增批量 append API（`SessionEventInput` 辅助类型，`types.ts:485`）——
  SessionEventMap 与事件载荷形状不变，消费面零影响。
- **消费范本 = 本插件自己**：`workspace.ts:84` 构造期挂 session/event（turn/start 记忆 cwd），
  最小结构接口不依赖 dsh-session 包（`workspace.ts:65-74`）——V3 引擎照此先例扩展；
- **`workspaceChanges` 服务（[39][40][41] 消费面）**：`ctx.provide('workspaceChanges')`
  （workspace-changes `src/index.ts:120`），正式服务面
  `summary(sessionId, seq)` / `diff(sessionId, seq, index, signal)`（`src/types.ts:52-70`）；
  其产出以 **`workspace/changes` 会话事件**广播（`recorder.ts:351`，data `{turn}`）——**事件本身携带 seq**，V3 直接消费 `session/event` 中 `type === 'workspace/changes'` 的 `(sessionId, seq, turn)` 三元组建检查点索引（**字段名已按 rc.2 源码核实**：`session/src/index.ts` `createAppendEvent` 冻结事件形状 `{ type, seq, time, data }`，总线发射 `collectSessionCallbacks(…, 'session/event', …)` 签名不变——监听器收到的即 append 返回的同一冻结事件；batch append 为连续 seq，见 rc.2 增量）；
- **summary 形状**（`src/types.ts:30-39`）：`{ files: [{path, display, added, deleted, …}], total,
  added, deleted, snapshot?: {before, after} }`；diff 形状（`:30-70`）：
  `WorkspaceFileDiff = text{path, display, before, after, hunks, coarse} | binary | oversized`，
  hunk = `{oldStart, oldLines, newStart, newLines, lines: ('+'|'-'|' '前缀)[]}`——
  **即 unified diff hunk 本体**，序列化成 patch 文本可行（批次四 [39] 恢复路径的基石）。

**③ workspace-changes 的三条硬边界（V3 设计必须绕开的坑）**：
1. 快照对象写入**私有临时对象库**（`GIT_OBJECT_DIRECTORY` 指向 session 临时目录）——
   summary 暴露的 `snapshot.before/after` tree id **引用私有对象库，宿主 repo 内不可达**
   （repo 对象库只作只读 alternate）。⇒ 恢复（回滚）**只能**走 `diff()` hunks 反向应用，
   不能走「checkout 该 tree」（施工防坑注记，防止实现期走错）；
2. 摘要在 Host 内存，**Session 处置或 Host 重启即失**（README「A conversation reopened after
   a Host restart therefore has no card」）——[40][41] 的历史归因要么接受丢失要么自持久化
   （决策点 DE）；
3. 无 repo/git 时只记 file-tool 编辑（shell 编辑缺席）——归因口径的诚实边界（有 repo 时
   turn 级 git 快照 diff 全覆盖，含 shell 编辑）。

**④ 「任务」锚点候选（[42][43]）**：dsh 无一等「任务」对象。候选 = **会话**（v1 单 session
单仓库口径天然对齐）、turn、goal（`packages/goal`——每会话一个持久目标 + goal-round-driver
自动续轮，`ctx.goals`）、todo（会话级任务清单）、插件自有任务登记表。官方 superagent 样本
（见 ⑤）在插件内自建 ticket 登记表——可行但超出本插件 git 面的合理边界，列为远期（DA）。

**⑤ 官方 superagent 原型语义（出处 recover，2026-11-11 远端实读）**：
仓库单 commit `8c32a9d`（2026-10-31，此后零更新）；`docs/003-execution.md` **在树中**
（V2 方案 §11-2 的「原始出处已不可考」结论系当日漏检——勘误见 §11）。其 per-ticket 语义：
worktree 由**配置供给的 prepare 命令**在任务首次指派前自动创建（“A typical command uses
`git worktree` to create a checkout”，失败即任务失败）、PR↔任务按「分支最后一段 = 任务短名」
命名约定归属、合并决策「host 无 merge 逻辑」全靠 prompt 约束（<200 行 + 审批覆盖 + 绝不
以 agent 账号 auto-merge）。**对 V3 的意义**：[68]（V2 已交付管理面）与 [43]（V3 自动化）
的 git 机械层已随 v0.2.0 发完（`worktreeAdd`/`branchCreate` + danger 闸），V3 剩余工作是
任务锚定与自动化策略层；但 003 的「worktree 隔离」形态要求插件控制会话 cwd——本插件的
会话 cwd 由 dsh 绑定，**v0.3.0 的 [43] 只做 in-place 分支自动化**（干净边界 + 受保护分支
守卫），worktree 形态登记为远期（§8 DA 附注）。

### 0.3 平台硬约束（沿用 V2 §0.4 全表 + V3 新增两条）

1-9. 同 `docs/v2-implementation-plan.md` §0.4（无事件通道 / shell.overlay 不注册 / 单 session
单仓库 / client 单文件 bundle 零新依赖 / fs watch depth:0 / typert 禁手编 / 移植合规 /
真仓测试范式）——全表继续有效，V3 不复核不推翻；
10. **（新增）workspaceChanges 消费边界**：0.2-③ 的三条（私有对象库不可恢复 / 摘要不持久 /
无 repo 降级）——V3 批次四的全部设计与测试计划以此为前提；
11. **（新增）`ctx.tools` 可达性**：可选切片 + 降级注册，不做硬依赖（0.2-① 可达性口径）；
    verify-load 对 dsh-tools 的断言以 dev host 实际挂载情况为准（批次三 spike 先行定案，DF）。

---

## 1. 变更链 SOP（V3 修订版）

每加一个方法/域码，V2 §1 的八步链条**原样生效**（wire 类型先行 → host 方法 + REMOTE_METHODS →
build:host 生成 → client 四处同步 → 三方对账 → 域码四件套 → 文档同步 → 批次门禁），
V3 两处增补：

- **(a) 工具注册链（仅批次三）**：新工具 = `agent-tools.ts` 定义表加行 →
  `agentToolsStatus().registered` 断言面加行 →（若 readwrite 类）audit 覆盖核对 →
  测试计划各加一条；**不走 typert/`@Remote` 链**（tools 是宿主注册面，不进 wire）。
- **(b) 审计链（全部批次）**：每个新**写**方法在 `index.ts` 调用点按批次四既有模式挂
  `auditOk`/`auditFail` 双出口（V2 §6.5 纪律：只挂 afterWrite 会漏失败审计）；新只读方法
  不入审计。

---

## 2. 批次总览与顺序理由

| 批次 | 主题 | 清单条目 | 新增方法 | 新增域码 | 主要落点 |
|---|---|---|---|---|---|
| **〇** | 前置：文档归真 + 兼容快查 | （非清单项） | 0 | 0 | README/勘误/外层笔记/engines 下限快查 |
| **一** | 冲突解决 | 13 | 4 | 0（+2 reason 联合扩展） | 变更 tab 冲突面板 + abort/continue 扩展 |
| **二** | merge / rebase | 28, 29 | 2 | 0 | 新引擎 merge-rebase.ts + 图 tab 入口 |
| **三** | Agent 工具 | 45 | 1 | 0 | agent-tools.ts + tools 注册（spike 先行） |
| **四** | 检查点 · 归因 · 聚合 | 39, 40, 41 | 4 | 1（`checkpoint-unavailable`） | session-watch.ts + 变更 tab 时间线/徽标 |
| **五** | 自动化 + 发布 | 42, 43 | 1 | 0 | automation.ts + v0.3.0 发布链 |

合计：**12 个新方法（44→56）、1 个新域码（37→38）**——计数为草案定案值，批次施工中若
增删在本节回填（V2 §2 纪律）。

**顺序理由**：
1. **批次一（[13]）先行**：v2 的 cherry-pick/revert/stash-pop 已经产出 `git/merge-conflict`
   中间态——冲突解决 UI 不等 merge/rebase 就有真实服务对象；且「继续操作」的
   continue/resolve wire 一次定型后，批次二 merge/rebase 直接扩 op 联合即接入。
   （清单注记「13/29 全生态最难、建议最后做或不做」的对案：把 [13] 拆薄——批次一只做
   「逐文件解决 + 继续/放弃」的最小闭环，三方合并编辑器级 UI 不在本期口径内，见 §3.1；
   若用户偏好保守可 1↔2 对调，登记为可选重排，对调耦合 = `operation-in-progress` 联合
   扩展随批次一移至批次二。）
2. **批次二**：merge/rebase 引擎完全复用批次一的冲突底座与 V2 time-travel 守卫范式，
   零新前置。
3. **批次三（[45]）**：tools 面是全新平台面，先 spike（`ctx.tools` 在 profile bundle 的
   可达性 + dev host 挂载情况）再施工；白名单可覆盖批次二新增的 merge/rebase（若 D-γ
   选含写面）。
4. **批次四**：消费面（0.2-②③）已核实，但 [39] 回滚路径依赖 DB 拍板；UI 与轮询接入
   放在写面稳定后。
5. **批次五**：自动化依赖批次三工具面（readwrite 白名单与自动化共享护栏语义）与批次四
   的会话事件底座（session-watch.ts 先落，automation 复用其事件接线），最后收口发布
   v0.3.0。

### 批次〇：前置（不改运行时，独立提交）

1. **README:4 发布状态归真**：现文「尚未打 tag/发 npm」与事实矛盾——tag `v0.2.0` 在
   （f1c92f7）、npm `dsh-gitkit@0.2.0`/`dsh-gitkit-ui@0.2.0` 已发布（2026-11-11 `npm view`
   实核，附录 A-6）。改为如实表述（已发布 + HEAD 领先 tag 一个 release 脚本修复提交）。
2. **出处勘误**：`docs/v2-implementation-plan.md` §11-2 与 `docs/feature-checklist.md` §D8
   的「`docs/003-execution.md` 原始出处已不可考」→ 改为「已考得（远端 main `8c32a9d`
   docs/003-execution.md，2026-11-11 实读；V2 最小解释与原义的对照见本方案 §0.2-⑤）」。
3. **外层笔记入库（外层仓库动作）**：`research/notes/superagent-prototype-crosscheck.md`
   在外层工作区仍为未跟踪——它承载 D8 出处与本方案 §0.2-⑤ 的证据链，且外层其余 5 篇
   笔记均已跟踪（有 2026-10-28 工作区清空丢文档前科）。
4. **engines 下限逐符号快查**：V3 新消费面 = dsh-tools 契约（ToolDefinition/register/guard
   形状）、`workspaceChanges` 服务面、`session/event` 载荷（seq 字段）——对声明下限
   0.2.1-rc.5 跑 README 兼容段同口径快查；并按 README 兼容纪律对 0.2.2-rc.2 复跑同口径
   快查（本方案 §0.2 的零破坏结论是**静态源码比对**，不替代逐符号快查，也不替代
   verify 矩阵实测）。不过 ⇒ 抬下限或对相应批次降级，**不预设结论**。
   **快查结果回填（2026-11-12）**：两轮快查均已跑（README 兼容段同口径：临时空目录
   prefix 安装取证 + 包内 `lib/types/*.d.ts` 逐符号对照）——
   - **0.2.1-rc.5（声明下限）快查 pass、gaps 为空**：临时 prefix 安装成功（`added 28
     packages`，三包 package.json 实测 0.2.1-rc.5），三组消费面（dsh-tools 注册/守卫形状、
     workspaceChanges 服务与 diff/hunk 形状、session/event 事件键与 seq 冻结事件形状）
     逐符号在场且与 §0.2 同形或纯增量（cancel 决策等为插件可忽略超集）——无抬下限或
     降级理由；
   - **0.2.2-rc.2 快查 fail，属「目标版本未发布」型取证缺口**：三包 npm 均 E404/ETARGET
     （dist-tags `next` 停在 0.2.2-rc.1，最后发布 2026-11-04；2026-11-12 回填时 `npm view`
     复核仍 E404），0/3 包安装、0 个 d.ts 可读——安装层失败而非符号层失配；rc.2 增量
     口径（`ToolGuard` 加宽等）在 npm 产物层面暂不可验证，仅附录 A-16 静态源码比对出处；
   - **处置 = proceed**（fail 属环境/取证缺口 + 附录 A-15/16 已证 e8f7b93a（0.2.2-rc.2）
     消费面零破坏 ⇒ 不抬下限、不降级批次）：engines 下限维持 `>=0.2.1-rc.5` 不变
     （`packages/host/package.json:52` 现值即此，无需改动）；§0.2 零破坏系静态比对，
     **不得宣称「rc.2 兼容已证」**——待三包发布 0.2.2-rc.2 后原样复跑同口径快查
     （批次五发布门禁 npm 列复跑兜底）；rc.2 增量身份（`ToolGuardDenial` /
     `ToolContextUnavailableError` / `APPROVAL_*`）在 0.2.1-rc.5 下限路径不得引用
     （ask 通道须特性探测或另议抬下限）；0.2.1-rc.5 真机 profile 装载实测仍是发版前置
     门禁（README 口径）。
   - 附（rc.5 取证尾注，原文截断）：请所有者处理 C:\Users\duyan 下被本次取证牵出的孤儿
     （取证临时目录为 Temp\dsh-compat-rc5-jUjv）——清理类动作，不影响本结论。
5. **dsh 树版本锚复验**：能力地图（`host-capability-map.md`）口径停 @ alpha.2——2026-11-11
   本方案两轮实读（fcc0ad46 → e8f7b93a 漂移复核，附录 A-15/16）已覆盖 V3 所涉契约；此步
   剩余义务 = 施工前 `git log -1` 例行复核树锚（§5.6 纪律），无额外工作。

---

## 3. 批次一：冲突解决（[13]）

### 3.1 范围拆解

| 清单号 | 内容 | v3 交付形态 |
|---|---|---|
| 13 | 冲突三方解决（保留双方 / 手动编辑） | **逐文件两向解决**：conflictList（七码结构化）+ conflictResolve（ours/theirs 命令矩阵）+ conflictMarkResolved（手动编辑后标记）+ operationContinue（继续中间态操作）/ abortOperation（既有，扩 op）。「保留双方」（逐 hunk 拼合）**不在本期**——登记为范围外（§3.10），本期以手动编辑路径覆盖 |

服务对象：v2 已产的 cherry-pick / revert / stash-pop 冲突中间态（批次二起 +merge/rebase）。

### 3.2 wire 类型（`packages/host/src/types.ts`）

- `ConflictEntry { path: string; code: 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU';
  kind: 'modified' | 'added' | 'deleted'; oursExists: boolean; theirsExists: boolean }`
  （code/kind 由冲突引擎**独立 fresh porcelain v2 扫描**得出，不走 1.5s 缓存快照——
  解决动作必须基于此刻的世界；`oursExists/theirsExists` 由 X/Y 码推导，供 UI 禁用不可向）；
- `ConflictListResult { conflicts: ConflictEntry[]; operation: 'cherry-pick' | 'revert' |
  'merge' | 'rebase' | null; abortable: boolean }`（operation = 中间态伪引用/sequencer 探测，
  null = 无中间态但工作区仍有 unmerged 路径的裸冲突）；
- `ConflictResolveOptions { choices: Array<{ path: string; resolution: 'ours' | 'theirs' }> }`、
  `ConflictResolveResult { resolved: string[] }`；
- `ConflictMarkOptions { paths: string[] }`、`ConflictMarkResult { resolved: string[] }`；
- `OperationContinueResult { op: 'cherry-pick' | 'revert' | 'merge' | 'rebase'; done: boolean;
  conflicted: string[] }`（**冲突是返回值不是错误**——client 循环驱动需要）；
- `AbortOperationResult.aborted` 联合 `+= 'merge' | 'rebase'`；
- `git/bad-request` reason 联合 `+= 'path-not-conflicted' | 'conflicts-remaining'`。

### 3.3 新增 `@Remote` 方法（4 个）

| 方法 | 守卫 | 语义 |
|---|---|---|
| `conflictList` | —（只读） | fresh porcelain v2 扫 unmerged 路径 + 中间态探测（伪引用/rebase 目录），组 ConflictEntry[] |
| `conflictResolve` | path 非 unmerged ⇒ `git/bad-request` `'path-not-conflicted'`（零写命令） | 逐条按 3.4 矩阵执行 checkout/rm + add；部分失败不回滚已成功项（逐文件语义，结果如实） |
| `conflictMarkResolved` | 同上 | 手动编辑后 `git add -- <path>`（删除侧用户已删文件 ⇒ `git rm -- <path>`——add 对缺失文件无效） |

既有方法扩展：`abortOperation` 探测面 `+= MERGE_HEAD`（`git merge --abort`）、
`.git/rebase-merge` / `.git/rebase-apply`（`git rebase --abort`）——op 联合同步扩展；
新增 `operationContinue`：

| 方法 | 守卫 | 语义 |
|---|---|---|
| `operationContinue` | 仍有 unmerged 路径 ⇒ `git/bad-request` `'conflicts-remaining'`（零命令） | cherry-pick → `git cherry-pick --continue`；revert → `git revert --continue`；merge → MERGE_HEAD 在场 ⇒ `git merge --continue`；rebase → `git rebase --continue`。**执行 env 追加 `GIT_EDITOR=true`**（防 sequencer 打开编辑器挂起——网络命令 GIT_TERMINAL_PROMPT=0 同纪律的编辑器版）；下一冲突 ⇒ `{done:false, conflicted}`；完成 ⇒ `{done:true}` |

### 3.4 解决命令矩阵（七码 × 两向，批次一测试夹具逐码覆盖）

| code | 语义（git porcelain v2） | resolution='ours' | resolution='theirs' |
|---|---|---|---|
| UU | 双方修改 | `checkout --ours -- p` + `add` | `checkout --theirs -- p` + `add` |
| AA | 双方新增 | 同 UU | 同 UU |
| AU | 我方新增 | `add`（保留我方） | `rm -- p`（接受删除） |
| UA | 对方新增 | `rm -- p` | `checkout --theirs` + `add` |
| DU | 我方删除（deleted by us——对方修改在场） | `rm -- p`（保持删除） | `checkout --theirs` + `add` |
| UD | 对方删除（deleted by them——我方修改在场） | `add`（保留我方修改） | `rm -- p` |
| DD | 双方删除 | `rm -- p`（resolution 两向同效，UI 显式确认） | 同左 |

> 实现注记：`checkout --ours/--theirs` 对 unmerged 路径操作的是 index stage（stage#2=ours、
> #3=theirs），删除侧不存在 stage ⇒ 走 `git rm`；矩阵在批次一引擎文件 `conflicts.ts`
> 内以查表实现（批次二 merge-rebase.ts 消费同一函数），**禁止在调用点散布分支**。
> UD/DU 两行按 **git porcelain v2 官方语义 + git 2.55.0.windows.2 真仓逐码实测**落表
> （UD = deleted by them ⇒ ours=修 / theirs=删；DU = deleted by us ⇒ ours=删 /
> theirs=修）——实测裁决全文见 `packages/host/src/conflicts.ts` 文件头；本表初稿曾把
> 两行语义与命令列整体标反，独立评审指认后随批回正（2026-11-12）。

### 3.5 域码

零新码（`merge-conflict`/`operation-in-progress`/`bad-request` 联合扩展即可）——
`operation-in-progress.details.op` 联合 `+= 'merge' | 'rebase'`（wire 变更链 §1 走全）。

### 3.6 host 引擎文件

- 新 `packages/host/src/conflicts.ts`：fresh 扫描 + 七码矩阵 + 中间态探测函数
  （`detectOperation()`：CHERRY_PICK_HEAD/REVERT_HEAD/MERGE_HEAD/rebase-merge|apply 目录
  ——**从 time-travel.ts 提共享**，time-travel 改为消费，行为不变，迁移后跑
  time-travel.spec 回归）。
- `index.ts`：三新方法 + abortOperation 扩展 + operationContinue；全部写方法挂审计双出口。

### 3.7 client 组件与 tab 落点（无新 tab）

- **变更 tab 顶部冲突条**（常驻入口）：`status.conflicted` 非空即显示（不依赖错误路径）——
  展示计数 + operation 徽标（「正在 cherry-pick」等）→ 展开冲突面板；
- **冲突面板**：文件列表（code/kind 徽标）→ 选中文件显示双列视图（复用既有 FileDiff 的
  staged/worktree 双路读法？**不引入新 diff 模式**——面板内提供「查看冲突 diff」跳转既有
  diff 区，冲突行高亮已由 `markConflictRows` 在位）+ ours/theirs 按钮（不可向禁用，由
  `oursExists/theirsExists` 驱动）+「我已手动编辑，标记已解决」行；
- **底部操作条**：`继续操作`（operationContinue——done:false 时刷新面板进下一冲突）、
  `放弃操作`（abortOperation——danger 勾选闸，GitConfirmDialog 既有组件）；
- **`git/merge-conflict` 错误面板**（v2 已有「放弃操作」按钮）追加「解决冲突…」入口 →
  打开冲突面板（变更 tab）。
- 键盘可达/a11y 沿用 P3-9 锚标准。
- **「查看冲突 diff」跳转：deferred 登记（2026-11-13，批次二施工时 spike 定案）**——
  spike 实测（git 2.55.0.windows.2，临时真仓 UU 冲突，复跑 host diff 引擎的 patch
  命令 `git diff --no-ext-diff --unified=3 --find-renames -- <unmerged 路径>`）：
  git 对 unmerged 路径的 patch 输出是 **combined diff**（`diff --cc` 头 +
  `@@@ -1,3 -1,3 +1,7 @@@` 三列 hunk 头 + `++`/` +` 双前缀体行），而既有
  `parsePatch` 的 `HUNK_HEADER`（`patch-hunks.ts:49`）只匹配两列 `@@ -a[,b] +c[,d] @@`
  ——同一文本喂入实测解析出 **0 个 hunk**，跳转落地后 FileDiffView 会渲染
  `diff.empty`「该文件没有文本差异」占位（对冲突文件恰是最误导的文案）。能消费的
  替代面（`--ours/--base/--theirs` stage diff、combined 专用解析渲染）均为新 diff
  模式，§3.7 明文排除。故本跳转登记 deferred：待后续引入冲突专用 diff 读法时一并
  实施；批次一冲突面板维持「逐文件 ours/theirs/手动标记」闭环不变（冲突内容在
  worktree 文件本身，用户用编辑器/合并工具处理）。

### 3.8 测试计划

- **host 真仓范式**：新 `conflicts.spec.ts`——七码夹具生成脚本（真仓制造七类 unmerged：
  双改/双增/增删/删改各组合）+ 矩阵逐格 world 重读（resolve 后 `git status --porcelain`
  断言 unmerged 清空、index 内容符合所向）；conflictList 的 operation 探测四态；手动标记
  （含删除侧 `rm` 路径）；path-not-conflicted 负路径；`operationContinue`——cherry-pick
  双提交链冲突 → resolve → continue → 第二个冲突 → resolve → continue → done:true，
  全程 world 重读（HEAD/序役器状态）；GIT_EDITOR=true 防挂起断言（超时夹具）；abort 扩展
  （merge 中间态 abort 回原 HEAD）。
- **client 纯函数范式**：新 `conflict-view.spec.ts`（冲突条可见性/矩阵→按钮可用性/
  DD 两向同效确认态/continue 循环状态机 done:false→刷新→done:true）；`error-map.spec`/
  `locales.spec` 联合扩展行；`loader-composition.spec` 自动对账 3 新方法。
- **verify-load 断言面扩展**：conflictList（真宿主 + 夹具仓制造 UU 冲突 → 断言 code/kind）、
  conflictResolve（解决后 status.conflicted 空）、operationContinue 负路径
  （conflicts-remaining）——随 §3.9 跑（前提：断言链 A–K 为固定清单，先扩再跑，V2 §3.8 注）。

### 3.9 门禁口径

四件套（typecheck/test/build/check:locale）+ `verify:load`（断言面已按 §3.8 扩展）。

### 3.10 依赖与风险

- 依赖 v2：`merge-conflict`/`operation-in-progress`/abortOperation、status conflicted 类目、
  GitConfirmDialog danger 闸、markConflictRows 冲突行高亮、audit 双出口。零跨批依赖。
- 风险：
  - **`checkout --ours/--theirs` 的 index 语义**：矩阵执行后必须 `git add` 固化——夹具断言
    必须读 index 而非仅工作区；DD/AU/UA 的 rm 分支语义以 git 2.55 实测为准（施工第一验证点）；
  - **rebase --continue 的编辑器**：`GIT_EDITOR=true` 必须进执行 env 且夹具断言不挂起
    （fastTimeoutMs 兜底存在，但超时即操作失败——挂起防护是正确性问题非性能问题）；
  - **部分成功语义**：多文件 resolve 中途失败——已执行项不回滚（git 级别也难回滚），已成功
    清单随 `git/git-error` details.resolved **如实分列**（conflicts.spec 真仓断言）；面板
    单文件提交（§3.7），部分失败在 UI 仅以错误条呈现（README §5 如实登记）——原稿
    「UI 文案明示部分成功」的面板面随独立评审定案撤销：面板单文件提交下该文案不可达
    （三选一取 (a)+(c)：host 分列进 details，UI 死文案/死函数 partialResolveView 移除）；
  - **范围外登记**：「保留双方」逐 hunk 拼合与内嵌三方编辑器不在 v0.3.0（手动编辑路径 +
    标记已解决覆盖该场景的最小可用形态）；bisect 中间态不探测不顺带处理。

---

## 4. 批次二：merge / rebase（[28][29]）

### 4.1 范围拆解

| 清单号 | 内容 | v3 交付形态 |
|---|---|---|
| 28 | merge 分支合并 | `branchMerge()`：ff 三态（auto/ff-only/no-ff）+ 冲突走批次一面板 + abort |
| 29 | rebase 变基（含冲突处理） | `rebase()`：upstream 必填 + onto 可选（非 interactive）；冲突走批次一面板 + continue 循环 + abort |

### 4.2 wire 类型

- `BranchMergeOptions { branch: string; fastForward: 'auto' | 'ff-only' | 'no-ff';
  message?: string | null; acknowledged: boolean; baseRevision: string | null }`、
  `BranchMergeResult { oldOid: string; newOid: string | null; fastForward: boolean }`；
- `RebaseOptions { upstream: string; onto?: string | null; acknowledged: boolean;
  baseRevision: string | null }`、`RebaseResult { oldOid: string; newOid: string | null;
  done: boolean }`（done 恒 true——冲突走错误路径，continue 由批次一 `operationContinue`
  驱动，rebase 引擎自身不做内循环）。

### 4.3 新增 `@Remote` 方法（2 个）

| 方法 | 守卫链（全过才执行写命令，time-travel 同款） | 语义 |
|---|---|---|
| `branchMerge` | ① acknowledged ② baseRevision 乐观并发 ③ `branch` 存在（`rev-parse --verify <rev>^{commit}` ⇒ unknown-revision——**剥 `^{commit}`**：annotated tag 经裸 rev-parse 回 tag 对象 oid（git 2.55 实测），ff 比对面必须是剥壳 commit oid，评审收口） ④ `detectOperation()` 非空 ⇒ operation-in-progress ⑤ fresh status 非干净 ⇒ `git/dirty-worktree`（从严档：git 本身允许部分脏合并，插件口径要求干净才可预测——README 如实注明） | `git merge <branch> [--ff-only|--no-ff] [-m <msg>|--no-edit]`；冲突 ⇒ `git/merge-conflict`（op `'merge'`，conflicted 回读——**`-z` 口径**：`diff --name-only --diff-filter=U -z` NUL 分隔路径原样，porcelain v2 u 记录同口径，评审收口统一；行分割口径会 C-引号化非 ASCII 路径），abortable=true；ff 场景 newOid=目标 commit oid（剥壳）、fastForward=true |
| `rebase` | 同上（⑤ 同从严档；upstream/onto 解析失败 ⇒ unknown-revision——同款剥 `^{commit}`） | `git rebase [--onto <onto>] <upstream>`（默认分支系 = 当前分支）；冲突 ⇒ `git/merge-conflict`（op `'rebase'`，conflicted 回读同款 -z 口径） |

### 4.4 域码

零新码（复用 unknown-revision / operation-in-progress / dirty-worktree / merge-conflict /
bad-request）。

### 4.5 host 引擎文件

- 新 `packages/host/src/merge-rebase.ts`：两方法 + 与批次一 `conflicts.ts` 的
  `detectOperation()` 共享（该函数批次一落位，本批消费不再迁移）；abort 扩展若批次一
  未覆盖 rebase 目录探测则本批补齐（以批次一实落为准，收口核对）。
- 执行一律 write runner（fastTimeoutMs；rebase 多提交慢场景实测超时再开独立档——照 V2
  time-travel 先例，默认不新增档位）。

### 4.6 client 组件与 tab 落点（无新 tab）

- **header 菜单直拉两行**（批次二评审收口落点回填——**实现为准**：初稿写「图 tab 分支
  选择器扩两行」，实装落在 header 菜单，V2 选择器保持既有职责不扩）：
  `GitHeaderButton` 新增「合并到当前分支…」「变基到…」两行（无候选分支整行禁用——
  无当前分支或只有当前分支自身），拉起 `GitMergeDialog`（branch picker + ff 三态单选 +
  message 编辑（no-ff 时）+ danger 确认——merge 产生合并提交是对外可见动作）与
  `GitRebaseDialog`（upstream picker + onto 可选 + danger 确认——重写历史语义）；
  候选清单与菜单行同源（`packages/client-ui/src/client/components/GitHeaderButton.tsx`
  ——mergeIntent/rebaseIntent 臂位 + 对话框挂载）；
- 冲突路径零新 UI（批次一面板直接服务，op 徽标显示 merge/rebase）；
- merge/rebase 成功后走既有写后失效刷新（R3 帧）→ graph 重载链路回归
  （keepMounted:true，V2 §3.10 先例）。

### 4.7 测试计划

- **host 真仓范式**：新 `merge-rebase.spec.ts`——merge：ff-only 可 ff 成功 / ff-only 不可 ff
  拒绝 / no-ff 产生合并提交（parents 数=2 world 重读）/ auto 两态 / 冲突 ⇒ merge-conflict
  op 'merge' + details.conflicted 回读一致 + abort 回原 HEAD / continue 链路（批次一方法
  组合）/ dirty 拒绝 / baseRevision 过期拒绝；rebase：线性三提交变基 world 重读 / onto 变基
  / 冲突 → resolve → continue 循环至 done / abort 回原 HEAD / **分支已是最新的幂等成功**
  （git up-to-date 语义——Result.done=true 不报错）/ **annotated tag 目标**（`rev-parse`
  剥 `^{commit}`：经 tag 名的 ff 合并 fastForward=true——评审收口回归用例）/ **非 ASCII
  路径冲突**（conflicted 回读 -z 口径：中文路径原样字节不 C-引号化，评审收口）。
- **client 纯函数范式**：新 `merge-dialog.spec.ts`（ff 三态→命令参数纯函数/对话框校验/
  danger 闸）；`loader-composition.spec` 对账 2 新方法。
- **verify-load 断言面扩展**：branchMerge（夹具仓 ff 合并 → world 断言）/ rebase（线性变基
  → world 断言）/ 两方法负路径（dirty / operation-in-progress）各一。

### 4.8 门禁口径

同 §3.9（断言面按 §4.7 扩展）。

### 4.9 依赖与风险

- 依赖批次一（冲突底座 + detectOperation 共享）、V2（time-travel 守卫范式、分支选择器、
  unknown-revision 码）。
- 风险：
  - **rebase 时长**：多提交大仓 rebase 可能超 fastTimeoutMs——夹具以中规模（10+ 提交）实测
    定档，超时再开独立 Config 档（不预设）；
  - **merge 从严档的口径争议**：要求干净才许 merge 比 git 原生严格——README §5 登记
    「插件口径从严」，用户可先 stash（V2 面板直达）；
  - **abort 后中间态残留**：merge --abort / rebase --abort 后 HEAD 回原位但 ORIG_HEAD 等
    残留无害——夹具断言以「HEAD 回原 + unmerged 清空」为口径，不过度断言；
  - **git am 盲区**（批次二评审收口登记，git 2.55 实测）：`git am` 停止态（补丁冲突）
    同样落 `rebase-apply` 目录——批次一 `detectOperation` 对目录在场一律分类 'rebase'，
    am 态**错标 op**。后果 fail-closed：operationContinue/abortOperation 的
    `git rebase --continue|--abort` 在 am 态 exit 128「It looks like 'git am' is in
    progress. Cannot rebase.」（git 自拒，中间态无损）；conflictList 徽标错显。插件不
    暴露 am，该态只产生于插件外手工 git am；甄别器 = `rebase-apply/applying` 标记文件
    （am 在场、rebase apply 后端不写）——后续扩 am 支持时按此分档，本批仅登记不实现。

---

## 5. 批次三：Agent 工具（[45]）

### 5.1 范围拆解

| 清单号 | 内容 | v3 交付形态 |
|---|---|---|
| 45 | Agent 工具接口：白名单 git 操作，禁止模型自己拼 shell 命令 | `ctx.tools.register` 白名单工具集（Config 三档：off/readonly/readwrite，默认 off）+ 可选 shell-git 拦截 guard（默认关）+ `agentToolsStatus()` 观测 RPC。**白名单 = 引擎层直调**（非 RPC 自调），写类工具内嵌护栏前检；「禁止拼 shell」的拦截面是可选 guard（D-γ），默认关（误报面如实登记） |

### 5.2 spike（本批第一步，结论回填本节）

1. dev host（verify-load 的 DSH_TREE 入口）是否挂载 dsh-tools（`ctx.get('tools')` 非空？）
   ——决定 verify-load 断言形态（挂载 ⇒ registered 数量断言；未挂 ⇒ toolsFaceAvailable
   false 断言 + WARN 登记，DF 决策点）；
2. ToolDefinition 形状实读（`packages/core/tools/src/contracts.ts`）——本地结构接口对齐面
   （parameters DSL 子集取 raw JSON Schema 形态最稳）；
3. `ctx.tools.register` 在 profile bundle（非 dsh 树内包）的可达性实测（最小工具注册 +
   system-prompt 出现断言或 registered 面确认）。

**spike 结论回填（2026-11-13 实读定案；证据 = `packages/host/src/agent-tools.ts:5-23`
文件头与 `scripts/verify-load.mjs:145-154` 注释）**：

1. **dev host 挂载成立**——dsh-tools 由 base bundle 透传进 web 宿主组合（verify-load
   实测 `toolsFaceAvailable=true`）；verifyForm = **assert-registered**（挂载 ⇒
   toolsFaceAvailable=true + registered 白名单面断言；未挂载部署 ⇒ WARN 登记 + 降级
   一致性断言，**绝不 fail**——其他部署的 overlay 可能不挂 tools）。
2. **ToolDefinition 形状定案**：= ToolSchema {name, description, parameters:
   Record&lt;string,unknown&gt;, deferLoading?}（llm `types.ts:517-528`）+ 强制 output:
   ToolOutputDefinition {schema: JsonSchemaNode, render(args, value), presentationMeta?}
   （`contracts.ts:17-24`）+ execute(args, exec)（`:40`）；`ctx.tools.register(definition,
   options?)` 返回撤销 disposer（`index.ts:121-153`；同层重名抛错、run_code 保留名）。
3. **raw JSON Schema 形态定案**（问 2 答案）：parameters/output.schema 直接给
   assertSupportedJsonSchema 子集（type/oneOf/properties/required/additionalProperties/
   items/enum/const + 注解；type 单字符串）；register() **不经 defineTool 编译**（零运行期
   依赖纪律禁止 import）——参数校验由本文件 execute 包装自带。实测坑：output 侧对象节点
   必须显式 `additionalProperties: boolean`、不写 required（execute 恒返回全量对象）。

### 5.3 Config 扩展（host Config schema）

- `agentTools: 'off' | 'readonly' | 'readwrite'`（默认 `'off'`——工具面默认不改变既有部署
  行为，显式开启；D-γ=A 推荐）；
- `agentToolBlockShellGit: boolean`（默认 `false`）——true 时注册 `tools/pre-execute`
  guard：对 shell 类工具（名称匹配 `bash|shell|pwsh`）的调用参数做 `git` 命令模式匹配，
  命中 ⇒ deny（reason 文案引导用 git_* 工具）。**误报面如实登记**（多行脚本/heuristic
  绕过——该 guard 是引导性防线不是安全边界，README §5 注明）。

### 5.4 工具白名单（定义表 = `agent-tools.ts` 唯一权威）

| 工具名 | 档位 | 映射引擎 | 备注 |
|---|---|---|---|
| `git_status` | readonly | status 引擎（fresh 扫描入参） | 返回 snapshot 投影（四类计数 + 文件列表裁剪——单次返回上限，超限引导缩小 path 过滤） |
| `git_diff` | readonly | diff 引擎 | path 可选；超预算 ⇒ `diff-oversized` 语义文本 |
| `git_log` | readonly | graph 引擎 | limit 钳制沿用 |
| `git_refs` | readonly | graph 引擎 parseForEachRef | — |
| `git_blame` | readonly | blame 引擎 | `-L` 区间参数透传 |
| `git_commit_detail` | readonly | graph 引擎 | — |
| `git_compare_branches` | readonly | rev-count + log | — |
| `git_repo_diagnostics` | readonly | diagnostics 引擎 | — |
| `git_stage` | readwrite | mutations 引擎 | — |
| `git_unstage` | readwrite | mutations 引擎 | — |
| `git_commit` | readwrite | commit 引擎 + **内嵌 scanStaged 前检** | secret 命中 ⇒ 拒绝（`commit-blocked` 语义文本，硬阻断不可豁免——对齐 V2 D5 / 本方案 DD）；无 staged ⇒ 拒绝 |

- 只读档 8 个、readwrite 增 3 个；**merge/rebase/cherry-pick 等高危写操作不进白名单**
  （模型经由 [42][43] 自动化或用户 UI 触发；agent 直接改写历史的口子不开——D-γ 推荐口径，
  如用户要求放开在 §8 拍板时改）；
- 工具 execute 返回**纯 JSON**（RPC 序列化纪律同源：plain object/无 Date/无 Map）；
- 工具描述（model-facing）为固定英文串（模型面非 UI 面，不进 locale——README 口径注明）；
- 审计挂点（批次三施工修正，2026-11-17 回填）：**引擎层无 audit 调用**（grep
  mutations.ts/commit.ts 无 record 实证）——工具面在 execute 内按 §6.5 双出口模式挂
  `AuditEngine.record`（op 名 = 工具名，auditOk/auditFail 双出口；`agent-tools.ts:55-63`
  文件头如实自证）；失败以工具结果文本返回（不抛宿主异常）。

### 5.5 host 引擎文件

- 新 `packages/host/src/agent-tools.ts`：定义表（结构面构造）+ `registerTools()`（可选切片
  读取 `ctx.get('tools')`，缺失 ⇒ 降级 log 一次）+ guard 注册（Config 开时）+ `ctx.effect`
  清理纪律（注册返回 disposer 撤销）；
- `index.ts`：service start 时按 Config 挂注册 effect；Config 热更触发重注册（cordis config
  reload 语义——volatile 字段豁免核对，非 volatile 改动即 fiber 重载，天然满足）；
- 新 `@Remote agentToolsStatus()` → `{ mode: 'off' | 'readonly' | 'readwrite';
  toolsFaceAvailable: boolean; registered: string[] }`（只读；观测/verify 断言锚）。

### 5.6 域码

零新码（工具内失败以结果文本表达，不抛 RemoteError——tools 管线有自己的错误结果语义）。

### 5.7 client 落点（最小面）

- header 菜单「Agent 工具」状态行（`agentToolsStatus` 拉取：off 显示关闭、on 显示
  `readonly (N tools)`）——只读展示，无操作面（工具的启停在 profile 配置层）；
- 无新 tab、无新组件文件（`admin-face.ts` 既有菜单模型加一行）。

### 5.8 测试计划

- **host 单测（fake tools face）**：新 `agent-tools.spec.ts`——三档白名单表断言（定义名集/
  parameters schema 可 JSON 化/readwrite 工具的 scanStaged 前检：secret 样本拒绝、干净
  放行）/ tools face 缺失降级（不 throw、log 一次、registered=[]）/ guard：blockShellGit
  开启时 shell 调用 deny 文案、关闭时零注册；
- **真仓集成**：git_commit 工具全链（stage → commit 经工具 → world 重读 + audit 入环）；
- **verify-load 断言面扩展**：`agentToolsStatus`——off 档 registered=[]；以 profile 补丁设
  `agentTools: 'readonly'` ⇒ registered 数量断言（toolsFaceAvailable 以 spike 结论定断言
  形态，DF）。
- **client**：`admin-view-model.spec` 扩状态行渲染模型。

### 5.9 门禁口径

同 §3.9（断言面按 §5.8 扩展）。

### 5.10 依赖与风险

- 依赖：0.2-① 契约（可选切片/结构面/零运行期依赖纪律）。
- 风险：
  - **dsh-tools 未挂载的部署**（headless/最小组合）：降级路径必须静默且可观测
    （agentToolsStatus.toolsFaceAvailable=false）；
  - **结构面漂移**：dsh-tools contracts 演进可能破坏形状对齐——快查纪律（§0 批次〇-4）
    + `registered` 断言兜底；工具注册失败（schema 校验拒绝）必须 log + 不炸服务；
  - **工具滥用面**：readwrite 档下模型可 stage/commit 任意内容——scanStaged 前检 + 审计
    是兜底；白名单不含历史改写类是边界决策（D-γ）；
  - **guard 误报**：默认关；开启后的误拦文案必须指向正确替代（git_* 工具名）。

---

## 6. 批次四：检查点 · 归因 · 聚合（[39][40][41]，消费式）

### 6.1 范围拆解

| 清单号 | 内容 | v3 交付形态 |
|---|---|---|
| 39 | 检查点 / 回滚（消费式） | **检查点 = turn 粒度**：session-watch 消费 `workspace/changes` 事件建索引；`checkpointList/checkpointDiff` 只读呈现；`checkpointRestore` = 该 turn 文件集 diff **反向应用**（DB=A 推荐）——不重建快照引擎，私有 tree id 不可恢复（0.2-③-1） |
| 40 | 变更归因（agent vs 用户） | turn 索引 × status 快照求交：turn 记录内的路径 = agent；快照内其余路径 = user；无覆盖记录 = unknown。文件卡片徽标 + 筛选 |
| 41 | 按会话/任务聚合改动 | 「会话改动时间线」折叠区（变更 tab）：turn 分组 + 每文件增删计数 + 点击看 diff（checkpointDiff）——当前会话口径（v1 单 session 单仓库不破） |

### 6.2 wire 类型

- `CheckpointEntry { sessionId: string; seq: number; turn: number; endedAt: string;
  reason: string | null; summary: { total: number; added: number; deleted: number;
  files: Array<{ path: string; added: number; deleted: number }> } | null }`（null =
  workspaceChanges 无该记录——Host 重启/Session 处置后如实呈现 unavailable，不伪造；
  **reason = turn/end 的 reason.kind**——批次四评审收口起过线（§6.6 时间线 reason 徽标
  的数据半；dsh TurnEndReasonMap 基础词汇 completed/aborted/blocked/error/max-tokens/
  interrupted/forked，merge-extensible，未知 kind 客户端原样显示；null = 尚未观察到
  turn/end））；
- `CheckpointListResult { entries: CheckpointEntry[] }`（newest-first，环容量
  Config `checkpointMaxTurns` 默认 50）；
- `CheckpointDiffOptions { seq: number; index: number; sessionId?: string | null }`、
  `CheckpointFileDiff = { kind: 'text'; path: string; display: string; before: boolean;
  after: boolean; coarse: boolean; hunks: Array<{ oldStart: number; oldLines: number;
  newStart: number; newLines: number; lines: string[] }> } | { kind: 'binary' | 'oversized';
  path: string; display: string }`（与 workspace-changes `src/types.ts:30-70` 同形投影，
  纯 JSON 安全——RPC 序列化纪律 0.1；**sessionId = 批次四评审收口的可选判别半**——seq
  是会话内序号，多会话并发下裸 seq 跨会话碰撞 ⇒ 歧义硬拒 `git/checkpoint-unavailable`；
  client 回传条目自带的 sessionId 后 host 把解析收窄到单会话环；缺席 = 维持现状口径。
  可选入参向后兼容，wire 变更链 §1 回填本节）；
- `CheckpointRestoreOptions { seq: number; paths?: string[] | null; acknowledged: boolean;
  baseRevision: string | null; sessionId?: string | null }`（paths null = 全部；sessionId
  判别半同上）、`CheckpointRestoreResult { applied: string[]; failed: Array<{ path: string;
  reason: string }> }`（逐文件部分成功语义）；
- `AttributionResult { entries: Array<{ path: string; turns: number[]; attribution:
  'agent' | 'user' | 'mixed' | 'unknown' }> }`；
- 新域码 `git/checkpoint-unavailable` details `{ seq: number }`（checkpointDiff/Restore 对
  无记录 seq 的显式拒绝——listing 侧不抛错只置 null，操作侧必须硬失败防误恢复）。

### 6.3 新增 `@Remote` 方法（4 个）

| 方法 | 守卫 | 语义 |
|---|---|---|
| `checkpointList` | —（只读） | 环内索引 → 逐条 `workspaceChanges.summary(sessionId, seq)` 补 summary（服务缺失/记录缺失 ⇒ summary null）；limit 缺省全量（受环容量钳制） |
| `checkpointDiff` | seq 不在环/summary 缺 ⇒ `git/checkpoint-unavailable`；index 越界 ⇒ `git/bad-request` | `workspaceChanges.diff(sessionId, seq, index, signal)` 投影过线 |
| `checkpointRestore` | acknowledged + baseRevision 乐观并发 + seq/paths 校验 | DB=A：逐文件取 diff → hunk 结构序列化 patch 文本（`before/after` ⇒ `/dev/null` 头）→ `git apply -R --whitespace=nowarn`（**worktree 应用**，非 --cached）；apply 失败（turn 后内容又被改）⇒ failed 列表，已成功项不回滚 |
| `attributionGet` | —（只读） | 当前 status 全路径 × turn→files 记忆映射：turn 记录命中 ⇒ 'agent'（多 turn 同路径累积 turns 列表）；快照有但零命中 ⇒ 'user'；两者皆有 ⇒ 'mixed'；无记录覆盖 ⇒ 'unknown'（重启前历史——DE=A 如实降级） |

> mixed 施工解释（批次四回填，2026-11-17）：path 粒度上「agent 与 user 皆有」无法直接判定，实现取 **mtime 近似**——文件 mtime 晚于最近命中回合的 endedAt ⇒ mixed（wire 类型注记如实）；恢复成功的文件因 mtime 更新，会在之后的 attributionGet 变 mixed——语义可接受，与 README §5 归因近似性行配套。

### 6.4 host 引擎文件

- 新 `packages/host/src/session-watch.ts`：构造期 `ctx.on('session/event')`（workspace.ts
  先例）——消费 `type === 'workspace/changes'`（取 sessionId/seq/turn 建索引）与
  `turn/end`（补 endedAt/reason）；per-session 环（Config `checkpointMaxTurns`）；
  `session/disposed` 清理（workspace-changes `src/index.ts:154` 同款）；**workspaceChanges
  服务经可选切片读取**（未挂载 ⇒ 索引照建、summary/diff 降级 null/unavailable）。
- 新 `packages/host/src/checkpoints.ts`：四方法引擎 + **hunk→patch 序列化器**（纯函数，
  独立导出供单测：text/binary/oversized/coarse/新增/删除六态夹具）。
- `GitSessionEventFace` 扩投影字段（`workspace.ts:69-71` 最小面加 `seq`/`data` 读取——
  字段名已按 rc.2 `createAppendEvent` 核实，附录 A-16）。

### 6.5 域码（1 个）

`git/checkpoint-unavailable` → `{ seq: number }`。

### 6.6 client 落点（无新 tab）

- **变更 tab「会话改动时间线」折叠区**：checkpointList 轮询接入既有 HostReadStore 模式
  （低频——打开折叠区才拉取，不做常驻轮询）；turn 分组列表（相对时间 + reason 徽标 +
  文件计数）→ 展开文件行（±计数）→ 点击看 diff（checkpointDiff → 既有 FileDiff 渲染
  结构，只读）→「恢复此回合」按钮（danger 勾选闸 + baseRevision 并发基线——discard
  三重守卫范式）；
- **文件卡片归因徽标**：agent（回合号 tooltip）/ user / mixed / unknown 四态 + 时间线区
  筛选（按归因过滤文件列表）；
- 归因/时间线的**诚实文案**：unknown 态说明「宿主重启前的回合无记录」（DE=A 口径）。

### 6.7 测试计划

- **host 单测**：新 `checkpoints.spec.ts`——hunk→patch 序列化六态夹具（新增/修改/删除/
  binary/oversized/coarse）逐态 patch 文本断言；fake session 事件流建索引（turn 乱序到达/
  session disposed 清理/环容量截断）；attribution 求交四态；
- **host 真仓集成**：checkpointRestore——真仓 + 真 diff 序列化：turn 内新增文件 → restore
  ⇒ 文件消失（world 重读）；turn 内修改 → restore ⇒ 内容回 turn 前夹具值；turn 后用户
  再改 → apply 失败 ⇒ failed 列表（部分成功）；baseRevision 过期拒绝；
- **降级路径**：workspaceChanges 缺失（face 未挂）⇒ list 空 + unavailable 码路径；
- **client 纯函数范式**：新 `checkpoint-view.spec.ts`（时间线分组/unavailable 文案状态/
  徽标四态/筛选）；`error-map.spec`/`locales.spec` 新码行；`loader-composition.spec`
  对账 4 新方法。
- **verify-load 断言面扩展**：checkpointList（真宿主跑一个 turn 后 entries≥1——夹具会话
  产生 workspace/changes 事件；若 dev host 未挂 workspace-changes ⇒ 该断言列降级 WARN
  如实登记，施工时实测定案）；checkpointDiff 负路径（unavailable）；attributionGet 形状。

### 6.8 门禁口径

同 §3.9（断言面按 §6.7 扩展）。

### 6.9 依赖与风险

- 依赖：0.2-②③ 契约（session/event、workspaceChanges 服务面、三条硬边界）、DB 拍板、
  discard 三重守卫范式、FileDiff 只读渲染。
- 风险：
  - **apply -R 正确性**（本批最高风险）：序列化器六态夹具 + 真仓端到端必须全覆盖；
    CRLF 仓库的行尾漂移场景进夹具（V2 staging-patch CRLF 先例）；失败文件列表必须可读
    （不静默跳过）；
  - **事件载荷形状**：已按 rc.2 源码核实——`createAppendEvent` 冻结事件含 `seq`/`data`、
    总线发射签名不变、batch append 连续 seq（附录 A-16）；残余风险 = 0.2.1-rc.5 声明下限
    上这些字段是否同形（批次〇-4 快查覆盖，不过 ⇒ §6.9 原降级方案回填生效）。
  - **归因近似性**：turn 内用户与 agent 交替编辑无法区分（快照是 turn 级）——徽标语义
    = 「该回合内被改动」，README 如实（这是 [40] 消费式的固有边界，不是实现缺陷）；
  - **summary 500 文件封顶**：files 可能被截（total 计数仍全）——UI 显示「共 N 文件，
    显示前 M」；**restore 侧（批次四评审收口补齐）**：restore-all 对截断记录会静默欠
    恢复（跳过的文件既不恢复也不进 failed）——fail-closed（`git/checkpoint-unavailable`
    零命令，文案带 N/M 与补救路径）；显式 paths 只能点名清单内文件，记录外路径的拒绝
    文案区分「封顶截去」与「确不在记录」；
  - **多会话 seq 碰撞**（批次四评审收口登记）：seq 是会话内序号、环跨会话持有条目——
    并发会话各自从 1 起序必然碰撞，裸 seq 的 diff/restore 歧义硬拒（fail-closed 无误
    恢复）但 [39][41] 不可用；wire 入参扩可选 sessionId 判别半（client 回传条目自带的
    sessionId，host 收窄到单会话环；缺席维持现状口径）——§6.2 已回填。

---

## 7. 批次五：自动化（[42][43]）+ 发布 v0.3.0

### 7.1 范围拆解

| 清单号 | 内容 | v3 交付形态 |
|---|---|---|
| 42 | 自动提交模式（可开关） | Config `autoCommitMode: 'off' \| 'turn-end'`（默认 off）：turn/end（reason=completed）时 `add -A` → scanStaged → commit（模板或 AI 消息 + 署名 trailer） |
| 43 | 任务自动开分支 | Config `autoBranchMode: 'off' \| 'session-start'`（默认 off）：会话首回合、当前分支 ∈ 受保护表、工作区干净 ⇒ 建切 `dsh/task-<短id>`（复用 refs-admin） |

「任务」锚定 = **会话**（DA=C 推荐：与 v1 单 session 单仓库口径天然对齐；goal/ticket
登记表为远期，§8）。turn-end 触发自动提交 + session-start 触发自动开分支的最小组合
已构成「每任务一分支、每回合一提交」的完整自动化故事。

### 7.2 Config 扩展

```
autoCommitMode:    'off' | 'turn-end'      # 默认 'off'
autoCommitMessage: 'ai' | 'template'       # 默认 'template'（ai 路由未解析 ⇒ 回落模板）
autoCommitTemplate: string                 # 默认 'chore: auto-commit session changes (turn {turn})'
autoBranchMode:    'off' | 'session-start' # 默认 'off'
autoBranchPrefix:  string                  # 默认 'dsh/task-'
autoBranchProtected: string[]              # 默认 ['main', 'master']（仅这些分支上才自动开）
```

### 7.3 host 引擎文件

- 新 `packages/host/src/automation.ts`：
  - **auto-commit**：`turn/end`（reason.kind==='completed'）→ workspace 已解析 + fresh
    status 非干净 ⇒ `git add -A` → `scanStaged`（**secret 命中 ⇒ `git reset` 全撤销 +
    audit 记录，不豁免不重试**——DD=A，对齐 V2 D5 硬阻断语义）→ commit 引擎落提交
    （消息 = 模板插值或 message-gen AI 路由（未解析/失败 ⇒ 回落模板），trailer 追加
    `Auto-committed-by: dsh-git-plugin`）→ hook 失败 = 放弃本次并 audit（不重试不改写）；
    identity-missing ⇒ 跳过 + audit；
  - **auto-branch**：`turn/start`（eligible session 判重——`GitSessionFace` 扩 `id` 投影，
    `workspace.ts:55` 最小面加字段；运行时字段存在性施工实读核对）→ 当前分支 ∈
    autoBranchProtected + fresh status **clean** ⇒ `branchCreate({name: prefix+短id,
    checkout: true})`（refs-admin 复用）；非 clean/非受保护分支 ⇒ 跳过（不阻塞会话、
    不报错）+ log；
  - **并发纪律**：自动化执行前 fresh status + detectOperation 双检，任何意外 ⇒ 跳过
    （自动化**永不向 UI 报错**——无事件通道下的诚实口径：结果经 auditLog + status 刷新
    可见，失败经 `automationStatus` 可查）；
- 新 `@Remote automationStatus()` → `{ autoCommitMode: string; autoBranchMode: string;
  lastActions: Array<{ at: string; action: string; ok: boolean; detail: string }> }`
  （环 20 条；verify 断言锚 + UI 可选展示；detail 白名单摘要——audit 同纪律不落消息正文）。

### 7.4 域码

零新码（自动化失败以 audit/lastActions 表达，不抛 RemoteError——无 UI 报错通道，
域码无处着陆）。

### 7.5 client 落点（最小面）

- header 菜单「自动化」状态行（automationStatus：两模式开关态 + 最近动作摘要 tooltip）；
  可选实现（默认仅状态行，无操作面——启停在 profile 配置层，与批次三同口径）。

### 7.6 测试计划

- **host 真仓范式**：新 `automation.spec.ts`——
  auto-commit：turn/end(completed) + 脏区 ⇒ 提交落地（world 重读 + message 模板插值 +
  trailer 断言）；secret staged 样本 ⇒ 无提交 + `git reset` 后 worktree 改动仍在 + audit
  入环；identity 缺失 ⇒ 跳过；hook 失败（夹具 hook exit 1）⇒ 放弃 + audit；aborted/error
  回合不触发；autoCommitMode off 全程零动作；
  auto-branch：受保护分支 + clean ⇒ 建切（world 重读 HEAD + 分支名前缀）；非 clean ⇒
  跳过；已在任务分支 ⇒ 不再建（判重）；`dsh/task-*` 命名冲突递增（branch-exists ⇒ 序号
  后缀——refs-admin branch-exists 消费）；
  并发：turn/end 与手工 commit 竞态（夹具先后触发）⇒ 无重复提交（fresh status 判空）。
- **client**：`admin-view-model.spec` 扩状态行；`loader-composition.spec` 对账 1 新方法。
- **verify-load 断言面扩展**：automationStatus（off 档形状断言）；autoCommitMode 开启
  profile 补丁 + 夹具 turn 完成 ⇒ 新提交出现（status ahead 变化或 log 头）——真宿主
  agent-loop 回合驱动可用性以 spike 实测为准（夹具会话能否在 verify 环境产生 completed
  turn 待确认，不可 ⇒ 降级为 status-only 断言 + 人工走查登记）。

### 7.7 发布口径：v0.3.0

沿 V2 §7 全链（四 manifest 升版 + 锚同步 / tag 主通道 / verify:install 两相 + npm 列 /
check:locale 本机补跑 / 门禁表实跑回填）+ V3 增量：

1. capability-spec v3 增补：§1.9 方法总表 44→**56**、§1.0.5 错误码 37→**38**、
   §3.1 组件表（冲突面板/时间线/徽标/工具状态行）、工具白名单表（新增 §——tools 面
   首次进 spec，含三档语义与降级口径）；
2. README §1 功能清单（五批能力行）+ §3 配置（新增 8 个 Config 键）+ §5 已知限制
   （新增：归因近似性/自动化无 UI 报错通道/guard 误报面/工具面降级）+ §6 门禁表实跑回填；
3. PORTING.md/NOTICE.md：批次一 conflicts.ts 七码矩阵若对照 codex/zode 已知实现则 C 级
   登记（预期零 A 级新增——全部自研）；
4. verify-load 断言链终检（五批扩展全绿）+ verify:install dev-tree 两相 + npm 列；
5. **CLAUDE.md 收口**（批次五评审发现项，2026-11-17 补入清单）：方法数 44→56、错误目录
   += `checkpoint-unavailable`、spec 计数 57→65（用例数以实跑回填）、仓库地图补 v3 模块
   （conflicts/merge-rebase/agent-tools/session-watch/checkpoints/automation + 对应 spec）。

### 7.8 门禁口径（批次收口 = 发布门禁全链）

四件套 + verify:load（§7.6 扩展）→ §7.7 发布链。

### 7.9 依赖与风险

- 依赖：批次三（护栏语义共享/audit/工具档位先例）、批次四（session-watch 事件接线复用）、
  V2（scanStaged/commit 引擎/message-gen/refs-admin/branch-exists）。
- 风险：
  - **自动提交竞态**：turn/end 恰逢用户手工操作——执行前 fresh status + 单飞队列
    （in-flight dedupe，status 引擎先例）；最坏情况 = 多一次空提交尝试，不会覆盖用户提交；
  - **AI 消息成本/时延**：默认 template（零 LLM 调用）；ai 档每次 completed turn 一调用，
    README 配置指引明示；
  - **auto-branch 分支蔓延**：每会话一支——README 指引配合 autoBranchProtected 收窄 +
    手动清理（分支删除 UI 已有）；
  - **自动化静默性**：失败不投 UI 是设计（无事件通道），但必须 audit + automationStatus
    双可查——测试断言覆盖两路。

---

## 8. 决策点（**定案记录**——2026-11-11 拍板定案并写回对应节，V2 §8 同格式）

> 定案说明：2026-11-11 依用户指令『根据方案完成 V3 开发』按推荐选项定案；任一批次开工前可推翻重定，推翻时同步修订受影响批次节。

| # | 决策点 | 选项 | 定案 |
|---|---|---|---|
| DA | **「任务」锚定（[42][43]）** | A=turn 粒度（每回合开分支——过碎）· B=goal（依赖 dsh goal 包部署）· **C=会话（session-start 分支 + turn-end 提交）** · D=插件自有任务登记表（superagent ticket 式——远期，超出 git 面边界） | **C** |
| DB | **[39] 回滚写路径** | **A=diff 反向应用（消费式，无持久化，恢复到 turn-start 内容）** · B=自建 WIP-commit 检查点（精确但越「不重建快照引擎」口径，且与 [42] 自动提交部分重叠） · C=只呈现不回滚（缩 [39] 范围） | **A** |
| DG | **[45] 工具档位与白名单** | **A=readonly 默认关 + readwrite 显式 Config，白名单不含历史改写类（merge/rebase/cherry-pick/reset 不进工具面）** · B=只读工具 + 自动化承担全部写面 · C=含写工具 + `tools/pre-execute` ask 对接宿主审批 UI（依赖宿主审批面形态，spike 加项） | **A** |
| DD | **[42] 自动提交护栏交互** | **A=secret 命中 ⇒ 撤销本次自动提交（reset）+ audit 记录，不可自动豁免** · B=Config 可配豁免（与 D5 硬阻断语义冲突） | **A** |
| DE | **[40] 归因持久性** | **A=内存环 + 重启丢失如实登记（unknown 态文案）** · B=插件自持久化（stateDir JSON——增持久化维护面，二期增补不阻塞本期） | **A** |
| DF | **verify 对 dsh-tools / workspaceChanges 的断言形态** | **定案（2026-11-13 spike，结论回填 §5.2）**：dev host 挂载成立（base bundle 透传 tools 行）⇒ assert-registered——toolsFaceAvailable=true + registered 白名单面断言；未挂载部署 ⇒ WARN 登记 + 降级一致性断言，**绝不 fail** | spike 定案 |

---

## 9. 已知限制（v1+V2）在 V3 的去向

| 既有条目 | V3 去向 |
|---|---|
| 嵌套目录角标刷新最迟 60s | **保留**——平台硬限；自动化/检查点的判定一律 fresh 扫描，不受此限 |
| GCM 认证弹窗 | **保留**——merge/rebase 不涉网络；工具面同口径 |
| AI 消息需 LLM 路由 | **保留 + 扩**——autoCommitMessage='ai' 同路由，未配置回落模板（§7.3） |
| 事件传输 = 轮询 + 写后失效 | **保留**——[39]-[41] UI 仍轮询（时间线低频按需拉取）；workspaceChanges 数据经新 RPC 投影 |
| 单 session 单仓库 | **保留**——[40][41] 当前会话口径；DA=C 与之一致 |
| push 真实凭证未自动化 | **保留** |
| **（新增）归因近似性** | turn 级快照无法区分回合内人机交替编辑——徽标语义 =「该回合内被改动」（§6.9） |
| **（新增）归因/摘要重启丢失** | DE=A 时 unknown 态如实呈现（§6.2） |
| **（新增）自动化无 UI 报错通道** | 无事件通道 ⇒ 失败经 audit + automationStatus 双路可查，不投 UI（§7.3） |
| **（新增）guard 误报面** | agentToolBlockShellGit 默认关；开启后是引导性防线非安全边界（§5.3） |
| **（新增）工具面降级** | dsh-tools 未挂载 ⇒ 静默不注册 + toolsFaceAvailable 可查（§5.5） |

---

## 10. V2 遗留接收

| # | 项 | V3 处置 |
|---|---|---|
| R-1 | `git/merge-conflict.details.op` 定为 string | 批次一直接受益（op 联合扩 merge/rebase 零类型变更） |
| R-2 | `git/operation-in-progress.op` 联合 `'cherry-pick'\|'revert'` | 批次一扩展 `+= 'merge'\|'rebase'`（wire 变更链走全） |
| R-3 | audit 双出口机制（批次四） | 全部新写方法逐个挂载（§1-(b)） |
| R-4 | `redaction/classifyConflictLine`（原 `m13/`，收尾更名）在位 + `scanConflictLines` 已删（P3-2） | 批次一冲突面板复用 classifyConflictLine；scanConflictLines 若需从 git 历史找回，随批次一评估（预期不需要——面板不做行级拼合） |
| R-5 | P3-1~P3-9 全表已处置（v0.2.0 收口） | 无接收义务；P3-9 a11y 锚标准继续作为全批约束 |

---

## 11. 待决事项备案

1. **出处勘误**（批次〇-2）：`docs/003-execution.md` 已考得（远端 main `8c32a9d`）——
   V2 §11-2 与 feature-checklist §D8 的「已不可考」表述随批次〇修正；V2 三项的最小解释
   与原义对照见本方案 §0.2-⑤（不构成 V2 返工义务）。
2. **engines 下限**（批次〇-4）：快查不过时的两个出路（抬下限 / 降级对应批次功能）——
   不预设，快查结果定案后回填本条。**已定案（2026-11-12）：维持 0.2.1-rc.5 不变**
   （rc.5 快查 pass；0.2.2-rc.2 未发布 E404 属取证缺口，发布后复跑——详见批次〇-4
   「快查结果回填（2026-11-12）」段）。
3. **README:4 发布状态**（批次〇-1）：随批次〇修正；v0.3.0 发布时同锚同步。
4. **外层 crosscheck 笔记入库**（批次〇-3）：外层仓库动作，非本仓库提交。
5. **v0.2.0 tag 与 HEAD 的关系**：HEAD `3a662ac`（release 脚本修复）领先 tag 一个提交，
   产物无差（脚本/CI 层修复）——v0.3.0 tag 时自然收拢，无补发动作。

---

## 附录 A. 本方案引用核实记录（2026-11-11 本会话实读/实跑）

**dsh 参照树**（`D:\DeepSeekHarness` @ fcc0ad46，0.2.2-rc.1 已合 master）：
1. `packages/core/tools/README.md` 全文——register/defineTool、conditional tools、
   executor 选择、guard（单调 deny）、`tools/pre-execute`（allow/deny/ask）、restrict；
   官方注册范式 `ctx.tools.register(defineTool({...}))`。
2. `packages/core/session/src/types.ts:199-232`（TurnEndReasonMap 全联合）、`:287-437`
   （SessionEventMap 全集：turn/start|end、step/*、user/message source 语义、tool/call、
   tool/result meta）、`:438` SessionEventType（插件可合并扩展）。
3. `packages/deliverables/workspace-changes/`——README 全文（服务面/私有临时对象库/
   非持久/无 repo 降级/turn 时序）、`src/index.ts:120`（provide 'workspaceChanges'）、
   `:145-152`（ctx.on('session/event') 消费 turn/start|end）、`:154`（session/disposed）、
   `:155`（agent/turn-stopping）、`src/types.ts:30-70`（WorkspaceFileDiff/Hunk/Summary
   形状，含 `snapshot?: {before, after}` tree id 字段与私有对象库注记）、`:106-120`
   （SessionEventMap 合并 + Context augmentation）。
4. `packages/goal/README.md`（ctx.goals / goal-round-driver / tool-goal→ctx.tools /
   command-goal→ctx.commands）、`packages/todo/README.md`（会话级任务清单）。

**插件仓库**（dsh-git-plugin @ 3a662ac）：
5. `packages/host/src/index.ts:246`（REMOTE_METHODS 44 方法全表）、`:1251-1273`
   （abortOperation 现状）；`:693-733`（fs/llm 可选切片先例）系**转引**
   `v2-implementation-plan.md` 附录 A-17（2026-11-07 核实），本会话未重读；
6. `packages/host/src/error-codes.ts:131`（merge-conflict details）、`:134-135`
   （operation-in-progress op 联合现状）；
7. `packages/host/src/time-travel.ts:1-60`（守卫链/伪引用抽象/冲突语义/执行档位头注）；
8. `packages/host/src/status-parser.ts:43`（UNMERGED_CODES 七码）、`:373-394`（conflicted
   聚合）、`:423`（kind 语义）；`types.ts:101`（snapshot.conflicted）；
9. `packages/host/src/workspace.ts:1-90`（session/event 消费先例 + GitSessionFace 最小面
   ——**现无 id 字段**，批次五扩投影）；
10. `packages/client-ui/src/client/redaction/conflict-markers.ts:26,33`（原 `m13/`，收尾更名；
    classifyConflictLine 在位）。

**实跑**：
11. `pnpm test` → 57 文件 / 820 用例全绿（2026-11-11，139.9s）；
12. `npm view dsh-gitkit version` / `npm view dsh-gitkit-ui version` → 双双 0.2.0
    （README:4「尚未打 tag/发 npm」为陈旧表述——批次〇-1 依据）；
13. `git tag` / `git log v0.2.0..HEAD` → tag 在 f1c92f7，HEAD 领先 3a662ac 一个
    release 脚本修复提交。

**远端读取**（GitHub API，未 clone，无本地字节校验）：
14. `deepseek-ai/dsh-superagent-prototype` → 单 commit `8c32a9d`（2026-10-31，无 parent，
    此后零更新）；`docs/003-execution.md` 全文（ticket→prepare 命令建 worktree / PR 按
    分支名归属 / 「host 无 merge 决策逻辑」/ <200 行 auto-merge 约束）——V2 §11-2
    「原始出处已不可考」勘误依据（出处 recover）。

**rc.2 漂移复核**（2026-11-11 第二轮；dsh 树 fcc0ad46 → e8f7b93a（0.2.2-rc.2），间隔
923 提交，逐包 `git diff/log fcc0ad46..HEAD` 实查）：
15. **V3 核心消费面零破坏**——`packages/core/session/src/types.ts` 仅新增
    `SessionEventInput` 辅助类型（SessionEventMap/turn-end reason 联合零变更）；
    `packages/deliverables/workspace-changes` 仅 package.json（版本/files）——summary/diff
    服务面零变更；`packages/typert/protocol/src` 零变更（插件 vendored 副本无恙）；
    `packages/api/remotes/src/remote-events.ts` 转发 allowlist 零变更（spec §2.1 硬约束
    不变）；`packages/fs` watch 实现零变更（depth:0 限制不变）；goal/todo/ui-slots 源面
    零实质变更（ui-slots 仅泛型默认值加宽，register 兼容）。
16. **rc.2 增量（对 V3 有利/需知）**——① tools：`ToolGuard` 返回加宽
    `string | ToolGuardDenial | undefined`（checkGuards 内部归一化，string 写法兼容）；
    新增 `ToolContextUnavailableError` 与审批码 `APPROVAL_REJECTED/CANCELLED/UNAVAILABLE`
    （ask 审批通道正式化）；`pipeline.ts` register/defineTool 语义零变更。② session：
    `createAppendEvent` 冻结事件形状 `{ type, seq, time, data }` + 总线发射
    `collectSessionCallbacks(…, 'session/event', …)` 不变——**批次四消费设计的 seq/data
    字段名核实关闭**；新增批量 append（连续 seq）。③ subprocess：
    `SubprocessExecutableNotFoundError` 迁入新 `error.ts` 并改继承 `SubprocessError`
    （仍自 index 再导出——插件 GitRunner 的导入路径与 instanceof 判定不受影响）；
    新增 `SUBPROCESS_ERROR_CODES`/`subprocessSpawnFailure`（加法）。④ zod 全树统一 4.6.6
    （插件侧 zod 为 external，不受影响）；vite 8.2.2 / rolldown 1.2.7 锚仍与 dsh lockfile
    匹配（插件 pnpm-workspace.yaml 无需同步）。

**未验证/如实登记**：session 对象 `id` 运行时字段（批次五实读核对）；dev host 对
dsh-tools / workspace-changes 的挂载情况（批次三/四 spike）；0.2.1-rc.5 与 0.2.2-rc.2 对
新消费面的逐符号快查（批次〇-4——rc.2 的零破坏结论是静态源码比对，非快查）；git 2.55 下
七码矩阵 rm/checkout 分支语义（批次一第一验证点）。本方案不预设任何未实跑的「门禁已过」
结论。
