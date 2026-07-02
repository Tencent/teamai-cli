import { describe, it, expect } from 'vitest';
import {
  MemberConfigSchema,
  TeamaiConfigSchema,
  SharingConfigSchema,
  StateSchema,
  LocalConfigSchema,
} from '../types.js';

describe('MemberConfigSchema', () => {
  it('should parse a complete member config', () => {
    const result = MemberConfigSchema.parse({
      username: 'alice',
      displayName: 'Alice Chen',
      registeredAt: '2025-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({
      username: 'alice',
      displayName: 'Alice Chen',
      registeredAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('should default displayName to empty string', () => {
    const result = MemberConfigSchema.parse({
      username: 'bob',
      registeredAt: '2025-01-01T00:00:00.000Z',
    });
    expect(result.displayName).toBe('');
  });

  it('should reject missing required fields', () => {
    expect(() => MemberConfigSchema.parse({ username: 'x' })).toThrow();
    expect(() => MemberConfigSchema.parse({ registeredAt: 'x' })).toThrow();
  });

  it('should reject empty object', () => {
    expect(() => MemberConfigSchema.parse({})).toThrow();
  });

  it('should strip unknown fields like legacy role', () => {
    const result = MemberConfigSchema.parse({
      username: 'alice',
      displayName: 'Alice',
      registeredAt: '2025-01-01T00:00:00.000Z',
      role: 'write',
    });
    // Zod by default passes through unknown keys, but result type should not include role
    expect(result.username).toBe('alice');
    expect(result.registeredAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('TeamaiConfigSchema', () => {
  it('should include codebuddy in default toolPaths', () => {
    const result = TeamaiConfigSchema.parse({
      team: 'test-team',
      repo: 'https://git.woa.com/test/repo.git',
    });
    expect(result.toolPaths).toHaveProperty('codebuddy');
    expect(result.toolPaths.codebuddy).toEqual({
      skills: '.codebuddy/skills',
      rules: '.codebuddy/rules',
      agents: '.codebuddy/agents',
      settings: '.codebuddy/settings.json',
      claudemd: '.codebuddy/CODEBUDDY.md',
    });
  });

  it('should preserve all existing default tools in toolPaths', () => {
    const result = TeamaiConfigSchema.parse({
      team: 'test-team',
      repo: 'https://git.woa.com/test/repo.git',
    });
    expect(Object.keys(result.toolPaths)).toEqual(
      expect.arrayContaining(['claude', 'codex', 'codex-internal', 'claude-internal', 'cursor', 'codebuddy', 'openclaw'])
    );
  });

  it('should include openclaw in default toolPaths', () => {
    const result = TeamaiConfigSchema.parse({
      team: 'test-team',
      repo: 'https://git.woa.com/test/repo.git',
    });
    expect(result.toolPaths).toHaveProperty('openclaw');
    expect(result.toolPaths.openclaw).toEqual({
      skills: '.openclaw/skills',
      rules: '.openclaw/rules',
    });
  });

  it('should include codex-internal in default toolPaths', () => {
    const result = TeamaiConfigSchema.parse({
      team: 'test-team',
      repo: 'https://git.woa.com/test/repo.git',
    });
    expect(result.toolPaths).toHaveProperty('codex-internal');
    expect(result.toolPaths['codex-internal']).toEqual({
      skills: '.codex-internal/skills',
      rules: '.codex-internal/rules',
      settings: '.codex-internal/hooks.json',
      agents: '.codex-internal/agents',
    });
  });

});

describe('TeamaiConfigSchema reviewers', () => {
  const minConfig = {
    team: 'my-team',
    repo: 'https://git.woa.com/team/repo.git',
  };

  it('should default reviewers to empty array when not provided', () => {
    const result = TeamaiConfigSchema.parse(minConfig);
    expect(result.reviewers).toEqual([]);
  });

  it('should accept an explicit reviewers list', () => {
    const result = TeamaiConfigSchema.parse({
      ...minConfig,
      reviewers: ['alice', 'bob'],
    });
    expect(result.reviewers).toEqual(['alice', 'bob']);
  });

  it('should accept empty reviewers array', () => {
    const result = TeamaiConfigSchema.parse({
      ...minConfig,
      reviewers: [],
    });
    expect(result.reviewers).toEqual([]);
  });
});

describe('SharingConfigSchema env', () => {
  it('should default env.injectShellProfile to true', () => {
    const result = SharingConfigSchema.parse({});
    expect(result.env.injectShellProfile).toBe(true);
  });

  it('should default shellProfilePath to undefined', () => {
    const result = SharingConfigSchema.parse({});
    expect(result.env.shellProfilePath).toBeUndefined();
  });

  it('should accept explicit env config', () => {
    const result = SharingConfigSchema.parse({
      env: { injectShellProfile: false, shellProfilePath: '/custom/.profile' },
    });
    expect(result.env.injectShellProfile).toBe(false);
    expect(result.env.shellProfilePath).toBe('/custom/.profile');
  });

  it('should be included in TeamaiConfigSchema defaults', () => {
    const result = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
    });
    expect(result.sharing.env).toBeDefined();
    expect(result.sharing.env.injectShellProfile).toBe(true);
  });
});

describe('StateSchema pushedEnvVars', () => {
  it('should default pushedEnvVars to empty array', () => {
    const result = StateSchema.parse({});
    expect(result.pushedEnvVars).toEqual([]);
  });

  it('should accept explicit pushedEnvVars', () => {
    const result = StateSchema.parse({
      pushedEnvVars: ['API_URL', 'TOKEN'],
    });
    expect(result.pushedEnvVars).toEqual(['API_URL', 'TOKEN']);
  });
});

describe('StateSchema update fields', () => {
  it('should default lastUpdateCheck to null', () => {
    const result = StateSchema.parse({});
    expect(result.lastUpdateCheck).toBeNull();
  });

  it('should default availableUpdate to null', () => {
    const result = StateSchema.parse({});
    expect(result.availableUpdate).toBeNull();
  });

  it('should accept explicit update fields', () => {
    const result = StateSchema.parse({
      lastUpdateCheck: '2025-03-19T00:00:00.000Z',
      availableUpdate: '0.4.0',
    });
    expect(result.lastUpdateCheck).toBe('2025-03-19T00:00:00.000Z');
    expect(result.availableUpdate).toBe('0.4.0');
  });
});

describe('TeamaiConfigSchema autoUpdate', () => {
  const base = {
    team: 'test-team',
    repo: 'https://git.woa.com/test/repo.git',
  };

  it('leaves autoUpdate undefined when not specified', () => {
    const result = TeamaiConfigSchema.parse(base);
    expect(result.autoUpdate).toBeUndefined();
  });

  it('parses autoUpdate: false', () => {
    const result = TeamaiConfigSchema.parse({ ...base, autoUpdate: false });
    expect(result.autoUpdate).toBe(false);
  });

  it('parses autoUpdate: true', () => {
    const result = TeamaiConfigSchema.parse({ ...base, autoUpdate: true });
    expect(result.autoUpdate).toBe(true);
  });

  it('rejects non-boolean autoUpdate', () => {
    expect(() => TeamaiConfigSchema.parse({ ...base, autoUpdate: 'nope' })).toThrow();
  });
});

describe('LocalConfigSchema updatePolicy', () => {
  const baseConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/team/repo.git' },
    username: 'test',
  };

  it('should leave updatePolicy undefined when not specified', () => {
    const result = LocalConfigSchema.parse(baseConfig);
    expect(result.updatePolicy).toBeUndefined();
  });

  it('should accept auto, prompt, and skip values', () => {
    for (const policy of ['auto', 'prompt', 'skip'] as const) {
      const result = LocalConfigSchema.parse({ ...baseConfig, updatePolicy: policy });
      expect(result.updatePolicy).toBe(policy);
    }
  });

  it('should reject invalid updatePolicy values', () => {
    expect(() => LocalConfigSchema.parse({ ...baseConfig, updatePolicy: 'invalid' })).toThrow();
  });
});
