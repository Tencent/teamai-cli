/**
 * The agent wait budget: what a member's agent waits on in teamai's hooks and pulls, counted as the processes they
 * start and the files they write in a verify world, on a first run and a second. The budget is those counts, not
 * elapsed time: the same hook took twice as long in one world as in another while every count stayed the same. Each
 * row also records how long the tool waited in that one run (`waitedMs`), for reference: it is never compared.
 *
 *   node scripts/agent-wait-budget.mjs                                     the budget as JSON; exit 1 when an invariant breaks
 *   node scripts/agent-wait-budget.mjs --compare <main.json> [<head.json>] a Markdown report of the change from main
 *                                                                          (without <head.json> it measures this checkout, and exits 1 as above)
 *   node scripts/agent-wait-budget.mjs --keep                              leave the world for debugging; its run id goes to stderr
 *
 * A process is waited when the tool cannot go on until it ends, and after when it runs once the hook has returned
 * (teamai's detached background pass) or when the tool does not wait for the hook at all (an `async` entry).
 * git's trace2 counts every git process, the login shell's too; agent-wait-preload.cjs counts Node processes and tags
 * what runs after, which trace2 reports per process.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runLedger } from './verify/ledger.js';
import { createWorld, REPO_ROOT, runInWorld, saveWorld, TEAM_URL, worldFiles, type World } from './verify/world.js';

const PRELOAD = path.join(REPO_ROOT, 'scripts', 'agent-wait-preload.cjs');

/** The Claude Code the measurer's fake reports: at or above every version floor a hook form depends on. */
const FAKE_CLAUDE_VERSION = '2.1.322';

const NOT_MEASURED = 'a process other than git, Node and gh that the hook command\'s own shell starts (its login shell), Windows, tools other than Claude Code, user scope, self mode, HTTP mode, teamai\'s git hook on post-merge and post-rewrite, git worktree add when the team repo was last fetched more than 24 hours ago (it waits on one inline pull by design), a submodule, a workspace with workspace children, a bare repo';

const RowSchema = z.object({
  row: z.string(),
  run: z.enum(['first', 'second']),
  gitWaited: z.number().int(),
  gitAfter: z.number().int(),
  nodeWaited: z.number().int(),
  nodeAfter: z.number().int(),
  fastPath: z.boolean(),
  filesWritten: z.number().int(),
  remote: z.array(z.string()),
  ghWaited: z.number().int(),
  ghAfter: z.number().int(),
  otherWaited: z.number().int(),
  otherAfter: z.number().int(),
  gitByCommand: z.record(z.string(), z.object({ waited: z.number().int(), after: z.number().int() })),
  otherByCommand: z.record(z.string(), z.object({ waited: z.number().int(), after: z.number().int() })),
  /** Milliseconds the tool waited on the row's commands in this one run; not a count, so never compared. */
  waitedMs: z.number().int().nonnegative(),
});

export const AgentWaitBudgetSchema = z.object({
  commit: z.string(),
  platform: z.string(),
  git: z.string(),
  tool: z.literal('claude'),
  toolVersion: z.string(),
  rows: z.array(RowSchema),
});

export type AgentWaitBudget = z.infer<typeof AgentWaitBudgetSchema>;

type Row = z.infer<typeof RowSchema>;

const COUNTS = ['gitWaited', 'gitAfter', 'nodeWaited', 'nodeAfter', 'ghWaited', 'ghAfter', 'otherWaited', 'otherAfter', 'filesWritten'] as const;
const WAITED = ['gitWaited', 'nodeWaited', 'ghWaited', 'otherWaited'] as const;
const PROCESSES = ['gitWaited', 'gitAfter', 'nodeWaited', 'nodeAfter', 'ghWaited', 'ghAfter', 'otherWaited', 'otherAfter'] as const;

type Count = (typeof COUNTS)[number];

const COUNT_LABELS: Record<Count, string> = {
  gitWaited: 'git processes',
  gitAfter: 'git processes after',
  nodeWaited: 'Node processes',
  nodeAfter: 'Node processes after',
  ghWaited: 'gh calls',
  ghAfter: 'gh calls after',
  otherWaited: 'other processes',
  otherAfter: 'other processes after',
  filesWritten: 'files written',
};

// ───────────────────────────── instruments ─────────────────────────────

// Only the events read here: a process's argv, the variables GIT_TRACE2_ENV_VARS names, and its worktree.
const Trace2EventSchema = z.union([
  z.object({ event: z.literal('start'), sid: z.string(), argv: z.array(z.string()) }),
  z.object({ event: z.literal('def_param'), sid: z.string(), param: z.string(), value: z.string() }),
  z.object({ event: z.literal('def_repo'), sid: z.string(), worktree: z.string().optional() }),
  z.object({ event: z.string(), sid: z.string() }),
]);

const NodeRecordSchema = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('start'), pid: z.number().int(), argv: z.array(z.string()), side: z.enum(['waited', 'after']) }),
  z.object({ ev: z.literal('spawn'), pid: z.number().int(), child: z.number().int().nullable(), command: z.array(z.string()), detached: z.boolean() }),
]);

const readLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

const nodeRecords = (file: string) => readLines(file).map((line) => NodeRecordSchema.parse(JSON.parse(line)));

type NodeRecord = z.infer<typeof NodeRecordSchema>;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const NODE_BINARY = /^node(js)?(-\d+)?(\.exe)?$/;

