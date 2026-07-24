import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Verify that `recall(query, { check: true })` emits a single-line verdict
// (RELEVANT / NOT_RELEVANT + score) and exits before recording quality or
// formatting full results.

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
}));

import { recall } from '../recall.js';
import { detectProjectConfig } from '../config.js';
import { buildIndex } from '../utils/search-index.js';
import { getTeamaiHome, type LocalConfig } from '../types.js';
import { readRecallQuality } from '../recall-quality.js';

const CHECK_LEARNING_TITLE = 'Deployment Timeout Retry Policy';

function learningDoc(title: string): string {
  return [
    '---',
    `title: "${title}"`,
    'author: tester',
    'date: 2026-05-01',
    'tags: [deployment, timeout]',
    '---',
    '',
    'Notes about deployment timeout retry policy.',
    '',
  ].join('\n');
}

describe('recall --check precheck mode', () => {
  let tmpDir: string;
  let projectRoot: string;
  let projectConfig: LocalConfig;
  let writeSpy: { mockRestore: () => void };
  let captured: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-check-'));
    projectRoot = path.join(tmpDir, 'proj');
    await fse.ensureDir(projectRoot);
    await fse.ensureDir(path.join(tmpDir, 'home'));
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));

    // ── Project scope index (<projectRoot>/.teamai/search-index.json) ──
    const projectRepo = path.join(projectRoot, '.teamai', 'team-repo');
    const projectLearnings = path.join(projectRepo, 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(
      path.join(projectLearnings, 'proj-deploy-2026-05-01-ccc.md'),
      learningDoc(CHECK_LEARNING_TITLE),
    );
    await fse.ensureDir(getTeamaiHome('project', projectRoot));
    await buildIndex({
      learningsDir: projectLearnings,
      indexPath: path.join(getTeamaiHome('project', projectRoot), 'search-index.json'),
    });

    projectConfig = {
      repo: { localPath: projectRepo, remote: 'https://git.woa.com/test/proj.git' },
      username: 'checkscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
    };

    captured = '';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as never);
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('RELEVANT: high-signal query prints RELEVANT with score, no full output', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('deployment timeout retry', { check: true });

    expect(captured).toMatch(/^RELEVANT score=\d+\.\d+\n$/);
    expect(captured).not.toContain(CHECK_LEARNING_TITLE);
    expect(Number(captured.match(/score=([\d.]+)/)![1])).toBeGreaterThanOrEqual(4.0);
  });

  it('NOT_RELEVANT: unrelated query prints NOT_RELEVANT score', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('completely unrelated gibberish xyzzy quantum', { check: true });

    expect(captured).toMatch(/^NOT_RELEVANT score=\d+\.\d+\n$/);
  });

  it('check mode does not record recall quality (no side effects)', async () => {
    vi.stubEnv('CLAUDE_SESSION_ID', 'recall-check-no-side-effect');
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('deployment timeout retry', { check: true });

    expect(readRecallQuality('recall-check-no-side-effect')).toBeNull();
    const votesDir = path.join(tmpDir, 'home', '.teamai', 'votes');
    const votesDirExists = await fse.pathExists(votesDir);
    if (votesDirExists) {
      const files = await fse.readdir(votesDir);
      expect(files).toHaveLength(0);
    } else {
      expect(votesDirExists).toBe(false);
    }
  });

  it('empty query + check emits NOT_RELEVANT score=0.0', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('', { check: true });

    expect(captured).toBe('NOT_RELEVANT score=0.0\n');
  });
});
