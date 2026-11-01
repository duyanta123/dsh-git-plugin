/**
 * M13 纯函数测试（本模块 ask §⑥）：redact 脱敏 + 冲突标记行分类器。
 * 纯函数纪律：无 IO、无全局态、同输入同输出。
 */

import { describe, expect, it } from 'vitest'
import { redact, redactTail } from '../src/client/m13/redact.ts'
import { classifyConflictLine, scanConflictLines } from '../src/client/m13/conflict-markers.ts'

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

describe('scanConflictLines — 文本扫描', () => {
  it('按行号产出标记行清单（含 \r\n 容忍）', () => {
    const text = [
      'line 0',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> feature',
      'line 6',
    ].join('\n')
    expect(scanConflictLines(text)).toEqual([
      { index: 1, kind: 'start', line: '<<<<<<< HEAD' },
      { index: 3, kind: 'separator', line: '=======' },
      { index: 5, kind: 'end', line: '>>>>>>> feature' },
    ])
  })

  it('无标记文本 → 空清单；CRLF 行尾不破坏分类', () => {
    expect(scanConflictLines('a\nb\nc')).toEqual([])
    const crlf = '<<<<<<< HEAD\r\nours\r\n=======\r\n'
    expect(scanConflictLines(crlf).map((row) => row.kind)).toEqual(['start', 'separator'])
  })
})
