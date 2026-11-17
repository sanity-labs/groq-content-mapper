---
'@sanity-labs/groq-content-mapper': minor
---

Prettify the type of a `.groq` default import with the [groq-format](https://github.com/atombender/groq-format) crate, built into the package's WebAssembly next to the parser. The hover text of `import posts from './posts.groq'` is the query, with the custom functions it calls prepended, formatted and wrapped to 80 columns, comments kept. A new `prettify` option sets the column width with `{"width": 120}`, and `"prettify": false` turns it off, typing the import as written. It is on by default. The loaders never prettify, so `minify` alone decides the string at run time. `generateGroqModule` takes the same `prettify` option, with the same default.
