import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
/**
* Terminate a child and wait for it to release its ports before the next spawn.
*
* The exit check reads the process handle, not only the manager's own flag: a
* child that is still running must never be treated as already gone, because that
* is the one mistake that leaves a hundred-megabyte compiler behind with nothing
* left in the process to reach it.
*/
function stopProcess(instance) {
	const proc = instance.proc;
	if (instance.exited || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
	if (proc.pid === void 0) {
		instance.exited = true;
		return Promise.resolve();
	}
	return new Promise((settle) => {
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
			settle();
		}, 3e3);
		proc.once("exit", () => {
			clearTimeout(timer);
			settle();
		});
		try {
			proc.kill("SIGTERM");
		} catch {
			clearTimeout(timer);
			settle();
		}
	});
}
/** How often the reaper looks for work. */
const REAP_INTERVAL_MS = 3e4;
/**
* How long a child that no longer belongs to any key may live. A spawn that is
* still waiting for its first page is younger than this, so the reaper cannot
* kill a preview that is merely slow to come up.
*/
const ORPHAN_GRACE_MS = 6e4;
/**
* The live preview servers this plugin owns.
*
* Three maps, because a compiler process is far too expensive to lose track of:
*
*  - `instances` — the reusable previews, keyed by session × file × color mode,
*    which is what `open` serves and what the LRU cap counts;
*  - `spawned` — **every** child this manager has started, keyed by token. This is
*    the set `close`, the reaper and `dispose` act on, so a child stays reachable
*    even after it leaves `instances` for any reason;
*  - `spawning` — the spawns in flight, keyed like `instances`. Two tabs opened on
*    the same file at the same moment (a remount, a second pane, a reload racing
*    the first request) used to see an empty `instances` and each start their own
*    `tinymist preview`; the loser of that race was overwritten in the map and
*    leaked for the lifetime of the app — a leak of ~600 MB per click. Sharing the
*    pending promise makes one file mean one process.
*/
var TinymistPreviews = class {
	options;
	binary;
	instances = /* @__PURE__ */ new Map();
	spawned = /* @__PURE__ */ new Map();
	spawning = /* @__PURE__ */ new Map();
	/** Last resort: a graceful host exit must not orphan compilers. */
	onExit = () => {
		for (const instance of this.spawned.values()) try {
			instance.proc.kill("SIGKILL");
		} catch {}
	};
	reaper;
	disposed = false;
	constructor(options) {
		this.options = options;
		this.binary = resolveTinymistPath(options.tinymistPath);
		process.once("exit", this.onExit);
	}
	/** The executable actually spawned, for diagnostics. */
	get executable() {
		return this.binary;
	}
	/** Every live instance, newest use first. */
	list() {
		return [...this.instances.values()].sort((a, b) => b.lastUsed - a.lastUsed);
	}
	/** How many children this manager is responsible for, live previews or not. */
	get processCount() {
		return this.spawned.size;
	}
	/** The instance a proxy path names; a child being retired still answers. */
	byToken(token) {
		return this.spawned.get(token);
	}
	/** Start the idle reaper; the returned callback stops it. */
	startReaper() {
		if (this.reaper !== void 0) return () => {};
		this.reaper = setInterval(() => {
			this.reap();
		}, REAP_INTERVAL_MS);
		this.reaper.unref?.();
		return () => {
			if (this.reaper !== void 0) clearInterval(this.reaper);
			this.reaper = void 0;
		};
	}
	/**
	* One reaping pass, with three jobs:
	*
	*  1. a child no key claims any more — closed, evicted, or abandoned by a
	*     dropped request — is killed, because nothing else can ever reach it;
	*  2. an active child nobody has touched for the whole idle window is killed;
	*  3. the total number of children is capped, so a bug can cost this process a
	*     few hundred megabytes for half a minute, never for the rest of the day.
	*/
	async reap() {
		if (this.disposed) return;
		const now = Date.now();
		for (const instance of [...this.spawned.values()]) {
			if (!(this.instances.get(instance.key) === instance)) {
				if (now - instance.startedAt > ORPHAN_GRACE_MS) await this.stop(instance);
				continue;
			}
			if (instance.sockets > 0) continue;
			if (instance.lastUsed < now - this.options.idleTimeoutMs) await this.stop(instance);
		}
		const ceiling = Math.max(2, this.options.maxInstances * 2);
		while (this.spawned.size > ceiling) {
			const children = [...this.spawned.values()];
			const victim = children.filter((child) => this.instances.get(child.key) !== child).sort((a, b) => a.lastUsed - b.lastUsed)[0] ?? children.sort((a, b) => a.lastUsed - b.lastUsed)[0];
			if (victim === void 0) return;
			await this.stop(victim);
		}
	}
	/** Reuse a live preview of the same file, or start one. */
	async open(request) {
		if (this.disposed) throw new Error("预览管理器已停止");
		const file = resolveInput(request.file, request.cwd);
		const invert = normalizeInvert(request.invert);
		const key = `${request.sessionId ?? ""}\u0000${file}\u0000${invert}`;
		const existing = this.instances.get(key);
		if (existing !== void 0 && !existing.exited) {
			existing.lastUsed = Date.now();
			return existing;
		}
		if (existing !== void 0) this.instances.delete(key);
		const inFlight = this.spawning.get(key);
		if (inFlight !== void 0) return inFlight;
		const started = this.startSpawn(key, file, invert, request.cwd);
		this.spawning.set(key, started);
		try {
			const instance = await started;
			instance.lastUsed = Date.now();
			this.instances.set(key, instance);
			return instance;
		} finally {
			if (this.spawning.get(key) === started) this.spawning.delete(key);
		}
	}
	/** Evict down to the cap, then start the child; a thin async body for {@link open}. */
	startSpawn(key, file, invert, cwd) {
		const run = async () => {
			await this.reapBeyondLimit();
			return this.spawn(key, file, invert, cwd);
		};
		return run();
	}
	/** Stop one preview by token; unknown or already stopped tokens are a no-op. */
	async close(token) {
		const instance = this.spawned.get(token);
		if (instance === void 0) return false;
		await this.stop(instance);
		return true;
	}
	/** Stop everything and stop listening for new work; used on plugin disposal. */
	async dispose() {
		this.disposed = true;
		process.removeListener("exit", this.onExit);
		const live = [...this.spawned.values()];
		this.instances.clear();
		this.spawned.clear();
		this.spawning.clear();
		await Promise.all(live.map((instance) => stopProcess(instance)));
	}
	/** Retire one child: out of every map first, then out of the process table. */
	async stop(instance) {
		this.spawned.delete(instance.token);
		if (this.instances.get(instance.key) === instance) this.instances.delete(instance.key);
		await stopProcess(instance);
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
		if (this.disposed) throw new Error("预览管理器已停止");
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
			sockets: 0,
			exited: false,
			proc
		};
		this.spawned.set(instance.token, instance);
		proc.once("error", () => {
			instance.exited = true;
			this.spawned.delete(instance.token);
			if (this.instances.get(key) === instance) this.instances.delete(key);
			try {
				proc.kill("SIGKILL");
			} catch {}
		});
		proc.once("exit", () => {
			instance.exited = true;
			this.spawned.delete(instance.token);
			if (this.instances.get(key) === instance) this.instances.delete(key);
		});
		try {
			await waitForReady(dataPort, this.options.readyTimeoutMs, () => !instance.exited);
			if (this.disposed) throw new Error("预览管理器已停止");
			return instance;
		} catch (error) {
			await this.stop(instance);
			throw error;
		}
	}
};
/** Fold an arbitrary client string onto the three accepted color modes. */
function normalizeInvert(value) {
	return value === "auto" || value === "always" ? value : "never";
}
//#endregion
export { DEFAULT_OPTIONS, TinymistPreviews, resolveInput, resolveRoot, resolveTinymistPath };
