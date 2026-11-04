import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshRoleAssignment } from '../config.js';
import { driveByDefault } from '../default-driver.js';
import { getUserConfigPath, LocalConfigSchema, type LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

const dirs: string[] = [];
const machineFile = getUserConfigPath;

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(machineFile(), { force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `yaml` as this machine's member settings. */
function onMachine(yaml: string): void {
  fs.mkdirSync(path.dirname(machineFile()), { recursive: true });
  fs.writeFileSync(machineFile(), yaml);
}

/** A workspace whose own config.yaml adds `workspaceYaml`, in a team whose teamai.yaml adds `teamYaml`, loaded as teamai loads it. */
async function workspace(workspaceYaml: string, teamYaml = ''): Promise<LocalConfig> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-default-driver-')));
  dirs.push(root);
  const team = path.join(root, 'team');
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(team, 'teamai.yaml'), `team: t\nrepo: https://example.com/t.git\n${teamYaml}`);
  const dataHome = path.join(root, 'data');
  fs.mkdirSync(dataHome);
  const yaml = `repo: { localPath: ${JSON.stringify(team)}, remote: origin }\nusername: tester\nscope: workspace\nprojectRoot: ${JSON.stringify(root)}\n${workspaceYaml}`;
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), yaml);
  const config: LocalConfig = { ...LocalConfigSchema.parse(YAML.parse(yaml)), dataHome };
  await refreshRoleAssignment(config);
  return config;
}

/** What `log.warn` said while `run` ran. */
async function warned<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const value = await run();
  return { value, warnings: warn.mock.calls.map((call) => call.map(String).join(' ')) };
}

describe('driveByDefault', () => {
  it('drives here on the local driver when no level sets workflows.driver', async () => {
    const config = await workspace('');

    expect(await driveByDefault(config)).toEqual({ kind: 'drive', driver: 'local' });
  });

  it('awaits the driver the team sets, which this machine does not run', async () => {
    const config = await workspace('', 'workflows: { driver: acme-sandbox }\n');

    expect(await driveByDefault(config)).toEqual({ kind: 'awaits', driver: 'acme-sandbox' });
  });

  it('takes the member\'s machine setting over the team\'s, and the workspace\'s own over both', async () => {
    onMachine('workflows: { driver: local }\n');
    const machine = await workspace('', 'workflows: { driver: acme }\n');
    const own = await workspace('workflows: { driver: beta }\n', 'workflows: { driver: acme }\n');

    expect(await driveByDefault(machine)).toEqual({ kind: 'drive', driver: 'local' });
    expect(await driveByDefault(own)).toEqual({ kind: 'awaits', driver: 'beta' });
  });

  it('leaves the run to any driver with none', async () => {
    const config = await workspace('workflows: { driver: none }\n', 'workflows: { driver: acme }\n');

    expect(await driveByDefault(config)).toEqual({ kind: 'unassigned' });
  });

  it.each([
    ['a value that is no driver name', 'acme sandbox', '"acme sandbox" is not a driver name: letters, digits, dot, underscore and hyphen, starting with a letter or digit'],
    ['a value that is no text', '[acme]', '["acme"] is not a driver name: letters, digits, dot, underscore and hyphen, starting with a letter or digit'],
    ['fleet', 'fleet', 'fleet is a driver name teamai reserves, and no driver of it exists yet'],
    ['skill', 'skill', 'the skill driver needs a coding session, so it drives only a run started with --driver skill'],
  ])('skips %s with a warning naming its file, and the next level decides', async (_case, value, why) => {
    onMachine(`workflows: { driver: ${value} }\n`);
    const config = await workspace('', 'workflows: { driver: gamma }\n');

    const { value: decided, warnings } = await warned(() => driveByDefault(config));

    expect(decided).toEqual({ kind: 'awaits', driver: 'gamma' });
    expect(warnings).toEqual([`Ignoring workflows.driver in ${machineFile()}: ${why}.`]);
  });
});
