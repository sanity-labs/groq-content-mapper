# groq-content-mapper

Typed `.groq` file imports for TypeScript 7.1 and later, from your Sanity schema.

```ts
import postsBySearch, {type QueryResponse} from './postsBySearch.groq'
```

See [`packages/groq-content-mapper`](./packages/groq-content-mapper#readme) for usage and setup.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

`packages/groq-content-mapper/wasm` is the build of the Rust crate in `packages/groq-content-mapper/rust`, which parses GROQ with [groq-parser](https://github.com/sanity-io/groq-parser-rs). It is committed, so only a change to the crate needs Rust: `pnpm --filter @sanity-labs/groq-content-mapper build:wasm` rebuilds it with the toolchain `rust/rust-toolchain.toml` pins and `wasm-bindgen-cli` at the version `rust/Cargo.toml` pins. CI rebuilds it and fails on a difference.

Every user-facing change needs a changeset: run `pnpm changeset` and commit the file it writes. Merging to `main` opens or updates the release PR, and merging that publishes to npm.
