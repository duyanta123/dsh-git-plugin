/**
 * spec §5.4 合规守卫（NOTICE.md §5 承诺的 tests/licenses.spec.ts；2026-11-01 落地）。
 *
 * 三项断言（spec §5.4 原文口径）：
 *  (a) NOTICE.md §2 登记表内**非「计划中」**的每个目标文件都真实存在，且其来源可溯源：
 *      文件自带溯源标记（Ported from / PORTING.md / NOTICE.md / 自研声明…）**或**
 *      PORTING.md 有该文件的登记行（B/C 级「就近注明/行登记」的双通道口径，NOTICE §2
 *      头注「两表互为镜像索引」）；其中登记为**代码级移植**（手抄组合/逐段移植/照抄/
 *      只抄/范式移植/参数清单翻译）的文件必须带 §5.3 模板的 `Ported from` 文件头。
 *  (b) packages 各 src 与 lib（存在即扫）全库 grep：`packages/plus`、
 *      `LICENSE.plus` 边界字面量零出现（连注释也不许）；剥离注释后 `mhutchie`、
 *      `vscode-git-graph`、`gitamine` 的标识符/路径零出现——NOTICE §1 允许的
 *      「阅读参考、未使用代码」自我声明只许留在注释里（lane-layout.ts 文件头），
 *      不许进代码标识符面（spec §5.4(b)「vscode-git-graph 的标识符」口径）。
 *  (c) `THIRD_PARTY_NOTICES.md`（根 + 三包副本）不含 mhutchie 文本；四份同文；
 *      六个署名条目与 Apache-2.0/MIT 全文在场；根+三包（host/client-ui/git-bundle）
 *      LICENSE/NOTICE.md/THIRD_PARTY_NOTICES.md 三件套齐备且各包 `files` 已声明
 *      （§5.2 发布就绪；git-bundle 为 v0.1.0 发布薄包，许可随本项目）。
 *  本项目许可：Apache-2.0（`Copyright 2026 dsh-git-plugin contributors`；发布 ask
 *  改定，spec §5.2 原写 MIT —— THIRD_PARTY_NOTICES.md §1 版本注记）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readText(rel: string): Promise<string> {
  return readFile(path.join(repoRoot, rel), 'utf8')
}

/** 剥离块注释与行注释（对「禁词只许在注释」的扫描方向安全：只删不加）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

async function walkCode(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkCode(full)))
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.name)) out.push(full)
  }
  return out
}

/** NOTICE.md §2 登记行（非计划中）的解析形状。 */
interface RegisteredRow {
  /** 目标单元格原文（首个单元格）。 */
  target: string
  /** 移植方式单元格原文。 */
  method: string
}

function parseNoticeRows(notice: string): RegisteredRow[] {
  const rows: RegisteredRow[] = []
  let inTable = false
  for (const line of notice.split(/\r?\n/)) {
    if (line.startsWith('## 3.')) break // §2 登记表在其后结束
    if (!line.startsWith('|')) {
      inTable = false
      continue
    }
    const cells = line.split('|').map((cell) => cell.trim())
    // 6 列表：'' | 目标 | 来源 | 版本 | 许可 | 方式 | 状态 | ''
    const target = cells[1] ?? ''
    const method = cells[5] ?? ''
    const status = cells[6] ?? ''
    if (target === '' || target.startsWith('---') || target.startsWith('我们的目标文件')) {
      inTable = true
      continue
    }
    if (!inTable || status.includes('计划中')) continue
    rows.push({ target, method })
  }
  return rows
}

