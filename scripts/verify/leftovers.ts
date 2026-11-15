/**
 * What a world's runs left running, one row per kind: processes, the attempt places teamai's own records say are open,
 * containers, sbx sandboxes, and remote sandboxes. Ledger section (f), `cleanup` and `reap` read the same rows, and every
 * row judges whose a leftover is with one rule, `attributeLeftover`: only this world's own is a LEAK.
 *
 * A world that ran no step runtime pays for the process check alone; the rows that ask an engine are loaded only once
 * the world's own records show a runtime outside teamai's process ran (`worldTier`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AttemptPlacement } from '../../src/workflow/runtimes/attempt.js';
import { ledgerRedactor } from './secrets.js';
import { markDriverSeen, runProbe, runtimeStateDirs, worldHomes, WORLDS_ROOT, type World } from './world.js';

/** Whose a leftover is: this world's (a LEAK), another world's, teamai's but no world's, or nothing of teamai's. */
export type Attribution =
  | { kind: 'own'; why: string }
  | { kind: 'other_world'; runId: string }
  | { kind: 'ambiguous'; why: string }
  | { kind: 'unrelated' };

/** What ties a leftover to a world: the paths it names (mounts, cwd, arguments), the sandbox journals and teamai runs it belongs to. */
export interface Ties {
  readonly paths: readonly string[];
  readonly journals: readonly string[];
  readonly runs: readonly string[];
  /** Whether it carries teamai's mark: a `teamai.owner` label, or an sbx name teamai gives. */
  readonly marked: boolean;
}

/** What a world can be tied by: its directories (TMPDIRs included), its HOMEs' sandbox journals, and the runs its installs started. */
export interface WorldTies {
  readonly runId: string;
  readonly paths: readonly string[];
  readonly journals: readonly string[];
  readonly runs: readonly string[];
}

const isWithin = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

function tieOf(ties: Ties, world: WorldTies): string | undefined {
  const named = ties.paths.find((at) => world.paths.some((dir) => isWithin(at, dir)));

  if (named !== undefined) return `names ${named}`;
  const owner = ties.journals.find((id) => world.journals.includes(id));

  if (owner !== undefined) return `owned by sandbox journal ${owner}, under a HOME of the world`;
  const run = ties.runs.find((id) => world.runs.includes(id));

  return run === undefined ? undefined : `made for run ${run}, which an install of the world started`;
}

/** Whose a leftover with `ties` is, given this world and every other world on this machine. */
export function attributeLeftover(ties: Ties, self: WorldTies, others: readonly WorldTies[]): Attribution {
  const own = tieOf(ties, self);

  if (own !== undefined) return { kind: 'own', why: own };
  const other = others.find((world) => world.runId !== self.runId && tieOf(ties, world) !== undefined);

  if (other !== undefined) return { kind: 'other_world', runId: other.runId };

  return ties.marked ? { kind: 'ambiguous', why: "teamai's, tied to no world on this machine" } : { kind: 'unrelated' };
}

/** How much of the leftovers machinery a world needs, from what its own installs recorded. */
export type Tier = 'basic' | 'middle' | 'driver';

export interface TierEvidence {
  readonly inProcessRecords: number;
  readonly externalRecords: number;
  /** Folders under a HOME's ~/.teamai/runtime-state: a runtime outside teamai's process ran there. */
  readonly runtimeJournals: number;
  readonly containerMembers: number;
  /** An earlier look saw a runtime outside teamai's process run here (world.json), whatever uninstall has removed since. */
  readonly driverSeen?: boolean;
}

/** basic: no step runtime ran; middle: only teamai's own process ran steps; driver: a runtime outside it, or a container member. */
export function worldTier(evidence: TierEvidence): Tier {
  if (evidence.driverSeen === true || evidence.externalRecords > 0 || evidence.runtimeJournals > 0 || evidence.containerMembers > 0) return 'driver';

  return evidence.inProcessRecords > 0 ? 'middle' : 'basic';
}

/** One leftover a row found, as the ledger prints it and cleanup removes it. */
export interface Finding {
  readonly what: string;
  readonly attribution: Attribution;
  /** The command that removes it, for a kind cleanup may remove; a process has none: cleanup never signals one. */
  readonly remove?: readonly string[];
  /** What `remove` says on stderr, exiting non-zero, when it is gone already: cleanup takes that as removed. */
  readonly gone?: RegExp;
  /** What the person does to end it, for a kind cleanup refuses over: its refusal prints it beside the finding. */
  readonly next?: string;
}

/** What a row saw: its findings and notes, or that it could not look and why, which proves nothing for that part. */
export type Observed =
  | { kind: 'observed'; findings: Finding[]; notes: string[] }
  | { kind: 'not_observed'; what: string; why: string };

