import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { skillExistsOnDisk, skillRoots } from '../usage-tracker.js';
import type { LocalConfig } from '../types.js';
import { saveToolHomes } from '../tool-home.js';

describe('a skill use counts where the tool takes skills', () => {
  let tmp: string;
  const userScope = (): LocalConfig => ({
    repo: { localPath: path.join(tmp, 'team-repo'), remote: 'https://example.test/acme/team.git' },
    username: 'tester', scope: 'user', additionalRoles: [],
  });

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-roots-'));
    vi.stubEnv('HOME', path.join(tmp, 'home'));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fse.remove(tmp); });

  it('finds a Hermes skill in HERMES_HOME', async () => {
    const hermes = path.join(tmp, 'hermes');
    vi.stubEnv('HERMES_HOME', hermes);
    await fse.outputFile(path.join(hermes, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');

    expect(await skillExistsOnDisk('deploy', await skillRoots({ config: userScope(), tool: 'hermes' }))).toBe(true);
  });

  it('finds an OpenCode skill in the home recorded for it, from a shell without XDG_CONFIG_HOME', async () => {
    const recorded = path.join(tmp, 'xdg', 'opencode');
    await fse.outputFile(path.join(recorded, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');

    await saveToolHomes({ opencode: recorded });

    expect(await skillExistsOnDisk('deploy', await skillRoots({ config: userScope(), tool: 'opencode' }))).toBe(true);
  });
});
