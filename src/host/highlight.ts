/**
 * Typst syntax highlighting for the source face, taken from tinymist itself.
 *
 * The app's shared code renderer (`@deepseek-ai/dsh-client-ui-primitives`'
 * `CodeBlock`) drives one shiki core with a fixed grammar table, and Typst is not
 * in it — so `lang="typst"` falls through to flat text. tinymist does publish
 * `textDocument/semanticTokens/full` with a Typst-aware legend (heading, marker,
 * label, ref, math, pol, raw, …), which is both the accurate palette and the
 * engine that has already parsed the file for the preview next to it.
 *
 * One language server is kept per project root — the same root rule the preview
 * fleet uses — and each file it has been asked about is cached by content hash,
 * so paging through a long document costs one token request per edit rather than
 * one per page. Token decoding happens here, not in the browser: what crosses the
 * wire is per-line runs of `[start, end, classIndex, styleBits]` over UTF-16
 * offsets, which is exactly what a `<span>` needs, and with no grammar or legend
 * shipped into the client bundle.
 *
 * Position encoding is asserted rather than assumed: the runs index JavaScript
 * strings, so a server that moved to UTF-8 would mis-slice non-ASCII lines
 * silently and the whole feature would be worse than no colors.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveInput, resolveRoot } from './tinymist'

/**
 * Token classes the browser half knows how to paint. The names are the contract
 * between the halves: the host decodes a tinymist token type onto one of these,
 * the client maps the name to a `--shiki-*` color, and an unknown name renders as
 * plain text rather than as an invisible or miscolored run.
 */
export const TOKEN_CLASSES = [
  'comment',
  'string',
  'raw',
  'keyword',
  'function',
  'number',
  'variable',
  'punctuation',
  'link',
  'error',
] as const

/** One of {@link TOKEN_CLASSES}. */
export type TokenClass = (typeof TOKEN_CLASSES)[number]

/**
 * tinymist token type to class. Typst has no "variable" token type: `pol` is the
 * polymorphic identifier slot the compiler puts names and parameters in, and it
 * is the closest thing to one. Types left out (`text` above all) stay plain.
 */
const TYPE_CLASS: Readonly<Record<string, TokenClass>> = {
  comment: 'comment',
  string: 'string',
  raw: 'raw',
  escape: 'raw',
  keyword: 'keyword',
  heading: 'keyword',
  marker: 'keyword',
  function: 'function',
  decorator: 'function',
  type: 'function',
  namespace: 'function',
  number: 'number',
  bool: 'number',
  pol: 'variable',
  parameter: 'variable',
  term: 'variable',
  punct: 'punctuation',
  operator: 'punctuation',
  delim: 'punctuation',
  link: 'link',
  label: 'link',
  ref: 'link',
  error: 'error',
}

/** Style bit for a run inside `*strong*` markup. */
const STYLE_STRONG = 1
/** Style bit for a run inside `_emphasis_` markup. */
const STYLE_EMPH = 2

/** How many token requests a freshly opened document may fail before it is flat. */
const TOKEN_ATTEMPTS = 8
/** Delay between those attempts; tinymist normally answers on the first. */
const TOKEN_RETRY_MS = 60
/** Cached files per language server; the least recently used one is dropped. */
const MAX_CACHED_FILES = 64

/** Deployment knobs for the highlighter. */
export interface HighlightOptions {
  /** Executable name or absolute path; a bare name is resolved through PATH. */
  readonly tinymistPath: string
  /** Extra arguments passed to `tinymist lsp`. */
  readonly extraArgs: readonly string[]
  /** Language servers kept alive at once, one per project root. */
  readonly maxServers: number
  /** How long one language-server request may take before it is abandoned. */
  readonly requestTimeoutMs: number
  /** How long an unused language server survives before the reaper stops it. */
  readonly idleTimeoutMs: number
  /** Files larger than this are left to the paged plain-text reader. */
  readonly maxFileBytes: number
}

