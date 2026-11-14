import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDriver } from '../workflow/runtimes/definitions.js';
import { openDriver } from '../workflow/runtimes/sources.js';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';

/**
 * A step runtime as a resource: `runtimes/<name>.yaml`, or a folder `runtimes/<name>/` with its `RUNTIME.yaml` and its
 * code, of the member, the team or teamai, found as `driver.runtimes[].use` names it.
 */

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const kind of ['drivers', 'runtimes', 'trust']) fs.rmSync(path.join(getTeamaiHomeDir(), kind), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A user-scope config whose team repo holds `files`, and a definition `acme` that uses runtime `use`. */
function teamWith(files: Record<string, string>, use = 'acme'): LocalConfig {
  const team = tempDir('teamai-runtime-resources-');
  const all = { 'drivers/acme.yaml': `schemaVersion: v1alpha1\nname: acme\nruntimes:\n  - use: ${use}\n`, ...files };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(team, file)), { recursive: true });
    fs.writeFileSync(path.join(team, file), text, { mode: file.endsWith('/runtime') ? 0o755 : 0o644 });
  }
  return { repo: { localPath: team, remote: 'origin', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [] };
}

/** A directory on PATH holding an executable named `name`. */
function onPath(name: string): string {
  const bin = tempDir('teamai-runtime-bin-');
  fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
  return path.join(bin, name);
}

/** Writes the member's own `files` under ~/.teamai/. */
function personal(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(getTeamaiHomeDir(), file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text, { mode: file.endsWith('/runtime') ? 0o755 : 0o644 });
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const open = (config: LocalConfig) => openDriver(config, 'acme', { personal: true, mode: 'unattended', canAsk: false, purpose: 'check', checkout: config.repo.localPath });

const COMMAND_RUNTIME = 'protocol: 1\nentry: { command: acme-runtime }\n';

describe('a team runtime file', () => {
  it('finds a team runtimes/acme.yaml whose entry is an executable on PATH, and asks for its file\'s content before it runs', async () => {
    onPath('acme-runtime');
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });

    expect(await open(team)).toEqual({
      ok: false,
      failure: {
        code: 'runtime_not_accepted',
        message: `Step runtime "acme" comes from the team repo (runtimes/acme.yaml, content ${sha(COMMAND_RUNTIME).slice(0, 12)}) and runs acme-runtime, which no one has accepted on this machine, and an unattended run does not ask. `
          + 'Run the same command once in a terminal, attended, to review and accept it, then run it unattended again.',
      },
    });
  });
});

