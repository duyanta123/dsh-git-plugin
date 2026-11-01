/**
 * @dsh-plugin/client-ui-git — 提交图 tab 的槽位 UI 状态 store（本模块 ask §④；spec
 * §3.2 C3 的 GraphTabState/GraphTabActions 原样落地）。
 *
 * **范式 B**：`defineStore` draft mutator（map §3.4 槽位 UI 状态；changes-tab-store
 * 同构）。经 tab body 注册的 `store: createGraphTabStore()` 声明为排他 store——
 * 框架按「注册项 × 会话」铸实例，随槽位生命周期；图数据缓存在 root 作用域
 * （git-graph-store 范式 A），本 store 只持选择态。
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** 一个提交图 tab 的 UI 选择态。 */
export interface GraphTabState {
  /** 当前选中详情的提交 oid（null = 详情面板收起）。 */
  selectedOid: string | null
  /** 详情面板里展开 patch 的文件路径（null = 全收起）。 */
  detailPath: string | null
}

/** tab UI 状态的完整写集（draft mutator；type 别名带隐式索引签名以满足 ActionsDecl）。 */
export type GraphTabActions = {
  /** 选中/收起一个提交的详情面板。 */
  select: (draft: GraphTabState, oid: string | null) => void
  /** 展开/收起详情面板里一个文件的 patch 位。 */
  openDetailPath: (draft: GraphTabState, path: string | null) => void
}

/**
 * 声明提交图 tab 的 UI store。
 * @returns 注册用 store 句柄（框架按 scope 铸实例）。
 */
export function createGraphTabStore(): EngineStoreHandle<GraphTabState, GraphTabActions> {
  return defineStore({
    init: (): GraphTabState => ({ selectedOid: null, detailPath: null }),
    actions: {
      select(d, oid: string | null) {
        d.selectedOid = oid
        d.detailPath = null
      },
      openDetailPath(d, path: string | null) {
        d.detailPath = path
      },
    },
  })
}

/** 注册组件侧的 handle 类型（PropsStore 的推导输入）。 */
export type GraphTabStoreHandle = ReturnType<typeof createGraphTabStore>
