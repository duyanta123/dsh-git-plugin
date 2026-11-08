/**
 * CSS token 守卫（V2 plan §10 P3-6 归批次一）：git.css 头注约定「颜色只引用宿主
 * token，零硬编码色值」此前零断言防线——本 spec 补上：
 *   1. git.css 零色值字面量（hex / rgb() / hsl() 家族；注释剔除后全文扫描）；
 *   2. 自定义属性（--*）声明的值只引用 --dsw-*（宿主 token）或 --dsh-git-*
 *      （本插件 lane 变量，值域本身是 dsw token）——不允许其它来源；
 *   3. graph/graph-svg.tsx 的主题缺失 fallback hex 全集 == 允许清单（逐项注释来源；
 *      fallback 只在 token 未定义时生效——git.css 的 lane 色板块在位时永不命中）。
 * 新增样式若带色值字面量，本测试即红——修复方向是补 dsw token 引用，不是扩清单。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const clientSrc = (rel: string): string => path.join(repoRoot, 'packages', 'client-ui', 'src', 'client', rel)

/** CSS 色值字面量形态（hex 3/4/6/8 位 + rgb/rgba/hsl/hsla 函数家族）。 */
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g
const COLOR_FN_RE = /\b(rgba?|hsla?)\s*\(/g

/** 剔除 /* … *\/ 注释（注释里的示例/文档措辞不参与扫描）。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('git.css — 零色值字面量 + token 引用纪律（P3-6）', () => {
  let css = ''
  let stripped = ''

  it('读取样式入口（前置装配）', async () => {
    css = await readFile(clientSrc('styles/git.css'), 'utf8')
    stripped = stripCssComments(css)
    expect(stripped.length).toBeGreaterThan(0)
  })

  it('零 hex 色值字面量（#fff / #ffffff / #rrggbbaa 全形态）', () => {
    const matches = [...stripped.matchAll(HEX_RE)].map((match) => match[0])
    expect(matches, `git.css 出现 hex 字面量: ${matches.join(', ')}`).toEqual([])
  })

  it('零 rgb()/rgba()/hsl()/hsla() 色值函数', () => {
    const matches = [...stripped.matchAll(COLOR_FN_RE)].map((match) => match[0])
    expect(matches, `git.css 出现色值函数: ${matches.join(', ')}`).toEqual([])
  })

  it('自定义属性声明的值只引用 --dsw-* / --dsh-git-* 变量（不引其它来源）', () => {
    // 逐条 --custom-prop: value; 声明扫描（多行值以 ; 收口）。
    const declarationRe = /(^|\n)\s*--[\w-]+\s*:\s*([^;]+);/g
    const violations: string[] = []
    for (const match of stripped.matchAll(declarationRe)) {
      const value = match[2] ?? ''
      for (const ref of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const token = ref[1] ?? ''
        if (!token.startsWith('--dsw-') && !token.startsWith('--dsh-git-')) {
          violations.push(`${token} (value: ${value.trim()})`)
        }
      }
    }
    expect(violations, `自定义属性引用了非 dsw/dsh-git token: ${violations.join('; ')}`).toEqual([])
  })
})

describe('graph-svg.tsx — 主题缺失 fallback hex 允许清单（P3-6）', () => {
  /**
   * 允许清单（逐项来源——与 graph-svg.tsx 源内注释同口径）：
   * lane fallback = 暗色底友好的 8 色相（lane 序号取模 8；token 在位时永不生效），
   * head ring = HEAD 描边的琥珀色（git 分支头语义，主题 --dsw-static-amber-500 对应）。
   */
  const ALLOWED = new Set([
    '#5b8def', // lane-0 fallback：蓝（--dsw-static-blue-400 的降级）
    '#4caf7d', // lane-1 fallback：绿（--dsw-static-green-400 的降级）
    '#e0a63f', // lane-2 fallback：琥珀（--dsw-static-amber-400 的降级）
    '#d45f74', // lane-3 fallback：红（--dsw-static-red-400 的降级）
    '#9a6fd0', // lane-4 fallback：紫（--dsw-static-deepseek-300 的降级）
    '#43b8c9', // lane-5 fallback：青（--dsw-static-green-500 族的降级）
    '#c97db3', // lane-6 fallback：粉紫（--dsw-static-blue-600 族对比位的降级）
    '#8fa860', // lane-7 fallback：橄榄（--dsw-static-neutral-bluish-400 的降级）
    '#f2b03d', // HEAD ring fallback：琥珀描边（--dsw-static-amber-500 的降级）
  ])

  it('源内 hex 字面量全集 == 允许清单（新增 fallback 必须连注释一起过审）', async () => {
    const source = await readFile(clientSrc('graph/graph-svg.tsx'), 'utf8')
    // lane fallback 在数组里是带引号字符串，head-ring 是 var() 串内的裸 hex——
    // 两种形态统一按裸 hex 记号扫描。
    const found = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0])
    expect(found.length).toBeGreaterThan(0)
    const unknown = [...new Set(found)].filter((hex) => !ALLOWED.has(hex))
    expect(unknown, `graph-svg 出现允许清单之外的 fallback hex: ${unknown.join(', ')}`).toEqual([])
    // 每个允许项恰出现一次（清单与源一一对应，防静默增删）。
    for (const hex of ALLOWED) {
      expect(found.filter((item) => item === hex), `${hex} 应恰出现一次`).toHaveLength(1)
    }
  })

  it('fallback 只在两处合法上下文出现（LANE_FALLBACKS 数组 / head-ring var() 串），其余零 hex', async () => {
    const source = await readFile(clientSrc('graph/graph-svg.tsx'), 'utf8')
    // 上下文一：LANE_FALLBACKS 数组字面量（laneColor 经 var(--dsh-git-lane-${slot}, …) 模板消费）。
    const arrayMatch = source.match(/const LANE_FALLBACKS[^=]*=\s*\[([\s\S]*?)\]/)
    expect(arrayMatch, 'LANE_FALLBACKS 数组在位').not.toBeNull()
    // 上下文二：head-ring 的 var(--dsh-git-graph-head-ring, <hex>) 串。
    const ringForm = /var\(--dsh-git-graph-head-ring,\s*#[0-9a-fA-F]{6}\)/
    expect(source).toMatch(ringForm)
    // 剔除两个合法上下文后全文零 hex——fallback 不允许从别处（style 内联/其它常量）漏出。
    const rest = source.replace(/const LANE_FALLBACKS[^=]*=\s*\[[\s\S]*?\]/, '').replace(ringForm, '')
    expect([...rest.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0])).toEqual([])
  })
})
