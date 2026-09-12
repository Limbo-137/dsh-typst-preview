import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
//#region src/host/tinymist.ts
/**
* `tinymist preview` process management.
*
* One Typst file gets one preview server: `tinymist preview` binds a data plane
* (the page and its WebSocket) and a control plane, and both default to fixed
* ports, so two previews can only coexist when every instance is handed its own
* pair. That pair is picked here by binding two throwaway loopback listeners and
* releasing them, and the instance is keyed by session + file + color mode so a
* second tab of the same file reuses the running process instead of racing it
* for a port.
*
* The project root follows tinymist's own convention: the nearest ancestor
* directory carrying a `typst.toml`, else the Session workspace when the file
* lives inside it, else the file's own directory. A root that is too narrow
* only narrows what `@local`/absolute imports resolve against; it never blocks
* the preview.
*/
/** Defaults used when the plugin row declares no config. */
const DEFAULT_OPTIONS = {
	tinymistPath: "tinymist",
	extraArgs: [],
	maxInstances: 4,
	readyTimeoutMs: 2e4,
	idleTimeoutMs: 18e5
};
/** Absolute path of the input, refusing anything that is not an existing file. */
function resolveInput(file, cwd) {
	const trimmed = file.trim();
	if (trimmed === "") throw new Error("file required");
	const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd ?? process.cwd(), trimmed);
	const info = statSync(absolute, { throwIfNoEntry: false });
	if (info === void 0) throw new Error(`file not found: ${absolute}`);
	if (!info.isFile()) throw new Error(`not a regular file: ${absolute}`);
	return absolute;
}
/** Whether `child` sits inside `parent`, or is `parent` itself. */
function contains(parent, child) {
	if (child === parent) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}
