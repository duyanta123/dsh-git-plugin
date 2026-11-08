/**
 * dsh-gitkit — 仓库行尾/编码诊断引擎（v2 批次三：[清单 56] repoDiagnostics；
 * docs/v2-implementation-plan.md §5.3/§5.5）。
 *
 * 实例纪律：只读 → readonly runner（两键 config --get）；工作区文件抽样走 node fs
 * （不进 git 对象库——blame.ts countWorktreeLines 同款 node 面纪律；中文路径由
 * node fs 原样字节语义承载，v1 的 `-z` porcelain 纪律 CLAUDE.md:65 不受影响）。
 *
 * 抽样口径（方案 §5.3：「限顶层 + 已知文本后缀，封顶」）：
 *   - 只扫仓库**顶层**（depth 1 文件——方案 §5.3 收窄口径；不递归、不进 .git）；
 *   - 只扫已知文本后缀（TEXT_SUFFIXES 表自研——常见代码/文档/配置后缀；无后缀文件
 *     不抽样，误报面收窄）；
 *   - 封顶 DIAGNOSTICS_SAMPLE_MAX_FILES 个文件（超出停止抽样，计数仍如实）；
 *   - `mixedEolFiles` 清单封顶（方案 §5.2「文件清单封顶，超出仅计数」——wire 类型
 *     无溢出计数字段，现形状以「截断清单 + worktreeCrlfCount 量级」承载，类型注已记）。
 *
 * config 键语义（identity configGet 同口径）：exit 0 有值（空串值按缺失 null）、
 * exit 1 = 未设置 null、其余非零 ⇒ git/git-error。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertGitOk, gitError, gitRunError } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { RepoDiagnostics } from './types.ts'

/** 抽样文件数封顶（引擎级护栏）。 */
export const DIAGNOSTICS_SAMPLE_MAX_FILES = 100

/** mixedEolFiles 清单封顶（方案 §5.2「文件清单封顶」；超出截断）。 */
export const DIAGNOSTICS_MIXED_LIST_MAX = 50

/** 已知文本后缀表（自研；小写匹配）。 */
const TEXT_SUFFIXES: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml',
  '.css', '.scss', '.html', '.xml', '.sql', '.sh', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.toml', '.ini', '.cfg', '.env',
]

/** diagnostics 引擎构造项（预留 logger 诊断位）。 */
export interface DiagnosticsEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许——index.ts 传 this.logger）。 */
  logger?: { debug(message: string): void } | undefined
}

export class DiagnosticsEngine {
  private readonly logger: DiagnosticsEngineOptions['logger']

  constructor(
    /** 只读实例（config --get 两键）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（repoRoot 发现）。 */
    private readonly workspace: WorkspaceResolver,
    options: DiagnosticsEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  /**
   * 仓库诊断（[清单 56]；只读）：core.autocrlf/core.eol 生效值 + 顶层文本文件 CRLF
   * 抽样（含 CRLF 文件计数 + 混用清单）。
   * @throws git/no-repository、git/session-workspace-unresolved、git/timeout、
   *   git/git-error（config 失败兜底）。
   */
  async repoDiagnostics(signal?: AbortSignal): Promise<RepoDiagnostics> {
    const active = signal ?? neverAborted()
    const repoRoot = await this.resolveRepoRoot('repoDiagnostics', active)
    const autocrlf = await this.configGet(repoRoot, 'core.autocrlf', active)
    const coreEol = await this.configGet(repoRoot, 'core.eol', active)
    const sample = await this.sampleWorktreeEol(repoRoot)
    this.logger?.debug(`git repoDiagnostics: autocrlf=${autocrlf ?? '(unset)'} coreEol=${coreEol ?? '(unset)'} crlfCount=${String(sample.crlfCount)} mixedCount=${String(sample.mixedFiles.length)}`)
    return {
      autocrlf,
      coreEol,
      mixedEolFiles: sample.mixedFiles.slice(0, DIAGNOSTICS_MIXED_LIST_MAX),
      worktreeCrlfCount: sample.crlfCount,
    }
  }

  /** 单键 `git config --get`（identity.configGet 同口径：0=有值/空串按缺失、1=null、其余 git-error）。 */
  private async configGet(repoRoot: string, key: 'core.autocrlf' | 'core.eol', signal: AbortSignal): Promise<string | null> {
    const result = await this.gitRead.run(['config', '--get', key], {
      cwd: repoRoot, op: `repoDiagnostics(config --get ${key})`, signal,
    })
    if (result.exitCode === 0) {
      const value = result.stdout.trim()
      return value === '' ? null : value
    }
    if (result.exitCode === 1) return null
    throw gitRunError(`repoDiagnostics(config --get ${key})`, result.exitCode, result.stderr, result.truncated)
  }

  /** 顶层文本文件 CRLF 抽样（node fs；单文件读取失败按未含 CRLF 处理——如实降级）。 */
  private async sampleWorktreeEol(repoRoot: string): Promise<{ crlfCount: number; mixedFiles: string[] }> {
    let names: string[]
    try {
      names = await readdir(repoRoot, { withFileTypes: true }).then((entries) =>
        entries.filter((entry) => entry.isFile() && isTextSuffix(entry.name)).map((entry) => entry.name),
      )
    } catch {
      // 目录不可读（权限/竞争）：抽样降级为零样本，config 值仍返回（诊断主键不受影响）。
      return { crlfCount: 0, mixedFiles: [] }
    }
    let crlfCount = 0
    const mixedFiles: string[] = []
    for (const name of names.slice(0, DIAGNOSTICS_SAMPLE_MAX_FILES)) {
      let content: string
      try {
        content = await readFile(join(repoRoot, name), 'utf8')
      } catch {
        continue
      }
      let hasCrlf = false
      let hasLfOnly = false
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') {
          if (i > 0 && content[i - 1] === '\r') hasCrlf = true
          else hasLfOnly = true
          if (hasCrlf && hasLfOnly) break
        }
      }
      if (hasCrlf) crlfCount += 1
      if (hasCrlf && hasLfOnly) mixedFiles.push(name)
    }
    return { crlfCount, mixedFiles }
  }

  /** repo 发现（blame.ts 同款：exit 128 + not a git repository ⇒ git/no-repository）。 */
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

/** 已知文本后缀判定（小写匹配；无后缀文件不抽样）。 */
function isTextSuffix(name: string): boolean {
  const lower = name.toLowerCase()
  return TEXT_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
