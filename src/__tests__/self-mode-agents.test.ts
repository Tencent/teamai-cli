import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  normalizeAgentList,
  detectHomeInstalledAgents,
  seedSelfModeToolDirs,
  SELF_MODE_AGENT_CHOICES,
} from '../known-agents.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('normalizeAgentList', () => {
  it('returns [] for undefined', () => {
    expect(normalizeAgentList(undefined)).toEqual([]);
  });

  it('splits a comma-separated string', () => {
    expect(normalizeAgentList('claude,codex')).toEqual(['claude', 'codex']);
  });

  it('passes through a variadic array', () => {
    expect(normalizeAgentList(['claude', 'codex'])).toEqual(['claude', 'codex']);
  });

  it('handles a mix of array + comma-separated elements', () => {
    expect(normalizeAgentList(['claude,codex', 'cursor'])).toEqual(['claude', 'codex', 'cursor']);
  });

  it('trims blanks and dedupes, preserving first-seen order', () => {
    expect(normalizeAgentList(' claude , , codex ,claude')).toEqual(['claude', 'codex']);
  });
});

describe('detectHomeInstalledAgents', () => {
  let home: string;

  beforeEach(async () => {
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-home-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(home);
  });

  it('returns [] when no candidate tool dir exists under HOME', async () => {
    expect(await detectHomeInstalledAgents()).toEqual([]);
  });

  it('returns only the tools whose root dir exists, in candidate order', async () => {
    await fse.ensureDir(path.join(home, '.codex'));
    await fse.ensureDir(path.join(home, '.claude'));
    const found = await detectHomeInstalledAgents();
    // candidate order is claude, codex, cursor, codebuddy, workbuddy
    expect(found).toEqual(['claude', 'codex']);
  });

  it('respects a custom candidate list', async () => {
    await fse.ensureDir(path.join(home, '.cursor'));
    await fse.ensureDir(path.join(home, '.claude'));
    expect(await detectHomeInstalledAgents(['cursor'])).toEqual(['cursor']);
  });

  it('SELF_MODE_AGENT_CHOICES is the 5 common coding agents', () => {
    expect([...SELF_MODE_AGENT_CHOICES]).toEqual(['claude', 'codex', 'cursor', 'codebuddy', 'workbuddy']);
  });
});

describe('seedSelfModeToolDirs (no hardcoded claude default)', () => {
  let tmp: string;
  let repoRoot: string;
  let teamConfig: TeamaiConfig;

  function makeConfig(enabledAgents?: string[]): LocalConfig {
    return {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r', kind: 'self', businessRepoRoot: repoRoot },
      username: 'alice',
      scope: 'project',
      projectRoot: repoRoot,
      additionalRoles: [],
      ...(enabledAgents ? { enabledAgents } : {}),
    };
  }

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-seed-'));
    repoRoot = path.join(tmp, 'biz');
    await fse.ensureDir(repoRoot);
    teamConfig = {
      team: 't', description: '', repo: 'r', provider: 'github' as const, reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills' },
        codex: { skills: '.codex/skills' },
        cursor: { skills: '.cursor/skills' },
      },
    };
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('seeds nothing when enabledAgents is empty (no default claude)', async () => {
    const seeded = await seedSelfModeToolDirs(makeConfig([]), teamConfig);
    expect(seeded).toEqual([]);
    expect(await fse.pathExists(path.join(repoRoot, '.claude'))).toBe(false);
  });

  it('seeds nothing when enabledAgents is undefined (no default claude)', async () => {
    const seeded = await seedSelfModeToolDirs(makeConfig(undefined), teamConfig);
    expect(seeded).toEqual([]);
    expect(await fse.pathExists(path.join(repoRoot, '.claude'))).toBe(false);
  });

  it('seeds exactly the enabled agents, and no others', async () => {
    const seeded = await seedSelfModeToolDirs(makeConfig(['codex']), teamConfig);
    expect(seeded).toEqual(['codex']);
    expect(await fse.pathExists(path.join(repoRoot, '.codex/skills'))).toBe(true);
    expect(await fse.pathExists(path.join(repoRoot, '.claude'))).toBe(false);
  });

  it('seeds multiple selected agents', async () => {
    const seeded = await seedSelfModeToolDirs(makeConfig(['claude', 'cursor']), teamConfig);
    expect(new Set(seeded)).toEqual(new Set(['claude', 'cursor']));
    expect(await fse.pathExists(path.join(repoRoot, '.claude/skills'))).toBe(true);
    expect(await fse.pathExists(path.join(repoRoot, '.cursor/skills'))).toBe(true);
  });

  it('never seeds an explicitly disabled agent', async () => {
    const config = makeConfig(['claude', 'codex']);
    config.disabledAgents = ['codex'];
    const seeded = await seedSelfModeToolDirs(config, teamConfig);
    expect(seeded).toEqual(['claude']);
    expect(await fse.pathExists(path.join(repoRoot, '.codex'))).toBe(false);
  });
});
