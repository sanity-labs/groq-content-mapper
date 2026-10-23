---
'@sanity-labs/groq-content-mapper': patch
---

Type a `.groq` module against a schema with a type named `record`. Its alias, `Record`, shadowed TypeScript's `Record` in `QueryParams`, so the module failed with "Type 'Record' is not generic". It is now `Record_2` within the module.
