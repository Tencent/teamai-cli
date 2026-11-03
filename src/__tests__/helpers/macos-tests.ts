/**
 * Unit test files the macOS CI job runs in full (vitest.macos.config.ts).
 * Alphabetical. A file is here when its result depends on the machine: the
 * `/tmp` → `/private/tmp` symlink, or `path_helper` rebuilding PATH.
 *
 * `git-exclude.test.ts` is not here. Almost every case there is the same on
 * Linux; CI runs the two that are not (precomposed names, and the on-disk
 * spelling on a case-insensitive volume) by name. See ci.yml.
 */
export const MACOS_TESTS = [
  'src/__tests__/e2e/providers-cli-path.test.ts',
  'src/__tests__/macos-test-list.test.ts',
  'src/__tests__/migrate-image-and-cursor-id.test.ts',
  'src/__tests__/session-target-id.test.ts',
] as const;
