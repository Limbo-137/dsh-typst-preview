/**
 * Where the app's own HTTP origin is, when the shell publishes one.
 *
 * In the browser this is a no-op: the shell and our routes are served by the same
 * server, so a path is already the right URL.
 *
 * The desktop app is different. Its window document comes from `dsh-app://app/`,
 * and while that scheme handler forwards plain requests to the HTTP host, a custom
 * scheme cannot carry a WebSocket. The shell says so itself:
 * `@deepseek-ai/dsh-api-gateway` builds its own socket from
 * `__DSH_TRANSPORT__.streamBaseUrl` rather than from `document.baseURI`, and
 * `@deepseek-ai/dsh-client-connection` documents that field as "the HTTP origin of
 * its owned Host … the Gateway uses that origin for its WebSocket".
 *
 * A preview is not a fetch — it is a document with a socket inside it. Served from
 * `dsh-app://app/api/typst-preview/p/<token>/`, the page loads and then resolves its
 * own WebSocket against that scheme, which is not one a WebSocket can be made from,
 * so the socket never opens and the preview stays blank while every `fetch` in the
 * tab keeps working. Putting the document on the HTTP origin is what makes the rest
 * of the page — and its same-origin WebSocket — behave exactly as they do in a
 * browser.
 */
/**
 * Resolve a host-issued path against the app's HTTP origin when it has one.
 * @param path - an absolute path the host answered with, e.g. `/api/typst-preview/p/<token>/`.
 * @returns the same path in a browser, or its absolute form under the desktop shell.
 */
export declare function appUrl(path: string): string;
//# sourceMappingURL=base.d.ts.map