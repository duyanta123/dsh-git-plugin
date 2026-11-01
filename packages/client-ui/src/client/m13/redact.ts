/**
 * @dsh-plugin/client-ui-git — M13 纯函数：显示面脱敏（redact）。
 *
 * 语义与 host 侧 `packages/host/src/error-codes.ts` 的 sanitizeStderr 同族（同仓自有
 * 代码，非第三方移植）：客户端在把 `error.message` / `details.stderr` 渲染进
 * GitErrorNotice 的折叠区之前再做一次纵深防御——host 已脱敏（§1.2.5），本函数保证
 * 即使有未脱敏的诊断串到达显示面，凭证形状也不会上屏。
 *
 * 覆盖两类形状（与 host sanitizeStderr 一致）：
 *  1. URL userinfo：`scheme://user:token@host/…` → `scheme://***:***@host/…`；
 *  2. 凭证形键值：`token=` / `access-token=` / `password=` / `secret=` / `api_key=` /
 *     `authorization: Bearer …` 等 → 值置换 `***`（键与分隔符保留）。
 *
 * 纯函数：无 IO、无全局态、同输入同输出（tests/m13.spec.ts 快照式断言）。
 */

/** URL userinfo（`https://user:pat@github.com/…`）——只保留 scheme，用户与凭证全遮。 */
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi

/**
 * 凭证形键值（`token= ghp_x` / `password: hunter2` / `Authorization: Bearer xyz`）。
 * 键簇与 host sanitizeStderr 的登记口径一致；值为到空白/分隔符为止的连续段。
 */
const CREDENTIAL_PAIR
  = /(token|access[_-]?token|password|passwd|pwd|secret|api[_-]?key|authorization)([=:])(\s*)(bearer\s+)?[^\s&;]+/gi

/** 对一段将进入 UI 的诊断文本做凭证脱敏；非字符串输入原样返回空串。 */
export function redact(text: string): string {
  return text
    .replace(URL_USERINFO, (match) => {
      const scheme = match.slice(0, match.indexOf('://'))
      return `${scheme}://***:***@`
    })
    .replace(CREDENTIAL_PAIR, '$1$2$3***')
}

/** 折叠到尾部至多 `maxChars` 字符（stderr 保留策略的显示面版；host 同款保尾部）。 */
export function redactTail(text: string, maxChars = 2000): string {
  const cleaned = redact(text)
  return cleaned.length <= maxChars ? cleaned : `…${cleaned.slice(-maxChars)}`
}
