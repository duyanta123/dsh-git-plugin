/**
 * dsh-gitkit-ui — FileDiffView：单文件 diff 渲染（本模块 ask §④；
 * C2 变更审查 tab 与 C3 提交图 tab 共用）。
 *
 * 输入 = host `DiffFile`（patch 为 unified diff 文本）。渲染链：parsePatch →
 * renderedHunks（MAX_RENDERED_LINES 截断）→ hunkRows → markConflictRows（冲突标记
 * 行高亮锚）+ useCodeHighlighter(languageForPath(path)) 逐行 token 高亮（dsh 基线
 * 积木，ui-deliverables FileDiff 同款；未知/加载中语法回落纯文本）。
 *
 * 占位语义（[清单 59]）：binary / oversized（单文件超预算）/ patch:null（总预算
 * 耗尽或单文件失败）→ 文案占位；渲染截断 → diff.truncated 行；无 hunk（纯模式
 * 变更/零差异）→ diff.empty。加载/错误态由消费方（展开卡片）装配——本组件只在
 * 「有 DiffFile 可渲染或可判定占位」时使用。
 *
 * **V2 批次三（[10]，plan §5.6）**：可选 `selection` props 切入 hunk/行级勾选形态
 * （ChangesTab 双侧 diff 区专用；提交图 tab 不传 → 既有渲染零变化）。勾选形态 =
 * splitRows 并排行片（P3-1 复活点：行选择需要逐行行片——plan §10 P3-1「复活」；
 * v2 plan 收口定案 = 本批在 src 运行期消费 splitRows）+ hunk 头三态勾选框 +
 * 行级勾选框（del 在 old 侧、add 在 new 侧；context 行不可勾选——它们是 apply 的
 * 定位锚）。勾选立即经装配半（diff/patch-select.ts assembleSelectedPatch）组装
 * patch 调 stagePatch（plan §5.6「勾选变化 → 组装 → stagePatch」）；勾选形态不做
 * token 高亮（勾选框行片与高亮分词的行序对齐成本高于收益，如实取舍）。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { languageForPath, useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffFile } from 'dsh-gitkit/types'
import {
  MAX_RENDERED_LINES, hunkHeader, hunkRows, markConflictRows, parsePatch, renderedHunks, splitRows,
} from '../diff/patch-hunks.js'
import type { PatchHunk, SplitRow } from '../diff/patch-hunks.js'
import { hunkSelectionState, selectionAvailable } from '../diff/patch-select.js'
import type { NS } from '../locales.js'

/** hunk/行级勾选的组件面（勾选变化由装配半折算成 stagePatch 调用）。 */
export interface DiffSelectionProps {
  /** 当前勾选集（diff/patch-select.ts lineKeyOf 的产出键）。 */
  selected: ReadonlySet<string>
  /** 勾选/取消一行（装配半立即应用）。 */
  onToggleLine(key: string): void
  /** 勾选/取消整个 hunk（hunkLineKeys 全集切换）。 */
  onToggleHunk(hunkIndex: number): void
}

/** 每行 token 高亮：整 hunk 展示序行文本 join 后一次分词，按下标对齐回填。 */
function hunkHighlights(
  rows: readonly { text: string }[],
  highlighter: (code: string) => HighlightSpan[][] | undefined,
): HighlightSpan[][] | undefined {
  if (rows.length === 0) return undefined
  const highlighted = highlighter(rows.map((row) => row.text).join('\n'))
  if (highlighted === undefined) return undefined
  return rows.map((_, index) => highlighted[index] ?? [])
}

/** 一行 diff 的文本半区（无 token 高亮时整行纯文本）。 */
function DiffText({ text, spans }: { text: string; spans: readonly HighlightSpan[] | undefined }): ReactNode {
  return (
    <span className='dsh-git-diff__text' data-git-diff-code={spans === undefined ? undefined : ''}>
      {spans === undefined ? text : spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}
    </span>
  )
}

/**
 * 渲染一个文件的 unified diff（含占位与冲突标记高亮；selection 给定时切入 hunk/行级
 * 勾选形态）。
 * @param props - host DiffFile + 词典 t + 可选勾选面。
 * @returns diff 视图或其占位。
 */
export function FileDiffView({ file, t, selection }: {
  file: DiffFile
  selection?: DiffSelectionProps
} & PropsLocale<typeof NS>): ReactNode {
  if (file.binary) return <p className='dsh-git-diff__status' data-git-diff-status='binary'>{t('diff.binary')}</p>
  if (file.oversized) return <p className='dsh-git-diff__status' data-git-diff-status='oversized'>{t('diff.oversized')}</p>
  if (file.patch === null) {
    return <p className='dsh-git-diff__status' data-git-diff-status='load-failed'>{t('changes.loadFailed')}</p>
  }
  if (selection !== undefined && selectionAvailable(file)) {
    return <SelectableDiffView file={file} selection={selection} t={t} />
  }
  return <PatchDiffView file={file} t={t} />
}

