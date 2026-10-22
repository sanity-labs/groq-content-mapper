# @sanity-labs/groq-content-mapper

## 0.1.4

### Patch Changes

- [#22](https://github.com/sanity-labs/groq-content-mapper/pull/22) [`e76cb0a`](https://github.com/sanity-labs/groq-content-mapper/commit/e76cb0a4b58a268e789a136e156337bd87d1aaf8) Thanks [@stipsan](https://github.com/stipsan)! - Type a `.groq` file whose last line is a `//` comment with no newline after it. groq-js reported a syntax error for it.

## 0.1.3

### Patch Changes

- [#20](https://github.com/sanity-labs/groq-content-mapper/pull/20) [`01cb51f`](https://github.com/sanity-labs/groq-content-mapper/commit/01cb51f30b717951fe830c5d5129f1f9f7865dbd) Thanks [@stipsan](https://github.com/stipsan)! - Update `@babel/generator` and `@babel/types` to ^7.29.8.

## 0.1.2

### Patch Changes

- [#17](https://github.com/sanity-labs/groq-content-mapper/pull/17) [`b0ba1b2`](https://github.com/sanity-labs/groq-content-mapper/commit/b0ba1b2d66420d4a47724d2fe3d7988b55aa3f93) Thanks [@stipsan](https://github.com/stipsan)! - Bump `@sanity/codegen` to 8.3.0, which exports `SchemaTypeGenerator` publicly. The internal fallback this package used while the API was private is removed.

- [#16](https://github.com/sanity-labs/groq-content-mapper/pull/16) [`64ad90e`](https://github.com/sanity-labs/groq-content-mapper/commit/64ad90e01857ad97717cf774fc9f5d00e2e2f01c) Thanks [@stipsan](https://github.com/stipsan)! - Infer the type of a param compared against `^`

- [#18](https://github.com/sanity-labs/groq-content-mapper/pull/18) [`84e1f6f`](https://github.com/sanity-labs/groq-content-mapper/commit/84e1f6fb08ebe1cb6985678add95885de8ffdb5b) Thanks [@stipsan](https://github.com/stipsan)! - README: rename the example query's `$searchQuery` param to `$q` and order by `publishedAt` instead of `_createdAt`, and add a "Generate a schema" section showing the minimal `sanity.cli.ts`/`sanity.config.ts` needed for `sanity schema extract` to produce `schema.json`.

## 0.1.1

### Patch Changes

- [#4](https://github.com/sanity-labs/groq-content-mapper/pull/4) [`0a9cfa6`](https://github.com/sanity-labs/groq-content-mapper/commit/0a9cfa658c91852451a1fea1a73da0f495f409a2) Thanks [@stipsan](https://github.com/stipsan)! - Pin `@sanity/codegen` to an exact version. Each new release is adopted on its own, after CI.

- [#3](https://github.com/sanity-labs/groq-content-mapper/pull/3) [`30e2535`](https://github.com/sanity-labs/groq-content-mapper/commit/30e2535e70dcf55b774f8bff25f5d5dde16a6f9a) Thanks [@stipsan](https://github.com/stipsan)! - State the TypeScript 7.1, Node.js, and `tsc --runExternalCode` requirements at the top of the README.

## 0.1.0

### Minor Changes

- [#1](https://github.com/sanity-labs/groq-content-mapper/pull/1) [`3a68173`](https://github.com/sanity-labs/groq-content-mapper/commit/3a68173be179605a27c15061a792cac70641fb48) Thanks [@stipsan](https://github.com/stipsan)! - Type `.groq` file imports with a TypeScript 7.1 content mapper, configured in `tsconfig.json` with the schema `sanity schema extract` writes, and run them with `/register` (Node), `/vite`, `/jest` or `/next`.
