import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['src/__tests__/helpers/assert-safe-tmpdir.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/*-e2e.test.ts'],
    // Applied before setupFiles: clear-agent-session-env.ts must remove each,
    // which workflow-test-env.test.ts checks.
    env: { CLAUDE_CODE_SESSION_ID: 'seeded-by-vitest-config', TEAMAI_WORKFLOW_ATTEMPT: 'seeded-by-vitest-config', TEAMAI_LAUNCHED_BY: 'seeded-by-vitest-config', TEAMAI_MODE: 'unattended', CI: 'seeded-by-vitest-config' },
    // teardown-writers first, so its afterAll runs after the others' and
    // the removals in theirs can still join detached writers.
    // isolate-home next: the setup file after it imports modules that build
    // home paths at load time.
    setupFiles: [
      'src/__tests__/helpers/teardown-writers.ts',
      'src/__tests__/helpers/isolate-home.ts',
      'src/__tests__/helpers/clear-agent-session-env.ts',
    ],
    // The order above holds only when setup files load one after another.
    sequence: { setupFiles: 'list' },
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