/** An executable's name; a shell with `-c` adds the first word of its script, and `execSync`'s one string is a `sh -c` script. */
function processName(command: readonly string[]): string {
  const [file = '', ...args] = command;

  if (args.length === 0 && /\s/.test(file.trim())) return `sh -c ${file.trim().split(/\s+/)[0]}`;
  const name = path.basename(file);
  const flag = SHELLS.has(name) ? args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
  const script = flag === -1 ? undefined : args[flag + 1];

  return script === undefined ? name : `${name} ${args[flag]} ${script.trim().split(/\s+/)[0] ?? ''}`;
}

/**
 * The processes a measured Node started that are not git, gh or Node, by side and by name. A detached one runs after the
 * hook returns; any other runs on the side of the Node that started it.
 */
export function otherProcesses(records: readonly NodeRecord[]) {
  const starts = new Map(records.flatMap((record) => (record.ev === 'start' ? [[record.pid, record] as const] : [])));
  const byCommand: Record<string, { waited: number; after: number }> = {};
  const counts = { waited: 0, after: 0 };

  for (const record of records) {
    if (record.ev !== 'spawn') continue;
    const name = processName(record.command);
    const binary = path.basename(record.command[0] ?? '');

    if (binary === 'git' || binary === 'gh' || NODE_BINARY.test(binary) || (record.child !== null && starts.has(record.child))) continue;
    const side = record.detached ? 'after' : (starts.get(record.pid)?.side ?? 'waited');
    counts[side]++;
    const tally = byCommand[name] ?? { waited: 0, after: 0 };
    tally[side]++;
    byCommand[name] = tally;
  }

  return { ...counts, byCommand: Object.fromEntries(Object.entries(byCommand).sort(([left], [right]) => left.localeCompare(right))) };
}

interface GitProcess {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly side: 'waited' | 'after';
  readonly fromNode: boolean;
  readonly worktree: string | undefined;
}

/** The git processes teamai or a shell started: trace2 marks one git started by another git with a `/` in its sid. */
function gitProcesses(file: string): GitProcess[] {
  const bySid = new Map<string, { argv: string[]; params: Map<string, string>; worktree?: string }>();

  for (const line of readLines(file)) {
    const event = Trace2EventSchema.parse(JSON.parse(line));

    if (event.sid.includes('/')) continue;
    const record = bySid.get(event.sid) ?? { argv: [], params: new Map<string, string>() };
    bySid.set(event.sid, record);

    if ('argv' in event) record.argv = event.argv;

    if ('param' in event) record.params.set(event.param, event.value);

    if ('worktree' in event) record.worktree = event.worktree;
  }

  return [...bySid.entries()].map(([sid, record]) => ({
    pid: Number.parseInt(sid.split('-P').at(-1) ?? '', 16),
    argv: record.argv,
    side: record.params.get('AGENT_WAIT_SIDE') === 'after' ? 'after' : 'waited',
    fromNode: record.params.get('AGENT_WAIT_FROM') === 'node',
    worktree: record.worktree,
  }));
}

const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);

function subcommand(argv: readonly string[]): string {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index] ?? '';

    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) index++;
    else if (!arg.startsWith('-')) return arg;
    else if (arg === '--version') return arg;
  }

  return '(none)';
}

const REMOTE_GIT = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone']);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

const sizeOf = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).size : 0);

/** Waits until every process the logs name has ended and the logs stopped growing for three polls. Ends nothing. */
function waitForBackground(files: readonly string[], logs: { node: string; trace2: string }): boolean {
  const deadline = Date.now() + 60_000;
  let stable = 0;
  let lastSize = -1;

  while (Date.now() < deadline) {
    const pids = new Set([
      ...nodeRecords(logs.node).flatMap((record) => (record.ev === 'start' ? [record.pid] : record.child === null ? [] : [record.child])),
      ...gitProcesses(logs.trace2).map((git) => git.pid),
    ]);

    const anyAlive = [...pids].some((pid) => Number.isInteger(pid) && isAlive(pid));
    const size = files.reduce((sum, file) => sum + sizeOf(file), 0);
    stable = !anyAlive && size === lastSize ? stable + 1 : 0;
    lastSize = size;

    if (stable >= 3) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }

  return false;
}

// ───────────────────────────── the world ─────────────────────────────

const ClaudeSettingsSchema = z.object({
  hooks: z
    .record(
      z.string(),
      z.array(z.object({ matcher: z.string().optional(), hooks: z.array(z.object({ command: z.string().optional(), async: z.boolean().optional() })) })),
    )
    .default({}),
});

/** Claude Code's rule: none, `""` or `*` matches all; a plain list of names matches exactly; anything else is a regex. */
function matcherMatches(matcher: string | undefined, subject: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;

  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === subject);

  return new RegExp(matcher).test(subject);
}

interface HookCommand {
  readonly command: string;
  readonly unwaited: boolean;
}

/** The teamai entries Claude Code runs for this event and payload, read from the world's user settings. */
function hookCommands(world: World, event: string, subject: string | undefined): HookCommand[] {
  const settings = ClaudeSettingsSchema.parse(JSON.parse(fs.readFileSync(path.join(world.home, '.claude', 'settings.json'), 'utf8')));

  return (settings.hooks[event] ?? [])
    .filter((entry) => subject === undefined || matcherMatches(entry.matcher, subject))
    .flatMap((entry) => entry.hooks)
    .flatMap((hook) => (hook.command?.includes('teamai hook-dispatch') ? [{ command: hook.command, unwaited: hook.async === true }] : []));
}

function inWorld(world: World, args: readonly string[]): void {
  const status = runInWorld(world, args);

  if (status !== 0) throw new Error(`\`${args.join(' ')}\` exited ${status} in world ${world.runId}; see ${world.logs}`);
}

