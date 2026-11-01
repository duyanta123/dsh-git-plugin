/**
 * @dsh-plugin/client-ui-git — locale 词典（spec §4；M14 首批键组）。
 *
 * 机制（map §4.4）：apply 层 `ctx.locale.register(NS, { zh, en })`，zh+en 双语齐备强制；
 * 槽注册传 `locale: NS` 组件获得类型化 `t`；词典扁平 `Record<string, string>` + `{name}`
 * 插值。**键集权威 = zh 词典**（map §3.5），`GitLocaleKey = keyof typeof gitZh` 经
 * `declare module '@deepseek-ai/dsh-client-ui-slots'` 合并进 LocaleNamespaceMap（本文件
 * 底部——放置于同文件保证键集与类型声明单点同步）。
 *
 * 首批键组（M14 ask §⑤ + F 变更面板模块 ask §⑥）：header / errors(+common) / confirm /
 * problems / shortcut / menu / tab，另含 C1 菜单标签所需的 menu 组与两个右栏 tab 定义
 * 标题所需的 tab 组（spec §3.1 `title: () => t('tab.changes.title')` 的键）；F 变更
 * 面板模块补齐 spec §4 的 changes 键组（种子全集）与 diff 键组（FileDiffView 占位/
 * 注记）。en/zh 必须逐键对齐——`check:locale`
 * 仓库脚本与 tests/locales.spec.ts 双重把关（键集合相等 + `{name}` 占位符一致）。
 *
 * 本文件保持**零 import**：scripts/check-locale.mjs（M14）以 typescript.transpileModule
 * 平移后直接求值取词典，不依赖打包器。
 */

/** locale 命名空间（spec §4）。 */
export const NS = 'git' as const

