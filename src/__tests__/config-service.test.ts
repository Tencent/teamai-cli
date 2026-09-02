import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

vi.mock('../utils/branch-manager.js', () => ({
  pinCloneToBranch: vi.fn(async () => undefined),
  BranchVanishedError: class BranchVanishedError extends Error {},
}));
vi.mock('../recall-toggle.js', () => ({
  deployRecallArtifacts: vi.fn(async () => undefined),
  removeRecallArtifacts: vi.fn(async () => undefined),
  recallEnable: vi.fn(),
  recallDisable: vi.fn(),
  recallStatus: vi.fn(),
}));

const { pinCloneToBranch } = await import('../utils/branch-manager.js');
const { deployRecallArtifacts, removeRecallArtifacts } = await import('../recall-toggle.js');

// Import AFTER mocks are in place (vitest hoists vi.mock, but be explicit anyway).
const { readConfigBundle, applyConfigPatch, NotInitializedError } = await import('../config-service.js');
const { loadLocalConfigForScope, saveLocalConfigForScope, saveStateForScope } = await import('../config.js');
const type_ = await import('../types.js');

let root: string;
let home: string;
let repoPath: string;
let projectRoot: string;
let realHome: string | undefined;

function writeConfig(scope: 'user' | 'project', config: Record<string, unknown>): void {
  const cfg = scope === 'user'
    ? path.join(home, '.teamai', 'config.yaml')
    : path.join(projectRoot, '.teamai', 'config.yaml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, YAML.stringify(config));
}

function readConfigFile(scope: 'user' | 'project'): Record<string, unknown> {
  const cfg = scope === 'user'
    ? path.join(home, '.teamai', 'config.yaml')
    : path.join(projectRoot, '.teamai', 'config.yaml');
  return YAML.parse(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>;
}

function baseConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: { localPath: repoPath, remote: 'https://git.example.com/team/repo.git', kind: 'git' },
    username: 'alice',
    scope: 'user',
    additionalRoles: [],
    ...over,
  };
}

beforeAll(() => {
  realHome = process.env.HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cfgsvc-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });

  repoPath = path.join(root, 'team-repo');
  fs.mkdirSync(path.join(repoPath, 'manifest'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'skills', 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, 'teamai.yaml'),
    YAML.stringify({
      team: 'test-team',
      repo: 'https://git.example.com/team/repo.git',
      provider: 'git',
      sharing: { env: { injectShellProfile: true } },
    }),
  );
  fs.writeFileSync(
    path.join(repoPath, 'manifest', 'roles.yaml'),
    YAML.stringify({
      version: 3,
      roles: [
        { id: 'dev', description: 'developer', resources: { knowledge: ['common'], skills: ['core'] } },
        { id: 'ops', description: 'operator', resources: { knowledge: ['runbooks'], skills: ['ops'] } },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(repoPath, 'tags.yaml'),
    YAML.stringify({
      skills: { 'deploy-tool': ['infra'] },
      rules: {},
    }),
  );
});

afterAll(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.HOME = home;
  // Fresh user + project configs per test.
  writeConfig('user', baseConfig());
  writeConfig('project', baseConfig({ scope: 'project', projectRoot }));
  vi.mocked(pinCloneToBranch).mockClear();
  vi.mocked(deployRecallArtifacts).mockClear();
  vi.mocked(removeRecallArtifacts).mockClear();
});