/** 目标单元格 → 仓库内真实文件（相对根；短名按包内候选目录解析；`*.ts` 按目录展开）。 */
async function resolveTargetFiles(cell: string): Promise<string[]> {
  const groups = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  const resolved: string[] = []
  const prefixes = [
    '',
    'packages/host/src',
    'packages/host/tests',
    'packages/client-ui/src/client',
    'packages/client-ui/src/client/components',
    'packages/client-ui/src/client/store',
    'packages/client-ui/src/client/graph',
    'packages/client-ui/src/client/diff',
  ]
  for (const group of groups) {
    if (group.endsWith('/') || !group.includes('.')) continue // 目录行/汇总行（typert-protocol 整包、client 组件交互等）
    if (group.includes('*')) {
      // 通配行（diff/*.ts）：展开目录内同扩展名文件
      const star = group.indexOf('*')
      const dir = path.join(repoRoot, group.slice(0, star))
      const ext = group.slice(group.lastIndexOf('.'))
      if (!existsSync(dir)) continue
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(ext)) resolved.push(path.join(dir, entry.name))
      }
      continue
    }
    if (existsSync(path.join(repoRoot, group))) {
      resolved.push(path.join(repoRoot, group))
      continue
    }
    for (const prefix of prefixes) {
      const candidate = path.join(repoRoot, prefix, group)
      if (existsSync(candidate)) {
        resolved.push(candidate)
        break
      }
    }
  }
  return resolved
}

/** 代码级移植方式（spec §5.3 文件头义务的判定面）。 */
const CODE_TRANSFER_RE = /手抄组合|逐段移植|照抄|只抄|翻译成 TS/u
/** 语义级对照（零代码搬运——无文件头义务，登记行/就近注明即可）。 */
const SEMANTIC_ONLY_RE = /零逐行搬运|零代码搬运|语义学习|语义对照|语义参考|形态对照|用法对照|行为仿真|只学语义/u
/** 文件内溯源标记（双通道之一：文件头/注释注明）。 */
const PROVENANCE_RE = /Ported from|PORTING\.md|NOTICE\.md|自研声明|移植登记|来源/u

