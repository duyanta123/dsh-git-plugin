# dsh-git-plugin

dsh（DeepSeek Harness）的 **Git 插件** —— 让 dsh 会话「看清工作区改动 + 提交 + 推送 + 看提交图」。
发布版本 **v0.1.2**（代码定稿；尚未打 tag/发 npm，随 V2 首版一并发布），由三部分组成（pnpm workspace）：

| 落点 | npm 名 | 半 | 内容（接口权威 = `docs/capability-spec.md`） |
|---|---|---|---|
| `packages/host` | `dsh-gitkit` | node（宿主插件） | TypertRemoteService `git` 命名空间：25 个 `@Remote` 方法（v1 十六：`status`/`followStatus`/`diff`/`stage`/`unstage`/`discard`/`commit`/`push`/`pull`/`fetch`/`generateCommitMessage`/`log`/`refs`/`getCommitDetail` + `ping`/`identity`；V2 批次一九：`branchCreate`/`branchSwitch`/`branchDelete`/`tagCreate`/`tagDelete`/`remoteList`/`worktreeList`/`worktreeAdd`/`worktreeRemove`），GitRunner 执行底座（四实例两套安全前缀）+ StatusEngine 刷新（fs watch / 兜底轮询 / 写后失效）+ 域码错误体系（spec §①②） |
| `packages/client-ui` | `dsh-gitkit-ui` | web（client bundle） | header 入口 + 变更审查 tab（暂存/撤销/提交对话框 + FileDiff 视图）+ 提交图 tab（自研 lane 布局纯函数 + SVG + 虚拟滚动 + 分页），HostReadStore 轮询缓存，zh/en locale（spec §③④） |
| `git-bundle` | `dsh-gitkit-bundle` | 发布薄包（零代码） | 单一 `file:` 安装入口：一次 `dsh plugin add` 同时挂上 host/client 两包与其 bundle 补丁层 |

v1 范围 = `docs/feature-checklist.md:105` 分期表约 35 项（用户确认边界：看清 + 提交 + 推送 + 图）；
**多仓库口径：v1 单 session 单仓库**（spec §0.2-3）；dsh 插件事件广播不可用，v1 传输 = 轮询 + 写后失效（spec §②）。

## 1. 功能清单（v1 + V2 批次一）

**看清（变更感知）**
- 工作区快照：staged / unstaged / untracked / conflicted 四类变更 + ahead/behind + 分支/HEAD 字段（含 detached、unborn 首提交前、rename、二进制、中文路径）；
- 变更角标与 header 入口自动刷新（`.git/index`/`.git/HEAD` fs watch + 150ms 防抖 + 写后失效 + ≤60s 兜底轮询）；
- 单文件 diff：worktree / staged 双路，patch 带 per-hunk 高亮与超大文件预算（`git/no-repository`、`git/diff-oversized` 等域错误可读提示）。

**暂存与撤销**
- stage / unstage（含 unborn 仓库回退 `rm --cached`）、discard（tracked/untracked 混合，unmerged 路径拒绝为 `git/git-error`）；写后 world 状态即时失效重算。

**提交**
- 提交对话框：消息编辑、amend（改 oid 保 tree）、空 staged 守卫（`git/nothing-staged`）、pre-commit hook 失败 stderr 进 details、`skipHooks` 绕过、identity 缺失 → `git/identity-missing`；
- **AI 生成提交信息**（`git/generateCommitMessage`，走 dsh LLM 路由；Conventional Commits 预检）；
- 提交并推送一步完成（失败分类见下）。

**推送与同步**
- push（含首次 `--set-upstream`）、pull、fetch（prune）；diverged 预检（`git/diverged` 带 ahead/behind）、非 ff pull 守卫（`git/pull-diverged`）、pre-receive 拒绝（`git/push-rejected`）、凭证失败分类（`git/auth-failed`，stderr 先脱敏）。
- force push：推送对话框勾选 force → `GitConfirmDialog` danger 勾选二次确认 → host `acknowledged` 守卫（置于最前、零命令执行）。**force 会覆盖远端**——force 态跳过 diverged 预检（语义即覆盖远端），误用面由「UI danger 确认 + host acknowledged」双闸承担（方案 §3.10 注记）；
- 多 remote 时由推送对话框选 remote（数据面 `remoteList`；单 remote 保持一步直推不回归）；
- 定时 fetch：`autoFetchIntervalMs`（默认 300_000 = 5 分钟，`0` = 关）到点后台 fetch，失败仅记日志不投 UI，成功走写后失效刷新 ahead/behind；
- header 菜单 push/pull/fetch 动作转真（v1 的 `sync` 占位行移除）。

