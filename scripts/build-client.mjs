/**
 * dsh-gitkit — client bundle 构建（闭包工厂产物）。单包合并后 client 半与 host 同包：
 * 入口 packages/host/src/client/index.ts，产物 packages/host/lib/client.js，
 * 经 exports["./client"] + dsh.client 交付；client 对 `dsh-gitkit/remote`、
 * `dsh-gitkit/types` 的引用是同包 self-reference（rolldown 按本包 exports 解析并内联）。
 *
 * 产物协议（实读 dsh 树两份样板）：
 *   - `packages/extensions/ui-cordis/lib/client.js`（tsdown 预设产物头部/尾部形状）；
 *   - `apps/web/tests/fixtures/plugins/fixture-live-client/client.js`（手写同协议）：
 *     `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ...; return 模块面 } })`，
 *     external（react 等基线模块，map §1.3）经注入的 require 解析。
 *
 * 树外不能 import dsh 的 tsdown.client.ts 预设（map §1.3 引 AGENTS.md@687f282e86:77），
 * 本脚本用 rolldown（cjs 格式 + external）产模块体后按上述协议包壳 —— 形状与
 * ui-cordis 产物头部逐字同构（var module = {exports:{}}; var exports = module.exports;
 * ...; return module.exports）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const pkgDir = join(repoRoot, 'packages', 'host')
// rolldown / lightningcss 是本包的 devDependencies；从包目录锚定解析（pnpm 严格隔离：
// 只有声明方包的 node_modules 有直连）。
const { rolldown } = createRequire(join(pkgDir, 'package.json'))('rolldown')
const { transform } = createRequire(join(pkgDir, 'package.json'))('lightningcss')
const input = join(pkgDir, 'src', 'client', 'index.ts')
const outFile = join(pkgDir, 'lib', 'client.js')
// client bundle 的注册 id = 包名（dsh client-modules manifest.ts：entry id 即包名，
// bundle 以该 id 经 window.__ModuleLoader__.load 注册——宿主 boot 图按 id 找 factory）。
// 单包合并前为 dsh-gitkit-ui；与 host 包同名后两半同属一个 npm 包。
const PACKAGE_ID = 'dsh-gitkit'
const HOST_ENTRY_ID = 'dsh-plugin-git'
// 已退役的双包形态：目录、bundle id、host insert id 任何一处残留都意味着迁移不完整。
const RETIRED_PACKAGE_DIRS = ['packages/client-ui', 'git-bundle']
const RETIRED_IDENTITY_RE = /dsh-gitkit-ui|dsh-gitkit-bundle|dsh-plugin-client-ui-git/u

/** dsh 基线 externals（packages/client/web/src/platform.ts:8-15）：经注入 require 解析，不打进 bundle。 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

// ── CSS 编译管线（审查报告 §2.2 P2）────────────────────────────────────────
// dsh client-modules 协议只服务单文件 client.js（无 .css 旁文件路由），宿主主 CSS
// 对 dsh-git 类名零规则——bundle 必须自带样式。官方 tsdown client 预设的范式是把
// CSS 编译后内联进 JS、factory 执行时注入 <style>（dsh 树 packages/client/
// tsdown.client.ts:856-881 插件体），本管线按同款形状实现：
//   `.css` / `.module.css` 导入 → lightningcss 编译（module 支路 cssModules pattern
//   '[hash]_[local]' + minify，同 tsdown.client.ts:874-875；global 支路仅 minify，
//   同款 dsh-css-global-inline——cssModules 会改写全局类名，全局支路不得开启）→
//   styleInjectionModule 形状的 JS 模块（逐字复刻 tsdown.client.ts:58-77：typeof
//   document 守卫 + querySelector 防重复 + data-plugin + data-plugin-css +
//   head.appendChild）。虚拟 id（\0dsh-git-css: 前缀 + .js 后缀）抢在 rolldown 内置
//   CSS 管线之前虚拟化——后缀不能是 .css（会落进内置管线），.js 让虚拟模块按 JS 编译。
const CSS_VIRTUAL_PREFIX = '\0dsh-git-css:'
const CSS_VIRTUAL_SUFFIX = '.js'

/**
 * Emit one plugin-owned style injector and an optional CSS Modules export.
 * 形状逐字对照 tsdown.client.ts:58-77；css 表达式内联了 stylesheetSource 的零引用
 * 形态 JSON.stringify(css)（本管线不携带 assets url() 重写，git.css 无 url()）。
 */
