import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fse from 'fs-extra';
import { listFilesRecursive } from '../utils/fs.js';
import { shipped, shippedSkillDigestsMock } from './helpers/shipped-skills.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The team config the prune tests share; pass toolPaths to change which tool runs. */
function legacyPruneTeamConfig(
  toolPaths: Record<string, { skills: string; userScope?: { skills: string } }> = { claude: { skills: '.claude/skills' } },
) {
  return {
    team: 'test',
    description: '',
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths,
  };
}

function legacyPruneLocalConfig(tmpDir: string) {
  return {
    repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto' as const,
    additionalRoles: [],
    scope: 'user' as const,
  };
}

/**
 * The one backup root this run created. Its name carries a timestamp, so the
 * test reads it back instead of reconstructing it and racing the clock.
 */
async function onlyRunDir(homeDir: string): Promise<string> {
  const root = path.join(homeDir, '.teamai/removed-skills');
  const runs = await fse.readdir(root);
  expect(runs).toHaveLength(1);
  // Below the run comes the base directory the deploy targeted, keyed by a
  // digest so two scopes in one process cannot land on the same path.
  const bases = await fse.readdir(path.join(root, runs[0]));
  expect(bases).toHaveLength(1);
  return path.join(root, runs[0], bases[0]);
}

// A file is the CLI's only at content a release shipped; `shipped()` stands in
// for that content, anything else at the same path is the member's.
vi.mock('../packaged-skill-digests.js', () => shippedSkillDigestsMock());

const WIKI_SKILL = shipped('team-wiki-codebase', 'SKILL.md');
/** Two releases' SKILL.md: both ours, and told apart. */
const WIKI_SKILL_OTHER_RELEASE = shipped('team-wiki-codebase', 'SKILL.md', 2);

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  // pullAllRules reads placement records so its stale sweep spares the
  // author's own copy of a rule published into a namespace.
  loadStateForScope: vi.fn(async () => ({})),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn(),
  pushRepoBranch: vi.fn().mockResolvedValue(true),
  generateBranchName: vi.fn().mockReturnValue('teamai/push/test/20260305-120000'),
}));

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

import { ResourceHandler } from '../resources/base.js';
import { SkillsHandler } from '../resources/skills.js';
import { RulesHandler } from '../resources/rules.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('ResourceHandler.isToolInstalled', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-install-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should return true when tool root directory exists', async () => {
    expect(await ResourceHandler.isToolInstalled('.claude/skills')).toBe(true);
  });

  it('should return false when tool root directory does not exist', async () => {
    expect(await ResourceHandler.isToolInstalled('.codebuddy/skills')).toBe(false);
  });

  it('should return false for nested path when root does not exist', async () => {
    expect(await ResourceHandler.isToolInstalled('.cursor/skills')).toBe(false);
  });

  it('should return true after tool directory is created', async () => {
    expect(await ResourceHandler.isToolInstalled('.codex/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.codex'));
    expect(await ResourceHandler.isToolInstalled('.codex/skills')).toBe(true);
  });

  it('should detect codex-internal tool installation', async () => {
    expect(await ResourceHandler.isToolInstalled('.codex-internal/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.codex-internal'));
    expect(await ResourceHandler.isToolInstalled('.codex-internal/skills')).toBe(true);
  });

  it('uses .config/opencode (not .config) as the OpenCode user-scope root', async () => {
    // A bare .config dir must NOT count as OpenCode installed.
    await fse.ensureDir(path.join(homeDir, '.config'));
    expect(await ResourceHandler.isToolInstalled('.config/opencode/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.config/opencode'));
    expect(await ResourceHandler.isToolInstalled('.config/opencode/skills')).toBe(true);
  });

  it('uses the first segment as the root for openclaw 3-segment claudemd paths', async () => {
    // .openclaw/workspace/AGENTS.md → root is .openclaw, not .openclaw/workspace.
    expect(await ResourceHandler.isToolInstalled('.openclaw/workspace/AGENTS.md')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.openclaw'));
    expect(await ResourceHandler.isToolInstalled('.openclaw/workspace/AGENTS.md')).toBe(true);
  });
});

