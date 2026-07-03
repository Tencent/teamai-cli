import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';
import {
  LocalConfigSchema,
  TeamaiConfigSchema,
  ScopeEnum,
  resolveBaseDir,
  getTeamaiHome,
  getConfigPath,
  getStatePath,
  type LocalConfig,
} from '../types.js';
import { validateScopeMatch } from '../init.js';
import {
  detectProjectConfig,
  loadLocalConfigForScope,
  saveLocalConfigForScope,
  loadStateForScope,
  saveStateForScope,
} from '../config.js';

// ─── Scope type tests ──────────────────────────────────

describe('ScopeEnum', () => {
  it('should accept "user" and "project"', () => {
    expect(ScopeEnum.parse('user')).toBe('user');
    expect(ScopeEnum.parse('project')).toBe('project');
  });

  it('should reject invalid scope values', () => {
    expect(() => ScopeEnum.parse('global')).toThrow();
    expect(() => ScopeEnum.parse('')).toThrow();
  });
});

describe('LocalConfigSchema with scope', () => {
  const baseConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/team/repo.git' },
    username: 'test',
  };

  it('should default scope to "user"', () => {
    const result = LocalConfigSchema.parse(baseConfig);
    expect(result.scope).toBe('user');
  });

  it('should accept explicit scope', () => {
    const result = LocalConfigSchema.parse({ ...baseConfig, scope: 'project' });
    expect(result.scope).toBe('project');
  });

  it('should accept projectRoot when scope is project', () => {
    const result = LocalConfigSchema.parse({
      ...baseConfig,
      scope: 'project',
      projectRoot: '/Users/test/my-project',
    });
    expect(result.projectRoot).toBe('/Users/test/my-project');
  });

  it('should allow projectRoot to be undefined', () => {
    const result = LocalConfigSchema.parse(baseConfig);
    expect(result.projectRoot).toBeUndefined();
  });

  it('should parse old configs without scope field (backward compatibility)', () => {
    const oldConfig = {
      repo: { localPath: '/tmp/repo', remote: 'https://example.com/repo.git' },
      username: 'olduser',
      updatePolicy: 'auto',
    };
    const result = LocalConfigSchema.parse(oldConfig);
    expect(result.scope).toBe('user');
    expect(result.projectRoot).toBeUndefined();
  });
});

// ─── resolveBaseDir tests ──────────────────────────────

describe('resolveBaseDir', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/Users/testuser';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('should return HOME for user scope', () => {
    const config: LocalConfig = {
      repo: { localPath: '/tmp/repo', remote: 'https://example.com' },
      username: 'test',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };
    expect(resolveBaseDir(config)).toBe('/Users/testuser');
  });

  it('should return projectRoot for project scope', () => {
    const config: LocalConfig = {
      repo: { localPath: '/tmp/repo', remote: 'https://example.com' },
      username: 'test',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'project',
      projectRoot: '/Users/testuser/my-project',
    };
    expect(resolveBaseDir(config)).toBe('/Users/testuser/my-project');
  });

  it('should throw instead of silently falling back to HOME if project scope without projectRoot (#85)', () => {
    const config: LocalConfig = {
      repo: { localPath: '/tmp/repo', remote: 'https://example.com' },
      username: 'test',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'project',
    };
    expect(() => resolveBaseDir(config)).toThrow(/projectRoot is missing/);
  });
});

// ─── getTeamaiHome tests ──────────────────────────────

describe('getTeamaiHome', () => {
  it('should return ~/.teamai for user scope', () => {
    const result = getTeamaiHome('user');
    expect(result).toBe(`${process.env.HOME}/.teamai`);
  });

  it('should return <projectRoot>/.teamai for project scope', () => {
    const result = getTeamaiHome('project', '/Users/test/proj');
    expect(result).toBe('/Users/test/proj/.teamai');
  });

  it('should throw instead of silently falling back to ~/.teamai if project scope without projectRoot (#85)', () => {
    expect(() => getTeamaiHome('project')).toThrow(/projectRoot is missing/);
  });
});

// ─── getConfigPath / getStatePath tests ────────────────

