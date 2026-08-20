import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { EnvHandler } from '../resources/env.js';
import { AgentsHandler } from '../resources/agents.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

/**
 * Single-repo mode: users drop env/agents straight into <repo>/.teamai/{env,agents}.
 * push runs in the knowledge worktree, so localConfig.repo.localPath is the
 * origin/<default> checkout (the diff baseline) while projectRoot is the active
 * tree. These tests mirror that exact shape.
 */
describe('single-repo mode: env + agents direct .teamai scan', () => {
  let tmp: string;
  let bizRoot: string;       // active tree (projectRoot)
  let worktreeTeamai: string; // baseline (localConfig.repo.localPath = <wt>/.teamai)
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-selfea-'));
    bizRoot = path.join(tmp, 'biz');
    worktreeTeamai = path.join(tmp, 'biz', '.teamai', 'knowledge-wt', '.teamai');
    await fse.ensureDir(path.join(bizRoot, '.teamai', 'env'));
    await fse.ensureDir(path.join(bizRoot, '.teamai', 'agents'));
    await fse.ensureDir(path.join(worktreeTeamai, 'env'));
    await fse.ensureDir(path.join(worktreeTeamai, 'agents'));

    teamConfig = {
      team: 't', description: '', repo: 'https://github.com/acme/app.git',
      provider: 'github' as const, reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { agents: '.claude/agents' } },
    };
    localConfig = {
      repo: {
        localPath: worktreeTeamai,
        remote: 'https://github.com/acme/app.git',
        kind: 'self',
        businessRepoRoot: path.join(tmp, 'biz', '.teamai', 'knowledge-wt'),
      },
      username: 'alice',
      scope: 'project',
      projectRoot: bizRoot,
      additionalRoles: [],
    };
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  // ── env ────────────────────────────────────────────────────────────────
  it('env: detects a hand-placed .teamai/env/env.yaml as pushable', async () => {
    await fse.writeFile(
      path.join(bizRoot, '.teamai', 'env', 'env.yaml'),
      'variables:\n  - key: API_BASE\n    value: https://api.example.com\n',
    );
    const items = await new EnvHandler().scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('env');
    expect(items[0].sourcePath).toBe(path.join(bizRoot, '.teamai', 'env', 'env.yaml'));
  });

  it('env: skips when active copy equals the committed baseline', async () => {
    const content = 'variables:\n  - key: A\n    value: "1"\n';
    await fse.writeFile(path.join(bizRoot, '.teamai', 'env', 'env.yaml'), content);
    await fse.writeFile(path.join(worktreeTeamai, 'env', 'env.yaml'), content);
    const items = await new EnvHandler().scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(0);
  });

  it('env: detects an edit vs the baseline as pushable', async () => {
    await fse.writeFile(path.join(worktreeTeamai, 'env', 'env.yaml'), 'variables:\n  - key: A\n    value: "1"\n');
    await fse.writeFile(path.join(bizRoot, '.teamai', 'env', 'env.yaml'), 'variables:\n  - key: A\n    value: "2"\n');
    const items = await new EnvHandler().scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(1);
  });

  it('env: pushItem copies the active env.yaml into the worktree', async () => {
    const active = path.join(bizRoot, '.teamai', 'env', 'env.yaml');
    await fse.writeFile(active, 'variables:\n  - key: X\n    value: "y"\n');
    const [item] = await new EnvHandler().scanLocalForPush(teamConfig, localConfig);
    await new EnvHandler().pushItem(item, teamConfig, localConfig);
    const committed = await fse.readFile(path.join(worktreeTeamai, 'env', 'env.yaml'), 'utf8');
    expect(committed).toContain('key: X');
  });

  // Regression: a teammate who clones a self-mode repo has .teamai/env/ as a
  // committed DIRECTORY (holding env.yaml). pullItem must NOT try to write its
  // KEY=value backup at <teamaiHome>/env (that path is the dir → EISDIR). It must
  // use env.local instead. This is the pull/consumer half the push-only E2E missed.
  it('env: pullItem does not EISDIR-crash when .teamai/env is a directory (writes env.local)', async () => {
    // Simulate the teammate: teamaiHome = <projectRoot>/.teamai, with env/ a real dir.
    const pullConfig: LocalConfig = {
      ...localConfig,
      repo: { ...localConfig.repo, localPath: path.join(bizRoot, '.teamai') },
    };
    const envYaml = path.join(bizRoot, '.teamai', 'env', 'env.yaml');
    await fse.ensureDir(path.dirname(envYaml));
    await fse.writeFile(envYaml, 'variables:\n  - key: TEAM_API\n    value: https://api.example.com\n');
    const item = {
      name: 'env.yaml', type: 'env' as const,
      sourcePath: envYaml, relativePath: 'env/env.yaml',
    };
    // Disable shell-profile injection so the test has no side effects on the host.
    const noInject: TeamaiConfig = {
      ...teamConfig,
      sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } },
    };
    // Must not throw (previously threw EISDIR on <teamaiHome>/env).
    await expect(
      new EnvHandler().pullItem(item, noInject, pullConfig),
    ).resolves.not.toThrow();
    // Backup landed at env.local, NOT clobbering the env/ directory.
    const backup = await fse.readFile(path.join(bizRoot, '.teamai', 'env.local'), 'utf8');
    expect(backup).toContain('TEAM_API=https://api.example.com');
    expect((await fse.stat(path.join(bizRoot, '.teamai', 'env'))).isDirectory()).toBe(true);
  });

  // ── agents ─────────────────────────────────────────────────────────────
  it('agents: picks up a canonical .yaml placed in .teamai/agents as new', async () => {
    await fse.writeFile(
      path.join(bizRoot, '.teamai', 'agents', 'reviewer.yaml'),
      'name: reviewer\ndescription: Reviews code\n',
    );
    const items = await new AgentsHandler().scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'reviewer');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
    expect(item!.relativePath).toBe('agents/reviewer.yaml');
    expect(item!.legacy).toBe(false);
  });

  it('agents: picks up a legacy .md as legacy=true', async () => {
    await fse.writeFile(path.join(bizRoot, '.teamai', 'agents', 'helper.md'), '# Helper\n');
    const items = await new AgentsHandler().scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'helper');
    expect(item).toBeDefined();
    expect(item!.legacy).toBe(true);
    expect(item!.relativePath).toBe('agents/helper.md');
  });

  it('agents: skips a canonical file identical to the baseline', async () => {
    const content = 'name: same\ndescription: d\n';
    await fse.writeFile(path.join(worktreeTeamai, 'agents', 'same.yaml'), content);
    await fse.writeFile(path.join(bizRoot, '.teamai', 'agents', 'same.yaml'), content);
    const items = await new AgentsHandler().scanLocalForPush(teamConfig, localConfig);
    expect(items.map((i) => i.name)).not.toContain('same');
  });

  it('agents: pushItem preserves the .yaml extension (no .md corruption)', async () => {
    await fse.writeFile(
      path.join(bizRoot, '.teamai', 'agents', 'canon.yaml'),
      'name: canon\ndescription: d\n',
    );
    const [item] = await new AgentsHandler().scanLocalForPush(teamConfig, localConfig);
    await new AgentsHandler().pushItem(item, teamConfig, localConfig);
    expect(await fse.pathExists(path.join(worktreeTeamai, 'agents', 'canon.yaml'))).toBe(true);
    expect(await fse.pathExists(path.join(worktreeTeamai, 'agents', 'canon.md'))).toBe(false);
  });
});
