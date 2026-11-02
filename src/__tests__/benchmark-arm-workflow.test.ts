import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinArmWorkflow } from '../benchmark/arm-workflow.js';
import type { PlannedArm } from '../benchmark/plan.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FIXER = `schemaVersion: v1alpha1
name: fixer
description: Fix through another workflow.
inputs: { task: string }
steps:
  - id: fix
    workflow: fix-once
`;
const FIX_ONCE = `schemaVersion: v1alpha1
name: fix-once
description: Fix it.
steps:
  - id: fix
    prompt: Fix it.
`;
const ARM: PlannedArm = { name: 'flow', tool: 'claude', source: 'team', team: { kind: 'pulled', revision: 'c'.repeat(40) } };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A member of project infra, which receives the workflows of `namespaces`, in a git team whose commit holds `files`;
 * and that commit.
 */
function teamAt(namespaces: readonly string[], files: Record<string, string>): { config: LocalConfig; revision: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-arm-workflow-'));
  dirs.push(root);
  const repo = path.join(root, 'team');
  const all = {
    'teamai.yaml': 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: git\n',
    'manifest/projects.yaml': `version: 1\nprojects:\n  - id: infra\n    name: Infra\n    resources:\n      workflows: [${namespaces.join(', ')}]\n`,
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed');
  return {
    config: {
      repo: { localPath: repo, remote: 'https://github.com/acme/team.git', kind: 'git' },
      username: 'tester', scope: 'project', additionalRoles: [], projects: ['infra'], projectRoot: root, dataHome: path.join(root, 'data'),
    },
    revision: git(repo, 'rev-parse', 'HEAD'),
  };
}

describe('pinArmWorkflow', () => {
  it('finds an arm workflow and its sub-workflow in a namespace the member receives', async () => {
    const { config, revision } = teamAt(['ops'], { 'workflows/ops/fixer.yaml': FIXER, 'workflows/ops/fix-once.yaml': FIX_ONCE });

    const pinned = await pinArmWorkflow(config, { arm: ARM, name: 'fixer', revision, unattended: false });

    expect(pinned.ok && Object.keys(pinned.pinned.files).map((key) => key.replace(/\.[0-9a-f]{12}$/, '')).sort()).toEqual(['fix-once', 'fixer']);
  });

  it('copies the prompts of an arm workflow and its sub-workflow unattended only when the trials may run unattended', async () => {
    const files = { 'workflows/ops/fixer.yaml': FIXER, 'workflows/ops/fix-once.yaml': FIX_ONCE.replace('prompt: Fix it.', 'prompt: Fix it.\n    permissions: unattended') };
    const prompts = async (unattended: boolean): Promise<unknown[]> => {
      const { config, revision } = teamAt(['ops'], files);
      const pinned = await pinArmWorkflow(config, { arm: ARM, name: 'fixer', revision, unattended });
      if (!pinned.ok) throw new Error(pinned.message);
      return Object.entries(pinned.pinned.files).filter(([key]) => key.startsWith('fix-once.')).flatMap(([, file]) => (Array.isArray(file.steps) ? file.steps : []));
    };

    expect(await prompts(true)).toEqual([{ id: 'fix', prompt: 'Fix it.', tool: 'claude', permissions: 'unattended' }]);
    expect(await prompts(false)).toEqual([{ id: 'fix', prompt: 'Fix it.', tool: 'claude' }]);
  });

  it('refuses an arm workflow that two namespaces the member receives define', async () => {
    const { config, revision } = teamAt(['ops', 'devops'], {
      'workflows/ops/fixer.yaml': FIXER, 'workflows/devops/fixer.yaml': FIXER, 'workflows/fix-once.yaml': FIX_ONCE,
    });

    const pinned = await pinArmWorkflow(config, { arm: ARM, name: 'fixer', revision, unattended: false });

    expect(pinned).toMatchObject({ ok: false, code: 'workflow_namespace_conflict', message: expect.stringMatching(/^Arm "flow" runs workflow "fixer", which /) });
    expect(!pinned.ok && pinned.message).toContain('workflows/ops/fixer.yaml');
    expect(!pinned.ok && pinned.message).toContain('workflows/devops/fixer.yaml');
  });

  it('refuses an arm workflow whose sub-workflow two namespaces the member receives define', async () => {
    const { config, revision } = teamAt(['ops', 'devops'], {
      'workflows/fixer.yaml': FIXER, 'workflows/ops/fix-once.yaml': FIX_ONCE, 'workflows/devops/fix-once.yaml': FIX_ONCE,
    });

    const pinned = await pinArmWorkflow(config, { arm: ARM, name: 'fixer', revision, unattended: false });

    expect(pinned).toMatchObject({ ok: false, code: 'workflow_namespace_conflict', message: expect.stringMatching(/^Arm "flow" runs workflow "fixer", which runs workflow "fix-once", which /) });
    expect(!pinned.ok && pinned.message).toContain('workflows/devops/fix-once.yaml');
  });
});
