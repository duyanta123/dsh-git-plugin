/**
 * groupPaths 纯函数单测（本模块 ask §②「目录分组折叠（group-paths 纯函数单测）」；
 * spec §6 纯函数纪律：无 IO、无全局态、同输入同输出，可快照断言）。
 */

import { describe, expect, it } from 'vitest'
import { groupPaths } from '../src/client/group-paths.ts'
import type { PathNode } from '../src/client/group-paths.ts'

/** 形状化简：树 → 可比较结构（断言面）。 */
function shape(nodes: readonly PathNode[]): unknown {
  return nodes.map((node) => node.kind === 'dir'
    ? { dir: node.path, children: shape(node.children) }
    : { file: node.path })
}

describe('groupPaths — 平面与排序', () => {
  it('空输入 → 空数组', () => {
    expect(groupPaths([])).toEqual([])
  })

  it('根级文件按 name 升序', () => {
    expect(shape(groupPaths(['README.md', 'a.ts', 'B.ts']))).toEqual([
      { file: 'B.ts' }, { file: 'README.md' }, { file: 'a.ts' },
    ])
  })

  it('重复路径去重', () => {
    expect(shape(groupPaths(['a.ts', 'a.ts']))).toEqual([{ file: 'a.ts' }])
  })
})

describe('groupPaths — 目录分组', () => {
  it('同级多目录 + 目录内文件升序，目录与文件混排', () => {
    expect(shape(groupPaths(['b/z.ts', 'a/y.ts', 'a/x.ts', 'top.ts']))).toEqual([
      { dir: 'a', children: [{ file: 'a/x.ts' }, { file: 'a/y.ts' }] },
      { dir: 'b', children: [{ file: 'b/z.ts' }] },
      { file: 'top.ts' },
    ])
  })

  it('嵌套目录递归成树（dir.path 全路径，展示名只取本段）', () => {
    const nodes = groupPaths(['src/deep/mod.ts', 'src/index.ts', 'tests/a.spec.ts'])
    expect(shape(nodes)).toEqual([
      {
        dir: 'src',
        children: [
          { dir: 'src/deep', children: [{ file: 'src/deep/mod.ts' }] },
          { file: 'src/index.ts' },
        ],
      },
      { dir: 'tests', children: [{ file: 'tests/a.spec.ts' }] },
    ])
    const src = nodes[0]
    if (src?.kind !== 'dir') return
    expect(src.children[0]?.kind === 'dir' && src.children[0].name).toBe('deep')
  })

  it('单文件深链折叠成单个目录节点（name/path 带合并段）', () => {
    const nodes = groupPaths(['a/b/c/d.ts'])
    expect(nodes).toHaveLength(1)
    const dir = nodes[0]
    expect(dir?.kind).toBe('dir')
    if (dir?.kind !== 'dir') return
    expect(dir.path).toBe('a/b/c')
    expect(dir.name).toBe('a/b/c')
    expect(shape(dir.children)).toEqual([{ file: 'a/b/c/d.ts' }])
  })

  it('只含一个文件的目录不折叠进文件（目录行保留）', () => {
    expect(shape(groupPaths(['only/one.ts']))).toEqual([
      { dir: 'only', children: [{ file: 'only/one.ts' }] },
    ])
  })

  it('单链中段分叉后不再合并', () => {
    expect(shape(groupPaths(['a/b/x.ts', 'a/c/y.ts']))).toEqual([
      {
        dir: 'a',
        children: [
          { dir: 'a/b', children: [{ file: 'a/b/x.ts' }] },
          { dir: 'a/c', children: [{ file: 'a/c/y.ts' }] },
        ],
      },
    ])
  })

  it('确定性：同输入两次调用输出全等', () => {
    const input = ['z/y.ts', 'z/a/b.ts', 'm.ts', 'a/1.ts', 'a/b/2.ts', 'a/b/3.ts']
    expect(shape(groupPaths(input))).toEqual(shape(groupPaths([...input].reverse())))
  })
})
