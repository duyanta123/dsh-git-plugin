/**
 * dsh-gitkit-ui — GitSubmodulePanel：子模块状态详情面板（V2 批次四 [61]；plan §6.6）。
 *
 * 装配：changes tab 文件卡片的 submodule 徽标行旁「子模块详情」动作拉起（Modal）——
 * 面板显示 `submoduleStatus` 列表（path / 当前 oid vs 记录 oid 差异高亮 / state
 * 徽标）。**只列不递归**（host submodule.ts 同口径——plan §6.5/§6.1 [61] 行）。
 * 行模型收敛在 submodule-view-model.submoduleRows（tests/submodule-view.spec 断言）；
 * oid 差异高亮 = data-git-submodule-mismatch 锚 + mismatchHint 提示行（样式归 git.css
 * 的 dsw token）。
 */

import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubmoduleEntry } from 'dsh-gitkit/types'
import type { GitErrorLike } from '../remote/mount.js'
import type { NS } from '../locales.js'
import type { GitChangesOpsFace } from '../changes-ops-face.js'
import { submoduleRows } from '../submodule-view-model.js'
import { GitErrorNotice } from './GitErrorNotice.js'

export interface GitSubmodulePanelProps {
  /** false = 不渲染（原语 Modal 亦不挂载）。 */
  open: boolean
  /** 词典 t（拉起方 bind 后传入——本组件不直接注册 locale）。 */
  t: TranslateNS<typeof NS>
  /** 变更动作面（submoduleStatus 消费半；apply 顶层单例闭包）。 */
  ops: GitChangesOpsFace
  /** 关框（关闭按钮 / Esc / 遮罩点击）。 */
  onClose(): void
}

/** 子模块状态详情面板（submoduleStatus 列表；原语 Modal 浮层）。 */
export function GitSubmodulePanel(props: GitSubmodulePanelProps): ReactNode {
  const { open, t, ops, onClose } = props
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading')
  const [entries, setEntries] = useState<readonly SubmoduleEntry[]>([])
  const [error, setError] = useState<GitErrorLike | null>(null)

  // 开框即取（只读面；失败进错误条——可关闭重开）。
  useEffect(() => {
    if (!open) return
    setPhase('loading')
    setEntries([])
    setError(null)
    let cancelled = false
    void ops.submoduleStatus().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setEntries(result.value.submodules)
        setPhase('ready')
      } else {
        setError(result.error)
        setPhase('ready')
      }
    })
    return () => { cancelled = true }
  }, [open, ops])

  if (!open) return null
  const rows = submoduleRows(entries)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('submodule.details')}
      closeLabel={t('common.close')}
      footer={(
        <Button
          variant='outline'
          className='dsh-git-submodule-panel__close'
          onClick={() => { onClose() }}
        >
          {t('common.close')}
        </Button>
      )}
    >
      <div className='dsh-git-submodule-panel' data-git-submodule-panel=''>
        {error !== null && <GitErrorNotice error={error} t={t} />}
        {phase === 'loading' && (
          <p className='dsh-git-submodule-panel__status' role='status' data-git-submodule-status='loading'>
            {t('submodule.loading')}
          </p>
        )}
        {phase === 'ready' && error === null && rows.length === 0 && (
          <p className='dsh-git-submodule-panel__status' data-git-submodule-status='empty'>
            {t('submodule.empty')}
          </p>
        )}
        {rows.length > 0 && (
          <ul className='dsh-git-submodule-panel__list' data-git-submodule-list=''>
            {rows.map((row) => (
              <li
                key={row.path}
                className='dsh-git-submodule-panel__item'
                data-git-submodule-item={row.path}
                data-git-submodule-mismatch={row.mismatch ? '' : undefined}
              >
                <span className='dsh-git-submodule-panel__path'>{row.path}</span>
                <span className='dsh-git-submodule-panel__state' data-git-submodule-state={row.stateKey}>
                  {t(row.stateKey)}
                </span>
                <span className='dsh-git-submodule-panel__oids'>
                  <span className='dsh-git-submodule-panel__oid'>
                    {t('submodule.currentOid', { oid: row.oid ?? '—' })}
                  </span>
                  <span className='dsh-git-submodule-panel__oid'>
                    {t('submodule.recordedOid', { oid: row.recordedOid ?? '—' })}
                  </span>
                </span>
                {row.mismatch && (
                  <span className='dsh-git-submodule-panel__hint' data-git-submodule-hint=''>
                    {t('submodule.mismatchHint')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
