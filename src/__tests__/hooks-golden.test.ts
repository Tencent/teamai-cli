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
];

describe('hooks golden — built-in output is byte-identical to the captured baseline', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-golden-'));
  });
  afterEach(async () => {
    await fse.remove(tmp);
  });

  for (const [tool, file] of cases) {
    it(`${tool} output matches golden fixture`, async () => {
      const p = path.join(tmp, tool, file);
      await injectHooks(p, tool);
      const got = await fse.readFile(p, 'utf-8');
      const want = await fse.readFile(path.join(fixturesDir, `${tool}.json`), 'utf-8');
      expect(got).toBe(want);
    });
  }
});
