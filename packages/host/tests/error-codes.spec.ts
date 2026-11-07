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

  // M6 实测修订并入后的补测：以下形态在收敛前的弱版（大小写敏感、无 [remote
  // rejected]、无 network 簇）下全部漏分类落 undefined——样本取自 remote-ops.ts
  // M6 夹具与 sync.spec.ts 同源的真实世界 stderr。
  it('[remote rejected]（pre-receive 拒绝不含字面 [rejected]，弱版此前漏分类）→ push-rejected', () => {
    expect(classifyStderr(' ! [remote rejected] main -> main (pre-receive hook declined)')).toBe('push-rejected')
  })

  it('network 簇（curl 传输层措辞，弱版此前漏分类）→ network', () => {
    const samples = [
      "fatal: unable to access 'https://nonexistent.invalid/repo.git/': Could not resolve host: nonexistent.invalid",
      "fatal: unable to access 'http://127.0.0.1:9/repo.git/': Failed to connect to 127.0.0.1 port 9 after 2 ms: Couldn't connect to server",
      'fatal: unable to access ...: Connection timed out',
      'ssh: connect to host git.example.com port 22: Network is unreachable',
    ]
    for (const sample of samples) expect(classifyStderr(sample), sample).toBe('network')
  })

  it('簇正则 /i（弱版大小写敏感漏分类面）：大小写变体同样命中', () => {
    expect(classifyStderr('fatal: authentication failed for ...')).toBe('auth-failed')
    expect(classifyStderr("fatal: COULD NOT READ USERNAME for 'https://git.example.com'")).toBe('auth-failed')
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

  // gitRunError 随单一强版分类器同步变强的补测（弱版下两例均落默认失败消息）。
  it('[remote rejected] 经本分类器 → git-error「rejected by remote」（弱版落默认失败消息）', () => {
    const stderr = ' ! [remote rejected] main -> main (pre-receive hook declined)'
    const error = gitRunError('push', 1, stderr, false)
    expect(error.code).toBe('git/git-error')
    expect(error.message).toContain('rejected by remote')
    expect(error.details).toEqual({ op: 'push', exitCode: 1, stderr, truncated: false })
  })

  it('network stderr → git-error，message 带 (network) 注记（remote-ops fallback 同款口径）', () => {
    const stderr = "fatal: unable to access 'http://127.0.0.1:9/repo.git/': Failed to connect to 127.0.0.1 port 9"
    const error = gitRunError('push(set-upstream)', 128, stderr, false)
    expect(error.code).toBe('git/git-error')
    expect(error.message).toContain('(network)')
    expect(error.message).toContain('(exit 128)')
    expect(error.details).toEqual({ op: 'push(set-upstream)', exitCode: 128, stderr, truncated: false })
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
