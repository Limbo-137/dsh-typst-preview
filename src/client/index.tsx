/**
 * Browser half: register `typst-preview` as a native right-Sidebar tab type and
 * draw one tab per `.typ` file.
 *
 * The tab is a two-face surface with its own switch, the way the sidebar's
 * Markdown preview reads: **预览** is a live `tinymist preview` page in an
 * iframe, **源码** is the file's own text. The source face is highlighted from
 * tinymist's semantic tokens through `/api/typst-preview/source` — the shared
 * code renderer has no Typst grammar, so it only ever painted flat text — and
 * falls back to that renderer over the host's paged reader whenever highlighting
 * is unavailable (no tinymist, a file past the size cap, `highlight: false`).
 * The type claims `*.typ` in the `extension` band, so a click on a `.typ` file in
 * the Files tree lands here instead of in the plain-text fallback; the source
 * face is one button away, and the plain-text viewer stays reachable through
 * `openResource(address, { kind: 'text' })` for anything this surface cannot do.
 *
 * Everything wire-side is same-origin: the iframe points at
 * `/api/typst-preview/p/<token>/`, which the host half reverse-proxies to the
 * instance's loopback data plane, WebSocket included.
 */

import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { CodeBlock, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { basenameOf, parseFileAddress } from './address'
import { acquirePreview, previewAlive, refreshPreview, releaseAllPreviews, releasePreview, type InvertMode } from './preview-client'
import { fetchSourcePage, type HighlightedSourcePage } from './source-client'

/* -------------------------------------------------------------------------- *
 * The native right-Sidebar contracts this plugin consumes (mirrors of
 * @deepseek-ai/dsh-client-ui-sidebar-right/client, kept local so the package
 * builds against the installed DSH without importing its internals).
 * -------------------------------------------------------------------------- */

/** Stage one of tab-type registration: what one type IS. */
interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly patterns?: readonly string[]
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  readonly canOpen?: (address: string) => boolean
  readonly title: (address: string) => string
  /**
   * Keep a visited body mounted across tab and Session changes, collapse and
   * docking. Added in DSH 0.1.7; hosts that predate it ignore the field, which
   * is why it is optional here rather than required.
   */
  readonly keepMounted?: boolean
}

/** Stage-one registry, behind `ctx.sidebarRightTabs`. */
interface SidebarRightTabRegistry {
  register(definition: SidebarRightTabDefinition): () => void
}

