/**
 * dsh-gitkit-ui — C1 GitHeaderButton（spec §3.1 [清单 47/48/54/65]；V2 批次一扩行）。
 *
 * 注册于 `conversation.session.header.utilities`（list/session——ui-open-in-app 范本）；
 * **不碰 `conversation.session.header.corner`**（AppFrame header 自留席位，map §3.2）。
 *
 * 展示：分支名（[清单 47]）+ 变更角标（badgeCount 去重路径）+ detached（短 oid
 * [清单 65]）/ unborn（[清单 64]）/ 无仓库（[清单 54]）/ 检查中态；点击开菜单
 * （原语 Menu：摘要/冲突 label 行 + 数据行，portal 浮层防 header 溢出裁切）。
 *
 * 菜单动作（V2 批次一，plan §3.6）：
 *   1. 打开变更面板 / 2. 打开提交图（openResource 幂等）；
 *   3. 提交… / 4. 提交并推送… —— GitCommitDialog（④-K）；
 *   5. 推送 —— remoteList 路由（pushRoute）：单远端一步直推（v1 行为不回归），
 *      多远端开 GitPushDialog（remote picker + force danger 双闸）；
 *   6. 拉取 / 7. 获取 —— 直跑（fetch 成功后 refresh() = R5 manual 刷 ahead/behind）；
 *   8. 分支（子菜单）—— 本地分支清单（admin.refs()），当前分支 '✓ ' 前缀（原语
 *      子菜单行无 selected 面），detached 前置短 oid 信息行，点击 branchSwitch
 *      （成功后 refresh()——HEAD 变更驱动 status/graph 重载链路，plan §3.10）；
 *   9. 新建分支… / 10. 打标签… / 11. Worktree… —— 各自对话框；
 *   12. 删除分支…（子菜单）—— 非当前分支逐行（当前分支除外——git 拒删当前分支，
 *       UI 前置排除），点击后 GitConfirmDialog 确认 → branchDelete。
 *
 * 菜单直跑动作的错误面：admin 面板（按钮下方浮动卡，GitErrorNotice + 关闭）——
 * 菜单已收起，错误不能丢。对话框动作的错误面在各对话框内。
 *
 * **V2 批次四（plan §6.6）扩面**：
 *   - 无仓库态整菜单收敛为单行「初始化 Git 仓库…」（[8] 空态引导的 header 半；
 *     成功 → refresh()——workspace unresolved → resolved 的 R5 manual 首帧）；
 *   - 「创建 PR…」行（[46]）→ GitPrDialog（head = 当前分支；分支不可用行禁用）；
 *   - [69] 分支选择子菜单行尾 PR 关联徽标（prForBranch 逐分支并行查询——无关联/
 *     失败静默不占位；菜单行是 button 不可嵌 anchor，链接打开面在推送对话框与
 *     PR 对话框的成功 URL）；
 *   - GitPushDialog 增 prFace（[69] 关联 anchor）与推送成功态「创建 PR…」引导。
 *
 * **V3 批次二（v3-implementation-plan §4.6）扩面**：
 *   - 「合并到当前分支…」行（[28]）→ GitMergeDialog（branch picker + ff 三态单选 +
 *     no-ff 时 message 编辑 + danger 恒档确认——合并提交是对外可见动作）；
 *   - 「变基到…」行（[29]）→ GitRebaseDialog（upstream picker + onto 可选 + danger
 *     恒档确认——重写历史语义文案明示）；冲突路径零新 UI（git/merge-conflict 错误
 *     面板既有 abort/resolve 动作 + 变更 tab 冲突面板——op 徽标显示 merge/rebase）。
 *
 * **V3 批次三（v3-implementation-plan §5.7）扩面**：header 菜单「Agent 工具」状态行
 * （[45]）——菜单开着即拉 admin.agentToolsStatus()（每次开菜单重取防陈旧），只读
 * 展示无操作面（工具启停在 profile 配置层）；off（含 face 缺失降级档）显示关闭、
 * on 显示 'readonly (N tools)' 形态。拉取失败/未拉取整行缺席（观测行不进错误卡
 * 语义）；a11y 沿 P3-9 锚标准——原语 Menu label 行 role=presentation（非交互行不入
 * menuitem 键盘走查），稳定行 id 'dsh-git-menu-agent-tools' 供组合断言。
 *
 * **V3 批次五（v3-implementation-plan §7.5）扩面**：header 菜单「自动化」状态行
 * （[42][43]）——菜单开着即拉 admin.automationStatus()（Agent 工具观测态同款重取
 * 防陈旧），只读观测无操作面（启停在 profile 配置层）。两行：开关态行（两模式档位
 * 字面量——全 off 收敛单行「关闭」）+ 最近动作摘要行（lastActions 首条——host
 * newest-first 环；空环整行缺席）。**tooltip 注记**：原语 MenuEntry 无 tooltip 通道
 * （Menu.d.ts MenuLabel 只有 {type,id,text}；编译面 label 行 role=presentation 直出
 * text，无 title 透传）——「最近动作摘要」以相邻 label 行落地（同 a11y 类：非交互
 * 不入键盘走查），不引原语 children 自绘行（原语 children 契约 = role=menuitem
 * 按钮行）。拉取失败整组缺席（观测行不进错误卡语义）；a11y 同 P3-9 锚标准——
 * 稳定行 id 'dsh-git-menu-automation' / 'dsh-git-menu-automation-latest' 供组合断言。
 */

