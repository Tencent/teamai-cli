import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearVersionCache } from '../agent-version.js';
import { buildInstructionDeliveryChecks } from '../doctor-delivery.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

/**
 * Pi reads `AGENTS.override.md` before `AGENTS.md` only from 0.84.0. An older
 * Pi reads `AGENTS.md`, which pull leaves without team blocks when the
 * override exists, so doctor names the version.
 */
const NAME = 'Pi reads the AGENTS.override.md holding the team instructions';
let home = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pi-override-')));
  fs.mkdirSync(path.join(home, 'repo'));
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', undefined);
  vi.stubEnv('PATH', `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
  clearVersionCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function installPi(version: string): void {
  const bin = path.join(home, 'bin', 'pi');
  fs.writeFileSync(bin, `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(bin, 0o755);
}

async function overrideCheck() {
  const localConfig: LocalConfig = {
    repo: { localPath: path.join(home, 'repo'), remote: 'fixture' }, username: 'test', additionalRoles: [], scope: 'user', enabledAgents: ['pi'],
  };
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'fixture' });
  const checks = await buildInstructionDeliveryChecks({
    localConfig, teamConfig, toolPaths: teamConfig.toolPaths, hookToolPaths: teamConfig.toolPaths, baseDir: home,
  });
  return checks.find((check) => check.name === NAME);
}

const posixIt = it.skipIf(process.platform === 'win32');

posixIt('fails when the override holds the team instructions and Pi is older than 0.84.0', async () => {
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.override.md'), 'Personal override.\n');
  installPi('0.73.1');

  const check = await overrideCheck();

  expect(await check?.check()).toBe(false);
  expect(check?.fix).toContain(`Pi 0.73.1 reads ${path.join(home, '.pi', 'agent', 'AGENTS.md')}`);
  expect(check?.fix).toContain('0.84.0');
  // Its `pi` command belongs to @mariozechner/pi-coding-agent, so installing the new package over it fails with EEXIST.
  expect(check?.fix).toContain('npm uninstall -g @mariozechner/pi-coding-agent && npm install -g @earendil-works/pi-coding-agent');
});

posixIt('upgrades an @earendil-works Pi older than 0.84.0 in place', async () => {
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.override.md'), 'Personal override.\n');
  installPi('0.83.0');

  const check = await overrideCheck();

  expect(await check?.check()).toBe(false);
  expect(check?.fix).toContain('Upgrade Pi (`npm install -g @earendil-works/pi-coding-agent`)');
});

posixIt('passes from Pi 0.84.0', async () => {
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.override.md'), 'Personal override.\n');
  installPi('0.84.0');

  expect(await (await overrideCheck())?.check()).toBe(true);
});

posixIt('is not asked without an override file', async () => {
  installPi('0.73.1');

  expect(await overrideCheck()).toBeUndefined();
});
