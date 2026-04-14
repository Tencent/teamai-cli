import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

// Mock external dependencies before importing modules
vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
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
  })),
}));

import { getMemberConfig, listMembers } from '../members.js';
import { requireInit } from '../config.js';
import { log } from '../utils/logger.js';

function mockRequireInit(tmpDir: string, username = 'alice') {
  vi.mocked(requireInit).mockResolvedValue({
    localConfig: {
      repo: { localPath: tmpDir, remote: 'https://git.woa.com/team/repo.git' },
      username,
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    },
    teamConfig: {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/team/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    },
  });
}

describe('getMemberConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-test-'));
    await fse.ensureDir(path.join(tmpDir, 'members'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return null for non-existent member', async () => {
    const result = await getMemberConfig(tmpDir, 'nobody');
    expect(result).toBeNull();
  });

  it('should parse a valid member YAML', async () => {
    const memberData = {
      username: 'alice',
      displayName: 'Alice Chen',
      registeredAt: '2025-01-01T00:00:00.000Z',
    };
    await fse.writeFile(
      path.join(tmpDir, 'members', 'alice.yaml'),
      YAML.stringify(memberData),
    );

    const result = await getMemberConfig(tmpDir, 'alice');
    expect(result).toEqual(memberData);
  });

  it('should default displayName to empty string when omitted', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'minimal.yaml'),
      YAML.stringify({
        username: 'minimal',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );

    const result = await getMemberConfig(tmpDir, 'minimal');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('');
  });

  it('should parse role field from member config', async () => {
    const legacyData = {
      username: 'bob',
      displayName: 'Bob Li',
      registeredAt: '2025-01-01T00:00:00.000Z',
      role: 'write',
    };
    await fse.writeFile(
      path.join(tmpDir, 'members', 'bob.yaml'),
      YAML.stringify(legacyData),
    );

    const result = await getMemberConfig(tmpDir, 'bob');
    expect(result).not.toBeNull();
    expect(result!.username).toBe('bob');
    expect(result!.displayName).toBe('Bob Li');
    // role field should now be parsed
    expect(result!.role).toBe('write');
  });

  it('should return null for invalid YAML content', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'bad.yaml'),
      '{{invalid yaml: [',
    );

    const result = await getMemberConfig(tmpDir, 'bad');
    expect(result).toBeNull();
  });
});

describe('listMembers', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-test-'));
    await fse.ensureDir(path.join(tmpDir, 'members'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    await fse.remove(tmpDir);
  });

  it('should show "No team members registered" when members dir is empty', async () => {
    mockRequireInit(tmpDir);

    await listMembers({});

    expect(log.info).toHaveBeenCalledWith('No team members registered');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('should display members without role tags', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'alice.yaml'),
      YAML.stringify({
        username: 'alice',
        displayName: 'Alice Chen',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    await fse.writeFile(
      path.join(tmpDir, 'members', 'bob.yaml'),
      YAML.stringify({
        username: 'bob',
        displayName: 'Bob Li',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );

    mockRequireInit(tmpDir, 'alice');

    await listMembers({});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).not.toContain('[write]');
    expect(allOutput).not.toContain('[readonly]');
    expect(allOutput).toContain('(you)');
    expect(allOutput).toContain('alice');
    expect(allOutput).toContain('bob');
    expect(allOutput).toContain('Team members (2)');
  });

  it('should mark only the current user with (you)', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'alice.yaml'),
      YAML.stringify({
        username: 'alice',
        displayName: 'Alice',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    await fse.writeFile(
      path.join(tmpDir, 'members', 'bob.yaml'),
      YAML.stringify({
        username: 'bob',
        displayName: 'Bob',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );

    mockRequireInit(tmpDir, 'bob');

    await listMembers({});

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    const aliceLine = calls.find((l) => l.includes('alice'));
    const bobLine = calls.find((l) => l.includes('bob'));
    expect(aliceLine).not.toContain('(you)');
    expect(bobLine).toContain('(you)');
  });

  it('should omit display name separator when displayName is empty', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'nodisplay.yaml'),
      YAML.stringify({
        username: 'nodisplay',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );

    mockRequireInit(tmpDir, 'other');

    await listMembers({});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('nodisplay');
    expect(allOutput).not.toContain('—');
  });

  it('should show registeredAt in verbose mode', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'alice.yaml'),
      YAML.stringify({
        username: 'alice',
        displayName: 'Alice',
        registeredAt: '2025-06-15T10:30:00.000Z',
      }),
    );

    mockRequireInit(tmpDir, 'alice');

    await listMembers({ verbose: true });

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('registered: 2025-06-15T10:30:00.000Z');
  });

  it('should not show registeredAt in non-verbose mode', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'alice.yaml'),
      YAML.stringify({
        username: 'alice',
        displayName: 'Alice',
        registeredAt: '2025-06-15T10:30:00.000Z',
      }),
    );

    mockRequireInit(tmpDir, 'alice');

    await listMembers({});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).not.toContain('registered:');
  });

  it('should warn on invalid member YAML files', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'broken.yaml'),
      '{{broken yaml [[[',
    );

    mockRequireInit(tmpDir, 'other');

    await listMembers({});

    expect(log.warn).toHaveBeenCalledWith('Invalid member file: broken.yaml');
  });

  it('should handle legacy YAML with extra role field gracefully', async () => {
    await fse.writeFile(
      path.join(tmpDir, 'members', 'legacy.yaml'),
      YAML.stringify({
        username: 'legacy',
        displayName: 'Legacy User',
        registeredAt: '2025-01-01T00:00:00.000Z',
        role: 'readonly',
      }),
    );

    mockRequireInit(tmpDir, 'other');

    await listMembers({});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).not.toContain('[readonly]');
    expect(allOutput).toContain('legacy');
  });
});
