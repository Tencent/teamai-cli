/**
 * Workspace planning. The engine names the branch and lists the commits to merge.
 * A driver creates the worktree. This module does not run git.
 */
import { z } from 'zod';
import { sameDriver } from '../driver-identity.js';
import type { JsonValue } from '../types.js';
import { jsonType } from './expression.js';
import { itemsAfter, itemsOf } from './fan-out.js';
import { localId, statesIn, stepDefinitions, type Scope } from './scope.js';
import { parseStepPath } from './step-path.js';
import { renderValue, stepRoleSpec, type StepRoleSpec } from './template.js';
import { passOf, type Delivery, type StepState } from './step-state.js';
import { ClonePlaceSchema, type ClonePlace } from './clone.js';
import { parseTemplate, renderText } from './template.js';
import { isWorkflowFile, stepWorkflow, workflowRunBy, type DriverIdentity, type InlineWorkflow, type RunState, type TeamPlace, type WorkflowDefinition, type WorkflowFailure, type WorkflowStep, type WORKSPACE_MODES } from './types.js';

export type WorkspaceMode = typeof WORKSPACE_MODES[number];

/** What a driver reports for a step that ran in a change branch. */
export interface StepChanges {
  branch: string;
  base: string;
  from: string;
  to: string;
  commits: string[];
}

/**
 * The git contract on a lease that runs in a copy. Paths stay off it. A `new` or `continue` step commits to `branch`.
 * A `read-only` step inside a copy runs in `branch`'s worktree, merges and commits nothing, and leaves it as it was.
 * A `team` step commits to `branch` of the team repo, in a clone the driver makes of it: the commits it starts from and
 * merges are origin's when the clone is made, so none is named here.
 */
export type WorkspaceContract = CopyContract | z.infer<typeof TeamContractSchema>;

/** The contract of a copy of the run's repository, or of a clone teamai prepares. */
export type CopyContract = {
  base: { ref?: string; commit: string };
  /** The commit agent configuration is restored from before the step runs. */
  configCommit: string;
  branch: string;
  start: { commit: string; branch?: string };
} & (
  /** `clone`: the copy is the clone a step opened, which teamai prepares; it merges nothing and is never pushed. */
  | { mode: 'new' | 'continue'; merge: Array<{ branch: string; commit: string }>; clone?: ClonePlace }
  | { mode: 'read-only'; merge: [] }
);

const ContractFields = {
  base: z.object({ ref: z.string().optional(), commit: z.string() }),
  configCommit: z.string(),
  branch: z.string(),
  start: z.object({ commit: z.string(), branch: z.string().optional() }),
};

const CopyContractOptions = [
  z.object({ ...ContractFields, mode: z.enum(['new', 'continue']), merge: z.array(z.object({ branch: z.string(), commit: z.string() })), clone: ClonePlaceSchema.optional() }),
  z.object({ ...ContractFields, mode: z.literal('read-only'), merge: z.tuple([]) }),
] as const;

export const CopyContractSchema = z.discriminatedUnion('mode', CopyContractOptions) satisfies z.ZodType<CopyContract>;

export const TeamContractSchema = z.object({ mode: z.literal('team'), branch: z.string().min(1) });

export const WorkspaceContractSchema = z.discriminatedUnion('mode', [...CopyContractOptions, TeamContractSchema]) satisfies z.ZodType<WorkspaceContract>;

export interface SessionRef {
  tool: string;
  id: string;
}

/** The session a lease resumes, with the sessions it continued, newest first, for a driver that cannot resume it. */
export interface LeaseSession extends SessionRef {
  earlier?: SessionRef[];
}

export interface WorkspacePlan {
  mode: WorkspaceMode;
  contract?: WorkspaceContract;
  session?: LeaseSession;
  /**
   * The step stays pending. `next` does not hand it to this driver: it lacks the workspace mode `needs`, or, without
   * `needs`, another driver owns the copy.
   */
  defer?: { reason: string; needs?: WorkspaceMode };
  fail?: WorkflowFailure;
}

/** A branch name that includes the run, the step path, and the pass, and is safe in a ref. */
export function branchName(runId: string, stepPath: string, pass: number): string {
  const safe = parseStepPath(stepPath).map((segment) => {
    const plain = /^[A-Za-z0-9]+$/.test(segment.id);
    const readable = segment.id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = plain ? segment.id : `${readable || 'step'}-x${Buffer.from(segment.id).toString('hex')}`;

    return segment.index === undefined ? id : `${id}-${segment.index}`;
  }).join('-') || 'step';

  return `teamai/${runId}/${safe}/p${pass}`;
}

/**
 * How a step runs. An explicit `workspace` wins. A command that omits it is read-only, even inside a copy, which it reads.
 * A prompt that omits it continues the nearest enclosing copy, or stays read-only. A `for_each` copy is `new`
 * per item, so siblings do not share a worktree.
 */
export function resolveMode(step: WorkflowStep, ancestors: WorkflowStep[]): WorkspaceMode {
  switch (step.workspace) {
    case undefined:
      break;
    case 'read-only':
    case 'new':
    case 'continue':
      return step.workspace;
    default:
      return 'clone' in step.workspace ? 'clone' : 'team';
  }

  if (step.command !== undefined && step.prompt === undefined && step.promptFile === undefined) return 'read-only';

  for (const ancestor of ancestors.toReversed()) {
    if (cloneOf(ancestor)) return 'continue';

    if (ancestor.workspace !== 'new' && ancestor.workspace !== 'continue') continue;

    return ancestor.forEach ? 'new' : 'continue';
  }

  return 'read-only';
}

/** The place `step`'s workspace names, a clone or the team repo, or undefined when it names a mode or none. */
function placeOf(step: WorkflowStep): Exclude<WorkflowStep['workspace'], string | undefined> | undefined {
  switch (step.workspace) {
    case undefined:
    case 'read-only':
    case 'new':
    case 'continue':
      return undefined;
    default:
      return step.workspace;
  }
}

