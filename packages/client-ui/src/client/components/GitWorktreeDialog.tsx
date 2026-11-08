/**
 * dsh-gitkit-ui — GitWorktreeDialog：worktree 管理对话框（V2 批次一 [62][68]；
 * plan §3.6「Worktree…」行）。三区：
 *   - 列表区（[62]）：worktreeList 数据 → worktreeRows（path + 分支/detached/bare/
 *     locked 徽标；bare 不可移除——git worktree remove 对主 bare 无效）；
 *   - 移除入口：两段闸（admin-view-model.worktreeRemovePlan）——首次 normal 确认
 *     （不传 force，host 对脏 worktree 拒绝）；失败（git/worktree-failed）后转
 *     GitConfirmDialog severity='danger' 的强制移除（force+acknowledged 透传，
 *     勾选闸承担「不可逆」确认——脏 worktree 的 danger 勾选闸语义）；
 *   - 新建区（[68]）：path + 检出现有分支 / 新建分支二选一（互斥，plan §3.2）；
 *     现有分支 picker 排除已被任一 worktree 检出的分支（git 拒绝重复检出）。
 * 校验与入参组装收敛在 admin-view-model（纯函数，tests/admin-view-model.spec）。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RefInfo, WorktreeInfo } from 'dsh-gitkit/types'
import type { GitAdminFace } from '../admin-face.js'
import type { WorktreeBranchMode } from '../admin-view-model.js'
import { worktreeAddDraft, worktreeRemovePlan, worktreeRows } from '../admin-view-model.js'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import { GitConfirmDialog } from './GitConfirmDialog.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitWorktreeDialogProps {
  open: boolean
  t: TranslateNS<typeof NS>
  face: GitAdminFace
  /** 关框（Cancel / Esc / 遮罩点击）。 */
  onClose(): void
}

