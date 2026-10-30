import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import {
  reconcileCoAuthorForConfig,
  spliceCodexAttribution,
} from '../coauthor-reconcile.js';
import { StateSchema } from '../types.js';
import type { TeamaiConfig, LocalConfig, State } from '../types.js';

const TOOL_PATHS = {
  claude: { skills: '.claude/skills', settings: '.claude/settings.json' },
  codex: { skills: '.codex/skills', settings: '.codex/hooks.json' },
  cursor: { skills: '.cursor/skills', settings: '.cursor/hooks.json' },
};

describe('co-author reconcile', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let baseTeam: TeamaiConfig;
  let baseLocal: LocalConfig;

  function team(coAuthor?: { enabled: boolean }): TeamaiConfig {
    return {
      ...baseTeam,
      sharing: { ...baseTeam.sharing, ...(coAuthor ? { coAuthor } : {}) },
    } as TeamaiConfig;
  }

  const freshState = (): State => StateSchema.parse({});

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-coauthor-test-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    // All three tools "installed" at user scope.
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.cursor', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.teamai'));

    vi.stubEnv('HOME', homeDir);
    // Cursor CLI resolves its config root as CURSOR_CONFIG_DIR, then $XDG_CONFIG_HOME/cursor,
    // then ~/.cursor. This file expects the last of those, so pin the variable instead of
    // inheriting whatever the runner exports.
    vi.stubEnv('XDG_CONFIG_HOME', '');

    baseTeam = {
      team: 't',
      description: '',
      repo: 'r',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '~/.teamai/docs' },
        env: { injectShellProfile: false },
      },
      toolPaths: TOOL_PATHS,
    } as unknown as TeamaiConfig;

    baseLocal = {
      repo: { localPath: repoPath, remote: 'r' },
      username: 'u',
      scope: 'user',
      additionalRoles: [],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  const claudeSettings = () => path.join(homeDir, '.claude', 'settings.json');
  const codexToml = () => path.join(homeDir, '.codex', 'config.toml');
  const cursorConfig = () => path.join(homeDir, '.cursor', 'cli-config.json');

  it('does nothing when neither team nor user has an opinion', async () => {
    const { changes } = await reconcileCoAuthorForConfig(team(), baseLocal, freshState());
    expect(changes).toEqual([]);
    expect(await fse.pathExists(claudeSettings())).toBe(false);
    expect(await fse.pathExists(codexToml())).toBe(false);
    expect(await fse.pathExists(cursorConfig())).toBe(false);
  });

  it('disables the trailer across all three tool families when team says off', async () => {
    const { changes, managed } = await reconcileCoAuthorForConfig(
      team({ enabled: false }),
      baseLocal,
      freshState(),
    );

    // Claude: attribution.commit / .pr = ""
    const claude = await fse.readJson(claudeSettings());
    expect(claude.attribution).toEqual({ commit: '', pr: '' });

    // Codex: commit_attribution = ""
    const toml = await fse.readFile(codexToml(), 'utf-8');
    expect(toml).toContain('commit_attribution = ""');

    // Cursor: attribution.attributeCommitsToAgent = false
    const cursor = await fse.readJson(cursorConfig());
    expect(cursor.attribution).toEqual({ attributeCommitsToAgent: false });

    expect(changes.every((c) => c.action === 'updated' && !c.enabled)).toBe(true);
    expect(Object.values(managed).every((v) => !v)).toBe(true);
  });

  it('leaves Muse Code settings alone: Muse documents no co-author setting', async () => {
    const museSettings = path.join(homeDir, '.config', 'muse', 'settings.json');
    await fse.outputJson(museSettings, { schema_version: 1 });
    const withMuse = {
      ...team({ enabled: false }),
      toolPaths: { ...TOOL_PATHS, muse: { skills: '.config/muse/skills', settings: '.config/muse/settings.json' } },
    } as TeamaiConfig;

    const { changes } = await reconcileCoAuthorForConfig(withMuse, baseLocal, freshState());

    expect(await fse.readJson(museSettings)).toEqual({ schema_version: 1 });
    expect(changes.some((c) => c.tool === 'muse')).toBe(false);
  });

  it('leaves a Claude or Cursor file that does not parse as it is, and does not record it as applied', async () => {
    const broken = '{ "permissions": {\n';
    await fse.outputFile(claudeSettings(), broken);
    await fse.outputFile(cursorConfig(), broken);
    const { changes, managed } = await reconcileCoAuthorForConfig(team({ enabled: false }), baseLocal, freshState());

    expect(await fse.readFile(claudeSettings(), 'utf-8')).toBe(broken);
    expect(await fse.readFile(cursorConfig(), 'utf-8')).toBe(broken);
    for (const file of [claudeSettings(), cursorConfig()]) {
      expect(changes.find((c) => c.file === file)?.action).toBe('skipped');
      expect(managed[file]).toBeUndefined();
    }
  });

  it('writes the Codex trailer setting into the recorded CODEX_HOME root', async () => {
    const codexHome = path.join(homeDir, '.codex-alt');
    await fse.remove(path.join(homeDir, '.codex'));
    await fse.ensureDir(path.join(codexHome, 'skills'));

    await reconcileCoAuthorForConfig(
      team({ enabled: false }),
      { ...baseLocal, toolRoots: { codex: codexHome } },
      freshState(),
    );

    expect(await fse.readFile(path.join(codexHome, 'config.toml'), 'utf-8')).toContain('commit_attribution = ""');
    expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
  });

  it('keeps the Codex trailer setting in the Codex root when skills are mapped elsewhere', async () => {
    await fse.ensureDir(path.join(homeDir, '.agents', 'skills'));

    await reconcileCoAuthorForConfig(
      { ...team({ enabled: false }), toolPaths: { codex: { skills: '.agents/skills' } } } as TeamaiConfig,
      baseLocal,
      freshState(),
    );

    expect(await fse.readFile(codexToml(), 'utf-8')).toContain('commit_attribution = ""');
    expect(await fse.pathExists(path.join(homeDir, '.agents', 'config.toml'))).toBe(false);
  });

  it('is idempotent: a second pass makes no writes', async () => {
    const first = await reconcileCoAuthorForConfig(team({ enabled: false }), baseLocal, freshState());
    const state = { ...freshState(), coAuthorManaged: first.managed };
    const second = await reconcileCoAuthorForConfig(team({ enabled: false }), baseLocal, state);
    expect(second.changes.every((c) => c.action === 'skipped')).toBe(true);
  });

  it('user override beats team default', async () => {
    // Team says OFF, but user overrides to ON. Seed a stripped trailer so there
    // is something for enabled=true to restore, proving the override is applied.
    await fse.writeJson(claudeSettings(), { attribution: { commit: '', pr: '' } });
    const local = { ...baseLocal, coAuthorEnabled: true } as LocalConfig;
    await reconcileCoAuthorForConfig(team({ enabled: false }), local, freshState());
    // enabled=true restores default → attribution override removed.
    const claude = await fse.readJson(claudeSettings());
    expect(claude.attribution).toBeUndefined();
  });

  it('write-only: dropping the team policy leaves the trailer untouched', async () => {
    // Round 1: team says off, we strip.
    const r1 = await reconcileCoAuthorForConfig(team({ enabled: false }), baseLocal, freshState());
    const state = { ...freshState(), coAuthorManaged: r1.managed };

    // Round 2: team drops the policy entirely (no coAuthor block).
    const r2 = await reconcileCoAuthorForConfig(team(), baseLocal, state);
    expect(r2.changes).toEqual([]); // no-op, nothing rewritten

    // The stripped trailer is still stripped — we never restored it.
    const claude = await fse.readJson(claudeSettings());
    expect(claude.attribution).toEqual({ commit: '', pr: '' });
  });

  it('preserves unrelated keys in each config file', async () => {
    await fse.writeJson(claudeSettings(), { model: 'opus', attribution: { commit: 'keep-me' } });
    await fse.writeFile(codexToml(), '# my config\nmodel = "gpt-5"\n\n[features]\ncodex_git_commit = true\n');
    await fse.writeJson(cursorConfig(), { editor: { theme: 'dark' } });

    await reconcileCoAuthorForConfig(team({ enabled: false }), baseLocal, freshState());

    const claude = await fse.readJson(claudeSettings());
    expect(claude.model).toBe('opus');
    expect(claude.attribution.commit).toBe(''); // overridden
    expect(claude.attribution.pr).toBe('');

    const toml = await fse.readFile(codexToml(), 'utf-8');
    expect(toml).toContain('# my config');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('[features]');
    expect(toml).toContain('commit_attribution = ""');

    const cursor = await fse.readJson(cursorConfig());
    expect(cursor.editor).toEqual({ theme: 'dark' });
    expect(cursor.attribution.attributeCommitsToAgent).toBe(false);
  });

  it('skips uninstalled tools', async () => {
    await fse.remove(path.join(homeDir, '.cursor'));
    const { changes } = await reconcileCoAuthorForConfig(team({ enabled: false }), baseLocal, freshState());
    expect(changes.find((c) => c.tool === 'cursor')).toBeUndefined();
    expect(changes.find((c) => c.tool === 'claude')).toBeDefined();
  });

  it('skips codex/cursor in project scope (user-scope only)', async () => {
    const projRoot = path.join(tmpDir, 'proj');
    await fse.ensureDir(path.join(projRoot, '.claude', 'skills'));
    const local = {
      ...baseLocal,
      scope: 'project',
      projectRoot: projRoot,
    } as LocalConfig;

    const { changes } = await reconcileCoAuthorForConfig(team({ enabled: false }), local, freshState());
    expect(changes.find((c) => c.tool === 'codex')).toBeUndefined();
    expect(changes.find((c) => c.tool === 'cursor')).toBeUndefined();
    // Claude writes into the member's PROJECT settings.local.json, never the shared settings.json (#993).
    const projClaude = await fse.readJson(path.join(projRoot, '.claude', 'settings.local.json'));
    expect(projClaude.attribution).toEqual({ commit: '', pr: '' });
    expect(await fse.pathExists(path.join(projRoot, '.claude', 'settings.json'))).toBe(false);
  });

  describe('project scope (#993)', () => {
    let projRoot: string;
    let local: LocalConfig;
    const shared = () => path.join(projRoot, '.claude', 'settings.json');
    const preFix = (managed: Record<string, boolean>): State => StateSchema.parse({ coAuthorManaged: managed });

    beforeEach(async () => {
      projRoot = path.join(tmpDir, 'proj');
      await fse.ensureDir(path.join(projRoot, '.claude', 'skills'));
      local = { ...baseLocal, scope: 'project', projectRoot: projRoot } as LocalConfig;
    });

    it('skips every Claude-family tool but claude', async () => {
      await fse.ensureDir(path.join(projRoot, '.codebuddy', 'skills'));
      const withCodebuddy = {
        ...team({ enabled: false }),
        toolPaths: { ...TOOL_PATHS, codebuddy: { skills: '.codebuddy/skills', settings: '.codebuddy/settings.json' } },
      } as TeamaiConfig;
      const { changes } = await reconcileCoAuthorForConfig(withCodebuddy, local, freshState());
      expect(changes.map((c) => c.tool)).toEqual(['claude']);
      expect(await fse.pathExists(path.join(projRoot, '.codebuddy', 'settings.json'))).toBe(false);
    });

    it.each([
      ['first member', '{"attribution": {"commit": "", "pr": ""}, "model": "opus"}', '{"model": "opus"}'],
      ['last member', '{\n\t"model": "opus",\n\t"attribution": {"pr": "", "commit": ""}\n}\n', '{\n\t"model": "opus"\n}\n'],
      ['only member', '{\n  "attribution": {\n    "commit": "",\n    "pr": ""\n  }\n}\n', '{\n}\n'],
    ])('removes a pre-fix value recorded as teamai\'s, byte-preserving (%s)', async (_label, before, after) => {
      await fse.writeFile(shared(), before);
      const { managed } = await reconcileCoAuthorForConfig(team({ enabled: false }), local, preFix({ [shared()]: false }));
      expect(await fse.readFile(shared(), 'utf8')).toBe(after);
      expect(managed[shared()]).toBeUndefined();
    });

    it('leaves a pre-fix-looking value alone when the record does not list the file', async () => {
      const before = '{"attribution": {"commit": "", "pr": ""}}';
      await fse.writeFile(shared(), before);
      await reconcileCoAuthorForConfig(team({ enabled: false }), local, freshState());
      expect(await fse.readFile(shared(), 'utf8')).toBe(before);
    });

    it('with no choice, keeps the member\'s own settings.local.json attribution when moving a pre-fix value', async () => {
      const localFile = path.join(projRoot, '.claude', 'settings.local.json');
      const mine = '{\n  "attribution": {"commit": "Mine"}\n}\n';
      await fse.writeFile(localFile, mine);
      await fse.writeFile(shared(), '{"attribution": {"commit": "", "pr": ""}, "model": "opus"}');
      const { changes, managed } = await reconcileCoAuthorForConfig(team(), local, preFix({ [shared()]: false }));
      expect(changes.map((c) => c.action)).toEqual(['moved']);
      expect(await fse.readFile(shared(), 'utf8')).toBe('{"model": "opus"}');
      expect(await fse.readFile(localFile, 'utf8')).toBe(mine);
      expect(managed).toEqual({});
    });

    it('with no choice, leaves a pre-fix value in another Claude-family tool\'s shared file for a later choice', async () => {
      await fse.ensureDir(path.join(projRoot, '.codebuddy', 'skills'));
      const withCodebuddy = {
        ...team(),
        toolPaths: { ...TOOL_PATHS, codebuddy: { skills: '.codebuddy/skills', settings: '.codebuddy/settings.json' } },
      } as TeamaiConfig;
      const codebuddyShared = path.join(projRoot, '.codebuddy', 'settings.json');
      const before = '{"attribution": {"commit": "", "pr": ""}}';
      await fse.writeFile(codebuddyShared, before);
      const { changes, managed } = await reconcileCoAuthorForConfig(withCodebuddy, local, preFix({ [codebuddyShared]: false }));
      expect(changes).toEqual([]);
      expect(await fse.readFile(codebuddyShared, 'utf8')).toBe(before);
      expect(managed).toEqual({ [codebuddyShared]: false });
    });

    it('reports a recorded file that does not parse as unreadable, naming it, not as a value of the member\'s', async () => {
      const before = '{"attribution": {"commit": "", "pr": ""},';
      await fse.writeFile(shared(), before);
      const { changes } = await reconcileCoAuthorForConfig(team({ enabled: false }), local, preFix({ [shared()]: false }));
      expect(await fse.readFile(shared(), 'utf8')).toBe(before);
      const skipped = changes.find((c) => c.file === shared());
      expect(skipped?.action).toBe('skipped');
      expect(skipped?.reason).toBe(`${shared()} is not valid JSON, so teamai could not read it`);
    });

    it('keeps the record of a recorded file that does not parse, so a pull after it is repaired removes the value', async () => {
      await fse.writeFile(shared(), '{"attribution": {"commit": "", "pr": ""},');
      const first = await reconcileCoAuthorForConfig(team({ enabled: false }), local, preFix({ [shared()]: false }));
      expect(first.managed[shared()]).toBe(false);
      await fse.writeFile(shared(), '{"attribution": {"commit": "", "pr": ""}}');
      const second = await reconcileCoAuthorForConfig(team({ enabled: false }), local, preFix(first.managed));
      expect(second.changes.find((c) => c.file === shared())?.action).toBe('removed');
    });

    it('leaves a value with keys teamai never writes alone', async () => {
      const before = '{"attribution": {"commit": "", "pr": "", "extra": true}}';
      await fse.writeFile(shared(), before);
      const { managed } = await reconcileCoAuthorForConfig(team({ enabled: false }), local, preFix({ [shared()]: false }));
      expect(await fse.readFile(shared(), 'utf8')).toBe(before);
      expect(managed[shared()]).toBeUndefined();
    });
  });
});

