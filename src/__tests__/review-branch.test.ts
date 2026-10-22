import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => {
  let silent = false;
  return {
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      dim: vi.fn(),
      persist: vi.fn(),
    },
    spinner: vi.fn(() => ({
      start: vi.fn().mockReturnThis(),
      succeed: vi.fn().mockReturnThis(),
      fail: vi.fn().mockReturnThis(),
    })),
    setSilent(value: boolean) {
      silent = value;
    },
    isSilent() {
      return silent;
    },
  };
});

import { reviewBranchDir, materializeRef, type BranchReview } from '../review-branch.js';

const BRANCH = 'teamai/push/tester/20260101-000000';

function rolesYaml(namespaces: string[]): string {
  return [
    'version: 1',
    'roles:',
    '  - id: dev',
    '    description: dev',
    '    resources:',
    '      knowledge: []',
    `      skills: [${namespaces.join(', ')}]`,
    '      agents: []',
    '',
  ].join('\n');
}

async function writeSkill(repoDir: string, relativeDir: string, body: string): Promise<void> {
  const dir = path.join(repoDir, ...relativeDir.split('/'));
  await fse.ensureDir(dir);
  await fse.writeFile(path.join(dir, 'SKILL.md'), body);
}

async function writeWorkflow(repoDir: string, name: string, body: string): Promise<void> {
  const dir = path.join(repoDir, 'workflows');
  await fse.ensureDir(dir);
  await fse.writeFile(path.join(dir, `${name}.yaml`), body);
}

/** Repo-relative paths, directories marked with a trailing slash. */
async function relativeListing(root: string): Promise<string[]> {
  const listing: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
      const relative = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      listing.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
  };
  await walk(root);
  return listing.sort();
}

const DEPLOY_BAD_NEEDS = [
  'schemaVersion: v1alpha1',
  'name: deploy',
  'description: Ship the release candidate.',
  'steps:',
  '  - id: release',
  '    needs: [biuld]',
  '    command: echo release',
].join('\n');

const VALID_BUILD = [
  'schemaVersion: v1alpha1',
  'name: build',
  'description: Compile the project.',
  'steps:',
  '  - id: compile',
  '    command: node compile.js',
].join('\n');

const MISSING_PROMPT = [
  'schemaVersion: v1alpha1',
  'name: release',
  'description: Publish the release notes.',
  'steps:',
  '  - id: notes',
  '    prompt_file: prompts/release.md',
].join('\n');

function runsWorkflow(name: string, child: string): string {
  return `schemaVersion: v1alpha1
name: ${name}
description: Run ${child}.
steps:
  - id: run
    workflow: ${child}
`;
}

const GOOD_SKILL = [
  '---',
  'name: vr',
  'description: Use this skill when reviewing a merge request for security issues.',
  '---',
  '',
  '# VR',
  '',
].join('\n');

function findings(review: BranchReview) {
  return review.findings;
}

