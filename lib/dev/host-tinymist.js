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
export { DEFAULT_OPTIONS, TinymistPreviews, resolveRoot, resolveTinymistPath };
