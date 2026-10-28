/**
 * The running runs published on `teamai-reports`, which another install can continue: offered to whoever takes one next, or held by the
 * install that claimed it. `workflow resume` lists them beside this machine's running runs, `workflow resume --next`
 * takes one, and the dashboard shows them. This module reads the reports checkout as the caller's last refresh left it,
 * and claims nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowEnv } from './env-resolution.js';
import { log } from './utils/logger.js';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from './types.js';
import { describeWorkflow } from './workflow/describe.js';
import { canFor, ceilingOf, isLeft, localReason, stepNeeds } from './workflow/drivers/skill/skill-driver.js';
import { listOf } from './workflow/drivers/skill/preflight.js';
import { launchToolFor } from './workflow/drivers/local/local-driver.js';
import { memberTools, type MemberTool } from './tool-launch/call.js';
import { executableOf, type LaunchTool } from './tool-launch/tools.js';
import { resolveCliPath } from './utils/cli-path.js';
import { sameEnvName } from './resources/env-key.js';
import type { EnvFacts } from './workflow/requirements.js';
import { definitionsOf, settledSteps } from './workflow/handoff.js';
import { invokeRefusal, type InvokeCaller } from './workflow/protocol.js';
import { parseSnapshot, SNAPSHOTS_DIR, snapshotPath, type HandoffOwner, type RunSnapshot } from './workflow/snapshot.js';
import { installOwner, readRuns, RunIdSchema, type RunId } from './workflow/store.js';
import type { RunState, RunStatus, WorkflowFailure } from './workflow/types.js';

/**
 * Who would take an offered run: the calling process, as `invoke` judges it, whether a person answers what the run asks
 * them, as its driver finds out, and the driver it would drive the run with: the local driver with `--tools` `tools`, or
 * the skill driver, whose session runs the prompt steps.
 */
export type Taker = { caller: InvokeCaller; hasPerson: boolean } & ({ driver: 'local'; tools: Record<string, string> } | { driver: 'skill' });

/** Something the steps an offered run has left need that this machine lacks: why, as a clause, and what gives it. */
export interface Lack {
  reason: string;
  fix: string;
}

/** An offered run, as `taker` would find it. */
export interface Offer {
  at: string;
  /** What in the steps the run has not settled for good needs a person, a clause each; empty when a runner can finish it. */
  needs: string[];
  /** What those steps need that this machine lacks: env with no value here, or for the local driver a prompt tool. */
  lacks: Lack[];
  /** Why `taker` may not take it at all: its `invoke` refuses the caller, it needs the local driver, or its workflows cannot be read here. */
  refusal?: WorkflowFailure;
}

/** A running run some install published: offered while `offer` is set, else held by `owner`, who drives it. */
export interface PublishedRun {
  run: RunId;
  workflow: string;
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
  const tools = taker.driver === 'local' ? toolLacks(config, taker.tools, await memberTools(config)) : () => [];
  const runs = await Promise.all(running.map(async (snapshot): Promise<PublishedRun> => ({
    run: RunIdSchema.parse(snapshot.run),
    workflow: snapshot.name,
    owner: snapshot.owner,
    ownedAt: snapshot.ownedAt,
    ...(snapshot.repository !== undefined ? { repository: snapshot.repository } : {}),
    ...(snapshot.offered ? { offer: await offerOf(config, snapshot, snapshot.offered.at, { taker, env, tools }) } : {}),
  })));
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
 * steps the run has not settled for good that need a person, as the skill driver's unattended resume counts them; the
 * run's `invoke` for the caller; and, for the skill driver, a local route.
 */
async function offerOf(config: LocalConfig, snapshot: RunSnapshot, at: string, { taker, env, tools }: { taker: Taker; env: WorkflowEnv; tools: ToolLacks }): Promise<Offer> {
  const definitions = await definitionsOf(config, snapshot);
  if (!definitions.ok) return { at, needs: [], lacks: [], refusal: { code: definitions.error.code, message: definitions.error.message } };
  const { definition, workflows } = definitions.value;
  const description = describeWorkflow({
    definition, workflows, ceiling: ceilingOf(config), can: canFor(undefined), allow: config.workflows?.allow ?? {}, env: env.facts,
  });
  const settled = new Set(settledSteps({ definition, workflows, steps: snapshot.steps }));
  const needs = stepNeeds(description, settled);
  const left = description.facts.runs.filter((run) => isLeft(run.step, settled));
  const local = taker.driver === 'skill' ? localReason(description) : undefined;
  const refusal = invokeRefusal(definition, taker.caller, { kind: 'continue', run: RunIdSchema.parse(snapshot.run) })
    ?? (local !== undefined ? { code: 'needs_local_driver', message: local } : undefined);
  return { at, needs, lacks: [...envLacks(left, env.facts), ...tools(left)], ...(refusal ? { refusal } : {}) };
}

/** What the prompt steps among `runs` lack here: a tool to run on, or one on PATH. */
type ToolLacks = (runs: ReadonlyArray<{ step: string; executor: 'command' | 'prompt'; agent?: string }>) => Lack[];

/**
 * {@link ToolLacks} for the local driver here with `--tools` `flags`: the tool a prompt step of each agent runs on, as the
 * driver picks it, and whether its executable is on PATH, looked up once a tool.
 */
function toolLacks(config: LocalConfig, flags: Record<string, string>, members: MemberTool[]): ToolLacks {
  const onPath = new Map<LaunchTool, boolean>();
  const found = (tool: LaunchTool): boolean => onPath.get(tool) ?? onPath.set(tool, resolveCliPath(executableOf(tool)) !== null).get(tool) === true;
  return (runs) => {
    const byAgent = new Map<string | undefined, Array<{ step: string }>>();
    for (const run of runs) if (run.executor === 'prompt') byAgent.set(run.agent, [...byAgent.get(run.agent) ?? [], run]);
    return [...byAgent].flatMap(([agent, prompts]): Lack[] => {
      const steps = `the prompt step${prompts.length > 1 ? 's' : ''} ${listOf(prompts.map((run) => run.step))}`;
      const flag = agent === undefined ? 'default' : agent;
      const choice = launchToolFor(agent, config, flags, members);
      if (choice.ok) {
        return found(choice.tool) ? [] : [{ reason: `${steps} run on ${choice.tool}, which is not on PATH here`, fix: `install ${choice.tool}, or pass --tools ${flag}=<tool> for one that is` }];
      }
      if (choice.failure.code === 'tool_unconfigured') {
        return [{ reason: `no tool is configured here for ${steps}`, fix: `pass --tools ${flag}=<tool>, or set workflows.tools.${flag}` }];
      }
      return [{ reason: `${choice.failure.message}, for ${steps}`, fix: `pass --tools ${flag}=<tool> with a tool teamai launches` }];
    });
  };
}

/** What `runs` require of env that `env` cannot give here: a key with no value, or any key while the team env is unreadable. */
function envLacks(runs: ReadonlyArray<{ step: string; env: string[] }>, env: EnvFacts): Lack[] {
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
    fix: `${keys.map((key) => `teamai env set ${key}`).join(', ')}, or set ${one ? 'it' : 'them'} in the environment`,
  }];
}

/**
 * The runs `workflow resume --next` tries, in order, from `runs` as `list` gave them: offered by an install other than
 * `self`, in business repository `repository`, refused by nothing, and, unless `hasPerson`, with no step left that needs
 * a person, since `--auto-approve` answers none of them.
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
