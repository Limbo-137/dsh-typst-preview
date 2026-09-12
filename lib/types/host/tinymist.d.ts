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
import { type ChildProcess } from 'node:child_process';
/** Color handling handed to tinymist's `--invert-colors`. */
export type InvertColors = 'never' | 'auto' | 'always';
/** Deployment knobs for the preview manager. */
export interface TinymistOptions {
    /** Executable name or absolute path; a bare name is resolved through PATH. */
    readonly tinymistPath: string;
    /** Extra arguments inserted before the input file. */
    readonly extraArgs: readonly string[];
    /** Live previews kept at once; the least recently used one is reaped past it. */
    readonly maxInstances: number;
    /** How long a freshly spawned server may take to answer its first request. */
    readonly readyTimeoutMs: number;
    /** How long an unused preview survives before the reaper stops it. */
    readonly idleTimeoutMs: number;
}
/** Defaults used when the plugin row declares no config. */
export declare const DEFAULT_OPTIONS: TinymistOptions;
/** What the browser half asks for. */
export interface OpenPreviewRequest {
    /** The `.typ` file: absolute, or relative to `cwd`. */
    readonly file: string;
    /** Session workspace directory, the fallback project root. */
    readonly cwd: string | undefined;
    /** Session identity, for diagnostics and process keying. */
    readonly sessionId: string | undefined;
    /** Color handling; anything unrecognized means `never`. */
    readonly invert: string | undefined;
}
/** One live `tinymist preview` server. */
export interface PreviewInstance {
    /** URL-safe identity used in the proxy paths the browser half is given. */
    readonly token: string;
    /** Internal reuse key: session, absolute file, color mode. */
    readonly key: string;
    readonly file: string;
    readonly root: string;
    readonly dataPort: number;
    readonly controlPort: number;
    readonly invert: InvertColors;
    readonly args: readonly string[];
    readonly startedAt: number;
    lastUsed: number;
    /** Open WebSocket relays: the browser is holding this preview on screen. */
    sockets: number;
    exited: boolean;
    readonly proc: ChildProcess;
}
/** Absolute path of the input, refusing anything that is not an existing file. */
export declare function resolveInput(file: string, cwd: string | undefined): string;
/** Nearest ancestor with a `typst.toml`, else the workspace, else the file's directory. */
export declare function resolveRoot(file: string, cwd: string | undefined): string;
/** Resolve the executable once: PATH first, then the usual install locations. */
export declare function resolveTinymistPath(preferred: string): string;
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
export declare class TinymistPreviews {
    private readonly options;
    private readonly binary;
    private readonly instances;
    private readonly spawned;
    private readonly spawning;
    /** Last resort: a graceful host exit must not orphan compilers. */
    private readonly onExit;
    private reaper;
    private disposed;
    constructor(options: TinymistOptions);
    /** The executable actually spawned, for diagnostics. */
    get executable(): string;
    /** Every live instance, newest use first. */
    list(): readonly PreviewInstance[];
    /** How many children this manager is responsible for, live previews or not. */
    get processCount(): number;
    /** The instance a proxy path names; a child being retired still answers. */
    byToken(token: string): PreviewInstance | undefined;
    /** Start the idle reaper; the returned callback stops it. */
    startReaper(): () => void;
    /**
     * One reaping pass, with three jobs:
     *
     *  1. a child no key claims any more — closed, evicted, or abandoned by a
     *     dropped request — is killed, because nothing else can ever reach it;
     *  2. an active child nobody has touched for the whole idle window is killed;
     *  3. the total number of children is capped, so a bug can cost this process a
     *     few hundred megabytes for half a minute, never for the rest of the day.
     */
    private reap;
    /** Reuse a live preview of the same file, or start one. */
    open(request: OpenPreviewRequest): Promise<PreviewInstance>;
    /** Evict down to the cap, then start the child; a thin async body for {@link open}. */
    private startSpawn;
    /** Stop one preview by token; unknown or already stopped tokens are a no-op. */
    close(token: string): Promise<boolean>;
    /** Stop everything and stop listening for new work; used on plugin disposal. */
    dispose(): Promise<void>;
    /** Retire one child: out of every map first, then out of the process table. */
    private stop;
    private reapBeyondLimit;
    private spawn;
}
//# sourceMappingURL=tinymist.d.ts.map