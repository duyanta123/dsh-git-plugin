/**
 * dsh-gitkit-ui — CSS 导入的 TypeScript 面（审查报告 §2.2 P2）。
 *
 * 形状照抄 dsh 树 ui-primitives/src/css-modules.d.ts（形状照抄源，非自创）：
 * `*.module.css` 默认导出哈希类名表（构建期 lightningcss cssModules pattern
 * '[hash]_[local]' 的产物面），`*.css` 仅作 side-effect 导入（本包当前源码走全局
 * 支路——scripts/build-client.mjs 的 dsh-git-css-inline 管线）。
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
