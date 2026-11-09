/**
 * dsh-gitkit — RPC 线路类型（wire types）。spec 权威：research/capability-spec.md §1.0.3
 * （本模块 ⑤ 一次落全；client 包唯一类型依赖面，client 只允许 `import type`——编译期擦除，
 * 不构成 runtime-import，不违反「feature 插件禁止 runtime-import 另一 feature 插件的值」，
 * host-capability-map.md:37）。
 *
 * 序列化边界硬规则（research/host-capability-map.md §2.3）：RPC 出入参只允许
 * null/string/boolean/有限 number/plain object/array；出参禁 Map/Set（静默拷成 {} 丢数据）；
 * Date 出参写 ISO string；入参可选字段由调用方省略而非传显式 undefined；
 * strict codec 会丢弃编译类型未声明的对象字段（host-capability-map.md:158）。
 */

/** wire namespace（= src/index.ts 的 SERVICE_KEY，类型面重复声明以便独立引用）。 */
export type GitServiceKey = 'git'

/** `git ping` 的成功出参：本机 git 可执行文件的自述。 */
export interface GitPingResult {
  ok: true
  /** `git --version` 的 stdout 首行，如 `git version 2.55.0.windows.2`。 */
  gitVersion: string
}

/** `git identity` 的 `scope` 入参：git config --get 的作用域限定；缺省 = 合并视图。 */
export type GitIdentityScope = 'merged' | 'local' | 'global' | 'system'

/** `git identity` 的出参：user.name / user.email 的生效状态（spec §1.4 前置校验 1 的查询面）。 */
export interface GitIdentityResult {
  /** user.name 生效值；未设置（exit 1 或空串值）时 null。 */
  name: string | null
  /** user.email 生效值；同上。 */
  email: string | null
  /** 缺失键清单（`user.name` / `user.email` 的子集）。 */
  missing: string[]
  /** missing 为空。 */
  complete: boolean
  /** 本次查询跑 git config 的目录（realpath 规范化）。 */
  workspace: string
  /** 工作区解析来源：workspace-override（Config 钉死）或 session（最近顶层会话）。 */
  workspaceSource: 'workspace-override' | 'session'
}

// ---------- 变更条目（spec §1.0.3） ----------

export type ChangeKind =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'

/** porcelain v2 条目行（1 <XY>… 或 2 <XY>…<orig>）+ 并发 numstat 结果的合并视图。 */
export interface FileChange {
  /** -z 下原样字节路径（中文/空格安全，spec §1.1/【报告】:237）。 */
  path: string
  /** renamed/copied 的原路径（格式 2 行），其余 null。 */
  origPath: string | null
  kind: ChangeKind
  /** porcelain XY 首位（index 侧状态字符）。 */
  x: string
  /** porcelain XY 次位（worktree 侧状态字符）。 */
  y: string
  /** XY ∈ {DD,AU,UD,UA,DU,AA,UU}。 */
  conflicted: boolean
  /** numstat 对该路径报 '-'（[清单 59]）。 */
  binary: boolean
  /** binary 时 null；untracked 无 numstat 记录，亦为 null。 */
  additions: number | null
  deletions: number | null
  /** porcelain sub 字段非 'N' 时 true；v1 只展示不递归（[清单 61] 为 v2）。 */
  submodule: boolean
}

// ---------- status ----------

export interface BranchState {
  /** 当前分支短名；detached 时 null（[清单 65]）。 */
  name: string | null
  /** HEAD 全 oid；无提交仓库（branch.oid (initial)）时 null（[清单 64]）。 */
  oid: string | null
  /** 短 oid（oid 前 7 位，展示用启发式），供 detached 展示；oid 为 null 时 null。 */
  abbrevOid: string | null
  /** 如 'origin/main'；无 upstream 为 null。 */
  upstream: string | null
  /** 无 upstream 时 null（[清单 24]）。 */
  ahead: number | null
  behind: number | null
  detached: boolean
  /** 无提交仓库。 */
  unborn: boolean
}

/** git.status 的返回值；spec §2 的「快照」即此类型（未来若 dsh 开放事件转发，git/status 事件 payload 同型）。 */
export interface GitStatusSnapshot {
  repoRoot: string
  /** ISO 时间戳（host 打点，用于 client 判新旧）。 */
  generatedAt: string
  branch: BranchState
  /** X ∉ {'.','?'} 的条目（UU 会同时出现在 staged/unstaged/conflicted）。 */
  staged: FileChange[]
  /** Y ∉ {'.','!'} 的条目。 */
  unstaged: FileChange[]
  /** X == '?' 的条目；porcelain 默认不列 ignored → 即「非 ignored 未跟踪」（[清单 5]）。 */
  untracked: FileChange[]
  /** XY ∈ {DD,AU,UD,UA,DU,AA,UU} 的视图分组（与上三组允许重叠）。 */
  conflicted: FileChange[]
  /** 以上四组全空。 */
  clean: boolean
}

// ---------- diff ----------

export type DiffScope = 'worktree' | 'staged'

export interface DiffFile {
  path: string
  origPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  binary: boolean
  /** binary 时 null。 */
  additions: number | null
  deletions: number | null
  /** unified diff 文本；binary/超预算/加载失败为 null（[清单 59] 占位语义）。 */
  patch: string | null
  /** 本文件 patch 被单文件上限截断。 */
  patchTruncated: boolean
  /** 超过 diffFilePatchMaxBytes，UI 显示占位（[清单 59]）。 */
  oversized: boolean
}

