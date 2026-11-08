/**
 * dsh-gitkit-ui — C4 GitCommitDialog：提交对话框（④-K 提交对话框模块
 * ask §①/②；spec §3.1 GitCommitDialog 行的字段全表 + [清单 11/15/16/17/19/48/55]）。
 *
 * 字段全表（ask §①）：
 *   - 消息编辑器：实时校验（空消息提示 + 非 amend 禁用提交）+ 字符计数；
 *   - AI 生成按钮：调 `generateCommitMessage`（生成中再点 = 取消，AbortController）；
 *     **覆盖前确认**——编辑器已有内容时结果先进二次确认（GitConfirmDialog）；
 *   - Conventional 非阻断提示（CONVENTIONAL_HINT_RE 不命中时行内警示，不拦截）；
 *   - staged 只读清单（计数 + 路径列表；[清单 11] 前端镜像：staged 为空禁用提交）；
 *   - amend 开关（[清单 19]）：勾选时取 HEAD 消息预填；有 upstream 且 ahead==0 时
 *     附「改写已推送历史」警示（v1 无 force push，只警示）；
 *   - 跳过 hook 勾选（[清单 20] → --no-verify）；
 *   - 身份告警条 / unborn 提示条 / diverged 告警条（开框时预检身份 RPC）；
 *   - 三动作 Commit / Commit & Push（链式：commit 成功后自动 push，push 失败在框内
 *     显错不断链）/ Cancel；
 *   - 错误动作（spec §3.4 动作清单的消费方，2026-11-01 接线）：错误条 GitErrorNotice
 *     接 onAction——retry 重放失败步（identity 预检 / commit / push）、set-upstream
 *     经 GitConfirmDialog 确认后 push({setUpstream:true})、fetch/pull 同步动作（host
 *     diverged 预检与 pull-diverged 说明文案兜底）。
 *
 * 浮层：**原语 Modal**（审查报告 §2.2 P2 / A3 修订——手写 portal/背板/焦点管理整段
 * 删除，壳/标题/遮罩/Escape 层栈/Tab 焦点圈/初始聚焦归 useModalLayer；不注册 root
 * 槽——root 被 AppFrame 占据（map §3.1）；由拉起方（GitHeaderButton 菜单 /
 * GitChangesTab 底部按钮）在自己的组件树内渲染本组件）。编辑器以 data-modal-autofocus
 * 标注初始聚焦（取代原 editorRef 手动聚焦）；data-git-commit-dialog 锚保留在 Modal
 * children 包裹层（verify-load 断言）。
 *
 * 快捷键（ask §②，aria-keyshortcuts 全组，经 footer Button 的 rest 透传落在按钮元素
 * 上）：Ctrl/Cmd+Enter = 默认动作（defaultAction）；Esc 归 Modal 层栈——嵌套覆盖确认
 * 打开时层栈顶持有 Escape，自动让位给确认框。
 *
 * **V2 批次三三块扩展（plan §5.6 ②）**：
 * ① trailer 编辑区（[18]）——预设 Co-authored-by / Generated-by 行可增删，非法行
 *    即时警示不阻断（镜像 Conventional 预检形态；入参折算 commitOptionsOf(+trailers)）；
 * ② 护栏结果面板（[21][22]）——开框与 staged 集变化时自动 scanStaged，点提交前再
 *    扫一次取最新裁决；blocked ⇒ 禁用提交按钮 + 违规列表 + 可豁免类 danger 勾选豁免
 *    入口（D5：secret 类硬阻断不可豁免）；
 * ③ hook 输出折叠区（[63]）——提交成功读 `CommitResult.process`（诚实命名：git
 *    commit 进程整体输出，含 hooks）、`git/hook-failed` 失败读 details.stderr；长输出
 *    尾保留 = redactTail（P3-3 复活点）。**评审修复**：成功路径不再立即 onDone()
 *    关框（那会使折叠区的成功半不可达、process 成 UI 死数据）——成功转「已提交」
 *    终态（succeeded）：对话框保持打开、折叠区默认展开，footer 换单关按钮由用户
 *    收尾；豁免勾选绑定产生它的违规集签名（violationsSignature），点提交前的 fresh
 *    扫描违规集已变 ⇒ 旧豁免失效（TOCTOU 闸）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitScanResult, GeneratedCommitMessage, GitIdentityResult, GitStatusSnapshot } from 'dsh-gitkit/types'
import type { GitCommitDialogFace, HeadCommitInfo } from '../commit-dialog-face.js'
import type { CommitPending, GuardScanPhase, ProcessOutputView } from '../commit-view-model.js'
import {
  commitAllowedByGuard, commitDialogView, commitOptionsOf, guardScanView, invalidTrailerLine,
  processFromHookError, processOutputView, pushOptionsOf, trailerLines, violationsSignature,
} from '../commit-view-model.js'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import type { ErrorAction } from '../error-map.js'
import type { NS } from '../locales.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** 提交对话框的拉起意图（默认动作 = Ctrl/Cmd+Enter 的目标）。 */
export type CommitDialogIntent = 'commit' | 'commit-push'

