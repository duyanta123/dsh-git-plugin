/**
 * v2 批次三 — hunk/行级暂存测试（[清单 10] stagePatch；docs/v2-implementation-plan.md
 * §5.7 host 真仓库范式行）。
 *
 * 覆盖：两 hunk patch 只 stage 一个 → world 重读 index（staged 侧只含选中 hunk、
 * worktree 侧保留未选中 hunk）；行级 patch `--recount`（hunk 头计数漂移容忍）；
 * **direction:'unstage' 反向应用 → world 重读 index 恢复（D7=B）**；二进制 hunk 拒绝
 * （零命令）；模式变更 hunk 拒绝（零命令）；patch 与 index 不符 ⇒ stage-patch-failed；
 * **CRLF 夹具**（core.autocrlf=false 直写 CRLF 文件：CRLF patch 成功 + 行尾漂移
 * 失败形态如实断言）与**中文路径夹具**必测（方案 §5.10）。
 *
 * 断言纪律：验证世界而非自述——每个写断言后用独立 execFileSync git 重读 index。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeService(workspaceOverride: string): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  return new GitService(ctx, {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000,
    workspaceOverride, autoFetchIntervalMs: 0,
  })
}

async function makeWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-sp-${name}-`, cleanups)
  // 本机全局 autocrlf=true 会把检出文件 smudge 成 CRLF——fixture 钉死 false 让
  // patch 文本与 index 的行尾字节确定（§5.10 CRLF 夹具的前提）。
  git(repo, 'config', 'core.autocrlf', 'false')
  return { repo, service: makeService(repo) }
}

async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', '--', rel)
  git(repo, 'commit', '-qm', message)
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// ---------- world 重读（独立 git 进程，验证世界而非自述） ----------

function worldStagedDiff(repo: string, rel: string): string {
  return execFileSync('git', ['diff', '--cached', '--', rel], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function worldWorktreeDiff(repo: string, rel: string): string {
  return execFileSync('git', ['diff', '--', rel], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** index 内 blob 的字节内容（`git cat-file -p :<path>`——CRLF 断言按字节）。 */