describe('reviewBranchDir — read-only health checks for a pushed branch (#776)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-branch-'));
  });

  afterEach(async () => {
    await fse.remove(repoDir);
  });

  it('passes a clean branch whose namespaced skill is declared and well formed', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/frontend/vr', GOOD_SKILL);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(review.counts).toEqual({ fail: 0, warn: 0, info: 0 });
    expect(findings(review)).toEqual([]);
  });

  it('fails a skill directory with no SKILL.md at its root', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await fse.ensureDir(path.join(repoDir, 'skills', 'frontend', 'vr'));
    await fse.writeFile(path.join(repoDir, 'skills', 'frontend', 'vr', 'notes.md'), '# no SKILL.md here');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'structure' && /no SKILL\.md/.test(f.message))).toBe(true);
  });

  it('fails a resource in a namespace no role or project declares', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/backend/vr', GOOD_SKILL);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'structure' && /namespace "backend"/.test(f.message))).toBe(true);
  });

  it('fails the same resource name in two namespaces that can be active together', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend', 'backend']));
    await writeSkill(repoDir, 'skills/frontend/vr', GOOD_SKILL);
    await writeSkill(repoDir, 'skills/backend/vr', GOOD_SKILL);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'duplicates' && /"vr" is defined in both/.test(f.message))).toBe(true);
  });

  it('does not flag a duplicate when the two namespaces are never co-active', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    // Two roles, each declaring one namespace: a member holds one role, so the
    // two namespaces are never active together.
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: fe',
      '    description: fe',
      '    resources:',
      '      knowledge: []',
      '      skills: [frontend]',
      '      agents: []',
      '  - id: be',
      '    description: be',
      '    resources:',
      '      knowledge: []',
      '      skills: [backend]',
      '      agents: []',
      '',
    ].join('\n'));
    await writeSkill(repoDir, 'skills/frontend/vr', GOOD_SKILL);
    await writeSkill(repoDir, 'skills/backend/vr', GOOD_SKILL);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(findings(review).some((f) => f.check === 'duplicates')).toBe(false);
  });

  it('fails when a skill frontmatter name does not match its directory', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/frontend/vr', [
      '---',
      'name: not-vr',
      'description: Use this skill when reviewing a merge request for security issues.',
      '---',
      '',
      '# VR',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'naming' && /declares the name "not-vr"/.test(f.message))).toBe(true);
  });

  it('warns when a skill has no description explaining when to use it', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/frontend/vr', [
      '---',
      'name: vr',
      '---',
      '',
      '# VR',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(review.counts.warn).toBe(1);
    expect(findings(review).some((f) => f.check === 'format' && /no frontmatter "description"/.test(f.message))).toBe(true);
  });

  it('fails when a resource carries a credential shape', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/frontend/vr', [
      '---',
      'name: vr',
      'description: Use this skill when reviewing a merge request for security issues.',
      '---',
      '',
      'Use the key sk-abcdefghijklmnopqrstuvwx0123456789 to call the API.',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'leaks' && /credential/.test(f.message))).toBe(true);
  });

  it('fails when a resource carries an internal address', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/frontend/vr', [
      '---',
      'name: vr',
      'description: Use this skill when reviewing a merge request for security issues.',
      '---',
      '',
      'Point the client at http://10.12.0.7:8080 before running it.',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'leaks' && /internal address/.test(f.message))).toBe(true);
  });

  it('reports an agent whose frontmatter name does not match its file name', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await fse.ensureDir(path.join(repoDir, 'agents', 'frontend'));
    await fse.writeFile(path.join(repoDir, 'agents', 'frontend', 'reviewer.yaml'), [
      'name: not-reviewer',
      'description: Reviews code.',
      'instructions: Review the code.',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => f.check === 'naming' && /declares the name "not-reviewer"/.test(f.message))).toBe(true);
  });

  it('serializes to the documented --json shape', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend']));
    await writeSkill(repoDir, 'skills/backend/vr', GOOD_SKILL);

    const review = await reviewBranchDir(BRANCH, repoDir);
    const parsed = JSON.parse(JSON.stringify(review)) as BranchReview;

    expect(parsed.branch).toBe(BRANCH);
    expect(parsed.ok).toBe(false);
    expect(parsed.counts).toEqual({ fail: 1, warn: 0, info: 0 });
    expect(Array.isArray(parsed.findings)).toBe(true);
    for (const finding of parsed.findings) {
      expect(['fail', 'warn', 'info']).toContain(finding.level);
      expect(['structure', 'naming', 'duplicates', 'format', 'leaks', 'workflows']).toContain(finding.check);
      expect(typeof finding.message).toBe('string');
    }
  });

  it('fails a workflow whose step needs a step that is not in the file', async () => {
    await writeWorkflow(repoDir, 'deploy', DEPLOY_BAD_NEEDS);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(review.counts.fail).toBe(1);
    expect(review.findings).toEqual([
      {
        level: 'fail',
        check: 'workflows',
        path: 'workflows/deploy.yaml',
        message: 'workflows/deploy.yaml:6: field "steps[0].needs": step "release" needs "biuld", which is not a step in this workflow',
      },
    ]);
  });

  it('passes a valid workflow and leaves the repo listing unchanged', async () => {
    await writeWorkflow(repoDir, 'build', VALID_BUILD);
    const before = await relativeListing(repoDir);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(review.findings).toEqual([]);
    expect(await relativeListing(repoDir)).toEqual(before);
  });

  it('fails a workflow whose prompt file is missing', async () => {
    await writeWorkflow(repoDir, 'release', MISSING_PROMPT);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(review.findings).toEqual([
      {
        level: 'fail',
        check: 'workflows',
        path: 'workflows/release.yaml',
        message: 'workflows/release.yaml:6: field "steps[0].prompt_file": prompt_file "prompts/release.md" must be a readable, non-symlink file under prompts/',
      },
    ]);
  });

  it('fails a workflow and the workflow that runs it when the child has no runnable version', async () => {
    await writeWorkflow(repoDir, 'ship', runsWorkflow('ship', 'check'));
    await writeWorkflow(repoDir, 'check', runsWorkflow('check', 'gone'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(review.findings).toEqual([
      {
        level: 'fail',
        check: 'workflows',
        path: 'workflows/check.yaml',
        message: 'workflows/check.yaml:6: field "steps[0].workflow": step "run" runs workflow "gone", which has no runnable version; fix or add workflows/gone.yaml',
      },
      {
        level: 'fail',
        check: 'workflows',
        path: 'workflows/ship.yaml',
        message: 'workflows/ship.yaml:6: field "steps[0].workflow": step "run" runs workflow "check", which has no runnable version; fix or add workflows/check.yaml',
      },
    ]);
  });
});

