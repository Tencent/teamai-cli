import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectInstalledAgents } from '../known-agents.js';
import { installOf, locate, ownOf } from '../locate.js';
import type { Host } from '../tool-home.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

function linuxHost(env: Record<string, string>, existing: readonly string[]): Host {
  return {
    platform: 'linux', path: path.posix, home: '/home/m', profileHome: '/home/m', env, toolHomes: { kind: 'missing' }, cwd: () => '/home/m',
    exists: async (file) => existing.includes(file), readJson: async () => ({ kind: 'missing' }),
    realpath: async (file) => file, readText: async () => null, existsNow: () => false, readTextNow: () => null, userToolRoots: async () => undefined,
  };
}

const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'r' });
const localConfig: LocalConfig = {
  repo: { localPath: '/home/m/team', remote: 'https://example.test/acme/team.git' },
  username: 'tester', scope: 'user', additionalRoles: [],
};

describe('skill list and status under a moved home', () => {
  it.each([
    ['muse', { XDG_CONFIG_HOME: '/xdg' }, '/xdg/muse'],
    ['pi', { PI_CODING_AGENT_DIR: '/agents/pi' }, '/agents/pi'],
  ])('read %s skills where pull writes them', async (tool, env, home) => {
    const host = linuxHost(env, [home]);
    const pulled = ownOf(await locate(tool, 'skills', installOf(teamConfig, localConfig), host));

    const agent = (await detectInstalledAgents(localConfig, teamConfig, host))
      .find((candidate) => candidate.id === tool);

    expect(agent).toMatchObject({ absoluteSkillsPath: pulled?.path, installed: true });
  });
});
