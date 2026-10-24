import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  autoDetectInit: vi.fn(),
}));
vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  withFileLock: async <T>(_lock: string, _wait: unknown, body: () => Promise<T>) => ({ held: true, value: await body() }),
}));
vi.mock('../utils/logger.js', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis() })),
}));
vi.mock('../resources/desired.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resources/desired.js')>();
  return { ...actual, resolveDesiredSkills: vi.fn(actual.resolveDesiredSkills) };
});
vi.mock('../builtin-skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../builtin-skills.js')>();
  return { ...actual, deployBuiltinSkills: vi.fn(actual.deployBuiltinSkills) };
});
vi.mock('../skill-content.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skill-content.js')>();
  return { ...actual, packagedSkillRoots: vi.fn(actual.packagedSkillRoots) };
});

import { pull } from '../pull.js';
import { resolveDesiredSkills } from '../resources/desired.js';
import { deployBuiltinSkills } from '../builtin-skills.js';
import { packagedSkillRoots } from '../skill-content.js';
import { getHandler } from '../resources/index.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';
import { realHost, recordedHomes, saveToolHomes, toolHomesPath } from '../tool-home.js';

describe('a pull and the homes the env moves', () => {
  let tmp: string; let home: string; let repo: string; let saved: State; let config: LocalConfig;
  const recordOnDisk = async (): Promise<unknown> => JSON.parse(await fse.readFile(toolHomesPath(), 'utf8'));
  const notices = (): string[] => vi.mocked(log.info).mock.calls.map(([message]) => String(message)).filter((line) => line.includes('no longer updates'));

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-dirs-'));
    home = path.join(tmp, 'home'); repo = path.join(tmp, 'repo');
    await fse.outputFile(path.join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\n---\nDeploy.\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('HERMES_HOME', '');
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (s) => { saved = structuredClone(s); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    config = {
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      additionalRoles: [], scope: 'user', enabledAgents: ['opencode', 'hermes'],
    } as LocalConfig;
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => scope === 'user' ? config : null);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(log.warn).mockClear(); vi.mocked(log.info).mockClear(); await fse.remove(tmp); });

  it('keeps a file blocking Hermes skills and still delivers to the other tools', async () => {
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    const blocked = path.join(home, '.hermes', 'skills');
    await fse.outputFile(blocked, 'member data: do not delete');
    await expect(pull({ force: true })).resolves.toBeUndefined();
    expect(await fse.readFile(blocked, 'utf8')).toBe('member data: do not delete');
    expect(await fse.pathExists(path.join(home, '.config', 'opencode', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).toContain(blocked);
    expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).toContain('not a directory');
    await fse.remove(blocked);
    await pull({});
    expect(await fse.pathExists(path.join(blocked, 'deploy', 'SKILL.md'))).toBe(true);
  });

  it('records an env-moved home that exists on the first pull that sees it, and keeps an existing record', async () => {
    const xdg = path.join(tmp, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await pull({});

    expect(await recordOnDisk()).toEqual({ opencode: path.join(xdg, 'opencode') });

    await saveToolHomes({ opencode: path.join(tmp, 'recorded') });
    await fse.ensureDir(path.join(xdg, 'muse'));
    await pull({});

    expect(await recordOnDisk()).toEqual({ opencode: path.join(tmp, 'recorded'), muse: path.join(xdg, 'muse') });
  });

  it('installs Hermes hooks in the home its skills go to: the recorded one, not the shell\'s', async () => {
    const recorded = path.join(tmp, 'hermes-a'); const shell = path.join(tmp, 'hermes-b');
    await fse.ensureDir(recorded); await fse.ensureDir(shell);
    await saveToolHomes({ hermes: recorded });
    vi.stubEnv('HERMES_HOME', shell);

    await pull({});

    expect(await fse.pathExists(path.join(recorded, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(recorded, 'hooks'))).toBe(true);
    expect(await fse.pathExists(path.join(shell, 'skills'))).toBe(false);
    expect(await fse.pathExists(path.join(shell, 'hooks'))).toBe(false);
    expect(recordedHomes(realHost())).toEqual({ hermes: recorded });
  });

  it('delivers OpenCode skills where XDG_CONFIG_HOME puts its home, and keeps them there from a shell without it', async () => {
    const xdg = path.join(tmp, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await pull({});

    expect(await fse.pathExists(path.join(xdg, 'opencode', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.config', 'opencode'))).toBe(false);

    vi.stubEnv('XDG_CONFIG_HOME', '');
    await fse.remove(path.join(xdg, 'opencode', 'skills'));
    await pull({ force: true });

    expect(await fse.pathExists(path.join(xdg, 'opencode', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.config', 'opencode'))).toBe(false);
  });

  it('counts an OpenCode that took skills in its XDG home among the tools the pull delivered to', async () => {
    const xdg = path.join(tmp, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await pull({});

    expect(await fse.pathExists(path.join(xdg, 'opencode', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.targets)).toEqual([['opencode']]);
  });

  it('syncs in full once on the skills directories an earlier release recorded, which say nothing of rules, instruction blocks or agents, and records them only as places', async () => {
    await pull({});
    const [[key, record]] = Object.entries(saved.lastPullByWorkspace ?? {});
    const { places, ...earlier } = record;
    saved.lastPullByWorkspace = { [key]: { ...earlier, skillDirs: places?.skills } };
    vi.mocked(log.success).mockClear();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.flat()).not.toContainEqual(expect.stringContaining('Already synced at abc1234'));
    const next = saved.lastPullByWorkspace?.[key];
    expect(next?.places).toEqual(places);
    expect(next?.places?.rules).toBeDefined();
    expect(next?.places?.blocks).toBeDefined();
    expect(next?.places?.agents).toBeDefined();
    expect(next?.skillDirs).toBeUndefined();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.flat()).toContainEqual(expect.stringContaining('Already synced at abc1234'));
  });

  describe('when a tool\'s skills directory moves at one team revision', () => {
    let before: string; let after: string;
    beforeEach(async () => {
      before = path.join(tmp, 'hermes-a'); after = path.join(tmp, 'hermes-b');
      await fse.ensureDir(before); await fse.ensureDir(after);
      vi.stubEnv('HERMES_HOME', before);
      await pull({});
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      await saveToolHomes({ ...recordedHomes(realHost()), hermes: after });
      vi.stubEnv('HERMES_HOME', after);
    });

    it('syncs in full instead of reporting the checkout already synced', async () => {
      await pull({});

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    });

    it('keeps the old record while a collision holds skills, and finishes the move once it is gone', async () => {
      await fse.outputFile(path.join(repo, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: review\n    resources:\n      knowledge: []\n      skills: [a, b]\n');
      for (const ns of ['a', 'b']) await fse.outputFile(path.join(repo, 'skills', ns, 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: ${ns}\n---\n${ns}\n`);
      Object.assign(config, { primaryRole: 'review', resourceProfileVersion: 1 });

      await pull({});

      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(await fse.pathExists(path.join(after, 'skills', 'deploy'))).toBe(false);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(before, 'skills')]]);

      await fse.remove(path.join(repo, 'skills', 'b'));
      await pull({});

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(after, 'skills')]]);
    });

    it('keeps the old copies when the new directory cannot take the skills', async () => {
      await fse.ensureDir(path.join(after, 'skills'));
      await fse.chmod(path.join(after, 'skills'), 0o555);
      try {
        await pull({});
      } finally {
        await fse.chmod(path.join(after, 'skills'), 0o755);
      }

      expect(vi.mocked(log.warn).mock.calls.flat()).toContainEqual(expect.stringContaining('Failed to sync skill deploy to hermes'));
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(before, 'skills'), path.join(after, 'skills')]]);
    });

    it('keeps the old copies and the old record while a file of the member\'s holds a skill back at the new directory', async () => {
      await fse.outputFile(path.join(after, 'skills', 'deploy', 'SKILL.md'), 'This is a member skill, unrelated to team deploy.\n');

      await pull({});

      expect(await fse.readFile(path.join(after, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('member skill');
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(before, 'skills'), path.join(after, 'skills')]]);

      await fse.remove(path.join(after, 'skills', 'deploy'));
      await pull({});

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(after, 'skills')]]);
    });

    it('keeps the old copies while the new directory skips a skill', async () => {
      await fse.symlink(path.join(tmp, 'gone'), path.join(after, 'skills'));

      await pull({});

      expect(vi.mocked(log.warn).mock.calls.flat()).toContainEqual(expect.stringContaining('Skipped deploy (hermes)'));
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(before, 'skills'), path.join(after, 'skills')]]);
    });

    it('keeps the old copies, the built-in one included, while a file of the member\'s holds the built-in skill back at the new directory', async () => {
      await fse.outputFile(path.join(after, 'skills', 'teamai', 'SKILL.md'), 'Instructions belonging to the member\n');

      await pull({});

      expect(await fse.readFile(path.join(after, 'skills', 'teamai', 'SKILL.md'), 'utf8')).toContain('belonging to the member');
      expect(await fse.pathExists(path.join(before, 'skills', 'teamai', 'SKILL.md'))).toBe(true);
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    });

    it('keeps the old copies when the built-in skills could not be deployed', async () => {
      vi.mocked(deployBuiltinSkills).mockRejectedValueOnce(new Error('EACCES: permission denied'));

      await pull({});

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    });

    it('keeps the old copies when the package ships no built-in skill to deploy', async () => {
      const { packagedSkillRoots: actual } = await vi.importActual<typeof import('../skill-content.js')>('../skill-content.js');
      vi.mocked(packagedSkillRoots).mockImplementation(() => ({ ...actual(), deployRoot: path.join(tmp, 'no-built-in-skills') }));
      try {
        await pull({});
      } finally {
        vi.mocked(packagedSkillRoots).mockImplementation(actual);
      }

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(before, 'skills'), path.join(after, 'skills')]]);
    });

    it('keeps the old copy of a skill a workspace holds back', async () => {
      const resolve = vi.mocked(resolveDesiredSkills);
      const { resolveDesiredSkills: actual } = await vi.importActual<typeof import('../resources/desired.js')>('../resources/desired.js');
      resolve.mockImplementationOnce(async (...args) => {
        const desired = await actual(...args);
        return desired.kind === 'resolved' ? { ...desired, items: desired.items.filter((item) => item.name !== 'deploy'), held: ['deploy'] } : desired;
      });

      await pull({});

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy'))).toBe(false);
      expect(await fse.pathExists(path.join(before, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    });

    it('keeps on record the copies a held move wrote to the new directory, and names both directories when the tool moves on', async () => {
      await fse.outputFile(path.join(repo, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: r\n---\nReview.\n');
      await fse.outputFile(path.join(after, 'skills', 'deploy', 'SKILL.md'), 'This is a member skill, unrelated to team deploy.\n');
      await pull({});
      expect(await fse.pathExists(path.join(after, 'skills', 'review', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(before, 'skills'), path.join(after, 'skills')]]);
      const third = path.join(tmp, 'hermes-c');
      await fse.ensureDir(third);
      await saveToolHomes({ ...recordedHomes(realHost()), hermes: third });
      vi.stubEnv('HERMES_HOME', third);

      await pull({});

      expect(await fse.pathExists(path.join(third, 'skills', 'review', 'SKILL.md'))).toBe(true);
      const leftFile = (noun: 'team rules' | 'instruction blocks', now: string, old: string): string =>
        `[user] hermes takes the ${noun} from ${path.join(now, 'SOUL.md')} now, so teamai no longer updates them in ${path.join(old, 'SOUL.md')}. Delete them there once no tool reads it.`;
      expect(notices()).toEqual([
        leftFile('team rules', after, before),
        leftFile('instruction blocks', after, before),
        ...[before, after].map((dir) => `[user] hermes takes skills from ${path.join(third, 'skills')} now, so teamai no longer updates its copies in ${path.join(dir, 'skills')}. Delete them once no tool reads that directory.`),
        leftFile('team rules', third, after),
        leftFile('instruction blocks', third, after),
      ]);
      expect(await fse.readFile(path.join(after, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('member skill');
    });

    it('moves the record of a tool that took every skill while a file of the member\'s holds one back in another tool', async () => {
      await fse.outputFile(path.join(home, '.config', 'opencode', 'skills', 'deploy', 'SKILL.md'), 'This is a member skill, unrelated to team deploy.\n');

      await pull({});

      expect(await fse.pathExists(path.join(after, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.skills?.hermes)).toEqual([[path.join(after, 'skills')]]);
    });
  });

  describe('when tools share a skills directory and one moves off it', () => {
    let shared: string; let hermes: string; let pi: string;
    const deployIn = (dir: string): string => path.join(dir, 'skills', 'deploy', 'SKILL.md');
    beforeEach(async () => {
      shared = path.join(tmp, 'shared'); hermes = path.join(tmp, 'hermes-b'); pi = path.join(tmp, 'pi-c');
      for (const dir of [shared, hermes, pi]) await fse.ensureDir(dir);
    });

    it('keeps the copies in a directory OpenClaw still takes skills from', async () => {
      await fse.ensureDir(path.join(home, '.openclaw'));
      config.enabledAgents = ['hermes', 'openclaw'];
      vi.stubEnv('HERMES_HOME', shared);
      vi.stubEnv('OPENCLAW_WORKSPACE_DIR', shared);
      await pull({});
      expect(await fse.pathExists(deployIn(shared))).toBe(true);
      await saveToolHomes({ ...recordedHomes(realHost()), hermes });
      vi.stubEnv('HERMES_HOME', hermes);

      await pull({});

      expect(await fse.pathExists(deployIn(hermes))).toBe(true);
      expect(await fse.pathExists(deployIn(shared))).toBe(true);
    });

    describe('while a file of the member\'s holds a skill back in the moved tool', () => {
      beforeEach(async () => {
        config.enabledAgents = ['hermes', 'pi'];
        vi.stubEnv('HERMES_HOME', shared);
        vi.stubEnv('PI_CODING_AGENT_DIR', shared);
        await pull({});
        expect(await fse.pathExists(deployIn(shared))).toBe(true);
        await fse.outputFile(deployIn(hermes), 'Member instructions\n');
      });

      it('keeps the shared copies when the other tool moves in the same pull', async () => {
        await saveToolHomes({ hermes, pi });
        vi.stubEnv('HERMES_HOME', hermes);
        vi.stubEnv('PI_CODING_AGENT_DIR', pi);

        await pull({});

        expect(await fse.pathExists(deployIn(pi))).toBe(true);
        expect(await fse.readFile(deployIn(hermes), 'utf8')).toBe('Member instructions\n');
        expect(await fse.pathExists(deployIn(shared))).toBe(true);
      });

      it('keeps the shared copies when the other tool moves in a later pull', async () => {
        await saveToolHomes({ hermes, pi: shared });
        vi.stubEnv('HERMES_HOME', hermes);
        await pull({});
        await saveToolHomes({ hermes, pi });
        vi.stubEnv('PI_CODING_AGENT_DIR', pi);

        await pull({});

        expect(await fse.pathExists(deployIn(pi))).toBe(true);
        expect(await fse.readFile(deployIn(hermes), 'utf8')).toBe('Member instructions\n');
        expect(await fse.pathExists(deployIn(shared))).toBe(true);
      });
    });
  });

  describe('when only Hermes is selected and moves off a skills directory', () => {
    it.each([
      {
        name: 'a user pull, while OpenCode, installed, reads the old directory',
        scope: 'user', old: 'home/.claude', installed: ['home/.config/opencode'],
      },
      {
        name: 'a project pull, while OpenCode, installed in the user scope only, reads the old directory',
        scope: 'project', old: 'home/.claude', installed: ['home/.config/opencode'],
      },
      {
        name: 'a user pull, while Claude Code reads the old directory in a project',
        scope: 'user', old: 'project/.claude', installed: [],
      },
      {
        name: 'a user pull, while no tool reads the old directory',
        scope: 'user', old: 'hermes-a', installed: [],
      },
    ] as const)('keeps teamai\'s copies there and names the directory once: $name', async ({ scope, old, installed }) => {
      const project = path.join(tmp, 'project'); const oldHome = path.join(tmp, old); const newHome = path.join(tmp, 'hermes-b');
      for (const dir of [project, oldHome, newHome, ...installed.map((dir) => path.join(tmp, dir))]) await fse.ensureDir(dir);
      execFileSync('git', ['init', '-q', project]);
      config.enabledAgents = ['hermes'];
      if (scope === 'project') {
        const projectConfig = { ...config, scope: 'project', projectRoot: project } as LocalConfig;
        vi.mocked(loadLocalConfigForScope).mockImplementation(async (s) => s === 'project' ? projectConfig : null);
        vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
      }
      vi.stubEnv('HERMES_HOME', oldHome);
      await pull({});
      expect(await fse.pathExists(path.join(oldHome, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      await saveToolHomes({ hermes: newHome });
      vi.stubEnv('HERMES_HOME', newHome);
      vi.mocked(log.info).mockClear();

      await pull({});

      expect(await fse.pathExists(path.join(newHome, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(await fse.pathExists(path.join(oldHome, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      expect(await fse.pathExists(path.join(oldHome, 'skills', 'teamai', 'SKILL.md'))).toBe(true);
      const scopeLabel = scope === 'user' ? 'user' : 'workspace';
      const skillsNotice = `[${scopeLabel}] hermes takes skills from ${path.join(newHome, 'skills')} now, so teamai no longer updates its copies in ${path.join(oldHome, 'skills')}. Delete them once no tool reads that directory.`;
      const fileNotice = (noun: 'team rules' | 'instruction blocks'): string =>
        `[${scopeLabel}] hermes takes the ${noun} from ${path.join(newHome, 'SOUL.md')} now, so teamai no longer updates them in ${path.join(oldHome, 'SOUL.md')}. Delete them there once no tool reads it.`;
      expect(notices()).toEqual(scope === 'user'
        ? [skillsNotice, fileNotice('team rules'), fileNotice('instruction blocks')]
        : [skillsNotice]);

      vi.mocked(log.info).mockClear();
      await pull({ force: true });

      expect(notices()).toEqual([]);
      expect(await fse.pathExists(path.join(oldHome, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    });
  });

  it('keeps the old copies once a moved home that did not exist yet takes the skills', async () => {
    const old = path.join(home, '.hermes'); const later = path.join(tmp, 'hermes-later');
    await fse.ensureDir(old);
    await pull({});
    expect(await fse.pathExists(path.join(old, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    vi.stubEnv('HERMES_HOME', later);
    await pull({});
    vi.mocked(log.success).mockClear();
    await pull({});
    expect(vi.mocked(log.success).mock.calls.map((args) => String(args[0]))).toContain('[user] Already synced at abc1234, skipping');
    await fse.ensureDir(later);

    await pull({});

    expect(await fse.pathExists(path.join(later, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(old, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
  });

  it('syncs in full into a recorded home that comes back after a pull it was gone for', async () => {
    const moved = path.join(tmp, 'opencode-moved');
    await fse.ensureDir(moved); await fse.ensureDir(path.join(home, '.config', 'opencode'));
    config.enabledAgents = ['opencode'];
    await saveToolHomes({ opencode: moved });
    await pull({});
    expect(await fse.pathExists(path.join(moved, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    await fse.remove(moved);
    await pull({});
    await fse.ensureDir(moved);

    await pull({});

    expect(await fse.pathExists(path.join(moved, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
  });

  describe('when a tool\'s moved home is its old one through a link', () => {
    let old: string;
    const delivered = async (dir: string): Promise<boolean[]> => Promise.all(['deploy', 'teamai'].map((name) => fse.pathExists(path.join(dir, 'skills', name, 'SKILL.md'))));
    beforeEach(async () => {
      old = path.join(home, '.hermes');
      await fse.ensureDir(old);
      await pull({});
      expect(await delivered(old)).toEqual([true, true]);
    });

    it('keeps every copy when the old home is a link left to the moved one', async () => {
      const real = path.join(home, 'hermes-real');
      await fse.move(old, real); await fse.symlink(real, old);
      vi.stubEnv('HERMES_HOME', real);

      await pull({});

      expect(await delivered(real)).toEqual([true, true]);
    });

    it('keeps every copy when the moved home links to the old one', async () => {
      const link = path.join(home, 'hermes-link');
      await fse.symlink(old, link);
      vi.stubEnv('HERMES_HOME', link);

      await pull({});

      expect(await delivered(link)).toEqual([true, true]);
    });
  });

  it('stops with doctor\'s message while the tool-homes record is invalid, and delivers to no other home', async () => {
    const recorded = path.join(tmp, 'hermes-a');
    await fse.ensureDir(recorded); await fse.ensureDir(path.join(home, '.hermes'));
    vi.stubEnv('HERMES_HOME', recorded);
    await pull({});
    expect(await fse.pathExists(path.join(recorded, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    const invalid = '{"hermes": "relative/x"';
    await fse.writeFile(toolHomesPath(), invalid);
    const xdg = path.join(tmp, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    vi.stubEnv('HERMES_HOME', '');
    const before = structuredClone(saved);

    try {
      await pull({ force: true });

      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
    const errors = vi.mocked(log.error).mock.calls.map(([message]) => String(message));
    expect(errors.find((line) => line.startsWith(`${toolHomesPath()} is not a tool-homes record (`))).toContain('pull syncs nothing until it is');
    expect(await fse.pathExists(path.join(home, '.hermes', 'skills'))).toBe(false);
    expect(await fse.pathExists(path.join(xdg, 'opencode', 'skills'))).toBe(false);
    expect(await fse.pathExists(path.join(recorded, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.readFile(toolHomesPath(), 'utf8')).toBe(invalid);
    expect(saved).toEqual(before);
  });

  it('reports the checkout already synced when only the OpenClaw workspace a session names changed', async () => {
    const custom = path.join(tmp, 'custom-workspace');
    await fse.ensureDir(custom); await fse.ensureDir(path.join(home, '.openclaw', 'workspace'));
    config.enabledAgents = ['openclaw'];
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', custom);
    await pull({});
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', '');
    vi.mocked(log.success).mockClear();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.map((args) => String(args[0]))).toContain('[user] Already synced at abc1234, skipping');
  });

  it('syncs in full into the workspace of a recorded OpenClaw home move, and keeps the old workspace\'s copies', async () => {
    const moved = path.join(home, '.openclaw-work');
    await fse.ensureDir(path.join(home, '.openclaw', 'workspace')); await fse.ensureDir(path.join(moved, 'workspace'));
    config.enabledAgents = ['openclaw'];
    await pull({});
    expect(await fse.pathExists(path.join(home, '.openclaw', 'workspace', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    await saveToolHomes({ openclaw: moved });

    await pull({});

    expect(await fse.pathExists(path.join(moved, 'workspace', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.openclaw', 'workspace', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
  });

  it('syncs in full again after a recorded OpenClaw home move that missed a skill', async () => {
    const moved = path.join(home, '.openclaw-work'); const skills = path.join(moved, 'workspace', 'skills');
    await fse.ensureDir(path.join(home, '.openclaw', 'workspace')); await fse.ensureDir(path.join(moved, 'workspace'));
    config.enabledAgents = ['openclaw'];
    await pull({});
    await saveToolHomes({ openclaw: moved });
    await fse.ensureDir(path.join(tmp, 'member-skills'));
    await fse.symlink(path.join(tmp, 'member-skills'), skills);
    await pull({});
    expect(vi.mocked(log.warn).mock.calls.flat()).toContainEqual(expect.stringContaining('Skipped deploy (openclaw)'));
    await fse.remove(skills);

    await pull({});

    expect(await fse.pathExists(path.join(skills, 'deploy', 'SKILL.md'))).toBe(true);
  });

  it('reports the checkout already synced after a full pull that kept the member\'s own OpenClaw built-in skill', async () => {
    await fse.ensureDir(path.join(home, '.openclaw', 'workspace'));
    config.enabledAgents = ['openclaw'];
    await pull({});
    await fse.outputFile(path.join(home, '.openclaw', 'workspace', 'skills', 'teamai', 'SKILL.md'), 'Member instructions\n');
    await pull({ force: true });
    vi.mocked(log.success).mockClear();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.map((args) => String(args[0]))).toContain('[user] Already synced at abc1234, skipping');
  });

  it('reports the checkout already synced when the member\'s own OpenClaw built-in skill was there before the first pull', async () => {
    await fse.outputFile(path.join(home, '.openclaw', 'workspace', 'skills', 'teamai', 'SKILL.md'), 'Member instructions\n');
    config.enabledAgents = ['openclaw'];
    await pull({});
    vi.mocked(log.success).mockClear();

    await pull({});

    expect(vi.mocked(log.success).mock.calls.map((args) => String(args[0]))).toContain('[user] Already synced at abc1234, skipping');
  });

  it('never removes OpenClaw\'s copies from a workspace another session\'s env named', async () => {
    const custom = path.join(tmp, 'custom-workspace');
    await fse.ensureDir(custom); await fse.ensureDir(path.join(home, '.openclaw', 'workspace'));
    config.enabledAgents = ['openclaw'];
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', custom);
    await pull({});
    expect(await fse.pathExists(path.join(custom, 'skills', 'deploy', 'SKILL.md'))).toBe(true);

    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', '');
    await pull({ force: true });

    expect(await fse.pathExists(path.join(home, '.openclaw', 'workspace', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(custom, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
  });

  describe('every skills pass looks where the tool takes skills', () => {
    const team = () => TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' });

    it('cleans a tombstoned skill out of HERMES_HOME', async () => {
      const hermes = path.join(tmp, 'hermes'); await fse.ensureDir(hermes);
      vi.stubEnv('HERMES_HOME', hermes);
      await pull({});
      expect(await fse.pathExists(path.join(hermes, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      await fse.remove(path.join(repo, 'skills', 'deploy'));
      await fse.outputFile(path.join(repo, 'skills', '.removed'), 'deploy\n');

      await pull({ force: true });

      expect(await fse.pathExists(path.join(hermes, 'skills', 'deploy'))).toBe(false);
    });

    it('removes a skill no longer delivered from the OpenClaw workspace', async () => {
      const state = path.join(tmp, 'openclaw'); await fse.ensureDir(path.join(state, 'workspace'));
      vi.stubEnv('OPENCLAW_STATE_DIR', state);
      config.enabledAgents = ['openclaw'];
      await pull({});
      expect(await fse.pathExists(path.join(state, 'workspace', 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      config.excludedSkills = ['deploy'];

      await pull({ force: true });

      expect(await fse.pathExists(path.join(state, 'workspace', 'skills', 'deploy'))).toBe(false);
    });

    it('removes a skill no longer delivered from COPILOT_HOME, not from ~/skills', async () => {
      const copilot = path.join(tmp, 'copilot'); await fse.ensureDir(copilot);
      vi.stubEnv('COPILOT_HOME', copilot);
      config.enabledAgents = ['copilot'];
      await pull({});
      expect(await fse.pathExists(path.join(copilot, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      config.excludedSkills = ['deploy'];

      await pull({ force: true });

      expect(await fse.pathExists(path.join(copilot, 'skills', 'deploy'))).toBe(false);
    });

    it('labels a skill already in HERMES_HOME updated, not new', async () => {
      const hermes = path.join(tmp, 'hermes'); await fse.ensureDir(hermes);
      vi.stubEnv('HERMES_HOME', hermes);
      await pull({});
      expect(await fse.pathExists(path.join(hermes, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
      vi.mocked(log.success).mockClear();

      await pull({ force: true });

      expect(vi.mocked(log.success).mock.calls.map((args) => String(args[0]))).toEqual(['[user] Synced 1 skills (all updated)']);
    });

    it('offers a skill written in HERMES_HOME for push', async () => {
      const hermes = path.join(tmp, 'hermes'); await fse.ensureDir(hermes);
      vi.stubEnv('HERMES_HOME', hermes);
      await pull({});
      await fse.outputFile(path.join(hermes, 'skills', 'drafted', 'SKILL.md'), '---\nname: drafted\ndescription: d\n---\nDrafted.\n');

      const items = await getHandler('skills').scanLocalForPush(team(), config);

      expect(items.map((item) => item.name)).toContain('drafted');
    });

    it('removes a skill from HERMES_HOME on teamai remove', async () => {
      const hermes = path.join(tmp, 'hermes'); await fse.ensureDir(hermes);
      vi.stubEnv('HERMES_HOME', hermes);
      await pull({});
      expect(await fse.pathExists(path.join(hermes, 'skills', 'deploy', 'SKILL.md'))).toBe(true);

      await getHandler('skills').removeItem('deploy', team(), config);

      expect(await fse.pathExists(path.join(hermes, 'skills', 'deploy'))).toBe(false);
    });
  });
});
