/**
 * A world: one run's isolated playground under $TMPDIR/teamai-verify/<run id>/. A scratch project repo, a bare team
 * repo behind a fake https URL, the teamai under test packed and installed the way a member installs it, and a HOME
 * and TMPDIR of its own. Commands run in it with an environment built from nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { runtimeStateRoot } from '@teamai/runtime-protocol/state-root';
import { signalPid } from '@teamai/shared/process-group';
import { errnoCode } from '../../src/utils/fs.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORLDS_ROOT = path.join(os.tmpdir(), 'teamai-verify');

/** teamai takes only https or ssh team repo URLs, so the world's git maps this one onto its bare repo. */
export const TEAM_URL = 'https://teamai.test/team/repo.git';

const FilesSchema = z.record(z.string(), z.string());

/** What a member has of its own: a HOME, a TMPDIR and a clone of the world's project, and the env its commands get. */
const MemberPlaceSchema = z.object({
  name: z.string(),
  home: z.string(),
  project: z.string(),
  tmp: z.string(),
  writers: z.string(),
  env: z.record(z.string(), z.string()),
  baseline: z.object({ files: FilesSchema }),
});

/** A member on this machine, or one in a Linux container of its own: its own hostname and process table. */
const MemberSchema = z.discriminatedUnion('machine', [
  MemberPlaceSchema.extend({ machine: z.literal('host') }),
  MemberPlaceSchema.extend({ machine: z.literal('container'), container: z.string() }),
]);

export type Member = z.infer<typeof MemberSchema>;

const WorldSchema = z.object({
  runId: z.string(),
  dir: z.string(),
  project: z.string(),
  team: z.string(),
  home: z.string(),
  tmp: z.string(),
  logs: z.string(),
  bin: z.string(),
  build: z.object({
    commit: z.string(),
    dirty: z.boolean(),
    version: z.string(),
    tarball: z.string(),
    sha256: z.string(),
    node: z.string(),
  }),
  createdAt: z.string(),
  baseline: z.object({ teamRefs: z.record(z.string(), z.string()), checkoutStatus: z.array(z.string()), files: z.record(z.string(), z.string()).optional() }),
  /** The only variables a command gets, frozen at creation; absent in a world made before it, whose commands run through bin/run. */
  env: z.record(z.string(), z.string()).optional(),
  /** The project's bare origin behind a fake https URL, made on first need, and its refs once the harness set it up. */
  origin: z.object({ bare: z.string(), url: z.string(), refs: z.record(z.string(), z.string()) }).optional(),
  members: z.array(MemberSchema).optional(),
  /** Every name a command of the world was given with --pass, never a value: the ledger masks what each holds in the harness. */
  passed: z.array(z.string()).optional(),
  // Once a runtime outside teamai's process ran in the world: what uninstall deletes cannot lower the ledger's checks after it.
  driverSeen: z.literal(true).optional(),
  cleanedAt: z.string().optional(),
});

export type World = z.infer<typeof WorldSchema>;

/** Git rewrites these itself on any command, so they say nothing about what teamai left. */
const GIT_OWN = new Set(['.git/objects', '.git/logs', '.git/index']);

/** Files git keeps its settings in, which a member's git and teamai's hooks both edit. */
const GIT_CONFIG = /(^|\/)(\.git\/config|\.git\/worktrees\/[^/]+\/config\.worktree|\.gitconfig)$/;

/** Each setting of a git config file at `${entry}#<key>`, with its value, so a setting is judged by its own writer and what it names. */
function gitConfigSettings(entry: string, file: string): Record<string, string> | undefined {
  const values = new Map<string, string[]>();
  // A file git cannot parse is judged whole, so the command that broke it can still run to fix it.
  const listed = spawnSync('git', ['config', '--file', file, '--list', '-z'], { encoding: 'utf8' });

  if (listed.status !== 0) return undefined;

  for (const setting of listed.stdout.split('\0').filter(Boolean)) {
    const [key = '', ...value] = setting.split('\n');
    values.set(key, [...values.get(key) ?? [], value.join('\n')]);
  }

  return Object.fromEntries([...values].map(([key, value]) => [`${entry}#${key}`, value.join('\0')]));
}

