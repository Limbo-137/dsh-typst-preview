/**
 * Integration smoke test for the whole host half.
 *
 * Boots the plugin's own `apply()` against a stand-in for the DSH web server
 * (same exact/prefix/longest-prefix and exact-upgrade dispatch), then drives the
 * five routes the browser half uses against real `tinymist` processes:
 *
 *   1. `open` starts an instance and answers with same-origin paths;
 *   2. the page route forwards the preview page with its WebSocket URL rewritten;
 *   3. the upgrade route relays a live WebSocket that delivers compile results;
 *   4. `source` answers with a page of text plus the token runs that paint it;
 *   5. `close` stops the process, and so does disposing the plugin.
 *
 * `open` and `source` are also refused for a cross-site request, which is the one
 * guard that keeps a random page from spawning compilers on this machine.
 *
 * Run with `node scripts/smoke.mjs` after `pnpm build`.
 */

import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const fixtureDir = join(packageRoot, '.tmp-smoke')
const fixture = join(fixtureDir, 'smoke.typ')
/** The source-route document: markup, math, CJK and a comment on purpose. */
const markup = join(fixtureDir, 'markup.typ')

// Start clean: a preview watches this directory, and leftovers from an earlier
// run make the fixture and the watched tree disagree about what is there.
rmSync(fixtureDir, { recursive: true, force: true })
mkdirSync(fixtureDir, { recursive: true })
writeFileSync(fixture, '#set page(width: 240pt, height: 160pt)\n= Smoke\n$ x^2 + y^2 = z^2 $\n', 'utf8')
writeFileSync(
  markup,
  [
    // A CJK font is not optional: Typst's default Latin font has no Chinese
    // glyphs, so without the stack the page renders boxes and says nothing
    // useful about the pipeline. `typst fonts` lists what a machine has.
    '#set text(font: ("New Computer Modern", "Songti SC", "STSong", "SimSun"))',
    '#set page(width: 240pt, height: 160pt)',
    // Referencing a heading needs numbering, or Typst refuses the reference.
    '#set heading(numbering: "1.")',
    '= Smoke <smoke>',
    '$ x^2 + y^2 = z^2 $',
    'Let *\u5f3a\u8c03* and #emph[thing] be $x_1$ for @smoke. // \u6ce8\u91ca',
  ].join('\n') + '\n',
  'utf8',
)

/* ---------------------------------------------------------------- stand-ins */

/** A web server stub with the shipped dispatcher's semantics. */
function fakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const lifecycle = []
  const webServer = {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error(`duplicate upgrade route ${route.path}`)
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
  const ctx = {
    webServer,
    effect(fn) {
      const dispose = fn()
      lifecycle.push(dispose)
      return () => {}
    },
  }
  const match = (pathname) => {
    const hit = exact.get(pathname)
    if (hit !== undefined) return hit
    let best
    for (const [prefix, route] of prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }
  return { ctx, match, upgrades, lifecycle }
}

function fetchText(url, headers = {}) {
  return new Promise((settle, fail) => {
    const attempt = httpRequest(url, { headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => settle({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }))
    })
    attempt.on('error', fail)
    attempt.end()
  })
}

function postJson(url, body, headers = {}) {
  return new Promise((settle, fail) => {
    const payload = JSON.stringify(body)
    const attempt = httpRequest(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = { raw: text }
          }
          settle({ status: response.statusCode, body: parsed })
        })
      },
    )
    attempt.on('error', fail)
    attempt.end(payload)
  })
}

function collectWebSocketFrames(url, windowMs) {
  return new Promise((settle, fail) => {
    const socket = new WebSocket(url)
    const sizes = []
    let bytes = 0
    const finish = () => {
      try {
        socket.close()
      } catch {
        /* already gone */
      }
      settle({ count: sizes.length, bytes, sizes })
    }
    const timer = setTimeout(finish, windowMs)
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => socket.send('current'))
    socket.addEventListener('message', (event) => {
      const size = typeof event.data === 'string' ? event.data.length : (event.data.byteLength ?? 0)
      sizes.push(size)
      bytes += size
      if (bytes > 0) {
        clearTimeout(timer)
        finish()
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error('WebSocket error'))
    })
  })
}

/* ------------------------------------------------------------------- checks */

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const { ctx, match, upgrades, lifecycle } = fakeWebServer()
apply(ctx, { maxInstances: 2, readyTimeoutMs: 20_000 })

const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0]
  const route = match(pathname)
  if (route === undefined) {
    res.writeHead(404).end('not found')
    return
  }
  Promise.resolve(route.handler(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '/').split('?')[0]
  const route = upgrades.get(pathname)
  if (route === undefined) {
    socket.destroy()
    return
  }
  void route.handler(req, socket, head)
})
await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
const address = server.address()
const origin = `http://127.0.0.1:${address.port}`
const sameSite = { origin }

