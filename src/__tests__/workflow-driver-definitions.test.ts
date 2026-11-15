import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDriverDefinition, resolveDriver } from '../workflow/runtimes/definitions.js';
import { openDriver } from '../workflow/runtimes/sources.js';
import { acceptRuntime, locateRuntime } from '../workflow/runtimes/locate.js';
import { RESERVED_DRIVERS } from '../workflow/reserved-drivers.js';
import { shippedDriverFile } from '../default-drivers.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { log } from '@teamai/shared/log';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(path.join(getTeamaiHomeDir(), 'drivers'), { recursive: true, force: true });
  fs.rmSync(path.join(getTeamaiHomeDir(), 'trust'), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const definition = (name: string): string => `schemaVersion: v1alpha1\nname: ${name}\nruntimes:\n  - use: local\n`;

/** A config in `scope` whose team repo holds a definition for each of `names` under drivers/. */
function teamWith(names: string[], scope: LocalConfig['scope'] = 'user'): LocalConfig {
  const team = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-driver-definitions-')));
  dirs.push(team);
  fs.mkdirSync(path.join(team, 'drivers'));
  for (const name of names) fs.writeFileSync(path.join(team, 'drivers', `${name}.yaml`), definition(name));
  return { repo: { localPath: team, remote: 'origin', kind: 'git' }, username: 'tester', scope, additionalRoles: [], ...(scope === 'project' && { projectRoot: team }) };
}

describe('driver definition names', () => {
  it('keeps for its own drivers local, skill, none, fleet and host, which no definition file may take', () => {
    expect(Object.values(RESERVED_DRIVERS).toSorted()).toEqual(['fleet', 'host', 'local', 'none', 'skill']);
    for (const name of Object.values(RESERVED_DRIVERS)) expect(parseDriverDefinition(`drivers/${name}.yaml`, definition(name))).toMatchObject({ ok: false, failure: { code: 'driver_invalid', message: expect.stringContaining(`"${name}" is a name teamai keeps for its own driver`) } });
  });

  it('loads a definition with an ordinary name from the team repo, from ~/.teamai/drivers/, and from a project\'s own team repo', async () => {
    const team = teamWith(['acme-sandbox']);
    const project = teamWith(['payments.ci'], 'project');
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'drivers'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'drivers', 'my_box.yaml'), definition('my_box'));

    expect(await resolveDriver(team, 'acme-sandbox', { personal: true })).toMatchObject({ ok: true, driver: { name: 'acme-sandbox', source: 'team' } });
    expect(await resolveDriver(team, 'my_box', { personal: true })).toMatchObject({ ok: true, driver: { name: 'my_box', source: 'personal' } });
    expect(await resolveDriver(project, 'payments.ci', { personal: true })).toMatchObject({ ok: true, driver: { name: 'payments.ci', source: 'team' } });
  });

  it('reads no definition of the member\'s own where personal ones do not count, and does not tell the member to add one there', async () => {
    const team = teamWith([]);
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'drivers'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'drivers', 'my_box.yaml'), definition('my_box'));

    expect(await resolveDriver(team, 'my_box', { personal: false })).toEqual({ ok: false, failure: {
      code: 'driver_not_found',
      message: 'No driver definition of the team or teamai is named "my_box", and a definition in ~/.teamai/drivers/ does not count here. Add drivers/my_box.yaml to the team repo and run teamai pull, or use --driver local.',
    } });
  });

  it('loads a definition in a namespace only for a member whose project selects it for workflows, and refuses two active namespaces that define one name', async () => {
    const team = { ...teamWith([]), projects: ['checkout'] };
    const at = (file: string): string => path.join(team.repo.localPath, file);
    fs.mkdirSync(at('manifest'));
    fs.writeFileSync(at('manifest/projects.yaml'), 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web, ops] }\n  - id: billing\n    resources: { workflows: [mobile] }\n');
    for (const file of ['drivers/web/web-box.yaml', 'drivers/mobile/mobile-box.yaml', 'drivers/web/twice.yaml', 'drivers/ops/twice.yaml']) {
      fs.mkdirSync(path.dirname(at(file)), { recursive: true });
      fs.writeFileSync(at(file), definition(path.basename(file, '.yaml')));
    }

    expect(await resolveDriver(team, 'web-box', { personal: true })).toMatchObject({ ok: true, driver: { name: 'web-box', source: 'team', location: 'drivers/web/web-box.yaml in the team repo' } });
    expect(await resolveDriver(team, 'mobile-box', { personal: true })).toMatchObject({ ok: false, failure: { code: 'driver_not_found' } });
    expect(await resolveDriver(team, 'twice', { personal: true })).toEqual({ ok: false, failure: {
      code: 'driver_namespace_conflict',
      message: 'Driver "twice" is defined in two active namespaces (drivers/web/twice.yaml and drivers/ops/twice.yaml). Keep it in one namespace, push it, run teamai pull, and start again.',
    } });
  });

  it('loads a definition of a self-mode team tree, from .teamai/drivers/', async () => {
    const business = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-driver-self-')));
    dirs.push(business);
    fs.mkdirSync(path.join(business, '.teamai', 'drivers'), { recursive: true });
    fs.writeFileSync(path.join(business, '.teamai', 'drivers', 'self-box.yaml'), definition('self-box'));
    const self: LocalConfig = { repo: { localPath: path.join(business, '.teamai'), remote: 'origin', kind: 'self', businessRepoRoot: business }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: business };

    expect(await resolveDriver(self, 'self-box', { personal: true })).toMatchObject({ ok: true, driver: { source: 'team', location: 'drivers/self-box.yaml in the team repo' } });
  });

  it('names a definition that is not valid by its path in the team repo, never by the team clone\'s', async () => {
    const team = teamWith([]);
    fs.writeFileSync(path.join(team.repo.localPath, 'drivers', 'broken.yaml'), definition('other'));

    expect(await resolveDriver(team, 'broken', { personal: true })).toEqual({ ok: false, failure: {
      code: 'driver_invalid',
      message: 'Driver definition drivers/broken.yaml in the team repo is not valid: its name is "other", and a definition is named after its file or its folder, "broken". Fix the file and start again.',
    } });
  });

  it('loads a definition kept as a folder with its DRIVER.yaml, named after the folder, of the team, a namespace or the member, and refuses one name kept both ways', async () => {
    const team = { ...teamWith([]), projects: ['checkout'] };
    const at = (file: string): string => path.join(team.repo.localPath, file);
    fs.mkdirSync(at('manifest'));
    fs.writeFileSync(at('manifest/projects.yaml'), 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n  - id: billing\n    resources: { workflows: [mobile] }\n');
    const files = {
      'drivers/acme/DRIVER.yaml': definition('acme'), 'drivers/web/web-box/DRIVER.yaml': definition('web-box'), 'drivers/mobile/mobile-box/DRIVER.yaml': definition('mobile-box'),
      'drivers/both.yaml': definition('both'), 'drivers/both/DRIVER.yaml': definition('both'),
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(at(file)), { recursive: true });
      fs.writeFileSync(at(file), text);
    }
    fs.mkdirSync(path.join(getTeamaiHomeDir(), 'drivers', 'my_box'), { recursive: true });
    fs.writeFileSync(path.join(getTeamaiHomeDir(), 'drivers', 'my_box', 'DRIVER.yaml'), definition('my_box'));

    expect(await resolveDriver(team, 'acme', { personal: true })).toMatchObject({ ok: true, driver: { name: 'acme', source: 'team', location: 'drivers/acme/DRIVER.yaml in the team repo' } });
    expect(await resolveDriver(team, 'DRIVER', { personal: true })).toMatchObject({ ok: false, failure: { code: 'driver_not_found' } });
    expect(await resolveDriver(team, 'web-box', { personal: true })).toMatchObject({ ok: true, driver: { name: 'web-box', location: 'drivers/web/web-box/DRIVER.yaml in the team repo' } });
    expect(await resolveDriver(team, 'mobile-box', { personal: true })).toMatchObject({ ok: false, failure: { code: 'driver_not_found' } });
    expect(await resolveDriver(team, 'my_box', { personal: true })).toMatchObject({ ok: true, driver: { name: 'my_box', source: 'personal', location: path.join(getTeamaiHomeDir(), 'drivers', 'my_box', 'DRIVER.yaml') } });
    expect(await resolveDriver(team, 'both', { personal: true })).toEqual({ ok: false, failure: {
      code: 'driver_namespace_conflict',
      message: 'Driver "both" is defined twice in one place (drivers/both.yaml and drivers/both/). Keep one, push it, run teamai pull, and start again.',
    } });
  });

  it('refuses the definitions of a team repo whose drivers folder is a link, reads nothing through it, and runs no teamai default in their place', async () => {
    const team = teamWith([]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-drivers-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'mine.yaml'), definition('mine'));
    fs.rmSync(path.join(team.repo.localPath, 'drivers'), { recursive: true });
    fs.symlinkSync(outside, path.join(team.repo.localPath, 'drivers'));
    const refused = { ok: false, failure: {
      code: 'driver_invalid',
      message: 'drivers in the team repo is a link, and teamai reads the team\'s driver definitions only from a folder the team repo holds, so it reads none of them. Replace the link with the folder, push it, run teamai pull, and start again.',
    } };

    expect(await resolveDriver(team, 'mine', { personal: true })).toEqual(refused);
    expect(await resolveDriver(team, 'local', { personal: true })).toEqual(refused);
  });

  it.each(Object.values(RESERVED_DRIVERS).filter((name) => name !== 'local' && name !== 'host'))('refuses a definition named %s, a name teamai keeps for its own driver', async (name) => {
    const team = teamWith([name]);

    expect(parseDriverDefinition(`drivers/${name}.yaml`, definition(name))).toMatchObject({ ok: false, failure: { code: 'driver_invalid' } });
    expect(await resolveDriver(team, name, { personal: true })).toMatchObject({ ok: false, failure: { code: 'driver_not_found', message: expect.stringContaining(`"${name}"`) } });
  });
});