/** A `worldFiles` entry the harness has no permission to read, as a folder another user's tool left: what is in it is not observed. */
export const UNREADABLE = 'unreadable';

/** What `read` returns, or undefined when the harness has no permission to read what it names; any other failure is thrown. */
function permitted<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    const code = errnoCode(error);

    if (code === 'EACCES' || code === 'EPERM') return undefined;
    throw error;
  }
}

/** What `present` returns for an entry removed after its folder was listed. */
export const GONE = Symbol('gone');

/** What `read` returns, or `GONE` when what it names no longer exists; any other failure is thrown. */
export function present<T>(read: () => T): T | typeof GONE {
  try {
    return read();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return GONE;
    throw error;
  }
}

/**
 * Every entry under the world's HOME and project: a file's sha256, `dir`, or a symlink's target; a git config file is `git
 * config` and one entry per setting. A folder or file the harness has no permission to read is `UNREADABLE`. An entry
 * removed after its folder was listed, as a lock file a running tool removes, is not there.
 */
export function worldFiles(world: Pick<World, 'home' | 'project'>) {
  const files: Record<string, string> = {};

  const walk = (root: string, label: string, rel: string, entries: readonly fs.Dirent[]): void => {
    for (const entry of entries) {
      const child = path.posix.join(rel, entry.name);
      const full = path.join(root, child);

      if (label === 'project' && GIT_OWN.has(child)) continue;

      const settings = entry.isFile() && GIT_CONFIG.test(child) ? gitConfigSettings(`${label}/${child}`, full) : undefined;

      if (entry.isSymbolicLink()) {
        const target = present(() => fs.readlinkSync(full));

        if (target !== GONE) files[`${label}/${child}`] = `-> ${target}`;
      } else if (entry.isDirectory()) {
        const inside = present(() => permitted(() => fs.readdirSync(full, { withFileTypes: true })));

        if (inside === GONE) continue;
        files[`${label}/${child}`] = inside === undefined ? UNREADABLE : 'dir';

        if (inside !== undefined) walk(root, label, child, inside);
      } else if (settings !== undefined) {
        files[`${label}/${child}`] = 'git config';
        Object.assign(files, settings);
      } else {
        const content = present(() => permitted(() => fs.readFileSync(full)));

        if (content === GONE) continue;
        files[`${label}/${child}`] = content === undefined ? UNREADABLE : crypto.createHash('sha256').update(content).digest('hex');
      }
    }
  };

  walk(world.home, 'home', '', fs.readdirSync(world.home, { withFileTypes: true }));
  walk(world.project, 'project', '', fs.readdirSync(world.project, { withFileTypes: true }));

  return files;
}

/** A HOME's ~/.gitconfig in a world: who commits, no background git, and each fake https URL mapped onto its bare repo. */
export function gitconfigText({ name, email, urls }: { name: string; email: string; urls: ReadonlyArray<{ repo: string; url: string }> }): string {
  const mapped = urls.map(({ repo, url }) => `[url "file://${repo}"]\n\tinsteadOf = ${url}\n`).join('');

  return `[user]\n\tname = ${name}\n\temail = ${email}\n[init]\n\tdefaultBranch = main\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n${mapped}`;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function checkoutStatus(): string[] {
  return git(REPO_ROOT, 'status', '--porcelain').split('\n').filter(Boolean);
}

export function teamRefs(team: string) {
  return Object.fromEntries(
    git(team, 'for-each-ref', '--format=%(refname) %(objectname)')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref = '', sha = ''] = line.split(' ');

        return [ref, sha] as const;
      }),
  );
}

/** `value` as one word of a POSIX shell command line. */
export const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const TOOL_COMMANDS = ['claude', 'codex', 'codebuddy', 'opencode'] as const;

