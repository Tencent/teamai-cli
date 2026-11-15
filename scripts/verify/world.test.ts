import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketPathOf } from '../../packages/runtime-sandbox/src/attempt-socket.js';
import { packCheckout, REPO_ROOT, rewriteLocked, updateWorld, worldCommandNames, worldEnv, worldFiles, worldTmpDir, writeCommandLog, type World } from './world.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();

  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the commands a world puts on PATH', () => {
  it('are git, every tool, every sandbox provider teamai runs on this machine, and the T3 and Paseo commands', async () => {
    // docs/dev/glossary.md, Sandbox provider: docker, podman, sbx, seatbelt (macOS's /usr/bin/sandbox-exec), bwrap; vercel runs elsewhere.
    expect(await worldCommandNames()).toEqual(expect.arrayContaining(['git', 'claude', 'codex', 'codebuddy', 'opencode', 'docker', 'podman', 'sbx', '/usr/bin/sandbox-exec', 'bwrap', 't3', 'paseo']));
  });

  /** A checkout whose teamai ships `runtime-fake` as an executable, and whose package declares `exports` in its package.json. */
  function checkoutWithRuntime(exports: Record<string, string> | undefined): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-runtimes-'));
    roots.push(root);
    const pkg = path.join(root, 'packages', 'runtime-fake');
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { teamai: 'dist/index.js', 'teamai-runtime-fake': 'dist/runtime-fake.js' } }));
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@teamai/runtime-fake', ...(exports && { exports }) }));
    fs.writeFileSync(path.join(pkg, 'src', 'host-commands.ts'), "export const HOST_COMMANDS = ['fakeapp'];\n");

    return root;
  }

  it('include the command a new runtime package declares, with no edit to the harness', async () => {
    expect(await worldCommandNames({ root: checkoutWithRuntime({ './host-commands': './src/host-commands.ts' }) })).toEqual(['git', 'claude', 'codex', 'codebuddy', 'opencode', 'fakeapp']);
  });

  it('refuse a runtime teamai ships as an executable whose package declares no host commands', async () => {
    await expect(worldCommandNames({ root: checkoutWithRuntime(undefined) })).rejects.toThrow(/packages\/runtime-fake ships dist\/runtime-fake\.js but declares no host commands/);
  });

  it("reach Node through the world's own tools folder, never Node's folder, which holds every global npm command", () => {
    const env = worldEnv({ home: '/w/home', tmp: '/tmp/w', bin: '/w/install/node_modules/.bin', fakes: '/w/fakes', tools: '/w/tools', npmCache: '/w/npm-cache' });

    expect(env.PATH.split(':')).toEqual(['/w/fakes', '/w/install/node_modules/.bin', '/w/tools', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });
});

