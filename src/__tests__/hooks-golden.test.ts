import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { injectHooks } from '../hooks.js';

// Byte-equality anchor for the built-in (A) hooks (issue #19 §8 "兼容锚点").
// fixtures/hooks/<tool>.json were captured from the pre-refactor injector.
// Any refactor of the injection engine MUST keep these byte-identical so that
// already-installed machines see a zero-diff reconcile after a CLI upgrade.
const fixturesDir = path.resolve(__dirname, 'fixtures', 'hooks');

const cases: Array<[string, string]> = [
  ['claude', 'settings.json'],
  ['claude-internal', 'settings.json'],
  ['codebuddy', 'settings.json'],
  ['cursor', 'hooks.json'],
  ['workbuddy', 'settings.json'],
];

/**
 * Tools whose rendered command is platform-specific, so they have no
 * cross-platform baseline: codebuddy is rendered in cmd.exe syntax on Windows
 * (its hook runner there is cmd.exe, not a POSIX shell — see
 * bundled-runtime.ts), exactly like ZCode, which is absent from the fixture set
 * for the same reason. Their Windows shape is pinned by
 * hooks-shell-check.test.ts instead, so the anchor stays platform-independent.
 */
const PLATFORM_SPECIFIC_TOOLS = new Set(['codebuddy']);

describe('hooks golden — built-in output is byte-identical to the captured baseline', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-golden-'));
  });
  afterEach(async () => {
    await fse.remove(tmp);
  });

  for (const [tool, file] of cases) {
    const skip = process.platform === 'win32' && PLATFORM_SPECIFIC_TOOLS.has(tool);
    it.skipIf(skip)(`${tool} output matches golden fixture`, async () => {
      const p = path.join(tmp, tool, file);
      await injectHooks(p, tool);
      const got = await fse.readFile(p, 'utf-8');
      const want = await fse.readFile(path.join(fixturesDir, `${tool}.json`), 'utf-8');
      expect(got).toBe(want);
    });
  }
});
