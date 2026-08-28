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

    expect(changes.every((c) => c.action === 'updated' && c.enabled === false)).toBe(true);
    expect(Object.values(managed).every((v) => v === false)).toBe(true);
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
    // Claude writes into the PROJECT settings.json.
    const projClaude = await fse.readJson(path.join(projRoot, '.claude', 'settings.json'));
    expect(projClaude.attribution).toEqual({ commit: '', pr: '' });
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
