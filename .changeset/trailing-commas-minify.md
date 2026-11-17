---
'@sanity-labs/groq-content-mapper': patch
---

Drop a trailing comma when minifying a GROQ query. An object, a projection, an array, and a function argument list lose a final comma the query does not need. Comments, whitespace, and the rest of minify are unchanged, and prettify is untouched.