describe('SkillsHandler.pullItem — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: SkillsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-pull-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new SkillsHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    // Create a skill in the team repo to pull
    const skillDir = path.join(repoPath, 'skills', 'test-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync skill to installed tool (claude)', async () => {
    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/test-skill/SKILL.md'))).toBe(true);
  });

  it('should NOT create directories for uninstalled tool (codebuddy)', async () => {
    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });

  it('should sync to both tools when both are installed', async () => {
    // Now also create .codebuddy
    await fse.ensureDir(path.join(homeDir, '.codebuddy'));

    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/test-skill/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/test-skill/SKILL.md'))).toBe(true);
  });
});

describe('RulesHandler.pullItem — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-pull-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Only create .claude, NOT .cursor
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
        cursor: { skills: '.cursor/skills', rules: '.cursor/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    // Create a rule in the team repo
    await fse.writeFile(path.join(repoPath, 'rules', 'test-rule.md'), '# Test Rule');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync rule to installed tool (claude)', async () => {
    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/test-rule.md'))).toBe(true);
  });

  it('should NOT create directories for uninstalled tool (cursor)', async () => {
    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor'))).toBe(false);
  });

  it('should sync to both tools when both are installed', async () => {
    await fse.ensureDir(path.join(homeDir, '.cursor'));

    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/test-rule.md'))).toBe(true);
    // Cursor rules must be written as `.mdc` (a plain `.md` there is ignored by Cursor).
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/test-rule.mdc'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/test-rule.md'))).toBe(false);
  });
});

describe('RulesHandler.pullAllRules — skip CLAUDE.md update for uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-claudemd-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
        codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', claudemd: '.codebuddy/CODEBUDDY.md' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# My Rule');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should distribute rules to installed tool only', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    // claude rules directory should have the rule file
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/my-rule.md'))).toBe(true);

    // codebuddy should not exist at all
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });
});

