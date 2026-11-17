---
'@sanity-labs/groq-content-mapper': minor
---

`.groq` imports are plain imports, run by this package's loaders: the Node preload, the Vite plugin, the Jest transformer, `withGroqFiles` for Next.js, and a new webpack loader at `./loader`. A `with {type: 'text'}` import still works where the runtime or bundler handles the attribute, but delivers the file as it is.

Add the `functions` option: files or globs of custom GROQ function definitions. A query that calls one gets its definition, and those of the functions it calls, prepended, both in its type and by the Node preload, the Vite plugin, the Jest transformer and the webpack loader. The definitions are read with GROQ's Rust parser, groq-parser, built to WebAssembly. `minimize` drops comments and whitespace from the emitted query.
