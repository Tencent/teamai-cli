import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it.each(['environment', 'recorded'] as const)('switches and restores Muse models in its %s home through the CLI', (source) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-muse-home-')));
  const home = path.join(root, 'home');
  const moved = path.join(root, 'xdg', 'muse');
  const settings = path.join(moved, 'settings.json');
  const normal = path.join(home, '.config', 'muse', 'settings.json');
  const original = { schema_version: 1, model: 'personal', hooks: { Stop: [] } };
  fs.mkdirSync(moved, { recursive: true });
  fs.mkdirSync(path.dirname(normal), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(original));
  fs.writeFileSync(normal, JSON.stringify({ schema_version: 1, model: 'default-personal' }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    XDG_CONFIG_HOME: source === 'environment' ? path.dirname(moved) : '',
    TEAMAI_MUSE_TEST_KEY: 'fixture-model-key', ZDOTDIR: home };
  if (source === 'recorded') {
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'tool-homes.json'), JSON.stringify({ muse: moved }));
  }
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    cli('models', 'add', 'fixture', '--name', 'Fixture', '--protocol', 'openai-responses',
      '--base-url', 'https://gateway.example.test', '--model', 'team-model', '--from-env', 'TEAMAI_MUSE_TEST_KEY');
    expect(cli('models', 'switch', 'local:fixture', '--agent', 'muse')).toContain('muse switched');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toMatchObject({ model: 'team-model', hooks: original.hooks });
    expect(JSON.parse(fs.readFileSync(normal, 'utf8')).model).toBe('default-personal');
    expect(cli('models', 'restore', '--agent', 'muse')).toContain('restored');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(original);
    expect(JSON.parse(fs.readFileSync(normal, 'utf8')).model).toBe('default-personal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
