/**
 * dsh-gitkit-ui — 域错误码 → 文案/动作表（本模块 ask §④；spec §3.4）。
 *
 * **Record 穷尽约束**：`ERROR_MAP` 的键域 = `GitErrorCode`（host 包
 * `dsh-gitkit/errors`（types-only 导出，lib/error-codes.d.ts）里 declare module
 * 合并进 `RemoteErrorDetailsMap` 的 `git/*` 子集）——host 侧新增/删减域码时本文件
 * 编译期即报错，词典与映射不漏项。client 只 `import type`（编译期擦除，bundle 零
 * runtime 依赖 host 包——map §1.2 的 feature 插件值依赖红线）。
 *
 * 键 → 词典 `error.*` 键（spec §4：`error.<code 去 'git/' 前缀>`）；动作按 spec §3.4
 * 的清单：service-unavailable → retry；no-upstream → set-upstream；diverged →
 * fetch/pull；pull-diverged / auth-failed → 仅说明文案。gateway 保留码单列
 * （gateway/service-unavailable → retry；其余 gateway/* → 通用条目）；陌生 code
 * 由 lookup 返回 null，GitErrorNotice 回落透传 `error.message`（client 容忍陌生码，
 * map §2.4）。
 */

import type {} from 'dsh-gitkit/errors'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import type { GitLocaleKey } from './locales.js'
import { redact } from './m13/redact.js'

/** host 包声明过的域错误码（RemoteErrorDetailsMap 的 git/* 子集——穷尽约束的键域）。 */
export type GitCode = Extract<RemoteErrorCode, `git/${string}`>

/** GitErrorNotice 按码提供的动作（spec §3.4 动作清单）。 */
export type ErrorAction = 'retry' | 'set-upstream' | 'fetch' | 'pull'

/** 一个码的展示条目：词典键 + details→插值参数 + 动作。 */
export interface ErrorMapEntry {
  /** 词典键（`error.*` 组；GitLocaleKey 类型面校验键存在）。 */
  key: GitLocaleKey
  /** `details` → `t(key, params)` 的插值参数；缺省无参数。 */
  params?(details: unknown): Record<string, unknown>
  /** 按 spec §3.4 提供的动作按钮；缺省无动作。 */
  actions?: readonly ErrorAction[]
}

/** gateway 保留码（client 会遇到的三个：spec §1.0.1/§3.4）。 */
export type GatewayCode = 'gateway/service-unavailable' | 'gateway/cancelled' | 'gateway/input-invalid'

/** gateway 保留码条目（client 会遇到的三个：spec §1.0.1/§3.4）。 */
export const GATEWAY_MAP: Record<GatewayCode, ErrorMapEntry> = {
  'gateway/service-unavailable': { key: 'error.gateway-service-unavailable', actions: ['retry'] },
  'gateway/cancelled': { key: 'error.gateway', params: (details) => ({ code: codeOf(details) }) },
  'gateway/input-invalid': { key: 'error.gateway', params: (details) => ({ code: codeOf(details) }) },
}

/**
 * 域错误码全表（Record 穷尽 = GitCode；host 增删码即编译错）。
 * params 的 details 形状 = host RemoteErrorDetailsMap 各码的声明（编译期校验经
 * `satisfies`：本表与 GitCode 双向锁死）。
 */
