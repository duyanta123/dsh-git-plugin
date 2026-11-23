#!/usr/bin/env node
/**
 * verify-install.mjs — 发布门禁：干净安装冒烟（发布 ask ③；P3 门禁矩阵参数化 + P6 干净 clone 相）。
 *
 * 列矩阵（列解析与发布形态安装见 ./verify-target.mjs，报告 §2.3）：
 *   - 缺省（无 DSH_SPEC/DSH_BIN）= dev-tree 列：与 v0.1.1 行为逐位一致 —— 被测 CLI 是
 *     开发树源码入口（`node --import tsx/esm apps/cli/src/bin.ts`，cwd=DSH_TREE），
 *     断言面全严格（# == dsh-gitkit 层标签 / 严格 boot 行 /
 *     "[dsh-plugin-git] GitService active" 全串 marker / strict typert）。
 *   - `DSH_SPEC=@deepseek-ai/dsh@<ver>` = npm 列：npm view 探活 + npm i --prefix <tmp>，
 *     装后 `node <tmp>/node_modules/@deepseek-ai/dsh/lib/bin.js` 裸启动、cwd=<tmp>；
 *     层标签/marker/boot 行按列放宽（无层标签 → 全文 id 行判据 + WARN；
 *     marker 降级 'GitService active' 子串 + WARN；boot 行加宽松兜底形）。
 *   - DSH_SPEC 命中 NEGATIVE_SPECS（@deepseek-ai/dsh@0.1.7-rc.2 / @deepseek-ai/dsh@0.2.1-rc.2）
 *     = 声明下限外观测列：KNOWN-UNSUPPORTED（exit 0，纯记录式）或 PASS-UNEXPECTED
 *     （exit 1）双结局合法——宿主不强制校验（0.1.x 实证 grep -c engines=0），不写「预期拒绝」。
 *   - `DSH_BIN=<pkgRoot>/lib/bin.js` = 现成可执行列（放宽面同 npm 列）。
 *   - 退出码纪律：0=pass / 1=fail / 2=skip（npm 列 npm-cli.js 缺失或 view|install 失败，
 *     且未设 DSH_VERIFY_ALLOW_SKIP=1；设 ALLOW 时 exit 0 但 RESULT 行
 *     outcome=SKIPPED-ALLOWED，永不把 skip 记 pass）。每列结束打印 RESULT 行。
 *
 * 两相结构（P6 §2.6③ 门禁层）：
 *   PHASE working-copy —— 本工作副本（REPO）走一遍完整安装断言链（下列 ①-⑥）；
 *   PHASE clean-clone —— prepareCleanClone()：`git clone` 本仓库到临时目录（取已提交
 *     HEAD，未提交改动不在其内——语义即「用户拿到的是仓库 HEAD」）→ 断言无
 *     node_modules / packages/host/lib → 按 README §2 全新
 *     clone 前提 `pnpm install --frozen-lockfile` + `pnpm run build`（win32 下 pnpm 是
 *     .cmd 垫片，Node ≥18.20 无 shell 直启 .cmd 返回 EINVAL → run() shell 透传；
 *     参数为固定常量，无注入面）→ 走与工作副本相同的单条 file: add 断言链。
 *     prepareCleanClone 自包含清理（mkdtemp 后任何失败路径先删目录再抛出）；clone 目录
 *     由 `second` 变量 try 内赋值、统一 finally 清理；退出点唯一、位于统一 finally 之后。
 *     DSH_VERIFY_INSTALL_SKIP_CLONE=1 跳过 clone 相（CI verify 步显式设 1：clone 相
 *     耗时近乎翻倍，CI 保持 npm 列主体验证；本地发布门禁默认两相全跑）。
 *
 * 与 verify-load.mjs（全断言联调）的分工：本脚本只验证「发布形态的安装链路」——
 * 用户拿到本仓库后唯一需要的安装动作是一条 file: 安装命令（两相各走一遍）：
 * （单包合并：host + client 同属 dsh-gitkit，原 git-bundle 薄包与 dsh-gitkit-ui 退役。）
 *
 *   ① 全新临时 DSH_HOME + 全新 profile（名字带随机后缀，永不与既有 profile 撞名）；
 *   ② `dsh plugin --profile <新> add file:<packages/host 绝对路径>` —— 单一安装入口：
 *      包自带 dsh.bundle（宿主 profile 用 nodeLinker: hoisted，app-boot/src/profile.ts
 *      PROFILE_PNPM_WORKSPACE），reconcile 按 dsh.bundle 把 insert 行追加进
 *      dsh.profile.bundles（packages/boot/plugin-manager/src/operations.ts reconcile：
 *      只扫 profile 顶层 dependencies —— dsh-gitkit 是唯一顶层依赖）；
 *   ③ `dsh --profile <新> --dump-config` 断言 git 行（`id: dsh-plugin-git` +
 *      `name: dsh-gitkit`，在 `# == dsh-gitkit` 层标签之下；npm/bin 列无层标签时降级
 *      全文 id 行判据），且不得出现已退役的 `dsh-plugin-client-ui-git` 行；
 *   ④ boot web（`dsh --profile <新> --no-open --port 0`，runbook §2.1 实测命令形态；
 *      profile 需 dsh-web-app bundle 层——install 的 init 只给 dsh-base
 *      （official-bundles/src/bundles.ts:43-44），此为 profile 层用户文件补齐，
 *      与 verify-load 同一处理）；
 *   ⑤ workspaceOverride 经 profile 层 cordis.patch.yml 钉到临时真仓库 →
 *      `git/status` RPC 断言 ready（wire 形状注记：git/status 返回裸
 *      GitStatusSnapshot，无 {kind:'ready'} 包装——{kind} 只在 followStatus 帧与
 *      host 引擎内部 StatusAvailability 'ready'（status.ts:50）；本脚本按实形断言
 *      ok:true + born 分支全量字段，语义等价「仓库就绪」，与 verify-load 头注同口径）；
 *   ⑥ client 服务 HTML（认证后的 index）含该包：__DSH_BOOT__ entries 有
 *      `dsh-gitkit`（单包的 client 条目 id = 包名；inject 边不含自身），HTML 文本
 *      不得出现已退役的 `dsh-gitkit-ui`；其 url 服务出的 bundle 带闭包工厂标记；
 *   ⑦ 清理：taskkill 宿主进程树 + 删临时 DSH_HOME 与夹具仓库（runbook §6.9），
 *      退出码 0；任何一步失败退出码 1 并打印诊断。
 *
 * 深度断言（提交链/图/AI 负往返等）归 verify-load.mjs 与 vitest 套件；本脚本是
 * 发布面最小闭环，跑在 `pnpm run verify:install` 门禁里（ci/release 的
 * Verify install matrix 步以 DSH_SPEC 跑 npm 列）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXIT_FAIL,
  EXIT_PASS,
  SkipError,
  applySkipDiscipline,
  bootLineMatch,
  npmInstallToPrefix,
  resolveTarget,
} from './verify-target.mjs'
import {
  assert,
  exchangeTokenForCookie,
  extractJsonAfter,
  killTree,
  rpcCall,
  tail,
  tokenQueryCookie,
} from './verify-rpc.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..')
// 列解析（P3 §2.3）：模块顶层同步、零网络；缺省 = dev-tree 列（env DSH_TREE 可改指向）。
const target = resolveTarget()
const BOOT_TIMEOUT_MS = 180_000
const INSTALL_TIMEOUT_MS = 300_000
const DUMP_TIMEOUT_MS = 120_000
const BUILD_TIMEOUT_MS = 600_000 // P6 干净 clone 相：pnpm run build 的超时上界
const RPC_TIMEOUT_MS = 30_000 // 本机 fetch 一律带上界：无信号 fetch 可无限挂起（第 2 轮空输出失败的头号嫌疑）
const PROFILE = `dshgit-install-${Date.now().toString(36)}`
// 单包合并后的发布身份：唯一 npm 包 / 唯一 profile 顶层依赖 / 唯一 bundle 层 / client 条目 id。
const PKG_NAME = 'dsh-gitkit'
const PKG_DIR_REL = ['packages', 'host']
const BUNDLE_LAYER_LABEL = `# == ${PKG_NAME}` // dump-config 的层标签（app-boot index.ts:727 `# == ${label}`）
const HOST_ENTRY_ID = 'dsh-plugin-git'
// 已退役的双包身份：任何一处出现 = 迁移不完整或旧安装残留。
const RETIRED_NAMES = ['dsh-gitkit-ui', 'dsh-gitkit-bundle']
const RETIRED_ENTRY_IDS = ['dsh-plugin-client-ui-git']

// 运行日志（法医通道，第 2 轮 verify:install 空输出失败后增设）：step/phaseStep/fail/
// RESULT 同步 append 落盘——runGate 的 tail 取 stderr 优先（stdout 可能整段被丢弃），
// 且 Windows 上 process.exit 可丢弃管道未刷新缓冲；journal 文件不受两者影响，是失败
// 的确定性证据源。路径固定模式 <TEMP>/dshgit-install-journal-<PROFILE>.log，事后按
// mtime 取最新一份即可复盘任意一轮。
const journalPath = join(process.env.TEMP ?? '/tmp', `dshgit-install-journal-${PROFILE}.log`)
let journalReady = false
function journal(line) {
  try {
    if (!journalReady) {
      writeFileSync(journalPath, `==== verify-install ${new Date().toISOString()} pid=${process.pid} target=${target.label}\n`)
      journalReady = true
    }
    writeFileSync(journalPath, `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
  } catch { /* 尽力而为：journal 自身故障绝不影响主流程 */ }
}

