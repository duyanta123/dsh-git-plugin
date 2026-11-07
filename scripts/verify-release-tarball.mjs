#!/usr/bin/env node
/**
 * verify-release-tarball.mjs — P4 第三层侦探（审查与修复报告 §2.4）：发布后一致性比对。
 * 在 release.yml 的 Publish 步之后运行（不能阻止坏发布——预防靠第一层 dispatch 锚定；
 * rerun 整个 job 会在 Publish 撞同版本重发拒绝——断言红时人工比对 stderr 差异清单，
 * 勿直接重跑）。
 *
 * 流程：
 *   ① `npm pack <name>@<version>` 从 registry 拉已发布 tarball（stdout 尾行解析 tgz 路径）；
 *   ② 包目录 `npm pack --ignore-scripts` 重打包（用 Build 步已产出的 lib/，跳过 prepack
 *      重复构建）；
 *   ③ `tar -xzf` 解包两份；
 *   ④ 比对 = 文件路径集合严格相等 + 除 package/package.json 外逐文件 byte 相等 +
 *      package.json 经 JSON.parse 语义比较（deepStrictEqual）；
 *   ⑤ 差异清单写 stderr 并以 exitCode=1 退出（保证 finally 清理已执行）；
 *   ⑥ finally 删临时目录；
 *   ⑦ fail-fast：任一包 mismatch 即停。
 *
 * spawn 形态（关键不变量③⑥）：npm 一律 node 直跑 npm-cli.js（DSH_NPM_CLI_JS env 覆盖
 * 或默认 join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')；禁止
 * execFileSync('npm'/'npm.cmd')——win32 shim 双路 ENOENT/EINVAL）；tar 为系统 .exe，
 * 数组传参直接 spawn（路径含空格安全）；全部 spawn 带 'error' 事件兜底。本脚本的参数
 * 含动态路径（TEMP 目录、包目录），不设 {shell:true}——shell 仅限固定常量参数处。
 * 本脚本不对 npm 失败做 skip（0/1 二元）：它是发布侦探门禁，任何无法比对的情形都是失败。
 *
 * 凭据：workflow 侧与 Publish 步同凭据上下文（env NODE_AUTH_TOKEN，公开包 pack 本不
 * 需要凭据，显式传入仅保持与发布相同的 registry 上下文）。tag 通道 checkout 即 tag、
 * dispatch 通道已被第一层锚定为同一 commit —— 「当前 checkout 重打包」≡「tag 检出
 * 重打包」。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepStrictEqual } from 'node:assert/strict'
import { resolveNpmCliJs } from './verify-target.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..')
/** 发布包 → 仓库内包目录（release.yml 只发这两个；vendored typert-protocol 不属于本仓库）。 */
const PACKAGES = [
  ['dsh-gitkit', 'host'],
  ['dsh-gitkit-ui', 'client-ui'],
]
const PACK_TIMEOUT_MS = 600_000
const TAR_TIMEOUT_MS = 120_000

const step = (message) => console.log(`[verify-release-tarball] ${message}`)
const fail = (message) => {
  console.error(`[verify-release-tarball] FAIL: ${message}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** node 直跑 npm-cli.js 的 spawn（关键不变量③）；带 timeout / 'error' 事件兜底。 */
function runNpm(npmCli, args, { cwd, timeoutMs }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const collect = (chunk) => { out += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* best effort */ }
      resolveRun({ code: -1, out: `${out}\n[verify-release-tarball] process timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ code: -1, out: `${out}\n[verify-release-tarball] spawn failed: ${error?.message ?? error}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, out })
    })
  })
}

/** `tar -xzf <tgz> -C <dest>`：tar 为系统 .exe，数组传参直接 spawn（无 shell，路径含空格安全）。 */
function extractTar(tgzPath, destDir) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('tar', ['-xzf', tgzPath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const collect = (chunk) => { out += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* best effort */ }
      rejectRun(new Error(`tar extraction timed out after ${TAR_TIMEOUT_MS}ms: ${tgzPath}`))
    }, TAR_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(new Error(`tar spawn failed: ${error?.message ?? error}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveRun()
      else rejectRun(new Error(`tar -xzf failed (exit ${code}):\n${out.slice(-1000)}`))
    })
  })
}

/** 递归列出 root 下所有文件（相对 root 的 POSIX 斜杠路径，排序稳定）。
 *  npm tgz 解包布局是顶层唯一 'package/' 目录——键保留该段（'package/lib/index.js'），
 *  两份树一致处理；package.json 的语义比较豁免因此按 'package/package.json' 寻址
 *  （R1：裸 'package.json' 键在 tgz 布局下永不出现，是死代码）。 */
function listFiles(root) {
  const files = []
  const walk = (relative) => {
    const absolute = join(root, relative)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else files.push(rel)
    }
  }
  walk('')
  return files.sort()
}

/**
 * npm pack 的 tgz 定位：stdout 尾行解析优先（报告 §2.4 ①；npm 把新建 tgz 的路径打在
 * 输出里，可能是绝对/相对路径或纯文件名），失败回退扫 --pack-destination 目录。
 */
function resolvePackedTarball(packOut, destDir) {
  const lines = packOut.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.endsWith('.tgz')) continue
    if (line.includes('/') || line.includes('\\')) {
      const candidate = resolve(line)
      if (existsSync(candidate)) return candidate
    }
    const inDest = resolve(destDir, line)
    if (existsSync(inDest)) return inDest
  }
  const tgzs = readdirSync(destDir).filter((name) => name.endsWith('.tgz')).sort()
  assert(tgzs.length > 0, `npm pack produced no .tgz in ${destDir}`)
  return join(destDir, tgzs[0])
}

