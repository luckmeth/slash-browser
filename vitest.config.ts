import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests target pure logic only — URL resolution, policy evaluation, the tab
 * state machine, permission scope resolution, query building. None of it imports
 * `electron`, which is why these run in plain Node with no Electron harness.
 * Anything that genuinely needs a running app belongs in the Playwright E2E suite.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts']
    }
  }
})
