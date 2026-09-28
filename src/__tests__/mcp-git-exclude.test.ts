import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn() },
}));

// Git's own failure modes (unsafe repository, bad config) are hard to stage for one subcommand alone.
const failCheckIgnore = vi.hoisted(() => ({ on: false }));
vi.mock('../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...actual,
    execCommand: (cmd: string, args: string[], opts?: Parameters<typeof actual.execCommand>[2]) =>
      failCheckIgnore.on && args[0] === 'check-ignore'
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository' })
        : actual.execCommand(cmd, args, opts),
  };
});

// Widens the read-modify-write window on the exclude file, as a slow disk or a second process would.
const slowExcludeRead = vi.hoisted(() => ({ on: false }));
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    readFileSafe: async (file: string) => {
      const content = await actual.readFileSafe(file);
      if (slowExcludeRead.on && file.endsWith(path.join('info', 'exclude'))) await new Promise((r) => setTimeout(r, 30));
      return content;
    },
  };
});

import { MCP_EXCLUDE_START, excludeFromGit, removeMcpGitExclude } from '../mcp-git-exclude.js';
import { log } from '../utils/logger.js';

describe('teamai block in .git/info/exclude (#882)', () => {
  let repo: string;
  let excludeFile: string;

  beforeEach(async () => {
    repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-exclude-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    excludeFile = path.join(repo, '.git', 'info', 'exclude');
  });

  afterEach(async () => {
    failCheckIgnore.on = false;
    slowExcludeRead.on = false;
    vi.mocked(log.warn).mockClear();
    await fse.remove(repo);
  });

  describe('when git cannot say whether it would commit the file', () => {
    it('still excludes it while the exclude file is reachable', async () => {
      await fse.writeJson(path.join(repo, '.mcp.json'), {});
      failCheckIgnore.on = true;

      await excludeFromGit(path.join(repo, '.mcp.json'));

      expect(await fse.readFile(excludeFile, 'utf8')).toMatch(/^\/\.mcp\.json$/m);
    });

    it('warns with the file and git\'s error when it is not', async () => {
      await fse.writeJson(path.join(repo, '.mcp.json'), {});
      await fse.writeFile(path.join(repo, '.git', 'config'), '[core\nbroken\n');

      await excludeFromGit(path.join(repo, '.mcp.json'));

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(path.join(repo, '.mcp.json')));
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/config/));
    });
  });

  it('keeps every pattern when several writers add to the same exclude file at once', async () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((name) => path.join(repo, `${name}.json`));
    for (const file of files) await fse.writeJson(file, {});
    slowExcludeRead.on = true;

    await Promise.all(files.map((file) => excludeFromGit(file)));

    const content = await fse.readFile(excludeFile, 'utf8');
    for (const name of ['a', 'b', 'c', 'd', 'e']) expect(content).toMatch(new RegExp(`^/${name}\\.json$`, 'm'));
  });

  it('stays quiet outside any repository', async () => {
    const outside = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-no-repo-'));
    await fse.writeJson(path.join(outside, '.mcp.json'), {});

    await excludeFromGit(path.join(outside, '.mcp.json'));

    expect(log.warn).not.toHaveBeenCalled();
    await fse.remove(outside);
  });

  it('never takes the member\'s lines when a start marker has lost its end marker', async () => {
    await fse.writeFile(excludeFile, `${MCP_EXCLUDE_START}\n/old.json\nscratch/\n`);
    await fse.writeJson(path.join(repo, '.mcp.json'), {});

    await excludeFromGit(path.join(repo, '.mcp.json'));
    expect(await removeMcpGitExclude(excludeFile)).toBe(true);

    expect(await fse.readFile(excludeFile, 'utf8')).toBe(`${MCP_EXCLUDE_START}\n/old.json\nscratch/\n`);
  });
});
