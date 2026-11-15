import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { paseoApp } from '../testing/asar.js';
import { TEST_CLIENT } from '../testing/harness.js';
import { dir, start, ready, useRuntimeSuite } from '../testing/suite.js';
import { entriesUnder } from '@teamai/shared/entries-under';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it('fails init, saying how to install Paseo or point at its client, when no Paseo client can be found', async () => {
    const empty = path.join(dir, 'no-client');
    fs.mkdirSync(empty);

    expect(await ready(start({ PASEO_CLIENT_PATH: empty }))).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'client_missing',
        message: `teamai-runtime-paseo found no Paseo client in ${empty}, which PASEO_CLIENT_PATH names. Install the Paseo CLI from the Paseo desktop app's settings, or with npm install -g @getpaseo/cli, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.`,
      },
    });
    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath) }))).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'client_missing',
        message: 'teamai-runtime-paseo found no `paseo` on PATH, or in ~/.local/bin where the Paseo desktop app installs its CLI, to load the Paseo client from. Install the Paseo CLI from the Paseo desktop app\'s settings, or with npm install -g @getpaseo/cli, or set PASEO_CLIENT_PATH to the directory of its @getpaseo/client package.',
      },
    });
  });

  it('fails init on a client older than the Paseo it runs against', async () => {
    const old = path.join(dir, 'old-client');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: '@getpaseo/client', version: '0.13.2' }));

    expect(await ready(start({ PASEO_CLIENT_PATH: old }))).toEqual({
      type: 'init', ok: false,
      error: { code: 'client_version', message: `The Paseo client in ${old} is version 0.13.2; teamai-runtime-paseo needs Paseo 0.14.0 or later. Update Paseo, or set PASEO_CLIENT_PATH to a newer @getpaseo/client package.` },
    });
  });

  it('runs on the client of the paseo on PATH, found through the links an install makes', async () => {
    // As npm installs it: bin/paseo links into the CLI package, whose node_modules holds the client.
    const cli = path.join(dir, 'lib', 'node_modules', '@getpaseo', 'cli');
    fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(cli, 'node_modules', '@getpaseo'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@getpaseo/cli', version: '0.14.0' }));
    fs.writeFileSync(path.join(cli, 'bin', 'paseo'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(TEST_CLIENT, path.join(cli, 'node_modules', '@getpaseo', 'client'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.symlinkSync(path.join(cli, 'bin', 'paseo'), path.join(dir, 'bin', 'paseo'));

    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: [path.join(dir, 'bin'), path.dirname(process.execPath)].join(path.delimiter) }))).toMatchObject({ type: 'init', ok: true });
  });

  it('runs on the client inside the Paseo app, through the CLI its install-CLI action links into ~/.local/bin, though no paseo is on PATH', async () => {
    const cli = paseoApp(path.join(dir, 'app'), TEST_CLIENT);
    fs.mkdirSync(path.join(dir, 'home', '.local', 'bin'), { recursive: true });
    fs.symlinkSync(cli, path.join(dir, 'home', '.local', 'bin', 'paseo'));
    const env = { PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath) };

    expect(await ready(start(env))).toMatchObject({ type: 'init', ok: true });
    // Once unpacked, the client is loaded again from where it was kept, as a second runtime does.
    expect(await ready(start(env))).toMatchObject({ type: 'init', ok: true });
  });

  it('answers a check on the client inside the Paseo app, and leaves teamai\'s state and the temp directory as they were', async () => {
    const cli = paseoApp(path.join(dir, 'app'), TEST_CLIENT);
    fs.mkdirSync(path.join(dir, 'home', '.local', 'bin'), { recursive: true });
    fs.symlinkSync(cli, path.join(dir, 'home', '.local', 'bin', 'paseo'));
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const state = path.join(dir, 'home', '.teamai');
    fs.mkdirSync(path.join(state, 'runtime-state'), { recursive: true });
    fs.writeFileSync(path.join(state, 'config.json'), '{}');

    /** Every file and directory under `root`, with each file's bytes. */
    const tree = (root: string): Record<string, string> => Object.fromEntries(entriesUnder(root)
      .map(({ entry }) => {
        const at = path.join(entry.parentPath, entry.name);

        return [path.relative(root, at), entry.isFile() ? fs.readFileSync(at, 'base64') : 'directory'];
      }));

    const before = tree(state);

    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath), TMPDIR: tmp }), { mode: 'check' })).toMatchObject({ type: 'init', ok: true, prompt: true });
    expect(tree(state)).toEqual(before);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('fails init naming the file, rather than load it, when a file of the client in the Paseo app does not match the app\'s own hash', async () => {
    const cli = paseoApp(path.join(dir, 'app'), TEST_CLIENT, 'node_modules/ws/package.json');
    fs.mkdirSync(path.join(dir, 'home', '.local', 'bin'), { recursive: true });
    fs.symlinkSync(cli, path.join(dir, 'home', '.local', 'bin', 'paseo'));
    const app = fs.realpathSync(path.join(dir, 'app', 'Paseo.app'));

    expect(await ready(start({ PASEO_CLIENT_PATH: undefined, PATH: path.dirname(process.execPath) }))).toEqual({
      type: 'init', ok: false,
      error: {
        code: 'client_missing',
        message: `teamai-runtime-paseo could not unpack the Paseo client from the Paseo app at ${app}: node_modules/ws/package.json does not match the SHA-256 the app records for it. Reinstall the Paseo app, or install the Paseo CLI (npm install -g @getpaseo/cli) so \`paseo\` is on PATH.`,
      },
    });
  });
});
