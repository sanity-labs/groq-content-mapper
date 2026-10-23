# @sanity-labs/groq-content-mapper

Typed `.groq` file imports for TypeScript 7.1 and later. A query kept in its own file is imported as a string that carries its result and params types, inferred from your Sanity schema.

## Requirements

- **TypeScript 7.1 or later.** Content mappers do not exist in earlier versions. 7.1 is currently a beta: `npm install -D typescript@beta`.
- **Node.js 22.12 or later.** On Node 26.5 and later, run `.groq` imports with `--experimental-import-text`, or with the preload below. On earlier Node, run `node --import @sanity-labs/groq-content-mapper/register`.
- **Type-check with `tsc --runExternalCode`.** Without that flag the mapper does not run, and `.groq` imports are not typed.

```jsonc
// package.json
{
  "scripts": {
    "typecheck": "tsc --noEmit --runExternalCode",
  },
}
```

## Generate a schema

The mapper reads `schema.json`, the file `sanity schema extract` writes from a Sanity Studio config. A minimal `sanity.cli.ts` names the project and dataset, with `schemaExtraction`'s defaults spelled out:

```ts
// sanity.cli.ts
import {defineCliConfig} from 'sanity/cli'

export default defineCliConfig({
  api: {projectId: 'myprojectid', dataset: 'production'},
  schemaExtraction: {
    path: './schema.json', // default
    enforceRequiredFields: false, // default
    // workspace: 'production', // required if sanity.config.ts exports an array of named workspaces
  },
})
```

`sanity.config.ts` adds the schema types, here a `post` with the fields the example below uses:

```ts
// sanity.config.ts
import {defineConfig, defineType} from 'sanity'

export default defineConfig({
  projectId: 'myprojectid',
  dataset: 'production',
  schema: {
    types: [
      defineType({
        name: 'post',
        type: 'document',
        fields: [
          {name: 'title', type: 'string'},
          {name: 'slug', type: 'slug'},
          {name: 'publishedAt', type: 'datetime'},
        ],
      }),
    ],
  },
})
```

```sh
npx sanity schema extract
```

This writes `schema.json` in the current directory by default. Point the mapper's `options.schema` at that path, as shown under [Setup](#setup).

## Usage

```groq
// postsBySearch.groq
*[_type == "post" && title match $q] | order(publishedAt desc) [$start...$end] {
  _id,
  title,
  slug
}
```

```ts
import postsBySearch, {type QueryResponse} from './postsBySearch.groq' with {type: 'text'}

const posts = await client.fetch(postsBySearch, {q: 'foo', start: 0, end: 10})
//    ^? QueryResponse, with the params checked
```

Types come from the file as it is. Nothing is written to disk, and nothing is added to the global scope.

## What an import gives you

Each `.groq` file has three exports:

- The default export is the query string, typed as its own text, and still assignable to `string`. The type includes the file's trailing newline, because that is what the import evaluates to.
- `QueryResponse` is the result type. `[0]` is `T | null`.
- `QueryParams` is the object the `$` placeholders expect. A placeholder compared with a field takes the field's type, `match` takes a string, slice bounds are numbers, and anything the schema says nothing about is `unknown`. A query without placeholders has `QueryParams = Record<string, never>`.

```ts
export type QueryResponse = Array<{_id: string; title: string | null; slug: Slug | null}>
export type QueryParams = {q: string; start: number; end: number}
declare const query: '*[_type == "post" && title match $q] …\n' & {
  readonly __groqResult?: QueryResponse
  readonly __groqParams?: QueryParams
}
export default query
```