describe('the basic world', () => {
  // Every module of a step runtime's package the harness loads for its basic verbs, each a path and nothing else.
  const COMMAND_NAMES = new Set(['runtime-sandbox/src/journal-root.ts']);

  it('allows only modules that exist', () => {
    for (const module of COMMAND_NAMES) expect(fs.existsSync(path.join(REPO_ROOT, 'packages', module)), module).toBe(true);
  });

  it("loads no step runtime's modules beyond the command names it puts on PATH", () => {
    // module.register, not registerHooks, which Node 20 lacks. Hooks registered later run first, so this one goes after
    // the TypeScript loader verify.mjs registers, which settles a relative import without asking the hooks before it.
    const loader = `import fs from 'node:fs';
      export async function resolve(specifier, context, next) { const resolved = await next(specifier, context); fs.writeSync(2, 'LOADED ' + resolved.url + '\\n'); return resolved; }`;
    const hook = `import { register } from 'node:module';
      register(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'typescript-loader.mjs')).href)});
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;
    const ran = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, 'scripts/verify/verify.ts', 'help'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const runtimes = [...new Set(ran.stderr.split('\n').flatMap((line) => /^LOADED file:\/\/.*\/packages\/(runtime-(?!protocol\/)[^/]+\/src\/.+)$/.exec(line)?.[1] ?? []))];

    expect(ran.status).toBe(0);
    expect(runtimes.filter((module) => !COMMAND_NAMES.has(module))).toEqual([]);
    expect(runtimes.length).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === 'win32')("a world's snapshot of its HOME and project", () => {
  const layout = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-files-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(home, '.codex', 'sessions', '0000'), { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(home, '.codex', 'sessions', '0000', 'rollout.jsonl'), '{}\n');
    fs.writeFileSync(path.join(home, 'secret.txt'), 'x');
    fs.writeFileSync(path.join(home, 'notes.txt'), 'y');

    return { home, project };
  };

  it('records a folder or file it has no permission to read as unreadable, and goes on with the rest', () => {
    const { home, project } = layout();
    const folder = path.join(home, '.codex', 'sessions', '0000');
    const file = path.join(home, 'secret.txt');
    // A folder another user's tool left: this user can write to it, and cannot list it.
    fs.chmodSync(folder, 0o300);
    fs.chmodSync(file, 0o200);

    try {
      const files = worldFiles({ home, project });

      expect(files).toMatchObject({ 'home/.codex/sessions/0000': 'unreadable', 'home/secret.txt': 'unreadable', 'home/notes.txt': expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(Object.keys(files).filter((entry) => entry.startsWith('home/.codex/sessions/0000/'))).toEqual([]);
    } finally {
      fs.chmodSync(folder, 0o700);
      fs.chmodSync(file, 0o600);
    }
  });

  it('fails on a folder it cannot list for a reason other than permission, rather than leave it out', () => {
    const { home, project } = layout();
    const folder = path.join(home, '.codex', 'sessions', '0000');
    // As when the process has no file handle left. Other folders list through opendir, which the spy leaves alone.
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, _options: { withFileTypes: true }) => {
      if (dir.toString() === folder) throw Object.assign(new Error(`EMFILE: too many open files, scandir '${folder}'`), { code: 'EMFILE', path: folder });
      const listing = fs.opendirSync(dir.toString());
      const entries: fs.Dirent[] = [];

      for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) entries.push(entry);
      listing.closeSync();

      return entries;
    }) as typeof fs.readdirSync);

    try {
      expect(() => worldFiles({ home, project })).toThrow(/EMFILE/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves out an entry removed after its folder was listed, as a tool removes its lock file while the world is read', () => {
    const { home, project } = layout();
    fs.mkdirSync(path.join(home, '.tmp', 'plugins-clone', '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tmp', 'plugins-clone', '.git', 'shallow.lock'), '');
    fs.symlinkSync('notes.txt', path.join(home, 'notes-link'));
    // Listed whole, then each of a file, a folder and a symlink in it removed before the walk reads it.
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, _options: { withFileTypes: true }) => {
      const listing = fs.opendirSync(dir.toString());
      const entries: fs.Dirent[] = [];

      for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) entries.push(entry);
      listing.closeSync();

      if (dir.toString() === path.join(home, '.tmp', 'plugins-clone', '.git')) fs.rmSync(path.join(dir.toString(), 'shallow.lock'));

      if (dir.toString() === home) {
        fs.rmSync(path.join(home, '.codex'), { recursive: true });
        fs.rmSync(path.join(home, 'notes-link'));
      }

      return entries;
    }) as typeof fs.readdirSync);

    try {
      const files = worldFiles({ home, project });

      expect(Object.keys(files).filter((entry) => /^home\/(\.codex|notes-link|\.tmp\/plugins-clone\/\.git\/)/.test(entry))).toEqual([]);
      expect(files).toMatchObject({ 'home/.tmp/plugins-clone/.git': 'dir', 'home/notes.txt': expect.stringMatching(/^[0-9a-f]{64}$/) });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("a world's TMPDIR", () => {
  // A unix socket path holds at most 103 bytes on macOS (sun_path is 104 with its NUL), 107 on Linux.
  it.each([
    ['the world', undefined],
    ['a member with the longest name', 'abcdefghijkl'],
  ])('leaves room for the deepest attempt socket teamai makes there, for %s', (_who, member) => {
    const tmp = worldTmpDir({ root: '/private/tmp', runId: '20261112T113044-479be0', member });
    vi.stubEnv('TMPDIR', tmp);
    // A result path past what a socket binds sends the socket to the temp directory, its deepest place.
    const socket = socketPathOf({ result: path.join('/private/var/folders/xx', 'y'.repeat(120), 'result'), place: 'teamai-r0123456789abcdef-a01234567' });

    expect(socket.startsWith(`${tmp}/`)).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  });

  it('is one of its own per world and per member, named after the run so it is found again', () => {
    const runId = '20261112T113044-479be0';

    expect(new Set([worldTmpDir({ root: '/tmp', runId }), worldTmpDir({ root: '/tmp', runId, member: 'bob' }), worldTmpDir({ root: '/tmp', runId: '20261112T113044-000000' })]).size).toBe(3);
    expect(worldTmpDir({ root: '/tmp', runId })).toContain(runId);
  });
});

describe("a world's world.json", () => {
  /** A world whose world.json is written in a folder of its own, as `createWorld` leaves it. */
  function writtenWorld(): World {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-json-'));
    roots.push(dir);
    const world: World = {
      runId: '20261112T113044-479be0', dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T11:30:44.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
    };
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world));

    return world;
  }

  it('keeps a change another command of the world wrote since this one loaded it', () => {
    const loaded = writtenWorld();

    updateWorld(loaded, (fresh) => ({ ...fresh, driverSeen: true }));
    updateWorld(loaded, (fresh) => ({ ...fresh, cleanedAt: '2026-11-12T12:00:00.000Z' }));

    expect(JSON.parse(fs.readFileSync(path.join(loaded.dir, 'world.json'), 'utf8'))).toMatchObject({ driverSeen: true, cleanedAt: '2026-11-12T12:00:00.000Z' });
  });

  it('never removes the lock of a command that took it over from a dead holder, and waits through its release', () => {
    const loaded = writtenWorld();
    const lock = path.join(loaded.dir, 'world.json.lock');
    const dead = spawnSync('true').pid ?? 0;
    const live = String(process.ppid);
    fs.writeFileSync(lock, String(dead));
    const read = fs.readFileSync.bind(fs);
    const rm = fs.rmSync.bind(fs);
    let reads = 0;
    let removedLive = false;

    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (file !== lock) return read(file, options as BufferEncoding);
      reads += 1;

      // Another waiter saw the same dead holder, broke its lock and took it, right after this read.
      if (reads === 1) {
        fs.writeFileSync(lock, live);

        return String(dead);
      }

      // That command ends between this one's try to take the lock and its read of the holder.
      if (reads === 4) {
        rm(lock);
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${lock}'`), { code: 'ENOENT' });
      }

      return read(file, 'utf8');
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (file === lock && fs.existsSync(lock) && read(lock, 'utf8') === live) removedLive = true;
      rm(file, options);
    });

    updateWorld(loaded, (fresh) => ({ ...fresh, driverSeen: true }));
    vi.restoreAllMocks();

    expect(removedLive).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(loaded.dir, 'world.json'), 'utf8'))).toMatchObject({ driverSeen: true });
  });

  it("keeps every writer two commands of the world record at once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-writers-'));
    roots.push(dir);
    const file = path.join(dir, 'writers.json');
    const go = path.join(dir, 'go');
    const writer = `import fs from 'node:fs';
      const { recordWriters } = await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'verify', 'world.ts')).href)});
      const [file, go, tag] = process.argv.slice(1);
      while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
      for (let i = 0; i < 400; i += 1) recordWriters(file, ['cp'], {}, { [tag + '/' + i]: 'v' });`;
    const loader = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'typescript-loader.mjs')).href;
    const { spawn } = await import('node:child_process');
    const done = ['a', 'b'].map((tag) => new Promise<number | null>((resolve) => {
      spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`)}`, '--input-type=module', '-e', writer, file, go, tag], { cwd: REPO_ROOT, stdio: 'ignore' }).on('exit', resolve);
    }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(go, '');

    expect(await Promise.all(done)).toEqual([0, 0]);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length).toBe(800);
  }, 30_000);

  it("keeps each command's log when another command of the world took the next number first", () => {
    const { logs } = writtenWorld();
    fs.mkdirSync(logs);
    // Another command counted the same one log and wrote number 2 before this one did.
    fs.writeFileSync(path.join(logs, '2-sh.log'), 'the other command\n');

    const file = writeCommandLog({ logs }, ['sh', '-c', 'true'], 'out\n', 0);

    expect(fs.readFileSync(path.join(logs, '2-sh.log'), 'utf8')).toBe('the other command\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('$ sh -c true\nout\nexit 0\n');
  });
});

