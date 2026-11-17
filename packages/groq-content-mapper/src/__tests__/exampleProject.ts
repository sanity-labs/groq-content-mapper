import {execFile, spawn} from 'node:child_process'
import {cp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

import {minifyGroq} from '../functions.js'
import {prettifyGroq} from '../groqParser.js'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

export const PACKAGE_ROOT = join(here, '../..')
export const FIXTURES = join(here, 'fixtures')
/** TypeScript 7.1, the first release with content mappers, installed as `typescript-7.1`. */
export const TYPESCRIPT_7_1 = dirname(
  require.resolve('typescript-7.1/package.json', {paths: [PACKAGE_ROOT]}),
)

/**
 * Writes the example project: the fixture schema, the `.groq` queries, and `check.ts`, a file
 * of type assertions that fails to compile when inference regresses. The caller adds the
 * tsconfig that registers the content mapper, with `prettify` set as it is here.
 */
export async function writeExampleProject(
  directory: string,
  {prettify = true}: {prettify?: boolean} = {},
): Promise<void> {
  await cp(join(FIXTURES, 'schema.json'), join(directory, 'schema.json'))
  await cp(join(FIXTURES, 'queries'), join(directory, 'queries'), {recursive: true})
  await writeFile(join(directory, 'package.json'), '{"type": "module"}\n')
  // The file as checked out, so a CRLF checkout on Windows reads `\r\n`.
  const postsText = await readFile(join(FIXTURES, 'queries', 'posts.groq'), 'utf8')
  const postsTyped = prettify ? prettifyGroq(postsText, 80) : postsText
  await writeFile(
    join(directory, 'check.ts'),
    checkSource(postsTyped, postsText, minifyGroq(postsText)),
  )
}

/**
 * What `postCards.groq` in `directory`, by default `fixtures/functions`, evaluates to with
 * `functions: "lib/*.groq"`: the definition it calls after the one that calls, then the file.
 * A loader delivers that minified unless `minify` is false; the import's type is the unminified
 * one, which is `{minify: false}`, prettified unless `prettify` is off.
 */
export async function postCardsWithFunctions(
  directory = join(FIXTURES, 'functions'),
  {minify = true}: {minify?: boolean} = {},
): Promise<string> {
  const [author, post, query] = await Promise.all(
    ['lib/author.groq', 'lib/post.groq', 'postCards.groq'].map((name) =>
      readFile(join(directory, name), 'utf8'),
    ),
  )
  const prepended = [author!.split('\n')[1], post!.split('\n')[0], query].join('\n')
  return minify ? minifyGroq(prepended) : prepended
}

/** Makes `@sanity-labs/groq-content-mapper` resolvable from `directory`, as it is in a project that installed it. */
export async function linkPackage(directory: string): Promise<void> {
  await mkdir(join(directory, 'node_modules', '@sanity-labs'), {recursive: true})
  // A junction on Windows, which needs no privilege; a plain symlink elsewhere.
  await symlink(
    PACKAGE_ROOT,
    join(directory, 'node_modules', '@sanity-labs', 'groq-content-mapper'),
    'junction',
  )
}

/** A tsconfig for the example project, with the given `contentMappers` entries. */
export function exampleTsconfig(options: {contentMappers: unknown[]; files?: string[]}): string {
  return JSON.stringify(
    {
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 'ES2023',
        types: [],
      },
      contentMappers: options.contentMappers,
      files: options.files ?? ['check.ts'],
    },
    null,
    2,
  )
}

/**
 * Runs TypeScript 7.1's `tsc` with `--runExternalCode`,
 * which lets it start the content mapper, and returns its output. Throws with that output on
 * failure.
 */
