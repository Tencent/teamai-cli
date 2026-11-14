/**
 * What a world's runs left behind, written to <world>/LEDGER-<n>.md. A LEAK line fails the verdict whatever the
 * claim's own checks say: teamai must not reach this checkout or the real HOME, and must not leave worktrees behind.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { descriptorOf, TOOL_ORDER } from '../../src/tool-registry.js';
import type { ToolId } from '../../src/tools.js';
import { z } from 'zod';
import { defaultToolHome, envToolHome, toolHome } from '../../src/tool-home.js';
import { detectToolRoot, RELOCATABLE_TOOLS, TeamaiConfigBaseSchema } from '../../src/types.js';
import { checkoutStatus, git, loadWriters, REPO_ROOT, runInWorld, teamRefs, worldFiles, type World } from './world.js';

interface Section {
  readonly title: string;
  readonly leaks: string[];
  readonly notes: string[];
}

const MAX_SCANNED_BYTES = 1024 * 1024;

function teamRepo(world: World): Section {
  const notes: string[] = [];
  const before = world.baseline.teamRefs;
  const after = teamRefs(world.team);

  for (const ref of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[ref] === after[ref]) continue;
    notes.push(`team repo ${ref}: ${before[ref]?.slice(0, 7) ?? 'absent'} -> ${after[ref]?.slice(0, 7) ?? 'deleted'}`);
  }

  if (notes.length === 0) notes.push('team repo unchanged since the world was created');
  const dirty = git(world.project, 'status', '--porcelain');
  notes.push(dirty ? `project changes:\n${dirty.split('\n').map((line) => `      ${line}`).join('\n')}` : 'project working tree clean');

  return { title: '(a) Team repo and project', leaks: [], notes };
}

function worktrees(world: World): Section {
  const leaks = [world.project, world.team]
    .flatMap((repo) =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
        .filter((dir) => !fs.existsSync(dir) || fs.realpathSync.native(dir) !== repo),
    )
    .map((dir) => `worktree ${dir} left behind${fs.existsSync(dir) ? '' : ' (directory missing)'}`);

  return { title: '(b) Leftover worktrees', leaks, notes: leaks.length > 0 ? [] : ['none'] };
}

/**
 * Files under `dir`, to a depth of three, changed since the world was born and whose path or content names the world.
 * A world's own directory names hold its run id, so a partition or transcript made for it is found by name.
 */
function namingWorld(dir: string, world: World, since: number, found: string[], unreadable: string[], depth = 0): void {
  if (!fs.existsSync(dir)) return;
  const id = world.runId.toLowerCase();
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable.push(dir);

    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.name.toLowerCase().includes(id)) {
      found.push(full);
      continue;
    }

    if (entry.isDirectory()) {
      if (depth < 3) namingWorld(full, world, since, found, unreadable, depth + 1);
      continue;
    }

    // Pull delivers by symlink too, and a world's path holds its run id; a linked directory is read like any other.
    if (entry.isSymbolicLink()) {
      try {
        if (fs.readlinkSync(full).toLowerCase().includes(id)) found.push(full);
        else if (depth < 3 && fs.statSync(full).isDirectory()) namingWorld(full, world, since, found, unreadable, depth + 1);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) unreadable.push(full);
      }

      continue;
    }

    // A .jsonl is a session log: the session running this world types its run id, so its content proves nothing.
    if (!entry.isFile() || entry.name.endsWith('.jsonl')) continue;

    // A live tool home deletes files while it is read.
    try {
      const stat = fs.statSync(full);

      if (stat.mtimeMs < since || stat.size > MAX_SCANNED_BYTES) continue;
      const text = fs.readFileSync(full, 'utf8');

      if (text.includes(world.dir) || text.includes(world.runId)) found.push(full);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) unreadable.push(full);
    }
  }
}

