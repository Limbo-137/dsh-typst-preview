# dsh-typst-preview

DeepSeek Harness Web UI **原生右侧边栏里的 Typst 实时预览**：在右侧边栏里点开一个 `.typ` 文件，就是一个带「预览 / 源码」开关的 tab，形态与内置的 Markdown 预览一致。

English: [README.md](README.md)。

## 它长什么样

右侧边栏 → **Files** → 点一个 `.typ`：

- **预览**：`tinymist preview` 渲染的页面，走 WebSocket 推送，改文件即重编译。工具栏三个按钮：重新载入、配色（原始 / 跟随系统 / 反色，记在 `localStorage`）、在新标签页打开。
- **源码**：同一 tab 内切成源码，**语法高亮取自 `tinymist` 自己的语义 token**（标题、关键字、函数、字符串、公式、标签、注释，以及 `*加粗*`／`_斜体_` 标记），带行号、复制，大文件带「加载更多」。配色直接用应用自身的代码块色板（`--shiki-*`），所以 `.typ` 源码与 Markdown 代码块看起来是一套。取不到高亮时——没有 `tinymist`、文件超过体积上限、或 `highlight: false`——退回原生代码渲染器 + 宿主分页读取，与加高亮之前完全一致。

两个面始终挂载，切到源码再切回来**不会**销毁预览进程：后台仍在编译，切回是瞬时的。

默认预览面来自类型注册的 `priority: 'extension'`（高于随包的纯文本 `fallback` 查看器）。想让 `.typ` 回到原生文本预览，把 `src/client/index.tsx` 里 `typstTabDefinition()` 的 `priority` 改成 `'fallback'`，再从别处显式 `openResource(address, { kind: 'typst-preview' })`。

## 依赖

- **DSH `>= 0.1.5-rc.1`**：本插件在原生右侧边栏上注册 tab 类型（`ctx.sidebarRightTabs`），正文挂进 `sidebar.right.pane.tab` 席位。
- **`tinymist`**：先查 `PATH`，再查 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.cargo/bin`；用 `tinymistPath` 可覆盖。
- 本插件的前身（`~/.dsh/plugins/dsh-typst-preview`，挂在 `dsh-better-sidebar` 的文件查看器上）与 0.1.5 不兼容，已被本插件取代。

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
#   close 回收 / 跨站请求被拒 —— 19/19

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

## 中文（以及任何非拉丁文字）

Typst 默认字体是拉丁字体，没有设字体的中文文档会渲染成一串空框——在这个预览里、在 `typst compile` 里、在任何地方都一样。这是**文档**属性而不是插件属性：在文件里（或它 import 的 preamble 里）设好字体，两个面都会跟上。

```typst
#set text(font: ("New Computer Modern", "Songti SC", "STSong", "Source Han Sans SC", "SimSun"))
```

`typst fonts` 可以列出本机可用字体；macOS 上 `Songti SC` / `PingFang SC` / `Heiti SC` 一定在。字体栈让拉丁字体负责公式与英文，中文由后面的字体兜底。装不到系统里的字体用 `extraArgs: ['--font-path', '…']`。要让中文预览有意义，入口文件必须像 `typst compile` 一样在内容之前设好它。

## 已知边界

- **只读**：源码面是查看器，不是编辑器；编辑仍由 agent 的写入工具或外部编辑器完成，预览会自动跟上。
- 右侧栏 tab 状态只在内存：刷新后回到折叠态（这是原生侧边栏本身的行为）。
- 每个文件一个 `tinymist` 进程：上限 `maxInstances`，超出按最近使用淘汰；端口由宿主挑，不占固定 23625。
- `--invert-colors` 的 `auto` 由 tinymist 自己解释；DSH 深色主题下若不合意，用工具栏切到「反色」。
- 只认 `dsh-resource://file/**` 里的 `.typ`（大小写不敏感）；工作区外的文件走 `absolute` 地址同样可用。

## 许可

MIT
