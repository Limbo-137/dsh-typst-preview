/**
 * `dsh-resource://file/…` address parsing.
 *
 * The right Sidebar records a resource tab under the address it opened, so this
 * is where the tab body learns which file it is showing. Session-scoped
 * addresses carry `session/<sessionId>/<path>`; the path is absolute on POSIX
 * when it starts with `/`, otherwise workspace-relative. `absolute/<path>`
 * addresses carry no session, so the enclosing slot's session identity is the
 * fallback. Encoding is per segment, exactly as the address was built.
 */
/** One file address resolved to the parts a reader needs. */
export interface SessionFileAddress {
    /** Owning Session: from the address, or from the enclosing slot when it carries none. */
    readonly sessionId: string;
    /** Absolute or workspace-relative path, decoded. */
    readonly path: string;
}
/**
 * Read a file address back into its parts.
 * @param address - a candidate `dsh-resource://file/…` address.
 * @param fallbackSessionId - session identity used by session-less addresses.
 * @returns the parts, or `undefined` when the address is not a file address with a path.
 */
export declare function parseFileAddress(address: string, fallbackSessionId: string): SessionFileAddress | undefined;
/** The tab chip's text: the file's last segment, or the address when it has none. */
export declare function basenameOf(address: string): string;
//# sourceMappingURL=address.d.ts.map