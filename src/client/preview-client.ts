/**
 * Browser half of the preview transport.
 *
 * The host owns one process per file; the browser only says which file it is
 * looking at and lets go when the last tab of that file does. Reference counting
 * lives here rather than in the component because a tab body is mounted,
 * unmounted and remounted around React strict mode and pane switches, and a
 * process per remount would both leak and fight for ports. A release is
 * therefore deferred, and cancels itself if the tab comes back.
 */

/** One open request, as the host route expects it. */
export interface OpenPreviewRequest {
  /** Absolute path when the file's metadata is known, else the address path. */
  readonly file: string
  /** Session workspace directory, the project-root fallback. */
  readonly cwd: string | undefined
  readonly sessionId: string | undefined
  readonly invert: InvertMode
}

/** Color handling, mirrored from the host's flag. */
export type InvertMode = 'never' | 'auto' | 'always'

/** The host's answer to an open request. */
export interface OpenPreviewResult {
  readonly ok: boolean
  readonly token?: string
  readonly url?: string
  readonly ws?: string
  readonly file?: string
  readonly root?: string
  readonly error?: string
}

const OPEN_URL = '/api/typst-preview/open'
const CLOSE_URL = '/api/typst-preview/close'
const STATUS_URL = '/api/typst-preview/status'
/** Long enough to survive a strict-mode remount, short enough to free the port. */
const RELEASE_DELAY_MS = 1500

interface Entry {
  count: number
  timer: ReturnType<typeof setTimeout> | undefined
  readonly promise: Promise<OpenPreviewResult>
}

const entries = new Map<string, Entry>()

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return { ok: false, error: `HTTP ${response.status}` }
}

function failureOf(error: unknown): OpenPreviewResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * Take a reference on one file's preview, starting it on the first reference.
 * @param key - reuse identity: absolute file plus color mode.
 * @param request - what to start when nothing is running.
 * @returns the host's answer, shared by every reference taken on this key.
 */
export function acquirePreview(key: string, request: OpenPreviewRequest): Promise<OpenPreviewResult> {
  const existing = entries.get(key)
  if (existing !== undefined) {
    if (existing.timer !== undefined) {
      clearTimeout(existing.timer)
      existing.timer = undefined
    }
    existing.count += 1
    return existing.promise
  }
  const entry: Entry = {
    count: 1,
    timer: undefined,
    promise: postJson(OPEN_URL, request)
      .then((body): OpenPreviewResult => ({
        ok: body.ok === true,
        token: typeof body.token === 'string' ? body.token : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
        ws: typeof body.ws === 'string' ? body.ws : undefined,
        file: typeof body.file === 'string' ? body.file : undefined,
        root: typeof body.root === 'string' ? body.root : undefined,
        error: typeof body.error === 'string' ? body.error : undefined,
      }))
      .catch(failureOf),
  }
  entries.set(key, entry)
  return entry.promise
}

/**
 * Ask the host for this key's preview again, keeping the reference count.
 *
 * Used before a reload re-points an iframe at a cached URL: the token the tab
 * still holds may belong to an instance the host has already reaped (idle window,
 * LRU eviction, a crash), and a page request for a dead token answers with the
 * "already reaped" page. `open` is idempotent — a running instance is reused and
 * comes back with the same token, a dead one is started again — so this is the
 * cheap way to make a reload always valid.
 *
 * @param key - the identity passed to {@link acquirePreview}.
 * @param request - what to start when nothing is running.
 * @returns the host's current answer for this key.
 */
export function refreshPreview(key: string, request: OpenPreviewRequest): Promise<OpenPreviewResult> {
  const existing = entries.get(key)
  const promise = postJson(OPEN_URL, request)
    .then((body): OpenPreviewResult => ({
      ok: body.ok === true,
      token: typeof body.token === 'string' ? body.token : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
      ws: typeof body.ws === 'string' ? body.ws : undefined,
      file: typeof body.file === 'string' ? body.file : undefined,
      root: typeof body.root === 'string' ? body.root : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
    }))
    .catch(failureOf)
  if (existing !== undefined) {
    if (existing.timer !== undefined) {
      clearTimeout(existing.timer)
      existing.timer = undefined
    }
    entries.set(key, { count: existing.count, timer: undefined, promise })
  }
  return promise
}

/**
 * Drop one reference; the last one stops the preview after a short grace.
 * @param key - the identity passed to {@link acquirePreview}.
 */
export function releasePreview(key: string): void {
  const entry = entries.get(key)
  if (entry === undefined) return
  entry.count -= 1
  if (entry.count > 0 || entry.timer !== undefined) return
  entry.timer = setTimeout(() => {
    const live = entries.get(key)
    if (live === undefined || live.count > 0) return
    entries.delete(key)
    void live.promise
      .then((result) => {
        if (result.ok && result.token !== undefined) return postJson(CLOSE_URL, { token: result.token })
        return undefined
      })
      .catch(() => undefined)
  }, RELEASE_DELAY_MS)
}

/** Stop holding anything: used when the plugin unloads. */
export function releaseAllPreviews(): void {
  for (const [key, entry] of [...entries]) {
    entries.delete(key)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    void entry.promise
      .then((result) => {
        if (result.ok && result.token !== undefined) return postJson(CLOSE_URL, { token: result.token })
        return undefined
      })
      .catch(() => undefined)
  }
}

/**
 * Whether the host still lists this key's preview.
 *
 * The page inside the iframe only ever retries the token it was loaded with, so a
 * preview that disappears while its tab stays open — the instance cap evicting it, a
 * crash, the idle reaper on an instance whose socket had already dropped — leaves
 * that tab retrying a dead token forever with nothing on screen to say so. Asking
 * costs one small same-origin GET.
 *
 * @param key - the identity passed to {@link acquirePreview}.
 * @returns `false` only when the host answered and this key's token was not in it;
 *          `undefined` when there is nothing to ask about, or the answer is unusable,
 *          which must never be read as "gone".
 */
export async function previewAlive(key: string): Promise<boolean | undefined> {
  const entry = entries.get(key)
  if (entry === undefined) return undefined
  const result = await entry.promise.catch(() => undefined)
  if (result === undefined || !result.ok || result.token === undefined) return undefined
  try {
    const response = await fetch(STATUS_URL, { credentials: 'same-origin' })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    const list = (body as { instances?: unknown }).instances
    if (!Array.isArray(list)) return undefined
    return list.some((instance) => (instance as { token?: unknown }).token === result.token)
  } catch {
    return undefined
  }
}
