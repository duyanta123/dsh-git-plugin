/**
 * @dsh-plugin/client-ui-git — 变更列表的目录分组纯函数（本模块 ask §②；[清单 4]
 * 「文件/目录树分组」）。GitChangesTab 对每个变更组（staged/changes/untracked/…）
 * 的路径清单调 {@link groupPaths} 得到树节点，目录节点可折叠（展开态在 tab store
 * 的 expandedDirs，键 = 组 id + 目录路径）。纯函数：无 IO、无全局态、同输入同输出
 * （tests/group-paths.spec.ts）。
 *
 * 规则（确定性，可快照断言）：
 *  - git 路径恒 `/` 分隔；无 `/` 的路径是根级文件节点；
 *  - 目录链上「只含一个子目录」的段合并成一个目录节点（name 以 `/` 连接，
 *    如 `a/b/c`）——深路径不产生一串单子节点；只含一个**文件**的目录不合并
 *    （目录行仍可见，与 VS Code 资源管理一致）；
 *  - 同层排序：目录与文件按 name 升序混排（同为 name 时目录在前——git 路径里
 *    同层同名不可能既是目录又是文件，此规则只为排序全序确定性兜底）。
 */

/** 一条路径分组节点：目录（可折叠，含子节点）或文件（叶子）。 */
export type PathNode =
  | { kind: 'dir'; /** 目录全路径（合并段以 `/` 连接；根级目录即首段）。 */ path: string; /** 展示名（合并段同 path）。 */ name: string; children: PathNode[] }
  | { kind: 'file'; /** 文件完整路径（分组输入原样）。 */ path: string }

/** 目录 trie 的中间形态。 */
interface DirTrie {
  dirs: Map<string, DirTrie>
  files: string[]
}

function emptyTrie(): DirTrie {
  return { dirs: new Map(), files: [] }
}

function trieInsert(root: DirTrie, path: string): void {
  const segments = path.split('/')
  const fileName = segments.pop()
  if (fileName === undefined || fileName === '') return
  let node = root
  for (const segment of segments) {
    let child = node.dirs.get(segment)
    if (child === undefined) {
      child = emptyTrie()
      node.dirs.set(segment, child)
    }
    node = child
  }
  // 叶子记完整原路径（文件节点 path 契约 = 分组输入原样，供行模型回查）。
  node.files.push(path)
}

/** 目录链折叠：唯一子目录链合并进一个节点（文件叶子不合并）。 */
function collapse(prefix: string[], chain: string[], trie: DirTrie): PathNode {
  const children = [...trie.dirs.entries()]
  if (children.length === 1 && trie.files.length === 0) {
    const [name, child] = children[0] as [string, DirTrie]
    return collapse(prefix, [...chain, name], child)
  }
  const path = [...prefix, ...chain].join('/')
  return {
    kind: 'dir',
    path,
    // 展示名 = 本节点的合并链（嵌套未合并目录只显示最后一段，父行已含前缀）。
    name: chain.join('/'),
    children: trieChildren([...prefix, ...chain], trie),
  }
}

function trieChildren(segments: string[], trie: DirTrie): PathNode[] {
  const nodes: PathNode[] = []
  for (const [name, child] of trie.dirs) {
    nodes.push(collapse(segments, [name], child))
  }
  for (const path of trie.files) {
    nodes.push({ kind: 'file', path })
  }
  return nodes.sort(compareNodes)
}

function compareNodes(left: PathNode, right: PathNode): number {
  const leftName = left.kind === 'dir' ? left.name : left.path
  const rightName = right.kind === 'dir' ? right.name : right.path
  if (leftName !== rightName) return leftName < rightName ? -1 : 1
  // 全序兜底（同层同名不可能出现在 git 路径里；防御排序器非稳定实现）：
  // 目录排在前。
  return (left.kind === 'dir' ? 0 : 1) - (right.kind === 'dir' ? 0 : 1)
}

/**
 * 把一组变更路径分组成目录树（根级 = 当前变更组的顶层）。
 * @param paths - 文件路径清单（git 形状，`/` 分隔；重复路径去重）。
 * @returns 根级节点（目录先折叠单链、同层按 name 升序）。
 */
export function groupPaths(paths: readonly string[]): PathNode[] {
  const root = emptyTrie()
  for (const path of new Set(paths)) trieInsert(root, path)
  return [...root.dirs.entries()]
    .map(([name, child]) => collapse([], [name], child))
    .concat(root.files.map((path) => ({ kind: 'file' as const, path })))
    .sort(compareNodes)
}
