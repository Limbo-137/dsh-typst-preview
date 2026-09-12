/**
 * Browser half: register `typst-preview` as a native right-Sidebar tab type and
 * draw one tab per `.typ` file.
 *
 * The tab is a two-face surface with its own switch, the way the sidebar's
 * Markdown preview reads: **预览** is a live `tinymist preview` page in an
 * iframe, **源码** is the file's own text with the shared code renderer. The
 * type claims `*.typ` in the `extension` band, so a click on a `.typ` file in
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
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { basenameOf, parseFileAddress } from './address'
import { acquirePreview, releaseAllPreviews, releasePreview, type InvertMode } from './preview-client'

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

function IconInvert(): ReactElement {
  return (
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

interface SourceState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly pages: readonly string[]
  readonly nextOffset: number
  readonly eof: boolean
  readonly error?: string
}

const EMPTY_SOURCE: SourceState = { status: 'idle', pages: [], nextOffset: 1, eof: false }

const INVERT_STORAGE_KEY = 'dsh-typst-preview:invert'
const INVERT_CYCLE: readonly InvertMode[] = ['never', 'auto', 'always']

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
  const { tab } = useTabInfo()
  const meta = useResource(tab.contentId)
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd)
  const address = useMemo(() => parseFileAddress(tab.contentId, sessionId), [tab.contentId, sessionId])

  const [face, setFace] = useState<Face>('preview')
  const [invert, setInvert] = useState<InvertMode>(readStoredInvert)
  const [frameNonce, setFrameNonce] = useState(0)
  const [preview, setPreview] = useState<PreviewState>({ status: 'starting' })
  const [source, setSource] = useState<SourceState>(EMPTY_SOURCE)

  const absolutePath = meta.value?.absolutePath
  const file = absolutePath ?? address?.path
  const key = file === undefined ? undefined : `${file}\u0000${invert}`

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

  // Source face: the file's text, paged through the host's own reader.
  useEffect(() => {
    if (face !== 'source' || address === undefined || source.status !== 'idle') return
    loadSource(address.sessionId, address.path, 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSource is stable per render inputs
  }, [face, address?.sessionId, address?.path, source.status])

  function loadSource(owner: string, path: string, offset: number): void {
    const signal = tab.signal
    setSource((previous) => ({ ...previous, status: 'loading', error: undefined }))
    void read(owner, path, offset, signal)
      .then((page) => {
        if (signal.aborted) return
        setSource((previous) => ({
          status: 'ready',
          pages: offset <= 1 ? [page.text] : [...previous.pages, page.text],
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

  const invertLabel = t(`state.invert.${invert}`)

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
        onClick={() => setFrameNonce((value) => value + 1)}
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
            <iframe
              key={frameNonce}
              className="dshTypstPreview_frame"
              data-typst-frame={preview.url}
              src={`${preview.url}?r=${String(frameNonce)}`}
              title={file ?? t('mode.preview.aria')}
            />
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
          ) : source.pages.length === 0 ? (
            <div className="dshTypstPreview_overlay">
              <span>{t('state.reading')}</span>
            </div>
          ) : (
            <>
              <SourceText text={source.pages.join('\n')} copyLabel={t('code.copy')} copiedLabel={t('code.copied')} />
              {!source.eof && (
                <div className="dshTypstPreview_more">
                  <button
                    type="button"
                    className="dshTypstPreview_action"
                    data-typst-tool="more"
                    disabled={source.status === 'loading'}
                    onClick={() => {
                      if (address !== undefined) loadSource(address.sessionId, address.path, source.nextOffset)
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