/** Defaults used when the plugin row declares no highlight config. */
export const DEFAULT_HIGHLIGHT_OPTIONS: HighlightOptions = {
  tinymistPath: 'tinymist',
  extraArgs: [],
  maxServers: 2,
  requestTimeoutMs: 5_000,
  idleTimeoutMs: 10 * 60 * 1000,
  maxFileBytes: 4 * 1024 * 1024,
}

/** What the browser half asks for: one page of a file, highlighted. */
export interface SourceRequest {
  /** The `.typ` file: absolute, or relative to `cwd`. */
  readonly file: string
  /** Session workspace directory, the project-root fallback. */
  readonly cwd: string | undefined
  /** First line of the page, 1-based — the paged reader's own convention. */
  readonly offset: number
  /** How many lines the page may carry. */
  readonly limit: number
}

/** One page of highlighted source. */
export interface SourcePage {
  readonly file: string
  readonly root: string
  readonly bytes: number
  /** Lines in the whole file, not in this page. */
  readonly lineCount: number
  /** First line of this page, 1-based. */
  readonly offset: number
  /** Lines in this page. */
  readonly lines: number
  readonly eof: boolean
  /** Offset to pass back for the next page. */
  readonly nextOffset: number
  /** The page's text: exactly the lines the runs describe. */
  readonly text: string
  /** Class names by index, as {@link TOKEN_CLASSES}. */
  readonly classes: readonly string[]
  /** One flat `[start, end, classIndex, styleBits, …]` run list per page line. */
  readonly spans: readonly (readonly number[])[]
}

/** One token legend, as the server declared it. */
interface Legend {
  readonly types: readonly string[]
  readonly modifiers: readonly string[]
}

/** One file's cached decode, so a page turn costs no token request. */
interface FileCache {
  hash: string
  version: number
  runs: number[][]
}

/** One live `tinymist lsp` process and the protocol state around it. */
interface LspServer {
  readonly root: string
  readonly proc: ChildProcess
  readonly legend: Legend
  readonly files: Map<string, FileCache>
  readonly request: (method: string, params: unknown) => Promise<unknown>
  readonly notify: (method: string, params: unknown) => void
  readonly dispose: () => void
  readonly dead: boolean
  lastUsed: number
}

/** A server being started, or the one that answered. */
interface ServerEntry {
  promise: Promise<LspServer>
  server: LspServer | undefined
}

/** Turn one LSP semantic token type into the class it paints as, or `-1`. */
function classIndexOf(type: string | undefined): number {
  if (type === undefined) return -1
  const name = TYPE_CLASS[type]
  return name === undefined ? -1 : TOKEN_CLASSES.indexOf(name)
}

/** Pack the legend's modifier bits into the run's style bits. */
function styleBitsOf(modifierBits: number, modifiers: readonly string[]): number {
  let bits = 0
  for (let i = 0; i < modifiers.length; i += 1) {
    if (((modifierBits >> i) & 1) === 0) continue
    if (modifiers[i] === 'strong') bits |= STYLE_STRONG
    else if (modifiers[i] === 'emph') bits |= STYLE_EMPH
  }
  return bits
}

/**
 * Decode LSP relative-encoded semantic tokens into per-line run lists.
 *
 * Tokens carry a delta line and delta character, may be longer than their line (a
 * raw block, a multi-line comment), and leave plain text uncovered — so a run
 * that crosses a newline is split at the break, and the gaps are simply not
 * covered. Neighbouring runs with the same class and style are merged, which is
 * what keeps a thousands-of-tokens document to a few thousand spans.
 *
 * @param lines - the file's lines, already split on `\n`.
 * @param data - the five-number tuples of a `semanticTokens/full` answer.
 * @param legend - the server's token type and modifier names, in legend order.
 * @returns one flat run list per line, index-aligned with `lines`.
 */