export const ERROR_MAP: Record<GitCode, ErrorMapEntry> = {
  'git/no-repository': { key: 'error.no-repository' },
  'git/session-workspace-unresolved': { key: 'error.session-workspace-unresolved' },
  'git/identity-missing': {
    key: 'error.identity-missing',
    params: (details) => ({ missing: list((details as { missing?: unknown }).missing) }),
  },
  'git/nothing-staged': { key: 'error.nothing-staged' },
  'git/empty-message': { key: 'error.empty-message' },
  'git/no-upstream': {
    key: 'error.no-upstream',
    params: (details) => ({ branch: text((details as { branch?: unknown }).branch) }),
    actions: ['set-upstream'],
  },
  'git/no-remote': {
    key: 'error.no-remote',
    params: (details) => ({ remotes: list((details as { remotes?: unknown }).remotes) }),
  },
  'git/diverged': {
    key: 'error.diverged',
    params: (details) => ({
      ahead: num((details as { ahead?: unknown }).ahead),
      behind: num((details as { behind?: unknown }).behind),
    }),
    actions: ['fetch', 'pull'],
  },
  'git/push-rejected': { key: 'error.push-rejected' },
  'git/auth-failed': { key: 'error.auth-failed' },
  'git/pull-diverged': { key: 'error.pull-diverged' },
  'git/timeout': {
    key: 'error.timeout',
    params: (details) => ({ op: text((details as { op?: unknown }).op) }),
  },
  'git/git-error': {
    key: 'error.git-error',
    params: (details) => ({ op: text((details as { op?: unknown }).op) }),
  },
  'git/llm-route-unresolved': { key: 'error.llm-route-unresolved' },
  'git/llm-failed': {
    key: 'error.llm-failed',
    params: (details) => ({ reason: text((details as { reason?: unknown }).reason) }),
  },
  // host ⑤ mutations/commit 模块（2026-10-31）新增三码（workflow 任务口径）。
  'git/no-paths': { key: 'error.no-paths' },
  'git/bad-request': {
    key: 'error.bad-request',
    params: (details) => ({ reason: text((details as { reason?: unknown }).reason) }),
  },
  'git/hook-failed': { key: 'error.hook-failed' },
  // host M6 remote-ops 模块（2026-10-31）新增三码（workflow 任务口径）。
  'git/no-branch': { key: 'error.no-branch' },
  'git/dirty-worktree': {
    key: 'error.dirty-worktree',
    params: (details) => ({ branch: text((details as { branch?: unknown }).branch) }),
  },
  'git/choose-remote': {
    key: 'error.choose-remote',
    params: (details) => ({ remotes: list((details as { remotes?: unknown }).remotes) }),
  },
}

/** 查一个错误码的展示条目；陌生 code → null（透传 error.message 的回落路径）。 */
export function errorMapEntry(code: string): ErrorMapEntry | null {
  if (code.startsWith('git/')) {
    return (ERROR_MAP as Record<string, ErrorMapEntry>)[code] ?? null
  }
  return (GATEWAY_MAP as Record<string, ErrorMapEntry>)[code] ?? null
}

/** GitErrorNotice 的纯视图模型（组件只做 t/渲染；tests/error-map.spec 断言）。 */
export interface ErrorNoticeView {
  /** 主文案键；null = 陌生码（回落 message）。 */
  key: GitLocaleKey | null
  /** 主文案插值参数。 */
  params: Record<string, unknown>
  /** 陌生码的回落文案（redact 后的 error.message）。 */
  fallbackText: string | null
  /** 折叠区正文（details.stderr 优先，均过 redact）。 */
  detailsText: string
  /** 动作按钮。 */
  actions: readonly ErrorAction[]
}

/** 组装视图模型。`error.details` 为宿主过线的 details（形状按码；未知形状安全降级）。 */
export function errorNoticeView(error: { code: string; message: string; details?: unknown }): ErrorNoticeView {
  const entry = errorMapEntry(error.code)
  const details = error.details
  const stderr = (details as { stderr?: unknown } | null)?.stderr
  const detailsText = typeof stderr === 'string' && stderr.trim() !== ''
    ? redact(stderr)
    : redact(error.message)
  if (entry === null) {
    return { key: null, params: {}, fallbackText: redact(error.message), detailsText, actions: [] }
  }
  return {
    key: entry.key,
    // details 缺席/形状漂移 ⇒ 空对象（params 函数对字段缺失已安全降级）。
    params: entry.params?.(details ?? {}) ?? {},
    fallbackText: null,
    detailsText,
    actions: entry.actions ?? [],
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => text(item)).filter((item) => item !== '').join(', ') : ''
}

function codeOf(details: unknown): string {
  // gateway 错误的 details 可能携带字段码（gateway/input-invalid 的 field）——透传码本身即可。
  const field = (details as { field?: unknown } | null)?.field
  return typeof field === 'string' ? field : ''
}
