/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Alias @trialpulse/shared to the shared package's TypeScript source (not the
// built dist/) so that:
//  - vitest resolves the workspace contract without requiring a prior
//    `npm run build -w @trialpulse/shared` before every test run
//  - type information stays in lockstep with the source of truth
// Rollup tree-shakes unused named exports (e.g. the Node-only hash helpers in
// @trialpulse/shared/hash.ts), so none of that module's `node:crypto` usage
// reaches the production browser bundle as long as the tab never imports it.
const sharedSrc = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));
const nodeCryptoShim = fileURLToPath(new URL('./src/shims/node-crypto-browser-shim.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@trialpulse/shared': sharedSrc,
      // See src/shims/node-crypto-browser-shim.ts: satisfies Rollup's binding
      // resolution for the unused `createHash` import inside
      // @trialpulse/shared/hash.ts without ever executing real Node crypto
      // in the browser bundle.
      'node:crypto': nodeCryptoShim,
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
