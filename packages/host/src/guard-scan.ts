/**
 * dsh-gitkit — 提交护栏扫描引擎（v2 批次三：[清单 21] 提交护栏 + [清单 22] secret
 * 扫描；docs/v2-implementation-plan.md §5.3/§5.5；D5=A 拍板的豁免语义）。
 *
 * 实例纪律：**只读**操作 → readonly runner（staged 内容读取走 `git cat-file --batch`
 * / `--batch-check`——方案 §5.5 指认的 cat-file 面）；文件系统抽样走 node fs
 * （repoDiagnostics 的工作区文件——blame.ts countWorktreeLines 同款 node 面纪律）。
 * 模式表**自研、零新依赖**（§0.4-5 平台硬约束 + 方案 §5.5）——无任何外部 secret
 * 扫描库进入（移植合规 §0.4-8：对照仅 C 级登记）。
 *
 * 违规类别（CommitViolation.kind）：
 *   - 'secret'：密钥模式命中（token 格式 / PEM 头 / .env 键值——模式表见 SECRET_PATTERNS）。
 *     **D5=A：硬阻断不可豁免**——commit() 守卫强制（commit-blocked overridable:false）。
 *   - 'env-file'：路径形态的环境变量文件（.env / .env.*（除 .env.example）/ *.env）。
 *   - 'large-file'：staged blob > Config.guardLargeFileBytes（默认 1 MiB）。
 *   - 'build-artifact'：staged 路径落在构建产物目录（Config.guardBuildPatterns，
 *     默认常见产物目录表）。
 *   - 'eol-mixed'：文件同时含 CRLF 与裸 LF 行（CRLF 抽样）。
 *
 * 脱敏纪律（redactedMatch）：命中展示文本绝不落明文密钥——按模式的「安全前缀 +
 * 掩码」规则截断（SECRET_PATTERNS 每行 redact 字段；sanitizeStderr 纪律的延伸）。
 * 无 SecretPattern 命中的违规（env-file/large-file/build-artifact/eol-mixed）不产
 * redactedMatch（null）。
 *
 * 体量纪律：staged blob 尺寸经 `cat-file --batch-check` 一次取回；内容经
 * `cat-file --batch` 一次取回（仅 ≤ SCAN_CONTENT_MAX_BYTES 的 blob——大体量文件只
 * 尺寸检测，内容不进内存）；文件数封顶 SCAN_MAX_FILES、违规条数封顶
 * SCAN_MAX_VIOLATIONS（超出截断且仅 logger 记录——不注入占位 violation，防污染
 * D5 的 overridable 语义；方案 §5.10 防失控）。
 *
 * D5=A 的 host 强制面：本模块导出 `hardBlockViolations()`——commit() 守卫链消费
 * （secret ⇒ git/commit-blocked overridable:false，零命令）。env-file/large-file/
 * build-artifact 的豁免 = client danger 勾选闸（UI 面，方案 §5.6）——host commit 不
 * 重复拦截（无 bypass wire 字段可承载豁免语义，登记为方案空白的施工解释，见
 * ModuleResult.openIssues 口径）。
 */

import { assertGitOk, gitError } from './error-codes.ts'
import type { GitLoggerFace } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { CommitScanResult, CommitViolation } from './types.ts'

// ---------- 体量常量（方案 §5.10 防失控；Config 之外的引擎级护栏） ----------

/** 单个 staged blob 进入内容扫描的字节上限（大体量只尺寸检测——内容不进内存）。 */
export const SCAN_CONTENT_MAX_BYTES = 256 * 1024
/** 单次扫描的 staged 文件数封顶（超出截断，detail 注记）。 */
export const SCAN_MAX_FILES = 200
/** violations 条数封顶（超出截断，detail 注记）。 */
export const SCAN_MAX_VIOLATIONS = 200

// ---------- 密钥模式表（自研；高置信度收窄——方案 §5.10 误报纪律） ----------

