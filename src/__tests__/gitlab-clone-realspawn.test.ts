import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// NOTE: no vi.mock('node:child_process') here — this exercises a REAL git spawn
// against a fake `git` on PATH, to verify the token never reaches the URL/argv
// and that error output is sanitized end-to-end.
import { gitlabRepoClone } from '../providers/gitlab/gitlab-api.js';

describe('gitlabRepoClone — real spawn (e2e)', () => {
  let tmp: string;
  const origPath = process.env.PATH;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-clone-e2e-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    // Fake git: records its argv, then fails like a 403 with creds in the URL.
    const fakeGit = path.join(bin, 'git');
    fs.writeFileSync(
      fakeGit,
      [
        '#!/bin/bash',
        `printf '%s\\n' "$@" > "${path.join(tmp, 'argv.txt')}"`,
        `echo "fatal: unable to access 'https://oauth2:glpat_e2e_secret@gitlab.example.com/org/repo.git/': The requested URL returned error: 403" >&2`,
        'exit 128',
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${origPath}`;
    process.env.GITLAB_TOKEN = 'glpat_e2e_secret';
  });

  afterEach(() => {
    process.env.PATH = origPath;
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('never passes the token in the clone URL/argv and sanitizes the error', () => {
    let err: Error | null = null;
    try {
      gitlabRepoClone('org/repo', path.join(tmp, 'dest'));
    } catch (e) {
      err = e as Error;
    }

    // The real git argv, as the child process saw it.
    const argv = fs.readFileSync(path.join(tmp, 'argv.txt'), 'utf-8').split('\n');
    const urlArg = argv.find((a) => a.endsWith('.git'));
    expect(urlArg).toBeDefined();
    // Token must NOT be embedded in the clone URL.
    expect(urlArg).not.toContain('glpat_e2e_secret');
    expect(urlArg).not.toContain('oauth2:');
    // Token travels only inside the http.extraHeader arg (base64), never plaintext.
    expect(argv.some((a) => a.includes('glpat_e2e_secret'))).toBe(false);
    expect(argv.some((a) => a.startsWith('http.extraHeader=Authorization: Basic '))).toBe(true);

    // Error surfaced to the caller is sanitized.
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain('glpat_e2e_secret');
    expect(err!.message).toContain('***@');
  });
});
