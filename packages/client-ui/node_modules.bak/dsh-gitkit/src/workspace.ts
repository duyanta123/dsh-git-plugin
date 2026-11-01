/*!
 * Ported from deepseek-ai/deepseek-harness@ce7073d512 (dsh 树 HEAD，0.2.2-alpha.2)
 *   path: packages/deliverables/workspace-changes/src/index.ts（session→cwd 解析服务面：
 *         :60-62 eligible(session)——`session.header.cwd` + origin/delegationDepth 资格；
 *         :84-87 ctx.on('session/event', turn/start) 时机）
 *         packages/deliverables/workspace-changes/src/recorder.ts（:136 realpath 规范化）
 * License: MIT — Copyright (c) DeepSeek (dsh 源码树许可；NOTICE.md「来源许可与版本细节」行)
 * Modifications: 2026-10-31 —— 事件监听改本插件 GitService 构造期注册；解析优先级改为
 *   Config.workspaceOverride（任务口径键名）→ 最近顶层会话 cwd → git/session-workspace-unresolved；
 *   Session 类型面用最小结构接口（本包不依赖 @deepseek-ai/dsh-session 类型包）。
 * SPDX-License-Identifier: MIT
 */

/**
 * dsh-gitkit — 工作区解析（session → cwd）。
 *
 * 解析服务面（§⑧-1 核实结论，dsh 树 workspace-changes 实读）：宿主把"当前目录"
 * 挂在会话头上——`session.header.cwd`（可 undefined），且子代理会话与被委托回合
 * 不参与（`origin === 'subagent' || (delegationDepth ?? 0) > 0` ⇒ 跳过）；
 * 事件时机为 `ctx.on('session/event', (session, event) => …)` 的 `turn/start`。
 * RemoteInvocation 本身不携带会话身份（protocol/src/types.ts:498-524 实读：
 * request/service/peer/signal/uplink），故 host 服务只能从事件流记忆 cwd。
 *
 * 解析优先级（本模块任务口径）：
 *   1. `Config.workspaceOverride`（非空 ⇒ 显式钉死；路径不存在 = 解析失败，不回落）；
 *   2. 最近一个顶层会话回合的 `session.header.cwd`（realpath 规范化）；
 *   3. 都没有 ⇒ 抛 `git/session-workspace-unresolved`（域码注册在 error-codes.ts）。
 *
 * v1 口径（spec §0.2-3）：单 session 单仓库——记忆"最近一个"顶层会话即可。
 */

import { realpath } from 'node:fs/promises'
import { gitError } from './error-codes.ts'
import type { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** 工作区解析来源。 */
export type GitWorkspaceSource =
  | 'workspace-override'   // Config.workspaceOverride 显式指定
  | 'session'              // 最近顶层会话的 session.header.cwd

/** 一次解析结果：跑 git 的目录（绝对、realpath 规范化）与来源。 */
export interface GitWorkspaceResolution {
  root: string
  source: GitWorkspaceSource
}

/** 本插件感知的最小会话头（dsh `Session['header']` 的 cwd/origin/delegationDepth 投影）。 */
export interface GitSessionHeaderFace {
  cwd?: string
  origin?: string
  delegationDepth?: number
}

/** 本插件感知的最小会话对象（只读头 + 身份形状）。 */
export interface GitSessionFace {
  readonly header: GitSessionHeaderFace
}

/** 本插件感知的最小会话事件（`session/event` 回调第二参）。 */
export interface GitSessionEventFace {
  readonly type: string
}

/**
 * 宿主事件面切片：`ctx.on('session/event', listener)`。
 * cordis Context 的结构子集——本包不声明 `@deepseek-ai/dsh-session` 依赖，
 * 运行时对象由宿主提供（同 git-runner.ts 的 SubprocessFace 先例）。
 */
export interface GitSessionEventHost {
  on(event: 'session/event', listener: (session: GitSessionFace, event: GitSessionEventFace) => void): unknown
}

/**
 * workspace-changes/index.ts:59-62 的资格判定（照抄语义）：子代理来源或
 * 被委托回合（delegationDepth > 0）不产生工作区；无 cwd 同样跳过。
 */
export function eligibleSessionCwd(header: GitSessionHeaderFace): string | undefined {
  const { cwd, origin, delegationDepth } = header
  if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * 工作区解析器：记忆最近顶层会话 cwd（构造时若给了宿主面则自挂 session/event），
 * 按优先级给出跑 git 的目录；解析不出即抛 git/session-workspace-unresolved。
 */
export class WorkspaceResolver {
  /** 最近一个顶层会话回合的工作目录（undefined = 尚未观察到）。 */
  private sessionCwd: string | undefined

  constructor(
    /** Config.workspaceOverride；空串 = 自动（session → 未解析）。 */
    private readonly override: string,
    /** 宿主上下文面；提供时注册 session/event 记忆（监听随宿主 fiber 清理）。 */
    host?: GitSessionEventHost,
  ) {
    host?.on('session/event', (session, event) => { this.observe(session, event) })
  }

  /** session/event 处理：只在 turn/start 记忆顶层会话 cwd（workspace-changes :84-87 时机）。 */
  observe(session: GitSessionFace, event: GitSessionEventFace): void {
    if (event.type !== 'turn/start') return
    const cwd = eligibleSessionCwd(session.header)
    if (cwd !== undefined) this.sessionCwd = cwd
  }

  /** 测试/调试视图：当前记忆的会话 cwd。 */
  get observedSessionCwd(): string | undefined {
    return this.sessionCwd
  }

  /** 解析跑 git 的目录；失败抛 git/session-workspace-unresolved（消息区分来源）。 */
  async resolve(): Promise<GitWorkspaceResolution> {
    if (this.override !== '') {
      try {
        return { root: await realpath(this.override), source: 'workspace-override' }
      } catch (cause) {
        throw workspaceUnresolved(
          `workspaceOverride does not resolve to a directory: ${this.override}`
          + ` (${cause instanceof Error ? cause.message : String(cause)})`,
        )
      }
    }
    if (this.sessionCwd !== undefined) {
      try {
        return { root: await realpath(this.sessionCwd), source: 'session' }
      } catch {
        // 会话目录已消失：按未解析处理（回落路径是重新观察下一个回合）。
        throw workspaceUnresolved(`session workspace no longer exists: ${this.sessionCwd}`)
      }
    }
    throw workspaceUnresolved(
      'no session workspace observed (no top-level session turn/start yet) and no workspaceOverride configured',
    )
  }
}

function workspaceUnresolved(message: string): RemoteError {
  return gitError('git/session-workspace-unresolved', message, {})
}
