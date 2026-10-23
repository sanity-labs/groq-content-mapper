# @sanity-labs/groq-content-mapper

## 0.1.6

### Patch Changes

- [#32](https://github.com/sanity-labs/groq-content-mapper/pull/32) [`2fc56f1`](https://github.com/sanity-labs/groq-content-mapper/commit/2fc56f1f3bf52d299138794279860389d0e59638) Thanks [@stipsan](https://github.com/stipsan)! - The Node preload loads a `.groq` file whose folder or file name has a `#` or `?` in it.

- [#33](https://github.com/sanity-labs/groq-content-mapper/pull/33) [`f0e7012`](https://github.com/sanity-labs/groq-content-mapper/commit/f0e7012e4822e39b1383bfc706e6a7afca5dfce6) Thanks [@stipsan](https://github.com/stipsan)! - README: spell out `schemaExtraction`'s `path` and `enforceRequiredFields` defaults in the "Generate a schema" `sanity.cli.ts` snippet, so the output path lines up with the mapper's own `schema.json` setting.

- [#31](https://github.com/sanity-labs/groq-content-mapper/pull/31) [`2d386b9`](https://github.com/sanity-labs/groq-content-mapper/commit/2d386b96398abe6abd233251304f9d3279c196dc) Thanks [@stipsan](https://github.com/stipsan)! - Type a `.groq` module against a schema with a type named `record`. Its alias, `Record`, shadowed TypeScript's `Record` in `QueryParams`, so the module failed with "Type 'Record' is not generic". It is now `Record_2` within the module.

## 0.1.5

### Patch Changes

- [#21](https://github.com/sanity-labs/groq-content-mapper/pull/21) [`525628e`](https://github.com/sanity-labs/groq-content-mapper/commit/525628e839700074edc2bfc4e755fff6150aaec4) Thanks [@stipsan](https://github.com/stipsan)! - Say what is wrong with a `schemas` entry in plain words, such as `Unknown key "typo"` or `A folder in "include" must be a path` at the folder's index, instead of valibot's `Invalid key: Expected never`. A file system root, `/` or `C:\`, as an `include` folder now contains the files under it.

- [#27](https://github.com/sanity-labs/groq-content-mapper/pull/27) [`6e4ed32`](https://github.com/sanity-labs/groq-content-mapper/commit/6e4ed32cc36d0972b81514ac9f099d84a2a10b4a) Thanks [@stipsan](https://github.com/stipsan)! - `serveJsonRpc` answers a handler that resolves to `undefined` with `"result": null`. The response had no `result`, which JSON-RPC 2.0 requires on success.

- [#21](https://github.com/sanity-labs/groq-content-mapper/pull/21) [`525628e`](https://github.com/sanity-labs/groq-content-mapper/commit/525628e839700074edc2bfc4e755fff6150aaec4) Thanks [@stipsan](https://github.com/stipsan)! - Type queries whose slice bounds are expressions, such as `[-3...$end]`, `[($start)..$start + $size]` or `[-$n..-1]`. These run fine, but a `.groq` file using one lost its types to a "slicing must use constant numbers" error.

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
