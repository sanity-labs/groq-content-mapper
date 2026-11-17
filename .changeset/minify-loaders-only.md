---
'@sanity-labs/groq-content-mapper': minor
---

Minify in the loaders only, not in TypeScript types. The type of a `.groq` default import is now the exact text of the file, comments and whitespace included, so hovering `postsBySearch` in `import postsBySearch from './postsBySearch.groq'` shows what the file holds. The `minify` option is unchanged and the loaders still apply it at run time: `true`, the default, and `{comments: false}` strip and minify the query, and `{comments: true}` and `false` keep it as written. It is expected that the hover type and the runtime string differ when `minify` is on. `QueryResponse`, `QueryParams` and the other generated types are unchanged.

The string type no longer includes the custom functions the query calls either; the loaders still prepend their definitions at run time, and the result and params types still account for them. `generateGroqModule` no longer takes a `literal` option, and `GroqModule.query` is the file's content.
