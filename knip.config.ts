import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  // `pnpm change` is a pnpm 12 built-in, not a package binary.
  ignoreBinaries: ['change'],
  workspaces: {
    '.': {
      // oxlint loads `tsrs` at runtime for type-aware linting; it isn't a declared peer of oxlint.
      ignoreDependencies: ['tsrs'],
    },
    'packages/groq-content-mapper': {
      entry: [
        'src/{index,jest,loader,next,register,vite,nodeHooks}.ts',
        'src/bin/contentMapper.ts',
      ],
      project: ['src/**/*.ts', '*.ts'],
      // `withGroqFiles` resolves the app's own `next` at build time.
      ignoreDependencies: ['next'],
    },
  },
}

export default config
