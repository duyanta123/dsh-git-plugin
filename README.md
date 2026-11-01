# dsh-git-plugin

dsh（DeepSeek Harness）的 **Git 插件** —— 让 dsh 会话「看清工作区改动 + 提交 + 推送 + 看提交图」。
发布版本 **v0.1.1**，由三部分组成（pnpm workspace）：

| 落点 | npm 名 | 半 | 内容（接口权威 = `docs/capability-spec.md`） |
|---|---|---|---|
| `packages/host` | `@dsh-plugin/git` | node（宿主插件） | TypertRemoteService `git` 命名空间：16 个 `@Remote` 方法（`status`/`followStatus`/`diff`/`stage`/`unstage`/`discard`/`commit`/`push`/`pull`/`fetch`/`generateCommitMessage`/`log`/`refs`/`getCommitDetail` + `ping`/`identity`），GitRunner 执行底座（四实例两套安全前缀）+ StatusEngine 刷新（fs watch / 兜底轮询 / 写后失效）+ 域码错误体系（spec §①②） |
| `packages/client-ui` | `@dsh-plugin/client-ui-git` | web（client bundle） | header 入口 + 变更审查 tab（暂存/撤销/提交对话框 + FileDiff 视图）+ 提交图 tab（自研 lane 布局纯函数 + SVG + 虚拟滚动 + 分页），HostReadStore 轮询缓存，zh/en locale（spec §③④） |
| `git-bundle` | `@dsh-plugin/git-bundle` | 发布薄包（零代码） | 单一 `file:` 安装入口：一次 `dsh plugin add` 同时挂上 host/client 两包与其 bundle 补丁层 |

v1 范围 = `docs/feature-checklist.md:105` 分期表约 35 项（用户确认边界：看清 + 提交 + 推送 + 图）；
**多仓库口径：v1 单 session 单仓库**（spec §0.2-3）；dsh 插件事件广播不可用，v1 传输 = 轮询 + 写后失效（spec §②）。

## 1. 功能清单（v1）

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

**提交图**
- 提交图 tab：自研 lane 布局（时间序 topo + 活跃泳道，教材 = pvigier 博客，自研实现）、SVG 渲染、行虚拟化、分页加载（limit+1/hasMore）、提交详情（meta + numstat + 单文件 patch）、分支/标签装饰（annotated tag peeled 命中）。

## 2. 安装（用户形态）

前提：dsh ≥ 0.2.1-rc.2、git 在 PATH（本发布在 git 2.55.0.windows.2 实测）。

```bash
# 仓库根目录执行；<repo> = 本仓库 dsh-git-plugin/ 的绝对路径
dsh plugin --profile <你的profile> add file:<repo>/git-bundle
```

一条命令完成安装：`@dsh-plugin/git-bundle` 经 `file:` 依赖把 `@dsh-plugin/git` 与
`@dsh-plugin/client-ui-git` 带进 profile（宿主 profile 用 `nodeLinker: hoisted` 平铺安装），
reconcile 自动把两层服务补丁追加进 `dsh.profile.bundles`。重启 dsh（或 patchReload）即生效，
无需重建 web 前端。

安装自检（可选，与发布门禁 verify:install 同口径）：

```bash
dsh --profile <你的profile> --dump-config | tail -5
# 期待在 `# == @dsh-plugin/git-bundle` 层下看到两行：
#   - id: dsh-plugin-git
#     name: '@dsh-plugin/git'
#   - id: dsh-plugin-client-ui-git
#     name: '@dsh-plugin/client-ui-git'
```

之后打开 dsh web：会话 header 出现 Git 入口（角标 + 变更审查 tab + 提交图 tab）。
默认工作区 = 当前 session 的 cwd；可在 profile 层补丁用 `workspaceOverride` 钉死（见 §3）。

### npm 包（@dsh-plugin/git · @dsh-plugin/client-ui-git）

两个代码包同时发布到 npm（tag 驱动：推 `v*` 标签 → GitHub Actions 门禁（typecheck/test/build）→
自动 `pnpm publish`，见 `.github/workflows/release.yml`）。npm 安装形态（适合想自行组装 profile 的用户）：

```bash
pnpm add @dsh-plugin/git @dsh-plugin/client-ui-git   # 在 profile 目录内
```

随后需在 profile 的 `cordis.patch.yml` 自行追加两行 insert（内容即 `git-bundle/cordis.patch.yml`）。
**推荐大多数用户走上面的 git-bundle 一条命令安装**——它同时完成依赖带入与补丁挂载。
`git-bundle` 本身不发 npm（其 `file:` 相对依赖无法远程解析），保持 GitHub/本地分发。

## 3. 配置（可选）

host 服务的 Config（schemastery；profile 层补丁示例）：

```yaml
- id: dsh-plugin-git
  config:
    workspaceOverride: 'D:/path/to/repo'   # 不依赖 session cwd，直接钉死工作区
    # fastTimeoutMs / commitTimeoutMs / networkTimeoutMs   # 三档超时（spec §1.0.2）
    # pollIntervalMs: 60000                # 兜底轮询间隔（嵌套目录变更靠它，见 §5）
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
pnpm --dir dsh-git-plugin test            # vitest run（29 文件 / 412 用例：解析器快照、真仓库集成、合规守卫）
pnpm --dir dsh-git-plugin run verify:load   # 全断言联调：构建 → 双包直装 → web 启动 → RPC 往返（status/commit 链路、strict 注册判别）
pnpm --dir dsh-git-plugin run verify:install  # 发布门禁：全新 DSH_HOME/profile → 单条 git-bundle 安装 → dump-config 两行 → web → status() ready → HTML 含两包
```

- `verify:load`：开发者回归（覆盖深，跑得慢，装两个包）；
- `verify:install`：发布冒烟（用户安装形态，装一个薄包；断言清单见脚本头注）。
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
  无 GCM 的环境直接得到 `git/auth-failed` 域错误（stderr 已脱敏，`packages/host/src/error-codes.ts:104`）。
- **AI 提交信息需配置 LLM 路由**：未配置 `llmProvider`/`llmModel`（且会话无模型捕获）时，
  `git/generateCommitMessage` 返回 `git/llm-route-unresolved`——端点已服务，属确定性域错误。
- **事件传输 = 轮询 + 写后失效**：dsh 对出树插件无事件广播（spec §②），变更高峰期角标
  与 tab 数据的更新粒度受轮询间隔影响。
- **v1 单 session 单仓库**：一个会话一个工作区（多 session 天然多仓库）；子模块仓库不展开。
- **命令面板/全局快捷键**未做（清单 51：宿主机制待开放，spec §0.4-7）。
- **push 真实凭证/网络失败未自动化**：sync 测试用本地 bare 远端 + stderr 分类器夹具覆盖
  （无凭证管理器，可离线确定）；真实网络路径靠 verify:load 的人工走查。

## 6. 门禁（v0.1.0 发布时实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `pnpm --dir dsh-git-plugin run typecheck` | exit 0 |
| test | `pnpm --dir dsh-git-plugin run test` | 29 文件 / 412 用例全绿 |
| build | `pnpm --dir dsh-git-plugin run build` | host typert/remote 产物 + client bundle（238 KB）+ git-bundle 一致性检查 |
| verify:install | `pnpm --dir dsh-git-plugin run verify:install` | 全新 profile 单条安装 → dump-config git/ui-git 两行 → web boot → status() ready → HTML 含两包，exit 0 |

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
