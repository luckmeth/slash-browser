import { defineConfig } from 'vitest/config'

// Its own config so the browser's vitest.config.ts one directory up is not
// picked up instead — that one sets aliases for the Electron source tree.
export default defineConfig({
  test: {
    // The desktop shell's rules live in plain CJS beside main.js, because
    // main.js cannot be imported here at all -- it requires electron.
    include: ['shared/src/**/*.test.ts', 'admin-desktop/*.test.mjs'],
    environment: 'node'
  }
})