export interface DiffResult {
  scope: DiffScope
  /** null = 该 scope 全部变更文件（预算内）；指定路径 = 单文件。 */
  path: string | null
  files: DiffFile[]
  /** diffTotalPatchMaxBytes 触发。 */
  totalTruncated: boolean
  generatedAt: string
}

// ---------- log / refs / show（提交图数据层，[清单 31/32/33]） ----------

export interface CommitInfo {
  oid: string
  /** 全 oid；root 提交为 []。 */
  parents: string[]
  authorName: string
  authorEmail: string
  /** ISO（%aI）。 */
  authoredAt: string
  /** ISO（%cI）——lane 布局的 topo 排序键（SOURCES.md:140）。 */
  committedAt: string
  subject: string
  /** 可为 ''。 */
  body: string
}

/** 一页 log；分页契约 = 每次取 limit+1 条，多出 1 条 ⇒ hasMore，其余截去（防御性 over-fetch，GitLens over-walk 模式 SOURCES.md:108）。 */
export interface LogPage {
  /** children-first（git log --topo-order 输出序）。 */
  commits: CommitInfo[]
  hasMore: boolean
  skipUsed: number
  limitUsed: number
}

export type RefType = 'local-branch' | 'remote-branch' | 'tag'

export interface RefInfo {
  type: RefType
  /** refs/heads/main、refs/remotes/origin/main、refs/tags/v1。 */
  fullName: string
  /** main、origin/main、v1。 */
  shortName: string
  /** **peeled 提交 oid**：annotated tag 取 %(*objectname)，其余取 %(objectname)（spec §1.8 B6）。 */
  oid: string
  /**
   * 本地分支的 upstream 跟踪态（`%(upstream:track)` 原文；workflow F7 任务口径
   * 「refs 单次查询含 upstream:track 与 gone 解析」——spec §1.0.3 RefInfo 未列，
   * 任务口径扩展字段，记 ModuleResult.openIssues）：`[gone]` = upstream 引用已消失、
   * `[ahead N]`/`[behind N]`/`[ahead N, behind M]` = 未同步计数、null = 无 upstream /
   * 已同步 / 非 local-branch（remote-branch 与 tag 无 upstream 语义）。信息性字段，
   * v1 图 UI 不渲染（host 一次 for-each-ref 取回，避免逐分支 rev-list）。
   */
  upstreamTrack: string | null
}

export interface RefsSnapshot {
  refs: RefInfo[]
  head: {
    kind: 'branch' | 'detached' | 'unborn'
    /** branch 时短名。 */
    name: string | null
    oid: string | null
  }
}

export interface CommitDetail {
  commit: CommitInfo
  /** numstat（path 模式下含该文件 patch）。 */
  files: DiffFile[]
  totalTruncated: boolean
  /**
   * 指向本提交的 refs（workflow F7 任务口径「getCommitDetail 元数据+文件清单+
   * refs 过滤」——spec §1.0.3 CommitDetail 未列，任务口径扩展字段，记
   * ModuleResult.openIssues）：peeled oid == commit.oid 的 RefInfo，详情面板
   * 渲染 ref chips 用（decorated chip 集 = log 窗口行 + 本字段的并）。
   */
  refs: RefInfo[]
}

// ---------- 写操作结果 ----------

export interface StageResult { staged: number }
export interface UnstageResult { unstaged: number }
/** tracked restore + untracked clean 合计文件数。 */
export interface DiscardResult { discarded: number }

/**
 * `git.discard` 入参（三重守卫，workflow 任务口径；spec §1.3 的 `discard(paths)` 单参
 * 签名的扩展——扩展点记入 ModuleResult.openIssues，client 挂载面后续模块跟进）：
 *   - acknowledged：C 级二次确认旗标（[清单 12]；spec §1.0.4 discard 权限 C），
 *     false ⇒ `git/bad-request`（reason 'unacknowledged'），一次命令都不执行；
 *   - baseRevision：乐观并发基线 = 客户端发起请求时持有的 HEAD 全 oid（null = 不参与
 *     校验/unborn）；host 按最新 status 的 branch.oid 比对，不一致 ⇒ `git/bad-request`
 *     （reason 'stale-base-revision'），一次命令都不执行。
 */
export interface DiscardOptions {
  paths: string[]
  acknowledged: boolean
  baseRevision: string | null
}

export interface CommitOptions {
  message: string
  /** [清单 19]。amend 且 message 全空白 ⇒ `--amend --no-edit`（保留原消息，不改写）。 */
  amend: boolean
  /** [清单 20] → --no-verify。 */
  skipHooks: boolean
  /**
   * [清单 18] 作者署名 trailer（v2 批次三）：每条需形如 `Key: value`（Key = 字母开头的
   * 字母/数字/连字符 token，冒号后空白 + 非空 value）；host 组装进 `-F -` 消息体
   * （空行分隔的尾块，git trailer 语义），回读展示纪律不变（CommitResult.message 为
   * 权威值）。不合法条目 ⇒ `git/bad-request`（reason 'malformed-trailer'，零命令）。
   * `amend + 全空白 message`（--no-edit 路径）与 trailers 同给 ⇒ `git/bad-request`
   * （reason 'invalid-options'——--no-edit 保留原消息，trailer 无从附着，零命令）。
   */
  trailers?: string[]
}

