#!/usr/bin/env node
/**
 * verify-load.mjs — 真实 dsh 宿主装载验证（runbook §5 作业单的自包含版）。
 *
 * 依据 research/notes/real-host-install-startup-test.md（任务口径的
 * host-debug-runbook.md 不存在 —— map ⑧.1，本脚本按其正对本 runbook 的第⑤节施工）：
 *   ① 隔离 DSH_HOME（mktemp），`dsh plugin --profile <dbg> add file:<包>` 安装两个包
 *      （通道 A 生产形态，file: 零下载）；
 *   ② 启动真实 web 宿主 `node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 0`
 *      （runbook §2.1 实测命令；--port 0 = 随机，runbook §2.2）；
 *   ③ 断言：
 *      A. 两个包安装 exit 0 且 profile package.json 记入 dependencies；
 *      B. boot 日志打印 `dsh web: http://…/?token=…`，且无 "did not activate" / "failed to import"；
 *      C. client 半进入 `window.__DSH_BOOT__` 花名册（entry id = 包名，
 *         packages/client/modules/src/client/manifest.ts:52-54），其 url 服务出的 bundle
 *         含闭包工厂标记、按钮注册代码与生成的 remote 描述符（#git/ping、#git/identity）；
 *      D. ping RPC 往返：POST /api/git/ping（API 操作员 cookie 经 /connect?token=
 *         换取 —— packages/client/connection/src/index.ts:160-166、browser-auth.ts:308-351；
 *         线格式照 packages/client/connection/src/client/rpc.ts:41-56）返回
 *         {ok:true, gitVersion:"git version …"}；
 *      E. identity RPC 往返（remote 地基模块）：profile 层 cordis.patch.yml 把
 *         `workspaceOverride` 钉到临时真仓库 → `git/identity` 返回该仓库本地
 *         user.name/email（world 重读比对）、workspace/workspaceSource 字段；scope
 *         参数过线（带参方法往返）；
 *      F. strict 注册判别（§⑧-2 动态安装链路）：生成产物 lib/typert.host.js 经
 *         typert-loader 自动注册后，非法 scope 值被 strict codec 在网关拒绝为
 *         `gateway/input-invalid`（SRC 反射兜底下会放行到方法内 → git/git-error，
 *         gateway/src/index.ts decode 分支）——以此证明生成产物经 file: 安装在
 *         真宿主动态注册成功；
 *      G. 反向：POST /api/git/<未知端点> 返回 ok:false + gateway/invocation-unavailable
 *         （packages/api/gateway/src/index.ts:908-910），证明派发层真实解析了 git 命名空间。
 *      H. client 地基模块：bundle 内联装配骨架与状态源数据面——GitHeaderButton 注册
 *         id（dsh-plugin.git.header）、两个右栏 tab kind、生成的 git/status 与
 *         git/followStatus 描述符、基线 store 引擎的注入 require、zh 词典词条；并跑
 *         `git/status` RPC 往返（夹具仓库钉死 workspaceOverride）断言 unborn 快照
 *         （[清单 64]）与 repoRoot 投影。
 *      I. F 变更面板模块：bundle 内联变更审查 tab body——会话域地址前缀
 *         （dsh-resource://git-changes/session/）、keyed 注册 key（dsh-plugin.git.changes）、
 *         变更卡片/diff 视图 data 锚、ui-primitives 基线 require（useCodeHighlighter）、
 *         changes/diff 词典词条。
 *      J. ④-K 提交对话框模块：bundle 内联提交对话框——portal 背板 data 锚
 *         （data-git-commit-dialog）、消息编辑器锚、aria-keyshortcuts 快捷键组、
 *         commit.* 词典词条（AI 生成/修订/提交并推送）、生成的 git/commit、git/push、
 *         git/generateCommitMessage 描述符；
 *      K. 提交链路 RPC 往返（M11 全断言的闭环半）：workspaceOverride 钉住的夹具仓库
 *         **带一笔种子提交**（分支字段全量可断言）→ git/status 返回 ok:true（ready，
 *         即 host StatusEngine availability='ready' 的 wire 投影——wire 形状是裸
 *         GitStatusSnapshot，无 {kind} 包装，见文件头注记）与分支字段（name/oid/
 *         abbrevOid/upstream/ahead/behind/detached/unborn）→ git/stage + git/status
 *         （staged=1/clean=false）→ git/generateCommitMessage 负往返（无路由 ⇒
 *         git/llm-route-unresolved，端点已服务的域错误路径）→ git/commit 成功且
 *         **world 重读**（execFileSync git log -1 比对 oid/subject）→ git/status
 *         （oid 前进、clean 回真）→ git/commit 空 staged ⇒ git/nothing-staged
 *         （[清单 11] 守卫的真实宿主面）→ git/log({limit:1}) 返回新 HEAD（amend
 *         预填数据面）。
 *
 *   ④ 结束清理：taskkill 宿主进程树 + 删临时 DSH_HOME（runbook §6.9 清理纪律）。
 *
 * 退出码：全部断言通过 = 0；任何一步失败 = 1（打印宿主输出尾部诊断）。
 *
 * 注记（ask ④ 口径与 wire 实形的差异，不硬凑）：ask 写「status() 断言 {kind:'ready'}」，
 * 但 wire 上 git/status 返回裸 GitStatusSnapshot（packages/host/src/types.ts:89 无 kind
 * 字段；{kind} 形状只存在于 followStatus 帧 GitStatusFrame.kind='status' 与 host 引擎
 * 内部 StatusAvailability 'ready'，status.ts:50）。本脚本按实形断言 ok:true + 全量
 * 快照字段，语义等价（仓库就绪 + 分支字段），差异已记 ModuleResult openIssues。
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..')
const DSH_TREE = process.env.DSH_TREE ?? 'D:\\DeepSeekHarness'
const PROFILE = 'dshgit-verify'
const BOOT_TIMEOUT_MS = 180_000
const INSTALL_TIMEOUT_MS = 300_000

const step = (message) => console.log(`[verify] ${message}`)
const fail = (message) => {
  console.error(`[verify] FAIL: ${message}`)
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
      resolveRun({ code: -1, out: `${out}\n[verify] process timed out after ${timeoutMs}ms` })
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
  assert(at >= 0, `marker ${JSON.stringify(marker)} not found`)
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

async function main() {
  // ── 0. 前置检查 ──────────────────────────────────────────────
  const binTs = join(DSH_TREE, 'apps', 'cli', 'src', 'bin.ts')
  const hostPkgDir = join(REPO, 'packages', 'host')
  const hostLib = join(hostPkgDir, 'lib', 'index.js')
  const hostTypert = join(hostPkgDir, 'lib', 'typert.host.js')
  const hostRemoteClient = join(hostPkgDir, 'lib', 'typert.remote-client.js')
  const hostPatch = join(REPO, 'packages', 'host', 'cordis.patch.yml')
  const clientPkg = join(REPO, 'packages', 'client-ui')
  const clientLib = join(clientPkg, 'lib', 'client.js')
  assert(existsSync(binTs), `dsh CLI entry missing: ${binTs}（env DSH_TREE 可改指向）`)
  assert(existsSync(hostLib), `host lib missing: ${hostLib} — run \`pnpm build\` first`)
  assert(existsSync(hostTypert), `generated host typert artifact missing: ${hostTypert} — run \`pnpm build\` first`)
  assert(existsSync(hostRemoteClient), `generated remote-client artifact missing: ${hostRemoteClient} — run \`pnpm build\` first`)
  assert(readFileSync(hostPatch, 'utf8').includes("name: '@dsh-plugin/git'"), 'host cordis.patch.yml mismatch')
  step(`dsh tree: ${DSH_TREE}; repo: ${REPO}`)

  // status/commit 往返夹具：临时真仓库 + 本地身份 + 一笔种子提交（M11 全断言：
  // 分支字段全量可断言 —— unborn 空仓库断言（④-E H 段）按 ask ④ 的「ready + 分支
  // 字段」口径替换；unborn 形状仍由 host tests/status.spec [清单 64] 真仓库覆盖）。
  const fixtureRepo = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-verify-ws-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'verify-user'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'verify@example.com'], { cwd: fixtureRepo, stdio: 'ignore' })
  writeFileSync(join(fixtureRepo, 'seed.md'), 'dsh verify-load seed\n')
  execFileSync('git', ['add', 'seed.md'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'chore: verify-load seed'], { cwd: fixtureRepo, stdio: 'ignore' })
  const seedOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
  step(`identity fixture repo: ${fixtureRepo} (seed commit ${seedOid.slice(0, 7)}, local user verify-user <verify@example.com>)`)

  const home = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dsh-git-verify-'))
  const env = { ...process.env, DSH_HOME: home }
  const cli = process.execPath
  const cliArgs = ['--import', 'tsx/esm', binTs]
  const profileDir = join(home, 'profiles', PROFILE)

  let host = null
  let exitCode = 1
  let hostOutput = ''
  try {
    // ── 1. 通道 A 安装（runbook §3.A：file: 安装零下载，reconcile 自动挂 bundles）──
    for (const [label, dir] of [['host @dsh-plugin/git', hostPkgDir], ['client @dsh-plugin/client-ui-git', clientPkg]]) {
      step(`installing ${label}: dsh plugin --profile ${PROFILE} add file:${dir.replaceAll('\\', '/')}`)
      const spec = `file:${dir.replaceAll('\\', '/')}`
      const install = await run(cli, [...cliArgs, 'plugin', '--profile', PROFILE, 'add', spec], {
        cwd: DSH_TREE, env, timeoutMs: INSTALL_TIMEOUT_MS,
      })
      assert(install.code === 0, `install failed for ${label} (exit ${install.code}):\n${install.out.slice(-2000)}`)
      step(`installed ${label} (exit 0)`)
    }
    const profilePackageJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = profilePackageJson.dependencies ?? {}
    assert(deps['@dsh-plugin/git'] !== undefined, `profile dependencies missing @dsh-plugin/git: ${JSON.stringify(deps)}`)
    assert(deps['@dsh-plugin/client-ui-git'] !== undefined, `profile dependencies missing @dsh-plugin/client-ui-git: ${JSON.stringify(deps)}`)
    // dsh plugin add 的 init 只给 DEFAULT_PROFILE_BUNDLES = [dsh-base]
    // （packages/util/official-bundles/src/bundles.ts:43-44 实读）；web 宿主需要 shipped
    // web 模板的 [dsh-base, dsh-web-app]（bundles.ts:18-21）。profile manifest 是用户层文件
    // （runbook §3.D），在此补齐 web-app bundle 层。
    const bundles = profilePackageJson.dsh?.profile?.bundles
    assert(Array.isArray(bundles), `profile dsh.profile.bundles missing: ${JSON.stringify(profilePackageJson.dsh)}`)
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      const baseAt = bundles.indexOf('@deepseek-ai/dsh-base')
      bundles.splice(baseAt + 1, 0, '@deepseek-ai/dsh-web-app')
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePackageJson, null, 2) + '\n')
      step(`profile bundles patched to include dsh-web-app: ${JSON.stringify(bundles)}`)
    }
    step('profile dependencies recorded for both packages')

    // ── 1.5 profile 层补丁：把 git 服务的 workspaceOverride 钉到夹具仓库
    //        （map §1.4：profile 层按 id 覆盖行、config 整块替换，其余键回落 schema 默认）。
    //        Windows 路径写成正斜杠，避开 YAML 反斜杠转义。
    const profilePatchPath = join(profileDir, 'cordis.patch.yml')
    const overrideRow = [
      '# verify-load.mjs: pin the git service workspace to the fixture repository',
      '- id: dsh-plugin-git',
      '  config:',
      `    workspaceOverride: '${fixtureRepo.replaceAll('\\', '/')}'`,
      '',
    ].join('\n')
    const existingPatch = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : ''
    // initProfile 可能留下空补丁（`[]` 或纯注释/空白）——空列表后直接续写条目是非法
    // YAML（宿主 parsePatchList 实测报 "document separator is expected"），此处整体替换。
    const stripped = existingPatch.split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line.length > 0)
      .join('\n')
    if (stripped === '' || stripped === '[]') {
      writeFileSync(profilePatchPath, overrideRow)
      step('profile cordis.patch.yml: empty patch replaced with the workspaceOverride row')
    } else {
      writeFileSync(profilePatchPath, existingPatch.endsWith('\n') || existingPatch === ''
        ? existingPatch + overrideRow
        : `${existingPatch}\n${overrideRow}`)
      step('profile cordis.patch.yml: workspaceOverride row appended')
    }

    // ── 2. 启动真实 web 宿主。CLI 语法（apps/cli/src/args.ts:9-13 实读）：
    //        `dsh web` 是 `--profile web` 的缩写；显式 --profile dbg 时不能再写 'web' 词
    //        （它会变成内层 app 参数 → "too many arguments"——首跑实测踩坑），
    //        app 由 profile 的 dsh-web-app bundle 层挂载，--no-open/--port 是内层 app flags。──
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

    // ── 3. 断言 B：无装载失败标记（runbook §5.4 反向判据）──
    assert(!/entry did not activate/.test(hostOutput), `host log reports "did not activate":\n${tail(hostOutput)}`)
    assert(!/failed to import/.test(hostOutput), `host log reports "failed to import":\n${tail(hostOutput)}`)
    const constructed = hostOutput.includes('[dsh-plugin-git] GitService active')
    step(`host load marker "[dsh-plugin-git] GitService active": ${constructed ? 'present' : 'ABSENT'}`)
    assert(constructed, 'GitService activation marker missing from host stdout — plugin did not activate')

    // ── 4. 断言 C：client 半进入 boot 花名册 + bundle 被服务 ──
    // 浏览器 cookie 与 API cookie 是两种凭据（browser-auth.ts 实读）：index 的
    // 浏览器 cookie 由 GET /?token= 铸造（authorizeIndex → 303）；/api 的操作员
    // cookie 由 GET /connect?token= 铸造（version 2）。
    const browserCookie = await tokenQueryCookie(base.origin, token)
    const indexResponse = await fetch(base.origin, { headers: { cookie: browserCookie }, redirect: 'manual' })
    assert(indexResponse.status === 200, `authenticated index returned ${indexResponse.status}`)
    const indexHtml = await indexResponse.text()
    const boot = extractJsonAfter(indexHtml, '__DSH_BOOT__')
    const entries = boot.entries ?? []
    const clientEntry = entries.find((entry) => entry.id === '@dsh-plugin/client-ui-git')
    assert(clientEntry !== undefined,
      `boot graph has no entry '@dsh-plugin/client-ui-git'; ids: ${JSON.stringify(entries.map((e) => e.id))}`)
    assert(Array.isArray(clientEntry.inject) && clientEntry.inject.includes('@dsh-plugin/git'),
      `client entry inject edges missing '@dsh-plugin/git': ${JSON.stringify(clientEntry.inject)}`)
    step(`boot graph: client entry present (rev ${clientEntry.rev}), inject edges: ${JSON.stringify(clientEntry.inject)}`)
    const bundleResponse = await fetch(new URL(clientEntry.url, base.origin), { headers: { cookie: browserCookie } })
    assert(bundleResponse.status === 200, `client bundle fetch ${clientEntry.url} → ${bundleResponse.status}`)
    const bundleBody = await bundleResponse.text()
    assert(bundleBody.includes('__ModuleLoader__'), 'served client bundle lacks the closure-factory marker')
    assert(bundleBody.includes('conversation.session.header.utilities'), 'served client bundle lacks the header-utilities registration')
    // 生成产物内联判据（remote 地基模块）：client 半挂的是 typert-generator 生成的
    // 描述符（生成物里 package 字段与 `"git/<method>"` 方法键分立，id 由
    // createTypertRemoteInfo 在运行时以 `${package}#${endpoint}` 拼出）。
    assert(bundleBody.includes('"@dsh-plugin/git"'), 'client bundle lacks the generated remote package field')
    assert(bundleBody.includes('"git/ping"'), 'client bundle lacks the generated git/ping method descriptor')
    assert(bundleBody.includes('"git/identity"'), 'client bundle lacks the generated git/identity method descriptor')
    // client 地基模块断言：装配骨架 + 状态源数据面 + 词典。
    assert(bundleBody.includes('"git/status"'), 'client bundle lacks the generated git/status method descriptor')
    assert(bundleBody.includes('"git/followStatus"'), 'client bundle lacks the generated git/followStatus stream descriptor')
    assert(bundleBody.includes('dsh-plugin.git.header'), 'client bundle lacks the GitHeaderButton registration id (dsh-plugin.git.header)')
    assert(bundleBody.includes('conversation.session.header.utilities'), 'client bundle lacks the header-utilities slot key')
    assert(bundleBody.includes('dsh-resource://git-changes/session/'), 'client bundle lacks the changes tab resource address prefix (F 变更面板: dsh-resource://git-changes/session/{id})')
    assert(bundleBody.includes('"git-changes"') && bundleBody.includes('"git-graph"'), 'client bundle lacks the two sidebar tab type kinds')
    assert(bundleBody.includes('require("@deepseek-ai/dsh-client-store")')
      || bundleBody.includes("require('@deepseek-ai/dsh-client-store')"),
    'client bundle does not consume the baseline store engine via injected require')
    assert(bundleBody.includes('处变更') && bundleBody.includes('不是 git 仓库'),
      'client bundle lacks the zh locale dictionary entries (header.badge / header.noRepo)')
    // F 变更面板模块断言：tab body 注册、diff 渲染底座、ui-primitives 基线、词典新键组。
    assert(bundleBody.includes('dsh-plugin.git.changes'), 'client bundle lacks the changes tab body registration key')
    assert(bundleBody.includes('data-git-change-card'), 'client bundle lacks the ChangeCard data anchor')
    assert(bundleBody.includes('data-git-diff-line'), 'client bundle lacks the FileDiffView diff row anchor')
    assert(bundleBody.includes('require("@deepseek-ai/dsh-client-ui-primitives")')
      || bundleBody.includes("require('@deepseek-ai/dsh-client-ui-primitives')"),
    'client bundle does not consume dsh-client-ui-primitives (useCodeHighlighter) via injected require')
    assert(bundleBody.includes('已暂存') && bundleBody.includes('差异加载中'),
      'client bundle lacks the changes/diff zh dictionary entries (changes.staged / diff.loading)')
    // ④-K 提交对话框模块断言（J）：对话框 portal 背板/编辑器锚、快捷键组、词典、生成描述符。
    assert(bundleBody.includes('data-git-commit-dialog'), 'client bundle lacks the commit dialog portal backdrop anchor')
    assert(bundleBody.includes('data-git-commit-editor'), 'client bundle lacks the commit message editor anchor')
    assert(bundleBody.includes('data-git-commit-portal'), 'client bundle does not mount a self-built portal host (ask ① portal 自建)')
    assert(bundleBody.includes('aria-keyshortcuts'), 'client bundle lacks the aria-keyshortcuts shortcut set (ask ②)')
    assert(bundleBody.includes("'Control+Enter Meta+Enter'") || bundleBody.includes('"Control+Enter Meta+Enter"'),
      'client bundle lacks the Ctrl/Cmd+Enter shortcut string')
    assert(bundleBody.includes('AI 生成') && bundleBody.includes('修订上一次提交') && bundleBody.includes('提交并推送'),
      'client bundle lacks the commit.* zh dictionary entries (commit.generate / commit.amend / commit.commitPush)')
    assert(bundleBody.includes('"git/commit"'), 'client bundle lacks the generated git/commit method descriptor')
    assert(bundleBody.includes('"git/push"'), 'client bundle lacks the generated git/push method descriptor')
    assert(bundleBody.includes('"git/generateCommitMessage"'), 'client bundle lacks the generated git/generateCommitMessage method descriptor')
    step(`client bundle served (${bundleBody.length} bytes, closure factory + header registration + generated remote descriptors + locale verified)`)

    // ── 5. 断言 D：ping RPC 往返（runbook §2.3 token fence → API cookie）──
    const apiCookie = await exchangeTokenForCookie(base.origin, token)
    const pingResult = await rpcCall(base.origin, apiCookie, 'git/ping', {})
    assert(pingResult.ok === true, `git/ping failed: ${JSON.stringify(pingResult)}`)
    const gitVersion = pingResult.value?.gitVersion
    assert(typeof gitVersion === 'string' && /^git version \S+/.test(gitVersion),
      `git/ping returned unexpected value: ${JSON.stringify(pingResult)}`)
    const localGit = await run('git', ['--version'], { cwd: REPO, env: process.env, timeoutMs: 15_000 })
    step(`ping RPC round-trip OK: gitVersion=${JSON.stringify(gitVersion)} (local \`git --version\`: ${localGit.out.trim()})`)

    // ── 5.5 断言 E：identity RPC 往返（带参方法；workspaceOverride → 夹具仓库本地身份）。
    const identity = await rpcCall(base.origin, apiCookie, 'git/identity', {})
    assert(identity.ok === true, `git/identity (no args) failed: ${JSON.stringify(identity)}`)
    assert(identity.value?.name === 'verify-user' && identity.value?.email === 'verify@example.com',
      `git/identity returned unexpected identity: ${JSON.stringify(identity)}`)
    assert(identity.value?.complete === true && Array.isArray(identity.value?.missing) && identity.value.missing.length === 0,
      `git/identity completeness wrong: ${JSON.stringify(identity)}`)
    assert(identity.value?.workspaceSource === 'workspace-override',
      `git/identity workspaceSource should be workspace-override: ${JSON.stringify(identity)}`)
    const fixtureReal = fixtureRepo.replaceAll('\\', '/')
    assert(typeof identity.value?.workspace === 'string' && identity.value.workspace.toLowerCase().replace(/\\/g, '/') === fixtureReal.toLowerCase().replace(/\\/g, ''),
      `git/identity workspace should resolve to the fixture repo: ${JSON.stringify(identity.value?.workspace)} vs ${fixtureReal}`)
    step(`identity RPC round-trip OK: name=verify-user email=verify@example.com workspace=${identity.value.workspace}`)

    // scope 参数显式过线（strict 描述符 codec：z.literal 联合）。
    const identityLocal = await rpcCall(base.origin, apiCookie, 'git/identity', { scope: 'local' })
    assert(identityLocal.ok === true && identityLocal.value?.name === 'verify-user' && identityLocal.value?.email === 'verify@example.com',
      `git/identity(scope=local) failed: ${JSON.stringify(identityLocal)}`)
    step('identity RPC scope=local OK (parameter traversed the wire)')

    // ── 5.7 断言 K（④-K 提交对话框模块，M11 全断言）：status RPC 往返 = 状态源的
    //        数据面真值 + 提交链路闭环。夹具仓库带一笔种子提交 ⇒ 快照 ready（ok:true
    //        ——wire 为裸 GitStatusSnapshot，无 {kind} 包装，见文件头注记），分支字段
    //        全量断言：main / 40hex oid / 7 位短 oid / 无 upstream / ahead=behind=null /
    //        非 detached / 非 unborn / clean。
    const status = await rpcCall(base.origin, apiCookie, 'git/status', {})
    assert(status.ok === true, `git/status failed: ${JSON.stringify(status)}`)
    const snapshot = status.value ?? {}
    const branch = snapshot.branch ?? {}
    assert(branch.name === 'main', `git/status branch.name should be 'main': ${JSON.stringify(branch)}`)
    assert(typeof branch.oid === 'string' && /^[0-9a-f]{40}$/.test(branch.oid),
      `git/status branch.oid should be a full 40-hex oid: ${JSON.stringify(branch)}`)
    assert(typeof branch.abbrevOid === 'string' && /^[0-9a-f]{7}$/.test(branch.abbrevOid),
      `git/status branch.abbrevOid should be a 7-char short oid: ${JSON.stringify(branch)}`)
    assert(branch.unborn === false && branch.detached === false,
      `seeded repo should be on a born, attached branch: ${JSON.stringify(branch)}`)
    assert(branch.upstream === null && branch.ahead === null && branch.behind === null,
      `seeded repo has no remote, so upstream/ahead/behind should be null: ${JSON.stringify(branch)}`)
    assert(Array.isArray(snapshot.staged) && snapshot.staged.length === 0
      && Array.isArray(snapshot.unstaged) && snapshot.unstaged.length === 0
      && Array.isArray(snapshot.untracked) && snapshot.untracked.length === 0
      && Array.isArray(snapshot.conflicted) && snapshot.conflicted.length === 0,
      `seeded fixture repo should start clean: ${JSON.stringify(snapshot)}`)
    assert(snapshot.clean === true, `seeded fixture repo should be clean: ${JSON.stringify(snapshot)}`)
    assert(typeof snapshot.repoRoot === 'string'
      && snapshot.repoRoot.toLowerCase().replace(/\\/g, '/') === fixtureReal.toLowerCase().replace(/\\/g, '/'),
      `git/status repoRoot should be the pinned fixture repo: ${JSON.stringify(snapshot.repoRoot)} vs ${fixtureReal}`)
    assert(branch.oid === seedOid, `branch.oid should equal the world-read seed HEAD: ${branch.oid} vs ${seedOid}`)
    step(`status RPC round-trip OK: ready snapshot on 'main' @ ${branch.abbrevOid}, clean, repoRoot=${snapshot.repoRoot}`)

    // ── 5.8 K 链路半：stage → AI 负往返（无路由）→ commit → world 重读 → status →
    //        空 staged 守卫 → log(limit:1)（amend 预填数据面）。
    writeFileSync(join(fixtureRepo, 'chain.txt'), 'dsh verify-load commit chain\n')
    const staged = await rpcCall(base.origin, apiCookie, 'git/stage', { paths: ['chain.txt'] })
    assert(staged.ok === true && staged.value?.staged === 1, `git/stage failed: ${JSON.stringify(staged)}`)
    const stagedStatus = await rpcCall(base.origin, apiCookie, 'git/status', {})
    assert(stagedStatus.ok === true && stagedStatus.value?.staged?.length === 1 && stagedStatus.value?.clean === false,
      `post-stage status should show 1 staged entry and clean=false: ${JSON.stringify(stagedStatus.value)}`)
    step('stage RPC round-trip OK: world-visible staged entry (clean=false)')

    // AI 生成负往返：本环境无 llm 路由（Config.llmProvider/llmModel 空 + 无 request/header
    // 捕获），nothing-staged 前置已过（有 staged diff）⇒ 确定性 git/llm-route-unresolved
    // ——证明端点被真实派发且域错误过线（M7 路由解析链的真宿主面）。
    const generate = await rpcCall(base.origin, apiCookie, 'git/generateCommitMessage', {})
    assert(generate.ok === false, `git/generateCommitMessage unexpectedly succeeded: ${JSON.stringify(generate)}`)
    assert(generate.error?.code === 'git/llm-route-unresolved',
      `expected git/llm-route-unresolved (no LLM route in this environment), got ${JSON.stringify(generate.error)}`)
    step('generateCommitMessage negative round-trip OK: git/llm-route-unresolved (endpoint served, domain error crosses the wire)')

    // git/commit 的 wire 形状：strict 描述符按**命名参数**封装（参数名 options——
    // gateway/arguments-invalid 报文实测口径），client 代理由 typert 运行时折算；
    // 本脚本的裸 RPC 直接给 { options: CommitOptions }。
    const commitMessage = 'feat: verify-load commit chain'
    const commit = await rpcCall(base.origin, apiCookie, 'git/commit', {
      options: { message: commitMessage, amend: false, skipHooks: false },
    })
    assert(commit.ok === true, `git/commit failed: ${JSON.stringify(commit)}`)
    const commitValue = commit.value ?? {}
    assert(typeof commitValue.oid === 'string' && /^[0-9a-f]{40}$/.test(commitValue.oid),
      `commit result should carry a full oid: ${JSON.stringify(commitValue)}`)
    assert(commitValue.branch === 'main' && commitValue.amended === false,
      `commit result metadata wrong: ${JSON.stringify(commitValue)}`)
    assert(commitValue.message === commitMessage,
      `commit result message should round-trip: ${JSON.stringify(commitValue)}`)
    // world 重读（spec §6 断言纪律）：独立 git log 比对，不信 RPC 自述。
    const worldHead = execFileSync('git', ['-C', fixtureRepo, 'log', '-1', '--format=%H%x00%s'], { encoding: 'utf8' })
    const [worldOid, worldSubject] = worldHead.trim().split('\0')
    assert(worldOid === commitValue.oid && worldSubject === commitMessage,
      `world re-read mismatch: git log says ${worldOid} ${JSON.stringify(worldSubject)}, RPC said ${commitValue.oid} ${JSON.stringify(commitValue.message)}`)
    step(`commit RPC round-trip OK: ${commitValue.shortOid} on 'main', world re-read matches (git log -1)`)

    const afterCommit = await rpcCall(base.origin, apiCookie, 'git/status', {})
    assert(afterCommit.ok === true && afterCommit.value?.clean === true
      && afterCommit.value?.branch?.oid === commitValue.oid,
      `post-commit status should be clean at the new oid: ${JSON.stringify(afterCommit.value)}`)
    step(`status after commit OK: clean at ${afterCommit.value?.branch?.abbrevOid} (R3 失效后新快照)`)

    // [清单 11] 空提交守卫的真宿主面：clean 仓库上 commit ⇒ git/nothing-staged。
    const emptyCommit = await rpcCall(base.origin, apiCookie, 'git/commit', {
      options: { message: 'feat: should never land', amend: false, skipHooks: false },
    })
    assert(emptyCommit.ok === false && emptyCommit.error?.code === 'git/nothing-staged',
      `empty-staged commit should be rejected with git/nothing-staged, got ${JSON.stringify(emptyCommit)}`)
    step('empty-commit guard OK: clean repo rejects commit with git/nothing-staged ([清单 11])')

    // amend 预填数据面：log({limit:1}) 返回新 HEAD（client headCommit 折算的数据源）。
    // wire 形状同 git/commit：参数名 options（命名参数封装）。
    const headPage = await rpcCall(base.origin, apiCookie, 'git/log', { options: { limit: 1, skip: 0 } })
    assert(headPage.ok === true && headPage.value?.commits?.length === 1
      && headPage.value.commits[0]?.oid === commitValue.oid
      && headPage.value.commits[0]?.subject === commitMessage,
      `git/log(limit:1) should return the new HEAD: ${JSON.stringify(headPage)}`)
    step('log(limit:1) OK: amend-prefill data plane returns the new HEAD commit')

    // ── 5.6 断言 F：strict 注册判别（§⑧-2 动态安装链路）。
    //        生成产物 lib/typert.host.js 经 typert-loader 自动注册后，scope 的
    //        strict codec 在网关拒绝非法值为 gateway/input-invalid；若仍是 SRC
    //        反射兜底，该值会穿过网关进方法 → git/git-error。
    const strictProbe = await rpcCall(base.origin, apiCookie, 'git/identity', { scope: 'not-a-scope' })
    assert(strictProbe.ok === false, `git/identity(scope=<invalid>) unexpectedly succeeded: ${JSON.stringify(strictProbe)}`)
    assert(strictProbe.error?.code === 'gateway/input-invalid',
      `expected gateway/input-invalid (strict descriptor registered), got ${JSON.stringify(strictProbe.error)} — ` +
      'the generated ./typert artifact was NOT registered (SRC fallback is active)')
    step('strict descriptor registered OK: invalid scope rejected as gateway/input-invalid (typert-loader auto-registration works)')

    // ── 6. 断言 E：未知端点不被服务（证明 /api 路由表真实解析了 git 命名空间）。
    //        实测：未知端点在 Connection 传输层就 404（gateway 的 claimsEndpoint 不认领
    //        未注册端点，请求到不了 dispatchRpc），到达 dispatchRpc 的未知方法才返回
    //        gateway/invocation-unavailable。两种拒绝形状都算通过。──
    const negative = await rpcNegative(base.origin, apiCookie, 'git/__no_such_method__')
    assert(negative.rejected, `unknown endpoint unexpectedly succeeded: ${JSON.stringify(negative)}`)
    step(`negative check OK: unknown endpoint rejected (${negative.detail})`)

    exitCode = 0
    step('ALL CHECKS PASSED')
  } catch (error) {
    fail(error?.message ?? String(error))
    if (hostOutput) console.error(`---- host output tail ----\n${tail(hostOutput, 4000)}`)
  } finally {
    // ── 7. 清理（runbook §6.9）──
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
      console.warn(`[verify] WARN: could not remove temp home ${home}: ${error?.message ?? error}`)
    }
    try {
      rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed identity fixture repo ${fixtureRepo}`)
    } catch (error) {
      console.warn(`[verify] WARN: could not remove fixture repo ${fixtureRepo}: ${error?.message ?? error}`)
    }
  }
  process.exit(exitCode)
}

/** 未知端点的负向检查：接受传输层 404 或 gateway 层 ok:false 两种拒绝形状。 */
async function rpcNegative(origin, cookie, endpoint) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: {} } }),
  })
  if (response.status === 404) return { rejected: true, detail: 'HTTP 404 (transport route not claimed)' }
  const text = await response.text()
  assert(response.status === 200, `POST /api/${endpoint} → HTTP ${response.status}: ${text}`)
  const envelope = JSON.parse(text)
  assert(envelope?.type === 'server-response' && envelope.rpcId === rpcId, `unexpected envelope: ${text.slice(0, 200)}`)
  if (envelope.result?.ok === false) {
    return { rejected: true, detail: `gateway error ${envelope.result.error?.code}` }
  }
  return { rejected: false, detail: envelope.result }
}

/** POST one Connection unary RPC（client/rpc.ts 线格式）。 */
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
  const pair = setCookie.split(';', 1)[0]
  step('API operator cookie acquired via /connect')
  return pair
}

function tail(text, limit = 2500) {
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

main().catch((error) => {
  fail(error?.stack ?? String(error))
  process.exit(1)
})
