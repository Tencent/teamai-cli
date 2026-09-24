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
  buildClassifyContext,
  classifySkill,
  formatSkillSource,
  readSkillDescription,
  scanAgentSkills,
  scanInstalledAgents,
  truncate,
} from '../agent-skills.js';
import { detectInstalledAgents, getEffectiveAgents } from '../known-agents.js';
import { BUILTIN_SKILL_NAMES } from '../builtin-skills.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

interface Fixture {
  tmpDir: string;
  homeDir: string;
  repoPath: string;
  localConfig: LocalConfig;
  teamConfig: TeamaiConfig;
}

async function makeFixture(): Promise<Fixture> {
  const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-skills-'));
  const homeDir = path.join(tmpDir, 'home');
  const repoPath = path.join(tmpDir, 'team-repo');
  await fse.ensureDir(path.join(repoPath, 'skills'));
  await fse.ensureDir(homeDir);
  vi.stubEnv('HOME', homeDir);

  const teamConfig: TeamaiConfig = {
    team: 'test',
    description: '',
    repo: 'https://example.com/test.git',
    provider: 'tgit',
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths: {
      claude: { skills: '.claude/skills', rules: '.claude/rules' },
      cursor: { skills: '.cursor/skills', rules: '.cursor/rules' },
    },
  };

  const localConfig: LocalConfig = {
    repo: { localPath: repoPath, remote: 'https://example.com/test.git' },
    username: 'tester',
    updatePolicy: 'auto',
    scope: 'user',
    additionalRoles: [],
  };

  return { tmpDir, homeDir, repoPath, localConfig, teamConfig };
}

async function makeSkill(dir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await fse.ensureDir(skillDir);
  const fm = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
  await fse.writeFile(path.join(skillDir, 'SKILL.md'), fm, 'utf-8');
}

describe('readSkillDescription', () => {
  it('parses single-line description', async () => {
    const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fm-'));
    const file = path.join(tmpDir, 'SKILL.md');
    await fse.writeFile(file, '---\nname: foo\ndescription: hello world\n---\n\n# foo');
    expect(await readSkillDescription(file)).toBe('hello world');
    await fse.remove(tmpDir);
  });

  it('parses quoted description', async () => {
    const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fm-'));
    const file = path.join(tmpDir, 'SKILL.md');
    await fse.writeFile(file, '---\ndescription: "quoted desc"\n---\n');
    expect(await readSkillDescription(file)).toBe('quoted desc');
    await fse.remove(tmpDir);
  });

  it('parses multi-line block description', async () => {
    const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fm-'));
    const file = path.join(tmpDir, 'SKILL.md');
    await fse.writeFile(
      file,
      '---\ndescription: >-\n  line one\n  line two\nname: bar\n---\n',
    );
    expect(await readSkillDescription(file)).toBe('line one line two');
    await fse.remove(tmpDir);
  });

  it('returns empty string when no frontmatter', async () => {
    const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fm-'));
    const file = path.join(tmpDir, 'SKILL.md');
    await fse.writeFile(file, '# Just a heading\n');
    expect(await readSkillDescription(file)).toBe('');
    await fse.remove(tmpDir);
  });
});

describe('truncate', () => {
  it('keeps short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('appends ellipsis when over limit', () => {
    expect(truncate('hello world this is long', 10)).toBe('hello w...');
  });
});

describe('classifySkill', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(fx.tmpDir);
  });

  it('returns [team] when skill is in flat layout of team repo', async () => {
    await makeSkill(path.join(fx.repoPath, 'skills'), 'team-flat', 'd');
    const ctx = await buildClassifyContext(fx.localConfig);
    const cls = classifySkill('team-flat', ctx);
    expect(cls).toEqual({ kind: 'team', namespace: undefined });
    expect(formatSkillSource(cls)).toBe('[team]');
  });

  it('returns [team:<ns>] when skill is in namespaced layout', async () => {
    await makeSkill(path.join(fx.repoPath, 'skills', 'hai'), 'team-ns', 'd');
    const ctx = await buildClassifyContext(fx.localConfig);
    const cls = classifySkill('team-ns', ctx);
    expect(cls).toEqual({ kind: 'team', namespace: 'hai' });
    expect(formatSkillSource(cls)).toBe('[team:hai]');
  });

  it('returns [builtin] for skills shipped with the CLI', async () => {
    const ctx = await buildClassifyContext(fx.localConfig);
    const builtinName = [...BUILTIN_SKILL_NAMES][0];
    const cls = classifySkill(builtinName, ctx);
    expect(cls.kind).toBe('builtin');
    expect(formatSkillSource(cls)).toBe('[builtin]');
  });

  it('returns [source:<name>] when skill is in a source manifest', async () => {
    const sourcesDir = path.join(fx.homeDir, '.teamai', 'sources', 'partner');
    await fse.ensureDir(sourcesDir);
    await fse.writeJson(path.join(sourcesDir, 'installed.json'), {
      lastPull: '2026-01-01T00:00:00Z',
      installedSkills: ['external-skill'],
    });
    const ctx = await buildClassifyContext(fx.localConfig);
    const cls = classifySkill('external-skill', ctx);
    expect(cls).toEqual({ kind: 'source', name: 'partner' });
    expect(formatSkillSource(cls)).toBe('[source:partner]');
  });

  it('returns [builtin] for the names a pre-stub release deployed, until pull prunes them', async () => {
    const ctx = await buildClassifyContext(fx.localConfig);
    for (const legacy of ['team-wiki-codebase', 'teamai-share-learnings']) {
      expect(classifySkill(legacy, ctx).kind).toBe('builtin');
    }
  });

  it('returns [local-only] when skill is unknown to repo, sources and builtins', async () => {
    const ctx = await buildClassifyContext(fx.localConfig);
    const cls = classifySkill('only-local', ctx);
    expect(cls).toEqual({ kind: 'local-only' });
    expect(formatSkillSource(cls)).toBe('[local-only]');
  });
});