/** The clone `step` opens, or undefined when it opens none. */
export function cloneOf(step: WorkflowStep): ClonePlace | undefined {
  const place = placeOf(step);

  return place && 'clone' in place ? place.clone : undefined;
}

/** The clone a lease's contract runs in, or undefined when it runs in none. */
export function contractClone(contract: WorkspaceContract | undefined): ClonePlace | undefined {
  return contract?.mode === 'new' || contract?.mode === 'continue' ? contract.clone : undefined;
}

/** The team repo branch `step` commits to, or undefined when it runs in no team workspace. */
function teamOf(step: WorkflowStep): TeamPlace | undefined {
  const place = placeOf(step);

  return place && 'team' in place ? place.team : undefined;
}

/**
 * Whether a run of `definition` is isolated: a step of it, or of a workflow it runs, opens a clone. An isolated run is
 * never published, claimed, retried or counted in member stats, and its sessions and labels stay off the team's.
 */
export function isIsolated(run: Pick<RunState, 'definition' | 'workflows'>): boolean {
  // What a `from` step runs is admitted only when its producer reports, after the run started, so it may open one.
  return someStep(run, (step) => cloneOf(step) !== undefined || stepWorkflow(step)?.kind === 'from');
}

/** Whether a step of `run`, or of a workflow it runs, works in the team workspace, whose clone only the machine that ran it has. */
export function worksInTeam(run: Pick<RunState, 'definition' | 'workflows'>): boolean {
  return someStep(run, (step) => teamOf(step) !== undefined);
}

/** Whether `matches` holds for a step of `run`, of a workflow it runs inline, or of one it admitted. */
function someStep(run: Pick<RunState, 'definition' | 'workflows'>, matches: (step: WorkflowStep) => boolean): boolean {
  const found = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const child = stepWorkflow(step);

    return matches(step) || (child?.kind === 'inline' && found(child.workflow.steps));
  });

  return [run.definition, ...Object.values(run.workflows ?? {})].some((definition) => found(definition.steps));
}

/** Whether a step runs in the member's checkout as it is: read-only, with no enclosing step that opens a copy. */
export function runsInCheckout(step: WorkflowStep, ancestors: WorkflowStep[]): boolean {
  return resolveMode(step, ancestors) === 'read-only' && !ancestors.some(opensCopy);
}

/**
 * Why a run of `definition` cannot deliver what its steps declare, or undefined when it can. A step in a sub-workflow
 * continues the copy of the step that runs it, so this reads the whole tree a run executes, which one file cannot.
 * `base` is the checkout the run starts from: a pull request targets a branch, and a detached HEAD has none.
 */
export function deliveryProblem(
  definition: WorkflowDefinition, workflows: Record<string, WorkflowDefinition>, base: RunState['base'],
): WorkflowFailure | undefined {
  let delivering: string | undefined;
  const childOf = (step: WorkflowStep) => workflowRunBy({ workflows }, step, '');

  const writes = (steps: WorkflowStep[], ancestors: WorkflowStep[]): boolean => steps.some((step) => {
    const child = childOf(step);

    if (child) return writes(child.steps, [...ancestors, step]);

    return (step.prompt !== undefined || step.promptFile !== undefined || (step.workspace !== undefined && step.workspace !== 'read-only'))
      && resolveMode(step, ancestors) !== 'read-only';
  });

  const visit = (steps: WorkflowStep[], ancestors: WorkflowStep[], prefix: string): WorkflowFailure | undefined => {
    for (const step of steps) {
      const path = `${prefix}${step.id}`;
      const child = childOf(step);

      if (step.deliver === 'pr') {
        // A team step's pull request goes into the team repo's default branch, whatever the checkout has checked out.
        if (!teamOf(step)) delivering ??= path;

        if (step.workflow !== undefined && step.workspace !== 'new' && !step.forEach) {
          return { code: 'bad_delivery', message: `Step "${path}" delivers its workflow, so it needs workspace: new to own the branch it delivers.` };
        }

        if (child && !writes(child.steps, [...ancestors, step])) {
          return { code: 'bad_delivery', message: `Step "${path}" has deliver: pr, but no step of the workflow it runs writes a branch, so it would deliver nothing. Set workspace: new on "${path}" so its prompt steps write, or give a step in that workflow workspace: new or continue.` };
        }

        if (step.workflow === undefined && resolveMode(step, ancestors) === 'read-only') {
          return { code: 'bad_delivery', message: `Step "${path}" has deliver: pr but runs read-only. Set workspace: new on it, or on the workflow step that runs it.` };
        }
      }

      const problem = child && visit(child.steps, [...ancestors, step], `${path}.`);

      if (problem) return problem;
    }

    return undefined;
  };

  const problem = visit(definition.steps, [], '');

  if (problem || delivering === undefined || !base || base.ref !== undefined) return problem;

  return {
    code: 'no_base_branch',
    message: `Step "${delivering}" delivers a pull request, but the run would start from a detached HEAD at ${base.commit}, so no branch is there for the pull request to target. Check out a named branch, then start the run again.`,
  };
}

/** How step instance `path` runs, or undefined when the run's definitions have no such step. */
export function stepMode(run: StepTree, path: string): WorkspaceMode | undefined {
  const definition = stepDefinitions(run)(path);

  return definition && resolveMode(definition, ancestorsOf(run, path).map((ancestor) => ancestor.step));
}

interface Ancestor {
  instance: string;
  step: WorkflowStep;
  pass: number;
}

/** What finding a step's workspace reads of a run: its definitions, and the pass of each step instance. */
type StepTree = Pick<RunState, 'definition' | 'workflows'> & { steps: readonly { id: string; pass?: number; item?: unknown }[] };

/** For each steps array, its instances by id. A run's steps array is never changed in place (RunState.steps). */
const instanceIndex = new WeakMap<StepTree['steps'], Map<string, StepTree['steps'][number]>>();

