import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── contribute --namespace (#916) ──────────────────────────
// A directory that reads several learnings namespaces gets a way to choose
// one for a contribution, instead of always landing in the shared root.

function writeManifest(repoDir: string, learnings: Record<string, string[]>): void {
  const projects = Object.entries(learnings)
    .map(([id, ns]) => `  - id: ${id}\n    resources: { learnings: [${ns.join(', ')}] }`)
    .join('\n');
  fs.mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'manifest', 'projects.yaml'),
    `version: 1\nprojects:\n${projects}\n`,
    'utf-8',
  );
}

describe('resolveLearningsDestination (#916)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-dest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function localConfigFor(projects: string[]) {
    return {
      repo: { localPath: tmpDir },
      username: 'testuser',
      projects,
    } as never;
  }

  it('routes to the single active namespace without a flag', async () => {
    writeManifest(tmpDir, { 'svc-a': ['svc-a'] });
    const { resolveLearningsDestination } = await import('../contribute.js');
    const dest = await resolveLearningsDestination(localConfigFor(['svc-a']));
    expect(dest).toEqual({ subdir: 'svc-a', namespaces: ['svc-a'] });
  });

  it('falls back to the shared root when several namespaces are active', async () => {
    writeManifest(tmpDir, { 'svc-a': ['svc-a'], payments: ['payments'] });
    const { resolveLearningsDestination } = await import('../contribute.js');
    const dest = await resolveLearningsDestination(localConfigFor(['svc-a', 'payments']));
    expect(dest).toEqual({ subdir: '', namespaces: ['svc-a', 'payments'] });
  });

  it('routes a --namespace flag to the requested namespace', async () => {
    writeManifest(tmpDir, { 'svc-a': ['svc-a'], payments: ['payments'] });
    const { resolveLearningsDestination } = await import('../contribute.js');
    const dest = await resolveLearningsDestination(localConfigFor(['svc-a', 'payments']), 'payments');
    expect(dest).toEqual({ subdir: 'payments', namespaces: ['svc-a', 'payments'] });
  });

  it('accepts a namespace that differs from the project id', async () => {
    writeManifest(tmpDir, { alpha: ['alpha-notes'] });
    const { resolveLearningsDestination } = await import('../contribute.js');
    const dest = await resolveLearningsDestination(localConfigFor(['alpha']), 'alpha-notes');
    expect(dest).toEqual({ subdir: 'alpha-notes', namespaces: ['alpha-notes'] });
  });

  it('refuses a namespace this directory does not read, listing the valid ones', async () => {
    writeManifest(tmpDir, { 'svc-a': ['svc-a'], payments: ['payments'] });
    const { resolveLearningsDestination } = await import('../contribute.js');
    await expect(
      resolveLearningsDestination(localConfigFor(['svc-a', 'payments']), 'nope'),
    ).rejects.toThrow('Unknown learnings namespace "nope". Valid namespaces: svc-a, payments');
  });

  it('refuses any flag value when no namespace is active', async () => {
    writeManifest(tmpDir, { 'svc-a': ['svc-a'] });
    const { resolveLearningsDestination } = await import('../contribute.js');
    await expect(
      resolveLearningsDestination(localConfigFor([]), 'svc-a'),
    ).rejects.toThrow('reads no learnings namespace');
  });
});

describe('contribute --namespace (#916)', () => {
  let tmpDir: string;
  let repoDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-ns-'));
    process.env.HOME = tmpDir;
    // One level in: the queue sits NEXT TO the repo checkout, and a repo at
    // the tmpDir root would put it in the shared OS temp dir.
    repoDir = path.join(tmpDir, 'repo');
    writeManifest(repoDir, { 'svc-a': ['svc-a'], payments: ['payments'] });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockConfig(projects: string[]) {
    // The pure-function tests above import contribute.js against the real
    // config; drop the registry so this import re-resolves it to the mock.
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      requireInit: vi.fn().mockResolvedValue({
        localConfig: {
          repo: { localPath: repoDir, remote: 'https://example.com/team/repo.git', kind: 'git' },
          username: 'testuser',
          projects,
          scope: 'user',
        },
        teamConfig: {},
      }),
      detectProjectConfig: vi.fn().mockResolvedValue(null),
    }));
    // The queue write checks the install's own config still names this install
    // as the queue's owner; without it every write is refused as stale.
    fs.mkdirSync(path.join(tmpDir, '.teamai'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${repoDir}\n  remote: https://example.com/team/repo.git\n  kind: git\nusername: testuser\nprojects: ${JSON.stringify(projects)}\n`,
      'utf-8',
    );
  }

  function contentFile(): string {
    const file = path.join(tmpDir, 'notes.md');
    fs.writeFileSync(file, '# Session Notes\nA payment routing insight.', 'utf-8');
    return file;
  }

  // The queue sits next to the repo checkout, not inside it.
  function queuedFiles(): string[] {
    const queueDir = path.join(path.dirname(repoDir), 'pending-learnings');
    if (!fs.existsSync(queueDir)) return [];
    return fs.readdirSync(queueDir, { recursive: true }) as string[];
  }

  function mockPublishNothing(): void {
    vi.doMock('../utils/learnings-publish.js', () => ({
      publishQueuedLearnings: vi.fn().mockResolvedValue({
        published: [], lastError: null, refused: false, installChanged: null,
      }),
    }));
  }

  it('files a learning under the requested namespace', async () => {
    mockConfig(['svc-a', 'payments']);
    mockPublishNothing();

    const { contribute } = await import('../contribute.js');
    await contribute({ file: contentFile(), title: 'Payments insight', namespace: 'payments' });

    expect(queuedFiles().some((f) => f.includes(`payments${path.sep}`))).toBe(true);
    vi.doUnmock('../config.js');
    vi.doUnmock('../utils/learnings-publish.js');
  });

  it('refuses an unknown namespace without queueing anything', async () => {
    mockConfig(['svc-a', 'payments']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { contribute } = await import('../contribute.js');
    await contribute({ file: contentFile(), namespace: 'nope' });

    // log.error prefixes its symbol; the message is the second argument.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Unknown learnings namespace "nope". Valid namespaces: svc-a, payments'),
    );
    expect(queuedFiles()).toEqual([]);

    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.doUnmock('../config.js');
  });

  it('hints at the namespaces when several are active and no flag is passed', async () => {
    mockConfig(['svc-a', 'payments']);
    mockPublishNothing();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { contribute } = await import('../contribute.js');
    await contribute({ file: contentFile() });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('several learnings namespaces (svc-a, payments)'),
    );

    logSpy.mockRestore();
    vi.doUnmock('../config.js');
    vi.doUnmock('../utils/learnings-publish.js');
  });

  it('shows the namespace in the dry-run path', async () => {
    mockConfig(['svc-a', 'payments']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { contribute } = await import('../contribute.js');
    await contribute({
      file: contentFile(), title: 'Payments insight', namespace: 'payments', dryRun: true,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Would push: learnings/payments/'));
    expect(queuedFiles()).toEqual([]);

    logSpy.mockRestore();
    vi.doUnmock('../config.js');
  });
});
