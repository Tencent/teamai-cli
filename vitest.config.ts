import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/*-e2e.test.ts'],
    // CI workers can be resource-constrained under parallel load, which made
    // otherwise-fast tests sporadically exceed vitest's 5s default timeout.
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['cobertura', 'text'],
      reportsDirectory: 'coverage',
    },
  },
});
