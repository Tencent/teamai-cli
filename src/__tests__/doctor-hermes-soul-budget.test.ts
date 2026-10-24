import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildInstructionDeliveryChecks } from '../doctor-delivery.js';
import { TeamaiConfigSchema, type LocalConfig, TEAMAI_RULES_START, TEAMAI_RULES_END } from '../types.js';

let home = '';
afterEach(() => { vi.unstubAllEnvs(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-budget-'));
  const hermes = path.join(home, '.hermes');
  fs.mkdirSync(hermes);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('HERMES_HOME', hermes);
  fs.writeFileSync(path.join(hermes, 'config.yaml'), 'context_file_max_chars: 20000\n');

});

const block = `${TEAMAI_RULES_START}\nTeam rule.\n${TEAMAI_RULES_END}`;
async function budget(text: string, trailing = '') {
  fs.writeFileSync(path.join(home, '.hermes', 'SOUL.md'), text + block + trailing);
  const localConfig: LocalConfig = { repo: { localPath: path.join(home, 'repo'), remote: 'fixture' }, username: 'test', additionalRoles: [], scope: 'user', enabledAgents: ['hermes'] };
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'fixture' });
  const checks = await buildInstructionDeliveryChecks({ teamConfig, localConfig } as never);
  const budget = checks.find(check => check.name === 'Hermes SOUL.md fits the context-file read budget');
  return budget;
}

it('checks member text as well as the managed block', async () => {
  const check = await budget('x'.repeat(20000));
  expect(await check!.check()).toBe(false);
  expect(check!.informational).toBe(false);
  expect(check!.fix).toContain('context_file_max_chars');
});
it('uses Python code points and strips surrounding whitespace at the exact boundary', async () => {
  const text = '😀'.repeat(400);
  fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), `context_file_max_chars: ${Array.from(text + block).length}\n`);
  expect(await (await budget(text, '\n   '))!.check()).toBe(true);
  expect(await (await budget(text + 'x'))!.check()).toBe(false);
});
it('matches Python strip for C0 and NEL whitespace, but keeps BOM', async () => {
  fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), `context_file_max_chars: ${Array.from(block).length}\n`);
  expect(await (await budget('\u0085\u001c\u001f', '\u0085\u001c\u001f'))!.check()).toBe(true);
  expect(await (await budget('\ufeff'))!.check()).toBe(false);
});
it('warns informationally about the model-dependent default floor', async () => {
  fs.rmSync(path.join(home, '.hermes', 'config.yaml'));
  const check = await budget('x'.repeat(20000));
  expect(await check!.check()).toBe(false);
  expect(check!.informational).toBe(true);
  expect(check!.fix).toContain('selected model');
});
it('does not claim a known budget when YAML is malformed', async () => {
  fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), 'broken: [');
  const check = await budget('');
  expect(await check!.check()).toBe(false);
  expect(check!.informational).toBe(false);
});

it('does not add a budget check to an unmanaged file', async () => {
  await budget('');
  fs.writeFileSync(path.join(home, '.hermes', 'SOUL.md'), 'personal instructions');
  const localConfig: LocalConfig = { repo: { localPath: path.join(home, 'repo'), remote: 'fixture' }, username: 'test', additionalRoles: [], scope: 'user', enabledAgents: ['hermes'] };
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'fixture' });
  const checks = await buildInstructionDeliveryChecks({ teamConfig, localConfig } as never);
  expect(checks.some(check => check.name === 'Hermes SOUL.md fits the context-file read budget')).toBe(false);
});