/** What every row is given: the world, its ties and the other worlds', and what the world's installs recorded. */
export interface LeftoverContext {
  readonly world: World;
  readonly self: WorldTies;
  readonly others: readonly WorldTies[];
  readonly records: RecordScan;
}

/**
 * What cleanup does with a row's findings of this world's own. remove: runs each one's `remove`; keep: leaves it to the
 * ledger or reap; refuse: stops while one is there, saying `found`, or while the row could not look, saying `unseen`.
 */
export type CleanupRule = { kind: 'remove' } | { kind: 'keep' } | { kind: 'refuse'; found: string; unseen: string };

/** One kind of leftover: what it is called, how it is looked for, and what cleanup does with this world's own. */
export interface LeftoverKind {
  readonly title: string;
  readonly onCleanup: CleanupRule;
  observe(context: LeftoverContext): Promise<Observed[]>;
}

/**
 * Runs an engine's listing with the harness's own environment, never the world's, so asking writes nothing into a HOME
 * of the world: `missing` when the command is not installed, `ran` with its exit code otherwise (null, and a NOT OBSERVED
 * reason, when it did not answer within `timeoutMs`).
 */
export function probeHere(argv: readonly string[], { timeoutMs = 30_000 }: { timeoutMs?: number } = {}): { kind: 'missing' } | { kind: 'ran'; code: number | null; stdout: string; stderr: string; why: string } {
  const [command = 'true', ...args] = argv;
  const ran = runProbe({ command, args, cwd: os.tmpdir(), env: process.env, timeoutMs });

  if (ran.errno === 'ENOENT') return { kind: 'missing' };

  return { kind: 'ran', code: ran.code, stdout: ran.stdout, stderr: ran.stderr, why: ran.why };
}

/** The data homes under `home` whose runs teamai keeps: user scope's ~/.teamai and each workspace's ~/.teamai/projects/<slug>, read with the product's own layout. */
async function runsDirsUnder(home: string): Promise<string[]> {
  const [{ runsDirIn }, { projectsRootDir }] = await Promise.all([import('../../src/workflow/store.js'), import('../../src/utils/partition.js')]);
  const projects = projectsRootDir(home);
  const dataHomes = [path.join(home, '.teamai'), ...(fs.existsSync(projects) ? fs.readdirSync(projects).map((slug) => path.join(projects, slug)) : [])];

  return dataHomes.flatMap((dataHome) => {
    const runs = runsDirIn(dataHome);

    return fs.existsSync(runs) ? [runs] : [];
  });
}

/** Every attempt's runtime.json under the world's HOMEs, and the runs they belong to. */
export interface RecordScan {
  readonly files: readonly string[];
  readonly runs: readonly string[];
  readonly runtimeJournals: number;
  /** Each file's placement, in the order of `files`, read with them: `teamai uninstall` removes the files. */
  readonly placements: readonly AttemptPlacement[];
}

async function scanRecords(world: World): Promise<RecordScan> {
  const { attemptsDirIn, RunIdSchema } = await import('../../src/workflow/store.js');
  const files: string[] = [];
  const runs: string[] = [];

  for (const runsDir of (await Promise.all(worldHomes(world).map(runsDirsUnder))).flat()) {
    for (const run of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      runs.push(run.name);
      const id = RunIdSchema.safeParse(run.name);

      if (!id.success) continue;
      const attempts = attemptsDirIn(runsDir, id.data);

      for (const attempt of fs.existsSync(attempts) ? fs.readdirSync(attempts) : []) {
        const file = path.join(attempts, attempt, 'runtime.json');

        if (fs.existsSync(file)) files.push(file);
      }
    }
  }

  const runtimeJournals = runtimeStateDirs(world).flatMap((state) => (fs.existsSync(state) ? fs.readdirSync(state) : [])).length;

  const placements = files.length === 0 ? [] : await (await import('./leftovers/places.js')).readPlacements(files);

  return { files, runs, runtimeJournals, placements };
}

const SpanSchema = z.object({
  runId: z.string(),
  dir: z.string(),
  tmp: z.string(),
  home: z.string(),
  members: z.array(z.object({ home: z.string(), tmp: z.string() })).optional(),
});

/** `at` and, when it resolves elsewhere (macOS's /var is /private/var), where it resolves: a leftover may name either. */
function withRealPath(at: string): string[] {
  try {
    const real = fs.realpathSync(at);

    return real === at ? [at] : [at, real];
  } catch {
    return [at];
  }
}

/** What ties a world, from its world.json: any world's, from any checkout, cleaned or not. */
function tiesOf(world: z.infer<typeof SpanSchema>, runs: readonly string[], journalOf: ((home: string) => string) | undefined): WorldTies {
  const homes = worldHomes(world);

  return {
    runId: world.runId,
    paths: [world.dir, world.tmp, ...(world.members ?? []).map((member) => member.tmp)].flatMap(withRealPath),
    journals: journalOf === undefined ? [] : homes.map(journalOf),
    runs,
  };
}

