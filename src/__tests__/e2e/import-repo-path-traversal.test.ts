import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const UNSAFE_URL = 'https://gitlab.com/../../../victim';
const VALID_URL = 'https://git.example.com/team/sub/service.git';

describe('repository imports reject cache path traversal', () => {
  let sandbox: string;
  let cacheRoot: string;
  let victim: string;
  let output: string;
  let env: NodeJS.ProcessEnv;
  let head: string;

  function git(args: string[], cwd = victim): string {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10_000 }).trim();
  }

  function cli(args: string[]) {
    const result = spawnSync(process.execPath, [CLI, 'import', ...args, '--output', output, '--skip-enrich'], {
      cwd: sandbox, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return { code: result.status, output: result.stdout + result.stderr };
  }

  function expectVictimUnchanged(): void {
    expect(fs.readFileSync(path.join(victim, 'important.txt'), 'utf8')).toBe('Uncommitted user data\n');
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['status', '--porcelain'])).toBe('M important.txt');
  }

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-path-')));
    cacheRoot = path.join(sandbox, 'cache', 'repos');
    victim = path.join(sandbox, 'victim');
    output = path.join(sandbox, 'output');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(victim);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
    env = {
      ...process.env,
      HOME: home, USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
      GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(victim).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: VALID_URL,
      TEAMAI_CACHE_DIR: cacheRoot, GITLAB_TOKEN: '', FORCE_COLOR: '0',
    };
    fs.writeFileSync(path.join(victim, 'important.txt'), 'Committed user data\n');
    fs.writeFileSync(path.join(victim, 'index.ts'), 'export const service = 1;\n');
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    head = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(victim, 'important.txt'), 'Uncommitted user data\n');
    // The vulnerable cache calculation would resolve exactly to this user repository.
    expect(path.resolve(cacheRoot, 'gitlab', '../../..', 'victim')).toBe(victim);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    { flags: [] }, { flags: ['--incremental'] }, { flags: ['--dry-run'] },
    { flags: ['--incremental', '--dry-run'] },
  ])(
    'refuses an unsafe URL before reading or replacing its destination ($flags)', ({ flags }) => {
      // An incremental run must refuse the path even when it looks like a cached repository.
      fs.writeFileSync(path.join(victim, 'LAST_SYNC'), `${head}\n2026-01-01T00:00:00.000Z\n`);
      const result = cli(['--from-repo', UNSAFE_URL, ...flags]);

      expect(fs.existsSync(path.join(victim, 'important.txt')), result.output).toBe(true);
      fs.unlinkSync(path.join(victim, 'LAST_SYNC'));
      expectVictimUnchanged();
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('Invalid repository cache path');
      expect(result.output).not.toContain('Shallow clone to cache');
      expect(result.output).not.toContain('[incremental] cache hit');
      expect(fs.existsSync(cacheRoot)).toBe(false);
      expect(fs.existsSync(output)).toBe(false);
    },
  );

  it('rejects an unsafe URL from a repository list without deleting user files', () => {
    const list = path.join(sandbox, 'repos.yaml');
    fs.writeFileSync(list, `version: 1\nrepos:\n  - url: ${UNSAFE_URL}\n`);
    const result = cli(['--from-repo-list', list]);

    expectVictimUnchanged();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Invalid repository cache path');
    expect(fs.existsSync(cacheRoot)).toBe(false);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('still imports and incrementally refreshes a valid repository with nested groups', () => {
    const first = cli(['--from-repo', VALID_URL]);
    expect(first.code, first.output).toBe(0);
    const cache = path.join(cacheRoot, 'git', 'team', 'sub', 'service');
    expect(git(['rev-parse', 'HEAD'], cache)).toBe(head);
    const manifest = path.join(output, 'teamwiki', 'evidence', 'code', 'git__team-sub__service', 'source-manifest.json');
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).headSha).toBe(head);

    const incremental = cli(['--from-repo', VALID_URL, '--incremental']);
    expect(incremental.code, incremental.output).toBe(0);
    expect(incremental.output).toContain('SHA unchanged');
    expectVictimUnchanged();
  });
});