function instanceOf(run: StepTree, id: string): StepTree['steps'][number] | undefined {
  let index = instanceIndex.get(run.steps);

  if (!index) {
    index = new Map();

    for (const state of run.steps) if (!index.has(state.id)) index.set(state.id, state);
    instanceIndex.set(run.steps, index);
  }

  return index.get(id);
}

function ancestorsOf(run: StepTree, path: string): Ancestor[] {
  const definitionOf = stepDefinitions(run);
  const segments = parseStepPath(path);
  const ancestors: Ancestor[] = [];

  for (let length = 1; length < segments.length; length += 1) {
    const instance = segments.slice(0, length).map((segment) => (
      segment.index === undefined ? segment.id : `${segment.id}[${segment.index}]`
    )).join('.');

    const step = definitionOf(instance);

    if (!step) continue;
    ancestors.push({ instance, step, pass: instanceOf(run, instance)?.pass ?? 1 });
  }

  return ancestors;
}

function changesOf(state: StepState | undefined): StepChanges | undefined {
  if (!state || !('changes' in state) || !state.changes) return undefined;

  return state.changes;
}

/**
 * What a step that just succeeded delivers, or undefined when its branch holds nothing beyond the run base. A leaf
 * delivers the branch it reported. A workflow step delivers its own copy once, never per step inside it; one without a
 * copy of its own, such as a `for_each` item that runs a workflow, delivers the branch its latest step wrote.
 */
export function deliverableOf(run: RunState, state: StepState, step: WorkflowStep, changes?: StepChanges): Omit<Delivery, 'reported'> | undefined {
  let branch = changes?.branch;
  let head = changes?.to;

  if (step.workflow !== undefined) {
    branch = workflowBranch(run, state);
    head = branch === undefined ? undefined : run.copies?.[branch]?.commit;
  }

  const copy = branch === undefined ? undefined : run.copies?.[branch];
  const base = copy?.kind === 'team' ? copy.base : run.base?.commit;

  return branch === undefined || head === undefined || head === base ? undefined : { branch, head };
}

/** The branch workflow step `state` delivers: its own copy, else the branch its latest step wrote. */
function workflowBranch(run: RunState, state: StepState): string | undefined {
  const own = branchName(run.id, state.id, state.pass ?? 1);

  if (run.copies?.[own]?.commit !== undefined) return own;

  const latest = run.steps.filter((item) => item.id.startsWith(`${state.id}.`) && item.status !== 'cancelled' && changesOf(item))
    .sort((left, right) => ('settledAt' in right ? right.settledAt : 0) - ('settledAt' in left ? left.settledAt : 0))[0];

  return changesOf(latest)?.branch;
}

/**
 * Work a step inside workflow step `state` wrote beyond the run base, when `state` delivers nothing of its own: no
 * pull request would hold it. Undefined when there is none.
 */
export function workLeftUndelivered(run: RunState, state: StepState): { branch: string; head: string; child: { step: string; branch: string } } | undefined {
  const branch = workflowBranch(run, state);
  const base = run.base?.commit;

  if (branch === undefined || base === undefined) return undefined;
  const child = childWorkOff(run, state, branch).find((item) => item.commit !== base);

  return child && { branch, head: base, child };
}

/**
 * The work steps inside `state` that succeeded left on other branches than `branch`, the one `state` delivers, which no
 * step inside it delivers: a pull request of `branch` leaves out any of it that `branch` does not hold.
 */
export function childWorkOff(run: RunState, state: StepState, branch: string): Array<{ step: string; branch: string; commit: string }> {
  const inside = run.steps.filter((item) => item.id.startsWith(`${state.id}.`) && item.status === 'succeeded');
  const delivered = new Set(inside.flatMap((item) => ('delivery' in item && item.delivery ? [item.delivery.branch] : [])));

  return inside.flatMap((item) => {
    const changes = changesOf(item);

    return changes && changes.branch !== branch && !delivered.has(changes.branch) ? [{ step: item.id, branch: changes.branch, commit: changes.to }] : [];
  });
}

/**
 * The branch a pull request from `branch` goes into: the nearest branch it grew from that delivered a pull request, so
 * the request holds only the work done since, else the run base branch. Undefined when the run started from no branch.
 */
export function deliveryTarget(run: Pick<RunState, 'base' | 'copies' | 'deliveries'>, branch: string): string | undefined {
  const delivered = new Set((run.deliveries ?? []).map((receipt) => receipt.branch));
  const walked = new Set([branch]);

  for (let from = run.copies?.[branch]?.from; from !== undefined && !walked.has(from); from = run.copies?.[from]?.from) {
    if (delivered.has(from)) return from;
    walked.add(from);
  }

  return run.base?.ref;
}

/** Direct steps of a workflow step, such as `work.write`, not its fan-out items. */
function workflowChildren(run: RunState, step: StepState): StepState[] {
  const prefix = `${step.id}.`;

  return run.steps.filter((item) => {
    if (!item.id.startsWith(prefix)) return false;
    // `rest` is a string; these are substring checks, not array membership (the rule can't tell the two apart).
    // oxlint-disable-next-line unicorn/prefer-set-has
    const rest = item.id.slice(prefix.length);

    return !rest.includes('.') && !rest.includes('[');
  });
}

