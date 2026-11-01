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
 * 浮层：**portal 自建**（document.body 挂载点，Escape 折叠）+ **焦点管理**（开框存
 * 焦点 → 聚焦消息编辑器 → 关框还原）。不注册 root 槽——root 被 AppFrame 占据
 * （map §3.1）；由拉起方（GitHeaderButton 菜单 / GitChangesTab 底部按钮）在自己的
 * 组件树内渲染本组件。
 *
 * 快捷键（ask §②，aria-keyshortcuts 全组）：Ctrl/Cmd+Enter = 默认动作
 * （defaultAction），Esc = Cancel；嵌套覆盖确认打开时让位给确认框自己的 Esc。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GeneratedCommitMessage, GitIdentityResult, GitStatusSnapshot } from 'dsh-gitkit/types'
import type { GitCommitDialogFace, HeadCommitInfo } from '../commit-dialog-face.js'
import type { CommitPending } from '../commit-view-model.js'
import { commitDialogView, commitOptionsOf, pushOptionsOf } from '../commit-view-model.js'
import type { GitErrorLike, RemoteResult } from '../remote/mount.js'
import type { ErrorAction } from '../error-map.js'
import type { NS } from '../locales.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** 提交对话框的拉起意图（默认动作 = Ctrl/Cmd+Enter 的目标）。 */
export type CommitDialogIntent = 'commit' | 'commit-push'

export interface GitCommitDialogProps {
  /** false = 不渲染（portal 亦不挂载）。 */
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
 * 提交对话框（portal 浮层）。
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
  }), [snapshot, identityState, message, amend, head, pending])

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

  // ── portal 自建：open 时在 body 挂承载节点，关闭即摘除 ───────
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) {
      setPortalHost(null)
      return
    }
    const host = document.createElement('div')
    host.setAttribute('data-git-commit-portal', '')
    document.body.appendChild(host)
    setPortalHost(host)
    return () => { host.remove() }
  }, [open])

  // ── 焦点管理：开框存焦点 → 聚焦编辑器 → 关框还原 ─────────────
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    editorRef.current?.focus()
    return () => { previous?.focus() }
  }, [open])

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
    onDone()
  }

  const runCommit = async (pushAfter: boolean): Promise<void> => {
    if (!view.commitEnabled) return
    setPending('commit')
    setError(null)
    const options = commitOptionsOf(message, amend, skipHooks)
    const committed = await face.commit(options)
    if (!committed.ok) {
      setPending(false)
      lastFailureRef.current = { step: 'commit', pushAfter }
      setError(committed.error)
      return
    }
    if (!pushAfter) {
      setPending(false)
      onDone()
      return
    }
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

  // ── 快捷键（ask §②）：Ctrl/Cmd+Enter 默认动作；Esc 取消 ─────
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 嵌套覆盖确认 / set-upstream 确认打开时让位：确认框自己的 Esc 负责收它。
        if (pendingGenerate !== null || setUpstreamAsk) return
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (pendingGenerate !== null || setUpstreamAsk) return
        void runCommit(defaultAction === 'commit-push')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, pendingGenerate, setUpstreamAsk, defaultAction, onClose, view.commitEnabled, message, amend, skipHooks, snapshot])

  if (!open || portalHost === null) return null

  const identityError = identityState.phase === 'ready' ? identityState.error : null
  const busyLabel = pending === 'commit'
    ? t('commit.committing')
    : pending === 'push'
      ? t('commit.pushing')
      : pending === 'fetch'
        ? t('commit.fetching')
        : t('commit.pulling')

  return createPortal(
    <>
      <div
        className='dsh-git-commit-backdrop'
        data-git-commit-dialog=''
        onClick={() => { onClose() }}
      >
      <div
        className='dsh-git-commit-dialog'
        role='dialog'
        aria-modal='true'
        aria-label={t('commit.title')}
        onClick={(event) => { event.stopPropagation() }}
      >
        <h3 className='dsh-git-commit-dialog__title'>{t('commit.title')}</h3>

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
          ref={editorRef}
          className='dsh-git-commit-dialog__editor'
          data-git-commit-editor=''
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
          disabled={!view.available || pending !== false}
          onClick={runGenerate}
        >
          {generating ? t('commit.generating') : t('commit.generate')}
        </button>

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
          <label className='dsh-git-commit-dialog__flag'>
            <input
              type='checkbox'
              checked={amend}
              disabled={!view.amendAvailable}
              data-git-commit-amend=''
              onChange={(event) => { toggleAmend(event.target.checked) }}
            />
            <span>
              {view.amendParams !== null
                ? t('commit.amend', view.amendParams)
                : t('commit.amendFallback')}
            </span>
          </label>
          <label className='dsh-git-commit-dialog__flag'>
            <input
              type='checkbox'
              checked={skipHooks}
              disabled={pending !== false}
              data-git-commit-skip-hooks=''
              onChange={(event) => { setSkipHooks(event.target.checked) }}
            />
            <span>{t('commit.skipHooks')}</span>
          </label>
        </div>
        {view.showAmendWarning && (
          <p className='dsh-git-commit-dialog__amend-warning' data-git-commit-amend-warning=''>
            {t('commit.amendWarning')}
          </p>
        )}

        <div className='dsh-git-commit-dialog__actions'>
          <button
            type='button'
            className='dsh-git-commit-dialog__cancel'
            data-git-commit-cancel=''
            aria-keyshortcuts='Escape'
            onClick={() => { onClose() }}
          >
            {t('confirm.cancel')}
          </button>
          <button
            type='button'
            className='dsh-git-commit-dialog__commit'
            data-git-commit-do='commit'
            disabled={!view.commitEnabled}
            aria-keyshortcuts={defaultAction === 'commit' ? 'Control+Enter Meta+Enter' : undefined}
            onClick={() => { void runCommit(false) }}
          >
            {pending === 'commit' && defaultAction !== 'commit-push' ? busyLabel : t('commit.commit')}
          </button>
          <button
            type='button'
            className='dsh-git-commit-dialog__commit-push'
            data-git-commit-do='commit-push'
            disabled={!view.pushEnabled}
            aria-keyshortcuts={defaultAction === 'commit-push' ? 'Control+Enter Meta+Enter' : undefined}
            onClick={() => { void runCommit(true) }}
          >
            {pending !== false && defaultAction === 'commit-push' ? busyLabel : t('commit.commitPush')}
          </button>
        </div>
      </div>
      </div>

      {/* AI 覆盖前确认（嵌套确认框架；portal host 内与背板平级——遮罩点击不冒泡到外层取消） */}
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
    </>,
    portalHost,
  )
}
