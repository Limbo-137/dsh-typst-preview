# dsh-typst-preview

Live **Typst** preview in the DeepSeek Harness Web UI's native right Sidebar — the same
shape as the built-in Markdown preview: one tab per file, one toolbar switch between the
rendered page and the source.

中文说明见 [README.zh.md](README.zh.md).

## What you get

Open the right Sidebar → **Files** → click a `.typ` file, and it opens as a Sidebar tab with
two faces:

- **Preview** — the page `tinymist preview` renders, driven over a WebSocket, so it follows
  the file on disk while you (or the agent) write it. The toolbar has reload, a colour mode
  cycle (original / follow system / inverted, remembered in `localStorage`) and open-in-new-tab.
- **Source** — the file's own text, **syntax-highlighted from `tinymist`'s own semantic
  tokens** (headings, keywords, functions, strings, math, labels, comments, `*strong*` and
  `_emphasis_` markup), with line numbers, copy and a **Load more** button for large files.
  The colours are the app's own code-block palette, so a `.typ` block looks the same here as
  in a Markdown code fence. If highlighting is unavailable — no `tinymist`, a file past the
  size cap, or `highlight: false` — the face falls back to the shared code renderer over the
  host's paged reader, exactly as it worked before.

Both faces stay mounted, so switching to Source and back does not tear down the preview
server — it keeps compiling in the background. The preview *document* is mounted only for
the tab you are looking at: one live preview page is a whole WebKit document with a
compiled renderer and a socket, and keeping one per open tab is how a browser tab reaches
multiple gigabytes. Returning to a tab reloads its page (~1 s); the `tinymist` process
behind it was never torn down, so nothing is recompiled from scratch.

`.typ` is claimed through the Sidebar's tab-type registry at `priority: 'extension'`, which
outranks the built-in plain-text fallback viewer. To send `.typ` back to the native text
viewer instead, change `priority` in `typstTabDefinition()` (`src/client/index.tsx`) to
`'fallback'` and open the tab explicitly with
`openResource(address, { kind: 'typst-preview' })`.

## Requirements

- **DSH `>= 0.1.5-rc.1`** — the plugin registers a tab type on the native right Sidebar
  (`ctx.sidebarRightTabs`) and mounts its body into the `sidebar.right.pane.tab` slot.