describe('licenses 合规守卫（spec §5.4）', () => {
  it('(a) 登记表内文件真实存在且来源可溯源；代码级移植文件带 Ported from 文件头', async () => {
    const [notice, porting] = await Promise.all([readText('NOTICE.md'), readText('PORTING.md')])
    const rows = parseNoticeRows(notice)
    expect(rows.length).toBeGreaterThan(10) // 登记表解析有效性（防止表结构漂移后守卫空转）

    const files = new Map<string, boolean>() // path → 是否代码级移植
    for (const row of rows) {
      const tier3 = CODE_TRANSFER_RE.test(row.method) && !SEMANTIC_ONLY_RE.test(row.method)
      for (const file of await resolveTargetFiles(row.target)) {
        files.set(file, (files.get(file) ?? false) || tier3)
      }
    }
    expect(files.size).toBeGreaterThan(10)

    const missing: string[] = []
    const untraceable: string[] = []
    const missingHeader: string[] = []
    for (const [file, tier3] of files) {
      const base = path.basename(file)
      const content = await readFile(file, 'utf8')
      const traceable =
        PROVENANCE_RE.test(content) ||
        porting.includes(base) ||
        porting.includes(base.replace(/\.[^.]+$/u, ''))
      if (!existsSync(file)) missing.push(file)
      if (!traceable) untraceable.push(path.relative(repoRoot, file))
      if (tier3 && !content.includes('Ported from')) missingHeader.push(path.relative(repoRoot, file))
    }
    expect(missing, '登记行指向的文件不存在').toEqual([])
    expect(untraceable, '登记文件既无溯源标记也无 PORTING.md 登记行').toEqual([])
    expect(missingHeader, '代码级移植（§5.3 义务）文件缺 Ported from 文件头').toEqual([])
  })

  it('(b) packages/*/src(+lib) 零 plus 边界字面量；剥离注释后零 mhutchie/vscode-git-graph/gitamine', async () => {
    const scanRoots = [
      'packages/host/src',
      'packages/host/lib',
      'packages/client-ui/src',
      'packages/client-ui/lib',
      'packages/typert-protocol/src',
    ]
    const files: string[] = []
    for (const root of scanRoots) files.push(...(await walkCode(path.join(repoRoot, root))))
    expect(files.length).toBeGreaterThan(20) // 扫描面有效性

    const plusHits: string[] = []
    const bannedHits: string[] = []
    for (const file of files) {
      const raw = await readFile(file, 'utf8')
      if (/packages\/plus|LICENSE\.plus/u.test(raw)) plusHits.push(path.relative(repoRoot, file))
      const codeOnly = stripComments(raw)
      if (/mhutchie|vscode-git-graph|gitamine/u.test(codeOnly)) {
        bannedHits.push(path.relative(repoRoot, file))
      }
    }
    expect(plusHits, 'GitLens plus 边界字面量出现在出货面（连注释也不许）').toEqual([])
    expect(bannedHits, 'GPL/禁再发布来源标识符出现在代码面（只许留在「阅读参考」注释里）').toEqual([])
  })

  it('(c) THIRD_PARTY_NOTICES 四份同文、无 mhutchie 文本、署名与全文齐备；发布三件套就绪（本项目 Apache-2.0）', async () => {
    const noticePaths = [
      'THIRD_PARTY_NOTICES.md',
      'packages/host/THIRD_PARTY_NOTICES.md',
      'packages/client-ui/THIRD_PARTY_NOTICES.md',
      'git-bundle/THIRD_PARTY_NOTICES.md',
    ]
    const contents = await Promise.all(noticePaths.map((rel) => readText(rel)))
    expect(new Set(contents).size, '根与三包 THIRD_PARTY_NOTICES.md 必须同文').toBe(1)
    const text = contents[0] ?? ''

    const mhutchieText = [/mhutchie/iu, /vscode-git-graph/iu, 'determinePath', 'registerUnavailablePoint', 'getAvailableColour']
    for (const needle of mhutchieText) {
      expect(text).not.toContain(needle) // mhutchie 项目文本不得入 THIRD_PARTY_NOTICES（spec §5.2）
    }
    for (const attribution of ['Z.AI Co., Ltd', 'OpenAI', 'Cline Bot Inc.', 'opencode', 'Axosoft', 'DeepSeek']) {
      expect(text, `缺 Apache/MIT 署名条目：${attribution}`).toContain(attribution)
    }
    expect(text).toContain('Apache License')
    expect(text).toContain('Version 2.0, January 2004')
    expect(text).toContain('Permission is hereby granted, free of charge') // MIT 全文在场
    expect(text).toContain('Copyright (c) 2026 DeepSeek') // dsh 版权行原文（spec §0.4-8，经 typert-protocol/LICENSE 副本核实）

    const packageDirs = ['.', 'packages/host', 'packages/client-ui', 'git-bundle']
    for (const dir of packageDirs) {
      for (const name of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) {
        const rel = path.join(dir, name)
        expect(existsSync(path.join(repoRoot, rel)), `缺发布三件套：${rel}`).toBe(true)
      }
      const license = await readText(path.join(dir, 'LICENSE'))
      expect(license).toContain('Apache License')
      expect(license).toContain('Version 2.0, January 2004')
      expect(license).toContain('Copyright 2026 dsh-git-plugin contributors')
      expect(license).toContain('Licensed under the Apache License, Version 2.0')
      expect(license).toContain('END OF TERMS AND CONDITIONS')
    }
    // 三包同文（LICENSE / NOTICE.md 的副本面）。
    for (const name of ['LICENSE', 'NOTICE.md']) {
      const rootText = await readText(name)
      for (const dir of packageDirs.slice(1)) {
        expect(await readText(path.join(dir, name)), `${dir}/${name} 与根不同文`).toBe(rootText)
      }
    }
    expect(existsSync(path.join(repoRoot, 'packages/typert-protocol/LICENSE')), 'typert-protocol 副本须自带 dsh MIT LICENSE').toBe(true)

    for (const pkg of ['packages/host/package.json', 'packages/client-ui/package.json', 'git-bundle/package.json']) {
      const manifest = JSON.parse(await readText(pkg)) as { files?: string[]; license?: string; name?: string }
      for (const name of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) {
        expect(manifest.files ?? [], `${pkg} files 缺 ${name}`).toContain(name)
      }
      expect(manifest.license, `${pkg} license 字段应为 Apache-2.0`).toBe('Apache-2.0')
      expect(manifest.name, '包名面').toMatch(/^(@dsh-plugin\/|dsh-git-plugin$)/u)
    }
  })
})