/** [清单 63] `git commit` 进程整体输出捕获（v2 批次三）。 */
export interface CommitProcessOutput {
  /**
   * **诚实命名**：这是 `git commit` 进程的整体输出——含 hook 输出（git 不做
   * per-hook 归因，stdout 里有 hook 转发内容时无法区分哪段来自哪个 hook）。
   * stderr 已过 sanitizeStderr 脱敏；两侧各截 16 KiB 尾部（sanitizeStderr 同口径）。
   */
  stdout: string
  /** 同上（整体输出、脱敏、16 KiB 尾部）。 */
  stderr: string
  /**
   * 超时旗标。**恒 false**：超时路径抛 `git/timeout`（不返回 CommitResult），
   * 本字段为 wire 形状完备保留（方案 §5.2 定形）。
   */
  timedOut: boolean
  /** `git commit` 命令的执行时长毫秒（不含回读）。 */
  durationMs: number
}

export interface CommitResult {
  oid: string
  shortOid: string
  branch: string | null
  amended: boolean
  /**
   * 提交后回读的最终 message（`git show -s --format=%B`，去尾换行；workflow 任务口径
   * 「回读最终 message → 刷新回带」——commit-msg hook 改写/`--no-edit` 保留原消息后，
   * client 展示以此为准，不信入参）。
   */
  message: string
  /**
   * [清单 63] hook 输出面板数据源（v2 批次三）：`git commit` 进程整体输出（含 hook
   * 输出，见 {@link CommitProcessOutput} 的诚实命名注）。**空输出置 null 省 wire**
   * （方案 §5.2/§5.10）；hook 失败路径不返回本字段（错误抛 `git/hook-failed`，
   * stderr 进 details——既有纪律不变）。
   */
  process: CommitProcessOutput | null
}

export interface PushOptions {
  /** [清单 26]；无 upstream 且 false ⇒ git/no-upstream。 */
  setUpstream: boolean
  /**
   * [清单 27] force push（v2 批次一）：`--force` 透传，语义即覆盖远端（diverged
   * 预检跳过，upstream 存在性预检保留）。**双闸的 host 半**：force=true 且
   * acknowledged!==true ⇒ `git/bad-request`（reason 'force-unacknowledged'），
   * 零命令执行（discards acknowledged 守卫同款纪律）。
   */
  force?: boolean
  /** force 的 C 级二次确认旗标（与 DiscardOptions.acknowledged 同范式）。 */
  acknowledged?: boolean
  /**
   * [清单 57] 推送目标 remote 显式指定（推送对话框 remote picker 的 host 面）：
   * 非空字符串 = 直查该 remote 存在性（不存在 ⇒ git/no-remote，details.remotes 带
   * 全量清单），**不走** origin/唯一 remote 解析链（§3.10 预检顺序写死，避免与
   * git/choose-remote 双轨报错）；null/缺省 = v1 缺省解析链不变。
   */
  remote?: string | null
}

export interface PushResult {
  remote: string
  branch: string
  /** set-upstream 成功后非空。 */
  upstream: string | null
  setUpstreamUsed: boolean
}

/** v1 恒 true（非 ff 直接拒绝）。 */
export interface PullResult {
  fastForwarded: boolean
  oldOid: string
  newOid: string
  remote: string
}

/** null = upstream 的 remote，否则 origin，否则报错。 */
export interface FetchOptions { remote: string | null }
export interface FetchResult { remote: string; pruned: boolean }

export interface GeneratedCommitMessage {
  message: string
  /** CONVENTIONAL_COMMIT_RE 通过（[清单 17]）。 */
  conventional: boolean
  filesConsidered: number
}

// ---------- log/refs/show 入参 ----------

/**
 * limit 钳到 [1, logMaxLimit]；skip ≥ 0。
 *
 * v2 批次二扩展（docs/v2-implementation-plan.md §4.2，[清单 35/60]）：可选过滤参数
 * ——strict codec 丢弃编译类型未声明的字段，任何 client 调用先于此扩展落库（变更链
 * §1 第 1 步）。缺省语义与 v1 完全一致（全量 HEAD topo 分页）。
 */
export interface LogOptions {
  limit: number
  skip: number
  /**
   * [清单 35] 提交 message 搜索词：`--grep=<query> -F`（**固定串**语义——不含正则
   * 元字符解释，UI 可直接透传用户输入）；空串/缺省 = 不过滤。
   */
  query?: string
  /**
   * [清单 35] 作者过滤：`--author=<author>`（git 的**正则**语义，子串命中即匹配——
   * 与 query 的固定串不同，UI 需提示「按子串/正则匹配」）；空串/缺省 = 不过滤。
   */
  author?: string
  /**
   * [清单 35/60] pathspec（单路径）：只列触及该路径的提交（`-- <path>`，字面路径
   * ——runner env GIT_LITERAL_PATHSPECS=1）；空串/null/缺省 = 不限路径。
   */
  path?: string | null
  /**
   * [清单 60] `--follow`：单文件历史跨 rename 跟踪（git 尽力跟踪有限 rename 链）。
   * **仅在 path 为单路径时合法**——违反 ⇒ git/bad-request（reason
   * 'follow-without-path'，零命令执行）。
   */
  follow?: boolean
  /**
   * [清单 35/60] 分页起点 revision（分支名/tag/oid 等 rev-parse 可解析修订）；
   * null/缺省 = HEAD。不可解析 ⇒ git/unknown-revision（details.op='log'）。
   */
  ref?: string | null
}
/** path=null：仅 meta+numstat；path 给定：含该文件 patch。 */
export interface ShowOptions { oid: string; path: string | null }

// ---------- v2 批次三：提交链路与护栏（[清单 10/14/21/22/56]；docs/v2-implementation-plan.md §5.2） ----------

