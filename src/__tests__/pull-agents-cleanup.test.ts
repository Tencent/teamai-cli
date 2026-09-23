import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
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
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

const ROLES_YAML = `
version: 1
roles:
  - id: frontend
    description: Frontend
    resources:
      knowledge: [common]
      skills: [common]
      agents: [common, frontend]
  - id: devops
    description: DevOps
    resources:
      knowledge: [common]
      skills: [common]
      agents: [common, devops]
`;

const VR_YAML = 'name: vr-reviewer\ndescription: Reviews visual regressions\ninstructions: |\n  Compare screenshots.\n';
const TF_YAML = 'name: tf-reviewer\ndescription: Reviews terraform plans\ninstructions: |\n  Read the plan.\n';

describe('pull agents cleanup after role change', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  function configFor(role: string): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: role,
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-agents-cleanup-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), ROLES_YAML);
    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.ensureDir(path.join(repoPath, 'agents', 'common'));
    await fse.ensureDir(path.join(repoPath, 'agents', 'frontend'));
    await fse.ensureDir(path.join(repoPath, 'agents', 'devops'));
    await fse.writeFile(path.join(repoPath, 'agents', 'shared.md'), '# shared helper\n');
    await fse.writeFile(path.join(repoPath, 'agents', 'frontend', 'vr-reviewer.yaml'), VR_YAML);
    await fse.writeFile(path.join(repoPath, 'agents', 'devops', 'tf-reviewer.yaml'), TF_YAML);

    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents' },
        codex: { skills: '.codex/skills', rules: '.codex/rules', agents: '.codex/agents' },
      },
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor('frontend'));
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it.each([false, true])('cleans same-stem agents per target while preserving local edits: %s', async (edited) => {
    await fse.outputFile(path.join(repoPath, 'agents/frontend/reviewer.yaml'), 'name: reviewer\ndescription: Old\ninstructions: Review old.\ntargets: [claude]\n');
    await fse.outputFile(path.join(repoPath, 'agents/devops/reviewer.yaml'), 'name: reviewer\ndescription: New\ninstructions: Review new.\ntargets: [codex]\n');
    await pull({});
    const oldCopy = path.join(homeDir, '.claude/agents/reviewer.md');
    expect(await fse.pathExists(oldCopy)).toBe(true);
    if (edited) await fse.appendFile(oldCopy, '\nLocal edit.\n');
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor('devops'));
    await pull({});
    expect(await fse.pathExists(oldCopy)).toBe(edited);
    expect(await fse.readFile(path.join(homeDir, '.codex/agents/reviewer.toml'), 'utf8')).toContain('Review new.');
  });

  it('removes an old Codex render when the active same-stem source is legacy Markdown', async () => {
    await fse.outputFile(path.join(repoPath, 'agents/frontend/reviewer.yaml'), 'name: reviewer\ndescription: Old\ninstructions: Review old.\n');
    await fse.outputFile(path.join(repoPath, 'agents/devops/reviewer.md'), '# Active legacy agent\n');
    await pull({});
    const codexCopy = path.join(homeDir, '.codex/agents/reviewer.toml');
    expect(await fse.pathExists(codexCopy)).toBe(true);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor('devops'));
    await pull({});
    expect(await fse.pathExists(codexCopy)).toBe(false);
    expect(await fse.readFile(path.join(homeDir, '.claude/agents/reviewer.md'), 'utf8')).toBe('# Active legacy agent\n');
  });

  it('removes agents of a namespace that stops being active and keeps root agents', async () => {
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'shared.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'vr-reviewer.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codex/agents', 'vr-reviewer.toml'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'tf-reviewer.md'))).toBe(false);

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor('devops'));
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'shared.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'tf-reviewer.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codex/agents', 'tf-reviewer.toml'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'vr-reviewer.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/agents', 'vr-reviewer.toml'))).toBe(false);
  });

  it('keeps a locally edited copy of a revoked agent and warns', async () => {
    await pull({});

    const edited = path.join(homeDir, '.claude/agents', 'vr-reviewer.md');
    await fse.appendFile(edited, '\nMy local tweak.\n');

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor('devops'));
    await pull({});

    expect(await fse.pathExists(edited)).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codex/agents', 'vr-reviewer.toml'))).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.some(([msg]) => /Kept agent "vr-reviewer"/.test(String(msg)))).toBe(true);
  });

  it('never touches built-in or hand-added agents', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'teamai-recall.md'), '# builtin placeholder\n');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'my-own.md'), '# mine\n');

    await pull({});
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor('devops'));
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'my-own.md'))).toBe(true);
  });
});
