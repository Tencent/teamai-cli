import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

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

const saved = Object.fromEntries(
  ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'PATH'].map((name) => [name, process.env[name]]),
);
process.env.HOME = home;
process.env.USERPROFILE = home;
// Unset rather than pointed into the sandbox: XDG paths then follow HOME, so a
// test that sets HOME for one spawn gets that home's ~/.config as well.
delete process.env.XDG_CONFIG_HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
