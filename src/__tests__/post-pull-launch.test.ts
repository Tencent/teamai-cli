import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LocalConfig, TeamaiConfig } from '../types.js';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

const mockLoadTeamConfig = vi.fn();
vi.mock('../config.js', () => ({ loadTeamConfig: mockLoadTeamConfig }));

const { launchPostPull, launchDeclaredPostPull } = await import('../post-pull.js');
const { log } = await import('../utils/logger.js');

let dir: string;
let debugSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-postpull-launch-'));
  mockSpawn.mockReset().mockReturnValue(fakeChild());
  mockLoadTeamConfig.mockReset().mockResolvedValue(null);
  debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const localConfig = (repoPath: string) => ({ repo: { kind: 'git', localPath: repoPath } }) as LocalConfig;

describe('launchPostPull', () => {
  it('spawns the detached supervisor with repo, script and budget', () => {
    const spec = { scriptPath: path.join(dir, 'post.mjs'), repoPath: dir, timeoutSec: 120 };
    launchPostPull(spec);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual([
      'post-pull-run',
      '--repo', dir,
      '--script', spec.scriptPath,
      '--timeout-sec', '120',
    ]);
    expect(options.detached).toBe(true);
    expect(options.cwd).toBe(dir);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: launched'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('timeout=120s'));
  });

  it('warns instead of throwing when the spawn fails', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn EACCES');
    });
    launchPostPull({ scriptPath: path.join(dir, 'post.mjs'), repoPath: dir, timeoutSec: 300 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not launch'));
  });
});

describe('launchDeclaredPostPull', () => {
  it('does nothing when the team declares no postPull', async () => {
    await launchDeclaredPostPull(localConfig(dir));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('skips (and warns) when the declared script is missing', async () => {
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: 'missing.mjs' } } } as TeamaiConfig);
    await launchDeclaredPostPull(localConfig(dir));
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declared script not found'));
  });

  it('launches a declared script that exists', async () => {
    fs.writeFileSync(path.join(dir, 'post.mjs'), 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: 'post.mjs' } } } as TeamaiConfig);
    await launchDeclaredPostPull(localConfig(dir));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('never throws on an escaping path — it only logs', async () => {
    fs.writeFileSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`), 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: '../outside.mjs' } } } as TeamaiConfig);
    await expect(launchDeclaredPostPull(localConfig(dir))).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: skipped'));
    fs.rmSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`), { force: true });
  });
});
