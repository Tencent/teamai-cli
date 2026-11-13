import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/e2e/**/*.test.ts',
      'src/__tests__/*-e2e.test.ts',
      'validation/*.test.ts',
    ],
    env: {
      // Tests match git's English messages, which git translates on a machine set to another language.
      LC_ALL: 'C.UTF-8',
      // Applied before setupFiles: clear-agent-session-env.ts must remove each,
      // which workflow-test-env.test.ts checks.
      CLAUDE_CODE_SESSION_ID: 'seeded-by-vitest-config', TEAMAI_WORKFLOW_ATTEMPT: 'seeded-by-vitest-config', TEAMAI_LAUNCHED_BY: 'seeded-by-vitest-config', TEAMAI_MODE: 'unattended', CI: 'seeded-by-vitest-config', BASH_ENV: 'seeded-by-vitest-config', T3CODE_THREAD_ID: 'seeded-by-vitest-config', PASEO_AGENT_ID: 'seeded-by-vitest-config',
      // Every variable that moves a tool's root, so the scrub has one of each to remove. Spelled out
      // rather than read from TOOLS: this file is loaded before the product modules it would import.
      CLAUDE_CONFIG_DIR: 'seeded-by-vitest-config', CODEX_HOME: 'seeded-by-vitest-config', CURSOR_DATA_DIR: 'seeded-by-vitest-config', CURSOR_CONFIG_DIR: 'seeded-by-vitest-config',
    },
    // teardown-writers first, so its afterAll runs after the others' and
    // the removals in theirs can still join detached writers.
    // isolate-e2e-env next: the setup file after it imports modules that build
    // home paths at load time.
    setupFiles: [
      'src/__tests__/helpers/teardown-writers.ts',
      'src/__tests__/helpers/isolate-e2e-env.ts',
      'src/__tests__/helpers/clear-agent-session-env.ts',
      'src/__tests__/helpers/yield-between-tests.ts',
      'src/__tests__/helpers/record-retried-tests.ts',
    ],
    // The order above holds only when setup files load one after another.
    sequence: { setupFiles: 'list' },
    // OpenCode's installer replaces a shared binary. Run it before workers.
    // retried-tests.ts prints, at the end, each test that passed only on its retry, which no reporter shows.
    globalSetup: ['src/__tests__/helpers/assert-safe-tmpdir.ts', 'src/__tests__/helpers/prepare-opencode-e2e.ts', 'src/__tests__/helpers/retried-tests.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Build before the runner: rebuilding inside a test would delete dist
    // while another file's CLI subprocess is using it.
    fileParallelism: true,
    // GitHub's runner has 4 vCPUs: 4 workers halve the job against 2.
    maxWorkers: 4,
    // Retry once: flaky tests recover, real bugs stay failed, and retried-tests.ts names each test that recovered.
    retry: 1,
  },
});
