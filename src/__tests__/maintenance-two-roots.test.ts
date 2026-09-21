import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
}));

import { writeBackConfidence } from '../maintenance/confidence.js';
import { executePrune } from '../maintenance/prune.js';
import { log } from '../utils/logger.js';

/**
 * Learnings live in two roots after #485: the branch worktree, which is pushed,
 * and the clone's `learnings/`, which is not. Maintenance may only change what
 * it can publish.
 */
describe('maintenance across the write root and the inherited root', () => {
  let tmp: string;
  let writeRoot: string;
  let inherited: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-maint-roots-'));
    writeRoot = path.join(tmp, 'learnings-wt', 'learnings');
    inherited = path.join(tmp, 'team-repo', 'learnings');
    fs.mkdirSync(writeRoot, { recursive: true });
    fs.mkdirSync(inherited, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes an inherited learning back into the write root, leaving the clone untouched', async () => {
    fs.writeFileSync(path.join(inherited, 'old.md'), '---\ntitle: old\nconfidence: 0.1\n---\nbody');

    const updated = await writeBackConfidence(
      [writeRoot, inherited],
      new Map([['old', 0.9]]),
      writeRoot,
    );

    expect(updated).toBe(1);
    expect(fs.readFileSync(path.join(writeRoot, 'old.md'), 'utf8')).toContain('confidence: 0.9');
    expect(fs.readFileSync(path.join(inherited, 'old.md'), 'utf8')).toContain('confidence: 0.1');
  });

  it('updates a learning already in the write root in place', async () => {
    fs.writeFileSync(path.join(writeRoot, 'new.md'), '---\ntitle: new\nconfidence: 0.1\n---\nbody');

    await writeBackConfidence([writeRoot, inherited], new Map([['new', 0.9]]), writeRoot);

    expect(fs.readFileSync(path.join(writeRoot, 'new.md'), 'utf8')).toContain('confidence: 0.9');
  });

  it('refuses to prune an inherited learning, and says what to do instead', async () => {
    fs.writeFileSync(path.join(inherited, 'old.md'), '---\ntitle: old\n---\nbody');

    const result = await executePrune(writeRoot, [{
      filename: 'old.md',
      path: path.join(inherited, 'old.md'),
      confidence: 0.05,
      lastActivity: '',
      reason: 'test',
    }]);

    expect(result).toEqual({ archived: 0, removed: 0 });
    expect(fs.existsSync(path.join(inherited, 'old.md'))).toBe(true);
    expect(vi.mocked(log.warn).mock.calls.join(' ')).toContain('pull request');
  });

  it('archives a learning from the write root into a directory that is published', async () => {
    fs.writeFileSync(path.join(writeRoot, 'stale.md'), '---\ntitle: stale\n---\nbody');

    const result = await executePrune(writeRoot, [{
      filename: 'stale.md',
      path: path.join(writeRoot, 'stale.md'),
      confidence: 0.05,
      lastActivity: '',
      reason: 'test',
    }], { archive: true });

    expect(result.archived).toBe(1);
    expect(fs.existsSync(path.join(writeRoot, '_archive', 'stale.md'))).toBe(true);
    expect(fs.existsSync(path.join(writeRoot, 'stale.md'))).toBe(false);
  });
});
