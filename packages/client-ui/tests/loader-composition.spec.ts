/**
 * M10 loader-composition 测试（④-K 提交对话框模块 ask §③；spec §6 第 11 行「装载冒烟」
 * 的进程内组合半——真宿主往返在 scripts/verify-load.mjs M11）。
 *
 * **模块表三方对账，断言无未加载行**（composition table = 提交链路的装载面）：
 *   1. host `REMOTE_METHODS`（src/index.ts 源面权威）——16 个 @Remote 方法；
 *   2. typert-generator 生成产物 `dsh-gitkit/remote` 的 `methods` 键——生成描述符；
 *   3. client `GIT_NAMESPACE_METHODS` + `createGitRpcClient()` 产物的函数键——client 面。
 * 三层键集必须两两相等：host 声明了而生成产物没有 = 生成器漏行；生成产物有而 client
 * 面没有 = client 落后（调用在方法缺席处 TypeError）；多出的行 = 幽灵面。
 *
 * 另断言提交链路 UI 桩已全部接线（无未加载桩行）：装配面不再有 ④-K 之前的
 * openCommitDialog no-op 占位，两个拉起方（header 菜单 / 变更面板底部按钮）引用
 * GitCommitDialog，快捷键 aria-keyshortcuts 四组锚在位（ask §②）。
 *
 * 位置注记：放在 client-ui/tests（包编译面解析 `dsh-gitkit*` workspace link 与
 * dsh-client-* 类型面；根 tsconfig 无 paths 表，locales.ts 的 declare module 增补也
 * 只在包程序内合法——包级组合测试是对账层的自然归属）。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import gitRemote from 'dsh-gitkit/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { GIT_NAMESPACE_METHODS, createGitRpcClient } from '../src/client/remote/mount.ts'
import { headerMenuItems, headerViewModel } from '../src/client/ui-model.ts'
import type { GitStatusSourceState } from '../src/client/store/git-status-source.ts'
import type { GitStatusSnapshot } from 'dsh-gitkit/types'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const clientSrc = (rel: string): string => path.join(repoRoot, 'packages', 'client-ui', 'src', 'client', rel)

async function readText(abs: string): Promise<string> {
  return readFile(abs, 'utf8')
}

/** host src/index.ts 的 REMOTE_METHODS 字面量解析（源面权威——不依赖构建产物）。 */
async function remoteMethodsOfSource(): Promise<string[]> {
  const source = await readText(path.join(repoRoot, 'packages', 'host', 'src', 'index.ts'))
  const match = source.match(/export const REMOTE_METHODS = \[([^\]]+)\] as const/)
  expect(match, 'host src/index.ts must declare REMOTE_METHODS as a const array').not.toBeNull()
  return (match![1] ?? '').split(',').map((item) => item.trim().replaceAll("'", '')).filter((item) => item.length > 0)
}

