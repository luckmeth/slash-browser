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
    /*
     * Raised from vitest's 5s default because the suite outgrew it on CI, not
     * because anything here is slow.
     *
     * `PermissionManager > denies when no window can show the prompt` timed out
     * at 5187ms on a GitHub Windows runner while passing in single-digit
     * milliseconds locally, every time. Its whole path is synchronous —
     * `showPrompt` returns false, `settle` looks up a map, calls a hook and
     * resolves — with no timer, no IO and nothing awaited, so a five-second
     * duration cannot be the code waiting for something. It is a worker starved
     * of CPU on a two-core runner now sharing it with 2,000 tests.
     *
     * This weakens no assertion: a promise that never resolves, or resolves
     * wrongly, still fails. It only stops a slow machine being reported as a
     * broken browser.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts']
    }
  }
})
