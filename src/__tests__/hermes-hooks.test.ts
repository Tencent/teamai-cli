import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { injectHermesHooks, getReportScriptPath } from '../hermes-hooks.js';
import { log } from '../utils/logger.js';

let tmpDir: string;
let savedHermesHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-hooks-test-'));
  savedHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = tmpDir;
});

afterEach(() => {
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHermesHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectHermesHooks', () => {
  it('reports the injection only when the script, hook entry or allowlist changes', async () => {
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});
    try {
      await injectHermesHooks();
      expect(fs.existsSync(getReportScriptPath())).toBe(true);
      expect(success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai Hermes hook'));
      success.mockClear();

      await injectHermesHooks();
      expect(success).not.toHaveBeenCalled();
    } finally {
      success.mockRestore();
    }
  });
});
