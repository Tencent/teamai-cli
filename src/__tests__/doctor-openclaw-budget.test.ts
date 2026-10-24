import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildInstructionDeliveryChecks } from '../doctor-delivery.js';
import { TeamaiConfigSchema, type LocalConfig, TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END } from '../types.js';

let home = '';
afterEach(() => { vi.unstubAllEnvs(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-budget-'));
  const state = path.join(home, '.openclaw');
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('OPENCLAW_STATE_DIR', state);
  vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(state, 'openclaw.json'));
  fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 1000 } } }));
});

const block = `${TEAMAI_CLAUDEMD_START}\nTeam instructions.\n${TEAMAI_CLAUDEMD_END}`;
async function budget(text: string, trailing = '') {
  fs.writeFileSync(path.join(home, '.openclaw', 'workspace', 'AGENTS.md'), text + block + trailing);
  const localConfig: LocalConfig = { repo: { localPath: path.join(home, 'repo'), remote: 'fixture' }, username: 'test', additionalRoles: [], scope: 'user', enabledAgents: ['openclaw'] };
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'fixture' });
  const checks = await buildInstructionDeliveryChecks({ teamConfig, localConfig } as never);
  const budget = checks.find(check => check.name === 'OpenClaw AGENTS.md fits the default bootstrap read budget');
  return budget;
}

function configure(defaults: Record<string, unknown>) {
  fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults } }));
}
it('checks member text as well as the managed block', async () => {
  expect(await (await budget('x'.repeat(1000)))!.check()).toBe(false);
});
it('counts UTF-16 units, ignores trailing whitespace and accepts the exact cap', async () => {
  const text = '😀'.repeat(200);
  configure({ bootstrapMaxChars: (text + block).length });
  expect(await (await budget(text, '\n  '))!.check()).toBe(true);
  expect(await (await budget(text + 'x'))!.check()).toBe(false);
});
it('honors the total cap and skips a file with less than 64 characters left', async () => {
  configure({ bootstrapMaxChars: 10000, bootstrapTotalMaxChars: 100 });
  expect(await (await budget('x'.repeat(100)))!.check()).toBe(false);
  configure({ bootstrapTotalMaxChars: 63 });
  expect(await (await budget(''))!.check()).toBe(false);
});
it('uses the upstream defaults for missing or invalid numeric limits', async () => {
  configure({ bootstrapMaxChars: -1, bootstrapTotalMaxChars: '100' });
  expect(await (await budget('x'.repeat(19000)))!.check()).toBe(true);
  expect(await (await budget('x'.repeat(20000)))!.check()).toBe(false);
});
it('reads the config-path override', async () => {
  const config = path.join(home, 'custom.json');
  fs.writeFileSync(config, JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 100 } } }));
  vi.stubEnv('OPENCLAW_CONFIG_PATH', config);
  expect(await (await budget('x'.repeat(100)))!.check()).toBe(false);
});

it('does not add a budget check to an unmanaged file', async () => {
  await budget('');
  fs.writeFileSync(path.join(home, '.openclaw', 'workspace', 'AGENTS.md'), 'personal instructions');
  const localConfig: LocalConfig = { repo: { localPath: path.join(home, 'repo'), remote: 'fixture' }, username: 'test', additionalRoles: [], scope: 'user', enabledAgents: ['openclaw'] };
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'fixture' });
  const checks = await buildInstructionDeliveryChecks({ teamConfig, localConfig } as never);
  expect(checks.some(check => check.name === 'OpenClaw AGENTS.md fits the default bootstrap read budget')).toBe(false);
});
