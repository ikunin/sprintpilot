import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 8_200_000, // ~2.3 hours max (8 sessions * 17 min each for greenfield loop)
    hookTimeout: 300_000, // 5 min for setup/teardown
    fileParallelism: false, // Run test files sequentially (each costs $$$)
  },
});