**提交图**
- 提交图 tab：自研 lane 布局（时间序 topo + 活跃泳道，教材 = pvigier 博客，自研实现）、SVG 渲染、行虚拟化、分页加载（limit+1/hasMore）、提交详情（meta + numstat + 单文件 patch）、分支/标签装饰（annotated tag peeled 命中）。

**分支 · 标签 · worktree（V2 批次一）**
- 分支：新建（可勾选建后切换；存在即拒 `git/branch-exists`）、切换（header 菜单 branches 子菜单——当前分支打勾、detached 显短 oid、点击切换）、删除（未合并被 git 拒绝映射 `git/branch-not-merged`；`-D` 强删需 danger 确认双闸）；
- 标签：创建（header 菜单 / 图 tab 提交行「在此打标签」；message 非空 = annotated，`-f` 覆盖需 danger 确认；非 force 重名预检 `git/tag-exists`）、删除（图 tab tag chip 菜单）；
- worktree：列表（porcelain 解析；locked 显布尔位、unborn HEAD oid 归 null）、新增（检出已有分支或新建分支）、移除（脏 worktree 需 force + danger 确认双闸）；
- 变更纪律：命令一律带 `--` 分隔符（选项注入防线）、变更前 `rev-parse --verify` 存在性预检并域码化（`git/branch-not-found` / `git/tag-not-found` / `git/worktree-failed` 可读提示）、变更后写后失效即时刷新。

## 2. 安装（用户形态）

前提：dsh ≥ 0.2.1-rc.5（兼容性口径见下方专段）、git 在 PATH（本发布在 git 2.55.0.windows.2 实测）。
**全新 clone 先构建再安装**：`lib/` 产物不入库，clone 后先在仓库根执行
`pnpm install --frozen-lockfile && pnpm run build`（`--frozen-lockfile` 与 ci.yml/发布门禁同口径），再跑下方安装命令。

**兼容性口径（v0.1.2 声明，engines/peer 字面值见四份 manifest）**：

- **声明下限 0.2.1-rc.5**：唯一做过逐符号**源码级对照**的已发布 dsh 版本（npm dist-tags latest；插件消费的
  API 面零差异或纯增量）——对照是静态结论；0.2.1-rc.5 真机 profile 装载实测是**发版前置门禁**，完成前不宣称「实测支持」。
- **0.2.1 线早于 rc.5 的预发布（rc.2～rc.4）明确拒绝**：未做 API 对照不放行（无 dist-tag 指向、存量极少）；
  相比 0.1.1 的「名义放行」，这是声明修正而非回归，出路 = 升级 dsh ≥ 0.2.1-rc.5。
