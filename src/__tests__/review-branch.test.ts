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

import { localAliasesPath } from '../models/aliases.js';
import { reviewBranchDir, materializeRef, type BranchReview, type Finding } from '../review-branch.js';
import { INVOKE_ALIAS_SINCE } from '../workflow/parse.js';

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

/** A roles manifest whose dev role declares `namespaces` on `axis`. */
function resourcesYaml(axis: string, namespaces: string[]): string {
  return [
    'version: 1',
    'roles:',
    '  - id: dev',
    '    description: dev',
    '    resources:',
    '      knowledge: []',
    '      skills: []',
    '      agents: []',
    `      ${axis}: [${namespaces.join(', ')}]`,
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

const VALID_SCORER = [
  '---',
  'labels:',
  '  - { value: good, score: 1, description: Good. }',
  '  - { value: bad, score: 0, description: Bad. }',
  'passingScore: 1',
  '---',
  'Judge the change.',
  '',
].join('\n');

async function writeScorer(repoDir: string, file: string, body: string): Promise<void> {
  await fse.outputFile(path.join(repoDir, 'scorers', file), body);
}

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

  it('reviews newly placeable resource types for undeclared namespaces', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('workflows', ['frontend']));
    await fse.ensureDir(path.join(repoDir, 'workflows', 'backend'));
    await fse.writeFile(path.join(repoDir, 'workflows', 'backend', 'deploy.yaml'), 'name: deploy\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => (
      f.check === 'structure'
      && f.path === 'workflows/backend/deploy.yaml'
      && /namespace "backend"/.test(f.message)
    ))).toBe(true);
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

  it('passes a nested doc whose first directory is not a declared namespace', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('prompts', ['frontend']));
    await fse.ensureDir(path.join(repoDir, 'docs', 'api'));
    await fse.writeFile(path.join(repoDir, 'docs', 'api', 'guide.md'), '# API guide\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(findings(review)).toEqual([]);
  });

  it('keeps distinct nested doc sub-paths in co-active namespaces from conflicting', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('docs', ['a', 'b']));
    await fse.ensureDir(path.join(repoDir, 'docs', 'a', 'api'));
    await fse.writeFile(path.join(repoDir, 'docs', 'a', 'api', 'guide.md'), '# API guide\n');
    await fse.ensureDir(path.join(repoDir, 'docs', 'b', 'ui'));
    await fse.writeFile(path.join(repoDir, 'docs', 'b', 'ui', 'guide.md'), '# UI guide\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(findings(review)).toEqual([]);
  });

  it('fails the same nested doc sub-path in two co-active namespaces', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('docs', ['a', 'b']));
    await fse.ensureDir(path.join(repoDir, 'docs', 'a', 'api'));
    await fse.writeFile(path.join(repoDir, 'docs', 'a', 'api', 'guide.md'), '# API guide\n');
    await fse.ensureDir(path.join(repoDir, 'docs', 'b', 'api'));
    await fse.writeFile(path.join(repoDir, 'docs', 'b', 'api', 'guide.md'), '# other guide\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => (
      f.check === 'duplicates' && /"api\/guide\.md" is defined in both/.test(f.message)
    ))).toBe(true);
  });

  it('passes a nested prompt whose first directory is not a declared namespace', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('prompts', ['ops']));
    await fse.ensureDir(path.join(repoDir, 'prompts', 'topic'));
    await fse.writeFile(path.join(repoDir, 'prompts', 'topic', 'note.md'), 'Review the change.\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    // Delivered to everyone as a shared nested prompt, so it is context, not a failure.
    expect(review.ok).toBe(true);
    expect(review.counts.fail).toBe(0);
    expect(findings(review).some((f) => f.check === 'naming' && /"topic\/note\.md"/.test(f.message))).toBe(false);
  });

  it('does not flag nested docs that differ only by extension', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('docs', ['a', 'b']));
    await fse.ensureDir(path.join(repoDir, 'docs', 'a', 'api'));
    await fse.writeFile(path.join(repoDir, 'docs', 'a', 'api', 'guide.md'), '# API guide\n');
    await fse.ensureDir(path.join(repoDir, 'docs', 'b', 'api'));
    await fse.writeFile(path.join(repoDir, 'docs', 'b', 'api', 'guide.png'), 'PNG placeholder\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(findings(review).some((f) => f.check === 'duplicates')).toBe(false);
  });

  it('reviews hooks by their entry ids, not their file names', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('hooks', ['a', 'b']));
    for (const ns of ['a', 'b']) await fse.ensureDir(path.join(repoDir, 'hooks', ns));
    await fse.writeFile(path.join(repoDir, 'hooks', 'a', 'hooks.yaml'), [
      'hooks:',
      '  - id: deploy',
      '    description: deploy helper',
      '    event: PreToolUse',
      '    command: ~/.teamai/team-scripts/deploy.sh',
      '',
    ].join('\n'));
    await fse.writeFile(path.join(repoDir, 'hooks', 'b', 'hooks.yaml'), [
      'hooks:',
      '  - id: notify',
      '    description: notify helper',
      '    event: PostToolUse',
      '    command: ~/.teamai/team-scripts/notify.sh',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(findings(review)).toEqual([]);
  });

  it('fails the same hook id in two co-active namespaces', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('hooks', ['a', 'b']));
    for (const ns of ['a', 'b']) await fse.ensureDir(path.join(repoDir, 'hooks', ns));
    const hook = [
      'hooks:',
      '  - id: deploy',
      '    description: deploy helper',
      '    event: PreToolUse',
      '    command: ~/.teamai/team-scripts/deploy.sh',
      '',
    ].join('\n');
    await fse.writeFile(path.join(repoDir, 'hooks', 'a', 'hooks.yaml'), hook);
    await fse.writeFile(path.join(repoDir, 'hooks', 'b', 'hooks.yaml'), hook);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => (
      f.check === 'duplicates' && /"deploy" is defined in both/.test(f.message)
    ))).toBe(true);
  });

  it('reviews wiki pages at teamwiki/evidence/code, not the wiki/ name', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), resourcesYaml('wiki', ['a', 'b']));
    for (const ns of ['a', 'b']) await fse.ensureDir(path.join(repoDir, 'teamwiki', 'evidence', 'code', ns));
    await fse.writeFile(path.join(repoDir, 'teamwiki', 'evidence', 'code', 'a', 'page.md'), '# page a\n');
    await fse.writeFile(path.join(repoDir, 'teamwiki', 'evidence', 'code', 'b', 'page.md'), '# page b\n');
    // A stray file under the old wiki/ root must not be reviewed at all.
    await fse.ensureDir(path.join(repoDir, 'wiki'));
    await fse.writeFile(path.join(repoDir, 'wiki', 'stray.md'), 'password: hunter2\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(findings(review).some((f) => (
      f.check === 'duplicates' && /"page\.md" is defined in both/.test(f.message)
    ))).toBe(true);
    expect(findings(review).some((f) => f.path?.startsWith('wiki/'))).toBe(false);
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
      expect(['structure', 'naming', 'duplicates', 'format', 'leaks', 'safety', 'workflows', 'scorers', 'models']).toContain(finding.check);
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

  it('fails bad invoke, bad alias and alias conflicts, and warns that older CLIs drop a workflow setting either key', async () => {
    const header = (name: string, keys: string) => `schemaVersion: v1alpha1\nname: ${name}\ndescription: Ship.\n${keys}\nsteps:\n  - id: work\n    command: echo work\n`;
    await writeWorkflow(repoDir, 'ship', header('ship', 'invoke: allow\nalias: go'));
    await writeWorkflow(repoDir, 'land', header('land', 'alias: go'));
    await writeWorkflow(repoDir, 'odd', header('odd', 'invoke: always'));
    await writeWorkflow(repoDir, 'self', header('self', 'alias: self'));
    await writeWorkflow(repoDir, 'plain', header('plain', ''));

    const review = await reviewBranchDir(BRANCH, repoDir);

    const since = `teamai before ${INVOKE_ALIAS_SINCE} drops a workflow that sets invoke or alias, so members and CI jobs must run at least ${INVOKE_ALIAS_SINCE}.`;
    expect(review.findings).toEqual(expect.arrayContaining([
      { level: 'fail', check: 'workflows', path: 'workflows/odd.yaml', message: 'workflows/odd.yaml:4: field "invoke": invoke must be allow, ask or deny' },
      { level: 'fail', check: 'workflows', path: 'workflows/self.yaml', message: 'workflows/self.yaml:4: field "alias": alias must differ from the workflow name "self"' },
      { level: 'fail', check: 'workflows', path: 'workflows/land.yaml', message: 'workflows/land.yaml:4: field "alias": alias "go" is also the alias of workflows/ship.yaml, so it starts neither; start them by name' },
      { level: 'fail', check: 'workflows', path: 'workflows/ship.yaml', message: 'workflows/ship.yaml:5: field "alias": alias "go" is also the alias of workflows/land.yaml, so it starts neither; start them by name' },
      { level: 'warn', check: 'workflows', path: 'workflows/land.yaml', message: `workflows/land.yaml sets alias: ${since}` },
      { level: 'warn', check: 'workflows', path: 'workflows/ship.yaml', message: `workflows/ship.yaml sets invoke and alias: ${since}` },
    ]));
    expect(review.counts).toEqual({ fail: 4, warn: 2, info: 0 });
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

describe('reviewBranchDir — skill links, Agent Skills limits and piped installs (#1398)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-skill-files-'));
  });

  afterEach(async () => {
    await fse.remove(repoDir);
  });

  function skill(name: string, body: string[], description = 'Use this skill when cutting a release of the project.'): string {
    return ['---', `name: ${name}`, `description: ${description}`, '---', '', ...body, ''].join('\n');
  }

  async function writeSkillFile(relativePath: string, content: string): Promise<void> {
    await fse.outputFile(path.join(repoDir, ...relativePath.split('/')), content);
  }

  function warnings(review: BranchReview): Array<Pick<Finding, 'check' | 'path' | 'message'>> {
    return review.findings.filter((f) => f.level === 'warn').map(({ check, path: file, message }) => ({ check, path: file, message }));
  }

  it('warns once for a SKILL.md link to a file the skill does not have, and not for links that work or are skipped', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', [
      'See [the checklist](references/missing.md) and [it again](references/missing.md#top).',
      'Read [setup](references/setup.md), [the docs](https://example.com/docs), [mail](mailto:a@example.com),',
      '[below](#section), [root](/etc/hosts) and `[code](references/inline.md)`.',
      '',
      '```md',
      '[fenced](references/fenced.md)',
      '```python',
      '[still fenced](references/still-fenced.md)',
      '```',
      '',
      '[TODO]: tighten this section later',
    ]));
    await writeSkillFile('skills/release/references/setup.md', '# Setup\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(warnings(review)).toEqual([{
      check: 'format',
      path: 'skills/release/SKILL.md',
      message: 'skills/release/SKILL.md links to references/missing.md, which is not in the skill.',
    }]);
  });

  it('reads links after a code block and reference definitions in a file with CRLF line endings', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['```sh', 'echo', '```', '', '[guide]: references/missing.md']).replace(/\n/g, '\r\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message)).toEqual(['skills/release/SKILL.md links to references/missing.md, which is not in the skill.']);
  });

  it('reads links the way Markdown does around code, comments, brackets and parentheses', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', [
      'A stray ` backtick.',
      '',
      '[after stray](references/after-stray.md)',
      '',
      'Then `code` and [the [best] guide](references/nested.md) and [paren](references/foo(1).md).',
      '',
      '<!-- [old](references/old.md) -->',
      '',
      'An example:',
      '',
      '    [indented](references/indented.md)',
      '',
      '1. Step one.',
      '',
      '    See [listed](references/listed.md).',
      '',
      '[titled]: references/titled.md "say \\"hi\\""',
      '[setup](references/SETUP.md)',
    ]));
    await writeSkillFile('skills/release/references/foo(1).md', '# Foo\n');
    await writeSkillFile('skills/release/references/setup.md', '# Setup\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message.replace(/, which is not in the skill\.$/, ''))).toEqual([
      'skills/release/SKILL.md links to references/after-stray.md',
      'skills/release/SKILL.md links to references/nested.md',
      'skills/release/SKILL.md links to references/listed.md',
      'skills/release/SKILL.md links to references/SETUP.md',
      'skills/release/SKILL.md links to references/titled.md',
    ]);
  });

  it('reads links around comments, list fences, block boundaries, escapes and deep brackets, and resolves them as pull copies the skill', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', [
      'Code `<!--` here.',
      '',
      '[after comment opener](references/after-comment.md)',
      '',
      'Code `-->` here.',
      '',
      '1. Step one.',
      '',
      '    ```md',
      '    [list fenced](references/list-fenced.md)',
      '',
      '    ```',
      '',
      '2. Read [list guide].',
      '',
      '    [list guide]: references/list-guide.md',
      '',
      '# A heading with a stray `',
      '[after heading](references/after-heading.md)',
      '- an item with a stray `',
      '',
      '[hash](references/file%23name.md), \\[escaped](references/escaped.md), [a [b [c] d] e](references/deep.md),',
      '[symlinked](references/linked.md), [ignored](references/.DS_Store), [file as dir](references/setup.md/).',
    ]));
    await writeSkillFile('skills/release/references/setup.md', '# Setup\n');
    await writeSkillFile('skills/release/references/file#name.md', '# Hash\n');
    await writeSkillFile('skills/release/references/.DS_Store', '');
    await fse.symlink('setup.md', path.join(repoDir, 'skills/release/references/linked.md'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message.replace(/^skills\/release\/SKILL\.md links to /, '')).sort()).toEqual([
      'references/.DS_Store, which pull does not copy (a symlink or an ignored name); replace it with the file itself.',
      'references/after-comment.md, which is not in the skill.',
      'references/after-heading.md, which is not in the skill.',
      'references/deep.md, which is not in the skill.',
      'references/linked.md, which pull does not copy (a symlink or an ignored name); replace it with the file itself.',
      'references/list-guide.md, which is not in the skill.',
      'references/setup.md/, which is not in the skill.',
    ]);
  });

  it('reads comments and code spans in one pass, keeps a blockquote paragraph whole, and closes a fence only on its own marker', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', [
      'A <!-- ` --> [after comment](references/after-comment.md) and `code`.',
      '',
      '> `Example:',
      '> [quoted code](references/quoted-code.md)',
      '> end`',
      '',
      '> Press the `',
      '>',
      '> [quoted guide](references/quoted-guide.md)',
      '>',
      '> Another `',
      '',
      '```md',
      '```~~~',
      '[fenced](references/fenced.md)',
      '```',
    ]));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message)).toEqual([
      'skills/release/SKILL.md links to references/after-comment.md, which is not in the skill.',
      'skills/release/SKILL.md links to references/quoted-guide.md, which is not in the skill.',
    ]);
  });

  it('reads HTML comment blocks before fences, fences on list-marker lines, escaped backticks and character references', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', [
      '<!--',
      '~~~',
      '-->',
      '[after comment block](references/after-comment-block.md)',
      '',
      '- ~~~md',
      '  [list marker fence](references/list-marker-fence.md)',
      '  ~~~',
      '',
      'Escaped \\`[between escaped ticks](references/between-ticks.md)\\` and [entity](references/a&amp;b.md).',
    ]));
    await writeSkillFile('skills/release/references/a&b.md', '# A and B\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message.replace(/^skills\/release\/SKILL\.md links to /, '')).sort()).toEqual([
      'references/after-comment-block.md, which is not in the skill.',
      'references/between-ticks.md, which is not in the skill.',
    ]);
  });

  it('reads indented code inside a list item and ends a list fence at the outdent', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', [
      '- Example:',
      '',
      '      [list code](references/list-code.md)',
      '',
      '- ~~~md',
      '  [list fenced](references/list-fenced.md)',
      '',
      '[after list fence](references/after-list-fence.md)',
    ]));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message)).toEqual(['skills/release/SKILL.md links to references/after-list-fence.md, which is not in the skill.']);
  });

  it('warns for a reference definition to a file the skill does not have', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Read the [guide].', '', '[guide]: references/missing.md']));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review)).toEqual([{
      check: 'format',
      path: 'skills/release/SKILL.md',
      message: 'skills/release/SKILL.md links to references/missing.md, which is not in the skill.',
    }]);
  });

  it('resolves a link from the directory of the file that holds it', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Start at [a](references/a.md).']));
    await writeSkillFile('skills/release/references/a.md', 'Then read [b](b.md) and [c](c.md).\n');
    await writeSkillFile('skills/release/references/b.md', '# B\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review)).toEqual([{
      check: 'format',
      path: 'skills/release/references/a.md',
      message: 'skills/release/references/a.md links to c.md, which is not in the skill.',
    }]);
  });

  it('resolves a link outside the skill where pull delivers skills, side by side by name', async () => {
    await fse.ensureDir(path.join(repoDir, 'manifest'));
    await fse.writeFile(path.join(repoDir, 'manifest', 'roles.yaml'), rolesYaml(['frontend', 'backend']));
    await writeSkill(repoDir, 'skills/frontend/release', skill('release', [
      'See [notes](../notes/SKILL.md), [deploy](../deploy/SKILL.md), [deploy by repo path](../../backend/deploy/SKILL.md),',
      '[missing in notes](../notes/references/missing.md) and [guide](../../../docs/guide.md).',
    ]));
    await writeSkill(repoDir, 'skills/frontend/notes', skill('notes', ['# Notes']));
    await writeSkill(repoDir, 'skills/backend/deploy', skill('deploy', ['# Deploy']));

    const review = await reviewBranchDir(BRANCH, repoDir);
    const linkFindings = review.findings
      .filter((f) => f.path === 'skills/frontend/release/SKILL.md')
      .map(({ level, message }) => `${level} ${message.replace(/^skills\/frontend\/release\/SKILL\.md links to /, '')}`);

    expect(review.ok).toBe(true);
    expect(linkFindings).toEqual([
      'info ../notes/SKILL.md, in skill "notes"; it resolves only for a member who also receives that skill.',
      'info ../deploy/SKILL.md, in skill "deploy"; it resolves only for a member who also receives that skill.',
      'warn ../../backend/deploy/SKILL.md, which pull never delivers there: it delivers each skill as <skills>/<name>/, '
        + 'so link another skill as ../<name>/… and move any other file into the skill.',
      'warn ../notes/references/missing.md, which is not in skill "notes".',
      'warn ../../../docs/guide.md, which pull never delivers there: it delivers each skill as <skills>/<name>/, '
        + 'so link another skill as ../<name>/… and move any other file into the skill.',
    ]);
  });

  it('warns for a description over 1024 characters and not for one of 1024, counting characters rather than UTF-16 units', async () => {
    await writeSkill(repoDir, 'skills/long', skill('long', ['# Long'], 'd'.repeat(1025)));
    await writeSkill(repoDir, 'skills/limit', skill('limit', ['# Limit'], 'd'.repeat(1024)));
    await writeSkill(repoDir, 'skills/emoji', skill('emoji', ['# Emoji'], '🚀'.repeat(1024)));
    await writeSkill(repoDir, 'skills/block', ['---', 'name: block', 'description: |', `  ${'d'.repeat(1024)}`, '---', '', '# Block', ''].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review)).toEqual([{
      check: 'format',
      path: 'skills/long',
      message: 'skills/long/SKILL.md has a "description" of 1025 characters; the Agent Skills format allows 1024.',
    }]);
  });

  it('warns for a name outside the Agent Skills format and not for a lowercase hyphenated one', async () => {
    await writeSkill(repoDir, 'skills/Release_Tool', skill('Release_Tool', ['# Release']));
    await writeSkill(repoDir, 'skills/release-tool', skill('release-tool', ['# Release']));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(warnings(review)).toEqual([{
      check: 'format',
      path: 'skills/Release_Tool',
      message: 'skills/Release_Tool/SKILL.md has the name "Release_Tool"; the Agent Skills format allows 1 to 64 lowercase letters, '
        + 'digits and hyphens, with no leading, trailing or doubled hyphen. Rename the skill directory and its name together.',
    }]);
  });

  it('warns once for a script that pipes a download into a shell, and not for one that saves it', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Run scripts/setup.sh.']));
    await writeSkillFile('skills/release/scripts/setup.sh', [
      '#!/bin/sh',
      'curl -fsSL https://example.com/i.sh | sh',
      'wget -qO- https://example.com/i.sh | sudo bash -s --',
      '',
    ].join('\n'));
    await writeSkillFile('skills/release/scripts/fetch.sh', '#!/bin/sh\ncurl -o i.sh https://example.com/i.sh\ncurl -s https://example.com/sha | shasum\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review)).toEqual([{
      check: 'safety',
      path: 'skills/release/scripts/setup.sh',
      message: 'skills/release/scripts/setup.sh runs a download in a shell (curl … | sh); ship the script in the skill or pin what it runs.',
    }]);
  });

  it('warns for a download piped into a shell through env or a shell path', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Run the scripts.']));
    await writeSkillFile('skills/release/scripts/path.sh', 'curl -sL https://example.com/i.sh | /bin/bash\n');
    await writeSkillFile('skills/release/scripts/env.sh', 'wget -qO- https://example.com/i.sh | env bash\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.path).sort()).toEqual(['skills/release/scripts/env.sh', 'skills/release/scripts/path.sh']);
  });

  it('warns for a download piped into a shell through sudo options, another pipe or a line continuation, and not for ||', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Run the scripts.']));
    await writeSkillFile('skills/release/scripts/sudo.sh', 'curl -sL https://example.com/i.sh | sudo -u root bash\n');
    await writeSkillFile('skills/release/scripts/tee.sh', 'curl -sL https://example.com/i.sh | tee i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/split.sh', 'curl -fsSL https://example.com/i.sh \\\n  | sh\n');
    await writeSkillFile('skills/release/scripts/safe.sh', 'curl -sf https://example.com/up || sh fallback.sh\ncurl -s https://example.com/sha | shasum; echo ok | sh\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.path).sort()).toEqual([
      'skills/release/scripts/split.sh',
      'skills/release/scripts/sudo.sh',
      'skills/release/scripts/tee.sh',
    ]);
  });

  it('warns for a pipe that continues on the next line or follows a quoted separator, and only for a download a shell runs', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Run the scripts.']));
    await writeSkillFile('skills/release/scripts/next-line.sh', 'curl -fsSL https://example.com/i.sh |\n  sh\n');
    await writeSkillFile('skills/release/scripts/quoted.sh', "curl -H 'Cookie: a=b; c=d' https://example.com/i.sh | sh\n");
    await writeSkillFile('skills/release/scripts/env.sh', 'curl -fsSL https://example.com/i.sh | env CI=1 bash\n');
    await writeSkillFile('skills/release/scripts/escaped.sh', 'curl -H "X: \\"a; b\\"" https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/prose.md', "It's quick, and it's what we use: curl -fsSL https://example.com/i.sh | sh\n");
    await writeSkillFile('skills/release/inline.md', 'Install it with `curl -fsSL https://example.com/i.sh | sh`.\n');
    await writeSkillFile('skills/release/package.json', '{ "scripts": { "setup": "curl -fsSL https://example.com/i.sh | bash" } }\n');
    await writeSkillFile('skills/release/scripts/wget.sh', 'wget -O - https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/quoted-dash.sh', 'curl -o "-" https://example.com/i.sh | sh\nwget -O \'-\' https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/quoted-output.sh', 'curl --output="-" https://example.com/i.sh | sh\nwget -O"-" https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/schemeless.sh', 'curl -o saved example.com/a example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/remote-name-all.sh', 'curl --remote-name-all -o - https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/url-option.sh', 'curl -o saved --url=https://example.com/a --url=https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/env-unset.sh', 'curl https://example.com/i.sh | env -u LD_PRELOAD bash\n');
    await writeSkillFile('skills/release/scripts/yaml-run.sh', 'run: "set -e; curl -fsSL https://example.com/i.sh | sh"\n');
    await writeSkillFile('skills/release/scripts/retry-flag.sh', 'curl -o saved --retry-all-errors https://example.com/a https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/proxy-flag.sh', 'curl -o saved --proxy-insecure https://example.com/a https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/assignment.sh', 'curl -sfL https://example.com/i.sh | INSTALL_EXEC=server sh -\n');
    await writeSkillFile('skills/release/scripts/sudo-assignment.sh', 'curl -fsSL https://example.com/i.sh | sudo -E CI=1 bash\n');
    await writeSkillFile('skills/release/scripts/curl-dev-stdout.sh', 'curl -fsSL -o /dev/stdout https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/wget-dev-stdout.sh', 'wget -q -O /dev/stdout https://example.com/i.sh | bash\n');
    await writeSkillFile('skills/release/scripts/attached.sh', 'curl -HOrigin:example.test https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/two-urls.sh', 'curl -o saved https://example.com/a https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/scripts/safe.sh', [
      'curl -fsSL https://example.com/i.sh | bash-format',
      'echo curl | sh',
      "printf 'curl x' | sh",
      'curl -o i.sh https://example.com/i.sh | sh',
      'curl -fsSLO https://example.com/i.sh | sh',
      'curl -OfsSL https://example.com/i.sh | sh',
      'curl -o saved --proxy https://proxy.example.com https://example.com/i.sh | sh',
      'curl -o saved -x https://proxy.example.com https://example.com/i.sh | sh',
      "curl -H 'X: | sh' -o saved https://example.com/i.sh",
      'curl https://example.com/i.sh > installer.sh | sh',
      'curl -o saved --retry 3 https://example.com/i.sh | sh',
      'curl -o saved --data https://example.com/payload https://example.com/i.sh | sh',
      'curl https://example.com/i.sh>installer.sh | sh',
      'wget -O - -O saved https://example.com/i.sh | sh',
      "curl https://example.com/i.sh | sh -c 'echo done'",
      "curl -H 'User-Agent: curl | sh' -o saved https://example.com/i.sh",
      'echo -n curl | sh',
      'curl --remote-name-all https://example.com/a https://example.com/b | sh',
      'wget https://example.com/i.sh | sh',
      '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.path).sort()).toEqual([
      'skills/release/inline.md',
      'skills/release/package.json',
      'skills/release/prose.md',
      'skills/release/scripts/assignment.sh',
      'skills/release/scripts/attached.sh',
      'skills/release/scripts/curl-dev-stdout.sh',
      'skills/release/scripts/env-unset.sh',
      'skills/release/scripts/env.sh',
      'skills/release/scripts/escaped.sh',
      'skills/release/scripts/next-line.sh',
      'skills/release/scripts/proxy-flag.sh',
      'skills/release/scripts/quoted-dash.sh',
      'skills/release/scripts/quoted-output.sh',
      'skills/release/scripts/quoted.sh',
      'skills/release/scripts/remote-name-all.sh',
      'skills/release/scripts/retry-flag.sh',
      'skills/release/scripts/schemeless.sh',
      'skills/release/scripts/sudo-assignment.sh',
      'skills/release/scripts/two-urls.sh',
      'skills/release/scripts/url-option.sh',
      'skills/release/scripts/wget-dev-stdout.sh',
      'skills/release/scripts/wget.sh',
      'skills/release/scripts/yaml-run.sh',
    ]);
  });

  it('warns for a download a shell runs through process or command substitution, and not for one it saves', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Run the scripts.']));
    await writeSkillFile('skills/release/scripts/process.sh', 'bash <(curl -fsSL https://example.com/i.sh)\n');
    await writeSkillFile('skills/release/scripts/homebrew.sh',
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n');
    await writeSkillFile('skills/release/scripts/oh-my-zsh.sh', 'sh -c "$(wget -qO- https://example.com/i.sh)"\n');
    await writeSkillFile('skills/release/scripts/safe.sh', 'bash <(curl -o saved https://example.com/i.sh)\ndiff <(curl -s https://example.com/a) b\nbash "$(curl -fsSL https://example.com/path)"\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.message)).toEqual([
      'skills/release/scripts/homebrew.sh runs a download in a shell (bash -c "$(curl …)"); ship the script in the skill or pin what it runs.',
      'skills/release/scripts/oh-my-zsh.sh runs a download in a shell (sh -c "$(wget …)"); ship the script in the skill or pin what it runs.',
      'skills/release/scripts/process.sh runs a download in a shell (bash <(curl …)); ship the script in the skill or pin what it runs.',
    ]);
  });

  it('warns for a download from a URL in a variable, and not for text or a script comment that only names curl | sh', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['Run the scripts.']));
    await writeSkillFile('skills/release/scripts/variable.sh', 'curl -fsSL "$INSTALL_URL" | sh\n');
    await writeSkillFile('skills/release/scripts/braced.sh', 'curl -fsSL ${URL} | sh\n');
    await writeSkillFile('skills/release/policy.md', [
      'We avoid curl | sh installs in this team.',
      'Never run `curl … | sh`.',
      '',
      '| Linux | curl | bash |',
      '',
    ].join('\n'));
    await writeSkillFile('skills/release/scripts/commented.sh', '#!/bin/sh\n# never do: curl https://example.com/i.sh | sh\n  # wget -qO- https://example.com/i.sh | bash\necho ok\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(warnings(review).map((f) => f.path)).toEqual(['skills/release/scripts/braced.sh', 'skills/release/scripts/variable.sh']);
  });

  it('keeps a branch with only these findings ok, each at level "warn"', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['See [x](references/missing.md).']));
    await writeSkillFile('skills/release/scripts/setup.sh', 'curl -fsSL https://example.com/i.sh | sh\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(true);
    expect(review.counts).toEqual({ fail: 0, warn: 2, info: 0 });
    expect(review.findings.map(({ level, check }) => ({ level, check }))).toEqual([
      { level: 'warn', check: 'format' },
      { level: 'warn', check: 'safety' },
    ]);
  });

  it('lists link warnings before the frontmatter ones, and piped installs after them, as the issue example does', async () => {
    await writeSkill(repoDir, 'skills/release', skill('release', ['See [x](references/missing.md).'], 'd'.repeat(1025)));
    await writeSkillFile('skills/release/a.sh', 'curl -fsSL https://example.com/i.sh | sh\n');
    await writeSkillFile('skills/release/z.md', 'See [y](references/other.md).\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings.map(({ check, path: file }) => `${check} ${file}`)).toEqual([
      'format skills/release/SKILL.md',
      'format skills/release/z.md',
      'format skills/release',
      'safety skills/release/a.sh',
    ]);
  });
});

