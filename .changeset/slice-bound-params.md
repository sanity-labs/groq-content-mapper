---
'@sanity-labs/groq-content-mapper': patch
---

Type queries whose slice bounds are expressions, such as `[-3...$end]`, `[($start)..$start + $size]` or `[-$n..-1]`. These run fine, but a `.groq` file using one lost its types to a "slicing must use constant numbers" error.
