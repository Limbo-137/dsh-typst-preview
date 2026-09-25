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
multiple gigabytes. Returning to a tab reloads its page (~1 s), and it re-opens the preview
first: the token the tab still holds may belong to an instance that was reaped while the tab
was hidden, and asking for a dead token used to answer with an error page instead of the
document.

`.typ` is claimed through the Sidebar's tab-type registry at `priority: 'extension'`, which
outranks the built-in plain-text fallback viewer. To send `.typ` back to the native text
viewer instead, change `priority` in `typstTabDefinition()` (`src/client/index.tsx`) to
`'fallback'` and open the tab explicitly with
`openResource(address, { kind: 'typst-preview' })`.

## Requirements

- **DSH `>= 0.1.5-rc.1`** — the plugin registers a tab type on the native right Sidebar
  (`ctx.sidebarRightTabs`) and mounts its body into the `sidebar.right.pane.tab` slot. That pair is
  the extension path the 0.1.7 docking Sidebar documents for itself, so the same two calls serve
  both the panel 0.1.5 shipped and the dockable, floatable one 0.1.7 ships; `keepMounted: true`
  asks a 0.1.7 host to keep a visited tab alive across collapse, tab switches and docking.
- **`tinymist`** — looked up on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` and `~/.cargo/bin`. Override the path with `tinymistPath` (below). Both faces use
  that one resolved path, which is what lets the plugin work under a host whose `PATH` is only
  `/usr/bin:/bin:/usr/sbin:/sbin` — the desktop app's host process, where that lookup order is the
  only reason a preview appears at all.
- The predecessor of this plugin (`~/.dsh/plugins/dsh-typst-preview`, mounted onto the
  `dsh-better-sidebar` file viewer) is not compatible with 0.1.5 and is superseded by this one.

## Permissions, dependencies and failure bounds

Stated plainly, because this plugin drives an external compiler and DSH STORE (rightly) refuses to
guess: it is a **high-capability** plugin, so the store lists it as `user-reviewed` — the market
shows you what changed and you confirm it — rather than auto-approving it.

| Capability | Exact bounds |
|---|---|
| **Files** | Reads the `.typ` files whose tabs you opened, and nothing else of yours. Never writes: the source face is read-only, and only the agent's own tools edit your files. |
| **Network** | No outbound traffic, no telemetry. Every request is either same-origin (`/api/typst-preview/*` on the app's own host) or loopback to a `tinymist` process this plugin started. |
| **Commands** | Spawns the local `tinymist` binary (`preview`, and `lsp` for source highlighting) with an explicit argv; no shell, no remote installs, no other executables. `tinymistPath` overrides which binary. |
| **Credentials** | None. No tokens, keys or cookies are read; the only environment use is resolving the `tinymist` path and the user's home directory. |
| **Lifecycle** | No `preinstall`/`install`/`postinstall`/`prepare`. Nothing runs at install or update time, which is also why `lib/` is committed. |

**External dependency**: [`tinymist`](https://github.com/Myriad-Dreamin/tinymist) must be on `PATH`
(or given via `tinymistPath`); verified against `v0.15.0-rc1`.

**When things are missing or fail**: no `tinymist` means the Preview face shows the error and the
Source face falls back to plain text; a file over `highlightMaxBytes` (4 MiB) loses highlighting but
still reads; a crashed or killed preview is reaped and started again on demand; the fleet is capped
(`maxInstances`, plus a hard ceiling of twice that) and both idle and orphaned children are
reaped, so a lost child cannot outlive the tab that started it.

**Declared compatibility**: Node `>=22`, DSH `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.1 <0.2.0-0`
(per-release record: `0.1.5-rc.1: compatible`, `0.1.5-rc.2: compatible`, `0.1.7-rc.2: compatible`),
profile `web`. The range spells out the prerelease lines that were actually run, because a plain
`>=0.1.5-rc.1 <0.2.0` silently excludes every prerelease on another `major.minor.patch` tuple —
including `0.1.7-rc.2`, which is what the native app runs. `0.1.6-*` was never tested and is not
claimed. The install/start/uninstall/rollback transcript on a disposable profile is in
[`docs/profile-evidence.md`](docs/profile-evidence.md); other DSH releases stay `unknown` there
until the same run is done on them.

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
  browser never delivered. A preview with a live relay socket is never idle: "nobody is
  watching" cannot be inferred from request timestamps, because a page nobody recompiles
  makes no requests at all.
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
#   close reaps it, an unknown page token answers a readable page rather than JSON,
#   and a cross-site request is refused — 20/20.

# Host half: the preview fleet against the OS process table
node scripts/leak-check.mjs
#   two simultaneous opens of one file share a token and one child; the LRU cap
#   kills what it evicts; a child removed from the instance map is still closable
#   and still counted; the reaper collects a stray but spares a preview that still
#   holds a socket; dispose leaves nothing alive — 15/15.

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