/** worktree 管理对话框（列表区 + 新建区 + 移除两段闸；原语 Modal 浮层）。 */
export function GitWorktreeDialog(props: GitWorktreeDialogProps): ReactNode {
  const { open, t, face, onClose } = props
  const [worktrees, setWorktrees] = useState<readonly WorktreeInfo[]>([])
  const [branches, setBranches] = useState<readonly RefInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  // 新建区
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<WorktreeBranchMode>('existing')
  const [branch, setBranch] = useState<string | null>(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [creating, setCreating] = useState(false)
  // 移除闸
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removeStage, setRemoveStage] = useState<'ask' | 'force'>('ask')
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<GitErrorLike | null>(null)

  useEffect(() => {
    if (!open) return
    setWorktrees([])
    setBranches([])
    setLoaded(false)
    setPath('')
    setMode('existing')
    setBranch(null)
    setBranchPickerOpen(false)
    setNewBranch('')
    setCreating(false)
    setRemoveTarget(null)
    setRemoveStage('ask')
    setRemoving(false)
    setError(null)
    let cancelled = false
    void face.worktreeList().then((result) => {
      if (cancelled) return
      if (result.ok) setWorktrees(result.value.worktrees)
      else setError(result.error)
      setLoaded(true)
    })
    void face.listLocalBranches().then((result) => {
      if (cancelled) return
      if (result.ok) setBranches(result.value)
    })
    return () => { cancelled = true }
  }, [open, face])

  const rows = useMemo(() => worktreeRows(worktrees), [worktrees])
  // 现有分支 picker 排除已被任一 worktree 检出的分支（git 拒绝重复检出）。
  const branchChoices = useMemo(() => {
    const checkedOut = new Set(worktrees.map((worktree) => worktree.branch).filter((name): name is string => name !== null))
    return branches.filter((ref) => !checkedOut.has(ref.shortName))
  }, [worktrees, branches])
  const draft = worktreeAddDraft({ path, mode, branch: branch ?? '', newBranch })

  const refreshList = (): void => {
    void face.worktreeList().then((result) => {
      if (result.ok) setWorktrees(result.value.worktrees)
    })
  }

  const onCreate = (): void => {
    if (!draft.valid || draft.options === null || creating) return
    setCreating(true)
    setError(null)
    void face.worktreeAdd(draft.options).then((result) => {
      if (!result.ok) {
        setCreating(false)
        setError(result.error)
        return
      }
      setCreating(false)
      setPath('')
      setBranch(null)
      setNewBranch('')
      refreshList()
    })
  }

  const onRemoveConfirm = (): void => {
    if (removeTarget === null) return
    const plan = worktreeRemovePlan(removeStage)
    setRemoving(true)
    setError(null)
    void face.worktreeRemove({
      path: removeTarget,
      ...(plan.force ? { force: true, acknowledged: true } : {}),
    }).then((result) => {
      setRemoving(false)
      if (!result.ok) {
        // 脏 worktree（或其它失败）→ 转强制移除的 danger 勾选闸（两段闸第二段）。
        setRemoveStage('force')
        setError(result.error)
        return
      }
      setRemoveTarget(null)
      setRemoveStage('ask')
      refreshList()
    })
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('worktree.title')}
        closeLabel={t('common.close')}
        contentClassName='dsh-git-worktree-dialog__scroll'
        footer={(
          <Button
            variant='outline'
            className='dsh-git-worktree-dialog__close'
            onClick={() => { onClose() }}
          >
            {t('common.close')}
          </Button>
        )}
      >
        <div className='dsh-git-worktree-dialog' data-git-worktree-dialog=''>
          {error !== null && <GitErrorNotice error={error} t={t} />}

          {/* ── 列表区（[62]）── */}
          <div className='dsh-git-worktree-dialog__list' data-git-worktree-list=''>
            {loaded && rows.length === 0 && (
              <p className='dsh-git-worktree-dialog__empty'>{t('worktree.empty')}</p>
            )}
            {rows.map((row) => (
              <div key={row.path} className='dsh-git-worktree-dialog__row' data-git-worktree-row={row.path}>
                <span className='dsh-git-worktree-dialog__row-path'>{row.path}</span>
                <span className='dsh-git-worktree-dialog__row-branch'>
                  {row.branch ?? (row.detached ? t('worktree.detached') : '')}
                  {row.bare ? ` ${t('worktree.bare')}` : ''}
                  {row.locked ? ` ${t('worktree.locked')}` : ''}
                </span>
                <button
                  type='button'
                  className='dsh-git-worktree-dialog__row-remove'
                  data-git-worktree-remove=''
                  disabled={!row.removable || removing}
                  onClick={() => {
                    setRemoveStage('ask') // 两段闸首段：normal 确认（不传 force）
                    setRemoveTarget(row.path)
                  }}
                >
                  {t('worktree.remove')}
                </button>
              </div>
            ))}
          </div>

          {/* ── 新建区（[68]：path / 现有分支或新建分支二选一）── */}
          <div className='dsh-git-worktree-dialog__add' data-git-worktree-add=''>
            <p className='dsh-git-worktree-dialog__add-title'>{t('worktree.addTitle')}</p>
            <label className='dsh-git-worktree-dialog__label' htmlFor='dsh-git-worktree-path'>
              {t('worktree.pathLabel')}
            </label>
            <Input
              id='dsh-git-worktree-path'
              className='dsh-git-worktree-dialog__path'
              value={path}
              onChange={(event) => { setPath(event.target.value) }}
            />
            {draft.missing === 'path' && <p className='dsh-git-worktree-dialog__hint'>{t('worktree.pathRequired')}</p>}
            <div className='dsh-git-worktree-dialog__modes'>
              <button
                type='button'
                className='dsh-git-worktree-dialog__mode'
                aria-pressed={mode === 'existing'}
                onClick={() => { setMode('existing') }}
              >
                {t('worktree.existingBranch')}
              </button>
              <button
                type='button'
                className='dsh-git-worktree-dialog__mode'
                aria-pressed={mode === 'new'}
                onClick={() => { setMode('new') }}
              >
                {t('worktree.newBranch')}
              </button>
            </div>
            {mode === 'existing' ? (
              <div className='dsh-git-worktree-dialog__picker-row'>
                <Menu
                  open={branchPickerOpen}
                  anchor={
                    <button
                      type='button'
                      className='dsh-git-worktree-dialog__picker'
                      data-git-worktree-branch-picker=''
                      aria-haspopup='menu'
                      aria-expanded={branchPickerOpen}
                      disabled={branchChoices.length === 0}
                      onClick={() => { setBranchPickerOpen((value) => !value) }}
                    >
                      {branch ?? t('worktree.existingBranch')}
                    </button>
                  }
                  items={branchChoices.map((ref) => ({ id: ref.shortName, label: ref.shortName }))}
                  selectedId={branch ?? undefined}
                  onSelect={(id) => {
                    setBranch(id)
                    setBranchPickerOpen(false)
                  }}
                  onClose={() => { setBranchPickerOpen(false) }}
                />
              </div>
            ) : (
              <div className='dsh-git-worktree-dialog__picker-row'>
                <Input
                  className='dsh-git-worktree-dialog__new-branch'
                  aria-label={t('worktree.branchLabel')}
                  value={newBranch}
                  onChange={(event) => { setNewBranch(event.target.value) }}
                />
              </div>
            )}
            {mode === 'new' && draft.missing === 'branch' && (
              <p className='dsh-git-worktree-dialog__hint'>{t('worktree.branchRequired')}</p>
            )}
            <Button
              variant='primary'
              className='dsh-git-worktree-dialog__add-confirm'
              data-git-worktree-add-confirm=''
              disabled={!draft.valid || creating}
              onClick={onCreate}
            >
              {t('worktree.add')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 移除确认（两段闸）：ask = normal；force = danger 勾选闸（脏 worktree 强制移除）。
          force 段打开时错误条已解释失败原因（GitErrorNotice 在主框内）。 */}
      <GitConfirmDialog
        open={removeTarget !== null}
        title={t('worktree.removeTitle')}
        message={removeStage === 'ask'
          ? t('worktree.removeMessage', { path: removeTarget ?? '' })
          : `${t('worktree.removeMessage', { path: removeTarget ?? '' })} ${t('worktree.removeForceMessage')}`}
        severity={removeStage === 'ask' ? 'normal' : 'danger'}
        confirmLabel={removeStage === 'ask' ? t('worktree.remove') : t('worktree.removeForce')}
        cancelLabel={t('confirm.cancel')}
        checkboxLabel={t('confirm.dangerCheckbox')}
        onConfirm={onRemoveConfirm}
        onCancel={() => { setRemoveTarget(null) }}
      />
    </>
  )
}
