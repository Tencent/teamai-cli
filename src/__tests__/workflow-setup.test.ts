import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetup } from '../workflow/setup.js';

const TOKEN = 'setup-token-value-1082';
const dirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-setup-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.npmrc\nnode_modules/\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function setup(dir: string, command: string): ReturnType<typeof runSetup> {
  return runSetup({ command, dir, env: { ...process.env, SETUP_TOKEN: TOKEN }, keys: ['SETUP_TOKEN'] });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace setup', () => {
  it('lets the step start when setup writes only ignored files without its keys', async () => {
    const dir = workspace();
    expect(await setup(dir, 'mkdir -p node_modules/pkg && echo installed > node_modules/pkg/index.js && test "$SETUP_TOKEN" = setup-token-value-1082')).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('installed\n');
  });

  it('fails setup_failed when setup exits non-zero, quoting its output with its key values masked', async () => {
    const failure = await setup(workspace(), 'echo "broken with $SETUP_TOKEN" >&2; exit 3');
    expect(failure).toMatchObject({ code: 'setup_failed', message: expect.stringContaining('exited with code 3') });
    expect(failure?.message).toContain('broken with <REDACTED:SETUP_TOKEN>');
  });

  it('fails setup_dirty when setup changes a tracked file or adds a file git would commit', async () => {
    const failure = await setup(workspace(), 'echo changed > tracked.txt && echo new > added.txt');
    expect(failure).toMatchObject({ code: 'setup_dirty' });
    expect(failure?.message).toContain('tracked.txt');
    expect(failure?.message).toContain('added.txt');
  });

  it('fails setup_secret when setup leaves the value of one of its keys in an ignored file, naming the key and never the value', async () => {
    const failure = await setup(workspace(), 'printf "//registry/:_authToken=%s\\n" "$SETUP_TOKEN" > .npmrc');
    expect(failure).toMatchObject({ code: 'setup_secret', message: expect.stringContaining('SETUP_TOKEN') });
    expect(failure?.message).toContain('.npmrc');
    expect(failure?.message).not.toContain(TOKEN);
  });

  it('does not start setup that was stopped while it read the workspace', async () => {
    const dir = workspace();
    const controller = new AbortController();
    const running = runSetup({ command: 'touch started', dir, env: process.env, keys: [], signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ code: 'setup_failed', message: expect.stringContaining('was stopped') });
    expect(fs.existsSync(path.join(dir, 'started'))).toBe(false);
  });

  it('stops setup at the step deadline when no caller stops it', async () => {
    const dir = workspace();
    const startedAt = Date.now();
    const failure = await runSetup({ command: 'sleep 20', dir, env: process.env, keys: [], expiresAt: new Date(startedAt + 500).toISOString() });
    expect(failure).toMatchObject({ code: 'setup_failed', message: expect.stringContaining('timeout') });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('runs setup normally when the step deadline is further away than a timer can wait', async () => {
    const dir = workspace();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(await runSetup({ command: 'sleep 0.2 && mkdir -p node_modules && touch node_modules/done', dir, env: process.env, keys: [], expiresAt })).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'node_modules', 'done'))).toBe(true);
  });

  it('scans only the files setup created or changed, and never .git', async () => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, '.npmrc'), TOKEN);
    expect(await setup(dir, 'printf "%s" "$SETUP_TOKEN" > .git/setup-note && echo ok > node_modules.txt.tmp && rm node_modules.txt.tmp')).toBeUndefined();
  });
});
