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
import { resolveSelfModeSelection } from '../init.js';
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

  it('counts a Claude Code relocated with CLAUDE_CONFIG_DIR, with no ~/.claude at all', async () => {
    const relocated = path.join(home, '.claude-work');
    await fse.ensureDir(relocated);
    vi.stubEnv('CLAUDE_CONFIG_DIR', relocated);
    expect(await detectHomeInstalledAgents(['claude', 'codex'])).toEqual(['claude']);
  });

  it('returns only the tools whose root dir exists, in candidate order', async () => {
    await fse.ensureDir(path.join(home, '.codex'));
    await fse.ensureDir(path.join(home, '.claude'));
    const found = await detectHomeInstalledAgents();
    // candidate order is claude, codex, cursor, copilot, pi, joycode, codebuddy, workbuddy
    expect(found).toEqual(['claude', 'codex']);
  });

  it('respects a custom candidate list', async () => {
    await fse.ensureDir(path.join(home, '.cursor'));
    await fse.ensureDir(path.join(home, '.claude'));
    expect(await detectHomeInstalledAgents(['cursor'])).toEqual(['cursor']);
  });

  it('SELF_MODE_AGENT_CHOICES includes Pi, Copilot and JoyCode among the common coding agents', () => {
    expect([...SELF_MODE_AGENT_CHOICES]).toEqual([
      'claude',
      'codex',
      'cursor',
      'copilot',
      'pi',
      'joycode',
      'codebuddy',
      'workbuddy',
    ]);
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

  // Despite the name, this is called from non-self-mode `init` too (#867) —
  // resolveBaseDir + enabledAgents are not self-mode-specific, and neither is
  // a custom agent configured only in teamai.yaml's toolPaths.
  it('seeds a custom agent configured only in toolPaths, outside self mode', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { skills: 'a/skills' } },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, 'a', 'skills'))).toBe(true);

    vi.unstubAllEnvs();
  });

  // Outside self mode, a built-in tool's root must already exist on its own —
  // that's exactly what doctor's "is installed" check verifies (#598).
  // Seeding it here would silently create a directory for software that was
  // never actually installed (#867 review finding).
  it('does not seed a built-in tool outside self mode, even if enabled', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['claude'],
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, teamConfig);

    expect(seeded).toEqual([]);
    expect(await fse.pathExists(path.join(repoRoot, '.claude'))).toBe(false);

    vi.unstubAllEnvs();
  });

  it('seeds the user-scope override path, not the default, when scope is user', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: {
        ...teamConfig.toolPaths,
        AA: { skills: '.aa/skills', userScope: { skills: '.config/aa/skills' } },
      },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, '.config/aa/skills'))).toBe(true);
    expect(await fse.pathExists(path.join(repoRoot, '.aa'))).toBe(false);

    vi.unstubAllEnvs();
  });

  it('seeds a custom agent configured with only a rules path, no skills', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { rules: 'a/rules' } },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, 'a', 'rules'))).toBe(true);

    vi.unstubAllEnvs();
  });

  // settings/hooks/claudemd are FILE paths (e.g. "a/settings.json"), unlike
  // skills/rules/agents which are directories. Seeding must create their
  // parent tool root, not a bogus directory literally named "settings.json"
  // (#867 review finding).
  it('seeds only the tool root for a custom agent configured with only a settings file', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { settings: 'a/settings.json' } },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, 'a'))).toBe(true);
    expect(await fse.pathExists(path.join(repoRoot, 'a', 'settings.json'))).toBe(false);

    vi.unstubAllEnvs();
  });

  it('seeds a custom agent configured with only a claudemd file', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { claudemd: 'a/AGENTS.md' } },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, 'a'))).toBe(true);
    expect(await fse.pathExists(path.join(repoRoot, 'a', 'AGENTS.md'))).toBe(false);

    vi.unstubAllEnvs();
  });

  it('seeds every distinct configured root, not just the first one found', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { skills: 'a/skills', rules: 'b/rules' } },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, 'a', 'skills'))).toBe(true);
    expect(await fse.pathExists(path.join(repoRoot, 'b', 'rules'))).toBe(true);

    vi.unstubAllEnvs();
  });

  it('does not create a bogus directory for a bare root-level file path', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { claudemd: 'AGENTS.md' } },
    };
    vi.stubEnv('HOME', repoRoot);

    await seedSelfModeToolDirs(config, customTeamConfig);

    expect(await fse.pathExists(path.join(repoRoot, 'AGENTS.md'))).toBe(false);

    vi.unstubAllEnvs();
  });

  // Non-self project scope injects hooks into HOME, not the project root
  // (resolveHookScope, #264): a custom tool's HOME root must exist too, or
  // its session-start hook is silently skipped even though its resource dirs
  // landed correctly under the project root (#867 review finding).
  it('also seeds the HOME hook-scope root in non-self project scope', async () => {
    const home = path.join(tmp, 'home');
    await fse.ensureDir(home);
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'project',
      projectRoot: repoRoot,
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { skills: '.aa/skills', settings: '.aa/settings.json' } },
    };
    vi.stubEnv('HOME', home);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, '.aa', 'skills'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.aa'))).toBe(true);

    vi.unstubAllEnvs();
  });

  // A bare root-level settings path (no "/") has no parent directory — the
  // hook-installation gate checks the FILE itself, and reconcileHooks already
  // treats a missing settings/hooks file as `{}`, so seed an empty JSON
  // object there instead of leaving it (or a bogus directory) behind (#867
  // review finding).
  it('seeds an empty JSON file, not a directory, for a bare root-level settings path', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { skills: 'a/skills', settings: 'settings.json' } },
    };
    vi.stubEnv('HOME', repoRoot);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    const settingsPath = path.join(repoRoot, 'settings.json');
    expect((await fse.stat(settingsPath)).isFile()).toBe(true);
    expect(JSON.parse(await fse.readFile(settingsPath, 'utf-8'))).toEqual({});

    vi.unstubAllEnvs();
  });

  // The HOME hook-scope pass must be restricted to what hook installation
  // actually reads (settings/hooks) — seeding skills/rules/agents there too
  // would create a directory a tool with no settings-based hook surface never
  // needs (#867 review finding, P2).
  it('does not seed skills/rules/agents at the HOME hook-scope root when the tool has no settings path', async () => {
    const home = path.join(tmp, 'home');
    await fse.ensureDir(home);
    const config: LocalConfig = {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r' },
      username: 'alice',
      scope: 'project',
      projectRoot: repoRoot,
      additionalRoles: [],
      enabledAgents: ['AA'],
    };
    const customTeamConfig: TeamaiConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, AA: { skills: '.aa/skills' } },
    };
    vi.stubEnv('HOME', home);

    const seeded = await seedSelfModeToolDirs(config, customTeamConfig);

    expect(seeded).toContain('AA');
    expect(await fse.pathExists(path.join(repoRoot, '.aa', 'skills'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.aa'))).toBe(false);

    vi.unstubAllEnvs();
  });
});

