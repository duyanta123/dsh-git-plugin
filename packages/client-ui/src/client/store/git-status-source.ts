/**
 * dsh-gitkit-ui — 工作区状态源（spec §3.2 范式 A + 本模块 ask §②）。
 *
 * 数据缓存用裸 observable：`createSnapshotStore`（@deepseek-ai/dsh-client-store 引擎，
 * zustand vanilla + immer —— map §3.4 范式 A，ui-deliverables HostReadStore 同构），
 * **root 作用域**（apply 顶层创建 + ctx.effect 清理——session 域切 Session 会重挂载，
 * map §3.4 句柄-作用域规则）。模块级 store 句柄禁止——本工厂每次调用产独立实例。
 *
 * 数据面 = ④-D 的 `git followStatus` 流（typert stream；R1–R6 帧）。消费规则：
 *
 *  - **代际（generation）丢帧**：每代流持一个单调代际号；`reset()`（connection/reset）
 *    与 `dispose()` 递增代际并 dispose 旧句柄——旧流在清空竞态里迟到的帧一律丢弃
 *    （绝不覆盖新代际的状态）。
 *  - **revision 丢帧**：`state.revision` 只对**被接受**的帧递增；内容签名（剔除
 *    generatedAt 的廉价比对——spec §2.3「快照比对」行）与上一帧相同的帧被丢弃，
 *    不写 store、不 bump revision、不触发渲染（host R5 manual 的无条件帧与 R1 重放
 *    由此幂等）。
 *  - **错误以帧通告**：`GitStatusFrame` 的 error 分支落 `statusError` + `repo.available`
 *    投影（no-repository / session-workspace-unresolved ⇒ 不可用）；流不断开，仓库
 *    就绪后的下一帧 status 自然恢复（watcher R1' 语义）。
 *  - **connection/reset 重订**：`reset()` 清空全部状态（回到 checking）并立即重开流
 *    （spec §2.3 client 表「全缓存清空 + 立即重拉」；ui-deliverables HostReadStore.reset
 *    的 generation 语义同构）。
 *  - **R5 manual**：`refresh()` 在流开着时走上行 `{type:'refresh'}`；流未开（启动失败
 *    /载波断）时退化为重开流（重试路径）。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GitFollowCommand, GitStatusFrame, GitStatusSnapshot } from 'dsh-gitkit/types'
import type { GitErrorLike, GitRpcFace, GitStreamHandle } from '../remote/mount.js'
import { GATEWAY_UNAVAILABLE } from '../remote/mount.js'

/** 状态源快照（store 形状；范式 A 数据缓存）。 */
export interface GitStatusSourceState {
  /** 工作区可用性投影（[清单 54] header 空态的依据）。 */
  repo: { available: boolean; root: string | null; checking: boolean }
  /** 最近一帧工作区快照；尚未就绪/不可用时 null。 */
  status: GitStatusSnapshot | null
  /** 最近一帧的域错误投影（帧通告不断流）。 */
  statusError: GitErrorLike | null
  /** 被接受的帧计数（丢帧不计数；tests/git-status-source.spec 断言）。 */
  revision: number
  /** followStatus 流是否开着（含挂载等待中）。 */
  streaming: boolean
}

/** 状态源（store + 命令面）。 */
export interface GitStatusSource {
  readonly store: SnapshotStore<GitStatusSourceState>
  /** 打开首代流（幂等：已开着则 no-op；apply 内 mount 完成后调用）。 */
  start(): void
  /** R5 manual：上行刷新；流未开时退化为重开流。 */
  refresh(): void
  /** connection/reset：全缓存清空 + 立即重订（新代际；旧代际帧全部丢弃）。 */
  reset(): void
  /** 终结：递增代际 + dispose 句柄（ctx.effect 清理半）。 */
  dispose(): void
}

const INITIAL_STATE: GitStatusSourceState = {
  repo: { available: false, root: null, checking: true },
  status: null,
  statusError: null,
  revision: 0,
  streaming: false,
}

