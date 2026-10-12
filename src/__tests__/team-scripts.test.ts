import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  mockSpawn.mockImplementation((...args: Parameters<typeof actual.spawn>) =>
    actual.spawn(...args) as ReturnType<typeof actual.spawn>,
  );
  return { ...actual, spawn: mockSpawn };
});

const { runTeamScript, POST_DEPLOY_BUDGET_SEC } = await import('../team-scripts.js');
const { trySymlink } = await import('./helpers/symlink.js');
const { log } = await import('../utils/logger.js');

let dir: string;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scripts-'));
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  debugSpy.mockRestore();
  mockSpawn.mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

function config(repo: string, extra: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'https://example.test/acme/team.git' },
    username: 'tester',
    scope: 'user',
    additionalRoles: [],
    ...extra,
  } as LocalConfig;
}

function writeTeamYaml(repo: string, scripts: Record<string, { path: string }>): void {
  const body = {
    team: 'test',
    repo: 'test/repo',
    scripts,
  };
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), JSON.stringify(body), 'utf8');
}

function writeScript(repo: string, name: string, body: string): string {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function fakeScript(code: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
  return child;
}

describe('teamai.yaml scripts', () => {
  it('keeps the new events and strips one it does not know', () => {
    const parsed = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'test/repo',
      scripts: {
        preInit: { path: 'pre.mjs' },
        postInit: { path: 'post.mjs' },
        prePull: { path: 'before.mjs' },
        postPull: { path: 'after.mjs' },
        postDeploy: { path: 'link.mjs' },
        noSuch: { path: 'nope.mjs' },
      },
    });
    expect(parsed.scripts).toEqual({
      preInit: { path: 'pre.mjs' },
      postInit: { path: 'post.mjs' },
      prePull: { path: 'before.mjs' },
      postPull: { path: 'after.mjs' },
      postDeploy: { path: 'link.mjs' },
    });
  });
});

