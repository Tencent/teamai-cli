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
//
// Windows: the dispatch shell resolves a bare `bash` to the WSL launcher, so
// the injector names Git Bash by absolute path instead — machine-specific, and
// the Linux-captured fixtures cannot match it. Only the dispatch-command
// renderers (claude, claude-internal, cursor) skip there; the wrapper
// renderers (codebuddy, workbuddy) stay machine-independent and keep coverage.
const fixturesDir = path.resolve(__dirname, 'fixtures', 'hooks');

// true = the command carries the dispatch shell prefix (`getDispatchCommand`).
const cases: Array<[string, string, boolean]> = [
  ['claude', 'settings.json', true],
  ['claude-internal', 'settings.json', true],
  ['codebuddy', 'settings.json', false],
  ['cursor', 'hooks.json', true],
  ['workbuddy', 'settings.json', false],
];

describe('hooks golden — built-in output is byte-identical to the captured baseline', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-golden-'));
  });
  afterEach(async () => {
    await fse.remove(tmp);
  });

  for (const [tool, file, usesDispatchCommand] of cases) {
    it.skipIf(process.platform === 'win32' && usesDispatchCommand)(`${tool} output matches golden fixture`, async () => {
      const p = path.join(tmp, tool, file);
      await injectHooks(p, tool);
      const got = await fse.readFile(p, 'utf-8');
      const want = await fse.readFile(path.join(fixturesDir, `${tool}.json`), 'utf-8');
      expect(got).toBe(want);
    });
  }
});
