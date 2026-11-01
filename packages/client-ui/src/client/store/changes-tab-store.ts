/**
 * @dsh-plugin/client-ui-git — C2 变更审查 tab 的槽位 UI 状态 store（本模块 ask §②/⑥；
 * spec §3.2 C2 的 ChangesTabState/ChangesTabActions 原样落地）。
 *
 * **范式 B**：`defineStore` draft mutator（map §3.4 槽位 UI 状态；ui-deliverables
 * review-store.ts 同构）。经 tab body 注册的 `store: createChangesTabStore()` 声明为
 * 排他 store——框架按「注册项 × 会话」铸实例（registry.ts factoryStoreOf 实读），
 * 随槽位生命周期，不进 root 缓存。
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** 一个变更审查 tab 的 UI 选择态。 */
export interface ChangesTabState {
  /** 目录折叠展开态；键 = `${groupId}:${dir}`，缺省 = 展开。 */
  expandedDirs: Record<string, boolean>
  /** 当前展开 diff 的文件路径（单展开；null = 全收起）。 */
  selectedPath: string | null
  /** 待确认的 discard（C5 GitConfirmDialog 的载荷；确认路径全量在此）。 */
  pendingConfirm: { kind: 'discard'; paths: string[] } | null
}

/** tab UI 状态的完整写集（draft mutator——组件只经这些动作写；type 别名带隐式索引签名以满足 ActionsDecl，照 review-store ReviewActions）。 */
export type ChangesTabActions = {
  /** 折叠/展开一个目录。 */
  toggleDir: (draft: ChangesTabState, path: string) => void
  /** 选中/收起一个文件的 diff 展开位。 */
  select: (draft: ChangesTabState, path: string | null) => void
  /** 请求丢弃一批路径（打开确认对话框）。 */
  requestDiscard: (draft: ChangesTabState, paths: string[]) => void
  /** 结束确认（ok 由组件消费以决定是否真正 discard；状态侧只负责关闭）。 */
  resolveConfirm: (draft: ChangesTabState, ok: boolean) => void
}

/**
 * 声明变更审查 tab 的 UI store。
 * @returns 注册用 store 句柄（框架按 scope 铸实例）。
 */
export function createChangesTabStore(): EngineStoreHandle<ChangesTabState, ChangesTabActions> {
  return defineStore({
    init: (): ChangesTabState => ({ expandedDirs: {}, selectedPath: null, pendingConfirm: null }),
    actions: {
      toggleDir(d, path: string) {
        d.expandedDirs[path] = !(d.expandedDirs[path] ?? true)
      },
      select(d, path: string | null) {
        d.selectedPath = path
      },
      requestDiscard(d, paths: string[]) {
        d.pendingConfirm = { kind: 'discard', paths }
      },
      resolveConfirm(d, _ok: boolean) {
        d.pendingConfirm = null
      },
    },
  })
}

/** 注册组件侧的 handle 类型（PropsStore 的推导输入）。 */
export type ChangesTabStoreHandle = ReturnType<typeof createChangesTabStore>