/** Branches a step merges, `after` items first, then its other needs. An omitted `needs` uses the parent step's needs. */
function mergeChanges(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): StepChanges[] {
  const ordered: Array<{ changes: StepChanges; settledAt: number }> = [];
  const visited = new Set<string>();

  const push = (step: StepState | undefined): void => {
    if (!step || visited.has(step.id)) return;
    visited.add(step.id);
    const changes = changesOf(step);

    // A for_each step keeps each item's branch on that item, and a workflow step keeps each child's on that child.
    if (!changes) {
      for (const item of itemsOf(run, step)) push(item);

      for (const child of workflowChildren(run, step)) push(child);
      // A skipped or read-only need wrote no branch, but its earlier dependencies still supply the copy's origin.
      let id: string | undefined = step.id;

      while (id) {
        const defined = stepDefinitions(run)(id);
        const prefix: string = id.includes('.') ? id.slice(0, id.lastIndexOf('.') + 1) : '';

        if (defined?.needs !== undefined) {
          for (const need of defined.needs) push(run.steps.find((item) => item.id === `${prefix}${need}`));
          break;
        }

        id = prefix ? prefix.slice(0, -1) : undefined;
      }

      return;
    }

    const settledAt = 'settledAt' in step ? step.settledAt : 0;
    const earlier = ordered.findIndex((item) => item.changes.branch === changes.branch);

    if (earlier >= 0) {
      if (settledAt > ordered[earlier]!.settledAt) ordered[earlier] = { changes, settledAt };

      return;
    }

    ordered.push({ changes, settledAt });
  };

  for (const itemId of itemIdsIn(state.id)) pushItemAfter(run, itemId, push);
  const inherited = inheritedNeeds(run, scope, definition);

  if (inherited) {
    for (const id of inherited) push(run.steps.find((item) => item.id === id));
  } else {
    const states = statesIn(run, scope);

    for (const id of definition.needs ?? []) push(states.find((item) => localId(scope, item) === id));
  }

  return ordered.map((item) => item.changes);
}

/**
 * The branches a read-only step's own `needs` wrote or read, each with the newest commit a need left or read there.
 * Inherited needs and `after` items are where a copy starts, not what a reader reads, so they are left out.
 */
function readHeads(run: RunState, scope: Scope, definition: WorkflowStep): Array<{ branch: string; commit: string; settledAt: number }> {
  const heads: Array<{ branch: string; commit: string; settledAt: number }> = [];

  const visit = (step: StepState | undefined): void => {
    if (!step) return;
    const changes = changesOf(step);
    const read = 'read' in step ? step.read : undefined;
    const head = changes ? { branch: changes.branch, commit: changes.to } : read;

    if (!head) {
      for (const item of itemsOf(run, step)) visit(item);

      for (const child of workflowChildren(run, step)) visit(child);

      return;
    }

    const settledAt = 'settledAt' in step ? step.settledAt : 0;
    const earlier = heads.find((known) => known.branch === head.branch);

    if (!earlier) heads.push({ branch: head.branch, commit: head.commit, settledAt });
    else if (settledAt > earlier.settledAt) Object.assign(earlier, { commit: head.commit, settledAt });
  };

  const states = statesIn(run, scope);

  for (const id of definition.needs ?? []) visit(states.find((item) => localId(scope, item) === id));

  return heads;
}

/** Item ids on a step path, such as `fan[1]` inside `fan[1].check`. */
function itemIdsIn(id: string): string[] {
  const ids: string[] = [];
  let acc = '';

  for (const segment of parseStepPath(id)) {
    const part = segment.index === undefined ? segment.id : `${segment.id}[${segment.index}]`;
    acc = acc === '' ? part : `${acc}.${part}`;

    if (segment.index !== undefined) ids.push(acc);
  }

  return ids;
}

function pushItemAfter(run: RunState, itemId: string, push: (step: StepState | undefined) => void): void {
  const ownerId = itemId.replace(/\[\d+\]$/, '');
  const owner = run.steps.find((item) => item.id === ownerId);

  if (!owner) return;
  const items = itemsOf(run, owner);
  const item = items.find((entry) => entry.id === itemId);
  const after = itemsAfter(owner.id, items.map((entry) => entry.item));
  const index = item ? items.indexOf(item) : -1;

  if (!Array.isArray(after) || index < 0) return;

  for (const other of after[index] ?? []) push(items[other]);
}

/**
 * Needs a step inherits when it omits `needs`. A nested workflow that also omits them
 * inherits from the first enclosing step that declares them.
 */
function inheritedNeeds(run: RunState, scope: Scope, definition: WorkflowStep): string[] | undefined {
  if (definition.needs !== undefined || !scope.runner) return undefined;
  let runnerId: string | undefined = scope.runner.id;

  while (runnerId) {
    const parent = stepDefinitions(run)(runnerId);
    const prefix: string = runnerId.includes('.') ? runnerId.slice(0, runnerId.lastIndexOf('.') + 1) : '';

    if (parent?.needs !== undefined) return parent.needs.map((id) => `${prefix}${id}`);
    runnerId = prefix === '' ? undefined : prefix.slice(0, -1);
  }

  return [];
}

function sessionFromPasses(passes: Array<{ tool?: string; session?: string }>): SessionRef | undefined {
  for (let index = passes.length - 1; index >= 0; index -= 1) {
    const pass = passes[index];

    if (pass?.tool && pass.session) return { tool: pass.tool, id: pass.session };
  }

  return undefined;
}

/** Where `session` stands now: the copy the latest step that continued it under another id left, and so on from there. */
function latestContinuation(run: RunState, session: SessionRef | undefined): LeaseSession | undefined {
  if (!session) return undefined;
  const latestFirst = (run.sessionContinuations ?? []).toReversed();
  let latest = session;
  const earlier: SessionRef[] = [];

  // At most one hop per link, so links a driver reported in a circle still end.
  for (let hop = 0; hop < latestFirst.length; hop += 1) {
    const from = latest;
    const next = latestFirst.find((link) => link.from.tool === from.tool && link.from.id === from.id);

    if (!next) break;
    earlier.unshift(from);
    latest = next.to;
  }

  return earlier.length > 0 ? { tool: latest.tool, id: latest.id, earlier } : { tool: latest.tool, id: latest.id };
}

/**
 * The session a step resumes: its own latest with `session: continue`, or the latest of the step `session.from` names,
 * as later steps that continued it left it.
 */