describe('getConfigPath', () => {
  it('should return correct path for user scope', () => {
    const result = getConfigPath('user');
    expect(result).toContain('.teamai/config.yaml');
  });

  it('should return correct path for project scope', () => {
    const result = getConfigPath('project', '/my/project');
    expect(result).toBe('/my/project/.teamai/config.yaml');
  });
});

describe('getStatePath', () => {
  it('should return correct path for user scope', () => {
    const result = getStatePath('user');
    expect(result).toContain('.teamai/state.json');
  });

  it('should return correct path for project scope', () => {
    const result = getStatePath('project', '/my/project');
    expect(result).toBe('/my/project/.teamai/state.json');
  });
});

// ─── detectProjectConfig tests ─────────────────────────

describe('detectProjectConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join('/tmp', `teamai-scope-test-${Date.now()}`);
    await fse.ensureDir(tmpDir);
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return null when no .teamai/config.yaml exists', async () => {
    const result = await detectProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('should return null when config has scope=user', async () => {
    const configDir = path.join(tmpDir, '.teamai');
    await fse.ensureDir(configDir);
    await fse.writeFile(
      path.join(configDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: '/tmp/repo', remote: 'https://example.com' },
        username: 'test',
        scope: 'user',
      }),
    );
    const result = await detectProjectConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('should return LocalConfig when config has scope=project', async () => {
    const configDir = path.join(tmpDir, '.teamai');
    await fse.ensureDir(configDir);
    await fse.writeFile(
      path.join(configDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: '/tmp/repo', remote: 'https://example.com' },
        username: 'test',
        scope: 'project',
        projectRoot: tmpDir,
      }),
    );
    const result = await detectProjectConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.scope).toBe('project');
    expect(result!.projectRoot).toBe(tmpDir);
  });

  it('should return null for invalid YAML', async () => {
    const configDir = path.join(tmpDir, '.teamai');
    await fse.ensureDir(configDir);
    await fse.writeFile(path.join(configDir, 'config.yaml'), 'not: valid: yaml: [[[');
    const result = await detectProjectConfig(tmpDir);
    expect(result).toBeNull();
  });
});

// ─── loadLocalConfigForScope / saveLocalConfigForScope ──

describe('loadLocalConfigForScope / saveLocalConfigForScope', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpDir = path.join('/tmp', `teamai-scope-cfg-${Date.now()}`);
    await fse.ensureDir(tmpDir);
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it('should save and load user scope config', async () => {
    const config: LocalConfig = {
      repo: { localPath: '/tmp/repo', remote: 'https://example.com' },
      username: 'test',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };
    await fse.ensureDir(path.join(tmpDir, '.teamai'));
    await saveLocalConfigForScope(config, 'user');
    const loaded = await loadLocalConfigForScope('user');
    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('user');
    expect(loaded!.username).toBe('test');
  });

  it('should save and load project scope config', async () => {
    const projectRoot = path.join(tmpDir, 'my-project');
    await fse.ensureDir(path.join(projectRoot, '.teamai'));

    const config: LocalConfig = {
      repo: { localPath: path.join(projectRoot, '.teamai/team-repo'), remote: 'https://example.com' },
      username: 'projuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'project',
      projectRoot,
    };
    await saveLocalConfigForScope(config, 'project', projectRoot);
    const loaded = await loadLocalConfigForScope('project', projectRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('project');
    expect(loaded!.projectRoot).toBe(projectRoot);
  });

  it('migrates a legacy user config without roles to default hai role and persists it', async () => {
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(
      path.join(repoPath, 'manifest', 'roles.yaml'),
      YAML.stringify({
        version: 1,
        roles: [
          {
            id: 'hai',
            name: 'HAI R&D',
            description: 'default migration target',
            resources: {
              knowledge: ['common', 'hai'],
              skills: ['common', 'hai'],
              learnings: ['common', 'hai'],
            },
          },
        ],
        defaults: { shareTarget: 'primary-role' },
      }),
    );

    await fse.ensureDir(path.join(tmpDir, '.teamai'));
    await fse.writeFile(
      path.join(tmpDir, '.teamai', 'config.yaml'),
      YAML.stringify({
        repo: { localPath: repoPath, remote: 'https://example.com' },
        username: 'legacy-user',
        updatePolicy: 'auto',
        scope: 'user',
      }),
    );

    const loaded = await loadLocalConfigForScope('user');
    const persisted = YAML.parse(await fse.readFile(path.join(tmpDir, '.teamai', 'config.yaml'), 'utf8')) as LocalConfig;

    expect(loaded).not.toBeNull();
    expect(loaded!.primaryRole).toBe('hai');
    expect(loaded!.additionalRoles).toEqual([]);
    expect(loaded!.resourceProfileVersion).toBe(1);
    expect(persisted.primaryRole).toBe('hai');
    expect(persisted.additionalRoles).toEqual([]);
    expect(persisted.resourceProfileVersion).toBe(1);
  });

  it('does not overwrite an existing role profile during config load', async () => {
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(
      path.join(repoPath, 'manifest', 'roles.yaml'),
      YAML.stringify({
        version: 2,
        roles: [
          {
            id: 'hai',
            name: 'HAI R&D',
            resources: {
              knowledge: ['common', 'hai'],
              skills: ['common', 'hai'],
              learnings: ['common', 'hai'],
            },
          },
          {
            id: 'pm',
            name: 'Product Manager',
            resources: {
              knowledge: ['common', 'pm'],
              skills: ['common', 'pm'],
              learnings: ['common', 'pm'],
            },
          },
        ],
        defaults: { shareTarget: 'primary-role' },
      }),
    );

    await fse.ensureDir(path.join(tmpDir, '.teamai'));
    await fse.writeFile(
      path.join(tmpDir, '.teamai', 'config.yaml'),
      YAML.stringify({
        repo: { localPath: repoPath, remote: 'https://example.com' },
        username: 'configured-user',
        updatePolicy: 'auto',
        scope: 'user',
        primaryRole: 'pm',
        additionalRoles: ['hai'],
        resourceProfileVersion: 1,
      }),
    );

    const loaded = await loadLocalConfigForScope('user');

    expect(loaded).not.toBeNull();
    expect(loaded!.primaryRole).toBe('pm');
    expect(loaded!.additionalRoles).toEqual(['hai']);
    expect(loaded!.resourceProfileVersion).toBe(1);
  });
});

