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

  it('strips unknown keys without disturbing a populated events block', async () => {
    const { home, configPath } = await zcodeHome();
    try {
      // A populated events block is what a working setup looks like:
      // reconciled teamai entries plus a user hook. The heal must remove
      // only the unrecognized root key (#1049 review).
      const eventsBlock = {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'process', command: 'node', args: ['mine.mjs'], enabled: true }],
          },
        ],
      };
      await fse.writeJson(configPath, {
        hooks: {
          enabled: true,
          timeoutMs: 90000,
          maxOutputBytes: 16384,
          description: 'leftover from an older schema',
          events: eventsBlock,
        },
      });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.hooks.description).toBeUndefined();
      expect(cfg.hooks.timeoutMs).toBe(90000);
      expect(cfg.hooks.maxOutputBytes).toBe(16384);
      // The user's own hook entry survives the heal untouched.
      const session = cfg.hooks.events?.SessionStart as typeof eventsBlock.SessionStart;
      expect(session.some((g) => g.hooks.some((h) => h.command === 'node' && h.args[0] === 'mine.mjs'))).toBe(true);
    } finally {
      await fse.remove(home);
    }
  });

  it('strips timeoutMs/maxOutputBytes that fail the positive-integer schema and warns (#1059 value check)', async () => {
    const { home, configPath } = await zcodeHome();
    try {
      // zcode-app-cli validates both keys as optional positive integers
      // (number().int().positive(), vendor/zcode.cjs). A value failing that
      // check would make ZCode reject the whole hooks block, so it goes
      // through the same strip-and-warn path as an unknown key.
      await fse.writeJson(configPath, {
        hooks: {
          enabled: true,
          timeoutMs: 0,
          maxOutputBytes: 'big',
          events: {},
        },
      });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.hooks.timeoutMs).toBeUndefined();
      expect(cfg.hooks.maxOutputBytes).toBeUndefined();
      expect(cfg.hooks.enabled).toBe(true);
      const warned = vi.mocked(log.warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('"timeoutMs"'))).toBe(true);
      expect(warned.some((w) => w.includes('"maxOutputBytes"'))).toBe(true);
    } finally {
      await fse.remove(home);
    }
  });

  it('strips negative and non-integer values for each key; valid integers stay silent', async () => {
    const { home, configPath } = await zcodeHome();
    try {
      await fse.writeJson(configPath, {
        hooks: {
          enabled: true,
          timeoutMs: 1.5,
          maxOutputBytes: -1,
          events: {},
        },
      });

      await reconcileHooks(configPath, 'zcode');

      let cfg = await fse.readJson(configPath);
      expect(cfg.hooks.timeoutMs).toBeUndefined();
      expect(cfg.hooks.maxOutputBytes).toBeUndefined();

      // Valid positive integers keep the keep-branch silent: no warning.
      await fse.writeJson(configPath, {
        hooks: {
          enabled: true,
          timeoutMs: 45000,
          maxOutputBytes: 8192,
          events: {},
        },
      });
      vi.mocked(log.warn).mockClear();

      await reconcileHooks(configPath, 'zcode');

      cfg = await fse.readJson(configPath);
      expect(cfg.hooks.timeoutMs).toBe(45000);
      expect(cfg.hooks.maxOutputBytes).toBe(8192);
      expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    } finally {
      await fse.remove(home);
    }
  });
});
