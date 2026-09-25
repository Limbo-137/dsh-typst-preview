/**
 * Host half: the `tinymist preview` fleet and the `/api/typst-preview/*` routes
 * the browser half drives.
 *
 * One route table, loopback-free by construction:
 *
 *  - `POST open`  — start (or reuse) a preview for one `.typ` file, answer with
 *                   the same-origin page path plus the upgrade path, and claim
 *                   the upgrade route that instance's socket needs.
 *  - `POST close` — stop it and release both routes.
 *  - `POST source`— one page of the file's text with the token runs that paint
 *                   it, decoded from tinymist's own semantic tokens, so the
 *                   source face is not flat text.
 *  - `GET  status`— what is running, for diagnostics.
 *  - `GET  p/<token>/…` — the page and everything it asks for, forwarded to the
 *                   instance's data plane; the page's one absolute WebSocket
 *                   reference is rewritten onto `ws/<token>`.
 *  - `GET  ws/<token>` (Upgrade) — relayed verbatim to the same data plane.
 *
 * Every route refuses cross-site requests and requests whose `Origin` is not the
 * request's own host, because spawning a compiler for a page the user is not
 * looking at is exactly the class of bug a browser makes easy. Same-origin
 * requests from a remote GUI pass, so the plugin works with the app bound to a
 * LAN address or behind a tunnel.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { DEFAULT_OPTIONS, TinymistPreviews, type PreviewInstance, type TinymistOptions } from './host/tinymist'
import { DEFAULT_HIGHLIGHT_OPTIONS, TypstHighlighter, type HighlightOptions } from './host/highlight'
import { patchPreviewHtml, proxyHttp, proxyWebSocket } from './host/proxy'

/** Required host services. */
export const inject = ['webServer']

/** One named HTTP route registration, as `@deepseek-ai/dsh-host-webserver` declares it. */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** The slice of the web server this plugin uses. */
interface WebServerFace {
  register(route: WebRoute): () => void
  registerUpgrade(route: WebUpgradeRoute): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The browser HTTP carrier, provided by the host web composition. */
    webServer: WebServerFace
  }
}

/** Plugin config: the manager's knobs, all optional. */
export interface TypstPreviewConfig {
  readonly tinymistPath?: string
  readonly extraArgs?: readonly string[]
  readonly maxInstances?: number
  readonly readyTimeoutMs?: number
  readonly idleTimeoutMs?: number
  /** Whether the source face is highlighted; off leaves it to the paged reader. */
  readonly highlight?: boolean
  /** Lines per highlighted page; the browser half sends its own default too. */
  readonly highlightLines?: number
  /** Files above this size fall back to plain text. */
  readonly highlightMaxBytes?: number
  /** How long an unused highlighting language server survives. */
  readonly highlightIdleTimeoutMs?: number
  /** Language servers kept at once, one per project root. */
  readonly highlightMaxServers?: number
}

const API = '/api/typst-preview'
const PAGE_PREFIX = `${API}/p/`
const WS_PREFIX = `${API}/ws/`
const BODY_LIMIT = 8 * 1024

/** Merge declared config over the defaults. */
function optionsOf(config: TypstPreviewConfig | undefined): TinymistOptions {
  return {
    tinymistPath: config?.tinymistPath ?? DEFAULT_OPTIONS.tinymistPath,
    extraArgs: config?.extraArgs ?? DEFAULT_OPTIONS.extraArgs,
    maxInstances: config?.maxInstances ?? DEFAULT_OPTIONS.maxInstances,
    readyTimeoutMs: config?.readyTimeoutMs ?? DEFAULT_OPTIONS.readyTimeoutMs,
    idleTimeoutMs: config?.idleTimeoutMs ?? DEFAULT_OPTIONS.idleTimeoutMs,
  }
}

/** Merge declared config over the highlighting defaults. */
function highlightOptionsOf(config: TypstPreviewConfig | undefined, tinymistPath: string): HighlightOptions {
  return {
    // The *resolved* executable, never the raw config value: both halves must run
    // the same `tinymist`, and only the preview manager searches the install
    // locations. A bare `tinymist` here is an ENOENT waiting for a host that does
    // not put `~/.local/bin` on `PATH` — which is exactly what the native app is.
    tinymistPath,
    extraArgs: config?.extraArgs ?? DEFAULT_OPTIONS.extraArgs,
    maxServers: positive(config?.highlightMaxServers, DEFAULT_HIGHLIGHT_OPTIONS.maxServers),
    requestTimeoutMs: DEFAULT_HIGHLIGHT_OPTIONS.requestTimeoutMs,
    idleTimeoutMs: positive(config?.highlightIdleTimeoutMs, DEFAULT_HIGHLIGHT_OPTIONS.idleTimeoutMs),
    maxFileBytes: positive(config?.highlightMaxBytes, DEFAULT_HIGHLIGHT_OPTIONS.maxFileBytes),
  }
}