function worldOutput(world: World, args: readonly string[]): string {
  const result = spawnSync(path.join(world.bin, 'run'), args, { encoding: 'utf8', input: '' });

  if (result.status !== 0) throw new Error(`\`${args.join(' ')}\` exited ${result.status ?? 'on a signal'} in world ${world.runId}: ${result.stderr}`);

  return result.stdout.trim();
}

const PROFILE_MARK = '# agent-wait-budget: removed before the ledger';

/**
 * A login shell resets PATH (Debian's /etc/profile, macOS path_helper), so without this line a hook would not find
 * the world's teamai on Linux and would step over its fakes on both. It stands for the line a Node version manager writes.
 */
function profileLine(world: World): string {
  return `PATH='${worldOutput(world, ['sh', '-c', 'printf %s "$PATH"']).replace(/'/g, `'\\''`)}'; export PATH ${PROFILE_MARK}\n`;
}

function removeProfileLine(world: World): void {
  const profile = path.join(world.home, '.profile');

  if (!fs.existsSync(profile)) return;
  const lines = fs.readFileSync(profile, 'utf8').split('\n');
  fs.writeFileSync(profile, lines.filter((line) => !line.endsWith(PROFILE_MARK)).join('\n'));
}

/** Everything a first run must not find: the world's TMPDIR (Node's compile cache, teamai's git answers) and each fetch stamp. */
function clearCaches(world: World): void {
  for (const name of fs.readdirSync(world.tmp)) fs.rmSync(path.join(world.tmp, name), { recursive: true, force: true });

  for (const stamp of fetchStamps(world)) fs.rmSync(stamp, { force: true });
}

function fetchStamps(world: World): string[] {
  const projects = path.join(world.home, '.teamai', 'projects');
  const scoped = fs.existsSync(projects) ? fs.readdirSync(projects).map((slug) => path.join(projects, slug, 'last-fetch.json')) : [];

  return [path.join(world.home, '.teamai', 'last-fetch.json'), ...scoped].filter((stamp) => fs.existsSync(stamp));
}

const FetchStampSchema = z.object({ lastFetch: z.string() }).passthrough();

/** Sets the workspace scope's team fetch stamp to `ageMs` ago, writing it when a cold step removed it. */
function stampFetch(world: World, ageMs: number): void {
  const projects = path.join(world.home, '.teamai', 'projects');

  for (const slug of fs.readdirSync(projects)) {
    const stamp = path.join(projects, slug, 'last-fetch.json');
    const current = fs.existsSync(stamp) ? FetchStampSchema.parse(JSON.parse(fs.readFileSync(stamp, 'utf8'))) : {};
    fs.writeFileSync(stamp, `${JSON.stringify({ ...current, lastFetch: new Date(Date.now() - ageMs).toISOString() }, null, 2)}\n`);
  }
}

const UpdateStateSchema = z.record(z.string(), z.unknown());

/** The Stop hook asks the npm registry unless the last update check is recent and names a version. */
function pinUpdateCheck(world: World): void {
  const file = path.join(world.home, '.teamai', 'state.json');
  const state = fs.existsSync(file) ? UpdateStateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : {};
  fs.writeFileSync(file, `${JSON.stringify({ ...state, lastUpdateCheck: new Date().toISOString(), availableUpdate: world.build.version }, null, 2)}\n`);
}

/** Answers `--version` only, so a hook form that depends on Claude Code's version is the one measured without it installed. */
function writeFakeClaude(world: World): void {
  const claude = path.join(world.dir, 'fakes', 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\nif [ "$1" = --version ]; then echo '${FAKE_CLAUDE_VERSION} (Claude Code)'; exit 0; fi\necho 'claude: not available in a world' >&2\nexit 1\n`);
  fs.chmodSync(claude, 0o755);
}

// ───────────────────────────── one measured run ─────────────────────────────

interface Measured {
  readonly counts: Row;
  readonly lines: readonly string[];
  readonly gits: readonly GitProcess[];
}

interface Run {
  readonly row: string;
  readonly run: 'first' | 'second';
  readonly cwd: string;
  /** A hook: its event in Claude Code's settings, what its matcher is tested on, and its JSON payload. Otherwise a command run as is. */
  readonly hook?: { readonly event: string; readonly subject?: string; readonly payload: string };
  readonly command?: readonly string[];
  readonly cold?: boolean;
  readonly before?: () => void;
  /** Checked the moment the command returns, before its background pass ends. */
  readonly onReturn?: () => string | undefined;
}

interface Todo {
  readonly content: string;
  readonly status: string;
  readonly activeForm: string;
}

/** What Claude Code adds to a hook's payload for each event measured here. */
type HookPayloadFields =
  | { readonly source: 'startup' }
  | { readonly prompt: string }
  | { readonly stop_hook_active: boolean }
  | { readonly tool_name: 'Read'; readonly tool_input: { readonly file_path: string }; readonly tool_response: { readonly content: string } }
  | { readonly tool_name: 'TodoWrite'; readonly tool_input: { readonly todos: readonly Todo[] }; readonly tool_response: { readonly oldTodos: readonly Todo[]; readonly newTodos: readonly Todo[] } };

const GIT_OWN_FILES = /\/\.git\/(objects|logs)(\/|$)|\/\.git\/index$/;