const PackageJsonSchema = z.looseObject({ bin: z.record(z.string(), z.string()).optional(), exports: z.record(z.string(), z.string()).optional() });

/** An executable teamai ships for a step runtime: `dist/runtime-<name>.js`, built from `packages/runtime-<name>`. */
const RUNTIME_EXECUTABLE = /^(?:\.\/)?dist\/(runtime-[\w-]+)\.js$/;

/**
 * The commands each step runtime teamai ships as an executable runs on the member's machine, by its package: what the
 * module its package.json exports as `./host-commands` says. A runtime that declares none fails here, so a new one is
 * never left off a world's PATH unnoticed.
 */
export async function runtimeHostCommands({ root = REPO_ROOT }: { root?: string } = {}): Promise<Array<{ runtime: string; commands: readonly string[] }>> {
  const read = (dir: string) => PackageJsonSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));
  const runtimes = [...new Set(Object.values(read(root).bin ?? {}).flatMap((file) => RUNTIME_EXECUTABLE.exec(file)?.[1] ?? []))].toSorted();

  return Promise.all(runtimes.map(async (runtime) => {
    const dir = path.join(root, 'packages', runtime);
    const module = read(dir).exports?.['./host-commands'];

    if (module === undefined) throw new Error(`packages/${runtime} ships dist/${runtime}.js but declares no host commands: add "./host-commands" to the "exports" of its package.json, a module exporting HOST_COMMANDS (empty when it runs none).`);
    const { HOST_COMMANDS } = z.object({ HOST_COMMANDS: z.array(z.string()) }).parse(await import(pathToFileURL(path.join(dir, module)).href));

    return { runtime, commands: HOST_COMMANDS };
  }));
}

/** Every command a world's PATH reaches on this machine: git, the tools, and the host commands of each step runtime teamai ships. */
export async function worldCommandNames({ root }: { root?: string } = {}): Promise<string[]> {
  return ['git', ...TOOL_COMMANDS, ...(await runtimeHostCommands({ root })).flatMap(({ commands }) => commands)];
}

/**
 * A world's or a member's TMPDIR, outside the world's directory: macOS keeps $TMPDIR under /var/folders, too deep for
 * the attempt socket teamai binds there once the attempt's own path is too long (103 bytes on macOS).
 */
export function worldTmpDir({ root, runId, member }: { root: string; runId: string; member?: string | undefined }): string {
  return path.join(root, `teamai-verify-${runId}${member === undefined ? '' : `-${member}`}`);
}

/** The short root every world's TMPDIR is made in: /tmp, as its real path. */
export function shortTmpRoot(): string {
  return fs.realpathSync.native('/tmp');
}

/**
 * Where the host finds a command, or undefined when it has none: what a world links into its `tools`, and what doctor
 * probes. Past the `node_modules/.bin` folders `npm run` puts first on PATH, so a tool this checkout has as a dependency
 * is not taken for the member's own. Throws when the shell that looks it up does not answer.
 */
export function hostCommand(name: string): string | undefined {
  const PATH = (process.env.PATH ?? '').split(':').filter((dir) => !dir.endsWith(`${path.sep}node_modules${path.sep}.bin`)).join(':');
  const found = spawnSync('sh', ['-c', `command -v ${quote(name)}`], { encoding: 'utf8', env: { ...process.env, PATH }, timeout: 10_000, killSignal: 'SIGKILL' });

  if (found.error !== undefined) throw new Error(`looking ${name} up on PATH failed (${found.error.message})`, { cause: found.error });
  const at = found.stdout.trim();

  return at === '' ? undefined : at;
}

/** What a probe answered: its exit code, null when it did not end on its own, what it printed, and why it failed. */
export interface Probed {
  code: number | null;
  stdout: string;
  stderr: string;
  why: string;
  /** The errno of a probe that could not run or did not end, such as ENOENT or ETIMEDOUT. */
  errno?: string;
}

