/**
 * Whether OpenCode gets a project's team content only through teamai's plugin (#915): on OpenCode V2, with the plugin
 * as this build writes it, and `sharing.gitExclude` on. The OpenCode version is mocked where it is read, so the
 * member's own OpenCode never answers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const version = vi.hoisted(() => ({ major: 2 }));

vi.mock('../opencode-version.js', () => ({ opencodeMajorVersion: async () => version.major }));

import { buildPluginSource, opencodeContextPlugin, opencodeDeliversThroughPlugin } from '../opencode-hooks.js';
import { resolveCliEntry } from '../builtin-hooks.js';
import { LocalConfigSchema, TeamaiConfigSchema } from '../types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-oc-plugin-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const team = TeamaiConfigSchema.parse({ team: 'acme', repo: 'acme/team', sharing: { gitExclude: { enabled: true } } });
const local = () => LocalConfigSchema.parse({ repo: { localPath: path.join(home, 'team'), remote: 'https://example.com/acme/team.git' }, username: 'member', scope: 'project', projectRoot: path.join(home, 'project') });

async function installPlugin(): Promise<void> {
  const { file } = await opencodeContextPlugin();
  const entry = resolveCliEntry();
  if (entry === null) throw new Error('no CLI entry to write the plugin for');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildPluginSource(undefined, entry));
}

describe('OpenCode delivery through teamai\'s plugin', () => {
  it('delivers through the plugin on OpenCode V2 with the plugin this build writes', async () => {
    version.major = 2;
    await installPlugin();

    expect(await opencodeDeliversThroughPlugin(team, local())).toBe(true);
  });

  it('does not on OpenCode V1, which reads the team rules from opencode.json', async () => {
    version.major = 1;
    await installPlugin();

    expect(await opencodeDeliversThroughPlugin(team, local())).toBe(false);
  });

  it('does not without the plugin, whatever OpenCode runs', async () => {
    version.major = 2;

    expect(await opencodeDeliversThroughPlugin(team, local())).toBe(false);
  });
});
