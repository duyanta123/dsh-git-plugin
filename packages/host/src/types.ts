/**
 * @dsh-plugin/git — RPC 线路类型（wire types）。spec 权威：research/capability-spec.md §1.0.3
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
}

export interface PushOptions {
  /** [清单 26]；无 upstream 且 false ⇒ git/no-upstream。 */
  setUpstream: boolean
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

/** limit 钳到 [1, logMaxLimit]；skip ≥ 0。 */
export interface LogOptions { limit: number; skip: number }
/** path=null：仅 meta+numstat；path 给定：含该文件 patch。 */
export interface ShowOptions { oid: string; path: string | null }

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
