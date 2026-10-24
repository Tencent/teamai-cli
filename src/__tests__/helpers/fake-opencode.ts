import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A stand-in `opencode` (V2) for the session commands teamai runs: `--version`,
 * `session list --format json`, `session export <id>`, `session delete <id>` and
 * `session import <file> --directory <dir>`, which answers the way OpenCode 2.0.29 does.
 * Sessions are export files (`{ info, messages }`, the shape `session export`
 * prints) under `$XDG_DATA_HOME/fake-opencode/sessions/<id>.json`, so a test
 * plants one by writing its export. `list` shows the sessions of the project it
 * runs in, newest first: inside a git repo (a `.git` entry above it) every
 * directory of that repo, otherwise that directory alone.
 *
 * Like the real CLI under an isolated data home, any session command without
 * `--standalone` fails: it would try to start the managed background service.
 * `$XDG_DATA_HOME/fake-opencode/version` overrides the version it prints, and
 * `$XDG_DATA_HOME/fake-opencode/export-error` makes `session export` fail with that message.
 */
const CLI = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.env.XDG_DATA_HOME || '', 'fake-opencode');
const dir = path.join(root, 'sessions');
const args = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1); };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const repoOf = (d) => fs.existsSync(path.join(d, '.git')) ? d : path.dirname(d) === d ? undefined : repoOf(path.dirname(d));
if (args[0] === '--version') {
  let version = 'opencode v2.0.29';
  try { version = fs.readFileSync(path.join(root, 'version'), 'utf8').trim(); } catch {}
  process.stdout.write(version + '\n');
  process.exit(0);
}
if (args[0] === 'serve') {
  const http = require('node:http');
  const port = Number(args[args.indexOf('--port') + 1]);
  const expected = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_SERVER_PASSWORD || '')).toString('base64');
  http.createServer((req, res) => {
    if (req.headers.authorization !== expected) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/session') { res.writeHead(404); res.end(); return; }
    const parent = url.searchParams.get('parentID');
    const infos = [];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try { infos.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).info); } catch {}
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(infos.filter((info) => parent === null || info.parentID === parent)));
  }).listen(port, args[args.indexOf('--hostname') + 1] || '127.0.0.1');
  return;
}
if (args[0] !== 'session') fail('fake opencode: unsupported command ' + args.join(' '));
if (!args.includes('--standalone')) fail('Managed service port 49374 on 127.0.0.1 is already in use by another process.');
const positional = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && ['--format', '-n', '--max-count', '--directory'].includes(args[i - 1])));
const [, sub, id] = positional;
const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const file = (sid) => path.join(dir, sid + '.json');
if (sub === 'list') {
  const cwd = real(process.cwd());
  const repo = repoOf(cwd);
  const inProject = (d) => (repo ? d === repo || d.startsWith(repo + path.sep) : d === cwd);
  const rows = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).info; } catch { continue; }
    if (!inProject(real(info.location.directory))) continue;
    rows.push({ id: info.id, title: info.title, updated: info.time.updated, created: info.time.created, projectId: info.projectID, directory: info.location.directory });
  }
  rows.sort((a, b) => b.updated - a.updated);
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
} else if (sub === 'export') {
  const exportError = path.join(root, 'export-error');
  if (fs.existsSync(exportError)) fail(fs.readFileSync(exportError, 'utf8').trim());
  if (!id.startsWith('ses')) fail('Expected a string starting with "ses"');
  if (!fs.existsSync(file(id))) fail('Session not found: ' + id);
  process.stdout.write(fs.readFileSync(file(id), 'utf8'));
} else if (sub === 'delete') {
  if (!fs.existsSync(file(id))) fail('Session not found: ' + id);
  fs.rmSync(file(id));
} else if (sub === 'import') {
  const doc = JSON.parse(fs.readFileSync(id, 'utf8'));
  const { info, messages } = doc;
  for (const key of ['projectID', 'cost', 'tokens']) if (info[key] === undefined) fail('SchemaError: Missing key\n  at ["info"]["' + key + '"]');
  if (!info.id.startsWith('ses')) fail('ID ' + info.id + ' does not start with ses');
  for (const m of messages) {
    if (!m.id.startsWith('msg_')) fail('Expected a string starting with "msg_"');
    for (const part of m.content || []) {
      if (part.type === 'tool' && !(part.time && part.time.created)) fail('SchemaError: Missing key\n  at ["content"]["time"]');
      if (part.type === 'tool' && part.state.status === 'error' && !part.state.error) fail('SchemaError: Missing key\n  at ["state"]["error"]');
    }
  }
  const directory = path.resolve(option('--directory') || process.cwd());
  if (!fs.existsSync(directory)) fail('LocationNotFoundError: Location not found: ' + directory);
  // OpenCode answers an existing id on stderr and exits 0.
  if (fs.existsSync(file(info.id))) { process.stderr.write('Session already exists\n'); process.exit(0); }
  const taken = new Set();
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try { for (const m of JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).messages) taken.add(m.id); } catch {}
  }
  if (messages.some((m) => taken.has(m.id))) fail('Failed to import session: Internal Server Error');
  // OpenCode keeps an assistant message only once it completed, and drops the rest without a word.
  const kept = messages.filter((m) => m.type !== 'assistant' || (m.time && m.time.completed));
  const stored = { info: { ...info, time: { ...info.time, updated: Date.now() }, location: { directory } }, messages: kept };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(info.id), JSON.stringify(stored, null, 2));
  process.stdout.write('Imported session: ' + info.id + '\n');
} else fail('fake opencode: unsupported command ' + args.join(' '));
`;

/** Write the fake `opencode` into a new directory and return it (put it on PATH). */
export function installFakeOpencode(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-opencode-')));
  const script = path.join(dir, 'fake-opencode.cjs');
  fs.writeFileSync(script, CLI);
  const node = JSON.stringify(process.execPath);
  fs.writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh\nexec ${node} ${JSON.stringify(script)} "$@"\n`);
  fs.chmodSync(path.join(dir, 'opencode'), 0o755);
  fs.writeFileSync(path.join(dir, 'opencode.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  return dir;
}

/** The export a real OpenCode 2.0.29 printed for a session that read a file, ran `ls`, and got an image. */
export function opencodeExportFixture(): OpencodeExport {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode', 'export-tool-calls.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OpencodeExport;
}

export type OpencodeExport = {
  info: { id: string; title: string; time: { created: number; updated: number }; location: { directory: string } } & Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
};

/** Plant a session the fake lists and exports. `raw` replaces the export file's content. */
export function plantOpencodeSession(dataHome: string, session: OpencodeExport, raw?: string): void {
  const dir = path.join(dataHome, 'fake-opencode', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.info.id}.json`), raw ?? JSON.stringify(session, null, 2));
}

/** Make the fake's `opencode session export` fail with `message`, as for a store it cannot open. */
export function setFakeOpencodeExportError(dataHome: string, message: string): void {
  fs.mkdirSync(path.join(dataHome, 'fake-opencode'), { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'fake-opencode', 'export-error'), message);
}

/** Make the fake print `version` for `opencode --version`. */
export function setFakeOpencodeVersion(dataHome: string, version: string): void {
  fs.mkdirSync(path.join(dataHome, 'fake-opencode'), { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'fake-opencode', 'version'), version);
}
