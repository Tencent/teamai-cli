import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/e2e/**/*.test.ts',
      'src/__tests__/*-e2e.test.ts',
      'validation/*.test.ts',
    ],
    // isolate-e2e-env first: the other setup file imports modules that build
    // home paths at load time.
    setupFiles: [
      'src/__tests__/helpers/isolate-e2e-env.ts',
      'src/__tests__/helpers/clear-agent-session-env.ts',
      'src/__tests__/helpers/yield-between-tests.ts',
    ],
    // OpenCode's installer replaces a shared binary. Run it before workers.
    globalSetup: ['src/__tests__/helpers/prepare-opencode-e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Build before the runner: rebuilding inside a test would delete dist
    // while another file's CLI subprocess is using it.
    fileParallelism: true,
    minWorkers: 1,
    // GitHub's runner has 4 vCPUs: 4 workers halve the job against 2.
    maxWorkers: 4,
    // Retry once: flaky tests recover, real bugs stay failed.
    retry: 1,
  },
});
