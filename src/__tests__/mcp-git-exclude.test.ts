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
const failLsFiles = vi.hoisted(() => ({ on: false }));
const failVerboseCheckIgnore = vi.hoisted(() => ({ on: false }));
vi.mock('../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...actual,
    execCommand: (cmd: string, args: string[], opts?: Parameters<typeof actual.execCommand>[2]) =>
      (failCheckIgnore.on || (failVerboseCheckIgnore.on && args.includes('-v'))) && args[0] === 'check-ignore'
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository' })
        : failLsFiles.on && args.includes('ls-files')
          ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: index file corrupt' })
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

import { MCP_EXCLUDE_END, MCP_EXCLUDE_START, ensureExcludedFromGit, excludeFromGit, removeMcpGitExclude } from '../mcp-git-exclude.js';
import { acquireLock, releaseLock } from '../update.js';
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
    failLsFiles.on = false;
    failVerboseCheckIgnore.on = false;
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

    it('excludes a file git answers it does not track', async () => {
      failCheckIgnore.on = true;

      expect(await ensureExcludedFromGit(path.join(repo, '.mcp.json'))).toEqual({ kind: 'excluded', added: true });
      expect(await fse.readFile(excludeFile, 'utf8')).toMatch(/^\/\.mcp\.json$/m);
    });

    it('fails for a file git tracks, and writes nothing', async () => {
      const file = path.join(repo, '.mcp.json');
      await fse.writeJson(file, {});
      execFileSync('git', ['add', '.mcp.json'], { cwd: repo });
      failCheckIgnore.on = true;

      expect(await ensureExcludedFromGit(file)).toMatchObject({ kind: 'failed', reason: `git already tracks ${file}` });
      expect(await fse.pathExists(excludeFile) ? await fse.readFile(excludeFile, 'utf8') : '').not.toContain('teamai');
    });

    it('fails with git\'s error, and writes nothing, when git cannot say whether it tracks the file either', async () => {
      failCheckIgnore.on = true;
      failLsFiles.on = true;

      expect(await ensureExcludedFromGit(path.join(repo, '.mcp.json'))).toMatchObject({
        kind: 'failed',
        reason: expect.stringContaining('fatal: index file corrupt'),
      });
      expect(await fse.pathExists(excludeFile) ? await fse.readFile(excludeFile, 'utf8') : '').not.toContain('teamai');
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

  describe('while another command holds the exclude file\'s lock', () => {
    beforeEach(async () => {
      expect(await acquireLock(`${excludeFile}.teamai-lock`)).toBe(true);
    });

    afterEach(async () => {
      await releaseLock(`${excludeFile}.teamai-lock`);
    });

    it('does not write, and warns that the file is not excluded yet and to pull again', async () => {
      await fse.outputFile(excludeFile, 'scratch/\n');
      await fse.writeJson(path.join(repo, '.mcp.json'), {});

      await excludeFromGit(path.join(repo, '.mcp.json'));

      expect(await fse.readFile(excludeFile, 'utf8')).toBe('scratch/\n');
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(path.join(repo, '.mcp.json')));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('teamai pull'));
    });

    it('does not remove patterns', async () => {
      const content = `${MCP_EXCLUDE_START}\n/.mcp.json\n${MCP_EXCLUDE_END}\n`;
      await fse.outputFile(excludeFile, content);

      expect(await removeMcpGitExclude(excludeFile, ['/.mcp.json'])).toBe('locked');

      expect(await fse.readFile(excludeFile, 'utf8')).toBe(content);
    });
  });

  it('removes only the patterns asked for, and the block with its last one', async () => {
    await fse.outputFile(excludeFile, `mine/\n${MCP_EXCLUDE_START}\n/a.json\n/b.json\n${MCP_EXCLUDE_END}\n`);

    expect(await removeMcpGitExclude(excludeFile, ['/a.json'])).toBe('written');
    expect(await fse.readFile(excludeFile, 'utf8')).toBe(`mine/\n${MCP_EXCLUDE_START}\n/b.json\n${MCP_EXCLUDE_END}\n`);

    expect(await removeMcpGitExclude(excludeFile, ['/b.json'])).toBe('written');
    expect(await fse.readFile(excludeFile, 'utf8')).toBe('mine/\n');
  });

  describe('for a file git already tracks', () => {
    beforeEach(async () => {
      await fse.writeJson(path.join(repo, '.mcp.json'), {});
      execFileSync('git', ['add', '.mcp.json'], { cwd: repo });
    });

    it('says so on a dry run before any pull has listed it, and writes nothing', async () => {
      const file = path.join(repo, '.mcp.json');

      expect(await ensureExcludedFromGit(file, { dryRun: true })).toEqual({
        kind: 'failed',
        reason: `git already tracks ${file}`,
        fix: `Run \`git rm --cached ${file}\` (rotate any value a commit of it holds), then \`teamai pull\` again.`,
      });
      expect(await fse.pathExists(excludeFile) ? await fse.readFile(excludeFile, 'utf8') : '').not.toContain('teamai');
    });

    it.skipIf(process.getuid?.() === 0).each([
      ['a pull', {}],
      ['a dry run', { dryRun: true }],
    ])('names the tracked file first on %s when .git/info is not writable either', async (_label, options) => {
      const info = path.join(repo, '.git', 'info');
      await fse.chmod(info, 0o555);

      try {
        const exclusion = await ensureExcludedFromGit(path.join(repo, '.mcp.json'), options);
        expect(exclusion).toMatchObject({ kind: 'failed', reason: `git already tracks ${path.join(repo, '.mcp.json')}` });
      } finally {
        await fse.chmod(info, 0o755);
      }
    });
  });

  // A rule after teamai's line, or in a .gitignore, which git reads first, can re-include the file.
  describe('for a file a rule of the member\'s re-includes', () => {
    beforeEach(async () => {
      await fse.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n!/.mcp.json\n');
    });

    it('names the rule, and says to remove it rather than untrack the file', async () => {
      const file = path.join(repo, '.mcp.json');
      const gitignore = path.join(await fse.realpath(repo), '.gitignore');

      expect(await ensureExcludedFromGit(file)).toEqual({
        kind: 'failed',
        reason: `a rule in your git ignore files re-includes ${file}: \`!/.mcp.json\` (${gitignore}:2)`,
        fix: `Remove \`!/.mcp.json\` from ${gitignore}, then run \`teamai pull\` again.`,
      });
    });

    it('names the rule on a dry run too, before any line is written', async () => {
      const file = path.join(repo, '.mcp.json');
      const gitignore = path.join(await fse.realpath(repo), '.gitignore');

      expect(await ensureExcludedFromGit(file, { dryRun: true })).toEqual({
        kind: 'failed',
        reason: `a rule in your git ignore files re-includes ${file}: \`!/.mcp.json\` (${gitignore}:2)`,
        fix: `Remove \`!/.mcp.json\` from ${gitignore}, then run \`teamai pull\` again.`,
      });
      expect(await fse.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8').catch(() => '')).not.toContain('teamai');
    });

    it('says so when git cannot name the rule', async () => {
      failVerboseCheckIgnore.on = true;
      const file = path.join(repo, '.mcp.json');

      expect(await ensureExcludedFromGit(file)).toEqual({
        kind: 'failed',
        reason: `a rule in your git ignore files re-includes ${file}`,
        fix: 'Remove the rule in .gitignore, .git/info/exclude or core.excludesFile that re-includes it (`git check-ignore -v` names it), then run `teamai pull` again.',
      });
    });
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
    expect(await removeMcpGitExclude(excludeFile, ['/.mcp.json'])).toBe('written');

    expect(await fse.readFile(excludeFile, 'utf8')).toBe(`${MCP_EXCLUDE_START}\n/old.json\nscratch/\n`);
  });
  // The appliers replace the file itself (tmp + rename) but follow its directories (#886).
  describe('for a file under a symlinked directory, judged where the write lands', () => {
    let real: string;
    const commit = (...files: string[]): void => {
      execFileSync('git', ['add', ...files], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'config'], { cwd: repo });
    };

    beforeEach(async () => {
      real = await fse.realpath(repo);
      await fse.outputFile(path.join(repo, 'config', 'README.md'), 'cursor config\n');
      await fse.symlink('config', path.join(repo, '.cursor'), 'dir');
    });

    it('fails for a file git tracks there, naming both paths and the one to untrack', async () => {
      await fse.writeJson(path.join(repo, 'config', 'mcp.json'), {});
      commit('config', '.cursor');
      const file = path.join(repo, '.cursor', 'mcp.json');
      const landed = path.join(real, 'config', 'mcp.json');

      expect(await ensureExcludedFromGit(file)).toEqual({
        kind: 'failed',
        reason: `git already tracks ${landed} (where ${file} is written)`,
        fix: `Run \`git rm --cached ${landed}\` (rotate any value a commit of it holds), then \`teamai pull\` again.`,
      });
      expect(await fse.pathExists(excludeFile) ? await fse.readFile(excludeFile, 'utf8') : '').not.toContain('teamai');
    });

    it('lists the file it lands in, in a tracked directory', async () => {
      commit('config', '.cursor');

      expect(await ensureExcludedFromGit(path.join(repo, '.cursor', 'mcp.json'))).toEqual({ kind: 'excluded', added: true });
      await fse.writeJson(path.join(repo, 'config', 'mcp.json'), {});

      expect(await fse.readFile(excludeFile, 'utf8')).toMatch(/^\/config\/mcp\.json$/m);
      expect(await fse.readFile(excludeFile, 'utf8')).not.toContain('/.cursor/');
      expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })).not.toContain('config/mcp.json');
    });

    it('lists a file whose directory does not exist yet under the one it will be created in', async () => {
      expect(await ensureExcludedFromGit(path.join(repo, '.cursor', 'sub', 'mcp.json'))).toEqual({ kind: 'excluded', added: true });

      expect(await fse.readFile(excludeFile, 'utf8')).toMatch(/^\/config\/sub\/mcp\.json$/m);
    });

    it('protects it in the repository the directory links into, not this one', async () => {
      const other = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-other-repo-'));
      execFileSync('git', ['init', '-q'], { cwd: other });
      await fse.ensureDir(path.join(other, 'cfg'));
      await fse.symlink(path.join(other, 'cfg'), path.join(repo, '.tool'), 'dir');

      try {
        expect(await ensureExcludedFromGit(path.join(repo, '.tool', 'mcp.json'))).toEqual({ kind: 'excluded', added: true });
        expect(await fse.readFile(path.join(other, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/cfg\/mcp\.json$/m);
        expect(await fse.pathExists(excludeFile) ? await fse.readFile(excludeFile, 'utf8') : '').not.toContain('teamai');
      } finally {
        await fse.remove(other);
      }
    });

    it('lists nothing and stays quiet when the directory links outside any repository', async () => {
      const outside = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-no-repo-'));
      await fse.symlink(outside, path.join(repo, '.tool'), 'dir');
      await fse.writeJson(path.join(outside, 'mcp.json'), {});

      try {
        expect(await ensureExcludedFromGit(path.join(repo, '.tool', 'mcp.json'))).toEqual({ kind: 'excluded', added: false });
        await excludeFromGit(path.join(repo, '.tool', 'mcp.json'));
        expect(log.warn).not.toHaveBeenCalled();
        expect(await fse.pathExists(excludeFile) ? await fse.readFile(excludeFile, 'utf8') : '').not.toContain('teamai');
      } finally {
        await fse.remove(outside);
      }
    });

    it('judges a directory that links nowhere from the closest one that exists: no write lands through it', async () => {
      await fse.symlink('missing', path.join(repo, '.dangling'), 'dir');

      expect(await ensureExcludedFromGit(path.join(repo, '.dangling', 'mcp.json'))).toEqual({ kind: 'excluded', added: true });
      expect(await fse.readFile(excludeFile, 'utf8')).toMatch(/^\/\.dangling\/mcp\.json$/m);
      await expect(fse.ensureDir(path.join(repo, '.dangling'))).rejects.toThrow();
    });

    it('judges a symlink at the file itself as the file: the write replaces it', async () => {
      await fse.writeJson(path.join(repo, 'config', 'mcp.json'), {});
      commit('config');
      await fse.symlink(path.join('config', 'mcp.json'), path.join(repo, '.mcp.json'));

      expect(await ensureExcludedFromGit(path.join(repo, '.mcp.json'))).toEqual({ kind: 'excluded', added: true });
      expect(await fse.readFile(excludeFile, 'utf8')).toMatch(/^\/\.mcp\.json$/m);
      expect(await fse.readFile(excludeFile, 'utf8')).not.toContain('/config/');
    });
  });
});