import { useEffect, useRef, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentToolsStatusResult, AutomationStatusResult, RefInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import { pushRoute } from '../admin-face.js'
import { agentToolsStatusLine, automationStatusLines } from '../admin-view-model.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import type { GitPrFace } from '../pr-face.js'
import { prLinkView } from '../pr-view-model.js'
import type { HeaderMenuId, HeaderSubmenuEntry } from '../ui-model.js'
import {
  branchCompareEntries, branchDeleteEntries, branchPickerEntries, branchResetEntries,
  branchSubmenuEntries, headerMenuItems, headerViewModel,
} from '../ui-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { GitStatusSourceState } from '../store/git-status-source.js'
import { useAsyncAction } from '../hooks/useAsyncAction.js'
import { useMenuFetch } from '../hooks/useMenuFetch.js'
import { GitBranchCreateDialog } from './GitBranchCreateDialog.js'
import { GitCommitDialog } from './GitCommitDialog.js'
import type { GitCommitDialogFace } from '../commit-dialog-face.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'
import { GitMergeDialog } from './GitMergeDialog.js'
import { GitPrDialog } from './GitPrDialog.js'
import { GitPushDialog } from './GitPushDialog.js'
import { GitRebaseDialog } from './GitRebaseDialog.js'
import { GitResetDialog } from './GitResetDialog.js'
import { GitTagCreateDialog } from './GitTagCreateDialog.js'
import { GitWorktreeDialog } from './GitWorktreeDialog.js'

/** inject 面投给组件的 props（inject: () => ({...}) 的形状；spec §3.1 注册范本）。 */
export interface GitHeaderButtonProps {
  /** 词典翻译（注册 locale: NS 后由框架注入）。 */
  t: TranslateNS<'git'>
  /** 状态源订阅 hook（渲染器由 inject 面的 hooks.gitStatus 合成）。 */
  useGitStatus: SnapshotSelectorHook<GitStatusSourceState>
  /**
   * 打开变更面板（openResource 幂等；spec §3.1）。**会话域地址**：inject 工厂以
   * 框架解析的 sessionId 闭包铸造 `dsh-resource://git-changes/session/{id}`。
   */
  openChangesPanel(): void
  /** 打开提交图 tab（openResource 幂等；静态地址 GIT_GRAPH_ADDRESS——F7 提交图模块）。 */
  openGraphPanel(): void
  /**
   * 打开图 tab 的分支对比面板（V2 批次二 [36]；plan §4.6「分支选择器内『与当前分支
   * 比较』→ 图 tab 内对比面板」）。跨槽位通道：意图投 graph-intent-store + 静态地址
   * 打开图 tab（apply 半装配）。
   */
  openComparePanel(base: string): void
  /** 提交对话框业务面（④-K：commit/push/AI/身份/HEAD 预取——apply 顶层单例闭包）。 */
  commitDialog: GitCommitDialogFace
  /** 管理面业务面（V2 批次一：refs/分支/标签/worktree/推送路由——apply 顶层单例闭包）。 */
  admin: GitAdminFace
  /** 变更动作面（V2 批次四 [8]：initRepository 消费半——apply 顶层单例闭包）。 */
  ops: GitChangesOpsFace
  /** PR 业务面（V2 批次四 [46][69]：listRefs/generateDescription/createPr/prLink）。 */
  pr: GitPrFace
  /** R5 manual 状态刷新（fetch / branchSwitch 成功后的 ahead/behind 与图链路刷新）。 */
  refresh(): void
}

/** HeaderSubmenuEntry → 原语 MenuItem（'✓ ' 前缀 = 当前分支行——子菜单无 selected 面；
 *  [69] prNumber 在场时行尾追加 PR 关联徽标词条——无关联分支不带后缀，不占位）。 */
function toSubmenuItem(entry: HeaderSubmenuEntry, t: GitHeaderButtonProps['t']): MenuItem {
  const base = entry.labelKey !== undefined
    ? t(entry.labelKey, entry.params)
    : entry.current ? `✓ ${entry.label}` : entry.label
  return {
    id: entry.id,
    label: entry.prNumber !== undefined && entry.prNumber !== null
      ? `${base} ${t('pr.link.badge', { number: entry.prNumber })}`
      : base,
    disabled: entry.disabled,
  }
}

/** 菜单直跑动作的任务形态（runAdmin 的入参；拆别名避免泛型签名触发 check-locale
 * 的 JSX 文本启发式——单行内 `>…<` 相邻会被当裸文案，见 check-locale.mjs §3）。 */
type AdminTaskResult = Promise<GitErrorLike | null>
type AdminTask = () => AdminTaskResult

export function GitHeaderButton(props: GitHeaderButtonProps) {
  const { t, useGitStatus, openChangesPanel, openGraphPanel, openComparePanel, commitDialog, admin, ops, pr, refresh } = props
  const state = useGitStatus((s) => s)
  const view = headerViewModel(state)
  const menu = headerMenuItems(view)
  const [open, setOpen] = useState(false)
  /** 提交对话框的打开意图（null = 关；值 = defaultAction）。 */
  const [commitIntent, setCommitIntent] = useState<'commit' | 'commit-push' | null>(null)
  // ── V2 批次一管理面：对话框意图 + 分支清单 + admin 错误面 ──
  const [pushIntent, setPushIntent] = useState(false)
  const [branchCreateIntent, setBranchCreateIntent] = useState(false)
  const [tagCreateIntent, setTagCreateIntent] = useState(false)
  const [worktreeIntent, setWorktreeIntent] = useState(false)
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null)
  // ── V2 批次二：reset 目标意图（[37]——soft/mixed/hard 与 hard danger 闸在对话框内）──
  const [resetAsk, setResetAsk] = useState<string | null>(null)
  // ── V3 批次二：merge / rebase 对话框意图（[28]/[29]——picker/三态/danger 闸在对话框内）──
  const [mergeIntent, setMergeIntent] = useState(false)
  const [rebaseIntent, setRebaseIntent] = useState(false)
  // ── V2 批次四：创建 PR 对话框意图（[46]）+ [69] 分支关联 PR 徽标数据 ──
  const [prIntent, setPrIntent] = useState(false)
  const [prNumbers, setPrNumbers] = useState<Readonly<Record<string, number | null>>>({})
  const [branchList, setBranchList] = useState<readonly RefInfo[]>([])
  // ── V3 批次三：Agent 工具观测态（[45]）与 V3 批次五：自动化观测态（[42][43]）──
  // 「菜单开着即拉数据」同形 effect 收敛到 useMenuFetch（成功 ⇒ value；失败静默降
  // 级 ⇒ null，行缺席；重取防陈旧）。[69] 的并行 PR 查询（错误卡 + 多路 Promise.all
  // + 徽标折叠）形状不同，保留独立 effect。
  const agentTools = useMenuFetch<AgentToolsStatusResult>({ enabled: open, fetch: admin.agentToolsStatus })
  const automation = useMenuFetch<AutomationStatusResult>({ enabled: open, fetch: admin.automationStatus })
  const [adminError, setAdminError] = useState<GitErrorLike | null>(null)
  // runAdmin 点击时的任务闭包（useAsyncAction 的 run 经 ref 读取——任务因动作而异）。
  const taskRef = useRef<AdminTask | null>(null)

  // V3 批次三/五观测态 effect 已收敛（见上）；分支清单 + [69] PR 徽标的拉取形状
  // 不同（错误卡 + 并行查询），保留独立。

  const branch = state.status?.branch ?? null
  const headName = branch !== null && !branch.detached && !branch.unborn ? branch.name : null

  // 菜单开着即取本地分支清单（子菜单数据源；每次开菜单重取防陈旧）。
  // V2 批次四（[69]）：逐分支并行查 prForBranch（静默降级——失败/无关联分支
  // 不进 prNumbers，行尾无徽标；pr 面缺席同样不查——旧装配兼容）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void admin.listLocalBranches().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setAdminError(result.error)
        return
      }
      setBranchList(result.value)
      const branches = result.value.map((ref) => ref.shortName)
      Promise.all(branches.map(async (name) => ({ name, link: await pr.prLink(name) })))
        .then((rows) => {
          if (cancelled) return
          const numbers: Record<string, number | null> = {}
          for (const row of rows) {
            const link = prLinkView({ ok: true, value: row.link })
            if (link !== null && link.number !== null) numbers[row.name] = link.number
          }
          setPrNumbers(numbers)
        })
        .catch(() => { /* 静默降级——[69] 查询失败不占位不报错 */ })
    })
    return () => { cancelled = true }
  }, [open, admin, pr])

  // V3 批次三（[45]）/ V3 批次五（[42][43]）的观测态拉取已收敛到 useMenuFetch
  // （见 hooks/useMenuFetch.ts——语义逐字节保真：开着重取防陈旧、失败静默降级）。

  // ── 菜单直跑动作闸（Phase 2·client 薄壳化）：busy 闸收敛到 useAsyncAction 的
  // createBusyGate（同步翻转先于任何 await——闭包 busy 竞态根治）；任务经 ref 传递。
  // 错误折叠保留原语义：任务失败 ⇒ setAdminError（错误卡不因后续成功动作清除——
  // 关闭按钮是唯一清除通道，hooks 的 error 态在此不消费）。 ──
  const adminAction = useAsyncAction<null>({
    run: async () => {
      const task = taskRef.current as AdminTask
      const error = await task()
      if (error !== null) setAdminError(error)
      return { ok: true, value: null }
    },
  })
  const runAdmin = (task: AdminTask): Promise<void> => {
    taskRef.current = task
    return adminAction.trigger()
  }

  const switchBranch = (name: string): void => {
    setOpen(false)
    void runAdmin(async () => {
      const result = await admin.branchSwitch(name)
      if (!result.ok) return result.error
      refresh() // HEAD 变更 → R5 manual 帧 → graph reload 链路（plan §3.10）
      return null
    })
  }

  const deleteBranch = (name: string): void => {
    setDeleteAsk(null)
    void runAdmin(async () => {
      const result = await admin.branchDelete({ name })
      if (!result.ok) return result.error
      refresh()
      return null
    })
  }

  const runPush = (): void => {
    setOpen(false)
    void runAdmin(async () => {
      const remotes = await admin.listRemotes()
      if (!remotes.ok) return remotes.error
      // 多远端 → 对话框（remote picker）；单/零远端 → 一步直推（v1 行为不回归）。
      if (pushRoute(remotes.value.remotes.length) === 'dialog') {
        setPushIntent(true)
        return null
      }
      const result = await admin.push({
        setUpstream: branch?.upstream === null,
        remote: remotes.value.remotes[0]?.name ?? null,
      })
      return result.ok ? null : result.error
    })
  }

  const runMenuId = (id: HeaderMenuId): void => {
    setOpen(false)
    if (id === 'open-changes') openChangesPanel()
    else if (id === 'open-graph') openGraphPanel()
    else if (id === 'commit') setCommitIntent('commit')
    else if (id === 'commit-push') setCommitIntent('commit-push')
    else if (id === 'push') runPush()
    else if (id === 'pr-create') setPrIntent(true)
    else if (id === 'init-repo') {
      // [8] 无仓库空态的初始化行（plan §6.6）：成功 → refresh()（workspace
      // unresolved → resolved，R5 manual 取 init 后首帧）；失败进 admin 错误卡。
      void runAdmin(async () => {
        const result = await ops.initRepository()
        if (!result.ok) return result.error
        refresh()
        return null
      })
    } else if (id === 'pull') {
      void runAdmin(async () => {
        const result = await admin.pull()
        return result.ok ? null : result.error
      })
    } else if (id === 'fetch') {
      void runAdmin(async () => {
        const result = await admin.fetch({ remote: null })
        if (!result.ok) return result.error
        refresh() // fetch 成功 → R5 manual 刷 ahead/behind（plan §3.6）
        return null
      })
    } else if (id === 'branch-create') setBranchCreateIntent(true)
    else if (id === 'tag-create') setTagCreateIntent(true)
    else if (id === 'worktree') setWorktreeIntent(true)
    // V3 批次二（[28]/[29]）：merge / rebase 对话框拉起（branch/upstream picker 在
    // 对话框内——直拉形，branch-create/tag-create/worktree 同款）。
    else if (id === 'branch-merge') setMergeIntent(true)
    else if (id === 'branch-rebase') setRebaseIntent(true)
    // branches / branch-delete：子菜单行本身不触发动作（原语只展开子菜单）。
  }

  const onSelect = (id: string): void => {
    if (id.startsWith('branch-switch:')) {
      switchBranch(id.slice('branch-switch:'.length))
      return
    }
    if (id.startsWith('branch-delete:')) {
      setOpen(false)
      setDeleteAsk(id.slice('branch-delete:'.length))
      return
    }
    // V2 批次二（[36]/[37]）：对比目标 / reset 目标两个子菜单行。
    if (id.startsWith('branch-compare:')) {
      setOpen(false)
      openComparePanel(id.slice('branch-compare:'.length))
      return
    }
    if (id.startsWith('branch-reset:')) {
      setOpen(false)
      setResetAsk(id.slice('branch-reset:'.length))
      return
    }
    runMenuId(id as HeaderMenuId)
  }

  const label = t(view.labelKey, view.params)
  // V3 批次三（[45]；plan §5.7）：状态行渲染模型（off/降级档 ⇒ 关闭行；on ⇒
  // 'readonly (N tools)' 形态；null ⇒ 整行缺席）。
  const agentToolsLine = agentToolsStatusLine(agentTools)
  // V3 批次五（[42][43]；plan §7.5）：自动化状态行渲染模型（null ⇒ 开关态行与摘要
  // 行整组缺席；latest = lastActions 首条——空环摘要行缺席）。
  const automationLines = automationStatusLines(automation)
  // ── 菜单面（原语 Menu）：摘要/冲突 label 行 + 数据行（子菜单挂 branches /
  // branch-compare / branch-reset / branch-delete 四行；无可选分支时整行禁用）+
  // 页脚 label 行。
  const switchEntries = branchSubmenuEntries({
    branches: branchList,
    headName,
    detached: branch?.detached ?? false,
    abbrevOid: branch?.abbrevOid ?? null,
    prNumbers,
  })
  const deleteEntries = branchDeleteEntries({ branches: branchList, headName })
  const compareEntries = branchCompareEntries({ branches: branchList, headName })
  const resetEntries = branchResetEntries({ branches: branchList, headName })
  // V3 批次二：merge/rebase 两行的候选清单（对话框内 picker 的同源数据；无候选整行禁用）。
  const pickerEntries = branchPickerEntries({ branches: branchList, headName })
  const menuEntries: MenuEntry[] = [
    {
      type: 'label' as const,
      id: 'dsh-git-menu-summary',
      text: view.badge === 0 && view.clean
        ? t('problems.clean')
        : t('header.badge', { count: view.badge }),
    },
    ...(view.conflicted > 0
      ? [{
          type: 'label' as const,
          id: 'dsh-git-menu-conflicts',
          text: t('problems.conflicted', { count: view.conflicted }),
        }]
      : []),
    // V3 批次三（[45]；plan §5.7）：「Agent 工具」状态行——只读展示，无操作面
    // （工具启停在 profile 配置层）。原语 Menu label 行 = role=presentation 非交互
    // 行（P3-9 锚标准：不入 menuitem 键盘走查；稳定 id 供组合断言）。
    ...(agentToolsLine !== null
      ? [{
          type: 'label' as const,
          id: 'dsh-git-menu-agent-tools',
          text: t(agentToolsLine.labelKey, agentToolsLine.params),
        }]
      : []),
    // V3 批次五（[42][43]；plan §7.5）：「自动化」状态行组——开关态行 + 最近动作
    // 摘要行（lastActions 首条）。只读观测无操作面（启停在 profile 配置层）；原语
    // MenuEntry 无 tooltip 通道，摘要以相邻 label 行落地（同 P3-9 非交互行，不入
    // 键盘走查；稳定 id 供组合断言）。
    ...(automationLines !== null
      ? [{
          type: 'label' as const,
          id: 'dsh-git-menu-automation',
          text: t(automationLines.status.labelKey, automationLines.status.params),
        }]
      : []),
    ...(automationLines !== null && automationLines.latest !== null
      ? [{
          type: 'label' as const,
          id: 'dsh-git-menu-automation-latest',
          text: t('automation.status.latest', {
            kind: t(automationLines.latest.kindKey),
            outcome: t(automationLines.latest.ok ? 'automation.action.ok' : 'automation.action.fail'),
            detail: automationLines.latest.detail,
          }),
        }]
      : []),
    ...menu.map((item) => {
      const base = {
        id: item.id,
        label: t(item.labelKey),
        disabled: !item.enabled,
      }
      if (item.id === 'branches' && switchEntries.length > 0) {
        return { ...base, submenu: switchEntries.map((entry) => toSubmenuItem(entry, t)) }
      }
      // V2 批次四（[46]）：创建 PR 行——分支不可用（detached/unborn/快照未就绪）禁用。
      if (item.id === 'pr-create') {
        return { ...base, disabled: !item.enabled || headName === null }
      }
      if (item.id === 'branch-compare') {
        return { ...base, disabled: !item.enabled || compareEntries.length === 0, ...(compareEntries.length > 0 ? { submenu: compareEntries.map((entry) => toSubmenuItem(entry, t)) } : {}) }
      }
      if (item.id === 'branch-reset') {
        return { ...base, disabled: !item.enabled || resetEntries.length === 0, ...(resetEntries.length > 0 ? { submenu: resetEntries.map((entry) => toSubmenuItem(entry, t)) } : {}) }
      }
      // V3 批次二（[28]/[29]）：merge/rebase 直拉行——无可选分支（无当前分支或只有
      // 当前分支）整行禁用（branch-compare/reset 的「空清单禁用」同口径）。
      if (item.id === 'branch-merge') {
        return { ...base, disabled: !item.enabled || pickerEntries.length === 0 }
      }
      if (item.id === 'branch-rebase') {
        return { ...base, disabled: !item.enabled || pickerEntries.length === 0 }
      }
      if (item.id === 'branch-delete') {
        return { ...base, disabled: !item.enabled || deleteEntries.length === 0, ...(deleteEntries.length > 0 ? { submenu: deleteEntries.map((entry) => toSubmenuItem(entry, t)) } : {}) }
      }
      return base
    }),
  ]
  const menuFooter = [
    { type: 'label' as const, id: 'dsh-git-menu-shortcut', text: t('shortcut.hint') },
  ]
  return (
    <div className='dsh-git-header-button' data-git-header-button=''>
      <Menu
        open={open}
        anchor={
          <button
            type='button'
            className='dsh-git-header-button__toggle'
            aria-haspopup='menu'
            aria-expanded={open}
            aria-label={t('header.title')}
            title={t('header.title')}
            data-git-header-state={view.kind}
            onClick={() => { setOpen((value) => !value) }}
          >
            <span className='dsh-git-header-button__label'>{label}</span>
            {view.badge > 0 && (
              <span className='dsh-git-header-button__badge' data-git-badge=''>{view.badge}</span>
            )}
          </button>
        }
        items={menuEntries}
        footer={menuFooter}
        onSelect={onSelect}
        onClose={() => { setOpen(false) }}
        portal
        listClassName='dsh-git-header-button__menu'
      />
      {/* admin 错误面：菜单直跑动作失败后的浮动卡（菜单已收起——错误不能丢）。 */}
      {adminError !== null && (
        <div className='dsh-git-header-button__notice' data-git-admin-notice=''>
          <GitErrorNotice error={adminError} t={t} />
          <button
            type='button'
            className='dsh-git-header-button__notice-close'
            data-git-admin-notice-close=''
            onClick={() => { setAdminError(null) }}
          >
            {t('common.close')}
          </button>
        </div>
      )}
      <GitCommitDialog
        open={commitIntent !== null}
        defaultAction={commitIntent ?? 'commit'}
        snapshot={state.status}
        t={t}
        face={commitDialog}
        onDone={() => { setCommitIntent(null) }}
        onClose={() => { setCommitIntent(null) }}
      />
      <GitPushDialog
        open={pushIntent}
        t={t}
        face={admin}
        branch={branch === null ? null : {
          name: branch.name,
          upstream: branch.upstream,
          detached: branch.detached,
          unborn: branch.unborn,
        }}
        // V2 批次四：[69] 关联 PR anchor + 推送成功态「创建 PR…」引导（关推送框
        // 后开 PR 对话框——head = 当前分支）。
        prFace={pr}
        onCreatePr={() => { setPrIntent(true) }}
        onDone={() => { setPushIntent(false) }}
        onClose={() => { setPushIntent(false) }}
      />
      {/* V2 批次四（[46]）：创建 PR 对话框（AI 描述 + base picker + draft + danger 闸 +
          成功 URL）；head = 当前分支短名（分支不可用时入口行已禁用）。 */}
      <GitPrDialog
        open={prIntent}
        t={t}
        face={pr}
        head={headName}
        onDone={() => { setPrIntent(false) }}
        onClose={() => { setPrIntent(false) }}
      />
      <GitBranchCreateDialog
        open={branchCreateIntent}
        t={t}
        face={admin}
        onDone={() => {
          setBranchCreateIntent(false)
          refresh()
        }}
        onClose={() => { setBranchCreateIntent(false) }}
      />
      <GitTagCreateDialog
        open={tagCreateIntent}
        t={t}
        face={admin}
        oid={null}
        targetLabel={null}
        onDone={() => {
          setTagCreateIntent(false)
          refresh()
        }}
        onClose={() => { setTagCreateIntent(false) }}
      />
      <GitWorktreeDialog
        open={worktreeIntent}
        t={t}
        face={admin}
        onClose={() => { setWorktreeIntent(false) }}
      />
      <GitConfirmDialog
        open={deleteAsk !== null}
        title={t('branch.delete.title')}
        message={t('branch.delete.message', { name: deleteAsk ?? '' })}
        severity='normal'
        confirmLabel={t('branch.delete.title')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => { if (deleteAsk !== null) deleteBranch(deleteAsk) }}
        onCancel={() => { setDeleteAsk(null) }}
      />
      {/* V2 批次二 [37]：重置当前分支（reset 子菜单选中目标后拉起；soft/mixed/hard
          三档 + hard 的 danger 勾选闸在对话框内；baseRevision = 当前 HEAD oid，
          hard 将丢弃的文件计数 = 去重路径角标）。 */}
      <GitResetDialog
        open={resetAsk !== null}
        target={resetAsk}
        headOid={branch?.oid ?? null}
        discardCount={view.badge}
        t={t}
        face={admin}
        onDone={() => { refresh() }}
        onClose={() => { setResetAsk(null) }}
      />
      {/* V3 批次二 [28]/[29]：merge / rebase 对话框（branch/upstream picker + ff 三态
          / onto + danger 恒档闸在对话框内；成功 → refresh()——HEAD 变更 → R5 manual
          帧 → status/graph 重载链路，plan §4.6 keepMounted 回归）。冲突路径零新 UI：
          git/merge-conflict 错误面板既有 abort/resolve 动作路由。 */}
      <GitMergeDialog
        open={mergeIntent}
        t={t}
        face={admin}
        headName={headName}
        headOid={branch?.oid ?? null}
        branches={branchList}
        onDone={() => {
          setMergeIntent(false)
          refresh()
        }}
        onClose={() => { setMergeIntent(false) }}
      />
      <GitRebaseDialog
        open={rebaseIntent}
        t={t}
        face={admin}
        headName={headName}
        headOid={branch?.oid ?? null}
        branches={branchList}
        onDone={() => {
          setRebaseIntent(false)
          refresh()
        }}
        onClose={() => { setRebaseIntent(false) }}
      />
    </div>
  )
}