describe('reviewBranchDir — scorers', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-scorers-'));
  });

  afterEach(async () => {
    await fse.remove(repoDir);
  });

  it('passes a valid scorer and ignores scorers/README.md', async () => {
    await writeScorer(repoDir, 'quality.md', VALID_SCORER);
    await writeScorer(repoDir, 'README.md', '# Our scorers\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('fails a malformed scorer and a file that is not a scorer', async () => {
    await writeScorer(repoDir, 'quality.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: high'));
    await writeScorer(repoDir, 'eval.yaml', 'name: eval\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(review.findings).toEqual([
      {
        level: 'fail',
        check: 'scorers',
        path: 'scorers/eval.yaml',
        message: 'scorers/eval.yaml: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md',
      },
      {
        level: 'fail',
        check: 'scorers',
        path: 'scorers/quality.md',
        message: 'scorers/quality.md: passingScore must be a number',
      },
    ]);
  });

  it('fails a workflow step that lists a scorer the branch does not have', async () => {
    await writeScorer(repoDir, 'quality.md', VALID_SCORER);
    await writeWorkflow(repoDir, 'ship', [
      'schemaVersion: v1alpha1',
      'name: ship',
      'description: Ship it.',
      'steps:',
      '  - id: plan',
      '    prompt: Plan it.',
      '    scorers: [quality, nope]',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(review.findings).toEqual([
      {
        level: 'fail',
        check: 'workflows',
        path: 'workflows/ship.yaml',
        message: 'workflows/ship.yaml: step "plan" lists scorer "nope", which has no valid scorers/nope.md; the step runs without it',
      },
    ]);
  });

  it('fails a malformed namespaced scorer of a team with a projects manifest', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'projects.yaml'), 'version: 1\nprojects:\n  - id: svc-a\n    name: Svc A\n    resources: { skills: [] }\n');
    await writeScorer(repoDir, 'svc-a/quality.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: high'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings).toEqual([
      { level: 'fail', check: 'scorers', path: 'scorers/svc-a/quality.md', message: 'scorers/svc-a/quality.md: passingScore must be a number' },
    ]);
  });

  it('checks every scoring.yaml of the branch, in every namespace, and takes none for a scorer', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], scorers: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n');
    await writeScorer(repoDir, 'scoring.yaml', 'batch: true\nisolation: verified\n');
    await writeScorer(repoDir, 'ops/scoring.yaml', 'batch: false\n');
    await writeScorer(repoDir, 'dev/scoring.yaml', 'batch: maybe\nisolaton: verified\n');
    await writeScorer(repoDir, 'shared/scoring.yaml', 'isolation: strict\n');
    await writeScorer(repoDir, 'qa/scoring.yaml', 'isolation: [verified\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    const scoring = (file: string, message: string) => ({ level: 'fail', check: 'scorers', path: `scorers/${file}`, message });
    expect(review.findings).toEqual([
      scoring('dev/scoring.yaml', 'scorers/dev/scoring.yaml: batch is "maybe", not true or false, so it is ignored'),
      scoring('dev/scoring.yaml', 'scorers/dev/scoring.yaml: "isolaton" is not a scoring setting (batch, isolation, sessions, daily_limit), so it is ignored'),
      scoring('qa/scoring.yaml', expect.stringMatching(/^scorers\/qa\/scoring\.yaml is not valid YAML: /)),
      scoring('shared/scoring.yaml', 'scorers/shared/scoring.yaml isolation is "strict", which is not verified or best-effort, so it counts as verified'),
    ]);
  });

  it('reads a scorers/<dir>/ that no role or project declares as shared, as pull does', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n');
    await writeScorer(repoDir, 'shared/x.md', VALID_SCORER);
    await writeScorer(repoDir, 'ops/y.md', VALID_SCORER);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings).toEqual([
      { level: 'info', check: 'structure', path: 'scorers/shared/x.md', message: 'scorers/shared/x.md sits at the shared root, so it is delivered to every member.' },
    ]);
  });

  it('fails a root scorer and a scorer of one name in a scorers/<dir>/ that no role or project declares', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n');
    await writeScorer(repoDir, 'quality.md', VALID_SCORER);
    await writeScorer(repoDir, 'shared/quality.md', VALID_SCORER);

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings.filter((finding) => finding.level === 'fail')).toEqual([
      {
        level: 'fail',
        check: 'duplicates',
        path: 'scorers/shared/quality.md',
        message: '"quality" is a shared scorer in both scorers/quality.md and scorers/shared/quality.md, so pull caches neither. Rename or remove one of them.',
      },
    ]);
  });

  it('fails a scorer whose text carries a credential, as it fails a rule', async () => {
    await writeScorer(repoDir, 'quality.md', VALID_SCORER.replace('Judge the change.', 'Call the API with sk-abcdefghijklmnopqrstuvwx0123456789.'));
    await writeScorer(repoDir, 'README.md', 'Ask at http://10.12.0.7:8080 before adding one.\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(review.findings.map(({ check, path: file, message }) => ({ check, file, message: message.split(' (')[0] })).sort((a, b) => String(a.file).localeCompare(String(b.file)))).toEqual([
      { check: 'leaks', file: 'scorers/quality.md', message: 'scorers/quality.md looks like it carries a credential' },
      { check: 'leaks', file: 'scorers/README.md', message: 'scorers/README.md contains an internal address' },
    ]);
  });

  it('passes one scorer name in two role namespaces that a step lists', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], scorers: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n');
    await writeScorer(repoDir, 'dev/quality.md', VALID_SCORER);
    await writeScorer(repoDir, 'ops/quality.md', VALID_SCORER);
    await writeWorkflow(repoDir, 'ship', 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship it.\nsteps:\n  - id: plan\n    prompt: Plan it.\n    scorers: [quality]\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings).toEqual([]);
  });
});

