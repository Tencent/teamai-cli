/**
 * A git that did not start (not installed, not on PATH) answers no question: it exits with no code of its own, so what
 * git() returns must not read as the 0 or 1 an exit-code question answers with.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedGit, fetchMissingCommits, offBranch, reconcileCopy } from '../workflow/worktree.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('git when git does not start', () => {
  const later = new Date(Date.now() + 60_000).toISOString();

  it.each([['run to its end', undefined], ['run under a deadline', later]])('returns the code of a command that did not start, %s, never a no', async (_, expiresAt) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);
    const withoutGit = boundedGit(expiresAt, { PATH: root });

    const asked = await withoutGit(root, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD']);

    expect(asked).toMatchObject({ code: 127, stdout: '', stderr: expect.stringContaining('check that git is installed and on PATH') });
  });

  it.each([['run to its end', undefined], ['run under a deadline', later]])('says why a git that is there did not start, %s, never that it is missing', async (_, expiresAt) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'git'), '', { mode: 0o644 });

    const asked = await boundedGit(expiresAt, { PATH: root })(root, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD']);

    expect(asked).toMatchObject({ code: 127, stderr: expect.stringContaining('EACCES') });
    expect(asked.stderr).not.toContain('installed');
  });

  it.each([['run to its end', undefined], ['run under a deadline', later]])('fails in a directory that is gone as git -C does, %s, so a missing repository stays a no', async (_, expiresAt) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);

    const asked = await boundedGit(expiresAt)(path.join(root, 'gone'), ['cat-file', '-e', 'HEAD^{commit}']);

    expect(asked).toMatchObject({ code: 128, stderr: expect.stringContaining('cannot change to') });
  });

  it('answers nothing when git is stopped at its deadline, never a no', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });

    const asked = await boundedGit(new Date(Date.now() + 300).toISOString(), { PATH: root })(root, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD']);

    expect(asked).toMatchObject({ code: 124, stderr: expect.stringContaining('stopped') });
  });

  it('finishes a place git cannot read as off its branch and lacking its commits, with git\'s cause, never throwing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);
    vi.stubEnv('PATH', root);
    const commit = 'a'.repeat(40);

    await expect(offBranch(root, 'feature')).resolves.toContain('git did not start');
    await expect(fetchMissingCommits(root, { run: 'r0123456789abcdef', commits: [commit] })).resolves.toEqual({ missing: [commit], fetchError: expect.stringContaining('git did not start') });
  });

  // macOS without the Command Line Tools: /usr/bin/git is a stub that runs no git, says why on stderr and exits 1.
  const STUB_NOTE = [
    'xcode-select: note: No developer tools were found, requesting install.',
    'If developer tools are located at a non-default location on disk, use `sudo xcode-select --switch path`, and cancel the installation dialog.',
    'See `man xcode-select\' for more details.',
  ];

  it.each([
    ['is not on PATH', undefined, 'git did not start'],
    ['is the macOS stub with no Command Line Tools', STUB_NOTE, 'xcode-select: note: No developer tools were found'],
    ['is the macOS stub whose Command Line Tools are gone', ['xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun'], 'xcrun: error: invalid active developer path'],
  ])('refuses to resume a run whose branch git cannot look up, as when git %s, never taking it for a branch this checkout lacks', async (_, stderr, cause) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-not-started-'));
    roots.push(root);
    if (stderr) {
      fs.writeFileSync(path.join(root, 'stub-note'), `${stderr.join('\n')}\n`);
      // Shell builtins only: PATH holds nothing but this stub.
      fs.writeFileSync(path.join(root, 'git'), `#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' "$line" >&2; done < '${path.join(root, 'stub-note')}'\nexit 1\n`, { mode: 0o755 });
    }
    vi.stubEnv('PATH', root);

    const reconciled = await reconcileCopy(root, 'feature', 'a'.repeat(40));

    expect(reconciled).toEqual({ error: expect.stringContaining(cause) });
  });
});
