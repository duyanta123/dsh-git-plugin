#!/usr/bin/env node
/**
 * verify-target.mjs — P3 门禁矩阵共享模块：列解析（resolveTarget）+ 发布形态安装
 * （npmInstallToPrefix）+ 退出码/skip 纪律（applySkipDiscipline）。
 * （审查与修复报告 §2.3「修复方案」；verify-install.mjs / verify-load.mjs 同构消费。）
 *
 * 列语义：
 *   - 缺省（无 DSH_SPEC/DSH_BIN）= dev-tree 列：与 v0.1.1 行为逐位一致 ——
 *     `node --import tsx/esm <DSH_TREE>/apps/cli/src/bin.ts`、cwd=DSH_TREE、断言面全严格
 *     （层标签 / 严格 boot 行 / 激活 marker 全串 / strict typert 全开）。
 *   - `DSH_SPEC=@deepseek-ai/dsh@<ver>` = npm 列：npm view 探活 + `npm i --prefix <tmp>`，
 *     装后 `node <tmp>/node_modules/@deepseek-ai/dsh/lib/bin.js` 裸启动、cwd=<tmp>。
 *     resolveTarget 零网络：npm 列的 cli/cliCwd 先为 null，由调用方在 try 内首步
 *     npmInstallToPrefix 成功后回填（延迟解析消除双重安装与顶层 SkipError 不可达）。
 *   - `DSH_BIN=<pkgRoot>/lib/bin.js` = 现成可执行列：cliCwd = resolve(DSH_BIN,'..','..')，
 *     两道存在性断言（防 DSH_BIN 指错子路径时 spawn 触发 child 'error' 事件而 run()
 *     未捕获 throw —— 报告 §2.3 备注级修订；run() 的 'error' 监听器是第二道防线）。
 *   - 同设 DSH_SPEC + DSH_BIN → resolveTarget throw（→ 调用方 exit 1）。
 *   - DSH_SPEC 命中 NEGATIVE_SPECS = 声明下限外观测列：宿主不强制校验（0.1.x 实证
 *     grep -c engines=0；0.2.1-rc.2~rc.4 是否校验未实证），不写「预期拒绝」——
 *     KNOWN-UNSUPPORTED（exit 0）或 PASS-UNEXPECTED（exit 1）双结局合法；
 *     KNOWN-UNSUPPORTED 行为纯记录式（记录实际失败形态，不预设失败形状）。
 *
 * npm 调用形态（修订②重做）：禁止 execFileSync('npm'/'npm.cmd') —— npm/npm.cmd shim
 * 双路在 win32 实测皆堵（ENOENT / EINVAL：CVE-2024-27980 修复后 Node ≥20.12.2/21.7.3
 * 对无 shell 的 .cmd spawn 强制 EINVAL）；一律 node 直跑 npm CLI 入口：
 * DSH_NPM_CLI_JS env 覆盖或默认 join(dirname(process.execPath),'node_modules','npm',
 * 'bin','npm-cli.js')（官方 node 发行版布局成立；缺失 → SkipError → skip 纪律）。
 *
 * 退出码与 skip 纪律：0=pass（观测列 KNOWN-UNSUPPORTED 亦 0）；1=fail（含观测列
 * PASS-UNEXPECTED）；2=skip（npm-cli.js 缺失 / npm view|install 失败，且未设
 * DSH_VERIFY_ALLOW_SKIP=1；SkipError 原因分类 spec-not-found（stderr 匹配
 * E404/'not found'/'404'）/ npm-unreachable，附 stderr 首行）。设 ALLOW 时 exit 0 但
 * RESULT 行 outcome=SKIPPED-ALLOWED，永不把 skip 记 pass；CI/release 不设 ALLOW
 * ⇒ exit 2 即步失败。每列结束打印 RESULT 行（由调用方在统一 finally 之后打印）。
 *
 * bootLineMatch：dev-tree 列单一严格形 /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/
 * （与 verify-install.mjs / verify-load.mjs 的历史 boot 行断言逐字一致）；npm/bin 列加
 * 宽松兜底形（宿主 boot 行形状可能随版本漂移）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const EXIT_PASS = 0
export const EXIT_FAIL = 1
export const EXIT_SKIP = 2

/**
 * 声明下限外观测列（engines `>=0.2.1-rc.5` 之下的宿主形态）：双结局合法、纯记录式。
 * 硬编码表需人工同步——漂移后果是显式失败而非静默（报告 P3 残余风险）。
 */
