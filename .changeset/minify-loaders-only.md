---
'@sanity-labs/groq-content-mapper': minor
---

Minify in the loaders only, not in TypeScript types. The type of a `.groq` default import is the query as written in its file, comments and whitespace included, with the custom functions it calls prepended, each exactly as written in its own file. Hovering `postsBySearch` in `import postsBySearch from './postsBySearch.groq'` shows that text, never a minified form. The `minify` option is unchanged and the loaders still apply it at run time, after prepending the same functions: `true`, the default, and `{comments: false}` strip and minify the query, and `{comments: true}` and `false` keep it as written. It is expected that the hover type and the runtime string differ when `minify` is on. `QueryResponse`, `QueryParams` and the other generated types are unchanged.

`generateGroqModule` no longer takes a `literal` option: the string type is `query`, as written.
