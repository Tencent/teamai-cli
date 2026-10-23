import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyOpencodeAgentHook } from '../../opencode-hooks.js';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'dist/index.js');
const V1 = path.join(ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
const V2 = process.env.TEAMAI_OPENCODE_V2_BIN;

async function freePort(): Promise<number> {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

// V2 is distributed separately; CI can opt in with its installed binary.
describe.each([{ version: 'V1', binary: V1 }, { version: 'V2', binary: V2 }])('real OpenCode $version hooks', ({ version, binary }) => {
  it.skipIf(!binary)('loads the CLI-generated plugin and dispatches session start once', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-oc-hooks-e2e-')));
    const home = path.join(sandbox, 'home');
    const work = path.join(sandbox, 'work');
    const team = path.join(sandbox, 'team');
    const bin = path.join(sandbox, 'bin');
    const records = path.join(sandbox, 'dispatch.jsonl');
    const commands = path.join(sandbox, 'enterprise.txt');
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(sandbox, 'data'),
      XDG_CACHE_HOME: path.join(sandbox, 'cache'), XDG_STATE_HOME: path.join(sandbox, 'state'),
      OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'),
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_PASSWORD: randomBytes(24).toString('hex'),
      OPENCODE_SERVER_PASSWORD: randomBytes(24).toString('hex'),
    };
    for (const dir of [home, work, team, bin, path.join(home, '.teamai'), env.OPENCODE_CONFIG_DIR]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(team, 'teamai.yaml'), `team: opencode-hooks-e2e\nrepo: ${team}\nprovider: tgit\ntoolPaths:\n  opencode:\n    skills: .opencode/skills\n`);
    fs.writeFileSync(path.join(home, '.teamai/config.yaml'), `repo:\n  localPath: ${team}\n  remote: ${team}\nusername: ci\nscope: user\nenabledAgents:\n  - opencode\n`);
    fs.writeFileSync(path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), '{}');
    // With any plugin configured, OpenCode's first request for a directory waits
    // until it has npm-installed @opencode-ai/plugin into its config dir: a
    // registry fetch that, when slow, outlasts the session request below (CI).
    // teamai's plugins import nothing from it, so record it as installed; with
    // node_modules present and the name locked, OpenCode installs nothing.
    fs.mkdirSync(path.join(env.OPENCODE_CONFIG_DIR, 'node_modules'));
    fs.writeFileSync(path.join(env.OPENCODE_CONFIG_DIR, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { '@opencode-ai/plugin': '*' } } } }));
    const shim = path.join(bin, 'capture.cjs');
    // Run injection through the installed-entry stand-in: dispatch captures
    // the payload, while every other command executes the real built CLI.
    fs.writeFileSync(shim, `if(process.argv[2]==='hook-dispatch'){let stdin='';process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>require('node:fs').appendFileSync(${JSON.stringify(records)},JSON.stringify({args:process.argv.slice(2),payload:JSON.parse(stdin)})+'\\n'));}else{import(${JSON.stringify(pathToFileURL(CLI).href)});}`);
    let server: ReturnType<typeof spawn> | undefined;
    let logs = '';
    try {
      const output = execFileSync(process.execPath, [shim, 'hooks', 'inject'], { env, cwd: work, encoding: 'utf8' });
      expect(output).toContain('OpenCode hook');
      await applyOpencodeAgentHook({ slug: 'start-proof', event: 'SessionStart', command: `node -e ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(commands)},'start\\n')`)}`, baseDir: home, scope: 'user' });
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      server = spawn(binary!, ['serve', '--print-logs', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout?.on('data', (data: Buffer) => { logs += data.toString(); });
      server.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
      const auth = Buffer.from(`opencode:${version === 'V1' ? env.OPENCODE_SERVER_PASSWORD : env.OPENCODE_PASSWORD}`).toString('base64');
      const request = async (route: string, body?: unknown, timeout = 5_000) => {
        if (version === 'V2') {
          const output = execFileSync(binary!, ['api', '--server', url, body ? 'POST' : 'GET', route, ...(body ? ['--data', JSON.stringify(body)] : [])], { env, cwd: work, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
          const response = JSON.parse(output) as Record<string, unknown>;
          return (response.data ?? response) as Record<string, unknown>;
        }
        const response = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout), ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw new Error(`${route}: ${response.status}`);
        return response.json() as Promise<Record<string, unknown>>;
      };
      await expect.poll(async () => { try { return !!(await request(version === 'V1' ? '/global/health' : '/api/info')); } catch { return false; } }, { timeout: 20_000 }).toBe(true);
      if (version === 'V2') {
        await expect.poll(() => {
          const list = execFileSync(binary!, ['api', '--server', url, 'plugin.list'], { env, cwd: work, encoding: 'utf8', timeout: 5_000 });
          const plugins = JSON.parse(list).data as Array<{ id: string; state: { status: string } }>;
          return ['teamai.hooks', 'teamai.agent.start-proof'].map((id) => plugins.find((p) => p.id === id)?.state.status);
        }, { timeout: 20_000 }).toEqual(['active', 'active']);
      }
      // The first session can still install the config-dir plugins' npm dependencies, which takes seconds and varies with load.
      const session = await request(version === 'V1' ? '/session' : '/api/session', version === 'V1' ? {} : { location: { directory: work } }, 20_000)
        .catch((error: unknown) => { throw new Error(`Creating the session failed: ${String(error)}\nOpenCode server log:\n${logs}`); });
      const dispatches = () => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; payload: Record<string, unknown> }) : [];
      await expect.poll(() => dispatches().length, { timeout: 10_000 }).toBe(1);
      expect(dispatches()).toEqual([{ args: ['hook-dispatch', 'session-start', '--tool', 'opencode'], payload: { cwd: work, session_id: session.id } }]);
      await expect.poll(() => fs.existsSync(commands) ? fs.readFileSync(commands, 'utf8') : '', { timeout: 10_000 }).toBe('start\n');
      expect(logs).not.toContain('Plugin must export a default definition');
    } finally {
      if (server && server.exitCode === null) {
        // OpenCode ignores SIGTERM while an aborted session request is in flight; force it so cleanup cannot mask the failure.
        const closed = once(server, 'close');
        server.kill();
        const force = setTimeout(() => server?.kill('SIGKILL'), 3_000);
        await closed;
        clearTimeout(force);
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