/**
 * `git.stagePatch` 入参（[清单 10] hunk/行级 stage；D7=B 拍板两态）：client 从既有
 * `parsePatch` 产物裁剪组装选中 patch（hunk 头勾选 / 行级勾选 + `--recount` 容忍
 * 行计数漂移），host 只做 `git apply --cached`。
 */
export interface StagePatchOptions {
  /** 目标文件路径（仓库相对路径，字面路径语义；单文件——patch 与 path 必须同指）。 */
  path: string
  /** unified diff patch 文本（client 组装的选中行片；经 stdin 传给 git apply）。 */
  patch: string
  /**
   * 应用方向（D7=B）：'stage'（缺省）= `apply --cached` 正向（worktree 选中 → 暂存）；
   * 'unstage' = `apply --cached -R` 反向应用（staged diff 区同构勾选 → 从暂存还原）。
   */
  direction?: 'stage' | 'unstage'
}

/**
 * `git.stagePatch` 出参：staged = 本次应用的 **hunk 数**（patch 文本中 `@@` 头计数——
 * 单文件多 hunk 选择时给 client「已应用 N 块」反馈面；方向两态同口径）。
 */
export interface StagePatchResult { staged: number }

/**
 * `git.stashPush` 入参（[清单 14]；D4=B 拍板：`includeUntracked` **wire 显式
 * boolean，client 缺省传 true**——默认含 untracked（`-u`），UI 勾选可关）。
 */
export interface StashPushOptions {
  /** stash 描述消息（`-m`）；null/缺省 = git 缺省 subject（"On <branch>: ..."）。 */
  message?: string | null
  /** true = `-u` 含 untracked（client 缺省传 true = D4=B）；false = 只 stash tracked 改动。 */
  includeUntracked: boolean
  /**
   * 乐观并发基线（discard 范式 `DiscardOptions.baseRevision` 的可选沿用——wire 一次
   * 带齐防静默丢失）：非 null 且 ≠ 最新 HEAD ⇒ `git/bad-request`
   * （reason 'stale-base-revision'，零命令）；null/缺省 = 不参与校验。
   */
  baseRevision?: string | null
}

/** stash 列表条目（[清单 14]；`git stash list` 自定义 format 解析）。 */
export interface StashEntry {
  /** 引用序号（stash@{N} 的 N；0 = 最新）。 */
  index: number
  /** stash 提交的全 oid。 */
  oid: string
  /** oid 前 7 位（展示启发式，BranchState.abbrevOid 同口径）。 */
  shortOid: string
  /** stash 提交 subject（git 组装的 "On <branch>: <msg>" / "WIP on <branch>: ..." 原样）。 */
  message: string
  /** stash 作者时间（%aI，ISO）。 */
  authoredAt: string
}

/** `git.stashList` 出参；空 stash ⇒ 空数组（不抛错）。 */
export interface StashListResult { stashes: StashEntry[] }

/** `git.stashPush` / `git.stashPop` / `git.stashDrop` 出参：op 涉及的 stash 序号。 */
export interface StashOpResult { index: number }

/**
 * `git.stashPop` 入参（[清单 14]）：index=null/缺省 = 弹出最新一条（stash@{0}）；
 * 越界/空 stash ⇒ `git/stash-not-found`。应用冲突 ⇒ `git/merge-conflict`
 * （op 'stash-pop'；git 语义冲突时 stash 不丢，UI 明示）。
 */
export interface StashPopOptions {
  /** 要弹出的 stash 序号；null/缺省 = 0（最新一条）。 */
  index?: number | null
}

/**
 * `git.stashDrop` 入参（[清单 14]；danger 闸——删除 stash 不可恢复）：
 * acknowledged!==true ⇒ `git/bad-request`（reason 'unacknowledged'，零命令）；
 * 越界/空 stash ⇒ `git/stash-not-found`。
 */
export interface StashDropOptions {
  /** 要删除的 stash 序号（必填——缺省无删除语义）。 */
  index: number
  /** C 级二次确认旗标（danger 闸 host 半）。 */
  acknowledged: boolean
}

/** 提交护栏违规条目（[清单 21/22]；scanStaged 预检与 git/commit-blocked details 共用形状）。 */
export interface CommitViolation {
  /** 违规类别；secret = D5=A 硬阻断（不可豁免），其余可 danger 勾选豁免。 */
  kind: 'secret' | 'env-file' | 'large-file' | 'build-artifact' | 'eol-mixed'
  /** 违规文件（仓库相对路径）。 */
  path: string
  /** 英文诊断说明（不落密钥/文件内容——日志同纪律）。 */
  detail: string
  /** 文件字节大小；非体量类违规为 null。 */
  sizeBytes: number | null
  /** 命中行号（1 起）；非行级违规为 null。 */
  line: number | null
  /**
   * 命中展示文本——**脱敏后**（模式表的「安全前缀 + 掩码」规则，见 guard-scan.ts；
   * 绝不落明文密钥——sanitizeStderr 纪律延伸）。非密钥类违规为 null。
   */
  redactedMatch: string | null
}

/** `git.scanStaged` 出参（[清单 21/22] 只读预检；blocked = violations 非空）。 */
export interface CommitScanResult {
  blocked: boolean
  violations: CommitViolation[]
}

