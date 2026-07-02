import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

// Stub out all real git I/O so we exercise reportUsageToTeam's reporting logic
// (delta → stats yaml → reported snapshot) without a real repo/remote.
const pushRepoDirectly = vi.fn().mockResolvedValue(undefined);
vi.mock('../utils/git.js', () => ({
  createGit: vi.fn(() => ({})),
  pushRepoDirectly: (...args: unknown[]) => pushRepoDirectly(...args),
  pullRepo: vi.fn().mockResolvedValue(undefined),
  resetToCleanMaster: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// VOTES_LOCAL_DIR is resolved at module load against the real HOME, so isolate
// vote staging from the developer's actual ~/.teamai/votes to keep the test hermetic.
vi.mock('../utils/fs.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    pathExists: vi.fn(async (p: string) => (p.includes(`${path.sep}votes`) ? false : actual.pathExists(p))),
  };
});

import { reportUsageToTeam } from '../team-push.js';

let tmpDir: string;
let repoDir: string;
let originalHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tp-iv-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  pushRepoDirectly.mockClear();
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDashboardEvents(lines: object[]): void {
  const p = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('reportUsageToTeam — intervention reporting', () => {
  it('writes intervention totals into stats/<user>.yaml and advances the reported snapshot', async () => {
    const ts = new Date().toISOString();
    writeDashboardEvents([
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', interventions: { interrupt: 2, toolReject: 1 } },
    ]);

    await reportUsageToTeam(repoDir, 'me');

    // stats yaml carries the merged intervention totals
    const statsPath = path.join(repoDir, 'stats', 'me.yaml');
    expect(fs.existsSync(statsPath)).toBe(true);
    const stats = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.interventions).toEqual({ sessions: 1, interrupt: 2, toolReject: 1, correction: 0 });

    // push was attempted with the stats file staged
    expect(pushRepoDirectly).toHaveBeenCalledTimes(1);
    expect(pushRepoDirectly.mock.calls[0][2]).toContain('stats/me.yaml');

    // reported snapshot persisted so a second run reports nothing new
    const reportedPath = path.join(tmpDir, '.teamai', 'dashboard', 'reported-interventions.json');
    expect(JSON.parse(fs.readFileSync(reportedPath, 'utf-8'))).toEqual({
      s1: { interrupt: 2, toolReject: 1, correction: 0 },
    });

    pushRepoDirectly.mockClear();
    await reportUsageToTeam(repoDir, 'me');
    // Nothing new (no usage, no intervention delta, no votes) → no push
    expect(pushRepoDirectly).not.toHaveBeenCalled();
  });

  it('does nothing when there are no events, interventions, or votes', async () => {
    await reportUsageToTeam(repoDir, 'me');
    expect(pushRepoDirectly).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repoDir, 'stats', 'me.yaml'))).toBe(false);
  });
});