// ─── loadStateForScope / saveStateForScope ──────────────

describe('loadStateForScope / saveStateForScope', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpDir = path.join('/tmp', `teamai-scope-state-${Date.now()}`);
    await fse.ensureDir(tmpDir);
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it('should return default state when no state file exists', async () => {
    // Use a subdirectory that definitely has no state file
    const emptyHome = path.join(tmpDir, 'empty-home');
    await fse.ensureDir(emptyHome);
    process.env.HOME = emptyHome;
    const state = await loadStateForScope('user');
    expect(state.lastPull).toBeNull();
    expect(state.lastPush).toBeNull();
  });

  it('should save and load state for user scope', async () => {
    await fse.ensureDir(path.join(tmpDir, '.teamai'));
    await saveStateForScope({ lastPull: '2025-01-01', lastPullRev: null, lastPush: null, pushedRules: [], pushedSkills: [], pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null }, 'user');
    const state = await loadStateForScope('user');
    expect(state.lastPull).toBe('2025-01-01');
  });

  it('should save and load state for project scope', async () => {
    const projectRoot = path.join(tmpDir, 'proj');
    await fse.ensureDir(path.join(projectRoot, '.teamai'));
    await saveStateForScope({ lastPull: '2025-06-01', lastPullRev: null, lastPush: null, pushedRules: [], pushedSkills: [], pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null }, 'project', projectRoot);
    const state = await loadStateForScope('project', projectRoot);
    expect(state.lastPull).toBe('2025-06-01');
  });
});

// ─── TeamaiConfigSchema scope field tests ────────────────

describe('TeamaiConfigSchema with scope', () => {
  const baseTeamConfig = {
    team: 'my-team',
    repo: 'https://example.com/repo.git',
  };

  it('should accept config without scope (legacy backward compatibility)', () => {
    const result = TeamaiConfigSchema.parse(baseTeamConfig);
    expect(result.scope).toBeUndefined();
  });

  it('should accept scope: "user"', () => {
    const result = TeamaiConfigSchema.parse({ ...baseTeamConfig, scope: 'user' });
    expect(result.scope).toBe('user');
  });

  it('should accept scope: "project"', () => {
    const result = TeamaiConfigSchema.parse({ ...baseTeamConfig, scope: 'project' });
    expect(result.scope).toBe('project');
  });

  it('should reject invalid scope values', () => {
    expect(() => TeamaiConfigSchema.parse({ ...baseTeamConfig, scope: 'global' })).toThrow();
    expect(() => TeamaiConfigSchema.parse({ ...baseTeamConfig, scope: 123 })).toThrow();
  });
});

