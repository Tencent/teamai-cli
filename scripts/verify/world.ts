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
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORLDS_ROOT = path.join(os.tmpdir(), 'teamai-verify');

/** teamai takes only https or ssh team repo URLs, so the world's git maps this one onto its bare repo. */
export const TEAM_URL = 'https://teamai.test/team/repo.git';

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

/** Every entry under the world's HOME and project: a file's sha256, `dir`, or a symlink's target; a git config file is `git config` and one entry per setting. */
export function worldFiles(world: Pick<World, 'home' | 'project'>) {
  const files: Record<string, string> = {};

  const walk = (root: string, label: string, rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      const full = path.join(root, child);

      if (label === 'project' && GIT_OWN.has(child)) continue;

      const settings = entry.isFile() && GIT_CONFIG.test(child) ? gitConfigSettings(`${label}/${child}`, full) : undefined;

      if (entry.isSymbolicLink()) files[`${label}/${child}`] = `-> ${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        files[`${label}/${child}`] = 'dir';
        walk(root, label, child);
      } else if (settings !== undefined) {
        files[`${label}/${child}`] = 'git config';
        Object.assign(files, settings);
      } else files[`${label}/${child}`] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };

  walk(world.home, 'home', '');
  walk(world.project, 'project', '');

  return files;
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

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const TOOL_COMMANDS = ['claude', 'codex', 'codebuddy', 'opencode'];

/** Where the host finds a command, or undefined when it has none. */
function hostCommand(name: string): string | undefined {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();

  return found === '' ? undefined : found;
}

/** The only variables a world's commands get. Anything else, a tool home or a teamai setting, must be set on the command line. */
function worldEnv(home: string, tmp: string, bin: string, fakes: string, npmCache: string) {
  const commands = ['git', ...TOOL_COMMANDS].flatMap((name) => hostCommand(name) ?? []);
  const search = [fakes, bin, path.dirname(process.execPath), ...commands.map((command) => path.dirname(command)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

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

export function createWorld(): World {
  if (process.platform === 'win32') throw new Error('A world needs a POSIX shell; Windows is not supported. Say so in the PR instead.');
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(WORLDS_ROOT, { recursive: true });
  const dir = path.join(fs.realpathSync.native(WORLDS_ROOT), runId);

  // Before world.json exists neither cleanup route can find the directory.
  try {
    return buildWorld(runId, dir);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function buildWorld(runId: string, dir: string): World {
  const at = (name: string): string => path.join(dir, name);

  for (const name of ['home', 'tmp', 'pkg', 'install', 'project', 'logs']) fs.mkdirSync(at(name), { recursive: true });

  const commit = git(REPO_ROOT, 'rev-parse', 'HEAD');
  const status = checkoutStatus();
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] });

  const packed = z
    .array(z.object({ filename: z.string(), version: z.string() }))
    .parse(JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', at('pkg')], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })))[0];

  const tarball = path.join(at('pkg'), packed.filename);
  execFileSync('npm', ['install', '--prefix', at('install'), '--no-audit', '--no-fund', '--prefer-offline', '--silent', tarball], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const team = at('team.git');
  fs.writeFileSync(
    path.join(at('home'), '.gitconfig'),
    `[user]\n\tname = TeamAI World\n\temail = world@teamai.test\n[init]\n\tdefaultBranch = main\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[url "file://${team}"]\n\tinsteadOf = ${TEAM_URL}\n`,
  );
  const bin = at('bin');
  fs.mkdirSync(bin);
  writeFakeGh(at('fakes'));
  const env = worldEnv(at('home'), at('tmp'), path.join(at('install'), 'node_modules', '.bin'), at('fakes'), at('npm-cache'));
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
  const teamSeed = path.join(at('tmp'), 'team-seed');
  inWorld('git', 'init', '--quiet', teamSeed);
  seed(teamSeed, 'World team');
  inWorld('git', '-C', teamSeed, 'push', '--quiet', TEAM_URL, 'main');
  fs.rmSync(teamSeed, { recursive: true, force: true });
  inWorld('git', '-C', at('project'), 'init', '--quiet');
  seed(at('project'), 'World project');

  const world: World = {
    runId,
    dir,
    project: at('project'),
    team,
    home: at('home'),
    tmp: at('tmp'),
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

export function saveWorld(world: World): void {
  fs.writeFileSync(path.join(world.dir, 'world.json'), `${JSON.stringify(world, null, 2)}\n`);
}

export function loadWorld(runId: string | undefined): World {
  if (!runId) throw new Error('Name the world: every verb after `world` takes its run id first. List them with `npm run -s verify -- dir --all`.');

  if (!/^\d{8}T\d{6}-[0-9a-f]{6}$/.test(runId)) throw new Error(`${runId} is not a run id. List them with \`npm run -s verify -- dir --all\`.`);
  const file = path.join(WORLDS_ROOT, runId, 'world.json');

  if (!fs.existsSync(file)) throw new Error(`No world ${runId} under ${WORLDS_ROOT}. Make one with \`npm run verify:world\`.`);

  const world = WorldSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

  // cleanup empties world.dir, so it must be this run's directory and nothing else.
  if (world.dir !== path.join(fs.realpathSync.native(WORLDS_ROOT), runId)) throw new Error(`${file} names ${world.dir}, which is not world ${runId}'s directory.`);

  return world;
}

export function liveWorlds(): World[] {
  if (!fs.existsSync(WORLDS_ROOT)) return [];

  return fs
    .readdirSync(WORLDS_ROOT)
    .filter((name) => fs.existsSync(path.join(WORLDS_ROOT, name, 'world.json')))
    .map((name) => loadWorld(name))
    .filter((world) => world.cleanedAt === undefined);
}

/** Programs a member runs on their own: what one of them writes is theirs, such as a tool's sessions. A shell may run teamai. */
const MEMBER_PROGRAMS = new Set([...TOOL_COMMANDS, 'cp', 'mkdir', 'touch', 'git']);

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

const Writer = z.object({ program: z.string(), value: z.string().nullable() });

export type Writers = Record<string, z.infer<typeof Writer>>;

function writersFile(world: World): string {
  return path.join(world.dir, 'writers.json');
}

/** For each entry of the world's HOME and project a member's program changed, the last such program and what it left there. */
export function loadWriters(world: World): Writers {
  const file = writersFile(world);

  return fs.existsSync(file) ? z.record(z.string(), Writer).parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : {};
}

function recordWriters(world: World, args: readonly string[], before: Record<string, string>, after: Record<string, string>): void {
  const program = memberProgramOf(args);

  if (program === undefined) return;
  const writers = loadWriters(world);

  for (const entry of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[entry] !== after[entry]) writers[entry] = { program, value: after[entry] ?? null };
  }

  fs.writeFileSync(writersFile(world), `${JSON.stringify(writers, null, 2)}\n`);
}

/** Runs a command in the world, its output shown and kept in logs/<n>-<name>.log. */
export function runInWorld(world: World, args: readonly string[]): number {
  if (world.cleanedAt !== undefined) throw new Error(`World ${world.runId} was cleaned up at ${world.cleanedAt}. Make a new one.`);
  const before = worldFiles(world);
  const result = spawnSync(path.join(world.bin, 'run'), args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1024 ** 3 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const n = fs.readdirSync(world.logs).length + 1;
  const name = path.basename(args[0] ?? 'command').replace(/[^\w.-]/g, '_');
  fs.writeFileSync(
    path.join(world.logs, `${n}-${name}.log`),
    `$ ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}exit ${result.status ?? 'signal'}\n`,
  );
  recordWriters(world, args, before, worldFiles(world));

  return result.status ?? 1;
}
