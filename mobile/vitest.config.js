import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ['test/unit/**', 'happy-dom'],
      ['test/server/**', 'node'],
    ],
    include: ['test/unit/**/*.test.js', 'test/server/**/*.test.js'],
    globals: false,
  },
});