- **`tinymist`** — looked up on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` and `~/.cargo/bin`. Override the path with `tinymistPath` (below).
- The predecessor of this plugin (`~/.dsh/plugins/dsh-typst-preview`, mounted onto the
  `dsh-better-sidebar` file viewer) is not compatible with 0.1.5 and is superseded by this one.

## Install

```sh
dsh plugin --profile web add github:Limbo-137/dsh-typst-preview
```

Then **restart `dsh web`** (Ctrl-C in the terminal that runs it, start it again). This plugin
has a host half that owns real `tinymist` processes and registers routes on the app's web
server, so it cannot be hot-mounted; and a running instance only picks up changed host code
on restart. (`smart_restart` needs systemd `restartUnit` and is a no-op on macOS.)

Build artifacts (`lib/`) are committed, so nothing is compiled at install time — the install
is a checkout, not a build.

To do it by hand instead, the profile needs the package in **both** places:

```jsonc
// $DSH_HOME/profiles/web/package.json
"dependencies": { "dsh-typst-preview": "github:Limbo-137/dsh-typst-preview" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-typst-preview" ] } }
```

then `pnpm install` inside `$DSH_HOME/profiles/web`.

## Configuration

Optional, on the plugin's row in the profile's `cordis.patch.yml` (or a home patch):

```yaml
- id: typst-preview
  config:
    tinymistPath: tinymist          # default 'tinymist' (PATH lookup, then the fallback dirs)
    extraArgs: []                   # extra argv for `tinymist preview`, e.g. ['--font-path', '/path/to/fonts']
    maxInstances: 4                 # live preview processes, LRU-evicted, default 4
    readyTimeoutMs: 20000           # first page deadline, default 20s
    idleTimeoutMs: 1800000          # idle reaper, default 30min
    highlight: true                 # highlight the source face; false = the paged plain-text reader
    highlightLines: 800             # lines per highlighted page, default 800
    highlightMaxBytes: 4194304      # files above this stay plain, default 4 MiB
    highlightIdleTimeoutMs: 600000  # idle reaper for highlighting language servers, default 10min
    highlightMaxServers: 2          # highlighting language servers kept at once, one per project root
```

`extraArgs` is shared: they are passed to `tinymist preview` and to `tinymist lsp` alike, so a
`--font-path` for a document that needs it applies to both faces.

## Memory and process hygiene

A `tinymist preview` costs 200–600 MB, so this plugin treats every child as a resource that
must stay reachable:

- **One process per file.** Two requests for the same file at the same moment (a remount, a
  second pane, a reload racing the first request) share one spawn. Without that, the loser
  of the race is overwritten in the instance map and no code path can ever kill it again.
- **Every child is tracked separately from the reusable set**, and `close`, the reaper and
  shutdown act on that superset — so a child that leaves the live set for any reason is still
  killable by token.
- **LRU cap** (`maxInstances`, default 4) evicts by killing, and a hard ceiling of twice that
  catches anything the cap misses.
- **Two reapers**: an idle one (default 30 min of no requests) and an orphan one that kills,
  after 60 s, any child no key claims any more — the safety net for a close request the
  browser never delivered.
- **Exit hook**: a graceful host exit SIGKILLs whatever is still running, so a restart does
  not leave orphans behind.

`GET /api/typst-preview/status` reports both `processes` (every child) and `instances` (the
reusable ones); the two disagreeing is the shape of a leak. `scripts/leak-check.mjs`
asserts exactly that against the real process table.

## How it works

| Layer | Responsibility |
|---|---|
| `src/index.ts` (host) | Five routes: `POST /api/typst-preview/open`, `POST …/close`, `POST …/source`, `GET …/status`, the prefix proxy `GET …/p/<token>/…`, plus one exact upgrade route per instance, `GET /api/typst-preview/ws/<token>`. Same-origin fence: requests whose `sec-fetch-site` is `cross-site`, or whose `Origin` host differs from `Host`, are refused. |
| `src/host/tinymist.ts` | One preview process per (session × absolute path × colour mode). Ports are picked by binding `0` twice and releasing, so an instance never collides with tinymist's fixed default pair 23625/23626. The preview root is the nearest `typst.toml`, else the session workspace when it contains the file, else the file's directory. Readiness is polled before the tab reports success. |
| `src/host/highlight.ts` | Typst syntax highlighting from `tinymist lsp`. Its `semanticTokens/full` answer is decoded down to per-line runs of `[start, end, classIndex, styleBits]` over UTF-16 offsets, so the browser half paints spans without shipping a grammar. One language server per project root, each file cached by content hash, so turning a page costs no token request; position encoding is asserted to be UTF-16 rather than assumed, because the runs index JavaScript strings and UTF-8 offsets would slice CJK lines at the wrong characters. The static app highlighter cannot do this: its shiki instance bundles a fixed grammar table and Typst is not in it. |
| `src/host/proxy.ts` | HTTP passthrough with the prefix stripped (forcing `accept-encoding: identity` so the HTML rewrite is safe), plus exactly one edit to the served page: `new URL("/", window.location.href)` — the page's only absolute address — is rewritten to the instance's WebSocket route. The WebSocket handshake and every frame are relayed verbatim. |
| `src/client/index.tsx` (browser) | Registers the tab type on `ctx.sidebarRightTabs` and the body in the keyed `sidebar.right.pane.tab` seat. The source face asks `POST …/source` first and falls back to `ctx.remote.workspaceFiles.read` (the paged plain-text reader) with the shared code renderer when highlighting is unavailable, so the face always shows something. Token class names map onto the shell's own `--shiki-*` custom properties, so the colours are the app's code-block palette in both themes. Locale strings in English and Chinese. |

Because both halves talk to `tinymist` through the DSH origin, the preview works over
localhost, a LAN address, or a tunnel — there is no second port to expose.

One DSH detail worth knowing if you write against this: Remote methods such as
`workspaceFiles.read` resolve to a **result envelope** (`{ ok: true, value }` /
`{ ok: false, error }`), not to the bare payload. The browser half unwraps it in its
`inject` face and raises the failure as an exception.

## Verification

Both scripts run against a real `tinymist`; nothing is mocked.

```sh
# Host half: apply() → a fake web server with the same exact/prefix/upgrade dispatch → real processes
node scripts/smoke.mjs
#   open starts an instance, the page is proxied, its WebSocket URL is rewritten,
#   the relay delivers real frames, a second open reuses the instance, the source
#   route answers with text plus token runs (and a page window, and a refusal),
#   close reaps it, and a cross-site request is refused — 19/19.

# Host half: the preview fleet against the OS process table
node scripts/leak-check.mjs
#   two simultaneous opens of one file share a token and one child; the LRU cap
#   kills what it evicts; a child removed from the instance map is still closable
#   and still counted; the reaper collects a stray; dispose leaves nothing alive
#   — 13/13.

# Browser half: the built client bundle loaded the way the shell loads it, rendered
# with React's static renderer against a page the host really highlighted
node scripts/render-check.mjs
#   a real tinymist page becomes one row per line with line numbers, `#set` is a
#   keyword span, `*strong*` carries the style bit, the CJK comment is exact, and
#   every character of the file survives rendering — 8/8.

# Browser half: headless Chrome over CDP against a running DSH Web
printf '= Probe\nHello $x^2$\n' > /path/to/workspace/probe-typst.typ
node scripts/gui-check.mjs "http://127.0.0.1:3080/?token=…" probe-typst.typ
#   the client bundle loads, the right Sidebar opens, clicking the probe .typ lands in
#   this plugin's tab, the iframe points at the plugin's proxy path, the host serves the
#   rewritten page, the source face reads text, switching back keeps the iframe alive,
#   no typst-related console errors — 14/14.
```

`gui-check.mjs` prints diagnostics on failure (panel text, the read-only
`globalThis.__dshTypstDebug` snapshot, and one direct `open` round-trip).

## Chinese (and any non-Latin) text

Typst's default font is a Latin one, so a document that never sets a font renders its
Chinese as empty boxes — in this preview, in `typst compile`, and everywhere else. This is a
document property, not a plugin one: put the font in the file (or in the preamble you
import), and both faces follow.

```typst
#set text(font: ("New Computer Modern", "Songti SC", "STSong", "Source Han Sans SC", "SimSun"))
```

`typst fonts` lists what the machine has; on macOS `Songti SC` / `PingFang SC` / `Heiti SC`
are always present, and a stack lets the Latin font win for formulas and English while CJK
falls through. `extraArgs: ['--font-path', '…']` covers fonts that are not installed
system-wide. For a preview of Chinese text to be meaningful the entrypoint must set this
before the content, exactly as with `typst compile`.

## Known limits

- **Read-only.** The source face is a viewer, not an editor; edits come from the agent's
  write tools or an external editor, and the preview follows them.
- Sidebar tab state is in memory: a page refresh returns the Sidebar to its collapsed state
  (native Sidebar behaviour, not this plugin's).
- One `tinymist` process per open file, capped by `maxInstances` and LRU-evicted.
  Ports are allocated per instance rather than reusing the fixed 23625.
- `--invert-colors=auto` is tinymist's own interpretation; on a dark DSH theme, switch the
  toolbar to the inverted mode if `auto` does not match.
- Only `.typ` under `dsh-resource://file/**` (case-insensitive) is claimed. Files outside the
  workspace work too, through their `absolute` address.

## License

MIT
