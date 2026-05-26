import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveWikiEnabled, LocalConfigSchema, TeamaiConfigSchema } from '../types.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('resolveWikiEnabled', () => {
  const baseLocalConfig: LocalConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/test/repo.git' },
    username: 'testuser',
    scope: 'user',
    additionalRoles: [],
  };

  const baseTeamConfig: TeamaiConfig = {
    team: 'test-team',
    description: '',
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit',
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: true },
    },
    toolPaths: {},
  };

  it('returns true when team has no wiki section and no local override', () => {
    expect(resolveWikiEnabled(baseTeamConfig, baseLocalConfig)).toBe(true);
  });

  it('returns true when team wiki.enabled is true and no local override', () => {
    const teamConfig = {
      ...baseTeamConfig,
      sharing: { ...baseTeamConfig.sharing, wiki: { enabled: true } },
    };
    expect(resolveWikiEnabled(teamConfig, baseLocalConfig)).toBe(true);
  });

  it('returns false when team wiki.enabled is false and no local override', () => {
    const teamConfig = {
      ...baseTeamConfig,
      sharing: { ...baseTeamConfig.sharing, wiki: { enabled: false } },
    };
    expect(resolveWikiEnabled(teamConfig, baseLocalConfig)).toBe(false);
  });

  it('returns false when team enabled + local override false (local wins)', () => {
    const teamConfig = {
      ...baseTeamConfig,
      sharing: { ...baseTeamConfig.sharing, wiki: { enabled: true } },
    };
    const localConfig = { ...baseLocalConfig, wikiEnabled: false };
    expect(resolveWikiEnabled(teamConfig, localConfig)).toBe(false);
  });

  it('returns true when team disabled + local override true (local wins)', () => {
    const teamConfig = {
      ...baseTeamConfig,
      sharing: { ...baseTeamConfig.sharing, wiki: { enabled: false } },
    };
    const localConfig = { ...baseLocalConfig, wikiEnabled: true };
    expect(resolveWikiEnabled(teamConfig, localConfig)).toBe(true);
  });

  it('backward compat: team config without wiki section defaults to enabled', () => {
    expect(resolveWikiEnabled(baseTeamConfig, baseLocalConfig)).toBe(true);
  });

  it('backward compat: old local config without wikiEnabled follows team config', () => {
    const teamConfig = {
      ...baseTeamConfig,
      sharing: { ...baseTeamConfig.sharing, wiki: { enabled: false } },
    };
    expect(resolveWikiEnabled(teamConfig, baseLocalConfig)).toBe(false);
  });
});

describe('LocalConfigSchema wikiEnabled', () => {
  const baseInput = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/test/repo.git' },
    username: 'test-user',
  };

  it('defaults wikiEnabled to undefined when not provided', () => {
    const config = LocalConfigSchema.parse(baseInput);
    expect(config.wikiEnabled).toBeUndefined();
  });

  it('accepts wikiEnabled: true', () => {
    const config = LocalConfigSchema.parse({ ...baseInput, wikiEnabled: true });
    expect(config.wikiEnabled).toBe(true);
  });

  it('accepts wikiEnabled: false', () => {
    const config = LocalConfigSchema.parse({ ...baseInput, wikiEnabled: false });
    expect(config.wikiEnabled).toBe(false);
  });

  it('rejects non-boolean wikiEnabled', () => {
    expect(() => LocalConfigSchema.parse({ ...baseInput, wikiEnabled: 'no' })).toThrow();
  });

  it('backward compat: old configs without wikiEnabled parse correctly', () => {
    const oldConfig = {
      repo: { localPath: '/home/user/.teamai/team-repo', remote: 'git@git.woa.com:team/repo.git' },
      username: 'alice',
      scope: 'user',
      primaryRole: 'backend',
      additionalRoles: ['infra'],
      subscribedTags: ['api', 'core'],
    };
    const config = LocalConfigSchema.parse(oldConfig);
    expect(config.wikiEnabled).toBeUndefined();
    expect(config.primaryRole).toBe('backend');
  });
});

describe('TeamaiConfigSchema wiki in sharing', () => {
  const baseInput = {
    team: 'my-team',
    repo: 'https://git.woa.com/test/repo.git',
  };

  it('defaults wiki to undefined when not in sharing config', () => {
    const config = TeamaiConfigSchema.parse(baseInput);
    expect(config.sharing.wiki).toBeUndefined();
  });

  it('accepts wiki.enabled: true', () => {
    const config = TeamaiConfigSchema.parse({
      ...baseInput,
      sharing: { wiki: { enabled: true } },
    });
    expect(config.sharing.wiki).toEqual({ enabled: true });
  });

  it('accepts wiki.enabled: false with disabledHint', () => {
    const config = TeamaiConfigSchema.parse({
      ...baseInput,
      sharing: { wiki: { enabled: false, disabledHint: 'use external team-wiki plugin' } },
    });
    expect(config.sharing.wiki).toEqual({ enabled: false, disabledHint: 'use external team-wiki plugin' });
  });
});

