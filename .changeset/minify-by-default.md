---
'@sanity-labs/groq-content-mapper': minor
---

**Breaking:** rename the `minimize` option to `minify`, and turn it on by default. Every `.groq` import is now typed as, and delivered by the loaders as, the query with comments removed and whitespace collapsed. `minify: true` is the same as `minify: {comments: false}`. Set `minify: {comments: true}`, or `minify: false`, to keep queries as written. `minimize` is no longer accepted: rename it to `minify`.

The content mapper and the loaders share one default, so an import's type and the string it delivers agree. Text imports that a runtime or bundler handles itself (Bun, Deno, esbuild, webpack, Rspack, Rolldown, Node's `--experimental-import-text`), and a loader that finds no `tsconfig.json`, still deliver the file as it is, so with `minify` on their literal type does not match the string at run time. Query text changes after upgrading, so expect a one-time miss on caches keyed by it.