function hostFiles(world: World): Section {
  const leaks: string[] = [];
  const notes: string[] = [];
  const before = new Set(world.baseline.checkoutStatus);

  for (const line of checkoutStatus()) if (!before.has(line)) leaks.push(`this checkout changed: ${line}`);
  const checkoutHead = git(REPO_ROOT, 'rev-parse', 'HEAD');

  // A commit empties the status lines it made, so HEAD is compared too; one of your own also counts.
  if (checkoutHead !== world.build.commit) leaks.push(`this checkout's HEAD moved: ${world.build.commit.slice(0, 7)} -> ${checkoutHead.slice(0, 7)}`);
  const realHome = os.homedir();
  const since = Date.parse(world.createdAt);
  // Every tool home TOOLS knows: default, recorded, and moved by this shell's env (also a relocated tool root), so a new tool is checked without editing this list.
  const homes = [...new Set([path.join(realHome, '.teamai'), ...TOOL_ORDER.flatMap((tool) => [defaultToolHome(tool, { home: realHome, path }), toolHome(tool), envToolHome(tool)?.dir ?? []].flat()), ...Object.keys(RELOCATABLE_TOOLS).flatMap((tool) => detectToolRoot(tool) ?? [])])];
  const found: string[] = [];
  const unreadable: string[] = [];

  for (const home of homes) namingWorld(home, world, since, found, unreadable);

  for (const dir of unreadable) notes.push(`not readable, so not checked: ${dir}`);

  // Tool homes often link to one shared directory: report each real file once.
  const real = new Map(found.toReversed().map((file) => [path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)), file]));

  for (const file of real.values()) leaks.push(`real HOME names this world: ${file}`);
  notes.push(`checked ${homes.length} homes under ${realHome}`);
  const landed = fs.existsSync(world.home) ? fs.readdirSync(world.home).sort() : [];
  notes.push(`in the world's HOME: ${landed.join(', ') || 'nothing'}`);

  return { title: '(c) Host files', leaks, notes };
}