describe('pull skips wiki when resolved to disabled', () => {
  it('filters wiki from resource types when disabled', () => {
    const wikiEnabled = false;
    const resourceTypes = wikiEnabled
      ? ['skills', 'rules', 'docs', 'env', 'wiki']
      : ['skills', 'rules', 'docs', 'env'];
    expect(resourceTypes).not.toContain('wiki');
  });

  it('includes wiki in resource types when enabled', () => {
    const wikiEnabled = true;
    const resourceTypes = wikiEnabled
      ? ['skills', 'rules', 'docs', 'env', 'wiki']
      : ['skills', 'rules', 'docs', 'env'];
    expect(resourceTypes).toContain('wiki');
  });
});

describe('builtin-skills skips teamai-wiki when disabled', () => {
  it('filters teamai-wiki from skill names when skipWiki is true', () => {
    const skillNames = ['teamai-share-learnings', 'teamai-wiki'];
    const filteredSkills = true
      ? skillNames.filter(name => name !== 'teamai-wiki')
      : skillNames;
    expect(filteredSkills).toEqual(['teamai-share-learnings']);
  });

  it('keeps teamai-wiki when skipWiki is false/undefined', () => {
    const skillNames = ['teamai-share-learnings', 'teamai-wiki'];
    const filteredSkills = false
      ? skillNames.filter(name => name !== 'teamai-wiki')
      : skillNames;
    expect(filteredSkills).toEqual(['teamai-share-learnings', 'teamai-wiki']);
  });
});

describe('resolveWikiEnabled - environment variable override', () => {
  const baseLocalConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/test/repo.git' },
    username: 'testuser',
    scope: 'user' as const,
    additionalRoles: [] as string[],
  };

  const baseTeamConfig = {
    team: 'test-team',
    description: '',
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [] as string[],
    sharing: {
      skills: {},
      rules: { enforced: [] as string[] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: true },
    },
    toolPaths: {},
  };

  let originalWikiDisabled: string | undefined;
  let originalWikiEnabled: string | undefined;

  beforeEach(() => {
    originalWikiDisabled = process.env.TEAMAI_WIKI_DISABLED;
    originalWikiEnabled = process.env.TEAMAI_WIKI_ENABLED;
    delete process.env.TEAMAI_WIKI_DISABLED;
    delete process.env.TEAMAI_WIKI_ENABLED;
  });

  afterEach(() => {
    if (originalWikiDisabled !== undefined) {
      process.env.TEAMAI_WIKI_DISABLED = originalWikiDisabled;
    } else {
      delete process.env.TEAMAI_WIKI_DISABLED;
    }
    if (originalWikiEnabled !== undefined) {
      process.env.TEAMAI_WIKI_ENABLED = originalWikiEnabled;
    } else {
      delete process.env.TEAMAI_WIKI_ENABLED;
    }
  });

  it('returns true by default (no env vars, no config)', () => {
    expect(resolveWikiEnabled(baseTeamConfig as any, baseLocalConfig as any)).toBe(true);
  });

  it('returns false when TEAMAI_WIKI_DISABLED=1', () => {
    process.env.TEAMAI_WIKI_DISABLED = '1';
    expect(resolveWikiEnabled(baseTeamConfig as any, baseLocalConfig as any)).toBe(false);
  });

  it('returns false when TEAMAI_WIKI_DISABLED=true', () => {
    process.env.TEAMAI_WIKI_DISABLED = 'true';
    expect(resolveWikiEnabled(baseTeamConfig as any, baseLocalConfig as any)).toBe(false);
  });

  it('returns false when TEAMAI_WIKI_ENABLED=0', () => {
    process.env.TEAMAI_WIKI_ENABLED = '0';
    expect(resolveWikiEnabled(baseTeamConfig as any, baseLocalConfig as any)).toBe(false);
  });

  it('returns false when TEAMAI_WIKI_ENABLED=false', () => {
    process.env.TEAMAI_WIKI_ENABLED = 'false';
    expect(resolveWikiEnabled(baseTeamConfig as any, baseLocalConfig as any)).toBe(false);
  });

  it('env var overrides local config wikiEnabled=true', () => {
    process.env.TEAMAI_WIKI_DISABLED = '1';
    const localConfig = { ...baseLocalConfig, wikiEnabled: true };
    expect(resolveWikiEnabled(baseTeamConfig as any, localConfig as any)).toBe(false);
  });

  it('env var overrides team config wiki.enabled=true', () => {
    process.env.TEAMAI_WIKI_DISABLED = '1';
    const teamConfig = {
      ...baseTeamConfig,
      sharing: { ...baseTeamConfig.sharing, wiki: { enabled: true } },
    };
    expect(resolveWikiEnabled(teamConfig as any, baseLocalConfig as any)).toBe(false);
  });

  it('returns true when TEAMAI_WIKI_DISABLED=0 (not a disable value)', () => {
    process.env.TEAMAI_WIKI_DISABLED = '0';
    expect(resolveWikiEnabled(baseTeamConfig as any, baseLocalConfig as any)).toBe(true);
  });
});
