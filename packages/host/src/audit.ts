/**
 * dsh-gitkit — 写操作审计引擎（v2 批次四：[清单 66] 环缓冲 + auditLog 查询面；
 * docs/v2-implementation-plan.md §6.3/§6.5）。
 *
 * 无事件通道（§0.4-1：dsh 事件转发 allowlist 无 git/*）→ 审计 = host 环缓冲 +
 * RPC 查询两路（logger + auditLog；无推送面）。**双出口挂钩**（§6.5）：v1 写方法
 * 的 afterWrite() 只在 try 成功分支——只挂 afterWrite 会漏全部失败审计，与
 * AuditEntry.ok/code 字段语义矛盾；故服务面在**成功出口**（logWrite 处）入环
 * ok:true、在**catch 出口**（logFailure 处）同步入环 ok:false + 域错误码。
 * 只读方法不入环（服务面只对写方法调 record）。
 *
 * summary 纪律（§6.2/§6.10）：只含 op 参数摘要——**白名单字段组装**（调用点逐 op
 * 传固定标量字段，非自由拼接），不落 commit message 正文 / 文件内容 / 密钥；
 * audit.spec 负断言兜底。失败出口的 summary 为空串（意外内容零落环）。
 *
 * 环缓冲：定长（auditMaxEntries Config 默认 500，超限从头逐出）；内存占用有界；
 * 单线程 node 无锁面。查询序 = newest-first（最近一条在前）。
 */

import { gitError } from './error-codes.ts'
import type { AuditEntry, AuditLogResult, AuditLogOptions } from './types.ts'

/** 环缓冲默认上限（Config auditMaxEntries 缺省——方案 §6.3 auditLog 行）。 */
export const DEFAULT_AUDIT_MAX_ENTRIES = 500

/** 环缓冲构造上限钳制（防单实例失控内存；Config schema 另有 min/max 双保险）。 */
export const AUDIT_MAX_ENTRIES_CEILING = 10_000

/** auditLog 缺省 limit（wire 缺省 = 最近 100 条）。 */
export const DEFAULT_AUDIT_LOG_LIMIT = 100

/** 审计引擎构造项。 */
export interface AuditEngineOptions {
  /** 环缓冲上限条数（Config auditMaxEntries；缺省 500，钳 [1, AUDIT_MAX_ENTRIES_CEILING]）。 */
  maxEntries?: number
}

/** `key=value` 摘要串（白名单标量字段；undefined 剔除——logWrite fields() 同形）。 */
export function summarizeAuditFields(pairs: Readonly<Record<string, unknown>>): string {
  return Object.entries(pairs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : String(value)}`)
    .join(' ')
}

export class AuditEngine {
  private readonly buffer: AuditEntry[] = []
  private readonly maxEntries: number

  constructor(options: AuditEngineOptions = {}) {
    const requested = options.maxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES
    this.maxEntries = Math.min(Math.max(Math.trunc(requested), 1), AUDIT_MAX_ENTRIES_CEILING)
  }

  /** 构造生效的环缓冲上限（诊断/测试视图）。 */
  get capacity(): number {
    return this.maxEntries
  }

  /**
   * 双出口挂钩的单一入口：服务面成功出口传 ok=true + code=null + 参数摘要白名单
   * 字段；catch 出口传 ok=false + 域错误码 + 空摘要。零抛错（审计不得反噬业务路径
   * ——内部异常面收敛为吞没，ring 崩溃不应让写操作失败）。
   */
  record(
    op: string,
    ok: boolean,
    code: string | null,
    durationMs: number,
    summary: Readonly<Record<string, unknown>>,
  ): void {
    try {
      const entry: AuditEntry = {
        at: new Date().toISOString(),
        op,
        ok,
        code,
        durationMs,
        summary: ok ? summarizeAuditFields(summary) : '',
      }
      this.buffer.push(entry)
      if (this.buffer.length > this.maxEntries) {
        this.buffer.splice(0, this.buffer.length - this.maxEntries)
      }
    } catch {
      // 审计记录失败不反噬写操作（零抛错纪律）。
    }
  }

  /**
   * 环缓冲查询（[清单 66] auditLog 数据面）：newest-first；limit 钳
   * [1, maxEntries]（缺省 100）；since ISO 下界（不可解析 ⇒ git/bad-request
   * 'invalid-options'，零状态变更）。
   * @throws git/bad-request 'invalid-options'（since 非 ISO）。
   */
  query(options: AuditLogOptions): AuditLogResult {
    const sinceRaw = options.since ?? null
    let sinceMs: number | null = null
    if (sinceRaw !== null && sinceRaw !== '') {
      sinceMs = Date.parse(sinceRaw)
      if (Number.isNaN(sinceMs)) {
        throw gitError('git/bad-request', `git auditLog: since is not a parseable timestamp: ${JSON.stringify(sinceRaw)}`, {
          reason: 'invalid-options', paths: [], expected: null, actual: null,
        })
      }
    }
    const requestedLimit = options.limit ?? DEFAULT_AUDIT_LOG_LIMIT
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), this.maxEntries)
    const picked: AuditEntry[] = []
    // newest-first：从环尾向环头扫，since 命中即收、越过下界即止（时间单调不严格，
    // 不做提前止——逐条过滤保证正确性）。
    for (let index = this.buffer.length - 1; index >= 0 && picked.length < limit; index--) {
      const entry = this.buffer[index] as AuditEntry
      if (sinceMs !== null && Date.parse(entry.at) < sinceMs) continue
      picked.push(entry)
    }
    return { entries: picked }
  }
}
