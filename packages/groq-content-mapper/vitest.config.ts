import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/__tests__/**'],
      include: ['src/**'],
      provider: 'v8',
    },
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
})