const step = (message) => {
  console.log(`[verify-install] ${message}`)
  journal(message)
}
const fail = (message) => {
  journal(`FAIL: ${String(message).slice(0, 2000)}`)
  console.error(`[verify-install] FAIL: ${message}`)
  // stdout 镜像一行：runGate tail 取 stderr 优先，若 stderr 中继异常，stdout 仍带结论。
  console.log(`[verify-install] FAIL: ${message}`)
}
// assert / killTree / tail / extractJsonAfter / rpcCall / tokenQueryCookie /
// exchangeTokenForCookie 收口至 ./verify-rpc.mjs（verify 系公共助手单源）。本脚本为
// install 列语义：RPC/cookie fetch 一律带 AbortSignal.timeout(RPC_TIMEOUT_MS) 上界
// （signalMs 参数），extractJsonAfter 缺失消息 'not found in served HTML'（法医诊断
// 措辞漂移按登记保真），cookie 助手的 step 行经本模块 step 落 '[verify-install]'
// 前缀 + journal。

/** spawn once, capture output, enforce a timeout, kill the tree on timeout.
 *  shell 透传（P6 干净 clone 相）：win32 下 pnpm 是 .cmd 垫片，无 shell 直启返回
 *  EINVAL——仅用于固定常量参数的调用点（关键不变量⑥）。spawn 失败（ENOENT 等）会
 *  触发 child 'error' 事件：run() 此前无监听器（报告 §2.3 备注级修订）——现显式兜底，
 *  与 DSH_BIN 列的存在性断言构成两道防线。 */