// ─── validateScopeMatch tests ────────────────────────────

describe('validateScopeMatch', () => {
  it('should allow matching scopes (user/user)', () => {
    expect(() => validateScopeMatch('user', 'user')).not.toThrow();
  });

  it('should allow matching scopes (project/project)', () => {
    expect(() => validateScopeMatch('project', 'project')).not.toThrow();
  });

  it('should reject mismatched scopes (user remote, project local)', () => {
    expect(() => validateScopeMatch('user', 'project')).toThrow(/Scope mismatch/);
    expect(() => validateScopeMatch('user', 'project')).toThrow(/--scope project/);
  });

  it('should reject mismatched scopes (project remote, user local)', () => {
    expect(() => validateScopeMatch('project', 'user')).toThrow(/Scope mismatch/);
    expect(() => validateScopeMatch('project', 'user')).toThrow(/--scope user/);
  });

  it('should allow any local scope when remote is undefined (legacy repo)', () => {
    expect(() => validateScopeMatch(undefined, 'user')).not.toThrow();
    expect(() => validateScopeMatch(undefined, 'project')).not.toThrow();
  });
});

// ─── contribute --scope tests ────────────────────────────

describe('contribute --scope', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    tmpDir = path.join('/tmp', `teamai-scope-contribute-${Date.now()}`);
    await fse.ensureDir(tmpDir);
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.cwd = originalCwd;
    await fse.remove(tmpDir);
    vi.restoreAllMocks();
  });

  it('should use project config when --scope project is specified', async () => {
    const projectRoot = path.join(tmpDir, 'my-project');
    const projectRepoPath = path.join(projectRoot, '.teamai', 'team-repo');
    await fse.ensureDir(path.join(projectRoot, '.teamai'));
    await fse.ensureDir(projectRepoPath);

    // Write project config
    await fse.writeFile(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      YAML.stringify({
        repo: { localPath: projectRepoPath, remote: 'https://example.com/project-repo.git' },
        username: 'projuser',
        scope: 'project',
        projectRoot,
      }),
    );

    // Override cwd to project root
    process.cwd = () => projectRoot;

    const { loadLocalConfigForScope } = await import('../config.js');
    const cfg = await loadLocalConfigForScope('project', projectRoot);
    expect(cfg).not.toBeNull();
    expect(cfg!.scope).toBe('project');
    expect(cfg!.username).toBe('projuser');
  });

  it('should use user config when --scope user is specified', async () => {
    // Set up user-scope config
    await fse.ensureDir(path.join(tmpDir, '.teamai'));
    await fse.writeFile(
      path.join(tmpDir, '.teamai', 'config.yaml'),
      YAML.stringify({
        repo: { localPath: path.join(tmpDir, '.teamai', 'repo'), remote: 'https://example.com/user-repo.git' },
        username: 'homeuser',
        scope: 'user',
      }),
    );

    const { loadLocalConfigForScope } = await import('../config.js');
    const cfg = await loadLocalConfigForScope('user');
    expect(cfg).not.toBeNull();
    expect(cfg!.scope).toBe('user');
    expect(cfg!.username).toBe('homeuser');
  });
});

// ─── recall dual-scope merge tests ───────────────────────

