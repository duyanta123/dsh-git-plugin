#!/usr/bin/env node
/**
 * check-locale.mjs — M14 仓库门禁：locale 词典健全性 + JSX 无裸字符串。
 *
 * 用法：`pnpm run check:locale`（root package.json scripts）。退出码 0 = 全部通过；
 * 1 = 发现违规（逐条打印 文件:行）。
 *
 * 检查项（本模块 ask §⑤）：
 *   1. **键集合相等**：gitZh 与 gitEn 逐键对齐（双向差集为空）——spec §4「新增键必须
 *      zh/en 同步」；键集权威 = zh 词典（map §3.5）。
 *   2. **占位符相等**：每键值的 `{name}` 插位集合 zh/en 一致（插值参数拼写漂移会让
 *      运行期插值丢参数）。
 *   3. **JSX 无裸字符串**（规则化 grep，非完整解析器）：扫描 packages/client-ui/src
 *      下 `.tsx` 的 JSX 文本子与用户可见属性字面量——文本节点里含字母且不是 `{expr}`
 *      的裸文案、`title=`/`placeholder=`/`aria-label=`/`alt=` 的字符串字面量都算违规
 *      （className、data-前缀、aria-枚举属性（haspopup 等）是结构锚不是用户文案；
 *      纯符号与空串豁免）。豁免口径：
 *      `data-*` 是测试锚不是用户文案；`aria-haspopup` 等枚举属性不在扫描清单里。
 *
 * 词典求值：locales.ts 保持零 import（文件头契约），本脚本以仓库 devDependency 的
 * typescript.transpileModule 平移成 CJS 后在受控沙箱里求值取 `gitZh`/`gitEn`——
 * 不走打包器，不进测试运行时。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = (() => fileURLToPath(new URL('.', import.meta.url)))()
const repo = resolveRepo(here)
const LOCALES_TS = join(repo, 'packages', 'client-ui', 'src', 'client', 'locales.ts')
const TSX_ROOT = join(repo, 'packages', 'client-ui', 'src')

const require = createRequire(import.meta.url)
const ts = require('typescript')

const problems = []

// ── 1+2. 词典求值与键/占位符对齐 ────────────────────────────────────────────
const source = readFileSync(LOCALES_TS, 'utf8')
const transpiled = ts.transpileModule(source, {
  fileName: 'locales.ts',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const sandboxModule = { exports: {} }
const sandboxRequire = (id) => {
  throw new Error(`check-locale: locales.ts must stay import-free (saw require(${JSON.stringify(id)}))`)
}
// 受控求值：locales.ts 的文件头契约承诺零 import/零副作用导出。
new Function('module', 'exports', 'require', transpiled)(sandboxModule, sandboxModule.exports, sandboxRequire)
const { gitZh, gitEn, NS } = sandboxModule.exports
if (NS !== 'git') problems.push(`locales.ts: NS 应为 'git'，实为 ${JSON.stringify(NS)}`)
if (typeof gitZh !== 'object' || gitZh === null) throw new Error('check-locale: gitZh 求值失败')
if (typeof gitEn !== 'object' || gitEn === null) throw new Error('check-locale: gitEn 求值失败')

const zhKeys = Object.keys(gitZh).sort()
const enKeys = Object.keys(gitEn).sort()
for (const key of zhKeys) {
  if (!(key in gitEn)) problems.push(`[键缺失] en 缺少 zh 权威键 "${key}"`)
}
for (const key of enKeys) {
  if (!(key in gitZh)) problems.push(`[键多余] en 多出 zh 没有的键 "${key}"`)
}
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g
function placeholders(value) {
  const names = new Set()
  for (const match of String(value).matchAll(PLACEHOLDER)) names.add(match[1])
  return names
}
for (const key of zhKeys) {
  if (!(key in gitEn)) continue
  const zh = placeholders(gitZh[key])
  const en = placeholders(gitEn[key])
  for (const name of zh) {
    if (!en.has(name)) problems.push(`[占位符] "${key}" en 缺少插位 {${name}}`)
  }
  for (const name of en) {
    if (!zh.has(name)) problems.push(`[占位符] "${key}" en 多出插位 {${name}}`)
  }
}
console.log(`check-locale: dictionaries ${zhKeys.length} keys (zh authority), en aligned: ${
  problems.length === 0 ? 'yes' : 'NO'}`)

// ── 3. JSX 无裸字符串（规则化 grep） ────────────────────────────────────────
const tsxFiles = listFiles(TSX_ROOT).filter((file) => file.endsWith('.tsx'))
// JSX 文本子：`>` 与 `<` 之间的一段；剔除 {expr} 后含字母即裸文案。
const JSX_TEXT = />([^<>{}]+)</g
// 用户可见属性的字面量值。
const VISIBLE_ATTRS = /\b(title|placeholder|aria-label|alt)=("([^"]*)"|'([^']*)')/g
const HAS_LETTER = /\p{L}/u
// 注释行跳过（规则化 grep 不做语法分析——注释里的 JSX 示例不算违规面）。
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

for (const file of tsxFiles) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return
    const location = `${relative(repo, file).split(sep).join('/')}:${index + 1}`
    for (const match of line.matchAll(JSX_TEXT)) {
      const segment = match[1]
      if (segment.trim() === '') continue
      if (HAS_LETTER.test(segment)) problems.push(`[JSX 裸文本] ${location}: ${JSON.stringify(segment.trim().slice(0, 60))}`)
    }
    for (const match of line.matchAll(VISIBLE_ATTRS)) {
      const value = match[3] ?? match[4] ?? ''
      if (value === '' || !HAS_LETTER.test(value)) continue
      problems.push(`[JSX 裸属性] ${location}: ${match[1]}=${JSON.stringify(value.slice(0, 60))}`)
    }
  })
}
console.log(`check-locale: scanned ${tsxFiles.length} .tsx files for bare user-facing strings`)

if (problems.length > 0) {
  console.error(`check-locale: ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('check-locale: OK')

// ── helpers ────────────────────────────────────────────────────────────────
function resolveRepo(from) {
  let dir = from
  while (dir !== join(dir, '..')) {
    if (statSyncSafe(join(dir, 'pnpm-workspace.yaml')) !== null) return dir
    dir = join(dir, '..')
  }
  throw new Error('check-locale: repo root not found (pnpm-workspace.yaml)')
}

function statSyncSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(root)
  return out
}
