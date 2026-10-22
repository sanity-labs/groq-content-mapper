---
'@sanity-labs/groq-content-mapper': patch
---

`serveJsonRpc` answers a handler that resolves to `undefined` with `"result": null`. The response had no `result`, which JSON-RPC 2.0 requires on success.
