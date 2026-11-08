/**
 * dsh-gitkit-ui — 图 tab 跨槽位意图 store（V2 批次二；plan §4.6 对比入口/单文件历史）。
 *
 * **范式 A**：裸 `createSnapshotStore` observable，工厂函数（模块级句柄禁止——map
 * §3.4）；root 作用域（apply 顶层创建 + ctx.effect 清理）。
 *
 * 动机：header 菜单（`conversation.session.header.utilities` 槽）与变更面板
 * （changes tab）要驱动**图 tab 内的模式切换**（分支对比 / path 模式），而图 tab 的
 * UI 态 store 是槽位作用域（范式 B，按「注册项 × 会话」铸实例）——两个拉起方够不到。
 * 跨槽位通道 = 本 root 作用域意图 store：拉起方 `request()`（同时 openResource 打开
 * 图 tab），图 tab 订阅并在消费后 `consume()` 清除。nonce 单调递增——同一意图重复
 * request（如再点一次同一分支对比）也能再次触发消费方。
 *
 * 请求只是**意图**：compare 的可用性闸（当前分支在场）与 path 的合法性由消费方
 * （GitGraphTab / git-compare-store / git-graph-store）各自承担。
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** 一条图 tab 模式意图。 */
export type GraphIntent =
  | { kind: 'compare'; base: string }
  | { kind: 'path'; path: string }

/** store 快照（request = 待消费意图；nonce 防同形意图不触发）。 */
export interface GraphIntentState {
  request: (GraphIntent & { nonce: number }) | null
}

/** 图 tab 意图通道（store + 命令面）。 */
export interface GraphIntentStore {
  readonly store: SnapshotStore<GraphIntentState>
  /** 投递一条意图（覆盖未消费的旧意图——最后点击胜出）。 */
  request(intent: GraphIntent): void
  /** 消费完成（图 tab 侧；清空 request，nonce 保留在调用方闭包内比较）。 */
  consume(): void
}

/** 创建意图通道（工厂——模块级句柄禁止，map §3.4）。 */
export function createGraphIntentStore(): GraphIntentStore {
  const store = createSnapshotStore<GraphIntentState>({ request: null })
  let nonce = 0
  return {
    store,
    request(intent) {
      nonce += 1
      store.update((draft) => {
        draft.request = { ...intent, nonce }
      })
    },
    consume() {
      store.update((draft) => {
        draft.request = null
      })
    },
  }
}