export const NEGATIVE_SPECS = ['@deepseek-ai/dsh@0.1.7-rc.2', '@deepseek-ai/dsh@0.2.1-rc.2']

const NPM_VIEW_TIMEOUT_MS = 120_000
const NPM_INSTALL_TIMEOUT_MS = 600_000

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** skip 纪律的异常载体：reason ∈ 'spec-not-found' | 'npm-unreachable'。 */
export class SkipError extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'SkipError'
    this.reason = reason
  }
}

/**
 * npm CLI 入口解析：DSH_NPM_CLI_JS env 覆盖，或默认官方 node 安装布局。
 * 缺失 → SkipError('npm-unreachable')（skip 纪律归调用方裁决）。
 */
export function resolveNpmCliJs(env = process.env) {
  const fromEnv = env.DSH_NPM_CLI_JS
  if (fromEnv && fromEnv.trim().length > 0) {
    const resolved = resolve(fromEnv.trim())
    if (!existsSync(resolved)) {
      throw new SkipError('npm-unreachable', `DSH_NPM_CLI_JS points to a missing file: ${resolved}`)
    }
    return resolved
  }
  const fallback = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(fallback)) {
    throw new SkipError('npm-unreachable', `npm-cli.js not found at ${fallback}（非标准 node 安装布局请设 DSH_NPM_CLI_JS）`)
  }
  return fallback
}

/**
 * 列解析（零网络，调用方在模块顶层同步执行）。
 * 返回对象字段：kind/label/observation、四个严格断言开关（strictLayerLabel /
 * strictBootLine / strictActivationMarker / strictTypert）、cli / cliArgs / cliCwd
 * （npm 列先为 null，由调用方在 try 内 npmInstallToPrefix 成功后回填）、npmSpec。
 */
export function resolveTarget(env = process.env) {
  const spec = env.DSH_SPEC?.trim() || null
  const bin = env.DSH_BIN?.trim() || null
  if (spec && bin) {
    throw new Error(`DSH_SPEC and DSH_BIN are mutually exclusive（同设 → exit 1）: DSH_SPEC=${spec} DSH_BIN=${bin}`)
  }

  if (bin) {
    // 现成可执行列：cliCwd = 包根等价物 resolve(DSH_BIN,'..','..')。
    const binPath = resolve(bin)
    const pkgRoot = resolve(binPath, '..', '..')
    // 两道存在性断言（第一道防线；run() 的 'error' 监听器为第二道）：
    assert(existsSync(binPath), `DSH_BIN does not exist: ${binPath}（期望 <pkgRoot>/lib/bin.js）`)
    assert(existsSync(join(pkgRoot, 'package.json')),
      `DSH_BIN package root has no package.json: ${pkgRoot}（cliCwd = resolve(DSH_BIN,'..','..')）`)
    return {
      kind: 'bin',
      label: `bin: ${binPath}`,
      observation: false,
      strictLayerLabel: false,
      strictBootLine: false,
      strictActivationMarker: false,
      strictTypert: true,
      cli: process.execPath,
      cliArgs: [binPath],
      cliCwd: pkgRoot,
      npmSpec: null,
    }
  }

  if (spec) {
    const observation = NEGATIVE_SPECS.includes(spec)
    return {
      kind: observation ? 'npm-observation' : 'npm',
      label: observation ? `npm-observation: ${spec}` : `npm: ${spec}`,
      observation,
      strictLayerLabel: false,
      strictBootLine: false,
      strictActivationMarker: false,
      strictTypert: true,
      cli: null,
      cliArgs: null,
      cliCwd: null,
      npmSpec: spec,
    }
  }

  // dev-tree 列：缺省形态，与 v0.1.1 行为逐位一致（DSH_TREE 默认值保持源码双反斜杠形态）。
  const tree = resolve(env.DSH_TREE ?? 'D:\\DeepSeekHarness')
  return {
    kind: 'dev-tree',
    label: `dev-tree: ${tree}`,
    observation: false,
    strictLayerLabel: true,
    strictBootLine: true,
    strictActivationMarker: true,
    strictTypert: true,
    cli: process.execPath,
    cliArgs: ['--import', 'tsx/esm', join(tree, 'apps', 'cli', 'src', 'bin.ts')],
    cliCwd: tree,
    npmSpec: null,
  }
}