export function decodeTokens(lines: readonly string[], data: readonly number[], legend: Legend): number[][] {
  const runs: number[][] = lines.map(() => [])
  let line = 0
  let character = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0
    const deltaStart = data[i + 1] ?? 0
    const length = data[i + 2] ?? 0
    const classIndex = classIndexOf(legend.types[data[i + 3] ?? -1])
    const style = styleBitsOf(data[i + 4] ?? 0, legend.modifiers)
    line += deltaLine
    character = deltaLine === 0 ? character + deltaStart : deltaStart
    if (classIndex < 0 || length <= 0) continue
    let remaining = length
    let at = line
    let offset = character
    while (remaining > 0 && at < runs.length) {
      const width = (lines[at] ?? '').length
      const take = Math.min(remaining, Math.max(0, width - offset))
      if (take > 0) (runs[at] as number[]).push(offset, offset + take, classIndex, style)
      remaining -= take
      at += 1
      offset = 0
    }
  }
  return runs.map(mergeRuns)
}

/** Fuse neighbouring runs that paint identically, so the DOM stays small. */
function mergeRuns(flat: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const start = flat[i] ?? 0
    const end = flat[i + 1] ?? 0
    const classIndex = flat[i + 2] ?? 0
    const style = flat[i + 3] ?? 0
    const previous = out.length - 4
    if (previous >= 0 && out[previous + 1] === start && out[previous + 2] === classIndex && out[previous + 3] === style) {
      out[previous + 1] = end
      continue
    }
    out.push(start, end, classIndex, style)
  }
  return out
}

/** Hash a file's text for change detection; cheaper than comparing whole files. */
function hashOf(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** One LSP message header block ends here. */
const HEADER_END = '\r\n\r\n'

/**
 * Start a language server for one project root and finish its handshake.
 *
 * Resolves only once `initialize` has been answered and `initialized` sent, so
 * later requests never race the handshake — and refuses up front when the server
 * offers no semantic tokens or a position encoding the decoder cannot use.
 *
 * @param binary - the tinymist executable.
 * @param extraArgs - extra arguments, placed before the `lsp` subcommand.
 * @param root - the project root the server is scoped to.
 * @param timeoutMs - per-request ceiling.
 */
async function startServer(
  binary: string,
  extraArgs: readonly string[],
  root: string,
  timeoutMs: number,
): Promise<LspServer> {
  const proc = spawn(binary, ['lsp', ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'], cwd: root })
  // Drain stderr: tinymist logs its whole startup there, and an unread pipe
  // eventually blocks the child mid-request.
  proc.stderr?.on('data', () => {})

  let buffer = Buffer.alloc(0)
  let sequence = 0
  let dead = false
  let legend: Legend = { types: [], modifiers: [] }
  const files = new Map<string, FileCache>()
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const end = buffer.indexOf(HEADER_END)
      if (end < 0) return
      const header = buffer.subarray(0, end).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (match === null) {
        buffer = buffer.subarray(end + HEADER_END.length)
        continue
      }
      const length = Number(match[1])
      if (buffer.length < end + HEADER_END.length + length) return
      const body = buffer.subarray(end + HEADER_END.length, end + HEADER_END.length + length).toString('utf8')
      buffer = buffer.subarray(end + HEADER_END.length + length)
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(body) as typeof message
      } catch {
        continue
      }
      if (message.id === undefined) continue
      const entry = pending.get(message.id)
      if (entry === undefined) continue
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) entry.reject(new Error(message.error.message ?? 'language server error'))
      else entry.resolve(message.result)
    }
  })
  proc.once('exit', () => {
    dead = true
    failAll(new Error('language server exited'))
  })
  proc.once('error', (error: Error) => {
    dead = true
    failAll(error)
  })

  /** Write one framed message, or refuse when the server is gone. */
  const write = (payload: unknown): void => {
    if (dead) throw new Error('language server is not running')
    const body = JSON.stringify(payload)
    proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = (sequence += 1)
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  const notify = (method: string, params: unknown): void => {
    write({ jsonrpc: '2.0', method, params })
  }
  const dispose = (): void => {
    dead = true
    failAll(new Error('language server stopped'))
    proc.kill('SIGTERM')
    const kill = setTimeout(() => proc.kill('SIGKILL'), 2_000)
    kill.unref?.()
  }

  const initialized = (await request('initialize', {
    processId: process.pid,
    clientInfo: { name: 'dsh-typst-preview' },
    rootUri: pathToFileURL(root).href,
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: basename(root) }],
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false },
        semanticTokens: {
          dynamicRegistration: false,
          // Empty arrays mean "every type and modifier you have"; the legend
          // comes back in the result, which is why the client needs no copy.
          tokenTypes: [],
          tokenModifiers: [],
          formats: ['relative'],
          requests: { range: false, full: true },
          multilineTokenSupport: true,
          overlappingTokenSupport: false,
        },
      },
      workspace: { workspaceFolders: true },
    },
    initializationOptions: {},
  })) as {
    capabilities?: {
      positionEncoding?: string
      semanticTokensProvider?: { legend?: { tokenTypes?: unknown; tokenModifiers?: unknown } }
    }
  }

  const capabilities = initialized.capabilities ?? {}
  const declared = capabilities.semanticTokensProvider?.legend
  if (declared === undefined || !Array.isArray(declared.tokenTypes)) {
    dispose()
    throw new Error('tinymist does not offer semantic tokens')
  }
  if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== 'utf-16') {
    // The runs index JS strings (UTF-16); any other encoding would slice
    // non-ASCII lines at the wrong offsets, so highlighting is refused instead.
    dispose()
    throw new Error(`unsupported position encoding: ${capabilities.positionEncoding}`)
  }
  legend = {
    types: declared.tokenTypes as string[],
    modifiers: Array.isArray(declared.tokenModifiers) ? (declared.tokenModifiers as string[]) : [],
  }
  notify('initialized', {})
  // The state that the process listeners write (`dead`) and the handshake fills
  // in (`legend`) is read through getters, so the object always shows the live
  // value instead of a snapshot taken at construction time.
  return {
    root,
    proc,
    files,
    request,
    notify,
    dispose,
    lastUsed: Date.now(),
    get legend() {
      return legend
    },
    get dead() {
      return dead
    },
  }
}

