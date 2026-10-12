// SPDX-License-Identifier: MIT
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { log } from '../utils/logger.js';
import { reconcileHooks } from '../hooks.js';

async function zcodeHome(): Promise<{ home: string; configPath: string }> {
  const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-keeplist-'));
  const configPath = path.join(home, '.zcode', 'cli', 'config.json');
  await fse.ensureDir(path.dirname(configPath));
  return { home, configPath };
}

describe('reconcileZcodeFormat hooks keep-list', () => {
  afterEach(() => {
    vi.mocked(log.warn).mockClear();
  });

  it('preserves documented user settings (timeoutMs, maxOutputBytes) across a heal', async () => {
    const { home, configPath } = await zcodeHome();
    try {
      await fse.writeJson(configPath, {
        hooks: {
          enabled: true,
          timeoutMs: 120000,
          maxOutputBytes: 1048576,
        },
      });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.hooks.timeoutMs).toBe(120000);
      expect(cfg.hooks.maxOutputBytes).toBe(1048576);
      expect(cfg.hooks.enabled).toBe(true);
      expect(cfg.hooks.events).toBeDefined();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      await fse.remove(home);
    }
  });

  it('still strips undocumented keys, but now warns instead of deleting silently', async () => {
    const { home, configPath } = await zcodeHome();
    try {
      await fse.writeJson(configPath, {
        hooks: {
          enabled: true,
          description: 'a key ZCode rejects',
          maxOutputBytes: 65536,
        },
      });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.hooks.description).toBeUndefined();
      expect(cfg.hooks.maxOutputBytes).toBe(65536);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const warning = vi.mocked(log.warn).mock.calls[0][0] as string;
      expect(warning).toContain('"description"');
    } finally {
      await fse.remove(home);
    }
  });

  it('keeps healing a config whose only hooks content is undocumented keys', async () => {
    const { home, configPath } = await zcodeHome();
    try {
      await fse.writeJson(configPath, {
        hooks: {
          description: 'stray',
        },
      });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.hooks.description).toBeUndefined();
      expect(cfg.hooks.enabled).toBe(true);
      expect(cfg.hooks.events).toBeDefined();
      expect(log.warn).toHaveBeenCalled();
    } finally {
      await fse.remove(home);
    }
  });
});