/**
 * `git.repoDiagnostics` 出参（[清单 56] 行尾与编码安全）：CRLF 抽样 = 仓库顶层 +
 * 已知文本后缀（封顶）；`mixedEolFiles` 清单封顶（超出截断不进 wire——wire 类型无
 * 溢出计数字段，封顶值见 guard-scan.ts 常量，方案 §5.2「文件清单封顶，超出仅计数」
 * 在现 wire 形状下以「截断清单 + worktreeCrlfCount 量级」承载）。
 */
export interface RepoDiagnostics {
  /** `git config --get core.autocrlf` 生效值；未设置（exit 1/空值）⇒ null。 */
  autocrlf: string | null
  /** `git config --get core.eol` 同上。 */
  coreEol: string | null
  /** CRLF 与 LF 混用的抽样文件清单（仓库相对路径；封顶）。 */
  mixedEolFiles: string[]
  /** 抽样中含有 CRLF 行尾的工作区文件计数（含 mixed 者）。 */
  worktreeCrlfCount: number
}

// ---------- refs 管理（v2 批次一：[清单 23/30] 分支与标签 + [清单 57] remote 列表 + [清单 62/68] worktree） ----------

/** `git.branchCreate` 入参（[清单 23]）：from=null/缺省 = 当前 HEAD 为起点。 */
export interface BranchCreateOptions {
  /** 新分支名；非法名（git check-ref-format 口径）由 git 自身拒绝（exit 128 ⇒ git-error）。 */
  name: string
  /** 起点 revision（分支名/oid 等可解析修订）；null/缺省 = HEAD。 */
  from?: string | null
  /** true = 创建后立即检出（`git switch -c`；存在即拒 ⇒ git/branch-exists）。 */
  checkout?: boolean
}

/** `git.branchCreate` 出参：oid = 新分支指向的提交（回读）；checkedOut = 是否已检出。 */
export interface BranchCreateResult {
  name: string
  /** 回读 `refs/heads/<name>` 的 oid；创建成功后必然非 null（unborn 起点在 git 侧已被拒）。 */
  oid: string | null
  checkedOut: boolean
}

/** `git.branchSwitch` 出参：from = 切换前分支名（detached 时 null），to = 回读的切换后分支名。 */
export interface BranchSwitchResult {
  from: string | null
  to: string
}

/** `git.branchDelete` 入参（[清单 23]）：force（= `-D`）需 acknowledged（双闸 host 半）。 */
export interface BranchDeleteOptions {
  name: string
  /** true = `-D` 强删（未合并也删）；需 acknowledged=true，否则 git/bad-request 'force-unacknowledged'。 */
  force?: boolean
  /** force 的 C 级二次确认旗标。 */
  acknowledged?: boolean
}

/** `git.branchDelete` 出参：wasMerged = 删除前该分支是否为 HEAD 的祖先（`merge-base --is-ancestor` 回读）。 */
export interface BranchDeleteResult {
  deleted: string
  wasMerged: boolean
}

/** `git.tagCreate` 入参（[清单 30]）：message 非空 = annotated（`-a -m`）；force（= `-f`）需 acknowledged。 */
export interface TagCreateOptions {
  name: string
  /** 打 tag 的目标 revision；null/缺省 = HEAD。 */
  oid?: string | null
  /** 非空 = annotated tag 的消息；null/缺省 = lightweight。 */
  message?: string | null
  /** true = `-f` 覆盖同名 tag；需 acknowledged=true，否则 git/bad-request 'force-unacknowledged'。 */
  force?: boolean
  /** force 的 C 级二次确认旗标。 */
  acknowledged?: boolean
}

/** `git.tagCreate` 出参：oid = peeled 提交（`<tag>^{commit}` 回读，annotated/lightweight 同口径）。 */
export interface TagCreateResult {
  name: string
  oid: string | null
  annotated: boolean
}

/** `git.tagDelete` 出参。 */
export interface TagDeleteResult { deleted: string }

/** `git.remoteList` 的单个 remote（[清单 57]）：`git remote -v` 的 fetch/push 双 url。 */
export interface RemoteInfo {
  name: string
  /** fetch url。 */
  url: string
  /**
   * 显式配置且与 fetch 不同的 push url；null = push 缺省使用 fetch url（git 语义——
   * 未显式配置时 `git remote -v` 也输出与 fetch 同值的 push 行，本处归一为 null）。
   */
  pushUrl: string | null
}

/** `git.remoteList` 出参。 */
export interface RemoteListResult { remotes: RemoteInfo[] }

/** `git.worktreeList` 的单个 worktree（[清单 62]；`git worktree list --porcelain` 解析）。 */
export interface WorktreeInfo {
  /** worktree 绝对路径（git 输出原样，正斜杠形态）。 */
  path: string
  /** HEAD oid；null = unborn（porcelain 全零 oid 归一）或 bare（无 HEAD 行）。 */
  head: string | null
  /** 本地分支短名（refs/heads/ 剥离）；null = detached / bare。 */
  branch: string | null
  /** porcelain `bare` 行（bare 主仓库）。 */
  bare: boolean
  /** porcelain `detached` 行。 */
  detached: boolean
  /** porcelain `locked` 行（reason 自由文本不进 wire，[清单 62] 只读展示布尔位）。 */
  locked: boolean
}

/** `git.worktreeList` 出参。 */
export interface WorktreeListResult { worktrees: WorktreeInfo[] }

/**
 * `git.worktreeAdd` 入参（[清单 68] per-ticket worktree 写面）：branch（检出**现有**
 * 分支）与 newBranch（**新建**分支）互斥、至少给其一——违反 ⇒ git/bad-request
 * （reason 'invalid-options'，防 `-b` 静默 DWIM 误建分支）。
 */
