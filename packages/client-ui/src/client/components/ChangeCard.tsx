/**
 * @dsh-plugin/client-ui-git — C2 ChangeCard：单文件变更卡片（本模块 ask §③）。
 *
 * **结构对照 ZCode GitPaneChangeCard**（research/ported-sources/zcode/packages/ui/src
 * /GitPaneChangeCard.tsx，Apache-2.0——PORTING.md B 级登记）：行按钮（文件名区 +
 * 右侧 +N −M 计数区）+ 展开后懒加载 diff 区的骨架照其结构；**逻辑重写、视觉随 dsh**——
 * 不引入其上下文菜单/Chevron 图标/shadcn 类名体系，改本包 dsh-git-* 类名 + data-* 锚；
 * 交互面按本插件 ask 扩展：状态字母徽标、binary 徽标、重命名 old→new、勾选（⇄
 * stage/unstage）、行内动作按钮按组区分（ChangeRow.actions，装配在 changes-view-model）。
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeRow } from '../changes-view-model.js'
import type { NS } from '../locales.js'

export interface ChangeCardProps {
  /** 行渲染模型（组 + 动作可见性已折算）。 */
  row: ChangeRow
  /** 勾选态（staged 组 true；其余组 false——勾选 ⇄ stage/unstage [清单 9]）。 */
  checked: boolean
  /** 是否展开 diff 区（单展开位由 tab store 的 selectedPath 决定）。 */
  expanded: boolean
  /** 展开时行下方的 diff 区（懒加载状态由父级装配；收起时不传）。 */
  diffArea?: ReactNode
  /** 词典 t。 */
  t: TranslateNS<typeof NS>
  onToggleCheck(): void
  onToggleExpand(): void
  onStage(): void
  onUnstage(): void
  onDiscard(): void
  /** 行级快捷键（④-K ask §②：Space=暂存切换 / Enter=行按钮原生展开 / Delete=丢弃；父级装配语义）。 */
  onKeyDown?(event: ReactKeyboardEvent): void
}

/** +N −M 计数（binary/untracked 无计数 → null）。 */
function Counts({ row }: { row: ChangeRow }): ReactNode {
  const { additions, deletions } = row.change
  if (additions === null || deletions === null) return null
  return (
    <span className='dsh-git-change-card__counts' data-git-change-counts=''>
      <span className='dsh-git-change-card__added' data-git-change-added=''>{`+${additions}`}</span>
      <span className='dsh-git-change-card__deleted' data-git-change-deleted=''>{`-${deletions}`}</span>
    </span>
  )
}

/**
 * 单文件变更卡片：勾选 + 行按钮（徽标/路径/计数 + 组内动作）+ 展开位。
 * @param props - 行模型与回调。
 */
export function ChangeCard(props: ChangeCardProps): ReactNode {
  const { row, checked, expanded, diffArea, t, onToggleCheck, onToggleExpand, onStage, onUnstage, onDiscard, onKeyDown } = props
  const { change } = row
  const renamed = change.origPath !== null
  return (
    <div
      className='dsh-git-change-card'
      data-git-change-card=''
      data-git-change-group={row.group}
      data-git-change-kind={change.kind}
      onKeyDown={onKeyDown}
    >
      <div className='dsh-git-change-card__row' data-git-change-row=''>
        <input
          type='checkbox'
          className='dsh-git-change-card__check'
          checked={checked}
          aria-label={t('changes.checkAria', { path: row.path })}
          data-git-change-check=''
          onChange={onToggleCheck}
        />
        <button
          type='button'
          className='dsh-git-change-card__main'
          aria-expanded={expanded}
          aria-keyshortcuts={row.actions.discard ? 'Space Enter Delete' : 'Space Enter'}
          title={row.path}
          data-git-change-toggle=''
          onClick={onToggleExpand}
        >
          <span className='dsh-git-change-card__glyph' data-git-change-glyph={row.glyph.letter} data-git-change-glyph-tone={row.glyph.tone}>
            {row.glyph.letter}
          </span>
          <span className='dsh-git-change-card__path' data-git-change-path={row.path}>
            {renamed && (
              <span className='dsh-git-change-card__orig' data-git-change-orig-path={change.origPath ?? undefined}>
                {`${change.origPath ?? ''} -> `}
              </span>
            )}
            <span className='dsh-git-change-card__name'>{row.path}</span>
          </span>
          {change.binary && <span className='dsh-git-change-card__flag' data-git-change-binary=''>{t('changes.binary')}</span>}
          {change.submodule && <span className='dsh-git-change-card__flag' data-git-change-submodule=''>{t('changes.submodule')}</span>}
          <Counts row={row} />
        </button>
        <span className='dsh-git-change-card__actions' data-git-change-actions=''>
          {row.actions.unstage && (
            <button type='button' className='dsh-git-change-card__action' data-git-change-action='unstage' onClick={onUnstage}>
              {t('changes.unstage')}
            </button>
          )}
          {row.actions.stage && (
            <button type='button' className='dsh-git-change-card__action' data-git-change-action='stage' onClick={onStage}>
              {t('changes.stage')}
            </button>
          )}
          {row.actions.discard && (
            <button type='button' className='dsh-git-change-card__action' data-git-change-action='discard' onClick={onDiscard}>
              {t('changes.discard')}
            </button>
          )}
        </span>
      </div>
      {expanded && diffArea !== undefined && (
        <div className='dsh-git-change-card__diff' data-git-change-diff=''>{diffArea}</div>
      )}
    </div>
  )
}