describe('every live world', () => {
  it('skips a world whose world.json cannot be read, says why, and still lists the others', async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'live-worlds-')));
    roots.push(tmp);
    vi.stubEnv('TMPDIR', tmp);
    vi.resetModules();
    const { liveWorlds, WORLDS_ROOT } = await import('./world.js');
    const write = (runId: string, text: string): void => {
      fs.mkdirSync(path.join(WORLDS_ROOT, runId), { recursive: true });
      fs.writeFileSync(path.join(WORLDS_ROOT, runId, 'world.json'), text);
    };
    const good = '20261112T113044-479be0';
    const dir = path.join(WORLDS_ROOT, good);
    write(good, JSON.stringify({
      runId: good, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' }, createdAt: '2026-11-12T11:30:44.000Z', baseline: { teamRefs: {}, checkoutStatus: [] },
    }));
    write('20261112T113045-000000', '{');
    write('20261112T113046-000000', JSON.stringify({ runId: '20261112T113046-000000' }));
    // Cleaned up long ago by an older harness, and kept as evidence: not a live world, so nothing to skip.
    write('20261112T113047-000000', JSON.stringify({ runId: '20261112T113047-000000', cleanedAt: '2026-11-01T00:00:00.000Z' }));

    const live = liveWorlds();

    expect(live.worlds.map((world) => world.runId)).toEqual([good]);
    expect(live.skipped).toEqual([
      { name: '20261112T113045-000000', why: expect.stringContaining('cannot be read as JSON') },
      { name: '20261112T113046-000000', why: expect.stringMatching(/is not a world\.json this harness reads \(.*dir.*\).*npm run verify:world/s) },
    ]);
  });
});

