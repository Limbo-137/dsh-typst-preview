/**
 * Headless end-to-end check of the browser half against a running DSH web app.
 *
 * Drives a real Chrome over CDP: boots the GUI, waits for the plugin boot to
 * settle, records console errors, then walks the UI — open the first session,
 * expand the right Sidebar, open the Files tab, click the probe `.typ` — and
 * asserts that the Typst tab mounted, pointed its iframe at the plugin's proxy
 * path, and that the host answers that path with the real preview page.
 *
 * Usage: node scripts/gui-check.mjs "http://127.0.0.1:3099/?token=…"
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2]
const PROBE = process.argv[3] ?? 'probe-typst.typ'
// The probe is a file in the workspace the running DSH instance has open, so it
// is resolved against this script's working directory rather than a fixed path.
const WORKSPACE = process.env.PROBE_CWD ?? process.cwd()
const PROBE_PATH = path.resolve(WORKSPACE, PROBE)
if (BASE === undefined) {
  console.error('usage: node scripts/gui-check.mjs <gui-url-with-token> [probe-file.typ]')
  process.exit(2)
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const USER_DATA = '/tmp/cdp-typst-check'

let failures = 0
const log = (line) => console.log(line)
function check(label, ok, detail = '') {
  if (ok) log(`  PASS  ${label}`)
  else {
    failures += 1
    log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/* ------------------------------------------------------------- Chrome + CDP */

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
chrome.stderr.on('data', () => {})

async function targets() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      const page = list.find((entry) => entry.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

const target = await targets()
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
const consoleErrors = []

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const settle = pending.get(message.id)
    pending.delete(message.id)
    settle?.(message)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text))
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
  }
})
await new Promise((settle, fail) => {
  socket.addEventListener('open', settle)
  socket.addEventListener('error', fail)
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((settle) => {
    pending.set(id, settle)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.result?.exceptionDetails !== undefined) {
    throw new Error(String(reply.result.exceptionDetails.exception?.description ?? 'evaluate failed'))
  }
  return reply.result?.result?.value
}

async function waitFor(expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression).catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(300)
  }
}

/**
 * Click through real mouse events at the element's centre: the app's rows are
 * divs, and a synthetic `.click()` on them is not always enough.
 * @param expression - expression resolving to the element, or `null`.
 * @returns whether an element was found and clicked.
 */