/**
 * 快照内容签名（spec §2.3「branch.oid + 分组计数 + generatedAt 廉价对比」——
 * generatedAt 每次重算必变，**剔除后**比对才可能判等；与 host watcher.frameSignature
 * 的剔除口径一致）。分组计数控本 + 分支锚点已覆盖渲染相关面。
 */
export function snapshotSignature(snapshot: GitStatusSnapshot): string {
  return JSON.stringify({
    oid: snapshot.branch.oid,
    counts: [
      snapshot.staged.length,
      snapshot.unstaged.length,
      snapshot.untracked.length,
      snapshot.conflicted.length,
    ],
    clean: snapshot.clean,
  })
}

/** 创建状态源（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitStatusSource(rpc: GitRpcFace): GitStatusSource {
  const store = createSnapshotStore<GitStatusSourceState>({ ...INITIAL_STATE, repo: { ...INITIAL_STATE.repo } })
  let generation = 0
  let handle: GitStreamHandle<GitStatusFrame, GitFollowCommand> | null = null

  function set(mutate: (draft: GitStatusSourceState) => void): void {
    store.update(mutate)
  }

  /** 代际内消费一帧；返回是否被接受（丢帧 = false）。 */
  function applyFrame(frame: GitStatusFrame): boolean {
    if (frame.kind === 'error') {
      const unavailable = frame.error.code === 'git/no-repository'
        || frame.error.code === 'git/session-workspace-unresolved'
      set((s) => {
        s.statusError = { code: frame.error.code, message: frame.error.message }
        if (unavailable) {
          s.repo = { available: false, root: null, checking: false }
          s.status = null
        }
        s.revision += 1
      })
      return true
    }
    const snapshot = frame.snapshot
    // revision 丢帧（内容重复）：与上一接受帧同签名 ⇒ 不写不计数。
    if (store.getSnapshot().status !== null && snapshotSignature(store.getSnapshot().status as GitStatusSnapshot) === snapshotSignature(snapshot)) {
      return false
    }
    set((s) => {
      s.status = snapshot
      s.statusError = null
      s.repo = { available: true, root: snapshot.repoRoot, checking: false }
      s.revision += 1
    })
    return true
  }

  function open(): void {
    const gen = ++generation
    set((s) => { s.streaming = true })
    void (async () => {
      let stream: GitStreamHandle<GitStatusFrame, GitFollowCommand>
      try {
        stream = await rpc.followStatus()
      } catch (cause) {
        if (gen !== generation) return
        set((s) => {
          s.streaming = false
          s.statusError = { code: causeCode(cause), message: causeMessage(cause) }
        })
        return
      }
      if (gen !== generation) {
        stream.dispose()
        return
      }
      handle = stream
      try {
        for await (const frame of stream) {
          if (gen !== generation) return
          applyFrame(frame)
        }
        // host/载波正常收尾：流结束（保持既有状态，等待 reset/refresh 重开）。
        if (gen === generation) set((s) => { s.streaming = false })
      } catch (cause) {
        if (gen === generation) {
          set((s) => {
            s.streaming = false
            s.statusError = { code: causeCode(cause), message: causeMessage(cause) }
          })
        }
      } finally {
        if (handle === stream) handle = null
      }
    })()
  }

  return {
    store,
    start() {
      if (handle !== null) return
      open()
    },
    refresh() {
      if (handle !== null) {
        handle.send({ type: 'refresh' })
        return
      }
      open()
    },
    reset() {
      // 旧代际退场：dispose 使旧迭代安静结束；代际已递增，旧帧全部丢弃。
      generation += 1
      const stale = handle
      handle = null
      stale?.dispose()
      set((s) => {
        s.repo = { available: false, root: null, checking: true }
        s.status = null
        s.statusError = null
        s.revision = 0
        s.streaming = false
      })
      open()
    },
    dispose() {
      generation += 1
      const stale = handle
      handle = null
      stale?.dispose()
      set((s) => { s.streaming = false })
    },
  }
}

function causeCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : GATEWAY_UNAVAILABLE
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
