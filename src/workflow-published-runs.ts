/**
 * The running runs published on `teamai-reports`, which another install can continue: offered to whoever takes one next, or held by the
 * install that claimed it. `workflow resume` lists them beside this machine's running runs, `workflow resume --next`
 * takes one, and the dashboard shows them. This module reads the reports checkout as the caller's last refresh left it,
 * and claims nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DefaultWorkflows } from './default-workflows.js';
import type { WorkflowEnv } from './env-resolution.js';
import { log } from './utils/logger.js';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from './types.js';
import { describeWorkflow, type WorkflowDescription } from './workflow/describe.js';
import { canFor, ceilingOf, isLeft, listOf, localReason, personClauses } from './workflow/drivers/skill/skill-driver.js';
import { launchToolFor } from './workflow/drivers/local/local-driver.js';
import { memberTools, type MemberTool } from './tool-launch/member-tools.js';
import { launchExecutableOf, type LaunchTarget } from './tool-launch/tools.js';
import { sameEnvName } from './resources/env-key.js';
import { envAdvice, type EnvFacts } from './workflow/requirements.js';
import { personSteps, type PersonStep } from './workflow/engine.js';
import { definitionsOf, handedRun, settledSteps } from './workflow/handoff.js';
import { invokeRefusal, type InvokeCaller } from './workflow/protocol.js';
import { parseSnapshot, SNAPSHOTS_DIR, snapshotPath, type HandoffOwner, type RunSnapshot } from './workflow/snapshot.js';
import { installOwner, readRuns, RunIdSchema, type RunId } from './workflow/store.js';
import { onlyPersonAnswers, type RunState, type RunStatus, type WorkflowFailure } from './workflow/types.js';

/**
 * Who would take an offered run: the calling process, as `invoke` judges it, whether a person answers what the run asks
 * them, as its driver finds out, and the driver it would drive the run with: the local driver with `--tools` `tools`,
 * answering optional gates when `autoApprove`, or the skill driver, whose session runs the prompt steps.
 */
export type Taker = { caller: InvokeCaller; hasPerson: boolean } & ({ driver: 'local'; tools: Record<string, string>; sandbox: boolean; autoApprove?: boolean } | { driver: 'skill' });

/** Something the steps an offered run has left need that this machine lacks: why, as a clause, and what gives it. */
export interface Lack {
  reason: string;
  fix: string;
}

/** An offered run, as `taker` would find it. */
export interface Offer {
  at: string;
  /**
   * What needs a person before `taker` can go on, a clause each; empty when a runner can take the run: the steps ready
   * now in the published state that only a person can take, such as an approval the run was handed back at.
   */
  needs: string[];
  /**
   * The steps the run has not settled for good that may need a person, whether or not the run reaches them. A runner
   * takes the run anyway, and hands it back to a person if it reaches one.
   */
  mayNeed: string[];
  /** What those steps need of the machine that runs them, whichever it is: the env keys they require, and the prompt steps among them, which run on a tool. */
  uses: { env: string[]; prompts: string[] };
  /** What those steps need that this machine lacks: env with no value here, or for the local driver a prompt tool. */
  lacks: Lack[];
  /** Why `taker` may not take it at all: its `invoke` refuses the caller, it needs the local driver, or its workflows cannot be read here. */
  refusal?: WorkflowFailure;
}

/** A running run some install published: offered while `offer` is set, else held by `owner`, who drives it. */
export interface PublishedRun {
  run: RunId;
  workflow: string;
  /** The alias that started the workflow, the name people use for it; absent when it had none. */
  alias?: string;
  owner: HandoffOwner;
  ownedAt: string;
  /** The business repository it works in, as `host/owner/repo`; unknown for a run published before teamai recorded it. */
  repository?: string;
  offer?: Offer;
}

/**
 * A run `workflow resume` can continue in a checkout: one another install offers for its business repository, or one of
 * this machine's running runs, as teamai-reports shows it: held here, claimed by another install since, or ended there.
 */
export type ResumableRun =
  | { kind: 'offered'; published: PublishedRun & { offer: Offer } }
  | { kind: 'here'; run: RunState; isOffered: boolean }
  | { kind: 'claimed'; run: RunState; owner: HandoffOwner; ownedAt: string }
  | { kind: 'ended'; run: RunState; owner: HandoffOwner; status: Exclude<RunStatus, 'running'> };

/**
 * Every running run on this machine's reports checkout, offered ones first, oldest offer first, then held ones, the
 * latest claim first. Each offered one says what holds it back from `taker`. A snapshot this teamai cannot read is left
 * out. Reads no network; reads the team commit a run's workflows came from when this machine's cache differs.
 */
