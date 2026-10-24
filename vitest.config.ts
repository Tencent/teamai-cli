import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['src/__tests__/helpers/assert-safe-tmpdir.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/*-e2e.test.ts'],
    // isolate-home first: the other setup file imports modules that build
    // home paths at load time.
    setupFiles: [
      'src/__tests__/helpers/isolate-home.ts',
      'src/__tests__/helpers/clear-agent-session-env.ts',
    ],
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
