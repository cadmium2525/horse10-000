import { defineConfig } from 'vitest/config';

// GitHub Pages (project site) is served from /<repo-name>/.
export default defineConfig({
  base: '/horse10-000/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
