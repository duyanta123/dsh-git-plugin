# host 批次接线史注记（自源文件头迁入）

> 2026-11-21 迁移注记：本文 §1/§2 收编 `packages/host/src/index.ts`（服务面批次接线史，
> 原 147 行文件头）与 `packages/host/src/error-codes.ts`（域码增补史，原 77 行文件头）中的
> 批次史注释，正文逐字保留（仅去掉注释行首 ` * ` 前缀）；两个源文件头各留一行指向本文。
> 迁移只动批次史段——源文件头的溯源材料原位保留（index.ts 服务形态段的 dsh 树对照引用、
> error-codes.ts 声明合并形态登记段「dsh 树 MIT —— NOTICE.md 登记」），NOTICE.md §2 /
> PORTING.md 登记面与 `/*! Ported from … */` 溯源横幅一律不动（tests/licenses.spec.ts
> PROVENANCE_RE 门禁口径）。各批次行号/方法计数以迁移时快照为准，后续演进查 git 历史
> 与 docs/v2-implementation-plan.md、docs/v3-implementation-plan.md。

## 1. 服务面批次接线史（原 packages/host/src/index.ts 文件头，2026-10-31 ~ 2026-11-18）

⑤ status 引擎模块（2026-10-31）接线：四实例 GitRunner（只读/写/提交/网络，
git-runner.ts）+ StatusEngine（status.ts）+ `@Remote status()`（spec §1.1）+
Config 超时三档（fastTimeoutMs/commitTimeoutMs/networkTimeoutMs，spec §1.0.2）。
④-C diff 引擎模块（2026-10-31）接线：DiffEngine（diff.ts）+ `@Remote diff()`
（spec §1.2，权限 A）+ Config diffFilePatchMaxBytes/diffTotalPatchMaxBytes
（spec §1.0.2 默认 262_144 / 2_097_152）。commitDiff 为 DiffEngine 引擎级方法
（show 接线模块经它取 CommitDetail 的 files/totalTruncated）。
M9 watcher/followStatus 模块（2026-10-31）接线：StatusWatcher（watcher.ts，三目标
watch + 防抖 + 轮询兜底 + 引用计数 + R1–R6）+ `@Remote({mode:'stream'})
followStatus()`（spec §2 host 推送契约的 v1 落地面——事件转发 allowlist 无 git/*，
推送以 typert stream 流帧承载；上行 `refresh` 命令 = R5 manual）+ Config
debounceMs/pollIntervalMs/watchEnabled（spec §1.0.2 默认 150/60_000/true）。
⑤ mutations/commit 模块（2026-10-31）接线：MutationEngine（mutations.ts，stage/
unstage/discard 三重守卫）+ CommitEngine（commit.ts，全守卫链/hook 分类/回读）+
`@Remote stage()/unstage()/discard()/commit()`（spec §1.3/§1.4）。写后失效统一
invalidateStatusCache()（R3 帧经 afterWrite → statusWatcher.notifyMutation()；
status/log/refs/show 的后三者在 log/refs/show 模块落地时并入此失效点）。
M6 remote-ops 模块（2026-10-31）接线：RemoteOpsEngine（remote-ops.ts，上游三态
判定/diverged 预检/stderr 脱敏分类器）+ `@Remote push()/pull()/fetch()`
（spec §1.5/§1.6；权限 push/pull C、fetch B）。
M7 message-gen 模块（2026-10-31）接线：MessageGenEngine（message-gen.ts，
nothing-staged 前置 + 裁剪四上限 + session-title-llm 六步范式）+
`@Remote generateCommitMessage()`（spec §1.7，权限 B）+ Config
llmTimeoutMs/llmProvider/llmModel/llmMaxInputBytes（spec §1.0.2 + 任务口径
硬顶）。LLM 路由捕获自挂 session/event（request/header）——与 workspace.ts
的 turn/start 监听同机制。
F7 提交图数据层模块（2026-10-31）接线：GraphEngine（graph.ts，log 分页
over-fetch/refs 单次查询/commitDetail）+ `@Remote log()/refs()/getCommitDetail()`
（spec §1.8 [清单 31/32/33]；workflow 任务口径端点名 show → getCommitDetail、
详情带 refs 过滤）+ Config logDefaultLimit/logMaxLimit（spec §1.0.2 默认
500/5_000）。host 对 log/refs/show 无缓存（spec §1.9 三行无失效列）——写后失效
由 client store 的状态订阅（branch.oid 变化 → reload）承担，afterWrite 无需接线。
v2 批次一（2026-11-08，docs/v2-implementation-plan.md §3）接线：RefsAdminEngine
（refs-admin.ts，分支/标签/remote/worktree 管理面，[清单 23/30/57/62/68]）+
`@Remote branchCreate()/branchSwitch()/branchDelete()/tagCreate()/tagDelete()/
remoteList()/worktreeList()/worktreeAdd()/worktreeRemove()`（九方法，REMOTE_METHODS
16→25）+ push 的 force/acknowledged/remote 入参（[清单 27/57]，remote-ops.ts 扩展）
+ Config autoFetchIntervalMs（[清单 58] 定时 fetch，D6=B 默认 300_000、0=关；
Cordis effect 挂 interval，失败仅 warn 不投 UI）。
v2 批次二（2026-11-08，docs/v2-implementation-plan.md §4）接线：BlameEngine
（blame.ts，[清单 34] blame --porcelain + D3=B 的 -L 区间分片与单次 50_000 行
硬顶/outputMaxBytes 互相校验）+ TimeTravelEngine（time-travel.ts，[清单 37]
cherry-pick/revert/reset/abortOperation，write runner 档 + 三重守卫 + 中间态
探测）+ GraphEngine 扩 log 过滤参数（[清单 35/60]）与 compareBranches（[清单 36]，
revListCounts 提共享 rev-count.ts）+ `@Remote blame()/compareBranches()/cherryPick()/
revert()/reset()/abortOperation()`（六方法，REMOTE_METHODS 25→31）+ 域码四码
（blame-oversized/merge-conflict/unknown-revision/operation-in-progress）+
bad-request reason += 'follow-without-path'。
v2 批次三（2026-11-08，docs/v2-implementation-plan.md §5）接线：StagingPatchEngine
（staging-patch.ts，[清单 10] `apply --cached --recount` 两态 stage/unstage——D7=B）
+ StashEngine（stash.ts，[清单 14] push/list/pop/drop——D4=B includeUntracked 显式
boolean 缺省 true）+ GuardScanEngine（guard-scan.ts，[清单 21/22] staged 护栏扫描
——密钥模式表自研零新依赖、redactedMatch 脱敏；D5=A secret 硬阻断由 CommitEngine
守卫链消费）+ DiagnosticsEngine（diagnostics.ts，[清单 56] autocrlf/eol/CRLF 抽样）
+ CommitEngine 扩 trailers（[清单 18]）与 process 捕获（[清单 63]）+ `@Remote
stagePatch()/stashPush()/stashList()/stashPop()/stashDrop()/scanStaged()/
repoDiagnostics()`（七方法，REMOTE_METHODS 31→38）+ 域码三码（stage-patch-failed/
stash-not-found/commit-blocked）+ bad-request reason += 'malformed-trailer' +
Config guardLargeFileBytes/guardBuildPatterns/guardSecretPatterns。
v2 批次四（2026-11-08，docs/v2-implementation-plan.md §6）接线：AdminRepoEngine
（admin-repo.ts，[清单 8] 非仓库目录 git init——前置 rev-parse 复核非仓库态）+
SubmoduleEngine（submodule.ts，[清单 61] `git submodule status` 只列不递归双读
归并）+ AuditEngine（audit.ts，[清单 66] 写操作审计环缓冲——**双出口挂钩**：
成功出口（logWrite 处）入环 ok:true、catch 出口（logFailure 处）入环 ok:false+code，
只挂 afterWrite 会漏全部失败审计，§6.5）+ PrEngine（pr.ts，[清单 46/69] gh CLI
载体 D1=A——ghCommand Config 经 resolveExecutable 解析（gitCommand 先例），失败
⇒ git/pr-tool-missing；transport 结构切片只在单测可达，§6.7/§6.10）+
MessageGenEngine 扩 generatePrDescription（[清单 46] 六步管线共用 dispatch +
[清单 70] 合并策略约定段——PR 模板/CONTRIBUTING/git config merge·pull 探测，
缺失即省略）+ `@Remote initRepository()/submoduleStatus()/auditLog()/
generatePrDescription()/createPr()/prForBranch()`（六方法，REMOTE_METHODS 38→44）
+ 域码三码（init-failed/pr-tool-missing/pr-create-failed）+ Config ghCommand/
auditMaxEntries。
v3 批次一（2026-11-12，docs/v3-implementation-plan.md §3）接线：ConflictsEngine
（conflicts.ts，[清单 13] 冲突解决——fresh porcelain v2 扫描 + §3.4 七码×两向命令
矩阵（查表；UD/DU 按 git 2.55 实测语义落表，与方案表格列互换的实测裁决见
conflicts.ts 文件头）+ detectOperation 中间态探测提共享）+ TimeTravelEngine 改消费
共享探测（abortOperation 探测面 += MERGE_HEAD/rebase 目录，§3.3）+ `@Remote
conflictList()/conflictResolve()/conflictMarkResolved()/operationContinue()`
（四方法，REMOTE_METHODS 44→48）+ 域码零新码（operation-in-progress op 联合 +=
'merge'|'rebase'、bad-request reason 联合 += 'path-not-conflicted'|
'conflicts-remaining'）+ operationContinue 执行 env 追加 GIT_EDITOR=true（防
sequencer 编辑器挂起）。
v3 批次二（2026-11-13，docs/v3-implementation-plan.md §4）接线：MergeRebaseEngine
（merge-rebase.ts，[清单 28/29] merge/rebase——守卫链 acknowledged / baseRevision
乐观并发 / rev-parse --verify / detectOperation（批次一共享探测，不重复实现）/
dirty-worktree 从严档（git 允许部分脏合并，插件口径要求干净才可预测，README 如实
注明）+ merge ff 三态（auto/ff-only/no-ff；-m msg|--no-edit 命令面防编辑器挂起）+
rebase [--onto] upstream（执行 env GIT_EDITOR=true）+ up-to-date 幂等成功 + 冲突 ⇒
git/merge-conflict（op 'merge'|'rebase'，conflicted 回读，continue 由批次一
operationContinue 驱动））+ `@Remote branchMerge()/rebase()`（两方法，REMOTE_METHODS
48→50）+ 域码零新码。
v3 批次三（2026-11-13，docs/v3-implementation-plan.md §5）接线：Agent 工具面
（[清单 45]）agent-tools.ts（11 工具定义表——readonly 8 + readwrite 3，plan §5.4
权威表；本地最小结构接口零运行期依赖 dsh-tools；raw JSON Schema 形态；execute
直调引擎层不走 RPC 自调；失败以 `{ok:false,error,message}` 值返回不抛宿主异常）
+ registerAgentTools 注册面（可选切片 ctx.get('tools') 结构读取——绝不进 static
inject；即时尝试 + 'internal/service' 事件跟随 + 宽限期单次降级 warn；逐工具
register 包 try/catch——schema 校验拒绝 log + 跳过不炸服务；写工具按批次四双出口
纪律挂 AuditEngine.record，op 名 = 工具名）+ agentToolBlockShellGit 引导 guard
（shell 类工具参数的 git 命令模式 deny——文案引导改用 git_* 工具；引导性防线非
安全边界，默认关）+ `@Remote agentToolsStatus()`（观测/verify 断言锚，REMOTE_METHODS
50→51）+ Config agentTools（三档，默认 off——D-γ=A）/agentToolBlockShellGit
（默认 false）。零新域码（工具内失败以结果文本表达——plan §5.6）。
v3 批次四（2026-11-14，docs/v3-implementation-plan.md §6）接线：检查点·归因·聚合
（[清单 39/40/41]，消费式）——SessionWatch（session-watch.ts，构造期挂
session/event + session/disposed，workspace.ts 先例；消费 workspace/changes 事件建
(sessionId,seq,turn) 环索引 + turn/end 补 endedAt/reason；per-session 环容量
Config checkpointMaxTurns 默认 50；事件缺 seq/turn 按降级跳过不炸监听——plan §6.9
残余风险守卫）+ CheckpointsEngine（checkpoints.ts，checkpointList/checkpointDiff/
checkpointRestore/attributionGet 四引擎 + hunk→patch 序列化器纯函数；restore =
`git apply -R --whitespace=nowarn --unidiff-zero` worktree 应用——DB=A diff hunks
反向应用，私有 tree id 绝不触碰（§0.2-③-1）；逐文件部分成功语义；--unidiff-zero
为施工增补（coarse/整文件替换 hunk 无上下文行，git apply 缺旗标即拒，probe 实测））
+ workspaceChanges 服务经可选切片 ctx.get('workspaceChanges') 读取（绝不进 static
inject——未挂载部署索引照建、summary null / 操作侧 checkpoint-unavailable 降级）
+ `@Remote checkpointList()/checkpointDiff()/checkpointRestore()/attributionGet()`
（四方法，REMOTE_METHODS 51→55）+ 域码一码（checkpoint-unavailable）+
checkpointRestore 审计双出口（checkpointDiff/Restore 的 seq 校验硬失败在引擎守卫链）。
v3 批次五（2026-11-18，docs/v3-implementation-plan.md §7）接线：自动化（[清单
42/43]，DA=C 会话锚定）——AutomationEngine（automation.ts，构造期挂 session/event
+ session/disposed——批次四 session-watch.ts 同款接线，消费 GitSessionFace.id 投影）：
auto-commit（turn/end reason.kind==='completed' + workspace 已解析 + fresh status
非干净 ⇒ add -A → scanStagedContents（secret 命中 ⇒ git reset 全撤销 + audit——
DD=A 不豁免不重试）→ CommitEngine 落提交（模板 `{turn}` 插值或 message-gen AI 路由
未解析/失败回落模板 + trailer 'Auto-committed-by: dsh-git-plugin'；hook 失败放弃
+ audit；identity-missing 跳过 + audit））+ auto-branch（turn/start per-session
判重 + 当前分支 ∈ autoBranchProtected + fresh status clean ⇒ refsAdmin.branchCreate
checkout=true，branch-exists ⇒ 序号后缀递增；非 clean/非受保护 ⇒ 跳过 + log）+
并发纪律（fresh status + detectOperation 双检 + 全局单飞；自动化永不向 UI 报错——
§7.4 零新码，结果经 auditLog + automationStatus 双可查）+ `@Remote automationStatus()`
（只读观测面，lastActions 环 20 条 newest-first，detail 白名单摘要——REMOTE_METHODS
55→56）+ Config autoCommitMode/autoCommitMessage/autoCommitTemplate/autoBranchMode/
autoBranchPrefix/autoBranchProtected 六键（默认全 off/template/['main','master']）。

## 2. 域错误码增补史（原 packages/host/src/error-codes.ts 文件头，2026-10-31 ~ 2026-11-14）

本模块新增 §1.0.5 之外的域码：`git/session-workspace-unresolved`（本模块
workspace.ts 的工作区解析失败；workflow 任务口径，spec §1.0.5 未列——见
ModuleResult.openIssues）。⑤ mutations/commit 模块（2026-10-31）续增三码
（同为 workflow 任务口径，spec §1.0.5 未列）：`git/no-paths`（stage/unstage/
discard 空路径数组）、`git/bad-request`（discard 三重守卫的守卫失败：未确认 /
baseRevision 过期 / 路由不可 discard 的路径）、`git/hook-failed`（commit 的
hook 失败分类——spec §1.4 落 git/git-error，任务口径单列以便 UI 可读展示
[清单 20/49]；details 形状与 git-error 同构）。

M6 remote-ops 模块（2026-10-31）续增三码（同为 workflow 任务口径，spec §1.0.5
未列）：`git/no-branch`（push/pull 在 detached/unborn 下的拒绝——git/no-upstream
的 hint 'set-upstream' 对该态是误导动作）、`git/dirty-worktree`（pull 前置脏区
拒绝）、`git/choose-remote`（多 remote 无默认远端——spec §1.5-1/§1.6 同场景落
git/no-remote，任务口径按「可选远端」语义单列；两者 details 同形 remotes: string[]）。

v2 批次一（2026-11-08，docs/v2-implementation-plan.md §3.4）续增六码 + 一处联合扩展：
`git/branch-not-found` / `git/branch-not-merged` / `git/branch-exists`（refs-admin.ts
的分支管理面，branch-exists 与 git/tag-exists 对称的「已存在」语义——方案评审修订轮
定死）、`git/tag-exists` / `git/tag-not-found`（tag 管理面）、`git/worktree-failed`
（[清单 68] worktree 写面专用，details.stderr 过 sanitizeStderr）；
`git/bad-request` reason 联合 `+= 'force-unacknowledged'`（方案 §3.2：force push /
`-D` 删分支 / tag `-f` 共用）与 `+= 'invalid-options'`（worktreeAdd 的 branch/
newBranch 互斥与至少其一契约的守卫面——方案 §3.2 类型注记要求该契约生效，方案未指认
承载码，取 bad-request 最贴近语义，登记为偏差）。

v2 批次二（2026-11-08，docs/v2-implementation-plan.md §4.4）续增四码 + 一处联合扩展：
`git/blame-oversized`（blame 单次 50_000 行硬顶（D3=B），details.lineCount 引导
client 转 `-L` 区间分片）、`git/merge-conflict`（cherry-pick/revert/stash-pop 类
冲突的结构化报错——details.op 定为 **string** 而非窄联合（方案 §4.4 注：批次三
stash-pop 复用此码时不再改类型），conflicted = `diff --name-only --diff-filter=U`
回读、abortable = 中间态伪引用在场）、`git/unknown-revision`（compareBranches/log/
时间旅行的修订解析失败）、`git/operation-in-progress`（时间旅行写前探测
CHERRY_PICK_HEAD/REVERT_HEAD 中间态，拒绝叠操作）；
`git/bad-request` reason 联合 `+= 'follow-without-path'`（方案 §4.2：`--follow`
仅在 path 为单路径时合法）。

v2 批次三（2026-11-08，docs/v2-implementation-plan.md §5.4）续增三码 + 一处联合扩展：
`git/stage-patch-failed`（stagePatch 的 `apply --cached` 失败/二进制·模式变更 hunk
拒绝，details.stderr 过 sanitizeStderr）、`git/stash-not-found`（stashPop/stashDrop
的序号越界与空 stash 预检）、`git/commit-blocked`（提交护栏 [21][22]：violations
过线 + overridable 按 D5=A 语义——违规集中无 secret 类才可豁免，secret 硬阻断）；
`git/bad-request` reason 联合 `+= 'malformed-trailer'`（方案 §5.2：CommitOptions
trailers 条目不合法）。

v2 批次四（2026-11-08，docs/v2-implementation-plan.md §6.4）续增三码：
`git/init-failed`（initRepository 前置复核失败——已是仓库 / `git init` 自身失败，
details.path + reason）、`git/pr-tool-missing`（gh CLI 不可用——ghCommand 解析失败
或 `gh auth status` 未过，details.tool='gh'）、`git/pr-create-failed`（gh pr
create/pr view 的 API 侧失败，details.stderr 过 sanitizeStderr）。

v3 批次一（2026-11-12，docs/v3-implementation-plan.md §3.2/§3.5）零新码 + 两处联合
扩展：`git/operation-in-progress` details.op 联合 `+= 'merge' | 'rebase'`（探测面
扩 MERGE_HEAD 与 .git/rebase-merge|rebase-apply——conflicts.ts detectOperation 提
共享）、`git/bad-request` reason 联合 `+= 'path-not-conflicted' | 'conflicts-remaining'`
（conflictResolve/conflictMarkResolved 与 operationContinue 的守卫面）。

v3 批次四（2026-11-14，docs/v3-implementation-plan.md §6.2/§6.5）续增一码：
`git/checkpoint-unavailable`（checkpointDiff/checkpointRestore 对无记录 seq 的显式
拒绝——listing 侧不抛错只置 null，操作侧硬失败防误恢复，details.seq）。
