import {execFile} from 'node:child_process'
import {cp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

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
 * tsconfig that registers the content mapper.
 */
export async function writeExampleProject(directory: string): Promise<void> {
  await cp(join(FIXTURES, 'schema.json'), join(directory, 'schema.json'))
  await cp(join(FIXTURES, 'queries'), join(directory, 'queries'), {recursive: true})
  await writeFile(join(directory, 'package.json'), '{"type": "module"}\n')
  // The literal is the file as checked out, so a CRLF checkout on Windows types `\r\n`.
  const postsText = await readFile(join(FIXTURES, 'queries', 'posts.groq'), 'utf8')
  await writeFile(join(directory, 'check.ts'), checkSource(postsText))
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
 * The assertions. `ClientReturn`, `ClientParams` and the `fetch` overloads are copied from
 * sanity-io/client#1373, which teaches `@sanity/client` to read the brand, so that this file
 * shows what `client.fetch(query, params)` resolves to with that release and without a generic
 * argument. They are declared here rather than imported because the client reads the brand
 * structurally and never imports this package, and this package never imports the client.
 */
const checkSource = (
  postsText: string,
): string => `// A value import carries the attribute that makes the runtime deliver the file as text.
import postBySlug from './queries/postBySlug.groq' with {type: 'text'}
import posts from './queries/posts.groq' with {type: 'text'}
import postsAgain from './queries/postsAgain.groq' with {type: 'text'}
import postsByRole from './queries/postsByRole.groq' with {type: 'text'}
import postsBySearch from './queries/postsBySearch.groq' with {type: 'text'}
import postsByTags from './queries/postsByTags.groq' with {type: 'text'}
import * as postsModule from './queries/posts.groq' with {type: 'text'}
// A type-only import needs no attribute.
import type {QueryParams as SlugParams, QueryResponse as SlugResponse} from './queries/postBySlug.groq'
import type {QueryParams as PostsParams, QueryResponse as PostsResponse} from './queries/posts.groq'
import type {QueryParams as RoleParams} from './queries/postsByRole.groq'
import type {QueryParams as SearchParams, QueryResponse as SearchResponse} from './queries/postsBySearch.groq'
import type {QueryParams as TagsParams, QueryResponse as TagsResponse} from './queries/postsByTags.groq'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type Slug = {_type: 'slug'; current?: string}
type PostItem = {title: string | null; role: 'admin' | 'member' | null}
// The file's exact content, line ending included: what a text import evaluates to.
const postsText = ${JSON.stringify(postsText)}

// The default export is the query text, usable anywhere a string is.
export const asString: string = posts
export const asLiteral: typeof postsText = posts
export const inTemplate = \`\${posts} | order(title)\`
export const compared = posts === postsText
// @ts-expect-error a different query text is a different type
export const otherText: typeof posts = '*[_type == "author"]'
// @ts-expect-error the literal is the file as it is, not trimmed
export const trimmed: typeof posts = '*[_type == "post"]{title, role}'

// The brand: two optional phantom properties, keyed by plain strings.
export type _Brand = Expect<Equal<typeof posts, typeof postsText & {readonly __groqResult?: PostsResponse; readonly __groqParams?: PostsParams}>>
export type _ResultBrand = Expect<Equal<NonNullable<(typeof postsBySearch)['__groqResult']>, SearchResponse>>
export type _ParamsBrand = Expect<Equal<NonNullable<(typeof postsBySearch)['__groqParams']>, SearchParams>>

// QueryResponse matches the projection, with [0] as T | null and nothing undefined at the top.
export type _Posts = Expect<Equal<PostsResponse, Array<PostItem>>>
export type _One = Expect<Equal<SlugResponse, {title: string | null; author: string | null} | null>>
export type _Search = Expect<Equal<SearchResponse, Array<{_id: string; title: string | null; slug: Slug | null; _score: null}>>>
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
