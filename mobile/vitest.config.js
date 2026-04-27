import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.js', 'test/server/**/*.test.js'],
    globals: false,
  },
});
