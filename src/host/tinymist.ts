/**
 * `tinymist preview` process management.
 *
 * One Typst file gets one preview server: `tinymist preview` binds a data plane
 * (the page and its WebSocket) and a control plane, and both default to fixed
 * ports, so two previews can only coexist when every instance is handed its own
 * pair. That pair is picked here by binding two throwaway loopback listeners and
 * releasing them, and the instance is keyed by session + file + color mode so a
 * second tab of the same file reuses the running process instead of racing it
 * for a port.
 *
 * The project root follows tinymist's own convention: the nearest ancestor
 * directory carrying a `typst.toml`, else the Session workspace when the file
 * lives inside it, else the file's own directory. A root that is too narrow
 * only narrows what `@local`/absolute imports resolve against; it never blocks
 * the preview.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/** Color handling handed to tinymist's `--invert-colors`. */
export type InvertColors = 'never' | 'auto' | 'always'

/** Deployment knobs for the preview manager. */
export interface TinymistOptions {
  /** Executable name or absolute path; a bare name is resolved through PATH. */
  readonly tinymistPath: string
  /** Extra arguments inserted before the input file. */
  readonly extraArgs: readonly string[]
  /** Live previews kept at once; the least recently used one is reaped past it. */
  readonly maxInstances: number
  /** How long a freshly spawned server may take to answer its first request. */
  readonly readyTimeoutMs: number
  /** How long an unused preview survives before the reaper stops it. */
  readonly idleTimeoutMs: number
}

/** Defaults used when the plugin row declares no config. */
export const DEFAULT_OPTIONS: TinymistOptions = {
  tinymistPath: 'tinymist',
  extraArgs: [],
  maxInstances: 4,
  readyTimeoutMs: 20_000,
  idleTimeoutMs: 30 * 60 * 1000,
}

/** What the browser half asks for. */
export interface OpenPreviewRequest {
  /** The `.typ` file: absolute, or relative to `cwd`. */
  readonly file: string
  /** Session workspace directory, the fallback project root. */
  readonly cwd: string | undefined
  /** Session identity, for diagnostics and process keying. */
  readonly sessionId: string | undefined
  /** Color handling; anything unrecognized means `never`. */
  readonly invert: string | undefined
}

/** One live `tinymist preview` server. */
export interface PreviewInstance {
  /** URL-safe identity used in the proxy paths the browser half is given. */
  readonly token: string
  /** Internal reuse key: session, absolute file, color mode. */
  readonly key: string
  readonly file: string
  readonly root: string
  readonly dataPort: number
  readonly controlPort: number
  readonly invert: InvertColors
  readonly args: readonly string[]
  readonly startedAt: number
  lastUsed: number
  exited: boolean
  readonly proc: ChildProcess
}

/** Absolute path of the input, refusing anything that is not an existing file. */
function resolveInput(file: string, cwd: string | undefined): string {
  const trimmed = file.trim()
  if (trimmed === '') throw new Error('file required')
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd ?? process.cwd(), trimmed)
  const info = statSync(absolute, { throwIfNoEntry: false })
  if (info === undefined) throw new Error(`file not found: ${absolute}`)
  if (!info.isFile()) throw new Error(`not a regular file: ${absolute}`)
  return absolute
}

/** Whether `child` sits inside `parent`, or is `parent` itself. */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/** Nearest ancestor with a `typst.toml`, else the workspace, else the file's directory. */
export function resolveRoot(file: string, cwd: string | undefined): string {
  let directory = dirname(file)
  const stop = resolve('/')
  for (;;) {
    if (existsSync(join(directory, 'typst.toml'))) return directory
    if (directory === stop) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (cwd !== undefined && cwd.trim() !== '') {
    const workspace = resolve(cwd)
    if (contains(workspace, file)) return workspace
  }
  return dirname(file)
}

/** Bind `count` loopback listeners at once so every returned port is distinct. */
function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => new Promise<Server>((settle, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => settle(server))
  }))
  return Promise.all(servers).then(async (listening) => {
    const ports = listening.map((server) => (server.address() as AddressInfo).port)
    await Promise.all(listening.map((server) => new Promise<void>((done) => server.close(() => done()))))
    return ports
  })
}

/** Candidate locations a bare `tinymist` may hide in when PATH is thin. */
function fallbackCandidates(): readonly string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin', 'tinymist'),
    '/opt/homebrew/bin/tinymist',
    '/usr/local/bin/tinymist',
    join(home, '.cargo', 'bin', 'tinymist'),
  ]
}

/** Resolve the executable once: PATH first, then the usual install locations. */
export function resolveTinymistPath(preferred: string): string {
  if (isAbsolute(preferred)) return preferred
  for (const candidate of fallbackCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return preferred
}

/** Poll the data plane until it answers, so the iframe never races the spawn. */
function waitForReady(port: number, timeoutMs: number, isAlive: () => boolean): Promise<void> {
  return new Promise((settle, fail) => {
    const deadline = Date.now() + timeoutMs
    const probe = (): void => {
      if (!isAlive()) {
        fail(new Error('tinymist 进程已退出'))
        return
      }
      const attempt = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (response) => {
        response.resume()
        settle()
      })
      attempt.setTimeout(1000, () => attempt.destroy())
      attempt.on('error', () => {
        if (Date.now() >= deadline) fail(new Error(`tinymist 预览未在 ${timeoutMs}ms 内就绪`))
        else setTimeout(probe, 200)
      })
      attempt.end()
    }
    probe()
  })
}

