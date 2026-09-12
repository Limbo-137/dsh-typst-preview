/**
 * Browser half of the highlighted-source transport.
 *
 * The host reads the file, asks tinymist's language server for its semantic
 * tokens, and answers with one page of text plus the runs that paint it. This
 * module only carries that answer across the app origin and gives the tab body
 * a typed face for it: a page when highlighting worked, and a reason when it did
 * not — an absent tinymist, a file past the size cap, highlighting switched off —
 * which is the signal to fall back to the host's paged plain-text reader.
 */

/** One highlighted page, as the host route answers it. */
export interface HighlightedSourcePage {
  /** Absolute path the host resolved, which may be more precise than the address. */
  readonly file: string
  /** First line of this page, 1-based. */
  readonly offset: number
  /** Lines on this page. */
  readonly lines: number
  readonly eof: boolean
  /** Offset to send for the next page. */
  readonly nextOffset: number
  /** The page's text, exactly the lines the runs describe. */
  readonly text: string
  /** Token class names, indexed by a run's third number. */
  readonly classes: readonly string[]
  /** One flat `[start, end, classIndex, styleBits, …]` list per line. */
  readonly spans: readonly (readonly number[])[]
}

/** The host's answer: a page, or the reason there is no highlighted page. */
export type SourcePageResult =
  | { readonly ok: true; readonly page: HighlightedSourcePage }
  | { readonly ok: false; readonly error: string }

/** What one page request carries. */
export interface SourcePageRequest {
  /** Absolute path when the resource metadata is known, else the address path. */
  readonly file: string
  /** Session workspace directory, which relative paths resolve against. */
  readonly cwd: string | undefined
  /** First line of the page, 1-based. */
  readonly offset: number
}

const SOURCE_URL = '/api/typst-preview/source'
/** Lines per page: a screenful of context without shipping a whole book. */
export const SOURCE_PAGE_LINES = 800

/** Read one numeric field off an untyped response body. */
function numberAt(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read one string field off an untyped response body. */
function stringAt(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Ask the host for one highlighted page.
 * @param request - the file and the page window.
 * @param signal - the tab's lifetime; an aborted fetch rejects.
 * @returns the page, or `ok: false` with the host's reason.
 */
export async function fetchSourcePage(request: SourcePageRequest, signal?: AbortSignal): Promise<SourcePageResult> {
  let body: Record<string, unknown>
  try {
    const response = await fetch(SOURCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: request.file, cwd: request.cwd, offset: request.offset, limit: SOURCE_PAGE_LINES }),
      credentials: 'same-origin',
      signal,
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `HTTP ${response.status}` }
    }
    body = parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (body.ok !== true) return { ok: false, error: stringAt(body, 'error') ?? 'highlighting is unavailable' }
  const classes = Array.isArray(body.classes) ? (body.classes.filter((name) => typeof name === 'string') as string[]) : []
  const spans = Array.isArray(body.spans) ? (body.spans as number[][]) : []
  const offset = numberAt(body, 'offset', request.offset)
  return {
    ok: true,
    page: {
      file: stringAt(body, 'file') ?? request.file,
      offset,
      lines: numberAt(body, 'lines', 0),
      eof: body.eof === true,
      nextOffset: numberAt(body, 'nextOffset', offset + 1),
      text: typeof body.text === 'string' ? body.text : '',
      classes,
      spans,
    },
  }
}
