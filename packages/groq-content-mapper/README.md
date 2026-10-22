# @sanity-labs/groq-content-mapper

Typed `.groq` file imports for TypeScript 7.1 and later. A query kept in its own file is imported as a string that carries its result and params types, inferred from your Sanity schema:

```groq
// postsBySearch.groq
*[_type == "post" && title match $searchQuery] | order(_createdAt desc) [$start...$end] {
  _id,
  title,
  slug
}
```

```ts
import postsBySearch, {type QueryResponse} from './postsBySearch.groq' with {type: 'text'}

const posts = await client.fetch(postsBySearch, {searchQuery: 'foo', start: 0, end: 10})
//    ^? QueryResponse, with the params checked
```

This is experimental. It is a TypeScript 7.1 [content mapper](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/): there is no generated declaration file, and nothing for earlier TypeScript releases. The type generation itself comes from [`@sanity/codegen`](https://github.com/sanity-io/codegen), which this package depends on, so you do not install it yourself.

## What an import gives you

Each `.groq` file is a module with three exports:

- The default export is the query string, typed as its own literal with the result and params types attached as optional phantom properties. It is still assignable to `string`. The literal is the file's exact content, trailing newline included, because that is what a text import evaluates to.
- `QueryResponse` is the result type, evaluated the way `defineQuery` results are, so `[0]` is `T | null`.
- `QueryParams` is the object the `$` placeholders expect. A placeholder compared with a field takes the field's type, `match` takes a string, slice bounds are numbers, and anything the schema says nothing about is `unknown`. A query without placeholders has `QueryParams = Record<string, never>`.

```ts
// What './postsBySearch.groq' resolves to
export type QueryResponse = Array<{_id: string; title: string | null; slug: Slug | null}>
export type QueryParams = {searchQuery: string; start: number; end: number}
declare const query: '*[_type == "post" && title match $searchQuery] …\n' & {
  readonly __groqResult?: QueryResponse
  readonly __groqParams?: QueryParams
}
export default query
```

Nothing is declared globally and nothing is imported. `@sanity/client` reads the brand structurally once [sanity-io/client#1373](https://github.com/sanity-io/client/pull/1373) is released, so `client.fetch(query, params)` infers both types. With an older client, pass the type yourself: `client.fetch<QueryResponse>(query, params)`. The brand is also exported as `GroqQuery<Query, Result, Params>`, with `GroqResult<Q>` and `GroqParams<Q>` to read it back.

### Imports

A value import needs the `with {type: 'text'}` attribute, which is the standard text import ([TC39 import text](https://github.com/tc39/proposal-import-text)): at run time the default export is the file's content. TypeScript ignores the attribute and asks the content mapper for the type.

A type-only import needs no attribute, and since it is erased it keeps the query string out of the bundle. Use it in code that only needs the types, such as components rendering a result:

```ts
import type {QueryResponse} from './postsBySearch.groq'

export function PostList(props: {posts: QueryResponse}) {}
```

When a file needs both the query and its types, write one statement with inline type specifiers:

```ts
import postsBySearch, {type QueryResponse} from './postsBySearch.groq' with {type: 'text'}
```

rather than a value import plus a separate `import type` from the same file. ESLint's `import-x/no-duplicates` autofix merges the two and drops or mangles the attribute in the process.

## Setup

You need TypeScript 7.1 or later and Node 22.12 or later.

```sh
npm install -D @sanity-labs/groq-content-mapper typescript@beta
```

If your app runs `.groq` imports on Node through the `register` preload below (rather than as a bundle), install the package as a regular dependency instead.

Write the schema file with the Sanity CLI:

```sh
npx sanity schema extract
```

Register the mapper in `tsconfig.json`, next to `compilerOptions`. The tsconfig is the only place it is configured, and `schema` is required:

```jsonc
// tsconfig.json
{
  "compilerOptions": {/* ... */},
  "contentMappers": [
    {
      "package": "@sanity-labs/groq-content-mapper",
      "extensions": [".groq"],
      "options": {"schema": "./schema.json"},
    },
  ],
}
```

Paths are relative to the tsconfig. Type-check with `--runExternalCode`, the flag that lets `tsc` start content mappers:

```jsonc
// package.json
{
  "scripts": {
    "typecheck": "tsc --noEmit --runExternalCode",
  },
}
```

The schema file is watched, so extracting it again retypes the imports. A file that cannot be typed, because the query does not parse or the schema is missing, still resolves, with `unknown` for what could not be inferred and a diagnostic saying why. GROQ syntax errors are reported at the `.groq` file as `error groq2`.

### Editor

In VS Code or Cursor, install the TypeScript 7 extension (`TypeScriptTeam.native-preview`) and point it at the project's TypeScript, since the extension bundles 7.0:

```jsonc
// .vscode/settings.json
{
  "js/ts.experimental.useTsgo": true,
  "js/ts.tsdk.path": "./node_modules/typescript",
}
```

Trust the workspace, and allow the extension to use the workspace's TypeScript when it asks.

## One schema per folder

A codebase that queries more than one project or dataset has one schema per folder. TypeScript registers a content mapper by file extension only, and rejects two entries for `.groq`, so the folders are listed inside the one entry with `schemas`:

```jsonc
{
  "contentMappers": [
    {
      "package": "@sanity-labs/groq-content-mapper",
      "extensions": [".groq"],
      "options": {
        "schemas": [
          {"include": "src/queries/blog", "schema": "schemas/blog.json"},
          {"include": ["src/queries/shop", "src/queries/checkout"], "schema": "schemas/shop.json"},
        ],
      },
    },
  ],
}
```

A file is typed against the schema of the deepest folder that contains it, and against `schema` when no folder does. Without a `schema`, a file outside every folder gets a diagnostic.

Folders work well with a `package.json` `imports` alias. TypeScript resolves the alias to the file before asking the mapper, so each folder's schema still applies, and Node, Bun, Deno and the bundlers resolve `imports` themselves:

```jsonc
// package.json
{
  "imports": {
    "#queries/*": "./src/queries/*",
  },
}
```

```ts
import posts from '#queries/blog/posts.groq' with {type: 'text'}
import products from '#queries/shop/products.groq' with {type: 'text'}
```

## Running the imports

At run time `with {type: 'text'}` makes the runtime or bundler deliver the file as a string. Many do this on their own; for the rest, this package has one entry each. None of them runs type generation.

| Runtime or bundler                            | Setup                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Bun, Deno, esbuild, `Bun.build`               | nothing                                                                 |
| webpack 5.102 and later, Rspack 1.7 and later | nothing                                                                 |
| webpack before 5.102                          | `{test: /\.groq$/, type: 'asset/source'}` in `module.rules`             |
| Rolldown                                      | `moduleTypes: {'.groq': 'text'}`                                        |
| Node 26.5 and later                           | `--experimental-import-text`, or the preload below                      |
| Node 22.12 and later                          | `node --import @sanity-labs/groq-content-mapper/register main.ts`       |
| Vite, Vitest, Rollup                          | the Vite plugin                                                         |
| Sanity Studio, App SDK apps                   | the Vite plugin, in `vite: {plugins: [groqFiles()]}` of `sanity.cli.ts` |
| Next.js 16.3 and later                        | `withGroqFiles`                                                         |
| Jest                                          | the Jest transformer, with tests compiled to CommonJS                   |

### Node

```sh
node --import @sanity-labs/groq-content-mapper/register main.ts
```

The preload uses `module.registerHooks` where Node has it (22.15 and later) and `module.register` before that.

### Vite, Vitest, Rollup

```ts
// vite.config.ts
import groqFiles from '@sanity-labs/groq-content-mapper/vite'
import {defineConfig} from 'vite'

export default defineConfig({plugins: [groqFiles()]})
```

Vite's dev server does not handle the attribute itself, so the plugin is needed there even where the build would work without it.

### Next.js

```ts
// next.config.ts
import {withGroqFiles} from '@sanity-labs/groq-content-mapper/next'

export default withGroqFiles(nextConfig)
```

Turbopack handles the attribute on its own. The wrapper adds an `asset/source` rule for the webpack that Next bundles, which predates webpack's built-in support. It also takes over the type check `next build` runs: Next runs `tsc` without `--runExternalCode`, so its check fails on every `.groq` import. The wrapper turns Next's check off and runs the same check with the flag after the compile. If your config already sets `typescript.ignoreBuildErrors`, no check is run.

### Jest

```js
// jest.config.js
export default {
  transform: {'\\.groq$': '@sanity-labs/groq-content-mapper/jest'},
}
```

Jest's ES module loader rejects `type: 'text'`, so this works for tests compiled to CommonJS, where Babel drops the attribute.

## Limitations

- A comparison against `^` (the parent scope) types its placeholder as `unknown`.
- groq-js does not model `score()` yet, so `_score` is typed as `null`, and a `[_score > 0]` filter empties the result type.
- `include` takes folders, not globs.

## License

MIT
