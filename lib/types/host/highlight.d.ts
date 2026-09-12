/**
 * Typst syntax highlighting for the source face, taken from tinymist itself.
 *
 * The app's shared code renderer (`@deepseek-ai/dsh-client-ui-primitives`'
 * `CodeBlock`) drives one shiki core with a fixed grammar table, and Typst is not
 * in it — so `lang="typst"` falls through to flat text. tinymist does publish
 * `textDocument/semanticTokens/full` with a Typst-aware legend (heading, marker,
 * label, ref, math, pol, raw, …), which is both the accurate palette and the
 * engine that has already parsed the file for the preview next to it.
 *
 * One language server is kept per project root — the same root rule the preview
 * fleet uses — and each file it has been asked about is cached by content hash,
 * so paging through a long document costs one token request per edit rather than
 * one per page. Token decoding happens here, not in the browser: what crosses the
 * wire is per-line runs of `[start, end, classIndex, styleBits]` over UTF-16
 * offsets, which is exactly what a `<span>` needs, and with no grammar or legend
 * shipped into the client bundle.
 *
 * Position encoding is asserted rather than assumed: the runs index JavaScript
 * strings, so a server that moved to UTF-8 would mis-slice non-ASCII lines
 * silently and the whole feature would be worse than no colors.
 */
/**
 * Token classes the browser half knows how to paint. The names are the contract
 * between the halves: the host decodes a tinymist token type onto one of these,
 * the client maps the name to a `--shiki-*` color, and an unknown name renders as
 * plain text rather than as an invisible or miscolored run.
 */
export declare const TOKEN_CLASSES: readonly ["comment", "string", "raw", "keyword", "function", "number", "variable", "punctuation", "link", "error"];
/** One of {@link TOKEN_CLASSES}. */
export type TokenClass = (typeof TOKEN_CLASSES)[number];
/** Deployment knobs for the highlighter. */
export interface HighlightOptions {
    /** Executable name or absolute path; a bare name is resolved through PATH. */
    readonly tinymistPath: string;
    /** Extra arguments passed to `tinymist lsp`. */
    readonly extraArgs: readonly string[];
    /** Language servers kept alive at once, one per project root. */
    readonly maxServers: number;
    /** How long one language-server request may take before it is abandoned. */
    readonly requestTimeoutMs: number;
    /** How long an unused language server survives before the reaper stops it. */
    readonly idleTimeoutMs: number;
    /** Files larger than this are left to the paged plain-text reader. */
    readonly maxFileBytes: number;
}
/** Defaults used when the plugin row declares no highlight config. */
export declare const DEFAULT_HIGHLIGHT_OPTIONS: HighlightOptions;
/** What the browser half asks for: one page of a file, highlighted. */
export interface SourceRequest {
    /** The `.typ` file: absolute, or relative to `cwd`. */
    readonly file: string;
    /** Session workspace directory, the project-root fallback. */
    readonly cwd: string | undefined;
    /** First line of the page, 1-based — the paged reader's own convention. */
    readonly offset: number;
    /** How many lines the page may carry. */
    readonly limit: number;
}
/** One page of highlighted source. */
export interface SourcePage {
    readonly file: string;
    readonly root: string;
    readonly bytes: number;
    /** Lines in the whole file, not in this page. */
    readonly lineCount: number;
    /** First line of this page, 1-based. */
    readonly offset: number;
    /** Lines in this page. */
    readonly lines: number;
    readonly eof: boolean;
    /** Offset to pass back for the next page. */
    readonly nextOffset: number;
    /** The page's text: exactly the lines the runs describe. */
    readonly text: string;
    /** Class names by index, as {@link TOKEN_CLASSES}. */
    readonly classes: readonly string[];
    /** One flat `[start, end, classIndex, styleBits, …]` run list per page line. */
    readonly spans: readonly (readonly number[])[];
}
/** One token legend, as the server declared it. */
interface Legend {
    readonly types: readonly string[];
    readonly modifiers: readonly string[];
}
/**
 * Decode LSP relative-encoded semantic tokens into per-line run lists.
 *
 * Tokens carry a delta line and delta character, may be longer than their line (a
 * raw block, a multi-line comment), and leave plain text uncovered — so a run
 * that crosses a newline is split at the break, and the gaps are simply not
 * covered. Neighbouring runs with the same class and style are merged, which is
 * what keeps a thousands-of-tokens document to a few thousand spans.
 *
 * @param lines - the file's lines, already split on `\n`.
 * @param data - the five-number tuples of a `semanticTokens/full` answer.
 * @param legend - the server's token type and modifier names, in legend order.
 * @returns one flat run list per line, index-aligned with `lines`.
 */
export declare function decodeTokens(lines: readonly string[], data: readonly number[], legend: Legend): number[][];
/** The highlighter: a small pool of language servers, one per project root. */
export declare class TypstHighlighter {
    private readonly entries;
    private readonly options;
    private reaper;
    /**
     * @param options - deployment knobs; omitted fields fall back to the defaults.
     */
    constructor(options?: Partial<HighlightOptions>);
    /** Start the idle reaper; the returned function stops it. */
    startReaper(): () => void;
    /** What is running, for the status route. */
    list(): {
        root: string;
        files: number;
        lastUsed: number;
    }[];
    /**
     * One page of a file, highlighted: the text of the lines plus the runs that
     * paint them.
     * @param request - the file, the root fallback, and the page window.
     */
    page(request: SourceRequest): Promise<SourcePage>;
    /** Stop every language server; used on plugin disposal. */
    dispose(): Promise<void>;
    private stop;
    private server;
    private reapBeyondLimit;
}
export {};
//# sourceMappingURL=highlight.d.ts.map