/** 有 patch 文本可渲染的路径（hooks 位置——占位分支不得在其之前提前 return）。 */
function PatchDiffView({ file, t }: { file: DiffFile } & PropsLocale<typeof NS>): ReactNode {
  const hunks = useMemo(() => parsePatch(file.patch ?? ''), [file.patch])
  const { hunks: rendered, truncated } = useMemo(() => renderedHunks(hunks), [hunks])
  const highlighter = useCodeHighlighter(languageForPath(file.path))
  const markedRows = useMemo(
    () => rendered.map((hunk) => markConflictRows(hunkRows(hunk))),
    [rendered],
  )
  // token 高亮与 conflict 标注同源（展示序行文本）；highlighter 变化（语法载入完成）时重算。
  const highlightRows = useMemo(
    () => markedRows.map((rows) => hunkHighlights(rows, highlighter)),
    [markedRows, highlighter],
  )
  return (
    <div className='dsh-git-diff' data-git-diff='' data-git-diff-path={file.path}>
      {file.patchTruncated && <p className='dsh-git-diff__note' data-git-diff-truncated-source>{t('changes.truncated')}</p>}
      {truncated && (
        <p className='dsh-git-diff__note' data-git-diff-truncated>
          {t('diff.truncated', { count: String(MAX_RENDERED_LINES) })}
        </p>
      )}
      {rendered.length === 0 && <p className='dsh-git-diff__status' data-git-diff-status='empty'>{t('diff.empty')}</p>}
      {rendered.map((hunk, position) => {
        const marked = markedRows[position] ?? []
        const spans = highlightRows[position]
        return (
          <section key={position} className='dsh-git-diff__hunk' data-git-diff-hunk=''>
            <div className='dsh-git-diff__hunk-header' data-git-diff-hunk-header=''>{hunkHeader(hunk)}</div>
            {marked.map((row, index) => (
              <div
                key={index}
                className='dsh-git-diff__line'
                data-git-diff-line={row.kind}
                data-git-diff-conflict={row.conflict ?? undefined}
              >
                <span className='dsh-git-diff__no' data-git-diff-no='old'>{row.old ?? ''}</span>
                <span className='dsh-git-diff__no' data-git-diff-no='new'>{row.new ?? ''}</span>
                <span className='dsh-git-diff__sign' data-git-diff-sign=''>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
                <DiffText text={row.text} spans={spans?.[index]} />
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

/** 勾选形态的一侧半区（del 行挂 old 侧勾选框、add 行挂 new 侧勾选框；context 无勾选框）。 */
function SelectionHalf(props: {
  side: 'old' | 'new'
  row: SplitRow['left'] | SplitRow['right']
  selection: DiffSelectionProps
  t: PropsLocale<typeof NS>['t']
}): ReactNode {
  const { side, row, selection, t } = props
  if (row === undefined) {
    return <span className='dsh-git-diff__half' data-git-diff-half={side} data-git-diff-half-empty='' />
  }
  const lineKey = row.kind === 'del' ? `del:${row.no}` : row.kind === 'add' ? `add:${row.no}` : null
  return (
    <span className='dsh-git-diff__half' data-git-diff-half={side}>
      {lineKey !== null && (
        <input
          type='checkbox'
          className='dsh-git-diff__line-check'
          data-git-diff-line-check=''
          checked={selection.selected.has(lineKey)}
          aria-label={t('changes.lineCheckAria', { line: String(row.no) })}
          onChange={() => { selection.onToggleLine(lineKey) }}
        />
      )}
      <span className='dsh-git-diff__no' data-git-diff-no={side}>{row.no}</span>
      <span className='dsh-git-diff__sign' data-git-diff-sign=''>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
      <span className='dsh-git-diff__text'>{row.text}</span>
    </span>
  )
}

/** hunk/行级勾选形态（ChangesTab 双侧 diff 区专用）：splitRows 并排行片 + hunk 头三态勾选框。 */
function SelectableDiffView({ file, selection, t }: {
  file: DiffFile
  selection: DiffSelectionProps
} & PropsLocale<typeof NS>): ReactNode {
  const hunks = useMemo(() => parsePatch(file.patch ?? ''), [file.patch])
  return (
    <div className='dsh-git-diff' data-git-diff='' data-git-diff-path={file.path} data-git-diff-selectable=''>
      {hunks.length === 0 && (
        <p className='dsh-git-diff__status' data-git-diff-status='empty'>{t('diff.empty')}</p>
      )}
      {hunks.map((hunk: PatchHunk, position: number) => {
        const state = hunkSelectionState(hunk, selection.selected)
        const header = hunkHeader(hunk)
        const rows = splitRows(hunk)
        return (
          <section key={position} className='dsh-git-diff__hunk' data-git-diff-hunk=''>
            <div className='dsh-git-diff__hunk-header' data-git-diff-hunk-header=''>
              <input
                type='checkbox'
                className='dsh-git-diff__hunk-check'
                data-git-diff-hunk-check=''
                checked={state === 'all'}
                ref={(el) => { if (el !== null) el.indeterminate = state === 'partial' }}
                aria-label={t('changes.hunkCheckAria', { header })}
                onChange={() => { selection.onToggleHunk(position) }}
              />
              <span className='dsh-git-diff__hunk-head-text'>{header}</span>
            </div>
            {rows.map((row, index) => (
              <div key={index} className='dsh-git-diff__split' data-git-diff-split=''>
                <SelectionHalf side='old' row={row.left} selection={selection} t={t} />
                <SelectionHalf side='new' row={row.right} selection={selection} t={t} />
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
