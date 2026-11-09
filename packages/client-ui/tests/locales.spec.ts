/**
 * locale 词典测试（spec §6 stores.spec 的「zh/en 键集一致（§4）」切片 + M14 判据的
 * 测试面镜像；仓库脚本 check:locale 持同一判据并加 JSX 无裸字符串 grep）。
 * 键集权威 = zh 词典（map §3.5）。
 */

import { describe, expect, it } from 'vitest'
import { NS, gitEn, gitZh } from '../src/client/locales.ts'

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string))
}

describe('locale 词典（NS=git；zh 权威）', () => {
  it('NS = git 且双语词典非空', () => {
    expect(NS).toBe('git')
    expect(Object.keys(gitZh).length).toBeGreaterThan(0)
    expect(Object.keys(gitEn).length).toBeGreaterThan(0)
  })

  it('en 与 zh 键集合相等（双向差集为空）', () => {
    const zhKeys = new Set(Object.keys(gitZh))
    const enKeys = new Set(Object.keys(gitEn))
    const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
    const extraInEn = [...enKeys].filter((key) => !zhKeys.has(key))
    expect(missingInEn, `en 缺键: ${missingInEn.join(', ')}`).toEqual([])
    expect(extraInEn, `en 多键: ${extraInEn.join(', ')}`).toEqual([])
  })

  it('每键 en 与 zh 的 {name} 插位集合一致', () => {
    const zhDict = gitZh as Record<string, string>
    const enDict = gitEn as Record<string, string>
    for (const key of Object.keys(gitZh)) {
      const zh = placeholders(zhDict[key] ?? '')
      const en = placeholders(enDict[key] ?? '')
      expect([...en].filter((name) => !zh.has(name)), `${key}: en 多出插位`).toEqual([])
      expect([...zh].filter((name) => !en.has(name)), `${key}: en 缺插位`).toEqual([])
    }
  })

  it('首批键组到齐（header/errors/confirm/problems/shortcut + menu/tab）', () => {
    const keys = new Set(Object.keys(gitZh))
    for (const prefix of ['header.', 'menu.', 'problems.', 'shortcut.', 'tab.', 'confirm.', 'error.', 'common.']) {
      expect([...keys].some((key) => key.startsWith(prefix)), `缺 ${prefix} 组`).toBe(true)
    }
    // spec §4 error 组的种子键（域码逐键 + common 动作）。
    for (const key of [
      'error.no-repository', 'error.identity-missing', 'error.nothing-staged', 'error.empty-message',
      'error.no-upstream', 'error.no-remote', 'error.diverged', 'error.push-rejected', 'error.auth-failed',
      'error.pull-diverged', 'error.timeout', 'error.git-error', 'error.llm-route-unresolved', 'error.llm-failed',
      'common.retry', 'common.details', 'common.close',
    ]) {
      expect(keys.has(key), `缺 ${key}`).toBe(true)
    }
    // V2 批次一管理面新码的 error.* 行（plan §3.4）+ 管理面对话框/菜单键组到齐。
    for (const key of [
      'error.branch-not-found', 'error.branch-not-merged', 'error.branch-exists',
      'error.tag-exists', 'error.tag-not-found', 'error.worktree-failed',
      'menu.push', 'menu.pull', 'menu.fetch', 'menu.branches', 'menu.branchCreate',
      'menu.tagCreate', 'menu.worktree', 'menu.branchDelete',
    ]) {
      expect(keys.has(key), `缺 ${key}`).toBe(true)
    }
    // V2 批次二历史面（plan §4.4/§4.6）：4 新码 error.* 行 + abort 动作 + 搜索/WIP/
    // 对比/path 模式/blame/时间旅行键组到齐。
    for (const key of [
      'error.blame-oversized', 'error.merge-conflict', 'error.unknown-revision',
      'error.operation-in-progress', 'error.action.abort',
      'menu.branchCompare', 'menu.branchReset', 'menu.commitCherryPick', 'menu.commitRevert',
      'graph.search.placeholder', 'graph.search.authorPlaceholder', 'graph.search.authorHint',
      'graph.search.chipQuery', 'graph.search.chipAuthor', 'graph.search.clear', 'graph.search.emptyResult',
      'graph.wip.label', 'graph.wip.counts',
      'graph.compare.title', 'graph.compare.ahead', 'graph.compare.behind', 'graph.compare.mergeBase',
      'graph.compare.empty', 'graph.compare.pending', 'graph.compare.close',
      'graph.path.chip', 'graph.path.exit',
      'changes.blameMode', 'changes.diffMode', 'changes.fileHistory',
      'blame.loading', 'blame.empty', 'blame.chunkHint', 'blame.oversizedFallback',
      'blame.time.now', 'blame.time.minutes', 'blame.time.hours', 'blame.time.days',
      'timeTravel.cherryPick.title', 'timeTravel.cherryPick.message',
      'timeTravel.revert.title', 'timeTravel.revert.message',
      'timeTravel.reset.title', 'timeTravel.reset.kindLabel', 'timeTravel.reset.soft',
      'timeTravel.reset.mixed', 'timeTravel.reset.hard', 'timeTravel.reset.hardMessage',
    ]) {
      expect(keys.has(key), `缺 ${key}`).toBe(true)
    }
    // V2 批次三提交链路与护栏（plan §5.4/§5.6）：3 新码 error.* 行 + hunk/行级勾选
    // aria + CRLF 提示条 + stash 面板 + 提交对话框三块扩展键组到齐。
    for (const key of [
      'error.stage-patch-failed', 'error.stash-not-found', 'error.commit-blocked',
      'changes.hunkCheckAria', 'changes.lineCheckAria',
      'changes.crlf.title', 'changes.crlf.summary', 'changes.crlf.unset', 'changes.crlf.files',
      'stash.chip', 'stash.chipCount', 'stash.panelTitle', 'stash.loading', 'stash.empty',
      'stash.pushAll', 'stash.pushAllIncludeUntracked', 'stash.untrackedHint',
      'stash.pop', 'stash.drop', 'stash.popConflict', 'stash.drop.title', 'stash.drop.message',
      'commit.trailers.label', 'commit.trailers.addCoauthored', 'commit.trailers.addGenerated',
      'commit.trailers.invalid',
      'commit.guard.title', 'commit.guard.scanning', 'commit.guard.clean', 'commit.guard.blocked',
      'commit.guard.secretHint', 'commit.guard.override',
      'commit.guard.kind.secret', 'commit.guard.kind.env-file', 'commit.guard.kind.large-file',
      'commit.guard.kind.build-artifact', 'commit.guard.kind.eol-mixed',
      'commit.process.title', 'commit.process.stdout', 'commit.process.stderr',
      'commit.process.timedOut', 'commit.process.duration', 'commit.process.truncated',
    ]) {
      expect(keys.has(key), `缺 ${key}`).toBe(true)
    }
    // V2 批次四体验集成（plan §6.4/§6.6）：3 新码 error.* 行 + [8] 初始化空态引导
    // 卡片与菜单行 + [46] PR 对话框键组 + [69] 关联展示 + [61] 子模块详情面板 +
    // 快捷键页脚（[51] spike 命中——真实键位提示）到齐。
    for (const key of [
      'error.init-failed', 'error.pr-tool-missing', 'error.pr-create-failed',
      'menu.initRepo', 'menu.prCreate',
      'init.card.title', 'init.card.body', 'init.card.action', 'init.card.running',
      'pr.title', 'pr.titleLabel', 'pr.bodyLabel', 'pr.baseLabel', 'pr.baseDefault',
      'pr.generate', 'pr.generating', 'pr.draft', 'pr.create', 'pr.creating',
      'pr.createConfirmTitle', 'pr.createConfirmMessage',
      'pr.aiOverwriteTitle', 'pr.aiOverwriteMessage',
      'pr.success', 'pr.linkLabel', 'pr.link.badge',
      'submodule.details', 'submodule.loading', 'submodule.empty',
      'submodule.state.clean', 'submodule.state.dirty', 'submodule.state.uninitialized',
      'submodule.state.mismatch', 'submodule.state.unknown',
      'submodule.recordedOid', 'submodule.currentOid', 'submodule.mismatchHint',
      'shortcut.hint', 'shortcut.noSession', 'push.done',
    ]) {
      expect(keys.has(key), `缺 ${key}`).toBe(true)
    }
  })

  it('V2 批次一清理：死键不复存在（P3-4/5 双删 + sync 占位键随转真移除）', () => {
    const keys = new Set(Object.keys(gitZh))
    for (const key of ['graph.head', 'changes.oversized', 'menu.sync', 'menu.placeholderHint']) {
      expect(keys.has(key), `死键 ${key} 应已删除`).toBe(false)
    }
  })

  it('词典值均为非空字符串（无占位对象/空文案）', () => {
    const enDict = gitEn as Record<string, string>
    for (const [key, value] of Object.entries(gitZh)) {
      expect(typeof value, `${key}: 非字符串`).toBe('string')
      expect(value.length, `${key}: 空文案`).toBeGreaterThan(0)
      expect(typeof enDict[key], `${key}: en 非字符串`).toBe('string')
    }
  })
})
