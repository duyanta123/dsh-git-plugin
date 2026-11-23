import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 单包合并后退役的包目录（docs/single-package-merge.workflow.yaml）。 */
const RETIRED_PACKAGE_DIRS = ['packages/client-ui', 'git-bundle']

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
  it('单包身份：只有 dsh-gitkit 一个发布包；退役的 client-ui / git-bundle 目录不得回潮', async () => {
    // 决议（docs/single-package-merge.workflow.yaml）：host 与 client 两半同属一个 npm 包，
    // 包名沿用 dsh-gitkit（已发布名），client 半经 exports["./client"] + dsh.client 编入。
    const host = await readJson('packages/host/package.json')
    expect(host['name']).toBe('dsh-gitkit')
    const ws = await readText('pnpm-workspace.yaml')
    expect(ws).toContain('packages/*')
    for (const dir of RETIRED_PACKAGE_DIRS) {
      expect(existsSync(path.join(repoRoot, dir)), `${dir} 已退役，不得重新出现`).toBe(false)
    }
    // 锁文件 importer 面 = 仓库内全部 workspace 成员（第三个是 vendored 的 typert-protocol）。
    const lock = await readText('pnpm-lock.yaml')
    const importers = lock.split(/\r?\n/u).filter((line) => /^ {2}packages\/[^:]+:\s*$/u.test(line))
    expect(importers.map((line) => line.trim())).toEqual(['packages/host:', 'packages/typert-protocol:'])
    expect(lock).not.toMatch(/packages\/client-ui|git-bundle/u)
  })

  it('host 面 exports：./types 与 typert 产物双导出（generator 契约形状，workspace.ts validateExport）', async () => {
    const host = await readJson('packages/host/package.json')
    const exportsMap = host['exports'] as Record<string, unknown>
    expect(host['main']).toBe('./lib/index.js')
    expect(exportsMap['./types']).toBeDefined()
    // remote 地基阶段（④-A）：./typert = typert.loader 自动注册的 host 面 strict 描述符；
    // ./remote = client 半 codec 贡献。形状由 generator validateExport 强制（恒等比对）。
    expect(exportsMap['./typert']).toEqual({ types: './lib/typert.host.d.ts', default: './lib/typert.host.js' })
    expect(exportsMap['./remote']).toEqual({ types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' })
    const dsh = host['dsh'] as Record<string, unknown>
    expect(dsh['bundle']).toEqual({ patch: './cordis.patch.yml' })
    // files 必须显式封闭覆盖四个产物（validateExport 的 files.includes 检查）。
    const files = host['files'] as string[]
    for (const artifact of [
      'lib/typert.host.js',
      'lib/typert.host.d.ts',
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
      'lib/typert.remote-client.d.ts.map',
    ]) {
      expect(files).toContain(artifact)
    }
  })

  it('client 面（并入同包）：声明了 dsh.client 就必须有 ./client 导出；platform=web；inject 不含自身', async () => {
    const host = await readJson('packages/host/package.json')
    const dsh = host['dsh'] as Record<string, unknown>
    const dshClient = dsh['client'] as Record<string, unknown>
    const exportsMap = host['exports'] as Record<string, unknown>
    expect(dshClient['platform']).toBe('web')
    expect(exportsMap['./client']).toEqual({ types: './lib/client/index.d.ts', default: './lib/client.js' })
    const inject = dshClient['inject'] as string[]
    // 同包后自身条目无语义（client 半本就在 dsh-gitkit 内），保留会形成 boot 图自依赖边。
    expect(inject).not.toContain('dsh-gitkit')
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-slots')
    // D8：包名带 -right（spec 转引 host-capability-map.md:451）
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
    expect(inject.every((name) => name.startsWith('@deepseek-ai/'))).toBe(true)
    const files = host['files'] as string[]
    for (const artifact of ['lib/client.js', 'lib/client/**/*.d.ts']) {
      expect(files, `files 缺 client 面产物 ${artifact}`).toContain(artifact)
    }
  })

  it('唯一一份 cordis.patch.yml 的 insert 行 id/name 与包身份一致（reconcile 依赖，runbook §3.A/§3.D）', async () => {
    const patch = await readText('packages/host/cordis.patch.yml')
    expect(patch).toContain('- insert:')
    expect(patch).toContain('id: dsh-plugin-git')
    expect(patch).toContain("name: 'dsh-gitkit'")
    // 单包 = 单条 host 入口行；Web 面由 dsh.client 编入 boot，不再有独立 client 行。
    expect(patch.match(/^\s*-\s*id:/gmu)).toHaveLength(1)
    expect(patch).not.toMatch(/dsh-plugin-client-ui-git|dsh-gitkit-ui/u)
    expect(existsSync(path.join(repoRoot, 'git-bundle/cordis.patch.yml'))).toBe(false)
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

  it('清单与锁文件不得出现机器绝对路径的依赖（干净 checkout 可解析）', async () => {
    // 2026-11-01 CI 根因守门：初始快照曾提交 link:D:/DeepSeekHarness/... 本机路径——
    // pnpm 对悬空 link 不报错，远端 typecheck 才全线 TS2307。
    const manifests = [
      'package.json',
      'packages/host/package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ]
    for (const manifest of manifests) {
      const text = await readText(manifest)
      expect(text, `${manifest} 含机器绝对路径的 link:/file: 依赖`).not.toMatch(
        /(?:link|file):(?:[A-Za-z]:[\\/]|[\\/])/,
      )
    }
  })
})