`client.fetch(query, params)` infers both types once `@sanity/client` includes [sanity-io/client#1373](https://github.com/sanity-io/client/pull/1373). With an older client, pass the type yourself: `client.fetch<QueryResponse>(query, params)`. `GroqQuery<Query, Result, Params>`, `GroqResult<Q>` and `GroqParams<Q>` are exported for the same shape.

### Imports

A value import needs `with {type: 'text'}`, the [standard text import](https://github.com/tc39/proposal-import-text). At run time the default export is the file's content.

A type-only import needs no attribute. It is erased, so the query string stays out of the bundle:

```ts
import type {QueryResponse} from './postsBySearch.groq'

export function PostList(props: {posts: QueryResponse}) {}
```

When a file needs both the query and its types, write one statement:

```ts
import postsBySearch, {type QueryResponse} from './postsBySearch.groq' with {type: 'text'}
```

A separate `import type` from the same file gets merged by ESLint's `import-x/no-duplicates` autofix, which drops or mangles the attribute.

## Setup

```sh
npm install -D @sanity-labs/groq-content-mapper typescript@beta
```

If the app runs `.groq` imports on Node through the preload (rather than as a bundle), install the package as a regular dependency instead.

```sh
npx sanity schema extract
```

`schema` is required, and the tsconfig is the only configuration. Paths are relative to it:

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

Type-check with the `tsc --noEmit --runExternalCode` script above. The schema file is watched, so extracting it again retypes the imports. A query that does not parse, or a missing schema, still resolves: the unknown parts are `unknown`, and the diagnostic says why. A GROQ syntax error is reported on the `.groq` file as `error groq2`.

### Editor

In VS Code or Cursor, install the TypeScript 7 extension (`TypeScriptTeam.native-preview`) and point it at the project's TypeScript. The extension bundles 7.0:

```jsonc
// .vscode/settings.json
{
  "js/ts.experimental.useTsgo": true,
  "js/ts.tsdk.path": "./node_modules/typescript",
}
```

Trust the workspace, and allow the extension to use the workspace's TypeScript when it asks.

## One schema per folder

A codebase that queries more than one project or dataset has one schema per folder. TypeScript allows one mapper entry per extension, so list the folders inside that entry with `schemas`:

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

A file uses the schema of the deepest folder that contains it, and `schema` when no folder does. Without a `schema`, a file outside every folder gets a diagnostic.

`include` also takes globs, with `/` as the separator on every platform:

```jsonc
{"include": ["src/**/blog/*.groq", "src/*/shop"], "schema": "schemas/shop.json"}
```

A glob that matches a folder includes everything under it, so `src/*/shop` covers `src/eu/shop/deep/products.groq`. For "deepest", a glob counts as its folder before the first wildcard: `src/**/blog/*.groq` is as deep as `src`. Of two entries that are equally deep, the first listed wins. A folder whose name only looks like a glob, such as `app/[locale]`, still includes everything under it.

A `package.json` `imports` alias resolves to the file, so the folder's schema still applies. Node, Bun, Deno and the bundlers resolve `imports` themselves:

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

`with {type: 'text'}` makes the runtime or bundler deliver the file as a string. Where one does not, one line fills in.

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

### Vite, Vitest, Rollup

```ts
// vite.config.ts
import groqFiles from '@sanity-labs/groq-content-mapper/vite'
import {defineConfig} from 'vite'

export default defineConfig({plugins: [groqFiles()]})
```

Vite's dev server does not handle the attribute, so the plugin is needed there even when a production build would work without it.

### Next.js

```ts
// next.config.ts
import {withGroqFiles} from '@sanity-labs/groq-content-mapper/next'

export default withGroqFiles(nextConfig)
```

`withGroqFiles` covers both Turbopack and the webpack Next bundles. It also replaces the type check `next build` runs, which does not pass `--runExternalCode` and so fails on every `.groq` import. The same check runs with the flag after the compile. If the config already sets `typescript.ignoreBuildErrors`, no check is run.

### Jest

```js
// jest.config.js
export default {
  transform: {'\\.groq$': '@sanity-labs/groq-content-mapper/jest'},
}
```

Jest rejects `type: 'text'` in its ES module loader, so this is for tests compiled to CommonJS, where the attribute is dropped.

## Limitations

- A comparison against `^` inside a filter or `[]{...}` over non-object elements, such as `tags[@ == ^.title]`, types its placeholder as `unknown`.
- `score()` is not typed yet, so `_score` is `null`, and a `[_score > 0]` filter empties the result type.
- `include` has no negated globs: `!legacy` is the folder named `!legacy`. Use a deeper entry to give a subfolder another schema.

## License

MIT