/** secret 模式表的行形状：正则 + 命中说明 + redactedMatch 的掩码规则。 */
export interface SecretPattern {
  /** 高置信度密钥格式正则（m 标志逐行锚定按需；不带 g——逐文件首命中即报）。 */
  pattern: RegExp
  /** 英文命中说明（进 detail）。 */
  label: string
  /**
   * redactedMatch 规则：'marker' = 模式自身是固定标记文本（PEM 头），原样展示；
   * 'prefix' = 保留 match 前 keepPrefix 字符、其余以 '*' 掩码（token 格式——保留
   * 固定前缀帮助识别提供方，掩码本体）。
   */
  redact: { kind: 'marker' } | { kind: 'prefix'; keepPrefix: number }
}

/**
 * 高置信度密钥模式表（默认集——「高置信度密钥格式」收窄口径；Config.guardSecretPatterns
 * 为用户叠加面）。逐条来源：各提供方公开文档的 token 形状；正则自写，零搬运。
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  {
    // PEM 私钥头（任意算法变体）——头部文本本身非密钥内容（marker 原样展示）。
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    label: 'PEM private key header',
    redact: { kind: 'marker' },
  },
  {
    // AWS Access Key ID（固定 AKIA 前缀 + 16 位大写数字）。
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    label: 'AWS access key id',
    redact: { kind: 'prefix', keepPrefix: 4 },
  },
  {
    // GitHub token（ghp_/gho_/ghu_/ghs_/ghr_ 前缀 + ≥20 位）。
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    label: 'GitHub token',
    redact: { kind: 'prefix', keepPrefix: 4 },
  },
  {
    // Slack token（xoxb-/xoxp-/xoxa-/xoxr-/xoxs- 前缀）。
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    label: 'Slack token',
    redact: { kind: 'prefix', keepPrefix: 5 },
  },
  {
    // Google API key（AIza 前缀 + 35 位）。
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    label: 'Google API key',
    redact: { kind: 'prefix', keepPrefix: 4 },
  },
  {
    // OpenAI 风格 key（sk- 前缀 + ≥20 位；sk- 裸前缀误报率高，长度收窄置信度）。
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
    label: 'OpenAI-style API key',
    redact: { kind: 'prefix', keepPrefix: 3 },
  },
  {
    // Authorization/Bearer 头携带实际值（值体 ≥16 位——掩码全值）。
    pattern: /\bauthorization["'\s]*:\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]{16,}/i,
    label: 'authorization header value',
    redact: { kind: 'prefix', keepPrefix: 13 },
  },
])

/**
 * .env 键值行模式（凭据形 key=value；只在 env 形态文件内启用——全局套用会把
 * README 里的 `PASSWORD=示例` 文档段落误伤）。仅凭据形 key 后缀（PASSWORD/PASSWD/
 * PWD/SECRET/TOKEN/API_KEY/ACCESS_KEY），值 ≥6 位非空白。
 */