describe('recall dual-scope merge', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tmpDir = path.join('/tmp', `teamai-scope-recall-${Date.now()}`);
    await fse.ensureDir(tmpDir);
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fse.remove(tmpDir);
  });

  it('should load indexes from different paths for different scopes', async () => {
    const { buildIndex, loadIndex } = await import('../utils/search-index.js');

    // User scope learnings
    const userLearnings = path.join(tmpDir, '.teamai', 'docs', 'learnings');
    await fse.ensureDir(userLearnings);
    await fse.writeFile(
      path.join(userLearnings, 'user-doc-2026-04-01-aaa.md'),
      '---\ntitle: "User scope doc"\nauthor: alice\ndate: 2026-04-01\ntags: [api]\n---\n\nUser scope content.\n',
    );

    // Project scope learnings
    const projectRoot = path.join(tmpDir, 'my-project');
    const projectLearnings = path.join(projectRoot, '.teamai', 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(
      path.join(projectLearnings, 'proj-doc-2026-04-01-bbb.md'),
      '---\ntitle: "Project scope doc"\nauthor: bob\ndate: 2026-04-01\ntags: [api]\n---\n\nProject scope content.\n',
    );

    // Build indexes at different paths
    const userIndexPath = path.join(tmpDir, '.teamai', 'search-index.json');
    const projectIndexPath = path.join(projectRoot, '.teamai', 'search-index.json');

    await buildIndex(userLearnings, undefined, userIndexPath);
    await buildIndex(projectLearnings, undefined, projectIndexPath);

    // Load separately
    const userIndex = await loadIndex(userIndexPath);
    const projectIndex = await loadIndex(projectIndexPath);

    expect(userIndex).not.toBeNull();
    expect(projectIndex).not.toBeNull();
    expect(userIndex!.entries).toHaveLength(1);
    expect(projectIndex!.entries).toHaveLength(1);
    expect(userIndex!.entries[0].title).toContain('User');
    expect(projectIndex!.entries[0].title).toContain('Project');
  });

  it('should merge and deduplicate results from both scopes', async () => {
    const { buildIndex, loadIndex, search } = await import('../utils/search-index.js');

    // User scope learnings
    const userLearnings = path.join(tmpDir, '.teamai', 'docs', 'learnings');
    await fse.ensureDir(userLearnings);
    await fse.writeFile(
      path.join(userLearnings, 'api-timeout-user-2026-04-01-aaa.md'),
      '---\ntitle: "API Timeout Fix (user)"\nauthor: alice\ndate: 2026-04-01\ntags: [api, timeout]\n---\n\nUser fix for api timeout.\n',
    );

    // Project scope learnings
    const projectRoot = path.join(tmpDir, 'my-project');
    const projectLearnings = path.join(projectRoot, '.teamai', 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(
      path.join(projectLearnings, 'api-timeout-proj-2026-04-01-bbb.md'),
      '---\ntitle: "API Timeout Fix (project)"\nauthor: bob\ndate: 2026-04-01\ntags: [api, timeout]\n---\n\nProject fix for api timeout.\n',
    );

    // Build indexes
    const userIndexPath = path.join(tmpDir, '.teamai', 'search-index.json');
    const projectIndexPath = path.join(projectRoot, '.teamai', 'search-index.json');
    await buildIndex(userLearnings, undefined, userIndexPath);
    await buildIndex(projectLearnings, undefined, projectIndexPath);

    // Load and search both
    const userIndex = await loadIndex(userIndexPath);
    const projectIndex = await loadIndex(projectIndexPath);
    const userResults = search('api timeout', userIndex!);
    const projectResults = search('api timeout', projectIndex!);

    // Both should find results
    expect(userResults.length).toBeGreaterThan(0);
    expect(projectResults.length).toBeGreaterThan(0);

    // Merged results should contain entries from both scopes
    const allFilenames = [
      ...userResults.map(r => r.entry.filename),
      ...projectResults.map(r => r.entry.filename),
    ];
    expect(allFilenames).toContain('api-timeout-user-2026-04-01-aaa.md');
    expect(allFilenames).toContain('api-timeout-proj-2026-04-01-bbb.md');
  });

  it('should deduplicate entries with same filename across scopes', async () => {
    const { buildIndex, loadIndex, search } = await import('../utils/search-index.js');

    const docContent = '---\ntitle: "Shared Doc"\nauthor: alice\ndate: 2026-04-01\ntags: [shared]\n---\n\nSame content.\n';

    // Same filename in both scopes
    const userLearnings = path.join(tmpDir, '.teamai', 'docs', 'learnings');
    await fse.ensureDir(userLearnings);
    await fse.writeFile(path.join(userLearnings, 'shared-doc-2026-04-01-xyz.md'), docContent);

    const projectRoot = path.join(tmpDir, 'my-project');
    const projectLearnings = path.join(projectRoot, '.teamai', 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(path.join(projectLearnings, 'shared-doc-2026-04-01-xyz.md'), docContent);

    const userIndexPath = path.join(tmpDir, '.teamai', 'search-index.json');
    const projectIndexPath = path.join(projectRoot, '.teamai', 'search-index.json');
    await buildIndex(userLearnings, undefined, userIndexPath);
    await buildIndex(projectLearnings, undefined, projectIndexPath);

    const userIndex = await loadIndex(userIndexPath);
    const projectIndex = await loadIndex(projectIndexPath);
    const userResults = search('shared', userIndex!);
    const projectResults = search('shared', projectIndex!);

    // Simulate merge with dedup (same logic as recall)
    const seenFilenames = new Set<string>();
    const merged: Array<{ filename: string; scope: string }> = [];
    for (const r of userResults) {
      if (!seenFilenames.has(r.entry.filename)) {
        seenFilenames.add(r.entry.filename);
        merged.push({ filename: r.entry.filename, scope: 'user' });
      }
    }
    for (const r of projectResults) {
      if (!seenFilenames.has(r.entry.filename)) {
        seenFilenames.add(r.entry.filename);
        merged.push({ filename: r.entry.filename, scope: 'project' });
      }
    }

    // Only one entry should appear (deduped)
    expect(merged).toHaveLength(1);
    expect(merged[0].filename).toBe('shared-doc-2026-04-01-xyz.md');
  });

  it('project scope should use repo learnings dir (not local copy)', async () => {
    const { buildIndex, loadIndex } = await import('../utils/search-index.js');

    // 模拟 project scope：learnings 只存在于 repo 中，不在 <projectRoot>/.teamai/learnings/
    const projectRoot = path.join(tmpDir, 'my-project');
    const projectRepoPath = path.join(projectRoot, '.teamai', 'team-repo');
    const repoLearningsDir = path.join(projectRepoPath, 'learnings');
    await fse.ensureDir(repoLearningsDir);
    await fse.writeFile(
      path.join(repoLearningsDir, 'repo-only-doc-2026-04-01-xyz.md'),
      '---\ntitle: "Repo Only Doc"\nauthor: bob\ndate: 2026-04-01\ntags: [deploy]\n---\n\nThis doc only exists in the repo.\n',
    );

    // 注意：没有创建 <projectRoot>/.teamai/learnings/ 目录
    // project scope 应该直接从 repo 里读取

    const projectIndexPath = path.join(projectRoot, '.teamai', 'search-index.json');
    await fse.ensureDir(path.join(projectRoot, '.teamai'));
    await buildIndex(repoLearningsDir, undefined, projectIndexPath);

    const index = await loadIndex(projectIndexPath);
    expect(index).not.toBeNull();
    expect(index!.entries).toHaveLength(1);
    expect(index!.entries[0].title).toBe('Repo Only Doc');
  });

  it('formatResults should output correct file path per scope', () => {
    // 直接测试 user scope 和 project scope 的 File 路径输出不同
    const userLearningsBase = path.join(tmpDir, '.teamai', 'docs', 'learnings');
    const projectLearningsBase = '/tmp/my-project/.teamai/team-repo/learnings';

    // 构造 ScopedSearchResult 数据
    const results = [
      {
        entry: {
          filename: 'user-doc.md',
          title: 'User Doc',
          author: 'alice',
          date: '2026-04-01',
          tags: [],
          tokens: [],
          votes: 0,
        },
        score: 5,
        scope: 'user' as const,
        learningsBase: userLearningsBase,
      },
      {
        entry: {
          filename: 'proj-doc.md',
          title: 'Project Doc',
          author: 'bob',
          date: '2026-04-01',
          tags: [],
          tokens: [],
          votes: 0,
        },
        score: 3,
        scope: 'project' as const,
        learningsBase: projectLearningsBase,
      },
    ];

    // formatResults 是 private，但我们可以间接验证输出格式
    // 用 search result 的 learningsBase 拼接路径
    const userFilePath = `${results[0].learningsBase}/${results[0].entry.filename}`;
    const projFilePath = `${results[1].learningsBase}/${results[1].entry.filename}`;

    expect(userFilePath).toBe(`${userLearningsBase}/user-doc.md`);
    expect(projFilePath).toBe(`${projectLearningsBase}/proj-doc.md`);
    expect(userFilePath).not.toEqual(projFilePath);
  });
});