export async function runTsc71(directory: string): Promise<string> {
  const tsc = join(TYPESCRIPT_7_1, 'bin', 'tsc')
  try {
    const {stdout} = await execFileAsync(
      process.execPath,
      [tsc, '--runExternalCode', '--pretty', 'false', '-p', directory],
      {cwd: directory},
    )
    return stdout
  } catch (error) {
    const failed = error as {stderr?: string; stdout?: string}
    throw new Error(`${failed.stdout ?? ''}\n${failed.stderr ?? ''}`.trim(), {cause: error})
  }
}

/**
 * The markdown TypeScript 7.1's language server shows on hovering `file` at the zero-based
 * `line` and `character`, with external code allowed, as an editor that enables content mappers
 * starts it. The first hovers can come before the mapper has typed the import, so it asks again
 * until the hover shows a `.groq` module's brand.
 */
export async function hoverTs71(
  directory: string,
  file: string,
  position: {character: number; line: number},
): Promise<string> {
  const server = spawn(process.execPath, [join(TYPESCRIPT_7_1, 'bin', 'tsc'), '--lsp', '--stdio'], {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const replies = new Map<number, (result: unknown) => void>()
  let buffer = Buffer.alloc(0)
  let lastId = 0
  const exited = new Promise<void>((resolve) => {
    server.once('exit', () => resolve())
    server.once('error', () => resolve())
  })
  const send = (message: object) => {
    if (server.stdin.destroyed || !server.stdin.writable) return
    const body = JSON.stringify({jsonrpc: '2.0', ...message})
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  server.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = Number(
        /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1],
      )
      if (buffer.length < headerEnd + 4 + length) return
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString())
      buffer = buffer.subarray(headerEnd + 4 + length)
      if (message.method !== undefined && message.id !== undefined) {
        send({id: message.id, result: null})
      } else if (message.id !== undefined) {
        replies.get(message.id)?.(message.result)
      }
    }
  })
  const request = (method: string, params?: object) =>
    new Promise<unknown>((resolve) => {
      const id = ++lastId
      replies.set(id, resolve)
      send({id, method, params})
    })

  try {
    const root = pathToFileURL(directory).href
    const uri = pathToFileURL(join(directory, file)).href
    await request('initialize', {
      capabilities: {textDocument: {hover: {contentFormat: ['markdown']}}},
      initializationOptions: {runExternalCode: true},
      processId: process.pid,
      rootUri: root,
      workspaceFolders: [{name: 'example', uri: root}],
    })
    send({method: 'initialized', params: {}})
    const text = await readFile(join(directory, file), 'utf8')
    send({
      method: 'textDocument/didOpen',
      params: {textDocument: {languageId: 'typescript', text, uri, version: 1}},
    })
    let markdown = ''
    for (let attempt = 0; attempt < 30 && !markdown.includes('__groqResult'); attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- each retry waits out the one before it
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
      // oxlint-disable-next-line no-await-in-loop -- asked again only if the last hover was early
      const hover = (await request('textDocument/hover', {position, textDocument: {uri}})) as {
        contents?: {value?: string}
      } | null
      markdown = hover?.contents?.value ?? ''
    }
    return markdown
  } finally {
    // Shutdown lets the content mapper exit before the temp directory is removed. On Windows
    // that directory stays locked while either process is still alive, so wait for the server
    // and kill its process tree if it hangs.
    try {
      await Promise.race([
        request('shutdown'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    } catch {
      // The server may already be gone.
    }
    send({method: 'exit'})
    server.stdin.end()
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
    ])
    if (timedOut && server.pid !== undefined) {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/T', '/F', '/PID', String(server.pid)]).catch(() => {})
      } else {
        server.kill('SIGKILL')
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
    }
  }
}

/**
 * The assertions. `ClientReturn`, `ClientParams` and the `fetch` overloads are copied from
 * sanity-io/client#1373, which teaches `@sanity/client` to read the brand, so that this file
 * shows what `client.fetch(query, params)` resolves to with that release and without a generic
 * argument. They are declared here rather than imported because the client reads the brand
 * structurally and never imports this package, and this package never imports the client.
 */
