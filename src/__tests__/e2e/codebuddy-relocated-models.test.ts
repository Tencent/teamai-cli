import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
it.each(['env', 'recorded'])('switches and restores CodeBuddy models at the %s home through the built CLI', mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cb-models-e2e-'));
  const home = path.join(root, 'home');
  const moved = path.join(root, 'moved-codebuddy');
  const file = path.join(moved, 'models.json');
  fs.mkdirSync(moved);
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  const personal = { models: [{ id: 'personal', name: 'Mine' }] };
  fs.writeFileSync(file, JSON.stringify(personal));
  if (mode === 'recorded') fs.writeFileSync(path.join(home, '.teamai/tool-homes.json'), JSON.stringify({ codebuddy: moved }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEBUDDY_CONFIG_DIR: mode === 'env' ? moved : '', TEAMAI_E2E_KEY: 'test-key', FORCE_COLOR: '0' };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    cli('models', 'add', 'fixture', '--name', 'Fixture', '--protocol', 'openai-chat-completions', '--base-url', 'https://example.test', '--model', 'team-model', '--from-env', 'TEAMAI_E2E_KEY');
    expect(cli('models', 'switch', 'local:fixture', '--agent', 'codebuddy')).toContain('codebuddy switched');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).models.map((m: { id: string }) => m.id)).toEqual(['personal', 'team-model']);
    expect(fs.existsSync(path.join(home, '.codebuddy/models.json'))).toBe(false);
    expect(cli('models', 'restore', '--agent', 'codebuddy')).toContain('restored');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(personal);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