describe('the local driver, which is the definition teamai-local', () => {
  const open = (config: LocalConfig, name: string) => openDriver(config, name, { personal: true, mode: 'unattended', canAsk: false, purpose: 'run', checkout: config.repo.localPath });

  it('opens the shipped teamai-local for --driver local, a definition of the tools runtime alone that names no tool', async () => {
    const opened = await open(teamWith([]), 'local');

    expect(opened).toMatchObject({ ok: true, opened: { asked: 'local', driver: { name: 'teamai-local', source: 'shipped', definition: { runtimes: [{ use: 'tools' }] } }, runtimes: [{ kind: 'tools', use: 'tools' }] } });
    expect(opened.ok && opened.opened.driver.definition.tool).toBeUndefined();
  });

  it('takes a member\'s ~/.teamai/drivers/teamai-local.yaml for --driver local over the team\'s, and says once which file it took', async () => {
    const team = teamWith(['teamai-local']);
    const file = path.join(getTeamaiHomeDir(), 'drivers', 'teamai-local.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'schemaVersion: v1alpha1\nname: teamai-local\ntool: codex\nruntimes:\n  - use: tools\n');
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    expect(await open(team, 'local')).toMatchObject({ ok: true, opened: { driver: { source: 'personal', location: file, definition: { tool: 'codex' } } } });
    expect(info.mock.calls.map(([line]) => line)).toEqual([`Driver local runs ${file}, your own teamai-local, in place of teamai's.`]);
  });

  it('takes the team\'s drivers/teamai-local.yaml for --driver local, and says so', async () => {
    const team = teamWith(['teamai-local']);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    expect(await open(team, 'local')).toMatchObject({ ok: true, opened: { driver: { source: 'team' } } });
    expect(info.mock.calls.map(([line]) => line)).toEqual(['Driver local runs drivers/teamai-local.yaml in the team repo, the team\'s teamai-local, in place of teamai\'s.']);
  });

  it('refuses a definition named local, and never reads a team\'s drivers/local.yaml for --driver local', async () => {
    const team = teamWith(['local']);

    expect(parseDriverDefinition('drivers/local.yaml', definition('local'))).toMatchObject({ ok: false, failure: { code: 'driver_invalid' } });
    expect(await resolveDriver(team, 'local', { personal: true })).toMatchObject({ ok: true, driver: { name: 'teamai-local', source: 'shipped' } });
  });

  it('runs a definition\'s use: local as the tools runtime, and logs nothing for it', async () => {
    const team = teamWith(['mine']);
    const said = [vi.spyOn(log, 'warn').mockImplementation(() => {}), vi.spyOn(log, 'info').mockImplementation(() => {})];

    expect(await open(team, 'mine')).toMatchObject({ ok: true, opened: { runtimes: [{ kind: 'tools' }] } });
    expect(said.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });

  it('ships each preset on the tools runtime, and none of an app with a fallback to this machine', () => {
    const runtimes = (name: string): unknown => {
      const parsed = parseDriverDefinition(`${name}.yaml`, fs.readFileSync(shippedDriverFile(name), 'utf8'));

      return parsed.ok ? { tool: parsed.definition.tool, uses: parsed.definition.runtimes.map((entry) => entry.use) } : parsed.failure.message;
    };

    expect(Object.fromEntries(['teamai-local', 'teamai-claude', 'teamai-codex', 'teamai-opencode', 'teamai-t3', 'teamai-paseo', 'teamai-sandbox'].map((name) => [name, runtimes(name)]))).toEqual({
      'teamai-local': { tool: undefined, uses: ['tools'] },
      'teamai-claude': { tool: 'claude', uses: ['tools'] },
      'teamai-codex': { tool: 'codex', uses: ['tools'] },
      'teamai-opencode': { tool: 'opencode', uses: ['tools'] },
      'teamai-t3': { tool: undefined, uses: ['t3'] },
      'teamai-paseo': { tool: undefined, uses: ['paseo'] },
      'teamai-sandbox': { tool: undefined, uses: ['sandbox', 'tools'] },
    });
  });
});

describe('a runtime through another in a definition', () => {
  const through = (use: string, by: string): string => `schemaVersion: v1alpha1\nname: boxed\nruntimes:\n  - use: ${use}\n    through: ${by}\n    options:\n      ${use}: {}\n`;

  it('reads a runtime through another, each one\'s options under its name', () => {
    expect(parseDriverDefinition('drivers/boxed.yaml', through('t3', 'sandbox'))).toMatchObject({ ok: true, definition: { runtimes: [{ use: 't3', through: 'sandbox', options: { t3: {} } }] } });
  });

  it('refuses a runtime through itself, naming through', () => {
    expect(parseDriverDefinition('drivers/boxed.yaml', through('sandbox', 'sandbox'))).toMatchObject({ ok: false, failure: { code: 'driver_invalid', message: expect.stringContaining('runtimes.0.through: A runtime runs through another runtime, not through itself') } });
  });

  it.each([['fleet', 'sandbox'], ['t3', 'fleet']])('refuses %s through %s, naming the entry and saying the fleet composes without through', (use, by) => {
    expect(parseDriverDefinition('drivers/boxed.yaml', through(use, by))).toMatchObject({ ok: false, failure: { code: 'driver_invalid', message: expect.stringContaining('runtimes.0.through: fleet runs no step through another runtime, and no runtime runs through fleet: a fleet entry composes without through, since each member runs the step on its own driver') } });
  });
});

describe('the host driver, which teamai builds in', () => {
  const open = (config: LocalConfig, name: string) => openDriver(config, name, { personal: true, mode: 'unattended', canAsk: false, purpose: 'run', checkout: config.repo.localPath });

  it('opens --driver host with no runtime, so only the host slot runs, whatever teamai-local the team ships', async () => {
    const team = teamWith(['teamai-local']);

    expect(await open(team, 'host')).toMatchObject({ ok: true, opened: { asked: 'host', driver: { name: 'host', source: 'builtin', definition: { runtimes: [] } }, runtimes: [] } });
  });

  it('refuses a definition named host, and says once, as a run opens it, that it read neither the member\'s nor the team\'s drivers/host.yaml', async () => {
    const team = teamWith(['host']);
    const personal = path.join(getTeamaiHomeDir(), 'drivers', 'host.yaml');
    fs.mkdirSync(path.dirname(personal), { recursive: true });
    fs.writeFileSync(personal, definition('host'));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    expect(parseDriverDefinition('drivers/host.yaml', definition('host'))).toMatchObject({ ok: false, failure: { code: 'driver_invalid', message: expect.stringContaining('"host" is a name teamai keeps for its own driver') } });
    expect(await resolveDriver(team, 'host', { personal: true })).toMatchObject({ ok: true, driver: { name: 'host', source: 'builtin' } });
    expect(await open(team, 'host')).toMatchObject({ ok: true, opened: { driver: { name: 'host', source: 'builtin' }, runtimes: [] } });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([personal, 'drivers/host.yaml in the team repo'].map((file) => (
      `Driver definition ${file} is not read: host is teamai's built-in driver, which runs only commands, gates and workflows whose steps need no AI tool, and no file replaces it. Rename the file and the name in it.`
    )));
  });
});

describe('a run that needs no AI tool and the runtimes that run no command', () => {
  /** The marker of a runtime folder whose entry is ./runtime, with `exec` when given. */
  const marker = (exec?: boolean): string => `protocol: 1\nentry: ./runtime\n${exec === undefined ? '' : `exec: ${exec}\n`}`;

  /** A team whose runtimes/agents/ holds a runtime with `exec` in its marker when given, and a definition of it. */
  function teamWithRuntime(exec?: boolean): LocalConfig {
    const team = teamWith([]);
    const dir = path.join(team.repo.localPath, 'runtimes', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime'), 'not run: an unattended open refuses a revision no one accepted\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'RUNTIME.yaml'), marker(exec));
    fs.writeFileSync(path.join(team.repo.localPath, 'drivers', 'agents.yaml'), 'schemaVersion: v1alpha1\nname: agents\nruntimes:\n  - use: agents\n');
    return team;
  }

  const open = (config: LocalConfig, needsAiTool: boolean) => openDriver(config, 'agents', { personal: true, mode: 'unattended', canAsk: false, purpose: 'run', checkout: config.repo.localPath, needsAiTool });

  /** Accepts the team runtime `agents` of `team` at its revision, as a person at the terminal would. */
  async function accept(team: LocalConfig): Promise<void> {
    const resolved = await resolveDriver(team, 'agents', { personal: true });
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const located = await locateRuntime(resolved.driver, 'agents');
    if (!located.ok) throw new Error(located.failure.message);
    expect(await acceptRuntime(located.source, { mode: 'attended', canAsk: true, ask: async () => true })).toEqual({ ok: true });
  }

  it('does not open a team runtime whose marker says it runs no command, for a run that needs no AI tool, once its revision is accepted here', async () => {
    const team = teamWithRuntime(false);
    await accept(team);

    expect(await open(team, false)).toMatchObject({ ok: true, opened: { runtimes: [] } });
  });

  it('refuses a team runtime whose marker is a link, whose target the accepted revision does not hold', async () => {
    const team = teamWithRuntime();
    const dir = path.join(team.repo.localPath, 'runtimes', 'agents');
    fs.writeFileSync(path.join(team.repo.localPath, 'facts.yaml'), marker(false));
    fs.rmSync(path.join(dir, 'RUNTIME.yaml'));
    fs.symlinkSync(path.join(team.repo.localPath, 'facts.yaml'), path.join(dir, 'RUNTIME.yaml'));

    expect(await open(team, false)).toMatchObject({ ok: false, failure: { code: 'runtime_not_found', message: expect.stringContaining('holds the link RUNTIME.yaml') } });
  });

  it('refuses a team runtime whose folder holds a link, since the revision a member accepts would not hold what it names', async () => {
    const team = teamWithRuntime();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'index.js'), 'not run\n');
    fs.mkdirSync(path.join(team.repo.localPath, 'runtimes', 'agents', 'src'));
    fs.symlinkSync(outside, path.join(team.repo.localPath, 'runtimes', 'agents', 'src', 'lib'));

    expect(await open(team, true)).toEqual({
      ok: false,
      failure: {
        code: 'runtime_not_found',
        message: 'Driver "agents" uses runtime "agents", whose folder runtimes/agents in the team repo holds the link src/lib, and teamai runs a team runtime only when its folder holds no link, so the revision you accept is all it runs. Replace the link with what it names, push it, run teamai pull, and start again.',
      },
    });
  });

  it('refuses a team runtime whose folder is a link, and reads nothing through it', async () => {
    const team = teamWith([]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'runtime'), 'not run\n', { mode: 0o755 });
    fs.writeFileSync(path.join(outside, 'RUNTIME.yaml'), marker(false));
    fs.mkdirSync(path.join(team.repo.localPath, 'runtimes'));
    fs.symlinkSync(outside, path.join(team.repo.localPath, 'runtimes', 'agents'));
    fs.writeFileSync(path.join(team.repo.localPath, 'drivers', 'agents.yaml'), 'schemaVersion: v1alpha1\nname: agents\nruntimes:\n  - use: agents\n');

    expect(await open(team, false)).toEqual({
      ok: false,
      failure: {
        code: 'runtime_not_found',
        message: 'Driver "agents" uses runtime "agents", whose folder runtimes/agents in the team repo is a link, and teamai runs a team runtime only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.',
      },
    });
  });

  it('refuses a team runtime reached through a linked runtimes folder, and reads nothing through it', async () => {
    const team = teamWith([]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-outside-'));
    dirs.push(outside);
    fs.mkdirSync(path.join(outside, 'agents'));
    fs.writeFileSync(path.join(outside, 'agents', 'runtime'), 'not run\n', { mode: 0o755 });
    fs.writeFileSync(path.join(outside, 'agents', 'RUNTIME.yaml'), marker(false));
    fs.symlinkSync(outside, path.join(team.repo.localPath, 'runtimes'));
    fs.writeFileSync(path.join(team.repo.localPath, 'drivers', 'agents.yaml'), 'schemaVersion: v1alpha1\nname: agents\nruntimes:\n  - use: agents\n');

    expect(await open(team, false)).toEqual({
      ok: false,
      failure: {
        code: 'runtime_not_found',
        message: 'Driver "agents" uses runtime "agents", and runtimes in the team repo is a link, and teamai runs a team runtime only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.',
      },
    });
  });

  it('opens it for a run that needs an AI tool or before its revision is accepted, and opens a team runtime whose marker does not say, or says it runs commands', async () => {
    const unaccepted = { ok: false, failure: { code: 'runtime_not_accepted' } };

    expect(await open(teamWithRuntime(false), true)).toMatchObject(unaccepted);
    // What a revision no one accepted declares decides nothing, so it cannot move the commands to the host slot.
    expect(await open(teamWithRuntime(false), false)).toMatchObject(unaccepted);
    expect(await open(teamWithRuntime(), false)).toMatchObject(unaccepted);
    expect(await open(teamWithRuntime(true), false)).toMatchObject(unaccepted);
  });
});