/** Locale face, behind `ctx.locale`; only the two calls this plugin makes. */
interface LocaleFace {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

/** Slot registry, behind `ctx.slots`. */
interface SlotRegistry {
  register(options: Record<string, unknown>, component: (props: never) => ReactNode): () => void
  inject(name: string, contribute: () => () => void): () => void
}

/** One page of a workspace file, as the `workspaceFiles` Remote returns it. */
interface WorkspaceFilePage {
  readonly text: string
  readonly lines: number
  readonly eof: boolean
}

/** The Remote carrier as this plugin uses it. */
interface RemoteFace {
  readonly workspaceFiles: {
    /** Resolves to the Remote result envelope, not to the page itself. */
    read(sessionId: string, path: string, range: { offset?: number }, signal: AbortSignal): Promise<unknown>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly sidebarRightTabs: SidebarRightTabRegistry
    readonly slots: SlotRegistry
    readonly locale: LocaleFace
    readonly remote: RemoteFace
  }
}

/* -------------------------------------------------------------------------- *
 * Copy
 * -------------------------------------------------------------------------- */

const NS = 'dshTypstPreview'

const zh = {
  'mode.preview': '预览',
  'mode.source': '源码',
  'mode.preview.aria': 'Typst 实时预览',
  'mode.source.aria': 'Typst 源码',
  'tool.reload': '重新载入预览',
  'tool.reread': '重新读取文件',
  'tool.invert': '预览配色',
  'tool.openExternal': '在新标签页打开预览',
  'tool.copyPath': '复制文件路径',
  'tool.copied': '已复制',
  'state.starting': '正在启动 Typst 预览…',
  'state.error': 'Typst 预览启动失败',
  'state.retry': '重试',
  'state.reading': '正在读取…',
  'state.loadMore': '加载更多',
  'state.noAddress': '无法从这个地址确定文件。',
  'state.invert.never': '原始配色',
  'state.invert.auto': '跟随系统',
  'state.invert.always': '反色',
  'error.unknown': '未知错误',
  'code.copy': '复制',
  'code.copied': '已复制',
}

const en: Record<keyof typeof zh, string> = {
  'mode.preview': 'Preview',
  'mode.source': 'Source',
  'mode.preview.aria': 'Live Typst preview',
  'mode.source.aria': 'Typst source',
  'tool.reload': 'Reload the preview',
  'tool.reread': 'Read the file again',
  'tool.invert': 'Preview colors',
  'tool.openExternal': 'Open the preview in a new tab',
  'tool.copyPath': 'Copy the file path',
  'tool.copied': 'Copied',
  'state.starting': 'Starting the Typst preview…',
  'state.error': 'The Typst preview could not start',
  'state.retry': 'Retry',
  'state.reading': 'Reading…',
  'state.loadMore': 'Load more',
  'state.noAddress': 'This address does not name a file.',
  'state.invert.never': 'Original colors',
  'state.invert.auto': 'Follow system',
  'state.invert.always': 'Inverted',
  'error.unknown': 'Unknown error',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
}

/* -------------------------------------------------------------------------- *
 * Styles, injected once under the shell's plugin-CSS convention.
 * -------------------------------------------------------------------------- */

const STYLE_ID = 'dsh-typst-preview/TypstPreview.css'

const CSS = `
.dshTypstPreview_root{display:flex;flex-direction:column;flex:auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.dshTypstPreview_bar{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:4px;height:38px;padding:0 6px 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dshTypstPreview_modes{display:flex;align-items:center;gap:2px;padding:2px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.dshTypstPreview_mode{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:4px 10px;border-radius:4px;cursor:pointer}
.dshTypstPreview_mode[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}
.dshTypstPreview_path{flex:auto;min-width:0;margin:0 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:var(--dsw-font-family,inherit)}
.dshTypstPreview_tool{display:inline-flex;flex:none;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshTypstPreview_tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTypstPreview_tool[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTypstPreview_tool:disabled{opacity:.4;cursor:default}
.dshTypstPreview_stage{position:relative;display:flex;flex:auto;min-height:0;background:#fff}
.dshTypstPreview_frame{display:block;flex:auto;width:100%;min-height:0;border:none;background:#fff}
.dshTypstPreview_overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dshTypstPreview_overlay[data-error="true"]{color:var(--dsw-alias-label-error,#c0392b);white-space:pre-wrap}
.dshTypstPreview_action{border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;padding:3px 10px;border-radius:4px;cursor:pointer}
.dshTypstPreview_source{flex:auto;min-height:0;overflow:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-base)}
.dshTypstPreview_plain{margin:0;padding:8px 10px;white-space:pre;font:inherit}
.dshTypstPreview_more{display:flex;justify-content:center;padding:8px}
/* Highlighted source: one row per line, painted with the theme's own shiki
   token sheet — the same colors the app's code blocks use, in both themes. */
.dshTypstPreview_code{padding:8px 0;background:var(--shiki-background,var(--dsw-alias-markdown-code-block));color:var(--shiki-foreground,var(--dsw-alias-label-primary))}
.dshTypstPreview_row{display:flex;white-space:pre}
.dshTypstPreview_row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshTypstPreview_ln{flex:none;width:3.4em;padding:0 10px 0 12px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}
.dshTypstPreview_line{flex:auto;min-width:0;padding-right:12px}
.dshTypstPreview_t-comment{color:var(--shiki-token-comment)}
.dshTypstPreview_t-string{color:var(--shiki-token-string)}
.dshTypstPreview_t-raw{color:var(--shiki-token-string-expression)}
.dshTypstPreview_t-keyword{color:var(--shiki-token-keyword)}
.dshTypstPreview_t-function{color:var(--shiki-token-function)}
.dshTypstPreview_t-number{color:var(--shiki-token-constant)}
.dshTypstPreview_t-variable{color:var(--shiki-token-parameter)}
.dshTypstPreview_t-punctuation{color:var(--shiki-token-punctuation)}
.dshTypstPreview_t-link{color:var(--shiki-token-link)}
.dshTypstPreview_t-error{color:var(--dsw-alias-label-error,#c0392b)}
.dshTypstPreview_s1{font-weight:600}
.dshTypstPreview_s2{font-style:italic}
.dshTypstPreview_s3{font-weight:600;font-style:italic}
`

function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-typst-preview'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/* -------------------------------------------------------------------------- *
 * Icons
 * -------------------------------------------------------------------------- */

function IconRefresh(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M13.3 2.3v3.3H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconExternal(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.6 2.6h3.8v3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.2 2.8 7.7 8.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M12 9.3v3.1c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6V5.6C2 4.7 2.7 4 3.6 4h3.1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconCopy(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.4 3.2H4.2c-.9 0-1.6.7-1.6 1.6v6.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconInvert(): ReactElement {  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 2.7a5.3 5.3 0 0 1 0 10.6z" fill="currentColor" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- *
 * Registration
 * -------------------------------------------------------------------------- */

/** This implementation's identity in the tab system, and its body's slot key. */
export const TYPST_TAB_ID = 'dsh-typst-preview'

/** The tab kind `openTab` names. */
export const TYPST_TAB_KIND = 'typst-preview'

/** Whether an address names a `.typ` file. */
function isTypstAddress(address: string): boolean {
  const path = address.split(/[?#]/)[0] ?? address
  return /\.typ$/i.test(path)
}

/** The type's static face: it claims `.typ` files and nothing else. */
export function typstTabDefinition(): SidebarRightTabDefinition {
  return {
    id: TYPST_TAB_ID,
    kind: TYPST_TAB_KIND,
    patterns: ['*.typ'],
    // Outside-the-product band: the plain-text fallback must not win a `.typ`.
    priority: 'extension',
    canOpen: isTypstAddress,
    title: (address) => basenameOf(address),
    // 0.1.7 unmounts a body once its tab stops being visible — collapsing the
    // right Sidebar, switching tabs, docking the panel elsewhere. The preview
    // document and the compiler behind it are the whole point of leaving a tab
    // open, so this type asks to be kept. On 0.1.5 the field is ignored.
    keepMounted: true,
  }
}

/* -------------------------------------------------------------------------- *
 * Tab body
 * -------------------------------------------------------------------------- */

/** What the injected business face hands the body. */
export interface TypstPreviewInjected {
  /** One page of a file's text, through the host's paged reader. */
  readonly read: (sessionId: string, path: string, offset: number, signal: AbortSignal) => Promise<WorkspaceFilePage>
}

interface ResourceSnapshot {
  readonly status: string
  readonly value?: { readonly absolutePath?: string; readonly version?: string } | undefined
}

interface SessionsSnapshot {
  readonly byId: Record<string, { readonly cwd?: string } | undefined>
}

interface SidebarTabRecord {
  readonly id: string
  readonly contentId: string
  readonly visible: boolean
  readonly signal: AbortSignal
}

interface TabInfo {
  readonly sidebar: { readonly expanded: boolean; readonly fullscreen: boolean }
  readonly panel: { readonly id: string }
  readonly tab: SidebarTabRecord
}

/** The composed props the slot framework hands a `sidebar.right.pane.tab` body. */
export interface TypstPreviewProps extends TypstPreviewInjected {
  readonly sessionId: string
  readonly useTabInfo: () => TabInfo
  readonly useSessions: <T>(select: (sessions: SessionsSnapshot) => T) => T
  readonly useResource: (address: string) => ResourceSnapshot
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

type Face = 'preview' | 'source'

interface PreviewState {
  readonly status: 'starting' | 'ready' | 'error'
  readonly url?: string
  readonly error?: string
}

/** One loaded page of the file: its text, and its token runs when highlighted. */
interface SourceChunk {
  readonly offset: number
  readonly text: string
  readonly spans?: readonly (readonly number[])[]
}

interface SourceState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly chunks: readonly SourceChunk[]
  /** Token class names, shared by every chunk of the file. */
  readonly classes?: readonly string[]
  /** True once the host answered with a highlighted page. */
  readonly highlighted: boolean
  /** Why highlighting is not in use, for the diagnostic surface. */
  readonly fallback?: string
  /** True while the paged plain-text reader is the one being asked. */
  readonly paged: boolean
  readonly nextOffset: number
  readonly eof: boolean
  readonly error?: string
}

const EMPTY_SOURCE: SourceState = {
  status: 'idle',
  chunks: [],
  highlighted: false,
  paged: false,
  nextOffset: 1,
  eof: false,
}

const INVERT_STORAGE_KEY = 'dsh-typst-preview:invert'
const INVERT_CYCLE: readonly InvertMode[] = ['never', 'auto', 'always']
/** How often a visible preview asks whether its instance is still there. */
const LIVE_CHECK_MS = 5000

function readStoredInvert(): InvertMode {
  try {
    const stored = globalThis.localStorage?.getItem(INVERT_STORAGE_KEY)
    if (stored === 'never' || stored === 'auto' || stored === 'always') return stored
  } catch {
    /* storage unavailable: fall through to the default */
  }
  return 'never'
}

function storeInvert(mode: InvertMode): void {
  try {
    globalThis.localStorage?.setItem(INVERT_STORAGE_KEY, mode)
  } catch {
    /* best effort */
  }
}

/** The tab: one toolbar, two faces, both fed by same-origin host routes. */
export function TypstPreviewTab(props: TypstPreviewProps): ReactElement {
  const { sessionId, useTabInfo, useSessions, useResource, read, t } = props
  const { tab, sidebar } = useTabInfo()
  // A fullscreen pane reports `visible: false` in some layouts; never hide the
  // preview there, because the user is looking straight at it.
  const previewMounted = tab.visible !== false || sidebar.fullscreen
  const meta = useResource(tab.contentId)
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd)
  const address = useMemo(() => parseFileAddress(tab.contentId, sessionId), [tab.contentId, sessionId])

  const [face, setFace] = useState<Face>('preview')
  const [invert, setInvert] = useState<InvertMode>(readStoredInvert)
  const [frameNonce, setFrameNonce] = useState(0)
  const [preview, setPreview] = useState<PreviewState>({ status: 'starting' })
  const [source, setSource] = useState<SourceState>(EMPTY_SOURCE)
  const [copied, setCopied] = useState(false)

  const absolutePath = meta.value?.absolutePath
  const file = absolutePath ?? address?.path
  const key = file === undefined ? undefined : `${file}\u0000${invert}`

  /**
   * Re-ask the host for this file's preview and adopt its answer.
   *
   * Called before anything re-points the iframe at a cached URL — the toolbar's
   * reload, and coming back to a tab whose preview document was unmounted. A
   * preview can be gone by then (idle window with no socket held, the LRU cap
   * evicting this tab's instance, a crash), and the tab's cached token would load
   * the "already reaped" page instead of the document.
   */
  function reopenPreview(): void {
    if (file === undefined || key === undefined) return
    void refreshPreview(key, { file, cwd, sessionId, invert }).then((result) => {
      if (result.ok && result.url !== undefined) setPreview({ status: 'ready', url: result.url })
      else if (result.ok) setPreview({ status: 'starting' })
      else setPreview({ status: 'error', error: result.error ?? translate.current('error.unknown') })
    })
  }

  // The framework's `t` is a fresh binding per render, so it must stay out of
  // effect dependencies; a stable ref keeps the message without the churn.
  const translate = useRef(t)
  translate.current = t

  // Diagnostic surface, read by scripts/gui-check.mjs while verifying a build.
  ;(globalThis as Record<string, unknown>).__dshTypstDebug = {
    contentId: tab.contentId,
    sessionId,
    address,
    file,
    absolutePath,
    metaStatus: meta.status,
    face,
    preview,
    source,
    hasRead: typeof read === 'function',
  }
  // The preview stays acquired while the tab lives, whichever face is showing:
  // switching to the source must not throw away a running tinymist (and the
  // preview keeps recompiling behind the source face, the way an editor's
  // preview pane does).
  useEffect(() => {
    if (file === undefined || key === undefined) return
    let live = true
    setPreview((previous) => (previous.status === 'ready' ? previous : { status: 'starting' }))
    void acquirePreview(key, { file, cwd, sessionId, invert }).then((result) => {
      if (!live) return
      setPreview(
        result.ok && result.url !== undefined
          ? { status: 'ready', url: result.url }
          : { status: 'error', error: result.error ?? translate.current('error.unknown') },
      )
    })
    return () => {
      live = false
      releasePreview(key)
    }
  }, [file, key, cwd, sessionId, invert])

  // A tab that becomes visible again remounts its preview document, so re-open
  // before the browser asks for the token this tab still holds. The first mount
  // is the acquire effect's job, not this one's.
  const latestPreview = useRef(preview)
  latestPreview.current = preview
  const wasMounted = useRef(previewMounted)
  useEffect(() => {
    if (wasMounted.current === previewMounted) return
    wasMounted.current = previewMounted
    if (!previewMounted || latestPreview.current.url === undefined) return
    reopenPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the visibility edge matters
  }, [previewMounted])

  // A preview can vanish while this tab stays open — the instance cap evicting it, a
  // crash, the idle reaper on an instance whose socket had already dropped. The page
  // inside the iframe keeps retrying the token it was loaded with, so nothing comes
  // back on its own; the tab simply sits on a dead socket. Ask, and re-open when the
  // answer is no. Only the visible face polls: a hidden tab holds its reference and
  // re-opens through the effect above.
  useEffect(() => {
    if (!previewMounted || key === undefined || preview.status !== 'ready') return
    const timer = setInterval(() => {
      void previewAlive(key).then((alive) => {
        if (alive !== false) return
        reopenPreview()
        setFrameNonce((nonce) => nonce + 1)
      })
    }, LIVE_CHECK_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reopenPreview reads these same inputs
  }, [key, preview.status, previewMounted])

  // Source face: the highlighted host reader when it can, the paged plain-text
  // reader when it cannot. The first page is fetched when the face appears, and
  // a failing/slow preview never blocks it.
  useEffect(() => {
    if (face !== 'source' || address === undefined || source.status !== 'idle') return
    loadSource(address.sessionId, address.path, 1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSource is stable per render inputs
  }, [face, address?.sessionId, address?.path, source.status])

  /** One highlighted page, or the switch to the paged reader on refusal. */
  function loadHighlighted(owner: string, path: string, offset: number, signal: AbortSignal): void {
    const target = file ?? path
    void fetchSourcePage({ file: target, cwd, offset }, signal)
      .then((result) => {
        if (signal.aborted) return
        if (!result.ok) {
          // Not an error the user has to see: the source face has always had a
          // plain-text reader, and it is what a missing tinymist or an oversized
          // file lands on.
          setSource((previous) => ({ ...previous, fallback: result.error, paged: false }))
          loadPaged(owner, path, offset, signal)
          return
        }
        const page: HighlightedSourcePage = result.page
        setSource((previous) => ({
          status: 'ready',
          chunks:
            offset <= 1
              ? [{ offset: page.offset, text: page.text, spans: page.spans }]
              : [...previous.chunks, { offset: page.offset, text: page.text, spans: page.spans }],
          classes: page.classes,
          highlighted: true,
          fallback: undefined,
          paged: false,
          nextOffset: page.nextOffset,
          eof: page.eof,
        }))
      })
      .catch((error: unknown) => {
        if (signal.aborted) return
        setSource((previous) => ({
          ...previous,
          status: 'error',
          fallback: error instanceof Error ? error.message : String(error),
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }

  /** One page from the host's plain-text reader; the pre-highlighting path. */
  function loadPaged(owner: string, path: string, offset: number, signal: AbortSignal): void {
    setSource((previous) => ({ ...previous, status: 'loading', paged: true, error: undefined }))
    void read(owner, path, offset, signal)
      .then((page) => {
        if (signal.aborted) return
        setSource((previous) => ({
          status: 'ready',
          chunks:
            offset <= 1 ? [{ offset, text: page.text }] : [...previous.chunks, { offset, text: page.text }],
          classes: undefined,
          highlighted: false,
          fallback: previous.fallback,
          paged: true,
          nextOffset: offset + Math.max(page.lines, 0),
          eof: page.eof,
        }))
      })
      .catch((error: unknown) => {
        if (signal.aborted) return
        setSource((previous) => ({
          ...previous,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }

  /** Load one page of the source face, highlighted when the host can do it. */
  function loadSource(owner: string, path: string, offset: number, paged: boolean): void {
    const signal = tab.signal
    if (paged) {
      loadPaged(owner, path, offset, signal)
      return
    }
    setSource((previous) => ({ ...previous, status: 'loading', error: undefined }))
    loadHighlighted(owner, path, offset, signal)
  }

  const invertLabel = t(`state.invert.${invert}`)
  const sourceText = useMemo(() => source.chunks.map((chunk) => chunk.text).join('\n'), [source.chunks])
  const hasText = sourceText !== ''

  function cycleInvert(): void {
    const next = INVERT_CYCLE[(INVERT_CYCLE.indexOf(invert) + 1) % INVERT_CYCLE.length] ?? 'never'
    storeInvert(next)
    setInvert(next)
  }

  const tools: ReactElement[] = []
  if (face === 'preview') {
    tools.push(
      <button
        key="reload"
        type="button"
        className="dshTypstPreview_tool"
        title={t('tool.reload')}
        aria-label={t('tool.reload')}
        data-typst-tool="reload"
        disabled={preview.status !== 'ready'}
        onClick={() => {
          reopenPreview()
          setFrameNonce((value) => value + 1)
        }}
      >
        <IconRefresh />
      </button>,
      <button
        key="invert"
        type="button"
        className="dshTypstPreview_tool"
        title={`${t('tool.invert')}：${invertLabel}`}
        aria-label={`${t('tool.invert')}：${invertLabel}`}
        data-active={invert !== 'never'}
        data-typst-tool="invert"
        onClick={cycleInvert}
      >
        <IconInvert />
      </button>,
      <button
        key="external"
        type="button"
        className="dshTypstPreview_tool"
        title={t('tool.openExternal')}
        aria-label={t('tool.openExternal')}
        data-typst-tool="external"
        disabled={preview.status !== 'ready'}
        onClick={() => {
          if (preview.url !== undefined) globalThis.open(preview.url, '_blank', 'noopener')
        }}
      >
        <IconExternal />
      </button>,
    )
  } else {
    tools.push(
      <button
        key="copy"
        type="button"
        className="dshTypstPreview_tool"
        title={copied ? t('code.copied') : t('code.copy')}
        aria-label={copied ? t('code.copied') : t('code.copy')}
        data-typst-tool="copy"
        disabled={!hasText}
        onClick={() => {
          void copyText(sourceText).then((done) => {
            if (!done) return
            setCopied(true)
            globalThis.setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        <IconCopy />
      </button>,
      <button
        key="reread"
        type="button"
        className="dshTypstPreview_tool"
        title={t('tool.reread')}
        aria-label={t('tool.reread')}
        data-typst-tool="reread"
        onClick={() => setSource(EMPTY_SOURCE)}
      >
        <IconRefresh />
      </button>,
    )
  }

  return (
    <div className="dshTypstPreview_root" data-typst-preview={TYPST_TAB_ID}>
      <div className="dshTypstPreview_bar">
        <div className="dshTypstPreview_modes" role="tablist" aria-label="Typst">
          <button
            type="button"
            role="tab"
            className="dshTypstPreview_mode"
            data-active={face === 'preview'}
            data-typst-face="preview"
            aria-selected={face === 'preview'}
            title={t('mode.preview.aria')}
            onClick={() => setFace('preview')}
          >
            {t('mode.preview')}
          </button>
          <button
            type="button"
            role="tab"
            className="dshTypstPreview_mode"
            data-active={face === 'source'}
            data-typst-face="source"
            aria-selected={face === 'source'}
            title={t('mode.source.aria')}
            onClick={() => setFace('source')}
          >
            {t('mode.source')}
          </button>
        </div>
        <p className="dshTypstPreview_path" title={file ?? tab.contentId}>
          {file ?? tab.contentId}
        </p>
        {tools}
      </div>
      <div
        className="dshTypstPreview_stage"
        data-typst-stage="preview"
        style={face === 'preview' ? undefined : { display: 'none' }}
      >
          {preview.status === 'ready' && preview.url !== undefined ? (
            // One preview document is a whole WebKit document with a compiled
            // renderer and a live socket; keeping one per open tab is how a GUI
            // ends up several gigabytes deep. Only the tab the user is looking at
            // keeps its document mounted — the tinymist process stays alive either
            // way, so coming back is a page load, not a new compiler.
            !previewMounted ? null : (
              <iframe
                key={frameNonce}
                className="dshTypstPreview_frame"
                data-typst-frame={preview.url}
                src={`${preview.url}?r=${String(frameNonce)}`}
                title={file ?? t('mode.preview.aria')}
              />
            )
          ) : preview.status === 'error' ? (
            <div className="dshTypstPreview_overlay" data-error="true" data-typst-stage="error">
              <span>
                {t('state.error')}：{preview.error}
              </span>
              <button
                type="button"
                className="dshTypstPreview_action"
                data-typst-tool="retry"
                onClick={() => setFrameNonce((value) => value + 1)}
              >
                {t('state.retry')}
              </button>
            </div>
          ) : (
            <div className="dshTypstPreview_overlay" data-typst-stage="starting">
              <span>{t('state.starting')}</span>
            </div>
          )}
      </div>
      <div
        className="dshTypstPreview_source"
        data-typst-stage="source"
        style={face === 'source' ? undefined : { display: 'none' }}
      >
          {address === undefined ? (
            <div className="dshTypstPreview_overlay" data-error="true">
              <span>{t('state.noAddress')}</span>
            </div>
          ) : source.status === 'error' ? (
            <div className="dshTypstPreview_overlay" data-error="true">
              <span>{source.error}</span>
              <button
                type="button"
                className="dshTypstPreview_action"
                onClick={() => setSource(EMPTY_SOURCE)}
              >
                {t('state.retry')}
              </button>
            </div>
          ) : source.chunks.length === 0 ? (
            <div className="dshTypstPreview_overlay">
              <span>{t('state.reading')}</span>
            </div>
          ) : (
            <>
              {source.highlighted ? (
                <HighlightedSource chunks={source.chunks} classes={source.classes} />
              ) : (
                <SourceText text={sourceText} copyLabel={t('code.copy')} copiedLabel={t('code.copied')} />
              )}
              {!source.eof && (
                <div className="dshTypstPreview_more">
                  <button
                    type="button"
                    className="dshTypstPreview_action"
                    data-typst-tool="more"
                    disabled={source.status === 'loading'}
                    onClick={() => {
                      if (address !== undefined) {
                        loadSource(address.sessionId, address.path, source.nextOffset, source.paged)
                      }
                    }}
                  >
                    {t('state.loadMore')}
                  </button>
                </div>
              )}
            </>
          )}
      </div>
    </div>
  )
}

/** The source face's text: the shared code renderer, or a plain fallback. */
function SourceText(props: { text: string; copyLabel: string; copiedLabel: string }): ReactElement {
  const { text, copyLabel, copiedLabel } = props
  if (typeof CodeBlock === 'function') {
    return <CodeBlock code={text} lang="typst" lineNumbers copyLabel={copyLabel} copiedLabel={copiedLabel} />
  }
  return <pre className="dshTypstPreview_plain">{text}</pre>
}

/**
 * The highlighted source: one row per line, one span per token run.
 *
 * Runs are `[start, end, classIndex, styleBits, …]`, merged by the host, so the
 * gaps between them are exactly the plain text — pushing those as bare strings is
 * what keeps a page of Typst to a few thousand nodes.
 *
 * Exported for `scripts/render-check.mjs`, which renders a page the host really
 * highlighted and asserts the markup, since the browser half has no other test
 * that does not need a GUI.
 */
export function HighlightedSource(props: {
  chunks: readonly SourceChunk[]
  classes: readonly string[] | undefined
}): ReactElement {
  const { chunks, classes } = props
  const names = classes ?? []
  const rows: ReactElement[] = []
  for (const chunk of chunks) {
    const lines = chunk.text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      rows.push(
        <div className="dshTypstPreview_row" key={`${String(chunk.offset)}:${String(index)}`}>
          <span className="dshTypstPreview_ln">{chunk.offset + index}</span>
          <span className="dshTypstPreview_line">{paint(line, chunk.spans?.[index], names)}</span>
        </div>,
      )
    }
  }
  return (
    <div className="dshTypstPreview_code" data-typst-code="highlighted">
      {rows}
    </div>
  )
}

/** One line's text, cut into painted runs with the plain gaps between them. */
function paint(line: string, runs: readonly number[] | undefined, classes: readonly string[]): ReactNode[] {
  if (runs === undefined || runs.length === 0) return [line]
  const out: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i + 3 < runs.length; i += 4) {
    const start = Math.max(0, Math.min(line.length, runs[i] ?? 0))
    const end = Math.max(start, Math.min(line.length, runs[i + 1] ?? 0))
    const name = classes[runs[i + 2] ?? -1]
    const style = runs[i + 3] ?? 0
    if (start > cursor) out.push(line.slice(cursor, start))
    if (end > start && name !== undefined) {
      out.push(
        <span
          key={`t${String(i)}`}
          className={`dshTypstPreview_t-${name}${style === 0 ? '' : ` dshTypstPreview_s${String(style)}`}`}
        >
          {line.slice(start, end)}
        </span>,
      )
    }
    cursor = Math.max(cursor, end)
  }
  if (cursor < line.length) out.push(line.slice(cursor))
  return out
}

/** Copy text through the shell's clipboard helper, with a plain fallback. */
async function copyText(text: string): Promise<boolean> {
  if (typeof writeClipboard === 'function') {
    try {
      return await writeClipboard(text)
    } catch {
      /* fall through to the platform clipboard */
    }
  }
  try {
    await globalThis.navigator?.clipboard?.writeText(text)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- *
 * Plugin body
 * -------------------------------------------------------------------------- */

/** Required browser services: the two registries, copy, and the Remote carrier. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: install the stylesheet, register the tab type, and
 * contribute the body under the type's own id — the same two-stage path every
 * shipped type walks.
 * @param ctx - client root context carrying the registries, copy, and Remote.
 */
export function apply(ctx: Context): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'typst-preview: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(typstTabDefinition()), 'typst-preview: tab type')
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TYPST_TAB_ID,
            locale: NS,
            inject: () => ({
              // The Remote answers with its result envelope; the body only ever
              // sees a page or a thrown failure, the way the shipped faces do.
              read: async (sessionId: string, path: string, offset: number, signal: AbortSignal) => {
                const result = (await ctx.remote.workspaceFiles.read(sessionId, path, { offset }, signal)) as
                  | { ok: true; value: WorkspaceFilePage }
                  | { ok: false; error?: { code?: string; message?: string } }
                if (!result.ok) {
                  const failure = result.error
                  throw new Error(failure?.message ?? failure?.code ?? 'read failed')
                }
                return result.value
              },
            }),
          },
          TypstPreviewTab as unknown as (props: never) => ReactNode,
        ),
      ),
    'typst-preview: tab body',
  )
  ctx.effect(() => () => releaseAllPreviews(), 'typst-preview: preview references')
}