export interface WorktreeAddOptions {
  /** 新 worktree 路径（绝对或相对仓库根）；已存在且非空 ⇒ git/worktree-failed。 */
  path: string
  /** 检出现有分支（互斥于 newBranch）。 */
  branch?: string | null
  /** 新建分支（`-b`，起点 HEAD；互斥于 branch）。 */
  newBranch?: string | null
}

/** `git.worktreeAdd` 出参：path = 传给 git 的绝对路径；branch/head = 新 worktree 内回读。 */
export interface WorktreeAddResult {
  path: string
  branch: string | null
  head: string | null
}

/**
 * `git.worktreeRemove` 入参（[清单 68]）：脏 worktree 删除需 force（git 自身拒绝 ⇒
 * git/worktree-failed）；`--force` 仅随 acknowledged 透传（双闸 host 半）。
 */
export interface WorktreeRemoveOptions {
  /** 要移除的 worktree 路径（绝对或相对仓库根）；不存在 ⇒ git/worktree-failed。 */
  path: string
  /** true = `--force`（脏 worktree 也删）；需 acknowledged=true。 */
  force?: boolean
  /** force 的 C 级二次确认旗标。 */
  acknowledged?: boolean
}

/** `git.worktreeRemove` 出参：removed = 传给 git 的路径（与入参同形）。 */
export interface WorktreeRemoveResult { removed: string }

// ---------- v2 批次二：历史面（[清单 34] blame / [清单 36] 分支对比 / [清单 37] 时间旅行） ----------

/**
 * `git.blame` 入参（[清单 34]；D3=B 拍板的 `-L` 区间分片 wire 承载）：
 * ref=null/缺省 = blame 工作区文件（含未提交行——porcelain 以全零 oid + author
 * 「Not Committed Yet」标注，真实世界如实过线）；ref 给定 = blame 该修订的版本。
 * range=null/缺省 = 全区（受单次行数硬顶钳制，见 {@link BlameResult}）。
 */
export interface BlameOptions {
  /** 仓库相对路径（字面路径语义——GIT_LITERAL_PATHSPECS=1）。 */
  path: string
  /** blame 起点 revision；null/缺省 = 工作区。 */
  ref?: string | null
  /** `-L <start>,<end>` 区间（1 起行号，闭区间）；null/缺省 = 全区。 */
  range?: { start: number; end: number } | null
}

/** blame 的单段连续同 oid 行区间（同 oid 连续行合并——§4.3 解析纪律）。 */
export interface BlameRange {
  /** 区间起始行号（1 起，blame 目标的最终行号——与全区结果可比，§4.7 一致性用例）。 */
  startLine: number
  /** 区间行数（≥1）。 */
  count: number
  /** 该区间归属提交的全 oid（未提交行 = 全零 oid）。 */
  oid: string
  /** 作者名（未提交行 = git 的「Not Committed Yet」）。 */
  authorName: string
  /** 作者时间（author-time 转 ISO；未提交行 = 探测时刻）。 */
  authoredAt: string
}

/** blame 区间归属提交的展示面（commits 去重清单）。 */
export interface BlameCommit {
  oid: string
  /** oid 前 7 位（展示启发式，BranchState.abbrevOid 同口径）。 */
  shortOid: string
  authorName: string
  /** 提交 subject（summary 行原样）。 */
  subject: string
}

/**
 * `git.blame` 出参。
 *
 * 单次行数硬顶（D3=B）：`maxLines` = min(50_000, floor(outputMaxBytes /
 * 128))——上限不得高于 outputMaxBytes 可承载量，两值互相校验（§4.10）。
 *   - 全区请求且总行数 > maxLines ⇒ git/blame-oversized（details.lineCount =
 *     精确总行数，引导 client 转 `-L` 区间分片）；
 *   - 区间请求跨度 > maxLines ⇒ **同钳**：end 钳到 start+maxLines-1，
 *     `truncated=true`（防失控区间的防御性截断，client 以下一片续读）。
 *
 * `lineCount` = blame 目标版本的总行数（探测精确值）；探测不可得时 =
 * 本次结果覆盖的末行行号（下界，如实降级）。
 */
export interface BlameResult {
  /** 回传入参 path（解析的仓库相对路径）。 */
  path: string
  /** blame 起点 revision（null = 工作区）。 */
  ref: string | null
  /** blame 目标版本总行数（探测不可得时 = 本次覆盖末行行号，见类型注）。 */
  lineCount: number
  /** 区间请求被单次硬顶钳制（end 被截短）；全区成功恒 false。 */
  truncated: boolean
  /** 行区间（按 startLine 升序、互不重叠；同 oid 连续行已合并）。 */
  ranges: BlameRange[]
  /** ranges 覆盖的提交去重清单（首现序）。 */
  commits: BlameCommit[]
}

/** `git.compareBranches` 入参（[清单 36]）：base/compare 均为可解析修订。 */
export interface CompareOptions {
  /** 基准分支（behind 侧——base 独有的提交落在 behind）。 */
  base: string
  /** 对比分支（ahead 侧——compare 独有的提交落在 ahead）。 */
  compare: string
}

/**
 * `git.compareBranches` 出参（[清单 36]）：ahead = compare 独有（`git log
 * base..compare`）；behind = base 独有（`git log compare..base`）；计数来自
 * `rev-list --left-right --count base...compare`（rev-count.ts 提共享）并与列表
 * 长度互检（不一致 = 契约破坏要响）。列表不做分页钳制——对比是管理面单次查询，
 * 输出超预算由 runner 的 stdout 上限如实兜底（截断 ⇒ git-error，不静默截取）。
 */