describe("a world's TMPDIRs, which cleanup removes", () => {
  it("loads a world only while each TMPDIR is its own, beside it in /tmp or inside its directory", async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'world-tmps-')));
    roots.push(tmp);
    vi.stubEnv('TMPDIR', tmp);
    vi.resetModules();
    const { loadWorld, shortTmpRoot, worldTmpDir: tmpOf, WORLDS_ROOT } = await import('./world.js');
    const runId = '20261112T113044-479be0';
    const dir = path.join(WORLDS_ROOT, runId);
    fs.mkdirSync(dir, { recursive: true });
    const member = (name: string, memberTmp: string) => ({ machine: 'host', name, home: `${dir}/members/${name}/home`, project: `${dir}/members/${name}/project`, writers: `${dir}/members/${name}/writers.json`, tmp: memberTmp, env: {}, baseline: { files: {} } });
    const load = (worldTmp: string, members: unknown[] = []) => {
      fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
        runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: worldTmp, logs: `${dir}/logs`, bin: `${dir}/bin`, members,
        build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' }, createdAt: '2026-11-12T11:30:44.000Z', baseline: { teamRefs: {}, checkoutStatus: [] },
      }));

      return (): unknown => loadWorld(runId);
    };
    const own = tmpOf({ root: shortTmpRoot(), runId });

    expect(load(own, [member('bob', tmpOf({ root: shortTmpRoot(), runId, member: 'bob' }))])).not.toThrow();
    expect(load(`${dir}/tmp`)).not.toThrow();
    expect(load(`${dir}/..tmp`)).not.toThrow();
    expect(load(shortTmpRoot())).toThrow(`names ${shortTmpRoot()} as a TMPDIR, which is not one of world ${runId}'s own`);
    expect(load(os.homedir())).toThrow(`names ${os.homedir()} as a TMPDIR`);
    expect(load(own, [member('bob', own)])).toThrow(`names ${own} as a TMPDIR`);
  });
});