/** A declared positive number, else the default. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** A declared positive integer, else the default. */
function pageLines(value: number | undefined): number {
  return Math.max(1, Math.floor(positive(value, 800)))
}

/**
 * What a page request for an unknown token answers.
 *
 * It is shown inside the preview iframe for the moment it takes the browser half
 * to notice and re-open, so it says what happened and that a reload fixes it.
 */
const STALE_PREVIEW_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>预览已失效</title>
<style>
 body{margin:0;padding:24px;font:13px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif;
      color:#495057;background:#fff}
 @media (prefers-color-scheme:dark){body{color:#ced4da;background:#1a1b1e}}
 code{font-family:ui-monospace,monospace;background:rgba(127,127,127,.14);padding:1px 4px;border-radius:4px}
</style></head>
<body><p><b>这个预览已经被回收了。</b></p>
<p>This preview has been reaped. 侧边栏会重新开一个 —— 如果一直停在这里，按一下工具栏的重新载入。</p>
</body></html>`

/** Answer with a small HTML document, used where the reader is a person. */
function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Whether this request comes from the app itself rather than another site. */
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) return false
    } catch {
      return false
    }
  }
  return true
}

/** Read a small JSON object body. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** A finite numeric body field, or `undefined` when it is absent or unusable. */
function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The instance a `/p/<token>/…` or `/ws/<token>` path names. */
function tokenOf(url: string | undefined, prefix: string): string | undefined {
  if (url === undefined) return undefined
  const path = url.split('?')[0] ?? ''
  if (!path.startsWith(prefix)) return undefined
  const [token] = path.slice(prefix.length).split('/')
  return token === undefined || token === '' ? undefined : token
}

/** The instance-local path behind one page URL: the prefix and token come off. */
function upstreamPathOf(url: string | undefined, token: string): string {
  const raw = url ?? '/'
  const cut = `${PAGE_PREFIX}${token}`
  if (!raw.startsWith(cut)) return '/'
  const rest = raw.slice(cut.length)
  if (rest === '') return '/'
  return rest.startsWith('/') ? rest : `/${rest}`
}

/** Plugin body: own the fleet, claim the routes, release both on unload. */
export function apply(ctx: Context, config?: TypstPreviewConfig): void {
  const webServer = ctx.webServer
  if (webServer === undefined) throw new Error('dsh-typst-preview: webServer service is required')
  const options = optionsOf(config)
  const previews = new TinymistPreviews(options)
  const highlightEnabled = config?.highlight !== false
  const highlighter = highlightEnabled
    ? new TypstHighlighter(highlightOptionsOf(config, previews.executable))
    : undefined
  const lineLimit = pageLines(config?.highlightLines)
  /** Upgrade route per live token; the socket owner is the instance itself. */
  const upgrades = new Map<string, () => void>()

  const releaseUpgrade = (token: string): void => {
    const dispose = upgrades.get(token)
    if (dispose === undefined) return
    upgrades.delete(token)
    dispose()
  }

  const claimUpgrade = (instance: PreviewInstance): void => {
    if (upgrades.has(instance.token)) return
    const path = `${WS_PREFIX}${instance.token}`
    const dispose = webServer.registerUpgrade({
      path,
      handler: (req, socket, head) => {
        if (!sameOrigin(req)) {
          socket.destroy()
          return
        }
        const live = previews.byToken(instance.token)
        if (live === undefined) {
          socket.destroy()
          return
        }
        live.lastUsed = Date.now()
        // Count the relay for the instance's lifetime: the reaper must not call a
        // preview idle while a browser is still holding its socket open.
        live.sockets += 1
        socket.once('close', () => {
          live.sockets = Math.max(0, live.sockets - 1)
          live.lastUsed = Date.now()
        })
        proxyWebSocket(live.dataPort, req, socket, head)
      },
    })
    upgrades.set(instance.token, dispose)
  }

  const openRoute: WebRoute = {
    kind: 'exact',
    path: `${API}/open`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' })
        return
      }
      const file = stringField(body, 'file')
      if (file === undefined) {
        writeJson(res, 400, { ok: false, error: 'file is required' })
        return
      }
      try {
        const instance = await previews.open({
          file,
          cwd: stringField(body, 'cwd'),
          sessionId: stringField(body, 'sessionId'),
          invert: stringField(body, 'invert'),
        })
        claimUpgrade(instance)
        writeJson(res, 200, {
          ok: true,
          token: instance.token,
          url: `${PAGE_PREFIX}${instance.token}/`,
          ws: `${WS_PREFIX}${instance.token}`,
          file: instance.file,
          root: instance.root,
          invert: instance.invert,
        })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'preview failed' })
      }
    },
  }

  const closeRoute: WebRoute = {
    kind: 'exact',
    path: `${API}/close`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad request' })
        return
      }
      const token = stringField(body, 'token')
      if (token === undefined) {
        writeJson(res, 400, { ok: false, error: 'token is required' })
        return
      }
      releaseUpgrade(token)
      const stopped = await previews.close(token)
      writeJson(res, 200, { ok: true, stopped })
    },
  }

  const statusRoute: WebRoute = {
    kind: 'exact',
    path: `${API}/status`,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      writeJson(res, 200, {
        ok: true,
        executable: previews.executable,
        pagePrefix: PAGE_PREFIX,
        wsPrefix: WS_PREFIX,
        highlight: { enabled: highlightEnabled, lines: lineLimit, servers: highlighter?.list() ?? [] },
        // `processes` counts every child this plugin owns, `instances` only the
        // reusable ones: the two disagreeing is the shape of a leak.
        processes: previews.processCount,
        instances: previews.list().map((instance) => ({
          token: instance.token,
          file: instance.file,
          root: instance.root,
          invert: instance.invert,
          dataPort: instance.dataPort,
          controlPort: instance.controlPort,
          startedAt: instance.startedAt,
          lastUsed: instance.lastUsed,
          exited: instance.exited,
        })),
      })
    },
  }

  const sourceRoute: WebRoute = {
    kind: 'exact',
    path: `${API}/source`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (highlighter === undefined) {
        writeJson(res, 200, { ok: false, error: 'highlighting is disabled' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad request' })
        return
      }
      const file = stringField(body, 'file')
      if (file === undefined) {
        writeJson(res, 400, { ok: false, error: 'file is required' })
        return
      }
      try {
        const page = await highlighter.page({
          file,
          cwd: stringField(body, 'cwd'),
          offset: numberField(body, 'offset') ?? 1,
          limit: numberField(body, 'limit') ?? lineLimit,
        })
        writeJson(res, 200, { ok: true, ...page })
      } catch (error) {
        // Not an error the browser half reports: it falls back to the paged
        // reader, which is what the source face did before highlighting existed.
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : 'highlight failed' })
      }
    },
  }

  const pageRoute: WebRoute = {
    kind: 'prefix',
    path: `${API}/p`,
    handler: (req, res) => {
      const token = tokenOf(req.url, PAGE_PREFIX)
      const instance = token === undefined ? undefined : previews.byToken(token)
      if (instance === undefined || instance.exited) {
        // The iframe was re-pointed at a token the host has already reaped. The
        // browser half re-opens and reloads, so this answer is a sentence a person
        // can read rather than a JSON blob rendered as the page.
        writeHtml(res, 404, STALE_PREVIEW_HTML)
        return
      }
      instance.lastUsed = Date.now()
      const wsPath = `${WS_PREFIX}${instance.token}`
      proxyHttp(instance.dataPort, req, res, {
        path: upstreamPathOf(req.url, instance.token),
        rewriteHtml: (html) => patchPreviewHtml(html, wsPath),
      })
    },
  }

  const disposers = [
    webServer.register(openRoute),
    webServer.register(closeRoute),
    webServer.register(statusRoute),
    webServer.register(sourceRoute),
    webServer.register(pageRoute),
  ]
  const stopReaper = previews.startReaper()
  const stopHighlightReaper = highlighter?.startReaper()

  ctx.effect(() => () => {
    stopReaper()
    stopHighlightReaper?.()
    for (const dispose of disposers) dispose()
    for (const dispose of [...upgrades.values()]) dispose()
    upgrades.clear()
    void highlighter?.dispose()
    void previews.dispose()
  }, 'typst-preview: routes, upgrade claims and preview processes')
}