function measure(world: World, dir: string, run: Run, failures: string[]): Measured {
  fs.mkdirSync(dir, { recursive: true });
  const logs = { node: path.join(dir, 'node.log'), trace2: path.join(dir, 'trace2.log') };
  const ghLog = path.join(world.dir, 'fakes', 'gh.log');
  const debugLog = path.join(world.home, '.teamai', 'debug.log');
  const debugFrom = sizeOf(debugLog);
  const ghFrom = sizeOf(ghLog);
  const filesBefore = worldFiles(world);
  const commands = run.hook ? hookCommands(world, run.hook.event, run.hook.subject).map(({ command, unwaited }) => ({ argv: ['sh', '-c', command], unwaited })) : [{ argv: [...(run.command ?? [])], unwaited: false }];

  if (commands.length === 0) failures.push(`${run.row}, ${run.run} run: no teamai entry in settings.json for ${run.hook?.event ?? 'the command'}`);
  const instruments = [`GIT_TRACE2_EVENT=${logs.trace2}`, 'GIT_TRACE2_ENV_VARS=AGENT_WAIT_SIDE,AGENT_WAIT_FROM', `AGENT_WAIT_NODE_LOG=${logs.node}`, `NODE_OPTIONS=--require ${JSON.stringify(PRELOAD)}`];
  const input = run.hook?.payload ?? '';
  let waitedMs = 0;

  for (const { argv, unwaited } of commands) {
    const env = unwaited ? [...instruments, 'AGENT_WAIT_SIDE=after'] : instruments;
    const started = performance.now();
    const ran = spawnSync(path.join(world.bin, 'run'), ['env', ...env, 'sh', '-c', 'cd "$1" || exit 97; shift; exec "$@"', 'agent-wait', run.cwd, ...argv], { input, encoding: 'utf8', maxBuffer: 1024 ** 3 });

    // The tool does not wait for an unwaited entry.
    if (!unwaited) waitedMs += performance.now() - started;

    // A command that failed is not the command the row names, whatever it left behind.
    if (ran.error || ran.status !== 0) {
      const how = ran.error ? `did not start: ${ran.error.message}` : ran.signal ? `was ended by ${ran.signal}` : `exited ${ran.status}`;
      failures.push(`${run.row}, ${run.run} run: the measured command ${how}`);
    }
  }

  const returned = run.onReturn?.();

  if (returned !== undefined) failures.push(`${run.row}, ${run.run} run: ${returned}`);

  if (!waitForBackground([logs.node, logs.trace2, ghLog], logs)) throw new Error(`${run.row}, ${run.run} run: its processes did not end within 60 s; see ${dir}`);

  const command = run.command ?? [];
  let skippedCommand = run.hook !== undefined || command[0] !== 'git';

  const gits = gitProcesses(logs.trace2).filter((git) => {
    if (skippedCommand || git.fromNode || JSON.stringify(git.argv.slice(1)) !== JSON.stringify(command.slice(1))) return true;
    skippedCommand = true;

    return false;
  });

  const nodes = nodeRecords(logs.node);
  const starts = nodes.flatMap((record) => (record.ev === 'start' ? [record] : []));
  const spawns = nodes.flatMap((record) => (record.ev === 'spawn' ? [record] : []));
  const gh = fs.existsSync(ghLog) ? fs.readFileSync(ghLog).subarray(ghFrom).toString('utf8').split('\n').filter(Boolean) : [];
  const lines = fs.existsSync(debugLog) ? fs.readFileSync(debugLog).subarray(debugFrom).toString('utf8').split('\n').filter((line) => line.includes('[hook-dispatch]')) : [];
  const filesAfter = worldFiles(world);
  const written = Object.keys(filesAfter).filter((entry) => filesAfter[entry] !== filesBefore[entry] && entry !== 'home/.teamai/debug.log' && !GIT_OWN_FILES.test(`/${entry}`));
  fs.writeFileSync(path.join(dir, 'files-written.txt'), written.map((entry) => `${entry}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'git.txt'), gits.map((git) => `${git.side}${git.fromNode ? ' node' : ''}\t${git.argv.slice(1).join(' ')}\n`).join(''));
  const byCommand: Record<string, { waited: number; after: number }> = {};

  for (const git of gits) {
    const name = subcommand(git.argv);
    const tally = byCommand[name] ?? { waited: 0, after: 0 };
    tally[git.side]++;
    byCommand[name] = tally;
  }

  const remote = new Set(gits.map((git) => subcommand(git.argv)).filter((name) => REMOTE_GIT.has(name)));
  const others = otherProcesses(nodes);

  if (spawns.some((record) => /(^|\/)npm(\s|$)/.test(record.command[0] ?? ''))) remote.add('npm');

  if (gh.length > 0) remote.add('gh');

  return {
    counts: {
      row: run.row,
      run: run.run,
      gitWaited: gits.filter((git) => git.side === 'waited').length,
      gitAfter: gits.filter((git) => git.side === 'after').length,
      nodeWaited: starts.filter((start) => start.side === 'waited').length,
      nodeAfter: starts.filter((start) => start.side === 'after').length,
      fastPath: lines.some((line) => line.endsWith(' fast path')),
      filesWritten: written.length,
      remote: [...remote].sort(),
      ghWaited: gh.filter((line) => line.startsWith('waited\t')).length,
      ghAfter: gh.filter((line) => line.startsWith('after\t')).length,
      otherWaited: others.waited,
      otherAfter: others.after,
      gitByCommand: Object.fromEntries(Object.entries(byCommand).sort(([left], [right]) => left.localeCompare(right))),
      otherByCommand: others.byCommand,
      waitedMs: Math.round(waitedMs),
    },
    lines,
    gits,
  };
}

// ───────────────────────────── the scenario ─────────────────────────────

const PULL = ['fetch', 'ls-remote', 'pull'];

/** What each row reaches over the network; a row that starts reaching more is a finding, never a new expectation. */
const EXPECTED_REMOTE = new Map([
  ['pull after init|first', PULL],
  ['pull after init|second', PULL],
  ['pull of a new team commit|first', PULL],
  ['pull of a new team commit|second', PULL],
  ['SessionStart|first', ['fetch', 'gh', 'ls-remote', 'pull', 'push']],
  ['SessionStart|second', ['fetch', 'gh', 'ls-remote']],
  ['SessionStart with a stale fetch|first', ['fetch', 'gh', 'ls-remote', 'pull']],
  ['worktree add, two checkouts|first', [...PULL, 'push']],
  ['worktree add, three checkouts|second', PULL],
  ['worktree add, four checkouts|second', PULL],
  ['SessionStart in a new worktree|first', ['fetch', 'gh', 'ls-remote', 'pull', 'push']],
  ['SessionStart in a new worktree|second', ['fetch', 'gh', 'ls-remote']],
]);

/** Measures one Claude Code session, workspace scope, team repo mode git, from the main checkout and linked worktrees. */
export function measureAgentWait(options: { keep: boolean }) {
  const world = createWorld();
  const failures: string[] = [];
  const scratch = path.join(world.dir, 'scratch');
  const seed = path.join(scratch, 'seed');
  const outside = path.join(world.dir, 'outside');
  const worktree = (name: string) => ({ name, dir: path.join(scratch, name) });
  const hookA = worktree('wt-hook-a');
  const hookB = worktree('wt-hook-b');
  const hookC = worktree('wt-hook-c');
  const tool = worktree('wt-tool');
  const worktrees = [hookA, hookB, hookC, tool];
  console.error(`Agent wait budget: world ${world.runId}`);

  try {
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    writeFakeClaude(world);

    // A pull pushes to the team repo too, so the seed clone catches up first.
    const pushToTeam = (message: string, files: Record<string, string>): void => {
      if (fs.existsSync(seed)) inWorld(world, ['git', '-C', seed, 'pull', '--quiet', '--rebase', 'origin', 'main']);

      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
        fs.writeFileSync(path.join(seed, file), content);
      }

      inWorld(world, ['git', '-C', seed, 'add', '-A']);
      inWorld(world, ['git', '-C', seed, 'commit', '--quiet', '-m', message]);
      inWorld(world, ['git', '-C', seed, 'push', '--quiet', 'origin', 'HEAD:main']);
    };

    inWorld(world, ['git', 'clone', '--quiet', TEAM_URL, seed]);
    pushToTeam('seed: one skill, one rule, members', {
      'skills/probe-skill/SKILL.md': '---\nname: probe-skill\ndescription: Use when measuring what a hook waits on.\n---\n\n# Probe skill\n\nSay "probe".\n',
      'rules/probe-rule.md': '# Probe rule\n\nPrefer small changes.\n',
      'manifest/members.yaml': 'version: 1\nmembers: {}\ndefault: []\n',
    });
    // The MR hint asks gh only for a GitHub origin; nothing may ever fetch it.
    inWorld(world, ['git', '-C', world.project, 'remote', 'add', 'origin', 'https://github.com/teamai-world/project.git']);
    const profile = path.join(world.home, '.profile');
    fs.writeFileSync(profile, profileLine(world) + (fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : ''));
    inWorld(world, ['teamai', 'init', TEAM_URL, '--provider', 'git', '--agent', 'claude']);
    pinUpdateCheck(world);

    if (hookCommands(world, 'SessionStart', undefined).length === 0) throw new Error('teamai init wrote no SessionStart hook into the world\'s ~/.claude/settings.json');

    const transcript = path.join(scratch, 'transcript.jsonl');
    const payload = (session: string, cwd: string, event: string, extra: HookPayloadFields): string => JSON.stringify({ session_id: session, transcript_path: transcript, cwd, hook_event_name: event, ...extra });
    const sessionStart = (session: string, cwd: string) => ({ event: 'SessionStart', subject: 'startup', payload: payload(session, cwd, 'SessionStart', { source: 'startup' }) });
    const read = (session: string, cwd: string) => ({ event: 'PostToolUse', subject: 'Read', payload: payload(session, cwd, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_response: { content: '# World project\n' } }) });
    const todos: readonly Todo[] = [{ content: 'Measure the hooks', status: 'in_progress', activeForm: 'Measuring the hooks' }];
    const todoWrite = (session: string, cwd: string) => ({ event: 'PostToolUse', subject: 'TodoWrite', payload: payload(session, cwd, 'PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos }, tool_response: { oldTodos: [], newTodos: todos } }) });
    const prompt = { event: 'UserPromptSubmit', payload: payload('wait-a', world.project, 'UserPromptSubmit', { prompt: 'fix the failing test' }) };
    const stop = { event: 'Stop', payload: payload('wait-a', world.project, 'Stop', { stop_hook_active: false }) };
    const pull = ['teamai', 'pull'];
    const delivered = (dir: string): boolean => fs.existsSync(path.join(dir, '.claude', 'rules', 'probe-rule.md'));
    const deliveredOnReturn = (dir: string): string | undefined => (delivered(dir) ? undefined : 'the new worktree has no .claude/rules/probe-rule.md when git worktree add returns');
    const worktreeAdd = ({ name, dir }: { name: string; dir: string }): readonly string[] => ['git', '-C', world.project, 'worktree', 'add', '--quiet', dir, '-b', name];

    const runs: Run[] = [
      {
        row: 'pull after init',
        run: 'first',
        cwd: world.project,
        command: pull,
        cold: true,
        onReturn: () => (delivered(world.project) ? undefined : 'the project has no .claude/rules/probe-rule.md after the pull'),
      },
      { row: 'pull after init', run: 'second', cwd: world.project, command: pull },
      {
        row: 'pull of a new team commit',
        run: 'first',
        cwd: world.project,
        command: pull,
        before: () => pushToTeam('change the rule', { 'rules/probe-rule.md': '# Probe rule\n\nPrefer small changes.\n\nSecond revision.\n' }),
      },
      { row: 'pull of a new team commit', run: 'second', cwd: world.project, command: pull },
      { row: 'SessionStart', run: 'first', cwd: world.project, hook: sessionStart('wait-a', world.project), cold: true },
      { row: 'SessionStart', run: 'second', cwd: world.project, hook: sessionStart('wait-a', world.project) },
      { row: 'SessionStart with a stale fetch', run: 'first', cwd: world.project, hook: sessionStart('wait-a', world.project), before: () => stampFetch(world, 120_000) },
      { row: 'UserPromptSubmit', run: 'first', cwd: world.project, hook: prompt, cold: true },
      { row: 'UserPromptSubmit', run: 'second', cwd: world.project, hook: prompt },
      { row: 'PostToolUse Read', run: 'first', cwd: world.project, hook: read('wait-a', world.project), cold: true },
      { row: 'PostToolUse Read', run: 'second', cwd: world.project, hook: read('wait-a', world.project) },
      { row: 'PostToolUse TodoWrite', run: 'first', cwd: world.project, hook: todoWrite('wait-a', world.project), cold: true },
      { row: 'PostToolUse TodoWrite', run: 'second', cwd: world.project, hook: todoWrite('wait-a', world.project) },
      { row: 'Stop', run: 'first', cwd: world.project, hook: stop, cold: true },
      { row: 'Stop', run: 'second', cwd: world.project, hook: stop },
      { row: 'PostToolUse outside any scope', run: 'first', cwd: outside, hook: read('wait-b', outside), cold: true },
      { row: 'PostToolUse outside any scope', run: 'second', cwd: outside, hook: read('wait-b', outside) },
      // Each run makes one more checkout of the project; teamai's git hook then waits on work in every checkout.
      {
        row: 'worktree add, two checkouts',
        run: 'first',
        cwd: world.project,
        command: worktreeAdd(hookA),
        before: () => {
          const named = spawnSync(path.join(world.bin, 'run'), ['git', '-C', world.project, 'config', '--get-regexp', '^hook\\.teamai-'], { encoding: 'utf8' }).stdout;
          const script = path.join(world.project, '.git', 'hooks', 'post-checkout');

          if (named.split('\n').filter((line) => /^hook\.teamai-[a-z-]+\.command /.test(line)).length < 3 && !(fs.existsSync(script) && fs.readFileSync(script, 'utf8').includes('teamai hook-dispatch'))) {
            failures.push('worktree add: teamai\'s git hook is not installed in the project');
          }

          // A member's session start has always fetched within 24 h; the cold step before the rows outside any scope removed the stamp.
          stampFetch(world, 0);
        },
        onReturn: () => deliveredOnReturn(hookA.dir),
      },
      { row: 'worktree add, three checkouts', run: 'second', cwd: world.project, command: worktreeAdd(hookB), onReturn: () => deliveredOnReturn(hookB.dir) },
      { row: 'worktree add, four checkouts', run: 'second', cwd: world.project, command: worktreeAdd(hookC), onReturn: () => deliveredOnReturn(hookC.dir) },
      {
        row: 'PostToolUse in a new worktree',
        run: 'first',
        cwd: tool.dir,
        hook: read('wait-a', tool.dir),
        cold: true,
        before: () => {
          // Neither step runs post-checkout: a worktree a tool made, which no git hook prepared.
          inWorld(world, ['git', '-C', world.project, 'worktree', 'add', '--quiet', '--no-checkout', tool.dir, '-b', tool.name]);
          inWorld(world, ['git', '-C', tool.dir, 'reset', '--hard', '--quiet']);

          if (fs.existsSync(path.join(tool.dir, '.claude'))) failures.push('PostToolUse in a new worktree: the worktree already has .claude before its first hook');
        },
      },
      { row: 'PostToolUse in a new worktree', run: 'second', cwd: tool.dir, hook: read('wait-a', tool.dir) },
      { row: 'SessionStart in a new worktree', run: 'first', cwd: tool.dir, hook: sessionStart('wait-d', tool.dir) },
      { row: 'SessionStart in a new worktree', run: 'second', cwd: tool.dir, hook: sessionStart('wait-d', tool.dir) },
    ];

    const measured = new Map<string, Measured>();

    runs.forEach((run, index) => {
      run.before?.();

      if (run.cold) clearCaches(world);
      const result = measure(world, path.join(scratch, 'measure', `${index + 1}`), run, failures);
      measured.set(`${run.row}|${run.run}`, result);
      console.error(`  ${run.row}, ${run.run} run: git ${result.counts.gitWaited} waited, ${result.counts.gitAfter} after; Node ${result.counts.nodeWaited} waited, ${result.counts.nodeAfter} after; other ${result.counts.otherWaited} waited, ${result.counts.otherAfter} after${result.counts.fastPath ? '; fast path' : ''}; ${result.counts.waitedMs} ms waited`);

      if (run.hook !== undefined || run.command?.[0] === 'git') {
        if (!result.lines.some((line) => / fast path$| foreground: | no scope$/.test(line))) failures.push(`${run.row}, ${run.run} run: the hook added no line to debug.log, so it did not run`);
      }

      if (run.row === 'PostToolUse in a new worktree' && run.run === 'first' && !delivered(tool.dir)) {
        failures.push('PostToolUse in a new worktree, first run: the worktree has no .claude/rules/probe-rule.md after the background pass');
      }
    });

    failures.push(...checkInvariants(measured, world, worktrees.map(({ dir }) => dir)));

    const toolVersion = worldOutput(world, ['claude', '--version']).split(' ')[0] ?? '';
    const gitVersion = worldOutput(world, ['git', '--version']).replace(/^git version /, '');

    const budget: AgentWaitBudget = {
      commit: world.build.commit,
      platform: `${process.platform}-${process.arch}`,
      git: gitVersion,
      tool: 'claude',
      toolVersion,
      rows: [...measured.values()].map((result) => result.counts),
    };

    return { budget, failures };
  } finally {
    for (const { name, dir } of worktrees) {
      if (fs.existsSync(dir)) spawnSync(path.join(world.bin, 'run'), ['git', '-C', world.project, 'worktree', 'remove', '--force', dir]);
      spawnSync(path.join(world.bin, 'run'), ['git', '-C', world.project, 'branch', '--quiet', '-D', name]);
    }

    spawnSync(path.join(world.bin, 'run'), ['git', '-C', world.project, 'remote', 'remove', 'origin']);
    removeProfileLine(world);

    if (options.keep) console.error(`Kept world ${world.runId}: npm run -s verify -- ledger ${world.runId}, then cleanup.`);
    else {
      const clean = runLedger(world);
      console.error(clean ? 'Ledger: CLEAN' : `Ledger found leaks: see ${world.dir}`);

      // The caller reads this list after the return above: a leak fails the measure as a broken invariant does.
      if (!clean) failures.push(`the ledger found leaks after the measured rows: see ${world.dir}`);
      cleanupWorld(world);
    }
  }
}

/** The same removal as `npm run -s verify -- cleanup`, keeping world.json, logs/ and every ledger. */
function cleanupWorld(world: World): void {
  for (const name of fs.readdirSync(world.dir)) {
    if (name === 'world.json' || name === 'logs' || /^LEDGER-\d+\.md$/.test(name)) continue;
    fs.rmSync(path.join(world.dir, name), { recursive: true, force: true });
  }

  saveWorld({ ...world, cleanedAt: new Date().toISOString() });
}

function checkInvariants(measured: ReadonlyMap<string, Measured>, world: World, worktrees: readonly string[]): string[] {
  const failures: string[] = [];
  const at = (row: string, run: 'first' | 'second'): Measured | undefined => measured.get(`${row}|${run}`);

  const equal = (left: [string, 'first' | 'second'], right: [string, 'first' | 'second'], counts: readonly Count[]): void => {
    const a = at(...left);
    const b = at(...right);

    if (!a || !b) return;

    for (const count of counts) {
      if (a.counts[count] !== b.counts[count]) failures.push(`${left.join(', ')} run has ${count} ${a.counts[count]}, ${right.join(', ')} run has ${b.counts[count]}: they must be equal`);
    }
  };

  // A second run costs no more than the first.
  for (const result of measured.values()) {
    if (result.counts.run !== 'second') continue;
    const first = at(result.counts.row, 'first');

    if (!first) continue;

    for (const count of COUNTS) {
      if (result.counts[count] > first.counts[count]) failures.push(`${result.counts.row}: second run has ${count} ${result.counts[count]}, more than the first run's ${first.counts[count]}`);
    }
  }

  // Not files: the second pull after init rewrites state.json in another key order and settles the learnings worktree's FETCH_HEAD, once.
  equal(['pull after init', 'second'], ['pull of a new team commit', 'second'], PROCESSES);
  equal(['PostToolUse in a new worktree', 'first'], ['PostToolUse Read', 'first'], WAITED);
  equal(['PostToolUse in a new worktree', 'second'], ['PostToolUse Read', 'second'], COUNTS);
  equal(['SessionStart in a new worktree', 'second'], ['SessionStart', 'second'], WAITED);
  // git worktree add waits the same however many checkouts the repository already has. The first row also pays cold answers.
  const worktreeAdds = [['worktree add, two checkouts', 'first'], ['worktree add, three checkouts', 'second'], ['worktree add, four checkouts', 'second']] as const;
  const listings = worktreeAdds.map(([row, run]) => at(row, run)?.counts.gitByCommand['ls-files']?.waited ?? 0);

  if (new Set(listings).size > 1) failures.push(`git worktree add waits on ls-files ${listings.join(', ')} times with two, three and four checkouts: they must be equal`);
  equal(['worktree add, three checkouts', 'second'], ['worktree add, four checkouts', 'second'], ['gitWaited']);

  // A warm fast-path hook starts no git from Node in the foreground.
  for (const [row, run] of [['UserPromptSubmit', 'second'], ['PostToolUse Read', 'second'], ['PostToolUse outside any scope', 'first'], ['PostToolUse outside any scope', 'second']] as const) {
    const result = at(row, run);

    if (!result) continue;

    if (!result.counts.fastPath) failures.push(`${row}, ${run} run: took no fast path`);
    const fromNode = result.gits.filter((git) => git.side === 'waited' && git.fromNode);

    if (fromNode.length > 0) failures.push(`${row}, ${run} run: ${fromNode.length} waited git processes started from Node: ${fromNode.map((git) => git.argv.slice(1).join(' ')).join('; ')}`);
  }

  // The MR hint reached gh exactly once per session start.
  for (const run of ['first', 'second'] as const) {
    const result = at('SessionStart', run);

    if (result && result.counts.ghWaited + result.counts.ghAfter !== 1) failures.push(`SessionStart, ${run} run: gh was called ${result.counts.ghWaited + result.counts.ghAfter} times, expected one pr list`);
  }

  // Nothing fetches the project, and each row reaches only the remotes it is known to reach.
  const project = new Set([world.project, ...worktrees]);

  for (const result of measured.values()) {
    const label = `${result.counts.row}, ${result.counts.run} run`;
    const reached = result.gits.filter((git) => REMOTE_GIT.has(subcommand(git.argv)) && git.worktree !== undefined && project.has(git.worktree));

    if (reached.length > 0) failures.push(`${label}: git ${reached.map((git) => git.argv.slice(1).join(' ')).join('; ')} reached the project's remote`);
    const expected = EXPECTED_REMOTE.get(`${result.counts.row}|${result.counts.run}`) ?? [];

    if (JSON.stringify(expected) !== JSON.stringify(result.counts.remote)) failures.push(`${label}: reached ${result.counts.remote.join(', ') || 'no remote'}, expected ${expected.join(', ') || 'no remote'}`);
  }

  // A hook and git worktree add never wait on the tool itself: only a full pull asks its version.
  for (const result of measured.values()) {
    const waited = result.counts.otherByCommand.claude?.waited ?? 0;

    if (!result.counts.row.startsWith('pull ') && waited > 0) failures.push(`${result.counts.row}, ${result.counts.run} run: waits on claude ${waited} times; only a full pull may ask its version`);
  }

  return failures;
}