function environment(world: World): Section {
  const run = fs.readFileSync(path.join(world.bin, 'run'), 'utf8');
  const names = [...run.matchAll(/ ([A-Z_]+)='/g)].map((match) => match[1]);

  return { title: '(d) Environment', leaks: [], notes: [`commands got only: ${names.join(', ')}`] };
}

/** What `teamai uninstall` leaves today, each tracked in KNOWN_LEFTOVERS_ISSUE; any other leftover is a LEAK. */
const KNOWN_LEFTOVERS_ISSUE = 'https://github.com/Tencent/teamai-cli/issues/1808';

// Each with what it holds: a sha256, `dir`, or `any` where the content names this machine or is a log.

/** Each tool's home under HOME, its parents included, and the top directory of each project path teamai writes for a tool. */
const TOOL_DIRS = [
  ...TOOL_ORDER.flatMap((tool) => descriptorOf(tool).home.dir.split('/').map((_, i, parts) => `home/${parts.slice(0, i + 1).join('/')}`)),
  ...Object.values(TeamaiConfigBaseSchema.shape.toolPaths.parse(undefined)).flatMap((paths) =>
    [paths.skills, paths.rules, paths.settings, paths.agents, paths.mcpProject].flatMap((dir) => (dir?.includes('/') ? [`project/${dir.split('/')[0]}`] : []))),
];

const KNOWN_LEFTOVERS = new Map([
  // A tool's own directory stays: teamai removes what it put inside, not the
  // directory the tool reads. Removing ~/.claude stopped Claude's MCP config
  // from being written in the mcp-uninstall e2e, so uninstall leaves it (#1808).
  ...TOOL_DIRS.map((dir) => [dir, 'dir'] as const),
  // debug.log stays: an uninstall that failed is explained there, and that
  // record is worth more than the file, so ~/.teamai stays to hold it (#1808).
  ['home/.teamai', 'dir'],
  ['home/.teamai/projects', 'dir'],
  ['home/.teamai/debug.log', 'any'],
  // What the hooks of a session leave today, in a world that ran them.
  ['home/.teamai/dashboard', 'dir'],
  ['home/.teamai/dashboard/session-owners.jsonl', 'any'],
  ['home/.teamai/dashboard/events.jsonl', 'any'],
  ['home/.teamai/dashboard/requests.jsonl', 'any'],
  ['home/.teamai/state.json', 'any'],
  // teamai starts Codex's app-server to trust its hooks (#955), and Codex writes its own files where teamai writes:
  // its system skills, and the table of hook approvals that taking teamai's out leaves empty.
  ['home/.codex/skills', 'dir'],
  ['home/.codex/config.toml', createHash('sha256').update('[hooks.state]\n').digest('hex')],
]);

/** Directories left with everything in them: session ids name what is in them, or Codex installs them. */
const KNOWN_LEFTOVER_DIRS = ['home/.teamai/sessions', 'home/.codex/skills/.system'];

const Base = z.enum(['home', 'project']);

const Read = z.union([
  z.object({ base: Base, path: z.string() }).transform(({ base, path: read }) => [`${base}/${read}`]),
  z.object({ base: Base, firstOf: z.array(z.union([z.string(), z.object({ path: z.string() }).transform((file) => file.path)])) })
    .transform(({ base, firstOf }) => firstOf.map((read) => `${base}/${read}`)),
]);

/** Every path under HOME and in the project that TOOLS says `tool` reads, each candidate of a `firstOf` too: where teamai writes for it. */
function toolReads(tool: ToolId): string[] {
  const paths: string[] = [];

  JSON.stringify(descriptorOf(tool), (_key, value) => {
    const read = Read.safeParse(value);

    if (read.success) paths.push(...read.data);

    return value;
  });

  return paths;
}

const TOOL_READS = [...new Set(TOOL_ORDER.flatMap(toolReads))];

const TEAMAI_HOME_WRITES = TOOL_READS.filter((read) => read.startsWith('home/'));

/** A tool's home under HOME holds the tool's own state (sessions, caches, the runtime of a Codex teamai starts to trust its hooks) beside what teamai writes there. */
const TOOL_HOMES = [...new Set(TOOL_ORDER.map((tool) => `home/${descriptorOf(tool).home.dir}`))];

/** A run's branch, which a run that succeeded keeps as its result (docs/guide/workflow.md, The branches a run leaves). */
const RUN_BRANCH = /^project\/\.git\/refs\/heads\/teamai(\/r[0-9a-f]{16}(\/[^/]+(\/p\d+)?)?)?$/;

/** What the project's repository tracks, and what differs from its HEAD, is untracked or is ignored, each relative to the project. */
function repositoryView(project: string) {
  // Untrimmed: a status line starts with a space when the index matches HEAD.
  const list = (...args: string[]): string[] | undefined => {
    const listed = spawnSync('git', args, { cwd: project, encoding: 'utf8' });

    return listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : undefined;
  };

  const tracked = fs.existsSync(path.join(project, '.git')) ? list('ls-files', '-z') : undefined;
  const dirty = tracked === undefined ? undefined : list('status', '--porcelain', '-z', '--ignored', '--untracked-files=all');

  // A repository git cannot read, such as one with a broken config, vouches for nothing.
  return tracked === undefined || dirty === undefined ? { tracked: [], dirty: [] } : { tracked, dirty: dirty.map((line) => line.slice(3)) };
}

/** git's copy of what a remote holds, which a fetch or a push writes whoever asked for it. */
const REMOTE_REF = /^project\/\.git\/refs\/remotes(\/|$)/;

/** teamai's own directories: whatever wrote last there, it is teamai's to remove. */
const TEAMAI_ROOTS = ['home/.teamai', 'project/.teamai'];

/** Each project path teamai delivers a tool's resources to, and those TOOLS says a tool reads there. */
const TEAMAI_PROJECT_WRITES = [...new Set([
  ...Object.values(TeamaiConfigBaseSchema.shape.toolPaths.parse(undefined)).flatMap((paths) =>
    [paths.skills, paths.rules, paths.settings, paths.agents, paths.mcpProject, paths.claudemd].flatMap((write) => (write === undefined ? [] : [`project/${write}`]))),
  ...TOOL_READS.filter((read) => read.startsWith('project/')),
])];

/** Where teamai hides what it adds to the project, beside the member's own patterns. */
const GIT_EXCLUDE = 'project/.git/info/exclude';

/** The files teamai writes its part into beside a tool's own settings, never a resource it delivers into a folder. */
const SHARED_FILES = new Set([...TEAMAI_HOME_WRITES, ...TEAMAI_PROJECT_WRITES, GIT_EXCLUDE]);

/**
 * Where teamai writes, which neither a member's command nor a tool's home excuses: an agent's session runs teamai's
 * hooks, which pull, and teamai names what it adds elsewhere in a tool's home, such as an adapter, after itself.
 * Of git's settings, teamai writes its own, the worktree extension and a hooks path to its hooks.
 */
function teamaiPlace(entry: string, value: string | undefined): boolean {
  return [...TEAMAI_ROOTS, ...TEAMAI_HOME_WRITES, ...TEAMAI_PROJECT_WRITES, GIT_EXCLUDE].some((write) => entry === write || entry.startsWith(`${write}/`))
    || entry.split('/').some((segment) => /^teamai([-_.]|$)/i.test(segment))
    || /#((.*\.)?teamai|extensions\.worktreeconfig$)/i.test(entry)
    || (/#core\.hookspath$/i.test(entry) && /teamai/i.test(value ?? ''));
}

/** A way in has a way out: after `teamai uninstall` the world's HOME and project match the snapshot taken at creation. */
function reverseState(world: World): Section {
  const title = '(e) After teamai uninstall';

  if (world.baseline.files === undefined) return { title, leaks: ['this world has no snapshot to compare: make a new world'], notes: [] };
  const before = world.baseline.files;
  // Uninstall drops a clone's registrations with it, so a worktree outside HOME and the project is listed first.
  const repos = Object.keys(worldFiles(world)).flatMap((entry) => (entry.endsWith('/.git') ? [path.join(world.dir, path.dirname(entry))] : []));

  const registered = new Set(
    repos.flatMap((repo) =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []))
        .filter((dir) => !repos.includes(dir)),
    ),
  );

  const status = runInWorld(world, ['teamai', 'uninstall', '--force']);
  const after = worldFiles(world);
  const leaks = status === 0 ? [] : [`teamai uninstall exited ${status}`];

  for (const dir of registered) if (fs.existsSync(dir)) leaks.push(`worktree ${dir} left behind after uninstall`);
  const notes: string[] = [];

  const leaked: string[] = [];
  const writers = loadWriters(world);
  const theirs = new Map<string, string[]>();
  const under = (entry: string, dirs: Iterable<string>): boolean => [...dirs].some((dir) => entry.startsWith(`${dir}/`));

  const excuse = (why: string, entry: string): void => {
    if (!under(entry, [...theirs.values()].flat())) theirs.set(why, [...theirs.get(why) ?? [], entry]);
  };

  const repository = repositoryView(world.project);
  const namesTeamai = (entry: string): boolean => /teamai/i.test(fs.readFileSync(path.join(world.dir, entry), 'utf8'));
  const remoteTips = new Set(Object.entries(after).flatMap(([entry, value]) => (REMOTE_REF.test(entry) && value !== 'dir' ? [value] : [])));

  for (const entry of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[entry] === after[entry] || under(entry, [...leaked, ...KNOWN_LEFTOVER_DIRS])) continue;
    const change = before[entry] === undefined ? 'left behind' : after[entry] === undefined ? 'removed' : 'changed';
    const writer = writers[entry];

    // A tool's sessions, or a member's own commit: left as a member's program left it, whatever teamai did in between.
    if (writer !== undefined && writer.value === (after[entry] ?? null) && !teamaiPlace(entry, after[entry])) {
      excuse(`left as ${writer.program} wrote it, so not teamai's`, entry);
      continue;
    }

    // A file teamai shares with a tool, such as Claude's ~/.claude.json, which keeps the tool's state once teamai's part is out.
    if (writer !== undefined && writer.value === after[entry] && /^[0-9a-f]{64}$/.test(after[entry]) && SHARED_FILES.has(entry) && !namesTeamai(entry)) {
      excuse(`left as ${writer.program} wrote it, with nothing of teamai's in it`, entry);
      continue;
    }

    if (change === 'left behind' && under(entry, TOOL_HOMES) && !teamaiPlace(entry, after[entry])) {
      excuse(`the tool's own state in ${TOOL_HOMES.find((dir) => entry.startsWith(`${dir}/`)) ?? entry}, where teamai writes none of it`, entry);
      continue;
    }

    if (REMOTE_REF.test(entry)) {
      excuse("git's copy of what the remote holds", entry);
      continue;
    }

    if (change === 'changed' && entry.startsWith('project/.git/refs/heads/') && remoteTips.has(after[entry] ?? '')) {
      excuse("the member's branch moved to a commit the remote has, history uninstall does not rewrite", entry);
      continue;
    }

    // Uninstall keeps what the repository tracks (#915): self mode commits the team's content, and teamai's part of
    // a tracked file it edits out for the member to commit. A tracked file still naming teamai stays a leak.
    const tracked = entry.startsWith('project/') && !entry.startsWith('project/.git/') ? entry.slice('project/'.length) : undefined;
    const within = (paths: string[]): boolean => tracked !== undefined && paths.some((file) => file === tracked || file.startsWith(`${tracked}/`));

    if (within(repository.tracked) && !within(repository.dirty)) {
      excuse("the repository's, as its HEAD has it", entry);
      continue;
    }

    if (tracked !== undefined && within(repository.tracked) && /^[0-9a-f]{64}$/.test(after[entry] ?? '')
      && !/teamai/i.test(fs.readFileSync(path.join(world.project, tracked), 'utf8'))) {
      excuse("teamai's part taken out of a file the repository tracks, for the member to commit", entry);
      continue;
    }

    if (change === 'left behind' && RUN_BRANCH.test(entry)) {
      if (after[entry] !== 'dir') notes.push(`${entry.slice('project/.git/refs/heads/'.length)} left behind: a run's result branch, the member's to keep`);
      continue;
    }

    const known = KNOWN_LEFTOVER_DIRS.includes(entry) ? 'any' : KNOWN_LEFTOVERS.get(entry);

    if (change === 'left behind' && (known === 'any' || known === after[entry])) notes.push(`${entry} left behind, known: ${KNOWN_LEFTOVERS_ISSUE}`);
    else {
      leaks.push(`${entry} ${change}${after[entry] === 'dir' || before[entry] === 'dir' ? ', with everything in it' : ''}`);
      leaked.push(entry);
    }
  }

  for (const [why, entries] of theirs) notes.push(`${why}: ${entries.join(', ')}`);

  if (leaks.length === 0 && notes.length === 0) notes.push('HOME and project match the world as it was made');

  return { title, leaks, notes };
}