/**
 * Runs a probe that ends within `timeoutMs`: KILL, not TERM, at its time, since a command that ignores TERM would hold
 * the probe past it. `why` says NOT OBSERVED, naming `shown`, for one that did not answer in time.
 */
export function runProbe({ command, args, shown = [command, ...args], cwd, env, timeoutMs, maxBuffer = 64 * 1024 ** 2 }: { command: string; args: readonly string[]; shown?: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer?: number }): Probed {
  const ran = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer });
  const errno = ran.error === undefined ? undefined : errnoCode(ran.error);
  const why = errno === 'ETIMEDOUT' ? `NOT OBSERVED: ${shown.join(' ')} did not answer within ${timeoutMs / 1000} s` : ran.error?.message ?? ran.stderr?.trim().split('\n').at(-1) ?? '';

  return { code: ran.error === undefined ? ran.status : null, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', why, ...(errno !== undefined && { errno }) };
}

/**
 * Links each host command a world may run into `tools`, alone. Its folder would bring every other command there, such
 * as a launcher that tells itself from the real program by `$HOME`, which in a world names another folder.
 */
async function linkHostCommands(tools: string): Promise<void> {
  fs.mkdirSync(tools, { recursive: true });

  // The Node the harness runs on, and its npm and npx, which teamai's update check runs: never Node's folder, where every global npm command sits.
  for (const [name, found] of [['node', process.execPath], ...['npm', 'npx'].map((command) => [command, path.join(path.dirname(process.execPath), command)])]) {
    if (fs.existsSync(found)) fs.symlinkSync(found, path.join(tools, name));
  }

  for (const name of await worldCommandNames()) {
    const found = hostCommand(name);

    if (found !== undefined) fs.symlinkSync(found, path.join(tools, path.basename(name)));
  }
}

/** The HOME of each install of the world, its own and then each member's, as this machine's file system has it: a container member's is mounted at the same path. */
export function worldHomes(world: { home: string; members?: ReadonlyArray<{ home: string }> | undefined }): string[] {
  return [world.home, ...(world.members ?? []).map((member) => member.home)];
}

/** Where each install of the world keeps the state of the runtimes outside teamai's process (sandbox, T3, Paseo), one folder each. */
export function runtimeStateDirs(world: Pick<World, 'home' | 'members'>): string[] {
  return worldHomes(world).map((home) => runtimeStateRoot(home));
}

/** The variable every world's commands carry with a value of its own, which no step may receive: the observer looks for it. */
export const CANARY_NAME = 'VERIFY_WORLD_CANARY';

