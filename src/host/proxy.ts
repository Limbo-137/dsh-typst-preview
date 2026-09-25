/**
 * Reverse proxy for one `tinymist preview` data plane.
 *
 * The preview page is served from the app origin under a per-instance path, not
 * from `127.0.0.1:<port>`, so a GUI opened on another machine (or through a
 * tunnel) reaches it exactly as a local one does. Two things make that work:
 *
 *  - HTTP: everything the page asks for is forwarded to the instance's data
 *    plane. The page itself is a single self-contained HTML document, and its
 *    only absolute reference is the WebSocket URL it derives from
 *    `window.location`. That one expression is rewritten to the per-instance
 *    upgrade path, which is why the WebSocket can be same-origin too.
 *  - Upgrade: `webServer.registerUpgrade` hands us the raw socket, so the
 *    handshake is relayed verbatim in both directions and neither the
 *    subprotocol nor the framing is interpreted here.
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** The one absolute reference in tinymist's preview page. */
const WS_URL_EXPRESSION = 'new URL("/", window.location.href)'
/** Tolerant form, in case the page ships with different spacing. */
const WS_URL_PATTERN = /new URL\(\s*"\/"\s*,\s*window\.location\.href\s*\)/

/** Headers that describe this hop and must not be forwarded. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/**
 * Rewrite the preview page's WebSocket URL onto this instance's upgrade path.
 *
 * The address is absolute, not a path: the page may be served from the desktop
 * app's own `dsh-app://app/…` origin, where a relative socket URL resolves to a
 * scheme no WebSocket can be made from (see `webSocketUrl` in the plugin entry).
 */
export function patchPreviewHtml(html: string, wsUrl: string): { html: string; patched: boolean } {
  const replacement = `new URL(${JSON.stringify(wsUrl)}, window.location.href)`
  if (html.includes(WS_URL_EXPRESSION)) {
    return { html: html.replace(WS_URL_EXPRESSION, replacement), patched: true }
  }
  if (WS_URL_PATTERN.test(html)) {
    return { html: html.replace(WS_URL_PATTERN, replacement), patched: true }
  }
  return { html, patched: false }
}

/** Copy client headers onto the upstream request. */
function forwardHeaders(req: IncomingMessage, port: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.includes(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${port}`
  // Identity keeps the page rewritable without a decompression pass.
  headers['accept-encoding'] = 'identity'
  return headers
}

/** How one proxied HTTP request reaches the instance. */
export interface HttpProxyOptions {
  /**
   * Upstream request path. The plugin serves the page under a per-instance
   * prefix, so the prefix is stripped before forwarding; leaving this out
   * forwards the client's own URL unchanged.
   */
  readonly path?: string
  /** Rewrite a `text/html` response body before it reaches the browser. */
  readonly rewriteHtml?: (html: string) => { html: string; patched: boolean }
}

/** Forward one HTTP request to a preview data plane, optionally rewriting its HTML. */
export function proxyHttp(
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpProxyOptions = {},
): void {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: options.path ?? req.url,
      headers: forwardHeaders(req, port),
    },
    (response) => {
      const type = String(response.headers['content-type'] ?? '')
      if (options.rewriteHtml !== undefined && type.toLowerCase().includes('text/html')) {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const rewritten = options.rewriteHtml!(Buffer.concat(chunks).toString('utf8'))
          const body = Buffer.from(rewritten.html, 'utf8')
          const headers: Record<string, string | string[]> = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            const lower = name.toLowerCase()
            if (lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding') continue
            headers[name] = value
          }
          headers['content-length'] = String(body.length)
          res.writeHead(response.statusCode ?? 502, headers)
          res.end(body)
        })
        response.on('error', () => res.destroy())
        return
      }
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('typst preview: instance unreachable')
      return
    }
    res.destroy()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

/** Relay one WebSocket handshake and its framed traffic to a preview data plane. */
export function proxyWebSocket(port: number, req: IncomingMessage, socket: Duplex, head: Buffer, path = '/'): void {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'host') continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${port}`
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const upstream = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false })
  let settled = false
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    settled = true
    const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`]
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead !== undefined && upstreamHead.length > 0) socket.unshift(upstreamHead)
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const finish = (): void => {
      upstreamSocket.destroy()
      socket.destroy()
    }
    upstreamSocket.on('close', finish)
    socket.on('close', finish)
  })
  upstream.on('response', (response) => {
    // The upstream answered plain HTTP: the handshake was refused.
    settled = true
    response.resume()
    socket.destroy()
  })
  upstream.on('error', () => {
    if (!settled) socket.destroy()
  })
  socket.on('close', () => upstream.destroy())
  upstream.end()
}
