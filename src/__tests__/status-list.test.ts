import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockAutoDetectInit = vi.fn();

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: vi.fn(async () => ({})),
}));

vi.mock('../utils/git.js', () => ({
  getRepoStatus: vi.fn(async () => ({ ahead: 0, behind: 0, modified: [] })),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
}));

import { list, status } from '../status.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';

function makeTeamConfig(): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://example.com/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: true },
    },
    toolPaths: {
      claude: {
        skills: '.claude/skills',
        rules: '.claude/rules',
        settings: '.claude/settings.json',
        claudemd: '.claude/CLAUDE.md',
        agents: '.claude/agents',
        mcp: '.claude.json',
        mcpProject: '.mcp.json',
      },
    },
  };
}

describe('teamai list / status resource coverage', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetWarnOnce();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-list-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'repo');
    vi.stubEnv('HOME', homeDir);

    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'mcp'));
    await fse.ensureDir(path.join(repoPath, 'hooks'));
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.ensureDir(path.join(repoPath, 'env'));

    await fse.writeFile(
      path.join(repoPath, 'env', 'env.yaml'),
      'variables:\n  - key: SECRET_TOKEN\n    value: super-secret-value\n',
    );
    await fse.writeFile(
      path.join(repoPath, 'mcp', 'mcp.yaml'),
      [
        'servers:',
        '  - name: gpu-analysis',
        '    transport: http',
        '    url: https://example.com/mcp',
      ].join('\n'),
    );
    await fse.writeFile(
      path.join(repoPath, 'hooks', 'hooks.yaml'),
      [
        'hooks:',
        '  - id: marker-hook',
        '    description: e2e marker',
        '    event: Stop',
        '    command: echo hi',
      ].join('\n'),
    );
    await fse.writeFile(path.join(repoPath, 'agents', 'reviewer.md'), '# Reviewer\n');

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/repo.git' },
      username: 'u',
      updatePolicy: 'auto',
      scope: 'user',
      additionalRoles: [],
    };
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig: makeTeamConfig() });

    lines = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    spy.mockRestore();
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('default list includes mcp, agents, hooks and masks env values', async () => {
    await list(undefined, { source: 'repo' });
    const out = lines.join('\n');

    expect(out).toContain('=== REPO MCP ===');
    expect(out).toContain('gpu-analysis  [http]');
    expect(out).toContain('=== REPO AGENTS ===');
    expect(out).toContain('reviewer');
    expect(out).toContain('=== REPO HOOKS ===');
    expect(out).toContain('marker-hook  [Stop]');
    expect(out).toContain('=== REPO ENV ===');
    expect(out).toContain('SECRET_TOKEN=su****');
    expect(out).not.toContain('super-secret-value');
  });

  it('list env --reveal shows plaintext', async () => {
    await list('env', { source: 'repo', reveal: true });
    const out = lines.join('\n');
    expect(out).toContain('SECRET_TOKEN=super-secret-value');
  });

  // #875: a declared secret shows where its value comes from, never the value.
  it('list env shows each declared secret with its state and never its value, --reveal included', async () => {
    await fse.writeFile(
      path.join(repoPath, 'env', 'secrets.yaml'),
      'secrets:\n  - key: GITHUB_TOKEN\n    description: GitHub token\n  - key: GITLAB_TOKEN\n',
    );
    vi.stubEnv('GITHUB_TOKEN', 'fixture-github-value');
    vi.stubEnv('GITLAB_TOKEN', '');

    await list('env', { source: 'repo', reveal: true, verbose: true });
    const out = lines.join('\n');
    expect(out).toContain('SECRET_TOKEN=super-secret-value');
    expect(out).toContain('GITHUB_TOKEN  environment  (root)');
    expect(out).toContain('    GitHub token');
    expect(out).toContain('GITLAB_TOKEN  missing  (root)');
    expect(out).not.toContain('fixture-github-value');
  });

  // #875 (#879 Conflict 13): a key declared twice is listed only as a secret.
  it('list env --reveal leaves out the env.yaml value of a key declared as a secret, and shows a team value as team', async () => {
    await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: SECRET_TOKEN\n');
    const { getTeamSecretsPath, writeSecretStore } = await import('../secret-store.js');
    const { localConfig } = await mockAutoDetectInit() as { localConfig: LocalConfig };
    await writeSecretStore(getTeamSecretsPath(localConfig), { SECRET_TOKEN: { value: 'fixture-team-value' } });

    await list('env', { source: 'repo', reveal: true });
    const out = lines.join('\n');
    expect(out).not.toContain('super-secret-value');
    expect(out).not.toContain('fixture-team-value');
    expect(out).toContain('SECRET_TOKEN  team  (root)');
  });

  // #875: list env is the listing env list prints, so it shows a member's override too.
  it('list env shows the member\'s value of an overridden variable, as team', async () => {
    const { getTeamSecretsPath, writeSecretStore } = await import('../secret-store.js');
    const { localConfig } = await mockAutoDetectInit() as { localConfig: LocalConfig };
    await writeSecretStore(getTeamSecretsPath(localConfig), { SECRET_TOKEN: { value: 'fixture-member-value', kind: 'variable' } });

    await list('env', { source: 'repo', reveal: true });
    const out = lines.join('\n');
    expect(out).toContain('SECRET_TOKEN=fixture-member-value  team  (root)');
    expect(out).not.toContain('super-secret-value');
  });

  it('list env still lists the variables when the secrets file is broken, without their values, and names it', async () => {
    await fse.writeFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secret:\n  - key: GITHUB_TOKEN\n');

    await list('env', { source: 'repo', reveal: true });
    const out = lines.join('\n');
    expect(out).toContain('SECRET_TOKEN  (root)');
    expect(out).not.toContain('super-secret-value');
    expect(out).toContain('env/secrets.yaml declares no secrets');
    expect(out).toContain('Team secrets were not resolved this run');
  });

  it('list rejects unknown types', async () => {
    await list('widgets', { source: 'repo' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unknown resource type'));
  });

  it('status counts include agents, hooks, and mcp', async () => {
    await status({});
    const out = lines.join('\n');
    expect(out).toMatch(/agents:\s*1/);
    expect(out).toMatch(/hooks:\s*1/);
    expect(out).toMatch(/mcp:\s*1/);
  });

  it('names an undelivered MCP entry even when another entry makes resolution fail', async () => {
    localConfig.primaryRole = 'worker';
    await fse.outputFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: worker',
      '    resources:',
      '      knowledge: []',
      '      skills: []',
      '      agents: []',
      '      mcp: [one, two]',
    ].join('\n'));
    await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: hidden',
      '    transport: http',
      '    url: https://example.com/hidden',
      '    role: worker',
    ].join('\n'));
    for (const namespace of ['one', 'two']) {
      await fse.outputFile(path.join(repoPath, 'mcp', namespace, 'mcp.yaml'), [
        'servers:',
        '  - name: duplicate',
        '    transport: http',
        `    url: https://example.com/${namespace}`,
      ].join('\n'));
    }

    vi.mocked(log.warn).mockClear();
    await status({});
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('server "hidden" has unknown key `role:`'));
    expect(lines.join('\n')).toContain('mcp: 0 (cannot be resolved; run `teamai doctor`)');

    resetWarnOnce();
    vi.mocked(log.warn).mockClear();
    lines.length = 0;
    await list('mcp', { source: 'repo' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('server "hidden" has unknown key `role:`'));
    expect(lines.join('\n')).toContain('server "duplicate" is defined in both');
  });

  it('status counts nested rule files', async () => {
    await fse.ensureDir(path.join(repoPath, 'rules', 'common'));
    await fse.writeFile(path.join(repoPath, 'rules', 'common', 'example.md'), '# Rule\n');
    await status({});
    const out = lines.join('\n');
    expect(out).toMatch(/rules:\s*1/);
  });

  it('status counts nested docs and excludes hidden files at every depth', async () => {
    for (const docPath of ['guide.md', 'ai/setup.md', 'ai/reference/api.pdf', '.gitkeep', 'ai/.draft.md', '.private/note.md']) {
      await fse.outputFile(path.join(repoPath, 'docs', docPath), 'Documentation\n');
    }

    await status({});

    expect(lines).toContain('  docs: 3');
  });

  it.each([
    { layout: 'flat', skillPaths: ['review', 'officecli'] },
    { layout: 'namespaced', skillPaths: ['ai/review', 'ai/planning', 'ops/review', 'ops/deploy'] },
    {
      layout: 'mixed with nested modules inside a skill',
      skillPaths: ['ai/log-reader', 'ai/asset-import', 'ai/asset-replacement', 'ai/project-analysis', 'ai/unity-skills', 'ai/skills-setup', 'officecli'],
      nestedModules: ['ai/unity-skills/skills/scene', 'ai/unity-skills/skills/camera'],
    },
    { layout: 'empty', skillPaths: [] },
  ])('status counts skills in a $layout repo instead of top-level directories', async ({ skillPaths, nestedModules = [] }) => {
    for (const skillPath of [...skillPaths, ...nestedModules]) {
      await fse.outputFile(path.join(repoPath, 'skills', skillPath, 'SKILL.md'), '# Skill\n');
    }
    await fse.ensureDir(path.join(repoPath, 'skills', 'empty-namespace'));

    await status({});

    expect(lines).toContain(`  skills: ${skillPaths.length}`);
  });
});