describe('materializeRef — branch materialization from git', () => {
  it('extracts workflows, prompts, scorers, and standard roots from git rev', async () => {
    const gitRepo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-git-repo-'));
    const destDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dest-'));
    try {
      execFileSync('git', ['init', '-q', gitRepo]);
      execFileSync('git', ['-C', gitRepo, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', gitRepo, 'config', 'user.email', 'test@example.com']);
      await fse.outputFile(path.join(gitRepo, 'workflows', 'deploy.yaml'), 'name: deploy\n');
      await fse.outputFile(path.join(gitRepo, 'prompts', 'release.md'), '# prompt\n');
      await fse.outputFile(path.join(gitRepo, 'scorers', 'eval.yaml'), 'name: eval\n');
      await fse.outputFile(path.join(gitRepo, 'ignored', 'file.txt'), 'ignore me\n');
      execFileSync('git', ['-C', gitRepo, 'add', '.']);
      execFileSync('git', ['-C', gitRepo, 'commit', '-q', '-m', 'initial']);

      const count = await materializeRef(gitRepo, 'HEAD', destDir);
      expect(count).toBe(3);
      expect(await fse.pathExists(path.join(destDir, 'workflows', 'deploy.yaml'))).toBe(true);
      expect(await fse.pathExists(path.join(destDir, 'prompts', 'release.md'))).toBe(true);
      expect(await fse.pathExists(path.join(destDir, 'scorers', 'eval.yaml'))).toBe(true);
      expect(await fse.pathExists(path.join(destDir, 'ignored', 'file.txt'))).toBe(false);
    } finally {
      await fse.remove(gitRepo);
      await fse.remove(destDir);
    }
  });
  it('preserves symlinks so validators observe symbolic links rather than regular files', async () => {
    const gitRepo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-git-repo-'));
    const destDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dest-'));
    try {
      execFileSync('git', ['init', '-q', gitRepo]);
      execFileSync('git', ['-C', gitRepo, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', gitRepo, 'config', 'user.email', 'test@example.com']);
      await fse.outputFile(path.join(gitRepo, 'prompts', 'target.md'), '# target prompt\n');
      await fse.symlink('target.md', path.join(gitRepo, 'prompts', 'link.md'));
      await fse.outputFile(path.join(gitRepo, 'prompts', 'target.md '), '# spaced target\n');
      await fse.symlink('target.md ', path.join(gitRepo, 'prompts', 'spaced.md'));
      execFileSync('git', ['-C', gitRepo, 'add', '.']);
      execFileSync('git', ['-C', gitRepo, 'commit', '-q', '-m', 'add symlink']);

      const count = await materializeRef(gitRepo, 'HEAD', destDir);
      expect(count).toBe(4);
      const linkStat = await fse.lstat(path.join(destDir, 'prompts', 'link.md'));
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await fse.readlink(path.join(destDir, 'prompts', 'link.md'))).toBe('target.md');
      expect(await fse.readlink(path.join(destDir, 'prompts', 'spaced.md'))).toBe('target.md ');
    } finally {
      await fse.remove(gitRepo);
      await fse.remove(destDir);
    }
  });
});
