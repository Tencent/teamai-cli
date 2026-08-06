import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Issue #73 keeps recall project-only by default. Layered recall is available
// only through an explicit project-local inheritance setting.

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
}));

vi.mock('../code-knowledge-recall.js', () => ({
  queryCodeKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock('../votes.js', () => ({
  incrementRecalled: vi.fn().mockResolvedValue(undefined),
}));

import { recall } from '../recall.js';
import { detectProjectConfig, loadLocalConfigForScope, requireInit } from '../config.js';
import { buildIndex } from '../utils/search-index.js';
import { getTeamaiHome, type LocalConfig } from '../types.js';
import { readRecallQuality } from '../recall-quality.js';
import { queryCodeKnowledge } from '../code-knowledge-recall.js';
import { incrementRecalled } from '../votes.js';

const PROJECT_TITLE = 'Project Deployment Timeout Fix';
const USER_TITLE = 'User Deployment Timeout Fix';
const PROJECT_SHARED_TITLE = 'Project Shared Review Policy';
const USER_SHARED_TITLE = 'User Shared Review Policy';
const USER_DOC_SHARED_TITLE = 'User Docs Shared Review Policy';
const USER_SHADOWED_TITLE = 'Obsolete Zzyzx Retry Advice';
const PROJECT_SHADOW_TITLE = 'Current Release Guidance';

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
    await fse.writeFile(path.join(userLearnings, 'shared-review.md'), learningDoc(USER_SHARED_TITLE));
    await fse.writeFile(path.join(userLearnings, 'shadowed-policy.md'), learningDoc(USER_SHADOWED_TITLE));
    const userDocs = path.join(tmpDir, 'user-docs');
    await fse.ensureDir(userDocs);
    await fse.writeFile(path.join(userDocs, 'shared-review.md'), learningDoc(USER_DOC_SHARED_TITLE));
    await fse.ensureDir(getTeamaiHome('user'));
    await buildIndex({
      learningsDir: userLearnings,
      docsDir: userDocs,
      indexPath: path.join(getTeamaiHome('user'), 'search-index.json'),
    });

    // ── Project scope index (<projectRoot>/.teamai/search-index.json) ──
    const projectRepo = path.join(projectRoot, '.teamai', 'team-repo');
    const projectLearnings = path.join(projectRepo, 'learnings');
    await fse.ensureDir(projectLearnings);
    await fse.writeFile(path.join(projectLearnings, 'proj-deploy-2026-05-01-bbb.md'), learningDoc(PROJECT_TITLE));
    await fse.writeFile(path.join(projectLearnings, 'shared-review.md'), learningDoc(PROJECT_SHARED_TITLE));
    await fse.writeFile(path.join(projectLearnings, 'shadowed-policy.md'), learningDoc(PROJECT_SHADOW_TITLE));
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

  it('project mode: merges user results when inheritance is explicitly enabled', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await recall('deployment timeout', { dryRun: true });

    expect(captured).toContain(PROJECT_TITLE);
    expect(captured).toContain(USER_TITLE);
    expect(captured).toContain('[project]');
    expect(captured).toContain('[user]');
  });

  it('project mode: project entry wins when both scopes contain the same type and filename', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await recall('shared review policy', { dryRun: true });

    expect(captured).toContain(PROJECT_SHARED_TITLE);
    expect(captured).not.toContain(USER_SHARED_TITLE);
  });

  it('keeps different resource types that share the same filename', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await recall('shared review policy', { dryRun: true });

    expect(captured).toContain(PROJECT_SHARED_TITLE);
    expect(captured).toContain(USER_DOC_SHARED_TITLE);
  });

  it('shadows a matching user entry even when the project replacement does not match', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await recall('zzyzx retry', { dryRun: true });

    expect(captured).not.toContain(USER_SHADOWED_TITLE);
    expect(captured).not.toContain(PROJECT_SHADOW_TITLE);
  });

  it('keeps codebase lookup bound to the project when its index is empty', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);
    const projectIndexPath = path.join(getTeamaiHome('project', projectRoot), 'search-index.json');
    const projectIndex = JSON.parse(await fse.readFile(projectIndexPath, 'utf8')) as { entries: unknown[] };
    projectIndex.entries = [];
    await fse.writeFile(projectIndexPath, JSON.stringify(projectIndex));

    await recall('deployment timeout', { dryRun: true });

    expect(queryCodeKnowledge).toHaveBeenCalledWith(
      'deployment timeout',
      expect.objectContaining({ wikiRoot: path.join(projectConfig.repo.localPath, 'teamwiki') }),
    );
  });

  it('does not write inherited user votes through the active project channel', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await recall('deployment timeout', {});

    expect(incrementRecalled).toHaveBeenCalledTimes(1);
    const docIds = vi.mocked(incrementRecalled).mock.calls[0][1] as string[];
    expect(docIds).toContain('proj-deploy-2026-05-01-bbb');
    expect(docIds).not.toContain('user-deploy-2026-05-01-aaa');
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