describe('a rewrite of a file two commands of a world share', () => {
  const lockedFile = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-lock-'));
    roots.push(root);

    return path.join(root, 'world.json');
  };
  const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid;

  it('gives up with the holder named once a live command keeps the lock past the limit', () => {
    const file = lockedFile();
    fs.writeFileSync(`${file}.lock`, String(process.pid));

    expect(() => rewriteLocked(file, () => ({ value: 1, text: '{}\n' }), { waitMs: 200 })).toThrow(`${file}.lock is held by process ${process.pid} for 0.2 s.`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('gives up, naming the break file, when a command that died breaking a dead lock left its break file', () => {
    const file = lockedFile();
    fs.writeFileSync(`${file}.lock`, String(exitedPid()));
    fs.writeFileSync(`${file}.lock.break`, String(exitedPid()));

    expect(() => rewriteLocked(file, () => ({ value: 1, text: '{}\n' }), { waitMs: 200 })).toThrow(`remove that file and ${file}.lock.break if it is there.`);
  });

  it('takes a lock whose holder died and writes the file', () => {
    const file = lockedFile();
    fs.writeFileSync(`${file}.lock`, String(exitedPid()));

    expect(rewriteLocked(file, () => ({ value: 'written', text: '{}\n' }), { waitMs: 200 })).toBe('written');
    expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("a world's teamai package", () => {
  /** Each file of the checkout's dist/ with the inode and time it was written, or that there is none. */
  function checkoutDist(): Record<string, string> | 'none' {
    const dist = path.join(REPO_ROOT, 'dist');

    if (!fs.existsSync(dist)) return 'none';

    return Object.fromEntries(fs.readdirSync(dist).map((name) => {
      const stat = fs.statSync(path.join(dist, name));

      return [name, `${stat.ino}:${stat.mtimeMs}`];
    }));
  }

  /** The files of a tarball `npm pack` made, or would make from the checkout, outside dist/. */
  const outsideDist = (files: string[]): string[] => files.filter((file) => !file.startsWith('dist/')).sort();

  it("is built and packed apart from the checkout, whose dist/ an E2E run there may be loading, with the files the checkout's own pack holds", () => {
    const into = fs.mkdtempSync(path.join(os.tmpdir(), 'world-pkg-'));
    roots.push(into);
    const before = checkoutDist();

    const { tarball } = packCheckout({ into });

    expect(checkoutDist()).toEqual(before);
    const packed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((file) => file.replace(/^package\//, ''));
    expect(packed).toEqual(expect.arrayContaining(['dist/index.js', 'dist/cli.js', 'dist/runtime-sandbox.js', 'dist/runtime-t3.js', 'dist/runtime-paseo.js']));
    const own = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const ownFiles = (JSON.parse(own.stdout) as Array<{ files: Array<{ path: string }> }>)[0].files.map((file) => file.path);
    expect(outsideDist(packed)).toEqual(outsideDist(ownFiles));
    expect(fs.readdirSync(into)).toEqual([path.basename(tarball)]);
  }, 180_000);
});