describe('resolveSelfModeSelection (interactive picker: option 1 = Auto)', () => {
  // Option order in the picker: 0 = Auto, then SELF_MODE_AGENT_CHOICES.
  const detected = ['claude', 'codex'];

  it('Auto (index 0) expands to the detected tools', () => {
    expect(resolveSelfModeSelection([0], detected)).toEqual(['claude', 'codex']);
  });

  it('Auto with nothing detected falls back to [claude]', () => {
    expect(resolveSelfModeSelection([0], [])).toEqual(['claude']);
  });

  it('a specific tool maps by (index - 1) into the choices list', () => {
    // index 2 → SELF_MODE_AGENT_CHOICES[1] = codex
    expect(resolveSelfModeSelection([2], detected)).toEqual(['codex']);
    // index 4 → SELF_MODE_AGENT_CHOICES[3] = copilot
    expect(resolveSelfModeSelection([4], detected)).toEqual(['copilot']);
  });

  it('multiple specific tools preserve choice order', () => {
    // indices 7 (codebuddy) + 2 (codex) → order follows the input
    expect(resolveSelfModeSelection([7, 2], detected)).toEqual(['codebuddy', 'codex']);
  });

  it('Auto + a specific tool merges detected first, then extras, deduped', () => {
    // Auto → [claude, codex]; index 3 → cursor. codex already present, not dup.
    expect(resolveSelfModeSelection([0, 3, 2], detected)).toEqual(['claude', 'codex', 'cursor']);
  });

  it('"all" (every index incl. Auto) yields the full choice set once', () => {
    const allIndices = Array.from({ length: SELF_MODE_AGENT_CHOICES.length + 1 }, (_, index) => index);
    expect(resolveSelfModeSelection(allIndices, detected)).toEqual([...SELF_MODE_AGENT_CHOICES]);
  });
});
