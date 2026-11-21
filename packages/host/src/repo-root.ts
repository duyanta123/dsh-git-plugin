/*!
 * Phase 1 评审收口（仓库内重构，非新增移植面）：11 份引擎私有 resolveRepoRoot 副本
 * 与 3 处内联 `rev-parse --show-toplevel` 探测的共享实现。
 * 来源：仓库内 diff/graph/blame/conflicts/guard-scan/checkpoints/diagnostics/
 * staging-patch/submodule/stash/refs-admin 的同款私有副本（其文件头各自登记的
 * dsh forge git.ts:99-103 "exit 128 + not a git repository → 域码" 范式——status.ts
 * 已登记段的再应用），本文件只做同仓去重，逐字保真错误语义。
 * SPDX-License-Identifier: MIT
 */

import { assertGitOk, gitError } from './error-codes.ts'
import { signalOf } from './git-runner.ts'
import type { GitRunner, GitRunResult } from './git-runner.ts'

/**
 * repo 发现共享实现（原各引擎 resolveRepoRoot 私有副本的公共核）：
 * `rev-parse --show-toplevel` 探测（cwd = 探测起点 workspaceRoot）；
 * exit 128 + "not a git repository" ⇒ git/no-repository（details.probed =
 * workspaceRoot，与原副本逐字同构）；其余非零退出 assertGitOk 照常抛 git/git-error。
 * 返回 toplevel 原文 trim——绝对化（`resolve(workspaceRoot, …)`）由调用方按各自
 * 原语义处理（diff/graph/blame/refs-admin 原本就做 resolve；conflicts/guard-scan/
 * checkpoints/diagnostics/staging-patch/submodule/stash 原样返回 trim 结果）。
 */
export async function probeRepoRoot(
  git: GitRunner,
  workspaceRoot: string,
  op: string,
  signal?: AbortSignal,
): Promise<string> {
  const probeOp = `${op}(rev-parse --show-toplevel)`
  const probe = await git.run(['rev-parse', '--show-toplevel'], {
    cwd: workspaceRoot,
    op: probeOp,
    signal: signalOf(signal),
  })
  if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)) {
    throw gitError('git/no-repository', `not a git repository: ${workspaceRoot}`, { probed: workspaceRoot })
  }
  assertGitOk(probe, probeOp)
  return probe.stdout.trim()
}

/**
 * 「exit 128 + not a git repository」判定谓词（admin-repo.ts initRepository 前置复核
 * 专用——该处的映射与 {@link probeRepoRoot} 反置：128 + not a git repository 是预期
 * 放行、exit 0 才是 git/init-failed，故只共享判定字面量，映射留在原地）。
 */
export function isNotARepositoryProbe(probe: GitRunResult): boolean {
  return probe.exitCode === 128 && /not a git repository/i.test(probe.stderr)
}
