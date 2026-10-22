# groq-content-mapper

Typed `.groq` file imports for TypeScript 7.1 and later, from your Sanity schema.

```ts
import postsBySearch, {type QueryResponse} from './postsBySearch.groq' with {type: 'text'}
```

See [`packages/groq-content-mapper`](./packages/groq-content-mapper#readme) for usage and setup.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Every user-facing change needs a changeset: run `pnpm changeset` and commit the file it writes. Merging to `main` opens or updates the release PR, and merging that publishes to npm.