/** Nearest ancestor with a `typst.toml`, else the workspace, else the file's directory. */
function resolveRoot(file, cwd) {
	let directory = dirname(file);
	const stop = resolve("/");
	for (;;) {
		if (existsSync(join(directory, "typst.toml"))) return directory;
		if (directory === stop) break;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	if (cwd !== void 0 && cwd.trim() !== "") {
		const workspace = resolve(cwd);
		if (contains(workspace, file)) return workspace;
	}
	return dirname(file);
}
/** Bind `count` loopback listeners at once so every returned port is distinct. */
function freePorts(count) {
	const servers = Array.from({ length: count }, () => new Promise((settle, fail) => {
		const server = createServer();
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => settle(server));
	}));
	return Promise.all(servers).then(async (listening) => {
		const ports = listening.map((server) => server.address().port);
		await Promise.all(listening.map((server) => new Promise((done) => server.close(() => done()))));
		return ports;
	});
}
/** Candidate locations a bare `tinymist` may hide in when PATH is thin. */
function fallbackCandidates() {
	const home = homedir();
	return [
		join(home, ".local", "bin", "tinymist"),
		"/opt/homebrew/bin/tinymist",
		"/usr/local/bin/tinymist",
		join(home, ".cargo", "bin", "tinymist")
	];
}
/** Resolve the executable once: PATH first, then the usual install locations. */
function resolveTinymistPath(preferred) {
	if (isAbsolute(preferred)) return preferred;
	for (const candidate of fallbackCandidates()) if (existsSync(candidate)) return candidate;
	return preferred;
}
/** Poll the data plane until it answers, so the iframe never races the spawn. */
function waitForReady(port, timeoutMs, isAlive) {
	return new Promise((settle, fail) => {
		const deadline = Date.now() + timeoutMs;
		const probe = () => {
			if (!isAlive()) {
				fail(/* @__PURE__ */ new Error("tinymist 进程已退出"));
				return;
			}
			const attempt = request({
				host: "127.0.0.1",
				port,
				path: "/",
				method: "GET"
			}, (response) => {
				response.resume();
				settle();
			});
			attempt.setTimeout(1e3, () => attempt.destroy());
			attempt.on("error", () => {
				if (Date.now() >= deadline) fail(/* @__PURE__ */ new Error(`tinymist 预览未在 ${timeoutMs}ms 内就绪`));
				else setTimeout(probe, 200);
			});
			attempt.end();
		};
		probe();
	});
}
/** Terminate a child and wait for it to release its ports before the next spawn. */
function stopProcess(instance) {
	if (instance.exited) return Promise.resolve();
	return new Promise((settle) => {
		const timer = setTimeout(() => {
			instance.proc.kill("SIGKILL");
			settle();
		}, 3e3);
		instance.proc.once("exit", () => {
			clearTimeout(timer);
			settle();
		});
		instance.proc.kill("SIGTERM");
	});
}
/** The live preview servers this plugin owns. */
var TinymistPreviews = class {
	options;
	binary;
	instances = /* @__PURE__ */ new Map();
	reaper;
	constructor(options) {
		this.options = options;
		this.binary = resolveTinymistPath(options.tinymistPath);
	}
	/** The executable actually spawned, for diagnostics. */
	get executable() {
		return this.binary;
	}
	/** Every live instance, newest use first. */
	list() {
		return [...this.instances.values()].sort((a, b) => b.lastUsed - a.lastUsed);
	}
	/** The instance a proxy path names. */
	byToken(token) {
		for (const instance of this.instances.values()) if (instance.token === token) return instance;
	}
	/** Start the idle reaper; the returned callback stops it. */
	startReaper() {
		if (this.reaper !== void 0) return () => {};
		this.reaper = setInterval(() => {
			const deadline = Date.now() - this.options.idleTimeoutMs;
			for (const instance of [...this.instances.values()]) if (instance.lastUsed < deadline) this.close(instance.token);
		}, 6e4);
		this.reaper.unref?.();
		return () => {
			if (this.reaper !== void 0) clearInterval(this.reaper);
			this.reaper = void 0;
		};
	}
	/** Reuse a live preview of the same file, or start one. */
	async open(request) {
		const file = resolveInput(request.file, request.cwd);
		const invert = normalizeInvert(request.invert);
		const key = `${request.sessionId ?? ""}\u0000${file}\u0000${invert}`;
		const existing = this.instances.get(key);
		if (existing !== void 0 && !existing.exited) {
			existing.lastUsed = Date.now();
			return existing;
		}
		if (existing !== void 0) this.instances.delete(key);
		await this.reapBeyondLimit();
		const instance = await this.spawn(key, file, invert, request.cwd);
		instance.lastUsed = Date.now();
		this.instances.set(key, instance);
		return instance;
	}
	/** Stop one preview by token; unknown or already stopped tokens are a no-op. */
	async close(token) {
		let target;
		for (const [key, instance] of this.instances) if (instance.token === token) {
			target = instance;
			this.instances.delete(key);
			break;
		}
		if (target === void 0) return false;
		await stopProcess(target);
		return true;
	}
	/** Stop everything; used on plugin disposal. */
	async dispose() {
		const live = [...this.instances.values()];
		this.instances.clear();
		await Promise.all(live.map((instance) => stopProcess(instance)));
	}
	async reapBeyondLimit() {
		while (this.instances.size >= Math.max(1, this.options.maxInstances)) {
			const oldest = this.list()[this.list().length - 1];
			if (oldest === void 0) return;
			await this.close(oldest.token);
		}
	}
	async spawn(key, file, invert, cwd) {
		const root = resolveRoot(file, cwd);
		const [dataPort, controlPort] = await freePorts(2);
		const args = [
			"preview",
			"--no-open",
			"--root",
			root,
			"--data-plane-host",
			`127.0.0.1:${dataPort}`,
			"--control-plane-host",
			`127.0.0.1:${controlPort}`,
			...invert === "never" ? [] : [`--invert-colors=${invert}`],
			...this.options.extraArgs,
			file
		];
		const proc = spawn(this.binary, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		proc.stdout?.on("data", () => {});
		proc.stderr?.on("data", () => {});
		const instance = {
			token: randomBytes(9).toString("hex"),
			key,
			file,
			root,
			dataPort,
			controlPort,
			invert,
			args,
			startedAt: Date.now(),
			lastUsed: Date.now(),
			exited: false,
			proc
		};
		proc.once("error", () => {
			instance.exited = true;
		});
		proc.once("exit", () => {
			instance.exited = true;
			if (this.instances.get(key) === instance) this.instances.delete(key);
		});
		try {
			await waitForReady(dataPort, this.options.readyTimeoutMs, () => !instance.exited);
		} catch (error) {
			await stopProcess(instance);
			throw error;
		}
		return instance;
	}
};
/** Fold an arbitrary client string onto the three accepted color modes. */
function normalizeInvert(value) {
	return value === "auto" || value === "always" ? value : "never";
}
//#endregion
//#region src/host/highlight.ts
/**
* Typst syntax highlighting for the source face, taken from tinymist itself.
*
* The app's shared code renderer (`@deepseek-ai/dsh-client-ui-primitives`'
* `CodeBlock`) drives one shiki core with a fixed grammar table, and Typst is not
* in it — so `lang="typst"` falls through to flat text. tinymist does publish
* `textDocument/semanticTokens/full` with a Typst-aware legend (heading, marker,
* label, ref, math, pol, raw, …), which is both the accurate palette and the
* engine that has already parsed the file for the preview next to it.
*
* One language server is kept per project root — the same root rule the preview
* fleet uses — and each file it has been asked about is cached by content hash,
* so paging through a long document costs one token request per edit rather than
* one per page. Token decoding happens here, not in the browser: what crosses the
* wire is per-line runs of `[start, end, classIndex, styleBits]` over UTF-16
* offsets, which is exactly what a `<span>` needs, and with no grammar or legend
* shipped into the client bundle.
*
* Position encoding is asserted rather than assumed: the runs index JavaScript
* strings, so a server that moved to UTF-8 would mis-slice non-ASCII lines
* silently and the whole feature would be worse than no colors.
*/
/**
* Token classes the browser half knows how to paint. The names are the contract
* between the halves: the host decodes a tinymist token type onto one of these,
* the client maps the name to a `--shiki-*` color, and an unknown name renders as
* plain text rather than as an invisible or miscolored run.
*/
const TOKEN_CLASSES = [
	"comment",
	"string",
	"raw",
	"keyword",
	"function",
	"number",
	"variable",
	"punctuation",
	"link",
	"error"
];
/**
* tinymist token type to class. Typst has no "variable" token type: `pol` is the
* polymorphic identifier slot the compiler puts names and parameters in, and it
* is the closest thing to one. Types left out (`text` above all) stay plain.
*/
const TYPE_CLASS = {
	comment: "comment",
	string: "string",
	raw: "raw",
	escape: "raw",
	keyword: "keyword",
	heading: "keyword",
	marker: "keyword",
	function: "function",
	decorator: "function",
	type: "function",
	namespace: "function",
	number: "number",
	bool: "number",
	pol: "variable",
	parameter: "variable",
	term: "variable",
	punct: "punctuation",
	operator: "punctuation",
	delim: "punctuation",
	link: "link",
	label: "link",
	ref: "link",
	error: "error"
};
/** Style bit for a run inside `*strong*` markup. */
const STYLE_STRONG = 1;
/** Style bit for a run inside `_emphasis_` markup. */
const STYLE_EMPH = 2;
/** How many token requests a freshly opened document may fail before it is flat. */
const TOKEN_ATTEMPTS = 8;
/** Delay between those attempts; tinymist normally answers on the first. */
const TOKEN_RETRY_MS = 60;
/** Cached files per language server; the least recently used one is dropped. */
const MAX_CACHED_FILES = 64;
/** Defaults used when the plugin row declares no highlight config. */
const DEFAULT_HIGHLIGHT_OPTIONS = {
	tinymistPath: "tinymist",
	extraArgs: [],
	maxServers: 2,
	requestTimeoutMs: 5e3,
	idleTimeoutMs: 6e5,
	maxFileBytes: 4194304
};
/** Turn one LSP semantic token type into the class it paints as, or `-1`. */
function classIndexOf(type) {
	if (type === void 0) return -1;
	const name = TYPE_CLASS[type];
	return name === void 0 ? -1 : TOKEN_CLASSES.indexOf(name);
}
/** Pack the legend's modifier bits into the run's style bits. */
function styleBitsOf(modifierBits, modifiers) {
	let bits = 0;
	for (let i = 0; i < modifiers.length; i += 1) {
		if ((modifierBits >> i & 1) === 0) continue;
		if (modifiers[i] === "strong") bits |= STYLE_STRONG;
		else if (modifiers[i] === "emph") bits |= STYLE_EMPH;
	}
	return bits;
}
/**
* Decode LSP relative-encoded semantic tokens into per-line run lists.
*
* Tokens carry a delta line and delta character, may be longer than their line (a
* raw block, a multi-line comment), and leave plain text uncovered — so a run
* that crosses a newline is split at the break, and the gaps are simply not
* covered. Neighbouring runs with the same class and style are merged, which is
* what keeps a thousands-of-tokens document to a few thousand spans.
*
* @param lines - the file's lines, already split on `\n`.
* @param data - the five-number tuples of a `semanticTokens/full` answer.
* @param legend - the server's token type and modifier names, in legend order.
* @returns one flat run list per line, index-aligned with `lines`.
*/
function decodeTokens(lines, data, legend) {
	const runs = lines.map(() => []);
	let line = 0;
	let character = 0;
	for (let i = 0; i + 4 < data.length; i += 5) {
		const deltaLine = data[i] ?? 0;
		const deltaStart = data[i + 1] ?? 0;
		const length = data[i + 2] ?? 0;
		const classIndex = classIndexOf(legend.types[data[i + 3] ?? -1]);
		const style = styleBitsOf(data[i + 4] ?? 0, legend.modifiers);
		line += deltaLine;
		character = deltaLine === 0 ? character + deltaStart : deltaStart;
		if (classIndex < 0 || length <= 0) continue;
		let remaining = length;
		let at = line;
		let offset = character;
		while (remaining > 0 && at < runs.length) {
			const width = (lines[at] ?? "").length;
			const take = Math.min(remaining, Math.max(0, width - offset));
			if (take > 0) runs[at].push(offset, offset + take, classIndex, style);
			remaining -= take;
			at += 1;
			offset = 0;
		}
	}
	return runs.map(mergeRuns);
}
/** Fuse neighbouring runs that paint identically, so the DOM stays small. */
function mergeRuns(flat) {
	const out = [];
	for (let i = 0; i + 3 < flat.length; i += 4) {
		const start = flat[i] ?? 0;
		const end = flat[i + 1] ?? 0;
		const classIndex = flat[i + 2] ?? 0;
		const style = flat[i + 3] ?? 0;
		const previous = out.length - 4;
		if (previous >= 0 && out[previous + 1] === start && out[previous + 2] === classIndex && out[previous + 3] === style) {
			out[previous + 1] = end;
			continue;
		}
		out.push(start, end, classIndex, style);
	}
	return out;
}
/** Hash a file's text for change detection; cheaper than comparing whole files. */
function hashOf(text) {
	return createHash("sha1").update(text, "utf8").digest("hex");
}
/** One LSP message header block ends here. */
const HEADER_END = "\r\n\r\n";
/**
* Start a language server for one project root and finish its handshake.
*
* Resolves only once `initialize` has been answered and `initialized` sent, so
* later requests never race the handshake — and refuses up front when the server
* offers no semantic tokens or a position encoding the decoder cannot use.
*
* @param binary - the tinymist executable.
* @param extraArgs - extra arguments, placed before the `lsp` subcommand.
* @param root - the project root the server is scoped to.
* @param timeoutMs - per-request ceiling.
*/
async function startServer(binary, extraArgs, root, timeoutMs) {
	const proc = spawn(binary, ["lsp", ...extraArgs], {
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		cwd: root
	});
	proc.stderr?.on("data", () => {});
	let buffer = Buffer.alloc(0);
	let sequence = 0;
	let dead = false;
	let legend = {
		types: [],
		modifiers: []
	};
	const files = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const failAll = (error) => {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	};
	proc.stdout?.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const end = buffer.indexOf(HEADER_END);
			if (end < 0) return;
			const header = buffer.subarray(0, end).toString("ascii");
			const match = /content-length:\s*(\d+)/i.exec(header);
			if (match === null) {
				buffer = buffer.subarray(end + 4);
				continue;
			}
			const length = Number(match[1]);
			if (buffer.length < end + 4 + length) return;
			const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
			buffer = buffer.subarray(end + 4 + length);
			let message;
			try {
				message = JSON.parse(body);
			} catch {
				continue;
			}
			if (message.id === void 0) continue;
			const entry = pending.get(message.id);
			if (entry === void 0) continue;
			pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error !== void 0) entry.reject(new Error(message.error.message ?? "language server error"));
			else entry.resolve(message.result);
		}
	});
	proc.once("exit", () => {
		dead = true;
		failAll(/* @__PURE__ */ new Error("language server exited"));
	});
	proc.once("error", (error) => {
		dead = true;
		failAll(error);
	});
	/** Write one framed message, or refuse when the server is gone. */
	const write = (payload) => {
		if (dead) throw new Error("language server is not running");
		const body = JSON.stringify(payload);
		proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = sequence += 1;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(/* @__PURE__ */ new Error(`${method} timed out`));
		}, timeoutMs);
		timer.unref?.();
		pending.set(id, {
			resolve,
			reject,
			timer
		});
		try {
			write({
				jsonrpc: "2.0",
				id,
				method,
				params
			});
		} catch (error) {
			clearTimeout(timer);
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const notify = (method, params) => {
		write({
			jsonrpc: "2.0",
			method,
			params
		});
	};
	const dispose = () => {
		dead = true;
		failAll(/* @__PURE__ */ new Error("language server stopped"));
		proc.kill("SIGTERM");
		setTimeout(() => proc.kill("SIGKILL"), 2e3).unref?.();
	};
	const capabilities = (await request("initialize", {
		processId: process.pid,
		clientInfo: { name: "dsh-typst-preview" },
		rootUri: pathToFileURL(root).href,
		workspaceFolders: [{
			uri: pathToFileURL(root).href,
			name: basename(root)
		}],
		capabilities: {
			textDocument: {
				synchronization: { dynamicRegistration: false },
				semanticTokens: {
					dynamicRegistration: false,
					tokenTypes: [],
					tokenModifiers: [],
					formats: ["relative"],
					requests: {
						range: false,
						full: true
					},
					multilineTokenSupport: true,
					overlappingTokenSupport: false
				}
			},
			workspace: { workspaceFolders: true }
		},
		initializationOptions: {}
	})).capabilities ?? {};
	const declared = capabilities.semanticTokensProvider?.legend;
	if (declared === void 0 || !Array.isArray(declared.tokenTypes)) {
		dispose();
		throw new Error("tinymist does not offer semantic tokens");
	}
	if (capabilities.positionEncoding !== void 0 && capabilities.positionEncoding !== "utf-16") {
		dispose();
		throw new Error(`unsupported position encoding: ${capabilities.positionEncoding}`);
	}
	legend = {
		types: declared.tokenTypes,
		modifiers: Array.isArray(declared.tokenModifiers) ? declared.tokenModifiers : []
	};
	notify("initialized", {});
	return {
		root,
		proc,
		files,
		request,
		notify,
		dispose,
		lastUsed: Date.now(),
		get legend() {
			return legend;
		},
		get dead() {
			return dead;
		}
	};
}
/**
* Request a file's runs from one server, reusing the cached decode when the text
* has not changed and re-sending the document when it has.
*/
async function runsFromServer(server, file, text, hash) {
	server.lastUsed = Date.now();
	const cached = server.files.get(file);
	if (cached !== void 0 && cached.hash === hash) return cached.runs;
	const uri = pathToFileURL(file).href;
	if (cached === void 0) server.notify("textDocument/didOpen", { textDocument: {
		uri,
		languageId: "typst",
		version: 1,
		text
	} });
	else server.notify("textDocument/didChange", {
		textDocument: {
			uri,
			version: cached.version + 1
		},
		contentChanges: [{ text }]
	});
	const lines = text.split("\n");
	let runs = lines.map(() => []);
	for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
		const result = await server.request("textDocument/semanticTokens/full", { textDocument: { uri } });
		const data = Array.isArray(result?.data) ? result.data : [];
		runs = decodeTokens(lines, data, server.legend);
		if (data.length > 0 || text.trim() === "") break;
		await new Promise((resolve) => setTimeout(resolve, TOKEN_RETRY_MS));
	}
	if (server.files.size >= MAX_CACHED_FILES) {
		const oldest = server.files.keys().next();
		if (!oldest.done) server.files.delete(oldest.value);
	}
	server.files.delete(file);
	server.files.set(file, {
		hash,
		version: (cached?.version ?? 0) + 2,
		runs
	});
	return runs;
}
/** The highlighter: a small pool of language servers, one per project root. */
var TypstHighlighter = class {
	entries = /* @__PURE__ */ new Map();
	options;
	reaper;
	/**
	* @param options - deployment knobs; omitted fields fall back to the defaults.
	*/
	constructor(options = {}) {
		this.options = {
			...DEFAULT_HIGHLIGHT_OPTIONS,
			...options
		};
	}
	/** Start the idle reaper; the returned function stops it. */
	startReaper() {
		if (this.reaper !== void 0) clearInterval(this.reaper);
		this.reaper = setInterval(() => {
			const deadline = Date.now() - this.options.idleTimeoutMs;
			for (const [root, entry] of [...this.entries]) {
				const server = entry.server;
				if (server !== void 0 && server.lastUsed < deadline) this.stop(root);
				else if (server === void 0) entry.promise.catch(() => this.entries.delete(root));
			}
		}, 6e4);
		this.reaper.unref?.();
		return () => {
			if (this.reaper !== void 0) clearInterval(this.reaper);
			this.reaper = void 0;
		};
	}
	/** What is running, for the status route. */
	list() {
		const rows = [];
		for (const entry of this.entries.values()) if (entry.server !== void 0) rows.push({
			root: entry.server.root,
			files: entry.server.files.size,
			lastUsed: entry.server.lastUsed
		});
		return rows;
	}
	/**
	* One page of a file, highlighted: the text of the lines plus the runs that
	* paint them.
	* @param request - the file, the root fallback, and the page window.
	*/
	async page(request) {
		const file = resolveInput(request.file, request.cwd);
		const root = resolveRoot(file, request.cwd);
		const info = statSync(file);
		if (info.size > this.options.maxFileBytes) throw new Error(`file is too large to highlight (${info.size} bytes)`);
		const text = readFileSync(file, "utf8");
		const runs = await runsFromServer(await this.server(root), file, text, hashOf(text));
		const lines = text.split("\n");
		const start = Math.max(0, Math.floor(Number.isFinite(request.offset) ? request.offset : 1) - 1);
		const limit = Math.max(1, Math.floor(Number.isFinite(request.limit) ? request.limit : 1));
		const end = Math.min(lines.length, start + limit);
		return {
			file,
			root,
			bytes: info.size,
			lineCount: lines.length,
			offset: start + 1,
			lines: end - start,
			eof: end >= lines.length,
			nextOffset: end + 1,
			text: lines.slice(start, end).join("\n"),
			classes: TOKEN_CLASSES,
			spans: runs.slice(start, end)
		};
	}
	/** Stop every language server; used on plugin disposal. */
	async dispose() {
		await Promise.all([...this.entries.keys()].map((root) => this.stop(root)));
	}
	async stop(root) {
		const entry = this.entries.get(root);
		if (entry === void 0) return;
		this.entries.delete(root);
		try {
			(await entry.promise).dispose();
		} catch {}
	}
	server(root) {
		const existing = this.entries.get(root);
		if (existing !== void 0) return existing.promise;
		this.reapBeyondLimit(root);
		const entry = {
			promise: void 0,
			server: void 0
		};
		entry.promise = startServer(this.options.tinymistPath, this.options.extraArgs, root, this.options.requestTimeoutMs).then((server) => {
			entry.server = server;
			return server;
		}).catch((error) => {
			this.entries.delete(root);
			throw error instanceof Error ? error : new Error(String(error));
		});
		this.entries.set(root, entry);
		return entry.promise;
	}
	async reapBeyondLimit(incoming) {
		const candidates = [...this.entries.keys()].filter((root) => root !== incoming);
		while (candidates.length + 1 > Math.max(1, this.options.maxServers)) {
			let oldestRoot;
			let oldest = Number.POSITIVE_INFINITY;
			for (const root of candidates) {
				const stamp = this.entries.get(root)?.server?.lastUsed ?? 0;
				if (stamp < oldest) {
					oldest = stamp;
					oldestRoot = root;
				}
			}
			if (oldestRoot === void 0) return;
			candidates.splice(candidates.indexOf(oldestRoot), 1);
			await this.stop(oldestRoot);
		}
	}
};
//#endregion
//#region src/host/proxy.ts
/**
* Reverse proxy for one `tinymist preview` data plane.
*
* The preview page is served from the app origin under a per-instance path, not
* from `127.0.0.1:<port>`, so a GUI opened on another machine (or through a
* tunnel) reaches it exactly as a local one does. Two things make that work:
*
*  - HTTP: everything the page asks for is forwarded to the instance's data
*    plane. The page itself is a single self-contained HTML document, and its
*    only absolute reference is the WebSocket URL it derives from
*    `window.location`. That one expression is rewritten to the per-instance
*    upgrade path, which is why the WebSocket can be same-origin too.
*  - Upgrade: `webServer.registerUpgrade` hands us the raw socket, so the
*    handshake is relayed verbatim in both directions and neither the
*    subprotocol nor the framing is interpreted here.
*/
/** The one absolute reference in tinymist's preview page. */
const WS_URL_EXPRESSION = "new URL(\"/\", window.location.href)";
/** Tolerant form, in case the page ships with different spacing. */
const WS_URL_PATTERN = /new URL\(\s*"\/"\s*,\s*window\.location\.href\s*\)/;
/** Headers that describe this hop and must not be forwarded. */
const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade"
];
/** Rewrite the preview page's WebSocket URL onto this instance's upgrade path. */
function patchPreviewHtml(html, wsPath) {
	const replacement = `new URL(${JSON.stringify(wsPath)}, window.location.href)`;
	if (html.includes(WS_URL_EXPRESSION)) return {
		html: html.replace(WS_URL_EXPRESSION, replacement),
		patched: true
	};
	if (WS_URL_PATTERN.test(html)) return {
		html: html.replace(WS_URL_PATTERN, replacement),
		patched: true
	};
	return {
		html,
		patched: false
	};
}
/** Copy client headers onto the upstream request. */
function forwardHeaders(req, port) {
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === void 0) continue;
		if (HOP_BY_HOP.includes(name.toLowerCase())) continue;
		headers[name] = value;
	}
	headers.host = `127.0.0.1:${port}`;
	headers["accept-encoding"] = "identity";
	return headers;
}
/** Forward one HTTP request to a preview data plane, optionally rewriting its HTML. */
function proxyHttp(port, req, res, options = {}) {
	const upstream = request({
		host: "127.0.0.1",
		port,
		method: req.method,
		path: options.path ?? req.url,
		headers: forwardHeaders(req, port)
	}, (response) => {
		const type = String(response.headers["content-type"] ?? "");
		if (options.rewriteHtml !== void 0 && type.toLowerCase().includes("text/html")) {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				const rewritten = options.rewriteHtml(Buffer.concat(chunks).toString("utf8"));
				const body = Buffer.from(rewritten.html, "utf8");
				const headers = {};
				for (const [name, value] of Object.entries(response.headers)) {
					if (value === void 0) continue;
					const lower = name.toLowerCase();
					if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") continue;
					headers[name] = value;
				}
				headers["content-length"] = String(body.length);
				res.writeHead(response.statusCode ?? 502, headers);
				res.end(body);
			});
			response.on("error", () => res.destroy());
			return;
		}
		res.writeHead(response.statusCode ?? 502, response.headers);
		response.pipe(res);
	});
	upstream.on("error", () => {
		if (!res.headersSent) {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end("typst preview: instance unreachable");
			return;
		}
		res.destroy();
	});
	res.on("close", () => upstream.destroy());
	req.pipe(upstream);
}
/** Relay one WebSocket handshake and its framed traffic to a preview data plane. */
function proxyWebSocket(port, req, socket, head, path = "/") {
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === void 0) continue;
		if (name.toLowerCase() === "host") continue;
		headers[name] = value;
	}
	headers.host = `127.0.0.1:${port}`;
	headers.connection = "Upgrade";
	headers.upgrade = "websocket";
	const upstream = request({
		host: "127.0.0.1",
		port,
		method: "GET",
		path,
		headers,
		agent: false
	});
	let settled = false;
	upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
		settled = true;
		const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`];
		for (const [name, value] of Object.entries(response.headers)) {
			if (value === void 0) continue;
			for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
		}
		socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (upstreamHead !== void 0 && upstreamHead.length > 0) socket.unshift(upstreamHead);
		upstreamSocket.on("error", () => socket.destroy());
		socket.on("error", () => upstreamSocket.destroy());
		upstreamSocket.pipe(socket);
		socket.pipe(upstreamSocket);
		const finish = () => {
			upstreamSocket.destroy();
			socket.destroy();
		};
		upstreamSocket.on("close", finish);
		socket.on("close", finish);
	});
	upstream.on("response", (response) => {
		settled = true;
		response.resume();
		socket.destroy();
	});
	upstream.on("error", () => {
		if (!settled) socket.destroy();
	});
	socket.on("close", () => upstream.destroy());
	upstream.end();
}
//#endregion
//#region src/index.ts
/** Required host services. */
const inject = ["webServer"];
const API = "/api/typst-preview";
const PAGE_PREFIX = `${API}/p/`;
const WS_PREFIX = `${API}/ws/`;
const BODY_LIMIT = 8192;
/** Merge declared config over the defaults. */
function optionsOf(config) {
	return {
		tinymistPath: config?.tinymistPath ?? DEFAULT_OPTIONS.tinymistPath,
		extraArgs: config?.extraArgs ?? DEFAULT_OPTIONS.extraArgs,
		maxInstances: config?.maxInstances ?? DEFAULT_OPTIONS.maxInstances,
		readyTimeoutMs: config?.readyTimeoutMs ?? DEFAULT_OPTIONS.readyTimeoutMs,
		idleTimeoutMs: config?.idleTimeoutMs ?? DEFAULT_OPTIONS.idleTimeoutMs
	};
}
/** Merge declared config over the highlighting defaults. */
function highlightOptionsOf(config, base) {
	return {
		tinymistPath: base.tinymistPath,
		extraArgs: base.extraArgs,
		maxServers: positive(config?.highlightMaxServers, DEFAULT_HIGHLIGHT_OPTIONS.maxServers),
		requestTimeoutMs: DEFAULT_HIGHLIGHT_OPTIONS.requestTimeoutMs,
		idleTimeoutMs: positive(config?.highlightIdleTimeoutMs, DEFAULT_HIGHLIGHT_OPTIONS.idleTimeoutMs),
		maxFileBytes: positive(config?.highlightMaxBytes, DEFAULT_HIGHLIGHT_OPTIONS.maxFileBytes)
	};
}
/** A declared positive number, else the default. */
function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** A declared positive integer, else the default. */
function pageLines(value) {
	return Math.max(1, Math.floor(positive(value, 800)));
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(Buffer.byteLength(payload)),
		"cache-control": "no-store",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Whether this request comes from the app itself rather than another site. */
function sameOrigin(req) {
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin !== "" && origin !== "null") try {
		if (new URL(origin).host !== req.headers.host) return false;
	} catch {
		return false;
	}
	return true;
}
/** Read a small JSON object body. */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > BODY_LIMIT) throw new Error("body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	const parsed = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be a JSON object");
	return parsed;
}
function stringField(body, key) {
	const value = body[key];
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
/** A finite numeric body field, or `undefined` when it is absent or unusable. */
function numberField(body, key) {
	const value = body[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** The instance a `/p/<token>/…` or `/ws/<token>` path names. */
function tokenOf(url, prefix) {
	if (url === void 0) return void 0;
	const path = url.split("?")[0] ?? "";
	if (!path.startsWith(prefix)) return void 0;
	const [token] = path.slice(prefix.length).split("/");
	return token === void 0 || token === "" ? void 0 : token;
}
/** The instance-local path behind one page URL: the prefix and token come off. */
function upstreamPathOf(url, token) {
	const raw = url ?? "/";
	const cut = `${PAGE_PREFIX}${token}`;
	if (!raw.startsWith(cut)) return "/";
	const rest = raw.slice(cut.length);
	if (rest === "") return "/";
	return rest.startsWith("/") ? rest : `/${rest}`;
}
/** Plugin body: own the fleet, claim the routes, release both on unload. */
function apply(ctx, config) {
	const webServer = ctx.webServer;
	if (webServer === void 0) throw new Error("dsh-typst-preview: webServer service is required");
	const options = optionsOf(config);
	const previews = new TinymistPreviews(options);
	const highlightEnabled = config?.highlight !== false;
	const highlighter = highlightEnabled ? new TypstHighlighter(highlightOptionsOf(config, options)) : void 0;
	const lineLimit = pageLines(config?.highlightLines);
	/** Upgrade route per live token; the socket owner is the instance itself. */
	const upgrades = /* @__PURE__ */ new Map();
	const releaseUpgrade = (token) => {
		const dispose = upgrades.get(token);
		if (dispose === void 0) return;
		upgrades.delete(token);
		dispose();
	};
	const claimUpgrade = (instance) => {
		if (upgrades.has(instance.token)) return;
		const path = `${WS_PREFIX}${instance.token}`;
		const dispose = webServer.registerUpgrade({
			path,
			handler: (req, socket, head) => {
				if (!sameOrigin(req)) {
					socket.destroy();
					return;
				}
				const live = previews.byToken(instance.token);
				if (live === void 0) {
					socket.destroy();
					return;
				}
				live.lastUsed = Date.now();
				proxyWebSocket(live.dataPort, req, socket, head);
			}
		});
		upgrades.set(instance.token, dispose);
	};
	const openRoute = {
		kind: "exact",
		path: `${API}/open`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			if (!sameOrigin(req)) {
				writeJson(res, 403, {
					ok: false,
					error: "cross-origin request refused"
				});
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				writeJson(res, 400, {
					ok: false,
					error: error instanceof Error ? error.message : "bad request"
				});
				return;
			}
			const file = stringField(body, "file");
			if (file === void 0) {
				writeJson(res, 400, {
					ok: false,
					error: "file is required"
				});
				return;
			}
			try {
				const instance = await previews.open({
					file,
					cwd: stringField(body, "cwd"),
					sessionId: stringField(body, "sessionId"),
					invert: stringField(body, "invert")
				});
				claimUpgrade(instance);
				writeJson(res, 200, {
					ok: true,
					token: instance.token,
					url: `${PAGE_PREFIX}${instance.token}/`,
					ws: `${WS_PREFIX}${instance.token}`,
					file: instance.file,
					root: instance.root,
					invert: instance.invert
				});
			} catch (error) {
				writeJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : "preview failed"
				});
			}
		}
	};
	const closeRoute = {
		kind: "exact",
		path: `${API}/close`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			if (!sameOrigin(req)) {
				writeJson(res, 403, {
					ok: false,
					error: "cross-origin request refused"
				});
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch {
				writeJson(res, 400, {
					ok: false,
					error: "bad request"
				});
				return;
			}
			const token = stringField(body, "token");
			if (token === void 0) {
				writeJson(res, 400, {
					ok: false,
					error: "token is required"
				});
				return;
			}
			releaseUpgrade(token);
			writeJson(res, 200, {
				ok: true,
				stopped: await previews.close(token)
			});
		}
	};
	const statusRoute = {
		kind: "exact",
		path: `${API}/status`,
		handler: (req, res) => {
			if (req.method !== "GET") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			if (!sameOrigin(req)) {
				writeJson(res, 403, {
					ok: false,
					error: "cross-origin request refused"
				});
				return;
			}
			writeJson(res, 200, {
				ok: true,
				executable: previews.executable,
				pagePrefix: PAGE_PREFIX,
				wsPrefix: WS_PREFIX,
				highlight: {
					enabled: highlightEnabled,
					lines: lineLimit,
					servers: highlighter?.list() ?? []
				},
				instances: previews.list().map((instance) => ({
					token: instance.token,
					file: instance.file,
					root: instance.root,
					invert: instance.invert,
					dataPort: instance.dataPort,
					controlPort: instance.controlPort,
					startedAt: instance.startedAt,
					lastUsed: instance.lastUsed,
					exited: instance.exited
				}))
			});
		}
	};
	const sourceRoute = {
		kind: "exact",
		path: `${API}/source`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			if (!sameOrigin(req)) {
				writeJson(res, 403, {
					ok: false,
					error: "cross-origin request refused"
				});
				return;
			}
			if (highlighter === void 0) {
				writeJson(res, 200, {
					ok: false,
					error: "highlighting is disabled"
				});
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				writeJson(res, 400, {
					ok: false,
					error: error instanceof Error ? error.message : "bad request"
				});
				return;
			}
			const file = stringField(body, "file");
			if (file === void 0) {
				writeJson(res, 400, {
					ok: false,
					error: "file is required"
				});
				return;
			}
			try {
				writeJson(res, 200, {
					ok: true,
					...await highlighter.page({
						file,
						cwd: stringField(body, "cwd"),
						offset: numberField(body, "offset") ?? 1,
						limit: numberField(body, "limit") ?? lineLimit
					})
				});
			} catch (error) {
				writeJson(res, 200, {
					ok: false,
					error: error instanceof Error ? error.message : "highlight failed"
				});
			}
		}
	};
	const pageRoute = {
		kind: "prefix",
		path: `${API}/p`,
		handler: (req, res) => {
			const token = tokenOf(req.url, PAGE_PREFIX);
			const instance = token === void 0 ? void 0 : previews.byToken(token);
			if (instance === void 0 || instance.exited) {
				writeJson(res, 404, {
					ok: false,
					error: "no such preview"
				});
				return;
			}
			instance.lastUsed = Date.now();
			const wsPath = `${WS_PREFIX}${instance.token}`;
			proxyHttp(instance.dataPort, req, res, {
				path: upstreamPathOf(req.url, instance.token),
				rewriteHtml: (html) => patchPreviewHtml(html, wsPath)
			});
		}
	};
	const disposers = [
		webServer.register(openRoute),
		webServer.register(closeRoute),
		webServer.register(statusRoute),
		webServer.register(sourceRoute),
		webServer.register(pageRoute)
	];
	const stopReaper = previews.startReaper();
	const stopHighlightReaper = highlighter?.startReaper();
	ctx.effect(() => () => {
		stopReaper();
		stopHighlightReaper?.();
		for (const dispose of disposers) dispose();
		for (const dispose of [...upgrades.values()]) dispose();
		upgrades.clear();
		highlighter?.dispose();
		previews.dispose();
	}, "typst-preview: routes, upgrade claims and preview processes");
}
//#endregion
export { apply, inject };