export interface GitCommitDialogProps {
  /** false = 不渲染（原语 Modal 亦不挂载）。 */
  open: boolean
  /** 默认动作（Ctrl/Cmd+Enter 触发；主按钮视觉序）。 */
  defaultAction: CommitDialogIntent
  /** 状态源快照（拉起方经 hooks.gitStatus 订阅后传入）。 */
  snapshot: GitStatusSnapshot | null
  /** 词典 t（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
  /** 提交对话框业务面（commit-dialog-face 工厂产物；两个拉起方共享同一闭包）。 */
  face: GitCommitDialogFace
  /** 全链成功（commit [+ push]）后的收尾（拉起方关框）。 */
  onDone(): void
  /** 关框（Cancel / Esc / 遮罩点击）。 */
  onClose(): void
}

type IdentityState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'ready'; identity: GitIdentityResult | null; error: GitErrorLike | null }

/**
 * 提交对话框（原语 Modal 浮层）。
 * @param props - 拉起方注入的快照/业务面/回调。
 */
export function GitCommitDialog(props: GitCommitDialogProps): ReactNode {
  const { open, defaultAction, snapshot, t, face, onDone, onClose } = props

  // ── 编辑器与开关 ──────────────────────────────────────────────
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [skipHooks, setSkipHooks] = useState(false)
  const [head, setHead] = useState<HeadCommitInfo | null>(null)
  /** amend 预填基准：仅当编辑器为空或仍是上次预填时才允许覆盖（不吞用户编辑）。 */
  const lastPrefillRef = useRef<string | null>(null)

  // ── V2 批次三 ①：trailer 编辑区（[18]；非法行警示不阻断）──
  const [trailers, setTrailers] = useState('')

  // ── V2 批次三 ②：护栏扫描（[21][22]；D5 豁免勾选态——勾选绑定产生它的违规集签名，
  //    点提交前 fresh 扫描违规集已变 ⇒ 旧豁免失效（评审修复的豁免 TOCTOU 闸））──
  const [scanPhase, setScanPhase] = useState<GuardScanPhase>('idle')
  const [scan, setScan] = useState<CommitScanResult | null>(null)
  const [scanError, setScanError] = useState<GitErrorLike | null>(null)
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false)
  const [overrideSignature, setOverrideSignature] = useState<string | null>(null)

  // ── V2 批次三 ③：hook 输出折叠区（[63]；redactTail 尾保留）──
  const [processView, setProcessView] = useState<ProcessOutputView | null>(null)

  // ── 「已提交」终态（评审修复：成功路径不再立即 onDone 关框——对话框保持打开展示
  //    [63] 的 process 折叠区，footer 换单关按钮由用户收尾）──
  const [succeeded, setSucceeded] = useState(false)

  // ── AI 生成（生成中可取消 + 覆盖前确认）──────────────────────
  const [generating, setGenerating] = useState(false)
  const generateAbortRef = useRef<AbortController | null>(null)
  const [pendingGenerate, setPendingGenerate] = useState<GeneratedCommitMessage | null>(null)

  // ── 身份预检 / 动作 pending / 错误条 ─────────────────────────
  const [identityState, setIdentityState] = useState<IdentityState>({ phase: 'idle' })
  const [pending, setPending] = useState<CommitPending>(false)
  const [error, setError] = useState<GitErrorLike | null>(null)
  /** set-upstream 错误动作的确认框（spec §3.4：确认后 push({setUpstream:true})）。 */
  const [setUpstreamAsk, setSetUpstreamAsk] = useState(false)
  /** 最后一次失败的动作步（retry 动作的重放目标；null = 无失败上下文）。 */
  const lastFailureRef = useRef<'identity' | { step: 'commit'; pushAfter: boolean } | { step: 'push' } | null>(null)

  const view = useMemo(() => commitDialogView({
    snapshot, identity: identityState.phase === 'ready' ? identityState.identity : null,
    message, amend, head, pending,
    guard: guardScanView(scanPhase, scan),
    overrideAcknowledged,
    succeeded,
  }), [snapshot, identityState, message, amend, head, pending, scanPhase, scan, overrideAcknowledged, succeeded])

  // ── 开框重置 + 预检（身份；HEAD 供 amend 标签）───────────────
  useEffect(() => {
    if (!open) return
    setMessage('')
    setAmend(false)
    setSkipHooks(false)
    setHead(null)
    lastPrefillRef.current = null
    setPendingGenerate(null)
    setPending(false)
    setError(null)
    setSetUpstreamAsk(false)
    lastFailureRef.current = null
    // V2 批次三三块的开框复位（trailer 清空 / 护栏与豁免复位 / 折叠区清空 / 终态复位）。
    setTrailers('')
    setScanPhase('idle')
    setScan(null)
    setScanError(null)
    setOverrideAcknowledged(false)
    setOverrideSignature(null)
    setProcessView(null)
    setSucceeded(false)
    setIdentityState({ phase: 'checking' })
    let cancelled = false
    const checkIdentity = (): void => {
      setIdentityState({ phase: 'checking' })
      void face.checkIdentity().then((result: RemoteResult<GitIdentityResult>) => {
        if (cancelled) return
        setIdentityState(result.ok
          ? { phase: 'ready', identity: result.value, error: null }
          : { phase: 'ready', identity: null, error: result.error })
        if (!result.ok) lastFailureRef.current = 'identity' // retry 动作的重放目标
      })
    }
    checkIdentity()
    // HEAD 首条：amend 勾选框标签与预填的先决数据；失败静默（勾选框禁用）。
    void face.headCommit().then((result) => {
      if (cancelled) return
      setHead(result.ok ? result.value : null)
    })
    return () => { cancelled = true }
  }, [open, face])

  // ── 护栏自动扫描（plan §5.6 ②「打开对话框 / 点提交前自动 scanStaged」）：
  // 开框首扫 + staged 集变化（staged 路径签名）重扫；新结果 ⇒ 豁免勾选复位。──
  const stagedSignature = useMemo(
    () => (snapshot?.staged ?? []).map((change) => change.path).join('\n'),
    [snapshot],
  )
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setScanPhase('scanning')
    void face.scanStaged().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setScan(result.value)
        setScanError(null)
        setScanPhase('ready')
      } else {
        // 扫描失败：面板显错误（retry 可重扫）——护栏是只读预检，不因扫描自身失败阻断。
        setScan(null)
        setScanError(result.error)
        setScanPhase('error')
      }
      setOverrideAcknowledged(false)
      setOverrideSignature(null)
    })
    return () => { cancelled = true }
  }, [open, face, stagedSignature])

  // （原 portal 自建承载节点与手写焦点管理已整段删除——壳/遮罩/Escape 层栈/Tab 焦点
  // 圈/初始聚焦/关闭还原全部归原语 Modal 的 useModalLayer；审查报告 §2.2 A3。）

  // ── amend 预填（[清单 19]）：勾选开 → 取 HEAD 消息 → 预填 ────
  const toggleAmend = (next: boolean): void => {
    setAmend(next)
    if (!next) return
    if (head === null) return // unborn/未取回：无预填来源（host 侧 amend 亦无意义）
    const current = message
    if (current.trim() === '' || current === lastPrefillRef.current) {
      setMessage(head.message)
      lastPrefillRef.current = head.message
    }
  }

  // ── AI 生成（生成中再点 = 取消；结果覆盖前确认）──────────────
  const runGenerate = (): void => {
    if (generating) {
      generateAbortRef.current?.abort()
      return
    }
    const controller = new AbortController()
    generateAbortRef.current = controller
    setGenerating(true)
    void face.generateCommitMessage(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        const generated = result.value.message
        if (message.trim() === '' || message === lastPrefillRef.current) {
          setMessage(generated)
          lastPrefillRef.current = generated
        } else {
          setPendingGenerate(result.value) // 覆盖前确认（ask §①）
        }
      } else {
        setError(result.error)
      }
    }).catch(() => { /* abort 竞态：生成中取消不显错 */ }).finally(() => {
      if (generateAbortRef.current === controller) generateAbortRef.current = null
      setGenerating(false)
    })
  }

  const applyGenerate = (): void => {
    if (pendingGenerate === null) return
    setMessage(pendingGenerate.message)
    lastPrefillRef.current = pendingGenerate.message
    setPendingGenerate(null)
  }

  // ── 三动作：Commit / Commit & Push（链式）/ Cancel ───────────
  // 评审修复：成功路径不再立即 onDone() 关框（原实现使 [63] 折叠区的成功半不可达，
  //  CommitResult.process 成 UI 死数据）——成功转「已提交」终态（setSucceeded），
  //  对话框保持打开、折叠区展开可见，footer 换单关按钮由用户收尾。
  const runPush = async (): Promise<void> => {
    setPending('push')
    const pushed = await face.push(pushOptionsOf(snapshot?.branch ?? null))
    if (!pushed.ok) {
      setPending(false)
      lastFailureRef.current = { step: 'push' }
      setError(pushed.error) // 链断在 push：框保持打开，commit 已落库（错误条可见）
      return
    }
    setPending(false)
    setSucceeded(true)
  }

  const runCommit = async (pushAfter: boolean): Promise<void> => {
    if (!view.commitEnabled) return
    setPending('commit')
    setError(null)
    // 点提交前自动 scanStaged（plan §5.6 ②）：以最新裁决放行——staged 集在开框后
    // 变化时面板可能滞后，落 RPC 前再扫一次。扫描失败 ⇒ 沿用面板当前裁决
    // （commitAllowedByGuard 对 null 放行——护栏是只读预检，不因扫描失败阻塞）。
    const fresh = await face.scanStaged()
    if (fresh.ok) {
      // 豁免 TOCTOU 闸（评审修复）：豁免勾选绑定「产生它的违规集签名」——fresh 违规集
      // 已变 ⇒ 上一个集勾选的豁免失效（新集需重新对清单勾选后提交），不再用陈旧闭包
      // 的 overrideAcknowledged 放行。
      const freshSignature = violationsSignature(fresh.value.violations)
      const exemptionValid = overrideAcknowledged && freshSignature === overrideSignature
      setScan(fresh.value)
      setScanError(null)
      setScanPhase('ready')
      setOverrideAcknowledged(exemptionValid)
      setOverrideSignature(exemptionValid ? freshSignature : null)
      if (!commitAllowedByGuard(fresh.value, exemptionValid)) {
        setPending(false)
        return
      }
    } else if (!commitAllowedByGuard(scan, overrideAcknowledged, overrideSignature)) {
      // fresh 扫描失败：沿用面板当前裁决放行（签名绑定校验豁免仍然成立）。
      setPending(false)
      return
    }
    // [18]：trailer 编辑区按行折算进 CommitOptions.trailers（空清单省略字段）。
    const options = commitOptionsOf(message, amend, skipHooks, trailerLines(trailers))
    const committed = await face.commit(options)
    if (!committed.ok) {
      setPending(false)
      lastFailureRef.current = { step: 'commit', pushAfter }
      setError(committed.error)
      // git/hook-failed：失败路径没有 CommitResult.process——details.stderr 进折叠区。
      setProcessView(processFromHookError(committed.error))
      return
    }
    // [63]：提交结果回读 process 字段（诚实命名：git commit 进程整体输出，含 hooks）。
    // 评审修复：转「已提交」终态并保持对话框打开（折叠区 open），不再走 onDone() 关框。
    setProcessView(processOutputView(committed.value.process))
    setSucceeded(true)
    setPending(false)
    if (!pushAfter) return
    await runPush()
  }

  // ── 错误动作（spec §3.4 动作清单的消费方；GitErrorNotice onAction）──
  /** 「设置 upstream 并推送」：确认框 → push({setUpstream:true})。 */
  const runSetUpstreamPush = (): void => {
    setSetUpstreamAsk(false)
    setPending('push')
    void face.push({ setUpstream: true }).then((pushed) => {
      if (!pushed.ok) {
        setPending(false)
        lastFailureRef.current = { step: 'push' }
        setError(pushed.error)
        return
      }
      setPending(false)
      onDone()
    })
  }

  /** retry 的身份预检重放（retry 只在框开着时可达；迟到解析被开框重置覆盖，无害）。 */
  const retryIdentity = (): void => {
    setIdentityState({ phase: 'checking' })
    void face.checkIdentity().then((result) => {
      setIdentityState(result.ok
        ? { phase: 'ready', identity: result.value, error: null }
        : { phase: 'ready', identity: null, error: result.error })
    })
  }

  const runErrorAction = (action: ErrorAction): void => {
    if (action === 'set-upstream') {
      setSetUpstreamAsk(true)
      return
    }
    if (action === 'fetch' || action === 'pull') {
      setPending(action)
      void (action === 'fetch' ? face.fetch({ remote: null }) : face.pull()).then((result) => {
        if (!result.ok) {
          setPending(false)
          setError(result.error)
          return
        }
        setPending(false)
        setError(null) // 同步动作成功 = 失败上下文消解（diverged 计数随快照刷新）
      })
      return
    }
    // retry：重放失败的那一步（identity 预检 / commit（保留原链意图）/ push 尾段）。
    const failed = lastFailureRef.current
    if (failed === 'identity') {
      retryIdentity()
      return
    }
    if (failed === null) return
    if (failed.step === 'push') void runPush()
    else void runCommit(failed.pushAfter)
  }

  // ── 快捷键（ask §②）：Ctrl/Cmd+Enter 默认动作。Esc 归原语 Modal 的 useModalLayer
  // （层栈顶持有 Escape——嵌套覆盖确认 / set-upstream 确认打开时自动让位）。──
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (pendingGenerate !== null || setUpstreamAsk) return
        void runCommit(defaultAction === 'commit-push')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, pendingGenerate, setUpstreamAsk, defaultAction, onClose, view.commitEnabled, message, amend, skipHooks, trailers, snapshot])

  // ── V2 批次三 ①：trailer 预设行（可增删——按钮追加预设 Key 前缀行，值由用户补）。──
  const addTrailerPreset = (trailerKey: string): void => {
    setTrailers((prev) => {
      const base = prev.trimEnd()
      return base === '' ? `${trailerKey}: ` : `${base}\n${trailerKey}: `
    })
  }

  // ── V2 批次三 ②：豁免勾选（评审修复的 TOCTOU 半）——勾选时把豁免绑定到「当前
  //    违规集签名」（violationsSignature），点提交前的 fresh 扫描违规集已变 ⇒ 旧豁免
  //    在 runCommit 内失效；取消勾选双清。 ──
  const toggleGuardOverride = (checked: boolean): void => {
    setOverrideAcknowledged(checked)
    setOverrideSignature(checked ? violationsSignature(scan?.violations ?? []) : null)
  }

  if (!open) return null

  const identityError = identityState.phase === 'ready' ? identityState.error : null
  // V2 批次三：trailer 非法行（警示不阻断）与护栏面板视图。
  const trailerInvalid = invalidTrailerLine(trailers)
  const guard = guardScanView(scanPhase, scan)
  const busyLabel = pending === 'commit'
    ? t('commit.committing')
    : pending === 'push'
      ? t('commit.pushing')
      : pending === 'fetch'
        ? t('commit.fetching')
        : t('commit.pulling')

  // footer（原语 Button；aria-keyshortcuts 经 Button 的 rest 透传落在按钮元素
  // 上——verify-load 的快捷键组断言依赖该透传面）。Esc 快捷键语义随 Modal 层栈。
  // 评审修复：提交成功转「已提交」终态——footer 换单关按钮（onDone 收尾关框），
  // [63] 的 process 折叠区在关框前保持可见（成功路径自此可达）。
  const footer = view.succeeded ? (
    <Button
      variant='primary'
      className='dsh-git-commit-dialog__close'
      data-git-commit-do='close'
      aria-keyshortcuts='Escape'
      onClick={() => { onDone() }}
    >
      {t('common.close')}
    </Button>
  ) : (
    <>
      <Button
        variant='outline'
        className='dsh-git-commit-dialog__cancel'
        data-git-commit-cancel=''
        aria-keyshortcuts='Escape'
        onClick={() => { onClose() }}
      >
        {t('confirm.cancel')}
      </Button>
      <Button
        variant='primary'
        className='dsh-git-commit-dialog__commit'
        data-git-commit-do='commit'
        disabled={!view.commitEnabled}
        aria-keyshortcuts={defaultAction === 'commit' ? 'Control+Enter Meta+Enter' : undefined}
        onClick={() => { void runCommit(false) }}
      >
        {pending === 'commit' && defaultAction !== 'commit-push' ? busyLabel : t('commit.commit')}
      </Button>
      <Button
        variant='primary'
        className='dsh-git-commit-dialog__commit-push'
        data-git-commit-do='commit-push'
        disabled={!view.pushEnabled}
        aria-keyshortcuts={defaultAction === 'commit-push' ? 'Control+Enter Meta+Enter' : undefined}
        onClick={() => { void runCommit(true) }}
      >
        {pending !== false && defaultAction === 'commit-push' ? busyLabel : t('commit.commitPush')}
      </Button>
    </>
  )

  return (
    <>
      {/* 壳/标题/遮罩/Escape 层栈/Tab 焦点圈/初始聚焦/关闭还原归原语 Modal；
          data-git-commit-dialog 锚保留在 children 包裹层（verify-load 断言）。 */}
      <Modal
        open={open}
        onClose={onClose}
        title={t('commit.title')}
        closeLabel={t('common.close')}
        footer={footer}
      >
        <div className='dsh-git-commit-dialog' data-git-commit-dialog=''>

        {view.showUnbornBar && (
          <p className='dsh-git-commit-dialog__bar' data-git-commit-bar='unborn'>{t('changes.emptyRepo')}</p>
        )}
        {view.showIdentityBar && (
          <p className='dsh-git-commit-dialog__bar' data-git-commit-bar='identity'>
            {t('error.identity-missing', { missing: view.identityMissing })}
          </p>
        )}
        {view.showDivergedBar && (
          <p className='dsh-git-commit-dialog__bar' data-git-commit-bar='diverged'>
            {t('confirm.push.diverged', { behind: view.divergedBehind })}
          </p>
        )}
        {identityError !== null && <GitErrorNotice error={identityError} t={t} onAction={runErrorAction} />}
        {error !== null && (
          <div className='dsh-git-commit-dialog__error' data-git-commit-error=''>
            <GitErrorNotice error={error} t={t} onAction={runErrorAction} />
            <button
              type='button'
              className='dsh-git-commit-dialog__error-dismiss'
              data-git-commit-error-dismiss=''
              onClick={() => { setError(null) }}
            >
              {t('common.close')}
            </button>
          </div>
        )}

        <label className='dsh-git-commit-dialog__editor-label' htmlFor='dsh-git-commit-message'>
          {t('commit.title')}
        </label>
        <textarea
          id='dsh-git-commit-message'
          className='dsh-git-commit-dialog__editor'
          data-git-commit-editor=''
          data-modal-autofocus=''
          placeholder={t('commit.placeholder')}
          value={message}
          rows={5}
          onChange={(event) => { setMessage(event.target.value) }}
        />
        <div className='dsh-git-commit-dialog__editor-meta'>
          <span className='dsh-git-commit-dialog__count' data-git-commit-count=''>{t('commit.messageCount', { count: view.chars })}</span>
          {view.showConventionalHint && (
            <span className='dsh-git-commit-dialog__conventional' data-git-commit-conventional=''>{t('commit.notConventional')}</span>
          )}
          {!view.showConventionalHint && view.messageEmpty && !amend && (
            <span className='dsh-git-commit-dialog__validation' data-git-commit-validation='empty'>{t('error.empty-message')}</span>
          )}
          {view.amendNoEdit && (
            <span className='dsh-git-commit-dialog__validation' data-git-commit-validation='no-edit'>{t('commit.amendNoEdit')}</span>
          )}
        </div>

        <button
          type='button'
          className='dsh-git-commit-dialog__generate'
          data-git-commit-generate=''
          disabled={!view.available || pending !== false || view.succeeded}
          onClick={runGenerate}
        >
          {generating ? t('commit.generating') : t('commit.generate')}
        </button>

        {/* ① trailer 编辑区（[18]）：预设 Co-authored-by / Generated-by 行，可增删；
            非法行即时警示不阻断（镜像 Conventional 预检形态）。 */}
        <div className='dsh-git-commit-dialog__trailers' data-git-commit-trailers=''>
          <label className='dsh-git-commit-dialog__trailers-label' htmlFor='dsh-git-commit-trailers'>
            {t('commit.trailers.label')}
          </label>
          <textarea
            id='dsh-git-commit-trailers'
            className='dsh-git-commit-dialog__trailers-editor'
            data-git-commit-trailers-editor=''
            value={trailers}
            rows={2}
            onChange={(event) => { setTrailers(event.target.value) }}
          />
          <div className='dsh-git-commit-dialog__trailers-actions' data-git-commit-trailers-actions=''>
            <button
              type='button'
              className='dsh-git-commit-dialog__trailer-add'
              data-git-commit-trailer-add='coauthored'
              disabled={pending !== false}
              onClick={() => { addTrailerPreset('Co-authored-by') }}
            >
              {t('commit.trailers.addCoauthored')}
            </button>
            <button
              type='button'
              className='dsh-git-commit-dialog__trailer-add'
              data-git-commit-trailer-add='generated'
              disabled={pending !== false}
              onClick={() => { addTrailerPreset('Generated-by') }}
            >
              {t('commit.trailers.addGenerated')}
            </button>
            {trailerInvalid !== null && (
              <span className='dsh-git-commit-dialog__trailers-invalid' data-git-commit-trailers-invalid=''>
                {t('commit.trailers.invalid')}
              </span>
            )}
          </div>
        </div>

        {/* ② 护栏结果面板（[21][22]）：blocked ⇒ 提交按钮禁用（commit-view-model 闸半）
            + 违规列表 + 可豁免类 danger 勾选豁免入口（D5：secret 硬阻断不可豁免）。 */}
        {guard.visible && (
          <div className='dsh-git-commit-dialog__guard' data-git-commit-guard=''>
            <p className='dsh-git-commit-dialog__guard-title' data-git-commit-guard-title=''>{t('commit.guard.title')}</p>
            {guard.scanning && (
              <p className='dsh-git-commit-dialog__guard-status' role='status' data-git-commit-guard-status='scanning'>
                {t('commit.guard.scanning')}
              </p>
            )}
            {scanError !== null && (
              <GitErrorNotice error={scanError} t={t} />
            )}
            {guard.clean && (
              <p className='dsh-git-commit-dialog__guard-status' data-git-commit-guard-status='clean'>
                {t('commit.guard.clean')}
              </p>
            )}
            {guard.blocked && (
              <p className='dsh-git-commit-dialog__guard-status' data-git-commit-guard-status='blocked'>
                {t('commit.guard.blocked', { count: guard.violations.length })}
              </p>
            )}
            {guard.violations.length > 0 && (
              <ul className='dsh-git-commit-dialog__guard-list' data-git-commit-guard-list=''>
                {guard.violations.map((violation) => (
                  <li
                    key={`${violation.kind}:${violation.path}:${violation.line ?? ''}`}
                    className='dsh-git-commit-dialog__guard-item'
                    data-git-commit-guard-item={violation.kind}
                  >
                    <span className='dsh-git-commit-dialog__guard-kind'>{t(`commit.guard.kind.${violation.kind}`)}</span>
                    <span className='dsh-git-commit-dialog__guard-path'>{violation.path}</span>
                    <span className='dsh-git-commit-dialog__guard-detail'>{violation.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {guard.hasSecret && (
              <p className='dsh-git-commit-dialog__guard-secret' data-git-commit-guard-secret-hint=''>
                {t('commit.guard.secretHint')}
              </p>
            )}
            {guard.blocked && guard.overridable && (
              <Checkbox
                className='dsh-git-commit-dialog__guard-override'
                checked={overrideAcknowledged}
                label={t('commit.guard.override')}
                onChange={toggleGuardOverride}
              />
            )}
          </div>
        )}

        <div className='dsh-git-commit-dialog__staged' data-git-commit-staged=''>
          <p className='dsh-git-commit-dialog__staged-count' data-git-commit-staged-count=''>
            {t('commit.stagedCount', { count: view.stagedCount })}
          </p>
          {view.staged.length > 0 && (
            <ul className='dsh-git-commit-dialog__staged-list' data-git-commit-staged-list=''>
              {view.staged.map((change) => (
                <li key={change.path} className='dsh-git-commit-dialog__staged-item' data-git-commit-staged-item={change.path}>
                  {change.path}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className='dsh-git-commit-dialog__flags'>
          {/* 勾选框换原语 Checkbox（无 rest 透传——data-git-commit-amend/-skip-hooks
              锚随落地消失；两锚在 verify-load/tests/capability-spec 均无断言）。 */}
          <Checkbox
            className='dsh-git-commit-dialog__flag'
            checked={amend}
            disabled={!view.amendAvailable}
            label={view.amendParams !== null
              ? t('commit.amend', view.amendParams)
              : t('commit.amendFallback')}
            onChange={toggleAmend}
          />
          <Checkbox
            className='dsh-git-commit-dialog__flag'
            checked={skipHooks}
            disabled={pending !== false}
            label={t('commit.skipHooks')}
            onChange={setSkipHooks}
          />
        </div>
        {view.showAmendWarning && (
          <p className='dsh-git-commit-dialog__amend-warning' data-git-commit-amend-warning=''>
            {t('commit.amendWarning')}
          </p>
        )}

        {/* ③ hook 输出折叠区（[63]）：成功 = CommitResult.process（git commit 进程整体
            输出，含 hooks）；hook-failed 失败 = details.stderr。长输出尾保留 = redactTail
            （P3-3 复活点），先脱敏再保尾。 */}
        {processView !== null && processView.visible && (
          <details
            className='dsh-git-commit-dialog__process'
            data-git-commit-process=''
            /* 评审修复：成功路径的输出面板默认展开（终态对话框的主内容就是它）；
                hook-failed 失败路径保持折叠（错误条已承接第一可视面）。 */
            open={view.succeeded}
          >
            <summary className='dsh-git-commit-dialog__process-summary' data-git-commit-process-summary=''>
              {t('commit.process.title')}
            </summary>
            {processView.timedOut && (
              <p className='dsh-git-commit-dialog__process-note' data-git-commit-process-timeout=''>{t('commit.process.timedOut')}</p>
            )}
            {processView.durationMs !== null && (
              <p className='dsh-git-commit-dialog__process-note' data-git-commit-process-duration=''>
                {t('commit.process.duration', { ms: processView.durationMs })}
              </p>
            )}
            {processView.truncated && (
              <p className='dsh-git-commit-dialog__process-note' data-git-commit-process-truncated=''>{t('commit.process.truncated')}</p>
            )}
            {processView.stdout !== '' && (
              <div className='dsh-git-commit-dialog__process-section' data-git-commit-process-stdout=''>
                <span className='dsh-git-commit-dialog__process-label'>{t('commit.process.stdout')}</span>
                <pre className='dsh-git-commit-dialog__process-output'>{processView.stdout}</pre>
              </div>
            )}
            {processView.stderr !== '' && (
              <div className='dsh-git-commit-dialog__process-section' data-git-commit-process-stderr=''>
                <span className='dsh-git-commit-dialog__process-label'>{t('commit.process.stderr')}</span>
                <pre className='dsh-git-commit-dialog__process-output'>{processView.stderr}</pre>
              </div>
            )}
          </details>
        )}

        </div>
      </Modal>

      {/* AI 覆盖前确认（嵌套确认框架：两个确认是原语 Modal 自身 portal 到 body 的
          独立浮层，遮罩点击只关各自那一层——外层不受牵连；Escape 让位由层栈承担） */}
      <GitConfirmDialog
        open={pendingGenerate !== null}
        title={t('commit.aiOverwriteTitle')}
        message={t('commit.aiOverwriteMessage')}
        severity='normal'
        confirmLabel={t('confirm.ok')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={() => { applyGenerate() }}
        onCancel={() => { setPendingGenerate(null) }}
      />

      {/* set-upstream 错误动作确认（spec §3.4：no-upstream → 确认后 push({setUpstream:true})） */}
      <GitConfirmDialog
        open={setUpstreamAsk}
        title={t('confirm.setUpstreamTitle')}
        message={t('confirm.setUpstreamMessage')}
        severity='normal'
        confirmLabel={t('error.action.setUpstream')}
        cancelLabel={t('confirm.cancel')}
        onConfirm={runSetUpstreamPush}
        onCancel={() => { setSetUpstreamAsk(false) }}
      />
    </>
  )
}
