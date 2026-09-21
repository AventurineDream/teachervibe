/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the static build can be served from any path (lilbox, tailnet, GitHub Pages mirror).
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node'
  }
});