function styleInjectionModule(id, fileId, css, classMap) {
  const source = [
    `const css = ${css};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

const cssInlinePlugin = {
  name: 'dsh-git-css-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.css')) return null
    const abs = isAbsolute(source)
      ? source
      : importer !== undefined ? resolvePath(dirname(importer), source) : resolvePath(source)
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    // 官方同款：把物理样式表登记进 watch 图（本脚本为一次性构建，API 形状保真）。
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const isModuleCss = fileId.endsWith('.module.css')
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      ...(isModuleCss ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
      minify: true,
    })
    const classMap = {}
    if (isModuleCss) {
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
    }
    return styleInjectionModule(PACKAGE_ID, fileId, JSON.stringify(code.toString()), Object.keys(classMap).length > 0 ? classMap : undefined)
  },
}

// `dsh-gitkit/remote` 不在 EXTERNALS：rolldown 按本包 exports 把生成产物
// lib/typert.remote-client.js 内联进 bundle（合并前经 client-ui/node_modules/dsh-gitkit
// 解析到同一文件，行为不变）。因此 build:client 依赖 build:host 先行——缺产物即 fail-closed，
// 不得静默打进陈旧或缺失的 codec。
const remoteArtifact = join(pkgDir, 'lib', 'typert.remote-client.js')
if (!existsSync(remoteArtifact)) {
  throw new Error(`missing packages/host/lib/typert.remote-client.js — run build:host (typert generation) before build:client`)
}
if ((await stat(remoteArtifact)).mtimeMs < (await stat(join(pkgDir, 'src', 'index.ts'))).mtimeMs) {
  throw new Error('stale packages/host/lib/typert.remote-client.js — older than packages/host/src/index.ts; rerun build:host')
}

const bundle = await rolldown({
  input,
  external: id => EXTERNALS.includes(id),
  plugins: [cssInlinePlugin],
})
// 单包 lib/ 与 host 共目录：构建前清掉上一次的 client 声明树（随后的
// tsconfig.build.client.json 重建），防止已删除模块的陈旧 .d.ts 留在 lib/client/ 进入
// npm tarball。只清 client 半的两个产物位；host 的 JS/声明/typert 产物归 build:host 管。
await rm(join(pkgDir, 'lib', 'client'), { recursive: true, force: true })
const { output } = await bundle.generate({
  format: 'cjs',
  exports: 'named',
})
await bundle.close()

const body = output[0]?.code
if (typeof body !== 'string' || body.length === 0) {
  throw new Error(`rolldown produced no code for ${input}`)
}

const banner = `/** Generated by scripts/build-client.mjs from packages/host/src/client/index.ts — do not edit. */\n`
const wrapped = `${banner}window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\t${body.replaceAll('\n', '\n\t\t')}
\t\treturn module.exports;
\t}
});
`

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, wrapped, 'utf8')
// sanity: the closure must reference its externals through the injected require
if (!/\brequire\(\s*["']react["']\s*\)/.test(body)) {
  throw new Error('client bundle body does not require("react") — externals misconfigured')
}
// sanity: the style pipeline must survive into the artifact (审查报告 §2.2 ④ P2 回归
// 闸——缺 data-plugin-css 注入器的 bundle 意味着整幅 UI 退回裸 DOM)
if (!body.includes('data-plugin-css')) {
  throw new Error('client bundle body lacks the data-plugin-css style injector — CSS inline pipeline missing')
}
// 单包身份：注册 id 必须是包名，且 bundle 内不得残留旧 client 包身份（旧 id 的 bundle
// 在 boot 图里找不到 entry；旧包名字面量意味着源码树迁移不完整）。
if (!wrapped.includes(`id: ${JSON.stringify(PACKAGE_ID)}`)) {
  throw new Error(`client bundle must register under the package name ${PACKAGE_ID}`)
}
if (RETIRED_IDENTITY_RE.test(body)) {
  throw new Error(`client bundle body contains a retired package identity (${RETIRED_IDENTITY_RE.source})`)
}
console.log(`build-client: wrote ${outFile} (${wrapped.length} bytes)`)

// ── 单包发布面 fail-closed 检查 ──────────────────────────────────────────────
// 一个 npm 包（dsh-gitkit）同时承担 Node host 面与 Web client 面；发布内容与宣称版本
// 在 push CI 的构建门禁咬合（『改了内容不升版』在这里被拒）。原双包形态的 git-bundle
// 薄包与四 manifest 同版检查随之退役——本地安装直接 file:<repo>/packages/host。
const [pkgRaw, patchRaw, rootRaw, readme] = await Promise.all([
  readFile(join(pkgDir, 'package.json'), 'utf8'),
  readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8'),
  readFile(join(repoRoot, 'package.json'), 'utf8'),
  readFile(join(repoRoot, 'README.md'), 'utf8'),
])
const manifest = JSON.parse(pkgRaw)
const rootManifest = JSON.parse(rootRaw)
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message)
}

// ① 退役目录不得回潮（否则 workspace 重新出现第二个发布包 / 本地安装入口分叉）。
for (const dir of RETIRED_PACKAGE_DIRS) {
  requireThat(!existsSync(join(repoRoot, dir)), `retired package directory is present again: ${dir}（单包合并后不得保留）`)
}

// ② 身份与版本：包名 = bundle id；包版本 = 仓库根版本；根 description 与 README 锚同一 v<version>。
requireThat(manifest.name === PACKAGE_ID, `package name must be ${PACKAGE_ID}, got ${manifest.name}`)
requireThat(manifest.version === rootManifest.version,
  `manifest version drift: root=${rootManifest.version} package=${manifest.version}（两份 manifest 必须同升）`)
requireThat(String(rootManifest.description ?? '').includes(`v${rootManifest.version}`),
  `root package.json description must mention v${rootManifest.version}`)
requireThat(readme.includes(`v${rootManifest.version}`), `README.md must mention v${rootManifest.version}`)
requireThat(!RETIRED_IDENTITY_RE.test(`${pkgRaw}\n${patchRaw}\n${rootRaw}`),
  'package.json / cordis.patch.yml / root package.json still mention a retired package identity')

// ③ Node host 面：main 与 typert 双导出形状（generator validateExport 恒等比对面）。
requireThat(manifest.main === './lib/index.js', `main must be ./lib/index.js, got ${manifest.main}`)
requireThat(manifest.exports?.['./typert']?.types === './lib/typert.host.d.ts'
  && manifest.exports['./typert']?.default === './lib/typert.host.js', 'exports["./typert"] shape drifted')
requireThat(manifest.exports?.['./remote']?.types === './lib/typert.remote-client.d.ts'
  && manifest.exports['./remote']?.default === './lib/typert.remote-client.js', 'exports["./remote"] shape drifted')

// ④ Web client 面：exports["./client"]（声明 + 运行时）+ dsh.client（platform / inject）。
requireThat(manifest.exports?.['./client']?.types === './lib/client/index.d.ts'
  && manifest.exports['./client']?.default === './lib/client.js', 'exports["./client"] shape drifted')
const dsh = manifest.dsh ?? {}
requireThat(dsh.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
requireThat(dsh.client?.platform === 'web', 'dsh.client.platform must be web')
const inject = dsh.client?.inject
requireThat(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject must be a non-empty array')
// 同包后自身条目无语义（client 半本就在 dsh-gitkit 包内）；保留会让 boot 图出现自依赖边。
requireThat(!inject.includes(PACKAGE_ID), `dsh.client.inject must not list the package itself (${PACKAGE_ID})`)
requireThat(inject.includes('@deepseek-ai/dsh-client-ui-slots') && inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'),
  'dsh.client.inject lost its slot surface (ui-slots / ui-sidebar-right)')

// ⑤ 装载记录：只有一条 host insert；不得再有独立的 client Node 行（同包再插一行会
//    重复导入 host 入口；Web 面由 dsh.client 编入 boot）。
requireThat(patchRaw.includes(`id: ${HOST_ENTRY_ID}`) && patchRaw.includes(`name: '${PACKAGE_ID}'`),
  `cordis.patch.yml lacks the host insert row id: ${HOST_ENTRY_ID} / name: '${PACKAGE_ID}'`)
requireThat((patchRaw.match(/^\s*-?\s*id:/gmu) ?? []).length === 1,
  'cordis.patch.yml must contain exactly one insert row (single package = single host entry)')

// ⑥ 发布清单：两面产物逐项显式在 files 内（npm 以 files 收口 tarball）。
const files = Array.isArray(manifest.files) ? manifest.files : []
for (const file of [
  'lib/index.js', 'lib/types.js', 'lib/*.d.ts',
  'lib/typert.host.js', 'lib/typert.host.d.ts',
  'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts', 'lib/typert.remote-client.d.ts.map',
  'lib/client.js', 'lib/client/**/*.d.ts',
  'locale', 'cordis.patch.yml', 'README.md',
]) {
  requireThat(files.includes(file), `package files must include ${file}`)
}
for (const file of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) {
  requireThat(files.includes(file), `package files must include ${file}`)
  await readFile(join(pkgDir, file), 'utf8') // throws when the release trio is missing
}
// 本次构建刚写出的两个 client 产物必须在场（files 声明了而磁盘缺失 = tarball 缺文件）。
requireThat(existsSync(outFile), `client bundle missing after build: ${outFile}`)
console.log(`build-client: single-package release surface verified (${manifest.name}@${manifest.version} at ${relativePath(repoRoot, pkgDir).replaceAll('\\', '/')}; host + client faces, one insert row, release trio present)`)