/** zh 词典——键集权威。 */
export const gitZh = {
  // ── header：C1 GitHeaderButton 状态面（spec §4 header 组 + 本模块禁用/检查态） ──
  'header.title': 'Git 仓库状态',
  'header.checking': 'Git…',
  'header.branch': '{name}',
  'header.detached': 'HEAD 分离于 {oid}',
  'header.unborn': '空仓库（尚无提交）',
  'header.noRepo': '不是 git 仓库',
  'header.badge': '{count} 处变更',
  // ── menu：C1 菜单动作（打开变更面板 / 提交图 / 提交… / 提交并推送… / 同步占位）──
  // ④-K 提交对话框模块：commit / commitPush 两动作接通对话框拉起（spec §3.1 [清单 48]
  // 的前四项；推送/拉取/获取仍并入 sync 占位——写 UI 动作随同步模块接线，openIssues）。
  'menu.openChanges': '打开变更面板',
  'menu.graph': '提交图',
  'menu.commit': '提交…',
  'menu.commitPush': '提交并推送…',
  'menu.sync': '同步',
  'menu.placeholderHint': '该动作将在后续版本提供',
  // ── problems：菜单头部的仓库摘要行（冲突计数 / 干净态） ──
  'problems.conflicted': '{count} 个冲突文件',
  'problems.clean': '工作区干净',
  // ── shortcut：[清单 51] v1 只交付菜单/tab 入口的如实提示（菜单页脚） ──
  'shortcut.hint': '快捷键将在后续版本提供',
  // ── tab：右栏两个 tab 定义的 chip 标题（spec §3.1；tab 体在后续模块落地） ──
  'tab.changes.title': 'Git 变更',
  'tab.graph.title': '提交图',
  // ── graph：GitGraphTab —— spec §4 graph 键组 + 详情面板（F7 提交图模块补齐） ──
  'graph.loadMore': '加载更多提交…',
  'graph.noCommits': '没有提交。',
  // 值保持 'HEAD'：git 保留名不作翻译，同时是 rowRefChips/detailViewModel 的
  // detached 判别值（headLabel === 'HEAD' ⇒ detached）。
  'graph.head': 'HEAD',
  'graph.loading': '加载中…',
  'graph.detail.files': '变更文件（{count}）',
  'graph.detail.totalTruncated': '变更文件清单超过预算，仅显示部分。',
  // ── changes：C2 GitChangesTab —— spec §4 changes 键组（种子全集）+ 组装所需动作/提示 ──
  'changes.staged': '已暂存',
  'changes.unstaged': '更改',
  'changes.untracked': '未跟踪',
  'changes.conflicted': '冲突',
  'changes.empty': '工作区干净，没有变更。',
  'changes.emptyRepo': '空仓库：还没有任何提交。先暂存文件，完成首次提交。',
  'changes.binary': '二进制',
  'changes.oversized': '差异超过大小上限，未加载。',
  'changes.truncated': '差异内容超过单文件上限，被截断。',
  'changes.loadFailed': '差异加载失败（超出本次预算或命令失败）。',
  'changes.stage': '暂存',
  'changes.unstage': '取消暂存',
  'changes.discard': '丢弃',
  'changes.checkAria': '切换 {path} 的暂存勾选',
  'changes.submodule': '子模块',
  'changes.discardConflict': '若文件仍存在未合并的冲突，请先解决冲突再丢弃。',
  // ── diff：FileDiffView 占位与渲染注记（C2/C3 共用；本模块 ask §⑥ 补齐） ──
  'diff.loading': '差异加载中…',
  'diff.binary': '二进制文件，没有文本差异。',
  'diff.oversized': '该文件的差异超过大小上限，未加载。',
  'diff.truncated': '差异过长，仅渲染前 {count} 行。',
  'diff.empty': '该文件没有文本差异。',
  // ── confirm：C5 GitConfirmDialog（danger 语义 + 确认勾选 + 路径全量列表） ──
  'confirm.ok': '确认',
  'confirm.cancel': '取消',
  'confirm.dangerCheckbox': '我已了解该操作不可逆',
  'confirm.discard.title': '丢弃工作区改动',
  'confirm.discard.message': '将丢弃 {count} 个文件的工作区改动，且无法撤销。',
  'confirm.discard.itemsTitle': '将丢弃以下文件的工作区改动：',
  'confirm.push.diverged': '远程已包含本地没有的提交（落后 {behind}），推送前需要先合并远程改动。',
  'confirm.setUpstreamTitle': '设置 upstream 并推送',
  'confirm.setUpstreamMessage': '当前分支尚未建立 upstream。确认后将执行推送并建立跟踪（push --set-upstream）。',
  // ── commit：C4 GitCommitDialog —— spec §4 commit dialog 键组（种子全集，值随
  //    host locale/*.json 包资产同文案）+ ④-K 组件所需的动作/确认/计数扩充键 ──
  'commit.title': '提交',
  'commit.placeholder': '提交信息（推荐 Conventional Commits）',
  'commit.generate': 'AI 生成',
  'commit.generating': '生成中…',
  'commit.fetching': '获取中…',
  'commit.pulling': '拉取中…',
  'commit.amend': '修订上一次提交 {shortOid} {subject}',
  'commit.amendWarning': '上一次提交已推送：修订将改写已发布历史，之后推送需要强制推送。',
  'commit.stagedCount': '已暂存 {count} 个文件',
  'commit.notConventional': '提交信息不符合 Conventional Commits（不阻断提交）',
  'commit.commit': '提交',
  'commit.commitPush': '提交并推送',
  'commit.committing': '提交中…',
  'commit.pushing': '推送中…',
  'commit.messageCount': '{count} 字符',
  'commit.amendFallback': '修订上一次提交',
  'commit.amendNoEdit': '修订时留空将保留原提交信息。',
  'commit.skipHooks': '跳过 hooks（--no-verify）',
  'commit.aiOverwriteTitle': '覆盖当前提交信息？',
  'commit.aiOverwriteMessage': 'AI 生成的新信息将替换输入框中的当前内容。',
  // ── errors：C6 GitErrorNotice —— 每个域错误码一键（spec §4 error 组 + host 扩展码） ──
  'error.no-repository': '这里不是 git 仓库（或 git 暂不可用）。',
  'error.identity-missing': '缺少 git 身份配置：{missing}。请先设置 user.name / user.email。',
  'error.nothing-staged': '没有已暂存的变更。',
  'error.empty-message': '提交信息不能为空。',
  'error.no-upstream': '分支 {branch} 尚未设置 upstream。',
  'error.no-remote': '没有可用的远端：{remotes}。',
  'error.diverged': '本地与远程已分叉（领先 {ahead} 落后 {behind}），请先拉取。',
  'error.push-rejected': '推送被远端拒绝，通常需要先拉取远程改动。',
  'error.auth-failed': '凭证验证失败。若弹出凭证管理器窗口，请完成登录后重试。',
  'error.pull-diverged': '本地与远程已分叉，无法快进合并；请在终端处理后再试。',
  'error.timeout': 'git 命令超时（{op}）。',
  'error.git-error': 'git 命令失败（{op}）。',
  'error.llm-route-unresolved': '无法解析 AI 模型路由。',
  'error.llm-failed': 'AI 生成提交信息失败：{reason}',
  'error.session-workspace-unresolved': '未找到可用的 git 工作区。',
  'error.no-paths': '没有提供要操作的文件路径。',
  'error.bad-request': '请求未执行：{reason}。',
  'error.hook-failed': '提交被 git hook 拒绝，详见下方输出。',
  'error.no-branch': '当前不在任何分支上（HEAD 分离或空仓库），无法执行该操作。',
  'error.dirty-worktree': '工作区有未提交的变更（{branch}），请先提交或暂存后再拉取。',
  'error.choose-remote': '存在多个远端且没有默认远端：{remotes}。请先指定要使用的 remote。',
  'error.gateway-service-unavailable': 'git 服务尚未就绪，请重试。',
  'error.gateway': '请求失败（{code}）。',
  'error.action.setUpstream': '设置 upstream 并推送',
  'error.action.fetch': '获取（fetch）',
  'error.action.pull': '拉取（pull）',
  // ── common：错误面板动作与折叠区（spec §4） ──
  'common.retry': '重试',
  'common.details': '详情',
  'common.close': '关闭',
} as const

