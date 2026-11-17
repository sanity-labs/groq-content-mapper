/* tslint:disable */
/* eslint-disable */

/**
 * What a query defines and calls. A query that does not parse gives `null`: the error is for
 * the consumer's own parse of it, and nothing is prepended to a query that is not valid.
 */
export function calls(query: string): string;

/**
 * The definitions in a functions file, which holds nothing else. Each is parsed on its own,
 * so a definition with a syntax error is reported without hiding the others.
 */
export function definitions(source: string): string;

/**
 * The query as groq-format prints it, wrapped to `width` columns, comments kept. A query that
 * does not parse, or holds nothing, gives `undefined`.
 */
export function format(query: string, width: number): string | undefined;

/**
 * The query with its comments and whitespace removed, and with a trailing comma dropped where
 * GROQ allows the query without it: an object, a projection, an array, or a function argument
 * list. What remains is its tokens, with a space only where two would otherwise run together,
 * as in `title match` or `publishedAt desc`. Strings keep their text. Tokens are all it needs,
 * so a fragment, or a query that does not parse, minimizes too.
 */
export function minimize(query: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly calls: (a: number, b: number) => [number, number];
    readonly definitions: (a: number, b: number) => [number, number];
    readonly format: (a: number, b: number, c: number) => [number, number];
    readonly minimize: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
