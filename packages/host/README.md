# dsh-gitkit

dsh（DeepSeek Harness）的 **Git 插件** —— 让 dsh 会话「看清工作区改动 + 提交 + 推送 + 看提交图」。

**一个 npm 包，两面**：

| 面 | 入口 | 交付方式 | 内容 |
|---|---|---|---|
| node（宿主插件） | `lib/index.js`（`main`） | `cordis.patch.yml` 的 insert 行（`id: dsh-plugin-git`，包自带 `dsh.bundle.patch`，安装时 reconcile 自动挂载） | TypertRemoteService `git` 命名空间：status / diff / stage / commit / push / pull / fetch / log / refs / blame / stash / worktree / submodule / PR 等 RPC 服务 |
| web（client bundle） | `lib/client.js`（`exports["./client"]`） | manifest 的 `dsh.client`（`platform: web`），宿主编入 `window.__DSH_BOOT__` | 会话 header 的 Git 入口 + 变更审查 tab + 提交图 tab |

生成的 Typert 产物：`exports["./typert"]`（host 面 strict 描述符，由 dsh typert-loader 自动注册）、
`exports["./remote"]`（client 面 codec 贡献）——均由 `@deepseek-ai/dsh-typert-generator` 生成，请勿手改。
类型面：`exports["./types"]`、`exports["./errors"]`。

## 安装

```bash
# npm（0.4.0 起为单包；预发布版本用 dsh-gitkit@next）
dsh plugin --profile <你的profile> add dsh-gitkit

# 本地源码
dsh plugin --profile <你的profile> add file:<repo>/packages/host
```

要求 dsh `>=0.2.1-rc.5`（见 `engines.dsh`）。安装后重启 dsh（或 patchReload）即生效，无需重建 web 前端。

从旧双包形态迁移（profile 里装过 `dsh-gitkit-bundle` / `dsh-gitkit-ui`，即 0.3.0 及更早）：
先 `dsh plugin --profile <你的profile> remove dsh-gitkit-bundle`，再执行上面的安装命令；
`dsh --profile <你的profile> --dump-config` 应只剩一行 `id: dsh-plugin-git`。

## 配置（可选）

在 profile 层 `cordis.patch.yml` 追加（`id` 必须与 insert 行一致）：

```yaml
- id: dsh-plugin-git
  config:
    workspaceOverride: 'D:/path/to/repo'   # 可选：钉死工作区；默认取当前 session 的 cwd
```

## 更多

接口权威与完整说明见仓库根 `README.md` 与 `docs/capability-spec.md`。

许可：Apache-2.0（`LICENSE`）；署名与移植登记见 `NOTICE.md`、`THIRD_PARTY_NOTICES.md`。
