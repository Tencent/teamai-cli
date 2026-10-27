import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelReadiness } from '../instruction-targets.js';
import { buildPiExtensionSource, PI_HOOK_FILE } from '../pi-hooks.js';
import { hookAdapterDir } from '../locate.js';
import { buildPluginSource, opencodeContextPlugin, resolveOpencodePluginDir, OPENCODE_HOOK_FILE } from '../opencode-hooks.js';

let home: string;
let entry: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-launcher-check-'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('OPENCODE_CONFIG_DIR', ''); vi.stubEnv('XDG_CONFIG_HOME', '');
  entry = path.join(home, 'other install.mjs');
  fs.writeFileSync(entry, '// CLI entry in another installation');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });
it('accepts a Pi extension installed by another live CLI entry, but not a missing entry or altered handler', async () => {
  const file = path.join(hookAdapterDir('pi-extension'), PI_HOOK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const source = buildPiExtensionSource(entry);
  fs.writeFileSync(file, source);
  expect((await channelReadiness('pi', 'pi-extension')).ready).toBe(true);
  fs.writeFileSync(file, source + '\nthrow new Error("edited");');
  expect((await channelReadiness('pi', 'pi-extension')).ready).toBe(false);
  fs.writeFileSync(file, source);
  fs.unlinkSync(entry);
  expect((await channelReadiness('pi', 'pi-extension')).ready).toBe(false);
});
it('accepts an OpenCode plugin installed by another live CLI entry', async () => {
  const file = path.join(resolveOpencodePluginDir(home, 'user'), OPENCODE_HOOK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildPluginSource(undefined, entry));
  expect((await opencodeContextPlugin()).ready).toBe(true);
  fs.unlinkSync(entry);
  expect((await opencodeContextPlugin()).ready).toBe(false);
});

it.each(['bun', 'hermes'])('recognizes %s launcher metadata without ignoring handler changes', async kind => {
  const { hookSourceMatches } = await import('../utils/hook-source.js');
  const launcher = JSON.stringify([process.execPath, entry]);
  const current = JSON.stringify([process.execPath, process.argv[1]]);
  const source = (value: string) => kind === 'bun' ? `const launcher = ${value};\nhandler();`
    : `${value.slice(0, -1)}, "hook-dispatch", "instructions", "--tool", "hermes"]`;
  expect(await hookSourceMatches(source(launcher), source(current))).toBe(true);
  expect(await hookSourceMatches(source(launcher) + '\nchanged();', source(current))).toBe(false);
  fs.unlinkSync(entry);
  expect(await hookSourceMatches(source(launcher), source(current))).toBe(false);
});
