import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, syncWorkflowDefinitions } from '../workflow/cache.js';

const dirs: string[] = [];

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-ns-test-'));
  dirs.push(root);
  const repo = path.join(root, 'team-repo');
  fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'prompts'), { recursive: true });
  return {
    repo: { localPath: repo, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initializeGit(repoDir: string): (msg: string) => string {
  git(repoDir, 'init', '--initial-branch=main');
  git(repoDir, 'config', 'user.name', 'TeamAI Test');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  return (msg: string) => {
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '--allow-empty', '-m', msg);
    return git(repoDir, 'rev-parse', 'HEAD');
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const WORKFLOW_A = `schemaVersion: v1alpha1
name: deploy
description: Deploy from namespace A.
steps:
  - id: step-a
    command: echo "deploying A"
`;

const WORKFLOW_B = `schemaVersion: v1alpha1
name: deploy
description: Deploy from namespace B.
steps:
  - id: step-b
    command: echo "deploying B"
`;

const SHARED_WORKFLOW = `schemaVersion: v1alpha1
name: deploy
description: Deploy from shared root.
steps:
  - id: step-shared
    command: echo "deploying shared"
`;

describe('workflow and prompt namespaces in cache', () => {
  it('lets a namespaced workflow override the shared root in legacy unfiltered mode', async () => {
    const config = testConfig();
    const repo = config.repo.localPath;
    const commit = initializeGit(repo);

    fs.writeFileSync(path.join(repo, 'workflows', 'deploy.yaml'), SHARED_WORKFLOW);
    fs.mkdirSync(path.join(repo, 'workflows', 'ops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'ops', 'deploy.yaml'), WORKFLOW_A);
    commit('add legacy shared and namespaced workflows');

    const result = await syncWorkflowDefinitions(config);
    expect(result.invalid).toEqual([]);
    expect((await loadCachedWorkflow(config, 'deploy'))?.definition.description)
      .toBe('Deploy from namespace A.');
  });

  it('drops conflicting namespaced workflows in legacy unfiltered mode', async () => {
    const config = testConfig();
    const repo = config.repo.localPath;
    const commit = initializeGit(repo);

    fs.mkdirSync(path.join(repo, 'workflows', 'ops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'ops', 'deploy.yaml'), WORKFLOW_A);
    fs.mkdirSync(path.join(repo, 'workflows', 'devops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'devops', 'deploy.yaml'), WORKFLOW_B);
    commit('add conflicting legacy namespaced workflows');

    const result = await syncWorkflowDefinitions(config);
    expect(result.invalid.some((diagnostic) => diagnostic.code === 'workflow_namespace_conflict'))
      .toBe(true);
    expect(await loadCachedWorkflow(config, 'deploy')).toBeNull();
  });

  it('discovers and loads namespaced workflows from workflows/<ns>/<name>.yaml', async () => {
    const config = testConfig();
    const repo = config.repo.localPath;
    const commit = initializeGit(repo);

    // Setup active namespaces manifest
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      `version: 1
projects:
  - id: infra
    name: Infra
    resources:
      workflows: [ops]
`
    );
    config.projects = ['infra'];

    // Write namespaced workflow under workflows/ops/deploy.yaml
    fs.mkdirSync(path.join(repo, 'workflows', 'ops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'ops', 'deploy.yaml'), WORKFLOW_A);

    commit('add ops deploy workflow');

    const result = await syncWorkflowDefinitions(config);
    expect(result.invalid).toEqual([]);

    const loaded = await loadCachedWorkflow(config, 'deploy');
    expect(loaded).not.toBeNull();
    expect(loaded?.definition.description).toBe('Deploy from namespace A.');
  });

  it('namespaced workflow takes precedence over shared root workflow when namespace is active', async () => {
    const config = testConfig();
    const repo = config.repo.localPath;
    const commit = initializeGit(repo);

    // Setup active namespaces
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      `version: 1
projects:
  - id: infra
    name: Infra
    resources:
      workflows: [ops]
`
    );
    config.projects = ['infra'];

    // Write shared workflow at workflows/deploy.yaml
    fs.writeFileSync(path.join(repo, 'workflows', 'deploy.yaml'), SHARED_WORKFLOW);
    // Write namespaced workflow at workflows/ops/deploy.yaml
    fs.mkdirSync(path.join(repo, 'workflows', 'ops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'ops', 'deploy.yaml'), WORKFLOW_A);

    commit('add shared and ops workflows');

    const result = await syncWorkflowDefinitions(config);
    expect(result.invalid).toEqual([]);

    const loaded = await loadCachedWorkflow(config, 'deploy');
    expect(loaded).not.toBeNull();
    // Namespaced version wins over root shared version
    expect(loaded?.definition.description).toBe('Deploy from namespace A.');
  });

  it('drops workflow and records diagnostic when two active namespaces conflict', async () => {
    const config = testConfig();
    const repo = config.repo.localPath;
    const commit = initializeGit(repo);

    // Setup two active namespaces declaring different namespaces for workflows
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      `version: 1
projects:
  - id: infra
    name: Infra
    resources:
      workflows: [ops, devops]
`
    );
    config.projects = ['infra'];

    // Write workflows/ops/deploy.yaml and workflows/devops/deploy.yaml
    fs.mkdirSync(path.join(repo, 'workflows', 'ops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'ops', 'deploy.yaml'), WORKFLOW_A);
    fs.mkdirSync(path.join(repo, 'workflows', 'devops'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'devops', 'deploy.yaml'), WORKFLOW_B);

    commit('add conflicting workflows');

    const result = await syncWorkflowDefinitions(config);
    // Should produce diagnostic for conflict
    expect(result.invalid.length).toBeGreaterThan(0);
    const conflictDiag = result.invalid.find((d) => d.code === 'workflow_namespace_conflict');
    expect(conflictDiag).toBeDefined();
    expect(conflictDiag?.message).toContain('deploy');

    // Conflicted workflow must be dropped from cache
    const loaded = await loadCachedWorkflow(config, 'deploy');
    expect(loaded).toBeNull();
  });

  it('ignores workflows in namespaces that are not active', async () => {
    const config = testConfig();
    const repo = config.repo.localPath;
    const commit = initializeGit(repo);

    // Only "team-x" is active
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      `version: 1
projects:
  - id: team-x
    name: Team X
    resources:
      workflows: [ns-x]
`
    );
    config.projects = ['team-x'];

    // Write workflow in inactive namespace "ns-other"
    fs.mkdirSync(path.join(repo, 'workflows', 'ns-other'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'workflows', 'ns-other', 'deploy.yaml'), WORKFLOW_B);

    commit('add inactive workflow');

    const result = await syncWorkflowDefinitions(config);
    expect(result.invalid).toEqual([]);

    const loaded = await loadCachedWorkflow(config, 'deploy');
    expect(loaded).toBeNull();
  });
});
