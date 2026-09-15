import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtinHookDefs } from '../builtin-hooks.js';
import { KNOWN_AGENTS } from '../known-agents.js';
import { getHookStatus, hasTeamaiHooks, reconcileHooks } from '../hooks.js';
import { agentFileExtensionForTool, ALL_SUPPORTED_TOOLS } from '../resources/agent-format.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { HookDef, TeamaiConfigSchema } from '../types.js';

describe('ZCode support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships ZCode resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.zcode).toEqual({
      skills: '.zcode/skills',
      agents: '.zcode/agents',
      settings: '.zcode/cli/config.json',
      mcp: '.agents/mcp.json',
    });
  });

  it('registers ZCode for discovery and Claude-style resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'zcode')).toMatchObject({
      displayName: 'ZCode',
      skillsPath: '.zcode/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('zcode');
    expect(agentFileExtensionForTool('zcode')).toBe('.md');
    expect(detectMcpFormat('zcode')).toBe('claude');
  });

  it('generates raw (unwrapped) dispatch commands for ZCode', () => {
    const defs = builtinHookDefs('zcode');

    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      // Process-type entries get their shell wrapper added by the ZCode writer
      // (bash + args), so the command itself must be wrapper-free.
      expect(def.command.startsWith('teamai hook-dispatch ')).toBe(true);
      expect(def.command).toContain('--tool zcode');
      expect(def.command).not.toContain('bash -lc');
    }
    const events = new Set(defs.map((d) => d.event));
    expect(events).toEqual(new Set(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit']));
  });

  it('injects hooks into ZCode config.json, forcing the runner enabled and preserving unrelated keys', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.ensureDir(path.dirname(configPath));
      await fse.writeJson(configPath, { plugins: { official: true }, unrelated: 'keep-me' });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.unrelated).toBe('keep-me');
      expect(cfg.plugins).toEqual({ official: true });
      expect(cfg.hooks.enabled).toBe(true);
      const events = cfg.hooks.events as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; args?: string[]; timeoutMs?: number }> }>>;
      expect(Object.keys(events).sort()).toEqual(
        ['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
      );
      for (const entries of Object.values(events)) {
        for (const group of entries) {
          // ZCode matchers are regexes: '*' would be an invalid pattern that
          // never matches, so wildcard groups must omit the matcher entirely.
          const hook = group.hooks[0];
          if (hook.args?.[1]?.includes('--matcher')) {
            expect(group.matcher).toBeDefined();
          } else {
            expect(group.matcher).toBeUndefined();
          }
          expect(hook.type).toBe('process');
          if (process.platform === 'win32') {
            // Bare `bash` would resolve to the WSL launcher via System32.
            expect(hook.command).toBe('cmd');
            expect(hook.args?.[0]).toBe('/c');
          } else {
            expect(hook.command).toBe('bash');
            expect(hook.args?.[0]).toBe('-lc');
          }
          expect(hook.args?.[1]).toContain('teamai hook-dispatch');
          expect(hook.args?.[1]).toContain('--tool zcode');
          expect(hook.timeoutMs).toBeGreaterThan(0);
        }
      }

      expect(await getHookStatus(configPath, 'zcode')).toBe('installed');
    } finally {
      await fse.remove(home);
    }
  });

  it('reconciles idempotently', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.ensureDir(path.dirname(configPath));
      await reconcileHooks(configPath, 'zcode');
      const afterFirst = await fse.readFile(configPath, 'utf-8');

      await reconcileHooks(configPath, 'zcode');
      const afterSecond = await fse.readFile(configPath, 'utf-8');

      expect(afterSecond).toBe(afterFirst);
    } finally {
      await fse.remove(home);
    }
  });

  it('removeAll strips teamai entries but keeps the runner and unrelated keys', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.ensureDir(path.dirname(configPath));
      await fse.writeJson(configPath, { unrelated: 'keep-me' });

      await reconcileHooks(configPath, 'zcode');
      expect(await hasTeamaiHooks(configPath, 'zcode')).toBe(true);

      await reconcileHooks(configPath, 'zcode', [], { removeAll: true });

      const cfg = await fse.readJson(configPath);
      expect(cfg.unrelated).toBe('keep-me');
      expect(cfg.hooks.enabled).toBe(true);
      for (const entries of Object.values(cfg.hooks.events) as Array<unknown[]>) {
        expect(entries).toEqual([]);
      }
      expect(await hasTeamaiHooks(configPath, 'zcode')).toBe(false);
      expect(await getHookStatus(configPath, 'zcode')).toBe('missing');
    } finally {
      await fse.remove(home);
    }
  });

  it('manages custom team hooks: single entry across reinjection, clean removal', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      const manifestPath = path.join(home, 'managed-hooks.json');
      const teamDefs: HookDef[] = [
        {
          source: 'team',
          key: 'audit',
          event: 'SessionStart',
          command: 'sh /tmp/audit.sh',
          description: '[teamai:hook:audit] audit',
        },
      ];
      const countAudit = async () => {
        const cfg = await fse.readJson(configPath);
        const groups = cfg.hooks.events.SessionStart as Array<{ hooks: Array<{ args?: string[] }> }>;
        return groups.filter((g) => g.hooks[0].args?.[1] === 'sh /tmp/audit.sh').length;
      };

      await reconcileHooks(configPath, 'zcode', teamDefs, { manifestPath });
      expect(await countAudit()).toBe(1);

      // Reinjection must recognize the stored entry via the manifest (its
      // command carries no teamai marker) instead of appending a duplicate.
      await reconcileHooks(configPath, 'zcode', teamDefs, { manifestPath });
      expect(await countAudit()).toBe(1);

      // Removal must strip the team entry, not just its manifest record.
      await reconcileHooks(configPath, 'zcode', [], { removeAll: true, manifestPath });
      expect(await countAudit()).toBe(0);
      expect(await hasTeamaiHooks(configPath, 'zcode', manifestPath)).toBe(false);
    } finally {
      await fse.remove(home);
    }
  });

  it('re-enables hooks.enabled when reinjecting an otherwise up-to-date disabled config', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.ensureDir(path.dirname(configPath));

      await reconcileHooks(configPath, 'zcode');
      const disabled = await fse.readJson(configPath);
      disabled.hooks.enabled = false;
      await fse.writeJson(configPath, disabled);

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(cfg.hooks.enabled).toBe(true);
      expect(Object.keys(cfg.hooks.events).length).toBeGreaterThan(0);
      expect(await getHookStatus(configPath, 'zcode')).toBe('installed');
    } finally {
      await fse.remove(home);
    }
  });

  it('heals unknown keys in the hooks block (ZCode strict schema rejects the whole block otherwise)', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.ensureDir(path.dirname(configPath));
      // A hand-added annotation key is enough for ZCode to drop every hook.
      await fse.writeJson(configPath, {
        plugins: {},
        hooks: { enabled: false, description: 'my hooks', events: {} },
      });

      await reconcileHooks(configPath, 'zcode');

      const cfg = await fse.readJson(configPath);
      expect(Object.keys(cfg.hooks).sort()).toEqual(['enabled', 'events']);
      expect(cfg.hooks.enabled).toBe(true);
      expect(await getHookStatus(configPath, 'zcode')).toBe('installed');
    } finally {
      await fse.remove(home);
    }
  });

  it('removeAll preserves a user-disabled hooks.enabled while stripping entries', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-test-'));
    try {
      const configPath = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.ensureDir(path.dirname(configPath));

      await reconcileHooks(configPath, 'zcode');
      const disabled = await fse.readJson(configPath);
      disabled.hooks.enabled = false;
      await fse.writeJson(configPath, disabled);

      await reconcileHooks(configPath, 'zcode', [], { removeAll: true });

      const cfg = await fse.readJson(configPath);
      // Removal strips the managed entries but must not flip the user's
      // explicit runner choice back on.
      expect(cfg.hooks.enabled).toBe(false);
      for (const entries of Object.values(cfg.hooks.events) as Array<unknown[]>) {
        expect(entries).toEqual([]);
      }
      expect(await hasTeamaiHooks(configPath, 'zcode')).toBe(false);
    } finally {
      await fse.remove(home);
    }
  });
});
