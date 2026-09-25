# dsh-typst-preview

DeepSeek Harness Web UI **原生右侧边栏里的 Typst 实时预览**：在右侧边栏里点开一个 `.typ` 文件，就是一个带「预览 / 源码」开关的 tab，形态与内置的 Markdown 预览一致。

English: [README.md](README.md)。

## 它长什么样

右侧边栏 → **Files** → 点一个 `.typ`：

- **预览**：`tinymist preview` 渲染的页面，走 WebSocket 推送，改文件即重编译。工具栏三个按钮：重新载入、配色（原始 / 跟随系统 / 反色，记在 `localStorage`）、在新标签页打开。
- **源码**：同一 tab 内切成源码，**语法高亮取自 `tinymist` 自己的语义 token**（标题、关键字、函数、字符串、公式、标签、注释，以及 `*加粗*`／`_斜体_` 标记），带行号、复制，大文件带「加载更多」。配色直接用应用自身的代码块色板（`--shiki-*`），所以 `.typ` 源码与 Markdown 代码块看起来是一套。取不到高亮时——没有 `tinymist`、文件超过体积上限、或 `highlight: false`——退回原生代码渲染器 + 宿主分页读取，与加高亮之前完全一致。

两个面始终挂载，切到源码再切回来**不会**销毁预览进程：后台仍在编译。但预览**文档**只为你正在看的那一个 tab 挂载：一个活的预览页就是一整份 WebKit 文档（带编译好的渲染器和 socket），给每个打开的 tab 都留一份正是浏览器标签页涨到几个 GB 的原因。切回某个 tab 会重新加载它的页面（约 1 秒），并且**先重新 open 一次**：这个 tab 手里的 token 可能属于一个在隐藏期间被回收的实例，而拿失效 token 去请求，过去会换来一张错误页而不是文档。

默认预览面来自类型注册的 `priority: 'extension'`（高于随包的纯文本 `fallback` 查看器）。想让 `.typ` 回到原生文本预览，把 `src/client/index.tsx` 里 `typstTabDefinition()` 的 `priority` 改成 `'fallback'`，再从别处显式 `openResource(address, { kind: 'typst-preview' })`。

## 依赖

- **DSH `>= 0.1.5-rc.1`**：本插件在原生右侧边栏上注册 tab 类型（`ctx.sidebarRightTabs`），正文挂进 `sidebar.right.pane.tab` 席位。这一对调用正是 0.1.7 那套可停靠侧边栏为自己文档化的扩展路径，所以 0.1.5 的单面板与 0.1.7 的可停靠／可浮动面板共用同一份代码；`keepMounted: true` 用来请 0.1.7 的宿主在折叠、切 tab、改变停靠位置时不要卸载已经打开过的 tab。
- **`tinymist`**：先查 `PATH`，再查 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.cargo/bin`；用 `tinymistPath` 可覆盖。**两个面共用这一个解析结果**——这正是插件在 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 的宿主下仍能出预览的原因（原生应用的宿主进程就是这种环境）。
- 本插件的前身（`~/.dsh/plugins/dsh-typst-preview`，挂在 `dsh-better-sidebar` 的文件查看器上）与 0.1.5 不兼容，已被本插件取代。
- **原生应用有两个 origin，而预览是一个「文档」不是一次 fetch。** `DeepSeek Harness.app` 的窗口是从 `dsh-app://app/` 提供的；这个自定义 scheme 会把普通请求转发给应用的 HTTP 宿主，但**承载不了 WebSocket**。所以预览**文档本身**要从宿主真正的 HTTP origin 加载——也就是 shell 用 `__DSH_TRANSPORT__.streamBaseUrl` 公布的那个（`@deepseek-ai/dsh-api-gateway` 自己的 socket 就是从它拼出来的）；文档里的 socket 于是也落在同一个 origin 上。tab 调用的那四条路由仍走文档自己的 origin、由 scheme handler 转发。在浏览器里没有这个全局变量，路径按原样使用。

