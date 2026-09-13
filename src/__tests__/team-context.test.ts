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
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

import { log } from '../utils/logger.js';
import {
  resolveTeamContextSnapshot,
  materializeTeamContext,
  syncTeamContext,
  getTeamContextItemNames,
  getTeamContextRepoDir,
} from '../team-context.js';
import { getHandler } from '../resources/index.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

const DSH_REPO_URL = 'git@example.com:acme/dsh-team-context.git';

describe('team-context', () => {
  let tmpDir: string;
  let homeDir: string;
  let dshRepoDir: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-team-context-test-'));
    homeDir = path.join(tmpDir, 'home');
    vi.stubEnv('HOME', homeDir);

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

    // The team-context cache dir is derived from the repo URL by team-context.ts
    // itself (sha256-hashed), so tests resolve it via the exported helper rather
    // than reimplementing the hash.
    dshRepoDir = getTeamContextRepoDir(DSH_REPO_URL);
    await fse.ensureDir(dshRepoDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.example.com/acme/team-repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      teamContext: { repo: DSH_REPO_URL },
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
      },
    } as unknown as TeamaiConfig;

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.example.com/acme/team-repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    } as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  /** Populate the fake upstream DSH repo with one skill, one rule, one governance file. */
  async function seedUpstream(opts: {
    schemaVersion?: number | string;
    skillContent?: string;
    ruleContent?: string;
    governanceContent?: string;
    omitContractFile?: boolean;
  } = {}): Promise<void> {
    await fse.remove(dshRepoDir);
    await fse.ensureDir(dshRepoDir);

    if (!opts.omitContractFile) {
      await fse.writeFile(
        path.join(dshRepoDir, 'team-context.yaml'),
        `schemaVersion: ${opts.schemaVersion ?? 1}\n`,
      );
    }

    await fse.ensureDir(path.join(dshRepoDir, 'skills', 'incident-response'));
    await fse.writeFile(
      path.join(dshRepoDir, 'skills', 'incident-response', 'SKILL.md'),
      opts.skillContent ?? '---\nname: incident-response\ndescription: canonical\n---\n# Canonical skill',
    );

    await fse.ensureDir(path.join(dshRepoDir, 'rules'));
    await fse.writeFile(
      path.join(dshRepoDir, 'rules', 'security-baseline.md'),
      opts.ruleContent ?? '# Canonical rule\nAlways do X.',
    );

    await fse.ensureDir(path.join(dshRepoDir, 'governance'));
    await fse.writeFile(
      path.join(dshRepoDir, 'governance', 'policy.md'),
      opts.governanceContent ?? 'All changes require review.',
    );
  }

  describe('resolveTeamContextSnapshot', () => {
    it('throws when team-context.yaml is missing', async () => {
      await seedUpstream({ omitContractFile: true });
      await expect(resolveTeamContextSnapshot(dshRepoDir)).rejects.toThrow(/missing team-context\.yaml/);
    });

    it('throws on an unsupported schemaVersion', async () => {
      await seedUpstream({ schemaVersion: 2 });
      await expect(resolveTeamContextSnapshot(dshRepoDir)).rejects.toThrow(/unsupported schemaVersion/);
    });

    it('resolves skills, rules, and governance files for a valid v1 repo', async () => {
      await seedUpstream();
      const snapshot = await resolveTeamContextSnapshot(dshRepoDir);
      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.skills.map((s) => s.name)).toEqual(['incident-response']);
      expect(snapshot.rules.map((r) => r.name)).toEqual(['security-baseline']);
      expect(snapshot.governanceFiles.map((g) => g.name)).toEqual(['policy.md']);
    });
  });

  describe('acceptance: canonical content follows upstream, never leaks into push, governance cannot be shadowed', () => {
    it('materializes skill + rule + governance on first pull', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});

      expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'))).toBe(true);
      expect(await fse.readFile(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8'))
        .toContain('Canonical rule');
      const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('Team Context Governance');
      expect(claudeMd).toContain('All changes require review.');
    });

    it('propagates an upstream content update on the next pull', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});

      await seedUpstream({ ruleContent: '# Canonical rule\nUpdated: always do Y now.' });
      await syncTeamContext(teamConfig, localConfig, {});

      const rule = await fse.readFile(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8');
      expect(rule).toContain('Updated: always do Y now.');
    });

    it('removes a skill and a rule locally once upstream drops them (tombstone-on-diff)', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});
      expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'incident-response'))).toBe(true);

      // Upstream now publishes nothing.
      await fse.remove(dshRepoDir);
      await fse.ensureDir(dshRepoDir);
      await fse.writeFile(path.join(dshRepoDir, 'team-context.yaml'), 'schemaVersion: 1\n');

      await syncTeamContext(teamConfig, localConfig, {});

      expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'incident-response'))).toBe(false);
      expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'))).toBe(false);
    });

    it('never surfaces canonical skills or rules as push candidates', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});

      const skillsHandler = getHandler('skills');
      const rulesHandler = getHandler('rules');
      const pushableSkills = await skillsHandler.scanLocalForPush(teamConfig, localConfig);
      const pushableRules = await rulesHandler.scanLocalForPush(teamConfig, localConfig);

      expect(pushableSkills.some((i) => i.name === 'incident-response')).toBe(false);
      expect(pushableRules.some((i) => i.name === 'security-baseline')).toBe(false);
    });

    it('a local project cannot silently shadow governance: the block is fully regenerated from upstream every pull', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});

      // Simulate a local attempt to override the governance section by hand-editing
      // inside its markers (the only way a human could try to "shadow" it, since
      // there is no config flag to disable the block).
      const claudeMdPath = path.join(homeDir, '.claude', 'CLAUDE.md');
      const tampered = (await fse.readFile(claudeMdPath, 'utf-8'))
        .replace('All changes require review.', 'Reviews are optional now.');
      await fse.writeFile(claudeMdPath, tampered);

      await syncTeamContext(teamConfig, localConfig, {});

      const finalContent = await fse.readFile(claudeMdPath, 'utf-8');
      expect(finalContent).toContain('All changes require review.');
      expect(finalContent).not.toContain('Reviews are optional now.');
    });

    it('clears stale governance content once upstream publishes none, rather than leaving it stale', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});

      await seedUpstream({ governanceContent: '' });
      await fse.remove(path.join(dshRepoDir, 'governance', 'policy.md'));
      await syncTeamContext(teamConfig, localConfig, {});

      const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).not.toContain('All changes require review.');
      expect(claudeMd).toContain('publishes no governance content');
    });

    it('an invalid upstream schemaVersion fails loud and leaves previously materialized state untouched', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, {});
      const before = await fse.readFile(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8');

      await seedUpstream({ schemaVersion: 99, ruleContent: '# This must never land\n' });
      await syncTeamContext(teamConfig, localConfig, {});

      const after = await fse.readFile(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8');
      expect(after).toBe(before);
      expect(after).not.toContain('This must never land');
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('unsupported schemaVersion'));
    });
  });

  describe('skills: local override wins, observably', () => {
    it('does not deploy the canonical skill when a local team skill has the same name', async () => {
      await seedUpstream();
      // The team repo declares its own skill under this name...
      await fse.ensureDir(path.join(localConfig.repo.localPath, 'skills', 'incident-response'));
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'skills', 'incident-response', 'SKILL.md'),
        '# Local team version',
      );
      // ...already deployed to the tool dir, as if pullForScope's own team-skill
      // sync had already run this pull cycle (team-context.ts never deploys team
      // skills itself — it only decides whether to leave this alone or overwrite it).
      await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'incident-response'));
      await fse.writeFile(
        path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'),
        '# Local team version',
      );

      await syncTeamContext(teamConfig, localConfig, {});

      const deployed = await fse.readFile(
        path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'),
        'utf-8',
      );
      expect(deployed).toBe('# Local team version');
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('overrides the canonical Team Context skill'));

      const names = await getTeamContextItemNames(teamConfig, 'skills');
      expect(names.has('incident-response')).toBe(false);
    });
  });

  describe('rules: canonical wins by default', () => {
    it('overwrites a same-named local team rule at its tool-dir location', async () => {
      await seedUpstream();
      // A team rule with the SAME name already deployed to the tool dir (as if
      // pullForScope's team-rule sync had already run this pull cycle).
      await fse.writeFile(
        path.join(homeDir, '.claude', 'rules', 'security-baseline.md'),
        '# Team-authored version (should be overwritten)',
      );

      await syncTeamContext(teamConfig, localConfig, {});

      const content = await fse.readFile(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8');
      expect(content).toContain('Canonical rule');
      expect(content).not.toContain('Team-authored version');
    });
  });

  describe('materializeTeamContext dry-run', () => {
    it('does not write anything to disk under --dry-run', async () => {
      await seedUpstream();
      await syncTeamContext(teamConfig, localConfig, { dryRun: true });

      expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'incident-response'))).toBe(false);
      expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'))).toBe(false);
    });
  });

  describe('no teamContext configured', () => {
    it('is a silent no-op', async () => {
      const noTeamContext = { ...teamConfig, teamContext: undefined };
      await expect(syncTeamContext(noTeamContext, localConfig, {})).resolves.toBeUndefined();
    });
  });

  describe('materializeTeamContext (unit)', () => {
    it('returns per-entity manifests instead of a single undifferentiated result', async () => {
      await seedUpstream();
      const snapshot = await resolveTeamContextSnapshot(dshRepoDir);
      const result = await materializeTeamContext(snapshot, teamConfig, localConfig, null);

      expect(result.deployedSkills).toEqual(['incident-response']);
      expect(result.deployedRules).toEqual(['security-baseline']);
      expect(result.governanceInjected).toBe(true);
      expect(result.skippedSkillsLocalOverride).toEqual([]);
      expect(result.removedSkills).toEqual([]);
      expect(result.removedRules).toEqual([]);
    });
  });
});
