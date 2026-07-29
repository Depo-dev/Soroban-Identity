import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/integration/**/*.integration.test.ts'],
    globals: true,
    testTimeout: 60000, // 60 seconds per test
    hookTimeout: 120000, // 2 minutes for setup/teardown
    poolOptions: {
      threads: {
        singleThread: true, // Run tests sequentially to avoid Docker conflicts
      },
    },
  },
});
