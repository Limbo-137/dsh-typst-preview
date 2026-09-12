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
- **Source** — the file's own text in the shared code renderer (syntax highlighting, line
  numbers, copy), with a **Load more** button for large files.

Both faces stay mounted, so switching to Source and back does not tear down the preview
server — it keeps compiling in the background, and switching back is instantaneous.

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
```

## How it works

| Layer | Responsibility |
|---|---|
| `src/index.ts` (host) | Four routes: `POST /api/typst-preview/open`, `POST …/close`, `GET …/status`, the prefix proxy `GET …/p/<token>/…`, plus one exact upgrade route per instance, `GET /api/typst-preview/ws/<token>`. Same-origin fence: requests whose `sec-fetch-site` is `cross-site`, or whose `Origin` host differs from `Host`, are refused. |
| `src/host/tinymist.ts` | One preview process per (session × absolute path × colour mode). Ports are picked by binding `0` twice and releasing, so an instance never collides with tinymist's fixed default pair 23625/23626. The preview root is the nearest `typst.toml`, else the session workspace when it contains the file, else the file's directory. Readiness is polled before the tab reports success. |
| `src/host/proxy.ts` | HTTP passthrough with the prefix stripped (forcing `accept-encoding: identity` so the HTML rewrite is safe), plus exactly one edit to the served page: `new URL("/", window.location.href)` — the page's only absolute address — is rewritten to the instance's WebSocket route. The WebSocket handshake and every frame are relayed verbatim. |
| `src/client/index.tsx` (browser) | Registers the tab type on `ctx.sidebarRightTabs` and the body in the keyed `sidebar.right.pane.tab` seat, then reads the file through `ctx.remote.workspaceFiles.read`. Locale strings in English and Chinese. |

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
#   the relay delivers real frames, a second open reuses the instance, close reaps it,
#   and a cross-site request is refused — 10/10.

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
