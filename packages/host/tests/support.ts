/**
 * 测试公共设施（范式照 dsh 树 workspace-changes/tests/support.ts：mkdtemp + cleanups
 * 逆序清理 + execFileSync 真 git 造仓库；断言纪律 = 验证世界而非自述）。
 *
 * SubprocessFace 的测试替身是真执行：spawn 真实 git 子进程（node child_process →
 * CreateProcess 语义按 PATH 解析可执行名），env 合并语义照 dsh subprocess
 * （types.ts:99-106：env 合并到净化后的父环境，`undefined` = 墓碑即删除）。
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { SubprocessFace } from '../src/git-runner.ts'
import type { GitFsWatchFace } from '../src/watcher.ts'

/** Run git synchronously inside a fixture repository（world 重读用）。 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A temporary directory removed by the returned cleanup. */
export async function scratchDir(prefix: string, cleanups: Array<() => Promise<unknown>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  // Windows：git 子进程的瞬态 cwd 句柄/杀软扫描会让 rmdir 撞上 EBUSY——rm 带重试。
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  return dir
}

/** A temporary git repository (`git init -q -b main`，可选本地身份配置)。 */
export async function scratchRepo(
  prefix: string,
  cleanups: Array<() => Promise<unknown>>,
  identity?: { name?: string; email?: string },
): Promise<string> {
  const dir = await scratchDir(prefix, cleanups)
  git(dir, 'init', '-q', '-b', 'main')
  if (identity?.name !== undefined) git(dir, 'config', 'user.name', identity.name)
  if (identity?.email !== undefined) git(dir, 'config', 'user.email', identity.email)
  return dir
}

/**
 * 真实 spawn 的 SubprocessFace 替身：真 git 子进程 + dsh env 合并语义
 * （父环境 ⊕ spec.env，`undefined` 墓碑 = 从父环境删除）。
 *
 * 输出保尾语义（dsh subprocess-local：stdout 溢出保尾部 + truncated 置真；
 * stderr 固定尾部）在本替身内模拟——readFrom 的 text 在 lossy 时只留最后 maxBytes 字节。
 *
 * @param record 可选记录数组：每次 spawn 的 {argv, cwd, env} 追加于此（断言前缀/env 用）。
 */
export function localSubprocess(record?: SpawnRecord[]): SubprocessFace {
  return {
    async resolveExecutable(command) {
      // node spawn 在 Windows 走 CreateProcess 的 PATH+.exe 解析，裸名即可命中；
      // 找不到时由 spawn 的 error 事件如实失败。
      return command
    },
    spawn(spec) {
      record?.push({ argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env } })
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value
      }
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      const stdinSpec = spec.stdio.stdin
      const child = nodeSpawn(spec.argv[0] as string, spec.argv.slice(1) as string[], {
        cwd: spec.cwd,
        env,
        windowsHide: true,
        stdio: [stdinSpec === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk); stdoutBytes += chunk.length })
      child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk); stderrBytes += chunk.length })
      if (stdinSpec !== 'ignore') {
        child.stdin?.end(stdinSpec.data)
      }
      if (spec.signal !== undefined) {
        const abort = () => {
          // runbook §6.9：Windows 终止一律 taskkill /PID /T /F。
          nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        }
        if (spec.signal.aborted) abort()
        else spec.signal.addEventListener('abort', abort, { once: true })
      }
      const done = new Promise<{ exitCode: number | null; signal?: unknown }>((resolveDone) => {
        child.on('error', () => { resolveDone({ exitCode: null }) })
        child.on('close', (code) => { resolveDone({ exitCode: code }) })
      })
      const tail = (buffers: Buffer[], bytes: number): string =>
        Buffer.concat(buffers).subarray(-bytes).toString('utf8')
      const stdoutText = () => stdoutBytes > spec.stdio.stdout.maxBytes
        ? tail(stdout, spec.stdio.stdout.maxBytes)
        : Buffer.concat(stdout).toString('utf8')
      const stderrText = () => stderrBytes > spec.stdio.stderr.maxBytes
        ? tail(stderr, spec.stdio.stderr.maxBytes)
        : Buffer.concat(stderr).toString('utf8')
      return {
        done,
        collected: {
          stdout: {
            readFrom(offset: number) {
              const text = stdoutText()
              return { text: text.slice(offset), lossy: stdoutBytes > spec.stdio.stdout.maxBytes }
            },
          },
          stderr: {
            readFrom(offset: number) {
              const text = stderrText()
              return { text: text.slice(offset), lossy: stderrBytes > spec.stdio.stderr.maxBytes }
            },
          },
        },
      }
    },
  }
}

/** 一次 spawn 的记录（前缀/env 断言用）。 */
export interface SpawnRecord {
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
}