/**
 * ④ 比对规则：文件路径集合严格相等 + 除 package/package.json 外逐文件 byte 相等 +
 * package.json 经 JSON.parse 语义比较。返回差异清单（空数组 = 一致）。
 * 键为解包布局相对路径（npm tgz 顶层唯一 'package/' 目录，listFiles 保留该段）——
 * 语义比较豁免与 manifest 读取都按 'package/package.json' 寻址（R1：此前写
 * 'package.json' 永不命中，语义比较不可达、manifest 错误落入逐字节比较）。
 */
function compareTrees(registryDir, localDir) {
  const diffs = []
  const registryFiles = listFiles(registryDir)
  const localFiles = listFiles(localDir)
  const registrySet = new Set(registryFiles)
  const localSet = new Set(localFiles)
  for (const file of registryFiles) {
    if (!localSet.has(file)) diffs.push(`only in published tarball: ${file}`)
  }
  for (const file of localFiles) {
    if (!registrySet.has(file)) diffs.push(`only in repacked tarball: ${file}`)
  }
  for (const file of registryFiles) {
    if (!localSet.has(file)) continue
    if (file === 'package/package.json') continue // 语义比较单独做（键序无关；npm tgz 布局键，R1）
    const published = readFileSync(join(registryDir, file))
    const repacked = readFileSync(join(localDir, file))
    if (!published.equals(repacked)) {
      diffs.push(`byte mismatch: ${file} (published ${published.length}B vs repacked ${repacked.length}B)`)
    }
  }
  if (registrySet.has('package/package.json') && localSet.has('package/package.json')) {
    try {
      deepStrictEqual(
        JSON.parse(readFileSync(join(registryDir, 'package', 'package.json'), 'utf8')),
        JSON.parse(readFileSync(join(localDir, 'package', 'package.json'), 'utf8')),
      )
    } catch (error) {
      diffs.push(`package.json semantic mismatch: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  return diffs
}

async function main() {
  const npmCli = resolveNpmCliJs() // 缺失 → SkipError：侦探门禁不 skip，按 fail 处理
  const workdir = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-release-tarball-'))
  let exitCode = 0
  try {
    step(`comparing published registry tarballs against a local repack of this checkout (npm-cli.js: ${npmCli})`)
    for (const [name, packageDirName] of PACKAGES) { // ⑦ fail-fast：任一包 mismatch 即停
      const packageDir = join(REPO, 'packages', packageDirName)
      const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      step(`verifying ${name}@${version} …`)

      // ① registry tarball：npm pack <name>@<version>（凭据走 env，与 Publish 步同上下文）。
      const registryPackDest = join(workdir, `${name}-registry`)
      mkdirSync(registryPackDest, { recursive: true })
      const registryPack = await runNpm(npmCli, ['pack', `${name}@${version}`, '--pack-destination', registryPackDest], {
        cwd: workdir, timeoutMs: PACK_TIMEOUT_MS,
      })
      assert(registryPack.code === 0, `npm pack ${name}@${version} failed (exit ${registryPack.code}):\n${registryPack.out.slice(-2000)}`)
      const registryTgz = resolvePackedTarball(registryPack.out, registryPackDest)

      // ② 本地重打包：包目录 npm pack --ignore-scripts（用 Build 步已产出的 lib/，跳过 prepack）。
      const localPackDest = join(workdir, `${name}-repack`)
      mkdirSync(localPackDest, { recursive: true })
      const localPack = await runNpm(npmCli, ['pack', '--ignore-scripts', '--pack-destination', localPackDest], {
        cwd: packageDir, timeoutMs: PACK_TIMEOUT_MS,
      })
      assert(localPack.code === 0, `local npm pack for ${name} failed (exit ${localPack.code}):\n${localPack.out.slice(-2000)}`)
      const localTgz = resolvePackedTarball(localPack.out, localPackDest)
      step(`${name}: registry tgz=${registryTgz.split(/[\\/]/).pop()}, local repack tgz=${localTgz.split(/[\\/]/).pop()}`)

      // ③ 解包两份。
      const registryExtractDir = join(workdir, `${name}-registry-x`)
      const localExtractDir = join(workdir, `${name}-local-x`)
      mkdirSync(registryExtractDir, { recursive: true })
      mkdirSync(localExtractDir, { recursive: true })
      await extractTar(registryTgz, registryExtractDir)
      await extractTar(localTgz, localExtractDir)

      // ④⑤ 比对；差异清单写 stderr，任一包 mismatch 即停（fail-fast）。
      const diffs = compareTrees(registryExtractDir, localExtractDir)
      if (diffs.length > 0) {
        console.error(`[verify-release-tarball] MISMATCH: ${name}@${version}\n${diffs.map((d) => `  - ${d}`).join('\n')}`)
        exitCode = 1
        break
      }
      step(`${name}: published tarball == local repack (${listFiles(registryExtractDir).length} files, paths + bytes + manifest semantics)`)
    }
    if (exitCode === 0) step('ALL TARBALLS MATCH')
  } catch (error) {
    fail(error?.stack ?? String(error))
    exitCode = 1
  } finally {
    // ⑥ finally 删临时目录（先于退出执行）。
    try {
      rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed temp workdir ${workdir}`)
    } catch (error) {
      console.warn(`[verify-release-tarball] WARN: could not remove temp workdir ${workdir}: ${error?.message ?? error}`)
    }
  }
  process.exit(exitCode) // ⑤ exitCode=1（差异清单已在 stderr）保证 finally 清理已执行
}

main().catch((error) => {
  fail(error?.stack ?? String(error))
  process.exit(1)
})