export interface BranchCompareResult {
  base: string
  compare: string
  /** merge-base oid； histories 不相交时 null（exit 1 如实归 null）。 */
  mergeBase: string | null
  /** compare 独有提交（topo 序，children-first）。 */
  ahead: CommitInfo[]
  /** base 独有提交（topo 序，children-first）。 */
  behind: CommitInfo[]
  /** ahead.length 的 rev-list 独立计数（互检一致才返回）。 */
  aheadCount: number
  behindCount: number
}

/**
 * `git.cherryPick` 入参（[清单 37]；discard 三重守卫同款——acknowledged + baseRevision
 * 乐观并发，任一失败零命令执行）。
 */
export interface CherryPickOptions {
  /** 要摘取的提交（rev-parse 可解析的 commit-ish；不可解析 ⇒ git/unknown-revision）。 */
  oid: string
  /** C 级二次确认旗标（false ⇒ git/bad-request 'unacknowledged'）。 */
  acknowledged: boolean
  /**
   * 乐观并发基线 = 客户端发起请求时持有的 HEAD 全 oid（null = 不参与校验）；
   * 与最新 status 的 branch.oid 不一致 ⇒ git/bad-request 'stale-base-revision'。
   */
  baseRevision: string | null
}

/** `git.revert` 入参（与 CherryPickOptions 同形；语义 = 逆向应用该提交）。 */
export interface RevertOptions {
  /** 要逆向的提交。 */
  oid: string
  /** C 级二次确认旗标。 */
  acknowledged: boolean
  /** 乐观并发基线（同 CherryPickOptions）。 */
  baseRevision: string | null
}

/**
 * `git.reset` 入参（[清单 37]）：soft = 只移 HEAD、mixed = +重置 index（unstage
 * 场景 target=null 用 mixed）、hard = +重置工作区（丢弃未提交改动——其语义即清理，
 * 脏区不拦，§4.10）。三档均需 acknowledged（C 级）；UI 侧 hard 另走 danger 勾选闸。
 */
export interface ResetOptions {
  kind: 'soft' | 'mixed' | 'hard'
  /** 重置目标；null = HEAD。不可解析 ⇒ git/unknown-revision。 */
  target: string | null
  /** C 级二次确认旗标。 */
  acknowledged: boolean
  /** 乐观并发基线（同 CherryPickOptions）。 */
  baseRevision: string | null
}

/**
 * cherry-pick / revert / reset 的统一出参：oldOid = 操作前 HEAD（fresh 快照回读），
 * newOid = 操作后 HEAD 回读（rev-parse；三者均不产生 unborn——null 仅为 wire
 * 前向兼容保留，实现恒回读非空）。
 */
export interface TimeTravelResult {
  op: 'cherry-pick' | 'revert' | 'reset'
  oldOid: string
  newOid: string | null
}

/**
 * `git.abortOperation` 出参（[清单 37]）：aborted = 清除的中间态种类；null =
 * 无中间态（幂等成功，零命令）。
 */
export interface AbortOperationResult {
  aborted: 'cherry-pick' | 'revert' | null
}

// ---------- v2 批次四：体验集成与收尾（[清单 8/46/61/66/69]；docs/v2-implementation-plan.md §6.2） ----------

/** `git.initRepository` 出参（[清单 8] 非 git 目录引导）：branch = init 后 HEAD 符号引用的短名（unborn 分支——`symbolic-ref` 回读，尊重 init.defaultBranch/用户全局配置）。 */
export interface InitResult {
  /** init 后回读的仓库根（`rev-parse --show-toplevel`，realpath 规范化）。 */
  repoRoot: string
  /** init 后的初始分支短名（unborn HEAD 也有符号引用，回读非 null）。 */
  branch: string
}

/**
 * `git.submoduleStatus` 的单个 submodule 条目（[清单 61] 只列不递归——`git submodule
 * status` **不带 --recursive**，v1 不展开口径）。state 由 status 前缀映射：
 * 空格=clean、`-`=uninitialized、`+`=mismatch（检出 commit ≠ index 记录）、
 * `U`=dirty（submodule 内合并冲突——枚举无 conflict 档，落 dirty；submodule
 * status 只比较 commit，不探内部工作区脏净）、未知前缀=unknown（前向兼容）。
 */
export interface SubmoduleEntry {
  /** submodule 在 superproject 内的相对路径（git 输出原样）。 */
  path: string
  /** 当前检出 commit 的全 oid（默认形态输出=检出侧）；uninitialized ⇒ null（无检出）。 */
  oid: string | null
  /** superproject index 记录的 gitlink oid（`git submodule status --cached` 输出）；无 index 记录 ⇒ null。 */
  recordedOid: string | null
  /** 前缀映射的展示态（见接口注）。 */
  state: 'clean' | 'dirty' | 'uninitialized' | 'mismatch' | 'unknown'
}

/** `git.submoduleStatus` 出参；无 submodule ⇒ 空数组（不抛错）。 */
export interface SubmoduleStatusResult { submodules: SubmoduleEntry[] }

/**
 * `git.auditLog` 的单条审计记录（[清单 66] 写操作审计，环缓冲）。**summary 只含
 * op 参数摘要**（白名单字段 `key=value` 串——不落 commit message 正文 / 文件内容 /
 * 密钥；spec §1.0.6 纪律延伸，audit.spec 负断言兜底）。
 */
