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
 *      J. ④-K 提交对话框模块：bundle 内联提交对话框——样式注入器标记（data-plugin-css，
 *         P2 样式管线）、对话框 children 包裹层 data 锚（data-git-commit-dialog）、
 *         消息编辑器锚、aria-keyshortcuts 快捷键组、commit.* 词典词条（AI 生成/修订/
 *         提交并推送）、生成的 git/commit、git/push、git/generateCommitMessage 描述符；
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
 *      L. v2 批次一 refs 管理面九方法各一条真宿主 RPC 往返（docs/v2-implementation-plan.md
 *         §3.7「verify-load 断言面扩展」硬前提——断言链 A–K 不自动覆盖新方法，漏扩 =
 *         本批端到端零覆盖）：remoteList（夹具仓库补 origin 指向姊妹 bare）→
 *         branchCreate（world 重读 refs/heads）→ branchCreate 重名 ⇒ git/branch-exists →
 *         worktreeAdd（姊妹目录 newBranch；world 重读新 worktree 的 HEAD 符号引用）→
 *         worktreeList（含主仓 + 新 worktree 两条目）→ branchSwitch（world 重读
 *         symbolic-ref HEAD）→ tagCreate（annotated；world 重读 cat-file -t = tag）→
 *         tagCreate 重名 ⇒ git/tag-exists → branchSwitch 回 main → branchDelete（-d，
 *         wasMerged=true；world 重读 ref 消失）→ branchDelete 再删 ⇒ git/branch-not-found →
 *         tagDelete（world 重读 tag 消失）→ tagDelete 再删 ⇒ git/tag-not-found →
 *         git/push force 无 acknowledged ⇒ git/bad-request 'force-unacknowledged'
 *         （[清单 27] 双闸 host 半的真宿主面）→ worktreeRemove（world 重读目录消失 +
 *         list 回落单条目）→ worktreeRemove 再删 ⇒ git/worktree-failed。
 *      M. v2 批次二历史面六方法各一条真宿主 RPC 往返（docs/v2-implementation-plan.md
 *         §4.7「verify-load 断言面扩展」硬前提——断言链 A–L 不自动覆盖新方法，漏扩 =
 *         本批端到端零覆盖）：blame（world re-read `git blame --porcelain` 首段 oid
 *         对照）→ compareBranches（world 建分支 + 提交后 ahead/behind 计数与列表、
 *         mergeBase 对照 git merge-base）→ reset 三档（soft/hard/mixed 各自 world 重读
 *         HEAD/staged/工作区）→ reset hard 无 acknowledged ⇒ git/bad-request
 *         'unacknowledged'（零命令）→ cherryPick 冲突 ⇒ git/merge-conflict 真宿主形状
 *         （details.op='cherry-pick'、conflicted == world diff-filter=U、abortable）+
 *         CHERRY_PICK_HEAD 在场 ⇒ git/operation-in-progress（cherryPick/reset 叠加皆
 *         拒）→ abortOperation（world 重读 HEAD/中间态/工作区复原；再 abort 幂等
 *         null）→ cherryPick 成功路径（world HEAD 前进）→ revert 成功（world 文件消失）
 *         → 空 revert ⇒ git-error op 'revert'。
 *         **批次三硬前提（plan §5.7）**：stashPop 落地时本断言面必须随之扩展——
 *         stashPop 冲突断言 `git/merge-conflict` 真宿主形状（op 'stash-pop'，该码
 *         注册于批次二 §4.4；§8 D9 对调时随移）+ stashPush/List/Pop/Drop 各一条往返，
 *         否则批次三新方法端到端零覆盖（§3.8 注同款纪律）。
 *      N. v2 批次三提交链路与护栏七方法各一条真宿主 RPC 往返（docs/v2-implementation-plan.md
 *         §5.7「verify-load 断言面扩展」硬前提——断言链 A–M 不自动覆盖新方法，漏扩 =
 *         本批端到端零覆盖）：commit 链路断言 `CommitResult.process` 字段（K 段）→
 *         stagePatch（world 重读 staged diff 只含选中 hunk）→ scanStaged 密钥样例
 *         （blocked + redactedMatch 无明文断言）→ commit 密钥硬阻断 ⇒ git/commit-blocked
 *         overridable:false（D5=A，world 零提交）→ repoDiagnostics（autocrlf=fixture
 *         钉死值 + 抽样计数形状）→ stashPush（D4=B 缺省含 untracked；world 重读 stash
 *         与干净工作区）→ stashList（index/oid world 对照）→ stashPop（内容恢复、stash
 *         清空）→ stashPop 冲突 ⇒ git/merge-conflict（op 'stash-pop'、conflicted 与
 *         world diff-filter=U 一致、**stash 未丢**）→ stashDrop 无 acknowledged ⇒
 *         git/bad-request 'unacknowledged'（零命令）→ stashDrop（acknowledged；world
 *         重读 stash 清空）→ stashDrop 再删 ⇒ git/stash-not-found。
 *
 *   ④ 结束清理：taskkill 宿主进程树 + 删临时 DSH_HOME（runbook §6.9 清理纪律）。
 *
 * 退出码纪律（P3 门禁矩阵）：全部断言通过 = 0；任何一步失败 = 1（打印宿主输出尾部
 * 诊断）；npm 列 skip（npm-cli.js 缺失 / npm view|install 失败）= 2，设
 * DSH_VERIFY_ALLOW_SKIP=1 时 exit 0 但 RESULT 行 outcome=SKIPPED-ALLOWED（永不把
 * skip 记 pass）。每列结束打印 RESULT 行。
 *
 * 列矩阵（列解析与发布形态安装见 ./verify-target.mjs，报告 §2.3）：缺省 = dev-tree 列
 * （与上列 ①-④ 行为逐位一致，断言面全严格）；`DSH_SPEC=@deepseek-ai/dsh@<ver>` = npm 列
 * （npm view 探活 + npm i --prefix <tmp>，装后裸 node lib/bin.js 启动；boot 行 /
 * 激活 marker / dump-config 无层标签断言——本脚本本无层标签断言——按列放宽，marker
 * 降级 'GitService active' 子串 + WARN）；DSH_SPEC 命中 NEGATIVE_SPECS（0.1.7-rc.2 /
 * 0.2.1-rc.2）= 观测列（KNOWN-UNSUPPORTED exit 0 纯记录式 / PASS-UNEXPECTED exit 1
 * 双结局合法）；`DSH_BIN=<pkgRoot>/lib/bin.js` = 现成可执行列。strict typert 注册
 * 断言（⑤-F）按列 flag target.strictTypert（矩阵列默认 true——0.2.1-rc.5 的 typert
 * loader src 与 HEAD 零 diff 普查实证；首跑 fail 的处置是该列置 false 并记录，
 * 非全局放宽）。
 *
 * 注记（ask ④ 口径与 wire 实形的差异，不硬凑）：ask 写「status() 断言 {kind:'ready'}」，
 * 但 wire 上 git/status 返回裸 GitStatusSnapshot（packages/host/src/types.ts:89 无 kind
 * 字段；{kind} 形状只存在于 followStatus 帧 GitStatusFrame.kind='status' 与 host 引擎
 * 内部 StatusAvailability 'ready'，status.ts:50）。本脚本按实形断言 ok:true + 全量
 * 快照字段，语义等价（仓库就绪 + 分支字段），差异已记 ModuleResult openIssues。
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..')
// 列解析（P3 §2.3）：模块顶层同步、零网络；缺省 = dev-tree 列（env DSH_TREE 可改指向）。
const target = resolveTarget()
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

/** spawn once, capture output, enforce a timeout, kill the tree on timeout.
 *  shell 透传与 install 同构（本脚本现无 shell 调用点，保留同形签名）；spawn 失败
 *  （ENOENT 等）会触发 child 'error' 事件：run() 此前无监听器（报告 §2.3 备注级
 *  修订）——现显式兜底，与 DSH_BIN 列的存在性断言构成两道防线。 */