describe('reviewBranchDir — model aliases', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-models-'));
  });

  afterEach(async () => {
    await fse.remove(repoDir);
    await fse.remove(localAliasesPath());
  });

  const aliasesFile = (yaml: string) => fse.outputFile(path.join(repoDir, 'models', 'aliases.yaml'), yaml);
  const modelFindings = (review: BranchReview) => review.findings.filter((finding) => finding.check === 'models');

  it('fails an agent whose alias the branch maps for none of its target tools', async () => {
    await aliasesFile('aliases:\n  fast:\n    codex: gpt-6-mini\n');
    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: Reviews code.\ninstructions: Review the code.\nmodel: fast\ntargets: [claude]\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(modelFindings(review)).toEqual([{
      level: 'fail', check: 'models', path: 'agents/reviewer.yaml',
      message: 'Agent "reviewer" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the agent.',
    }]);
  });

  it('fails a workflow step, and the steps defaults.model reaches, whose alias the branch maps for no tool', async () => {
    await writeWorkflow(repoDir, 'ship', [
      'schemaVersion: v1alpha1', 'name: ship', 'description: Ship it.', 'defaults:', '  model: fast', 'steps:',
      '  - id: plan', '    prompt: Plan it.', '    model: strong', '  - id: write', '    prompt: Write it.', '    needs: [plan]', '',
    ].join('\n'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(modelFindings(review)).toEqual([
      { level: 'fail', check: 'models', path: 'workflows/ship.yaml', message: 'Step "plan" asks for model alias "strong", which has no model for any tool in models/aliases.yaml. Add one or remove model from the step.' },
      { level: 'fail', check: 'models', path: 'workflows/ship.yaml', message: 'Step "write" gets model alias "fast" from defaults, which has no model for any tool in models/aliases.yaml. Add one, or set model on the step.' },
    ]);
  });

  it('fails a scorer whose alias the branch maps for no tool, judging the team files only', async () => {
    await aliasesFile('aliases:\n  strong:\n    claude: opus\n');
    await fse.outputFile(localAliasesPath(), 'aliases:\n  strong:\n    claude: ~\n  fast:\n    claude: haiku\n');
    await writeScorer(repoDir, 'quality.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: 1\nmodel: fast'));
    await writeScorer(repoDir, 'tests.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: 1\nmodel: strong'));
    await writeScorer(repoDir, 'literal.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: 1\nmodel: claude-haiku-4-5'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(modelFindings(review)).toEqual([{
      level: 'fail', check: 'models', path: 'scorers/quality.md',
      message: 'Scorer "quality" asks for model alias "fast", which has no model for any tool in models/aliases.yaml. Add one, or remove model from the scorer.',
    }]);
  });

  it('fails a malformed aliases file with the words doctor uses', async () => {
    await aliasesFile('aliases: [broken]\n');

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.ok).toBe(false);
    expect(modelFindings(review)).toEqual([{
      level: 'fail', check: 'models', path: 'models/aliases.yaml',
      message: expect.stringMatching(/^Invalid model aliases file at models\/aliases\.yaml: .+\. Until that is fixed, pull keeps the deployed copies of every agent that sets a `model`/),
    }]);
  });

  const roles = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], agents: [dev], models: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [] }\n';
  const agent = (model: string, extra = '') => `name: reviewer\ndescription: Reviews code.\ninstructions: Review the code.\nmodel: ${model}\ntargets: [claude]\n${extra}`;

  it('checks a namespaced agent only for the roles that receive it, against the aliases those roles receive', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), roles);
    await fse.outputFile(path.join(repoDir, 'manifest', 'projects.yaml'), 'version: 1\nprojects:\n  - id: svc-a\n    name: Svc A\n    resources: { skills: [] }\n');
    await fse.outputFile(path.join(repoDir, 'models', 'dev', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n');
    await fse.outputFile(path.join(repoDir, 'agents', 'dev', 'reviewer.yaml'), agent('fast'));

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([]);

    await fse.outputFile(path.join(repoDir, 'models', 'dev', 'aliases.yaml'), 'aliases:\n  fast:\n    codex: gpt-6-mini\n');
    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([{
      level: 'fail', check: 'models', path: 'agents/dev/reviewer.yaml',
      message: 'Agent "reviewer" asks for model alias "fast", which has no model for claude in models/dev/aliases.yaml (role dev). Add one, or remove model from the agent.',
    }]);
  });

  it('names the roles a shared agent\'s alias is unmapped for', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), roles);
    await fse.outputFile(path.join(repoDir, 'models', 'dev', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n');
    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), agent('fast'));

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([{
      level: 'fail', check: 'models', path: 'agents/reviewer.yaml',
      message: 'Agent "reviewer" asks for model alias "fast", which has no model for claude in models/aliases.yaml (no role or project, role ops). Add one, or remove model from the agent.',
    }]);
  });

  it('checks defaults.model for a step whose agent sets no model, as a run would use it', async () => {
    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: Reviews code.\ninstructions: Review the code.\n');
    await writeWorkflow(repoDir, 'ship', 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship it.\ndefaults:\n  model: fast\nsteps:\n  - id: check\n    agent: reviewer\n    prompt: Review it.\n');

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([{
      level: 'fail', check: 'models', path: 'workflows/ship.yaml',
      message: 'Step "check" gets model alias "fast" from defaults, which has no model for any tool in models/aliases.yaml. Add one, or set model on the step.',
    }]);

    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), agent('claude-haiku-4-5'));
    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([]);
  });

  it('passes an agent whose tool extras name the model of each target tool', async () => {
    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), agent('fast', 'tool_extras:\n  claude:\n    model: haiku\n'));

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([]);

    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), agent('fast', 'tool_extras:\n  codex:\n    model: gpt-6-mini\n'));
    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([expect.objectContaining({ path: 'agents/reviewer.yaml' })]);
  });

  it('passes aliases the branch maps and model names as they are', async () => {
    await aliasesFile('aliases:\n  fast:\n    claude: haiku\n');
    await fse.outputFile(path.join(repoDir, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: Reviews code.\ninstructions: Review the code.\nmodel: fast\n');
    await writeScorer(repoDir, 'quality.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: 1\nmodel: fast'));
    await writeScorer(repoDir, 'literal.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: 1\nmodel: gpt-6-mini'));

    const review = await reviewBranchDir(BRANCH, repoDir);

    expect(review.findings).toEqual([]);
  });

  const parent = 'schemaVersion: v1alpha1\nname: parent\ndescription: Runs the child.\ndefaults:\n  model: fast\nsteps:\n  - id: call\n    workflow: child\n';
  const child = 'schemaVersion: v1alpha1\nname: child\ndescription: Writes it.\nsteps:\n  - id: write\n    prompt: Write it.\n';

  it('fails a step of a workflow another runs with the defaults.model it inherits from it', async () => {
    await writeWorkflow(repoDir, 'parent', parent);
    await writeWorkflow(repoDir, 'child', child);

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([{
      level: 'fail', check: 'models', path: 'workflows/parent.yaml',
      message: 'Step "call.write" gets model alias "fast" from defaults, which has no model for any tool in models/aliases.yaml. Add one, or set model on the step.',
    }]);
  });

  it('passes a workflow another runs when the defaults.model it inherits is mapped', async () => {
    await aliasesFile('aliases:\n  fast:\n    claude: haiku\n');
    await writeWorkflow(repoDir, 'parent', parent);
    await writeWorkflow(repoDir, 'child', child);

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([]);
  });

  it('checks a namespaced workflow for the roles that receive it', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], workflows: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [] }\n');
    await fse.outputFile(path.join(repoDir, 'workflows', 'dev', 'ship.yaml'), 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship it.\nsteps:\n  - id: plan\n    prompt: Plan it.\n    model: strong\n');

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([{
      level: 'fail', check: 'models', path: 'workflows/dev/ship.yaml',
      message: 'Step "plan" asks for model alias "strong", which has no model for any tool in models/aliases.yaml (no role or project, role dev). Add one or remove model from the step.',
    }]);
  });

  it('checks a namespaced scorer only for the roles that receive it, against the aliases those roles receive', async () => {
    await fse.outputFile(path.join(repoDir, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], scorers: [dev] }\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops], models: [ops] }\n');
    await fse.outputFile(path.join(repoDir, 'manifest', 'projects.yaml'), 'version: 1\nprojects:\n  - id: svc-a\n    name: Svc A\n    resources: { skills: [] }\n');
    await fse.outputFile(path.join(repoDir, 'models', 'ops', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n');
    await writeScorer(repoDir, 'ops/quality.md', VALID_SCORER.replace('passingScore: 1', 'passingScore: 1\nmodel: fast'));

    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([]);

    await fse.outputFile(path.join(repoDir, 'models', 'ops', 'aliases.yaml'), 'aliases:\n  slow:\n    claude: opus\n');
    expect(modelFindings(await reviewBranchDir(BRANCH, repoDir))).toEqual([{
      level: 'fail', check: 'models', path: 'scorers/ops/quality.md',
      message: 'Scorer "quality" asks for model alias "fast", which has no model for any tool in models/aliases.yaml (role ops). Add one, or remove model from the scorer.',
    }]);
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
      await fse.outputFile(path.join(gitRepo, 'scorers', 'eval.md'), '---\npassingScore: 1\n---\nJudge.\n');
      await fse.outputFile(path.join(gitRepo, 'ignored', 'file.txt'), 'ignore me\n');
      execFileSync('git', ['-C', gitRepo, 'add', '.']);
      execFileSync('git', ['-C', gitRepo, 'commit', '-q', '-m', 'initial']);

      const count = await materializeRef(gitRepo, 'HEAD', destDir);
      expect(count).toBe(3);
      expect(await fse.pathExists(path.join(destDir, 'workflows', 'deploy.yaml'))).toBe(true);
      expect(await fse.pathExists(path.join(destDir, 'prompts', 'release.md'))).toBe(true);
      expect(await fse.pathExists(path.join(destDir, 'scorers', 'eval.md'))).toBe(true);
      expect(await fse.pathExists(path.join(destDir, 'ignored', 'file.txt'))).toBe(false);
    } finally {
      await fse.remove(gitRepo);
      await fse.remove(destDir);
    }
  });
  it('carries teamai.yaml, and the review fails a sessions.publish value pull would ignore', async () => {
    const gitRepo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-git-repo-'));
    const destDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dest-'));
    try {
      execFileSync('git', ['init', '-q', gitRepo]);
      execFileSync('git', ['-C', gitRepo, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', gitRepo, 'config', 'user.email', 'test@example.com']);
      await fse.outputFile(path.join(gitRepo, 'teamai.yaml'), 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish:\n    unattended: always\n    nightly: auto\n');
      execFileSync('git', ['-C', gitRepo, 'add', '.']);
      execFileSync('git', ['-C', gitRepo, 'commit', '-q', '-m', 'initial']);

      await materializeRef(gitRepo, 'HEAD', destDir);
      const review = await reviewBranchDir(BRANCH, destDir);

      expect(review.findings).toEqual([
        { level: 'fail', check: 'sessions', path: 'teamai.yaml', message: 'teamai.yaml sessions.publish.unattended is "always", not off, ask or auto, so it is ignored' },
        { level: 'fail', check: 'sessions', path: 'teamai.yaml', message: 'teamai.yaml sessions.publish.nightly is not a run mode (attended, unattended), so it is ignored' },
      ]);
    } finally {
      await fse.remove(gitRepo);
      await fse.remove(destDir);
    }
  });
  it('reports nothing about sessions when the branch teamai.yaml is not valid YAML', async () => {
    const destDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dest-'));
    try {
      await fse.outputFile(path.join(destDir, 'teamai.yaml'), 'team: acme\nsessions: [\n');

      const review = await reviewBranchDir(BRANCH, destDir);

      expect(review.findings).toEqual([]);
    } finally {
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
