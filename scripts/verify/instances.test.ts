import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { getUserHome } from '@teamai/shared/home';
import { installInstances, judgedInstances, recordedInstallInstances, recordInstallInstances } from './instances.js';
import { ledgerRules } from './ledger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);

  return dir;
}

/** An install whose team declares acme-codex, a Codex instance whose home ACME_CODEX_HOME moves. */
function installWithMovableHome(): { home: string; config: string } {
  const home = tempDir('instances-home-');
  const dataHome = path.join(home, '.teamai', 'projects', 'w-project-0123456789abcdef');
  const team = path.join(dataHome, 'team-repo');
  fs.mkdirSync(path.join(team, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(team, 'tools', 'acme-codex.yaml'), 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\ncommand: acme-codex\nhome: { dir: .acme-codex, env: ACME_CODEX_HOME }\n');
  const config = path.join(dataHome, 'config.yaml');
  fs.writeFileSync(config, `repo:\n  localPath: ${team}\n  remote: https://teamai.test/team/repo.git\nscope: workspace\nenabledAgents:\n  - acme-codex\n`);

  return { home, config };
}

const homesOf = async (home: string, env: Record<string, string>, cwd = home) => (await installInstances(home, { env, cwd })).map(({ declared, home: found }) => [declared.name, found]);

describe("where a world's command finds an instance's home", () => {
  it('is its home.dir under HOME when the command has no value of its variable', async () => {
    const { home } = installWithMovableHome();

    expect(await homesOf(home, {})).toEqual([['acme-codex', '.acme-codex']]);
  });

  it("is where the command's value of home.env puts it, an absolute path or one relative to the command's directory", async () => {
    const { home } = installWithMovableHome();

    expect(await homesOf(home, { ACME_CODEX_HOME: path.join(home, 'work', 'acme-moved') })).toEqual([['acme-codex', 'work/acme-moved']]);
    expect(await homesOf(home, { ACME_CODEX_HOME: 'acme-moved' }, path.join(home, 'work'))).toEqual([['acme-codex', 'work/acme-moved']]);
  });

  it("is the home the install recorded for its variable, which a command without the variable reads too", async () => {
    const { home } = installWithMovableHome();
    fs.writeFileSync(path.join(home, '.teamai', 'tool-homes.json'), JSON.stringify({ 'acme-codex': path.join(home, 'work', 'acme-recorded') }));

    expect(await homesOf(home, {})).toEqual([['acme-codex', 'work/acme-recorded']]);
  });

  it("never reads the homes recorded in the harness's own HOME", async () => {
    const { home } = installWithMovableHome();
    fs.mkdirSync(path.join(getUserHome(), '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(getUserHome(), '.teamai', 'tool-homes.json'), JSON.stringify({ 'acme-codex': path.join(home, 'harness-record') }));
    onTestFinished(() => fs.rmSync(path.join(getUserHome(), '.teamai', 'tool-homes.json'), { force: true }));

    expect(await homesOf(home, {})).toEqual([['acme-codex', '.acme-codex']]);
  });

  it('is none under HOME when that value lies outside it', async () => {
    const { home } = installWithMovableHome();

    expect(await homesOf(home, { ACME_CODEX_HOME: tempDir('instances-elsewhere-') })).toEqual([['acme-codex', undefined]]);
  });
});

describe("the world's record of its instances", () => {
  it("keeps every home its commands found an instance at after uninstall removed what declares it", async () => {
    const world = { dir: tempDir('instances-world-') };
    const { home, config } = installWithMovableHome();
    recordInstallInstances(world, home, await installInstances(home, { env: {}, cwd: home }));
    recordInstallInstances(world, home, await installInstances(home, { env: { ACME_CODEX_HOME: path.join(home, 'work', 'acme-moved') }, cwd: home }));
    fs.rmSync(config);

    expect(await installInstances(home, { env: {}, cwd: home })).toEqual([]);
    expect(recordedInstallInstances(world, home).map(({ declared, home: found }) => [declared.name, found])).toEqual([['acme-codex', '.acme-codex'], ['acme-codex', 'work/acme-moved']]);
    expect(recordedInstallInstances(world, path.join(home, 'other'))).toEqual([]);
  });
});

describe('what uninstall leaves in a Codex instance home that home.env moved', () => {
  const sha = 'f'.repeat(64);
  const moved = 'home/work/acme-moved';

  async function rules() {
    const { home } = installWithMovableHome();

    return ledgerRules(judgedInstances(await installInstances(home, { env: { ACME_CODEX_HOME: path.join(home, 'work', 'acme-moved') }, cwd: home })));
  }

  // Codex's own state, judged exactly as the same entry in ~/.codex.
  it.each([
    ['sessions/2026/11/14/rollout.jsonl', sha],
    ['sessions', 'dir'],
    ['config.toml', sha],
    // What teamai delivers there: never the tool's, a LEAK as in ~/.codex.
    ['hooks.json', sha],
    ['skills/hello-world/SKILL.md', sha],
    ['AGENTS.md', sha],
  ])('judges %s holding %s as the same entry in Codex\'s own home', async (entry, value) => {
    const judged = await rules();
    const base = judged.ownStateOf(`home/.codex/${entry}`, value);

    expect(judged.ownStateOf(`${moved}/${entry}`, value)).toEqual(base === undefined ? undefined : { ...base, dir: moved });
    expect(judged.knownLeftover(`${moved}/${entry}`)).toBe(judged.knownLeftover(`home/.codex/${entry}`));
  });

  it("excuses Codex's state there and keeps teamai's a LEAK", async () => {
    const judged = await rules();

    expect(judged.ownStateOf(`${moved}/sessions/2026/11/14/rollout.jsonl`, sha)).toEqual({ kind: 'state', owner: 'the tool', dir: moved });
    expect([moved, 'home/work'].map((entry) => judged.knownLeftover(entry))).toEqual(['dir', 'dir']);
    expect(judged.knownLeftover(`${moved}/config.toml`)).toBeDefined();
    expect([`${moved}/hooks.json`, `${moved}/skills/hello-world/SKILL.md`].map((entry) => judged.ownStateOf(entry, sha))).toEqual([undefined, undefined]);
  });

  it('excuses nothing there for an instance found only at its declared home', async () => {
    const { home } = installWithMovableHome();
    const judged = ledgerRules(judgedInstances(await installInstances(home, { env: {}, cwd: home })));

    expect(judged.ownStateOf(`${moved}/sessions/2026/11/14/rollout.jsonl`, sha)).toBeUndefined();
    expect(judged.knownLeftover(moved)).toBeUndefined();
  });
});