const ENV_SECRET_LINE_RE = /^(?:export\s+)?[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*=\s*["']?(\S{6,})/m

/**
 * 构建产物目录默认表（方案 §5.5：`guardBuildPatterns` 默认常见产物目录表）。
 * 路径段前缀匹配（仓库相对路径按 `/` 分段）；尾随 `/` 为目录语义。
 */
export const DEFAULT_BUILD_PATTERNS: readonly string[] = Object.freeze([
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  'vendor/',
  'target/',
])

/** 大文件阈值默认（方案 §5.5：guardLargeFileBytes 默认 1 MiB）。 */
export const DEFAULT_GUARD_LARGE_FILE_BYTES = 1_048_576

// ---------- 纯函数（导出供夹具单测） ----------

/** 模式命中 → 脱敏展示文本（「安全前缀 + 掩码」规则；绝不回明文密钥）。 */
export function redactMatch(pattern: SecretPattern, match: string): string {
  if (pattern.redact.kind === 'marker') return match
  const keep = Math.min(pattern.redact.keepPrefix, match.length)
  return match.slice(0, keep) + '*'.repeat(Math.max(0, match.length - keep))
}

/** env 文件路径形态判定（.env / .env.<name>（除 .env.example）/ *.env）。 */
export function isEnvFilePath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  if (base === '.env') return true
  if (base.endsWith('.env')) return true
  if (base.startsWith('.env.') && base !== '.env.example') return true
  return false
}

/** 构建产物路径判定（Config 模式表 ∪ 默认表；段前缀匹配）。 */
export function isBuildArtifactPath(path: string, extraPatterns: readonly string[]): boolean {
  const normalized = path.replaceAll('\\', '/')
  const patterns = [...DEFAULT_BUILD_PATTERNS, ...extraPatterns]
  return patterns.some((raw) => {
    const pattern = raw.replaceAll('\\', '/')
    const withSlash = pattern.endsWith('/') ? pattern : `${pattern}/`
    return normalized === pattern.replace(/\/$/, '')
      || normalized.startsWith(withSlash)
      || normalized.includes(`/${withSlash}`)
  })
}

/** 文本 EOL 计数（CRLF 行数 / 裸 LF 行数；裸 LF = 前一字符非 \r 的 \n）。 */
export function countEol(text: string): { crlf: number; lfOnly: number; firstMixedLine: number | null } {
  let crlf = 0
  let lfOnly = 0
  let firstMixedLine: number | null = null
  let line = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      if (i > 0 && text[i - 1] === '\r') {
        crlf += 1
        if (lfOnly > 0 && firstMixedLine === null) firstMixedLine = line
      } else {
        lfOnly += 1
        if (crlf > 0 && firstMixedLine === null) firstMixedLine = line
      }
      line += 1
    }
  }
  return { crlf, lfOnly, firstMixedLine }
}

/** 单文件 secret 扫描（内置模式表 + env 键值行 + 用户叠加固定串；首个命中即返回）。 */
export function scanTextForSecret(
  path: string,
  text: string,
  extraNeedles: readonly string[],
): CommitViolation | null {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.pattern.exec(text)
    if (match !== null) {
      const line = lineOfOffset(text, match.index)
      return {
        kind: 'secret',
        path,
        detail: `matched ${pattern.label}`,
        sizeBytes: null,
        line,
        redactedMatch: redactMatch(pattern, match[0]),
      }
    }
  }
  if (isEnvFilePath(path)) {
    const match = ENV_SECRET_LINE_RE.exec(text)
    if (match !== null) {
      const line = lineOfOffset(text, match.index)
      return {
        kind: 'secret',
        path,
        detail: 'credential-shaped key=value assignment in an environment file',
        sizeBytes: null,
        line,
        redactedMatch: `${(match[0].split('=')[0] ?? '').trim()}=***`,
      }
    }
  }
  for (const needle of extraNeedles) {
    if (needle === '') continue
    const at = text.toLowerCase().indexOf(needle.toLowerCase())
    if (at >= 0) {
      const line = lineOfOffset(text, at)
      return {
        kind: 'secret',
        path,
        detail: 'matched a configured guardSecretPatterns entry',
        sizeBytes: null,
        line,
        redactedMatch: `${needle.slice(0, 2)}${'*'.repeat(Math.max(0, needle.length - 2))}`,
      }
    }
  }
  return null
}

/** 1 起行号（offset 所在行）。 */
function lineOfOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line += 1
  }
  return line
}

// ---------- 引擎 ----------

/** GuardScanEngine 构造项（Config 护栏参数）。 */
export interface GuardScanOptions {
  /** 大文件阈值字节（Config.guardLargeFileBytes，默认 1 MiB）。 */
  largeFileBytes: number
  /** 用户叠加的构建产物目录模式（Config.guardBuildPatterns）。 */
  buildPatterns: readonly string[]
  /** 用户叠加的 secret 固定串（Config.guardSecretPatterns——大小写不敏感子串，非正则）。 */
  secretPatterns: readonly string[]
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许——index.ts/commit.ts 传 this.logger）。 */
  logger?: GitLoggerFace | undefined
}

export class GuardScanEngine {
  private readonly options: GuardScanOptions