/** The only variables a world's commands get. Anything else, a tool home or a teamai setting, must be set on the command line. */
export function worldEnv({ home, tmp, bin, fakes, tools, npmCache }: { home: string; tmp: string; bin: string; fakes: string; tools: string; npmCache: string }) {
  const search = [fakes, bin, tools, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

  return {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    PATH: [...new Set(search)].join(':'),
    GIT_CONFIG_NOSYSTEM: '1',
    // A member's npm cache predates teamai, so what teamai's update check makes npm write there is not teamai's.
    npm_config_cache: npmCache,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: process.env.TERM ?? 'dumb',
    [CANARY_NAME]: crypto.randomBytes(16).toString('hex'),
  };
}

/**
 * A `gh` that never reaches the network: `pr list` prints fakes/gh-pr-list.json or `[]`, anything else fails the way
 * a `gh` that is not signed in does. Each call is logged to fakes/gh.log with the side of the agent wait it ran on.
 */
function writeFakeGh(fakes: string): void {
  fs.mkdirSync(fakes, { recursive: true });
  const gh = path.join(fakes, 'gh');
  const prList = quote(path.join(fakes, 'gh-pr-list.json'));
  fs.writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\t%s\\n' "\${AGENT_WAIT_SIDE:-waited}" "$*" >> ${quote(path.join(fakes, 'gh.log'))}
case "$1 $2" in
  'pr list')
    if [ -f ${prList} ]; then cat ${prList}; else echo '[]'; fi
    exit 0 ;;
esac
if [ "$1" = --version ]; then echo 'gh version 0.0.0 (world)'; exit 0; fi
echo 'gh: not available in a world' >&2
exit 1
`,
  );
  fs.chmodSync(gh, 0o755);
}

export async function createWorld(): Promise<World> {
  if (process.platform === 'win32') throw new Error('A world needs a POSIX shell; Windows is not supported. Say so in the PR instead.');
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(WORLDS_ROOT, { recursive: true });
  const dir = path.join(fs.realpathSync.native(WORLDS_ROOT), runId);
  const tmp = worldTmpDir({ root: shortTmpRoot(), runId });

  // Before world.json exists neither cleanup route can find the directory.
  try {
    return await buildWorld(runId, dir, tmp);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Builds this checkout into a staging folder under `into` and packs it there; answers the tarball and the version it
 * carries. The checkout's own dist/ stays as it is: a build there rewrites it while an E2E run of the checkout loads it.
 */
export function packCheckout({ into }: { into: string }) {
  const staging = path.join(into, 'package');

  const listed = z
    .array(z.object({ files: z.array(z.object({ path: z.string() })) }))
    .parse(JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })))[0];

  // npm's own list of what the checkout ships, so its rules (`files`, README*, LICENSE, ...) are not restated here.
  for (const { path: file } of listed.files) {
    if (file.startsWith('dist/')) continue;
    fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(staging, file));
  }

  execFileSync('npm', ['run', 'build', '--silent', '--', '--out-dir', path.join(staging, 'dist')], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] });

  const packed = z
    .array(z.object({ filename: z.string(), version: z.string() }))
    .parse(JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', into], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })))[0];

  fs.rmSync(staging, { recursive: true, force: true });

  return { tarball: path.join(into, packed.filename), version: packed.version };
}

async function buildWorld(runId: string, dir: string, tmp: string): Promise<World> {
  const at = (name: string): string => path.join(dir, name);

  for (const name of ['home', 'pkg', 'install', 'project', 'logs']) fs.mkdirSync(at(name), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });

  const commit = git(REPO_ROOT, 'rev-parse', 'HEAD');
  const status = checkoutStatus();
  const packed = packCheckout({ into: at('pkg') });
  const tarball = packed.tarball;
  execFileSync('npm', ['install', '--prefix', at('install'), '--no-audit', '--no-fund', '--prefer-offline', '--silent', tarball], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const team = at('team.git');
  fs.writeFileSync(path.join(at('home'), '.gitconfig'), gitconfigText({ name: 'TeamAI World', email: 'world@teamai.test', urls: [{ repo: team, url: TEAM_URL }] }));
  const bin = at('bin');
  fs.mkdirSync(bin);
  writeFakeGh(at('fakes'));
  await linkHostCommands(at('tools'));
  const env = worldEnv({ home: at('home'), tmp, bin: path.join(at('install'), 'node_modules', '.bin'), fakes: at('fakes'), tools: at('tools'), npmCache: at('npm-cache') });
  const run = path.join(bin, 'run');
  fs.writeFileSync(
    run,
    `#!/bin/sh\n# Runs a command in the world's project with only these variables set.\ncd ${quote(at('project'))} || exit 1\nexec env -i ${Object.entries(env)
      .map(([name, value]) => `${name}=${quote(value)}`)
      .join(' ')} "$@"\n`,
  );
  fs.chmodSync(run, 0o755);

  const inWorld = (...args: string[]): string => execFileSync(run, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

  const seed = (repo: string, title: string): void => {
    fs.writeFileSync(path.join(repo, 'README.md'), `# ${title}\n`);
    inWorld('git', '-C', repo, 'add', 'README.md');
    inWorld('git', '-C', repo, 'commit', '--quiet', '-m', 'init');
  };

  inWorld('git', 'init', '--quiet', '--bare', team);
  const teamSeed = path.join(tmp, 'team-seed');
  inWorld('git', 'init', '--quiet', teamSeed);
  seed(teamSeed, 'World team');
  inWorld('git', '-C', teamSeed, 'push', '--quiet', TEAM_URL, 'main');
  fs.rmSync(teamSeed, { recursive: true, force: true });
  inWorld('git', '-C', at('project'), 'init', '--quiet');
  seed(at('project'), 'World project');

  const world: World = {
    runId,
    env,
    dir,
    project: at('project'),
    team,
    home: at('home'),
    tmp,
    logs: at('logs'),
    bin,
    build: {
      commit,
      dirty: status.length > 0,
      version: packed.version,
      tarball,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
      node: process.version,
    },
    createdAt: new Date().toISOString(),
    baseline: { teamRefs: teamRefs(team), checkoutStatus: status, files: worldFiles({ home: at('home'), project: at('project') }) },
  };

  saveWorld(world);

  const installed = inWorld('teamai', '--version').trim();

  if (installed !== world.build.version) {
    throw new Error(`The world's teamai reports ${installed}, but the tarball is ${world.build.version}. Make a new world.`);
  }

  return world;
}

