/**
 * M13 纯函数测试（本模块 ask §⑥）：redact 脱敏 + 冲突标记行分类器。
 * 纯函数纪律：无 IO、无全局态、同输入同输出。
 */

import { describe, expect, it } from 'vitest'
import { redact, redactTail } from '../src/client/m13/redact.ts'
// P3-2（v2 plan §10，批次四）：死代码 scanConflictLines 已删除——只保留行级分类器
// 的测试面；markConflictRows 走 classifyConflictLine（patch-hunks.ts:168）。
import { classifyConflictLine } from '../src/client/m13/conflict-markers.ts'

describe('redact — 显示面凭证脱敏', () => {
  it('URL userinfo 全遮（保留 scheme 与 host）', () => {
    expect(redact('clone from https://alice:ghp_secret@github.com/org/repo.git'))
      .toBe('clone from https://***:***@github.com/org/repo.git')
    expect(redact('ssh://user:pat@git.example.com/x')).toBe('ssh://***:***@git.example.com/x')
  })

  it('凭证形键值遮值留键', () => {
    expect(redact('remote: token= ghp_abc123 ok')).toBe('remote: token= *** ok')
    expect(redact('access_token=abc;expires=1')).toBe('access_token=***;expires=1')
    expect(redact('password: hunter2')).toBe('password: ***')
    expect(redact('api_key=sk-123')).toBe('api_key=***')
    expect(redact('Authorization: Bearer eyJhbGci')).toBe('Authorization: ***')
  })

  it('非凭证文本原样通过（幂等：已脱敏文本二次 redact 不变）', () => {
    const clean = 'fatal: pathspec "a b.ts" did not match any file(s) known to git'
    expect(redact(clean)).toBe(clean)
    const once = redact('token=*** fine')
    expect(redact(once)).toBe(once)
  })

  it('redactTail 保尾部并封顶（stderr 保留策略的显示面版）', () => {
    const long = `token=sekret ${'x'.repeat(5000)} TAIL-MARKER`
    const tail = redactTail(long, 100)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(101)
    expect(tail.endsWith('TAIL-MARKER')).toBe(true)
    expect(tail).not.toContain('sekret')
  })
})

describe('classifyConflictLine — 冲突标记行分类', () => {
  it('四类标记行', () => {
    expect(classifyConflictLine('<<<<<<< HEAD')).toBe('start')
    expect(classifyConflictLine('<<<<<<<')).toBe('start')
    expect(classifyConflictLine('||||||| merged common ancestors')).toBe('base')
    expect(classifyConflictLine('=======')).toBe('separator')
    expect(classifyConflictLine('>>>>>>> feature/x')).toBe('end')
  })

  it('分隔符恒为整行恰 7 等号（更长的等号串不是标记）', () => {
    expect(classifyConflictLine('======= ')).toBe('separator')
    expect(classifyConflictLine('========')).toBeNull()
    expect(classifyConflictLine('==============================')).toBeNull()
    expect(classifyConflictLine('======= label')).toBeNull()
  })

  it('非顶格/非标记行 → null', () => {
    expect(classifyConflictLine('  <<<<<<< HEAD')).toBeNull()
    expect(classifyConflictLine('<<<<<<<HEAD')).toBeNull()
    expect(classifyConflictLine('diff --git a/x b/x')).toBeNull()
    expect(classifyConflictLine('+++ b/x')).toBeNull()
    expect(classifyConflictLine('')).toBeNull()
  })
})

describe('P3-2 — 死代码删除（v2 plan §10）', () => {
  it('scanConflictLines / ConflictMarkedLine 已随批次四删除（classifyConflictLine 保留）', async () => {
    const module = await import('../src/client/m13/conflict-markers.ts')
    expect('scanConflictLines' in module).toBe(false)
    expect(typeof module.classifyConflictLine).toBe('function')
  })
})