async function clickAt(expression) {
  const box = await evaluate(`
    (() => {
      const element = ${expression}
      if (element === undefined || element === null) return null
      element.scrollIntoView({ block: 'center' })
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()
  `)
  if (box === null || box === undefined) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return true
}

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')
  await send('Page.navigate', { url: BASE })
  await waitFor('document.readyState === "complete"', 30_000, 'page load')
  await waitFor('document.body.innerText.trim().length > 0 || document.querySelector("canvas") !== null', 30_000, 'app boot')

  const booted = await waitFor(
    'document.querySelectorAll("button, [role=button], li, a").length > 3',
    30_000,
    'boot UI',
  )
  check('GUI booted', Boolean(booted))

  const pluginRequest = await evaluate(`
    performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('typst-preview'))
      .slice(0, 3)
  `)
  check('client bundle was requested by the app', Array.isArray(pluginRequest) && pluginRequest.length > 0, JSON.stringify(pluginRequest))

  // Open a session with content: an existing row when the tree offers one,
  // otherwise the workspace's blank session. A blank session shows the
  // new-session surface, which has no conversation header to expand from.
  const openedExisting = await clickAt(`
    [...document.querySelectorAll('[role="treeitem"]')].find((el) =>
      (el.className || '').includes('sessionRow') && !(el.textContent || '').includes('新会话')) ?? null
  `)
  if (!openedExisting) {
    check('session opened from the sidebar', await clickAt(`document.querySelector('button[aria-label="新建会话"]')`))
  } else {
    check('existing session opened from the sidebar', true)
  }
  await sleep(2500)

  const expandPresent = await waitFor(
    'document.querySelector("[data-sidebar-right-expand]") !== null',
    20_000,
    'right Sidebar expand control',
  ).catch(() => false)
  if (expandPresent) {
    await clickAt(`document.querySelector('[data-sidebar-right-expand]')`)
  } else {
    // The panel may already be open; either way the Files body is the proof.
    await clickAt(`document.querySelector('[data-dockkit-add-tab]')`)
  }
  check('right Sidebar is open', (await waitFor('document.querySelector("[data-files-state]") !== null', 20_000, 'Files tab body').catch(() => false)) !== false)

  // The probe file sits at the workspace root; click its leaf by text.
  const probeRow = `[...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '${PROBE}') ?? null`
  const probeReady = await waitFor(
    `(() => { const el = ${probeRow}; if (el === null) return null; el.scrollIntoView({ block: 'center' }); return true })()`,
    20_000,
    'probe file row',
  ).catch(() => false)
  const clicked = probeReady ? await clickAt(probeRow) : false
  check(
    'probe .typ row present and clicked',
    clicked === true,
    `tree root ${String(await evaluate(`document.querySelector('[data-files-root]')?.getAttribute('data-files-root') ?? 'none'`))}`,
  )

  if (process.env.DUMP_PANEL === '1') {
    await sleep(3000)
    await clickAt(`document.querySelector('[data-typst-face="source"]')`)
    await sleep(8000)
    const panel = String(await evaluate(`document.querySelector('[data-sidebar-right-panel]')?.innerText ?? ''`))
    log(`  panel text: ${panel.slice(0, 400).replace(/\n/g, ' | ')}`)
    log(`  debug: ${JSON.stringify(await evaluate('globalThis.__dshTypstDebug ?? null'))}`)
    socket.close()
    chrome.kill('SIGTERM')
    process.exit(0)
  }

  const tab = await waitFor(
    '(() => { const el = document.querySelector("[data-typst-preview]"); return el === null ? null : { id: el.getAttribute("data-typst-preview"), frame: document.querySelector("[data-typst-frame]")?.getAttribute("data-typst-frame") ?? null } })()',
    25_000,
    'typst tab body',
  )
  check('Typst tab mounted with the plugin id', tab?.id === 'dsh-typst-preview', JSON.stringify(tab))

  // Spawning tinymist and waiting for its first page takes a moment.
  const frame = await waitFor(
    'document.querySelector("[data-typst-frame]")?.getAttribute("data-typst-frame") ?? null',
    45_000,
    'preview iframe',
  ).catch(() => null)
  check('iframe points at the plugin proxy path', typeof frame === 'string' && frame.startsWith('/api/typst-preview/p/'), String(frame))
  if (typeof frame !== 'string') {
    const diagnosis = await evaluate(`
      (async () => {
        const body = document.querySelector('[data-typst-preview]')?.innerText ?? ''
        const debug = globalThis.__dshTypstDebug ?? null
        const probe = await fetch('/api/typst-preview/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: ${JSON.stringify(PROBE_PATH)}, cwd: ${JSON.stringify(WORKSPACE)}, sessionId: 'diagnostic' }),
        }).then(async (response) => ({ status: response.status, body: (await response.text()).slice(0, 300) })).catch((error) => ({ error: String(error) }))
        return { body: body.slice(0, 300), debug, probe }
      })()
    `)
    log(`  (diagnosis: ${JSON.stringify(diagnosis)})`)
  }

  const served = await evaluate(`
    (async () => {
      const el = document.querySelector('[data-typst-frame]')
      if (el === null) return null
      const response = await fetch(el.getAttribute('data-typst-frame'))
      const text = await response.text()
      return { status: response.status, bytes: text.length, patched: text.includes('/api/typst-preview/ws/') }
    })()
  `)
  check('host serves the preview page on that path', served?.status === 200 && served?.bytes > 100_000, JSON.stringify(served))
  check('served page carries the rewritten WebSocket path', served?.patched === true, JSON.stringify(served))

  const status = await evaluate(`fetch('/api/typst-preview/status').then((response) => response.json())`)
  const live = Array.isArray(status?.instances) ? status.instances : []
  check(
    'host reports a live preview for the probe file',
    live.some((entry) => String(entry.file).endsWith('probe-typst.typ')),
    JSON.stringify(live).slice(0, 200),
  )

  // The source face reads the file through the same Remote the file tree uses.
  const sourceActive = 'document.querySelector(\'[data-typst-face="source"]\')?.getAttribute("data-active") === "true"'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await evaluate(sourceActive)) break
    await clickAt(`document.querySelector('[data-typst-face="source"]')`)
    await sleep(1000)
  }
  check('source face selected', (await evaluate(sourceActive)) === true)
  const sourceText = await waitFor(
    `(() => { const el = document.querySelector('[data-typst-stage="source"]'); if (el === null) return null; const text = el.innerText.trim(); return text.length > 0 && !text.includes('正在读取') && !text.includes('Reading') ? text.slice(0, 60) : null })()`,
    30_000,
    'source face text',
  ).catch(() => null)
  if (sourceText === null) {
    log(`  (source state: ${JSON.stringify(await evaluate('globalThis.__dshTypstDebug?.source ?? null'))})`)
  }
  check('source face renders the .typ text', typeof sourceText === 'string' && sourceText.toLowerCase().includes('probe'), String(sourceText))

  await clickAt(`document.querySelector('[data-typst-face="preview"]')`)
  const backToPreview = await waitFor(
    'document.querySelector("[data-typst-frame]") !== null',
    20_000,
    'preview face again',
  ).catch(() => false)
  check('switching back to the preview face keeps the iframe', backToPreview === true)

  const pluginErrors = consoleErrors.filter((line) => line.toLowerCase().includes('typst'))
  check('no typst-related console errors', pluginErrors.length === 0, pluginErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length > 0) {
    log(`  (console errors seen: ${consoleErrors.length})`)
    for (const line of consoleErrors.slice(0, 5)) log(`    · ${line.slice(0, 200)}`)
  }
} catch (error) {
  failures += 1
  log(`  FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    socket.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGTERM')
}

log(failures === 0 ? '\nGUI CHECK OK' : `\nGUI CHECK FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