function saveWorld(world: World): void {
  fs.writeFileSync(path.join(world.dir, 'world.json'), `${JSON.stringify(world, null, 2)}\n`);
}

/** Waits about `ms` milliseconds, synchronously: world.json's lock is held for one read and one write only. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `change` of world.json as it is on disk now, under world.json.lock, so a change another command of the world
 * wrote since this one loaded it is kept; answers the world written. Every write after `createWorld` goes through it.
 */
export function updateWorld(world: Pick<World, 'dir'>, change: (fresh: World) => World): World {
  return rewriteLocked(path.join(world.dir, 'world.json'), (text) => {
    const next = change(WorldSchema.parse(JSON.parse(text ?? '')));

    return { value: next, text: `${JSON.stringify(next, null, 2)}\n` };
  });
}

/**
 * Rewrites `file` from its text as it is on disk now (undefined when there is none) under `<file>.lock`, through a
 * rename, so two commands of the world never lose each other's change or read a half-written file; answers `value`.
 * A live holder past `waitMs` (30 s) is an error that names it, as is a break file a dead command left.
 */
export function rewriteLocked<T>(file: string, rewrite: (text: string | undefined) => { value: T; text: string }, { waitMs = 30_000 }: { waitMs?: number } = {}): T {
  const lock = `${file}.lock`;
  const started = Date.now();

  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      const holder = lockHolder(lock);

      if (holder === undefined) continue;

      if (Date.now() - started >= waitMs) throw new Error(`${lock} is held by process ${holder} for ${waitMs / 1000} s. If no command of the world runs, remove that file and ${lock}.break if it is there.`, { cause: error });

      // A holder that died leaves its lock: no write of it can still come.
      if (Number.isInteger(holder) && signalPid(holder, 0) === 'gone') breakDeadLock(lock, holder);
      else pause(20);
    }
  }

  try {
    const { value, text } = rewrite(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
    const written = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(written, text);
    fs.renameSync(written, file);

    return value;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** The process `lock` names, or undefined once its holder let it go. */
function lockHolder(lock: string): number | undefined {
  try {
    return Number(fs.readFileSync(lock, 'utf8'));
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Removes `lock` while it still names `dead`, under `<lock>.break`, so of two commands that saw the same dead holder,
 * the second never removes the lock the first took since.
 */
function breakDeadLock(lock: string, dead: number): void {
  const breaking = `${lock}.break`;

  try {
    fs.writeFileSync(breaking, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
    pause(20);

    return;
  }

  try {
    if (lockHolder(lock) === dead) fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(breaking, { force: true });
  }
}

/** Stops a verb that would act in `world` once cleanup removed its files. */
export function refuseCleaned(world: Pick<World, 'runId' | 'cleanedAt'>): void {
  if (world.cleanedAt !== undefined) throw new Error(`World ${world.runId} was cleaned up at ${world.cleanedAt}. Make a new one.`);
}

/** Records, once, that a runtime outside teamai's process ran in `world`, read fresh so no other change to world.json is lost. */
export function markDriverSeen(world: Pick<World, 'runId' | 'driverSeen'>): void {
  if (world.driverSeen === true) return;
  updateWorld(loadWorld(world.runId), (fresh) => ({ ...fresh, driverSeen: true }));
}

/** Each TMPDIR of `world` outside its directory, its own and each member's, by whose it is: what cleanup removes besides world.dir. */
export function tmpDirsOutside(world: Pick<World, 'dir' | 'tmp' | 'members'>) {
  return [{ tmp: world.tmp, member: undefined }, ...(world.members ?? []).map((each) => ({ tmp: each.tmp, member: each.name }))].filter(({ tmp }) => {
    const relative = path.relative(world.dir, tmp);

    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
}

export function loadWorld(runId: string | undefined): World {
  if (!runId) throw new Error('Name the world: every verb after `world` takes its run id first. List them with `npm run -s verify -- dir --all`.');

  if (!/^\d{8}T\d{6}-[0-9a-f]{6}$/.test(runId)) throw new Error(`${runId} is not a run id. List them with \`npm run -s verify -- dir --all\`.`);
  const file = path.join(WORLDS_ROOT, runId, 'world.json');

  if (!fs.existsSync(file)) throw new Error(`No world ${runId} under ${WORLDS_ROOT}. Make one with \`npm run verify:world\`.`);

  let json: unknown;

  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} cannot be read as JSON (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }

  const parsed = WorldSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(`${file} is not a world.json this harness reads (${z.prettifyError(parsed.error).replaceAll('\n', ' ')}), such as one an older harness wrote. Clean it up with the harness that made it, or remove ${path.dirname(file)}; make a new world with \`npm run verify:world\`.`);
  }

  const world = parsed.data;

  // cleanup empties world.dir, so it must be this run's directory and nothing else.
  if (world.dir !== path.join(fs.realpathSync.native(WORLDS_ROOT), runId)) throw new Error(`${file} names ${world.dir}, which is not world ${runId}'s directory.`);

  // cleanup removes each TMPDIR outside world.dir too, so one there must be the one made for this run or member.
  for (const { tmp, member } of tmpDirsOutside(world)) {
    if (tmp !== worldTmpDir({ root: shortTmpRoot(), runId, member })) throw new Error(`${file} names ${tmp} as a TMPDIR, which is not one of world ${runId}'s own: cleanup would remove it.`);
  }

  return world;
}

const CleanedUpSchema = z.looseObject({ cleanedAt: z.string() });

/** Whether world.json `file` says its world was cleaned up, whichever harness wrote it: such a world is evidence only. */
function isCleanedUp(file: string): boolean {
  try {
    return CleanedUpSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8'))).success;
  } catch {
    return false;
  }
}

/** Every world not cleaned up, and each folder whose world.json cannot be loaded, with why: one never hides the others. */
export function liveWorlds() {
  const worlds: World[] = [];
  const skipped: Array<{ name: string; why: string }> = [];

  for (const name of fs.existsSync(WORLDS_ROOT) ? fs.readdirSync(WORLDS_ROOT).toSorted() : []) {
    if (!fs.existsSync(path.join(WORLDS_ROOT, name, 'world.json')) || isCleanedUp(path.join(WORLDS_ROOT, name, 'world.json'))) continue;

    try {
      const world = loadWorld(name);

      if (world.cleanedAt === undefined) worlds.push(world);
    } catch (error) {
      skipped.push({ name, why: error instanceof Error ? error.message : String(error) });
    }
  }

  return { worlds, skipped };
}

/** Programs a member runs on their own: what one of them writes is theirs, such as a tool's sessions. A shell may run teamai. */
// sbx keeps its sign-in and its list in HOME: a maintainer's `sh <run> sbx login` is theirs, not teamai's.
const MEMBER_PROGRAMS = new Set([...TOOL_COMMANDS, 'cp', 'mkdir', 'touch', 'git', 'sbx']);

/** git commands that run the hooks teamai installs in a project (post-checkout, post-merge, post-rewrite), which pull. */
const HOOKED_GIT = new Set(['checkout', 'switch', 'clone', 'merge', 'pull', 'rebase', 'worktree', 'am']);

/** The member program `args` runs, past `env` and its assignments, or undefined when teamai may run in it. */
function memberProgramOf(args: readonly string[]): string | undefined {
  const command = args[0] === 'env' ? args.slice(1) : args;
  const at = command.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word));
  const words = at === -1 ? [] : command.slice(at);
  const program = path.basename(words[0] ?? '');

  if (!MEMBER_PROGRAMS.has(program)) return undefined;

  if (program !== 'git') return program;
  // Past git's own options: -C <dir> and -c <name=value> take a value.
  const sub = words.slice(1).find((word, i, rest) => !word.startsWith('-') && !['-C', '-c'].includes(rest[i - 1] ?? ''));

  return sub === undefined || HOOKED_GIT.has(sub) || (sub === 'commit' && words.includes('--amend')) ? undefined : program;
}

const WritersSchema = z.record(z.string(), z.object({ program: z.string(), value: z.string().nullable() }));

export type Writers = z.infer<typeof WritersSchema>;

/** Where the world's own HOME and project keep their writers; a member keeps its own (`Member.writers`). */
export function worldWritersFile(world: Pick<World, 'dir'>): string {
  return path.join(world.dir, 'writers.json');
}

/** For each entry of a HOME and project a member's program changed, the last such program and what it left there. */
export function loadWriters(file: string): Writers {
  return fs.existsSync(file) ? WritersSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : {};
}

/** Records, for each entry a member's program run as `args` changed, that program and what it left there. */
export function recordWriters(file: string, args: readonly string[], before: Record<string, string>, after: Record<string, string>): void {
  const program = memberProgramOf(args);

  if (program === undefined) return;

  rewriteLocked(file, (text) => {
    const writers = text === undefined ? {} : WritersSchema.parse(JSON.parse(text));

    for (const entry of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[entry] !== after[entry]) writers[entry] = { program, value: after[entry] ?? null };
    }

    return { value: undefined, text: `${JSON.stringify(writers, null, 2)}\n` };
  });
}

/** Writes the next logs/<n>-<name>.log of a command and returns its path. */
export function writeCommandLog(world: Pick<World, 'logs'>, args: readonly string[], output: string, status: number | null): string {
  const name = path.basename(args[0] ?? 'command').replace(/[^\w.-]/g, '_');
  const taken = new Set(fs.readdirSync(world.logs).map((log) => /^(\d+)-/.exec(log)?.[1]));

  // Two commands ending together count the same logs; no log overwrites another, though two of different names may share a number.
  for (let n = taken.size + 1; ; n += 1) {
    if (taken.has(String(n))) continue;
    const file = path.join(world.logs, `${n}-${name}.log`);

    try {
      fs.writeFileSync(file, `$ ${args.join(' ')}\n${output}exit ${status ?? 'signal'}\n`, { flag: 'wx' });

      return file;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
    }
  }
}

/**
 * Runs a command in the world through bin/run and waits for it, its output shown and kept in logs/<n>-<name>.log. The
 * agent wait budget measures through it: nothing else runs beside the command. The verbs run through target.ts.
 */
export function runInWorld(world: World, args: readonly string[]): number {
  refuseCleaned(world);
  const before = worldFiles(world);
  const result = spawnSync(path.join(world.bin, 'run'), args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1024 ** 3 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  writeCommandLog(world, args, `${result.stdout ?? ''}${result.stderr ?? ''}`, result.status);
  recordWriters(worldWritersFile(world), args, before, worldFiles(world));

  return result.status ?? 1;
}
