import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockAutoDetectInit = vi.fn();

vi.mock('../config.js', () => ({
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
  },
}));

import { list, status } from '../status.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

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
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
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

    const localConfig: LocalConfig = {
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
});
