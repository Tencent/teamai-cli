import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TeamaiConfig } from '../types.js';

const { resolvePostPullSpec, runPostPull, DEFAULT_POST_PULL_TIMEOUT_SEC } = await import('../post-pull.js');
const { log } = await import('../utils/logger.js');

let dir: string;
let debugSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-postpull-'));
  debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeScript(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function teamConfig(postPull?: { path: string; timeoutSec?: number }): TeamaiConfig {
  return { scripts: postPull ? { postPull } : undefined } as TeamaiConfig;
}

describe('resolvePostPullSpec', () => {
  it('returns null when the team declares no postPull', () => {
    expect(resolvePostPullSpec(teamConfig(), dir)).toBeNull();
    expect(resolvePostPullSpec({} as TeamaiConfig, dir)).toBeNull();
  });

  it('resolves the declared path against the repo root with the default budget', () => {
    const spec = resolvePostPullSpec(teamConfig({ path: 'workbuddy/scripts/post-pull.mjs' }), dir);
    expect(spec).toEqual({
      scriptPath: path.join(dir, 'workbuddy', 'scripts', 'post-pull.mjs'),
      repoPath: dir,
      timeoutSec: DEFAULT_POST_PULL_TIMEOUT_SEC,
    });
  });

  it('honours an explicit timeoutSec', () => {
    expect(resolvePostPullSpec(teamConfig({ path: 'post.mjs', timeoutSec: 30 }), dir)?.timeoutSec).toBe(30);
  });

  it('rejects a path that escapes the clone', () => {
    writeScript(path.join('..', 'outside.mjs'), 'export {};\n');
    expect(() => resolvePostPullSpec(teamConfig({ path: '../outside.mjs' }), dir)).toThrow(/outside|traversal/i);
  });

  it('rejects a symlink pointing out of the clone when the platform allows it', () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`);
    fs.writeFileSync(outside, 'export {};\n', 'utf8');
    try {
      fs.symlinkSync(outside, path.join(dir, 'link.mjs'));
    } catch {
      fs.rmSync(outside, { force: true });
      return; // creating symlinks needs privileges on Windows; nothing to assert
    }
    expect(() => resolvePostPullSpec(teamConfig({ path: 'link.mjs' }), dir)).toThrow(/outside|traversal/i);
    fs.rmSync(outside, { force: true });
  });
});

describe('runPostPull (supervisor)', () => {
  it('runs the script with the repo env and records a clean exit', async () => {
    const envOut = path.join(dir, 'env.json');
    writeScript(
      'ok.mjs',
      `import fs from 'node:fs';
       fs.writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({
         repo: process.env.TEAMAI_REPO,
         timeout: process.env.TEAMAI_POSTPULL_TIMEOUT_SEC,
         cwd: process.cwd(),
       }));`,
    );

    await runPostPull({ scriptPath: path.join(dir, 'ok.mjs'), repoPath: dir, timeoutSec: 42 });

    const seen = JSON.parse(fs.readFileSync(envOut, 'utf8')) as Record<string, string>;
    expect(seen.repo).toBe(dir);
    expect(seen.timeout).toBe('42');
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(dir));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/postPull: exited 0 in \d+ms/));
  });

  it('records a non-zero exit together with the output tail', async () => {
    writeScript('fail.mjs', 'process.stderr.write("boom: missing config\\n"); process.exit(3);\n');
    await runPostPull({ scriptPath: path.join(dir, 'fail.mjs'), repoPath: dir, timeoutSec: 30 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: exited 3 in'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom: missing config'));
  });

  it('kills a script that overruns its deadline', async () => {
    writeScript('hang.mjs', 'setTimeout(() => {}, 60_000);\n');
    await runPostPull({ scriptPath: path.join(dir, 'hang.mjs'), repoPath: dir, timeoutSec: 1 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: timed out after 1s'));
    // let the (async) tree kill land so it cannot outlive the test run
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
