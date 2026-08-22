import { defineConfig } from 'vitest/config'

// Its own config so the browser's vitest.config.ts one directory up is not
// picked up instead — that one sets aliases for the Electron source tree.
export default defineConfig({
  test: {
    include: ['shared/src/**/*.test.ts'],
    environment: 'node'
  }
})