describe('readConfigBundle', () => {
  it('resolves fields with source attribution for the user scope', async () => {
    const bundle = await readConfigBundle('user');
    expect(bundle.scope).toBe('user');
    const updatePolicy = bundle.fields.find((f) => f.spec.key === 'updatePolicy')!;
    expect(updatePolicy.source).toBe('unset');

    await applyConfigPatch('user', { updatePolicy: 'skip' });
    const updated = await readConfigBundle('user');
    expect(updated.fields.find((f) => f.spec.key === 'updatePolicy')!.value).toBe('skip');
    expect(updated.fields.find((f) => f.spec.key === 'updatePolicy')!.source).toBe('user');
  });

  it('reports the user value as inherited source in project scope (display only)', async () => {
    await applyConfigPatch('user', { updatePolicy: 'skip' });
    // Project config does not set updatePolicy.
    const bundle = await readConfigBundle('project', projectRoot);
    const field = bundle.fields.find((f) => f.spec.key === 'updatePolicy')!;
    expect(field.source).toBe('user');
    expect(field.value).toBe('skip');
  });

  it('resolves team defaults for tri-state fields', async () => {
    fs.writeFileSync(
      path.join(repoPath, 'teamai.yaml'),
      YAML.stringify({
        team: 'test-team',
        repo: 'https://git.example.com/team/repo.git',
        provider: 'git',
        sharing: { recall: { enabled: true }, coAuthor: { enabled: false } },
      }),
    );
    const bundle = await readConfigBundle('user');
    expect(bundle.fields.find((f) => f.spec.key === 'recallEnabled')!.source).toBe('team-default');
    expect(bundle.fields.find((f) => f.spec.key === 'recallEnabled')!.value).toBe(true);
    expect(bundle.fields.find((f) => f.spec.key === 'coAuthorEnabled')!.value).toBe(false);
  });

  it('throws NotInitializedError when the scope has no config', async () => {
    fs.rmSync(path.join(home, '.teamai', 'config.yaml'));
    await expect(readConfigBundle('user')).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('resolves dynamic options from the team repo', async () => {
    const bundle = await readConfigBundle('user');
    expect(bundle.options.roles.sort()).toEqual(['dev', 'ops']);
    expect(bundle.options.tags).toEqual(['infra']);
  });
});

describe('applyConfigPatch — validation pipeline', () => {
  it('rejects unknown keys without writing', async () => {
    const result = await applyConfigPatch('user', { 'no.such.key': 'x' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].key).toBe('no.such.key');
    expect(readConfigFile('user')).toEqual(baseConfig());
  });

  it('rejects read-only fields with a CLI hint', async () => {
    const result = await applyConfigPatch('user', { username: 'mallory' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('teamai init');
  });

  it('rejects fields outside their scope (inheritUserScope is project-only)', async () => {
    const result = await applyConfigPatch('user', { inheritUserScope: true });
    expect(result.ok).toBe(false);
    expect(result.errors[0].key).toBe('inheritUserScope');
  });

  it('validates enum values', async () => {
    const result = await applyConfigPatch('user', { updatePolicy: 'sometimes' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('Valid');
  });

  it('validates primaryRole against the roles manifest', async () => {
    const bad = await applyConfigPatch('user', { primaryRole: 'ghost' });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toContain('Unknown role "ghost"');
    expect(bad.errors[0].message).toContain('dev, ops');

    const good = await applyConfigPatch('user', { primaryRole: 'dev' });
    expect(good.ok).toBe(true);
    expect(readConfigFile('user').primaryRole).toBe('dev');
  });

  it('validates additionalRoles per id and normalizes comma strings', async () => {
    const result = await applyConfigPatch('user', { additionalRoles: 'ops, ghost' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('ghost');

    const good = await applyConfigPatch('user', { additionalRoles: 'ops' });
    expect(good.ok).toBe(true);
    expect(readConfigFile('user').additionalRoles).toEqual(['ops']);
  });

  it('validates subscribedTags against tags.yaml', async () => {
    const bad = await applyConfigPatch('user', { subscribedTags: ['nope'] });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toContain('Unknown tag "nope"');

    const good = await applyConfigPatch('user', { subscribedTags: 'infra' });
    expect(good.ok).toBe(true);
  });

  it('aborts the whole patch on any per-key failure (nothing written)', async () => {
    const result = await applyConfigPatch('user', { updatePolicy: 'auto', username: 'x' });
    expect(result.ok).toBe(false);
    expect(readConfigFile('user').updatePolicy).toBeUndefined();
  });
});

describe('applyConfigPatch — tri-state handling', () => {
  it('stores booleans for true/false and deletes the key for unset', async () => {
    const on = await applyConfigPatch('user', { recallEnabled: 'true' });
    expect(on.ok).toBe(true);
    expect(readConfigFile('user').recallEnabled).toBe(true);

    const unset = await applyConfigPatch('user', { recallEnabled: 'unset' });
    expect(unset.ok).toBe(true);
    expect(readConfigFile('user').recallEnabled).toBeUndefined();
  });

  it('accepts raw booleans too', async () => {
    const result = await applyConfigPatch('user', { coAuthorEnabled: false });
    expect(result.ok).toBe(true);
    expect(readConfigFile('user').coAuthorEnabled).toBe(false);
  });
});

describe('applyConfigPatch — afterSave side effects', () => {
  it('pins the clone AFTER persisting repo.branch (mocked boundary)', async () => {
    const result = await applyConfigPatch('user', { 'repo.branch': 'release/v2' });
    expect(result.ok).toBe(true);
    expect(pinCloneToBranch).toHaveBeenCalledTimes(1);
    const [localPath, branch] = vi.mocked(pinCloneToBranch).mock.calls[0];
    expect(localPath).toBe(repoPath);
    expect(branch).toBe('release/v2');
    // The config was persisted BEFORE the hook ran — the hook reads it from disk.
    const base = baseConfig();
    const baseRepo = base.repo as Record<string, unknown>;
    expect(readConfigFile('user')).toEqual({
      ...base,
      repo: { ...baseRepo, branch: 'release/v2' },
    });
  });

  it('unsets repo.branch with an empty string (no pin target without a git repo)', async () => {
    writeConfig('user', baseConfig({ repo: { localPath: repoPath, remote: 'x', kind: 'git', branch: 'release/v2' } }));
    const result = await applyConfigPatch('user', { 'repo.branch': '' });
    expect(result.ok).toBe(true);
    expect(readConfigFile('user').repo).not.toHaveProperty('branch');
  });

  it('deploys/removes recall artifacts per value (reused routines)', async () => {
    const off = await applyConfigPatch('user', { recallEnabled: 'false' });
    expect(off.ok).toBe(true);
    expect(removeRecallArtifacts).toHaveBeenCalledTimes(1);
    expect(deployRecallArtifacts).not.toHaveBeenCalled();

    vi.mocked(removeRecallArtifacts).mockClear();
    const on = await applyConfigPatch('user', { recallEnabled: 'true' });
    expect(on.ok).toBe(true);
    expect(deployRecallArtifacts).toHaveBeenCalledTimes(1);
  });

  it('reports afterSave failures but keeps the config write', async () => {
    vi.mocked(pinCloneToBranch).mockRejectedValueOnce(new Error('branch gone'));
    const result = await applyConfigPatch('user', { 'repo.branch': 'dead/branch' });
    expect(result.ok).toBe(true); // write stands
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('repo.branch');
    expect(result.errors[0].message).toContain('branch gone');
    expect(readConfigFile('user').repo).toMatchObject({ branch: 'dead/branch' });
  });

  it('resets lastPullRev when excludedSkills change (mirrors exclude.ts)', async () => {
    await saveStateForScope({ lastPullRev: 'abc123', lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [], pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null } as never, 'user');
    const result = await applyConfigPatch('user', { excludedSkills: '["deploy-tool"]' });
    expect(result.ok).toBe(true);
    const statePath = path.join(home, '.teamai', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.lastPullRev).toBeNull();
    expect(readConfigFile('user').excludedSkills).toEqual(['deploy-tool']);
  });
});

describe('applyConfigPatch — scope handling', () => {
  it('writes to the project config file for project scope', async () => {
    const result = await applyConfigPatch('project', { inheritUserScope: true }, projectRoot);
    expect(result.ok).toBe(true);
    expect(readConfigFile('project').inheritUserScope).toBe(true);
    expect(readConfigFile('user').inheritUserScope).toBeUndefined();
  });

  it('loads via loadLocalConfigForScope with backfilled projectRoot', async () => {
    const cfg = await loadLocalConfigForScope('project', projectRoot);
    expect(cfg?.projectRoot).toBe(projectRoot);
    expect(cfg?.scope).toBe('project');
  });

  it('saves through saveLocalConfigForScope to the project path', async () => {
    const cfg = (await loadLocalConfigForScope('project', projectRoot))!;
    await saveLocalConfigForScope({ ...cfg, updatePolicy: 'prompt' }, 'project', projectRoot);
    expect(readConfigFile('project').updatePolicy).toBe('prompt');
  });
});

describe('types additions', () => {
  it('exposes the Config WebUI port constant above the dashboard', () => {
    expect(type_.CONFIG_UI_DEFAULT_PORT).toBe(3722);
    expect(type_.DASHBOARD_DEFAULT_PORT).toBe(3721);
  });
});
