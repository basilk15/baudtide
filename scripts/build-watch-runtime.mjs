import { build } from 'vite';

// Build the same parser/watch implementation for Node, without browser globals
// or a second implementation of threshold and decoder semantics.
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: 'src/lib/desktopWatchRuntime.ts',
    outDir: 'electron/watch-runtime',
    emptyOutDir: false,
    target: 'node22',
    rolldownOptions: { output: { entryFileNames: 'core.mjs' } },
  },
});
