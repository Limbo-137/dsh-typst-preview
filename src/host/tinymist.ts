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
export function resolveInput(file: string, cwd: string | undefined): string {
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

/**
 * Terminate a child and wait for it to release its ports before the next spawn.
 *
 * The exit check reads the process handle, not only the manager's own flag: a
 * child that is still running must never be treated as already gone, because that
 * is the one mistake that leaves a hundred-megabyte compiler behind with nothing
 * left in the process to reach it.
 */
function stopProcess(instance: PreviewInstance): Promise<void> {
  const proc = instance.proc
  if (instance.exited || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  if (proc.pid === undefined) {
    instance.exited = true
    return Promise.resolve()
  }
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      settle()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      settle()
    })
    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      settle()
    }
  })
}

/** How often the reaper looks for work. */
const REAP_INTERVAL_MS = 30_000
/**
 * How long a child that no longer belongs to any key may live. A spawn that is
 * still waiting for its first page is younger than this, so the reaper cannot
 * kill a preview that is merely slow to come up.
 */
const ORPHAN_GRACE_MS = 60_000

/**
 * The live preview servers this plugin owns.
 *
 * Three maps, because a compiler process is far too expensive to lose track of:
 *
 *  - `instances` — the reusable previews, keyed by session × file × color mode,
 *    which is what `open` serves and what the LRU cap counts;
 *  - `spawned` — **every** child this manager has started, keyed by token. This is
 *    the set `close`, the reaper and `dispose` act on, so a child stays reachable
 *    even after it leaves `instances` for any reason;
 *  - `spawning` — the spawns in flight, keyed like `instances`. Two tabs opened on
 *    the same file at the same moment (a remount, a second pane, a reload racing
 *    the first request) used to see an empty `instances` and each start their own
 *    `tinymist preview`; the loser of that race was overwritten in the map and
 *    leaked for the lifetime of the app — a leak of ~600 MB per click. Sharing the
 *    pending promise makes one file mean one process.
 */