async function list(config: LocalConfig, { taker, env }: { taker: Taker; env: WorkflowEnv }): Promise<PublishedRun[]> {
  if (!usesBranchWorktree(config)) return [];
  const root = path.join(getReportsDir(config), SNAPSHOTS_DIR);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  const snapshots = await Promise.all(entries.flatMap((entry) => {
    const run = RunIdSchema.safeParse(entry.name);

    return entry.isDirectory() && run.success ? [readSnapshot(config, run.data)] : [];
  }));

  const running = snapshots.filter((snapshot): snapshot is RunSnapshot => snapshot?.status === 'running');
  const toolLacksOf = taker.driver === 'local' ? toolLacks(config, taker.tools, await memberTools(config)) : () => [];

  const runs = await Promise.all(running.map(async (snapshot): Promise<PublishedRun> => {
    const run = RunIdSchema.parse(snapshot.run);
    const aliased: Pick<PublishedRun, 'alias'> = {};

    if (snapshot.alias !== undefined) aliased.alias = snapshot.alias;
    const located: Pick<PublishedRun, 'repository'> = {};

    if (snapshot.repository !== undefined) located.repository = snapshot.repository;
    const published: PublishedRun = { run, workflow: snapshot.name, ...aliased, owner: snapshot.owner, ownedAt: snapshot.ownedAt, ...located };

    if (snapshot.offered) published.offer = await offerOf(config, snapshot, snapshot.offered.at, { taker, env, toolLacksOf });

    return published;
  }));

  const offered = runs.filter((run) => run.offer).sort((left, right) => (left.offer?.at ?? '').localeCompare(right.offer?.at ?? ''));
  const held = runs.filter((run) => !run.offer).sort((left, right) => right.ownedAt.localeCompare(left.ownedAt));

  return [...offered, ...held];
}

async function readSnapshot(config: LocalConfig, run: RunId): Promise<RunSnapshot | undefined> {
  const text = await fs.readFile(path.join(getReportsDir(config), snapshotPath(run)), 'utf8').catch(() => undefined);

  if (text === undefined) return undefined;
  const parsed = parseSnapshot(text, run);

  if (parsed.ok) return parsed.value;
  log.debug(`[workflow] left out run ${run} from teamai-reports: ${parsed.error.message}`);

  return undefined;
}

/**
 * Offered run `snapshot` as `taker` finds it, judged from the run's own workflows by the rules a resume applies: the
 * steps ready now that only a person can take, and those left that may need one; what
 * those steps use of a machine, and what of it this one lacks, its env and, by `toolLacksOf`, its prompt tools; the
 * run's `invoke` for the caller; and, for the skill driver, a local route.
 */
async function offerOf(config: LocalConfig, snapshot: RunSnapshot, at: string, { taker, env, toolLacksOf }: { taker: Taker; env: WorkflowEnv; toolLacksOf: ToolLacks }): Promise<Offer> {
  const definitions = await definitionsOf(config, snapshot);

  if (!definitions.ok) return { at, needs: [], mayNeed: [], uses: { env: [], prompts: [] }, lacks: [], refusal: { code: definitions.error.code, message: definitions.error.message } };
  const { definition, workflows } = definitions.value;

  const description = describeWorkflow({
    definition, source: DefaultWorkflows.sourceOfRun(snapshot), workflows, ceiling: ceilingOf(config), can: canFor(undefined), allow: config.workflows?.allow ?? {}, env: env.facts,
  });

  const settled = new Set(settledSteps({ definition, workflows, steps: snapshot.steps }));

  // The skill driver's session answers every optional gate: its agent, or auto-approve in an unattended run (R19, R26).
  const isAutoApproved = taker.driver === 'skill' || (taker.autoApprove ?? config.workflows?.auto_approve === true);
  const needs = personNeeds(personSteps(handedRun(snapshot, definitions.value), new Date().toISOString(), { autoApprove: isAutoApproved }));

  const { facts } = description;

  const mayNeed = [...facts.interactive, ...facts.gates.flatMap((gate) => (onlyPersonAnswers(gate, { autoApprove: isAutoApproved }) ? [gate.step] : []))]
    .filter((step) => isLeft(step, settled));

  const left = description.facts.runs.filter((run) => isLeft(run.step, settled));
  const local = taker.driver === 'skill' ? localReason(description) : undefined;

  const refusal = invokeRefusal(definition, taker.caller, { kind: 'continue', run: RunIdSchema.parse(snapshot.run) })
    ?? (local !== undefined ? { code: 'needs_local_driver', message: local } : undefined);

  const uses = { env: [...new Set(left.flatMap((run) => run.env))], prompts: left.flatMap((run) => (run.executor === 'prompt' ? [run.step] : [])) };

  const isSandbox = taker.driver === 'local' && (taker.sandbox || config.workflows?.sandbox === true);
  const sealed = taker.driver === 'local' && !isSandbox ? sandboxLacks(description.facts.held.filter((held) => isLeft(held.step, settled))) : [];
  const offer: Offer = { at, needs, mayNeed, uses, lacks: [...envLacks(left, env.facts), ...toolLacksOf(left), ...sealed] };

  if (refusal) offer.refusal = refusal;

  return offer;
}

