/**
 * Browser half of the highlighted-source transport.
 *
 * The host reads the file, asks tinymist's language server for its semantic
 * tokens, and answers with one page of text plus the runs that paint it. This
 * module only carries that answer across the app origin and gives the tab body
 * a typed face for it: a page when highlighting worked, and a reason when it did
 * not — an absent tinymist, a file past the size cap, highlighting switched off —
 * which is the signal to fall back to the host's paged plain-text reader.
 */
/** One highlighted page, as the host route answers it. */
export interface HighlightedSourcePage {
    /** Absolute path the host resolved, which may be more precise than the address. */
    readonly file: string;
    /** First line of this page, 1-based. */
    readonly offset: number;
    /** Lines on this page. */
    readonly lines: number;
    readonly eof: boolean;
    /** Offset to send for the next page. */
    readonly nextOffset: number;
    /** The page's text, exactly the lines the runs describe. */
    readonly text: string;
    /** Token class names, indexed by a run's third number. */
    readonly classes: readonly string[];
    /** One flat `[start, end, classIndex, styleBits, …]` list per line. */
    readonly spans: readonly (readonly number[])[];
}
/** The host's answer: a page, or the reason there is no highlighted page. */
export type SourcePageResult = {
    readonly ok: true;
    readonly page: HighlightedSourcePage;
} | {
    readonly ok: false;
    readonly error: string;
};
/** What one page request carries. */
export interface SourcePageRequest {
    /** Absolute path when the resource metadata is known, else the address path. */
    readonly file: string;
    /** Session workspace directory, which relative paths resolve against. */
    readonly cwd: string | undefined;
    /** First line of the page, 1-based. */
    readonly offset: number;
}
/** Lines per page: a screenful of context without shipping a whole book. */
export declare const SOURCE_PAGE_LINES = 800;
/**
 * Ask the host for one highlighted page.
 * @param request - the file and the page window.
 * @param signal - the tab's lifetime; an aborted fetch rejects.
 * @returns the page, or `ok: false` with the host's reason.
 */
export declare function fetchSourcePage(request: SourcePageRequest, signal?: AbortSignal): Promise<SourcePageResult>;
//# sourceMappingURL=source-client.d.ts.map