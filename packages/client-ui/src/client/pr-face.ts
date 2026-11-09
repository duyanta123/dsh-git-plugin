/**
 * dsh-gitkit-ui — PR 业务面（V2 批次四 [46][69]；plan §6.6 的 client 消费半）。
 *
 * 组件只吃这个面（范式：admin-face.ts/commit-dialog-face.ts 同构——组件不做 RPC，
 * map §3.4）。`createGitPrFace` 在 apply 顶层用 root rpc 铸一次，由 header 按钮
 * （创建 PR… 入口）与推送对话框（推送成功引导 + [69] 关联展示）共享（同一闭包，
 * 无第二份状态）。
 *
 * D1=A：创建的载体 = host 半 gh CLI（client 只消费确认闸与结果展示）。[69] 的
 * `prLink` 把「无关联（ok:true value:null）」与「查询失败（ok:false）」都折叠为
 * null——UI 静默降级不占位（plan §6.1 [69] 行），错误面零展示。
 */

import type { PrCreateOptions, PrDescription, PrLinkResult, PrResult, RefInfo } from 'dsh-gitkit/types'
import type { RemoteResult } from './remote/mount.js'
import type { GitRpcFace } from './remote/mount.js'

/** PR 对话框业务面（组件不做 RPC——注入面纪律）。 */
export interface GitPrFace {
  /** base 分支选择数据（refs 全量——base 清单装配在 pr-view-model.prBaseChoices）。 */
  listRefs(): Promise<RemoteResult<RefInfo[]>>
  /** AI 生成 PR 描述（[46]；[70] 合并策略约定段在 host prompt 组装）。 */
  generateDescription(signal?: AbortSignal): Promise<RemoteResult<PrDescription>>
  /** 创建 PR（danger 勾选闸在组件；acknowledged = UI 已过闸的调用契约）。 */
  createPr(options: PrCreateOptions): Promise<RemoteResult<PrResult>>
  /**
   * [69] 分支关联 PR 查询（静默降级：无关联/查询失败 ⇒ null——不占位不报错，
   * plan §6.1/§6.6；gh 缺失 ⇒ ok:false pr-tool-missing 也折叠 null）。
   */
  prLink(branch: string): Promise<PrLinkResult | null>
}

/** 铸 PR 业务面（工厂——模块级句柄禁止，map §3.4）。 */
export function createGitPrFace(rpc: GitRpcFace): GitPrFace {
  return {
    async listRefs() {
      const snapshot = await rpc.refs()
      if (!snapshot.ok) return snapshot
      return { ok: true, value: snapshot.value.refs }
    },
    generateDescription: (signal) => rpc.generatePrDescription(signal),
    createPr: (options) => rpc.createPr(options),
    async prLink(branch) {
      const result = await rpc.prForBranch(branch)
      if (!result.ok) return null
      return result.value
    },
  }
}
