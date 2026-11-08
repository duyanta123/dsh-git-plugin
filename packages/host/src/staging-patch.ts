/**
 * dsh-gitkit — hunk/行级暂存引擎（v2 批次三：[清单 10] stagePatch；
 * docs/v2-implementation-plan.md §5.3/§5.5）。
 *
 * 实例纪律：改 index 的写操作 → **write** runner（WRITE_PREFIX + fastTimeoutMs，
 * mutations stage/unstage 同款）；patch 文本经 stdin 传入（`apply` 的 stdin patch
 * 形态，`-` 路径免临时文件）。零解析器移植——命令形态按 git 文档与本机
 * git 2.55.0.windows.2 口径自研。
 *
 * 命令形态：`git apply --cached --recount --whitespace=nowarn [-R]`
 *   - `--cached`：只改 index 不触工作区（D7=B 两态的载体）；
 *   - `--recount`：容忍 client 行级选择重组后的 hunk 头计数漂移（§5.3 语义行）；
 *   - `--whitespace=nowarn`：行尾/空白策略不产生 warning 噪声（CRLF 仓库的
 *     行尾漂移不阻断——§5.10 风险行的「提示回落文件级 stage」由失败如实报错承担）；
 *   - `-R`（direction='unstage'）：反向应用（staged 侧选中 → 从暂存还原）。
 *
 * 前置拒绝（零命令，客户端友好先行）：
 *   - patch 文本含 `GIT binary patch` / `Binary files … differ` ⇒ 二进制 hunk 拒绝；
 *   - patch 文本含 `old mode` 行 ⇒ 模式变更 hunk 拒绝（`new file mode`/`deleted file
 *     mode` 是新增/删除文件的正常 diff 头，**不拒**——拒绝它们会封死 hunk 级 stage
 *     新文件/删文件的主路径）。
 *   二者均落 `git/stage-patch-failed`（details.stderr 携带英文原因文本，过
 *   sanitizeStderr——自有文本无害透传）。apply 非零退出（patch 与 index 不符等）⇒
 *   同码，stderr 原样脱敏进 details。
 */

import { assertGitOk, gitError, sanitizeStderr } from './error-codes.ts'
import type { GitRunner } from './git-runner.ts'
import type { WorkspaceResolver } from './workspace.ts'
import type { StagePatchOptions, StagePatchResult } from './types.ts'

/** staging-patch 引擎构造项（预留 logger 诊断位，MutationEngine 同款）。 */
export interface StagingPatchEngineOptions {
  /** 可选 logger（exactOptionalPropertyTypes：显式 undefined 允许——index.ts 传 this.logger）。 */
  logger?: { debug(message: string): void } | undefined
}

/** patch 文本中的二进制 hunk 特征（git apply 文档 + git diff 输出口径）。 */
const BINARY_PATCH_RE = /GIT binary patch|^Binary files .* differ/m
/** patch 文本中的模式变更特征（`old mode <n>` + `new mode <n>` 成对出现——file mode flip）。 */
const MODE_CHANGE_RE = /^old mode [0-7]{6}$/m

/** patch 文本中的 hunk 头计数（`@@ -a,b +c,d @@` 行数 = staged 反馈值）。 */
export function countHunks(patch: string): number {
  return (patch.match(/^@@ /gm) ?? []).length
}

export class StagingPatchEngine {
  private readonly logger: StagingPatchEngineOptions['logger']

  constructor(
    /** write 实例（WRITE_PREFIX + fastTimeoutMs——`apply --cached` 改 index）。 */
    private readonly gitWrite: GitRunner,
    /** 只读实例（repoRoot 发现 probe——预检走只读，四实例纪律）。 */
    private readonly gitRead: GitRunner,
    /** 工作区解析（repoRoot 发现；blame.ts resolveRepoRoot 同款 probe）。 */
    private readonly workspace: WorkspaceResolver,
    options: StagingPatchEngineOptions = {},
  ) {
    this.logger = options.logger
  }

  /**
   * hunk/行级 stage（[清单 10]；权限 B）：前置二进制/模式变更拒绝 →
   * `git apply --cached --recount --whitespace=nowarn [-R]`（patch 走 stdin）。
   * @returns staged = 应用的 hunk 数。
   * @throws git/bad-request 'invalid-options'（空 path/patch、direction 越界）、
   *   git/stage-patch-failed（二进制/模式 hunk 前置拒绝；apply 失败兜底）、
   *   git/no-repository、git/session-workspace-unresolved、git/timeout、git/git-error。
   */
  async stagePatch(options: StagePatchOptions, signal?: AbortSignal): Promise<StagePatchResult> {
    const path = requireNonEmpty(options.path, 'path')
    const patch = requireNonEmpty(options.patch, 'patch')
    if (options.direction !== undefined && options.direction !== 'stage' && options.direction !== 'unstage') {
      throw gitError('git/bad-request', `git stagePatch: direction must be 'stage' or 'unstage', got ${JSON.stringify(options.direction)}`, {
        reason: 'invalid-options', paths: [], expected: null, actual: null,
      })
    }
    if (BINARY_PATCH_RE.test(patch)) {
      this.logger?.debug(`git stagePatch: binary hunk rejected for ${path}`)
      throw gitError('git/stage-patch-failed', `git stagePatch: binary hunks cannot be applied selectively; stage the whole file instead`, {
        path,
        stderr: sanitizeStderr('patch contains a binary hunk (GIT binary patch / Binary files differ); partial application is unsupported'),
      })
    }
    if (MODE_CHANGE_RE.test(patch)) {
      this.logger?.debug(`git stagePatch: mode-change hunk rejected for ${path}`)
      throw gitError('git/stage-patch-failed', `git stagePatch: file-mode change hunks cannot be applied selectively; stage the whole file instead`, {
        path,
        stderr: sanitizeStderr('patch contains a file-mode change hunk (old mode/new mode); partial application is unsupported'),
      })
    }
    const repoRoot = await this.resolveRepoRoot('stagePatch', signal)
    const args = ['apply', '--cached', '--recount', '--whitespace=nowarn']
    if (options.direction === 'unstage') args.push('-R')
    const applied = await this.gitWrite.run(args, {
      cwd: repoRoot,
      op: `stagePatch(git apply --cached${options.direction === 'unstage' ? ' -R' : ''})`,
      signal: signal ?? neverAborted(),
      stdin: patch,
    })
    if (applied.exitCode !== 0) {
      // apply 失败 = patch 与 index/worktree 现状不符（语义行的「patch 与 index 冲突」
      // 与其余 apply 失败同码——details.stderr 脱敏后给 client 回落文件级 stage 的线索）。
      throw gitError('git/stage-patch-failed', `git stagePatch: the patch does not apply to the current index (exit ${String(applied.exitCode)})`, {
        path,
        stderr: sanitizeStderr(applied.stderr),
      })
    }
    assertGitOk(applied, `stagePatch(git apply --cached${options.direction === 'unstage' ? ' -R' : ''})`)
    const hunks = countHunks(patch)
    this.logger?.debug(`git stagePatch: path=${path} direction=${options.direction ?? 'stage'} hunks=${String(hunks)}`)
    return { staged: hunks }
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

/** 非空字符串守卫（空 ⇒ bad-request 'invalid-options'）。 */
function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw gitError('git/bad-request', `git stagePatch: a non-empty ${name} is required`, {
      reason: 'invalid-options', paths: [], expected: null, actual: null,
    })
  }
  return value
}

function neverAborted(): AbortSignal {
  const controller = new AbortController()
  return controller.signal
}