function run(cmd, args, { cwd, env, timeoutMs, shell }) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell })
    let out = ''
    const collect = (chunk) => { out += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      killTree(child.pid)
      resolveRun({ code: -1, out: `${out}\n[verify] process timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ code: -1, out: `${out}\n[verify] spawn failed: ${error?.message ?? error}` })
    })
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
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { /* best effort */ })
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
  // ── 0. 前置检查（读侧断言：失败属仓库/宿主破损，直接抛出 → FAIL；观测列不吞）──
  assert(target.cli !== null && target.cliArgs !== null && target.cliCwd !== null,
    `verify target CLI unresolved (kind=${target.kind}) — npm column install step missing?`)
  const hostPkgDir = join(REPO, 'packages', 'host')
  const hostLib = join(hostPkgDir, 'lib', 'index.js')
  const hostTypert = join(hostPkgDir, 'lib', 'typert.host.js')
  const hostRemoteClient = join(hostPkgDir, 'lib', 'typert.remote-client.js')
  const hostPatch = join(REPO, 'packages', 'host', 'cordis.patch.yml')
  const clientPkg = join(REPO, 'packages', 'client-ui')
  const clientLib = join(clientPkg, 'lib', 'client.js')
  if (target.kind === 'dev-tree') {
    // binTs 断言仅 dev-tree 列执行（npm 发布包只有 lib/*.js，无 src —— P3 根因①）。
    const binTs = join(target.cliCwd, 'apps', 'cli', 'src', 'bin.ts')
    assert(existsSync(binTs), `dsh CLI entry missing: ${binTs}（env DSH_TREE 可改指向）`)
  }
  assert(existsSync(hostLib), `host lib missing: ${hostLib} — run \`pnpm build\` first`)
  assert(existsSync(hostTypert), `generated host typert artifact missing: ${hostTypert} — run \`pnpm build\` first`)
  assert(existsSync(hostRemoteClient), `generated remote-client artifact missing: ${hostRemoteClient} — run \`pnpm build\` first`)
  assert(readFileSync(hostPatch, 'utf8').includes("name: 'dsh-gitkit'"), 'host cordis.patch.yml mismatch')
  step(`dsh target: ${target.label}; repo: ${REPO}`)

  // status/commit 往返夹具：临时真仓库 + 本地身份 + 一笔种子提交（M11 全断言：
  // 分支字段全量可断言 —— unborn 空仓库断言（④-E H 段）按 ask ④ 的「ready + 分支
  // 字段」口径替换；unborn 形状仍由 host tests/status.spec [清单 64] 真仓库覆盖）。
  const fixtureRepo = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-verify-ws-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'verify-user'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'verify@example.com'], { cwd: fixtureRepo, stdio: 'ignore' })
  // 断言 M 的文件内容 world 重读（abort 后 seed.md 内容对照）需要确定性行尾：钉死
  // autocrlf=false（本机全局 true 会把恢复的检出文件 smudge 成 CRLF）。
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: fixtureRepo, stdio: 'ignore' })
  writeFileSync(join(fixtureRepo, 'seed.md'), 'dsh verify-load seed\n')
  execFileSync('git', ['add', 'seed.md'], { cwd: fixtureRepo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'chore: verify-load seed'], { cwd: fixtureRepo, stdio: 'ignore' })
  const seedOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim()
  step(`identity fixture repo: ${fixtureRepo} (seed commit ${seedOid.slice(0, 7)}, local user verify-user <verify@example.com>)`)
  // 断言 L 的姊妹面（v2 批次一）：origin 指向的本地 bare 远端 + worktreeAdd 目标目录
  // （都放夹具仓库旁的固定派生名，finally 统一清理——不进 mkdtemp 随机名以保持可读诊断）。
  const fixtureBare = `${fixtureRepo}-origin.git`
  const fixtureWt = `${fixtureRepo}-wt`

  const home = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dsh-git-verify-'))
  const env = { ...process.env, DSH_HOME: home }
  const profileDir = join(home, 'profiles', PROFILE)

  let host = null
  let outcome = 'FAIL'
  let exitCode = EXIT_FAIL
  let hostOutput = ''
  try {
    // ── 1. 通道 A 安装（runbook §3.A：file: 安装零下载，reconcile 自动挂 bundles）──
    for (const [label, dir] of [['host dsh-gitkit', hostPkgDir], ['client dsh-gitkit-ui', clientPkg]]) {
      step(`installing ${label}: dsh plugin --profile ${PROFILE} add file:${dir.replaceAll('\\', '/')}`)
      const spec = `file:${dir.replaceAll('\\', '/')}`
      const install = await run(target.cli, [...target.cliArgs, 'plugin', '--profile', PROFILE, 'add', spec], {
        cwd: target.cliCwd, env, timeoutMs: INSTALL_TIMEOUT_MS,
      })
      assert(install.code === 0, `install failed for ${label} (exit ${install.code}):\n${install.out.slice(-2000)}`)
      step(`installed ${label} (exit 0)`)
    }
    const profilePackageJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = profilePackageJson.dependencies ?? {}
    assert(deps['dsh-gitkit'] !== undefined, `profile dependencies missing dsh-gitkit: ${JSON.stringify(deps)}`)
    assert(deps['dsh-gitkit-ui'] !== undefined, `profile dependencies missing dsh-gitkit-ui: ${JSON.stringify(deps)}`)
    // dsh plugin add 的 init 只给 DEFAULT_PROFILE_BUNDLES = [dsh-base]
    // （packages/util/official-bundles/src/bundles.ts:43-44 实读）；web 宿主需要 shipped
    // web 模板的 [dsh-base, dsh-web-app]（bundles.ts:18-21）。profile manifest 是用户层文件
    // （runbook §3.D），在此补齐 web-app bundle 层。
    const bundles = profilePackageJson.dsh?.profile?.bundles
    assert(Array.isArray(bundles), `profile dsh.profile.bundles missing: ${JSON.stringify(profilePackageJson.dsh)}`)
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      const baseAt = bundles.indexOf('@deepseek-ai/dsh-base')
      if (baseAt >= 0) {
        bundles.splice(baseAt + 1, 0, '@deepseek-ai/dsh-web-app')
      } else {
        // indexOf=-1 时 splice(-1+1=0,0,…) 会静默把 dsh-web-app 插到队首（P3 修复）：
        // 改为队尾追加 + WARN。
        console.warn('[verify] WARN: profile bundles lack dsh-base — appending dsh-web-app at the end (indexOf=-1 silent queue-head insert fixed)')
        bundles.push('@deepseek-ai/dsh-web-app')
      }
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
    step(`host booted: ${base.origin} (token acquired)`)

    // ── 3. 断言 B：无装载失败标记（runbook §5.4 反向判据）──
    assert(!/entry did not activate/.test(hostOutput), `host log reports "did not activate":\n${tail(hostOutput)}`)
    assert(!/failed to import/.test(hostOutput), `host log reports "failed to import":\n${tail(hostOutput)}`)
    // 激活 marker 按列（P3）：dev-tree 全串严格（打点整串来自插件自身
    // packages/host/src/index.ts:253 的 process.stdout.write 字面量）；npm/bin 列
    // 降级 'GitService active' 子串 + WARN（宿主可能改写 stdout 行格式）。
    const fullMarker = hostOutput.includes('[dsh-plugin-git] GitService active')
    if (target.strictActivationMarker) {
      assert(fullMarker, 'GitService activation marker missing from host stdout — plugin did not activate')
      step('host load marker "[dsh-plugin-git] GitService active": present')
    } else {
      assert(hostOutput.includes('GitService active'),
        'GitService activation marker missing from host stdout — plugin did not activate（npm/bin 列降级子串判据仍失败）')
      if (!fullMarker) {
        console.warn('[verify] WARN: full marker "[dsh-plugin-git] GitService active" not found — degraded to "GitService active" substring（npm/bin 列）')
      }
      step(`host load marker: ${fullMarker ? 'full' : 'degraded substring'} "GitService active": present`)
    }

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
    const clientEntry = entries.find((entry) => entry.id === 'dsh-gitkit-ui')
    assert(clientEntry !== undefined,
      `boot graph has no entry 'dsh-gitkit-ui'; ids: ${JSON.stringify(entries.map((e) => e.id))}`)
    assert(Array.isArray(clientEntry.inject) && clientEntry.inject.includes('dsh-gitkit'),
      `client entry inject edges missing 'dsh-gitkit': ${JSON.stringify(clientEntry.inject)}`)
    step(`boot graph: client entry present (rev ${clientEntry.rev}), inject edges: ${JSON.stringify(clientEntry.inject)}`)
    const bundleResponse = await fetch(new URL(clientEntry.url, base.origin), { headers: { cookie: browserCookie } })
    assert(bundleResponse.status === 200, `client bundle fetch ${clientEntry.url} → ${bundleResponse.status}`)
    const bundleBody = await bundleResponse.text()
    assert(bundleBody.includes('__ModuleLoader__'), 'served client bundle lacks the closure-factory marker')
    assert(bundleBody.includes('conversation.session.header.utilities'), 'served client bundle lacks the header-utilities registration')
    // 生成产物内联判据（remote 地基模块）：client 半挂的是 typert-generator 生成的
    // 描述符（生成物里 package 字段与 `"git/<method>"` 方法键分立，id 由
    // createTypertRemoteInfo 在运行时以 `${package}#${endpoint}` 拼出）。
    assert(bundleBody.includes('"dsh-gitkit"'), 'client bundle lacks the generated remote package field')
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
    // ④-K 提交对话框模块断言（J）：样式注入器标记/对话框包裹层与编辑器锚、快捷键组、词典、生成描述符。
    assert(bundleBody.includes('data-git-commit-dialog'), 'client bundle lacks the commit dialog wrapper anchor')
    assert(bundleBody.includes('data-git-commit-editor'), 'client bundle lacks the commit message editor anchor')
    assert(bundleBody.includes('data-plugin-css'), 'client bundle lacks the inline style injector tag (data-plugin-css — P2 样式管线：git.css 编译进 factory 执行时注入 <style>)')
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
    // v2 批次三 [清单 63]：CommitResult.process 捕获（`git commit` 进程整体输出，
    // 含 hook 输出——诚实命名；空输出置 null，git commit 自身恒有 stdout 汇总行 ⇒ 非 null）。
    const processOutput = commitValue.process
    assert(processOutput !== null && typeof processOutput === 'object',
      `commit result should carry the process capture: ${JSON.stringify(commitValue)}`)
    assert(processOutput.timedOut === false && typeof processOutput.durationMs === 'number'
      && typeof processOutput.stdout === 'string' && typeof processOutput.stderr === 'string'
      && processOutput.stdout.includes('[main') === true,
    `commit process capture shape wrong: ${JSON.stringify(processOutput)}`)
    step(`commit process capture OK: stdout carries the git summary line, timedOut=false, durationMs=${String(processOutput.durationMs)}ms`)
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

    // ── 5.9 断言 L（v2 批次一 §3.7 verify-load 扩展）：refs 管理面九方法各一条真宿主
    //        往返 + force 双闸负往返。world 重读纪律同 K：每个写断言后用独立 git 进程
    //        重读 refs/HEAD/tag/目录，不信 RPC 自述。夹具仓库当前 HEAD = commitValue.oid
    //        （main，clean）。
    const fixtureNorm = (p) => String(p).replaceAll('\\', '/').toLowerCase()
    // bare 目录须先存在——spawnSync 的 cwd 不存在会以 ENOENT 报错（首跑踩坑：误报
    // "spawnSync git ENOENT"，与 git 可执行文件无关）。
    mkdirSync(fixtureBare, { recursive: true })
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: fixtureBare, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', fixtureBare], { cwd: fixtureRepo, stdio: 'ignore' })

    const remoteList = await rpcCall(base.origin, apiCookie, 'git/remoteList', {})
    assert(remoteList.ok === true, `git/remoteList failed: ${JSON.stringify(remoteList)}`)
    assert(Array.isArray(remoteList.value?.remotes) && remoteList.value.remotes.length === 1,
      `git/remoteList should list exactly the origin remote: ${JSON.stringify(remoteList.value)}`)
    assert(remoteList.value.remotes[0]?.name === 'origin'
      && fixtureNorm(remoteList.value.remotes[0]?.url) === fixtureNorm(fixtureBare)
      && remoteList.value.remotes[0]?.pushUrl === null,
      `git/remoteList origin entry wrong: ${JSON.stringify(remoteList.value.remotes[0])}`)
    step(`remoteList RPC round-trip OK: origin → ${remoteList.value.remotes[0].url} (pushUrl null = 未显式配置)`)

    const branchCreate = await rpcCall(base.origin, apiCookie, 'git/branchCreate', { options: { name: 'verify-branch' } })
    assert(branchCreate.ok === true, `git/branchCreate failed: ${JSON.stringify(branchCreate)}`)
    assert(branchCreate.value?.name === 'verify-branch' && branchCreate.value?.oid === commitValue.oid
      && branchCreate.value?.checkedOut === false,
      `git/branchCreate value wrong: ${JSON.stringify(branchCreate.value)}`)
    const worldBranch = execFileSync('git', ['-C', fixtureRepo, 'rev-parse', '--verify', 'refs/heads/verify-branch'], { encoding: 'utf8' }).trim()
    assert(worldBranch === commitValue.oid, `world re-read refs/heads/verify-branch mismatch: ${worldBranch}`)
    step(`branchCreate RPC round-trip OK: verify-branch @ ${String(branchCreate.value.oid).slice(0, 7)}, world re-read matches`)

    const branchExists = await rpcCall(base.origin, apiCookie, 'git/branchCreate', { options: { name: 'verify-branch' } })
    assert(branchExists.ok === false && branchExists.error?.code === 'git/branch-exists',
      `duplicate branchCreate should be git/branch-exists: ${JSON.stringify(branchExists)}`)
    step('branchCreate duplicate OK: git/branch-exists (typed pre-check on the real host)')

    const worktreeAdd = await rpcCall(base.origin, apiCookie, 'git/worktreeAdd', { options: { path: fixtureWt, newBranch: 'verify-wt' } })
    assert(worktreeAdd.ok === true, `git/worktreeAdd failed: ${JSON.stringify(worktreeAdd)}`)
    assert(worktreeAdd.value?.branch === 'verify-wt' && /^[0-9a-f]{40}$/.test(worktreeAdd.value?.head ?? ''),
      `git/worktreeAdd value wrong: ${JSON.stringify(worktreeAdd.value)}`)
    const worldWtBranch = execFileSync('git', ['-C', fixtureWt, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    assert(worldWtBranch === 'verify-wt', `world re-read worktree HEAD mismatch: ${worldWtBranch}`)
    step(`worktreeAdd RPC round-trip OK: ${worktreeAdd.value.path} on verify-wt, world re-read matches`)

    const worktreeList = await rpcCall(base.origin, apiCookie, 'git/worktreeList', {})
    assert(worktreeList.ok === true && Array.isArray(worktreeList.value?.worktrees) && worktreeList.value.worktrees.length === 2,
      `git/worktreeList should list main + new worktree: ${JSON.stringify(worktreeList.value)}`)
    const wtEntry = worktreeList.value.worktrees.find((entry) => fixtureNorm(entry?.path) === fixtureNorm(fixtureWt))
    const mainEntry = worktreeList.value.worktrees.find((entry) => fixtureNorm(entry?.path) === fixtureNorm(fixtureRepo))
    assert(wtEntry?.branch === 'verify-wt' && wtEntry?.bare === false && wtEntry?.detached === false && wtEntry?.locked === false,
      `worktreeList entry for the new worktree wrong: ${JSON.stringify(wtEntry)}`)
    assert(mainEntry?.branch === 'main' && mainEntry?.head === commitValue.oid,
      `worktreeList entry for the main worktree wrong: ${JSON.stringify(mainEntry)}`)
    step('worktreeList RPC round-trip OK: main + verify-wt entries with branch/head/bare/detached/locked fields')

    const branchSwitch = await rpcCall(base.origin, apiCookie, 'git/branchSwitch', { name: 'verify-branch' })
    assert(branchSwitch.ok === true && branchSwitch.value?.from === 'main' && branchSwitch.value?.to === 'verify-branch',
      `git/branchSwitch failed: ${JSON.stringify(branchSwitch)}`)
    const worldHeadBranch = execFileSync('git', ['-C', fixtureRepo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    assert(worldHeadBranch === 'verify-branch', `world re-read HEAD after switch mismatch: ${worldHeadBranch}`)
    step('branchSwitch RPC round-trip OK: main → verify-branch, world re-read matches')

    const tagCreate = await rpcCall(base.origin, apiCookie, 'git/tagCreate', { options: { name: 'verify-tag', message: 'verify annotated tag' } })
    assert(tagCreate.ok === true && tagCreate.value?.name === 'verify-tag' && tagCreate.value?.annotated === true
      && /^[0-9a-f]{40}$/.test(tagCreate.value?.oid ?? ''),
      `git/tagCreate failed: ${JSON.stringify(tagCreate)}`)
    const worldTagType = execFileSync('git', ['-C', fixtureRepo, 'cat-file', '-t', 'verify-tag'], { encoding: 'utf8' }).trim()
    assert(worldTagType === 'tag', `world re-read tag object type mismatch: ${worldTagType}`)
    step(`tagCreate RPC round-trip OK: annotated verify-tag peeled @ ${String(tagCreate.value.oid).slice(0, 7)}, world re-read matches`)

    const tagExists = await rpcCall(base.origin, apiCookie, 'git/tagCreate', { options: { name: 'verify-tag' } })
    assert(tagExists.ok === false && tagExists.error?.code === 'git/tag-exists',
      `duplicate tagCreate should be git/tag-exists: ${JSON.stringify(tagExists)}`)
    step('tagCreate duplicate OK: git/tag-exists')

    const switchBack = await rpcCall(base.origin, apiCookie, 'git/branchSwitch', { name: 'main' })
    assert(switchBack.ok === true && switchBack.value?.to === 'main',
      `git/branchSwitch back to main failed: ${JSON.stringify(switchBack)}`)
    assert(execFileSync('git', ['-C', fixtureRepo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim() === 'main',
      'world re-read HEAD should be back on main')
    step('branchSwitch back to main OK')

    // verify-branch 与 main 同指（K 链提交后未再前进）⇒ -d 可删（wasMerged=true）。
    const branchDelete = await rpcCall(base.origin, apiCookie, 'git/branchDelete', { options: { name: 'verify-branch' } })
    assert(branchDelete.ok === true && branchDelete.value?.deleted === 'verify-branch' && branchDelete.value?.wasMerged === true,
      `git/branchDelete failed: ${JSON.stringify(branchDelete)}`)
    let branchGone = false
    try {
      execFileSync('git', ['-C', fixtureRepo, 'rev-parse', '--verify', '--quiet', 'refs/heads/verify-branch'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      branchGone = true
    }
    assert(branchGone, 'world re-read: refs/heads/verify-branch should be gone after delete')
    step('branchDelete RPC round-trip OK: verify-branch deleted (wasMerged=true), world re-read gone')

    const branchMissing = await rpcCall(base.origin, apiCookie, 'git/branchDelete', { options: { name: 'verify-branch' } })
    assert(branchMissing.ok === false && branchMissing.error?.code === 'git/branch-not-found',
      `deleting a missing branch should be git/branch-not-found: ${JSON.stringify(branchMissing)}`)
    step('branchDelete missing OK: git/branch-not-found')

    const tagDelete = await rpcCall(base.origin, apiCookie, 'git/tagDelete', { name: 'verify-tag' })
    assert(tagDelete.ok === true && tagDelete.value?.deleted === 'verify-tag',
      `git/tagDelete failed: ${JSON.stringify(tagDelete)}`)
    let tagGone = false
    try {
      execFileSync('git', ['-C', fixtureRepo, 'cat-file', '-e', 'verify-tag'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      tagGone = true
    }
    assert(tagGone, 'world re-read: verify-tag should be gone after delete')
    step('tagDelete RPC round-trip OK: verify-tag deleted, world re-read gone')

    const tagMissing = await rpcCall(base.origin, apiCookie, 'git/tagDelete', { name: 'verify-tag' })
    assert(tagMissing.ok === false && tagMissing.error?.code === 'git/tag-not-found',
      `deleting a missing tag should be git/tag-not-found: ${JSON.stringify(tagMissing)}`)
    step('tagDelete missing OK: git/tag-not-found')

    // force 双闸 host 半的真宿主面：force=true 无 acknowledged ⇒ git/bad-request
    // 'force-unacknowledged'（守卫最前，零命令——夹具此时连 upstream 都没有也不影响）。
    const forceUnack = await rpcCall(base.origin, apiCookie, 'git/push', {
      options: { setUpstream: false, force: true, acknowledged: false },
    })
    assert(forceUnack.ok === false && forceUnack.error?.code === 'git/bad-request',
      `force push without acknowledgement should be git/bad-request: ${JSON.stringify(forceUnack)}`)
    assert(forceUnack.error?.details?.reason === 'force-unacknowledged',
      `force-unacknowledged reason should cross the wire: ${JSON.stringify(forceUnack.error)}`)
    step('push force guard OK: force without acknowledged rejected as git/bad-request force-unacknowledged')

    const worktreeRemove = await rpcCall(base.origin, apiCookie, 'git/worktreeRemove', { options: { path: fixtureWt } })
    assert(worktreeRemove.ok === true && fixtureNorm(worktreeRemove.value?.removed) === fixtureNorm(fixtureWt),
      `git/worktreeRemove failed: ${JSON.stringify(worktreeRemove)}`)
    assert(!existsSync(fixtureWt), `worktree directory should be gone after remove: ${fixtureWt}`)
    const worktreeListAfter = await rpcCall(base.origin, apiCookie, 'git/worktreeList', {})
    assert(worktreeListAfter.ok === true && worktreeListAfter.value?.worktrees?.length === 1,
      `worktreeList should fall back to the main worktree only: ${JSON.stringify(worktreeListAfter.value)}`)
    step('worktreeRemove RPC round-trip OK: directory gone, worktreeList back to 1 entry')

    const worktreeMissing = await rpcCall(base.origin, apiCookie, 'git/worktreeRemove', { options: { path: fixtureWt } })
    assert(worktreeMissing.ok === false && worktreeMissing.error?.code === 'git/worktree-failed',
      `removing a missing worktree should be git/worktree-failed: ${JSON.stringify(worktreeMissing)}`)
    step('worktreeRemove missing OK: git/worktree-failed')

    // ── 5.95 断言 M（v2 批次二 §4.7 verify-load 扩展）：历史面六方法各一条真宿主
    //        往返 + 时间旅行冲突真宿主形状。world 重读纪律同 K/L：每个写断言后用独立
    //        git 进程重读 HEAD/refs/工作区，不信 RPC 自述。夹具当前 HEAD = main @
    //        commitValue.oid（K 链提交），clean。
    const worldGit = (...args) => execFileSync('git', args, { cwd: fixtureRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const worldStatusPorcelain = () => execFileSync('git', ['status', '--porcelain'], { cwd: fixtureRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const worldStaged = () => worldStatusPorcelain().split('\n').filter((line) => line.startsWith('M ') || line.startsWith('A ') || line.startsWith('D '))
    const pseudoHeadExists = (head) => {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', head], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })
        return true
      } catch {
        return false
      }
    }

    // M-1 blame：chain.txt（K 链提交的单行文件）→ world 首段 oid 对照。
    const blame = await rpcCall(base.origin, apiCookie, 'git/blame', { options: { path: 'chain.txt' } })
    assert(blame.ok === true, `git/blame failed: ${JSON.stringify(blame)}`)
    assert(blame.value?.truncated === false && blame.value?.lineCount === 1
      && Array.isArray(blame.value?.ranges) && blame.value.ranges.length === 1
      && Array.isArray(blame.value?.commits) && blame.value.commits.length === 1,
    `git/blame value wrong for a one-line file: ${JSON.stringify(blame.value)}`)
    const worldBlameFirst = worldGit('blame', '--porcelain', '--', 'chain.txt').split('\n')[0] ?? ''
    const worldBlameOid = worldBlameFirst.split(' ')[0] ?? ''
    assert(/^[0-9a-f]{40}$/.test(worldBlameOid) && blame.value.ranges[0]?.oid === worldBlameOid,
      `git/blame range oid should match world re-read git blame --porcelain: ${String(blame.value?.ranges?.[0]?.oid)} vs ${worldBlameOid}`)
    assert(blame.value.commits[0]?.oid === worldBlameOid, 'git/blame commits[0].oid should match world re-read')
    step(`blame RPC round-trip OK: chain.txt @ ${worldBlameOid.slice(0, 7)} (world re-read git blame --porcelain matches)`)

    // M-2 compareBranches：world 建分支 verify-cmp @ commitValue + main 前进一笔 →
    // ahead = main 独有 1 笔、behind = 0、mergeBase = verify-cmp。
    worldGit('branch', 'verify-cmp', commitValue.oid)
    writeFileSync(join(fixtureRepo, 'cmp.txt'), 'dsh verify-load compare seed\n')
    worldGit('add', 'cmp.txt')
    worldGit('commit', '-q', '-m', 'chore: verify-load compare commit')
    const cmpOid = worldGit('rev-parse', 'HEAD')
    const compare = await rpcCall(base.origin, apiCookie, 'git/compareBranches', { options: { base: 'verify-cmp', compare: 'main' } })
    assert(compare.ok === true, `git/compareBranches failed: ${JSON.stringify(compare)}`)
    assert(compare.value?.aheadCount === 1 && compare.value?.behindCount === 0
      && Array.isArray(compare.value?.ahead) && compare.value.ahead.length === 1
      && compare.value.ahead[0]?.oid === cmpOid,
    `git/compareBranches value wrong: ${JSON.stringify(compare.value)}`)
    assert(compare.value?.mergeBase === commitValue.oid,
      `mergeBase should equal world git merge-base (verify-cmp): ${String(compare.value?.mergeBase)} vs ${commitValue.oid}`)
    assert(worldGit('merge-base', 'verify-cmp', 'main') === compare.value.mergeBase,
      'mergeBase should match world re-read git merge-base')
    step('compareBranches RPC round-trip OK: main ahead 1 of verify-cmp, mergeBase world-matched')

    // M-3 reset 三档 world 重读（K 链夹具是真仓库，reset 目标 = 对比提交链）。
    writeFileSync(join(fixtureRepo, 'cmp2.txt'), 'dsh verify-load reset seed\n')
    worldGit('add', 'cmp2.txt')
    worldGit('commit', '-q', '-m', 'chore: verify-load reset commit')
    const cmp2Oid = worldGit('rev-parse', 'HEAD')
    const resetSoft = await rpcCall(base.origin, apiCookie, 'git/reset', {
      options: { kind: 'soft', target: 'HEAD~1', acknowledged: true, baseRevision: cmp2Oid },
    })
    assert(resetSoft.ok === true && resetSoft.value?.op === 'reset'
      && resetSoft.value?.oldOid === cmp2Oid && resetSoft.value?.newOid === cmpOid,
    `git/reset soft failed: ${JSON.stringify(resetSoft)}`)
    assert(worldGit('rev-parse', 'HEAD') === cmpOid && worldStaged().length === 1,
      `after reset --soft the world should be HEAD=cmpOid with 1 staged entry (got porcelain ${JSON.stringify(worldStatusPorcelain())})`)
    step('reset soft RPC OK: HEAD stepped back, cmp2.txt staged (world re-read)')

    const resetHard = await rpcCall(base.origin, apiCookie, 'git/reset', {
      options: { kind: 'hard', target: null, acknowledged: true, baseRevision: cmpOid },
    })
    assert(resetHard.ok === true && resetHard.value?.op === 'reset' && resetHard.value?.newOid === cmpOid,
      `git/reset hard failed: ${JSON.stringify(resetHard)}`)
    assert(worldGit('rev-parse', 'HEAD') === cmpOid && worldStatusPorcelain() === '',
      'after reset --hard the world should be clean at cmpOid (cmp2.txt gone from index and worktree)')
    step('reset hard RPC OK: index and worktree reset, world clean')

    // 无 acknowledged ⇒ git/bad-request 'unacknowledged'（零命令——HEAD 不动）。
    const resetUnack = await rpcCall(base.origin, apiCookie, 'git/reset', {
      options: { kind: 'hard', target: null, acknowledged: false, baseRevision: cmpOid },
    })
    assert(resetUnack.ok === false && resetUnack.error?.code === 'git/bad-request'
      && resetUnack.error?.details?.reason === 'unacknowledged',
    `reset hard without acknowledgement should be git/bad-request unacknowledged: ${JSON.stringify(resetUnack)}`)
    assert(worldGit('rev-parse', 'HEAD') === cmpOid, 'rejected reset should execute zero commands (HEAD unchanged)')
    step('reset guard OK: hard without acknowledged rejected (zero commands)')

    writeFileSync(join(fixtureRepo, 'cmp3.txt'), 'dsh verify-load mixed seed\n')
    worldGit('add', 'cmp3.txt')
    const resetMixed = await rpcCall(base.origin, apiCookie, 'git/reset', {
      options: { kind: 'mixed', target: null, acknowledged: true, baseRevision: worldGit('rev-parse', 'HEAD') },
    })
    assert(resetMixed.ok === true && resetMixed.value?.op === 'reset',
      `git/reset mixed failed: ${JSON.stringify(resetMixed)}`)
    assert(worldStaged().length === 0 && worldStatusPorcelain() === '?? cmp3.txt',
      `after reset --mixed the staged entry should be untracked in the world: ${JSON.stringify(worldStatusPorcelain())}`)
    step('reset mixed RPC OK: staged entry returned to the worktree as untracked (world re-read)')
    rmSync(join(fixtureRepo, 'cmp3.txt'), { force: true })

    // M-4 cherryPick 冲突 ⇒ git/merge-conflict 真宿主形状 + 叠加拒绝 + abort 复原。
    worldGit('checkout', '-q', '-b', 'verify-cp')
    writeFileSync(join(fixtureRepo, 'seed.md'), 'cp branch edit\n')
    worldGit('add', 'seed.md')
    worldGit('commit', '-q', '-m', 'chore: verify-load cp edit')
    const cpOid = worldGit('rev-parse', 'HEAD')
    worldGit('checkout', '-q', 'main')
    writeFileSync(join(fixtureRepo, 'seed.md'), 'main edit\n')
    worldGit('add', 'seed.md')
    worldGit('commit', '-q', '-m', 'chore: verify-load main edit')
    const mainEditOid = worldGit('rev-parse', 'HEAD')
    const cpConflict = await rpcCall(base.origin, apiCookie, 'git/cherryPick', {
      options: { oid: cpOid, acknowledged: true, baseRevision: mainEditOid },
    })
    assert(cpConflict.ok === false && cpConflict.error?.code === 'git/merge-conflict',
      `conflicting cherryPick should be git/merge-conflict: ${JSON.stringify(cpConflict)}`)
    const worldUnmerged = worldGit('diff', '--name-only', '--diff-filter=U').split('\n').filter((line) => line !== '')
    assert(cpConflict.error?.details?.op === 'cherry-pick'
      && Array.isArray(cpConflict.error?.details?.conflicted)
      && JSON.stringify(cpConflict.error.details.conflicted) === JSON.stringify(worldUnmerged)
      && cpConflict.error?.details?.abortable === true,
    `merge-conflict details should carry op/conflicted(world diff-filter=U)/abortable: ${JSON.stringify(cpConflict.error)}`)
    assert(pseudoHeadExists('CHERRY_PICK_HEAD') === true && pseudoHeadExists('REVERT_HEAD') === false,
      'world re-read: CHERRY_PICK_HEAD should exist (and REVERT_HEAD not) after the conflicting pick')
    assert(worldGit('rev-parse', 'HEAD') === mainEditOid, 'HEAD should not advance on a conflicted pick')
    step('cherryPick conflict OK: git/merge-conflict real-host shape (conflicted world-matched, abortable)')

    const cpOverlap = await rpcCall(base.origin, apiCookie, 'git/cherryPick', {
      options: { oid: cpOid, acknowledged: true, baseRevision: worldGit('rev-parse', 'HEAD') },
    })
    assert(cpOverlap.ok === false && cpOverlap.error?.code === 'git/operation-in-progress'
      && cpOverlap.error?.details?.op === 'cherry-pick',
    `overlapping cherryPick during an in-progress pick should be git/operation-in-progress: ${JSON.stringify(cpOverlap)}`)
    const resetOverlap = await rpcCall(base.origin, apiCookie, 'git/reset', {
      options: { kind: 'soft', target: null, acknowledged: true, baseRevision: worldGit('rev-parse', 'HEAD') },
    })
    assert(resetOverlap.ok === false && resetOverlap.error?.code === 'git/operation-in-progress',
      `reset during an in-progress pick should be git/operation-in-progress: ${JSON.stringify(resetOverlap)}`)
    step('operation-in-progress OK: overlapping cherryPick and reset both rejected (CHERRY_PICK_HEAD present)')

    const abort = await rpcCall(base.origin, apiCookie, 'git/abortOperation', {})
    assert(abort.ok === true && abort.value?.aborted === 'cherry-pick',
      `git/abortOperation failed: ${JSON.stringify(abort)}`)
    assert(worldGit('rev-parse', 'HEAD') === mainEditOid && !pseudoHeadExists('CHERRY_PICK_HEAD')
      && worldStatusPorcelain() === ''
      && readFileSync(join(fixtureRepo, 'seed.md'), 'utf8') === 'main edit\n',
    'world re-read after abort: HEAD restored, intermediate state cleared, worktree clean, seed.md back to the main edit')
    step('abortOperation OK: world restored to the pre-pick HEAD (CHERRY_PICK_HEAD cleared)')

    const abortAgain = await rpcCall(base.origin, apiCookie, 'git/abortOperation', {})
    assert(abortAgain.ok === true && abortAgain.value?.aborted === null,
      `idempotent abortOperation should return aborted=null: ${JSON.stringify(abortAgain)}`)
    step('abortOperation idempotent OK: aborted=null with no intermediate state')

    // M-5 cherryPick 成功路径（非冲突提交摘到 main）：world HEAD 前进 + 文件落盘。
    worldGit('checkout', '-q', 'verify-cp')
    writeFileSync(join(fixtureRepo, 'cpfile.txt'), 'dsh verify-load cp file\n')
    worldGit('add', 'cpfile.txt')
    worldGit('commit', '-q', '-m', 'chore: verify-load cp file')
    const cpFileOid = worldGit('rev-parse', 'HEAD')
    worldGit('checkout', '-q', 'main')
    const cpOk = await rpcCall(base.origin, apiCookie, 'git/cherryPick', {
      options: { oid: cpFileOid, acknowledged: true, baseRevision: worldGit('rev-parse', 'HEAD') },
    })
    assert(cpOk.ok === true && cpOk.value?.op === 'cherry-pick' && cpOk.value?.oldOid === mainEditOid
      && cpOk.value?.newOid === worldGit('rev-parse', 'HEAD'),
    `git/cherryPick success path failed: ${JSON.stringify(cpOk)}`)
    assert(existsSync(join(fixtureRepo, 'cpfile.txt')) && worldStatusPorcelain() === '',
      'world re-read after the pick: cpfile.txt present and worktree clean')
    const pickedOid = worldGit('rev-parse', 'HEAD')
    step('cherryPick success RPC OK: HEAD advanced, cpfile.txt landed (world re-read)')

    // M-6 revert：逆向摘到的提交（文件消失，world HEAD 前进）；空 revert ⇒ git-error op revert。
    const revert = await rpcCall(base.origin, apiCookie, 'git/revert', {
      options: { oid: pickedOid, acknowledged: true, baseRevision: pickedOid },
    })
    assert(revert.ok === true && revert.value?.op === 'revert' && revert.value?.oldOid === pickedOid,
      `git/revert failed: ${JSON.stringify(revert)}`)
    assert(!existsSync(join(fixtureRepo, 'cpfile.txt')) && worldStatusPorcelain() === ''
      && worldGit('rev-parse', 'HEAD') === revert.value?.newOid,
    'world re-read after revert: cpfile.txt gone, worktree clean, HEAD advanced to the revert commit')
    const revertHead = worldGit('rev-parse', 'HEAD')
    const emptyRevert = await rpcCall(base.origin, apiCookie, 'git/revert', {
      options: { oid: pickedOid, acknowledged: true, baseRevision: revertHead },
    })
    assert(emptyRevert.ok === false && emptyRevert.error?.code === 'git/git-error'
      && emptyRevert.error?.details?.op === 'revert',
    `an empty revert (already reverted) should be git-error op=revert: ${JSON.stringify(emptyRevert)}`)
    assert(worldGit('rev-parse', 'HEAD') === revertHead && worldStatusPorcelain() === '' && !pseudoHeadExists('REVERT_HEAD'),
      'world re-read after the empty revert: HEAD unchanged, no intermediate state left')
    step('revert RPC OK: picked commit reverted (world re-read) + empty revert ⇒ git-error op=revert')

    // ── 5.97 断言 N（v2 批次三 §5.7 verify-load 扩展）：提交链路与护栏七方法各一条
    //        真宿主往返 + 密钥硬阻断真宿主形状。world 重读纪律同 K/L/M。夹具当前
    //        HEAD = main @ revertHead（M 链收尾），clean。──
    const worldCommitCount = () => Number(worldGit('rev-list', '--count', '--all'))
    const restoreStaged = (...paths) => execFileSync('git', ['restore', '--staged', '--', ...paths], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })

    // N-1 stagePatch：对 chain.txt 的单 hunk patch → world 重读 staged diff 只含选中行。
    const stagePatch = await rpcCall(base.origin, apiCookie, 'git/stagePatch', {
      options: {
        path: 'chain.txt',
        patch: [
          'diff --git a/chain.txt b/chain.txt',
          '--- a/chain.txt',
          '+++ b/chain.txt',
          '@@ -1 +1 @@',
          '-dsh verify-load commit chain',
          '+chain patched by stagePatch',
          '',
        ].join('\n'),
      },
    })
    assert(stagePatch.ok === true && stagePatch.value?.staged === 1,
      `git/stagePatch failed: ${JSON.stringify(stagePatch)}`)
    const worldStagedDiff = execFileSync('git', ['diff', '--cached', '--', 'chain.txt'], { cwd: fixtureRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert(worldStagedDiff.includes('+chain patched by stagePatch')
      && !worldStagedDiff.includes('patched by stagePatch patch'),
    `world re-read staged diff should carry the applied hunk: ${JSON.stringify(worldStagedDiff)}`)
    step('stagePatch RPC round-trip OK: hunk applied to the index, world re-read matches')
    restoreStaged('chain.txt')

    // N-2 scanStaged 密钥样例（AWS 文档假值）：blocked + redactedMatch 无明文 +
    //     commit 密钥硬阻断（D5=A overridable:false，world 零提交）。
    writeFileSync(join(fixtureRepo, 'secret-sample.txt'), 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n')
    execFileSync('git', ['add', '--', 'secret-sample.txt'], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })
    const scanStaged = await rpcCall(base.origin, apiCookie, 'git/scanStaged', {})
    assert(scanStaged.ok === true && scanStaged.value?.blocked === true,
      `git/scanStaged should block the staged secret: ${JSON.stringify(scanStaged)}`)
    const secretViolation = (scanStaged.value?.violations ?? []).find((v) => v.kind === 'secret' && v.path === 'secret-sample.txt')
    assert(secretViolation !== undefined && typeof secretViolation.redactedMatch === 'string'
      && secretViolation.redactedMatch.startsWith('AKIA')
      && !secretViolation.redactedMatch.includes('IOSFODNN7EXAMPLE'),
    `secret violation should carry a redacted match without plaintext: ${JSON.stringify(secretViolation)}`)
    step('scanStaged RPC OK: secret blocked, redactedMatch masked (no plaintext crossing the wire)')
    const commitsBeforeBlock = worldCommitCount()
    const blockedCommit = await rpcCall(base.origin, apiCookie, 'git/commit', {
      options: { message: 'feat: sneak the key', amend: false, skipHooks: false },
    })
    assert(blockedCommit.ok === false && blockedCommit.error?.code === 'git/commit-blocked',
      `commit with a staged secret should be git/commit-blocked: ${JSON.stringify(blockedCommit)}`)
    assert(blockedCommit.error?.details?.overridable === false
      && Array.isArray(blockedCommit.error?.details?.violations)
      && blockedCommit.error.details.violations.some((v) => v.kind === 'secret'),
    `commit-blocked details should carry overridable:false + secret violations (D5=A): ${JSON.stringify(blockedCommit.error)}`)
    assert(worldCommitCount() === commitsBeforeBlock,
      'commit-blocked should execute zero commits (world re-read commit count unchanged)')
    step('commit secret hard-block OK: git/commit-blocked overridable=false (D5=A), zero commands')
    restoreStaged('secret-sample.txt')
    rmSync(join(fixtureRepo, 'secret-sample.txt'), { force: true })

    // N-3 repoDiagnostics：夹具钉死 autocrlf=false（§1 步）→ config 回读 + 抽样形状。
    const repoDiagnostics = await rpcCall(base.origin, apiCookie, 'git/repoDiagnostics', {})
    assert(repoDiagnostics.ok === true, `git/repoDiagnostics failed: ${JSON.stringify(repoDiagnostics)}`)
    assert(repoDiagnostics.value?.autocrlf === 'false' && repoDiagnostics.value?.coreEol === null
      && Number.isInteger(repoDiagnostics.value?.worktreeCrlfCount)
      && Array.isArray(repoDiagnostics.value?.mixedEolFiles),
    `git/repoDiagnostics value wrong: ${JSON.stringify(repoDiagnostics.value)}`)
    step(`repoDiagnostics RPC OK: autocrlf=false (pinned fixture), crlfCount=${String(repoDiagnostics.value.worktreeCrlfCount)}, mixed list=${JSON.stringify(repoDiagnostics.value.mixedEolFiles)}`)

    // N-4 stashPush/stashList/stashPop 全链（D4=B 缺省含 untracked）：world 重读。
    writeFileSync(join(fixtureRepo, 'stash-file.txt'), 'dsh verify-load stash payload\n')
    const worldStashCount = () => worldGit('stash', 'list', '--format=%H').split('\n').filter((line) => line !== '').length
    const stashPush = await rpcCall(base.origin, apiCookie, 'git/stashPush', {
      options: { includeUntracked: true, message: 'verify stash' },
    })
    assert(stashPush.ok === true && stashPush.value?.index === 0,
      `git/stashPush failed: ${JSON.stringify(stashPush)}`)
    assert(worldStashCount() === 1 && worldStatusPorcelain() === ''
      && !existsSync(join(fixtureRepo, 'stash-file.txt')),
    `world after stashPush: stash listed, worktree clean, untracked gone (porcelain ${JSON.stringify(worldStatusPorcelain())})`)
    step('stashPush RPC round-trip OK: untracked included (D4=B), world re-read clean with 1 stash entry')

    const stashList = await rpcCall(base.origin, apiCookie, 'git/stashList', {})
    assert(stashList.ok === true && Array.isArray(stashList.value?.stashes) && stashList.value.stashes.length === 1,
      `git/stashList failed: ${JSON.stringify(stashList)}`)
    const stashEntry = stashList.value.stashes[0]
    const worldStashOid = worldGit('rev-parse', 'stash@{0}')
    assert(stashEntry.index === 0 && stashEntry.oid === worldStashOid
      && stashEntry.message.includes('verify stash')
      && !Number.isNaN(Date.parse(stashEntry.authoredAt)),
    `stashList entry wrong vs world re-read: ${JSON.stringify(stashEntry)} vs ${worldStashOid}`)
    step('stashList RPC round-trip OK: index/oid world-matched, message/authoredAt shaped')

    const stashPop = await rpcCall(base.origin, apiCookie, 'git/stashPop', { options: {} })
    assert(stashPop.ok === true && stashPop.value?.index === 0,
      `git/stashPop failed: ${JSON.stringify(stashPop)}`)
    assert(readFileSync(join(fixtureRepo, 'stash-file.txt'), 'utf8') === 'dsh verify-load stash payload\n'
      && worldStashCount() === 0,
    'world after stashPop: payload restored, stash list empty')
    step('stashPop RPC round-trip OK: payload restored, stash cleared (world re-read)')

    // N-5 stashPop 冲突 ⇒ git/merge-conflict（op 'stash-pop'，批次二注册的码在本批
    //     语义行消费）且 **stash 未丢**（git 语义，§5.10）。
    writeFileSync(join(fixtureRepo, 'conflict-stash.txt'), 'base\n')
    execFileSync('git', ['add', '--', 'conflict-stash.txt'], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['commit', '-q', '-m', 'chore: verify-load stash conflict base'], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(join(fixtureRepo, 'conflict-stash.txt'), 'stashed\n')
    const conflictStash = await rpcCall(base.origin, apiCookie, 'git/stashPush', { options: { includeUntracked: true, message: 'conflict stash' } })
    assert(conflictStash.ok === true, `git/stashPush (conflict fixture) failed: ${JSON.stringify(conflictStash)}`)
    writeFileSync(join(fixtureRepo, 'conflict-stash.txt'), 'mainline\n')
    execFileSync('git', ['add', '--', 'conflict-stash.txt'], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['commit', '-q', '-m', 'chore: verify-load stash conflict mainline'], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })
    const stashPopConflict = await rpcCall(base.origin, apiCookie, 'git/stashPop', { options: {} })
    assert(stashPopConflict.ok === false && stashPopConflict.error?.code === 'git/merge-conflict',
      `conflicting stashPop should be git/merge-conflict: ${JSON.stringify(stashPopConflict)}`)
    const worldUnmergedStash = worldGit('diff', '--name-only', '--diff-filter=U').split('\n').filter((line) => line !== '')
    assert(stashPopConflict.error?.details?.op === 'stash-pop'
      && JSON.stringify(stashPopConflict.error?.details?.conflicted) === JSON.stringify(worldUnmergedStash)
      && stashPopConflict.error?.details?.abortable === false,
    `merge-conflict details should carry op='stash-pop'/conflicted(world)/abortable:false: ${JSON.stringify(stashPopConflict.error)}`)
    assert(worldStashCount() === 1,
      'world re-read: the stash entry must survive a conflicted pop (git semantics, plan §5.10)')
    step('stashPop conflict OK: git/merge-conflict op=stash-pop, stash retained (world re-read)')
    execFileSync('git', ['reset', '--hard', '-q'], { cwd: fixtureRepo, stdio: ['ignore', 'pipe', 'pipe'] })

    // N-6 stashDrop danger 闸：无 acknowledged ⇒ git/bad-request 'unacknowledged'
    //     （零命令——stash 仍在）；acknowledged ⇒ 删除（world 重读清空）；再删 ⇒
    //     git/stash-not-found。
    const stashDropUnack = await rpcCall(base.origin, apiCookie, 'git/stashDrop', { options: { index: 0, acknowledged: false } })
    assert(stashDropUnack.ok === false && stashDropUnack.error?.code === 'git/bad-request'
      && stashDropUnack.error?.details?.reason === 'unacknowledged',
    `stashDrop without acknowledgement should be git/bad-request unacknowledged: ${JSON.stringify(stashDropUnack)}`)
    assert(worldStashCount() === 1, 'rejected stashDrop should execute zero commands (stash entry unchanged)')
    step('stashDrop guard OK: unacknowledged rejected (zero commands)')
    const stashDrop = await rpcCall(base.origin, apiCookie, 'git/stashDrop', { options: { index: 0, acknowledged: true } })
    assert(stashDrop.ok === true && stashDrop.value?.index === 0,
      `git/stashDrop failed: ${JSON.stringify(stashDrop)}`)
    assert(worldStashCount() === 0, 'world re-read: stash list empty after the acknowledged drop')
    step('stashDrop RPC round-trip OK: stash entry dropped (world re-read)')
    const stashDropMissing = await rpcCall(base.origin, apiCookie, 'git/stashDrop', { options: { index: 0, acknowledged: true } })
    assert(stashDropMissing.ok === false && stashDropMissing.error?.code === 'git/stash-not-found'
      && stashDropMissing.error?.details?.index === 0,
    `dropping a missing stash should be git/stash-not-found: ${JSON.stringify(stashDropMissing)}`)
    step('stashDrop missing OK: git/stash-not-found (typed pre-check on the real host)')

    // ── 5.6 断言 F：strict 注册判别（§⑧-2 动态安装链路）。
    //        生成产物 lib/typert.host.js 经 typert-loader 自动注册后，scope 的
    //        strict codec 在网关拒绝非法值为 gateway/input-invalid；若仍是 SRC
    //        反射兜底，该值会穿过网关进方法 → git/git-error。
    //        按列 flag target.strictTypert（矩阵列默认 true；首跑 fail 的处置是该列
    //        置 false 并记录，非全局放宽）。
    if (!target.strictTypert) {
      step('strict typert registration probe: not asserted for this column (target.strictTypert=false)')
    } else {
      const strictProbe = await rpcCall(base.origin, apiCookie, 'git/identity', { scope: 'not-a-scope' })
      assert(strictProbe.ok === false, `git/identity(scope=<invalid>) unexpectedly succeeded: ${JSON.stringify(strictProbe)}`)
      assert(strictProbe.error?.code === 'gateway/input-invalid',
        `expected gateway/input-invalid (strict descriptor registered), got ${JSON.stringify(strictProbe.error)} — ` +
        'the generated ./typert artifact was NOT registered (SRC fallback is active)')
      step('strict descriptor registered OK: invalid scope rejected as gateway/input-invalid (typert-loader auto-registration works)')
    }

    // ── 6. 断言 E：未知端点不被服务（证明 /api 路由表真实解析了 git 命名空间）。
    //        实测：未知端点在 Connection 传输层就 404（gateway 的 claimsEndpoint 不认领
    //        未注册端点，请求到不了 dispatchRpc），到达 dispatchRpc 的未知方法才返回
    //        gateway/invocation-unavailable。两种拒绝形状都算通过。──
    const negative = await rpcNegative(base.origin, apiCookie, 'git/__no_such_method__')
    assert(negative.rejected, `unknown endpoint unexpectedly succeeded: ${JSON.stringify(negative)}`)
    step(`negative check OK: unknown endpoint rejected (${negative.detail})`)

    outcome = 'PASS'
    exitCode = EXIT_PASS
    step('ALL CHECKS PASSED')
  } catch (error) {
    if (error instanceof SkipError) {
      ({ outcome, exit: exitCode } = applySkipDiscipline(error, '[verify]'))
    } else if (target.observation) {
      // 观测列：KNOWN-UNSUPPORTED 行改纯记录式（报告 §2.3）——不预设失败形态，
      // 记录实际失败与宿主输出尾部；exit 0（观测列 KNOWN-UNSUPPORTED 亦 0）。
      console.warn(`[verify] KNOWN-UNSUPPORTED（观测列纯记录，双结局合法）: ${error?.message ?? String(error)}`)
      if (hostOutput) console.warn(`---- host output tail ----\n${tail(hostOutput, 4000)}`)
      outcome = 'KNOWN-UNSUPPORTED'
      exitCode = EXIT_PASS
    } else {
      fail(error?.message ?? String(error))
      if (hostOutput) console.error(`---- host output tail ----\n${tail(hostOutput, 4000)}`)
      outcome = 'FAIL'
      exitCode = EXIT_FAIL
    }
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
    for (const derived of [fixtureWt, fixtureBare]) {
      try {
        if (existsSync(derived)) {
          rmSync(derived, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
          step(`removed fixture sibling ${derived}`)
        }
      } catch (error) {
        console.warn(`[verify] WARN: could not remove fixture sibling ${derived}: ${error?.message ?? error}`)
      }
    }
  }
  return { outcome, exit: exitCode }
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

// ── 编排（P3）：列解析（模块顶层）→ npm 列安装回填（try 内首步，延迟解析）→ main
//    → 统一 finally（清理 npm prefix 临时目录）→ RESULT 行 → 唯一退出点。──
let outcome = 'FAIL'
let exitCode = EXIT_FAIL
let npmPrefix = null // npm 列 --prefix 临时目录：try 内赋值、统一 finally 清理
try {
  step(`verify target: ${target.label}${target.observation ? '（观测列：KNOWN-UNSUPPORTED / PASS-UNEXPECTED 双结局合法，纯记录式）' : ''}`)
  if (target.npmSpec) {
    npmPrefix = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'dshgit-verify-npm-'))
    step(`npm column: installing ${target.npmSpec} into prefix ${npmPrefix}`)
    const installed = await npmInstallToPrefix(target.npmSpec, npmPrefix)
    target.cli = installed.cli
    target.cliArgs = installed.cliArgs
    target.cliCwd = installed.cliCwd
    step(`npm column ready: node ${installed.cliArgs[0]} (cwd=${installed.cliCwd}; npm view version → ${installed.viewVersion})`)
  }
  const mainResult = await main()
  outcome = mainResult.outcome
  exitCode = mainResult.exit
  // 观测列双结局落地（报告 §2.3）：全断言通过 = PASS-UNEXPECTED（exit 1）——声明下限
  // 外的宿主意外可装载 = 兼容声明被现实证伪，必须显式失败而非静默记 PASS。
  if (target.observation && outcome === 'PASS') {
    console.warn('[verify] WARN: observation column passed all assertions — recorded as PASS-UNEXPECTED (exit 1)：声明下限外宿主意外可装载')
    outcome = 'PASS-UNEXPECTED'
    exitCode = EXIT_FAIL
  }
} catch (error) {
  if (error instanceof SkipError) {
    ({ outcome, exitCode } = applySkipDiscipline(error, '[verify]'))
  } else {
    fail(error?.stack ?? String(error))
  }
} finally {
  if (npmPrefix) {
    try {
      rmSync(npmPrefix, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      step(`removed npm prefix ${npmPrefix}`)
    } catch (error) {
      console.warn(`[verify] WARN: could not remove npm prefix ${npmPrefix}: ${error?.message ?? error}`)
    }
  }
}
console.log(`[verify] RESULT: outcome=${outcome} target=${target.label}`)
process.exit(exitCode)