- **两代宿主校验语义**：0.2.1 线起（rc.2 世代）宿主为 engines-first——manifest 声明 `engines.dsh` 时由它
  单独裁决（`includePrerelease:true`），peerDependencies 不参与；0.2.0 及更早为 peer-only——忽略 engines、
  按 peerDependencies 裁决，旧宿主上 **host 半拒载、UI 半照常载入**，识别特征 = 「Git 入口在、状态永远
  『检查中』、所有 git/* RPC 失败」。出路：升级 dsh ≥ 0.2.1-rc.5，或 `dsh plugin allow-version` +
  `--accept-risk` 豁免（风险自担：豁免只救 host 半装载，运行期行为未验证）。
- **0.2.2 预发布线（alpha.2/alpha.3/rc.1）须分两种语义读**：宿主校验口径（`includePrerelease:true`）下
  engines `>=0.2.1-rc.5` **匹配** 0.2.2 预发布线（这些宿主会放行装载）；npm 默认口径下 engines **不匹配**
  任何 0.2.2 预发布（semver 实测 false）——alpha 线的安装期兼容由 peer 显式 OR 式承载（`^0.2.1-rc.5 ||
  ^0.2.2-alpha.2` 在两口径下均匹配 alpha.2/alpha.3/rc.1）。其中 0.2.2-rc.1（npm next）与 0.2.2-alpha.3
  已于 2026-11-07 各完成一轮逐符号快查，**均 pass**：消费面 = grep 派生插件 host/client src 全部
  `@deepseek-ai/*` 导入（49 行 import：host 18 符号 + client 22 符号 + 6 个 type-only 模块面），两版各于系统
  临时区 `npm install` 取证后逐符号读 `lib/types/*.d.ts` 对照——插件消费的全部符号在两版均存在且形状兼容
  （含 `declare module` 合并面 RemoteErrorDetailsMap / LlmRequestPurposeMap / MessageSourceMap /
  LocaleNamespaceMap / SlotMap / cordis Context；dsh-app-boot engines-first 实证——`engines.dsh` 在场即单独
  裁决、peerDependencies 不参与，semver.satisfies('0.2.2-rc.1', '>=0.2.1-rc.5', {includePrerelease:true})
  实测 true）。**未验证缺口（如实登记，不据此宣称运行期覆盖）**：① web shell 运行期注入面未证实——npm
  产物无 PLATFORM_MODULES 静态表，dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives 三包
  不在 dsh 元包依赖树内（符号已从 registry 单装同版验证存在且同形），「运行期由 shell 提供这三包」未验证；
  ② 未对插件跑对两版的整体 tsc 编译（`declare module` 合并兼容性系读两侧声明判定，非编译验证）；③ 插件
  自生成的 `packages/typert-protocol` 再导出符号未普查（在 grep 派生范围外）。升级出路：0.2.2 线装载判定按
  engines-first 放行，但运行期兼容的实测基准仍只有 0.2.1-rc.5——缺口证伪时出路 = 回退声明下限
  0.2.1-rc.5，并以 verify 矩阵真机列复验后再放开。
- **engines 不被 0.1.x 强制（上游缺口，如实登记）**：0.1.x 宿主不读 `engines.dsh`（已实证），声明收紧
  对它们没有运行时强制力——低于下限的旧宿主可能静默装上插件、在装载期才拒载，只能靠本段口径自律。

```bash
# 仓库根目录执行；<repo> = 本仓库 dsh-git-plugin/ 的绝对路径
dsh plugin --profile <你的profile> add file:<repo>/git-bundle
```

一条命令完成安装：`dsh-gitkit-bundle` 经 `file:` 依赖把 `dsh-gitkit` 与
`dsh-gitkit-ui` 带进 profile（宿主 profile 用 `nodeLinker: hoisted` 平铺安装），
reconcile 自动把两层服务补丁追加进 `dsh.profile.bundles`。重启 dsh（或 patchReload）即生效，
无需重建 web 前端。

> **⚠️ file: 安装会把源目录绝对路径钉进 profile**：`file:<绝对路径>/git-bundle` 会被**原样**写进 profile 的
> `package.json` 与 `pnpm-lock.yaml`（dsh 只对 `./`、`../` 开头的相对 spec 做锚定），而 pnpm 在该 profile 内的
> 任何包操作（add/remove/install）都会整份重新解析这些依赖——**源目录一旦移动/重命名/删除，整个 profile 的
> 包操作都会失败（含卸载本插件本身）**。出路：① 移动/删除源目录前先
> `dsh plugin --profile <你的profile> remove dsh-gitkit-bundle`；② 目录已丢失的手动救援——编辑 profile 的
> `package.json` 删掉 `dsh-gitkit-bundle` 条目、删除 profile 的 `pnpm-lock.yaml`、在 profile 目录内
> `pnpm install`（或直接重开一个干净 profile）；③ 不想被绑定到源目录的用户走下方 npm 形态
> （registry 依赖只钉版本号、不钉路径）。

安装自检（可选，与发布门禁 verify:install 同口径）：

```bash
dsh --profile <你的profile> --dump-config | tail -5
# 期待看到两行——判据是全文出现以下两行，不要求层标签在场
# （部分宿主版本的 dump-config 输出不带 `# == dsh-gitkit-bundle` 层标签前缀）：
#   - id: dsh-plugin-git
#     name: 'dsh-gitkit'
#   - id: dsh-plugin-client-ui-git
#     name: 'dsh-gitkit-ui'
```

之后打开 dsh web：会话 header 出现 Git 入口（角标 + 变更审查 tab + 提交图 tab）。
默认工作区 = 当前 session 的 cwd；可在 profile 层补丁用 `workspaceOverride` 钉死（见 §3）。

### npm 包（dsh-gitkit · dsh-gitkit-ui）

两个代码包同时发布到 npm（tag 驱动：推 `v*` 标签 → GitHub Actions 门禁（typecheck/test/build + verify
安装矩阵 npm 列）→ 自动 `pnpm publish`，见 `.github/workflows/release.yml`）。**发布锚定**：tag
`v<version>`、四 manifest `version`、根 description 与本 README 的版本号在 push CI 构建门禁中断言同值；
`workflow_dispatch` 手动补发通道自带 fail-closed 锚定步——host/client 清单版本必须相等、tag `v<version>`
必须存在且解析到本次 checkout 的 commit，否则拒发（Publish 不执行）。历史注记（如实）：npm 上的 0.1.1
是锚定恢复前的唯一例外——它自 main HEAD 提交 266d1cf 经手动通道发布，与 tag `v0.1.1` 内容不一致
（tag 版 host `files` 缺 `lib/*.d.ts`、client-ui devDependencies 为本机绝对路径）；0.1.2 起
恢复『已发布 == 已打 tag』。npm 安装形态（适合想自行组装 profile 的用户）：

```bash
pnpm add dsh-gitkit dsh-gitkit-ui   # 在 profile 目录内
```

随后需在 profile 的 `cordis.patch.yml` 自行追加两行 insert（内容即 `git-bundle/cordis.patch.yml`）。
**推荐大多数用户走上面的 git-bundle 一条命令安装**——它同时完成依赖带入与补丁挂载；不想被 file:
把源目录路径钉进 profile 的用户也优先选 npm 形态（registry 依赖只钉版本号、不钉路径，见上方警示块）。
`git-bundle` 本身不发 npm（其 `file:` 相对依赖无法远程解析），保持 GitHub/本地分发。

## 3. 配置（可选）

host 服务的 Config（schemastery；profile 层补丁示例）：

```yaml
- id: dsh-plugin-git
  config:
    workspaceOverride: 'D:/path/to/repo'   # 不依赖 session cwd，直接钉死工作区
    # fastTimeoutMs / commitTimeoutMs / networkTimeoutMs   # 三档超时（spec §1.0.2）
    # pollIntervalMs: 60000                # 兜底轮询间隔（嵌套目录变更靠它，见 §5）
    # autoFetchIntervalMs: 300000          # 定时 fetch 间隔（0=关，默认 5 分钟，见 §1 推送与同步）
    # llmProvider / llmModel               # AI 提交信息的 LLM 路由（缺省 ⇒ git/llm-route-unresolved）
```

## 4. 开发调试

工具链（本机实测）：Node v22.21.0（dsh 树自身要求 ≥24.9.0，但宿主启动与插件装载在 node 22
实测可用）、pnpm 11.8.0、git 2.55.0.windows.2。dsh 源码树默认取 `D:\DeepSeekHarness`
（可用环境变量 `DSH_TREE` 改指向），**只读参照**——本仓库从不写入该树。

```bash
# 在仓库根（dsh-git-plugin 的上一级）执行：
pnpm --dir dsh-git-plugin install         # workspace 安装
pnpm --dir dsh-git-plugin run typecheck   # host tsdown 构建（含 typert 生成产物）+ 三工程 tsc
pnpm --dir dsh-git-plugin run build       # host typert/remote 产物 + client bundle + git-bundle 一致性检查
pnpm --dir dsh-git-plugin test            # vitest run（35 文件；用例数未知，实跑未记总数——解析器快照、真仓库集成、合规守卫）
pnpm --dir dsh-git-plugin run verify:load   # 全断言联调：构建 → 双包直装 → web 启动 → RPC 往返（status/commit 链路、strict 注册判别）
pnpm --dir dsh-git-plugin run verify:install  # 发布门禁（两相）：working-copy 相——全新 DSH_HOME/profile → 单条 git-bundle 安装 → dump-config 两行 → web → status() ready → HTML 含两包；clean-clone 相——git clone 本仓库（取已提交 HEAD）→ pnpm install --frozen-lockfile + build → 同一断言链
```

verify 矩阵列（`verify:install` / `verify:load` 同构消费，列解析见 `scripts/verify-target.mjs` 头注）：

```bash
node scripts/verify-install.mjs                                    # 缺省 = dev-tree 列（被测 CLI = DSH_TREE 源码入口，断言面全严格）
DSH_SPEC=@deepseek-ai/dsh@0.2.1-rc.5 node scripts/verify-install.mjs   # npm 列（npm view 探活 + 临时 prefix 安装后裸启动）
DSH_BIN=<dsh包根>/lib/bin.js node scripts/verify-install.mjs       # 现成可执行列（与 DSH_SPEC 同设 → exit 1）
```

- 退出码纪律：0=pass / 1=fail / 2=skip（npm 列 npm-cli.js 缺失或 view|install 失败且未设
  `DSH_VERIFY_ALLOW_SKIP=1`；设 ALLOW 时 exit 0 但 RESULT 行 outcome=SKIPPED-ALLOWED——skip 永不记 pass）。
  声明下限外观测列（NEGATIVE_SPECS：0.1.7-rc.2、0.2.1 线 rc.2）双结局合法、纯记录式。
- **Windows shell 语法**：`VAR=… node …` 前缀式只在 Git Bash / POSIX shell 生效。PowerShell 用
  `$env:DSH_SPEC='@deepseek-ai/dsh@0.2.1-rc.5'; node scripts/verify-install.mjs`（跑完
  `Remove-Item Env:DSH_SPEC` 清除，残留会让后续命令意外落入 npm 列）；cmd 用
  `set "DSH_SPEC=@deepseek-ai/dsh@0.2.1-rc.5" && node scripts\verify-install.mjs`。

- `verify:load`：开发者回归（覆盖深，跑得慢，装两个包）；
- `verify:install`：发布冒烟（用户安装形态，装一个薄包；**两相各一轮**——working-copy 相 + clean-clone 相，
  clone 相取已提交 HEAD、在 clone 内 `pnpm install --frozen-lockfile` + build 后走同一断言链；
  断言清单见脚本头注）。
- 两者都会创建临时 `DSH_HOME` 与夹具仓库并在结束时 taskkill 宿主进程树、删除临时目录。
- 测试范式：真实临时 git 仓库 + world 重读断言（照 dsh `workspace-changes/tests/support.ts`）。

仓库结构速览：`packages/host`（src + tests + locale + 生成的 `lib/typert.*`）、
`packages/client-ui`（src + tests + `lib/client.js` 闭包工厂 bundle）、`git-bundle/`（清单 + 补丁 + 许可三件套）、
`packages/typert-protocol`（dsh MIT npm 包未改动副本，仅构建期/类型面）、根级 `tests/`（骨架 + licenses 合规守卫）、
`NOTICE.md` / `PORTING.md`（署名与移植登记 A/B/C 级）、`THIRD_PARTY_NOTICES.md`（全文许可）。

## 5. 已知限制（v1 如实登记）

- **嵌套目录变更的角标刷新最迟 60 秒**：宿主 `ctx.fs.watch` 对仓库根是 depth:0（硬限制，
  spec §2.2）——子目录内文件的改动不产生 fs 事件，状态刷新回落到兜底轮询
  （`pollIntervalMs`，默认 60_000，`packages/host/src/watcher.ts:59`）。顶层文件与
  `.git/index`/`.git/HEAD` 变更仍是准实时（150ms 防抖）。写操作（stage/commit 等）走写后失效，不受此限。
- **GCM（Git Credential Manager）提示**：网络命令带 `GIT_TERMINAL_PROMPT=0`
  （`packages/host/src/git-runner.ts:48`）——不会在终端挂起等输入。桌面环境首次
  push/pull/fetch 私有远端时，Git Credential Manager 可能弹出认证窗口，**在弹窗里完成认证即可**；
  无 GCM 的环境直接得到 `git/auth-failed` 域错误（stderr 已脱敏，`packages/host/src/error-codes.ts:86`）。
- **AI 提交信息需配置 LLM 路由**：未配置 `llmProvider`/`llmModel`（且会话无模型捕获）时，
  `git/generateCommitMessage` 返回 `git/llm-route-unresolved`——端点已服务，属确定性域错误。
- **事件传输 = 轮询 + 写后失效**：dsh 对出树插件无事件广播（spec §②），变更高峰期角标
  与 tab 数据的更新粒度受轮询间隔影响。
- **v1 单 session 单仓库**：一个会话一个工作区（多 session 天然多仓库）；子模块仓库不展开。
- **命令面板/全局快捷键**未做（清单 51：宿主机制待开放，spec §0.4-7）。
- **push 真实凭证/网络失败未自动化**：sync 测试用本地 bare 远端 + stderr 分类器夹具覆盖
  （无凭证管理器，可离线确定）；真实网络路径靠 verify:load 的人工走查。

## 6. 门禁（v0.1.0 首发实测，此后每次发布经 release.yml 同口径复跑）

结果列为 v0.1.0 首发实测的存档口径——**0.1.2 起一律以实跑回填、不预设通过**；
release.yml 在每次 `v*` 标签发布前按同口径复跑门禁（typecheck/test/build + verify 安装矩阵 npm 列）。

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `pnpm --dir dsh-git-plugin run typecheck` | **exit 0**（2026-11-07 前置修复批实测；v0.1.0 首发 exit 0） |
| test | `pnpm --dir dsh-git-plugin run test` | **用例全过**（2026-11-07 实测；现树 30 文件 = 13 host + 15 client + 2 root；用例数未知——实跑输出未记总数） |
| build | `pnpm --dir dsh-git-plugin run build` | **exit 0**（2026-11-07 实测；client bundle 281426 bytes，`wc -c packages/client-ui/lib/client.js`——构建日志曾按字符数误记 256568；host typert/remote 产物 + git-bundle 一致性检查同跑通过） |
| check:locale | `pnpm --dir dsh-git-plugin run check:locale` | **exit 0**（2026-11-07 实测） |
| verify:install | `pnpm --dir dsh-git-plugin run verify:install` | **dev-tree 列两相 PASS=true**（working-copy 相 + clean-clone 相，2026-11-07 实测）；npm 列与现成可执行列未跑（如实标注）——两相门禁：working-copy 相（全新 profile 单条安装 → dump-config git/ui-git 两行 → web boot → status() ready → HTML 含两包）+ clean-clone 相（git clone 本仓库 → frozen-lockfile 安装 + build → 同一断言链） |

## 7. 许可

本项目以 **Apache-2.0** 分发（`Copyright 2026 dsh-git-plugin contributors`，见 `LICENSE`）。
移植/对照的第三方材料按其原许可保留署名与声明：Apache-2.0（ZCode / Codex / Cline）、
MIT（dsh / opencode / GitLens MIT 区）——全文与逐条目署名见 `THIRD_PARTY_NOTICES.md`，
行级移植登记见 `NOTICE.md` §2 与 `PORTING.md`。GitLens 专有目录（plus）、mhutchie/vscode-git-graph、
gitamine（GPL-3.0）零代码进入本仓库（`tests/licenses.spec.ts` 合规守卫断言）。

### 商业授权与联系

Apache-2.0 已授予的权利——使用、修改、再分发（**含商业用途**）——不受影响，义务仅为保留
许可文本与本 NOTICE（即"被动署名"：使用本插件的发行包里会带着这份声明与仓库链接）。
若你需要**去除/替换署名**、**闭源集成**、**优先支持或定制开发**的替代授权，或只是想告知
我们你的使用场景，欢迎联系：

**GitHub [@duyanta123](https://github.com/duyanta123) · 3351868726@qq.com**

上游第三方代码（见 `THIRD_PARTY_NOTICES.md`）按其原许可（Apache-2.0 / MIT）独立授权，
本节不收紧也不扩展其权利。