  constructor(
    /** 只读实例（staged 清单/blob 尺寸/内容读取）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（repoRoot 发现）。 */
    private readonly workspace: WorkspaceResolver,
    options: GuardScanOptions,
  ) {
    // 归一兜底：真宿主 = schemastery 默认；直接构造（测试）= 常量默认（防御 undefined
    // ——schemastery .default 只在键缺席时生效，显式 undefined 不触发）。
    this.options = {
      largeFileBytes: options.largeFileBytes ?? DEFAULT_GUARD_LARGE_FILE_BYTES,
      buildPatterns: options.buildPatterns ?? [],
      secretPatterns: options.secretPatterns ?? [],
      logger: options.logger,
    }
  }

  /**
   * staged 预检（[21][22]；只读）：`diff --cached --raw -z` 取 staged 清单 + blob oid →
   * `cat-file --batch-check` 尺寸 → `cat-file --batch` 内容（≤ SCAN_CONTENT_MAX_BYTES
   * 的 blob）→ 分类扫描。blocked = violations 非空。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（清单/cat-file 失败兜底）。
   */
  async scanStaged(signal?: AbortSignal): Promise<CommitScanResult> {
    const repoRoot = await this.resolveRepoRoot('scanStaged', signal)
    const violations = await scanStagedContents(this.gitRead, repoRoot, this.options, signal)
    this.options.logger?.debug(`git scanStaged: violations=${String(violations.length)}`)
    return { blocked: violations.length > 0, violations }
  }

  /** repo 发现（blame.ts 同款）。 */
  private async resolveRepoRoot(op: string, signal?: AbortSignal): Promise<string> {
    const resolution = await this.workspace.resolve()
    const probe = await this.gitRead.run(['rev-parse', '--show-toplevel'], {
      cwd: resolution.root,
      op: `${op}(rev-parse --show-toplevel)`,
      signal: signal ?? neverAborted(),
    })
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
      throw gitError('git/no-repository', `not a git repository: ${resolution.root}`, { probed: resolution.root })
    }
    assertGitOk(probe, `${op}(rev-parse --show-toplevel)`)
    return probe.stdout.trim()
  }
}

/**
 * staged 内容扫描的可复用核心（GuardScanEngine 与 commit() 守卫共用——同一 repoRoot
 * 下零重复探测）。输入 = 已解析的 repoRoot；输出 = violations（SCAN_MAX_VIOLATIONS /
 * SCAN_MAX_FILES 封顶截断——封顶时仅 logger.debug 记录，**不注入占位 violation**
 * （kind 联合无占位值，伪造 secret 条目会污染 D5 的 overridable 语义）；封顶属
 * 引擎级失控护栏，实际触达即提示 Config 收窄扫描范围）。
 */
