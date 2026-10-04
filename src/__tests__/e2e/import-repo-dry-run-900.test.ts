/**
 * E2E (#900 C3): `teamai import --from-repo` and `--from-repo-list` with
 * `--dry-run` read the remote head and stop.
 *
 * A dry run used to delete and re-clone the repo cache (or fetch and reset
 * it), take the import lock and run the LLM scan. A preview may ask the
 * remote for its head with `git ls-remote`; it must leave the cache, the lock
 * and the team repo alone, and say whether the cache is current.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shallowFetch } from '../../clone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

/** A host no provider claims, so the import uses plain git and no token lookup. */
const URL = 'https://git.example.com/acme/widget.git';

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

/** Every file under `dir` with its contents, so any write shows up as a diff. */
function tree(dir: string): Record<string, string> | null {
  if (!fs.existsSync(dir)) return null;
  const files: Record<string, string> = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const abs = path.join(dir, rel);
    files[rel] = fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'base64') : '<dir>';
  }
  return files;
}

describe('import --from-repo --dry-run (#900 C3)', () => {
  let sandbox: string;
  let home: string;
  let cacheRoot: string;
  let cacheDir: string;
  let teamRepo: string;
  let remote: string;
  let head: string;

  function runCLI(args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn('node', [CLI, ...args], {
        cwd: home,
        env: {
          ...process.env,
          ...GIT_ENV,
          HOME: home,
          USERPROFILE: home,
          FORCE_COLOR: '0',
          TEAMAI_CACHE_DIR: cacheRoot,
          // Send the made-up URL to the local bare repo.
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
          GIT_CONFIG_VALUE_0: URL,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      child.on('close', (code) => resolve({ code, output }));
    });
  }

  /** What a dry run must leave as it was: the cache, the team repo and the lock beside it. */
  function snapshot() {
    return {
      cache: tree(cacheRoot),
      teamRepo: tree(teamRepo),
      lock: fs.existsSync(path.join(path.dirname(teamRepo), '.teamai-import.lock')),
    };
  }

  async function dryRun(args: string[]): Promise<RunResult> {
    const before = snapshot();
    const result = await runCLI([...args, '--dry-run']);
    expect(snapshot(), result.output).toEqual(before);
    return result;
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-900-import-')));
    home = path.join(sandbox, 'home');
    cacheRoot = path.join(sandbox, 'cache');
    cacheDir = path.join(cacheRoot, 'git', 'acme', 'widget');
    teamRepo = path.join(home, '.teamai', 'team-repo');
    remote = path.join(sandbox, 'widget.git');

    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'index.ts'), 'export const widget = 1;\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'widget'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    head = git(['rev-parse', 'HEAD'], seed).trim();

    fs.mkdirSync(teamRepo, { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: issue-900-import\nrepo: local/team\nprovider: git\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      '  remote: local/team',
      'username: e2e',
      'updatePolicy: skip',
      'scope: user',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** A cache from an earlier import, synced at `sha`. */
  function seedCache(sha: string): void {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    git(['clone', '-q', remote, cacheDir], sandbox);
    fs.writeFileSync(path.join(cacheDir, 'LAST_SYNC'), `${sha}\n2026-01-01T00:00:00.000Z\n`);
  }

  it('does not clone a repo that has no cache yet', async () => {
    const result = await dryRun(['import', '--from-repo', URL]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`[dry-run] Would import acme/widget at ${head.slice(0, 8)}`);
    expect(result.output).toContain('not cached yet');
  });

  it('says the cache is current without fetching into it', async () => {
    seedCache(head);
    const result = await dryRun(['import', '--from-repo', URL]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`cache is current at ${head.slice(0, 8)}`);
  });

  it('says a stale cache would be refreshed, and leaves it stale', async () => {
    seedCache('0'.repeat(40));
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`cache would be refreshed from 00000000 to ${head.slice(0, 8)}`);
  });

  function changeDefaultAfterCachingMaster(): string {
    git(['branch', 'master', head], remote);
    git(['symbolic-ref', 'HEAD', 'refs/heads/master'], remote);
    seedCache(head);
    const seed = path.join(sandbox, 'seed');
    fs.appendFileSync(path.join(seed, 'index.ts'), 'export const newer = 2;\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'main moves on'], seed);
    git(['push', '-q', remote, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    return git(['rev-parse', 'main'], remote).trim();
  }

  it('incremental preview follows cached master after remote HEAD changes to main', async () => {
    const main = changeDefaultAfterCachingMaster();
    expect(main).not.toBe(head);
    expect(git(['branch', '--show-current'], cacheDir).trim()).toBe('master');
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Would import acme/widget at ${head.slice(0, 8)}`);
    expect(result.output).toContain('so an incremental run would skip it');
    expect(result.output).not.toContain(main.slice(0, 8));
    const real = await runCLI(['import', '--from-repo', URL, '--incremental']);
    expect(real.code, real.output).toBe(0);
    expect(real.output).toContain(`SHA unchanged (${head.slice(0, 8)})`);
    expect(git(['rev-parse', 'HEAD'], cacheDir).trim()).toBe(head);
  });

  it('incremental preview retains a deleted cached branch when a non-pruning fetch does', async () => {
    const main = changeDefaultAfterCachingMaster();
    git(['branch', '-D', 'master'], remote);
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Would import acme/widget at ${head.slice(0, 8)}`);
    expect(result.output).toContain('so an incremental run would skip it');
    expect(result.output).not.toContain(main.slice(0, 8));
    const real = await runCLI(['import', '--from-repo', URL, '--incremental']);
    expect(real.code, real.output).toBe(0);
    expect(real.output).toContain(`SHA unchanged (${head.slice(0, 8)})`);
    expect(git(['rev-parse', 'HEAD'], cacheDir).trim()).toBe(head);
    const full = await dryRun(['import', '--from-repo', URL]);
    expect(full.output).toContain(`Would import acme/widget at ${main.slice(0, 8)}`);
  });

  it.each(['pruning', 'single-branch', 'missing origin ref'])('previews the full-clone fallback after branch deletion with %s', async (setting) => {
    const main = changeDefaultAfterCachingMaster();
    git(['branch', '-D', 'master'], remote);
    if (setting === 'pruning') git(['config', 'remote.origin.prune', 'true'], cacheDir);
    else if (setting === 'single-branch') git(['config', 'remote.origin.fetch', '+refs/heads/master:refs/remotes/origin/master'], cacheDir);
    else git(['update-ref', '-d', 'refs/remotes/origin/master'], cacheDir);
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('preview refresh failed, previewing a full clone instead');
    expect(result.output).toContain(`Would import acme/widget at ${main.slice(0, 8)}`);
    expect(result.output).not.toContain('so an incremental run would skip it');
    await expect(shallowFetch(cacheDir, { provider: 'git' })).rejects.toThrow();
  });

  it('full-clone preview follows remote HEAD even when the cache is on master', async () => {
    const main = changeDefaultAfterCachingMaster();
    const result = await dryRun(['import', '--from-repo', URL]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Would import acme/widget at ${main.slice(0, 8)}`);
  });

  it.each(['cache', 'LAST_SYNC'])('incremental preview follows remote HEAD without %s', async (missing) => {
    const main = changeDefaultAfterCachingMaster();
    if (missing === 'cache') fs.rmSync(cacheDir, { recursive: true });
    else fs.rmSync(path.join(cacheDir, 'LAST_SYNC'));
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Would import acme/widget at ${main.slice(0, 8)}`);
    expect(result.output).not.toContain('so an incremental run would skip it');
  });

  it('previews the full-clone fallback when the cached origin is unreachable', async () => {
    const main = changeDefaultAfterCachingMaster();
    git(['remote', 'set-url', 'origin', path.join(sandbox, 'missing-origin.git')], cacheDir);
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('preview refresh failed, previewing a full clone instead');
    expect(result.output).toContain(`Would import acme/widget at ${main.slice(0, 8)}`);
    expect(result.output).not.toContain('so an incremental run would skip it');
  });

  it('reads the cached origin HEAD branch for a detached incremental cache', async () => {
    const main = changeDefaultAfterCachingMaster();
    git(['checkout', '-q', '--detach'], cacheDir);
    const result = await dryRun(['import', '--from-repo', URL, '--incremental']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Would import acme/widget at ${head.slice(0, 8)}`);
    expect(result.output).not.toContain(main.slice(0, 8));
  });

  it('reports the actual --output destination without creating it', async () => {
    const output = path.join(sandbox, 'custom', 'summary.md');
    const before = tree(path.dirname(output));
    const result = await dryRun(['import', '--from-repo', URL, '--output', output]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(path.join(path.resolve(output, '..', 'teamwiki'), 'evidence', 'code', 'git__acme__widget'));
    expect(tree(path.dirname(output))).toEqual(before);
  });

  it('selects a remote repo before lower-priority unsafe sources', async () => {
    const result = await dryRun(['import', '--from-repo', URL, '--from-iwiki', 'page', '--from-claude']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Would import acme/widget');
  });

  it('previews every entry of --from-repo-list', async () => {
    const list = path.join(sandbox, 'repos.yaml');
    fs.writeFileSync(list, `repos:\n  - url: ${URL}\n`);
    const result = await dryRun(['import', '--from-repo-list', list, '--from-iwiki', 'page', '--from-claude']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`[dry-run] Would import acme/widget at ${head.slice(0, 8)}`);
  });
});