describe('which runtime a name finds', () => {
  /** The runtime `use: acme` of `config` finds, as `{ layer, resource, location }`, after the person accepts it when asked. */
  async function located(config: LocalConfig, use = 'acme'): Promise<unknown> {
    const { locateRuntime, acceptRuntime } = await import('../workflow/runtimes/locate.js');
    const resolved = await resolveDriver(config, 'acme', { personal: true });
    if (!resolved.ok) return resolved.failure;
    const found = await locateRuntime(resolved.driver, use);
    if (!found.ok) return found.failure;
    const { source } = found;
    if (source.kind === 'builtin') return source;
    const accepted = await acceptRuntime(source, { mode: 'unattended', canAsk: false });
    return { layer: source.layer, resource: source.resource, location: source.location, form: source.marker.endsWith('RUNTIME.yaml') ? 'folder' : 'file', accepted: accepted.ok };
  }

  it('reads the member\'s own runtimes/<name>.yaml and runtimes/<name>/RUNTIME.yaml, which run with no acceptance', async () => {
    onPath('acme-runtime');
    personal({ 'runtimes/acme.yaml': COMMAND_RUNTIME, 'runtimes/mine/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\n', 'runtimes/mine/runtime': '#!/bin/sh\n' });
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });

    expect(await located(team)).toEqual({ layer: 'personal', resource: 'acme', location: path.join(getTeamaiHomeDir(), 'runtimes', 'acme.yaml'), form: 'file', accepted: true });
    expect(await located(team, 'mine')).toMatchObject({ layer: 'personal', resource: 'mine', form: 'folder', accepted: true });
  });

  it('reads a team folder runtimes/<name>/RUNTIME.yaml, and runs it once its revision is accepted', async () => {
    const team = teamWith({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./bin/start\n', 'runtimes/acme/bin/start': '#!/bin/sh\n' });

    expect(await located(team)).toEqual({ layer: 'team', resource: 'acme', location: 'runtimes/acme/', form: 'folder', accepted: false });
  });

  it('runs a team file once a person accepts its content, and asks again once a teammate changes it', async () => {
    onPath('acme-runtime');
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });
    const { locateRuntime, acceptRuntime } = await import('../workflow/runtimes/locate.js');
    const resolved = await resolveDriver(team, 'acme', { personal: true });
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const found = await locateRuntime(resolved.driver, 'acme');
    if (!found.ok) throw new Error(found.failure.message);
    const asked: string[] = [];

    expect(await acceptRuntime(found.source, { mode: 'attended', canAsk: true, ask: async (question) => { asked.push(question); return true; } })).toEqual({ ok: true });
    expect(asked).toEqual([`Step runtime "acme" comes from the team repo (runtimes/acme.yaml, content ${sha(COMMAND_RUNTIME).slice(0, 12)}), which you have not accepted on this machine. It runs acme-runtime as you, with your files. Review the file before you accept it.\nRun it? [y/N] `]);
    expect(await located(team)).toMatchObject({ layer: 'team', accepted: true });
    fs.writeFileSync(path.join(team.repo.localPath, 'runtimes', 'acme.yaml'), `${COMMAND_RUNTIME}exec: true\n`);
    expect(await located(team)).toMatchObject({ layer: 'team', accepted: false });
  });

  it('runs a team folder at the revision accepted, though a pull changes the folder once the runtime started', async () => {
    const seen = path.join(tempDir('teamai-runtime-seen-'), 'payload.txt');
    // The runtime reads a file of its own folder a while after it started, then exits, as code that loads a module late.
    const team = teamWith({
      'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\n',
      'runtimes/acme/runtime': `#!/bin/sh\nsleep 1.5\ncat "$(dirname "$0")/payload.txt" > '${seen}'\ncd "$(dirname "$0")" && pwd -P > '${seen}.from'\n`,
      'runtimes/acme/payload.txt': 'accepted\n',
    });
    const { locateRuntime, acceptRuntime } = await import('../workflow/runtimes/locate.js');
    const resolved = await resolveDriver(team, 'acme', { personal: true });
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const found = await locateRuntime(resolved.driver, 'acme');
    if (!found.ok) throw new Error(found.failure.message);
    expect(await acceptRuntime(found.source, { mode: 'attended', canAsk: true, ask: async () => true })).toEqual({ ok: true });

    const opened = open(team);
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(team.repo.localPath, 'runtimes', 'acme', 'payload.txt'), 'pushed later\n');
    await opened;

    expect(fs.readFileSync(seen, 'utf8')).toBe('accepted\n');
    // The temp folder may forbid running programs, where the team's own folder ran before.
    expect(fs.readFileSync(`${seen}.from`, 'utf8').startsWith(fs.realpathSync(os.tmpdir()))).toBe(false);
  });

  it('removes the copy a killed teamai left of a team runtime folder, at the next run of it, and none a teamai on another host sharing the home runs', async () => {
    const team = teamWith({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\n', 'runtimes/acme/runtime': '#!/bin/sh\nexit 0\n' });
    const { locateRuntime, pinRuntime } = await import('../workflow/runtimes/locate.js');
    const resolved = await resolveDriver(team, 'acme', { personal: true });
    if (!resolved.ok) throw new Error(resolved.failure.message);
    const found = await locateRuntime(resolved.driver, 'acme');
    if (!found.ok || found.source.kind === 'builtin') throw new Error('no team runtime');
    // A teamai that pinned the folder, then was killed before it removed its copy.
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const pid = vi.spyOn(process, 'pid', 'get').mockReturnValue(gone);
    const left = await pinRuntime(found.source, { config: team });
    pid.mockRestore();
    if (!left.ok || left.source.launch.kind !== 'executable') throw new Error('no copy');
    const leftDir = path.dirname(left.source.launch.executable);
    expect(fs.existsSync(leftDir)).toBe(true);
    // A teamai in a container sharing the data home, whose pid names no process here.
    const hostname = vi.spyOn(os, 'hostname').mockReturnValue('devcontainer-4f2a');
    const containerPid = vi.spyOn(process, 'pid', 'get').mockReturnValue(gone);
    const elsewhere = await pinRuntime(found.source, { config: team });
    containerPid.mockRestore();
    hostname.mockRestore();
    if (!elsewhere.ok || elsewhere.source.launch.kind !== 'executable') throw new Error('no copy');
    // A copy a killed teamai left before copies named their host: `<pid>-<random>`, this host's, as every one was then.
    const legacy = path.join(path.dirname(leftDir), `${gone}-Ab12Cd`);
    fs.mkdirSync(legacy);

    const next = await pinRuntime(found.source, { config: team });
    if (!next.ok) throw new Error(next.failure.message);

    expect([fs.existsSync(leftDir), fs.existsSync(path.dirname(elsewhere.source.launch.executable)), fs.existsSync(legacy)]).toEqual([false, true, false]);
    await elsewhere.remove();
    if (next.source.launch.kind !== 'executable') throw new Error('no copy');
    // The person reviews what runs, which a pull no longer changes, at the revision they accept.
    const asked: string[] = [];
    const { acceptRuntime } = await import('../workflow/runtimes/locate.js');
    expect(await acceptRuntime(next.source, { mode: 'attended', canAsk: true, ask: async (question) => { asked.push(question); return true; } })).toEqual({ ok: true });
    expect(asked).toEqual([expect.stringContaining(`Review ${path.dirname(next.source.launch.executable)} (RUNTIME.yaml, runtime)`)]);
    await next.remove();
  });

  it('takes the exact name in every layer before teamai-<name>, and the member\'s before the team\'s', async () => {
    onPath('acme-runtime');
    personal({ 'runtimes/teamai-acme.yaml': COMMAND_RUNTIME });
    const team = teamWith({ 'runtimes/acme.yaml': COMMAND_RUNTIME });

    expect(await located(team)).toMatchObject({ layer: 'team', resource: 'acme' });
    fs.rmSync(path.join(team.repo.localPath, 'runtimes', 'acme.yaml'));
    expect(await located(team)).toMatchObject({ layer: 'personal', resource: 'teamai-acme' });
  });

  it('runs no teamai-runtime-<name> it finds only on PATH, and says where to declare the runtime', async () => {
    onPath('teamai-runtime-acme');

    expect(await located(teamWith({}))).toEqual({
      code: 'runtime_not_found',
      message: 'Driver "acme" uses runtime "acme", and none is declared: add runtimes/acme.yaml (or runtimes/acme/RUNTIME.yaml with its code) to the team repo and run teamai pull, or add ~/.teamai/runtimes/acme.yaml for yourself.',
    });
  });

  it('reads a team runtime in a namespace the member\'s project selects for workflows, and not in one it does not', async () => {
    onPath('acme-runtime');
    const team = { ...teamWith({
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n  - id: billing\n    resources: { workflows: [mobile] }\n',
      'runtimes/web/acme.yaml': COMMAND_RUNTIME,
      'runtimes/mobile/other.yaml': COMMAND_RUNTIME,
    }), projects: ['checkout'] };

    expect(await located(team)).toMatchObject({ layer: 'team', location: 'runtimes/web/acme.yaml' });
    expect(await located(team, 'other')).toMatchObject({ code: 'runtime_not_found' });
  });
});

