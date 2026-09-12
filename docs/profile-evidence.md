# Disposable-profile evidence: install, start, uninstall, rollback

This is the evidence DSH STORE's remediation asks for ("一次性 Profile 的安装、启动与卸载证据").
It was produced on a throwaway `DSH_HOME`, never on the real profile, and every command below is
reproducible by anyone with the same host. It is not a security audit, and it does not claim
Linux or Windows coverage.

- **Tested commit**: `2e07f4f3c0fae36528933eb3e61330dd46217805` (the manifest change that
  declares `engines.node` and `dsh.compatibility`). This document was added afterwards and
  changes no runtime code.
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

- Only macOS arm64 with Node 22.23.2 and DSH 0.1.5-rc.1. The manifest declares `>=22` and
  `0.1.5-rc.1: compatible` for exactly that reason; other releases are `unknown` until tested.
- No visual check: the preview page was verified by HTTP status and byte count, not by eye.
- No security review. The plugin spawns a local `tinymist`, reads the `.typ` files it is asked
  about and proxies its own child processes over the app origin — see the permissions section in
  the README for the exact bounds, and expect `user-reviewed` rather than an automatic pass for
  a plugin whose whole job is to drive an external compiler.