export function sessionOf(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): LeaseSession | WorkflowFailure | undefined {
  if (!definition.session) return undefined;

  if ('continue' in definition.session) {
    const archived = (run.archive ?? []).filter((entry) => entry.step === state.id);
    const passes = [...archived, ...(state.passes ?? [])];
    // A loop may run an item again for another item, whose role template gives another role than its session ran with.
    const resumed = passes.findLast((pass) => pass.tool && pass.session);
    const runsWith = stepRoleOf(run, state.id);

    if (runsWith.kind === 'unrenderable') return runsWith.failure;
    const own = runsWith.kind === 'role' ? runsWith.role : undefined;
    const team = resumed?.agent?.team;

    if (resumed && !team && own !== undefined) {
      return { code: 'bad_session', message: `step "${state.id}" resumes its session from pass ${resumed.pass}, whose record names no role it ran with, while step "${state.id}" runs with role ${own} now; a session goes on only with the knowledge it started with, so start a new session` };
    }

    if (resumed && team && team.selection?.stepRole !== own) {
      const named = (role: string | undefined): string => (role === undefined ? 'your roles' : `role ${role}`);

      return { code: 'bad_session', message: `step "${state.id}" resumes its session from pass ${resumed.pass}, which ran with ${named(team.selection?.stepRole)}, while step "${state.id}" runs with ${named(own)} now; a session goes on only with the knowledge it started with, so run its passes with one role, or start a new session` };
    }

    return latestContinuation(run, sessionFromPasses(passes));
  }

  const name = definition.session.from;
  const states = statesIn(run, scope);
  let target = states.find((item) => localId(scope, item) === name);
  let targetDefinition = scope.definition.steps.find((item) => item.id === name);

  if (!target && scope.prefix) {
    const parent = scope.prefix.slice(0, -1);
    const grand = parent.includes('.') ? parent.slice(0, parent.lastIndexOf('.') + 1) : '';
    target = run.steps.find((item) => item.id === `${grand}${name}`);
    targetDefinition = target ? stepDefinitions(run)(target.id) : undefined;
  }

  if (!target || !targetDefinition) {
    return { code: 'bad_session', message: `step "${state.id}" resumes "${name}", which is not a step it can read` };
  }

  if (targetDefinition.forEach) {
    return { code: 'bad_session', message: `step "${state.id}" resumes "${name}", which is a for_each step` };
  }

  // A workflow a step outputs may set roles pull never saw around it.
  const ownRole = stepRoleOf(run, state.id);

  if (ownRole.kind === 'unrenderable') return ownRole.failure;
  const theirRole = stepRoleOf(run, target.id);

  if (theirRole.kind === 'unrenderable') return theirRole.failure;
  const own = ownRole.kind === 'role' ? ownRole.role : undefined;
  const theirs = theirRole.kind === 'role' ? theirRole.role : undefined;

  if (own !== theirs) {
    const named = (role: string | undefined): string => (role === undefined ? 'your roles' : `role ${role}`);

    return { code: 'bad_session', message: `step "${state.id}" resumes "${name}", which ran with ${named(theirs)}, while step "${state.id}" runs with ${named(own)}; a session goes on only with the knowledge it started with, so run both steps with one role, or start a new session` };
  }

  const current = passOf(target);

  return latestContinuation(run, sessionFromPasses([...(target.passes ?? []), ...(current ? [current] : [])]));
}

export interface WorkspaceRequest {
  driver: DriverIdentity;
  /** Modes this driver can run. Omitted means read-only only, so a workspace step waits. */
  modes?: WorkspaceMode[];
  base?: { ref?: string; commit: string };
}

/**
 * The workspace and session a lease carries. `defer` means this driver must not take the step.
 * A handed-back lease is planned again so the payload stays the same, and is not deferred.
 */
export function planWorkspace(
  run: RunState,
  scope: Scope,
  state: StepState,
  definition: WorkflowStep,
  request: WorkspaceRequest,
  handback = false,
): WorkspacePlan {
  const ancestors = ancestorsOf(run, state.id);
  const mode = resolveMode(definition, ancestors.map((ancestor) => ancestor.step));
  // A role template that gives no role id fails the step before any role it would run with is compared.
  const levels = roleLevelsOf(run, state.id);

  if (!Array.isArray(levels)) return { mode, fail: levels };
  const sessionResult = sessionOf(run, scope, state, definition);

  if (sessionResult && 'code' in sessionResult) return { mode, fail: sessionResult };
  const session = sessionResult ? { session: sessionResult } : {};
  const owner = ancestors.toReversed().find((ancestor) => opensCopy(ancestor.step));
  const modes = request.modes ?? ['read-only'];

  const cloned = mode === 'clone' ? { clone: cloneOf(definition), instance: state.id, pass: state.pass ?? 1 }
    : owner && cloneOf(owner.step) ? { clone: cloneOf(owner.step), instance: owner.instance, pass: owner.pass } : undefined;

  // A copy runs with the role it was opened with; a step another file runs there may resolve another only by mistake.
  const conflict = copyRoleConflict(levels);

  if (conflict) return { mode, fail: copyRoleFailure(state.id, conflict) };

  if (cloned?.clone) return planClone(run, state, request, { ...cloned, clone: cloned.clone, mode, session, handback });

  const team = teamOf(definition);

  if (team) return planTeam(run, state, request, { team, session, handback });

  if (mode === 'clone') return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" opens a clone this teamai cannot read` } };

  if (ancestors.some((ancestor) => cloneOf(ancestor.step))) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" opens a copy of its own inside a clone; give it workspace: continue` } };
  }

  if (mode === 'read-only') {
    if (!owner) return { mode, ...session };
    // A reader runs where its need left the change, or in the copy a `continue` step there would use.
    const heads = readHeads(run, scope, definition);

    if (heads.length > 1) {
      const branches = heads.map((head) => head.branch).join(', ');

      return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" reads branches ${branches}; add a step that merges them and need that step` } };
    }

    const needed = heads.length === 1 ? heads[0] : undefined;
    const branch = needed?.branch ?? branchName(run.id, owner.instance, owner.pass);

    if (!handback && !modes.includes('continue')) {
      return { mode, defer: { reason: `step "${state.id}" reads workspace ${branch}, which needs continue`, needs: 'continue' } };
    }

    const base = run.base ?? request.base;

    if (!base) {
      return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" needs the run's base commit` } };
    }

    const copy = run.copies?.[branch];

    if (!handback && copy?.owner && !sameDriver(copy.owner, request.driver)) {
      return { mode, defer: { reason: `step "${state.id}" reads a workspace owned by another driver` } };
    }

    const start = { commit: copy?.commit ?? needed?.commit ?? base.commit };

    return { mode, ...session, contract: { mode, base, configCommit: base.commit, branch, start, merge: [] } };
  }

  if (!handback && !modes.includes(mode)) {
    return { mode, defer: { reason: `step "${state.id}" needs workspace ${mode}, which this driver does not provide`, needs: mode } };
  }

  const base = run.base ?? request.base;

  if (!base) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" needs the run's base commit` } };
  }

  const branch = mode === 'new' || !owner
    ? branchName(run.id, state.id, state.pass ?? 1)
    : branchName(run.id, owner.instance, owner.pass);

  if (mode === 'continue' && !owner) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" continues a workspace, but no enclosing step opens one` } };
  }

  const copy = run.copies?.[branch];

  if (!handback && copy?.owner && !sameDriver(copy.owner, request.driver)) {
    return { mode, defer: { reason: `step "${state.id}" continues a workspace owned by another driver` } };
  }

  const changes = mergeChanges(run, scope, state, definition);
  const [first, ...rest] = mode === 'new' ? changes : [];

  return {
    mode,
    ...session,
    contract: {
      mode,
      base,
      configCommit: base.commit,
      branch,
      start: first ? { commit: first.to, branch: first.branch } : { commit: copy?.commit ?? base.commit },
      merge: (mode === 'continue' ? changes : rest).map((item) => ({ branch: item.branch, commit: item.to })),
    },
  };
}