/** A controlled `GIT_CONFIG_GLOBAL` file (identity 测试的确定性全局配置)。 */
export async function scratchGlobalConfig(
  prefix: string,
  cleanups: Array<() => Promise<unknown>>,
  entries: Record<string, string>,
): Promise<string> {
  const file = join(await scratchDir(prefix, cleanups), 'gitconfig-global')
  const body = Object.entries(entries).map(([key, value]) => `[${key.slice(0, key.lastIndexOf('.'))}]\n\t${key.slice(key.lastIndexOf('.') + 1)} = ${value}`).join('\n')
  await writeFile(file, `${body}\n`, 'utf8')
  return file
}

// ---------- M9 watcher 的 fs watch 面替身 ----------

/**
 * chokidar@5 的宿主 fs watch 面 —— dsh fs-local `LocalFileSystem.watch`
 * （packages/fs/fs-local/src/index.ts:70-91）的**行为仿真**（B 级，PORTING.md 登记）：
 *   - 目录目标 = chokidar 监目录 `depth: 0`（只监直接子项），无 ignore 过滤；
 *   - 文件目标 = 监父目录，`ignored` 只放行根与目标本身；
 *   - 事件回调（失效）不带内容路径；`signal` 只取消初始化，close 关闭已建立者。
 * resolve 与 fs-local 同为「路径定型」语义（缺省不要求存在——absent 文件目标由
 * watch 内部的 stat 兜成父目录监听，目标被创建时照常触发）。
 */
export function chokidarFsFace(): GitFsWatchFace {
  return {
    async resolve(path) {
      return resolve(String(path))
    },
    async watch(target, changed, signal) {
      signal.throwIfAborted()
      const path = resolve(String(target))
      let directory = false
      try {
        directory = (await stat(path)).isDirectory()
      } catch {
        directory = false
      }
      const root = directory ? path : dirname(path)
      const watcher = chokidarWatch(root, {
        ignoreInitial: true,
        depth: 0,
        ...(directory ? {} : {
          ignored: (entry: string) => resolve(entry) !== root && resolve(entry) !== path,
        }),
      })
      watcher.on('all', (_event, entry) => {
        if (directory || resolve(String(entry)) === path) changed()
      })
      watcher.on('error', (error: unknown) => {
        changed(error instanceof Error ? error : new Error(String(error)))
      })
      try {
        await once(watcher, 'ready', { signal })
      } catch (error) {
        await watcher.close()
        throw error
      }
      return async () => { await watcher.close() }
    },
  }
}

/** 一次手动 watch 的记录（三目标形状/引用计数/close 断言用）。 */
export interface RecordedWatch {
  /** 解析后的目标绝对路径。 */
  target: string
  /** 失效回调：测试用它手动模拟 fs 事件（`changed()` 无参 / `changed(error)` 报错）。 */
  changed: (error?: Error) => void
  /** close 已调用（watcher 已关）。 */
  closed: boolean
  /** close 调用次数。 */
  closeCount: number
}

export interface ManualFsFaceHandle {
  face: GitFsWatchFace
  records: RecordedWatch[]
  /** 触发全部未关闭 watcher 的失效回调（无参 = 正常失效）。 */
  fireAll(): void
}

/**
 * 手动 fs watch 面：watch() 只记录、由测试手动触发 `changed()`。
 * 用于防抖合并、R2 抑制、R3/R5 触发、引用计数与 R6 changed(error) 降级的确定性断言。
 */
export function manualFsFace(): ManualFsFaceHandle {
  const records: RecordedWatch[] = []
  return {
    records,
    fireAll() {
      for (const record of records) {
        if (!record.closed) record.changed()
      }
    },
    face: {
      async resolve(path) {
        return resolve(String(path))
      },
      async watch(target, changed) {
        const record: RecordedWatch = { target: resolve(String(target)), changed, closed: false, closeCount: 0 }
        records.push(record)
        return async () => {
          record.closed = true
          record.closeCount += 1
        }
      },
    },
  }
}

/**
 * 拒绝式 fs watch 面 —— SSH/远端执行世界仿真（dsh fs 基类 `FileSystem.watch` 默认
 * 实现 packages/fs/fs/src/index.ts:116-121：`Promise.reject(FsError)`；ssh provider
 * 无 watch override 即走此路径）。resolve 可用（远端 resolve 存在，缺的只是 watch）。
 */
export function rejectingFsFace(): GitFsWatchFace & { resolveCalls: number; watchAttempts: number } {
  const face = {
    resolveCalls: 0,
    watchAttempts: 0,
    async resolve(path: string) {
      face.resolveCalls += 1
      return resolve(String(path))
    },
    watch() {
      face.watchAttempts += 1
      return Promise.reject(new Error('Filesystem watching is not supported by this provider.'))
    },
  }
  return face
}
