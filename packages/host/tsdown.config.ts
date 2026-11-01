/**
 * dsh-gitkit — host 半构建（tsdown + typertPlugin）。
 *
 * 照 dsh 树内范本：根 tsdown.config.ts 对 host 构建统一挂 generator 的插件面
 * （实读 dsh 树 HEAD ce7073d512：`packages/typert/generator/src/tsdown-plugin.ts:97-155`
 * `typertPlugin()`——package 模式在 writeBundle 对“package.json exports 声明了
 * `./typert`/`./remote` 的包”做全工作区分析并写出产物）。
 *
 * 产物（generator/src/artifact-files.ts:29-46 写入 <pkg>/lib）：
 *   - typert.host.js / typert.host.d.ts —— host 面 strict 描述符清单（TYPERT 常量），
 *     由 @deepseek-ai/dsh-typert-loader 在宿主装载本包时经 exports["./typert"]
 *     自动 import 并注册进 ctx.typert（loader/src/index.ts:41 TYPERT_HOST_EXPORT、
 *     :411 动态 import；§⑧-2 动态安装链路的 host 半）。
 *   - typert.remote-client.js / typert.remote-client.d.ts —— client 面 codec 贡献，
 *     client 包经 `dsh-gitkit/remote` 引入并 `ctx.remote.$mount`（对照 dsh
 *     api-remotes/client 的静态挂载形态：`import llmRemote from '@deepseek-ai/dsh-llm/remote'`）。
 *   - index.js / types.js —— 本包 lib（ESM bundle；npm 依赖按 tsdown 默认外置，
 *     运行时由 profile node_modules 解析）。
 *
 * d.ts 由 tsc（tsconfig.build.json，emitDeclarationOnly）在 tsdown 之后补齐——
 * 生成器产物自带 .d.ts，禁手编（capability-spec §0.4-1 / map §2.1）。
 */
import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  // .d.ts 由 tsc emitDeclarationOnly 补齐（含生成器自带的两份 typert d.ts，勿混写）。
  dts: false,
  // clean 必须关：同目录下 tsc emitDeclarationOnly 的 .d.ts 与生成器产物不能被清掉。
  clean: false,
  // workspace 模式：经 Worker Thread 走 generateContributors（只产出"manifest 已声明
  // typert 导出"的包 = 本 host 包；dsh 树自身生成走同语义 —— 树 scripts/generate-typert.ts
  // 头注 "same generator and writer as the workspace-mode Typert bundler plugin"，
  // worker.ts:53）。package 模式（generate()）会对全工作区有面包都跑 validateExport，
  // 会误伤 vendored @deepseek-ai/dsh-typert-protocol（有 Events 扩充面但不发布
  // typert 产物，树内 protocol 亦然）。
  plugins: [typertPlugin({ mode: 'workspace' })],
})