export async function scanStagedContents(
  gitRead: GitRunner,
  repoRoot: string,
  options: Pick<GuardScanOptions, 'largeFileBytes' | 'buildPatterns' | 'secretPatterns' | 'logger'>,
  signal?: AbortSignal,
): Promise<CommitViolation[]> {
  const active = signal ?? neverAborted()
  // 1. staged 清单 + 新 blob oid（--raw -z --no-abbrev：`:mode mode oldOid newOid
  //    status\0path\0`；R/C 重命名/复制为双路径 `…status\0<旧>\0<新>\0`——parseStagedRaw
  //    变长消费并取新路径；A/M/R/C/T 带内容可比对——D（删除）与全零 oid（U 未合并等）
  //    无 blob 可扫）。--no-abbrev 钉死全 40 位 oid：缺省缩写 oid（7 位起）在大仓可
  //    cat-file 歧义失败 → readBlobSize null → 内容扫描被静默跳过（另一类扫描缺口，
  //    评审修复连带加固）。
  const raw = await gitRead.run(['diff', '--cached', '--raw', '-z', '--no-abbrev'], {
    cwd: repoRoot, op: 'scanStaged(diff --cached --raw)', signal: active,
  })
  assertGitOk(raw, 'scanStaged(diff --cached --raw)')
  const entries = parseStagedRaw(raw.stdout)
  const violations: CommitViolation[] = []
  let truncated = false
  let processedFiles = 0
  for (const entry of entries) {
    if (processedFiles >= SCAN_MAX_FILES || violations.length >= SCAN_MAX_VIOLATIONS) {
      truncated = true
      break
    }
    processedFiles += 1
    // 2. 路径形态类违规（env-file / build-artifact）——零额外命令。
    if (isEnvFilePath(entry.path)) {
      violations.push({
        kind: 'env-file',
        path: entry.path,
        detail: 'environment file scheduled for commit (.env family)',
        sizeBytes: null,
        line: null,
        redactedMatch: null,
      })
    }
    if (isBuildArtifactPath(entry.path, options.buildPatterns)) {
      violations.push({
        kind: 'build-artifact',
        path: entry.path,
        detail: 'path is inside a build output directory',
        sizeBytes: null,
        line: null,
        redactedMatch: null,
      })
    }
    if (violations.length >= SCAN_MAX_VIOLATIONS) { truncated = true; break }
    if (entry.oid === null) continue
    // 3. blob 尺寸（--batch-check；体量与内容读取分离）。
    const size = await readBlobSize(gitRead, repoRoot, entry.oid, active)
    if (size !== null && size > options.largeFileBytes) {
      violations.push({
        kind: 'large-file',
        path: entry.path,
        detail: `staged blob is ${String(size)} bytes (threshold ${String(options.largeFileBytes)})`,
        sizeBytes: size,
        line: null,
        redactedMatch: null,
      })
      if (violations.length >= SCAN_MAX_VIOLATIONS) { truncated = true; break }
      continue
    }
    // 4. 内容扫描（≤ SCAN_CONTENT_MAX_BYTES——二进制由 NUL 探测跳过）。
    if (size === null || size > SCAN_CONTENT_MAX_BYTES) continue
    const text = await readBlobText(gitRead, repoRoot, entry.oid, active)
    if (text === null) continue
    const secret = scanTextForSecret(entry.path, text, options.secretPatterns)
    if (secret !== null) {
      secret.sizeBytes = size
      violations.push(secret)
      if (violations.length >= SCAN_MAX_VIOLATIONS) { truncated = true; break }
    }
    // 5. CRLF 抽样（eol-mixed）。
    const eol = countEol(text)
    if (eol.crlf > 0 && eol.lfOnly > 0) {
      violations.push({
        kind: 'eol-mixed',
        path: entry.path,
        detail: 'file mixes CRLF and LF line endings',
        sizeBytes: size,
        line: eol.firstMixedLine,
        redactedMatch: null,
      })
      if (violations.length >= SCAN_MAX_VIOLATIONS) { truncated = true; break }
    }
  }
  if (truncated) options.logger?.debug('git scanStaged: scan cap reached; remaining entries unlisted')
  return violations
}

/**
 * D5=A 的 host 强制面（commit() 守卫消费）：violations 中的 secret 类硬阻断条目；
 * 空 = 无 secret（overridable 场景）。commit() 的守卫语义：secret ⇒ git/commit-blocked
 * （overridable:false，零命令）；其余类别不拦 host commit（client danger 勾选豁免——
 * 文件头注）。
 */
export function hardBlockViolations(violations: readonly CommitViolation[]): CommitViolation[] {
  return violations.filter((violation) => violation.kind === 'secret')
}

/** `git/commit-blocked` 工厂（commit() 守卫与可测性导出）。 */
export function commitBlockedError(violations: readonly CommitViolation[]): never {
  const secrets = hardBlockViolations(violations)
  throw gitError('git/commit-blocked', `git commit: staged content violates the commit guard (${String(secrets.length)} secret violation(s)); remove the secret(s) and restage`, {
    violations: [...violations],
    overridable: secrets.length === 0,
  })
}

