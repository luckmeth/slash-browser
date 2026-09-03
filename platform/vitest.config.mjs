import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Its own config so the browser's vitest.config.ts one directory up is not
// picked up instead — that one sets aliases for the Electron source tree.
export default defineConfig({
  // Next compiles JSX itself, and its tsconfig says `preserve` -- which the
  // bundler under vitest cannot emit. The plugin does that transform here so
  // the real components can be rendered in a test.
  plugins: [react()],
  resolve: {
    alias: {
      // The same alias Next resolves for the admin app, so a component under
      // test imports exactly what it imports in the application.
      '@': fileURLToPath(new URL('./admin', import.meta.url))
    }
  },
  test: {
    // The desktop shell's rules live in plain CJS beside main.js, because
    // main.js cannot be imported here at all — it requires electron.
    include: ['shared/src/**/*.test.ts', 'admin-desktop/*.test.mjs', 'admin/**/*.test.tsx'],
    // Node by default, so the pure modules keep running in the environment
    // they are deployed in. A React test asks for a DOM with a
    // `@vitest-environment jsdom` docblock at the top of its own file.
    environment: 'node'
  }
})