/**
 * The failure of step instance `path`, which resolves a role other than the one of the copy an enclosing step opened:
 * what each runs with, and where to set the role instead.
 */
function copyRoleFailure(path: string, { copy, resolved }: NonNullable<ReturnType<typeof copyRoleConflict<RoleIdSpec>>>): WorkflowFailure {
  const opener = path.split('.').slice(0, copy.opener + 1).join('.');
  const copyRole = copy.runsWith.kind === 'role' ? copy.runsWith.role.id : undefined;
  const failed = (message: string): WorkflowFailure => ({ code: 'role_unavailable', message });

  if (resolved === undefined) {
    return failed(copyRole === undefined
      ? `step "${path}" runs with your roles but continues the copy step "${opener}" opened without a role, which every step there runs with; give step "${path}" that role, or remove it from step "${opener}"`
      : `step "${path}" runs with your roles but continues the copy step "${opener}" opened with role ${copyRole}, which every step there runs with; give step "${path}" that role, or remove it from step "${opener}"`);
  }

  const role = resolved.role.id;

  if (resolved.from === 'defaults') {
    return failed(copyRole === undefined
      ? `step "${path}" gets role ${role} from defaults.role but continues the copy step "${opener}" opened without a role, which every step there runs with; give the steps continuing that copy its role, or set role ${role} on step "${opener}"`
      : `step "${path}" gets role ${role} from defaults.role but continues the copy step "${opener}" opened with role ${copyRole}, which every step there runs with; give the steps continuing that copy its role, or set role ${role} on step "${opener}"`);
  }

  const named = path.split('.').slice(0, resolved.from + 1).join('.');

  if (named === path) {
    return failed(copyRole === undefined
      ? `step "${path}" has role ${role} but continues the copy step "${opener}" opened without a role, which every step there runs with; remove role from step "${path}", or set it on step "${opener}"`
      : `step "${path}" has role ${role} but continues the copy step "${opener}" opened with role ${copyRole}, which every step there runs with; remove role from step "${path}", or set it on step "${opener}"`);
  }

  return failed(copyRole === undefined
    ? `step "${path}" gets role ${role} from step "${named}" but continues the copy step "${opener}" opened without a role, which every step there runs with; remove role from step "${named}", or set it on step "${opener}"`
    : `step "${path}" gets role ${role} from step "${named}" but continues the copy step "${opener}" opened with role ${copyRole}, which every step there runs with; remove role from step "${named}", or set it on step "${opener}"`);
}

/**
 * The contract of a step in the clone `instance` opened, `instance` itself or its nearest enclosing copy: the clone's
 * commit is its base, whatever the run's, and its agent configuration; it merges nothing, as `needs` only order steps
 * there. It continues the clone's branch, held by the driver that opened it. A read-only step is refused: a clone has
 * no reader place.
 */
function planClone(run: RunState, state: StepState, request: WorkspaceRequest, input: {
  clone: ClonePlace; instance: string; pass: number; mode: WorkspaceMode; session: { session?: LeaseSession }; handback: boolean;
}): WorkspacePlan {
  const { clone, mode, session, handback } = input;

  if (mode === 'read-only') {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" runs read-only inside a clone, which has no reader place; give it workspace: continue` } };
  }

  const branch = branchName(run.id, input.instance, input.pass);

  if (!handback && !(request.modes ?? []).includes('clone')) {
    return { mode, defer: { reason: `step "${state.id}" runs in a clone, which this driver does not provide`, needs: 'clone' } };
  }

  const copy = run.copies?.[branch];

  if (!handback && copy?.owner && !sameDriver(copy.owner, request.driver)) {
    return { mode, defer: { reason: `step "${state.id}" continues a clone owned by another driver` } };
  }

  return {
    mode, ...session,
    contract: { mode: mode === 'clone' ? 'new' : 'continue', base: { commit: clone.commit }, configCommit: clone.commit, branch, start: { commit: copy?.commit ?? clone.commit }, merge: [], clone },
  };
}

/** A branch name git takes, of letters, digits and "._/-": no "..", "//", "/." or ".lock" part, and no "/", "." or "-" at an end. */
const GIT_BRANCH = /^(?!.*(?:\.\.|\/\/|\/\.|\.lock(?:\/|$)))(?![-./])[\w./-]*[\w-]$/;

/**
 * The contract of a step in the team workspace: `team.branch` rendered with the run's inputs, else the run's own branch
 * of the step. Only a driver that provides `team` takes it, and a step the copy's owner did not lease waits for it.
 */
