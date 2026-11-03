import { defineConfig } from 'vitest/config';
import { MACOS_TESTS } from './src/__tests__/helpers/macos-tests.js';

// CI sets this on the macOS job. Unset, the full suite runs.
const macos = process.env.TEAMAI_VITEST_SCOPE === 'macos';

export default defineConfig({
  test: {
    clearMocks: true,
    globalSetup: ['src/__tests__/helpers/assert-safe-tmpdir.ts'],
    include: macos
      ? [...MACOS_TESTS]
      : ['src/__tests__/**/*.test.ts', 'oxlint-plugin-teamai/**/*.test.ts', 'scripts/**/*.test.ts'],
    // The vendored anti-slop tests run through oxlint-plugin-teamai/anti-slop.test.ts.
    // The macOS list names its files, including one under e2e/, so the exclude would drop it.
    exclude: macos ? [] : ['src/__tests__/e2e/**', 'src/__tests__/*-e2e.test.ts', 'oxlint-plugin-teamai/anti-slop/**'],
    env: {
      // Tests match git's English messages, which git translates on a machine set to another language.
      LC_ALL: 'C.UTF-8',
      // Applied before setupFiles: clear-agent-session-env.ts must remove each,
      // which workflow-test-env.test.ts checks.
      CLAUDE_CODE_SESSION_ID: 'seeded-by-vitest-config', TEAMAI_WORKFLOW_ATTEMPT: 'seeded-by-vitest-config', TEAMAI_LAUNCHED_BY: 'seeded-by-vitest-config', TEAMAI_MODE: 'unattended', CI: 'seeded-by-vitest-config', BASH_ENV: 'seeded-by-vitest-config',
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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      reporter: ['cobertura', 'text'],
      reportsDirectory: 'coverage',
    },
  },
});