/** npm view/install 的失败分类：spec-not-found（E404/'not found'/'404'）或 npm-unreachable。 */
function classifyNpmFailure(spec, out, headline) {
  const stderrFirstLine = out.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (/E404|not found|404/i.test(out)) {
    return new SkipError('spec-not-found', `${headline}: spec ${spec} not found on the registry (stderr first line: ${stderrFirstLine})`)
  }
  return new SkipError('npm-unreachable', `${headline} (stderr first line: ${stderrFirstLine})`)
}

function killTree(pid) {
  if (!pid) return
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { /* best effort */ })
  } catch { /* best effort */ }
}

/** spawn once, capture output, enforce a timeout, kill the tree on timeout；'error' 事件兜底。 */
function runProcess(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const collect = (chunk) => { out += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      killTree(child.pid)
      resolveRun({ code: -1, out: `${out}\n[verify-target] process timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ code: -1, out: `${out}\n[verify-target] spawn failed: ${error?.message ?? error}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, out })
    })
  })
}

/**
 * npm 列安装（发布形态）：npm view 探活 + `npm i --prefix <prefixDir>`。
 * 一律 node 直跑 npm-cli.js（禁 execFileSync('npm'/'npm.cmd')）。
 * 任何失败 → SkipError（spec-not-found / npm-unreachable），退出码纪律归调用方。
 * 成功返回 { cli, cliArgs, cliCwd, viewVersion }：调用方回填 target 的同名字段 ——
 * 装后 `node <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js` 裸启动、cwd=<prefix>。
 */
export async function npmInstallToPrefix(spec, prefixDir, { env = process.env } = {}) {
  const npmCli = resolveNpmCliJs(env)
  // 1) 探活：node <npm-cli.js> view <spec> version（spawn 层探活形态）。
  const view = await runProcess(process.execPath, [npmCli, 'view', spec, 'version'], {
    cwd: prefixDir, env, timeoutMs: NPM_VIEW_TIMEOUT_MS,
  })
  if (view.code !== 0) {
    throw classifyNpmFailure(spec, view.out, `npm view probe failed for ${spec}`)
  }
  // 2) 安装：node <npm-cli.js> install --prefix <prefixDir> <spec>（会写 npm cache，正常行为）。
  const install = await runProcess(process.execPath, [npmCli, 'install', '--prefix', prefixDir, spec], {
    cwd: prefixDir, env, timeoutMs: NPM_INSTALL_TIMEOUT_MS,
  })
  if (install.code !== 0) {
    throw classifyNpmFailure(spec, install.out, `npm install --prefix ${prefixDir} failed for ${spec}`)
  }
  const binJs = join(prefixDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binJs)) {
    throw new SkipError('npm-unreachable', `npm install reported success but ${binJs} is missing（已发布 dsh 包形状变化？）`)
  }
  const viewLines = view.out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return {
    cli: process.execPath,
    cliArgs: [binJs],
    cliCwd: prefixDir,
    viewVersion: viewLines[viewLines.length - 1] ?? '',
  }
}

/**
 * boot 行按列匹配：dev-tree 列单一严格形（历史断言逐字）；npm/bin 列加宽松兜底形。
 * 匹配返回 boot URL（原正则第 1 捕获组），不匹配返回 null。
 */
export function bootLineMatch(output, target) {
  const strict = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
  if (strict) return strict[1]
  if (target.strictBootLine) return null
  // npm/bin 列宽松兜底形：dsh web: 前缀限定作用域，token 键序/端口形式允许漂移。
  const lenient = output.match(/dsh web: (\S+\/\?token=\S+)/) ?? output.match(/dsh web: (\S+token=\S+)/)
  return lenient ? lenient[1] : null
}

/**
 * skip 纪律：DSH_VERIFY_ALLOW_SKIP=1 → exit 0 但 outcome=SKIPPED-ALLOWED（永不把 skip
 * 记 pass）；否则 exit 2。CI/release 不设 ALLOW ⇒ exit 2 即步失败。
 */
export function applySkipDiscipline(error, tag) {
  const detail = `${error.reason}: ${error.message}`
  if (process.env.DSH_VERIFY_ALLOW_SKIP === '1') {
    console.warn(`${tag} SKIP-ALLOWED (DSH_VERIFY_ALLOW_SKIP=1 → outcome=SKIPPED-ALLOWED, never recorded as pass): ${detail}`)
    return { outcome: 'SKIPPED-ALLOWED', exit: EXIT_PASS }
  }
  console.error(`${tag} SKIP (exit 2): ${detail}`)
  return { outcome: 'SKIPPED', exit: EXIT_SKIP }
}
