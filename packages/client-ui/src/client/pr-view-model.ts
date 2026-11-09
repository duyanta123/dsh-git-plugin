/**
 * dsh-gitkit-ui — PR 对话框与 [69] 关联展示的纯视图模型（V2 批次四；plan §6.6）。
 *
 * 交付面：AI 生成描述按钮（[46]，生成结果填 title/body）、title/body 编辑、
 * base 分支选择（refs 数据——本地 + 远端分支）、draft 勾选、创建 danger 确认
 * （GitConfirmDialog severity='danger' 勾选闸——复用既有原语，plan §6.6）、
 * 成功展示 PR URL。[69]：分支选择器行与推送对话框显示 prForBranch 结果的 PR
 * 链接；无关联/查询失败 ⇒ 静默降级不占位（plan §6.1 [69] 行）。
 *
 * [70]（合并策略约定段）在 host generatePrDescription 的 prompt 组装——本文件无落点。
 * 断言面 = tests/pr-dialog.spec.ts（校验 / draft / danger 闸 / base 清单 / 链接解析）。
 */

import type { PrCreateOptions, PrLinkResult, RefInfo } from 'dsh-gitkit/types'

// ── base 分支选择（refs 数据的选项装配）──────────────────────────────────────

/** base 分支下拉的一行（展示短名 + 来源徽标）。 */
export interface PrBaseChoice {
  /** 分支短名（local-branch = 分支名；remote-branch = origin/name 形态）。 */
  name: string
  /** 数据来源（选项排序分组用：本地分支在前）。 */
  kind: 'local' | 'remote'
}

/**
 * refs 快照 → base 分支选项（纯函数；plan §6.6「base 分支选择（remoteList+refs 数据）」
 * 的 refs 半）。本地分支 + 远端分支都可作为 base（gh pr create --base 接受两种形态）；
 * 当前分支不进清单（PR 从当前分支发起，base = 其它分支）；序保持 host 返回序
 * （本地先于远端由 host for-each-ref 序保证，此处不再重排）。
 */
export function prBaseChoices(params: {
  refs: readonly RefInfo[]
  headName: string | null
}): PrBaseChoice[] {
  return params.refs
    .filter((ref) => ref.type === 'local-branch' || ref.type === 'remote-branch')
    .filter((ref) => ref.shortName !== params.headName)
    .map((ref) => ({ name: ref.shortName, kind: ref.type === 'local-branch' ? 'local' : 'remote' }))
}

// ── 创建入参组装（校验 + draft + danger 闸）──────────────────────────────────

/** PR 对话框输入（组件持有的全部决策相关状态）。 */
export interface PrDialogInput {
  /** 标题草稿（原样；校验半 trim）。 */
  title: string
  /** 描述草稿（可空）。 */
  body: string
  /** 选中 base（null = 未选——wire 可选，host 侧由 gh 以远端默认分支推断）。 */
  base: string | null
  /** head 分支（当前分支短名；null = 分支不可用——不可发起）。 */
  head: string | null
  /** draft 勾选。 */
  draft: boolean
  /** danger 勾选闸（GitConfirmDialog「不可逆」复选框——创建对外可见 PR 的确认）。 */
  acked: boolean
  /** 创建请求进行中。 */
  pending: boolean
}

/** PR 对话框渲染模型。 */
export interface PrDialogView {
  /** base 选项装配是否可用（refs 数据非空——head 恒排除）。 */
  baseChoices: readonly PrBaseChoice[]
  /** 标题必填校验（trim 后非空）。 */
  titleValid: boolean
  /** 确认按钮可用闸（标题合法 + head 可用 + 空闲）。 */
  canConfirm: boolean
  /** danger 闸状态（勾选「不可逆」后才可发起——confirmButtonEnabled 同语义）。 */
  dangerGate: { ask: boolean; confirmed: boolean }
  /** 组装 PrCreateOptions（null = 闸未过，调用方不得发起）。 */
  options: PrCreateOptions | null
}

/**
 * 组装 PR 对话框视图模型（纯函数）。acknowledged 恒 true = 调用契约「UI 已过
 * danger 勾选闸」（changes-ops-face stashDrop 同纪律）；base 未选 ⇒ null 透传
 * （wire `base?: string | null`——host 半 gh 缺省推断远端默认分支）。
 */
export function prDialogView(input: PrDialogInput, baseChoices: readonly PrBaseChoice[]): PrDialogView {
  const title = input.title.trim()
  const titleValid = title !== ''
  const headUsable = input.head !== null
  const canConfirm = titleValid && headUsable && !input.pending
  const options: PrCreateOptions | null = canConfirm && input.acked
    ? {
        title,
        body: input.body,
        base: input.base,
        head: input.head,
        draft: input.draft,
        acknowledged: true,
      }
    : null
  return {
    baseChoices,
    titleValid,
    canConfirm,
    dangerGate: { ask: canConfirm, confirmed: canConfirm && input.acked },
    options,
  }
}

// ── [69] prForBranch 关联展示（静默降级）─────────────────────────────────────

/** 一条分支的 PR 关联展示模型（null = 无关联/查询失败——不占位）。 */
export interface PrLinkView {
  url: string
  /** 从 URL 解析的 PR 号（/pull/<n>/ 或末段整数；解析不出 ⇒ null——徽标退化纯链接）。 */
  number: number | null
  state: string | null
}

/**
 * PR 号解析（纯函数）：GitHub 形态 `/pull/<n>` 优先；其余形态取末段整数；无整数
 * ⇒ null（徽标不显示号）。
 */
export function prUrlNumber(url: string): number | null {
  const pull = url.match(/\/pull\/(\d+)/u)
  if (pull !== null) return Number(pull[1])
  const tail = url.match(/(\d+)(?:\/?.*)?$/u)
  return tail === null ? null : Number(tail[1])
}

/**
 * prForBranch 结果 → 展示模型（纯函数）。ok:true 的 null 值与 ok:false（gh 缺失
 * ⇒ git/pr-tool-missing 等）都折为 null——[69]「无关联/查询失败 ⇒ UI 静默降级
 * （不占位不报错）」，消费方对 null 不渲染任何行。
 */
export function prLinkView(result: { ok: true; value: PrLinkResult | null } | { ok: false; error: unknown } | null): PrLinkView | null {
  if (result === null || !result.ok) return null
  if (result.value === null) return null
  return {
    url: result.value.url,
    number: prUrlNumber(result.value.url),
    state: result.value.state,
  }
}