/** Uninstalls teamai in the world, writes the next LEDGER-<n>.md and returns whether it is clean. */
export function runLedger(world: World): boolean {
  const reverse = reverseState(world);
  const sections = [teamRepo(world), worktrees(world), hostFiles(world), environment(world), reverse];
  const leaks = sections.reduce((sum, section) => sum + section.leaks.length, 0);
  const verdict = leaks === 0 ? 'CLEAN' : `${leaks} LEAK${leaks === 1 ? '' : 'S'}`;

  const body = sections
    .map((section) => [`## ${section.title}`, ...section.leaks.map((leak) => `- LEAK ${leak}`), ...section.notes.map((note) => `- ${note}`)].join('\n'))
    .join('\n\n');

  const n = fs.readdirSync(world.dir).filter((name) => /^LEDGER-\d+\.md$/.test(name)).length + 1;
  const file = path.join(world.dir, `LEDGER-${n}.md`);
  const head = `# Ledger ${n}: world ${world.runId}\n\nBuild ${world.build.commit.slice(0, 12)}${world.build.dirty ? '+dirty' : ''}, teamai ${world.build.version}\n\n`;
  fs.writeFileSync(file, `${head}${body}\n\nLedger: ${verdict}\n`);
  console.log(`${body}\n\nLedger: ${verdict}\nWritten to ${file}`);

  return leaks === 0;
}