function run(cmd, args, { cwd, env, timeoutMs, shell }) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell })
    let out = ''
    const collect = (chunk) => { out += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      killTree(child.pid)
      resolveRun({ code: -1, out: `${out}\n[verify-install] process timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ code: -1, out: `${out}\n[verify-install] spawn failed: ${error?.message ?? error}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, out })
    })
  })
}

// killTree（Windows 进程树 taskkill，runbook §6.9）、extractJsonAfter（balanced-brace
// JSON 提取）、rpcCall（POST one Connection unary RPC）、tokenQueryCookie
// （/?token= → 303 + 浏览器 cookie）、exchangeTokenForCookie（/connect?token= → 302 +
// API 操作员 cookie）与 tail 均收口至 ./verify-rpc.mjs——install 列差异以参数表达
// （signalMs 上界 / missingMessage 措辞），行为逐字节保真。

const rpcCallOptions = { signalMs: RPC_TIMEOUT_MS }
const cookieCallOptions = { step, signalMs: RPC_TIMEOUT_MS }
const extractOptions = { missingMessage: 'not found in served HTML' }

/**
 * 干净 clone 相准备（P6 §2.6③）：`git clone` 本仓库 → 断言无 node_modules / lib 产物 →
 * `pnpm install --frozen-lockfile` + `pnpm run build`。自包含清理：mkdtemp 后任何失败
 * 路径先删目录再抛出（成功路径的目录交给调用方 `second` 变量，统一 finally 清理）。
 * clone 取已提交 HEAD（未提交改动不在其内——语义即「用户拿到的是仓库 HEAD」）；
 * git clone 不走 shell，REPO 路径含空格数组传参天然安全。
 */
