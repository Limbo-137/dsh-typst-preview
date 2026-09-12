/**
 * Browser half of the preview transport.
 *
 * The host owns one process per file; the browser only says which file it is
 * looking at and lets go when the last tab of that file does. Reference counting
 * lives here rather than in the component because a tab body is mounted,
 * unmounted and remounted around React strict mode and pane switches, and a
 * process per remount would both leak and fight for ports. A release is
 * therefore deferred, and cancels itself if the tab comes back.
 */
/** One open request, as the host route expects it. */
export interface OpenPreviewRequest {
    /** Absolute path when the file's metadata is known, else the address path. */
    readonly file: string;
    /** Session workspace directory, the project-root fallback. */
    readonly cwd: string | undefined;
    readonly sessionId: string | undefined;
    readonly invert: InvertMode;
}
/** Color handling, mirrored from the host's flag. */
export type InvertMode = 'never' | 'auto' | 'always';
/** The host's answer to an open request. */
export interface OpenPreviewResult {
    readonly ok: boolean;
    readonly token?: string;
    readonly url?: string;
    readonly ws?: string;
    readonly file?: string;
    readonly root?: string;
    readonly error?: string;
}
/**
 * Take a reference on one file's preview, starting it on the first reference.
 * @param key - reuse identity: absolute file plus color mode.
 * @param request - what to start when nothing is running.
 * @returns the host's answer, shared by every reference taken on this key.
 */
export declare function acquirePreview(key: string, request: OpenPreviewRequest): Promise<OpenPreviewResult>;
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
export declare function refreshPreview(key: string, request: OpenPreviewRequest): Promise<OpenPreviewResult>;
/**
 * Drop one reference; the last one stops the preview after a short grace.
 * @param key - the identity passed to {@link acquirePreview}.
 */
export declare function releasePreview(key: string): void;
/** Stop holding anything: used when the plugin unloads. */
export declare function releaseAllPreviews(): void;
//# sourceMappingURL=preview-client.d.ts.map