export interface AuditEntry {
  /** 记录时刻（host ISO 时间戳）。 */
  at: string
  /** 写操作 op 名（与 @Remote 方法名同形，如 'stage' / 'branchCreate'）。 */
  op: string
  /** true = 成功出口（afterWrite 侧），false = 失败出口（catch 侧）。 */
  ok: boolean
  /** 失败时的域错误码（`git/<name>` 或 gateway 折叠码）；成功恒 null。 */
  code: string | null
  /** 方法入口到出口/抛错的耗时毫秒。 */
  durationMs: number
  /** op 参数摘要（白名单字段串，见接口注）。 */
  summary: string
}

/** `git.auditLog` 入参（[清单 66]；limit/since 过滤——缺省 = 最近 100 条）。 */
export interface AuditLogOptions {
  /** 返回条数上限（钳 [1, auditMaxEntries]）；null/缺省 = 100。 */
  limit?: number
  /** 只返回 at ≥ since 的记录（ISO 时间戳；不可解析 ⇒ git/bad-request 'invalid-options'）；null/缺省 = 不过滤。 */
  since?: string | null
}

/**
 * `git.auditLog` 出参：**newest-first**（最近一条在前——环缓冲的天然查询序）。
 * 只读方法不入环（audit.ts 只记录写操作双出口）。
 */
export interface AuditLogResult { entries: AuditEntry[] }

/** `git.generatePrDescription` 出参（[清单 46]）：title/body 由 LLM 产出经规则表规范化；conventional = title 命中 CONVENTIONAL_COMMIT_RE（[清单 17] 同款标志，不阻断）。 */
export interface PrDescription {
  /** PR 标题（单行，剥壳 + trim + 256 字符截断）。 */
  title: string
  /** PR 描述正文（Markdown，trim + 4000 字符截断；可为空串）。 */
  body: string
  /** title 命中 Conventional subject 正则（不阻断，client 提示用）。 */
  conventional: boolean
}

/**
 * `git.createPr` 入参（[清单 46]；D1=A 载体 = gh CLI）：acknowledged danger 闸
 * （创建 PR 是外部可见写动作——false ⇒ git/bad-request 'unacknowledged'，零命令）。
 * base/head 缺省（null/空串）= 交由 gh 自行推断（默认分支 / 当前分支）。
 */
export interface PrCreateOptions {
  /** PR 标题（非空；空白 ⇒ git/bad-request 'invalid-options'，零命令）。 */
  title: string
  /** PR 描述正文（经 stdin `--body-file -` 过线——不进 argv/进程清单）。 */
  body: string
  /** 目标 base 分支；null/缺省 = gh 推断（仓库默认分支）。 */
  base?: string | null
  /** head 分支；null/缺省 = 当前分支（gh 推断）。 */
  head?: string | null
  /** true = `--draft`。 */
  draft?: boolean
  /** C 级二次确认旗标（danger 闸 host 半）。 */
  acknowledged: boolean
}

/** `git.createPr` 出参：url = gh 输出回显的 PR URL；number = URL 中 `/pull/<n>` 解析值（非 GitHub 形态 URL ⇒ null）。 */
export interface PrResult {
  url: string
  number: number | null
}

/**
 * [69] `git.prForBranch` 的命中出参；方法返回 `PrLinkResult | null`——null =
 * 无关联 PR / 查询失败（gh 缺失仍抛 git/pr-tool-missing），UI 静默降级不占位。
 * state = gh 的 PR state 字段原样（'OPEN'|'CLOSED'|'MERGED'|'DRAFT' 或宿主扩展值，
 * wire 保持 string | null 前向兼容）。
 */
export interface PrLinkResult {
  url: string
  state: string | null
}

// ---------- followStatus 流帧（M9；spec §2 host 推送契约的 v1 落地面） ----------

/**
 * 一帧的推送原因（workflow 任务口径 R1–R5）：
 * initial=订阅建立即推（R1）；change=watch 防抖触发且内容有变（R2）；mutation=本插件
 * 写操作完成（R3）；poll=定时兜底重算且内容有变（R4，嵌套目录编辑只靠它）；manual=
 * 客户端显式刷新（R5，唯一旁路 R2 的原因——内容未变也推）。
 */
export type GitStatusFrameReason = 'initial' | 'change' | 'mutation' | 'poll' | 'manual'

/**
 * `git followStatus` 的下行帧。快照就绪 → `status`；不就绪（not-repository /
 * unavailable / 工作区解析不出）→ `error`——错误以帧通告而非终止流（仓库后续就绪时
 * 照常推 status 帧）；宿主/载波终止流是唯一断流方式。
 */
export type GitStatusFrame =
  | { kind: 'status'; reason: GitStatusFrameReason; snapshot: GitStatusSnapshot }
  | { kind: 'error'; reason: GitStatusFrameReason; error: GitFrameError }

/** 不就绪帧的域错误投影（wire 面 code+message；完整 details 走 `git status` 的 RemoteError）。 */
export interface GitFrameError {
  /** 域码（`git/<name>`，spec §1.0.5；client 按 code 判别不按 instanceof）。 */
  code: string
  /** host 诊断信息（英文诊断风格，不落密钥/文件内容）。 */
  message: string
}

/**
 * `git followStatus` 的上行命令（client → host，typert stream uplink）：
 * `refresh` = R5 manual 刷新；未知 type 被 host 忽略（前向兼容）。
 */
export type GitFollowCommand = { type: 'refresh' }
