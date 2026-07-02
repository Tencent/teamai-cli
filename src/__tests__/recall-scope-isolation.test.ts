import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Issue #73: recall must query the project-scope index ONLY when a project
// install is detected, and the user-scope index otherwise. The two are never
// merged anymore.

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
}));

import { recall } from '../recall.js';
import { detectProjectConfig, requireInit } from '../config.js';
import { buildIndex } from '../utils/search-index.js';
import { getTeamaiHome, type LocalConfig } from '../types.js';
import { readRecallQuality } from '../recall-quality.js';

const PROJECT_TITLE = 'Project Deployment Timeout Fix';
const USER_TITLE = 'User Deployment Timeout Fix';

function learningDoc(title: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-05-01\ntags: [deployment, timeout]\n---\n\nNotes about deployment timeout handling.\n`;
}

describe('recall scope isolation (issue #73)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let userConfig: LocalConfig;
  let projectConfig: LocalConfig;
  let writeSpy: { mockRestore: () => void };
  let captured: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-iso-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'proj');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(projectRoot);
    vi.stubEnv('HOME', homeDir);

    // ── User scope index (HOME/.teamai/search-index.json) ──
    const userLearnings = path.join(tmpDir, 'user-learnings');
    await fse.ensureDir(userLearnings);
    await fse.writeFile(path.join(userLearnings, 'user-deploy-2026-05-01-aaa.md'), learningDoc(USER_TITLE));
    await fse.ensureDir(getTeamaiHome('user'));
    await buildIndex({ learningsDir: userLearnings, indexPath: path.join(getTeamaiHome('user'), 'search-index.json') });

    // ── Project scope index (<projectRoot>/.teamai/search-index.json) ──
    const projectRepo = path.join(projectRoot, '.teamai', 'team-repo');
    const projectLearnings = path.join(projectRepo, 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(path.join(projectLearnings, 'proj-deploy-2026-05-01-bbb.md'), learningDoc(PROJECT_TITLE));
    await fse.ensureDir(getTeamaiHome('project', projectRoot));
    await buildIndex({ learningsDir: projectLearnings, indexPath: path.join(getTeamaiHome('project', projectRoot), 'search-index.json') });

    userConfig = {
      repo: { localPath: path.join(homeDir, '.teamai', 'team-repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'userscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
    projectConfig = {
      repo: { localPath: projectRepo, remote: 'https://git.woa.com/test/proj.git' },
      username: 'projscope',
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

  it('project mode: returns project results only, never consults user scope', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('deployment timeout', { dryRun: true });

    expect(captured).toContain(PROJECT_TITLE);
    expect(captured).not.toContain(USER_TITLE);
    expect(captured).toContain('[project]');
    // User scope must never be initialized in project mode.
    expect(requireInit).not.toHaveBeenCalled();
  });

  it('user mode: returns user results only when no project scope detected', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(requireInit).mockResolvedValue({ localConfig: userConfig, teamConfig: {} as never });

    await recall('deployment timeout', { dryRun: true });

    expect(captured).toContain(USER_TITLE);
    expect(captured).not.toContain(PROJECT_TITLE);
    expect(captured).toContain('[user]');
  });

  it('records recall quality (hit) for contribute-check knowledge-gap detection', async () => {
    vi.stubEnv('CLAUDE_SESSION_ID', 'recall-quality-hit-session');
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('deployment timeout', { dryRun: true });

    expect(readRecallQuality('recall-quality-hit-session')).toEqual(
      expect.objectContaining({ hitCount: 1, missCount: 0 }),
    );
  });

  it('records recall quality (miss) when nothing matches', async () => {
    vi.stubEnv('CLAUDE_SESSION_ID', 'recall-quality-miss-session');
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await recall('completely unrelated gibberish query xyzzy', { dryRun: true });

    expect(readRecallQuality('recall-quality-miss-session')).toEqual(
      expect.objectContaining({ hitCount: 0, missCount: 1 }),
    );
  });
});
