/**
 * error-codes.ts 单元测试：域码工厂（RemoteError marker + details 形状）、
 * stderr 脱敏/分类（spec §1.0.5 分类规则）、logger 字段串。
 * 声明合并本身是编译期断言（RemoteErrorDetailsMap 的 git/* 键有类型即过 typecheck）。
 */

import { remoteErrorOf, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import {
  classifyStderr, gitError, gitRunError, logFailure, logRead, logWrite, sanitizeStderr, stderrForDebug,
} from '../src/error-codes.ts'

/** 收集 logger 调用的假面（按级别分桶）。 */
function fakeLogger(): {
  calls: { debug: string[]; info: string[]; warn: string[]; error: string[] }
  face: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void }
} {
  const calls = { debug: [], info: [], warn: [], error: [] } as {
    debug: string[]; info: string[]; warn: string[]; error: string[]
  }
  return {
    calls,
    face: {
      debug: (m) => { calls.debug.push(m) },
      info: (m) => { calls.info.push(m) },
      warn: (m) => { calls.warn.push(m) },
      error: (m) => { calls.error.push(m) },
    },
  }
}

describe('gitError（域码工厂）', () => {
  it('产出真 RemoteError：code/message/details/marker，且 remoteErrorOf 结构识别命中', () => {
    const error = gitError('git/no-repository', 'not a repository', { probed: 'D:/x' })
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.code).toBe('git/no-repository')
    expect(error.message).toBe('not a repository')
    expect(error.details).toEqual({ probed: 'D:/x' })
    expect(error.isDSHRemoteError).toBe(true)
    expect(remoteErrorOf(error)?.code).toBe('git/no-repository')
    // 普通 Error 不被结构识别
    expect(remoteErrorOf(new Error('plain'))).toBeUndefined()
  })
})

describe('sanitizeStderr（stderr 先脱敏再进 details/日志）', () => {
  it('URL userinfo 凭证打码', () => {
    const out = sanitizeStderr('fatal: unable to access https://user:ghp_secret123@github.com/x/y.git/')
    expect(out).toContain('https://***:***@github.com')
    expect(out).not.toContain('ghp_secret123')
  })

  it('token/password/api key 键值打码', () => {
    const out = sanitizeStderr('remote: token=abc123 password=hunter2 apiKey=key-42 authorization: Bearer eyJhbGc')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('key-42')
    expect(out).not.toContain('eyJhbGc')
    expect(out).toContain('token=***')
    expect(out).toContain('password=***')
  })

  it('普通 stderr 原样保留（诊断信息不受损）', () => {
    const line = 'error: pathspec \'main\' did not match any file(s) known to git'
    expect(sanitizeStderr(line)).toBe(line)
  })

  it('超出上限保尾部（16KiB 默认）', () => {
    const long = 'x'.repeat(20_000) + 'THE-TAIL'
    expect(sanitizeStderr(long).length).toBeLessThanOrEqual(16 * 1024)
    expect(sanitizeStderr(long)).toContain('THE-TAIL')
  })
})

describe('classifyStderr（spec §1.0.5 关键词分类）', () => {
  it('认证失败簇 → auth-failed', () => {
    expect(classifyStderr('fatal: Authentication failed for ...')).toBe('auth-failed')
    expect(classifyStderr('fatal: could not read Username for ...')).toBe('auth-failed')
    expect(classifyStderr('Permission denied (publickey).')).toBe('auth-failed')
  })

  it('远端拒绝簇 → push-rejected', () => {
    expect(classifyStderr(' ! [rejected]        main -> main (fetch first)')).toBe('push-rejected')
    expect(classifyStderr('hint: Updates were rejected because the tip...non-fast-forward')).toBe('push-rejected')
  })

  it('fast-forward 拒绝 → pull-diverged', () => {
    expect(classifyStderr('fatal: Not possible to fast-forward, aborting.')).toBe('pull-diverged')
  })

  it('其余 → undefined（调用方落 git/git-error）', () => {
    expect(classifyStderr('fatal: not a git repository')).toBeUndefined()
  })
})

describe('gitRunError（非零退出 → 域错误）', () => {
  it('认证 stderr → git/auth-failed，stderr 已脱敏', () => {
    const error = gitRunError('push', 128, 'fatal: Authentication failed for https://u:p@host/x', false)
    expect(error.code).toBe('git/auth-failed')
    expect((error.details as { stderr: string }).stderr).not.toContain(':p@')
  })

  it('普通失败 → git/git-error，携带 op/exitCode/stderr/truncated', () => {
    const error = gitRunError('identity', 128, 'fatal: not a git repository', true)
    expect(error.code).toBe('git/git-error')
    expect(error.details).toEqual({ op: 'identity', exitCode: 128, stderr: 'fatal: not a git repository', truncated: true })
  })
})

describe('logger 用法（§⑧-5 对齐树内：单条字符串消息 + key=value 字段）', () => {
  it('logRead → debug 级单条字符串', () => {
    const { calls, face } = fakeLogger()
    logRead(face, 'ping', { gitVersion: 'git version 2.55.0' })
    expect(calls.debug).toEqual(['git ping gitVersion=git version 2.55.0'])
    expect(calls.info).toEqual([])
  })

  it('logWrite → info 级，字段串接', () => {
    const { calls, face } = fakeLogger()
    logWrite(face, 'commit', { durationMs: 120, amend: false })
    expect(calls.info).toEqual(['git commit durationMs=120 amend=false'])
  })

  it('logFailure → warn 级附 code', () => {
    const { calls, face } = fakeLogger()
    logFailure(face, 'identity', 'git/git-error', { key: 'user.name' })
    expect(calls.warn).toEqual(['git identity failed code=git/git-error key=user.name'])
  })

  it('stderrForDebug：debug 专用尾部且截 500（spec §1.0.6）', () => {
    const long = `${'y'.repeat(600)}TAIL-500`
    const out = stderrForDebug(long)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out).toContain('TAIL-500')
  })
})
