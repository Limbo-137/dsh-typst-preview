/**
 * Browser half: register `typst-preview` as a native right-Sidebar tab type and
 * draw one tab per `.typ` file.
 *
 * The tab is a two-face surface with its own switch, the way the sidebar's
 * Markdown preview reads: **预览** is a live `tinymist preview` page in an
 * iframe, **源码** is the file's own text with the shared code renderer. The
 * type claims `*.typ` in the `extension` band, so a click on a `.typ` file in
 * the Files tree lands here instead of in the plain-text fallback; the source
 * face is one button away, and the plain-text viewer stays reachable through
 * `openResource(address, { kind: 'text' })` for anything this surface cannot do.
 *
 * Everything wire-side is same-origin: the iframe points at
 * `/api/typst-preview/p/<token>/`, which the host half reverse-proxies to the
 * instance's loopback data plane, WebSocket included.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ReactElement, ReactNode } from 'react';
/** Stage one of tab-type registration: what one type IS. */
interface SidebarRightTabDefinition {
    readonly id: string;
    readonly kind: string;
    readonly patterns?: readonly string[];
    readonly priority?: 'extension' | 'builtin' | 'fallback';
    readonly canOpen?: (address: string) => boolean;
    readonly title: (address: string) => string;
}
/** Stage-one registry, behind `ctx.sidebarRightTabs`. */
interface SidebarRightTabRegistry {
    register(definition: SidebarRightTabDefinition): () => void;
}
/** Locale face, behind `ctx.locale`; only the two calls this plugin makes. */
interface LocaleFace {
    register(namespace: string, dictionaries: {
        zh: Record<string, string>;
        en: Record<string, string>;
    }): () => void;
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
}
/** Slot registry, behind `ctx.slots`. */
interface SlotRegistry {
    register(options: Record<string, unknown>, component: (props: never) => ReactNode): () => void;
    inject(name: string, contribute: () => () => void): () => void;
}
/** One page of a workspace file, as the `workspaceFiles` Remote returns it. */
interface WorkspaceFilePage {
    readonly text: string;
    readonly lines: number;
    readonly eof: boolean;
}
/** The Remote carrier as this plugin uses it. */
interface RemoteFace {
    readonly workspaceFiles: {
        /** Resolves to the Remote result envelope, not to the page itself. */
        read(sessionId: string, path: string, range: {
            offset?: number;
        }, signal: AbortSignal): Promise<unknown>;
    };
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        readonly sidebarRightTabs: SidebarRightTabRegistry;
        readonly slots: SlotRegistry;
        readonly locale: LocaleFace;
        readonly remote: RemoteFace;
    }
}
/** This implementation's identity in the tab system, and its body's slot key. */
export declare const TYPST_TAB_ID = "dsh-typst-preview";
/** The tab kind `openTab` names. */
export declare const TYPST_TAB_KIND = "typst-preview";
/** The type's static face: it claims `.typ` files and nothing else. */
export declare function typstTabDefinition(): SidebarRightTabDefinition;
/** What the injected business face hands the body. */
export interface TypstPreviewInjected {
    /** One page of a file's text, through the host's paged reader. */
    readonly read: (sessionId: string, path: string, offset: number, signal: AbortSignal) => Promise<WorkspaceFilePage>;
}
interface ResourceSnapshot {
    readonly status: string;
    readonly value?: {
        readonly absolutePath?: string;
        readonly version?: string;
    } | undefined;
}
interface SessionsSnapshot {
    readonly byId: Record<string, {
        readonly cwd?: string;
    } | undefined>;
}
interface SidebarTabRecord {
    readonly id: string;
    readonly contentId: string;
    readonly visible: boolean;
    readonly signal: AbortSignal;
}
interface TabInfo {
    readonly sidebar: {
        readonly expanded: boolean;
        readonly fullscreen: boolean;
    };
    readonly panel: {
        readonly id: string;
    };
    readonly tab: SidebarTabRecord;
}
/** The composed props the slot framework hands a `sidebar.right.pane.tab` body. */
export interface TypstPreviewProps extends TypstPreviewInjected {
    readonly sessionId: string;
    readonly useTabInfo: () => TabInfo;
    readonly useSessions: <T>(select: (sessions: SessionsSnapshot) => T) => T;
    readonly useResource: (address: string) => ResourceSnapshot;
    readonly t: (key: string, params?: Record<string, unknown>) => string;
}
/** The tab: one toolbar, two faces, both fed by same-origin host routes. */
export declare function TypstPreviewTab(props: TypstPreviewProps): ReactElement;
/** Required browser services: the two registries, copy, and the Remote carrier. */
export declare const inject: string[];
/**
 * Client plugin body: install the stylesheet, register the tab type, and
 * contribute the body under the type's own id — the same two-stage path every
 * shipped type walks.
 * @param ctx - client root context carrying the registries, copy, and Remote.
 */
export declare function apply(ctx: Context): void;
export {};
//# sourceMappingURL=index.d.ts.map