describe('detectInstalledAgents', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(fx.tmpDir);
  });

  it('marks agents installed only when ~/.<id>/ exists', async () => {
    await fse.ensureDir(path.join(fx.homeDir, '.claude'));
    const agents = await detectInstalledAgents(fx.localConfig, fx.teamConfig);
    const claude = agents.find((a) => a.id === 'claude');
    const cursor = agents.find((a) => a.id === 'cursor');
    expect(claude?.installed).toBe(true);
    expect(cursor?.installed).toBe(false);
  });

  it('does NOT create directories for non-installed agents', async () => {
    await detectInstalledAgents(fx.localConfig, fx.teamConfig);
    const cursorDir = path.join(fx.homeDir, '.cursor');
    expect(await fse.pathExists(cursorDir)).toBe(false);
  });

  it('honors team-config skillsPath overrides', () => {
    const custom: TeamaiConfig = {
      ...fx.teamConfig,
      toolPaths: {
        claude: { skills: 'opt/skills' },
      },
    };
    const merged = getEffectiveAgents(custom);
    const claude = merged.find((a) => a.id === 'claude');
    expect(claude?.skillsPath).toBe('opt/skills');
  });
});

describe('scanAgentSkills', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(fx.tmpDir);
  });

  it('skips entries that do not contain SKILL.md', async () => {
    const claudeSkillsDir = path.join(fx.homeDir, '.claude', 'skills');
    await fse.ensureDir(claudeSkillsDir);
    await makeSkill(claudeSkillsDir, 'real-skill', 'desc');
    await fse.ensureDir(path.join(claudeSkillsDir, 'not-a-skill'));
    await fse.writeFile(path.join(claudeSkillsDir, 'not-a-skill', 'README.md'), 'no SKILL.md');

    const ctx = await buildClassifyContext(fx.localConfig);
    const agents = await detectInstalledAgents(fx.localConfig, fx.teamConfig);
    const claude = agents.find((a) => a.id === 'claude')!;
    const view = await scanAgentSkills(claude, ctx);
    const names = view.skills.map((s) => s.name);
    expect(names).toContain('real-skill');
    expect(names).not.toContain('not-a-skill');
  });
});

describe('scanInstalledAgents', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(fx.tmpDir);
  });

  it('returns only installed agents', async () => {
    await fse.ensureDir(path.join(fx.homeDir, '.claude', 'skills'));
    await makeSkill(path.join(fx.homeDir, '.claude', 'skills'), 'foo', 'd');

    const views = await scanInstalledAgents(fx.localConfig, fx.teamConfig);
    const ids = views.map((v) => v.agent.id);
    expect(ids).toContain('claude');
    expect(ids).not.toContain('cursor');
    expect(ids).not.toContain('gemini');
  });

  it('classifies skills correctly across all sources', async () => {
    const claudeDir = path.join(fx.homeDir, '.claude', 'skills');
    await fse.ensureDir(claudeDir);
    // local-only
    await makeSkill(claudeDir, 'my-local', 'l');
    // team
    await makeSkill(path.join(fx.repoPath, 'skills'), 'team-shared', 't');
    await makeSkill(claudeDir, 'team-shared', 't-local');
    // builtin
    const builtinName = [...BUILTIN_SKILL_NAMES][0];
    await makeSkill(claudeDir, builtinName, 'builtin desc');
    // source
    const sourceDir = path.join(fx.homeDir, '.teamai', 'sources', 'partner');
    await fse.ensureDir(sourceDir);
    await fse.writeJson(path.join(sourceDir, 'installed.json'), {
      lastPull: '2026-01-01T00:00:00Z',
      installedSkills: ['external'],
    });
    await makeSkill(claudeDir, 'external', 'ext');

    const views = await scanInstalledAgents(fx.localConfig, fx.teamConfig);
    const claudeView = views.find((v) => v.agent.id === 'claude')!;
    const map = new Map(claudeView.skills.map((s) => [s.name, s.source]));
    expect(map.get('my-local')?.kind).toBe('local-only');
    expect(map.get('team-shared')?.kind).toBe('team');
    expect(map.get(builtinName)?.kind).toBe('builtin');
    expect(map.get('external')?.kind).toBe('source');
  });
});

describe('list command --source / --agent', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(fx.tmpDir);
    vi.doUnmock('../config.js');
    process.exitCode = 0;
  });

  async function runList(type: string | undefined, opts: Record<string, unknown>): Promise<void> {
    vi.doMock('../config.js', () => ({
      autoDetectInit: async () => ({ localConfig: fx.localConfig, teamConfig: fx.teamConfig }),
      loadStateForScope: async () => ({
        lastPush: null,
        lastPull: null,
        lastPullRev: null,
        pushedRules: [],
        pushedSkills: [],
        pushedEnvVars: [],
        lastUpdateCheck: null,
        availableUpdate: null,
      }),
    }));
    const { list } = await import('../status.js');
    await list(type, opts);
  }

  it('errors out when --agent points to a non-installed known agent', async () => {
    await runList('skills', { source: 'local', agent: 'gemini' });
    expect(process.exitCode).toBe(1);
  });

  it('errors out when --agent points to an unknown agent', async () => {
    await runList('skills', { source: 'local', agent: 'totally-unknown-tool' });
    expect(process.exitCode).toBe(1);
  });

  it('rejects --source local when type is not skills', async () => {
    await runList('rules', { source: 'local' });
    expect(process.exitCode).toBe(1);
  });
});
