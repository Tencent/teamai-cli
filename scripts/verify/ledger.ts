/**
 * What a world's runs left behind, written to <world>/LEDGER-<n>.md. A LEAK line fails the verdict whatever the
 * claim's own checks say: teamai must not reach this checkout or the real HOME, and must not leave worktrees behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_IDS } from '../../src/tools.js';
import { defaultToolHome, envToolHome, toolHome } from '../../src/tool-home.js';
import { detectToolRoot, RELOCATABLE_TOOLS } from '../../src/types.js';
import { checkoutStatus, git, REPO_ROOT, runInWorld, teamRefs, worldFiles, type World } from './world.js';

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
  const homes = [...new Set([path.join(realHome, '.teamai'), ...TOOL_IDS.flatMap((tool) => [defaultToolHome(tool, { home: realHome, path }), toolHome(tool), envToolHome(tool)?.dir ?? []].flat()), ...Object.keys(RELOCATABLE_TOOLS).flatMap((tool) => detectToolRoot(tool) ?? [])])];
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

const KNOWN_LEFTOVERS = new Map([
  // A tool's own directory stays: teamai removes what it put inside, not the
  // directory the tool reads. Removing ~/.claude stopped Claude's MCP config
  // from being written in the mcp-uninstall e2e, so uninstall leaves it (#1808).
  ['home/.claude', 'dir'],
  ['project/.claude', 'dir'],
  // debug.log stays: an uninstall that failed is explained there, and that
  // record is worth more than the file, so ~/.teamai stays to hold it (#1808).
  ['home/.teamai', 'dir'],
  ['home/.teamai/projects', 'dir'],
  ['home/.teamai/debug.log', 'any'],
  // What the hooks of a session leave today, in a world that ran them.
  ['home/.teamai/dashboard', 'dir'],
  ['home/.teamai/dashboard/session-owners.jsonl', 'any'],
  ['home/.teamai/dashboard/events.jsonl', 'any'],
  ['home/.teamai/state.json', 'any'],
]);

/** Directories left with everything in them: their file names hold session ids. */
const KNOWN_LEFTOVER_DIRS = ['home/.teamai/sessions'];

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

  for (const entry of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[entry] === after[entry] || [...leaked, ...KNOWN_LEFTOVER_DIRS].some((dir) => entry.startsWith(`${dir}/`))) continue;
    const change = before[entry] === undefined ? 'left behind' : after[entry] === undefined ? 'removed' : 'changed';

    const known = KNOWN_LEFTOVER_DIRS.includes(entry) ? 'any' : KNOWN_LEFTOVERS.get(entry);

    if (change === 'left behind' && (known === 'any' || known === after[entry])) notes.push(`${entry} left behind, known: ${KNOWN_LEFTOVERS_ISSUE}`);
    else {
      leaks.push(`${entry} ${change}${after[entry] === 'dir' || before[entry] === 'dir' ? ', with everything in it' : ''}`);
      leaked.push(entry);
    }
  }

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