/** `steps`, ready now and only a person can take them, as the clauses the static check words them with. */
function personNeeds(steps: readonly PersonStep[]): string[] {
  return personClauses({
    interactive: steps.flatMap((step) => (step.kind === 'interactive' ? [step.step] : [])),
    gates: steps.flatMap(({ step, kind }) => (kind === 'interactive' ? [] : [{ step, kind }])),
  });
}

/** A step that runs a command or a prompt, with what it needs of the machine that runs it, as describe gives it. */
type StepRun = WorkflowDescription['facts']['runs'][number];

/** What the prompt steps among `runs` lack here: a tool to run on, or one on PATH. */
type ToolLacks = (runs: readonly StepRun[]) => Lack[];

/** How long a PATH lookup holds, so a dashboard that lists every few seconds does not spawn a shell each time. */
const PATH_LOOKUP_MS = 60_000;
const pathLookups = new Map<string, { isFound: boolean; at: number }>();

/**
 * Whether the command that starts `target` is on PATH here, as the launcher would find it, looked up at most once a
 * minute. Keyed by name: an instance and a shipped tool with one command are looked up differently.
 */
function isOnPath(target: LaunchTarget): boolean {
  const known = pathLookups.get(target.name);

  if (known && Date.now() - known.at < PATH_LOOKUP_MS) return known.isFound;
  const isFound = launchExecutableOf(target) !== null;
  pathLookups.set(target.name, { isFound, at: Date.now() });

  return isFound;
}

/**
 * {@link ToolLacks} for the local driver here with `--tools` `flags`: the tool a prompt step of each agent, or its own
 * `tool`, runs on, as the driver picks it, and whether its executable is on PATH.
 */
function toolLacks(config: LocalConfig, flags: Record<string, string>, members: MemberTool[]): ToolLacks {
  return (runs) => {
    const byChoice = new Map<string, { agent: string | undefined; tool: string | undefined; prompts: StepRun[] }>();

    for (const run of runs) {
      // An answer runs on the member's AI tool, whatever the workflow tools say.
      if (run.executor !== 'prompt' || run.answer) continue;
      const key = JSON.stringify([run.agent, run.tool]);
      const group = byChoice.get(key) ?? { agent: run.agent, tool: run.tool, prompts: [] };
      byChoice.set(key, { ...group, prompts: [...group.prompts, run] });
    }

    // A step with no tool configured for its agent falls back to --tools default, so one default covers them all.
    const unconfigured: StepRun[] = [];

    const lacks = [...byChoice.values()].flatMap(({ agent, tool, prompts }): Lack[] => {
      const steps = promptSteps(prompts);
      const flag = agent === undefined ? 'default' : agent;
      const choice = launchToolFor({ agent, tool }, config, flags, members);

      if (choice.ok) {
        // A step's own tool wins over --tools, so only installing it helps.
        const { name } = choice.target;
        const fix = tool === undefined ? `install ${name}, or pass --tools ${flag}=<tool> for one that is` : `install ${name}`;

        return isOnPath(choice.target) ? [] : [{ reason: `${steps} ${prompts.length > 1 ? 'run' : 'runs'} on ${name}, which is not on PATH here`, fix }];
      }

      if (choice.failure.code === 'tool_unconfigured') {
        unconfigured.push(...prompts);

        return [];
      }

      const fix = tool === undefined
        ? `pass --tools ${flag}=<tool> with a tool teamai launches`
        : `its workflow names tool ${tool}, which teamai does not launch here; continue it with a driver that launches ${tool}`;

      return [{ reason: `${steps} ${prompts.length > 1 ? 'have' : 'has'} no tool teamai launches here (${choice.failure.message.replace(/\.$/, '')})`, fix }];
    });

    if (unconfigured.length === 0) return lacks;

    return [{ reason: `no tool is configured here for ${promptSteps(unconfigured)}`, fix: 'pass --tools default=<tool>, or set workflows.tools.default' }, ...lacks];
  };
}