describe('M10 模块表三方对账（host REMOTE_METHODS ⇄ 生成描述符 ⇄ client 面）', () => {
  it('生成产物 methods 键 = host REMOTE_METHODS（无未生成的行）', async () => {
    const declared = await remoteMethodsOfSource()
    const generated = Object.keys(gitRemote.methods).map((key) => key.replace(/^git\//, '')).sort()
    expect(declared.sort()).toEqual(generated)
    expect(declared.length).toBeGreaterThan(0)
  })

  it('client GIT_NAMESPACE_METHODS = host REMOTE_METHODS（无缺面的行）', async () => {
    const declared = (await remoteMethodsOfSource()).sort()
    expect([...GIT_NAMESPACE_METHODS].sort()).toEqual(declared)
  })

  it('createGitRpcClient 产物的函数键 = GIT_NAMESPACE_METHODS（无幽灵面行）', () => {
    const ready = Promise.resolve()
    const git = Object.fromEntries(GIT_NAMESPACE_METHODS.map((name) => [name, async () => ({ ok: true, value: {} })]))
    const remote = { $mount: async () => async () => {}, git } as unknown as TypertClientRemote
    const rpc = createGitRpcClient({ remote }, ready)
    const produced = Object.keys(rpc)
      .filter((key) => typeof (rpc as unknown as Record<string, unknown>)[key] === 'function')
      .sort()
    expect(produced).toEqual([...GIT_NAMESPACE_METHODS].sort())
  })

  it('生成描述符的 package 字段 = dsh-gitkit（装载身份；spec 面是运行期形状，类型面只有 methods）', () => {
    const spec = (gitRemote as unknown as { spec: { package: string; methods: Record<string, unknown> } }).spec
    expect(spec.package).toBe('dsh-gitkit')
    expect(Object.keys(spec.methods).every((key) => key.startsWith('git/'))).toBe(true)
  })
})

describe('M10 提交链路 UI 桩接线（无未加载桩行，ask ①/②）', () => {
  it('装配面：createCommitDialogFace 已接线，openCommitDialog no-op 占位已移除', async () => {
    const assembly = await readText(clientSrc('index.ts'))
    expect(assembly).toContain('createCommitDialogFace')
    expect(assembly).toContain('commitDialog: commitDialogFace')
    expect(assembly).not.toContain('占位：GitCommitDialog')
    expect(assembly).not.toContain('openCommitDialog')
  })

  it('两个拉起方均引用 GitCommitDialog（header 菜单 / 变更面板底部按钮）', async () => {
    for (const component of ['components/GitHeaderButton.tsx', 'components/GitChangesTab.tsx']) {
      const source = await readText(clientSrc(component))
      expect(source, `${component} must render GitCommitDialog`).toContain('GitCommitDialog')
      expect(source, `${component} must hold the dialog open-intent state`).toContain('commitIntent')
    }
    const changesTab = await readText(clientSrc('components/GitChangesTab.tsx'))
    // 底部提交按钮不再恒禁用（disabled 改由仓库可用性驱动——④-K 之前的恒禁用占位已移除）。
    expect(changesTab).toContain('disabled={!view.available}')
    expect(changesTab).not.toContain('data-git-changes-commit=\'\'\n          disabled\n')
  })

  it('快捷键 aria-keyshortcuts 四组锚在位（对话框 Ctrl/Cmd+Enter+Esc / 列表 Space Enter Delete / 图 ↑↓+Enter）', async () => {
    const dialog = await readText(clientSrc('components/GitCommitDialog.tsx'))
    expect(dialog).toContain("'Control+Enter Meta+Enter'")
    expect(dialog).toContain("aria-keyshortcuts='Escape'")
    expect(dialog).toContain('data-git-commit-dialog=')
    expect(dialog).toContain('createPortal')
    const card = await readText(clientSrc('components/ChangeCard.tsx'))
    expect(card).toContain("'Space Enter Delete'")
    expect(card).toContain("'Space Enter'")
    const graph = await readText(clientSrc('components/git-graph-tab.tsx'))
    expect(graph).toContain("'ArrowDown ArrowUp'")
    expect(graph).toContain("aria-keyshortcuts='Enter'")
  })

  it('菜单桩行已加载：仓库可用时 提交…/提交并推送… 可点、同步仍为占位', () => {
    const state: GitStatusSourceState = {
      repo: { available: true, root: 'D:/repo', checking: false },
      status: {
        repoRoot: 'D:/repo',
        generatedAt: '2026-11-01T00:00:00.000Z',
        branch: { name: 'main', oid: 'a'.repeat(40), abbrevOid: 'aaaaaaa', upstream: null, ahead: null, behind: null, detached: false, unborn: false },
        staged: [], unstaged: [], untracked: [], conflicted: [], clean: true,
      } satisfies GitStatusSnapshot,
      statusError: null,
      revision: 1,
      streaming: true,
    }
    const items = headerMenuItems(headerViewModel(state))
    expect(Object.fromEntries(items.map((item) => [item.id, { enabled: item.enabled, placeholder: item.placeholder }])))
      .toEqual({
        'open-changes': { enabled: true, placeholder: false },
        'open-graph': { enabled: true, placeholder: false },
        'commit': { enabled: true, placeholder: false },
        'commit-push': { enabled: true, placeholder: false },
        'sync': { enabled: false, placeholder: true },
      })
  })
})
