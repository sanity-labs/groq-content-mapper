---
'@sanity-labs/groq-content-mapper': patch
---

Write the type of a `.groq` default import as a template literal prefixed with `/* groq */`, keeping the query's line breaks in the literal. That is the spelling the Sanity VS Code extension highlights. The type is still that same string. Prettify, the prepended custom functions and loader minify are unchanged.