/**
 * The id the sandbox runtime labels what it makes with, for the member whose home is `home` (journal.ts `owner`); loaded
 * only for a world whose runs used a runtime outside teamai's process, since only what such a runtime makes carries it.
 */
async function sandboxJournalIds(): Promise<(home: string) => string> {
  const [{ journal }, { sandboxJournalRoot }] = await Promise.all([import('../../packages/runtime-sandbox/src/journal.js'), import('../../packages/runtime-sandbox/src/journal-root.js')]);

  return (home) => journal(sandboxJournalRoot(home)).owner;
}

/** Every other world on this machine, by what ties it; a world.json that cannot be read ties nothing. */
function otherWorlds(self: World | undefined, journalOf: ((home: string) => string) | undefined): WorldTies[] {
  if (!fs.existsSync(WORLDS_ROOT)) return [];

  return fs.readdirSync(WORLDS_ROOT).filter((name) => name !== self?.runId).flatMap((name) => {
    try {
      return [tiesOf(SpanSchema.parse(JSON.parse(fs.readFileSync(path.join(WORLDS_ROOT, name, 'world.json'), 'utf8'))), [], journalOf)];
    } catch {
      return [];
    }
  });
}

/** A row's LEAK lines and notes in section (f), and `no <title> left` when it looked everywhere and found nothing. */
export function linesOf(title: string, observed: readonly Observed[], mask: (text: string) => string) {
  const leaks: string[] = [];
  const notes: string[] = [];
  const rowNotes: string[] = [];
  let isWhole = true;

  for (const seen of observed) {
    if (seen.kind === 'not_observed') {
      isWhole = false;
      notes.push(mask(`NOT OBSERVED: ${seen.what}, ${seen.why}`));
      continue;
    }

    for (const finding of seen.findings) {
      const { attribution } = finding;

      switch (attribution.kind) {
        case 'own':
          leaks.push(mask(`${finding.what} still there (${attribution.why})`));
          break;
        case 'other_world':
          notes.push(mask(`${finding.what}: world ${attribution.runId}'s, not this one's`));
          break;
        case 'ambiguous':
          notes.push(mask(`${finding.what}: ${attribution.why}, so not counted here`));
          break;
        case 'unrelated':
          break;
        default: {
          const unknown: never = attribution;
          void unknown;
        }
      }
    }

    rowNotes.push(...seen.notes.map(mask));
  }

  if (isWhole && leaks.length === 0 && notes.length === 0) notes.push(`no ${title} left`);

  return { leaks, notes: [...notes, ...rowNotes] };
}

/** The rows, by the tier that asks them: the process and open-place checks always, the engines only for a driver world. */
async function rowsFor(tier: Tier): Promise<LeftoverKind[]> {
  const { processes } = await import('./leftovers/processes.js');

  if (tier === 'basic') return [processes];
  const { places } = await import('./leftovers/places.js');

  if (tier === 'middle') return [processes, places];
  const [{ containers }, { sbxLeftovers }, { remoteSandboxes }] = await Promise.all([import('./leftovers/containers.js'), import('./leftovers/sbx.js'), import('./leftovers/remote.js')]);

  return [processes, places, containers, sbxLeftovers, remoteSandboxes];
}

/** The context every row reads, built once per ledger or cleanup. */
async function contextOf(world: World): Promise<{ context: LeftoverContext; tier: Tier }> {
  const records = await scanRecords(world);

  const tier = worldTier({
    inProcessRecords: records.placements.filter((placement) => placement.kind === 'in_process').length,
    externalRecords: records.placements.filter((placement) => placement.kind !== 'in_process').length,
    runtimeJournals: records.runtimeJournals,
    containerMembers: (world.members ?? []).filter((member) => member.machine === 'container').length,
    driverSeen: world.driverSeen === true,
  });

  if (tier === 'driver') markDriverSeen(world);

  const journalOf = tier === 'driver' ? await sandboxJournalIds() : undefined;

  return { context: { world, self: tiesOf(world, records.runs, journalOf), others: otherWorlds(world, journalOf), records }, tier };
}

/** What ties `world`, its runs included, and every other world on this machine, journals included: how reap judges. */
export async function tiesOnThisMachine(world: World | undefined): Promise<{ self: WorldTies | undefined; others: WorldTies[] }> {
  const journalOf = await sandboxJournalIds();

  return {
    self: world === undefined ? undefined : tiesOf(world, (await scanRecords(world)).runs, journalOf),
    others: otherWorlds(world, journalOf),
  };
}

