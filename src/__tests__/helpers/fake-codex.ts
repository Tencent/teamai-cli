import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in `codex` whose `app-server` speaks the JSON-RPC subset teamai uses
 * (initialize, hooks/list, config/read, config/batchWrite), with its state in
 * `$CODEX_HOME/fake-state.json`. Hooks are listed from `$CODEX_HOME/hooks.json`
 * (the user layer) and from `<project>/.codex/hooks.json` for each trusted
 * project that is the cwd or one of its parents, or that `$CODEX_HOME/fake.json`
 * maps the cwd to (`projectLayers`, how Codex reads a linked worktree from its
 * main checkout). A hook's hash is its handler's JSON, so editing it reads as
 * `modified`, as in Codex. `fake.json` can also make one method fail
 * (`failMethod`), the process exit at once (`exit`), or the listing name a hook
 * by its `commandWindows` where it has one (`windowsCommands`), as Codex on
 * Windows does.
 */
const SERVER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const home = process.env.CODEX_HOME;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const opts = read(path.join(home, 'fake.json'), {});
if (opts.exit) process.exit(1);
const statePath = path.join(home, 'fake-state.json');
const state = () => read(statePath, { projects: {}, hooksState: {}, calls: [] });
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const snake = (e) => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
function layer(file, source, s, out) {
  const json = read(file, null);
  if (!json || !json.hooks) return;
  const src = real(file);
  for (const [event, groups] of Object.entries(json.hooks)) {
    (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
      if ((opts.omitCommands || []).includes(h.command)) return;
      const key = src + ':' + snake(event) + ':' + gi + ':' + hi;
      const currentHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(h)).digest('hex');
      const trusted = s.hooksState[key] && s.hooksState[key].trusted_hash;
      const trustStatus = !trusted ? 'untrusted' : trusted === currentHash ? 'trusted' : 'modified';
      const command = opts.windowsCommands && h.commandWindows ? h.commandWindows : h.command;
      out.push({ key, command, sourcePath: src, source, currentHash, trustStatus });
    }));
  }
}
function list(cwd, s) {
  const out = [];
  layer(path.join(home, 'hooks.json'), 'user', s, out);
  const c = real(cwd);
  const mapped = (opts.projectLayers || {})[c];
  const projects = mapped ? (fs.existsSync(path.join(c, '.codex')) ? [real(mapped)] : []) : Object.keys(s.projects).filter((p) => c === p || c.startsWith(p + path.sep));
  for (const p of projects) {
    if ((s.projects[p] || {}).trust_level !== 'trusted') continue;
    layer(path.join(p, '.codex', 'hooks.json'), 'project', s, out);
  }
  return out;
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const s = state();
    s.pid = process.pid;
    s.calls.push({ method: m.method, params: m.params });
    save(s);
    if (m.id === undefined) continue;
    const reply = (body) => process.stdout.write(JSON.stringify({ id: m.id, ...body }) + '\n');
    if (opts.failMethod === m.method) { reply({ error: { code: -32000, message: 'fake failure' } }); continue; }
    if (m.method === 'initialize') reply({ result: { userAgent: 'fake' } });
    else if (m.method === 'hooks/list') reply({ result: { data: m.params.cwds.map((cwd) => ({ cwd, hooks: list(cwd, s), warnings: [] })) } });
    else if (m.method === 'config/read') reply({ result: { config: { projects: s.projects } } });
    else if (m.method === 'config/batchWrite') {
      for (const e of m.params.edits) {
        if (e.keyPath === 'projects') Object.assign(s.projects, e.value);
        else if (e.keyPath.startsWith('projects.') && e.value === null) delete s.projects[JSON.parse(e.keyPath.slice('projects.'.length))];
        else if (e.keyPath === 'hooks.state') for (const [k, v] of Object.entries(e.value)) s.hooksState[k] = { ...(s.hooksState[k] || {}), ...v };
      }
      save(s);
      reply({ result: { status: 'ok' } });
    } else reply({ error: { code: -32600, message: 'unknown method ' + m.method } });
  }
});
`;

export interface FakeCodexState {
  pid?: number;
  projects: Record<string, { trust_level?: string }>;
  hooksState: Record<string, { trusted_hash?: string }>;
  calls: Array<{ method: string; params: unknown }>;
}

/** Write the fake `codex` into a new directory and return it (prepend it to PATH). */
export function installFakeCodex(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-codex-')));
  const script = path.join(dir, 'fake-codex.cjs');
  fs.writeFileSync(script, SERVER);
  const node = JSON.stringify(process.execPath);
  fs.writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\nexec ${node} ${JSON.stringify(script)} "$@"\n`);
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  fs.writeFileSync(path.join(dir, 'codex.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  return dir;
}

export function readFakeCodexState(codexHome: string): FakeCodexState {
  try {
    return JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-state.json'), 'utf8')) as FakeCodexState;
  } catch {
    return { projects: {}, hooksState: {}, calls: [] };
  }
}

export function writeFakeCodexOptions(
  codexHome: string,
  options: { failMethod?: string; exit?: boolean; omitCommands?: string[]; projectLayers?: Record<string, string>; windowsCommands?: boolean },
): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'fake.json'), JSON.stringify(options));
}
