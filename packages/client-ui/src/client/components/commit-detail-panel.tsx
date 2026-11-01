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
 * 视图模型收敛在 graph-view-model.ts。
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitDetailState } from '../store/git-graph-store.js'
import type { DetailRow, DetailViewModel } from '../graph-view-model.js'
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
  /** 文件点击（path patch 懒加载；同 path 再点收起由 tab 侧 openDetailPath 承担）。 */
  onFileClick(path: string): void
  /** 关闭面板（tab 侧 select(null)）。 */
  onClose(): void
}

/** 提交详情面板（提交图 tab 的选中态下半区）。 */
export function CommitDetailPanel(props: CommitDetailPanelProps): ReactNode {
  const { oid, state, view, t, onFileClick, onClose } = props
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
              <span
                key={`${ref}-${index}`}
                className={ref.head ? 'dsh-git-graph-detail__ref dsh-git-graph-detail__ref--head' : 'dsh-git-graph-detail__ref'}
                data-git-graph-detail-ref={ref.label}
              >
                {ref.label}
              </span>
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
      {state?.state === 'error' && state.error !== undefined && (
        <GitErrorNotice error={state.error} t={t} />
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