/**
 * Ledger section (f), in two steps: what ties the world is read when it is made, before `teamai uninstall` removes the
 * records that say which runtimes the world's runs used; `observe`, called after uninstall, gives each row the world's tier
 * asks, its LEAK lines and notes, so what uninstall removes is no LEAK. A world that ran no step runtime gets one line.
 */
export async function leftoversSection(world: World): Promise<{ observe(): Promise<{ leaks: string[]; notes: string[] }> }> {
  const { context, tier } = await contextOf(world);
  const rows = await rowsFor(tier);

  return {
    async observe() {
      const { mask, unmasked } = ledgerRedactor({ passedNames: world.passed ?? [], harnessEnv: process.env });
      const leaks: string[] = [];
      const notes: string[] = unmasked.length === 0 ? [] : [`not masked: ${unmasked.join(', ')}, which this shell does not set; run the ledger with each exported to mask its value in these lines`];

      for (const row of rows) {
        const lines = linesOf(row.title, await row.observe(context), mask);
        leaks.push(...lines.leaks);

        // A world that ran no step runtime keeps its section to one line, unless the process check found something.
        if (tier !== 'basic' || lines.leaks.length > 0 || lines.notes.some((note) => note.startsWith('NOT OBSERVED'))) notes.push(...lines.notes);
      }

      if (tier === 'basic') notes.push('no step runtime used');

      return { leaks, notes };
    },
  };
}

/**
 * What cleanup does: refuse while a row that refuses found this world's own, or could not look, each refusal with its
 * row's reason and every line it names; otherwise remove the world's own removable leftovers.
 */
export type CleanupPlan =
  | { kind: 'refuse'; refusals: Array<{ why: string; items: string[] }> }
  | { kind: 'remove'; removals: Array<{ what: string; command: readonly string[]; gone?: RegExp }>; unobserved: string[] };

/** Runs one removal of a cleanup plan from the harness's environment: whether it removed it, or found it gone, or why it failed. */
export function removeLeftover({ command, gone }: { command: readonly string[]; gone?: RegExp }): { ok: true; wasThere: boolean } | { ok: false; why: string } {
  const [executable = 'true', ...args] = command;
  const ran = spawnSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });

  if (ran.status === 0) return { ok: true, wasThere: true };

  return gone !== undefined && gone.test(ran.stderr) ? { ok: true, wasThere: false } : { ok: false, why: ran.error?.message ?? ran.stderr.trim() };
}

/** The plan for what each row observed, judged by the row's `onCleanup`: only this world's own findings count. */
export function cleanupPlan(rows: ReadonlyArray<{ onCleanup: CleanupRule; observed: readonly Observed[] }>): CleanupPlan {
  const refusals = new Map<string, string[]>();
  const removals: Array<{ what: string; command: readonly string[] }> = [];
  const unobserved: string[] = [];
  const refuse = (why: string, item: string): void => void refusals.set(why, [...refusals.get(why) ?? [], item]);

  for (const { onCleanup, observed } of rows) {
    for (const seen of observed) {
      if (seen.kind === 'not_observed') {
        if (onCleanup.kind === 'refuse') refuse(onCleanup.unseen, `NOT OBSERVED: ${seen.what}, ${seen.why}`);
        else unobserved.push(`${seen.what}, ${seen.why}`);
        continue;
      }

      for (const finding of seen.findings) {
        if (finding.attribution.kind !== 'own') continue;

        switch (onCleanup.kind) {
          case 'refuse':
            refuse(onCleanup.found, finding.next === undefined ? finding.what : `${finding.what}: ${finding.next}`);
            break;
          case 'remove':
            if (finding.remove !== undefined) removals.push({ what: finding.what, command: finding.remove, ...(finding.gone && { gone: finding.gone }) });
            break;
          case 'keep':
            break;
          default: {
            const unknown: never = onCleanup;
            void unknown;
          }
        }
      }
    }
  }

  return refusals.size > 0 ? { kind: 'refuse', refusals: [...refusals].map(([why, items]) => ({ why, items })) } : { kind: 'remove', removals, unobserved };
}

/** Cleanup's plan for `world`, from every row a world of its tier needs, each line it prints masked as the ledger's. */
export async function planCleanup(world: World): Promise<CleanupPlan> {
  const { context, tier } = await contextOf(world);
  const rows = await rowsFor(tier);
  const plan = cleanupPlan(await Promise.all(rows.map(async (row) => ({ onCleanup: row.onCleanup, observed: await row.observe(context) }))));
  const { mask } = ledgerRedactor({ passedNames: world.passed ?? [], harnessEnv: process.env });

  return plan.kind === 'refuse'
    ? { ...plan, refusals: plan.refusals.map((refusal) => ({ ...refusal, items: refusal.items.map(mask) })) }
    : { ...plan, removals: plan.removals.map((removal) => ({ ...removal, what: mask(removal.what) })), unobserved: plan.unobserved.map(mask) };
}
