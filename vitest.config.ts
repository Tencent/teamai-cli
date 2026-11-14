import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    globalSetup: ['src/__tests__/helpers/assert-safe-tmpdir.ts'],
    include: ['src/__tests__/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'oxlint-plugin-teamai/**/*.test.ts', 'scripts/**/*.test.ts'],
    // The vendored anti-slop tests run through oxlint-plugin-teamai/anti-slop.test.ts.
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/*-e2e.test.ts', 'oxlint-plugin-teamai/anti-slop/**'],
    env: {
      // Tests match git's English messages, which git translates on a machine set to another language.
      LC_ALL: 'C.UTF-8',
      // Applied before setupFiles: clear-agent-session-env.ts must remove each,
      // which workflow-test-env.test.ts checks.
      CLAUDE_CODE_SESSION_ID: 'seeded-by-vitest-config', TEAMAI_WORKFLOW_ATTEMPT: 'seeded-by-vitest-config', TEAMAI_LAUNCHED_BY: 'seeded-by-vitest-config', TEAMAI_MODE: 'unattended', CI: 'seeded-by-vitest-config', BASH_ENV: 'seeded-by-vitest-config',
      // Every variable that moves a tool's root, so the scrub has one of each to remove. Spelled out
      // rather than read from TOOLS: this file is loaded before the product modules it would import.
      CLAUDE_CONFIG_DIR: 'seeded-by-vitest-config', CODEX_HOME: 'seeded-by-vitest-config', CURSOR_DATA_DIR: 'seeded-by-vitest-config', CURSOR_CONFIG_DIR: 'seeded-by-vitest-config',
    },
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
    // Retry once on CI: a case that fails once recovers, a real bug stays failed. Local runs do not retry.
    retry: process.env.CI ? 1 : 0,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['src/__tests__/**', 'packages/*/src/**/*.test.ts'],
      reporter: ['cobertura', 'text'],
      reportsDirectory: 'coverage',
    },
  },
});
