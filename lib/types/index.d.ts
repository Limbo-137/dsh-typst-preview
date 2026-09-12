/**
 * Host half: the `tinymist preview` fleet and the `/api/typst-preview/*` routes
 * the browser half drives.
 *
 * One route table, loopback-free by construction:
 *
 *  - `POST open`  — start (or reuse) a preview for one `.typ` file, answer with
 *                   the same-origin page path plus the upgrade path, and claim
 *                   the upgrade route that instance's socket needs.
 *  - `POST close` — stop it and release both routes.
 *  - `POST source`— one page of the file's text with the token runs that paint
 *                   it, decoded from tinymist's own semantic tokens, so the
 *                   source face is not flat text.
 *  - `GET  status`— what is running, for diagnostics.
 *  - `GET  p/<token>/…` — the page and everything it asks for, forwarded to the
 *                   instance's data plane; the page's one absolute WebSocket
 *                   reference is rewritten onto `ws/<token>`.
 *  - `GET  ws/<token>` (Upgrade) — relayed verbatim to the same data plane.
 *
 * Every route refuses cross-site requests and requests whose `Origin` is not the
 * request's own host, because spawning a compiler for a page the user is not
 * looking at is exactly the class of bug a browser makes easy. Same-origin
 * requests from a remote GUI pass, so the plugin works with the app bound to a
 * LAN address or behind a tunnel.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/** Required host services. */
export declare const inject: string[];
/** One named HTTP route registration, as `@deepseek-ai/dsh-host-webserver` declares it. */
interface WebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration. */
interface WebUpgradeRoute {
    path: string;
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
/** The slice of the web server this plugin uses. */
interface WebServerFace {
    register(route: WebRoute): () => void;
    registerUpgrade(route: WebUpgradeRoute): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The browser HTTP carrier, provided by the host web composition. */
        webServer: WebServerFace;
    }
}
/** Plugin config: the manager's knobs, all optional. */
export interface TypstPreviewConfig {
    readonly tinymistPath?: string;
    readonly extraArgs?: readonly string[];
    readonly maxInstances?: number;
    readonly readyTimeoutMs?: number;
    readonly idleTimeoutMs?: number;
    /** Whether the source face is highlighted; off leaves it to the paged reader. */
    readonly highlight?: boolean;
    /** Lines per highlighted page; the browser half sends its own default too. */
    readonly highlightLines?: number;
    /** Files above this size fall back to plain text. */
    readonly highlightMaxBytes?: number;
    /** How long an unused highlighting language server survives. */
    readonly highlightIdleTimeoutMs?: number;
    /** Language servers kept at once, one per project root. */
    readonly highlightMaxServers?: number;
}
/** Plugin body: own the fleet, claim the routes, release both on unload. */
export declare function apply(ctx: Context, config?: TypstPreviewConfig): void;
export {};
//# sourceMappingURL=index.d.ts.map