async function prepareCleanClone(repoRoot) {
  const cloneDir = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-install-clone-'))
  const rollback = () => {
    try {
      rmSync(cloneDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch { /* 自包含清理尽力而为：失败时目录留在 TEMP，由调用方诊断 */ }
  }
  try {
    step(`clean clone: git clone ${repoRoot} → ${cloneDir}`)
    execFileSync('git', ['clone', '--quiet', repoRoot, cloneDir], { stdio: 'ignore' })
    assert(!existsSync(join(cloneDir, 'node_modules')), `clean clone unexpectedly contains node_modules — ${repoRoot} working copy is dirty?`)
    assert(!existsSync(join(cloneDir, 'packages', 'host', 'lib')), 'clean clone unexpectedly contains packages/host/lib — build artifacts must not be committed')
    assert(!existsSync(join(cloneDir, 'packages', 'client-ui')) && !existsSync(join(cloneDir, 'git-bundle')),
      'clean clone unexpectedly contains the retired packages/client-ui or git-bundle directory')
    step('clean clone: no node_modules, no committed lib/ build artifacts')
    step('clean clone: pnpm install --frozen-lockfile（README §2 全新 clone 前提，与 ci.yml/发布门禁同口径）')
    const pnpmInstall = await run('pnpm', ['install', '--frozen-lockfile'], {
      cwd: cloneDir, env: process.env, timeoutMs: INSTALL_TIMEOUT_MS,
      shell: process.platform === 'win32', // pnpm 是 .cmd 垫片：无 shell 直启在 Node ≥18.20 返回 EINVAL
    })
    assert(pnpmInstall.code === 0, `clean clone pnpm install failed (exit ${pnpmInstall.code}):\n${pnpmInstall.out.slice(-2000)}`)
    step(`clean clone: pnpm run build (BUILD_TIMEOUT_MS=${BUILD_TIMEOUT_MS})`)
    const build = await run('pnpm', ['run', 'build'], {
      cwd: cloneDir, env: process.env, timeoutMs: BUILD_TIMEOUT_MS,
      shell: process.platform === 'win32',
    })
    assert(build.code === 0, `clean clone build failed (exit ${build.code}):\n${build.out.slice(-2000)}`)
    step('clean clone: build OK (lib/ artifacts present inside the clone)')
    return cloneDir
  } catch (error) {
    rollback()
    throw error
  }
}

/**
 * 单相安装断言链（P6 §2.6③ 参数化）：对 repoRoot 指向的插件仓库副本走 ①-⑥ 全链。
 * 依赖 repoRoot 的恰为 4 个路径常量（pkgDir / hostLib / hostTypert / clientLib）与
 * 1 处 step（打印 repo）；不再自行 process.exit ——
 * 返回 { outcome, exit }，退出点唯一收口到模块底部统一 finally 之后的 process.exit。
 */
async function installFlow(repoRoot, phaseLabel) {
  const phaseStep = (message) => {
    console.log(`[verify-install][${phaseLabel}] ${message}`)
    journal(`[${phaseLabel}] ${message}`)
  }
  // ── 前置检查（读侧断言，无资源需清理）：单包 manifest + 两面构建产物（② 的产物面）──
  // 失败直接抛出（→ FAIL）：破损 checkout 不是兼容性结局，观测列的 KNOWN-UNSUPPORTED
  // 纯记录只覆盖宿主兼容面，不吞仓库破损。
  const pkgDir = join(repoRoot, 'packages', 'host')
  const pkgManifestPath = join(pkgDir, 'package.json')
  const hostLib = join(pkgDir, 'lib', 'index.js')
  const hostTypert = join(pkgDir, 'lib', 'typert.host.js')
  const clientLib = join(pkgDir, 'lib', 'client.js')
  assert(target.cli !== null && target.cliArgs !== null && target.cliCwd !== null,
    `verify target CLI unresolved (kind=${target.kind}) — npm column install step missing?`)
  assert(existsSync(pkgManifestPath), 'dsh-gitkit manifest missing — broken checkout')
  assert(existsSync(hostLib), `host lib missing: ${hostLib} — run \`pnpm run build\` first`)
  assert(existsSync(hostTypert), `generated host typert artifact missing: ${hostTypert} — run \`pnpm run build\` first`)
  assert(existsSync(clientLib), `client bundle missing: ${clientLib} — run \`pnpm run build\` first`)
  const pkgManifest = JSON.parse(readFileSync(pkgManifestPath, 'utf8'))
  assert(pkgManifest.name === PKG_NAME, `package manifest name wrong: ${pkgManifest.name}`)
  assert(pkgManifest.dsh?.bundle?.patch === './cordis.patch.yml' && pkgManifest.dsh?.client?.platform === 'web',
    `package manifest must carry both faces (dsh.bundle.patch + dsh.client.platform=web): ${JSON.stringify(pkgManifest.dsh)}`)
  assert(!existsSync(join(repoRoot, 'git-bundle')) && !existsSync(join(repoRoot, 'packages', 'client-ui')),
    'retired git-bundle / packages/client-ui directories are present again (single-package merge incomplete)')

  let host = null
  let home = null
  let fixtureRepo = null
  let hostOutput = ''
  let outcome = 'FAIL'
  let flowExit = EXIT_FAIL
  try {
    phaseStep(`dsh target: ${target.label}; repo: ${repoRoot}; installing ${pkgManifest.name}@${pkgManifest.version}（host + client 同包）`)

    // status() 夹具：临时真仓库（真 git init + 一笔种子提交 ⇒ ready 快照分支字段可断言；
    // world 事实由本脚本的 git 命令铸造，RPC 只做只读消费）。
    fixtureRepo = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-install-ws-'))
    // GH Windows runner 的 TEMP 是 8.3 短名（C:\Users\RUNNER~1\...），而 git 引擎返回
    // 的 repoRoot 是规范长名——夹具路径统一 realpath 展开后再进断言，避免两侧长短名
    // 不一致误红（native realpath 才展开短名；结果带 \\?\ 前缀时剥除）。
    try {
      fixtureRepo = realpathSync.native(fixtureRepo).replace(/^\\\\\?\\/, '')
    } catch {
      // native realpath 不可用时保留 8.3 形态（断言仍有大小写/反斜杠归一兜底）。
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRepo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'install-user'], { cwd: fixtureRepo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'install@example.com'], { cwd: fixtureRepo, stdio: 'ignore' })
    writeFileSync(join(fixtureRepo, 'seed.md'), 'dsh verify-install seed\n')
    execFileSync('git', ['add', 'seed.md'], { cwd: fixtureRepo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'chore: verify-install seed'], { cwd: fixtureRepo, stdio: 'ignore' })
    const seedOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
    phaseStep(`fixture repo: ${fixtureRepo} (seed commit ${seedOid.slice(0, 7)})`)

    home = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dsh-git-install-'))
    const env = { ...process.env, DSH_HOME: home }
    const profileDir = join(home, 'profiles', PROFILE)

    // 单包合并：直接安装 packages/host（host + client 同包，包自带 dsh.bundle）。
    const pkgSpec = `file:${pkgDir.replaceAll('\\', '/')}`
    phaseStep(`installing: dsh plugin --profile ${PROFILE} add ${pkgSpec}`)
    const install = await run(target.cli, [...target.cliArgs, 'plugin', '--profile', PROFILE, 'add', pkgSpec], {
      cwd: target.cliCwd, env, timeoutMs: INSTALL_TIMEOUT_MS,
    })
    assert(install.code === 0, `${PKG_NAME} install failed (exit ${install.code}):\n${install.out.slice(-2000)}`)
    phaseStep(`installed ${PKG_NAME} (exit 0)`)

    // 安装事实：profile manifest 记 dsh-gitkit 为顶层依赖；node_modules（hoisted）里该包齐备，
    // 且已退役的 dsh-gitkit-ui / dsh-gitkit-bundle 不得出现。
    const profilePackageJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = profilePackageJson.dependencies ?? {}
    assert(deps[PKG_NAME] !== undefined, `profile dependencies missing ${PKG_NAME}: ${JSON.stringify(deps)}`)
    for (const retired of RETIRED_NAMES) {
      assert(deps[retired] === undefined, `profile dependencies still carry the retired ${retired}: ${JSON.stringify(deps)}`)
      assert(!existsSync(join(profileDir, 'node_modules', retired, 'package.json')),
        `hoisted node_modules still contains the retired ${retired}`)
    }
    assert(existsSync(join(profileDir, 'node_modules', PKG_NAME, 'package.json')),
      `hoisted node_modules missing ${PKG_NAME}`)
    const bundles = profilePackageJson.dsh?.profile?.bundles
    assert(Array.isArray(bundles) && bundles.includes(PKG_NAME),
      `reconcile did not attach the ${PKG_NAME} layer: ${JSON.stringify(profilePackageJson.dsh)}`)
    for (const retired of RETIRED_NAMES) {
      assert(!bundles.includes(retired), `profile bundles still list the retired ${retired}: ${JSON.stringify(bundles)}`)
    }
    phaseStep(`profile recorded: dependencies=${JSON.stringify(Object.keys(deps))}, bundles=${JSON.stringify(bundles)}`)

    // web 宿主需要 dsh-web-app bundle 层（install init 只给 dsh-base，同 verify-load 处理）。
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      const baseAt = bundles.indexOf('@deepseek-ai/dsh-base')
      if (baseAt >= 0) {
        bundles.splice(baseAt + 1, 0, '@deepseek-ai/dsh-web-app')
      } else {
        // indexOf=-1 时 splice(-1+1=0,0,…) 会静默把 dsh-web-app 插到队首（P3 修复）：
        // 改为队尾追加 + WARN。
        console.warn('[verify-install] WARN: profile bundles lack dsh-base — appending dsh-web-app at the end (indexOf=-1 silent queue-head insert fixed)')
        bundles.push('@deepseek-ai/dsh-web-app')
      }
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePackageJson, null, 2) + '\n')
      phaseStep(`profile bundles patched to include dsh-web-app: ${JSON.stringify(bundles)}`)
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
    phaseStep('profile cordis.patch.yml: workspaceOverride row written')

    // ── 2. --dump-config 断言 host insert 行（包自带层标签之下）+ 无已退役行 ──
    const dump = await run(target.cli, [...target.cliArgs, '--profile', PROFILE, '--dump-config'], {
      cwd: target.cliCwd, env, timeoutMs: DUMP_TIMEOUT_MS,
    })
    assert(dump.code === 0, `--dump-config failed (exit ${dump.code}):\n${dump.out.slice(-2000)}`)
    // dump-config 判据：host insert 行在场（id: dsh-plugin-git + name: dsh-gitkit），
    // 已退役的 dsh-plugin-client-ui-git 行不得出现。name 行用行尾锚定正则兼容带/不带
    // 引号两种 YAML 渲染（v0.1.0 实测 dev 树渲染为不带引号）；`\r?` 兼容 CRLF。
    const hasGitRow = (text) => text.includes(`id: ${HOST_ENTRY_ID}`) && /name: ["']?dsh-gitkit["']?\r?$/m.test(text)
    const hasRetiredRow = (text) => RETIRED_ENTRY_IDS.some((id) => text.includes(`id: ${id}`))
    assert(dump.code === 0, `--dump-config failed (exit ${dump.code}):\n${dump.out.slice(-2000)}`)
    assert(!hasRetiredRow(dump.out),
      `dump-config still carries a retired insert row (${RETIRED_ENTRY_IDS.join(', ')}):\n${dump.out.slice(-1200)}`)
    const layerAt = dump.out.indexOf(BUNDLE_LAYER_LABEL)
    if (target.strictLayerLabel) {
      // dev-tree 列：严格层标签断言——该行必须位于 `# == dsh-gitkit` 层之下
      // （包自带 dsh.bundle，reconcile 自动挂层）。
      assert(layerAt >= 0, `dump-config has no ${BUNDLE_LAYER_LABEL} layer label:\n${dump.out.slice(-1200)}`)
      assert(hasGitRow(dump.out.slice(layerAt)),
        `dump-config ${BUNDLE_LAYER_LABEL} layer lacks the host insert row:\n${dump.out.slice(layerAt)}`)
      phaseStep(`dump-config OK: host insert row under the ${BUNDLE_LAYER_LABEL} layer; no retired rows`)
    } else {
      // npm/bin 列：部分宿主版本 dump-config 不带层标签——降级为全文 id 行判据 + WARN。
      if (layerAt < 0) {
        console.warn(`[verify-install] WARN: dump-config has no ${BUNDLE_LAYER_LABEL} layer label（npm/bin 列降级：全文 id 行判据）`)
        assert(hasGitRow(dump.out),
          `dump-config lacks the host insert row (degraded whole-text criterion):\n${dump.out.slice(-1200)}`)
      } else {
        assert(hasGitRow(dump.out.slice(layerAt)),
          `dump-config ${BUNDLE_LAYER_LABEL} layer lacks the host insert row:\n${dump.out.slice(layerAt)}`)
      }
      phaseStep('dump-config OK: host insert row present; no retired rows（层标签按列放宽）')
    }

    // ── 3. boot web ──
    phaseStep('starting dsh web host…')
    host = spawn(target.cli, [...target.cliArgs, '--profile', PROFILE, '--no-open', '--port', '0'], {
      cwd: target.cliCwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    host.stdout.on('data', (c) => { hostOutput += c.toString('utf8') })
    host.stderr.on('data', (c) => { hostOutput += c.toString('utf8') })
    const bootLine = await new Promise((resolveBoot, rejectBoot) => {
      const timer = setTimeout(() => rejectBoot(new Error(`host boot timed out after ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS)
      // spawn 失败（DSH_BIN 指错等）只触发 'error' 事件不触发 'exit'——显式兜底 reject。
      host.on('error', (error) => {
        clearTimeout(timer)
        rejectBoot(new Error(`host spawn failed: ${error?.message ?? error}`))
      })
      host.stdout.on('data', function pump() {
        // boot 行按列匹配：dev-tree 严格形；npm/bin 列宽松兜底形（verify-target.bootLineMatch）。
        const bootURL = bootLineMatch(hostOutput, target)
        if (bootURL) {
          clearTimeout(timer)
          host.stdout.off('data', pump)
          resolveBoot(bootURL)
        }
      })
      host.on('exit', (code) => {
        clearTimeout(timer)
        rejectBoot(new Error(`host exited early (code ${code}):\n${hostOutput.slice(-3000)}`))
      })
    })
    const base = new URL(bootLine)
    const token = base.searchParams.get('token')
    phaseStep(`host booted: ${base.origin} (token acquired)`)

    assert(!/entry did not activate/.test(hostOutput), `host log reports "did not activate":\n${tail(hostOutput)}`)
    assert(!/failed to import/.test(hostOutput), `host log reports "failed to import":\n${tail(hostOutput)}`)
    // 激活 marker 按列（P3）：dev-tree 全串严格（打点整串来自插件自身
    // packages/host/src/index.ts:253 的 process.stdout.write 字面量）；npm/bin 列降级
    // 'GitService active' 子串 + WARN（宿主可能改写 stdout 行格式）。
    const fullMarker = hostOutput.includes('[dsh-plugin-git] GitService active')
    if (target.strictActivationMarker) {
      assert(fullMarker, 'GitService activation marker missing from host stdout — plugin did not activate')
      phaseStep('host load marker "[dsh-plugin-git] GitService active": present')
    } else {
      assert(hostOutput.includes('GitService active'),
        'GitService activation marker missing from host stdout — plugin did not activate（npm/bin 列降级子串判据仍失败）')
      if (!fullMarker) {
        console.warn('[verify-install] WARN: full marker "[dsh-plugin-git] GitService active" not found — degraded to "GitService active" substring（npm/bin 列）')
      }
      phaseStep(`host load marker: ${fullMarker ? 'full' : 'degraded substring'} "GitService active": present`)
    }

    // ── 4. client 服务 HTML 含单包的 client 条目 ──
    const browserCookie = await tokenQueryCookie(base.origin, token, cookieCallOptions)
    const indexResponse = await fetch(base.origin, { headers: { cookie: browserCookie }, redirect: 'manual', signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    assert(indexResponse.status === 200, `authenticated index returned ${indexResponse.status}`)
    // 单包的 client 条目：id = 包名（client-modules manifest.ts「Entry name == package name」），
    // inject 不得自引用；已退役的 dsh-gitkit-ui 条目与包名不得再出现。
    const indexHtml = await indexResponse.text()
    assert(indexHtml.includes(PKG_NAME), 'served index HTML does not contain the package name')
    for (const retired of RETIRED_NAMES) {
      assert(!indexHtml.includes(retired), `served index HTML still mentions the retired ${retired}`)
    }
    const boot = extractJsonAfter(indexHtml, '__DSH_BOOT__', extractOptions)
    const entries = boot.entries ?? []
    const clientEntry = entries.find((entry) => entry.id === PKG_NAME)
    assert(clientEntry !== undefined,
      `boot graph has no entry '${PKG_NAME}'（单包合并后 client 条目 id = 包名）; ids: ${JSON.stringify(entries.map((e) => e.id))}`)
    assert(Array.isArray(clientEntry.inject) && !clientEntry.inject.includes(PKG_NAME),
      `client entry inject must not self-reference '${PKG_NAME}': ${JSON.stringify(clientEntry.inject)}`)
    assert(Array.isArray(clientEntry.inject) && clientEntry.inject.includes('@deepseek-ai/dsh-client-ui-slots'),
      `client entry inject edges missing '@deepseek-ai/dsh-client-ui-slots': ${JSON.stringify(clientEntry.inject)}`)
    const bundleResponse = await fetch(new URL(clientEntry.url, base.origin), { headers: { cookie: browserCookie }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    assert(bundleResponse.status === 200, `client bundle fetch ${clientEntry.url} → ${bundleResponse.status}`)
    const bundleBody = await bundleResponse.text()
    assert(bundleBody.includes('__ModuleLoader__'), 'served client bundle lacks the closure-factory marker')
    phaseStep(`served HTML carries the ${PKG_NAME} client entry; client bundle served (${bundleBody.length} bytes, closure factory)`)

    // ── 5. git/status RPC：workspaceOverride 夹具仓库的 ready 快照 ──
    const apiCookie = await exchangeTokenForCookie(base.origin, token, cookieCallOptions)
    const ping = await rpcCall(base.origin, apiCookie, 'git/ping', {}, rpcCallOptions)
    assert(ping.ok === true && /^git version \S+/.test(ping.value?.gitVersion ?? ''),
      `git/ping failed: ${JSON.stringify(ping)}`)
    phaseStep(`ping RPC OK: ${ping.value.gitVersion}`)
    const status = await rpcCall(base.origin, apiCookie, 'git/status', {}, rpcCallOptions)
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
    phaseStep(`status RPC OK: ready snapshot on 'main' @ ${branch.abbrevOid}, clean, repoRoot=${snapshot.repoRoot}`)

    outcome = 'PASS'
    flowExit = EXIT_PASS
    phaseStep('ALL CHECKS PASSED')
  } catch (error) {
    if (error instanceof SkipError) {
      ({ outcome, exit: flowExit } = applySkipDiscipline(error, `[verify-install][${phaseLabel}]`))
    } else if (target.observation) {
      // 观测列：KNOWN-UNSUPPORTED 行改纯记录式（报告 §2.3）——不预设失败形态，
      // 记录实际失败与宿主输出尾部；exit 0（观测列 KNOWN-UNSUPPORTED 亦 0）。
      console.warn(`[verify-install][${phaseLabel}] KNOWN-UNSUPPORTED（观测列纯记录，双结局合法）: ${error?.message ?? String(error)}`)
      if (hostOutput) console.warn(`---- host output tail ----\n${tail(hostOutput, 4000)}`)
      outcome = 'KNOWN-UNSUPPORTED'
      flowExit = EXIT_PASS
    } else {
      fail(error?.message ?? String(error))
      if (hostOutput) console.error(`---- host output tail ----\n${tail(hostOutput, 4000)}`)
      outcome = 'FAIL'
      flowExit = EXIT_FAIL
    }
  } finally {
    // ── 6. 清理进程与临时目录（runbook §6.9）──
    if (host?.pid && host.exitCode === null) {
      phaseStep(`stopping host pid ${host.pid} (taskkill /T /F)`)
      killTree(host.pid)
      await new Promise((resolveExit) => {
        const t = setTimeout(resolveExit, 10_000)
        host.on('exit', () => { clearTimeout(t); resolveExit() })
      })
    }
    if (home) {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        phaseStep(`removed temp DSH_HOME ${home}`)
      } catch (error) {
        console.warn(`[verify-install] WARN: could not remove temp home ${home}: ${error?.message ?? error}`)
      }
    }
    if (fixtureRepo) {
      try {
        rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        phaseStep(`removed fixture repo ${fixtureRepo}`)
      } catch (error) {
        console.warn(`[verify-install] WARN: could not remove fixture repo ${fixtureRepo}: ${error?.message ?? error}`)
      }
    }
  }
  phaseStep(`phase result: outcome=${outcome} exit=${flowExit}`)
  return { outcome, exit: flowExit }
}

// ── 编排（P6 §2.6③）：退出点唯一，位于统一 finally 之后；统一 finally 清理 npm
//    prefix 与干净 clone 目录（second 变量 try 内赋值）两个新增临时目录。──
let outcome = 'FAIL'
let exitCode = EXIT_FAIL
let npmPrefix = null // npm 列 --prefix 临时目录：try 内赋值、统一 finally 清理
let second = null    // 干净 clone 目录（第二个临时目录）：try 内赋值、统一 finally 清理
try {
  step(`verify target: ${target.label}${target.observation ? '（观测列：KNOWN-UNSUPPORTED / PASS-UNEXPECTED 双结局合法，纯记录式）' : ''}`)
  if (target.kind === 'dev-tree') {
    // binTs 断言仅 dev-tree 列执行（npm 发布包只有 lib/*.js，无 src —— P3 根因①）。
    const binTs = join(target.cliCwd, 'apps', 'cli', 'src', 'bin.ts')
    assert(existsSync(binTs), `dsh CLI entry missing: ${binTs}（env DSH_TREE 可改指向）`)
  }
  if (target.npmSpec) {
    npmPrefix = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-install-npm-'))
    step(`npm column: installing ${target.npmSpec} into prefix ${npmPrefix}`)
    const installed = await npmInstallToPrefix(target.npmSpec, npmPrefix)
    target.cli = installed.cli
    target.cliArgs = installed.cliArgs
    target.cliCwd = installed.cliCwd
    step(`npm column ready: node ${installed.cliArgs[0]} (cwd=${installed.cliCwd}; npm view version → ${installed.viewVersion})`)
  }
  const first = await installFlow(REPO, 'working-copy')
  outcome = first.outcome
  exitCode = first.exit
  // 观测列双结局落地（报告 §2.3）：全断言通过 = PASS-UNEXPECTED（exit 1）——声明下限
  // 外的宿主意外可装载 = 兼容声明被现实证伪，必须显式失败而非静默记 PASS。
  // remap 在 clone 相分支之前：观测列 remap 后 outcome!=='PASS'，自动不进 clone 相。
  if (target.observation && outcome === 'PASS') {
    console.warn('[verify-install] WARN: observation column passed all assertions — recorded as PASS-UNEXPECTED (exit 1)：声明下限外宿主意外可装载')
    outcome = 'PASS-UNEXPECTED'
    exitCode = EXIT_FAIL
  }
  if (outcome === 'PASS' && process.env.DSH_VERIFY_INSTALL_SKIP_CLONE === '1') {
    console.warn('[verify-install] WARN: DSH_VERIFY_INSTALL_SKIP_CLONE=1 — clean clone phase skipped（CI verify 步显式设 1；本地发布门禁默认两相全跑）')
  } else if (outcome === 'PASS') {
    second = await prepareCleanClone(REPO)
    const cloneRun = await installFlow(second, 'clean-clone')
    outcome = cloneRun.outcome
    exitCode = cloneRun.exit
  }
} catch (error) {
  if (error instanceof SkipError) {
    ({ outcome, exitCode } = applySkipDiscipline(error, '[verify-install]'))
  } else {
    fail(error?.stack ?? String(error))
  }
} finally {
  if (npmPrefix) {
    try {
      rmSync(npmPrefix, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed npm prefix ${npmPrefix}`)
    } catch (error) {
      console.warn(`[verify-install] WARN: could not remove npm prefix ${npmPrefix}: ${error?.message ?? error}`)
    }
  }
  if (second) {
    try {
      rmSync(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed clean clone ${second}`)
    } catch (error) {
      console.warn(`[verify-install] WARN: could not remove clean clone ${second}: ${error?.message ?? error}`)
    }
  }
}
console.log(`[verify-install] RESULT: outcome=${outcome} exit=${exitCode} target=${target.label}`)
journal(`RESULT: outcome=${outcome} exit=${exitCode}`)
console.error(`[verify-install] RESULT: outcome=${outcome} exit=${exitCode} target=${target.label}`)
process.exitCode = exitCode
// Windows 管道未刷新缓冲可被 process.exit 直接丢弃（第 2 轮空输出失败的候选机制之
// 一）：先置 exitCode 让流自然刷新，5s 上界后强制退出防 fetch keep-alive 悬挂句柄。
setTimeout(() => process.exit(exitCode), 5_000)
