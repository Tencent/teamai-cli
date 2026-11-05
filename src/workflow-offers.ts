/**
 * What teamai offers a session of its default workflows: whether a hook may offer one to the session it runs in, and
 * the values `workflow start --describe` proposes for a workflow's inputs, each with why. The skill driver asks this
 * module for proposals without naming a workflow; the proposers below are the one place a workflow's name picks the
 * module that knows its inputs. A team file that replaces a default keeps the proposals its declared inputs match.
 */
import { loadLocalConfigForScope } from './config.js';
import type { SessionRun } from './launch-context.js';
import { getDataHome, type LocalConfig } from './types.js';
import { nestedStart } from './workflow/attempt-marker.js';
import { loadWorkflowTree, resolveStart } from './workflow/cache.js';
import { projectPartitions } from './workflow/run-location.js';
import type { OutputSchema } from './workflow/types.js';

/** A value teamai proposes for one input, or none, and why. */
export type Proposal = { value?: unknown; why: string };

/** The workflow describe proposes for: its name and declared inputs. */
type Described = { name: string; inputs: Readonly<Record<string, OutputSchema>> };

/** The session that calls describe, when an agent session does, its tool, and the directory it works in. */
type Caller = { session: string | undefined; tool: string | undefined; cwd: string };

type Proposer = (config: LocalConfig, workflow: Described, caller: Caller) => Promise<Record<string, Proposal>>;

const shareProposer = async (): Promise<Proposer> => (await import('./session-share.js')).SessionShare.proposals;

/**
 * The module that proposes the inputs of each default, by name. Each loads only when describe asks, since the
 * modules that propose also read the hooks' state, which the skill driver does not need otherwise.
 */
const PROPOSERS: ReadonlyMap<string, () => Promise<Proposer>> = new Map([
  ['teamai-share-learnings', shareProposer],
  ['teamai-share-session', shareProposer],
  ['teamai-session-to-task', async () => (await import('./session-to-task.js')).SessionToTask.proposals],
  ['teamai-import-from-mr', async () => (await import('./mr-hint.js')).MrHintOffer.proposals],
]);

/** What describe proposes for the declared inputs of `workflow`, by input; nothing for a workflow no proposer names. */
async function proposals(config: LocalConfig, workflow: Described, caller: Caller): Promise<Record<string, Proposal>> {
  const proposer = PROPOSERS.get(workflow.name);

  return proposer ? (await proposer())(config, workflow, caller) : {};
}

function sameType(left: OutputSchema, right: OutputSchema): boolean {
  if (left.type === 'enum' && right.type === 'enum') return [...left.values].sort().join('\0') === [...right.values].sort().join('\0');

  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The declared `inputs` a proposer's `contract` names with the same type: those a team override keeps get filled, by
 * name and parsed type, and an enum matches in any order.
 */
function contractInputs<TInput extends string>(inputs: Readonly<Record<string, OutputSchema>>, contract: Readonly<Record<TInput, OutputSchema>>): TInput[] {
  const named = (input: string): input is TInput => Object.hasOwn(contract, input);

  return Object.entries(inputs).flatMap(([input, type]) => (named(input) && sameType(type, contract[input]) ? [input] : []));
}

/**
 * The config a start of `workflow` would run in, when a hook may offer it to session `sessionId`, which works in `cwd`
 * in a session of `run`. Undefined in a session teamai launched, one that runs unattended, one in a workflow place,
 * where no start is allowed, one that drives a skill-driven run not done yet in this machine's data homes, and where
 * `workflow` resolves to no definition, to one whose `invoke` is deny, or to one that cannot start, such as with a team
 * sub-workflow of other inputs.
 */
async function offerable(config: LocalConfig, workflow: string, { sessionId, cwd, run }: { sessionId: string; cwd: string; run: SessionRun }): Promise<LocalConfig | undefined> {
  if (run.launchedBy !== undefined || run.runMode === 'unattended' || (await nestedStart(process.env, cwd)) !== undefined) return undefined;
  const start = await resolveStart(config, workflow);

  if (!start.workflow || (start.workflow.definition.invoke ?? 'deny') === 'deny') return undefined;

  // A sub-workflow the team replaced with other inputs would fail the run after its first steps ran.
  if ('failed' in await loadWorkflowTree(start.config, start.workflow)) return undefined;
  // The skill driver imports this module for describe, so this one loads it only here.
  const { drivesUndoneRun } = await import('./workflow/drivers/skill/skill-driver.js');
  // A run lives in the data home of the scope it was started in, and a session drives it from any directory.
  const [user, partitions] = await Promise.all([loadLocalConfigForScope('user', undefined, { dryRun: true }), projectPartitions()]);
  const homes = new Map([config, ...(user ? [user] : []), ...partitions].map((home) => [getDataHome(home), home]));

  if ((await Promise.all([...homes.values()].map((home) => drivesUndoneRun(home, sessionId)))).some(Boolean)) return undefined;

  return start.config;
}

export const WorkflowOffers = { proposals, contractInputs, offerable } as const;