## 权限、依赖与失败边界

直说，因为这个插件要驱动外部编译器，而 DSH STORE（合理地）拒绝替作者猜：它是**高权限**插件，所以在商城里是 `user-reviewed`——由商城把变更摆给你看、你逐次确认——而不是自动放行。

| 能力 | 确切边界 |
|---|---|
| **文件** | 只读你打开过的那些 `.typ`，不碰其它。**从不写入**：源码面是只读的，改文件只可能来自 agent 自己的工具。 |
| **网络** | 无对外流量、无遥测。每个请求要么同源（应用自己主机上的 `/api/typst-preview/*`），要么是回环到本插件启动的 `tinymist` 进程。 |
| **命令** | 只 spawn 本机 `tinymist`（`preview`，以及源码高亮用的 `lsp`），argv 显式给出；不经 shell、不远程安装、不调用其它可执行文件。`tinymistPath` 可换二进制。 |
| **凭据** | 无。不读任何 token/key/cookie；唯一的"环境"用途是定位 `tinymist` 与用户家目录。 |
| **生命周期脚本** | 没有 `preinstall`/`install`/`postinstall`/`prepare`，安装与更新时不执行任何代码（这也是 `lib/` 入库的原因）。 |

**外部依赖**：[`tinymist`](https://github.com/Myriad-Dreamin/tinymist) 需在 `PATH`（或用 `tinymistPath` 指定），实测版本 `v0.15.0-rc1`。

**缺东西或出错时**：没有 `tinymist` → 预览面报错、源码面退回纯文本；文件超过 `highlightMaxBytes`（4 MiB）→ 不高亮但仍可读；预览进程崩溃/被杀 → 回收器清理，下次按需重启；进程数有上限（`maxInstances`，外加两倍硬闸），闲置与游离的子进程都会被回收，所以丢掉的子进程活不过启动它的那个 tab。

**声明的兼容范围**：Node `>=22`、DSH `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.1 <0.2.0-0`（逐版记录：`0.1.5-rc.1: compatible`、`0.1.5-rc.2: compatible`、`0.1.7-rc.2: compatible`）、profile `web`。范围里把**真正跑过的预发布线**逐条写出来，因为 `>=0.1.5-rc.1 <0.2.0` 这种写法会静默排除掉其它 `major.minor.patch` 元组上的预发布版——包括原生应用正在跑的 `0.1.7-rc.2`。`0.1.6-*` 从未实测，不声明。一次性 Profile 上的安装/启动/卸载/回滚实测记录见 [`docs/profile-evidence.md`](docs/profile-evidence.md)；其它 DSH 版本在做同样的实测之前保持 `unknown`。

## 安装

```sh
dsh plugin --profile web add github:Limbo-137/dsh-typst-preview
```

**然后必须重启 `dsh web`**（在跑它的终端 Ctrl-C 后重新执行）。本插件有宿主半：它要真正拉起 `tinymist` 进程、在应用 web server 上注册路由，不能热挂；而且已经跑着的实例只有重启才会加载改动后的宿主代码。（`smart_restart` 需要 systemd `restartUnit`，macOS 上无效。）

`lib/` 构建产物已入库，所以安装时**不跑构建脚本**——安装就是取一份代码，不是编译。

若想手改 profile，最小改动是：

```jsonc
// $DSH_HOME/profiles/web/package.json
"dependencies": { "dsh-typst-preview": "github:Limbo-137/dsh-typst-preview" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-typst-preview" ] } }
```

再在 `$DSH_HOME/profiles/web` 里 `pnpm install`。

## 配置（可选）

插件行的 config（写进 profile 的 `cordis.patch.yml` 或 home patch）：

```yaml
- id: typst-preview
  config:
    tinymistPath: tinymist          # 默认 'tinymist'（PATH，然后上面那几个目录）
    extraArgs: []                   # 追加给 `tinymist preview` 的参数，如 ['--font-path', '/path/to/fonts']
    maxInstances: 4                 # 同时在线的预览进程上限（LRU 淘汰），默认 4
    readyTimeoutMs: 20000           # 首个页面就绪超时，默认 20s
    idleTimeoutMs: 1800000          # 闲置回收，默认 30min
    highlight: true                 # 源码面是否高亮；false = 只用分页纯文本读取
    highlightLines: 800             # 每页高亮的行数，默认 800
    highlightMaxBytes: 4194304      # 超过这个大小就不高亮，默认 4 MiB
    highlightIdleTimeoutMs: 600000  # 高亮语言服务器闲置回收，默认 10min
    highlightMaxServers: 2          # 同时保留的语言服务器数（每项目根一个）
```

`extraArgs` 是共用的：既传给 `tinymist preview`，也传给 `tinymist lsp`，所以给文档补字体的 `--font-path` 两个面都生效。

## 内存与进程卫生

一个 `tinymist preview` 要 200–600 MB，所以本插件把每个子进程都当成"必须始终可寻址"的资源：

- **一个文件一个进程**：同一文件的两次并发请求（重新挂载、第二个 panel、刷新撞上首个请求）共享同一次 spawn。没有这一条，竞争的败者会被覆盖出实例表，此后没有任何代码路径能杀掉它。
- **全部子进程与"可复用集合"分开记账**，`close`、回收器和卸载都作用在这个超集上——所以任何原因离开活动集合的子进程，仍然可以被 token 杀掉。
- **LRU 上限**（`maxInstances`，默认 4）淘汰即杀，另有一道两倍上限的硬闸兜住漏网。
- **两道回收**：闲置回收（默认 30 分钟无请求），以及 60 秒后杀掉"已不被任何 key 认领"的子进程——这是浏览器没送达 close 请求时的安全网。**持有活跃中继 socket 的预览永不算闲置**："没人在看"不能从请求时间戳推断，因为无人重编译的页面根本不发请求。
- **退出钩子**：宿主正常退出时对残留子进程发 SIGKILL，重启不再留孤儿。

`GET /api/typst-preview/status` 同时报 `processes`（全部子进程）与 `instances`（可复用的那些），两者不一致就是泄漏的形状；`scripts/leak-check.mjs` 直接对着真实进程表断言这件事。

## 设计要点

| 层 | 做什么 |
|---|---|
| `src/index.ts`（宿主） | 5 条路由：`POST /api/typst-preview/open`、`POST …/close`、`POST …/source`、`GET …/status`、前缀代理 `GET …/p/<token>/…`，外加每实例一条精确升级路由 `GET /api/typst-preview/ws/<token>`。同源围栏：拒绝 `sec-fetch-site: cross-site` 与 `Origin` 主机与 `Host` 不一致的请求。 |
| `src/host/tinymist.ts` | 每个（会话 × 绝对路径 × 配色）一个预览进程；端口对用「同时 bind 0 再释放」的办法挑，避开 tinymist 默认固定端口 23625/23626；按 `typst.toml` → 会话 workspace（当它包含该文件）→ 文件目录的顺序定根；就绪后才向 tab 报成功。 |
| `src/host/highlight.ts` | 用 `tinymist lsp` 做 Typst 语法高亮：把 `semanticTokens/full` 的答案解成逐行的 `[start, end, classIndex, styleBits]` 游程（UTF-16 偏移），浏览器端只负责画 span，不用往包里塞语法文件。每个项目根一个语言服务器，文件按内容哈希缓存，所以翻页不再请求 token；位置编码是被**断言**为 UTF-16 而不是假设的——游程索引的是 JS 字符串，UTF-8 偏移会把中文行切错字。应用自带的静态高亮器做不了这件事：它的 shiki 只带一张固定语法表，里面没有 Typst。 |
| `src/host/proxy.ts` | HTTP 透传（前缀剥离，强制 `accept-encoding: identity` 以保证改写 HTML 安全），只改页面里一处：`new URL("/", window.location.href)`——那是页面里唯一的绝对地址——改写成该实例的 WebSocket 路由。WebSocket 握手与帧双向原样中继。 |
| `src/client/index.tsx`（浏览器） | 两阶段注册（类型进 `ctx.sidebarRightTabs`，正文进 keyed 席位 `sidebar.right.pane.tab`）。源码面先问 `POST …/source`，取不到高亮时退回 `ctx.remote.workspaceFiles.read`（分页纯文本）+ 自带代码渲染器，所以这一面永远有内容可看。token 类名映射到外壳自己的 `--shiki-*` 变量，明暗两套主题都由应用提供。文案中英双语。 |

因为宿主半与浏览器半都通过 DSH 自己的 origin 访问 `tinymist`，本机、局域网、隧道访问都能用，不需要额外暴露端口。

一个写这类插件要记住的 DSH 细节：`workspaceFiles.read` 这类 Remote 方法返回的是**结果信封**（`{ ok: true, value }` / `{ ok: false, error }`），不是裸 payload；浏览器半在 inject face 里拆封，并把失败抛成异常。

## 验证

两个脚本都对着**真 tinymist** 跑，不 mock：

```sh
# 宿主半：起 apply() → 假 web server（同 exact/prefix/upgrade 派发语义）→ 真进程
node scripts/smoke.mjs
#   open 起进程 / 页面代理且 WS 地址被重写 / WebSocket 中继收到真实帧 /
#   重复 open 复用实例 / source 返回文本 + token 游程（含分页窗口与失败回退）/
#   close 回收 / 未知页面 token 回一张可读的页面而不是 JSON / 跨站请求被拒 —— 20/20

# 宿主半：预览进程池 vs 操作系统进程表
node scripts/leak-check.mjs
#   同一文件并发两次 open 共享同一 token 与同一个子进程 / LRU 淘汰真的杀掉了进程 /
#   从实例表里被移除的子进程仍可 close、仍被计入 / 回收器收走游离子进程、
#   但放过仍持有 socket 的预览 / dispose 之后一个不剩 —— 15/15

# 浏览器半：按外壳的方式加载构建好的客户端包，用 React 静态渲染真高亮结果
node scripts/render-check.mjs
#   真 tinymist 页面 → 每行一行、带行号；#set 是 keyword span；*加粗* 带 style 位；
#   中文注释逐字对上；文件每一行逐字符还原 —— 8/8

# 浏览器半：无头 Chrome + CDP 驱动一个跑着的 DSH Web
printf '= Probe\nHello $x^2$\n' > /path/to/workspace/probe-typst.typ
node scripts/gui-check.mjs "http://127.0.0.1:3080/?token=…" probe-typst.typ
#   客户端包被加载、右侧栏打开、Files 里点 .typ 落到本插件的 tab、
#   iframe 指向 /api/typst-preview/p/<token>/、宿主返回带重写 WS 的真页面、
#   源码面读到文本、切回预览 iframe 仍在、无 typst 相关 console 错误 —— 14/14
```

`gui-check.mjs` 会在失败时打印诊断（面板文本、只读快照 `globalThis.__dshTypstDebug`、一次直接 `open` 的往返结果）。

## 已知边界

- **只读**：源码面是查看器，不是编辑器；编辑仍由 agent 的写入工具或外部编辑器完成，预览会自动跟上。
- 右侧栏 tab 状态只在内存：刷新后回到折叠态（这是原生侧边栏本身的行为）。
- 每个文件一个 `tinymist` 进程：上限 `maxInstances`，超出按最近使用淘汰；端口由宿主挑，不占固定 23625。
- `--invert-colors` 的 `auto` 由 tinymist 自己解释；DSH 深色主题下若不合意，用工具栏切到「反色」。
- 只认 `dsh-resource://file/**` 里的 `.typ`（大小写不敏感）；工作区外的文件走 `absolute` 地址同样可用。

## 许可

MIT
