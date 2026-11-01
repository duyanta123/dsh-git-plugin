import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(repoRoot, rel), 'utf8')) as Record<string, unknown>
}

async function readText(rel: string): Promise<string> {
  return readFile(path.join(repoRoot, rel), 'utf8')
}

function flattenKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort()
}

describe('workspace skeleton（骨架完整性，防最小插件阶段倒退）', () => {
  it('双包名与 workspace 成员符合决议（spec §0.1 用户决议：dsh-gitkit + dsh-gitkit-ui）', async () => {
    const host = await readJson('packages/host/package.json')
    const client = await readJson('packages/client-ui/package.json')
    expect(host['name']).toBe('dsh-gitkit')
    expect(client['name']).toBe('dsh-gitkit-ui')
    const ws = await readText('pnpm-workspace.yaml')
    expect(ws).toContain('packages/*')
  })

  it('host 包 exports 暴露 ./types 与 typert 产物双导出（generator 契约形状，workspace.ts validateExport）', async () => {
    const host = await readJson('packages/host/package.json')
    const exportsMap = host['exports'] as Record<string, unknown>
    expect(exportsMap['./types']).toBeDefined()
    // remote 地基阶段（④-A）：./typert = typert.loader 自动注册的 host 面 strict 描述符；
    // ./remote = client 半 codec 贡献。形状由 generator validateExport 强制（恒等比对）。
    expect(exportsMap['./typert']).toEqual({ types: './lib/typert.host.d.ts', default: './lib/typert.host.js' })
    expect(exportsMap['./remote']).toEqual({ types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' })
    expect(host['dsh']).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    // files 必须显式封闭覆盖四个产物（validateExport 的 files.includes 检查）。
    const files = host['files'] as string[]
    for (const artifact of ['lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']) {
      expect(files).toContain(artifact)
    }
  })

  it('client 包：声明了 dsh.client 就必须有 ./client 导出；platform=web；inject 含 host 包', async () => {
    const client = await readJson('packages/client-ui/package.json')
    const dsh = client['dsh'] as Record<string, unknown>
    const dshClient = dsh['client'] as Record<string, unknown>
    const exportsMap = client['exports'] as Record<string, unknown>
    expect(dshClient['platform']).toBe('web')
    expect(exportsMap['./client']).toBeDefined()
    const inject = dshClient['inject'] as string[]
    expect(inject).toContain('dsh-gitkit')
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-slots')
    // D8：包名带 -right（spec 转引 host-capability-map.md:451）
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
  })

  it('两包 cordis.patch.yml 的 insert 行 id/name 与包身份一致（reconcile 依赖，runbook §3.A/§3.D）', async () => {
    const hostPatch = await readText('packages/host/cordis.patch.yml')
    expect(hostPatch).toContain('- insert:')
    expect(hostPatch).toContain('id: dsh-plugin-git')
    expect(hostPatch).toContain("name: 'dsh-gitkit'")
    const clientPatch = await readText('packages/client-ui/cordis.patch.yml')
    expect(clientPatch).toContain('- insert:')
    expect(clientPatch).toContain('id: dsh-plugin-client-ui-git')
    expect(clientPatch).toContain("name: 'dsh-gitkit-ui'")
  })

  it('locale 骨架：zh/en 键集一致（spec §④ 规则：新增键必须 zh/en 同步）', async () => {
    const zh = (await readJson('packages/host/locale/zh.json')) as Record<string, string>
    const en = (await readJson('packages/host/locale/en.json')) as Record<string, string>
    expect(flattenKeys(zh)).toEqual(flattenKeys(en))
    // spec §④ 键组覆盖抽查（header / menu / tab / changes / commit / graph / confirm / error / common）
    for (const key of [
      'header.branch',
      'header.badge',
      'menu.commitPush',
      'tab.changes.title',
      'tab.graph.title',
      'changes.conflicted',
      'commit.amendWarning',
      'graph.loadMore',
      'confirm.discard.message',
      'error.no-repository',
      'error.diverged',
      'common.retry',
    ]) {
      expect(zh[key], `zh 缺键 ${key}`).toBeTruthy()
      expect(en[key], `en 缺键 ${key}`).toBeTruthy()
    }
    // spec §④ 给出的三个样例值逐字对齐
    expect(zh['header.badge']).toBe('{count} 处变更')
    expect(en['header.badge']).toBe('{count} changes')
    expect(zh['confirm.discard.message']).toBe('将丢弃 {count} 个文件的工作区改动，且无法撤销。')
    expect(en['confirm.discard.message']).toBe(
      'Discard working-tree changes of {count} file(s)? This cannot be undone.',
    )
    expect(zh['error.diverged']).toBe('本地与远程已分叉（领先 {ahead} 落后 {behind}），请先拉取。')
    expect(en['error.diverged']).toBe(
      'Local and remote have diverged (ahead {ahead}, behind {behind}). Pull first.',
    )
  })

  it('host src 骨架只锚定身份常量（serviceKey=git 须过 isTypertRemoteSegment 字符集）', async () => {
    const src = await readText('packages/host/src/index.ts')
    expect(src).toContain("SERVICE_KEY = 'git'")
    expect('git').toMatch(/^[A-Za-z0-9_$.-]+$/)
  })
})
