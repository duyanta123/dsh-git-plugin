/**
 * dsh-gitkit-ui — M13 纯函数：冲突标记行分类器。
 *
 * [清单 6] 的「标记展示」半边（spec §1.1 v1.1 修订 B4：冲突**文件**检测 = porcelain
 * XY 码在 host；冲突**标记**高亮 = FileDiffView 对 diff 文本行分类——本模块交付分类
 * 纯函数，FileDiffView 消费在后续模块）。git 冲突标记：
 *
 *   `<<<<<<< <label>`    —— 当前侧起点（start）
 *   `||||||| <label>`    —— diff3 风格的公共基（base；git merge 默认 merge 风格无此行）
 *   `=======`            —— 两侧分隔（separator；恒独占一行，后不跟文本）
 *   `>>>>>>> <label>`    —— 来入侧终点（end）
 *
 * 标记行恒为 **恰 7 个标记字符** 起头（git 写死 7）。`=======` 恒为整行恰 7 个等号
 * （`^={7}\s*$`）——更长的等号串（Markdown setext 下划线、ASCII 分隔线）不是冲突
 * 分隔；`<<<<<<<`/`|||||||`/`>>>>>>>` 允许后跟空格与标签（merge/diff3 的标签形状），
 * 也接受裸 7 字符行（标签可空）。
 *
 * 纯函数：无 IO、无全局态；同输入同输出（tests/m13.spec.ts）。
 *
 * **P3-2（v2 plan §10，批次四）**：死代码 `scanConflictLines` / `ConflictMarkedLine`
 * 已删除——唯一消费是本模块旧测试行（`markConflictRows` 走 `classifyConflictLine`，
 * patch-hunks.ts:168，src 零运行期调用）；v3 冲突 UI（[13]）若需可从 git 历史找回。
 */

/** 一行的冲突标记类别；非标记行 null。 */
export type ConflictLineKind = 'start' | 'base' | 'separator' | 'end'

/**
 * 分类一行文本：git 冲突标记行 → 类别；其余 → null。
 * 判定只依赖行首前缀（无 trim——git 标记行顶格写；带缩进的 `  =======` 不是标记）。
 * 行尾的 `\r`（CRLF 文本按 `\n` 切分后的残留）与尾随空白由 `\s*` 吸收。
 */
export function classifyConflictLine(line: string): ConflictLineKind | null {
  if (/^<{7}(?: .+)?\s*$/.test(line)) return 'start'
  if (/^\|{7}(?: .+)?\s*$/.test(line)) return 'base'
  if (/^>{7}(?: .+)?\s*$/.test(line)) return 'end'
  if (/^={7}\s*$/.test(line)) return 'separator'
  return null
}
