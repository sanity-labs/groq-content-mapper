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
import postsBySearch, {type QueryResponse} from './postsBySearch.groq'

const posts = await client.fetch(postsBySearch, {q: 'foo', start: 0, end: 10})
//    ^? QueryResponse, with the params checked
```

Types come from the file as it is. Nothing is written to disk, and nothing is added to the global scope. At run time, one of this package's [loaders](#running-the-imports) delivers the file as a module.

## What an import gives you

Each `.groq` file has three exports:

- The default export is the query string, typed as the query in its file [prettified](#prettify) by [groq-format](https://github.com/atombender/groq-format), comments kept, and still assignable to `string`. With `prettify` turned off, the type is the query exactly as written, comments, whitespace and trailing newline included. When the query calls [custom functions](#custom-groq-functions), their definitions come first, each as written in its own file, and are prettified with it. Hovering `postsBySearch` shows that text. The type is never minified: the loaders [minify](#minify) the string at run time, so with `minify` on, the default, the hover type and the runtime string differ.
- `QueryResponse` is the result type. `[0]` is `T | null`.
- `QueryParams` is the object the `$` placeholders expect. A placeholder compared with a field takes the field's type, `match` takes a string, slice bounds are numbers, and anything the schema says nothing about is `unknown`. A query without placeholders has `QueryParams = Record<string, never>`.

```ts
export type QueryResponse = Array<{_id: string; title: string | null; slug: Slug | null}>
export type QueryParams = {q: string; start: number; end: number}
declare const query: '*[_type == "post" && title match $q] | order(publishedAt desc)[$start...$end] {\n  _id,\n  title,\n  slug\n}' & {
  readonly __groqResult?: QueryResponse
  readonly __groqParams?: QueryParams
}
export default query
```

`client.fetch(query, params)` infers both types once `@sanity/client` includes [sanity-io/client#1373](https://github.com/sanity-io/client/pull/1373). With an older client, pass the type yourself: `client.fetch<QueryResponse>(query, params)`. `GroqQuery<Query, Result, Params>`, `GroqResult<Q>` and `GroqParams<Q>` are exported for the same shape.

### Imports

A value import is a plain import. At run time the default export is the query, as one of this package's [loaders](#running-the-imports) delivers it: with the [custom functions](#custom-groq-functions) it calls prepended, and [minified](#minify) unless `minify` is turned off. Its type is the same text unminified and [prettified](#prettify), so with `minify` or `prettify` on the runtime string differs from the type.

A type-only import is erased, so it needs no loader and the query string stays out of the bundle:

```ts
import type {QueryResponse} from './postsBySearch.groq'

export function PostList(props: {posts: QueryResponse}) {}
```

`import query from './posts.groq' with {type: 'text'}` type-checks the same way, and runs without a loader where the runtime or bundler handles the attribute, but delivers the file as it is, without the custom functions a loader prepends, and never minified. See [Text imports](#text-imports).

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
import posts from '#queries/blog/posts.groq'
import products from '#queries/shop/products.groq'
```

## Custom GROQ functions