function worldIndexBlob(repo: string, rel: string): string {
  return execFileSync('git', ['cat-file', '-p', `:${rel}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function worldStagedPaths(repo: string): string[] {
  // `-z`（中文路径 v1 纪律——CLAUDE.md:65）：porcelain 的 NUL 分隔不做 quotePath 转义。
  return execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\0').map((line) => line.trim()).filter((line) => line !== '')
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, message: remote!.message, details: remote!.details as Record<string, unknown> }
}

describe('stagePatch — hunk 级两态（[清单 10]，D7=B）', () => {
  /** 两 hunk 夹具：17 行文件、改 l2 与 l17（上下文 3 下间隔 9 行 → 两个独立 hunk）。 */
  async function makeTwoHunkWorld(name: string) {
    const { repo, service } = await makeWorld(name)
    const lines = Array.from({ length: 17 }, (_, i) => `l${String(i + 1)}`)
    await commitFile(repo, 'big.txt', lines.join('\n') + '\n', 'seed big')
    const mutated = [...lines]
    mutated[1] = 'HUNK1'
    mutated[16] = 'HUNK2'
    await writeFile(join(repo, 'big.txt'), mutated.join('\n') + '\n', 'utf8')
    const hunk1 = [
      'diff --git a/big.txt b/big.txt',
      '--- a/big.txt',
      '+++ b/big.txt',
      '@@ -1,5 +1,5 @@',
      ' l1',
      '-l2',
      '+HUNK1',
      ' l3',
      ' l4',
      ' l5',
      '',
    ].join('\n')
    return { repo, service, hunk1 }
  }

  it('两 hunk patch 只 stage 第一个 → world 重读：index 只含选中 hunk，worktree 保留另一个', async () => {
    const { repo, service, hunk1 } = await makeTwoHunkWorld('two-hunk')
    const result = await service.stagePatch({ path: 'big.txt', patch: hunk1 })
    expect(result.staged).toBe(1) // 单 hunk patch ⇒ staged = 1（hunk 计数语义）
    // world 重读 index：staged 侧只有 HUNK1，绝无 HUNK2。
    const staged = worldStagedDiff(repo, 'big.txt')
    expect(staged).toContain('+HUNK1')
    expect(staged).not.toContain('HUNK2')
    // world 重读 worktree：未选中的 HUNK2 仍在工作区（未被 --cached 触碰）。
    const worktree = worldWorktreeDiff(repo, 'big.txt')
    expect(worktree).toContain('+HUNK2')
  })

  it('direction:unstage 反向应用 → world 重读 index 恢复为 HEAD（D7=B）', async () => {
    const { repo, service } = await makeWorld('unstage')
    const base = await commitFile(repo, 'u.txt', 'u1\nu2\nu3\nu4\n', 'seed u')
    // worktree 改动 → 文件级 stage（v1 面）→ staged diff 即 u2→V2。
    await writeFile(join(repo, 'u.txt'), 'u1\nV2\nu3\nu4\n', 'utf8')
    await service.stage(['u.txt'])
    expect(worldStagedPaths(repo)).toEqual(['u.txt'])
    // staged 侧同构勾选：对 staged diff 的选中片做反向应用。
    const stagedPatch = [
      'diff --git a/u.txt b/u.txt',
      '--- a/u.txt',
      '+++ b/u.txt',
      '@@ -1,4 +1,4 @@',
      ' u1',
      '-u2',
      '+V2',
      ' u3',
      ' u4',
      '',
    ].join('\n')
    const result = await service.stagePatch({ path: 'u.txt', patch: stagedPatch, direction: 'unstage' })
    expect(result.staged).toBe(1)
    // world 重读：index 恢复 HEAD（该文件不再在 staged 视图）；worktree 改动仍在。
    expect(worldStagedPaths(repo)).toEqual([])
    expect(worldWorktreeDiff(repo, 'u.txt')).toContain('+V2')
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()).toBe(base)
  })

  it('行级 patch `--recount`：hunk 头计数漂移被容忍，index 落正确内容（world 重读）', async () => {
    const { repo, service } = await makeWorld('recount')
    await commitFile(repo, 'recount.txt', 'r1\nr2\nr3\nr4\nr5\n', 'seed recount')
    await writeFile(join(repo, 'recount.txt'), 'r1\nR2\nr3\nr4\nr5\n', 'utf8')
    // client 行级选择重组的计数漂移形态：头声称 2 行，body 实为 5 行。
    const drifting = [
      'diff --git a/recount.txt b/recount.txt',
      '--- a/recount.txt',
      '+++ b/recount.txt',
      '@@ -1,2 +1,2 @@',
      ' r1',
      '-r2',
      '+R2',
      ' r3',
      ' r4',
      ' r5',
      '',
    ].join('\n')
    const result = await service.stagePatch({ path: 'recount.txt', patch: drifting })
    expect(result.staged).toBe(1)
    // world 重读 index blob：R2 已进 index、r2 消失。
    expect(worldIndexBlob(repo, 'recount.txt')).toBe('r1\nR2\nr3\nr4\nr5\n')
  })

  it('patch 与 index 不符 ⇒ stage-patch-failed（details.stderr 脱敏；index 未动）', async () => {
    const { repo, service } = await makeWorld('mismatch')
    await commitFile(repo, 'm.txt', 'alpha\nbeta\ngamma\n', 'seed m')
    // patch 的上下文（l1-l5 形态）与 index 的三行文件完全对不上。
    const bogus = [
      'diff --git a/m.txt b/m.txt',
      '--- a/m.txt',
      '+++ b/m.txt',
      '@@ -1,5 +1,5 @@',
      ' nope1',
      '-nope2',
      '+nope2b',
      ' nope3',
      '',
    ].join('\n')
    const rejection = await rejectionOf(() => service.stagePatch({ path: 'm.txt', patch: bogus }))
    expect(rejection.code).toBe('git/stage-patch-failed')
    expect(rejection.details.path).toBe('m.txt')
    expect(typeof rejection.details.stderr).toBe('string')
    // world 重读：index 未被部分应用（零脏写）。
    expect(worldStagedPaths(repo)).toEqual([])
    expect(worldIndexBlob(repo, 'm.txt')).toBe('alpha\nbeta\ngamma\n')
  })

  it('空 path / 空 patch ⇒ bad-request invalid-options（零命令）', async () => {
    const { repo, service } = await makeWorld('empty')
    await commitFile(repo, 'e.txt', 'e\n', 'seed e')
    const noPath = await rejectionOf(() => service.stagePatch({ path: '', patch: 'diff --git a/e.txt b/e.txt\n' }))
    expect(noPath.code).toBe('git/bad-request')
    expect(noPath.details.reason).toBe('invalid-options')
    const noPatch = await rejectionOf(() => service.stagePatch({ path: 'e.txt', patch: '  ' }))
    expect(noPatch.code).toBe('git/bad-request')
    const badDirection = await rejectionOf(() => service.stagePatch({ path: 'e.txt', patch: 'x\n', direction: 'sideways' as never }))
    expect(badDirection.code).toBe('git/bad-request')
    expect(worldStagedPaths(repo)).toEqual([])
  })
})

describe('stagePatch — 二进制与模式变更 hunk 拒绝（零命令）', () => {
  it('GIT binary patch ⇒ stage-patch-failed，index 不动', async () => {
    const { repo, service } = await makeWorld('binary')
    await commitFile(repo, 'b.txt', 'text before\n', 'seed b')
    const binaryPatch = [
      'diff --git a/b.bin b/b.bin',
      'index 000000..111111 100644',
      'GIT binary patch',
      'literal 10',
      'Ycm`^F%D^M#ovS?0DDq7',
      '',
    ].join('\n')
    const rejection = await rejectionOf(() => service.stagePatch({ path: 'b.bin', patch: binaryPatch }))
    expect(rejection.code).toBe('git/stage-patch-failed')
    expect(String(rejection.details.stderr)).toContain('binary')
    expect(worldStagedPaths(repo)).toEqual([])
  })

  it('模式变更 hunk（old mode/new mode）⇒ stage-patch-failed，index 不动', async () => {
    const { repo, service } = await makeWorld('mode')
    await commitFile(repo, 's.sh', 'echo hi\n', 'seed s')
    const modePatch = [
      'diff --git a/s.sh b/s.sh',
      'old mode 100644',
      'new mode 100755',
      '--- a/s.sh',
      '+++ b/s.sh',
      '@@ -1 +1 @@',
      '-echo hi',
      '+echo changed',
      '',
    ].join('\n')
    const rejection = await rejectionOf(() => service.stagePatch({ path: 's.sh', patch: modePatch }))
    expect(rejection.code).toBe('git/stage-patch-failed')
    expect(String(rejection.details.stderr)).toContain('mode')
    expect(worldStagedPaths(repo)).toEqual([])
    // 新增/删除文件的 `new file mode` / `deleted file mode` 是正常 diff 头——**不拒**。
    const addPatch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+fresh content',
      '',
    ].join('\n')
    const added = await service.stagePatch({ path: 'new.txt', patch: addPatch })
    expect(added.staged).toBe(1)
    expect(worldStagedPaths(repo)).toEqual(['new.txt'])
  })
})