function planTeam(run: RunState, state: StepState, request: WorkspaceRequest, input: { team: TeamPlace; session: { session?: LeaseSession }; handback: boolean }): WorkspacePlan {
  const { team, session, handback } = input;
  const mode = 'team';
  const parsed = team.branch === undefined ? undefined : parseTemplate(team.branch, false);

  if (parsed && !parsed.ok) return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" workspace team branch ${team.branch} is not a template teamai reads` } };
  const branch = parsed ? renderText(parsed.template, { inputs: run.inputs ?? {}, steps: {} }) : branchName(run.id, state.id, state.pass ?? 1);

  if (!GIT_BRANCH.test(branch)) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" commits to team branch "${branch}", which git cannot name a branch. Give inputs that make workspace team branch a branch name.` } };
  }

  if (!handback && !(request.modes ?? []).includes('team')) {
    return { mode, defer: { reason: `step "${state.id}" runs in the team workspace, which this driver does not provide`, needs: 'team' } };
  }

  const copy = run.copies?.[branch];

  if (!handback && copy?.owner && !sameDriver(copy.owner, request.driver)) {
    return { mode, defer: { reason: `step "${state.id}" commits to team branch ${branch}, which another driver of this run holds` } };
  }

  return { mode, ...session, contract: { mode, branch } };
}

/**
 * The branch of the clone step instance `path` runs in: the clone it opens, else the clone of its nearest enclosing
 * copy. Undefined when it runs in no clone.
 */
export function cloneBranchOf(run: StepTree & Pick<RunState, 'id'>, path: string): string | undefined {
  const own = stepDefinitions(run)(path);

  if (own && cloneOf(own)) return branchName(run.id, path, instanceOf(run, path)?.pass ?? 1);
  const owner = ancestorsOf(run, path).toReversed().find((ancestor) => opensCopy(ancestor.step));

  return owner && cloneOf(owner.step) ? branchName(run.id, owner.instance, owner.pass) : undefined;
}

/** A role id, as a step names one or a lease renders one for its item. */
export type RoleIdSpec = Extract<StepRoleSpec, { kind: 'id' }>;

/**
 * A step on the way to a step, outermost first and that step last, with the role it names and the `defaults.role` in
 * effect where it sits: its own workflow file's, else that of the nearest file around it that sets one. Before a lease
 * the role may be a template of the item (`StepRoleSpec`); a lease's levels hold the id it renders (`RoleIdSpec`).
 */
export interface RoleLevel<TRole extends StepRoleSpec = StepRoleSpec> {
  step: WorkflowStep;
  role?: TRole;
  defaultRole?: string;
}

/** The level of `step`, whose `role` is read once as an id or a template of its item, under `defaultRole`. */
export function roleLevelOf(step: WorkflowStep, defaultRole: string | undefined): RoleLevel {
  const level: RoleLevel = { step };

  if (step.role !== undefined) level.role = stepRoleSpec(step.role);

  if (defaultRole !== undefined) level.defaultRole = defaultRole;

  return level;
}

/** `role` as the workflow file writes it: the id, or the template's source. */
export function writtenRole(role: StepRoleSpec): string {
  switch (role.kind) {
    case 'id': return role.id;
    case 'item_template': return role.source;
    default: {
      const unhandled: never = role;

      return unhandled;
    }
  }
}

/** The role the last of a list of levels resolves, and where it is named: the index of a level, or `defaults`. */
export interface ResolvedRole<TRole extends StepRoleSpec = StepRoleSpec> {
  role: TRole | RoleIdSpec;
  from: number | 'defaults';
}

/**
 * The role the last of `levels` resolves, outside the copy it may run in: its own `role`, else the nearest enclosing
 * workflow step's, else `defaults.role` in effect there. Undefined when none names one, so it runs with the member's.
 */
export function resolvedRoleOf<TRole extends StepRoleSpec>(levels: readonly RoleLevel<TRole>[]): ResolvedRole<TRole> | undefined {
  for (let at = levels.length - 1; at >= 0; at -= 1) {
    const role = levels[at]?.role;

    if (role !== undefined) return { role, from: at };
  }

  const role = levels.at(-1)?.defaultRole;

  return role === undefined ? undefined : { role: { kind: 'id', id: role }, from: 'defaults' };
}

/**
 * The copy the last of a list of levels runs in, by the index of the level that opens it, and what the copy runs with:
 * the role its opener resolves, the member's roles without one, or no team at all in a clone that installs none.
 */
export interface StepCopy<TRole extends StepRoleSpec = StepRoleSpec> {
  opener: number;
  runsWith: { kind: 'role'; role: TRole | RoleIdSpec } | { kind: 'member' } | { kind: 'no_team' };
}

/**
 * The copy the last of `levels` runs in: one it opens, else the one the nearest enclosing step opened, as
 * `planWorkspace` places it. Undefined when it runs in no copy: a step reading the member's checkout, a step in the team
 * workspace, or a `continue` step no enclosing step opens a copy for.
 */
export function copyOf<TRole extends StepRoleSpec>(levels: readonly RoleLevel<TRole>[]): StepCopy<TRole> | undefined {
  const last = levels.at(-1);

  if (!last) return undefined;
  const ancestors = levels.slice(0, -1).map((level) => level.step);
  const mode = resolveMode(last.step, ancestors);

  if (mode === 'team') return undefined;
  const opener = mode === 'new' || mode === 'clone' ? levels.length - 1 : ancestors.findLastIndex((ancestor) => opensCopy(ancestor));
  const opening = levels.slice(0, opener + 1);
  const opens = opening.at(-1);

  if (opener < 0 || !opens) return undefined;
  const clone = cloneOf(opens.step);

  if (clone && !('revision' in clone.team)) return { opener, runsWith: { kind: 'no_team' } };
  const resolved = resolvedRoleOf(opening);

  return { opener, runsWith: resolved ? { kind: 'role', role: resolved.role } : { kind: 'member' } };
}

