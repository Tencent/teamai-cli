import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { contribute } from '../contribute.js';

// A failed contribution must leave a nonzero exit status so a shell or CI
// step that relies on it does not continue as if the contribution succeeded.
describe('contribute failure exit status (#2133)', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contrib-exit-'));
    process.env.HOME = tmpDir;
    process.exitCode = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.exitCode = originalExitCode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits nonzero with no --file', async () => {
    await contribute({});
    expect(process.exitCode).toBe(1);
  });

  it('exits nonzero when the file cannot be read', async () => {
    await contribute({ file: path.join(tmpDir, 'missing.md') });
    expect(process.exitCode).toBe(1);
  });

  it('exits nonzero when the file is empty', async () => {
    const empty = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(empty, '', 'utf-8');
    await contribute({ file: empty });
    expect(process.exitCode).toBe(1);
  });
});
