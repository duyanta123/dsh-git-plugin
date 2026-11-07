/**
 * dsh-gitkit-ui — client bundle 构建（闭包工厂产物）。
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
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', 'packages', 'client-ui')
// rolldown 是 client-ui 包的 devDependency；从该包目录锚定解析。
const { rolldown } = createRequire(join(pkgDir, 'package.json'))('rolldown')
// lightningcss 同为 client-ui 的 devDependency（P2 样式管线）；同上从该包目录锚定解析
// （pnpm 严格隔离：两包都只在 client-ui/node_modules 有直连）。
const { transform } = createRequire(join(pkgDir, 'package.json'))('lightningcss')
const input = join(pkgDir, 'src', 'client', 'index.ts')
const outFile = join(pkgDir, 'lib', 'client.js')
const PACKAGE_ID = 'dsh-gitkit-ui'

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

const bundle = await rolldown({
  input,
  external: id => EXTERNALS.includes(id),
  plugins: [cssInlinePlugin],
})
const { output } = await bundle.generate({
  format: 'cjs',
  exports: 'named',
})
await bundle.close()

const body = output[0]?.code
if (typeof body !== 'string' || body.length === 0) {
  throw new Error(`rolldown produced no code for ${input}`)
}

const banner = `/** Generated by scripts/build-client.mjs from packages/client-ui/src/client/index.ts — do not edit. */\n`
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
console.log(`build-client: wrote ${outFile} (${wrapped.length} bytes)`)

// ── git-bundle 薄包一致性检查（② 全量构建的第三件产物：零代码发布薄包）──
// 无需编译；build 在此断言其清单/补丁/三件套与两包实况一致，防止漂移后
// verify-install 的单一 file: 安装路径静默失效。
const bundleDir = join(here, '..', 'git-bundle')
const [hostPkg, clientPkg, bundlePkg, bundlePatchRaw] = await Promise.all([
  readFile(join(here, '..', 'packages', 'host', 'package.json'), 'utf8'),
  readFile(join(here, '..', 'packages', 'client-ui', 'package.json'), 'utf8'),
  readFile(join(bundleDir, 'package.json'), 'utf8').catch(() => null),
  readFile(join(bundleDir, 'cordis.patch.yml'), 'utf8').catch(() => null),
])
const hostName = JSON.parse(hostPkg).name
const clientName = JSON.parse(clientPkg).name
if (bundlePkg === null || bundlePatchRaw === null) {
  throw new Error('git-bundle thin package missing: expected git-bundle/package.json + cordis.patch.yml at the repo root')
}
const bundleManifest = JSON.parse(bundlePkg)
if (bundleManifest.name !== 'dsh-gitkit-bundle') throw new Error(`git-bundle manifest name mismatch: ${bundleManifest.name}`)
// ── 四 manifest 一致性 + 宣传面同锚（审查报告 §2.4 第二层）──
// root/host/client/bundle version 全等；根 description 与 README 必须锚定同一版本号
// ——发布内容与宣称版本在 push CI 的构建门禁咬合，『改了内容不升版、dispatch 补发』
// 在这里被拒。根 package.json 读取在原 bundle-version 断言处已存在（复用其 parse，
// 零额外文件 IO）；hostPkg/clientPkg 在上方已读取；README 为新增读取。
const rootManifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
const hostVersion = JSON.parse(hostPkg).version
const clientVersion = JSON.parse(clientPkg).version
if (bundleManifest.version !== rootManifest.version) {
  throw new Error('git-bundle version drifted from the repo root version')
}
if (hostVersion !== rootManifest.version || clientVersion !== rootManifest.version) {
  throw new Error(`manifest version drift: root=${rootManifest.version} host=${hostVersion} client=${clientVersion} bundle=${bundleManifest.version}`)
}
if (!String(rootManifest.description ?? '').includes(`v${rootManifest.version}`)) {
  throw new Error(`root package.json description must mention v${rootManifest.version}`)
}
const readme = await readFile(join(here, '..', 'README.md'), 'utf8')
if (!readme.includes(`v${rootManifest.version}`)) {
  throw new Error(`README.md must mention v${rootManifest.version}`)
}
if (bundleManifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('git-bundle manifest lacks dsh.bundle.patch: ./cordis.patch.yml')
if (bundleManifest.dependencies?.['dsh-gitkit'] !== 'file:../packages/host'
  || bundleManifest.dependencies?.['dsh-gitkit-ui'] !== 'file:../packages/client-ui') {
  throw new Error(`git-bundle dependencies must be the two file: package specs, got ${JSON.stringify(bundleManifest.dependencies)}`)
}
for (const [id, name] of [['dsh-plugin-git', hostName], ['dsh-plugin-client-ui-git', clientName]]) {
  if (!bundlePatchRaw.includes(`id: ${id}`) || !bundlePatchRaw.includes(`name: '${name}'`)) {
    throw new Error(`git-bundle cordis.patch.yml lacks the insert row id: ${id} / name: '${name}'`)
  }
}
for (const file of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) {
  await readFile(join(bundleDir, file), 'utf8') // throws when the release trio is missing
}
console.log(`build-client: git-bundle thin package verified (${bundleManifest.name}@${bundleManifest.version}, two insert rows, release trio present)`)