/** Terminate a child and wait for it to release its ports before the next spawn. */
function stopProcess(instance: PreviewInstance): Promise<void> {
  if (instance.exited) return Promise.resolve()
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      instance.proc.kill('SIGKILL')
      settle()
    }, 3000)
    instance.proc.once('exit', () => {
      clearTimeout(timer)
      settle()
    })
    instance.proc.kill('SIGTERM')
  })
}

/** The live preview servers this plugin owns. */
export class TinymistPreviews {
  private readonly options: TinymistOptions
  private readonly binary: string
  private readonly instances = new Map<string, PreviewInstance>()
  private reaper: NodeJS.Timeout | undefined

  constructor(options: TinymistOptions) {
    this.options = options
    this.binary = resolveTinymistPath(options.tinymistPath)
  }

  /** The executable actually spawned, for diagnostics. */
  get executable(): string {
    return this.binary
  }

  /** Every live instance, newest use first. */
  list(): readonly PreviewInstance[] {
    return [...this.instances.values()].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  /** The instance a proxy path names. */
  byToken(token: string): PreviewInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.token === token) return instance
    }
    return undefined
  }

  /** Start the idle reaper; the returned callback stops it. */
  startReaper(): () => void {
    if (this.reaper !== undefined) return () => {}
    this.reaper = setInterval(() => {
      const deadline = Date.now() - this.options.idleTimeoutMs
      for (const instance of [...this.instances.values()]) {
        if (instance.lastUsed < deadline) void this.close(instance.token)
      }
    }, 60_000)
    this.reaper.unref?.()
    return () => {
      if (this.reaper !== undefined) clearInterval(this.reaper)
      this.reaper = undefined
    }
  }

  /** Reuse a live preview of the same file, or start one. */
  async open(request: OpenPreviewRequest): Promise<PreviewInstance> {
    const file = resolveInput(request.file, request.cwd)
    const invert = normalizeInvert(request.invert)
    const key = `${request.sessionId ?? ''}\u0000${file}\u0000${invert}`
    const existing = this.instances.get(key)
    if (existing !== undefined && !existing.exited) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing !== undefined) this.instances.delete(key)
    await this.reapBeyondLimit()
    const instance = await this.spawn(key, file, invert, request.cwd)
    instance.lastUsed = Date.now()
    this.instances.set(key, instance)
    return instance
  }

  /** Stop one preview by token; unknown or already stopped tokens are a no-op. */
  async close(token: string): Promise<boolean> {
    let target: PreviewInstance | undefined
    for (const [key, instance] of this.instances) {
      if (instance.token === token) {
        target = instance
        this.instances.delete(key)
        break
      }
    }
    if (target === undefined) return false
    await stopProcess(target)
    return true
  }

  /** Stop everything; used on plugin disposal. */
  async dispose(): Promise<void> {
    const live = [...this.instances.values()]
    this.instances.clear()
    await Promise.all(live.map((instance) => stopProcess(instance)))
  }

  private async reapBeyondLimit(): Promise<void> {
    while (this.instances.size >= Math.max(1, this.options.maxInstances)) {
      const oldest = this.list()[this.list().length - 1]
      if (oldest === undefined) return
      await this.close(oldest.token)
    }
  }

  private async spawn(key: string, file: string, invert: InvertColors, cwd: string | undefined): Promise<PreviewInstance> {
    const root = resolveRoot(file, cwd)
    const [dataPort, controlPort] = await freePorts(2)
    const args = [
      'preview',
      '--no-open',
      '--root', root,
      '--data-plane-host', `127.0.0.1:${dataPort}`,
      '--control-plane-host', `127.0.0.1:${controlPort}`,
      ...(invert === 'never' ? [] : [`--invert-colors=${invert}`]),
      ...this.options.extraArgs,
      file,
    ]
    const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    // Drain both pipes: an unread pipe eventually blocks the child.
    proc.stdout?.on('data', () => {})
    proc.stderr?.on('data', () => {})
    const instance: PreviewInstance = {
      token: randomBytes(9).toString('hex'),
      key,
      file,
      root,
      dataPort,
      controlPort,
      invert,
      args,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      exited: false,
      proc,
    }
    proc.once('error', () => { instance.exited = true })
    proc.once('exit', () => {
      instance.exited = true
      if (this.instances.get(key) === instance) this.instances.delete(key)
    })
    try {
      await waitForReady(dataPort, this.options.readyTimeoutMs, () => !instance.exited)
    } catch (error) {
      await stopProcess(instance)
      throw error
    }
    return instance
  }
}

/** Fold an arbitrary client string onto the three accepted color modes. */
function normalizeInvert(value: string | undefined): InvertColors {
  return value === 'auto' || value === 'always' ? value : 'never'
}