/**
 * Request a file's runs from one server, reusing the cached decode when the text
 * has not changed and re-sending the document when it has.
 */
async function runsFromServer(server: LspServer, file: string, text: string, hash: string): Promise<number[][]> {
  server.lastUsed = Date.now()
  const cached = server.files.get(file)
  if (cached !== undefined && cached.hash === hash) return cached.runs
  const uri = pathToFileURL(file).href
  if (cached === undefined) {
    server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typst', version: 1, text } })
  } else {
    server.notify('textDocument/didChange', {
      textDocument: { uri, version: cached.version + 1 },
      contentChanges: [{ text }],
    })
  }
  const lines = text.split('\n')
  let runs: number[][] = lines.map(() => [])
  // A freshly opened document answers with an empty set until the compiler has
  // seen it, which is a state that lasts milliseconds — so retry rather than
  // paint a file flat on the first page view after an edit.
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
    const result = (await server.request('textDocument/semanticTokens/full', {
      textDocument: { uri },
    })) as { data?: number[] } | null
    const data = Array.isArray(result?.data) ? result.data : []
    runs = decodeTokens(lines, data, server.legend)
    if (data.length > 0 || text.trim() === '') break
    await new Promise((resolve) => setTimeout(resolve, TOKEN_RETRY_MS))
  }
  if (server.files.size >= MAX_CACHED_FILES) {
    const oldest = server.files.keys().next()
    if (!oldest.done) server.files.delete(oldest.value)
  }
  server.files.delete(file)
  server.files.set(file, { hash, version: (cached?.version ?? 0) + 2, runs })
  return runs
}

/** The highlighter: a small pool of language servers, one per project root. */
export class TypstHighlighter {
  private readonly entries = new Map<string, ServerEntry>()
  private readonly options: HighlightOptions
  private reaper: NodeJS.Timeout | undefined