// ───────────────────────────── the report ─────────────────────────────

const key = (row: Pick<Row, 'row' | 'run'>): string => `${row.row}|${row.run}`;

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : `-${Math.abs(delta)}`;
}

/** A Markdown report of what changed from `base`, and the waited counts that grew. */
export function compareAgentWait(head: AgentWaitBudget, base: AgentWaitBudget) {
  const baseRows = new Map(base.rows.map((row) => [key(row), row]));
  const headRows = new Map(head.rows.map((row) => [key(row), row]));
  const changed: string[] = [];
  const grew: string[] = [];

  for (const row of head.rows) {
    const was = baseRows.get(key(row));

    if (!was) continue;

    for (const count of WAITED) {
      if (row[count] === was[count]) continue;
      const label = `${row.row}, ${row.run} run, ${COUNT_LABELS[count]}`;
      changed.push(`| ${label} | ${was[count]} | ${row[count]} | ${signed(row[count] - was[count])} |`);

      if (row[count] > was[count]) grew.push(label);
    }
  }

  const cell = (was: Row | undefined, now: Row | undefined, count: Count): string => {
    if (was === undefined) return `none / ${now?.[count] ?? ''}`;

    if (now === undefined) return `${was[count]} / none`;

    return was[count] === now[count] ? String(now[count]) : `${was[count]} / ${now[count]}`;
  };

  const all = [...new Set([...headRows.keys(), ...baseRows.keys()])].map((name) => {
    const was = baseRows.get(name);
    const now = headRows.get(name);
    const row = now ?? was;

    return `| ${row?.row ?? ''}, ${row?.run ?? ''} run | ${COUNTS.map((count) => cell(was, now, count)).join(' | ')} | ${was?.waitedMs ?? 'none'} / ${now?.waitedMs ?? 'none'} |`;
  });

  const top = changed.length === 0
    ? ['What the agent waits on did not change.']
    : ['| What the agent waits on | main | this PR | Change |', '| --- | ---: | ---: | ---: |', ...changed.slice(0, 30), ...(grew.length > 0 ? ['', 'Agent wait grew. Say why in the PR.'] : [])];

  const markdown = [
    ...top,
    '',
    `<details><summary>Every row, main / this PR</summary>`,
    '',
    `The budget is the counts of processes and files. The last column is how many milliseconds the tool waited in one run on each side on this machine, for reference: it is not compared. Claude Code ${head.toolVersion}, workspace scope, team repo mode git, ${head.platform}, git ${head.git} (main: git ${base.git}), from the main checkout and linked worktrees. Not measured: ${NOT_MEASURED}.`,
    '',
    `| Row | ${COUNTS.map((count) => COUNT_LABELS[count]).join(' | ')} | ms waited, one run |`,
    `| --- |${COUNTS.map(() => ' ---: |').join('')} ---: |`,
    ...all,
    '',
    '</details>',
  ].join('\n');

  return { markdown, grew };
}

