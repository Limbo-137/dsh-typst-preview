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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/**
 * Rewrite the preview page's WebSocket URL onto this instance's upgrade path.
 *
 * The address is absolute, not a path: the page may be served from the desktop
 * app's own `dsh-app://app/…` origin, where a relative socket URL resolves to a
 * scheme no WebSocket can be made from (see `webSocketUrl` in the plugin entry).
 */
export declare function patchPreviewHtml(html: string, wsUrl: string): {
    html: string;
    patched: boolean;
};
/** How one proxied HTTP request reaches the instance. */
export interface HttpProxyOptions {
    /**
     * Upstream request path. The plugin serves the page under a per-instance
     * prefix, so the prefix is stripped before forwarding; leaving this out
     * forwards the client's own URL unchanged.
     */
    readonly path?: string;
    /** Rewrite a `text/html` response body before it reaches the browser. */
    readonly rewriteHtml?: (html: string) => {
        html: string;
        patched: boolean;
    };
}
/** Forward one HTTP request to a preview data plane, optionally rewriting its HTML. */
export declare function proxyHttp(port: number, req: IncomingMessage, res: ServerResponse, options?: HttpProxyOptions): void;
/** Relay one WebSocket handshake and its framed traffic to a preview data plane. */
export declare function proxyWebSocket(port: number, req: IncomingMessage, socket: Duplex, head: Buffer, path?: string): void;
//# sourceMappingURL=proxy.d.ts.map