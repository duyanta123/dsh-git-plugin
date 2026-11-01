/**
 * @dsh-plugin/client-ui-git — 提交对话框的业务面（④-K 提交对话框模块 ask §①；
 * spec §3.1 GitCommitDialog 行 + §3.2 GitRpcClient 切片）。
 *
 * 组件只吃这个面（范式：槽组件读 props/inject，map §3.4；GitErrorNotice 同纪律——
 * 组件不做数据获取）。`createCommitDialogFace` 在 apply 顶层用 root rpc 铸一次，
 * 由 header 按钮与变更面板两个拉起方的 inject 工厂共享（同一闭包，无第二份状态）。
 *
 * `headCommit` 把 `git log` 的 LogPage 首条折算成 amend 预填所需的最小形状
 * （[清单 19] 修订入口的 `shortOid subject` 标签 + HEAD 消息）；unborn/空页 → null
 * （amend 勾选框随之禁用——没有上一笔提交可修订）。
 */

import type { CommitOptions, CommitResult, FetchOptions, FetchResult, GeneratedCommitMessage, GitIdentityResult, PullResult, PushOptions, PushResult } from '@dsh-plugin/git/types'
import type { RemoteResult } from './remote/mount.js'
import type { GitRpcFace } from './remote/mount.js'

/** HEAD 首条提交的折算形状（amend 预填与勾选框标签）。 */
export interface HeadCommitInfo {
  /** 短 oid（oid 前 7 位——BranchState.abbrevOid 同启发式）。 */
  shortOid: string
  /** 单行 subject（%s 语义 = CommitInfo.subject）。 */
  subject: string
  /** 完整消息（subject + 空行 + body；amend 预填文本）。 */
  message: string
}

/** 提交对话框业务面（组件不做 RPC——注入面纪律）。 */
export interface GitCommitDialogFace {
  /** 提交/修订（host 守卫链：身份 → 空提交保护 → 消息校验 → hook 分类 → 回读）。 */
  commit(options: CommitOptions): Promise<RemoteResult<CommitResult>>
  /** 链式推送（Commit & Push 的后半；无 upstream 时调用方给 setUpstream:true）。 */
  push(options: PushOptions): Promise<RemoteResult<PushResult>>
  /** 拉取（git/diverged 错误动作 [清单 67] 的消费方半；remote null = host 侧 upstream 解析）。 */
  fetch(options: FetchOptions): Promise<RemoteResult<FetchResult>>
  /** 拉取合并（非 ff → git/pull-diverged 说明文案，v1 无 merge UI）。 */
  pull(): Promise<RemoteResult<PullResult>>
  /** AI 生成提交信息（生成中可取消——signal 由组件持有）。 */
  generateCommitMessage(signal?: AbortSignal): Promise<RemoteResult<GeneratedCommitMessage>>
  /** 身份预检（身份告警条 [清单 55]；不抛 identity-missing 的查询面）。 */
  checkIdentity(): Promise<RemoteResult<GitIdentityResult>>
  /** HEAD 首条提交（amend 预填）；unborn/空页 → ok:null。 */
  headCommit(): Promise<RemoteResult<HeadCommitInfo | null>>
}

/** LogPage 首条 → HeadCommitInfo 的纯折算（tests/commit-view-model.spec 断言）。 */
export function headCommitOf(page: { commits: ReadonlyArray<{ oid: string; subject: string; body: string }> }): HeadCommitInfo | null {
  const head = page.commits[0]
  if (head === undefined) return null
  return {
    shortOid: head.oid.slice(0, 7),
    subject: head.subject,
    message: head.body === '' ? head.subject : `${head.subject}\n\n${head.body}`,
  }
}

/** 铸提交对话框业务面（工厂——模块级句柄禁止，map §3.4）。 */
export function createCommitDialogFace(rpc: GitRpcFace): GitCommitDialogFace {
  return {
    commit: (options) => rpc.commit(options),
    push: (options) => rpc.push(options),
    fetch: (options) => rpc.fetch(options),
    pull: () => rpc.pull(),
    generateCommitMessage: (signal) => rpc.generateCommitMessage(signal),
    checkIdentity: () => rpc.identity(),
    async headCommit() {
      const page = await rpc.log({ limit: 1, skip: 0 })
      if (!page.ok) return page
      return { ok: true, value: headCommitOf(page.value) }
    },
  }
}