/** en 词典——与 zh 逐键对齐（check:locale 与 locales.spec 双重校验）。 */
export const gitEn = {
  // ── header ──
  'header.title': 'Git repository status',
  'header.checking': 'Git…',
  'header.branch': '{name}',
  'header.detached': 'HEAD detached at {oid}',
  'header.unborn': 'Empty repository (no commits yet)',
  'header.noRepo': 'Not a git repository',
  'header.badge': '{count} changes',
  // ── menu ──
  'menu.openChanges': 'Open changes panel',
  'menu.graph': 'Commit graph',
  'menu.commit': 'Commit…',
  'menu.commitPush': 'Commit & Push…',
  'menu.sync': 'Sync',
  'menu.placeholderHint': 'This action arrives in a later version',
  // ── problems ──
  'problems.conflicted': '{count} conflicted file(s)',
  'problems.clean': 'Working tree clean',
  // ── shortcut ──
  'shortcut.hint': 'Keyboard shortcuts arrive in a later version',
  // ── tab ──
  'tab.changes.title': 'Git changes',
  'tab.graph.title': 'Commit graph',
  // ── graph：GitGraphTab ──
  'graph.loadMore': 'Loading more commits…',
  'graph.noCommits': 'No commits.',
  // Kept as 'HEAD' (a reserved git name, untranslated) — also the detached marker
  // consumed by rowRefChips/detailViewModel (headLabel === 'HEAD' ⇒ detached).
  'graph.head': 'HEAD',
  'graph.loading': 'Loading…',
  'graph.detail.files': 'Changed files ({count})',
  'graph.detail.totalTruncated': 'The changed-file list was truncated by the budget.',
  // ── changes：C2 GitChangesTab ──
  'changes.staged': 'Staged',
  'changes.unstaged': 'Changes',
  'changes.untracked': 'Untracked',
  'changes.conflicted': 'Conflicts',
  'changes.empty': 'Working tree clean — no changes.',
  'changes.emptyRepo': 'Empty repository: no commits yet. Stage files and make the first commit.',
  'changes.binary': 'Binary',
  'changes.oversized': 'Diff exceeds the size limit; not loaded.',
  'changes.truncated': 'The diff content exceeded the per-file limit and was truncated.',
  'changes.loadFailed': 'Diff failed to load (over budget or the command failed).',
  'changes.stage': 'Stage',
  'changes.unstage': 'Unstage',
  'changes.discard': 'Discard',
  'changes.checkAria': 'Toggle the staged checkbox for {path}',
  'changes.submodule': 'Submodule',
  'changes.discardConflict': 'If the file still has unresolved conflict markers, resolve them before discarding.',
  // ── diff：FileDiffView ──
  'diff.loading': 'Loading diff…',
  'diff.binary': 'Binary file — no textual diff.',
  'diff.oversized': 'The diff of this file exceeds the size limit and was not loaded.',
  'diff.truncated': 'The diff is long; only the first {count} lines are rendered.',
  'diff.empty': 'This file has no textual diff.',
  // ── confirm ──
  'confirm.ok': 'Confirm',
  'confirm.cancel': 'Cancel',
  'confirm.dangerCheckbox': 'I understand this cannot be undone',
  'confirm.discard.title': 'Discard working-tree changes',
  'confirm.discard.message': 'Discard working-tree changes of {count} file(s)? This cannot be undone.',
  'confirm.discard.itemsTitle': 'The working-tree changes of these files will be discarded:',
  'confirm.push.diverged': 'The remote has commits the local branch does not (behind {behind}); merge remote changes before pushing.',
  'confirm.setUpstreamTitle': 'Set upstream and push',
  'confirm.setUpstreamMessage': 'The current branch has no upstream. Confirming will push and set up tracking (push --set-upstream).',
  // ── commit：C4 GitCommitDialog（en 与 zh 逐键对齐；种子值随 host locale/en.json）──
  'commit.title': 'Commit',
  'commit.placeholder': 'Commit message (Conventional Commits recommended)',
  'commit.generate': 'Generate with AI',
  'commit.generating': 'Generating…',
  'commit.fetching': 'Fetching…',
  'commit.pulling': 'Pulling…',
  'commit.amend': 'Amend previous commit {shortOid} {subject}',
  'commit.amendWarning': 'The previous commit was already pushed: amending rewrites published history, and the next push will require force.',
  'commit.stagedCount': '{count} file(s) staged',
  'commit.notConventional': 'The message does not follow Conventional Commits (non-blocking)',
  'commit.commit': 'Commit',
  'commit.commitPush': 'Commit & Push',
  'commit.committing': 'Committing…',
  'commit.pushing': 'Pushing…',
  'commit.messageCount': '{count} characters',
  'commit.amendFallback': 'Amend previous commit',
  'commit.amendNoEdit': 'Leave the message empty when amending to keep the previous one.',
  'commit.skipHooks': 'Skip hooks (--no-verify)',
  'commit.aiOverwriteTitle': 'Overwrite the current commit message?',
  'commit.aiOverwriteMessage': 'The generated message will replace the current content of the editor.',
  // ── errors ──
  'error.no-repository': 'This is not a git repository (or git is currently unavailable).',
  'error.identity-missing': 'Missing git identity: {missing}. Set user.name / user.email first.',
  'error.nothing-staged': 'Nothing is staged.',
  'error.empty-message': 'The commit message must not be empty.',
  'error.no-upstream': 'Branch {branch} has no upstream.',
  'error.no-remote': 'No usable remote: {remotes}.',
  'error.diverged': 'Local and remote have diverged (ahead {ahead}, behind {behind}). Pull first.',
  'error.push-rejected': 'The push was rejected by the remote; pull remote changes first.',
  'error.auth-failed': 'Authentication failed. If a credential-manager window appears, sign in and retry.',
  'error.pull-diverged': 'Local and remote have diverged; a fast-forward is not possible. Resolve it in a terminal first.',
  'error.timeout': 'The git command timed out ({op}).',
  'error.git-error': 'The git command failed ({op}).',
  'error.llm-route-unresolved': 'Unable to resolve the AI model route.',
  'error.llm-failed': 'AI commit-message generation failed: {reason}',
  'error.session-workspace-unresolved': 'No usable git workspace was found.',
  'error.no-paths': 'No file paths were given.',
  'error.bad-request': 'The request was not executed: {reason}.',
  'error.hook-failed': 'The commit was rejected by a git hook; see the output below.',
  'error.no-branch': 'HEAD is detached or the repository is unborn; this operation needs a branch.',
  'error.dirty-worktree': 'The working tree of {branch} has uncommitted changes; commit or stage them before pulling.',
  'error.choose-remote': 'Multiple remotes exist and none is the default: {remotes}. Specify a remote first.',
  'error.gateway-service-unavailable': 'The git service is not ready yet. Retry.',
  'error.gateway': 'The request failed ({code}).',
  'error.action.setUpstream': 'Set upstream and push',
  'error.action.fetch': 'Fetch',
  'error.action.pull': 'Pull',
  // ── common ──
  'common.retry': 'Retry',
  'common.details': 'Details',
  'common.close': 'Close',
} as const

/** 本命名空间的词典键集（zh 权威；en 由 check:locale 对齐把关）。 */
export type GitLocaleKey = keyof typeof gitZh

/**
 * `declare module` 合并（spec §3.1/④）：`git` 命名空间的键域 = 本词典键集。
 * 槽注册传 `locale: NS` 后组件的 `t` 即 `TranslateNS<'git'>`。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh Git 插件的全部用户可见文案（键集权威 = gitZh）。 */
    'git': GitLocaleKey
  }
}
