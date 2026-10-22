---
'@sanity-labs/groq-content-mapper': patch
---

Say what is wrong with a `schemas` entry in plain words, such as `Unknown key "typo"` or `A folder in "include" must be a path` at the folder's index, instead of valibot's `Invalid key: Expected never`. A file system root, `/` or `C:\`, as an `include` folder now contains the files under it.
