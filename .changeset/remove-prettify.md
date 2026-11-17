---
'@sanity-labs/groq-content-mapper': minor
---

**Breaking:** remove the `prettify` option and its `width` setting, including from `generateGroqModule`. `prettify` is no longer accepted. A `.groq` import is typed as the query as written, with the custom functions it calls prepended exactly as they are written in their files. The hover doc comment shows that same text in a fenced `groq` block, with the source's line breaks. `minify` is unchanged, including dropping a trailing comma from an object, a projection, an array, or a function argument list.
