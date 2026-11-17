---
'@sanity-labs/groq-content-mapper': patch
---

Show a `.groq` import's query on its own lines when it is hovered. TypeScript prints the string literal type on one line with `\n` escapes, so the declaration now also carries the query, prettified unless `prettify` is off, in a doc comment as a fenced `groq` block. The hover renders that block below the type, and the Sanity VS Code extension highlights it. The type itself is unchanged.
