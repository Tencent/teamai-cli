import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { log } from '@teamai/shared/log';
import { resolveOpenclawStateDir } from '../openclaw-home.js';
import type { LocalConfig } from '../types.js';
import { skillRoots } from '../usage-tracker.js';
import { getUserHome } from '../utils/home.js';
import { realHost, reloadToolHomesHistory, saveToolHomes, toolHome, toolHomesHistoryPath, toolHomesPath } from '../tool-home.js';
import { recordToolHomes } from '../tool-home-record.js';
import { useToolInstances as useInstances } from '../tool-registry.js';

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

    expect([toolHome('hermes'), toolHome('copilot'), toolHome('dsh'), resolveOpenclawStateDir()])
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

    expect([toolHome('hermes'), toolHome('copilot'), toolHome('dsh'), resolveOpenclawStateDir()])
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

  it('keeps a replaced Hermes home in history so uninstall can find it after re-init', async () => {
    const oldHome = path.join(tmp, 'hermes-old');
    const newHome = path.join(tmp, 'hermes-new');
    fs.mkdirSync(oldHome, { recursive: true });
    vi.stubEnv('HERMES_HOME', oldHome);
    await recordToolHomes('init');
    vi.stubEnv('HERMES_HOME', newHome);
    await recordToolHomes('init');

    expect(reloadToolHomesHistory()).toEqual({ hermes: [oldHome] });
    expect(fs.existsSync(toolHomesHistoryPath())).toBe(true);
  });

  it('keeps a replaced OpenCode XDG home in history when both homes exist', async () => {
    const oldXdg = path.join(tmp, 'xdg-old');
    const newXdg = path.join(tmp, 'xdg-new');
    const oldHome = path.join(oldXdg, 'opencode');
    const newHome = path.join(newXdg, 'opencode');
    fs.mkdirSync(oldHome, { recursive: true });
    fs.mkdirSync(newHome, { recursive: true });
    vi.stubEnv('XDG_CONFIG_HOME', oldXdg);
    await recordToolHomes('init');
    vi.stubEnv('XDG_CONFIG_HOME', newXdg);
    await recordToolHomes('init');
    expect(reloadToolHomesHistory()).toEqual({ opencode: [oldHome] });
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('is reported, not thrown, when it cannot be written', async () => {
    const moved = path.join(tmp, 'hermes-moved');
    fs.mkdirSync(moved, { recursive: true });
    vi.stubEnv('HERMES_HOME', moved);
    const teamai = path.dirname(toolHomesPath());
    fs.mkdirSync(teamai, { recursive: true });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });
    fs.chmodSync(teamai, 0o500);
    const recorded = await recordToolHomes('pull').finally(() => { fs.chmodSync(teamai, 0o700); });

    expect(recorded).toEqual([]);
    expect(warn.mock.calls.map(([line]) => String(line).replace(/ \(.*\)\. /, ' (<cause>). '))).toEqual([
      `Did not record the tool homes this shell moves: could not write ${toolHomesPath()} (<cause>). `
        + 'Until it is recorded, teamai syncs those tools to their default homes from a shell without their variable. Fix the cause and run `teamai pull` again.',
    ]);
  });

  // An instance on the home directory itself is refused, and init lists only the instances in use: such a record could never be replaced.
  it.each([
    { by: 'init' as const, before: { 'acme-codex': 'moved' } },
    { by: 'pull' as const, before: {} },
  ])('is never the home directory itself for an instance, on $by, and says so', async ({ by, before }) => {
    const home = path.join(tmp, 'home');
    const moved = path.join(tmp, 'acme-moved');
    fs.mkdirSync(home, { recursive: true });
    const recorded = Object.fromEntries(Object.keys(before).map((tool) => [tool, moved]));
    await saveToolHomes(recorded);
    useInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' },
      source: 'personal', file: '/home/.teamai/tools/acme-codex.yaml', location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    onTestFinished(() => { useInstances(new Map()); });
    vi.stubEnv('ACME_CODEX_HOME', home);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });

    expect(await recordToolHomes(by)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(toolHomesPath(), 'utf8'))).toEqual(recorded);
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      `Did not record ACME_CODEX_HOME as the acme-codex home: ${home} is your home directory itself, where acme-codex would read and write every file in your home as its own. `
        + 'Point ACME_CODEX_HOME at a directory of its own and re-run `teamai init`.',
    ]);
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

describe('Hermes\'s active profile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-profile-')));
    vi.stubEnv('HOME', tmp);
    vi.stubEnv('HERMES_HOME', undefined);
    vi.stubEnv('HERMES_DATA_DIR_SUFFIX', undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('is followed on every run, so switching back to default needs no init', async () => {
    const native = path.join(tmp, '.hermes');
    fs.mkdirSync(path.join(native, 'profiles', 'work'), { recursive: true });
    fs.writeFileSync(path.join(native, 'active_profile'), 'work\n');
    await recordToolHomes('pull');
    expect(toolHome('hermes')).toBe(path.join(native, 'profiles', 'work'));

    fs.writeFileSync(path.join(native, 'active_profile'), 'default\n');

    expect(toolHome('hermes')).toBe(native);
  });
});

describe('the real host under an install\'s home', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('drops every variable that would move a tool\'s home back to the member\'s, an instance\'s own included', async () => {
    // A fresh module graph: the install home a process takes has no way back.
    vi.resetModules();
    const [{ useInstallHome }, { useToolInstances }, fresh] = await Promise.all([import('@teamai/shared/home'), import('../tool-registry.js'), import('../tool-home.js')]);
    const member = (name: string): string => path.join(os.tmpdir(), 'member', name);
    const moving = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'CURSOR_DATA_DIR', 'ACME_CODEX_HOME'];
    for (const name of moving) vi.stubEnv(name, member(name));
    vi.stubEnv('PATH', member('bin'));
    useToolInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' },
      source: 'personal', file: '/home/.teamai/tools/acme-codex.yaml', location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    useInstallHome(path.join(os.tmpdir(), 'clone', 'h'));

    const { env } = fresh.realHost();

    expect(moving.filter((name) => env[name] !== undefined)).toEqual([]);
    expect(env.PATH).toBe(member('bin'));
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
