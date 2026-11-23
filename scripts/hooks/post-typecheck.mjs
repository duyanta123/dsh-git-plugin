#!/usr/bin/env node
/**
 * PostToolUse hook：编辑 host / client 源码后，对对应编译面跑窄口径 tsc --noEmit（约 5s），
 * 替代全量 `pnpm run typecheck`（build:host + 3 次 tsc）作为编辑后的秒级类型反馈环。
 *
 * 协议（Claude Code hook）：stdin 收 { tool_name, tool_input: { file_path, ... } }；
 * 退出码 0 = 放行；2 = 把 stderr 作为反馈回传给模型。
 *
 * 设计约束：
 * - 本脚本绝不修改任何文件；
 * - 非目标路径（非 .ts/.tsx、不在 packages/host/src/ 下）静默放行；
 * - 一切基础设施异常（stdin 非 JSON、tsc 缺失、tsc 超时）都 fail-open（exit 0），
 *   只有真实的 tsc 类型错误才 exit 2。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

// 单包合并后两个编译面同在 packages/host：client 前缀必须排在 host 之前——
// 匹配用 includes，client 路径同时命中两条前缀，先命中者胜。
const TARGETS = [
  { prefix: 'packages/host/src/client/', tsconfig: 'packages/host/tsconfig.client.json', label: 'client' },
  { prefix: 'packages/host/src/', tsconfig: 'packages/host/tsconfig.json', label: 'host' },
]
const MAX_OUTPUT = 8000
const TSC_TIMEOUT_MS = 120_000

// hook 脚本在 process.exit() 前必须同步写 stdout/stderr（管道下 console.log 异步写会被 exit 截断）
const out = (msg) => writeSync(1, `${msg}\n`)
const errOut = (msg) => writeSync(2, `${msg}\n`)

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
    // stdin 异常不闭合时兜底，防止 hook 挂死（fail-open）
    setTimeout(() => resolve(data), 10_000).unref()
  })
}

const raw = (await readStdin()).trim()
if (raw === '') process.exit(0)

let payload
try {
  payload = JSON.parse(raw)
} catch (cause) {
  errOut(`[post-typecheck] stdin 非 JSON，跳过检查（fail-open）：${String(cause).slice(0, 200)}`)
  process.exit(0)
}

const filePath = payload?.tool_input?.file_path
if (typeof filePath !== 'string' || filePath === '') process.exit(0)

const normalized = filePath.replace(/\\/g, '/')
const target = TARGETS.find((t) => normalized.includes(t.prefix))
if (target === undefined) process.exit(0)
if (!/\.(ts|tsx|mts|cts)$/.test(normalized)) process.exit(0)

if (!existsSync(TSC)) {
  errOut('[post-typecheck] 未找到 node_modules/typescript/bin/tsc，跳过检查（fail-open）')
  process.exit(0)
}

try {
  execFileSync(process.execPath, [TSC, '-p', target.tsconfig, '--noEmit'], {
    cwd: ROOT,
    timeout: TSC_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  out(`[post-typecheck] ${target.label} typecheck OK (${target.tsconfig})`)
  process.exit(0)
} catch (error) {
  if (error?.killed === true || error?.signal === 'SIGTERM') {
    errOut('[post-typecheck] tsc 超时，跳过本次反馈（fail-open）')
    process.exit(0)
  }
  const text = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim()
  errOut(`[post-typecheck] ${target.label} 存在类型错误（${target.tsconfig}）：\n${text.slice(-MAX_OUTPUT)}`)
  process.exit(2)
}
