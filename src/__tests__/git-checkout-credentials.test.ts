import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutCredentials } from '../utils/git.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('checkoutCredentials', () => {
  it('answers the credential and http settings the checkout\'s own config holds, in order, as init and actions/checkout write them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-checkout-credentials-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', '--local', '--add', 'credential.https://github.com.helper', '');
    git(dir, 'config', '--local', '--add', 'credential.https://github.com.helper', '!f() { echo username=x-access-token; }; f');
    git(dir, 'config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA==');
    git(dir, 'config', '--local', 'user.name', 'member');

    expect(await checkoutCredentials(dir)).toEqual([
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', '!f() { echo username=x-access-token; }; f'],
      ['http.https://github.com/.extraheader', 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA=='],
    ]);
  });

  it('answers none for a checkout whose config holds no credential source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-checkout-credentials-'));
    dirs.push(dir);
    git(dir, 'init', '-q');

    expect(await checkoutCredentials(dir)).toEqual([]);
  });
});
