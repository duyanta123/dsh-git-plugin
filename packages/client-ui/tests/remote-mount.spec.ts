/**
 * remote/mount 适配层单测（spec §3.2 RPC 注入口的生产半）：
 * $mount 接线、ready 门（挂载完成前调用等待）、错误折叠（gateway/service-unavailable）。
 * 生成产物 `dsh-gitkit/remote` 的运行期面以最小假体注入（bundle 构建产物含真实
 * 生成物，verify:load 在真宿主断言）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { GitStatusFrame, GitStatusSnapshot } from 'dsh-gitkit/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { GATEWAY_UNAVAILABLE, createGitRpcClient, mountGitRemote } from '../src/client/remote/mount.ts'

interface MountRecorder {
  mounted: unknown[]
  calls: number
}

/** 假 remote：记录 $mount 贡献，`git` 命名空间挂最小方法桩。 */
function fakeRemote(recorder: MountRecorder, git: Record<string, unknown> | null): TypertClientRemote {
  return {
    $mount: async (contribution: unknown) => {
      recorder.calls += 1
      recorder.mounted.push(contribution)
      return async () => { /* unmount no-op */ }
    },
    ...(git === null ? {} : { git }),
  } as unknown as TypertClientRemote
}

describe('mountGitRemote — 挂 ④-A 生成产物', () => {
  it('$mount 收到生成贡献（package 字段 = dsh-gitkit）', async () => {
    const recorder: MountRecorder = { mounted: [], calls: 0 }
    const disposer = await mountGitRemote({ remote: fakeRemote(recorder, null) })
    expect(recorder.calls).toBe(1)
    const contribution = recorder.mounted[0] as { package?: string }
    expect(contribution?.package).toBe('dsh-gitkit')
    await disposer()
  })
})

describe('createGitRpcClient — ready 门与错误折叠', () => {
  it('ready resolve 前 status 挂起，resolve 后透传命名空间结果', async () => {
    const gate: { open?: () => void } = {}
    const ready = new Promise<void>((resolve) => { gate.open = resolve })
    const statusResult = { ok: true, value: { repoRoot: 'D:/repo' } } as const
    const recorder: MountRecorder = { mounted: [], calls: 0 }
    const git = {
      status: vi.fn(async () => statusResult),
    }
    const rpc = createGitRpcClient({ remote: fakeRemote(recorder, git) }, ready)
    let settled = false
    void rpc.status().then(() => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(settled).toBe(false) // ready 未开：调用挂起（mount 完成前无命名空间）
    expect(git.status).not.toHaveBeenCalled()
    gate.open?.()
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(git.status).toHaveBeenCalledTimes(1)
    const result = await rpc.status()
    expect(result.ok).toBe(true)
    expect((result as { value?: unknown }).value).toEqual({ repoRoot: 'D:/repo' })
  })

  it('载波异常折叠为 ok:false + gateway/service-unavailable（UI 重试口径）', async () => {
    const ready = Promise.resolve()
    const recorder: MountRecorder = { mounted: [], calls: 0 }
    const git = {
      status: vi.fn(async () => { throw new Error('socket gone') }),
    }
    const rpc = createGitRpcClient({ remote: fakeRemote(recorder, git) }, ready)
    const result = await rpc.status()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GATEWAY_UNAVAILABLE)
      expect(result.error.message).toContain('socket gone')
    }
  })

  it('命名空间缺失 ⇒ 折叠为 gateway/service-unavailable（不炸调用方）', async () => {
    const ready = Promise.resolve()
    const recorder: MountRecorder = { mounted: [], calls: 0 }
    const rpc = createGitRpcClient({ remote: fakeRemote(recorder, null) }, ready)
    const result = await rpc.status()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(GATEWAY_UNAVAILABLE)
  })

  it('followStatus：ready 后返回命名空间流句柄；载波异常以带码 Error 重组', async () => {
    const ready = Promise.resolve()
    const recorder: MountRecorder = { mounted: [], calls: 0 }
    const fakeHandle = {
      async *[Symbol.asyncIterator](): AsyncIterator<GitStatusFrame> { /* 空流 */ },
      send: () => {},
      end: () => {},
      dispose: () => {},
    }
    const git = {
      followStatus: vi.fn((): unknown => fakeHandle),
    }
    const rpc = createGitRpcClient({ remote: fakeRemote(recorder, git) }, ready)
    const handle = await rpc.followStatus()
    expect(handle).toBe(fakeHandle)
    const failing = createGitRpcClient({ remote: fakeRemote(recorder, {
      followStatus: () => { throw new Error('carrier down') },
    }) }, ready)
    await expect(failing.followStatus()).rejects.toMatchObject({ code: GATEWAY_UNAVAILABLE })
  })

  it('status 的 RemoteResult 不经折叠直接透传（错误分支按 code 判别）', async () => {
    const ready = Promise.resolve()
    const recorder: MountRecorder = { mounted: [], calls: 0 }
    const failure = { ok: false, error: { code: 'git/no-repository', message: 'not a repo', details: { probed: 'D:/x' } } }
    const git = { status: vi.fn(async () => failure) }
    const rpc = createGitRpcClient({ remote: fakeRemote(recorder, git) }, ready)
    const result = await rpc.status()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('git/no-repository')
  })
})

describe('GitStatusSnapshot 类型面（wire 契约抽样）', () => {
  it('快照形状与 host types 声明同构（编译面护栏的运行期抽样）', () => {
    const snapshot: GitStatusSnapshot = {
      repoRoot: 'D:/repo',
      generatedAt: '2026-10-31T00:00:00.000Z',
      branch: {
        name: 'main', oid: null, abbrevOid: null, upstream: null,
        ahead: null, behind: null, detached: false, unborn: true,
      },
      staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
    }
    expect(snapshot.branch.unborn).toBe(true)
    expect(snapshot.clean).toBe(true)
  })
})