try {
  const refused = await postJson(`${origin}/api/typst-preview/open`, { file: fixture }, { 'sec-fetch-site': 'cross-site' })
  check('cross-site open is refused', refused.status === 403, `status ${refused.status}`)

  const opened = await postJson(`${origin}/api/typst-preview/open`, { file: fixture, cwd: fixtureDir, sessionId: 'smoke' }, sameSite)
  check('open starts an instance', opened.status === 200 && opened.body.ok === true, JSON.stringify(opened.body).slice(0, 200))
  const token = opened.body.token
  const pageUrl = `${origin}${opened.body.url}`
  const wsPath = opened.body.ws

  const page = await fetchText(pageUrl)
  check('page proxied from the instance', page.status === 200 && page.body.length > 100_000, `status ${page.status}, ${page.body.length} bytes`)
  check('page WebSocket URL points at the upgrade route', page.body.includes(wsPath))
  check('page no longer dials the origin root', !page.body.includes('new URL("/", window.location.href)'))

  const frames = await collectWebSocketFrames(`ws://127.0.0.1:${address.port}${wsPath}`, 15_000)
  check('WebSocket relayed and delivering frames', frames.bytes > 0, `${frames.count} frames, sizes ${frames.sizes.slice(0, 4).join(', ')}`)

  const status = await fetchText(`${origin}/api/typst-preview/status`, sameSite)
  const listed = JSON.parse(status.body)
  check('status lists the live instance', Array.isArray(listed.instances) && listed.instances.length === 1, status.body.slice(0, 160))

  const reused = await postJson(`${origin}/api/typst-preview/open`, { file: fixture, cwd: fixtureDir, sessionId: 'smoke' }, sameSite)
  check('a second open reuses the instance', reused.body.token === token, `${String(reused.body.token)} vs ${String(token)}`)

  const stalePage = await fetchText(`${origin}/api/typst-preview/p/deadbeefdeadbeef/`, sameSite)
  check(
    'an unknown page token answers a readable page, not a JSON blob',
    stalePage.status === 404 && stalePage.body.includes('<html') && !stalePage.body.includes('"error"'),
    `status ${stalePage.status}, ${stalePage.body.slice(0, 80)}`,
  )

  /* ---------------------------------------------------------- source route */

  const refusedSource = await postJson(
    `${origin}/api/typst-preview/source`,
    { file: markup, cwd: fixtureDir, offset: 1 },
    { 'sec-fetch-site': 'cross-site' },
  )
  check('cross-site source is refused', refusedSource.status === 403, `status ${refusedSource.status}`)

  const highlighted = await postJson(
    `${origin}/api/typst-preview/source`,
    { file: markup, cwd: fixtureDir, offset: 1 },
    sameSite,
  )
  const sourcePage = highlighted.body
  check('source answers with a highlighted page', highlighted.status === 200 && sourcePage.ok === true, JSON.stringify(sourcePage).slice(0, 200))
  check('source page carries the file text', typeof sourcePage.text === 'string' && sourcePage.text.includes('#set page'), JSON.stringify(sourcePage.text).slice(0, 120))
  check(
    'source page is fully paged',
    // The fixture ends with a newline, so its last line is the empty one.
    sourcePage.lineCount === 7 && sourcePage.lines === 7 && sourcePage.eof === true && Array.isArray(sourcePage.spans) && sourcePage.spans.length === 7,
    `lineCount ${sourcePage.lineCount}, lines ${sourcePage.lines}, eof ${sourcePage.eof}, spans ${sourcePage.spans?.length}`,
  )

  /** The runs of one line as `{ text, className, style, inBounds }`. */
  const runsOf = (body, lineIndex) => {
    const line = body.text.split('\n')[lineIndex] ?? ''
    const flat = body.spans[lineIndex] ?? []
    const out = []
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const [start, end, classIndex, style] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]
      out.push({
        text: line.slice(start, end),
        className: body.classes[classIndex],
        style,
        inBounds: start >= 0 && end <= line.length && end >= start,
      })
    }
    return out
  }

  const first = runsOf(sourcePage, 0)
  check(
    'the `#set` keyword is painted as a keyword',
    first.some((run) => run.text === '#set' && run.className === 'keyword'),
    JSON.stringify(first).slice(0, 200),
  )
  check(
    'every run stays inside its line',
    sourcePage.spans.every((_, index) => runsOf(sourcePage, index).every((run) => run.inBounds)),
    'a run crossed its line',
  )
  const cjkLine = sourcePage.text.split('\n').findIndex((line) => line.includes('#emph'))
  const cjk = runsOf(sourcePage, cjkLine)
  check(
    'strong markup and CJK offsets land on the right characters',
    cjk.some((run) => run.text === '*' && run.style === 1) &&
      cjk.some((run) => run.text === '// \u6ce8\u91ca' && run.className === 'comment'),
    JSON.stringify(cjk).slice(0, 260),
  )

  const windowed = await postJson(
    `${origin}/api/typst-preview/source`,
    { file: markup, cwd: fixtureDir, offset: 2, limit: 2 },
    sameSite,
  )
  check(
    'a page window carries only its own lines',
    windowed.body.lines === 2 && windowed.body.eof === false && windowed.body.nextOffset === 4,
    `lines ${windowed.body.lines}, eof ${windowed.body.eof}, next ${windowed.body.nextOffset}`,
  )

  const missing = await postJson(
    `${origin}/api/typst-preview/source`,
    { file: join(fixtureDir, 'nope.typ'), cwd: fixtureDir, offset: 1 },
    sameSite,
  )
  check(
    'a missing file is refused as a fallback, not an error',
    missing.status === 200 && missing.body.ok === false && typeof missing.body.error === 'string',
    JSON.stringify(missing.body).slice(0, 160),
  )

  const closed = await postJson(`${origin}/api/typst-preview/close`, { token }, sameSite)
  check('close stops the instance', closed.status === 200 && closed.body.stopped === true)
  const afterClose = JSON.parse((await fetchText(`${origin}/api/typst-preview/status`, sameSite)).body)
  check('closed instance is gone', afterClose.instances.length === 0, JSON.stringify(afterClose.instances).slice(0, 160))
} catch (error) {
  failures += 1
  console.log(`  FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const dispose of lifecycle.reverse()) {
    try {
      await dispose?.()
    } catch (error) {
      console.log(`  (dispose threw: ${String(error)})`)
    }
  }
  server.close()
}

/** The manager kills its children on dispose; give SIGTERM a moment to land. */
await new Promise((settle) => setTimeout(settle, 500))

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
