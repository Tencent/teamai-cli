import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { installFakeOpencode } from '@teamai/tool-opencode/testing';

// E2E fixtures run `git`, and the git hooks teamai installs run
// `PATH="$HOME/.teamai/bin:$PATH" teamai hook-dispatch ...`. With the real HOME
// and PATH, a fixture's `git merge` or `checkout` ran the developer's installed
// teamai against the real ~/.teamai (and rewrote ~/.teamai/bin/teamai); in CI no
// teamai is installed, so the same test behaved differently. Give every test
// file, and everything it spawns, a sandboxed HOME and a `teamai` on PATH that
// runs the dist under test. A test that sets HOME itself still wins.
// Long path, like other temp roots (#870): Windows can hand out a short 8.3
// tmpdir that paths resolved later would not match.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-e2e-')));
const home = path.join(sandbox, 'home');
const bin = path.join(sandbox, 'bin');
fs.mkdirSync(home);
fs.mkdirSync(bin);

// The real ~/.gitconfig is out of reach now, so fixture commits need an
// identity. Background upkeep is off as well: a fixture commit or push under
// the defaults leaves a detached `git gc --auto` writing into `.git/objects/`
// after the test returns, which made teardowns fail with ENOTEMPTY on CI
// (#1413) — retries around rmSync did not keep up under parallel load.
fs.writeFileSync(
  path.join(home, '.gitconfig'),
  '[user]\n\tname = TeamAI E2E\n\temail = e2e@teamai.test\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');

const cli = path.join(ROOT, 'dist', 'index.js');
fs.writeFileSync(path.join(bin, 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
fs.chmodSync(path.join(bin, 'teamai'), 0o755);
fs.writeFileSync(path.join(bin, 'teamai.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);

// OpenCode's version decides how teamai delivers to it and launches it, and the first `opencode` on PATH was the
// machine's, or under `npm run` the opencode-ai devDependency (V1), so a case passed or failed by how the suite was
// started. Every file meets a stand-in V2 first instead, `opencode v2.0.29` as CI installs, which answers `--version`
// and the session commands as OpenCode 2 does, and fails any other. A case that means another version, or the real
// binary, puts its own first.
const opencode = installFakeOpencode();

// The temporary directory too, as isolate-home gives unit tests theirs: no
// other file then works in it, so a skill runner left working there fails the
// test that left it (teardown-writers.ts). Beside the sandbox rather than in
// it, under a short name: a step runtime's attempt socket sits under it, and
// macOS holds a unix socket path of at most 103 bytes. A process that must
// outlive the teardown, as a detached hook pass does on Windows, works in the
// directory this one sits in (hook-shells-windows.test.ts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));

const XDG = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
const saved = Object.fromEntries(
  ['HOME', 'USERPROFILE', ...XDG, 'GIT_CONFIG_NOSYSTEM', 'PATH', 'TMPDIR', 'TMP', 'TEMP'].map((name) => [name, process.env[name]]),
);
process.env.HOME = home;
process.env.USERPROFILE = home;
// Unset rather than pointed into the sandbox: XDG paths then follow HOME, so a
// test that sets HOME for one spawn gets that home's ~/.config as well, and no
// OpenCode, real or the stand-in, reads or writes the developer's data.
for (const name of XDG) delete process.env[name];
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.PATH = [bin, opencode, process.env.PATH ?? ''].join(path.delimiter);
process.env.TMPDIR = tmp;
process.env.TMP = tmp;
process.env.TEMP = tmp;

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(opencode, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});
