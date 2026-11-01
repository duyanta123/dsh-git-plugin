/*!
 * Ported from deepseek-ai/deepseek-harness (dsh 树)
 *   path: vitest.shared.ts（standardDecoratorPlugin：TS 标准装饰器 Vite 预变换）
 * License: MIT — Copyright (c) 2026 DeepSeek
 * Modifications: 2026-10-30 —— 去 v8 ignore 改写一行；测试平面 include 改为本仓两平面
 *   （包内 tests 与仓库级 tests），其余（transform 匹配/ES2024 降级/sourcemap 剥离）照抄。
 * SPDX-License-Identifier: MIT
 */

import { availableParallelism } from 'node:os'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * 装饰器预变换（照 dsh 树 vitest.shared.ts standardDecoratorPlugin，MIT——NOTICE.md 登记）：
 * Vite 默认解析器不认 TC39 标准装饰器（@Remote 在 host 服务源码上），先经
 * ts.transpileModule 降级再交给 Vite。
 */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0] as string
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    environment: 'node',
    // 测试平面：包内 tests/（host 七个 spec、client 六个 spec，施工期落地）
    // + 仓库级 tests/（loader-smoke 与骨架完整性测试）。dsh 树的 vitest 走
    // vite-tsconfig-paths 源平面解析（runbook §4.1）；本仓库包间引用经
    // workspace link 解析，无需 paths 插件。
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // 并行上限：本仓用例大量真实 git 子进程与真实 fs/timer（watcher/diff/status），
    // vitest 4 默认 min(12, cpus-1)=12 worker 在本机（16 核 Windows）把 CPU 打满，
    // 实时类断言在 5s/10s 边缘超时（client 地基模块全绿门禁实测复现；资源裕量问题，
    // 非断言问题）。压到 6 worker 后全绿且总时长不劣化；隔离（isolate）默认保留。
    // M6 remote-ops 模块（2026-10-31）实测注记：套件加量（sync.spec 24 例真 git
    // 子进程）后，重负载轮次（同机并行施工的外部负载）偶发把既有 30s 用例顶到
    // 超时——处置是把各集成 spec 的 testTimeout/hookTimeout 提到 60s（纯上限放宽，
    // 断言面零改动；6 worker 维持——4 worker 对照轮未见收益）。
    // 按可用核数收敛：16 核本机仍是 6（既有调优）；GitHub public 的
    // windows-latest 是 4 vCPU，固定 6 worker 会超订并把 spawn 密集型用例顶穿。
    maxWorkers: Math.max(1, Math.min(6, availableParallelism() - 1)),
  },
})
