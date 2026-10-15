delete process.env.ELECTRON_RUN_AS_NODE
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // The agent-browser tab strip is its own page: it must keep working when
          // the Harness page is a recovery page, so it gets a dedicated narrow bridge.
          'agent-browser-pane': resolve('src/preload/agent-browser-pane.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  }
})