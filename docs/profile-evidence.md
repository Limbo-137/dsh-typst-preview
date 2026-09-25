# Disposable-profile evidence: install, start, uninstall, rollback

This is the evidence DSH STORE's remediation asks for ("一次性 Profile 的安装、启动与卸载证据").
It was produced on a throwaway `DSH_HOME`, never on the real profile, and every command below is
reproducible by anyone with the same host. It is not a security audit, and it does not claim
Linux or Windows coverage.

- **Tested commit**: `2e07f4f3c0fae36528933eb3e61330dd46217805` (the manifest change that
  declares `engines.node` and `dsh.compatibility`). This document was added afterwards and
  changes no runtime code. The same run was repeated on **DSH `0.1.5-rc.2` with plugin `0.3.3`**
  and is recorded verbatim in [the second run](#second-run-dsh-015-rc2-plugin-033) below.
- **Host**: macOS (darwin arm64), Node `v22.23.2`, DSH `0.1.5-rc.1`, tinymist `v0.15.0-rc1`.
- **Isolation**: `DSH_HOME=/tmp/dsh-evidence` with its own `profiles/web/package.json`
  (`bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-typst-preview]`). The real
  `~/.dsh` was never written to; the app's own token was read from its boot line and used
  through a cookie jar.
- **Cleanup**: the temp home was deleted and the run left **no** `tinymist` processes behind.

## Install

```console
$ pnpm add "github:Limbo-137/dsh-typst-preview#2e07f4f3c0fae36528933eb3e61330dd46217805"
Progress: resolved 8, reused 7, downloaded 1, added 8, done
dependencies:
+ dsh-typst-preview 0.3.1
Done in 5.9s using pnpm v11.25.0

$ node -e "const d=require('./node_modules/dsh-typst-preview/package.json');console.log(d.version, JSON.stringify(d.engines), JSON.stringify(d.dsh.compatibility))"
0.3.1 {"node":">=22"} {"dsh":">=0.1.5-rc.1 <0.2.0","dshReleases":{"0.1.5-rc.1":"compatible"},"profiles":["web"]}

$ ls node_modules/dsh-typst-preview/lib/index.js node_modules/dsh-typst-preview/lib/client.js
node_modules/dsh-typst-preview/lib/client.js  node_modules/dsh-typst-preview/lib/index.js
```

No lifecycle script ran (the package declares none) and no build was attempted: `lib/` is
committed, so the install is a checkout of the published artifact.

## Start

```console
$ DSH_HOME=/tmp/dsh-evidence dsh --profile web --port 3099 --no-open
dsh web: http://127.0.0.1:3099/?token=…

$ curl -s -b jar http://127.0.0.1:3099/api/typst-preview/status
{"ok":true,"executable":"/Users/limbo/.local/bin/tinymist","pagePrefix":"/api/typst-preview/p/",
 "wsPrefix":"/api/typst-preview/ws/","highlight":{"enabled":true,"lines":800,"servers":[]},
 "processes":0,"instances":[]}

$ curl -s -X POST -d '{"file":"/tmp/dsh-evidence/ws/evidence.typ","cwd":"/tmp/dsh-evidence/ws",
                       "sessionId":"evidence","invert":"never"}' …/api/typst-preview/open
open ok: True | token: 63dac0c0 | url: /api/typst-preview/p/63dac0c0f2f50deca2/

$ curl -s -o /dev/null -w '%{http_code} %{size_download} bytes\n' …/api/typst-preview/p/63dac0c0f2f50deca2/
200 1647735 bytes

$ curl -s -X POST -d '{"file":"…/evidence.typ","offset":1}' …/api/typst-preview/source
source route ok: True | class list | lines 4

$ curl -s -X POST -d '{"token":"…"}' …/api/typst-preview/close   ; # then:
instances 0 | processes 0
```

The 1.65 MB body is tinymist's own preview page served through the plugin's proxy; the source
route is the semantic-token path added in v0.3.0. Closing the tab returns both counts to zero.

## Uninstall

Same disposable profile, same probe, with the plugin row present and then removed:

```console
-- plugin NOT in the profile (uninstalled) --
  app root                  HTTP 200
  /api/typst-preview/status HTTP 404
  not found

-- plugin installed again (same disposable profile) --
  app root                  HTTP 200
  /api/typst-preview/status HTTP 200
  {"ok":true,"executable":"/Users/limbo/.local/bin/tinymist",…
```

Removing the dependency and the `dsh.profile.bundles` entry is enough: the app boots without it
and the plugin's routes are gone (404), while the app itself keeps serving (200).

## Rollback

```console
$ pnpm add "github:Limbo-137/dsh-typst-preview#v0.3.0"
+ dsh-typst-preview 0.3.0
Done in 3.9s using pnpm v11.25.0
rolled back to version 0.3.0
v0.3.0 plugin serves again: ok = True | processes = None
```

`processes = None` is the point: the older release predates that status field, so the probe is
looking at the rolled-back build, not at a cached one.

## What this evidence does not cover

- Only macOS arm64 with Node 22.23.2, DSH 0.1.5-rc.1 and DSH 0.1.5-rc.2. The manifest declares
  `>=22` and `0.1.5-rc.1`/`0.1.5-rc.2` `compatible` for exactly that reason; other releases are
  `unknown` until tested.
- No visual check: the preview page was verified by HTTP status and byte count, not by eye.
- No security review. The plugin spawns a local `tinymist`, reads the `.typ` files it is asked
  about and proxies its own child processes over the app origin — see the permissions section in
  the README for the exact bounds, and expect `user-reviewed` rather than an automatic pass for
  a plugin whose whole job is to drive an external compiler.

## Second run: DSH `0.1.5-rc.2`, plugin `0.3.3`

Same protocol as above, repeated on the next release so the `0.1.5-rc.2: compatible` claim in the
manifest rests on the same kind of transcript rather than on a version-range argument.

- **Tested artifact**: the packed release tarball (`dsh-typst-preview-0.3.3.tgz`, published as the
  release asset `dsh-typst-preview.tgz`) — installed from that file rather than through a
  working-tree link; its checksum is in the release's own notes.
- **Host**: macOS (darwin arm64), Node `v22.23.2`, tinymist `v0.15.0-rc1`. The `dsh` binary on
  `PATH` stamps itself `0.1.5-rc.1`, but its `^0.1.5-rc.1` ranges resolve upward, so the shell it
  boots is **`0.1.5-rc.2`**; that was read back off disk rather than assumed:
  `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` both resolve to `…/0.1.5-rc.2/…`.
- **Isolation**: `DSH_HOME=/tmp/dsh-evidence-rc2`, a profile created by the CLI itself. The real
  `~/.dsh` was never written to; the app's token was read from its boot line and used through a
  cookie jar.
- **Cleanup**: the temp home was deleted (`rm -rf /tmp/dsh-evidence-rc2`) and the run left **no**
  `tinymist` processes behind.

### Install

```console
$ DSH_HOME=/tmp/dsh-evidence-rc2 dsh plugin --profile web add /…/dsh-typst-preview-0.3.3.tgz
dsh: initialized profile web at /tmp/dsh-evidence-rc2/profiles/web
dependencies:
+ dsh-typst-preview file:/…/dsh-typst-preview-0.3.3.tgz
Done in 239ms using pnpm v11.25.0

$ node -e "const d=require('./node_modules/dsh-typst-preview/package.json');console.log(d.version, JSON.stringify(d.engines), JSON.stringify(d.dsh.compatibility))"
0.3.3 {"node":">=22"} {"dsh":">=0.1.5-rc.1 <0.2.0","dshReleases":{"0.1.5-rc.1":"compatible","0.1.5-rc.2":"compatible"},"profiles":["web"]}

$ node -e "const s=require('./node_modules/dsh-typst-preview/package.json').scripts||{};console.log(Object.keys(s).filter(k=>/install|prepare|prepack|postpack/.test(k)))"
[]

$ ls -la node_modules/dsh-typst-preview/lib/index.js node_modules/dsh-typst-preview/lib/client.js
-rw-r--r--  wheel  47832 node_modules/dsh-typst-preview/lib/index.js
-rw-r--r--  wheel  39840 node_modules/dsh-typst-preview/lib/client.js
```

### Start

```console
$ DSH_HOME=/tmp/dsh-evidence-rc2 dsh --profile web --port 3099 --no-open
dsh web: http://127.0.0.1:3099/?token=…

$ curl -s -b jar http://127.0.0.1:3099/api/typst-preview/status
{"ok":true,"executable":"/Users/limbo/.local/bin/tinymist","pagePrefix":"/api/typst-preview/p/",
 "wsPrefix":"/api/typst-preview/ws/","highlight":{"enabled":true,"lines":800,"servers":[]},
 "processes":0,"instances":[]}

$ curl -s -X POST -d '{"file":"/tmp/dsh-evidence-rc2/ws/evidence.typ","cwd":"/tmp/dsh-evidence-rc2/ws",
                       "sessionId":"evidence-rc2","invert":"never"}' …/api/typst-preview/open
{"ok":true,"token":"578108ddfec3e0dc76","url":"/api/typst-preview/p/578108ddfec3e0dc76/",
 "ws":"/api/typst-preview/ws/578108ddfec3e0dc76",…}

$ curl -s -o /dev/null -w '%{http_code} %{size_download} bytes\n' …/api/typst-preview/p/578108ddfec3e0dc76/
200 1647735 bytes

$ curl -s -X POST -d '{"file":"…/evidence.typ","offset":1}' …/api/typst-preview/source
{"ok":true,…,"lineCount":5,"lines":5,"eof":true,"nextOffset":6,"text":"#set text(font: …"}

$ curl -s -b jar …/api/typst-preview/status      # instance is live
… "highlight":{"enabled":true,"lines":800,"servers":[{"root":"/tmp/dsh-evidence-rc2/ws","files":1}]},
   "processes":1,"instances":[{"token":"578108ddfec3e0dc76",…

$ curl -s -X POST -d '{"token":"…"}' …/api/typst-preview/close   ; # then:
{"ok":true,"stopped":true} | processes 0
```

The 1,647,735-byte body is the same byte count as the `0.1.5-rc.1` run above, and the page route,
the WebSocket rewrite and the semantic-token source route all behave identically.

### Client half

The browser half is the other half of the compatibility question, and it is the half that touches
a versioned shell API. Two checks, both against the shell that actually served this instance:

```console
$ curl -s …/ | grep -o 'dsh-typst-preview/client.js'
dsh-typst-preview/client.js            # the rc.2 shell preloads our client bundle
```
```js
// the shell's frozen module table, and the module it points at (from the served bundle):
//   "@deepseek-ai/dsh-client-ui-primitives": Zg
//   const Zg = Object.freeze({ …, CodeBlock: a8, …, writeClipboard: Rn })
```

So the specifier the plugin's client bundle `require()`s is still registered under rc.2, and both
symbols it uses are still exported. A headless browser reached the app in the same run and
confirmed the bundle is really requested at boot; `scripts/gui-check.mjs` then stopped on
*fixture* grounds (a throwaway home has no session to open), not on anything the plugin did, so
the click-through of the Sidebar tab was **not** repeated in this run — the client half is covered
by the module-table check above, by `scripts/render-check.mjs`, and by the fact that the `lib/`
tree rebuilt against `@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.2` is byte-identical to the
one built against `0.1.5-rc.1`.

### Uninstall

```console
-- plugin NOT in the profile (uninstalled) --
  app root                   HTTP 303
  /api/typst-preview/status  HTTP 404
  not found
```

Same conclusion as before: dropping the dependency and the `dsh.profile.bundles` entry is enough —
the app boots and keeps serving, the plugin's routes are gone.

## Third run: DSH `0.1.7-rc.2` (the desktop app), plugin `0.3.4`

The native app stopped shipping a `dsh` CLI on `PATH` and runs its profile from an asar-packed
runtime, so this run first had to reproduce the app's own conditions rather than assume them.

- **Tested artifact**: the packed release tarball `dsh-typst-preview-0.3.4.tgz` (published as the
  release asset `dsh-typst-preview.tgz`), installed from that file.
- **Host**: macOS arm64, with the desktop app's **bundled** runtime —
  `@deepseek-ai/dsh-desktop-runtime` `0.1.7-rc.2`, Node `v24.21.0`, pnpm `11.7.0`; tinymist
  `v0.15.0-rc1` at `~/.local/bin/tinymist`.
- **The condition that matters**: the app's *host process* runs with
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (read off the live process), so `tinymist` is **not** on
  `PATH`. Everything below was run with exactly that `PATH`.
- **Isolation**: `DSH_HOME=/tmp/dsh-017b`, profile created by the app's own CLI, invoked without
  Electron's UI as
  `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "…/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"`.
  The real `~/.dsh` was never written to.
- **Cleanup**: the temp home was deleted and the run left **no** `tinymist` processes behind.

### Install

```console
$ DSH_HOME=/tmp/dsh-017b PATH=/tmp/dsh-bin:/usr/bin:/bin:/usr/sbin:/sbin \
    ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness" "…/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    plugin --profile web add /…/dsh-typst-preview-0.3.4.tgz
dependencies:
+ dsh-typst-preview file:/…/dsh-typst-preview-0.3.4.tgz
Done in 392ms using pnpm v11.7.0

$ node -e "const d=require('./node_modules/dsh-typst-preview/package.json');console.log(d.version, JSON.stringify(d.dsh.compatibility))"
0.3.4 {"dsh":">=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.1 <0.2.0-0",
       "dshReleases":{"0.1.5-rc.1":"compatible","0.1.5-rc.2":"compatible","0.1.7-rc.2":"compatible"},
       "profiles":["web"]}
```

The version the app enforces is not this field. `evaluatePluginCompatibility` in
`@deepseek-ai/dsh-app-boot` reads only `peerDependencies` whose name is `@deepseek-ai/dsh` or starts
with `@deepseek-ai/dsh-`, and tests them with `semver.satisfies(runtime, range,
{ includePrerelease: true })`; `engines.dsh` and `dsh.compatibility` are declarative — the manifest
package's own README says so ("Current installers and loaders do not enforce `dsh.manifestVersion`
or `engines.dsh`"). With `includePrerelease: true` the plugin's peer `^0.1.5-rc.1` admits
`0.1.7-rc.2`, which is why the install is not refused; the declared range above is what a *reader*
and the storefront see, and it is written the awkward way on purpose (see the README).

### Start

```console
$ DSH_HOME=/tmp/dsh-017b PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness" "…/bin.js" --profile web --port 3099 --no-open
dsh web: http://127.0.0.1:3099/?token=…

$ curl -s -b jar …/api/typst-preview/status
{"ok":true,"executable":"/Users/limbo/.local/bin/tinymist",…,"processes":0,"instances":[]}

$ curl -s -X POST -d '{"file":"/tmp/dsh-017b/ws/probe-typst.typ","cwd":"/tmp/dsh-017b/ws",
                       "sessionId":"native","invert":"never"}' …/api/typst-preview/open
{"ok":true,"token":"124344d7d7e430d262","url":"/api/typst-preview/p/124344d7d7e430d262/",
 "ws":"/api/typst-preview/ws/124344d7d7e430d262",…}

$ curl -s -o /dev/null -w '%{http_code} %{size_download} bytes\n' …/api/typst-preview/p/124344d7d7e430d262/
200 1647738 bytes

$ curl -s -X POST -d '{"file":"…/probe-typst.typ","cwd":"…/ws","offset":1}' …/api/typst-preview/source
{"ok":true,…,"lineCount":6,"lines":6,"eof":true,"classes":["comment","string","raw","keyword",…]}

$ curl -s -X POST -d '{"token":"…"}' …/api/typst-preview/close   ; # then processes 0
{"ok":true,"stopped":true}
```

### The bug this run found

The same source route against **plugin 0.3.3** on the same host answered

```json
{"ok":false,"error":"spawn tinymist ENOENT"}
```

while the preview route answered normally. The two halves did not agree on which `tinymist` they
run: the preview manager resolves the configured name once (`resolveTinymistPath`: `PATH` first,
then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`), and the source
highlighter was handed the *raw* config value (`'tinymist'`), which it then `spawn`s with a
`cwd`. Under a shell whose `PATH` includes `~/.local/bin` both work and the difference is
invisible; under the desktop app's `/usr/bin:/bin:/usr/sbin:/sbin` the source face degrades to the
plain paged reader. 0.3.4 passes the resolved executable to the highlighter, and the transcript
above is what that looks like — the preview *and* the token runs, on a `PATH` with no `tinymist` on
it at all. `node scripts/smoke.mjs` now fails on the old code and passes on the new one for the
same reason.

### Client half

The session-scoped tab body is still the documented pair: `ctx.sidebarRightTabs.register({ id, kind,
patterns?, priority?, canOpen?, title, guide?, keepMounted? })` and
`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)` reading
`{ sidebar, panel, tab }` from the framework-injected `useTabInfo()`. That is verbatim what the
0.1.7 package's own README prescribes and what its shipped `files`, `documentpreview`, `plan`,
`schedule`, `browser`, `terminal` and `subagent` types do, and the `.typ` claim still wins: the
built-in text preview registers as `priority: 'fallback'` over `dsh-resource://file/**`, the
plugin as `priority: 'extension'` over `*.typ`, and the resolver ranks by band first.

```console
$ node -e "…performance.getEntriesByType('resource')…"   # in a headless Chrome on the running app
dsh-typst-preview/client.js            # fetched, in the same bundle request as the shell's own plugins
                                         # console errors: none
```

**Not covered**: the pixel-level click-through of the new docking panel. The right bar in 0.1.7 is
a `data-rightbar-*` DockKit surface whose expand control moved into the conversation header's
corner seat — the control keeps its `data-sidebar-right-expand` attribute, but the two selectors
`scripts/gui-check.mjs` drives the panel with (`data-dockkit-add-tab`, `data-files-state`) are gone,
and the script's session fixture is stale as well (a throwaway home lists no session row, so it
never reaches the panel). The client half is therefore covered by the registration contract above,
by the fetched-and-errorless bundle, and by `scripts/render-check.mjs` — not by an eye on the panel.
