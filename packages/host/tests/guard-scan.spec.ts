/**
 * v2 批次三 — 提交护栏扫描与仓库诊断测试（[清单 21/22/56]；docs/v2-implementation-plan.md
 * §5.7 host 真仓库范式行；D5=A 拍板的豁免语义钉住）。
 *
 * 覆盖：密钥样例（AWS/GitHub/PEM/.env 键值/用户叠加固定串）+ violations 形状 +
 * **redactedMatch 无明文断言**（掩码规则）；.env / .env.example 路径分类；大文件阈值
 * （Config.guardLargeFileBytes）+ 构建产物目录（默认表 + Config 叠加）；eol-mixed 行号；
 * **干净仓库零误报基线**；**commit 的 secret 硬阻断（D5=A）**：commit-blocked
 * overridable:false 零命令 + 非 secret 违规不拦 commit（豁免语义 = client danger 闸）；
 * 纯函数夹具（redactMatch/isEnvFilePath/isBuildArtifactPath/countEol/scanTextForSecret/
 * parseStagedRaw）；diagnostics（autocrlf 三态 / 空配置 / CRLF 抽样 / 中文路径夹具）。
 *
 * 断言纪律：验证世界而非自述；密钥样例全部为公开测试用假值（AWS 文档示例值等）。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { GitService } from '../src/index.ts'
import {
  countEol, isBuildArtifactPath, isEnvFilePath, redactMatch, scanTextForSecret, parseStagedRaw,
  SECRET_PATTERNS, DEFAULT_BUILD_PATTERNS,
} from '../src/guard-scan.ts'
import { git, localSubprocess, scratchRepo } from './support.ts'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const cleanups: Array<() => Promise<unknown>> = []
let realGlobalConfig: string | undefined
let realNosystem: string | undefined

beforeAll(async () => {
  // 身份/配置隔离（commit.spec 同款）：GIT_CONFIG_GLOBAL 指向不存在文件 + 
  // GIT_CONFIG_NOSYSTEM=1（git-for-windows 的系统级 gitconfig 默认 core.autocrlf=true，
  // 不隔离会污染 diagnostics 的「空配置」态）——diagnostics 的 autocrlf/core.eol 三态
  // 断言不受本机全局/系统配置漂移影响；commit 的身份走仓库 local（scratchRepo identity
  // 或 git 助手的 -c 旗标）。隔离目录注册进 cleanups 统一清理。
  const isolationDir = await mkdtemp(join(tmpdir(), 'dshgit-guard-iso-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(isolationDir, { recursive: true, force: true })
  })
  realGlobalConfig = process.env.GIT_CONFIG_GLOBAL
  realNosystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = join(isolationDir, 'does-not-exist')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(async () => {
  if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig
  if (realNosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = realNosystem
  while (cleanups.length > 0) await cleanups.pop()!()
})

afterEach(async () => {
  // 每用例夹具统一走 cleanups（afterAll 逆序清理）；此处仅为接口对齐 commit.spec。
})

function makeService(
  workspaceOverride: string,
  overrides: { guardLargeFileBytes?: number; guardBuildPatterns?: string[]; guardSecretPatterns?: string[] } = {},
): InstanceType<typeof GitService> {
  const ctx = new Context() as never
  const face = ctx as { provide(name: string, value: unknown): void }
  face.provide('subprocess', localSubprocess())
  // 护栏三键按 overrides 有值才进 Config（exactOptionalPropertyTypes：可选键不给显式
  // undefined——缺键时服务面走 schemastery 默认/index.ts 兜底归一）。
  const config: Record<string, unknown> = {
    gitCommand: 'git', fastTimeoutMs: 15_000, commitTimeoutMs: 15_000,
    workspaceOverride, autoFetchIntervalMs: 0,
  }
  if (overrides.guardLargeFileBytes !== undefined) config.guardLargeFileBytes = overrides.guardLargeFileBytes
  if (overrides.guardBuildPatterns !== undefined) config.guardBuildPatterns = overrides.guardBuildPatterns
  if (overrides.guardSecretPatterns !== undefined) config.guardSecretPatterns = overrides.guardSecretPatterns
  return new GitService(ctx, config as never)
}

async function makeWorld(name: string): Promise<{ repo: string; service: InstanceType<typeof GitService> }> {
  const repo = await scratchRepo(`dshgit-guard-${name}-`, cleanups, { name: 't', email: 't@example.com' })
  git(repo, 'config', 'core.autocrlf', 'false')
  return { repo, service: makeService(repo) }
}

async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, rel), content, 'utf8')
  git(repo, 'add', '--', rel)
  git(repo, 'commit', '-qm', message)
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitCount(repo: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', '--all'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const cause = await run().then(
    (value) => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`) },
    (cause: unknown) => cause,
  )
  const remote = remoteErrorOf(cause)
  expect(remote, `expected RemoteError, got ${String(cause)}`).not.toBeNull()
  return { code: remote!.code, message: remote!.message, details: remote!.details as Record<string, unknown> }
}

describe('scanStaged — 密钥模式命中（[清单 22]）', () => {
  it('AWS key 样例（文档公开假值）：secret 命中 + redactedMatch 无明文 + 行号', async () => {
    const { repo, service } = await makeWorld('secret-aws')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    // AWS 官方文档的示例 key（假值）。
    await writeFile(join(repo, 'config.txt'), 'line1\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\nline3\n', 'utf8')
    await service.stage(['config.txt'])
    const scan = await service.scanStaged()
    expect(scan.blocked).toBe(true)
    const secret = scan.violations.find((violation) => violation.kind === 'secret')
    expect(secret).toBeDefined()
    expect(secret?.path).toBe('config.txt')
    expect(secret?.line).toBe(2)
    expect(secret?.detail).toContain('AWS access key id')
    // 脱敏断言：掩码形（AKIA + 16 星），绝不落明文。
    expect(secret?.redactedMatch).toBe('AKIA****************')
    expect(secret?.redactedMatch).not.toContain('IOSFODNN7EXAMPLE')
  })

  it('GitHub token / PEM 头各命中（redactedMatch 形态按模式规则）', async () => {
    const { repo, service } = await makeWorld('secret-gh-pem')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, 'token.txt'), 'ghp_Wq2x9KvZ7Yb3mN4pQr5sT6uV8wX0yZa1B2c3D4e\n', 'utf8')
    await service.stage(['token.txt'])
    const scan = await service.scanStaged()
    const gh = scan.violations.find((violation) => violation.kind === 'secret')
    expect(gh?.detail).toContain('GitHub token')
    expect(gh?.redactedMatch).toBe('ghp_' + '*'.repeat(39))
    expect(gh?.redactedMatch).not.toContain('Wq2x9KvZ7')
    // PEM 头（marker 原样展示——头部文本非密钥本体）。
    await writeFile(join(repo, 'key.pem'), '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n', 'utf8')
    await service.stage(['key.pem'])
    const scan2 = await service.scanStaged()
    const pem = scan2.violations.find((violation) => violation.kind === 'secret' && violation.path === 'key.pem')
    expect(pem?.detail).toContain('PEM private key header')
    expect(pem?.redactedMatch).toBe('-----BEGIN OPENSSH PRIVATE KEY-----')
    // 私钥体（base64 行）不进 redactedMatch。
    expect(pem?.redactedMatch).not.toContain('b3BlbnNzaC1rZXk')
  })

  it('.env 键值：凭据形赋值命中 secret（redactedMatch 掩值留键）；.env.example 不误伤', async () => {
    const { repo, service } = await makeWorld('secret-env')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, '.env'), 'DATABASE_URL=postgres://x\nAPI_KEY=abcd1234efgh\nDEBUG=1\n', 'utf8')
    await service.stage(['.env'])
    const scan = await service.scanStaged()
    // .env 本身也触发 env-file 路径违规（两类并存）。
    expect(scan.violations.some((violation) => violation.kind === 'env-file' && violation.path === '.env')).toBe(true)
    const secret = scan.violations.find((violation) => violation.kind === 'secret' && violation.path === '.env')
    expect(secret).toBeDefined()
    expect(secret?.line).toBe(2)
    expect(secret?.redactedMatch).toBe('API_KEY=***')
    expect(secret?.redactedMatch).not.toContain('abcd1234efgh')
    // .env.example（占位值形态）不算 env 文件也不做键值 secret 扫描——零误伤。
    await writeFile(join(repo, '.env.example'), 'PASSWORD=your-password-here\n', 'utf8')
    await service.stage(['.env.example'])
    const scan2 = await service.scanStaged()
    expect(scan2.violations.filter((violation) => violation.path === '.env.example')).toEqual([])
  })

  it('Config.guardSecretPatterns 用户叠加固定串：命中且全掩码（非正则语义）', async () => {
    const repo = await scratchRepo('dshgit-guard-userneedle-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    const service = makeService(repo, { guardSecretPatterns: ['corp-internal-token-v1'] })
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, 'a.txt'), 'license = corp-internal-token-v1\n', 'utf8')
    await service.stage(['a.txt'])
    const scan = await service.scanStaged()
    const secret = scan.violations.find((violation) => violation.kind === 'secret')
    expect(secret?.detail).toContain('guardSecretPatterns')
    expect(secret?.redactedMatch).toBe('co' + '*'.repeat(20))
    // 正则元字符按字面处理（非正则语义）——'(weird)*needle' 这类串按字面命中，不抛错。
    const service2 = makeService(repo, { guardSecretPatterns: ['(weird)*needle'] })
    await writeFile(join(repo, 'b.txt'), 'plain (weird)*needle here\n', 'utf8')
    await service2.stage(['b.txt'])
    const scan2 = await service2.scanStaged()
    expect(scan2.blocked).toBe(true)
    expect(scan2.violations[0]?.redactedMatch).not.toContain('weird')
  })

  it('干净仓库零误报基线：普通文本/代码 staged ⇒ blocked=false 且 violations 空', async () => {
    const { repo, service } = await makeWorld('clean-baseline')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, 'app.ts'), 'const greeting = "hello world"\nexport default greeting\n', 'utf8')
    await writeFile(join(repo, 'notes.md'), '# 笔记\n今天写了登录页。\n', 'utf8')
    await service.stage(['app.ts', 'notes.md'])
    const scan = await service.scanStaged()
    expect(scan.blocked).toBe(false)
    expect(scan.violations).toEqual([])
  })
})

describe('scanStaged — 路径/体量/行尾类（[清单 21]）', () => {
  it('大文件阈值（Config.guardLargeFileBytes）：超限 ⇒ large-file 带 sizeBytes', async () => {
    const repo = await scratchRepo('dshgit-guard-large-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    const service = makeService(repo, { guardLargeFileBytes: 64 })
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, 'blob.bin'), 'x'.repeat(200) + '\n', 'utf8')
    await service.stage(['blob.bin'])
    const scan = await service.scanStaged()
    const large = scan.violations.find((violation) => violation.kind === 'large-file')
    expect(large?.path).toBe('blob.bin')
    expect(large?.sizeBytes).toBe(201)
    expect(large?.detail).toContain('201')
  })

  it('构建产物目录：默认表命中（dist/）+ Config.guardBuildPatterns 叠加命中', async () => {
    const repo = await scratchRepo('dshgit-guard-build-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    const service = makeService(repo, { guardBuildPatterns: ['artifacts/'] })
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await mkdir(join(repo, 'dist'), { recursive: true })
    await mkdir(join(repo, 'artifacts'), { recursive: true })
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(join(repo, 'dist', 'out.js'), 'bundle\n', 'utf8')
    await writeFile(join(repo, 'artifacts', 'x.bin'), 'bin\n', 'utf8')
    await writeFile(join(repo, 'src', 'app.ts'), 'code\n', 'utf8')
    await service.stage(['dist/out.js', 'artifacts/x.bin', 'src/app.ts'])
    const scan = await service.scanStaged()
    const dist = scan.violations.find((violation) => violation.kind === 'build-artifact' && violation.path === 'dist/out.js')
    const artifacts = scan.violations.find((violation) => violation.kind === 'build-artifact' && violation.path === 'artifacts/x.bin')
    expect(dist).toBeDefined()
    expect(artifacts).toBeDefined()
    // src/app.ts 不在任何产物目录——零误报。
    expect(scan.violations.some((violation) => violation.path === 'src/app.ts')).toBe(false)
  })

  it('eol-mixed：CRLF 与 LF 混用 ⇒ 违规带首个混用行号', async () => {
    const { repo, service } = await makeWorld('eol-mixed')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, 'mixed.txt'), 'a\r\nb\nc\r\n', 'utf8')
    await service.stage(['mixed.txt'])
    const scan = await service.scanStaged()
    const mixed = scan.violations.find((violation) => violation.kind === 'eol-mixed')
    expect(mixed?.path).toBe('mixed.txt')
    expect(mixed?.line).toBe(2) // 首个 LF-only 行（两种行尾齐备的首行）
    expect(mixed?.sizeBytes).toBe(8)
  })
})

describe('commit 的 secret 硬阻断（D5=A，[清单 22]）', () => {
  it('staged secret ⇒ git/commit-blocked（overridable:false，零命令）', async () => {
    const { repo, service } = await makeWorld('commit-blocked')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    const before = commitCount(repo)
    await writeFile(join(repo, 'config.txt'), 'aws = AKIAIOSFODNN7EXAMPLE\n', 'utf8')
    await service.stage(['config.txt'])
    const rejection = await rejectionOf(() => service.commit({ message: 'feat: sneak the key\n', amend: false, skipHooks: false }))
    expect(rejection.code).toBe('git/commit-blocked')
    expect(rejection.details.overridable).toBe(false)
    const violations = rejection.details.violations as Array<{ kind: string; path: string; redactedMatch: string | null }>
    expect(violations.some((violation) => violation.kind === 'secret' && violation.path === 'config.txt')).toBe(true)
    // violations 里的 redactedMatch 仍不落明文。
    expect(violations.some((violation) => (violation.redactedMatch ?? '').includes('IOSFODNN7EXAMPLE'))).toBe(false)
    // world：零命令——提交未发生。
    expect(commitCount(repo)).toBe(before)
    // 清除后同消息提交成功。
    await service.unstage(['config.txt'])
    await writeFile(join(repo, 'config.txt'), 'aws = safe\n', 'utf8')
    await service.stage(['config.txt'])
    const committed = await service.commit({ message: 'feat: safe change\n', amend: false, skipHooks: false })
    expect(committed.oid).not.toBe('')
    expect(commitCount(repo)).toBe(before + 1)
  })

  it('非 secret 违规（large-file）不拦 host commit（D5=A 豁免语义 = client danger 闸）', async () => {
    const repo = await scratchRepo('dshgit-guard-overridable-', cleanups, { name: 't', email: 't@example.com' })
    git(repo, 'config', 'core.autocrlf', 'false')
    const service = makeService(repo, { guardLargeFileBytes: 16 })
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    await writeFile(join(repo, 'big.bin'), 'y'.repeat(200) + '\n', 'utf8')
    await service.stage(['big.bin'])
    // scanStaged 报 large-file（预检面给 client 禁用按钮 + danger 豁免入口）……
    const scan = await service.scanStaged()
    expect(scan.violations.some((violation) => violation.kind === 'large-file')).toBe(true)
    // ……但 commit 本身不被 host 拦（豁免后可提交——无 bypass wire 字段的施工解释）。
    const committed = await service.commit({ message: 'feat: exempted large file\n', amend: false, skipHooks: false })
    expect(committed.oid).not.toBe('')
  })
})

describe('scanStaged/commit — 暂存重命名记录（评审 high 项修复回归）', () => {
  /** world 重读 staged raw（-z --no-abbrev 同引擎命令形——夹具必须真实落在 R 记录上）。 */
  function worldStagedRaw(repo: string): string {
    return execFileSync('git', ['diff', '--cached', '--raw', '-z', '--no-abbrev'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  it('staged rename + staged secret：rename 条目不错位、secret 命中（旧 i+=2 会把 secret 条目整体丢弃）', async () => {
    const { repo, service } = await makeWorld('rename-secret')
    await commitFile(repo, 'a.txt', 'safe\n', 'seed a')
    git(repo, 'mv', 'a.txt', 'b.txt') // staged rename（R100）
    await mkdir(join(repo, 'dist'), { recursive: true })
    await writeFile(join(repo, 'dist', 'secret.txt'), 'aws = AKIAIOSFODNN7EXAMPLE\n', 'utf8')
    await service.stage(['dist/secret.txt'])
    // 夹具自证：staged 集确实是「R 记录 + 紧随 A 记录」的错位触发形态。
    const worldRaw = worldStagedRaw(repo)
    expect(worldRaw).toMatch(/R\d+\0a\.txt\0b\.txt\0/)
    expect(worldRaw).toContain('dist/secret.txt')
    // 修复前：parseStagedRaw 产出 [{path:'a.txt'}]——secret 文件被错位丢弃，blocked=false。
    const scan = await service.scanStaged()
    expect(scan.blocked).toBe(true)
    const secret = scan.violations.find((violation) => violation.kind === 'secret')
    expect(secret?.path).toBe('dist/secret.txt')
    expect(secret?.redactedMatch).toBe('AKIA****************')
    // 重命名条目（旧路径）不产生幻影违规——R100 的新 blob 内容是已提交的 'safe\n'。
    expect(scan.violations.some((violation) => violation.path === 'a.txt')).toBe(false)
  })

  it('重命名并改写携带密钥（R0xx）：violation 报告在**新路径**（旧代码记在旧路径）', async () => {
    const { repo, service } = await makeWorld('rename-modify-secret')
    // 15/16 行保留（字节相似度 ≈65% > 50% 阈值，本机实测 R065）保证 git 判定为 rename 而非 D+A。
    const kept = Array.from({ length: 15 }, (_, i) => `l${String(i + 1)}`).join('\n') + '\n'
    await commitFile(repo, 'orig.txt', kept, 'seed orig')
    git(repo, 'mv', 'orig.txt', 'renamed.txt')
    await writeFile(join(repo, 'renamed.txt'), `${kept}aws = AKIAIOSFODNN7EXAMPLE\n`, 'utf8')
    await service.stage(['renamed.txt'])
    // 夹具自证：staged 记录是带改写的 R（非 D+A）。
    expect(worldStagedRaw(repo)).toMatch(/R\d+\0orig\.txt\0renamed\.txt\0/)
    const scan = await service.scanStaged()
    const secret = scan.violations.find((violation) => violation.kind === 'secret')
    expect(secret?.path).toBe('renamed.txt')
    expect(secret?.line).toBe(16)
    expect(scan.violations.some((violation) => violation.path === 'orig.txt')).toBe(false)
  })

  it('D5 硬阻断不因重命名被绕过：commit ⇒ git/commit-blocked overridable:false（零命令）', async () => {
    const { repo, service } = await makeWorld('rename-bypass')
    await commitFile(repo, 'a.txt', 'safe\n', 'seed a')
    const before = commitCount(repo)
    git(repo, 'mv', 'a.txt', 'b.txt')
    await mkdir(join(repo, 'dist'), { recursive: true })
    await writeFile(join(repo, 'dist', 'secret.txt'), 'aws = AKIAIOSFODNN7EXAMPLE\n', 'utf8')
    await service.stage(['dist/secret.txt'])
    const rejection = await rejectionOf(() => service.commit({ message: 'feat: sneak past rename\n', amend: false, skipHooks: false }))
    expect(rejection.code).toBe('git/commit-blocked')
    expect(rejection.details.overridable).toBe(false)
    const violations = rejection.details.violations as Array<{ kind: string; path: string }>
    expect(violations.some((violation) => violation.kind === 'secret' && violation.path === 'dist/secret.txt')).toBe(true)
    // world：零命令——密钥未随重命名越过硬阻断落进历史。
    expect(commitCount(repo)).toBe(before)
  })
})

describe('纯函数夹具（guard-scan.ts 导出面）', () => {
  it('redactMatch：marker 原样 / prefix 保留固定前缀掩码本体', () => {
    const pem = SECRET_PATTERNS.find((pattern) => pattern.label.includes('PEM'))!
    expect(redactMatch(pem, '-----BEGIN RSA PRIVATE KEY-----')).toBe('-----BEGIN RSA PRIVATE KEY-----')
    const aws = SECRET_PATTERNS.find((pattern) => pattern.label.includes('AWS'))!
    expect(redactMatch(aws, 'AKIAIOSFODNN7EXAMPLE')).toBe('AKIA****************')
    const auth = SECRET_PATTERNS.find((pattern) => pattern.label.includes('authorization'))!
    const full = 'authorization: Bearer abcdefghijklmnopqrstuvwxyz'
    expect(redactMatch(auth, full)).toBe('authorization' + '*'.repeat(full.length - 13))
  })

  it('isEnvFilePath / isBuildArtifactPath：分类边界', () => {
    expect(isEnvFilePath('.env')).toBe(true)
    expect(isEnvFilePath('.env.production')).toBe(true)
    expect(isEnvFilePath('config.env')).toBe(true)
    expect(isEnvFilePath('.env.example')).toBe(false)
    expect(isEnvFilePath('src/app.ts')).toBe(false)
    for (const pattern of DEFAULT_BUILD_PATTERNS) {
      expect(isBuildArtifactPath(pattern.replace(/\/$/, '') + '/out.js', [])).toBe(true)
    }
    expect(isBuildArtifactPath('src/app.ts', [])).toBe(false)
    expect(isBuildArtifactPath('artifacts/x.bin', ['artifacts/'])).toBe(true)
  })

  it('countEol：CRLF/LF-only/混用行号', () => {
    expect(countEol('a\r\nb\r\n')).toEqual({ crlf: 2, lfOnly: 0, firstMixedLine: null })
    expect(countEol('a\nb\n')).toEqual({ crlf: 0, lfOnly: 2, firstMixedLine: null })
    expect(countEol('a\r\nb\nc\r\n').firstMixedLine).toBe(2)
    expect(countEol('')).toEqual({ crlf: 0, lfOnly: 0, firstMixedLine: null })
  })

  it('scanTextForSecret：无命中返回 null；用户固定串大小写不敏感', () => {
    expect(scanTextForSecret('a.txt', 'plain text with no secrets\n', [])).toBeNull()
    const needle = scanTextForSecret('a.txt', 'TOKEN=corp-internal-token-v1\n', ['CORP-INTERNAL-TOKEN-V1'])
    expect(needle?.kind).toBe('secret')
    expect(needle?.redactedMatch).toBe('CO' + '*'.repeat(20))
  })

  it('parseStagedRaw：raw -z 记录解析（A/M 带 oid、D 归 null、全零 oid 归 null）', () => {
    const stdout = ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A\0added.txt\0'
      + ':100644 100644 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 M\0changed.txt\0'
      + ':100644 000000 4444444444444444444444444444444444444444 0000000000000000000000000000000000000000 D\0deleted.txt\0'
    const entries = parseStagedRaw(stdout)
    expect(entries).toEqual([
      { path: 'added.txt', oid: '1111111111111111111111111111111111111111' },
      { path: 'changed.txt', oid: '3333333333333333333333333333333333333333' },
      { path: 'deleted.txt', oid: null },
    ])
  })

  it('parseStagedRaw：R/C 双路径记录取**新路径**，且紧随其后的条目不被丢弃（评审 high 项回归）', () => {
    // 本机 git 2.55.0.windows.2 实测形：`…R100\0a.txt\0b.txt\0` + 紧随的 A 记录——
    // 旧 i+=2 固定配对把它解析成 [{path:'a.txt'}]，dist/secret.txt 被整体丢弃。
    const withRename = ':100644 100644 5555555555555555555555555555555555555555 6666666666666666666666666666666666666666 R100\0a.txt\0b.txt\0'
      + ':000000 100644 0000000000000000000000000000000000000000 7777777777777777777777777777777777777777 A\0dist/secret.txt\0'
    expect(parseStagedRaw(withRename)).toEqual([
      { path: 'b.txt', oid: '6666666666666666666666666666666666666666' },
      { path: 'dist/secret.txt', oid: '7777777777777777777777777777777777777777' },
    ])
    // C（复制）同双路径形态（-C 检出；相似度评分取前导字母）。
    const copyOnly = ':100644 100644 8888888888888888888888888888888888888888 9999999999999999999999999999999999999999 C75\0src/x.ts\0dst/x.ts\0'
    expect(parseStagedRaw(copyOnly)).toEqual([{ path: 'dst/x.ts', oid: '9999999999999999999999999999999999999999' }])
    // R 作为末条记录（无紧随条目）——旧代码同样错位（产出旧路径），新代码取新路径。
    const renameLast = ':100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R50\0old.txt\0new.txt\0'
    expect(parseStagedRaw(renameLast)).toEqual([{ path: 'new.txt', oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }])
    // U（未合并）实测 `:100644 000000 <oid> 0000000 U\0path\0`——全零 newOid 归 null（无 blob 可扫）。
    const unmerged = ':100644 000000 1234567890abcdef1234567890abcdef12345678 0000000000000000000000000000000000000000 U\0b.txt\0'
    expect(parseStagedRaw(unmerged)).toEqual([{ path: 'b.txt', oid: null }])
  })

  it('parseStagedRaw：契约破坏要响（非 \\0 终止 / 记录中途非 meta 槽 / R 缺路径槽）', () => {
    const okRecord = ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A\0added.txt\0'
    // 非 \0 终止（截断）。
    expect(() => parseStagedRaw(okRecord.slice(0, -1))).toThrow(/NUL-terminated/)
    // 记录中途出现非 meta 槽（错位形态——旧代码静默 continue，正是丢条目的根因）。
    expect(() => parseStagedRaw(`${okRecord}b.txt\0`)).toThrow(/expected ':<meta>'/)
    // R 记录缺第二个路径槽。
    expect(() => parseStagedRaw(':100644 100644 5555555555555555555555555555555555555555 6666666666666666666666666666666666666666 R100\0a.txt\0')).toThrow(/2 path field/)
    // meta 字段不足。
    expect(() => parseStagedRaw(':100644 100644 A\0x.txt\0')).toThrow(/meta/)
  })
})

describe('repoDiagnostics — 行尾/编码诊断（[清单 56]）', () => {
  // diag 夹具不用 makeWorld 的 autocrlf 钉死（那会写 local config，污染「空配置」态）。
  async function makeDiagWorld(name: string) {
    const repo = await scratchRepo(`dshgit-guard-diag-${name}-`, cleanups, { name: 't', email: 't@example.com' })
    return { repo, service: makeService(repo) }
  }

  it('autocrlf 显式值回读；core.eol 未设置 ⇒ null；CRLF 抽样计数与混用清单（含中文路径夹具）', async () => {
    const { repo, service } = await makeDiagWorld('ok')
    git(repo, 'config', 'core.autocrlf', 'true')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    // 顶层抽样面：CRLF 文件、混用文件、纯 LF 文件、中文路径 CRLF 文件、非文本后缀（忽略）。
    await writeFile(join(repo, 'win.md'), 'l1\r\nl2\r\n', 'utf8')
    await writeFile(join(repo, 'mixed.py'), 'a\r\nb\n', 'utf8')
    await writeFile(join(repo, 'unix.ts'), 'a\nb\n', 'utf8')
    await writeFile(join(repo, '中文说明.md'), '内容\r\n第二行\r\n', 'utf8')
    await writeFile(join(repo, 'blob.bin'), '\u0001\u0002\r\n', 'utf8') // 非文本后缀——不抽样
    const diagnostics = await service.repoDiagnostics()
    expect(diagnostics.autocrlf).toBe('true')
    expect(diagnostics.coreEol).toBeNull()
    // worktreeCrlfCount = 含 CRLF 的抽样文本文件数（win.md + mixed.py + 中文说明.md）。
    expect(diagnostics.worktreeCrlfCount).toBe(3)
    expect(diagnostics.mixedEolFiles).toEqual(['mixed.py'])
  })

  it('空配置（隔离全局 + 仓库未设）⇒ autocrlf/coreEol 均 null；仅 LF 文件不计数', async () => {
    const { repo, service } = await makeDiagWorld('empty')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    const diagnostics = await service.repoDiagnostics()
    expect(diagnostics.autocrlf).toBeNull()
    expect(diagnostics.coreEol).toBeNull()
    expect(diagnostics.worktreeCrlfCount).toBe(0)
    expect(diagnostics.mixedEolFiles).toEqual([])
    // 仅 LF 的顶层文本文件：计数仍 0（只有 CRLF 才计入 worktreeCrlfCount）。
    await writeFile(join(repo, 'only.md'), 'a\nb\n', 'utf8')
    const again = await service.repoDiagnostics()
    expect(again.worktreeCrlfCount).toBe(0)
  })

  it('core.eol 显式值回读（lf）', async () => {
    const { repo, service } = await makeDiagWorld('eol')
    git(repo, 'config', 'core.eol', 'lf')
    await commitFile(repo, 'seed.txt', 'seed\n', 'seed')
    const diagnostics = await service.repoDiagnostics()
    expect(diagnostics.coreEol).toBe('lf')
  })
})
