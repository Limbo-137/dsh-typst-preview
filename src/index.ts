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
  const previews = new TinymistPreviews(optionsOf(config))
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

  const pageRoute: WebRoute = {
    kind: 'prefix',
    path: `${API}/p`,
    handler: (req, res) => {
      const token = tokenOf(req.url, PAGE_PREFIX)
      const instance = token === undefined ? undefined : previews.byToken(token)
      if (instance === undefined || instance.exited) {
        writeJson(res, 404, { ok: false, error: 'no such preview' })
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
    webServer.register(pageRoute),
  ]
  const stopReaper = previews.startReaper()

  ctx.effect(() => () => {
    stopReaper()
    for (const dispose of disposers) dispose()
    for (const dispose of [...upgrades.values()]) dispose()
    upgrades.clear()
    void previews.dispose()
  }, 'typst-preview: routes, upgrade claims and preview processes')
}