const readBudget = (file: string): AgentWaitBudget => AgentWaitBudgetSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

export function main(args: readonly string[]): number {
  const [flag, baseFile, headFile] = args;

  if (flag === '--compare') {
    if (!baseFile) throw new Error('--compare needs the JSON file a run on main wrote.');
    // A head measured here answers for its own invariants; one read from a file answered when it was measured.
    const head = headFile ? { budget: readBudget(headFile), failures: [] } : measureOrFail(false);
    const { markdown, grew } = compareAgentWait(head.budget, readBudget(baseFile));
    process.stdout.write(`${markdown}\n`);

    if (grew.length > 0) console.error(`Agent wait grew: ${grew.join('; ')}.`);

    return reportFailures(head.failures);
  }

  const { budget, failures } = measureOrFail(args.includes('--keep'));
  process.stdout.write(`${JSON.stringify(budget, null, 2)}\n`);

  return reportFailures(failures);
}

function reportFailures(failures: readonly string[]): number {
  for (const failure of failures) console.error(`Agent wait invariant broken: ${failure}`);

  return failures.length === 0 ? 0 : 1;
}

/** Measures with stdout kept for the result: the world's commands and the ledger print to stderr. */
function measureOrFail(keep: boolean): ReturnType<typeof measureAgentWait> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);

  try {
    return measureAgentWait({ keep });
  } finally {
    process.stdout.write = write;
  }
}
