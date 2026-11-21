/**
 * verify-rpc.mjs — verify 系脚本公共助手收口（Phase 2 重构：verify-load.mjs ≡
 * verify-install.mjs 的同源复制助手提为单源；verify-target.mjs 的私有 assert/killTree
 * 同面收编）。行为逐字节保真——退出码纪律、断言消息文本、step 行文本均不变。
 *
 * 已知漂移按登记保留（两侧语义差异不得顺手统一——共享实现以参数表达差异）：
 *   - rpcCall / tokenQueryCookie / exchangeTokenForCookie：install 版 fetch 带
 *     `AbortSignal.timeout(RPC_TIMEOUT_MS)` 上界（无信号 fetch 可无限挂起——第 2 轮
 *     verify:install 空输出失败的头号嫌疑，journal 见 verify-install.mjs 头注），
 *     load 版不带。signalMs 参数：install 传 RPC_TIMEOUT_MS，load 不传（无信号）。
 *   - extractJsonAfter：首个 assert 的 marker 缺失消息两侧措辞不同（load 'not found' /
 *     install 'not found in served HTML'——法医诊断口径差异）。missingMessage 参数保真。
 *   - tokenQueryCookie / exchangeTokenForCookie 的 step 行（'browser cookie acquired…' /
 *     'API operator cookie acquired…'）经调用方 step 函数落各自前缀（'[verify]' vs
 *     '[verify-install]' + journal）——step 以参数注入。
 *
 * 消费面：verify-load.mjs / verify-install.mjs（RPC 与文本助手）、verify-target.mjs
 * （assert/killTree——npmInstallToPrefix/runProcess 的两道防线同源）。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Windows process-tree kill (runbook §6.9: taskkill /PID /T /F). */
function killTree(pid) {
  if (!pid) return
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { /* best effort */ })
  } catch { /* best effort */ }
}

function tail(text, limit = 2500) {
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

/** Extract a balanced-brace JSON object starting at the first `{` after `marker`. */
function extractJsonAfter(text, marker, { missingMessage = 'not found' } = {}) {
  const at = text.indexOf(marker)
  assert(at >= 0, `marker ${JSON.stringify(marker)} ${missingMessage}`)
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

/**
 * POST one Connection unary RPC（client/rpc.ts 线格式）。
 * signalMs：fetch 上界毫秒（install 列传 RPC_TIMEOUT_MS——AbortSignal.timeout）；
 * 不传 = 无信号（load 列历史语义，登记保留）。
 */
async function rpcCall(origin, cookie, endpoint, args, { signalMs } = {}) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    ...(signalMs === undefined ? {} : { signal: AbortSignal.timeout(signalMs) }),
  })
  const text = await response.text()
  assert(response.status === 200, `POST /api/${endpoint} → HTTP ${response.status}: ${text}`)
  const envelope = JSON.parse(text)
  assert(envelope?.type === 'server-response', `unexpected envelope type: ${JSON.stringify(envelope)?.slice(0, 200)}`)
  assert(envelope.rpcId === rpcId, `rpcId mismatch: sent ${rpcId}, got ${envelope.rpcId}`)
  return envelope.result
}

/**
 * GET /?token=… → 303 + 浏览器 cookie（browser-auth.ts authorizeIndex）。
 * step：调用方行日志函数（'[verify]' / '[verify-install]'+journal 前缀注入）。
 */
async function tokenQueryCookie(origin, token, { step = () => {}, signalMs } = {}) {
  const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    ...(signalMs === undefined ? {} : { signal: AbortSignal.timeout(signalMs) }),
  })
  assert(response.status === 303, `index token exchange → HTTP ${response.status}（expected 303）`)
  const setCookie = response.headers.get('set-cookie')
  assert(typeof setCookie === 'string' && setCookie.length > 0, 'index token exchange returned no set-cookie')
  step('browser cookie acquired via /?token=')
  return setCookie.split(';', 1)[0]
}

/**
 * GET /connect?token=… → 302 + API 操作员 cookie（browser-auth.ts:308-351）。
 * step/signalMs 语义同 {@link tokenQueryCookie}。
 */
async function exchangeTokenForCookie(origin, token, { step = () => {}, signalMs } = {}) {
  const response = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    ...(signalMs === undefined ? {} : { signal: AbortSignal.timeout(signalMs) }),
  })
  assert(response.status === 302, `/connect token exchange → HTTP ${response.status}（expected 302）`)
  const setCookie = response.headers.get('set-cookie')
  assert(typeof setCookie === 'string' && setCookie.length > 0, '/connect returned no set-cookie')
  const pair = setCookie.split(';', 1)[0]
  step('API operator cookie acquired via /connect')
  return pair
}

export {
  assert,
  exchangeTokenForCookie,
  extractJsonAfter,
  killTree,
  rpcCall,
  tail,
  tokenQueryCookie,
}
