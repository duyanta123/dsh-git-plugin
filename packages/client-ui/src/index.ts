/**
 * dsh-gitkit-ui — node 半最小入口。
 *
 * Loader 按 `name` 导入本包 main（map §1.1；runbook §3.C），故 main 必须存在
 * 且可导入。纯 UI 插件的 host 半是空 apply —— 形态照抄 dsh 树
 * `packages/extensions/ui-cordis/src/index.ts`（"the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader; the browser half ships via
 * exports["./client"]"）。client 半经 `exports["./client"]` 交付（lib/client.js
 * 闭包工厂），由 `dsh.client` 清单驱动宿主运行时动态装载。
 */

/** cordis bundle id，必须与 cordis.patch.yml 的 insert 行一致（runbook §3.D）。 */
export const PLUGIN_ID = 'dsh-plugin-client-ui-git'

/** npm 包名（client 半）。 */
export const PLUGIN_NAME = 'dsh-gitkit-ui'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