/**
 * Why the last of `levels` must not run in the copy an enclosing step opened: it resolves a role other than the one
 * that copy runs with, which every step there runs with. Undefined when it opens its copy, runs in none, or agrees.
 */
export function copyRoleConflict<TRole extends StepRoleSpec>(levels: readonly RoleLevel<TRole>[]): { copy: StepCopy<TRole>; resolved: ResolvedRole<TRole> | undefined } | undefined {
  const copy = copyOf(levels);

  if (!copy || copy.opener === levels.length - 1 || copy.runsWith.kind === 'no_team') return undefined;
  const resolved = resolvedRoleOf(levels);
  const copyRole = copy.runsWith.kind === 'role' ? writtenRole(copy.runsWith.role) : undefined;

  return (resolved && writtenRole(resolved.role)) === copyRole ? undefined : { copy, resolved };
}

/**
 * The levels to step instance `path` in the run's definitions, or none when they have no such step. A role written as
 * a template of the item (`{{ item.role }}`) is rendered for the item the level runs for; the failure is why one gives
 * no role.
 */
function roleLevelsOf(run: StepTree, path: string): RoleLevel<RoleIdSpec>[] | WorkflowFailure {
  const levels: RoleLevel<RoleIdSpec>[] = [];
  let workflow: WorkflowDefinition | InlineWorkflow | undefined = run.definition;
  let defaultRole = run.definition.defaults?.role;
  let prefix = '';
  let item: { value: unknown } | undefined;

  for (const segment of path.split('.')) {
    const parsed = parseStepPath(segment)[0];
    const id = parsed?.id ?? segment;
    const step = workflow?.steps.find((entry) => entry.id === id);

    if (!step) return [];

    if (parsed?.index !== undefined) item = { value: instanceOf(run, `${prefix}${segment}`)?.item };
    const written = roleLevelOf(step, defaultRole);
    const role = written.role === undefined ? undefined : itemRoleOf({ path: `${prefix}${segment}`, role: written.role, item });

    if (role !== undefined && 'code' in role) return role;
    const level: RoleLevel<RoleIdSpec> = { step };

    if (role !== undefined) level.role = role;

    if (defaultRole !== undefined) level.defaultRole = defaultRole;
    levels.push(level);
    workflow = workflowRunBy(run, step, prefix);

    if (workflow && isWorkflowFile(workflow)) defaultRole = workflow.defaults?.role ?? defaultRole;
    prefix = `${prefix}${segment}.`;
  }

  return levels;
}

/**
 * The role of step instance `path`: `role` itself, or, when it is a template of the item (`{{ item.role }}`), what it
 * gives for `item`, the item the instance runs for. A template that gives no role id fails the step, as the lease
 * cannot tell which role's knowledge the copy should get.
 */
function itemRoleOf(input: { path: string; role: StepRoleSpec; item: { value: unknown } | undefined }): RoleIdSpec | WorkflowFailure {
  const { path, role, item } = input;

  switch (role.kind) {
    case 'id':
      return role;
    case 'item_template': {
      const rendered = item ? renderValue(role.template, { steps: {}, item: item.value }) : undefined;

      const id = z.string().min(1).safeParse(rendered).data;

      if (id !== undefined) return { kind: 'id', id };

      return {
        code: 'role_unavailable',
        message: `step "${path}" role ${role.source} gives ${renderedKind(rendered)}, not the id of a role in manifest/roles.yaml, so teamai cannot tell which role's knowledge its copy gets; give each item a role id, such as review, then start the run again`,
      };
    }

    default: {
      const unhandled: never = role;

      return unhandled;
    }
  }
}

/** What a role template gave, as a role failure names it. */
function renderedKind(rendered: JsonValue | undefined): string {
  if (rendered === undefined || rendered === null || rendered === '') return 'nothing';
  const type = jsonType(rendered);

  return type === 'array' ? 'a list' : type === 'object' ? 'an object' : `a ${type}`;
}

/**
 * The team role a step instance runs with: `role`, the role of the copy it runs in; `none`, when it runs in no copy or in
 * one without a role, so it gets the member's roles or no team; `unrenderable`, when a role template on its way gives no
 * role id for its item, which fails the step.
 */
export type StepRole = { kind: 'role'; role: string } | { kind: 'none' } | { kind: 'unrenderable'; failure: WorkflowFailure };

/**
 * The team role step instance `path` runs with: the role of the copy it runs in, which the step that opens the copy
 * resolves (`copyOf`), each role template rendered for the item it runs for.
 */
export function stepRoleOf(run: StepTree, path: string): StepRole {
  const levels = roleLevelsOf(run, path);

  if (!Array.isArray(levels)) return { kind: 'unrenderable', failure: levels };
  const runsWith = copyOf(levels)?.runsWith;

  return runsWith?.kind === 'role' ? { kind: 'role', role: runsWith.role.id } : { kind: 'none' };
}

/** Whether the steps inside `step` run in a copy it opens rather than in the one around it. */
export function opensCopy(step: WorkflowStep): boolean {
  return step.workspace === 'new' || cloneOf(step) !== undefined || (step.forEach !== undefined && step.workspace === 'continue');
}

/**
 * The existing branch a step that has not started yet would run in. A leaf, or a `for_each` step whose items are leaves,
 * uses the branch its lease names. The steps of a workflow continue or read the copy around it, unless it opens its own;
 * a branch they open themselves does not exist yet.
 */
export function plannedBranch(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): string | undefined {
  if (definition.workflow !== undefined) {
    if (opensCopy(definition)) return undefined;
    const owner = ancestorsOf(run, state.id).toReversed().find((ancestor) => opensCopy(ancestor.step));

    return owner && branchName(run.id, owner.instance, owner.pass);
  }

  return planWorkspace(run, scope, state, definition, {
    driver: { kind: '', machine: '', workspace: '' },
    modes: ['read-only', 'new', 'continue'],
    base: run.base ?? { ref: 'HEAD', commit: 'base' },
  }, true).contract?.branch;
}
