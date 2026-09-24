import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

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

const mockGetFileContentAtRev = vi.fn<
  (repoPath: string, rev: string, filePath: string) => Promise<Buffer | null>
>().mockResolvedValue(null);
vi.mock('../utils/git.js', async () => ({
  ...(await vi.importActual('../utils/git.js')),
  getFileContentAtRev: (...args: [string, string, string]) => mockGetFileContentAtRev(...args),
}));

import { AgentsHandler } from '../resources/agents.js';
import { getDataHome, type TeamaiConfig, type LocalConfig } from '../types.js';

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
    mockGetFileContentAtRev.mockResolvedValue(null);
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

  it('pullItem leaves a member\'s same-stem file alone beside a legacy .md agent', async () => {
    // A legacy `.md` is copied verbatim to one extension for every tool, so it
    // can never leave a sibling of its own behind. Anything else on the stem is
    // the member's file: a rendered spec sweeps its own stale extensions, this
    // does not get to delete an unrelated `.toml`, `.json` or `.agent.md`.
    const srcPath = path.join(repoPath, 'agents', 'helper.md');
    await fse.writeFile(srcPath, '# helper agent');
    const mine = path.join(homeDir, '.claude/agents/helper.toml');
    await fse.ensureDir(path.dirname(mine));
    await fse.writeFile(mine, 'name = "my own helper"\n');

    await handler.pullItem(
      { name: 'helper', type: 'agents', sourcePath: srcPath, relativePath: 'agents/helper.md' },
      teamConfig,
      localConfig,
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/helper.md'))).toBe(true);
    expect(await fse.readFile(mine, 'utf8')).toBe('name = "my own helper"\n');
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

  /**
   * An agent published with `--role`/`--project` lands in a namespace the
   * author's own directory need not have activated. Without the record push
   * put in state.json, their very next edit is skipped as "no active source"
   * and they can never maintain the agent they just created (#649 review).
   */
  it('accepts the namespace push recorded for an agent even when it is inactive', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: inactive\n    resources:\n      agents: [fe-agents]\n');
    const sourcePath = path.join(repoPath, 'agents/fe-agents/reviewer.yaml');
    await fse.outputFile(sourcePath, 'name: reviewer\ndescription: Published\ninstructions: Read it.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Published\n---\n\nEdited locally.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { reviewer: 'agents/fe-agents/reviewer.yaml' },
    });

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toBeUndefined();
    expect(items[0]?.relativePath).toBe('agents/fe-agents/reviewer.yaml');
  });

  // A projects manifest with none of its projects active here: every namespace
  // is inactive, and only the shared root is delivered.
  const nothingActive = () => fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
    'version: 1\nprojects:\n  - id: elsewhere\n    resources:\n      agents: [zzz]\n');

  it('does not hold a recorded agent whose local copy already matches the team file', async () => {
    // The author's own edit merged after their last pull: the team file moved
    // past the baseline, but to exactly what they have, so nothing is pushed.
    await nothingActive();
    const current = { name: 'reviewer', type: 'agents' as const,
      sourcePath: path.join(repoPath, 'agents/fe-agents/reviewer.yaml'), relativePath: 'agents/fe-agents/reviewer.yaml' };
    await fse.outputFile(current.sourcePath, 'name: reviewer\ndescription: Published\ninstructions: My merged edit.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { reviewer: 'agents/fe-agents/reviewer.yaml' }, lastPullRev: 'abc1234',
    });
    await handler.pullItem(current, teamConfig, localConfig);
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('name: reviewer\ndescription: Published\ninstructions: Read it.\n'));

    expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);
  });

  it('holds a recorded agent that changed on the team since this machine last synced it', async () => {
    // Agents have no pre-push sync: a teammate's edit made before the author's
    // next pull would be overwritten by the stale local copy (#649 review).
    await nothingActive();
    await fse.outputFile(path.join(repoPath, 'agents/fe-agents/reviewer.yaml'),
      'name: reviewer\ndescription: Published\ninstructions: A teammate rewrote this.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Published\n---\n\nRead it.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { reviewer: 'agents/fe-agents/reviewer.yaml' }, lastPullRev: 'abc1234',
    });
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('name: reviewer\ndescription: Published\ninstructions: Read it.\n'));

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toContain('changed on the team since this machine last synced it');
    expect(mockGetFileContentAtRev).toHaveBeenCalledWith(repoPath, 'abc1234', './agents/fe-agents/reviewer.yaml');
  });

  /**
   * The layout allows the same stem in several namespaces. An explicit
   * --role/--project names the destination, so a copy in some OTHER namespace
   * is a different agent and must not block publishing this one — which is
   * what filtering on activity alone did (#649 review).
   */
  /**
   * `remove agents vr` matched the bare stem and deleted every `vr` in every
   * namespace, other people's agents included, and left the namespaced record
   * behind (#649 review).
   */
  it('resolves the bare agent name to the namespace push recorded for it', async () => {
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'),
      'name: vr\ndescription: Mine\ninstructions: Read it.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { vr: 'agents/fe/vr.yaml' },
    });

    expect(await handler.publishedNameFor('vr', localConfig)).toBe('fe/vr');
  });

  it('does not resolve an agent record whose team file is gone', async () => {
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { vr: 'agents/fe/vr.yaml' },
    });

    expect(await handler.publishedNameFor('vr', localConfig)).toBeNull();
  });

  it('removes only the named namespace, leaving the same stem elsewhere', async () => {
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\ndescription: Mine\ninstructions: A.\n');
    await fse.outputFile(path.join(repoPath, 'agents/other/vr.yaml'), 'name: vr\ndescription: Theirs\ninstructions: B.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/vr.md'), '# the author copy');
    // Push recorded where it put this agent; that record is what makes the
    // flattened local copy this agent's rather than another namespace's.
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { vr: 'agents/fe/vr.yaml' },
    });

    await handler.removeItem('fe/vr', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(repoPath, 'agents/fe/vr.yaml'))).toBe(false);
    // Somebody else's agent of the same name is not ours to delete.
    expect(await fse.readFile(path.join(repoPath, 'agents/other/vr.yaml'), 'utf-8')).toContain('Theirs');
    // The author's own copy is at the agents root under the bare stem.
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/vr.md'))).toBe(false);
    const tombstones = await fse.readFile(path.join(repoPath, 'agents', '.removed'), 'utf-8');
    expect(tombstones.split('\n')).toContain('fe/vr');
    // Agents deploy flattened, so a bare `vr` tombstone would suppress and
    // delete be/vr the moment that namespace became active.
    expect(tombstones.split('\n')).not.toContain('vr');
  });

  it('keeps the flattened local copy when no record proves it is this agent\'s', async () => {
    // Agents deploy flattened, so ~/.claude/agents/vr.md could be be/vr's
    // deployment. Without a record, removing fe/vr must not take it.
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\ndescription: A\ninstructions: A.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/vr.md'), '# some other namespace copy');

    await handler.removeItem('fe/vr', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(repoPath, 'agents/fe/vr.yaml'))).toBe(false);
    expect(await fse.readFile(path.join(homeDir, '.claude/agents/vr.md'), 'utf-8'))
      .toBe('# some other namespace copy');
  });

  /**
   * Single-repo mode: the canonical source is the repo's own .teamai/agents/,
   * picked up directly rather than reverse-parsed. Both the placement record
   * and removal have to reach it (#649 review).
   */
  describe('single-repo mode canonical sources', () => {
    function selfConfig(): LocalConfig {
      return { ...localConfig, repo: { ...localConfig.repo, kind: 'self' }, projectRoot: tmpDir };
    }

    it('follows the record for a root canonical source placed in a namespace', async () => {
      const self = selfConfig();
      await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'),
        'name: vr\ndescription: Published\ninstructions: Read it.\n');
      await fse.outputFile(path.join(tmpDir, '.teamai/agents/vr.yaml'),
        'name: vr\ndescription: Published\ninstructions: Edited locally.\n');
      await fse.outputJson(path.join(getDataHome(self), 'state.json'), {
        placedAgents: { vr: 'agents/fe/vr.yaml' },
      });

      const items = await handler.scanLocalForPush(teamConfig, self);

      // Without the record this reads as new, and the collision check then
      // refuses the very agent this machine published.
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe('modified');
      expect(items[0]?.relativePath).toBe('agents/fe/vr.yaml');
    });

    it('holds a root canonical source that is an older version of the placed file', async () => {
      // Nothing refreshes .teamai/agents/vr.yaml after placement: a teammate's
      // later edit leaves it an old copy nobody edited, and pushing it would
      // revert that edit (#649 review).
      const self = selfConfig();
      const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
        ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
      } });
      const placedFile = path.join(repoPath, 'agents/fe/vr.yaml');
      const asPlaced = 'name: vr\ndescription: Published\ninstructions: As placed.\n';
      run(['init', '-q', '-b', 'main']);
      await fse.outputFile(placedFile, asPlaced);
      run(['add', '-A']); run(['commit', '-q', '-m', 'placement merged']);
      await fse.outputFile(placedFile, 'name: vr\ndescription: Published\ninstructions: A teammate improved this.\n');
      run(['add', '-A']); run(['commit', '-q', '-m', 'teammate edit']);
      await fse.outputFile(path.join(tmpDir, '.teamai/agents/vr.yaml'), asPlaced);
      await fse.outputJson(path.join(getDataHome(self), 'state.json'), { placedAgents: { vr: 'agents/fe/vr.yaml' } });

      const items = await handler.scanLocalForPush(teamConfig, self);

      expect(items).toHaveLength(1);
      expect(items[0]?.skipReason).toContain('is an older version of agents/fe/vr.yaml');
    });

    it('follows a renamed canonical source to its new extension and retires the recorded file', async () => {
      const self = selfConfig();
      // Recorded and published as legacy .md; the author has since rewritten it as .yaml.
      await fse.outputFile(path.join(repoPath, 'agents/fe/vr.md'), '# vr\nLegacy body.\n');
      await fse.outputFile(path.join(tmpDir, '.teamai/agents/vr.yaml'),
        'name: vr\ndescription: Rewritten\ninstructions: Read it.\n');
      await fse.outputJson(path.join(getDataHome(self), 'state.json'), {
        placedAgents: { vr: 'agents/fe/vr.md' },
      });

      const items = await handler.scanLocalForPush(teamConfig, self);

      // Keeping the recorded .md as relativePath made pushGroup stage a path
      // pushItem never wrote — the .yaml went unstaged and the .md stayed.
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe('modified');
      expect(items[0]?.relativePath).toBe('agents/fe/vr.yaml');
      expect(items[0]).toMatchObject({ supersedes: 'agents/fe/vr.md' });

      await handler.pushItem(items[0]!, teamConfig, self);

      expect(await fse.pathExists(path.join(repoPath, 'agents/fe/vr.yaml'))).toBe(true);
      expect(await fse.pathExists(path.join(repoPath, 'agents/fe/vr.md'))).toBe(false);
    });

    it('removes the canonical source so the agent cannot republish itself', async () => {
      const self = selfConfig();
      await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\ndescription: A\ninstructions: A.\n');
      await fse.outputFile(path.join(tmpDir, '.teamai/agents/vr.yaml'), 'name: vr\ndescription: A\ninstructions: A.\n');
      await fse.outputJson(path.join(getDataHome(self), 'state.json'), {
        placedAgents: { vr: 'agents/fe/vr.yaml' },
      });

      await handler.removeItem('fe/vr', teamConfig, self);

      // A bare-stem tombstone cannot cover this without suppressing the same
      // stem in every other namespace, because agents deploy flattened.
      expect(await fse.pathExists(path.join(tmpDir, '.teamai/agents/vr.yaml'))).toBe(false);
    });
  });

  it('still removes a bare stem from every namespace', async () => {
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\ndescription: A\ninstructions: A.\n');
    await fse.outputFile(path.join(repoPath, 'agents/other/vr.yaml'), 'name: vr\ndescription: B\ninstructions: B.\n');

    await handler.removeItem('vr', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(repoPath, 'agents/fe/vr.yaml'))).toBe(false);
    expect(await fse.pathExists(path.join(repoPath, 'agents/other/vr.yaml'))).toBe(false);
  });

  it('publishes into the requested namespace despite a stem in an inactive one', async () => {
    await nothingActive();
    await fse.outputFile(path.join(repoPath, 'agents/other-ns/reviewer.yaml'),
      'name: reviewer\ndescription: Somebody else\'s\ninstructions: Read other-ns.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Mine\n---\n\nYou review the front end.\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig, { namespace: 'fe-agents' });

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toBeUndefined();
    // New at the shared root; placement then writes it to the requested namespace.
    expect(items[0]?.status).toBe('new');
  });

  it('refuses to place onto a requested namespace\'s agent that was never delivered here', async () => {
    // Neither active nor recorded, so this local file is not a copy of
    // fe-agents/reviewer: it is new, and pushing it there would overwrite
    // somebody else's agent — which rules already refuse (#649 review).
    await nothingActive();
    await fse.outputFile(path.join(repoPath, 'agents/other-ns/reviewer.yaml'),
      'name: reviewer\ndescription: Somebody else\'s\ninstructions: Read other-ns.\n');
    const requested = path.join(repoPath, 'agents/fe-agents/reviewer.yaml');
    const theirs = 'name: reviewer\ndescription: Theirs\ninstructions: Read it.\n';
    await fse.outputFile(requested, theirs);
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Mine\n---\n\nMy own agent.\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig, { namespace: 'fe-agents' });

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toContain('agents/fe-agents/reviewer.yaml already exists');
    for (const item of items) await handler.pushItem(item, teamConfig, localConfig);
    expect(await fse.readFile(requested, 'utf8')).toBe(theirs);
  });

  it('keeps two active same-stem agents ambiguous even when a flag names one of them', async () => {
    // pull reports the collision and leaves `vr` as common's copy; under
    // --role fe that copy must not be read as an edit of fe/vr (#649 review).
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: base\n    resources:\n      agents: [common, fe]\n');
    localConfig.projects = ['base'];
    const common = { name: 'vr', type: 'agents' as const, sourcePath: path.join(repoPath, 'agents/common/vr.yaml'), relativePath: 'agents/common/vr.yaml' };
    await fse.outputFile(common.sourcePath, 'name: vr\ndescription: Common\ninstructions: Read common.\n');
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\ndescription: Front\ninstructions: Read fe.\n');
    await handler.pullItem(common, teamConfig, localConfig);

    const items = await handler.scanLocalForPush(teamConfig, localConfig, { namespace: 'fe' });

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toContain('Ambiguous agent "vr"');
  });

  it('sends an agent awaiting review as a placement back to its PR, despite a same stem elsewhere', async () => {
    // Without a flag, a stem existing only in an inactive namespace is "no
    // active source" — but this one is this machine's, placed and under review.
    await nothingActive();
    await fse.outputFile(path.join(repoPath, 'agents/other-ns/vr.yaml'), 'name: vr\ndescription: Other\ninstructions: x\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/vr.md'), '---\nname: vr\ndescription: Mine\n---\n\nEdited.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      pendingPushes: [{ branch: 'teamai/push/me/1', prUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe', placed: true, blob: 'b10b' }] }],
    });

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toBeUndefined();
    expect(items[0]?.status).toBe('new');
  });

  it('edits the shared-root agent it was deployed from, never a namespaced second copy', async () => {
    // The root copy reaches every member, so the local file is its copy; a
    // namespaced second one would leave two active agents of that name.
    await fse.outputFile(path.join(repoPath, 'agents/reviewer.yaml'),
      'name: reviewer\ndescription: Shared\ninstructions: Read it.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Shared\n---\n\nEdited locally.\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig, { namespace: 'fe-agents' });

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toBeUndefined();
    expect(items[0]?.status).toBe('modified');
    expect(items[0]?.relativePath).toBe('agents/reviewer.yaml');
  });

  it('compares a deployed agent with its active source, not with the requested namespace\'s file', async () => {
    // common is active and delivered `vr`; fe/vr is another agent, inactive
    // here. `push --role fe` must not read the untouched common copy as an
    // edit of fe/vr and write it over that file (#649 review).
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: base\n    resources:\n      agents: [common]\n');
    localConfig.projects = ['base'];
    const common = { name: 'vr', type: 'agents' as const, sourcePath: path.join(repoPath, 'agents/common/vr.yaml'), relativePath: 'agents/common/vr.yaml' };
    await fse.outputFile(common.sourcePath, 'name: vr\ndescription: Common\ninstructions: Read common.\n');
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\ndescription: Front\ninstructions: Read fe.\n');
    await handler.pullItem(common, teamConfig, localConfig);

    expect(await handler.scanLocalForPush(teamConfig, localConfig, { namespace: 'fe' })).toEqual([]);
  });

  /**
   * The record lets the author edit an agent in a namespace this directory
   * never activates — which also means `pull` never refreshed a copy of it, and
   * the pre-push sync covers rules and skills but not agents. Pushing a stale
   * rendering over a teammate's newer canonical file is the risk (#649 review).
   */
  /**
   * Delivery and revocation are two halves of the same decision. When only
   * delivery knew about the placement record, `pull` wrote the agent and the
   * revocation pass deleted it again in the same run — so the record-based
   * delivery was inert and the file churned on every pull.
   */
  it('does not revoke an agent this machine published into an inactive namespace', async () => {
    const sourcePath = path.join(repoPath, 'agents/fe-agents/reviewer.yaml');
    await fse.outputFile(sourcePath, 'name: reviewer\ndescription: Mine\ninstructions: Read it.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { reviewer: 'agents/fe-agents/reviewer.yaml' },
    });
    // Deploy it the way pull would.
    await handler.pullItem(
      { name: 'reviewer', type: 'agents', sourcePath, relativePath: 'agents/fe-agents/reviewer.yaml', namespace: 'fe-agents' },
      teamConfig, localConfig,
    );
    const deployed = path.join(homeDir, '.claude/agents/reviewer.md');
    expect(await fse.pathExists(deployed)).toBe(true);

    // `fe-agents` is not active; only the record keeps this agent here.
    await handler.cleanupInactiveNamespaces(teamConfig, localConfig, ['common']);

    expect(await fse.pathExists(deployed)).toBe(true);
  });

  it('still revokes an agent whose namespace went inactive with no record', async () => {
    const sourcePath = path.join(repoPath, 'agents/fe-agents/reviewer.yaml');
    await fse.outputFile(sourcePath, 'name: reviewer\ndescription: Theirs\ninstructions: Read it.\n');
    await handler.pullItem(
      { name: 'reviewer', type: 'agents', sourcePath, relativePath: 'agents/fe-agents/reviewer.yaml', namespace: 'fe-agents' },
      teamConfig, localConfig,
    );
    const deployed = path.join(homeDir, '.claude/agents/reviewer.md');
    expect(await fse.pathExists(deployed)).toBe(true);

    await handler.cleanupInactiveNamespaces(teamConfig, localConfig, ['common']);

    expect(await fse.pathExists(deployed)).toBe(false);
  });

  it('prefers an active source over the placement record', async () => {
    // The record is a FALLBACK. When an active namespace holds this stem, that
    // is the agent deployed here — and the one pull delivers.
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: active\n    resources:\n      agents: [common]\n');
    localConfig.projects = ['active'];
    await fse.outputFile(path.join(repoPath, 'agents/common/reviewer.yaml'),
      'name: reviewer\ndescription: Active\ninstructions: Read common.\n');
    await fse.outputFile(path.join(repoPath, 'agents/fe-agents/reviewer.yaml'),
      'name: reviewer\ndescription: Recorded\ninstructions: Read fe.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Active\n---\n\nEdited locally.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { reviewer: 'agents/fe-agents/reviewer.yaml' },
    });

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toBeUndefined();
    expect(items[0]?.relativePath).toBe('agents/common/reviewer.yaml');
  });

  it('pushes a recorded agent whose canonical file has not moved', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: inactive\n    resources:\n      agents: [fe-agents]\n');
    const canonical = 'name: reviewer\ndescription: Mine\ninstructions: Read it.\n';
    await fse.outputFile(path.join(repoPath, 'agents/fe-agents/reviewer.yaml'), canonical);
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Mine\n---\n\nEdited locally.\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      lastPullRev: 'abc1234',
      placedAgents: { reviewer: 'agents/fe-agents/reviewer.yaml' },
    });
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from(canonical));

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toBeUndefined();
    expect(items[0]?.relativePath).toBe('agents/fe-agents/reviewer.yaml');
  });

  it('still skips an inactive agent this machine never published', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: inactive\n    resources:\n      agents: [fe-agents]\n');
    await fse.outputFile(path.join(repoPath, 'agents/fe-agents/reviewer.yaml'),
      'name: reviewer\ndescription: Somebody else\'s\ninstructions: Read it.\n');
    await fse.outputFile(path.join(homeDir, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Somebody else\'s\n---\n\nEdited locally.\n');
    // A record for a DIFFERENT agent must not widen this one.
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      placedAgents: { other: 'agents/fe-agents/other.yaml' },
    });

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items).toHaveLength(1);
    expect(items[0]?.skipReason).toContain('no active source');
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

  it('scanLocalForPush reads a namespaced tombstone as the flattened stem once no namespace has it', async () => {
    // Every member holds `fe/vr` as `<agents>/vr`. After the removal the only
    // tombstone is `fe/vr`, and without reading it as `vr` the copy is new.
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'fe/vr\n');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'vr.md'), '---\nname: vr\ndescription: d\n---\n\nold\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);

    expect(items.find((i) => i.name === 'vr')).toBeUndefined();
    expect(await handler.removedStems(teamConfig, localConfig)).toEqual(new Set(['fe/vr', 'vr']));
  });

  it('keeps the flattened stem live while this directory still receives an agent of that stem', async () => {
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'fe/vr\n');
    await fse.ensureDir(path.join(repoPath, 'agents', 'be'));
    await fse.writeFile(path.join(repoPath, 'agents', 'be', 'vr.yaml'), 'name: vr\ndescription: be\ninstructions: x\n');

    // No roles or projects here, so be/vr is delivered, and `vr` is its copy:
    // suppressing it would block editing be/vr.
    expect(await handler.removedStems(teamConfig, localConfig)).toEqual(new Set(['fe/vr']));
  });

  it('leaves a same-named agent alone on a member who never had the removed agent\'s namespace', async () => {
    // An ops member's own `vr` was never fe/vr's copy: removing fe/vr must not
    // delete it on pull or stop them pushing it (#649 review).
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: ops\n    resources:\n      agents: [ops]\n  - id: front\n    resources:\n      agents: [fe]\n');
    localConfig.projects = ['ops'];
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'fe/vr\n');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'vr.md'), '---\nname: vr\ndescription: mine\n---\n\nMine.\n');

    expect(await handler.removedStems(teamConfig, localConfig)).toEqual(new Set(['fe/vr']));
    expect((await handler.scanLocalForPush(teamConfig, localConfig)).map((i) => i.name)).toContain('vr');
  });

  it('retires the flattened stem of an agent this machine placed, after its record was dropped', async () => {
    // The author's fe was never active; the record said their `vr` was fe/vr.
    // Once the removal merged, reconcile dropped the record and retired it.
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: front\n    resources:\n      agents: [fe]\n');
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'fe/vr\n');
    await fse.outputJson(path.join(getDataHome(localConfig), 'state.json'), {
      retiredPlacedAgents: { vr: 'agents/fe/vr.yaml' },
    });

    expect(await handler.removedStems(teamConfig, localConfig)).toEqual(new Set(['fe/vr', 'vr']));
  });

  it('retires the flattened stem when the surviving same-stem agent is not active here', async () => {
    // An fe member: fe/vr is removed, be/vr survives but is not theirs, so the
    // `vr` they hold is the removed fe/vr, not a copy of be/vr (#649 review).
    await fse.outputFile(path.join(repoPath, 'manifest/projects.yaml'),
      'version: 1\nprojects:\n  - id: front\n    resources:\n      agents: [fe]\n  - id: back\n    resources:\n      agents: [be]\n');
    localConfig.projects = ['front'];
    await fse.writeFile(path.join(repoPath, 'agents', '.removed'), 'fe/vr\n');
    await fse.outputFile(path.join(repoPath, 'agents/be/vr.yaml'), 'name: vr\ndescription: be\ninstructions: x\n');
    await fse.writeFile(path.join(homeDir, '.claude/agents', 'vr.md'), '---\nname: vr\ndescription: d\n---\n\nold fe\n');

    expect(await handler.removedStems(teamConfig, localConfig)).toEqual(new Set(['fe/vr', 'vr']));
    expect((await handler.scanLocalForPush(teamConfig, localConfig, { namespace: 'fe' })).find((i) => i.name === 'vr'))
      .toBeUndefined();
  });

  it('scanLocalForPush does not publish the copy an excluded tool still holds', async () => {
    // `removeItem` leaves an excluded tool's copy alone, and a namespaced
    // removal tombstones only `<ns>/<stem>`: were this copy read, the next push
    // would republish the agent the author just removed (#649 review).
    await fse.writeFile(
      path.join(homeDir, '.codebuddy/agents', 'vr.md'),
      '---\nname: vr\ndescription: reviews code\n---\n\nYou review.\n',
    );

    const items = await handler.scanLocalForPush(teamConfig, { ...localConfig, enabledAgents: ['claude'] });

    expect(items.find((i) => i.name === 'vr')).toBeUndefined();
  });
});
