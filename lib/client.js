window.__ModuleLoader__.load({
	id: "dsh-typst-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/address.ts
		/**
		* `dsh-resource://file/…` address parsing.
		*
		* The right Sidebar records a resource tab under the address it opened, so this
		* is where the tab body learns which file it is showing. Session-scoped
		* addresses carry `session/<sessionId>/<path>`; the path is absolute on POSIX
		* when it starts with `/`, otherwise workspace-relative. `absolute/<path>`
		* addresses carry no session, so the enclosing slot's session identity is the
		* fallback. Encoding is per segment, exactly as the address was built.
		*/
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
		/** One decoded path segment, or `undefined` when the address is malformed. */
		function decode(segment) {
			try {
				return decodeURIComponent(segment);
			} catch {
				return;
			}
		}
		/**
		* Read a file address back into its parts.
		* @param address - a candidate `dsh-resource://file/…` address.
		* @param fallbackSessionId - session identity used by session-less addresses.
		* @returns the parts, or `undefined` when the address is not a file address with a path.
		*/
		function parseFileAddress(address, fallbackSessionId) {
			if (!address.startsWith(FILE_ADDRESS_PREFIX)) return void 0;
			const end = address.search(/[?#]/);
			const [scope, ...tail] = address.slice(20, end === -1 ? void 0 : end).split("/");
			if (scope === "session") {
				const [id, ...segments] = tail;
				if (id === void 0 || id === "" || segments.length === 0) return void 0;
				const decodedId = decode(id);
				if (decodedId === void 0) return void 0;
				const parts = [];
				for (const segment of segments) {
					const value = decode(segment);
					if (value === void 0) return void 0;
					parts.push(value);
				}
				const path = parts.join("/");
				if (path === "") return void 0;
				return {
					sessionId: decodedId,
					path
				};
			}
			if (scope === "absolute") {
				const unc = tail[0] === "" && tail.length > 1;
				const segments = unc ? tail.slice(1) : tail;
				const parts = [];
				for (const segment of segments) {
					const value = decode(segment);
					if (value === void 0) return void 0;
					parts.push(value);
				}
				const joined = parts.join("/");
				if (joined === "") return void 0;
				return {
					sessionId: fallbackSessionId,
					path: unc ? `//${joined}` : `/${joined}`
				};
			}
		}
		/** The tab chip's text: the file's last segment, or the address when it has none. */
		function basenameOf(address) {
			const trimmed = (address.split(/[?#]/)[0] ?? address).replace(/\/+$/, "");
			const index = trimmed.lastIndexOf("/");
			const decoded = decode(index === -1 ? trimmed : trimmed.slice(index + 1));
			return decoded === void 0 || decoded === "" ? address : decoded;
		}
		//#endregion
		//#region src/client/base.ts
		/**
		* Resolve a host-issued path against the app's HTTP origin when it has one.
		* @param path - an absolute path the host answered with, e.g. `/api/typst-preview/p/<token>/`.
		* @returns the same path in a browser, or its absolute form under the desktop shell.
		*/
		function appUrl(path) {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
			if (typeof base !== "string" || base === "") return path;
			try {
				return new URL(path, base).href;
			} catch {
				return path;
			}
		}
		//#endregion
		//#region src/client/preview-client.ts
		const OPEN_URL = "/api/typst-preview/open";
		const CLOSE_URL = "/api/typst-preview/close";
		const STATUS_URL = "/api/typst-preview/status";
		/** Long enough to survive a strict-mode remount, short enough to free the port. */
		const RELEASE_DELAY_MS = 1500;
		const entries = /* @__PURE__ */ new Map();
		async function postJson(url, body) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				credentials: "same-origin"
			});
			const text = await response.text();
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = void 0;
			}
			if (parsed !== void 0 && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
			return {
				ok: false,
				error: `HTTP ${response.status}`
			};
		}
		function failureOf(error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
		/**
		* Take a reference on one file's preview, starting it on the first reference.
		* @param key - reuse identity: absolute file plus color mode.
		* @param request - what to start when nothing is running.
		* @returns the host's answer, shared by every reference taken on this key.
		*/
		function acquirePreview(key, request) {
			const existing = entries.get(key);
			if (existing !== void 0) {
				if (existing.timer !== void 0) {
					clearTimeout(existing.timer);
					existing.timer = void 0;
				}
				existing.count += 1;
				return existing.promise;
			}
			const entry = {
				count: 1,
				timer: void 0,
				promise: postJson(OPEN_URL, request).then((body) => ({
					ok: body.ok === true,
					token: typeof body.token === "string" ? body.token : void 0,
					url: typeof body.url === "string" ? body.url : void 0,
					ws: typeof body.ws === "string" ? body.ws : void 0,
					file: typeof body.file === "string" ? body.file : void 0,
					root: typeof body.root === "string" ? body.root : void 0,
					error: typeof body.error === "string" ? body.error : void 0
				})).catch(failureOf)
			};
			entries.set(key, entry);
			return entry.promise;
		}
		/**
		* Ask the host for this key's preview again, keeping the reference count.
		*
		* Used before a reload re-points an iframe at a cached URL: the token the tab
		* still holds may belong to an instance the host has already reaped (idle window,
		* LRU eviction, a crash), and a page request for a dead token answers with the
		* "already reaped" page. `open` is idempotent — a running instance is reused and
		* comes back with the same token, a dead one is started again — so this is the
		* cheap way to make a reload always valid.
		*
		* @param key - the identity passed to {@link acquirePreview}.
		* @param request - what to start when nothing is running.
		* @returns the host's current answer for this key.
		*/
		function refreshPreview(key, request) {
			const existing = entries.get(key);
			const promise = postJson(OPEN_URL, request).then((body) => ({
				ok: body.ok === true,
				token: typeof body.token === "string" ? body.token : void 0,
				url: typeof body.url === "string" ? body.url : void 0,
				ws: typeof body.ws === "string" ? body.ws : void 0,
				file: typeof body.file === "string" ? body.file : void 0,
				root: typeof body.root === "string" ? body.root : void 0,
				error: typeof body.error === "string" ? body.error : void 0
			})).catch(failureOf);
			if (existing !== void 0) {
				if (existing.timer !== void 0) {
					clearTimeout(existing.timer);
					existing.timer = void 0;
				}
				entries.set(key, {
					count: existing.count,
					timer: void 0,
					promise
				});
			}
			return promise;
		}
		/**
		* Drop one reference; the last one stops the preview after a short grace.
		* @param key - the identity passed to {@link acquirePreview}.
		*/
		function releasePreview(key) {
			const entry = entries.get(key);
			if (entry === void 0) return;
			entry.count -= 1;
			if (entry.count > 0 || entry.timer !== void 0) return;
			entry.timer = setTimeout(() => {
				const live = entries.get(key);
				if (live === void 0 || live.count > 0) return;
				entries.delete(key);
				live.promise.then((result) => {
					if (result.ok && result.token !== void 0) return postJson(CLOSE_URL, { token: result.token });
				}).catch(() => void 0);
			}, RELEASE_DELAY_MS);
		}
		/** Stop holding anything: used when the plugin unloads. */
		function releaseAllPreviews() {
			for (const [key, entry] of [...entries]) {
				entries.delete(key);
				if (entry.timer !== void 0) clearTimeout(entry.timer);
				entry.promise.then((result) => {
					if (result.ok && result.token !== void 0) return postJson(CLOSE_URL, { token: result.token });
				}).catch(() => void 0);
			}
		}
		/**
		* Whether the host still lists this key's preview.
		*
		* The page inside the iframe only ever retries the token it was loaded with, so a
		* preview that disappears while its tab stays open — the instance cap evicting it, a
		* crash, the idle reaper on an instance whose socket had already dropped — leaves
		* that tab retrying a dead token forever with nothing on screen to say so. Asking
		* costs one small same-origin GET.
		*
		* @param key - the identity passed to {@link acquirePreview}.
		* @returns `false` only when the host answered and this key's token was not in it;
		*          `undefined` when there is nothing to ask about, or the answer is unusable,
		*          which must never be read as "gone".
		*/
		async function previewAlive(key) {
			const entry = entries.get(key);
			if (entry === void 0) return void 0;
			const result = await entry.promise.catch(() => void 0);
			if (result === void 0 || !result.ok || result.token === void 0) return void 0;
			try {
				const response = await fetch(STATUS_URL, { credentials: "same-origin" });
				if (!response.ok) return void 0;
				const list = (await response.json()).instances;
				if (!Array.isArray(list)) return void 0;
				return list.some((instance) => instance.token === result.token);
			} catch {
				return;
			}
		}
		//#endregion
		//#region src/client/source-client.ts
		const SOURCE_URL = "/api/typst-preview/source";
		/** Read one numeric field off an untyped response body. */
		function numberAt(body, key, fallback) {
			const value = body[key];
			return typeof value === "number" && Number.isFinite(value) ? value : fallback;
		}
		/** Read one string field off an untyped response body. */
		function stringAt(body, key) {
			const value = body[key];
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		/**
		* Ask the host for one highlighted page.
		* @param request - the file and the page window.
		* @param signal - the tab's lifetime; an aborted fetch rejects.
		* @returns the page, or `ok: false` with the host's reason.
		*/
		async function fetchSourcePage(request, signal) {
			let body;
			try {
				const response = await fetch(SOURCE_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						file: request.file,
						cwd: request.cwd,
						offset: request.offset,
						limit: 800
					}),
					credentials: "same-origin",
					signal
				});
				const text = await response.text();
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = void 0;
				}
				if (parsed === void 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {
					ok: false,
					error: `HTTP ${response.status}`
				};
				body = parsed;
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
			if (body.ok !== true) return {
				ok: false,
				error: stringAt(body, "error") ?? "highlighting is unavailable"
			};
			const classes = Array.isArray(body.classes) ? body.classes.filter((name) => typeof name === "string") : [];
			const spans = Array.isArray(body.spans) ? body.spans : [];
			const offset = numberAt(body, "offset", request.offset);
			return {
				ok: true,
				page: {
					file: stringAt(body, "file") ?? request.file,
					offset,
					lines: numberAt(body, "lines", 0),
					eof: body.eof === true,
					nextOffset: numberAt(body, "nextOffset", offset + 1),
					text: typeof body.text === "string" ? body.text : "",
					classes,
					spans
				}
			};
		}
		//#endregion
		//#region src/client/index.tsx
		const NS = "dshTypstPreview";
		const zh = {
			"mode.preview": "预览",
			"mode.source": "源码",
			"mode.preview.aria": "Typst 实时预览",
			"mode.source.aria": "Typst 源码",
			"tool.reload": "重新载入预览",
			"tool.reread": "重新读取文件",
			"tool.invert": "预览配色",
			"tool.openExternal": "在新标签页打开预览",
			"tool.copyPath": "复制文件路径",
			"tool.copied": "已复制",
			"state.starting": "正在启动 Typst 预览…",
			"state.error": "Typst 预览启动失败",
			"state.retry": "重试",
			"state.reading": "正在读取…",
			"state.loadMore": "加载更多",
			"state.noAddress": "无法从这个地址确定文件。",
			"state.invert.never": "原始配色",
			"state.invert.auto": "跟随系统",
			"state.invert.always": "反色",
			"error.unknown": "未知错误",
			"code.copy": "复制",
			"code.copied": "已复制"
		};
		const en = {
			"mode.preview": "Preview",
			"mode.source": "Source",
			"mode.preview.aria": "Live Typst preview",
			"mode.source.aria": "Typst source",
			"tool.reload": "Reload the preview",
			"tool.reread": "Read the file again",
			"tool.invert": "Preview colors",
			"tool.openExternal": "Open the preview in a new tab",
			"tool.copyPath": "Copy the file path",
			"tool.copied": "Copied",
			"state.starting": "Starting the Typst preview…",
			"state.error": "The Typst preview could not start",
			"state.retry": "Retry",
			"state.reading": "Reading…",
			"state.loadMore": "Load more",
			"state.noAddress": "This address does not name a file.",
			"state.invert.never": "Original colors",
			"state.invert.auto": "Follow system",
			"state.invert.always": "Inverted",
			"error.unknown": "Unknown error",
			"code.copy": "Copy",
			"code.copied": "Copied"
		};
		const STYLE_ID = "dsh-typst-preview/TypstPreview.css";
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
`;
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-typst-preview";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		function IconRefresh() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M13.2 8A5.2 5.2 0 1 1 11.7 4.3",
					stroke: "currentColor",
					strokeWidth: "1.2",
					strokeLinecap: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M13.3 2.3v3.3H10",
					stroke: "currentColor",
					strokeWidth: "1.2",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})]
			});
		}
		function IconExternal() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M9.6 2.6h3.8v3.8",
						stroke: "currentColor",
						strokeWidth: "1.2",
						strokeLinecap: "round",
						strokeLinejoin: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M13.2 2.8 7.7 8.3",
						stroke: "currentColor",
						strokeWidth: "1.2",
						strokeLinecap: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M12 9.3v3.1c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6V5.6C2 4.7 2.7 4 3.6 4h3.1",
						stroke: "currentColor",
						strokeWidth: "1.2",
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				]
			});
		}
		function IconCopy() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "5.6",
					y: "5.6",
					width: "7.8",
					height: "7.8",
					rx: "1.6",
					stroke: "currentColor",
					strokeWidth: "1.2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M10.4 3.2H4.2c-.9 0-1.6.7-1.6 1.6v6.2",
					stroke: "currentColor",
					strokeWidth: "1.2",
					strokeLinecap: "round"
				})]
			});
		}
		function IconInvert() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "5.3",
					stroke: "currentColor",
					strokeWidth: "1.2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M8 2.7a5.3 5.3 0 0 1 0 10.6z",
					fill: "currentColor"
				})]
			});
		}
		/** This implementation's identity in the tab system, and its body's slot key. */
		const TYPST_TAB_ID = "dsh-typst-preview";
		/** The tab kind `openTab` names. */
		const TYPST_TAB_KIND = "typst-preview";
		/** Whether an address names a `.typ` file. */
		function isTypstAddress(address) {
			const path = address.split(/[?#]/)[0] ?? address;
			return /\.typ$/i.test(path);
		}
		/** The type's static face: it claims `.typ` files and nothing else. */
		function typstTabDefinition() {
			return {
				id: TYPST_TAB_ID,
				kind: TYPST_TAB_KIND,
				patterns: ["*.typ"],
				priority: "extension",
				canOpen: isTypstAddress,
				title: (address) => basenameOf(address),
				keepMounted: true
			};
		}
		const EMPTY_SOURCE = {
			status: "idle",
			chunks: [],
			highlighted: false,
			paged: false,
			nextOffset: 1,
			eof: false
		};
		const INVERT_STORAGE_KEY = "dsh-typst-preview:invert";
		const INVERT_CYCLE = [
			"never",
			"auto",
			"always"
		];
		/** How often a visible preview asks whether its instance is still there. */
		const LIVE_CHECK_MS = 5e3;
		function readStoredInvert() {
			try {
				const stored = globalThis.localStorage?.getItem(INVERT_STORAGE_KEY);
				if (stored === "never" || stored === "auto" || stored === "always") return stored;
			} catch {}
			return "never";
		}
		function storeInvert(mode) {
			try {
				globalThis.localStorage?.setItem(INVERT_STORAGE_KEY, mode);
			} catch {}
		}
		/** The tab: one toolbar, two faces, both fed by same-origin host routes. */
		function TypstPreviewTab(props) {
			const { sessionId, useTabInfo, useSessions, useResource, read, t } = props;
			const { tab, sidebar } = useTabInfo();
			const previewMounted = tab.visible !== false || sidebar.fullscreen;
			const meta = useResource(tab.contentId);
			const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
			const address = (0, react.useMemo)(() => parseFileAddress(tab.contentId, sessionId), [tab.contentId, sessionId]);
			const [face, setFace] = (0, react.useState)("preview");
			const [invert, setInvert] = (0, react.useState)(readStoredInvert);
			const [frameNonce, setFrameNonce] = (0, react.useState)(0);
			const [preview, setPreview] = (0, react.useState)({ status: "starting" });
			const [source, setSource] = (0, react.useState)(EMPTY_SOURCE);
			const [copied, setCopied] = (0, react.useState)(false);
			const absolutePath = meta.value?.absolutePath;
			const file = absolutePath ?? address?.path;
			const key = file === void 0 ? void 0 : `${file}\u0000${invert}`;
			/**
			* Re-ask the host for this file's preview and adopt its answer.
			*
			* Called before anything re-points the iframe at a cached URL — the toolbar's
			* reload, and coming back to a tab whose preview document was unmounted. A
			* preview can be gone by then (idle window with no socket held, the LRU cap
			* evicting this tab's instance, a crash), and the tab's cached token would load
			* the "already reaped" page instead of the document.
			*/
			function reopenPreview() {
				if (file === void 0 || key === void 0) return;
				refreshPreview(key, {
					file,
					cwd,
					sessionId,
					invert
				}).then((result) => {
					if (result.ok && result.url !== void 0) setPreview({
						status: "ready",
						url: result.url
					});
					else if (result.ok) setPreview({ status: "starting" });
					else setPreview({
						status: "error",
						error: result.error ?? translate.current("error.unknown")
					});
				});
			}
			const translate = (0, react.useRef)(t);
			translate.current = t;
			globalThis.__dshTypstDebug = {
				contentId: tab.contentId,
				sessionId,
				address,
				file,
				absolutePath,
				metaStatus: meta.status,
				face,
				preview,
				source,
				hasRead: typeof read === "function"
			};
			(0, react.useEffect)(() => {
				if (file === void 0 || key === void 0) return;
				let live = true;
				setPreview((previous) => previous.status === "ready" ? previous : { status: "starting" });
				acquirePreview(key, {
					file,
					cwd,
					sessionId,
					invert
				}).then((result) => {
					if (!live) return;
					setPreview(result.ok && result.url !== void 0 ? {
						status: "ready",
						url: result.url
					} : {
						status: "error",
						error: result.error ?? translate.current("error.unknown")
					});
				});
				return () => {
					live = false;
					releasePreview(key);
				};
			}, [
				file,
				key,
				cwd,
				sessionId,
				invert
			]);
			const latestPreview = (0, react.useRef)(preview);
			latestPreview.current = preview;
			const wasMounted = (0, react.useRef)(previewMounted);
			(0, react.useEffect)(() => {
				if (wasMounted.current === previewMounted) return;
				wasMounted.current = previewMounted;
				if (!previewMounted || latestPreview.current.url === void 0) return;
				reopenPreview();
			}, [previewMounted]);
			(0, react.useEffect)(() => {
				if (!previewMounted || key === void 0 || preview.status !== "ready") return;
				const timer = setInterval(() => {
					previewAlive(key).then((alive) => {
						if (alive !== false) return;
						reopenPreview();
						setFrameNonce((nonce) => nonce + 1);
					});
				}, LIVE_CHECK_MS);
				return () => clearInterval(timer);
			}, [
				key,
				preview.status,
				previewMounted
			]);
			(0, react.useEffect)(() => {
				if (face !== "source" || address === void 0 || source.status !== "idle") return;
				loadSource(address.sessionId, address.path, 1, false);
			}, [
				face,
				address?.sessionId,
				address?.path,
				source.status
			]);
			/** One highlighted page, or the switch to the paged reader on refusal. */
			function loadHighlighted(owner, path, offset, signal) {
				fetchSourcePage({
					file: file ?? path,
					cwd,
					offset
				}, signal).then((result) => {
					if (signal.aborted) return;
					if (!result.ok) {
						setSource((previous) => ({
							...previous,
							fallback: result.error,
							paged: false
						}));
						loadPaged(owner, path, offset, signal);
						return;
					}
					const page = result.page;
					setSource((previous) => ({
						status: "ready",
						chunks: offset <= 1 ? [{
							offset: page.offset,
							text: page.text,
							spans: page.spans
						}] : [...previous.chunks, {
							offset: page.offset,
							text: page.text,
							spans: page.spans
						}],
						classes: page.classes,
						highlighted: true,
						fallback: void 0,
						paged: false,
						nextOffset: page.nextOffset,
						eof: page.eof
					}));
				}).catch((error) => {
					if (signal.aborted) return;
					setSource((previous) => ({
						...previous,
						status: "error",
						fallback: error instanceof Error ? error.message : String(error),
						error: error instanceof Error ? error.message : String(error)
					}));
				});
			}
			/** One page from the host's plain-text reader; the pre-highlighting path. */
			function loadPaged(owner, path, offset, signal) {
				setSource((previous) => ({
					...previous,
					status: "loading",
					paged: true,
					error: void 0
				}));
				read(owner, path, offset, signal).then((page) => {
					if (signal.aborted) return;
					setSource((previous) => ({
						status: "ready",
						chunks: offset <= 1 ? [{
							offset,
							text: page.text
						}] : [...previous.chunks, {
							offset,
							text: page.text
						}],
						classes: void 0,
						highlighted: false,
						fallback: previous.fallback,
						paged: true,
						nextOffset: offset + Math.max(page.lines, 0),
						eof: page.eof
					}));
				}).catch((error) => {
					if (signal.aborted) return;
					setSource((previous) => ({
						...previous,
						status: "error",
						error: error instanceof Error ? error.message : String(error)
					}));
				});
			}
			/** Load one page of the source face, highlighted when the host can do it. */
			function loadSource(owner, path, offset, paged) {
				const signal = tab.signal;
				if (paged) {
					loadPaged(owner, path, offset, signal);
					return;
				}
				setSource((previous) => ({
					...previous,
					status: "loading",
					error: void 0
				}));
				loadHighlighted(owner, path, offset, signal);
			}
			const invertLabel = t(`state.invert.${invert}`);
			const sourceText = (0, react.useMemo)(() => source.chunks.map((chunk) => chunk.text).join("\n"), [source.chunks]);
			const hasText = sourceText !== "";
			function cycleInvert() {
				const next = INVERT_CYCLE[(INVERT_CYCLE.indexOf(invert) + 1) % INVERT_CYCLE.length] ?? "never";
				storeInvert(next);
				setInvert(next);
			}
			const tools = [];
			if (face === "preview") tools.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dshTypstPreview_tool",
				title: t("tool.reload"),
				"aria-label": t("tool.reload"),
				"data-typst-tool": "reload",
				disabled: preview.status !== "ready",
				onClick: () => {
					reopenPreview();
					setFrameNonce((value) => value + 1);
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRefresh, {})
			}, "reload"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dshTypstPreview_tool",
				title: `${t("tool.invert")}：${invertLabel}`,
				"aria-label": `${t("tool.invert")}：${invertLabel}`,
				"data-active": invert !== "never",
				"data-typst-tool": "invert",
				onClick: cycleInvert,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconInvert, {})
			}, "invert"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dshTypstPreview_tool",
				title: t("tool.openExternal"),
				"aria-label": t("tool.openExternal"),
				"data-typst-tool": "external",
				disabled: preview.status !== "ready",
				onClick: () => {
					if (preview.url !== void 0) globalThis.open(appUrl(preview.url), "_blank", "noopener");
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconExternal, {})
			}, "external"));
			else tools.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dshTypstPreview_tool",
				title: copied ? t("code.copied") : t("code.copy"),
				"aria-label": copied ? t("code.copied") : t("code.copy"),
				"data-typst-tool": "copy",
				disabled: !hasText,
				onClick: () => {
					copyText(sourceText).then((done) => {
						if (!done) return;
						setCopied(true);
						globalThis.setTimeout(() => setCopied(false), 1200);
					});
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCopy, {})
			}, "copy"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dshTypstPreview_tool",
				title: t("tool.reread"),
				"aria-label": t("tool.reread"),
				"data-typst-tool": "reread",
				onClick: () => setSource(EMPTY_SOURCE),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRefresh, {})
			}, "reread"));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshTypstPreview_root",
				"data-typst-preview": TYPST_TAB_ID,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshTypstPreview_bar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshTypstPreview_modes",
								role: "tablist",
								"aria-label": "Typst",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									className: "dshTypstPreview_mode",
									"data-active": face === "preview",
									"data-typst-face": "preview",
									"aria-selected": face === "preview",
									title: t("mode.preview.aria"),
									onClick: () => setFace("preview"),
									children: t("mode.preview")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									className: "dshTypstPreview_mode",
									"data-active": face === "source",
									"data-typst-face": "source",
									"aria-selected": face === "source",
									title: t("mode.source.aria"),
									onClick: () => setFace("source"),
									children: t("mode.source")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dshTypstPreview_path",
								title: file ?? tab.contentId,
								children: file ?? tab.contentId
							}),
							tools
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshTypstPreview_stage",
						"data-typst-stage": "preview",
						style: face === "preview" ? void 0 : { display: "none" },
						children: preview.status === "ready" && preview.url !== void 0 ? !previewMounted ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
							className: "dshTypstPreview_frame",
							"data-typst-frame": preview.url,
							src: `${appUrl(preview.url)}?r=${String(frameNonce)}`,
							title: file ?? t("mode.preview.aria")
						}, frameNonce) : preview.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshTypstPreview_overlay",
							"data-error": "true",
							"data-typst-stage": "error",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("state.error"),
								"：",
								preview.error
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshTypstPreview_action",
								"data-typst-tool": "retry",
								onClick: () => setFrameNonce((value) => value + 1),
								children: t("state.retry")
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshTypstPreview_overlay",
							"data-typst-stage": "starting",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("state.starting") })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshTypstPreview_source",
						"data-typst-stage": "source",
						style: face === "source" ? void 0 : { display: "none" },
						children: address === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshTypstPreview_overlay",
							"data-error": "true",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("state.noAddress") })
						}) : source.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshTypstPreview_overlay",
							"data-error": "true",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: source.error }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshTypstPreview_action",
								onClick: () => setSource(EMPTY_SOURCE),
								children: t("state.retry")
							})]
						}) : source.chunks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshTypstPreview_overlay",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("state.reading") })
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [source.highlighted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HighlightedSource, {
							chunks: source.chunks,
							classes: source.classes
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceText, {
							text: sourceText,
							copyLabel: t("code.copy"),
							copiedLabel: t("code.copied")
						}), !source.eof && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshTypstPreview_more",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshTypstPreview_action",
								"data-typst-tool": "more",
								disabled: source.status === "loading",
								onClick: () => {
									if (address !== void 0) loadSource(address.sessionId, address.path, source.nextOffset, source.paged);
								},
								children: t("state.loadMore")
							})
						})] })
					})
				]
			});
		}
		/** The source face's text: the shared code renderer, or a plain fallback. */
		function SourceText(props) {
			const { text, copyLabel, copiedLabel } = props;
			if (typeof _deepseek_ai_dsh_client_ui_primitives.CodeBlock === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.CodeBlock, {
				code: text,
				lang: "typst",
				lineNumbers: true,
				copyLabel,
				copiedLabel
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				className: "dshTypstPreview_plain",
				children: text
			});
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
		function HighlightedSource(props) {
			const { chunks, classes } = props;
			const names = classes ?? [];
			const rows = [];
			for (const chunk of chunks) {
				const lines = chunk.text.split("\n");
				for (let index = 0; index < lines.length; index += 1) {
					const line = lines[index] ?? "";
					rows.push(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshTypstPreview_row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshTypstPreview_ln",
							children: chunk.offset + index
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshTypstPreview_line",
							children: paint(line, chunk.spans?.[index], names)
						})]
					}, `${String(chunk.offset)}:${String(index)}`));
				}
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dshTypstPreview_code",
				"data-typst-code": "highlighted",
				children: rows
			});
		}
		/** One line's text, cut into painted runs with the plain gaps between them. */
		function paint(line, runs, classes) {
			if (runs === void 0 || runs.length === 0) return [line];
			const out = [];
			let cursor = 0;
			for (let i = 0; i + 3 < runs.length; i += 4) {
				const start = Math.max(0, Math.min(line.length, runs[i] ?? 0));
				const end = Math.max(start, Math.min(line.length, runs[i + 1] ?? 0));
				const name = classes[runs[i + 2] ?? -1];
				const style = runs[i + 3] ?? 0;
				if (start > cursor) out.push(line.slice(cursor, start));
				if (end > start && name !== void 0) out.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `dshTypstPreview_t-${name}${style === 0 ? "" : ` dshTypstPreview_s${String(style)}`}`,
					children: line.slice(start, end)
				}, `t${String(i)}`));
				cursor = Math.max(cursor, end);
			}
			if (cursor < line.length) out.push(line.slice(cursor));
			return out;
		}
		/** Copy text through the shell's clipboard helper, with a plain fallback. */
		async function copyText(text) {
			if (typeof _deepseek_ai_dsh_client_ui_primitives.writeClipboard === "function") try {
				return await (0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(text);
			} catch {}
			try {
				await globalThis.navigator?.clipboard?.writeText(text);
				return true;
			} catch {
				return false;
			}
		}
		/** Required browser services: the two registries, copy, and the Remote carrier. */
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs",
			"remote",
			"remote.workspaceFiles"
		];
		/**
		* Client plugin body: install the stylesheet, register the tab type, and
		* contribute the body under the type's own id — the same two-stage path every
		* shipped type walks.
		* @param ctx - client root context carrying the registries, copy, and Remote.
		*/
		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "typst-preview: dictionaries");
			ctx.effect(() => ctx.sidebarRightTabs.register(typstTabDefinition()), "typst-preview: tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TYPST_TAB_ID,
				locale: NS,
				inject: () => ({ read: async (sessionId, path, offset, signal) => {
					const result = await ctx.remote.workspaceFiles.read(sessionId, path, { offset }, signal);
					if (!result.ok) {
						const failure = result.error;
						throw new Error(failure?.message ?? failure?.code ?? "read failed");
					}
					return result.value;
				} })
			}, TypstPreviewTab)), "typst-preview: tab body");
			ctx.effect(() => () => releaseAllPreviews(), "typst-preview: preview references");
		}
		//#endregion
		exports.HighlightedSource = HighlightedSource;
		exports.TYPST_TAB_ID = TYPST_TAB_ID;
		exports.TYPST_TAB_KIND = TYPST_TAB_KIND;
		exports.TypstPreviewTab = TypstPreviewTab;
		exports.apply = apply;
		exports.inject = inject;
		exports.typstTabDefinition = typstTabDefinition;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map