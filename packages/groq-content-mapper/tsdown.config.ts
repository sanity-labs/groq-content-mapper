import {defineConfig} from '@sanity/tsdown-config'
import type {UserConfig} from 'tsdown'

// `satisfies Promise<UserConfig>` names the return type through this package's own `tsdown`
// dependency, which keeps the declaration emit portable (TS2883).
export default defineConfig({
  tsconfig: 'tsconfig.build.json',
  // `nodeHooks` is its own entry because `register` hands it to `module.register` by URL on Node
  // before 22.15; `bin/contentMapper` is what `typescript.contentMapper.exec` runs.
  entry: {
    'index': './src/index.ts',
    'jest': './src/jest.ts',
    'next': './src/next.ts',
    'nodeHooks': './src/nodeHooks.ts',
    'register': './src/register.ts',
    'vite': './src/vite.ts',
    'bin/contentMapper': './src/bin/contentMapper.ts',
  },
  // `exports` points at the build, not the sources: Node runs `register` from it and TypeScript
  // runs the content mapper from it, in this repository's tests as in a project.
  exports: {devExports: false, exclude: [/^nodeHooks$/, /^bin\//]},
}) satisfies Promise<UserConfig>
