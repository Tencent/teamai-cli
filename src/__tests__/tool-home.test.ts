import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHermesHome } from '../hermes-home.js';
import { resolveDshHome } from '../dsh-hooks.js';
import { resolveOpenclawStateDir } from '../openclaw-home.js';
import { getCopilotHome, type LocalConfig } from '../types.js';
import { skillRoots } from '../usage-tracker.js';
import { getUserHome } from '../utils/home.js';
import { realHost, saveToolHomes, toolHome, toolHomesPath } from '../tool-home.js';
import { recordToolHomes } from '../tool-home-record.js';

describe('tool homes from a session whose directory was removed (#810)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gone-cwd-'));
    process.chdir(gone);
    fs.rmdirSync(gone);
  });
  afterEach(() => { process.chdir(cwd); });

  it('resolves the Hermes, Copilot, DSH and OpenClaw homes', () => {
    const home = getUserHome();

    expect([getHermesHome(), getCopilotHome(), resolveDshHome(), resolveOpenclawStateDir()])
      .toEqual([path.join(home, '.hermes'), path.join(home, '.copilot'), path.join(home, '.dsh'), path.join(home, '.openclaw')]);
  });

  it('lists the skill roots a skill use is counted in', async () => {
    const config: LocalConfig = {
      repo: { localPath: path.join(getUserHome(), 'team-repo'), remote: 'https://example.test/acme/team.git' },
      username: 'tester', scope: 'user', additionalRoles: [],
    };

    expect(await skillRoots({ config, tool: 'claude' })).toContain(path.join(getUserHome(), '.claude', 'skills'));
  });
});

describe('a home recorded on this machine', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recorded-home-')));
    vi.stubEnv('HOME', path.join(tmp, 'home'));
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('is the home hooks, rules and MCP resolve too, whatever the shell says', async () => {
    const recorded = (tool: string): string => path.join(tmp, 'recorded', tool);
    await saveToolHomes({ hermes: recorded('hermes'), copilot: recorded('copilot'), dsh: recorded('dsh'), openclaw: recorded('openclaw') });
    for (const name of ['HERMES_HOME', 'COPILOT_HOME', 'DSH_HOME', 'OPENCLAW_STATE_DIR']) vi.stubEnv(name, path.join(tmp, 'shell', name));

    expect([getHermesHome(), getCopilotHome(), resolveDshHome(), resolveOpenclawStateDir()])
      .toEqual([recorded('hermes'), recorded('copilot'), recorded('dsh'), recorded('openclaw')]);
  });

  it('is the one another process recorded after this one found none', async () => {
    const winner = path.join(tmp, 'hermes-b'); const loser = path.join(tmp, 'hermes-a');
    fs.mkdirSync(loser, { recursive: true });
    vi.stubEnv('HERMES_HOME', loser);
    expect(toolHome('hermes')).toBe(loser);
    fs.mkdirSync(path.dirname(toolHomesPath()), { recursive: true });
    fs.writeFileSync(toolHomesPath(), JSON.stringify({ hermes: winner }));

    expect(await recordToolHomes('pull')).toEqual([]);
    expect(toolHome('hermes')).toBe(winner);
  });

  it('is the one a pull read under the lock, even when the file kept its size and time', async () => {
    const winner = path.join(tmp, 'hermes-b'); const loser = path.join(tmp, 'hermes-a');
    fs.mkdirSync(loser, { recursive: true });
    vi.stubEnv('HERMES_HOME', loser);
    const file = toolHomesPath();
    const pinned = new Date(1_700_000_000_000);
    const writeRecord = (homes: Record<string, string>): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(homes));
      fs.utimesSync(file, pinned, pinned);
    };
    writeRecord({ dsh: path.join(tmp, 'dsh-home-ab') });
    const before = fs.statSync(file);
    expect(toolHome('hermes')).toBe(loser);
    writeRecord({ hermes: winner });
    expect([fs.statSync(file).size, fs.statSync(file).mtimeMs]).toEqual([before.size, before.mtimeMs]);

    expect(await recordToolHomes('pull')).toEqual([]);
    expect(toolHome('hermes')).toBe(winner);
  });
});

describe('the real host\'s reads for a checkout key', () => {
  it('resolves a path through its links and reads a small text file, and answers for a missing one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-host-reads-'));
    try {
      const file = path.join(dir, '.git');
      fs.writeFileSync(file, 'gitdir: ../main/.git/worktrees/x\n');
      const host = realHost();
      const missing = path.join(dir, 'missing', 'commondir');

      expect(await host.realpath(file)).toBe(fs.realpathSync(file));
      expect(await host.realpath(missing)).toBe(missing);
      expect(await host.readText(file)).toBe('gitdir: ../main/.git/worktrees/x\n');
      expect(await host.readText(missing)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
