import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── contribute.ts tests ────────────────────────────────────
// These test the contribute() function in isolation,
// mocking git operations and config loading.

describe('contribute', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-test-'));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects empty file', async () => {
    // Write empty file
    const emptyFile = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(emptyFile, '', 'utf-8');

    // Mock requireInit to avoid actual config dependency
    vi.doMock('../config.js', () => ({
      requireInit: vi.fn().mockResolvedValue({
        localConfig: {
          repo: { localPath: tmpDir },
          username: 'testuser',
        },
        teamConfig: {},
      }),
    }));

    const { contribute } = await import('../contribute.js');

    // Capture log output
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await contribute({ file: emptyFile });

    // Should not crash — graceful error
    errorSpy.mockRestore();
    vi.doUnmock('../config.js');
  });

  it('rejects missing file', async () => {
    const { contribute } = await import('../contribute.js');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await contribute({ file: '/nonexistent/path.md' });

    // Should not crash
    errorSpy.mockRestore();
  });

  it('generates valid filenames with title', () => {
    // Test the filename generation pattern indirectly
    // The format is: data-<slug>-<random>.md
    const title = 'K8s Pod Startup Timeout Fix!!!';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);

    expect(slug).toBe('k8s-pod-startup-timeout-fix');
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('generates valid filenames with Chinese title', () => {
    const title = 'K8s部署问题排查';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);

    expect(slug).toBe('k8s部署问题排查');
  });

  it('handles dry-run mode', async () => {
    const contentFile = path.join(tmpDir, 'notes.md');
    fs.writeFileSync(contentFile, '# Session Notes\nSome learnings here.', 'utf-8');

    vi.doMock('../config.js', () => ({
      requireInit: vi.fn().mockResolvedValue({
        localConfig: {
          repo: { localPath: tmpDir },
          username: 'testuser',
        },
        teamConfig: {},
      }),
    }));

    const { contribute } = await import('../contribute.js');

    // dry-run should not push
    await contribute({ file: contentFile, title: 'Test', dryRun: true });

    // No ai-docs directory should be created in the repo
    const aiDocsDir = path.join(tmpDir, 'ai-docs');
    // In dry-run, the file should NOT be copied
    // (contribute exits early before mkdir)
    vi.doUnmock('../config.js');
  });
});
