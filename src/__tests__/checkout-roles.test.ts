/**
 * The team role a workflow copy runs with is recorded in the data home, beside the copy's install, and applied whenever
 * that copy's config is read, so every pull and hook in the copy delivers for that role.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearCheckoutRole, recordCheckoutRole, withCheckoutRole } from '../checkout-roles.js';
import { readConfigFrom, refreshRoleAssignment, saveLocalConfigForScope } from '../config.js';
import { getCheckoutRolesPath, type LocalConfig } from '../types.js';
import { withFileLock } from '../update.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-checkout-roles-')));
  dirs.push(dir);
  return dir;
}

/** The project config of `checkout`, whose data home is `dataHome`. */
function configOf(dataHome: string, checkout: string): LocalConfig {
  return { repo: { localPath: path.join(dataHome, 'team-repo'), remote: 'local' }, username: 'member', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome };
}

describe('the role a copy runs with', () => {
  it('keeps every role that writers record at once, each for its own copy', async () => {
    const dataHome = tmp();
    const copies = Array.from({ length: 8 }, () => tmp());

    const recorded = await Promise.all(copies.map((copy, index) => recordCheckoutRole({ config: configOf(dataHome, copy), checkout: copy, role: `role-${index}` })));
    const applied = await Promise.all(copies.map((copy) => withCheckoutRole(configOf(dataHome, copy))));

    expect(recorded.every((outcome) => outcome.kind === 'recorded')).toBe(true);
    expect(applied.map((config) => config.stepRole)).toEqual(copies.map((_, index) => `role-${index}`));
  });
  it('records nothing, and names the lock, while another writer holds the file past the wait', async () => {
    const dataHome = tmp();
    const copy = tmp();
    const config = configOf(dataHome, copy);
    const lock = `${getCheckoutRolesPath(config)}.lock`;

    const recorded = await withFileLock(lock, { attempts: 1, delayMs: 0 }, () => recordCheckoutRole({ config, checkout: copy, role: 'review' }));

    expect(recorded).toEqual({ held: true, value: { kind: 'busy', lock } });
    expect((await withCheckoutRole(config)).stepRole).toBeUndefined();
  }, 15_000);

  it('drops the role of a copy that no longer exists at its next write, so a copy made later at that path runs with none', async () => {
    const dataHome = tmp();
    const [abandoned, kept, next] = [tmp(), tmp(), tmp()];
    const record = (copy: string, role: string) => recordCheckoutRole({ config: configOf(dataHome, copy), checkout: copy, role });
    await record(abandoned, 'review');
    await record(kept, 'frontend');
    fs.rmSync(abandoned, { recursive: true });

    await record(next, 'review');
    fs.mkdirSync(abandoned);
    const remade = await withCheckoutRole(configOf(dataHome, abandoned));
    fs.rmSync(next, { recursive: true });
    await clearCheckoutRole({ config: configOf(dataHome, kept), checkout: kept });

    expect(remade.stepRole).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(getCheckoutRolesPath(configOf(dataHome, kept)), 'utf8'))).toEqual({});
  });

  it('leaves a role file it cannot read as it is, and names it', async () => {
    const dataHome = tmp();
    const copy = tmp();
    const config = configOf(dataHome, copy);
    const file = getCheckoutRolesPath(config);
    fs.writeFileSync(file, '{ not json');

    const recorded = await recordCheckoutRole({ config, checkout: copy, role: 'review' });

    expect(recorded).toMatchObject({ kind: 'unreadable', file });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });
});

describe('a copy config, loaded, refreshed and saved', () => {
  /** A project data home whose config governs `checkout`, a copy recorded to run with the review role. */
  async function copyInstall(): Promise<{ dataHome: string; checkout: string }> {
    const dataHome = tmp();
    const checkout = tmp();
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), `repo:\n  localPath: ${path.join(dataHome, 'team-repo')}\n  remote: local\nusername: member\nscope: workspace\nprimaryRole: frontend\nadditionalRoles: []\nprojectRoot: ${checkout}\n`);
    await recordCheckoutRole({ config: configOf(dataHome, checkout), checkout, role: 'review' });
    return { dataHome, checkout };
  }

  it('loads with the role recorded for the copy, beside the member role', async () => {
    const { dataHome, checkout } = await copyInstall();

    const loaded = await readConfigFrom(dataHome, checkout);

    expect(loaded).toMatchObject({ primaryRole: 'frontend', stepRole: 'review' });
  });

  it('runs with no role once a refresh finds the copy released', async () => {
    const { dataHome, checkout } = await copyInstall();
    const loaded = await readConfigFrom(dataHome, checkout);
    if (!loaded) throw new Error('no config loaded');

    // A clone's role goes with the clone, and the data home its install had.
    fs.rmSync(getCheckoutRolesPath(loaded));
    await refreshRoleAssignment(loaded);

    expect(loaded.primaryRole).toBe('frontend');
    expect(loaded).not.toHaveProperty('stepRole');
  });

  it('saves the config every checkout shares without the role of the copy it was loaded for', async () => {
    const { dataHome, checkout } = await copyInstall();
    const loaded = await readConfigFrom(dataHome, checkout);
    if (!loaded) throw new Error('no config loaded');

    await saveLocalConfigForScope(loaded);

    expect(loaded.stepRole).toBe('review');
    expect(fs.readFileSync(path.join(dataHome, 'config.yaml'), 'utf8')).not.toContain('review');
  });
});
