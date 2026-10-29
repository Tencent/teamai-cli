import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGitExcludeFailure, readGitExcludeNotices, recordGitExcludeFailure, sayGitExcludeNotices,
} from '../git-exclude-notices.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

describe('git exclude notices kept per owner (#915)', () => {
  let home: string;
  let origHome: string | undefined;
  let project: LocalConfig;

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-notices-')));
    origHome = process.env.HOME;
    process.env.HOME = home;
    const dataHome = path.join(home, '.teamai', 'projects', 'app');
    fs.mkdirSync(dataHome, { recursive: true });
    project = { scope: 'project', projectRoot: path.join(home, 'app'), dataHome } as unknown as LocalConfig;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps the other writer\'s failure through a pull\'s success, and the pull\'s through the other writer\'s', async () => {
    await recordGitExcludeFailure(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }), 'other writer block not written');
    await recordGitExcludeFailure(project, 'delivered block not written');

    await clearGitExcludeFailure(project);
    expect((await readGitExcludeNotices(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }))).lastFailure?.message).toBe('other writer block not written');
    expect((await readGitExcludeNotices(project)).lastFailure).toBeNull();

    await recordGitExcludeFailure(project, 'delivered block not written');
    await clearGitExcludeFailure(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }));
    expect((await readGitExcludeNotices(project)).lastFailure?.message).toBe('delivered block not written');
    expect((await readGitExcludeNotices(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }))).lastFailure).toBeNull();
  });

  it('says the other writer\'s failure once, naming the other writer, and keeps another owner\'s record in the same file', async () => {
    const file = path.join(home, '.teamai', 'other', 'git-exclude-notices.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const other = { lastFailure: { at: '2026-01-01T00:00:00.000Z', message: 'credentials block not written' }, notices: [] };
    fs.writeFileSync(file, JSON.stringify({ credentials: other }));
    await recordGitExcludeFailure(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }), 'could not write it');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    expect(await sayGitExcludeNotices(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }))).toBe(true);
    expect(await sayGitExcludeNotices(({ stateHome: path.join(home, '.teamai', 'other'), owner: 'other', label: 'Another writer' }))).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^Another writer \(.+\) could not keep teamai's git exclude blocks up to date: could not write it$/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).credentials).toEqual(other);
  });
});
