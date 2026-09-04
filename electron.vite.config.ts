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
    plugins: [
      externalizeDepsPlugin({
        // Readability is imported with `?raw` so its source can be injected into
        // a page on demand. Externalising it would leave a literal
        // `require('...Readability.js?raw')` in the bundle, which resolves to
        // nothing at runtime — Vite has to process the import for it to inline.
        exclude: ['@mozilla/readability']
      })
    ],
    resolve: {
      alias: {
        '@shared': shared,
        '@main': resolve(__dirname, 'src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          /**
           * The embedding worker is a second entry, not part of the main bundle.
           * `utilityProcess.fork` needs a real file to launch, and the ONNX
           * runtime it pulls in must never be loadable from the main process by
           * accident — a separate entry makes that structural rather than a
           * convention someone has to remember.
           *
           * Emitted next to index.js, so `join(__dirname, 'embeddingWorker.js')`
           * resolves identically in dev and inside the asar.
           */
          embeddingWorker: resolve(__dirname, 'src/main/memory/embedding/worker.ts'),
          /**
           * The filter compiler, for the same reason as the embedding worker.
           * Parsing 4.3 MB of EasyList takes ~900ms; deserialising the result
           * takes 7ms. The expensive half must never run on the main thread.
           */
          filterCompiler: resolve(__dirname, 'src/main/shield/adblock/compiler.ts')
        }
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