/**
 * 解析 `diff --cached --raw -z` 输出（本机 git 2.55.0.windows.2 实测口径）：每条
 * `:<oldMode> <newMode> <oldOid> <newOid> <status>\0<path>\0`——**R（重命名）/C（复制）
 * 记录是双路径**：`…<status>\0<旧路径>\0<新路径>\0`（实测：
 * `:100644 100644 b7767f6 b7767f6 R100\0a.txt\0b.txt\0`），其余 A/M/D/T/U 等单路径。
 * 解析按 status 首字母**变长消费**（固定 i+=2 配对会把 R/C 之后的所有记录错位——
 * 紧随其后的暂存条目被整体丢弃，评审 high 项修复；错位必须 throw 而非静默跳过）。
 * 扫描目标 = **新路径**（R/C 的新 blob 挂在新路径上——暂存后的现状；旧路径是 HEAD
 * 侧原像，不进扫描集）。status 含相似度评分（R100/C75）取前导字母；A/M/R/C/T 取
 * newOid；D / 全零 newOid（U 未合并等）归 null。
 * @throws 非 \0 终止 / 记录中途出现非 meta 槽 / meta 字段不足 / R·C 缺路径槽（契约破坏要响）。
 */
export function parseStagedRaw(stdout: string): Array<{ path: string; oid: string | null }> {
  const parts = stdout.split('\0')
  if (parts.at(-1) !== '') {
    throw new Error('staged raw output is not NUL-terminated')
  }
  const entries: Array<{ path: string; oid: string | null }> = []
  let i = 0
  // 末槽是 \0 终止符的空串；其前的每个槽都必须是一条记录的 meta。
  while (i < parts.length - 1) {
    const meta = parts[i] as string
    if (!meta.startsWith(':')) {
      throw new Error(`malformed staged raw stream at slot ${String(i)}: expected ':<meta>', got ${JSON.stringify(meta.slice(0, 48))}`)
    }
    const columns = meta.slice(1).split(' ')
    if (columns.length < 5) {
      throw new Error(`malformed staged raw meta: ${JSON.stringify(meta)}`)
    }
    const status = columns[4] as string
    const newOid = columns[3] as string
    const kind = status[0] ?? ''
    const pathCount = kind === 'R' || kind === 'C' ? 2 : 1
    const paths = parts.slice(i + 1, i + 1 + pathCount)
    if (paths.length !== pathCount || paths.some((path) => path === '')) {
      throw new Error(`malformed staged raw record: status ${JSON.stringify(status)} needs ${String(pathCount)} path field(s), got ${JSON.stringify(paths)}`)
    }
    const oid = kind === 'D' || /^[0]+$/.test(newOid) ? null : newOid
    entries.push({ path: paths[paths.length - 1] as string, oid })
    i += 1 + pathCount
  }
  return entries
}

/** blob 尺寸（`cat-file --batch-check`；探测失败 ⇒ null——由后续内容面如实兜底）。 */
async function readBlobSize(gitRead: GitRunner, repoRoot: string, oid: string, signal: AbortSignal): Promise<number | null> {
  const result = await gitRead.run(['cat-file', '--batch-check'], {
    cwd: repoRoot, op: 'scanStaged(cat-file --batch-check)', signal, stdin: `${oid}\n`,
  })
  if (result.exitCode !== 0) return null
  const row = result.stdout.split('\n').find((line) => line.startsWith(oid))
  if (row === undefined) return null
  const size = Number(row.split(' ')[2])
  return Number.isFinite(size) && size >= 0 ? size : null
}

/** blob 文本（`cat-file --batch`；NUL 字节 = 二进制跳过；失败 ⇒ null）。 */
async function readBlobText(gitRead: GitRunner, repoRoot: string, oid: string, signal: AbortSignal): Promise<string | null> {
  const result = await gitRead.run(['cat-file', '--batch'], {
    cwd: repoRoot, op: 'scanStaged(cat-file --batch)', signal, stdin: `${oid}\n`,
  })
  if (result.exitCode !== 0 || result.truncated) return null
  // 输出形如 `<oid> blob <size>\n<content>\n`——剥头部行；二进制（NUL 前 8 KiB）跳过。
  const headerEnd = result.stdout.indexOf('\n')
  if (headerEnd < 0) return null
  const body = result.stdout.slice(headerEnd + 1)
  const probeWindow = body.slice(0, 8192)
  if (probeWindow.includes('\u0000')) return null
  return body.replace(/\r?\n$/, '')
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