  /**
   * @param options - deployment knobs; omitted fields fall back to the defaults.
   */
  constructor(options: Partial<HighlightOptions> = {}) {
    this.options = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...options }
  }

  /** Start the idle reaper; the returned function stops it. */
  startReaper(): () => void {
    if (this.reaper !== undefined) clearInterval(this.reaper)
    this.reaper = setInterval(() => {
      const deadline = Date.now() - this.options.idleTimeoutMs
      for (const [root, entry] of [...this.entries]) {
        const server = entry.server
        if (server !== undefined && server.lastUsed < deadline) void this.stop(root)
        else if (server === undefined) {
          void entry.promise.catch(() => this.entries.delete(root))
        }
      }
    }, 60_000)
    this.reaper.unref?.()
    return () => {
      if (this.reaper !== undefined) clearInterval(this.reaper)
      this.reaper = undefined
    }
  }

  /** What is running, for the status route. */
  list(): { root: string; files: number; lastUsed: number }[] {
    const rows: { root: string; files: number; lastUsed: number }[] = []
    for (const entry of this.entries.values()) {
      if (entry.server !== undefined) {
        rows.push({ root: entry.server.root, files: entry.server.files.size, lastUsed: entry.server.lastUsed })
      }
    }
    return rows
  }

  /**
   * One page of a file, highlighted: the text of the lines plus the runs that
   * paint them.
   * @param request - the file, the root fallback, and the page window.
   */
  async page(request: SourceRequest): Promise<SourcePage> {
    const file = resolveInput(request.file, request.cwd)
    const root = resolveRoot(file, request.cwd)
    const info = statSync(file)
    if (info.size > this.options.maxFileBytes) {
      throw new Error(`file is too large to highlight (${info.size} bytes)`)
    }
    const text = readFileSync(file, 'utf8')
    const runs = await runsFromServer(await this.server(root), file, text, hashOf(text))
    const lines = text.split('\n')
    const start = Math.max(0, Math.floor(Number.isFinite(request.offset) ? request.offset : 1) - 1)
    const limit = Math.max(1, Math.floor(Number.isFinite(request.limit) ? request.limit : 1))
    const end = Math.min(lines.length, start + limit)
    return {
      file,
      root,
      bytes: info.size,
      lineCount: lines.length,
      offset: start + 1,
      lines: end - start,
      eof: end >= lines.length,
      nextOffset: end + 1,
      text: lines.slice(start, end).join('\n'),
      classes: TOKEN_CLASSES,
      spans: runs.slice(start, end),
    }
  }

  /** Stop every language server; used on plugin disposal. */
  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((root) => this.stop(root)))
  }

  private async stop(root: string): Promise<void> {
    const entry = this.entries.get(root)
    if (entry === undefined) return
    this.entries.delete(root)
    try {
      ;(await entry.promise).dispose()
    } catch {
      /* the server never started, or died before it was stopped */
    }
  }

  private server(root: string): Promise<LspServer> {
    const existing = this.entries.get(root)
    if (existing !== undefined) return existing.promise
    void this.reapBeyondLimit(root)
    const entry: ServerEntry = { promise: undefined as unknown as Promise<LspServer>, server: undefined }
    entry.promise = startServer(this.options.tinymistPath, this.options.extraArgs, root, this.options.requestTimeoutMs)
      .then((server) => {
        entry.server = server
        return server
      })
      .catch((error: unknown) => {
        this.entries.delete(root)
        throw error instanceof Error ? error : new Error(String(error))
      })
    this.entries.set(root, entry)
    return entry.promise
  }

  private async reapBeyondLimit(incoming: string): Promise<void> {
    const candidates = [...this.entries.keys()].filter((root) => root !== incoming)
    while (candidates.length + 1 > Math.max(1, this.options.maxServers)) {
      let oldestRoot: string | undefined
      let oldest = Number.POSITIVE_INFINITY
      for (const root of candidates) {
        const stamp = this.entries.get(root)?.server?.lastUsed ?? 0
        if (stamp < oldest) {
          oldest = stamp
          oldestRoot = root
        }
      }
      if (oldestRoot === undefined) return
      candidates.splice(candidates.indexOf(oldestRoot), 1)
      await this.stop(oldestRoot)
    }
  }
}
