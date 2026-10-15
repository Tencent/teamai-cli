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
    persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { reviewBranchDir, type BranchReview } from '../review-branch.js';

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
      expect(['structure', 'naming', 'duplicates', 'format', 'leaks']).toContain(finding.check);
      expect(typeof finding.message).toBe('string');
    }
  });
});