describe('a selected runtime that cannot run', () => {
  /** What `use: acme` of a team whose `files` define it opens to, with a working teamai-acme of the member's own to fall through to. */
  async function opened(files: Record<string, string>): Promise<unknown> {
    onPath('acme-runtime');
    personal({ 'runtimes/teamai-acme.yaml': COMMAND_RUNTIME });
    const team = teamWith(files);
    for (const [file, target] of Object.entries(links)) fs.symlinkSync(path.join(team.repo.localPath, target), path.join(team.repo.localPath, file));
    links = {};
    return open(team);
  }

  let links: Record<string, string> = {};

  const refused = (location: string, reason: string) => ({
    ok: false,
    failure: { code: 'runtime_not_found', message: `Driver "acme" uses runtime "acme", and ${location} cannot run it: ${reason}. Fix it, push it, run teamai pull, and start again.` },
  });

  it('fails the run on a marker that does not parse or a folder with none, and never falls through to another layer', async () => {
    expect(await opened({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\nexec: no-commands\n', 'runtimes/acme/runtime': '#!/bin/sh\n' }))
      .toMatchObject({ ok: false, failure: { code: 'runtime_not_found', message: expect.stringMatching(/^Driver "acme" uses runtime "acme", and runtimes\/acme\/RUNTIME\.yaml cannot run it: exec: .*; a runtime sets protocol, entry and optionally exec\. Fix it, push it, run teamai pull, and start again\.$/) } });
    expect(await opened({ 'runtimes/acme.yaml': 'protocol: 1\nentry: { command: [acme-runtime\n' }))
      .toMatchObject({ ok: false, failure: { message: expect.stringContaining('runtimes/acme.yaml cannot run it: it is not YAML') } });
    // The layout before RUNTIME.yaml: the folder holds the code, and nothing that says it is a runtime.
    expect(await opened({ 'runtimes/acme/runtime': '#!/bin/sh\n' }))
      .toEqual(refused('runtimes/acme/', 'it holds no RUNTIME.yaml, the marker that names its protocol and its code, such as protocol: 1 and entry: ./runtime'));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails the run on a team runtime folder it cannot read all of, rather than taking it as holding no link', async () => {
    onPath('acme-runtime');
    personal({ 'runtimes/teamai-acme.yaml': COMMAND_RUNTIME });
    const team = teamWith({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\n', 'runtimes/acme/runtime': '#!/bin/sh\n', 'runtimes/acme/lib/a.sh': '' });
    const closed = path.join(team.repo.localPath, 'runtimes', 'acme', 'lib');
    fs.chmodSync(closed, 0o000);

    try {
      expect(await open(team)).toEqual({ ok: false, failure: { code: 'runtime_not_found', message: expect.stringMatching(/^Driver "acme" uses runtime "acme", and runtimes\/acme\/ cannot run it: its folder cannot be read \(.*\)\. Fix it, push it, run teamai pull, and start again\.$/) } });
    } finally {
      fs.chmodSync(closed, 0o755);
    }
  });

  it('fails the run on an entry that is not there', async () => {
    expect(await opened({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ./runtime\n' })).toEqual(refused('runtimes/acme/', 'entry: ./runtime names a file the folder does not hold'));
    expect(await opened({ 'runtimes/acme.yaml': 'protocol: 1\nentry: { command: acme-missing }\n' })).toEqual(refused('runtimes/acme.yaml', 'entry: { command: acme-missing } names no executable on PATH, as a bare name such as acme-runtime'));
    expect(await opened({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 1\nentry: ../acme-runtime\n' })).toEqual(refused('runtimes/acme/', 'entry: ../acme-runtime leaves the folder, and its entry is a file inside it, such as ./runtime'));
    expect(await opened({ 'runtimes/acme.yaml': 'protocol: 1\nentry: { bin: teamai-runtime-t3 }\n' })).toMatchObject({ ok: false, failure: { message: expect.stringContaining('entry: { bin: teamai-runtime-t3 } names a program of teamai\'s own package, which only teamai\'s runtimes use') } });
  });

  it('fails the run on a team runtime file that is a link', async () => {
    links = { 'runtimes/acme.yaml': 'elsewhere.yaml' };

    expect(await opened({ 'elsewhere.yaml': COMMAND_RUNTIME, 'runtimes/.keep': '' })).toEqual(refused('runtimes/acme.yaml', 'it is a link, and teamai reads a runtime only from a file the team repo holds'));
  });

  it('fails the run on a marker of another protocol, naming the marker, before anything is spawned', async () => {
    expect(await opened({ 'runtimes/acme/RUNTIME.yaml': 'protocol: 0\nentry: ./runtime\n', 'runtimes/acme/runtime': '#!/bin/sh\n' })).toEqual(refused('runtimes/acme/RUNTIME.yaml', 'it declares protocol 0, and this teamai speaks protocol 1'));
  });
});
