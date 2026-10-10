import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGitExcludeFailure, localAgentGitExcludeNotices, readGitExcludeNotices, recordGitExcludeFailure, sayGitExcludeNotices,
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

  it('keeps the local agent\'s failure through a pull\'s success, and the pull\'s through the local agent\'s', async () => {
    await recordGitExcludeFailure(localAgentGitExcludeNotices(), 'local agent block not written');
    await recordGitExcludeFailure(project, 'delivered block not written');

    await clearGitExcludeFailure(project);
    expect((await readGitExcludeNotices(localAgentGitExcludeNotices())).lastFailure?.message).toBe('local agent block not written');
    expect((await readGitExcludeNotices(project)).lastFailure).toBeNull();

    await recordGitExcludeFailure(project, 'delivered block not written');
    await clearGitExcludeFailure(localAgentGitExcludeNotices());
    expect((await readGitExcludeNotices(project)).lastFailure?.message).toBe('delivered block not written');
    expect((await readGitExcludeNotices(localAgentGitExcludeNotices())).lastFailure).toBeNull();
  });

  it('says the local agent\'s failure once, naming the local agent, and keeps another owner\'s record in the same file', async () => {
    const file = path.join(home, '.teamai', 'local-agent', 'git-exclude-notices.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const other = { lastFailure: { at: '2026-01-01T00:00:00.000Z', message: 'credentials block not written' }, notices: [] };
    fs.writeFileSync(file, JSON.stringify({ credentials: other }));
    await recordGitExcludeFailure(localAgentGitExcludeNotices(), 'could not write it');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    expect(await sayGitExcludeNotices(localAgentGitExcludeNotices())).toBe(true);
    expect(await sayGitExcludeNotices(localAgentGitExcludeNotices())).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^A local agent sync \(.+\) could not keep teamai's git exclude blocks up to date: could not write it$/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).credentials).toEqual(other);
  });
});
