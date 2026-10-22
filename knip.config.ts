import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  workspaces: {
    '.': {},
    'packages/groq-content-mapper': {
      entry: ['src/{index,jest,next,register,vite,nodeHooks}.ts', 'src/bin/contentMapper.ts'],
      project: ['src/**/*.ts', '*.ts'],
      // `withGroqFiles` resolves the app's own `next` at build time.
      ignoreDependencies: ['next'],
    },
  },
}

export default config