describe('deployBuiltinSkills — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let builtinSkillsDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-builtin-skills-'));
    homeDir = path.join(tmpDir, 'home');

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);

    // Create a fake built-in skills directory to simulate bundled skills
    builtinSkillsDir = path.join(tmpDir, 'builtin-skills', 'teamai-test-skill');
    await fse.ensureDir(builtinSkillsDir);
    await fse.writeFile(path.join(builtinSkillsDir, 'SKILL.md'), '# Test Built-in Skill');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should NOT create directories for uninstalled tool (codebuddy)', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
        codebuddy: { skills: '.codebuddy/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    await deployBuiltinSkills(teamConfig, localConfig);

    // codebuddy directory should NOT be created
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });

  it('should deploy to installed tool (claude)', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // deployBuiltinSkills uses getBuiltinSkillsDir() which resolves from import.meta.url
    // In test env the built-in skills dir may not exist, so deployed count could be 0
    // Key assertion: it does NOT create .codebuddy directories and does not throw
    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(true);
  });

  it('uses the default home when no local config is available', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };

    const deployed = await deployBuiltinSkills(teamConfig);

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(
      homeDir,
      '.claude/skills/teamai/SKILL.md',
    ))).toBe(true);
  });

  it('deploys the discovery stub only, never the packaged content', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);
    const skillsDir = path.join(homeDir, '.claude/skills');
    const stubDir = path.join(skillsDir, 'teamai');

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(stubDir, 'SKILL.md'))).toBe(true);
    // The stub is the whole deployed unit: one file, no references, no scripts.
    expect(await fse.readdir(stubDir)).toEqual(['SKILL.md']);
    expect(await fse.readdir(skillsDir)).toEqual(['teamai']);
    // ...and it is the packaged file verbatim, so a diff means a bug.
    expect(await fse.readFile(path.join(stubDir, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('deploys built-in skills to OpenCode user scope under .config/opencode/skills', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // OpenCode-only user: config lives at ~/.config/opencode, no ~/.opencode.
    await fse.ensureDir(path.join(homeDir, '.config/opencode'));

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        opencode: {
          skills: '.opencode/skills',
          userScope: { skills: '.config/opencode/skills' },
        },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    expect(deployed).toBeGreaterThan(0);
    // Written to the user-scope path, NOT the project-scope .opencode/skills.
    expect(await fse.pathExists(path.join(homeDir, '.config/opencode/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.opencode'))).toBe(false);
  });

  it('deploys the stub regardless of recall, and prunes the legacy directories', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // Pre-stub releases left these behind in every agent directory.
    await fse.ensureDir(path.join(homeDir, '.claude/skills/team-wiki-codebase/references'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    await fse.ensureDir(path.join(homeDir, '.claude/skills/teamai-share-learnings'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/teamai-share-learnings/SKILL.md'), shipped('teamai-share-learnings', 'SKILL.md'));
    // These two names were reserved in the old guard set but never packaged, so
    // a directory by either name is the user's own skill.
    for (const userSkill of ['teamai-workflow', 'teamai-import']) {
      await fse.ensureDir(path.join(homeDir, `.claude/skills/${userSkill}`));
      await fse.writeFile(path.join(homeDir, `.claude/skills/${userSkill}/SKILL.md`), '# mine');
    }

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    expect(deployed).toBeGreaterThan(0);
    // The stub routes to every workflow, so recall no longer gates deployment:
    // `teamai skill get share` decides at run time whether recall is on, and the
    // directories earlier releases deployed are removed on the way.
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-wiki-codebase'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/teamai-share-learnings'))).toBe(false);
    for (const userSkill of ['teamai-workflow', 'teamai-import']) {
      expect(await fse.readFile(path.join(homeDir, `.claude/skills/${userSkill}/SKILL.md`), 'utf8'), userSkill).toBe('# mine');
    }
  });

  it('archives what it prunes, and keeps a packaged path whose content the member changed', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // A path a release shipped is ours only at content a release shipped there.
    // The unedited SKILL.md goes, a copy archived first; the reference the
    // member rewrote is theirs now and stays, and so does its directory.
    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    await fse.ensureDir(path.join(wiki, 'references/methodology'));
    await fse.writeFile(path.join(wiki, 'SKILL.md'), WIKI_SKILL);
    await fse.writeFile(path.join(wiki, 'references/methodology/phase0-collection.md'), '# my notes');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(wiki, 'SKILL.md'))).toBe(false);
    expect(await fse.readFile(path.join(wiki, 'references/methodology/phase0-collection.md'), 'utf8')).toBe('# my notes');

    const backup = path.join(await onlyRunDir(homeDir), 'claude/.claude-skills/team-wiki-codebase');
    expect(await fse.readFile(path.join(backup, 'SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.pathExists(path.join(backup, 'references/methodology/phase0-collection.md'))).toBe(false);
  });

  it('keeps a file it could not back up, instead of deleting it anyway', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = legacyPruneTeamConfig();
    const localConfig = legacyPruneLocalConfig(tmpDir);

    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    await fse.ensureDir(wiki);
    await fse.writeFile(path.join(wiki, 'SKILL.md'), WIKI_SKILL);

    // A file where the backup tree has to start: every copy under it fails, the
    // way a full disk or a read-only home would.
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    await fse.writeFile(path.join(homeDir, '.teamai/removed-skills'), 'not a directory');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.readFile(path.join(wiki, 'SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
  });

  it('never walks through a symlinked skill root, so it cannot delete the link target', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // A shared checkout the member linked in. Every path under it matches ours
    // by name, so following the link would delete files we never wrote.
    const shared = path.join(tmpDir, 'shared-skills/team-wiki-codebase');
    await fse.ensureDir(shared);
    await fse.writeFile(path.join(shared, 'SKILL.md'), WIKI_SKILL);

    await fse.ensureDir(path.join(homeDir, '.claude/skills'));
    await fse.symlink(shared, path.join(homeDir, '.claude/skills/team-wiki-codebase'), 'dir');

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(shared, 'SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-wiki-codebase'))).toBe(true);
  });

  it('stops at a link above the skill directory, not just at the skill directory', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // The common shape: the member links their whole skills root at a dotfiles
    // checkout. Every directory under it is real, so checking the leaf alone
    // sees nothing and the walk deletes files in the checkout.
    const dotfiles = path.join(tmpDir, 'dotfiles/skills');
    await fse.ensureDir(path.join(dotfiles, 'team-wiki-codebase'));
    await fse.writeFile(path.join(dotfiles, 'team-wiki-codebase/SKILL.md'), WIKI_SKILL);

    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.symlink(dotfiles, path.join(homeDir, '.claude/skills'), 'dir');

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(dotfiles, 'team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.pathExists(path.join(dotfiles, 'teamai/SKILL.md'))).toBe(false);
  });

  it('does not write the stub through a symlinked destination', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const outside = path.join(tmpDir, 'outside/teamai');
    await fse.ensureDir(outside);
    await fse.writeFile(path.join(outside, 'SKILL.md'), '# not ours');

    await fse.ensureDir(path.join(homeDir, '.claude/skills'));
    await fse.symlink(outside, path.join(homeDir, '.claude/skills/teamai'), 'dir');

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    // The prune refuses to walk the link; the copy must refuse to write through
    // it too, or the guarantee stops one line short of where it is claimed.
    expect(await fse.readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('# not ours');
  });

  it('stops at a link on any component below the base, not only the last two', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // `~/.config/opencode` linked at a dotfiles checkout: the skills root and
    // the skill directory under it are real directories, the link is higher up.
    const dotfiles = path.join(tmpDir, 'dotfiles/opencode');
    await fse.ensureDir(path.join(dotfiles, 'skills/team-wiki-codebase'));
    await fse.writeFile(path.join(dotfiles, 'skills/team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    await fse.ensureDir(path.join(homeDir, '.config'));
    await fse.symlink(dotfiles, path.join(homeDir, '.config/opencode'), 'dir');

    const deployed = await deployBuiltinSkills(
      legacyPruneTeamConfig({ opencode: { skills: '.config/opencode/skills' } }),
      legacyPruneLocalConfig(tmpDir),
    );

    expect(deployed).toBe(0);
    expect(await fse.readFile(path.join(dotfiles, 'skills/team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.pathExists(path.join(dotfiles, 'skills/teamai'))).toBe(false);
  });

  it('deploys the stub and prunes where team skills land for Hermes and OpenClaw, not under the tool root', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // Hermes honours HERMES_HOME, which can live outside HOME; OpenClaw reads
    // skills from its workspace. Team-skill sync already resolves both.
    const hermesHome = path.join(tmpDir, 'elsewhere/hermes');
    vi.stubEnv('HERMES_HOME', hermesHome);
    await fse.ensureDir(path.join(hermesHome, 'skills/team-wiki-codebase'));
    await fse.writeFile(path.join(hermesHome, 'skills/team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    const workspace = path.join(homeDir, '.openclaw/workspace');
    await fse.ensureDir(workspace);

    const deployed = await deployBuiltinSkills(
      legacyPruneTeamConfig({ hermes: { skills: '.hermes/skills' }, openclaw: { skills: '.openclaw/skills' } }),
      legacyPruneLocalConfig(tmpDir),
    );

    expect(deployed).toBe(2);
    expect(await fse.pathExists(path.join(hermesHome, 'skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(hermesHome, 'skills/team-wiki-codebase'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, 'skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.hermes'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.openclaw/skills'))).toBe(false);
  });

  it('refuses a linked HERMES_HOME outside the home directory, the root itself not only what is under it', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const target = path.join(tmpDir, 'dotfiles/hermes');
    await fse.ensureDir(path.join(target, 'skills/team-wiki-codebase'));
    await fse.writeFile(path.join(target, 'skills/team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    const hermesHome = path.join(tmpDir, 'elsewhere/hermes');
    await fse.ensureDir(path.dirname(hermesHome));
    await fse.symlink(target, hermesHome, 'dir');
    vi.stubEnv('HERMES_HOME', hermesHome);

    const deployed = await deployBuiltinSkills(
      legacyPruneTeamConfig({ hermes: { skills: '.hermes/skills' } }),
      legacyPruneLocalConfig(tmpDir),
    );

    expect(deployed).toBe(0);
    expect(await fse.readFile(path.join(target, 'skills/team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.pathExists(path.join(target, 'skills/teamai'))).toBe(false);
  });

  it('refuses a linked COPILOT_HOME, which is Copilot\'s own base directory in user scope', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const target = path.join(tmpDir, 'dotfiles/copilot');
    await fse.ensureDir(path.join(target, 'skills/team-wiki-codebase'));
    await fse.writeFile(path.join(target, 'skills/team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    await fse.symlink(target, path.join(homeDir, '.copilot'), 'dir');

    const deployed = await deployBuiltinSkills(
      legacyPruneTeamConfig({ copilot: { skills: '.github/skills', userScope: { skills: 'skills' } } }),
      legacyPruneLocalConfig(tmpDir),
    );

    expect(deployed).toBe(0);
    expect(await fse.readFile(path.join(target, 'skills/team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.pathExists(path.join(target, 'skills/teamai'))).toBe(false);
  });

  it('keeps a skill of the member\'s that only shares a packaged name, whatever its paths', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // A root TeamAI never managed, or a skill the member wrote under the old
    // name: every path matches a packaged one, no content matches a release.
    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    await fse.ensureDir(path.join(wiki, 'scripts'));
    await fse.writeFile(path.join(wiki, 'SKILL.md'), '---\nname: team-wiki-codebase\n---\n# my own wiki skill\n');
    await fse.writeFile(path.join(wiki, 'scripts/scan_repo.py'), 'print("mine")\n');

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(wiki, 'SKILL.md'), 'utf8')).toContain('# my own wiki skill');
    expect(await fse.readFile(path.join(wiki, 'scripts/scan_repo.py'), 'utf8')).toBe('print("mine")\n');
    expect(await fse.pathExists(path.join(homeDir, '.teamai/removed-skills'))).toBe(false);
  });

  it('retires the second Codex copy of the stub, so Codex does not read a stale one beside it', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // The resolver picks .agents/skills/teamai because it exists; the copy an
    // earlier release left in .codex/skills would otherwise keep its old body.
    await fse.ensureDir(path.join(homeDir, '.codex'));
    const shared = path.join(homeDir, '.agents/skills/teamai');
    const configured = path.join(homeDir, '.codex/skills/teamai');
    await fse.ensureDir(shared);
    await fse.writeFile(path.join(shared, 'SKILL.md'), shipped('teamai', 'SKILL.md'));
    await fse.ensureDir(path.join(configured, 'references'));
    await fse.writeFile(path.join(configured, 'SKILL.md'), shipped('teamai', 'SKILL.md'));
    await fse.writeFile(path.join(configured, 'references/setup-admin.md'), shipped('teamai', 'references/setup-admin.md'));

    await deployBuiltinSkills(legacyPruneTeamConfig({ codex: { skills: '.codex/skills' } }), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(shared, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
    expect(await fse.pathExists(configured)).toBe(false);
  });

  it('keeps the second Codex copy when it holds a file TeamAI did not write', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    await fse.ensureDir(path.join(homeDir, '.codex'));
    const shared = path.join(homeDir, '.agents/skills/teamai');
    const configured = path.join(homeDir, '.codex/skills/teamai');
    await fse.ensureDir(shared);
    await fse.ensureDir(path.join(configured, 'references'));
    await fse.writeFile(path.join(configured, 'SKILL.md'), shipped('teamai', 'SKILL.md'));
    await fse.writeFile(path.join(configured, 'references/team-playbook.md'), '# mine');

    await deployBuiltinSkills(legacyPruneTeamConfig({ codex: { skills: '.codex/skills' } }), legacyPruneLocalConfig(tmpDir));

    expect(await fse.pathExists(path.join(configured, 'SKILL.md'))).toBe(false);
    expect(await fse.readFile(path.join(configured, 'references/team-playbook.md'), 'utf8')).toBe('# mine');
  });

  it('keeps a member\'s file under a __pycache__ that is not bytecode of a shipped script', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    await fse.ensureDir(path.join(wiki, 'scripts/__pycache__'));
    await fse.ensureDir(path.join(wiki, 'notes/__pycache__'));
    await fse.writeFile(path.join(wiki, 'SKILL.md'), WIKI_SKILL);
    await fse.writeFile(path.join(wiki, 'scripts/scan_repo.py'), shipped('team-wiki-codebase', 'scripts/scan_repo.py'));
    await fse.writeFile(path.join(wiki, 'scripts/__pycache__/scan_repo.cpython-311.pyc'), 'bytecode');
    await fse.writeFile(path.join(wiki, 'notes/__pycache__/keep.txt'), '# mine');

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.pathExists(path.join(wiki, 'scripts/__pycache__/scan_repo.cpython-311.pyc'))).toBe(false);
    expect(await fse.readFile(path.join(wiki, 'notes/__pycache__/keep.txt'), 'utf8')).toBe('# mine');
  });

  it('keeps both copies when the user and the project scope prune the same skill in one run', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // `inheritUserScope`: user base, then project base, same tool, root and name.
    const projectRoot = path.join(tmpDir, 'work/proj');
    const projectConfig = { ...legacyPruneLocalConfig(tmpDir), scope: 'project' as const, projectRoot };
    for (const [base, body] of [[homeDir, WIKI_SKILL], [projectRoot, WIKI_SKILL_OTHER_RELEASE]]) {
      await fse.ensureDir(path.join(base, '.claude/skills/team-wiki-codebase'));
      await fse.writeFile(path.join(base, '.claude/skills/team-wiki-codebase/SKILL.md'), body);
    }

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));
    await deployBuiltinSkills(legacyPruneTeamConfig(), projectConfig);

    expect(await fse.pathExists(path.join(projectRoot, '.claude/skills/team-wiki-codebase'))).toBe(false);
    const archived = (await listFilesRecursive(path.join(homeDir, '.teamai/removed-skills')))
      .filter((f) => f.endsWith('team-wiki-codebase/SKILL.md'));
    const bodies = await Promise.all(archived.map((f) => fse.readFile(path.join(homeDir, '.teamai/removed-skills', f), 'utf8')));
    expect(bodies.sort()).toEqual([WIKI_SKILL, WIKI_SKILL_OTHER_RELEASE].sort());
  });

  it('keeps the legacy skills when the stub could not be deployed, so the agent keeps one to discover', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // The stub destination is a link, so the stub is refused; pruning first
    // would leave the agent with neither the old skills nor the new one.
    const outside = path.join(tmpDir, 'outside/teamai');
    await fse.ensureDir(outside);
    await fse.ensureDir(path.join(homeDir, '.claude/skills/team-wiki-codebase'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    await fse.symlink(outside, path.join(homeDir, '.claude/skills/teamai'), 'dir');

    const deployed = await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(deployed).toBe(0);
    expect(await fse.readFile(path.join(homeDir, '.claude/skills/team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
  });

  it('reports a legacy directory it emptied but could not remove, instead of calling it removed', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const { log } = await import('../utils/logger.js');

    // A locked skills root: the files inside the legacy directory can go, the
    // directory itself cannot. The stub directory already exists, so the stub
    // still deploys and the prune runs.
    const skills = path.join(homeDir, '.claude/skills');
    await fse.ensureDir(path.join(skills, 'team-wiki-codebase'));
    await fse.writeFile(path.join(skills, 'team-wiki-codebase/SKILL.md'), WIKI_SKILL);
    await fse.ensureDir(path.join(skills, 'teamai'));
    await fse.writeFile(path.join(skills, 'teamai/SKILL.md'), shipped('teamai', 'SKILL.md'));
    (log.warn as ReturnType<typeof vi.fn>).mockClear();
    await fse.chmod(skills, 0o555);
    try {
      await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));
    } finally {
      await fse.chmod(skills, 0o755);
    }

    const warnings = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes('team-wiki-codebase') && w.includes('could not be deleted'))).toHaveLength(1);
    // The stub's own directory is not empty, so it is not reported.
    expect(warnings.filter((w) => w.includes(path.join(skills, 'teamai')))).toEqual([]);
  });

  it('keeps a SKILL.md whose member changed only the frontmatter', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // Same body a release shipped, a description of the member's: the skill is
    // theirs now, so the whole file is what ownership is proven on.
    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    const edited = `---\nname: team-wiki-codebase\ndescription: my wording\n---\n${WIKI_SKILL}`;
    await fse.ensureDir(wiki);
    await fse.writeFile(path.join(wiki, 'SKILL.md'), edited);

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(wiki, 'SKILL.md'), 'utf8')).toBe(edited);
  });

  it('keeps bytecode beside a script the member edited', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    await fse.ensureDir(path.join(wiki, 'scripts/__pycache__'));
    await fse.writeFile(path.join(wiki, 'scripts/scan_repo.py'), 'print("my version")\n');
    await fse.writeFile(path.join(wiki, 'scripts/__pycache__/scan_repo.cpython-311.pyc'), 'bytecode of my version');

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.pathExists(path.join(wiki, 'scripts/__pycache__/scan_repo.cpython-311.pyc'))).toBe(true);
  });

  it('keeps the old references when the stub cannot be written over the old SKILL.md', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // Something the copy cannot replace sits where SKILL.md goes, so the stub
    // is not written. Pruning the references first would leave the old skill
    // pointing at files that are gone.
    const stubDir = path.join(homeDir, '.claude/skills/teamai');
    await fse.ensureDir(path.join(stubDir, 'references'));
    await fse.ensureDir(path.join(stubDir, 'SKILL.md'));
    await fse.writeFile(path.join(stubDir, 'SKILL.md', 'keep'), '# blocks the copy');
    await fse.writeFile(path.join(stubDir, 'references/setup-admin.md'), shipped('teamai', 'references/setup-admin.md'));

    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(stubDir, 'references/setup-admin.md'), 'utf8')).toBe(shipped('teamai', 'references/setup-admin.md'));
  });

  it('deletes nothing through a linked Codex skills root while resolving where the stub goes', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // `.codex/skills` linked at a dotfiles checkout, holding a copy identical to
    // the shared one and to the package: the resolver's reconciliation would
    // delete it through the link before the guard ever ran.
    const stub = await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8');
    const dotfiles = path.join(tmpDir, 'dotfiles/codex-skills');
    await fse.ensureDir(path.join(dotfiles, 'teamai'));
    await fse.writeFile(path.join(dotfiles, 'teamai/SKILL.md'), stub);
    await fse.ensureDir(path.join(homeDir, '.codex'));
    await fse.symlink(dotfiles, path.join(homeDir, '.codex/skills'), 'dir');
    await fse.ensureDir(path.join(homeDir, '.agents/skills/teamai'));
    await fse.writeFile(path.join(homeDir, '.agents/skills/teamai/SKILL.md'), stub);

    await deployBuiltinSkills(legacyPruneTeamConfig({ codex: { skills: '.codex/skills' } }), legacyPruneLocalConfig(tmpDir));

    expect(await fse.readFile(path.join(dotfiles, 'teamai/SKILL.md'), 'utf8')).toBe(stub);
  });

  it('archives nothing when there is nothing retired to archive', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // Deployment runs on every session start, unchanged revision included. The
    // stub it rewrites is shipped now, not retired, so it must not be archived
    // once per session for the life of the install.
    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));
    await deployBuiltinSkills(legacyPruneTeamConfig(), legacyPruneLocalConfig(tmpDir));

    expect(await fse.pathExists(path.join(homeDir, '.teamai/removed-skills'))).toBe(false);
  });

  it('gives each skill root its own backup, so the two Codex copies do not overwrite each other', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = legacyPruneTeamConfig({ codex: { skills: '.codex/skills' } });
    const localConfig = legacyPruneLocalConfig(tmpDir);

    // Codex prunes its own root and the shared one; same skill name, different files.
    for (const [root, body] of [['.codex/skills', WIKI_SKILL], ['.agents/skills', WIKI_SKILL_OTHER_RELEASE]]) {
      await fse.ensureDir(path.join(homeDir, root, 'team-wiki-codebase'));
      await fse.writeFile(path.join(homeDir, root, 'team-wiki-codebase/SKILL.md'), body);
    }

    await deployBuiltinSkills(teamConfig, localConfig);

    const run = await onlyRunDir(homeDir);
    expect(await fse.readFile(path.join(run, 'codex/.codex-skills/team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
    expect(await fse.readFile(path.join(run, 'codex/.agents-skills/team-wiki-codebase/SKILL.md'), 'utf8')).toBe(WIKI_SKILL_OTHER_RELEASE);
  });

  it('removes the references an earlier release deployed beside the stub', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // What `teamai pull` wrote before the stub: the same directory name, with a
    // references tree the new deployment does not ship.
    const stubDir = path.join(homeDir, '.claude/skills/teamai');
    await fse.ensureDir(path.join(stubDir, 'references'));
    await fse.writeFile(path.join(stubDir, 'SKILL.md'), shipped('teamai', 'SKILL.md'));
    await fse.writeFile(path.join(stubDir, 'references/setup-admin.md'), shipped('teamai', 'references/setup-admin.md'));

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.readdir(stubDir)).toEqual(['SKILL.md']);
    expect(await fse.readFile(path.join(stubDir, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('prunes legacy skills from the Codex shared directory and deploys the stub beside them', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    await fse.ensureDir(path.join(homeDir, '.codex'));
    const sharedLegacy = path.join(homeDir, '.agents/skills/team-wiki-codebase');
    await fse.ensureDir(sharedLegacy);
    await fse.writeFile(path.join(sharedLegacy, 'SKILL.md'), WIKI_SKILL);

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { codex: { skills: '.codex/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    expect(deployed).toBe(1);
    expect(await fse.pathExists(sharedLegacy)).toBe(false);
    // Codex reads .codex/skills; the shared .agents/skills is where its legacy
    // copies live, and the prune is the only thing that reaches in there.
    expect(await fse.readFile(path.join(homeDir, '.codex/skills/teamai/SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('records every file the package still ships, so the prune keeps proving ownership', async () => {
    const { PACKAGED_SKILL_FILES } = await import('../builtin-skills.js');

    const shipped: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
        else shipped.push(relative);
      }
    };
    await walk(path.join(PACKAGE_ROOT, 'skills'), '');

    // A packaged file missing from the manifest is one a later migration would
    // leave behind on every machine, which no other test would notice.
    for (const relative of shipped) {
      const [skillName, ...rest] = relative.split('/');
      expect(PACKAGED_SKILL_FILES.get(skillName), relative).toContain(rest.join('/'));
    }
  });

  it('removes the packaged files from a legacy directory but keeps what the member added', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    // What the release packaged…
    for (const packaged of ['SKILL.md', 'README.md', 'references/methodology/phase0-collection.md', 'scripts/scan_repo.py']) {
      await fse.ensureDir(path.join(wiki, path.dirname(packaged)));
      await fse.writeFile(path.join(wiki, packaged), shipped('team-wiki-codebase', packaged));
    }
    // …and what the member put beside it, which `overwrite: true` never deleted.
    await fse.writeFile(path.join(wiki, 'references/methodology/my-notes.md'), '# mine');
    await fse.ensureDir(path.join(wiki, 'scripts/__pycache__'));
    await fse.writeFile(path.join(wiki, 'scripts/__pycache__/scan_repo.cpython-311.pyc'), 'bytecode');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(wiki, 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(wiki, 'README.md'))).toBe(false);
    expect(await fse.pathExists(path.join(wiki, 'references/methodology/phase0-collection.md'))).toBe(false);
    // Bytecode of a script we shipped is ours, so it does not keep the tree alive.
    expect(await fse.pathExists(path.join(wiki, 'scripts'))).toBe(false);
    // The member's file, and only it, survives.
    expect(await fse.readFile(path.join(wiki, 'references/methodology/my-notes.md'), 'utf8')).toBe('# mine');
  });

  it('keeps a file the member added beside the deployed stub', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const stubDir = path.join(homeDir, '.claude/skills/teamai');
    await fse.ensureDir(path.join(stubDir, 'references'));
    await fse.writeFile(path.join(stubDir, 'SKILL.md'), shipped('teamai', 'SKILL.md'));
    await fse.writeFile(path.join(stubDir, 'references/setup-admin.md'), shipped('teamai', 'references/setup-admin.md'));
    await fse.writeFile(path.join(stubDir, 'references/team-playbook.md'), '# mine');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(stubDir, 'references/setup-admin.md'))).toBe(false);
    expect(await fse.readFile(path.join(stubDir, 'references/team-playbook.md'), 'utf8')).toBe('# mine');
    expect(await fse.readFile(path.join(stubDir, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('leaves the Codex shared directory alone when another tool prunes and Codex is excluded', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.ensureDir(path.join(homeDir, '.codex'));
    const sharedLegacy = path.join(homeDir, '.agents/skills/team-wiki-codebase');
    await fse.ensureDir(sharedLegacy);
    await fse.writeFile(path.join(sharedLegacy, 'SKILL.md'), WIKI_SKILL);

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
      enabledAgents: ['claude'],
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    // .agents/skills is Codex's; the whitelist says Codex is neither written to
    // nor deleted from, and Claude's pass must not reach it on Codex's behalf.
    expect(deployed).toBe(1);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.readFile(path.join(sharedLegacy, 'SKILL.md'), 'utf8')).toBe(WIKI_SKILL);
  });

  it('deploys a built-in Codex skill to its existing shared location', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const sharedSkill = path.join(homeDir, '.agents', 'skills', 'teamai');
    await fse.ensureDir(path.join(homeDir, '.codex'));
    await fse.ensureDir(sharedSkill);

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { codex: { skills: '.codex/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(sharedSkill, 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'skills', 'teamai'))).toBe(false);
  });
});

describe('deployBuiltinSkills — enabledAgents whitelist (#510)', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-builtin-whitelist-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.workbuddy'));
    await fse.ensureDir(path.join(homeDir, '.hermes'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  function teamConfig() {
    return {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills' },
        hermes: { skills: '.hermes/skills' },
      },
    };
  }

  function localConfig(enabledAgents?: string[]) {
    return {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
      ...(enabledAgents ? { enabledAgents } : {}),
    };
  }

  it('does not copy builtin skills into an installed tool outside the whitelist', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const deployed = await deployBuiltinSkills(teamConfig(), localConfig(['workbuddy']));

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.workbuddy/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills/teamai'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills'))).toBe(false);
  });

  it('still deploys to every installed tool when enabledAgents is unset', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const deployed = await deployBuiltinSkills(teamConfig(), localConfig());

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.workbuddy/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills/teamai/SKILL.md'))).toBe(true);
  });
});
