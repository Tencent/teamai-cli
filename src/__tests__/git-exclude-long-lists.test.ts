import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Windows refuses a command line past 32767 characters with `spawn ENAMETOOLONG` (#1977).
vi.mock('@teamai/shared/exec', async (importOriginal) => {
  const real = await importOriginal<typeof import('@teamai/shared/exec')>();

  return {
    ...real,
    execCommand: (command: string, args: string[], options?: Parameters<typeof real.execCommand>[2]) =>
      args.join(' ').length > 32_767 ? Promise.reject(new Error('spawn ENAMETOOLONG')) : real.execCommand(command, args, options),
  };
});

const { GitContext, lsFilesBatched } = await import('../git-exclude.js');
const { fileHash } = await import('../utils/fs.js');
const { keptTrackedCopies } = await import('../doctor-git-exclude.js');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('git commands over long path lists (#1977)', () => {
  let repo: string;
  let rels: string[];

  beforeEach(async () => {
    repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-long-'));
    git(repo, 'init', '-q');
    rels = Array.from({ length: 1000 }, (_, i) => `.claude/skills/some-long-skill-name-${String(i).padStart(4, '0')}/SKILL.md`);

    for (const rel of rels) await fse.outputFile(path.join(repo, rel), 'x');

    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files');
  });

  afterEach(() => fse.remove(repo));

  it('GitContext.listFiles lists every tracked file', async () => {
    const listed = await new GitContext().listFiles(repo, rels, 'tracked');

    expect(listed.code).toBe(0);
    expect(listed.stdout.split('\0').filter(Boolean).sort()).toEqual([...rels].sort());
  });

  it('the doctor check finds every kept tracked copy', async () => {
    const files = rels.map((rel) => path.join(repo, rel));
    const delivered = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await fileHash(file)])));

    // A skill is named as its directory.
    expect((await keptTrackedCopies(repo, delivered, [])).sort()).toEqual(files.map((file) => path.dirname(file)).sort());
  });

  describe('lsFilesBatched', () => {
    it('joins the output of every run', async () => {
      const seen: string[][] = [];
      const listed = await lsFilesBatched(['ls'], rels, async (args) => {
        seen.push(args);

        return { code: 0, stdout: args.slice(1).map((a) => `${a}\0`).join(''), stderr: '' };
      });

      expect(seen.length).toBeGreaterThan(1);
      expect(listed.stdout).toBe(rels.map((a) => `${a}\0`).join(''));
    });

    it('returns the first run that fails', async () => {
      let calls = 0;
      const listed = await lsFilesBatched(['ls'], rels, async () => ({ code: ++calls === 2 ? 128 : 0, stdout: 'ok\0', stderr: calls === 2 ? 'boom' : '' }));

      expect(listed).toEqual({ code: 128, stdout: 'ok\0', stderr: 'boom' });
      expect(calls).toBe(2);
    });
  });
});
