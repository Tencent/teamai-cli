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
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { AgentsHandler } from '../resources/agents.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

/**
 * Build a minimal TeamaiConfig with the given toolPaths.
 * Returns a proxy object cast to TeamaiConfig — the handler only reads
 * `toolPaths`, so other fields can stay shallow.
 */
function buildTeamConfig(
  toolPaths: TeamaiConfig['toolPaths'],
): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://example.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths,
  } as TeamaiConfig;
}

describe('AgentsHandler — Phase 1 push/pull/remove', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let handler: AgentsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agents-test-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'agents'));
    // cursor intentionally has no agents directory — Tier-3 tool

    vi.stubEnv('HOME', homeDir);

    handler = new AgentsHandler();

    teamConfig = buildTeamConfig({
      claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents' },
      codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', agents: '.codebuddy/agents' },
      // No agents path: should be silently skipped
      cursor: { skills: '.cursor/skills', rules: '.cursor/rules' },
    });

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  // ── scanTeamForPull ─────────────────────────────────────

  it('scanTeamForPull returns *.md files from team repo agents/', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', 'code-reviewer.md'), '# code reviewer');
    await fse.writeFile(path.join(repoPath, 'agents', 'doc-writer.md'), '# doc writer');
    // Non-md files must be ignored
    await fse.writeFile(path.join(repoPath, 'agents', 'README.txt'), 'should be ignored');

    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(['code-reviewer', 'doc-writer']);
    expect(items.every((i) => i.type === 'agents')).toBe(true);
  });

  it('scanTeamForPull returns namespaced agents from one level of subdirectories', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', 'shared.md'), '# shared');
    await fse.ensureDir(path.join(repoPath, 'agents', 'frontend'));
    await fse.writeFile(path.join(repoPath, 'agents', 'frontend', 'vr-reviewer.yaml'), 'name: vr-reviewer\n');
    await fse.writeFile(path.join(repoPath, 'agents', 'frontend', 'notes.txt'), 'ignored');
    // Two levels deep is not a namespace and must be ignored
    await fse.ensureDir(path.join(repoPath, 'agents', 'frontend', 'nested'));
    await fse.writeFile(path.join(repoPath, 'agents', 'frontend', 'nested', 'deep.md'), '# deep');

    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    expect(items.map((i) => [i.name, i.namespace, i.relativePath]).sort()).toEqual([
      ['shared', undefined, 'agents/shared.md'],
      ['vr-reviewer', 'frontend', 'agents/frontend/vr-reviewer.yaml'],
    ]);
    expect(items.find((i) => i.name === 'vr-reviewer')?.legacy).toBe(false);
  });

  it('scanTeamForPull returns empty when team repo has no agents directory', async () => {
    await fse.remove(path.join(repoPath, 'agents'));
    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    expect(items).toEqual([]);
  });

  // ── pullItem ────────────────────────────────────────────

  it('pullItem deploys *.md to every tool whose toolPaths.agents is configured', async () => {
    const srcPath = path.join(repoPath, 'agents', 'helper.md');
    await fse.writeFile(srcPath, '# helper agent');

    await handler.pullItem(
      {
        name: 'helper',
        type: 'agents',
        sourcePath: srcPath,
        relativePath: 'agents/helper.md',
      },
      teamConfig,
      localConfig,
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/helper.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents/helper.md'))).toBe(true);
  });

  it('pullItem silently skips tools without agents path (cursor/codex/etc.)', async () => {
    const srcPath = path.join(repoPath, 'agents', 'helper.md');
    await fse.writeFile(srcPath, '# helper agent');

    // cursor only has skills/rules, no agents — must not blow up
    await handler.pullItem(
      {
        name: 'helper',
        type: 'agents',
        sourcePath: srcPath,
        relativePath: 'agents/helper.md',
      },
      teamConfig,
      localConfig,
    );

    expect(await fse.pathExists(path.join(homeDir, '.cursor/agents/helper.md'))).toBe(false);
  });

  it('pullItem skips tools that are not installed (no tool root dir)', async () => {
    // Add another tool whose root does NOT exist on the user machine
    const cfg = buildTeamConfig({
      claude: { skills: '.claude/skills', agents: '.claude/agents' },
      'claude-internal': { skills: '.claude-internal/skills', agents: '.claude-internal/agents' },
    });
    const srcPath = path.join(repoPath, 'agents', 'helper.md');
    await fse.writeFile(srcPath, '# helper');

    await handler.pullItem(
      { name: 'helper', type: 'agents', sourcePath: srcPath, relativePath: 'agents/helper.md' },
      cfg,
      localConfig,
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/helper.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude-internal/agents/helper.md'))).toBe(false);
  });

  // ── scanLocalForPush ────────────────────────────────────

  it('scanLocalForPush detects a modified agent across tool dirs as "modified"', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', 'shared.md'), 'team version');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'shared.md'), 'local edits');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
  });

  it('scanLocalForPush routes a modified namespaced agent back to its namespace', async () => {
    await fse.ensureDir(path.join(repoPath, 'agents', 'frontend'));
    await fse.writeFile(path.join(repoPath, 'agents', 'frontend', 'vr.md'), 'team version');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'vr.md'), 'local edits');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'vr');
    expect(item?.status).toBe('modified');
    expect(item?.relativePath).toBe('agents/frontend/vr.md');
  });

  it.each(['role', 'project', 'additional role'])('push resolves same-stem agents using the active %s', async (axis) => {
    await fse.outputFile(path.join(repoPath, 'manifest/roles.yaml'), `version: 1
roles:
  - id: active
    resources:
      knowledge: []
      skills: []
      agents: [zzz]
  - id: empty
    resources:
      knowledge: []
      skills: []
`);
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'), `version: 1
projects:
  - id: active
    resources:
      agents: [zzz]
`);
    if (axis === 'project') localConfig.projects = ['active'];
    else if (axis === 'additional role') {
      localConfig.primaryRole = 'empty';
      localConfig.additionalRoles = ['active'];
    } else localConfig.primaryRole = 'active';
    const inactive = 'name: reviewer\ndescription: Inactive\ninstructions: Read aaa.\n';
    await fse.outputFile(path.join(repoPath, 'agents/aaa/reviewer.yaml'), inactive);
    const sourcePath = path.join(repoPath, 'agents/zzz/reviewer.yaml');
    await fse.outputFile(sourcePath, 'name: reviewer\ndescription: Active\ninstructions: Read zzz.\n');
    await handler.pullItem({ name: 'reviewer', type: 'agents', sourcePath, relativePath: 'agents/zzz/reviewer.yaml' }, teamConfig, localConfig);
    expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);
    const deployed = path.join(homeDir, '.claude/agents/reviewer.md');
    await fse.writeFile(deployed, (await fse.readFile(deployed, 'utf8')).replace('Read zzz.', 'Edited zzz.'));
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item) throw new Error('Expected edited agent');
    expect(item.relativePath).toBe('agents/zzz/reviewer.yaml');
    await handler.pushItem(item, teamConfig, localConfig);
    expect(await fse.readFile(sourcePath, 'utf8')).toContain('Edited zzz.');
    expect(await fse.readFile(path.join(repoPath, 'agents/aaa/reviewer.yaml'), 'utf8')).toBe(inactive);
  });

  it('does not promote an inactive retained agent to a new root agent', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'), 'version: 1\nprojects:\n  - id: inactive\n    resources:\n      agents: [aaa]\n');
    await fse.outputFile(path.join(repoPath, 'agents/aaa/reviewer.md'), '# original');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'), '# local edit');
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toContain('no active source');
    for (const item of items) await handler.pushItem(item, teamConfig, localConfig);
    expect(await fse.pathExists(path.join(repoPath, 'agents/reviewer.yaml'))).toBe(false);
    expect(await fse.readFile(path.join(repoPath, 'agents/aaa/reviewer.md'), 'utf8')).toBe('# original');
  });

  it.each(['zzz', ''])('rejects ambiguous push destinations including root: %s', async (namespace) => {
    await fse.outputFile(path.join(repoPath, 'agents/aaa/reviewer.md'), '# aaa');
    await fse.outputFile(path.join(repoPath, 'agents', namespace, 'reviewer.md'), '# zzz');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'), '# edited');
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toContain('Ambiguous');
    for (const item of items) await handler.pushItem(item, teamConfig, localConfig);
    expect(await fse.readFile(path.join(repoPath, 'agents/aaa/reviewer.md'), 'utf8')).toBe('# aaa');
    expect(await fse.readFile(path.join(repoPath, 'agents', namespace, 'reviewer.md'), 'utf8')).toBe('# zzz');
  });

  it('scanLocalForPush detects a brand-new local agent as "new"', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'brand-new.md'), '# brand new');
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'brand-new');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
  });

  it('scanLocalForPush ignores local copies identical to team repo', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', 'same.md'), 'identical');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'same.md'), 'identical');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'same')).toBeUndefined();
  });

  it('scanLocalForPush ignores an untouched Codex agent rendered from team YAML', async () => {
    const codexConfig = buildTeamConfig({
      codex: { skills: '.codex/skills', agents: '.codex/agents' },
    });
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));

    const sourcePath = path.join(repoPath, 'agents', 'same.yaml');
    await fse.writeFile(sourcePath, [
      'name: same',
      'description: Unchanged Codex agent',
      'instructions: Review the current change.',
      'targets:',
      '  - codex',
      '',
    ].join('\n'));

    await handler.pullItem(
      {
        name: 'same',
        type: 'agents',
        sourcePath,
        relativePath: 'agents/same.yaml',
      },
      codexConfig,
      localConfig,
    );

    const items = await handler.scanLocalForPush(codexConfig, localConfig);
    expect(items.find((i) => i.name === 'same')).toBeUndefined();
  });

  it('scanLocalForPush detects edits to a Codex agent rendered from team YAML', async () => {
    const codexConfig = buildTeamConfig({
      codex: { skills: '.codex/skills', agents: '.codex/agents' },
    });
    const codexAgentsDir = path.join(homeDir, '.codex', 'agents');
    await fse.ensureDir(codexAgentsDir);

    const sourcePath = path.join(repoPath, 'agents', 'edited.yaml');
    await fse.writeFile(sourcePath, [
      'name: edited',
      'description: Original description',
      'instructions: Review the current change.',
      'targets:',
      '  - codex',
      '',
    ].join('\n'));

    await handler.pullItem(
      {
        name: 'edited',
        type: 'agents',
        sourcePath,
        relativePath: 'agents/edited.yaml',
      },
      codexConfig,
      localConfig,
    );
    const codexPath = path.join(codexAgentsDir, 'edited.toml');
    const rendered = await fse.readFile(codexPath, 'utf8');
    await fse.writeFile(codexPath, rendered.replace('Original description', 'Locally edited description'));

    const items = await handler.scanLocalForPush(codexConfig, localConfig);
    expect(items.find((i) => i.name === 'edited')?.status).toBe('modified');
  });

  it('scanLocalForPush excludes built-in CLI agents (e.g. teamai-recall)', async () => {
    await fse.writeFile(
      path.join(homeDir, '.claude/agents', 'teamai-recall.md'),
      '# managed by CLI — must not be pushed',
    );
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'teamai-recall')).toBeUndefined();
  });

  // ── pushItem ────────────────────────────────────────────

  it('pushItem copies the local md file into team-repo/agents/', async () => {
    const localFile = path.join(homeDir, '.claude/agents', 'pushed.md');
    await fse.writeFile(localFile, '# pushed agent');

    await handler.pushItem(
      { name: 'pushed', type: 'agents', sourcePath: localFile, relativePath: 'agents/pushed.md' },
      teamConfig,
      localConfig,
    );

    const teamFile = path.join(repoPath, 'agents', 'pushed.md');
    expect(await fse.pathExists(teamFile)).toBe(true);
    expect((await fse.readFile(teamFile, 'utf8'))).toBe('# pushed agent');
  });

  it('pushItem writes a namespaced agent to its own namespace directory, not the root', async () => {
    await fse.ensureDir(path.join(repoPath, 'agents', 'frontend'));
    await fse.writeFile(path.join(repoPath, 'agents', 'frontend', 'vr.md'), 'team version');
    const localFile = path.join(homeDir, '.claude/agents', 'vr.md');
    await fse.writeFile(localFile, 'local edits');

    await handler.pushItem(
      { name: 'vr', type: 'agents', sourcePath: localFile, relativePath: 'agents/frontend/vr.md' },
      teamConfig,
      localConfig,
    );

    expect(await fse.readFile(path.join(repoPath, 'agents', 'frontend', 'vr.md'), 'utf8')).toBe('local edits');
    expect(await fse.pathExists(path.join(repoPath, 'agents', 'vr.md'))).toBe(false);
  });

  // ── removeItem + tombstone ──────────────────────────────

  it('removeItem deletes from team repo and all tool agents/ dirs and writes a tombstone', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', 'old.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'old.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.codebuddy/agents', 'old.md'), 'old');

    const removed = await handler.removeItem('old', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(repoPath, 'agents', 'old.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'old.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents', 'old.md'))).toBe(false);
    expect(removed.length).toBeGreaterThanOrEqual(3);

    // Tombstone must be present so the agent is not re-pushed if a stale local
    // copy reappears.
    const tombstone = await fse.readFile(path.join(repoPath, 'agents', '.removed'), 'utf8');
    expect(tombstone.split('\n').map((l) => l.trim())).toContain('old');
  });

  it('removeItem leaves agents of an excluded tool alone', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', 'old.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'old.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.codebuddy/agents', 'old.md'), 'old');

    // enabledAgents whitelists claude only, so codebuddy is not ours to touch.
    await handler.removeItem('old', teamConfig, { ...localConfig, enabledAgents: ['claude'] });

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'old.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents', 'old.md'))).toBe(true);
  });

  it('removeItem deletes a namespaced agent from the team repo and tombstones it', async () => {
    await fse.ensureDir(path.join(repoPath, 'agents', 'devops'));
    await fse.writeFile(path.join(repoPath, 'agents', 'devops', 'tf.yaml'), 'name: tf\n');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'tf.md'), 'rendered');

    await handler.removeItem('tf', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(repoPath, 'agents', 'devops', 'tf.yaml'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents', 'tf.md'))).toBe(false);
    const tombstone = await fse.readFile(path.join(repoPath, 'agents', '.removed'), 'utf8');
    expect(tombstone.split('\n').map((l) => l.trim())).toContain('tf');
  });

  it('scanLocalForPush respects tombstones (skips removed items)', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'ghost\n');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'ghost.md'), '# revived');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'ghost')).toBeUndefined();
  });
});