describe('runTeamScript', () => {
  it('waits for postInit on the terminal and passes the scope', async () => {
    writeTeamYaml(dir, { postInit: { path: 'post.mjs' } });
    const out = path.join(dir, 'env.json');
    writeScript(dir, 'post.mjs', `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
        scope: process.env.TEAMAI_SCOPE,
        repo: process.env.TEAMAI_REPO,
        checkout: process.env.TEAMAI_CHECKOUT ?? null,
        hook: process.env.TEAMAI_GIT_HOOK ?? null,
      }));
    `);
    process.env.TEAMAI_GIT_HOOK = 'post-merge';
    try {
      const result = await runTeamScript(config(dir), 'postInit', { interactive: true });
      expect(result).toEqual({ status: 'ran', code: 0 });
    } finally {
      delete process.env.TEAMAI_GIT_HOOK;
    }
    const recorded = JSON.parse(fs.readFileSync(out, 'utf8')) as {
      scope: string; repo: string; checkout: string | null; hook: string | null;
    };
    expect(recorded.scope).toBe('user');
    expect(recorded.repo).toBe(dir);
    expect(recorded.checkout).toBeNull();
    expect(recorded.hook).toBeNull();
    const options = mockSpawn.mock.calls.at(-1)![2] as { stdio: string[] };
    expect(options.stdio).toEqual(['inherit', 'inherit', 'inherit']);
  });

  it('passes the resolver checkout to a project-scope script', async () => {
    const repo = path.join(dir, 'team');
    const checkout = path.join(dir, 'checkout');
    fs.mkdirSync(repo);
    fs.mkdirSync(checkout);
    execFileSync('git', ['init', '-q'], { cwd: checkout });
    writeTeamYaml(repo, { postDeploy: { path: 'link.mjs' } });
    const out = path.join(dir, 'env.json');
    writeScript(repo, 'link.mjs', `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
        checkout: process.env.TEAMAI_CHECKOUT,
        main: process.env.TEAMAI_MAIN_CHECKOUT,
        project: process.env.TEAMAI_PROJECT,
        scope: process.env.TEAMAI_SCOPE,
        budget: process.env.TEAMAI_SCRIPT_TIMEOUT_SEC,
      }));
    `);

    const result = await runTeamScript(
      config(repo, { scope: 'project', projectRoot: checkout }),
      'postDeploy',
    );

    expect(result).toEqual({ status: 'ran', code: 0 });
    const recorded = JSON.parse(fs.readFileSync(out, 'utf8')) as {
      checkout: string; main: string; project: string; scope: string; budget: string;
    };
    const realCheckout = fs.realpathSync(checkout);
    expect(recorded.checkout).toBe(realCheckout);
    expect(recorded.main).toBe(realCheckout);
    expect(recorded.project).toBe(realCheckout);
    expect(recorded.scope).toBe('project');
    expect(recorded.budget).toBe(String(POST_DEPLOY_BUDGET_SEC));
  });

  it('skips a prompted script when the run is not interactive', async () => {
    writeTeamYaml(dir, { postInit: { path: 'post.mjs' } });
    writeScript(dir, 'post.mjs', 'export {};\n');

    const result = await runTeamScript(config(dir), 'postInit', { interactive: false, announce: true });

    expect(result).toEqual({ status: 'skipped', code: null });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      'Skipped scripts.postInit because this run is not interactive. Run it in a terminal with: teamai script run postInit',
    );
  });

  it('does not fail the caller when postInit exits non-zero', async () => {
    writeTeamYaml(dir, { preInit: { path: 'pre.mjs' } });
    writeScript(dir, 'pre.mjs', 'export {};\n');
    mockSpawn.mockImplementationOnce(() => fakeScript(3) as never);

    const result = await runTeamScript(config(dir), 'preInit', { interactive: true, announce: true });

    expect(result).toEqual({ status: 'ran', code: 3 });
    expect(warnSpy).toHaveBeenCalledWith(
      'scripts.preInit exited 3. Setup will continue. Run it again with: teamai script run preInit',
    );
  });

  it('does nothing when the team declares no such script', async () => {
    writeTeamYaml(dir, { postPull: { path: 'post.mjs' } });
    const result = await runTeamScript(config(dir), 'postInit', { interactive: true, announce: true });
    expect(result).toEqual({ status: 'absent', code: null });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('rejects a symlink that leaves the team repo when the platform allows it', async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`);
    fs.writeFileSync(outside, 'export {};\n', 'utf8');
    try {
      if (trySymlink(outside, path.join(dir, 'link.mjs'))) {
        writeTeamYaml(dir, { postInit: { path: 'link.mjs' } });
        const result = await runTeamScript(config(dir), 'postInit', { interactive: true, announce: true });
        expect(result).toEqual({ status: 'skipped', code: null });
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          'scripts.postInit was not run because its path leaves the team repo.',
        );
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('stops waiting for postDeploy when the budget ends, without killing the script', async () => {
    writeTeamYaml(dir, { postDeploy: { path: 'hang.mjs' } });
    const marker = path.join(dir, 'alive.json');
    writeScript(dir, 'hang.mjs', `
      import fs from 'node:fs';
      import os from 'node:os';
      process.chdir(os.tmpdir());
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 120);
    `);

    const result = await runTeamScript(config(dir), 'postDeploy', { budgetSec: 0.05 });

    expect(result).toEqual({ status: 'ran', code: null });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('scripts.postDeploy: timed out after 0.05s'));
    await vi.waitUntil(() => fs.existsSync(marker), { timeout: 10_000, interval: 25 });
  });

  it('runs prePull without a terminal and under the pull budget', async () => {
    writeTeamYaml(dir, { prePull: { path: 'before.mjs' } });
    writeScript(dir, 'before.mjs', 'export {};\n');
    mockSpawn.mockImplementationOnce(() => fakeScript(0) as never);

    const result = await runTeamScript(config(dir), 'prePull');

    expect(result).toEqual({ status: 'ran', code: 0 });
    const options = mockSpawn.mock.calls.at(-1)![2] as { stdio: string[]; env: NodeJS.ProcessEnv };
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.env.TEAMAI_SCRIPT_TIMEOUT_SEC).toBe('90');
    expect(options.env.TEAMAI_SCOPE).toBe('user');
  });
});