describe('spliceCodexAttribution', () => {
  it('inserts the key before the first table', () => {
    const src = 'model = "gpt-5"\n\n[features]\ncodex_git_commit = true\n';
    const out = spliceCodexAttribution(src, false);
    expect(out).toContain('commit_attribution = ""');
    // must land in the head region, before [features]
    expect(out.indexOf('commit_attribution')).toBeLessThan(out.indexOf('[features]'));
    // and keep a blank line before the table header, never flush against it
    expect(out).not.toContain('commit_attribution = ""\n[features]');
    expect(out).toContain('commit_attribution = ""\n\n[features]');
  });

  it('replaces an existing top-level key', () => {
    const src = 'commit_attribution = "Codex <x>"\nmodel = "gpt-5"\n';
    const out = spliceCodexAttribution(src, false);
    expect(out).toContain('commit_attribution = ""');
    expect(out).not.toContain('Codex <x>');
  });

  it('removes the key when restoring the default (enabled=true)', () => {
    const src = 'commit_attribution = ""\nmodel = "gpt-5"\n';
    const out = spliceCodexAttribution(src, true);
    expect(out).not.toContain('commit_attribution');
    expect(out).toContain('model = "gpt-5"');
  });

  it('is a no-op restoring default when the key is absent', () => {
    const src = 'model = "gpt-5"\n';
    expect(spliceCodexAttribution(src, true)).toBe(src);
  });

  it('handles an empty file', () => {
    expect(spliceCodexAttribution('', false)).toBe('commit_attribution = ""\n');
  });
});
