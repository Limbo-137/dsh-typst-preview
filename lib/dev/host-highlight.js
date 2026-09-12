import { resolveInput, resolveRoot } from "./host-tinymist.js";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
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
export { DEFAULT_HIGHLIGHT_OPTIONS, TOKEN_CLASSES, TypstHighlighter, decodeTokens };
