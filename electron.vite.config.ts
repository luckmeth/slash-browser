import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  /**
   * Main process. `externalizeDepsPlugin` keeps everything in package.json
   * `dependencies` out of the bundle — essential for better-sqlite3, which is a
   * native module and must be loaded from node_modules at runtime, not inlined.
   */
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': shared,
        '@main': resolve(__dirname, 'src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },

  /**
   * Preload scripts. Both run with `sandbox: true`, which means Chromium loads
   * them as a single CommonJS file with no Node module system available beyond
   * a small builtin allowlist. So: bundle everything, emit CJS, never externalize
   * anything except `electron` itself.
   */
  preload: {
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        external: ['electron'],
        input: {
          chrome: resolve(__dirname, 'src/preload/chrome.ts'),
          content: resolve(__dirname, 'src/preload/content.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },

  /**
   * Renderer. Two separate documents: the browser chrome and the transparent
   * overlay. They are distinct HTML entries because they load into distinct
   * WebContentsViews stacked in the same window.
   */
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