/** `runs` as a clause: "the prompt step a" or "the prompt steps a and b". */
function promptSteps(runs: readonly StepRun[]): string {
  return `the prompt step${runs.length > 1 ? 's' : ''} ${listOf(runs.map((run) => run.step))}`;
}

/** What the steps among `held` that need strict isolation lack on a machine the local driver does not declare a sandbox. */
function sandboxLacks(held: WorkflowDescription['facts']['held']): Lack[] {
  const steps = held.filter(({ missing }) => missing.includes('isolation')).map(({ step }) => step);

  if (steps.length === 0) return [];

  return [{
    reason: `${listOf(steps)} need${steps.length > 1 ? '' : 's'} a sandbox, which this machine does not declare`,
    fix: 'pass --sandbox on a disposable host, such as a CI runner or a container, or set workflows.sandbox: true',
  }];
}

/** What `runs` require of env that `env` cannot give here: a key with no value, or any key while the team env is unreadable. */
function envLacks(runs: readonly StepRun[], env: EnvFacts): Lack[] {
  const absent = (keys: readonly string[]): string[] => (env.unreadable !== undefined ? [...keys] : keys.filter((key) => sameEnvName(env.present, key) === undefined));
  const short = runs.filter((run) => absent(run.env).length > 0);

  if (short.length === 0) return [];
  const keys = [...new Set(short.flatMap((run) => absent(run.env)))];
  const steps = short.map((run) => run.step);
  const require = `${listOf(steps)} require${steps.length > 1 ? '' : 's'} env ${listOf(keys)}`;

  if (env.unreadable !== undefined) {
    return [{ reason: `${require}, and the team env cannot be read here: ${env.unreadable}`, fix: 'teamai env list, and fix what it reports' }];
  }

  const one = keys.length === 1;

  return [{
    reason: `${require}, which ${one ? 'has' : 'have'} no value here`,
    fix: envAdvice(keys, env.declared),
  }];
}

/**
 * The runs `workflow resume --next` tries, in order, from `runs` as `list` gave them: offered by an install other than
 * `self`, in business repository `repository`, refused by nothing, and, unless `hasPerson`, with nothing that needs a
 * person before the taker can go on, since `--auto-approve` answers none of it.
 */
function candidates(runs: readonly PublishedRun[], { repository, hasPerson, self }: { repository: string | undefined; hasPerson: boolean; self: string }): PublishedRun[] {
  return runs.filter(({ offer, owner, repository: of }) => offer !== undefined && owner.id !== self && repository !== undefined && of === repository
    && offer.refusal === undefined && offer.lacks.length === 0 && (hasPerson || offer.needs.length === 0));
}

/**
 * The runs a checkout of business repository `repository` can resume, a run once: the ones other installs offer for it,
 * oldest offer first, then this machine's running runs, newest first. A run of this machine that another install
 * claimed and offers again is listed as offered. No run is offered to a checkout whose repository is unknown, since
 * `--next` takes none there.
 */
async function resumable(config: LocalConfig, { taker, env, repository }: { taker: Taker; env: WorkflowEnv; repository: string | undefined }): Promise<ResumableRun[]> {
  const [published, self, runs] = await Promise.all([list(config, { taker, env }), installOwner(config), readRuns(config)]);
  const local = runs.filter((run) => run.status === 'running').sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const mine = await Promise.all(local.map(async (run): Promise<Exclude<ResumableRun, { kind: 'offered' }> | undefined> => {
    const read = run.publication === undefined || !usesBranchWorktree(config) ? undefined : await readSnapshot(config, RunIdSchema.parse(run.id));
    const snapshot = read?.createdAt === run.createdAt ? read : undefined;

    if (snapshot === undefined || snapshot.owner.id === self.id) return { kind: 'here', run, isOffered: snapshot?.offered !== undefined };

    if (snapshot.status !== 'running') return { kind: 'ended', run, owner: snapshot.owner, status: snapshot.status };

    return snapshot.offered === undefined ? { kind: 'claimed', run, owner: snapshot.owner, ownedAt: snapshot.ownedAt } : undefined;
  }));

  const held = mine.filter((row) => row !== undefined);
  const here = new Set(held.map((row) => row.run.id));

  const offered = published.flatMap((run): ResumableRun[] => (run.offer !== undefined && run.owner.id !== self.id && repository !== undefined
    && run.repository === repository && !here.has(run.run) ? [{ kind: 'offered', published: { ...run, offer: run.offer } }] : []));

  return [...offered, ...held];
}

export const PublishedRuns = { list, candidates, resumable } as const;
