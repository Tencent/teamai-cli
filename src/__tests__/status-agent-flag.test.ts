import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy dependencies before importing the module under test
vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn().mockResolvedValue({
    localConfig: { repo: { localPath: '/tmp/fake-repo' } },
    teamConfig: {},
  }),
  loadStateForScope: vi.fn().mockResolvedValue({}),
}));

vi.mock('../known-agents.js', () => ({
  detectInstalledAgents: vi.fn().mockResolvedValue([]),
  filterAgents: vi.fn().mockReturnValue([]),
}));

vi.mock('../utils/git.js', () => ({ getRepoStatus: vi.fn().mockResolvedValue({}) }));
vi.mock('../resources/index.js', () => ({ getAllHandlers: vi.fn().mockReturnValue([]) }));
vi.mock('../agent-skills.js', () => ({
  buildClassifyContext: vi.fn().mockReturnValue({}),
  classifySkill: vi.fn().mockReturnValue('local'),
  formatSkillSource: vi.fn().mockReturnValue(''),
  scanAgentSkills: vi.fn().mockResolvedValue([]),
  truncate: vi.fn((s: string) => s),
}));

import { list } from '../status.js';

describe('list() --agent flag path-safety validation', () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.clearAllMocks();
  });

  it('rejects --agent with path traversal (../foo) and sets exitCode=2', async () => {
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await list('skills', { agent: '../foo' });
    expect(process.exitCode).toBe(2);
    errorSpy.mockRestore();
  });

  it('rejects empty --agent string and sets exitCode=2', async () => {
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await list('skills', { agent: '' });
    expect(process.exitCode).toBe(2);
    errorSpy.mockRestore();
  });

  it('allows valid --agent "claude" and proceeds past validation', async () => {
    // With mocked downstream, the call should NOT set exitCode=2 for a valid agent name.
    await list('skills', { agent: 'claude' });
    expect(process.exitCode).not.toBe(2);
  });
});
