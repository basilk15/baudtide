import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Keep production assets relative to dist/index.html so they resolve under
  // the stable baudtide://app origin. This is transparent to the Vite servers.
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