describe('stagePatch — CRLF 与中文路径夹具（方案 §5.10 必测）', () => {
  it('CRLF 夹具（autocrlf=false）：CRLF patch 应用成功，index 字节保 CRLF（world 重读）', async () => {
    const { repo, service } = await makeWorld('crlf-ok')
    await commitFile(repo, 'crlf.txt', 'c1\r\nc2\r\nc3\r\n', 'seed crlf')
    await writeFile(join(repo, 'crlf.txt'), 'c1\r\nC2\r\nc3\r\n', 'utf8')
    const crlfPatch = [
      'diff --git a/crlf.txt b/crlf.txt',
      '--- a/crlf.txt',
      '+++ b/crlf.txt',
      '@@ -1,3 +1,3 @@',
      ' c1',
      '-c2',
      '+C2',
      ' c3',
      '',
    ].join('\r\n')
    const result = await service.stagePatch({ path: 'crlf.txt', patch: crlfPatch })
    expect(result.staged).toBe(1)
    // world 重读 index blob：字节级 CRLF 保留（autocrlf=false 不归一）。
    expect(worldIndexBlob(repo, 'crlf.txt')).toBe('c1\r\nC2\r\nc3\r\n')
  })

  it('CRLF 行尾漂移（LF patch 对 CRLF index）的真实形态如实断言', async () => {
    const { repo, service } = await makeWorld('crlf-drift')
    await commitFile(repo, 'drift.txt', 'd1\r\nd2\r\nd3\r\n', 'seed drift')
    await writeFile(join(repo, 'drift.txt'), 'd1\r\nD2\r\nd3\r\n', 'utf8')
    // patch 文本为 LF-only（client 手拼/外部产物的漂移形态）——git apply 的真实
    // 行为如实断言（本机 git 2.55.0.windows.2：上下文行尾不匹配 ⇒ 不应用）。
    const lfPatch = [
      'diff --git a/drift.txt b/drift.txt',
      '--- a/drift.txt',
      '+++ b/drift.txt',
      '@@ -1,3 +1,3 @@',
      ' d1',
      '-d2',
      '+D2',
      ' d3',
      '',
    ].join('\n')
    const outcome = await service.stagePatch({ path: 'drift.txt', patch: lfPatch }).then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    )
    if (outcome.ok) {
      // git 若容忍漂移（--whitespace=nowarn 口径），index 必须真实落 D2 且不含 d2。
      expect(worldIndexBlob(repo, 'drift.txt')).toContain('D2')
      expect(worldIndexBlob(repo, 'drift.txt')).not.toContain('d2')
    } else {
      const remote = remoteErrorOf(outcome.cause)
      expect(remote?.code).toBe('git/stage-patch-failed')
      expect(worldStagedPaths(repo)).toEqual([])
    }
  })

  it('中文路径夹具：含空格的中文文件名 patch 正常 stage（world 重读 --name-only）', async () => {
    const { repo, service } = await makeWorld('zh-path')
    await mkdir(join(repo, 'docs'), { recursive: true })
    await commitFile(repo, 'docs/中文 说明.md', '第一行\n第二行\n', 'seed zh')
    await writeFile(join(repo, 'docs', '中文 说明.md'), '第一行\n改过的第二行\n', 'utf8')
    const zhPatch = [
      'diff --git a/docs/中文 说明.md b/docs/中文 说明.md',
      '--- a/docs/中文 说明.md',
      '+++ b/docs/中文 说明.md',
      '@@ -1,2 +1,2 @@',
      ' 第一行',
      '-第二行',
      '+改过的第二行',
      '',
    ].join('\n')
    const result = await service.stagePatch({ path: 'docs/中文 说明.md', patch: zhPatch })
    expect(result.staged).toBe(1)
    expect(worldStagedPaths(repo)).toEqual(['docs/中文 说明.md'])
    expect(worldIndexBlob(repo, 'docs/中文 说明.md')).toBe('第一行\n改过的第二行\n')
  })
})
