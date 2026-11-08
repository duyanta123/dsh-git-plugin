/**
 * dsh-gitkit-ui — 提交详情面板（本模块 ask §④；spec §3.1/§3.3
 * [清单 32/33]「点击提交行 → 行内详情 → 文件点击 → FileDiffView」）。
 *
 * 数据流：选中行（graph-tab-store.select）→ GitGraphTab 调 inject 面
 * `showCommit(oid)`（git-graph-store 列表态：meta + numstat + refs 过滤）→ 面板
 * 渲染提交头（subject/body/作者/日期/短 oid）+ ref chips（HEAD -> 分支形态在此
 * 合成——spec §3.3.1「由渲染层处理」）+ 文件清单；**点文件** 调
 * `showCommit(oid, path)`（host getCommitDetail 的 path 模式 = DiffEngine
 * commitDiff 单文件 patch——workflow ask §④「点文件调 commitDiff 复用 diff-view」）
 * → 带 patch 的文件 splice 回缓存 → FileDiffView 渲染（占位语义 [清单 59] 复用
 * changes/diff 词典键）。
 *
 * 面板自体不做数据获取与 RPC（props 注入；范式 map §3.4）；渲染为纯函数可测的
 * 视图模型收敛在 graph-view-model.ts。失败详情可重试（P2）：error 槽在错误码的
 * 映射动作全为 retry 时经 GitErrorNotice 的动作位重试（onAction 只在可服务时传入，
 * 防 set-upstream/fetch/pull 等不可服务动作位渲染成死按钮），其余码走面板自备
 * 重试位——都调 `onRetry` → tab 侧 `showCommit(oid, null)` 重发拉取（store 清槽
 * 语义见 git-graph-store 的 showCommit/reloadLog 注记）。
 */

import { useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { errorNoticeView } from '../error-map.js'
import type { ErrorAction } from '../error-map.js'
import type { CommitDetailState } from '../store/git-graph-store.js'
import type { DetailRow, DetailRefChip, DetailViewModel } from '../graph-view-model.js'
import { FileDiffView } from './FileDiffView.js'
import { GitErrorNotice } from './GitErrorNotice.js'

/** 详情面板 props（GitGraphTab 装配）。 */
export interface CommitDetailPanelProps {
  /** 选中提交 oid。 */
  oid: string
  /** 该 oid 的详情缓存槽（git-graph-store.details[oid]）。 */
  state: CommitDetailState | undefined
  /** 详情视图模型（GitGraphTab 从缓存装配；面板只渲染）。 */
  view: DetailViewModel
  /** 词典翻译。 */
  t: TranslateNS<'git'>
  /**
   * 失败详情的重试（P2 卡死修复：一次失败不再整会话卡死）。tab 侧 =
   * `showCommit(oid, null)`——store 契约：error 槽重发拉取并清槽（置 loading）。
   */
  onRetry(): void
  /** 文件点击（path patch 懒加载；同 path 再点收起由 tab 侧 openDetailPath 承担）。 */
  onFileClick(path: string): void
  /** 关闭面板（tab 侧 select(null)）。 */
  onClose(): void
  /** tag chip 菜单：删除标签（V2 批次一 [30]；tab 侧确认后 tagDelete）。 */
  onTagDelete(name: string): void
  /** tag chip 菜单：在该提交打标签（tab 侧拉起 GitTagCreateDialog）。 */
  onTagCreate(oid: string): void
}

/** 提交详情面板（提交图 tab 的选中态下半区）。 */
export function CommitDetailPanel(props: CommitDetailPanelProps): ReactNode {
  const { oid, state, view, t, onRetry, onFileClick, onClose, onTagDelete, onTagCreate } = props
  // 详情错误槽的动作面（评审第 1 轮）：面板只服务 retry——仅当错误码的映射动作
  // **全为** retry（现状即 gateway/service-unavailable）时才把 onAction 交给
  // notice，动作行才渲染；携带 set-upstream/fetch/pull 的码（git/no-upstream、
  // git/diverged——error-map.ts 的 actions 表）在 onAction 缺席时不渲染动作位
  // （GitErrorNotice 的渲染闸 = actions.length > 0 && onAction !== undefined），
  // 否则会产出点击无效的死按钮（修复前面板不传 onAction，动作位同样不渲染；
  // 现行 getCommitDetail 错误面不产生这些码，属潜伏缺陷封堵）。every 而非
  // includes 亦防未来「混合动作码」复发。无 retry 可服务的码走面板自备重试位。
  const errorSlot = state?.state === 'error' && state.error !== undefined ? state.error : null
  const errorActions = errorSlot !== null ? errorNoticeView(errorSlot).actions : []
  const noticeServesRetry = errorActions.length > 0
    && errorActions.every((action) => action === 'retry')
  return (
    <section className='dsh-git-graph-detail' data-git-graph-detail='' data-git-graph-detail-oid={oid}>
      <header className='dsh-git-graph-detail__header'>
        <div className='dsh-git-graph-detail__title'>
          <span className='dsh-git-graph-detail__subject' data-git-graph-detail-subject=''>{view.subject}</span>
          <span className='dsh-git-graph-detail__oid' data-git-graph-detail-oid-short=''>{view.shortOid}</span>
        </div>
        <p className='dsh-git-graph-detail__meta' data-git-graph-detail-meta=''>
          {view.author}{view.date === '' ? '' : ` · ${view.date}`}
        </p>
        {view.refs.length > 0 && (
          <p className='dsh-git-graph-detail__refs' data-git-graph-detail-refs=''>
            {view.refs.map((ref, index) => (
              ref.tag
                ? <TagChip key={`${ref.label}-${index}`} chip={ref} t={t} onTagDelete={onTagDelete} onTagCreate={() => { onTagCreate(oid) }} />
                : (
                    <span
                      key={`${ref.label}-${index}`}
                      className={ref.head ? 'dsh-git-graph-detail__ref dsh-git-graph-detail__ref--head' : 'dsh-git-graph-detail__ref'}
                      data-git-graph-detail-ref={ref.label}
                    >
                      {ref.label}
                    </span>
                  )
            ))}
          </p>
        )}
        <button
          type='button'
          className='dsh-git-graph-detail__close'
          data-git-graph-detail-close=''
          onClick={onClose}
        >
          {t('common.close')}
        </button>
      </header>
      {view.body !== '' && (
        <pre className='dsh-git-graph-detail__body' data-git-graph-detail-body=''>{view.body}</pre>
      )}
      {errorSlot !== null && (
        <div className='dsh-git-graph-detail__error' data-git-graph-detail-error=''>
          <GitErrorNotice
            error={errorSlot}
            t={t}
            // exactOptionalPropertyTypes 下可选属性不接受显式 undefined——用条件展开
            // 表达「不传」；onAction 缺席 ⇒ notice 动作行不渲染（见上方 noticeServesRetry 注）。
            {...(noticeServesRetry
              ? { onAction: (action: ErrorAction) => { if (action === 'retry') onRetry() } }
              : {})}
          />
          {/* 无 retry 可服务的失败码（git/git-error 等大多数 + set-upstream/fetch/pull 码）
              也要可重试——面板自备重试位（GitChangesTab diff-error 既有范式）；已由
              notice 动作位承担 retry 的码（gateway/service-unavailable）不重复出钮。 */}
          {!noticeServesRetry && (
            <button
              type='button'
              className='dsh-git-graph-detail__retry'
              data-git-graph-detail-retry=''
              onClick={onRetry}
            >
              {t('common.retry')}
            </button>
          )}
        </div>
      )}
      {state?.state === 'loading' && (
        <p className='dsh-git-graph-detail__loading' data-git-graph-detail-loading=''>{t('graph.loading')}</p>
      )}
      {view.totalTruncated && (
        <p className='dsh-git-graph-detail__note' data-git-graph-detail-truncated=''>{t('graph.detail.totalTruncated')}</p>
      )}
      {state?.state === 'ready' && (
        <div className='dsh-git-graph-detail__files' data-git-graph-detail-files=''>
          <h4 className='dsh-git-graph-detail__files-header'>
            {t('graph.detail.files', { count: String(view.files.length) })}
          </h4>
          {view.files.map((file) => (
            <DetailFileRow key={file.path} file={file} state={state} t={t} onFileClick={onFileClick} />
          ))}
        </div>
      )}
    </section>
  )
}

/** 一条变更文件行：状态徽标 + 路径 + 计数；展开时 FileDiffView（patch 就绪后）。 */
function DetailFileRow(props: {
  file: DetailRow
  state: CommitDetailState
  t: CommitDetailPanelProps['t']
  onFileClick(path: string): void
}): ReactNode {
  const { file, state, t, onFileClick } = props
  const expanded = file.expanded
  const patchFile = expanded ? state.detail?.files.find((item) => item.path === file.path) : undefined
  const loading = state.pendingPath === file.path
  return (
    <div className='dsh-git-graph-detail__file' data-git-graph-detail-file={file.path}>
      <button
        type='button'
        className='dsh-git-graph-detail__file-row'
        data-git-graph-detail-file-row=''
        data-git-graph-detail-file-status={file.status}
        onClick={() => { onFileClick(file.path) }}
      >
        <span className='dsh-git-graph-detail__file-status'>{file.statusLetter}</span>
        <span className='dsh-git-graph-detail__file-path'>
          {file.origPath !== null ? `${file.origPath} → ${file.path}` : file.path}
        </span>
        <span className='dsh-git-graph-detail__file-counts'>
          {file.binary
            ? t('changes.binary')
            : <>{`+${file.additions ?? 0}`}{` −${file.deletions ?? 0}`}</>}
        </span>
      </button>
      {expanded && loading && (
        <p className='dsh-git-graph-detail__loading'>{t('graph.loading')}</p>
      )}
      {expanded && !loading && patchFile !== undefined && (
        <FileDiffView file={patchFile} t={t} />
      )}
      {expanded && !loading && patchFile === undefined && (
        <p className='dsh-git-graph-detail__note'>{t('changes.loadFailed')}</p>
      )}
    </div>
  )
}

/**
 * tag chip（V2 批次一 [30]）：chip 本体 + 原语 Menu 浮层（删 tag / 从该提交打 tag
 * ——plan §3.6）。挂详情面板的 refs 区（非虚拟化区）；log 行 refs chips 是行
 * `<button>` 的内联 span，嵌套可交互菜单会产出 button-in-button 的非法 DOM 与
 * 键盘走焦点环破坏——不挂（落点差异记 ModuleResult.openIssues）。
 */
function TagChip(props: {
  chip: DetailRefChip
  t: CommitDetailPanelProps['t']
  onTagDelete(name: string): void
  onTagCreate(): void
}): ReactNode {
  const { chip, t, onTagDelete, onTagCreate } = props
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      anchor={
        <button
          type='button'
          className='dsh-git-graph-detail__ref dsh-git-graph-detail__ref--tag'
          data-git-graph-detail-ref={chip.label}
          data-git-graph-detail-tag=''
          aria-haspopup='menu'
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value) }}
        >
          {chip.label}
        </button>
      }
      portal
      items={[
        { id: 'tag-delete', label: t('tag.menuDelete') },
        { id: 'tag-create', label: t('tag.menuCreateHere') },
      ]}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'tag-delete') onTagDelete(chip.label)
        else onTagCreate()
      }}
      onClose={() => { setOpen(false) }}
    />
  )
}