export class TinymistPreviews {
  private readonly options: TinymistOptions
  private readonly binary: string
  private readonly instances = new Map<string, PreviewInstance>()
  private readonly spawned = new Map<string, PreviewInstance>()
  private readonly spawning = new Map<string, Promise<PreviewInstance>>()
  /** Last resort: a graceful host exit must not orphan compilers. */
  private readonly onExit = (): void => {
    for (const instance of this.spawned.values()) {
      try {
        instance.proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  private reaper: NodeJS.Timeout | undefined
  private disposed = false

  constructor(options: TinymistOptions) {
    this.options = options
    this.binary = resolveTinymistPath(options.tinymistPath)
    process.once('exit', this.onExit)
  }

  /** The executable actually spawned, for diagnostics. */
  get executable(): string {
    return this.binary
  }

  /** Every live instance, newest use first. */
  list(): readonly PreviewInstance[] {
    return [...this.instances.values()].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  /** How many children this manager is responsible for, live previews or not. */
  get processCount(): number {
    return this.spawned.size
  }

  /** The instance a proxy path names; a child being retired still answers. */
  byToken(token: string): PreviewInstance | undefined {
    return this.spawned.get(token)
  }

  /** Start the idle reaper; the returned callback stops it. */
  startReaper(): () => void {
    if (this.reaper !== undefined) return () => {}
    this.reaper = setInterval(() => {
      void this.reap()
    }, REAP_INTERVAL_MS)
    this.reaper.unref?.()
    return () => {
      if (this.reaper !== undefined) clearInterval(this.reaper)
      this.reaper = undefined
    }
  }

  /**
   * One reaping pass, with three jobs:
   *
   *  1. a child no key claims any more — closed, evicted, or abandoned by a
   *     dropped request — is killed, because nothing else can ever reach it;
   *  2. an active child nobody has touched for the whole idle window is killed;
   *  3. the total number of children is capped, so a bug can cost this process a
   *     few hundred megabytes for half a minute, never for the rest of the day.
   */
  private async reap(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    for (const instance of [...this.spawned.values()]) {
      const active = this.instances.get(instance.key) === instance
      if (!active) {
        if (now - instance.startedAt > ORPHAN_GRACE_MS) await this.stop(instance)
        continue
      }
      if (instance.lastUsed < now - this.options.idleTimeoutMs) await this.stop(instance)
    }
    const ceiling = Math.max(2, this.options.maxInstances * 2)
    while (this.spawned.size > ceiling) {
      const children = [...this.spawned.values()]
      const victim =
        children.filter((child) => this.instances.get(child.key) !== child).sort((a, b) => a.lastUsed - b.lastUsed)[0] ??
        children.sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (victim === undefined) return
      await this.stop(victim)
    }
  }

  /** Reuse a live preview of the same file, or start one. */
  async open(request: OpenPreviewRequest): Promise<PreviewInstance> {
    if (this.disposed) throw new Error('预览管理器已停止')
    const file = resolveInput(request.file, request.cwd)
    const invert = normalizeInvert(request.invert)
    const key = `${request.sessionId ?? ''}\u0000${file}\u0000${invert}`
    const existing = this.instances.get(key)
    if (existing !== undefined && !existing.exited) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing !== undefined) this.instances.delete(key)
    // Somebody else is already starting this exact preview: share their process
    // instead of starting a second compiler the map would have to forget. The
    // promise is registered below without awaiting anything first, because an
    // `await` before that registration is exactly the window two callers slip
    // through — and every child spawned in that window is unreachable forever.
    const inFlight = this.spawning.get(key)
    if (inFlight !== undefined) return inFlight
    const started = this.startSpawn(key, file, invert, request.cwd)
    this.spawning.set(key, started)
    try {
      const instance = await started
      instance.lastUsed = Date.now()
      this.instances.set(key, instance)
      return instance
    } finally {
      if (this.spawning.get(key) === started) this.spawning.delete(key)
    }
  }

  /** Evict down to the cap, then start the child; a thin async body for {@link open}. */
  private startSpawn(key: string, file: string, invert: InvertColors, cwd: string | undefined): Promise<PreviewInstance> {
    const run = async (): Promise<PreviewInstance> => {
      await this.reapBeyondLimit()
      return this.spawn(key, file, invert, cwd)
    }
    return run()
  }

  /** Stop one preview by token; unknown or already stopped tokens are a no-op. */
  async close(token: string): Promise<boolean> {
    const instance = this.spawned.get(token)
    if (instance === undefined) return false
    await this.stop(instance)
    return true
  }

  /** Stop everything and stop listening for new work; used on plugin disposal. */
  async dispose(): Promise<void> {
    this.disposed = true
    process.removeListener('exit', this.onExit)
    const live = [...this.spawned.values()]
    this.instances.clear()
    this.spawned.clear()
    this.spawning.clear()
    await Promise.all(live.map((instance) => stopProcess(instance)))
  }

  /** Retire one child: out of every map first, then out of the process table. */
  private async stop(instance: PreviewInstance): Promise<void> {
    this.spawned.delete(instance.token)
    if (this.instances.get(instance.key) === instance) this.instances.delete(instance.key)
    await stopProcess(instance)
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
    if (this.disposed) throw new Error('预览管理器已停止')
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
    // Registered before the readiness poll, so even a spawn that dies on the way
    // up is reachable by `close`, the reaper and `dispose`.
    this.spawned.set(instance.token, instance)
    proc.once('error', () => {
      // A failed spawn, or a signal the child refused: force it and forget it, so
      // no live compiler can hide behind `exited`.
      instance.exited = true
      this.spawned.delete(instance.token)
      if (this.instances.get(key) === instance) this.instances.delete(key)
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    })
    proc.once('exit', () => {
      instance.exited = true
      this.spawned.delete(instance.token)
      if (this.instances.get(key) === instance) this.instances.delete(key)
    })
    try {
      await waitForReady(dataPort, this.options.readyTimeoutMs, () => !instance.exited)
      if (this.disposed) throw new Error('预览管理器已停止')
      return instance
    } catch (error) {
      await this.stop(instance)
      throw error
    }
  }
}

/** Fold an arbitrary client string onto the three accepted color modes. */
function normalizeInvert(value: string | undefined): InvertColors {
  return value === 'auto' || value === 'always' ? value : 'never'
}