[Custom GROQ functions](https://www.sanity.io/docs/content-lake/custom-groq-functions) are defined at the start of the query that calls them. To share them between queries, keep the definitions in files of their own and list those under `functions`, as paths or globs relative to the tsconfig:

```groq
// groq/image.groq
fn image::asset($asset) = $asset->{url, metadata};
fn image::field($image) = $image{crop, hotspot, "asset": image::asset(asset)};
```

```jsonc
{
  "contentMappers": [
    {
      "package": "@sanity-labs/groq-content-mapper",
      "extensions": [".groq"],
      "options": {"schema": "./schema.json", "functions": ["groq/*.groq"]},
    },
  ],
}
```

A query that calls one of them gets its definition prepended, after the definitions of the custom functions it calls in turn. A function is prepended once, and not at all when the query defines it itself or never calls it:

```groq
// postWithImage.groq
*[_type == "post"][0]{title, "image": image::field(mainImage)}
```

```ts
import postWithImage from './postWithImage.groq'
// type: 'fn image::asset($asset) = …;\nfn image::field($image) = …;\n*[_type == "post"][0] {…}', the definitions and the query prettified together
// at run time: 'fn image::asset($asset)=…;fn image::field($image)=…;*[_type=="post"][0]{…}', the same minified
```

The prepended query is what the import's type and `QueryResponse` are inferred from. The type is that text [prettified](#prettify), or as written with `prettify` off, and never minified, so hovering the import shows the definitions and the query in full. The functions files are watched: changing one retypes the queries, and the Vite plugin reloads them. A functions file holds only `fn` definitions, each ending in `;`. They are read with GROQ's Rust parser, [groq-parser](https://github.com/sanity-io/groq-parser-rs) built to WebAssembly, which keeps each definition and the functions its body calls apart; groq-js inlines them as it parses. A missing file, a glob that matches nothing, a definition the parser or groq-js rejects and a name defined in two files are reported against the tsconfig, and on any query that fails while they are not fixed.

A function the query never calls is left out, so is one the query defines itself. Names have to be unique across every file the `functions` option matches.

The definitions are prepended by this package's loaders, which read `functions` and `minify` from this package's entry in the `tsconfig.json` nearest each `.groq` file. A [text import](#text-imports) that a runtime or bundler handles itself delivers the file as it is, so a query there that calls a shared function fails at run time, though it type-checks.

## Minify

`minify` is on by default, and applies in the loaders only. The string a loader delivers is the query, with any custom functions it calls prepended, with comments removed and the whitespace collapsed. The import's type is not minified: it is the query with the same functions prepended, [prettified](#prettify) unless that is turned off, so with `minify` on it differs from the string at run time. Minifying makes a shorter payload to send: the query's tokens, with a space only where two would otherwise run together, as in `title match`. Strings are kept as they are.

| `minify`                    | The loaders deliver the query                    |
| --------------------------- | ------------------------------------------------ |
| not set, `true`             | minified; the same as `{comments: false}`        |
| `{comments: false}`         | minified, comments stripped                      |
| `{comments: true}`, `false` | kept as written, comments and whitespace and all |

The minifier keeps nothing but the query's tokens, so keeping the comments keeps the query as written. Turn it off to send queries as you wrote them, for example to read them in logs:

```jsonc
"options": {"schema": "./schema.json", "minify": {"comments": true}}
```

groq-js can print a query back from its syntax tree, but that rewrites `count()` as `global::count()`, refuses a slice bound that is a parameter, and inlines `fn` definitions, so this does not use it.

Only the loaders read `minify`; the content mapper ignores it. Because the type is never minified, it equals the delivered string only when `minify` keeps the query as written and `prettify` is off. A loader that finds no `tsconfig.json` above a `.groq` file has no options to read and delivers the file as it is.

## Prettify

`prettify` is on by default, and applies to the import's type only. The content mapper types the default export as the query, with any custom functions it calls prepended, printed by [groq-format](https://github.com/atombender/groq-format), built to WebAssembly with the parser. Comments are kept, and lines are wrapped to a column width, 80 unless `width` says otherwise. The loaders never prettify: the string at run time is decided by [`minify`](#minify) alone. A query that does not parse is typed as written.

| `prettify`      | The import is typed as                   |
| --------------- | ---------------------------------------- |
| not set, `true` | prettified to 80 columns                 |
| `{width: 120}`  | prettified to 120 columns                |
| `false`         | the query as written, whitespace and all |

```jsonc
"options": {"schema": "./schema.json", "prettify": {"width": 120}}
```

Turn it off to have hovering an import show the query exactly as it is in the file:

```jsonc
"options": {"schema": "./schema.json", "prettify": false}
```

## Running the imports

A `.groq` import needs one of this package's loaders, which deliver the file as a module whose default export is the query, with the custom functions it calls prepended and minified unless `minify` is turned off. Each is one line.

| Runtime or bundler          | Setup                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| Node 22.12 and later        | `node --import @sanity-labs/groq-content-mapper/register main.ts`       |
| Vite, Vitest, Rollup        | the Vite plugin                                                         |
| Sanity Studio, App SDK apps | the Vite plugin, in `vite: {plugins: [groqFiles()]}` of `sanity.cli.ts` |
| Next.js 16.3 and later      | `withGroqFiles`                                                         |
| webpack, Rspack             | the loader, in a module rule                                            |
| Jest                        | the Jest transformer                                                    |

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

### Next.js

```ts
// next.config.ts
import {withGroqFiles} from '@sanity-labs/groq-content-mapper/next'

export default withGroqFiles(nextConfig)
```

`withGroqFiles` adds the loader to both Turbopack and the webpack Next bundles. It also replaces the type check `next build` runs, which does not pass `--runExternalCode` and so fails on every `.groq` import. The same check runs with the flag after the compile. If the config already sets `typescript.ignoreBuildErrors`, no check is run.

### webpack and Rspack

```js
// webpack.config.js
export default {
  module: {
    rules: [
      {test: /\.groq$/, type: 'javascript/auto', use: '@sanity-labs/groq-content-mapper/loader'},
    ],
  },
}
```

### Jest

```js
// jest.config.js
export default {
  transform: {'\\.groq$': '@sanity-labs/groq-content-mapper/jest'},
}
```

## Text imports

`import query from './posts.groq' with {type: 'text'}`, the [standard text import](https://github.com/tc39/proposal-import-text), type-checks like a plain import. Bun, Deno, esbuild, webpack 5.102 and later, Rspack 1.7 and later, Rolldown with `moduleTypes: {'.groq': 'text'}` and Node 26.5 and later with `--experimental-import-text` run it with no setup. They deliver the file as it is, though: without the shared functions it calls, not minified, and without whatever this package adds to the query later. Their string is the file as written, so it equals the import's type only for a query that calls no custom function; a loader's string is minified by default, so it differs from the type, though the query and its results are the same. Where the file is a complete query of its own, it works; it is not the recommended way to import. Next.js and webpack hand a text import to the bundler even with the loader set up, while the Node preload and the Vite plugin still deliver the file through this package.

## Limitations

- A comparison against `^` inside a filter or `[]{...}` over non-object elements, such as `tags[@ == ^.title]`, types its placeholder as `unknown`.
- `include` has no negated globs: `!legacy` is the folder named `!legacy`. Use a deeper entry to give a subfolder another schema.
- A file added where a `functions` glob would match it is picked up when the project is next opened, as by restarting `tsc --watch` or the editor's TypeScript server. Changes to files already matched are picked up at once.

## License

MIT
