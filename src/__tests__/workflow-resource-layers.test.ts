import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveDriver, type ResolvedDriver } from '../workflow/runtimes/definitions.js';
import { locateRuntime } from '../workflow/runtimes/locate.js';
import { locateSandboxProfile } from '../workflow/runtimes/sandbox-profiles.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';

/**
 * A driver's resources (drivers, runtimes, sandbox profiles) are each found by one walk over the member's own folder,
 * the team repo and teamai's package: what holds for one kind holds for every one.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const kind of ['drivers', 'runtimes', 'sandboxes']) fs.rmSync(path.join(getTeamaiHomeDir(), kind), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

/** A user-scope config whose team repo holds `files`, beside a driver `acme` that runs the sandbox. */
function teamWith(files: Record<string, string>): LocalConfig {
  const team = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-resource-layers-')));
  dirs.push(team);
  write(team, { 'drivers/acme.yaml': 'schemaVersion: v1alpha1\nname: acme\nruntimes:\n  - use: sandbox\n', ...files });

  return { repo: { localPath: team, remote: 'origin', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [] };
}

async function acme(config: LocalConfig): Promise<ResolvedDriver> {
  const resolved = await resolveDriver(config, 'acme', { personal: true });
  if (!resolved.ok) throw new Error(resolved.failure.message);

  return resolved.driver;
}

/** Each kind, by a name teamai ships as teamai-<name>, so a lookup that passes over a broken folder finds teamai's. */
const KINDS = [
  { dir: 'drivers', marker: 'DRIVER.yaml', asked: 'claude', find: async (config: LocalConfig) => resolveDriver(config, 'claude', { personal: true }) },
  { dir: 'runtimes', marker: 'RUNTIME.yaml', asked: 'sandbox', find: async (config: LocalConfig) => locateRuntime(await acme(config), 'sandbox') },
  { dir: 'sandboxes', marker: 'SANDBOX.yaml', asked: 'default', find: async (config: LocalConfig) => locateSandboxProfile(await acme(config), 'default') },
] as const;

for (const { dir, marker, asked, find } of KINDS) {
  it(`refuses a team folder ${dir}/${asked}/ whose ${marker} is misspelt, rather than reading it as a namespace and running teamai's teamai-${asked}`, async () => {
    const found = await find(teamWith({ [`${dir}/${asked}/${marker.replace('.yaml', '.yml')}`]: 'provider: docker\n' }));

    expect(found).toMatchObject({ ok: false, failure: { message: expect.stringContaining(`${dir}/${asked}/`) } });
    expect(found).toMatchObject({ failure: { message: expect.stringContaining(`holds no ${marker}`) } });
  });

  it(`refuses the member's own folder ${dir}/${asked}/ whose ${marker} is misspelt, rather than passing over it to teamai's teamai-${asked}`, async () => {
    write(getTeamaiHomeDir(), { [`${dir}/${asked}/${marker.replace('.yaml', '.yml')}`]: 'provider: docker\n' });

    const found = await find(teamWith({}));

    expect(found).toMatchObject({ ok: false, failure: { message: expect.stringContaining(`${path.join(getTeamaiHomeDir(), dir, asked)}${path.sep}`) } });
    expect(found).toMatchObject({ failure: { message: expect.stringContaining(`holds no ${marker}`) } });
  });

  it(`refuses a team folder ${dir}/${asked}/ that is a link, rather than passing over it to teamai's teamai-${asked}`, async () => {
    const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-resource-layers-elsewhere-')));
    dirs.push(elsewhere);
    write(elsewhere, { [marker]: 'provider: docker\n' });
    const config = teamWith({});
    fs.mkdirSync(path.join(config.repo.localPath, dir), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(config.repo.localPath, dir, asked), 'dir');

    const found = await find(config);

    expect(found).toMatchObject({ ok: false, failure: { message: expect.stringContaining(`${dir}/${asked} in the team repo is a link`) } });
  });

  it(`refuses a team folder ${dir}/${asked}/ that holds a link, rather than passing over it to teamai's teamai-${asked}`, async () => {
    const config = teamWith({ [`${dir}/${asked}/${marker}`]: 'provider: docker\n' });
    fs.symlinkSync(path.join(os.tmpdir(), 'anywhere'), path.join(config.repo.localPath, dir, asked, 'extra'));

    const found = await find(config);

    expect(found).toMatchObject({ ok: false, failure: { message: expect.stringContaining('the link extra') } });
  });
}
