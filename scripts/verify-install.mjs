#!/usr/bin/env node
/**
 * verify-install.mjs — v0.1.0 发布门禁：干净安装冒烟（发布 ask ③）。
 *
 * 与 verify-load.mjs（全断言联调）的分工：本脚本只验证「发布形态的安装链路」——
 * 用户拿到本仓库后唯一需要的安装动作是一条 file: 安装命令：
 *
 *   ① 全新临时 DSH_HOME + 全新 profile（名字带随机后缀，永不与既有 profile 撞名）；
 *   ② `dsh plugin --profile <新> add file:<git-bundle 绝对路径>` —— 单一安装入口：
 *      git-bundle 薄包经 file: 依赖带入 host/client 两包（宿主 profile 用
 *      nodeLinker: hoisted，app-boot/src/profile.ts PROFILE_PNPM_WORKSPACE），
 *      reconcile 按 git-bundle 的 dsh.bundle 把两行 insert 追加进 dsh.profile.bundles
 *      （packages/boot/plugin-manager/src/operations.ts reconcile：只扫 profile 顶层
 *      dependencies —— git-bundle 是唯一顶层依赖）；
 *   ③ `dsh --profile <新> --dump-config` 断言 git/ui-git 两行
 *      （`id: dsh-plugin-git` 与 `id: dsh-plugin-client-ui-git`，且都在
 *      `# == @dsh-plugin/git-bundle` 层标签之下）；
 *   ④ boot web（`dsh --profile <新> --no-open --port 0`，runbook §2.1 实测命令形态；
 *      profile 需 dsh-web-app bundle 层——install 的 init 只给 dsh-base
 *      （official-bundles/src/bundles.ts:43-44），此为 profile 层用户文件补齐，
 *      与 verify-load 同一处理）；
 *   ⑤ workspaceOverride 经 profile 层 cordis.patch.yml 钉到临时真仓库 →
 *      `git/status` RPC 断言 ready（wire 形状注记：git/status 返回裸
 *      GitStatusSnapshot，无 {kind:'ready'} 包装——{kind} 只在 followStatus 帧与
 *      host 引擎内部 StatusAvailability 'ready'（status.ts:50）；本脚本按实形断言
 *      ok:true + born 分支全量字段，语义等价「仓库就绪」，与 verify-load 头注同口径）；
 *   ⑥ client 服务 HTML（认证后的 index）含两个包：__DSH_BOOT__ entries 有
 *      `@dsh-plugin/client-ui-git`（inject 边含 `@dsh-plugin/git`），HTML 文本同时
 *      出现两个包名；其 url 服务出的 bundle 带闭包工厂标记；
 *   ⑦ 清理：taskkill 宿主进程树 + 删临时 DSH_HOME 与夹具仓库（runbook §6.9），
 *      退出码 0；任何一步失败退出码 1 并打印诊断。
 *
 * 深度断言（提交链/图/AI 负往返等）归 verify-load.mjs 与 vitest 套件；本脚本是
 * 发布面最小闭环，跑在 `pnpm run verify:install` 门禁里。
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..')
const DSH_TREE = process.env.DSH_TREE ?? 'D:\\DeepSeekHarness'
const BOOT_TIMEOUT_MS = 180_000
const INSTALL_TIMEOUT_MS = 300_000
const DUMP_TIMEOUT_MS = 120_000
const PROFILE = `dshgit-install-${Date.now().toString(36)}`

const step = (message) => console.log(`[verify-install] ${message}`)
const fail = (message) => {
  console.error(`[verify-install] FAIL: ${message}`)
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** spawn once, capture output, enforce a timeout, kill the tree on timeout. */
function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const collect = (chunk) => { out += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      killTree(child.pid)
      resolveRun({ code: -1, out: `${out}\n[verify-install] process timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, out })
    })
  })
}

/** Windows process-tree kill (runbook §6.9: taskkill /PID /T /F). */
function killTree(pid) {
  if (!pid) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch { /* best effort */ }
}

/** Extract a balanced-brace JSON object starting at the first `{` after `marker`. */
function extractJsonAfter(text, marker) {
  const at = text.indexOf(marker)
  assert(at >= 0, `marker ${JSON.stringify(marker)} not found in served HTML`)
  const start = text.indexOf('{', at)
  assert(start >= 0, `no object after ${JSON.stringify(marker)}`)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  throw new Error(`unbalanced JSON after ${JSON.stringify(marker)}`)
}

/** POST one Connection unary RPC（client/rpc.ts 线格式，同 verify-load）。 */
async function rpcCall(origin, cookie, endpoint, args) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  const text = await response.text()
  assert(response.status === 200, `POST /api/${endpoint} → HTTP ${response.status}: ${text}`)
  const envelope = JSON.parse(text)
  assert(envelope?.type === 'server-response', `unexpected envelope type: ${JSON.stringify(envelope)?.slice(0, 200)}`)
  assert(envelope.rpcId === rpcId, `rpcId mismatch: sent ${rpcId}, got ${envelope.rpcId}`)
  return envelope.result
}

/** GET /?token=… → 303 + 浏览器 cookie（browser-auth.ts authorizeIndex）。 */
async function tokenQueryCookie(origin, token) {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  assert(response.status === 303, `index token exchange → HTTP ${response.status}（expected 303）`)
  const setCookie = response.headers.get('set-cookie')
  assert(typeof setCookie === 'string' && setCookie.length > 0, 'index token exchange returned no set-cookie')
  step('browser cookie acquired via /?token=')
  return setCookie.split(';', 1)[0]
}

/** GET /connect?token=… → 302 + API 操作员 cookie（browser-auth.ts:308-351）。 */
async function exchangeTokenForCookie(origin, token) {
  const response = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  assert(response.status === 302, `/connect token exchange → HTTP ${response.status}（expected 302）`)
  const setCookie = response.headers.get('set-cookie')
  assert(typeof setCookie === 'string' && setCookie.length > 0, '/connect returned no set-cookie')
  step('API operator cookie acquired via /connect')
  return setCookie.split(';', 1)[0]
}

function tail(text, limit = 2500) {
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

async function main() {
  // ── 0. 前置检查：dsh 树 + git-bundle 薄包 + 两包构建产物（② 的产物面）──
  const binTs = join(DSH_TREE, 'apps', 'cli', 'src', 'bin.ts')
  const bundleDir = join(REPO, 'git-bundle')
  const bundleManifestPath = join(bundleDir, 'package.json')
  const hostLib = join(REPO, 'packages', 'host', 'lib', 'index.js')
  const hostTypert = join(REPO, 'packages', 'host', 'lib', 'typert.host.js')
  const clientLib = join(REPO, 'packages', 'client-ui', 'lib', 'client.js')
  assert(existsSync(binTs), `dsh CLI entry missing: ${binTs}（env DSH_TREE 可改指向）`)
  assert(existsSync(bundleManifestPath), 'git-bundle thin package missing — it ships in the repo, this is a broken checkout')
  assert(existsSync(hostLib), `host lib missing: ${hostLib} — run \`pnpm run build\` first`)
  assert(existsSync(hostTypert), `generated host typert artifact missing: ${hostTypert} — run \`pnpm run build\` first`)
  assert(existsSync(clientLib), `client bundle missing: ${clientLib} — run \`pnpm run build\` first`)
  const bundleManifest = JSON.parse(readFileSync(bundleManifestPath, 'utf8'))
  assert(bundleManifest.name === '@dsh-plugin/git-bundle', `git-bundle manifest name wrong: ${bundleManifest.name}`)
  step(`dsh tree: ${DSH_TREE}; repo: ${REPO}; installing ${bundleManifest.name}@${bundleManifest.version}`)

  // status() 夹具：临时真仓库（真 git init + 一笔种子提交 ⇒ ready 快照分支字段可断言；
  // world 事实由本脚本的 git 命令铸造，RPC 只做只读消费）。
  const fixtureRepo = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-install-ws-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'install-user'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'install@example.com'], { cwd: fixtureRepo, stdio: 'ignore' })
  writeFileSync(join(fixtureRepo, 'seed.md'), 'dsh verify-install seed\n')
  execFileSync('git', ['add', 'seed.md'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'chore: verify-install seed'], { cwd: fixtureRepo, stdio: 'ignore' })
  const seedOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
  step(`fixture repo: ${fixtureRepo} (seed commit ${seedOid.slice(0, 7)})`)

  const home = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dsh-git-install-'))
  const env = { ...process.env, DSH_HOME: home }
  const cli = process.execPath
  const cliArgs = ['--import', 'tsx/esm', binTs]
  const profileDir = join(home, 'profiles', PROFILE)

  let host = null
  let exitCode = 1
  let hostOutput = ''
  try {
    // ── 1. 单一安装入口：dsh plugin --profile <新> add file:<git-bundle 绝对路径> ──
    const bundleSpec = `file:${bundleDir.replaceAll('\\', '/')}`
    step(`installing: dsh plugin --profile ${PROFILE} add ${bundleSpec}`)
    const install = await run(cli, [...cliArgs, 'plugin', '--profile', PROFILE, 'add', bundleSpec], {
      cwd: DSH_TREE, env, timeoutMs: INSTALL_TIMEOUT_MS,
    })
    assert(install.code === 0, `git-bundle install failed (exit ${install.code}):\n${install.out.slice(-2000)}`)
    step('installed git-bundle (exit 0)')

    // 安装事实：profile manifest 只记 git-bundle；node_modules（hoisted）里两包齐备。
    const profilePackageJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = profilePackageJson.dependencies ?? {}
    assert(deps['@dsh-plugin/git-bundle'] !== undefined,
      `profile dependencies missing @dsh-plugin/git-bundle: ${JSON.stringify(deps)}`)
    for (const name of ['@dsh-plugin/git', '@dsh-plugin/client-ui-git']) {
      assert(existsSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json')),
        `hoisted node_modules missing ${name} — the thin package did not bring the two real packages in`)
    }
    const bundles = profilePackageJson.dsh?.profile?.bundles
    assert(Array.isArray(bundles) && bundles.includes('@dsh-plugin/git-bundle'),
      `reconcile did not attach the git-bundle layer: ${JSON.stringify(profilePackageJson.dsh)}`)
    step(`profile recorded: dependencies=${JSON.stringify(Object.keys(deps))}, bundles=${JSON.stringify(bundles)}`)

    // web 宿主需要 dsh-web-app bundle 层（install init 只给 dsh-base，同 verify-load 处理）。
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      const baseAt = bundles.indexOf('@deepseek-ai/dsh-base')
      bundles.splice(baseAt + 1, 0, '@deepseek-ai/dsh-web-app')
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePackageJson, null, 2) + '\n')
      step(`profile bundles patched to include dsh-web-app: ${JSON.stringify(bundles)}`)
    }

    // workspaceOverride：profile 层补丁把 git 服务钉到夹具仓库（Windows 路径写正斜杠）。
    const overrideRow = [
      '# verify-install.mjs: pin the git service workspace to the fixture repository',
      '- id: dsh-plugin-git',
      '  config:',
      `    workspaceOverride: '${fixtureRepo.replaceAll('\\', '/')}'`,
      '',
    ].join('\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), overrideRow)
    step('profile cordis.patch.yml: workspaceOverride row written')

    // ── 2. --dump-config 断言 git/ui-git 两行（git-bundle 层标签之下）──
    const dump = await run(cli, [...cliArgs, '--profile', PROFILE, '--dump-config'], {
      cwd: DSH_TREE, env, timeoutMs: DUMP_TIMEOUT_MS,
    })
    assert(dump.code === 0, `--dump-config failed (exit ${dump.code}):\n${dump.out.slice(-2000)}`)
    const layerAt = dump.out.indexOf('# == @dsh-plugin/git-bundle')
    assert(layerAt >= 0, `dump-config has no @dsh-plugin/git-bundle layer label:\n${dump.out.slice(-1200)}`)
    const layerText = dump.out.slice(layerAt)
    assert(layerText.includes('id: dsh-plugin-git') && layerText.includes("name: '@dsh-plugin/git'"),
      `dump-config git-bundle layer lacks the git row:\n${layerText}`)
    assert(layerText.includes('id: dsh-plugin-client-ui-git') && layerText.includes("name: '@dsh-plugin/client-ui-git'"),
      `dump-config git-bundle layer lacks the ui-git row:\n${layerText}`)
    step('dump-config OK: git / ui-git two insert rows under the @dsh-plugin/git-bundle layer')

    // ── 3. boot web ──
    step('starting dsh web host…')
    host = spawn(cli, [...cliArgs, '--profile', PROFILE, '--no-open', '--port', '0'], {
      cwd: DSH_TREE, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    host.stdout.on('data', (c) => { hostOutput += c.toString('utf8') })
    host.stderr.on('data', (c) => { hostOutput += c.toString('utf8') })
    const bootLine = await new Promise((resolveBoot, rejectBoot) => {
      const timer = setTimeout(() => rejectBoot(new Error(`host boot timed out after ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS)
      host.stdout.on('data', function pump() {
        const match = hostOutput.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
        if (match) {
          clearTimeout(timer)
          host.stdout.off('data', pump)
          resolveBoot(match[1])
        }
      })
      host.on('exit', (code) => {
        clearTimeout(timer)
        rejectBoot(new Error(`host exited early (code ${code}):\n${hostOutput.slice(-3000)}`))
      })
    })
    const base = new URL(bootLine)
    const token = base.searchParams.get('token')
    step(`host booted: ${base.origin} (token acquired)`)

    assert(!/entry did not activate/.test(hostOutput), `host log reports "did not activate":\n${tail(hostOutput)}`)
    assert(!/failed to import/.test(hostOutput), `host log reports "failed to import":\n${tail(hostOutput)}`)
    assert(hostOutput.includes('[dsh-plugin-git] GitService active'),
      'GitService activation marker missing from host stdout — plugin did not activate')
    step('host load marker "[dsh-plugin-git] GitService active": present')

    // ── 4. client 服务 HTML 含两个包 ──
    const browserCookie = await tokenQueryCookie(base.origin, token)
    const indexResponse = await fetch(base.origin, { headers: { cookie: browserCookie }, redirect: 'manual' })
    assert(indexResponse.status === 200, `authenticated index returned ${indexResponse.status}`)
    const indexHtml = await indexResponse.text()
    assert(indexHtml.includes('@dsh-plugin/git') && indexHtml.includes('@dsh-plugin/client-ui-git'),
      'served index HTML does not contain both package names')
    const boot = extractJsonAfter(indexHtml, '__DSH_BOOT__')
    const entries = boot.entries ?? []
    const clientEntry = entries.find((entry) => entry.id === '@dsh-plugin/client-ui-git')
    assert(clientEntry !== undefined,
      `boot graph has no entry '@dsh-plugin/client-ui-git'; ids: ${JSON.stringify(entries.map((e) => e.id))}`)
    assert(Array.isArray(clientEntry.inject) && clientEntry.inject.includes('@dsh-plugin/git'),
      `client entry inject edges missing '@dsh-plugin/git': ${JSON.stringify(clientEntry.inject)}`)
    const bundleResponse = await fetch(new URL(clientEntry.url, base.origin), { headers: { cookie: browserCookie } })
    assert(bundleResponse.status === 200, `client bundle fetch ${clientEntry.url} → ${bundleResponse.status}`)
    const bundleBody = await bundleResponse.text()
    assert(bundleBody.includes('__ModuleLoader__'), 'served client bundle lacks the closure-factory marker')
    step(`served HTML contains both packages; client bundle served (${bundleBody.length} bytes, closure factory)`)

    // ── 5. git/status RPC：workspaceOverride 夹具仓库的 ready 快照 ──
    const apiCookie = await exchangeTokenForCookie(base.origin, token)
    const ping = await rpcCall(base.origin, apiCookie, 'git/ping', {})
    assert(ping.ok === true && /^git version \S+/.test(ping.value?.gitVersion ?? ''),
      `git/ping failed: ${JSON.stringify(ping)}`)
    step(`ping RPC OK: ${ping.value.gitVersion}`)
    const status = await rpcCall(base.origin, apiCookie, 'git/status', {})
    assert(status.ok === true, `git/status failed: ${JSON.stringify(status)}`)
    const snapshot = status.value ?? {}
    const branch = snapshot.branch ?? {}
    const fixtureReal = fixtureRepo.replaceAll('\\', '/')
    assert(branch.name === 'main', `ready snapshot should be on 'main': ${JSON.stringify(branch)}`)
    assert(branch.oid === seedOid, `branch.oid should equal the world-read seed HEAD: ${branch.oid} vs ${seedOid}`)
    assert(typeof branch.abbrevOid === 'string' && /^[0-9a-f]{7}$/.test(branch.abbrevOid),
      `branch.abbrevOid should be a 7-char short oid: ${JSON.stringify(branch)}`)
    assert(branch.unborn === false && branch.detached === false && branch.upstream === null,
      `seeded repo should be born/attached/no-upstream: ${JSON.stringify(branch)}`)
    assert(snapshot.clean === true
      && snapshot.staged?.length === 0 && snapshot.unstaged?.length === 0 && snapshot.untracked?.length === 0,
      `seeded fixture repo should be clean: ${JSON.stringify(snapshot)}`)
    assert(typeof snapshot.repoRoot === 'string'
      && snapshot.repoRoot.toLowerCase().replace(/\\/g, '/') === fixtureReal.toLowerCase().replace(/\\/g, '/'),
      `git/status repoRoot should be the pinned fixture repo: ${JSON.stringify(snapshot.repoRoot)} vs ${fixtureReal}`)
    step(`status RPC OK: ready snapshot on 'main' @ ${branch.abbrevOid}, clean, repoRoot=${snapshot.repoRoot}`)

    exitCode = 0
    step('ALL CHECKS PASSED')
  } catch (error) {
    fail(error?.message ?? String(error))
    if (hostOutput) console.error(`---- host output tail ----\n${tail(hostOutput, 4000)}`)
  } finally {
    // ── 6. 清理进程与临时目录（runbook §6.9）──
    if (host?.pid && host.exitCode === null) {
      step(`stopping host pid ${host.pid} (taskkill /T /F)`)
      killTree(host.pid)
      await new Promise((resolveExit) => {
        const t = setTimeout(resolveExit, 10_000)
        host.on('exit', () => { clearTimeout(t); resolveExit() })
      })
    }
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed temp DSH_HOME ${home}`)
    } catch (error) {
      console.warn(`[verify-install] WARN: could not remove temp home ${home}: ${error?.message ?? error}`)
    }
    try {
      rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed fixture repo ${fixtureRepo}`)
    } catch (error) {
      console.warn(`[verify-install] WARN: could not remove fixture repo ${fixtureRepo}: ${error?.message ?? error}`)
    }
  }
  process.exit(exitCode)
}

main().catch((error) => {
  fail(error?.stack ?? String(error))
  process.exit(1)
})