const checkSource = (
  postsTyped: string,
  postsText: string,
  postsMinified: string,
): string => `// A value import evaluates to the query where a loader of this package delivers the file.
import postBySlug from './queries/postBySlug.groq'
import posts from './queries/posts.groq'
import postsAgain from './queries/postsAgain.groq'
import postsByRole from './queries/postsByRole.groq'
import postsBySearch from './queries/postsBySearch.groq'
import postsByTags from './queries/postsByTags.groq'
import * as postsModule from './queries/posts.groq'
// A type-only import is erased, so it needs no loader.
import type {QueryParams as SlugParams, QueryResponse as SlugResponse} from './queries/postBySlug.groq'
import type {QueryParams as PostsParams, QueryResponse as PostsResponse} from './queries/posts.groq'
import type {QueryParams as RoleParams} from './queries/postsByRole.groq'
import type {QueryParams as SearchParams, QueryResponse as SearchResponse} from './queries/postsBySearch.groq'
import type {QueryParams as TagsParams, QueryResponse as TagsResponse} from './queries/postsByTags.groq'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type Slug = {_type: 'slug'; current?: string}
type PostItem = {title: string | null; role: 'admin' | 'member' | null}
// What the import is typed as: the file prettified by groq-format, or as written with prettify off.
const postsTyped = ${JSON.stringify(postsTyped)}
// The file's exact content, line ending included: what a text import evaluates to.
const postsText = ${JSON.stringify(postsText)}
// The query minified, which is what the loaders deliver by default. It is not the import's type.
const postsMinified = ${JSON.stringify(postsMinified)}

// The default export is the query text, usable anywhere a string is.
export const asString: string = posts
export const asLiteral: typeof postsTyped = posts
export const inTemplate = \`\${posts} | order(title)\`
export const compared = posts === postsTyped
// @ts-expect-error a different query text is a different type
export const otherText: typeof posts = '*[_type == "author"]'
// @ts-expect-error the type is not the minified string a loader delivers
export const asMinified: typeof posts = postsMinified
${postsTyped === postsText ? '' : '// @ts-expect-error the type is the prettified query, not the file as written\nexport const asWritten: typeof posts = postsText\n'}

// The brand: two optional phantom properties, keyed by plain strings.
export type _Brand = Expect<Equal<typeof posts, typeof postsTyped & {readonly __groqResult?: PostsResponse; readonly __groqParams?: PostsParams}>>
export type _ResultBrand = Expect<Equal<NonNullable<(typeof postsBySearch)['__groqResult']>, SearchResponse>>
export type _ParamsBrand = Expect<Equal<NonNullable<(typeof postsBySearch)['__groqParams']>, SearchParams>>

// QueryResponse matches the projection, with [0] as T | null and nothing undefined at the top.
export type _Posts = Expect<Equal<PostsResponse, Array<PostItem>>>
export type _One = Expect<Equal<SlugResponse, {title: string | null; author: string | null} | null>>
export type _Search = Expect<Equal<SearchResponse, Array<{_id: string; title: string | null; slug: Slug | null; _score: number}>>>
export type _Tags = Expect<Equal<TagsResponse, Array<{title: string | null; tags: Array<string> | null}>>>
export type _NoUndefined = Expect<Equal<Extract<SearchResponse | SlugResponse, undefined>, never>>

// QueryParams: schema-typed where a placeholder is compared with a field, numbers for slices.
export type _SearchParams = Expect<Equal<SearchParams, {searchQuery: string; start: number; end: number}>>
export type _SlugParams = Expect<Equal<SlugParams, {slug: string}>>
export type _RoleParams = Expect<Equal<RoleParams, {role: 'admin' | 'member'}>>
export type _TagsParams = Expect<Equal<TagsParams, {tags: Array<string>}>>
export type _NoParams = Expect<Equal<PostsParams, Record<string, never>>>

// satisfies QueryParams accepts the right params and rejects the wrong ones.
export const searchParams = {searchQuery: 'foo', start: 0, end: 10} satisfies SearchParams
// @ts-expect-error start and end are missing
export const missingParams = {searchQuery: 'foo'} satisfies SearchParams
// @ts-expect-error start is a number
export const wrongType = {searchQuery: 'foo', start: '0', end: 10} satisfies SearchParams
// @ts-expect-error limit is not a param of this query
export const extraParam = {searchQuery: 'foo', start: 0, end: 10, limit: 10} satisfies SearchParams
// @ts-expect-error the role is an enum
export const wrongRole = {role: 'guest'} satisfies RoleParams
// @ts-expect-error this query declares no params
export const paramsForNone = {type: 'post'} satisfies PostsParams

// Two files with the same query text are interchangeable, and nothing is registered globally.
export type _SameAgain = Expect<Equal<typeof posts, typeof postsAgain>>
export type _OnlyDefault = Expect<Equal<keyof typeof postsModule, 'default'>>
declare global {
  interface SanityQueries {}
}
export type _NotRegistered = Expect<Equal<keyof SanityQueries, never>>

// What @sanity/client resolves once it reads the brand (sanity-io/client#1373).
type Any = any
type ClientQueryParams = {[key: string]: Any}
type QueryWithoutParams = Record<string, never> | undefined
type ClientReturn<GroqString extends string, Fallback = Any> = GroqString extends {readonly __groqResult?: infer Result}
  ? Result
  : GroqString extends keyof SanityQueries
    ? SanityQueries[GroqString]
    : Fallback
type ClientParams<GroqString extends string, Fallback = ClientQueryParams> = [GroqString] extends [{readonly __groqParams?: unknown}]
  ? NonNullable<(GroqString & {readonly __groqParams?: unknown})['__groqParams']>
  : Fallback
declare const client: {
  fetch<R = Any, Q extends QueryWithoutParams = QueryWithoutParams, const G extends string = string>(query: G, params?: Q | QueryWithoutParams): Promise<ClientReturn<G, R>>
  fetch<R = Any, Q extends QueryWithoutParams | ClientQueryParams = ClientQueryParams, const G extends string = string>(query: G, params: Q extends QueryWithoutParams ? QueryWithoutParams : ClientParams<G, Q>, options?: {perspective?: string}): Promise<ClientReturn<G, R>>
}

export async function fetched() {
  const found = await client.fetch(postsBySearch, {searchQuery: 'foo', start: 0, end: 10})
  const one = await client.fetch(postBySlug, {slug: 'hello'}, {perspective: 'published'})
  const all = await client.fetch(posts)
  const byRole = await client.fetch(postsByRole, {role: 'admin'})
  const byTags = await client.fetch(postsByTags, {tags: ['a']})
  // @ts-expect-error start and end are missing
  await client.fetch(postsBySearch, {searchQuery: 'foo'})
  // @ts-expect-error this query declares no params
  await client.fetch(posts, {type: 'post'})
  // @ts-expect-error the role is an enum
  await client.fetch(postsByRole, {role: 'guest'})
  const plain = await client.fetch(postsText)
  return {all, byRole, byTags, found, one, plain}
}
type Fetched = Awaited<ReturnType<typeof fetched>>
export type _FetchedSearch = Expect<Equal<Fetched['found'], SearchResponse>>
export type _FetchedOne = Expect<Equal<Fetched['one'], SlugResponse>>
export type _FetchedAll = Expect<Equal<Fetched['all'], PostsResponse>>
export type _FetchedTags = Expect<Equal<Fetched['byTags'], TagsResponse>>
export type _FetchedPlain = Expect<Equal<Fetched['plain'], any>>
export type _ClientReturn = Expect<Equal<ClientReturn<typeof postsBySearch>, SearchResponse>>
export type _ClientParams = Expect<Equal<ClientParams<typeof postsBySearch>, SearchParams>>
export type _ClientParamsNone = Expect<Equal<ClientParams<typeof posts>, Record<string, never>>>
`
