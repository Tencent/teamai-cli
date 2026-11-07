/**
 * Workspace planning. The engine names the branch and lists the commits to merge.
 * A driver creates the worktree. This module does not run git.
 */
import { z } from 'zod';
import { sameDriver } from '../driver-identity.js';
import type { JsonValue } from '../types.js';
import { jsonType } from './expression.js';
import { itemsAfter, itemsOf } from './fan-out.js';
import { isUnder, passesWithin, runPasses, type RunPass } from './loop.js';
import { contextOf, localId, statesIn, stepDefinitions, type Scope } from './scope.js';
import { parseStepPath } from './step-path.js';
import { renderLeaseText, renderValue, stepRoleSpec, type StepRoleSpec } from './template.js';
import { passOf, type Delivery, type StepState } from './step-state.js';
import { ClonePlaceSchema, type ClonePlace } from './clone.js';
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

/** `publish`: the step publishes what it stages to `branch`, a teamai data branch, as `deliver: publish` does. */
export const TeamContractSchema = z.object({ mode: z.literal('team'), branch: z.string().min(1), publish: z.literal(true).optional() });

export const WorkspaceContractSchema = z.discriminatedUnion('mode', [...CopyContractOptions, TeamContractSchema]) satisfies z.ZodType<WorkspaceContract>;

/** Whether `contract` publishes what its step stages to a data branch, so it makes no copy a driver works in. */
export function isPublishContract(contract: WorkspaceContract): boolean {
  return contract.mode === 'team' && contract.publish === true;
}

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

/** What every branch of run `runId` starts with: `teamai/<run>/`. */
export function runBranchPrefix(runId: string): string {
  return `teamai/${runId}/`;
}

/** A branch name that includes the run, the step path, and the pass, and is safe in a ref. */
export function branchName(runId: string, stepPath: string, pass: number): string {
  const safe = parseStepPath(stepPath).map((segment) => {
    const plain = /^[A-Za-z0-9]+$/.test(segment.id);
    const readable = segment.id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = plain ? segment.id : `${readable || 'step'}-x${Buffer.from(segment.id).toString('hex')}`;

    return segment.index === undefined ? id : `${id}-${segment.index}`;
  }).join('-') || 'step';

  return `${runBranchPrefix(runId)}${safe}/p${pass}`;
}

/**
 * How a step runs. An explicit `workspace` wins. A command that omits it is read-only, even inside a copy, which it reads.
 * A prompt that omits it continues the nearest enclosing copy, or stays read-only. Inside a `for_each` item that copy
 * is the item's own, so siblings do not share a worktree.
 */
export function resolveMode(step: WorkflowStep, ancestors: readonly WorkflowStep[]): WorkspaceMode {
  switch (step.workspace) {
    case undefined:
      break;
    case 'read-only':
    case 'new':
    case 'continue':
      return step.workspace;
    default:
      if ('clone' in step.workspace) return 'clone';

      // A step confined to a directory opens no copy and changes nothing.
      return 'team' in step.workspace ? 'team' : 'read-only';
  }

  if (step.command !== undefined && step.prompt === undefined && step.promptFile === undefined) return 'read-only';

  // An answer reads the checkout, without inheriting a surrounding copy.
  if (step.answer !== undefined) return 'read-only';

  for (const ancestor of ancestors.toReversed()) {
    if (cloneOf(ancestor)) return 'continue';

    if (ancestor.workspace !== 'new' && ancestor.workspace !== 'continue') continue;

    return 'continue';
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

/** The directory `step` is confined to, as written, or undefined when it is not confined to one. */
export function confinedOf(step: WorkflowStep): string | undefined {
  const place = placeOf(step);

  return place && 'confined' in place ? place.confined : undefined;
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

/**
 * Whether a step of `run`, or of a workflow it runs, works in the team workspace, whose clone only the machine that ran it
 * has. A step that publishes to a data branch leaves nothing behind that another machine would need.
 */
export function worksInTeam(run: Pick<RunState, 'definition' | 'workflows'>): boolean {
  return someStep(run, (step) => teamOf(step) !== undefined && step.deliver !== 'publish');
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
export function runsInCheckout(step: WorkflowStep, ancestors: readonly WorkflowStep[]): boolean {
  return resolveMode(step, ancestors) === 'read-only' && !ancestors.some(opensCopy);
}

/** The workflow a step runs, as a walk of the tree reads it. */
type ChildOf = (step: WorkflowStep) => WorkflowDefinition | InlineWorkflow | undefined;

/** Whether `step`, inside `outer`, leaves commits on a branch: it writes in a copy, or a step of the workflow it runs does. */
export function writesBranch(step: WorkflowStep, outer: readonly Level[], childOf: ChildOf): boolean {
  const child = childOf(step);

  if (child) return child.steps.some((inner) => writesBranch(inner, levelsInside(outer, { step }, child), childOf));

  return (step.prompt !== undefined || step.promptFile !== undefined || (step.workspace !== undefined && step.workspace !== 'read-only'))
    && resolveMode(step, outer.map((level) => level.step)) !== 'read-only';
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

  const visit = (steps: WorkflowStep[], outer: readonly Level[], prefix: string): WorkflowFailure | undefined => {
    for (const step of steps) {
      const path = `${prefix}${step.id}`;
      const child = childOf(step);
      const inside = levelsInside(outer, { step }, child);
      const placed = inside.at(-1)?.step;

      if (step.deliver === 'pr') {
        // A team step's pull request goes into the team repo's default branch, whatever the checkout has checked out.
        if (!teamOf(step)) delivering ??= path;

        if (step.workflow !== undefined && placed?.workspace !== 'new' && !step.forEach) {
          return { code: 'bad_delivery', message: `Step "${path}" delivers its workflow, so it needs workspace: new to own the branch it delivers.` };
        }

        if (child && !writesBranch(step, outer, childOf)) {
          return { code: 'bad_delivery', message: `Step "${path}" has deliver: pr, but no step of the workflow it runs writes a branch, so it would deliver nothing. Set workspace: new on "${path}" so its prompt steps write, or give a step in that workflow workspace: new or continue.` };
        }

        if (step.workflow === undefined && resolveMode(step, outer.map((level) => level.step)) === 'read-only') {
          return { code: 'bad_delivery', message: `Step "${path}" has deliver: pr but runs read-only. Set workspace: new on it, or on the workflow step that runs it.` };
        }
      }

      const problem = child && visit(child.steps, inside, `${path}.`);

      if (problem) return problem;
    }

    return undefined;
  };

  const problem = visit(definition.steps, runLevels(definition).map((step) => ({ step })), '');

  if (problem || delivering === undefined || !base || base.ref !== undefined) return problem;

  return {
    code: 'no_base_branch',
    message: `Step "${delivering}" delivers a pull request, but the run would start from a detached HEAD at ${base.commit}, so no branch is there for the pull request to target. Check out a named branch, then start the run again.`,
  };
}

/** How step instance `path` runs, or undefined when the run's definitions have no such step. */
export function stepMode(run: StepTree, path: string): WorkspaceMode | undefined {
  const { own, ancestors } = splitLevels(levelsTo(run, path), path);

  return own && resolveMode(own.step, ancestors.map((ancestor) => ancestor.step));
}

/**
 * The level of the run itself, before its first step, when its workflow's header says `workspace: new`: it opens the
 * copy its steps work in, as a `workflow` step with `workspace: new` does for the steps inside it.
 */
const RUN_COPY: WorkflowStep = { id: '', workspace: 'new' };

/**
 * The levels a walk of the steps of `definition`, the workflow a run starts, begins inside: the run's own copy when
 * the header says `workspace: new`, else none. Every chain of copies starts here.
 */
export function runLevels(definition: Pick<WorkflowDefinition, 'workspace'>): WorkflowStep[] {
  return definition.workspace === 'new' ? [RUN_COPY] : [];
}

/** Whether a level on the way to a step is the run itself, rather than a step. */
export function isRunLevel(step: WorkflowStep): boolean {
  return step === RUN_COPY;
}

/** A level on the way to a step: a step, or the run itself (`isRunLevel`), as `resolveMode` and `opensCopy` read it. */
export interface Level {
  step: WorkflowStep;
}

/**
 * The levels the steps of `child`, the workflow `level`'s step runs, are inside: `outer`, then that step as placed
 * there. A step with no `workspace` that runs a workflow whose header says `workspace: new` opens a copy, as
 * `workspace: new` on it would, unless a copy is already around it, which the workflow's steps then continue. Every
 * chain of levels starts at `runLevels` and grows through this.
 */
export function levelsInside<TLevel extends Level>(outer: readonly TLevel[], level: TLevel, child: WorkflowDefinition | InlineWorkflow | undefined): TLevel[] {
  const { step } = level;

  if (step.workspace !== undefined || !child || !isWorkflowFile(child) || child.workspace !== 'new' || outer.some((around) => opensCopy(around.step))) return [...outer, level];

  return [...outer, { ...level, step: { ...step, workspace: 'new' } }];
}

/**
 * A level on the way to a step instance, with the `defaults.role` in effect where it sits: the run itself, or a step
 * instance on the path, with its pass and the `for_each` item it runs for, at any depth.
 */
type PathLevel = Level & { defaultRole?: string } & ({ kind: 'run' } | { kind: 'step'; instance: string; pass: number; item?: { value: unknown } });

/**
 * The levels to step instance `path` in the run's definitions, outermost first: the run's own copy, then one level per
 * instance on the path, `path` itself last. It stops before a segment the definitions have no step for.
 */
function levelsTo(run: StepTree, path: string): PathLevel[] {
  let defaultRole = run.definition.defaults?.role;
  let levels: PathLevel[] = [];
  let workflow: WorkflowDefinition | InlineWorkflow | undefined = run.definition;
  let prefix = '';
  let item: { value: unknown } | undefined;

  for (const step of runLevels(run.definition)) {
    const level: PathLevel = { kind: 'run', step };

    if (defaultRole !== undefined) level.defaultRole = defaultRole;
    levels.push(level);
  }

  for (const segment of path.split('.')) {
    const parsed = parseStepPath(segment)[0];
    const step = workflow?.steps.find((entry) => entry.id === (parsed?.id ?? segment));

    if (!step) break;
    const instance = `${prefix}${segment}`;

    if (parsed?.index !== undefined) item = { value: instanceOf(run, instance)?.item };
    workflow = workflowRunBy(run, step, prefix);
    const level: PathLevel = { kind: 'step', instance, step, pass: instanceOf(run, instance)?.pass ?? 1 };

    if (defaultRole !== undefined) level.defaultRole = defaultRole;

    if (item) level.item = item;
    levels = levelsInside(levels, level, workflow);

    if (workflow && isWorkflowFile(workflow)) defaultRole = workflow.defaults?.role ?? defaultRole;
    prefix = `${instance}.`;
  }

  return levels;
}

/** `levels` to `path` as the step itself, when the definitions have it, and the levels around it. */
function splitLevels(levels: PathLevel[], path: string): { own?: PathLevel; ancestors: PathLevel[] } {
  const last = levels.at(-1);

  return last?.kind === 'step' && last.instance === path ? { own: last, ancestors: levels.slice(0, -1) } : { ancestors: levels };
}

/** The nearest level around `path` that opens the copy the steps inside it work in, the run's own included. */
function copyOwner(run: StepTree, path: string): PathLevel | undefined {
  return splitLevels(levelsTo(run, path), path).ancestors.toReversed().find((ancestor) => opensCopy(ancestor.step));
}

/** The branch of the copy `owner` opens: the run's own copy, or the branch of the step instance and its pass. */
function ownerBranch(runId: string, owner: PathLevel): string {
  switch (owner.kind) {
    case 'run': return runCopyBranch(runId);
    case 'step': return branchName(runId, owner.instance, owner.pass);
    default: {
      const unhandled: never = owner;

      return unhandled;
    }
  }
}

/** The branch that pins the commit run `runId` started from on origin, so a driver's fetch of the run's branches brings it in. */
export function basePinBranch(runId: string): string {
  return `${runBranchPrefix(runId)}base`;
}

/** The branch of the copy a run opens when its workflow's header says `workspace: new`. No step's branch takes this name. */
export function runCopyBranch(runId: string): string {
  return `${runBranchPrefix(runId)}_run`;
}

/**
 * The branch a person brings a succeeded run's changes in from: the copy the run opened, as its workflow's header says
 * `workspace: new`, when the run left commits on it. A driver names it as the run ends.
 */
export function runCopyToMerge(run: Pick<RunState, 'id' | 'status' | 'definition' | 'copies' | 'base'>): string | undefined {
  if (run.status !== 'succeeded' || run.definition.workspace !== 'new') return undefined;
  const branch = runCopyBranch(run.id);
  const commit = run.copies?.[branch]?.commit;

  return commit === undefined || commit === run.base?.commit ? undefined : branch;
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

/** A branch and the commit a step starts from or merges there. */
type BranchHead = Extract<WorkspaceContract, { mode: 'new' | 'continue' }>['merge'][number];

/**
 * The writes of the current pass of step `state`: its own passes and those of every step under it, current or archived
 * by a loop, so a fix loop that ends on a skipped pass still counts its fix. A step instance holds only the branch of its
 * latest pass that wrote; an earlier pass on another branch, such as a failed attempt a retry replaced, is not part of it.
 */
function writesOf(run: RunState, state: StepState): StepChanges[] {
  const current = passOf(state);

  const passes: RunPass[] = [
    ...[...state.passes ?? [], ...(current ? [current] : [])].map((pass) => ({ ...pass, step: state.id })),
    ...passesWithin(run, runPasses(run), state.id, state.pass ?? 1),
  ];

  const latest = new Map<string, RunPass>();

  for (const pass of passes) {
    const known = latest.get(pass.step);

    if (pass.changes && (!known || pass.pass > known.pass)) latest.set(pass.step, pass);
  }

  return passes.flatMap((pass) => (pass.changes && pass.changes.branch === latest.get(pass.step)?.changes?.branch ? [pass.changes] : []));
}

/**
 * Where `writes` left each branch, in the order the branches first appear. Passes record no settle time, and a write
 * starts from the commit the last one left, so the newest write on a branch is one no other write there goes on from.
 * An attempt released with commits keeps none of them on its step, which can leave two such ends; the one the run
 * recorded as the branch's tip is then the newest.
 */
function branchHeads(run: RunState, writes: readonly StepChanges[]): BranchHead[] {
  const ends = new Map<string, { commits: string[]; last: string }>();

  for (const write of writes) {
    const found = ends.get(write.branch) ?? { commits: [], last: write.to };
    const hasLaterWrite = writes.some((other) => other.branch === write.branch && other.from === write.to && other.to !== write.to);

    if (!hasLaterWrite && !found.commits.includes(write.to)) found.commits.push(write.to);
    ends.set(write.branch, { ...found, last: write.to });
  }

  // A step that reset its branch to an earlier commit leaves no end; the recorded tip, else the last write, is then where it is.
  return [...ends].map(([branch, { commits, last }]) => {
    const tip = run.copies?.[branch]?.commit;
    const commit = tip !== undefined && (commits.includes(tip) || commits.length === 0) ? tip : commits.at(-1) ?? last;

    return { branch, commit };
  });
}

/**
 * Branches a step merges, `after` items first, then its other needs, each where those needs left it together: two
 * needs that wrote one copy leave it at the newest of their writes, whichever settled last. An omitted `needs` uses the
 * parent step's needs. Only steps under a need write a branch it or a step under it opened, and they have all settled,
 * so the run's recorded tip of that branch is where they left it; when it is not, the run's records disagree and the
 * step fails rather than start without commits the branch may hold.
 */
function mergeChanges(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): BranchHead[] | WorkflowFailure {
  const writes: StepChanges[] = [];
  const opened = new Map<string, string>();
  const visited = new Set<string>();

  const push = (step: StepState | undefined): void => {
    if (!step || visited.has(step.id)) return;
    visited.add(step.id);
    const written = writesOf(run, step);

    // A skipped or read-only need wrote no branch, but its earlier dependencies still supply the copy's origin.
    if (written.length === 0) {
      for (const item of itemsOf(run, step)) push(item);

      for (const child of workflowChildren(run, step)) push(child);
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

    writes.push(...written);
    const under = isUnder(step.id);

    for (const inside of run.steps) {
      if (inside.id === step.id || under(inside.id)) opened.set(branchName(run.id, inside.id, inside.pass ?? 1), step.id);
    }
  };

  for (const itemId of itemIdsIn(state.id)) pushItemAfter(run, itemId, push);
  const inherited = inheritedNeeds(run, scope, definition);

  if (inherited) {
    for (const id of inherited) push(run.steps.find((item) => item.id === id));
  } else {
    const states = statesIn(run, scope);

    for (const id of definition.needs ?? []) push(states.find((item) => localId(scope, item) === id));
  }

  const heads = branchHeads(run, writes);

  for (const head of heads) {
    const need = opened.get(head.branch);
    const tip = run.copies?.[head.branch]?.commit;

    if (need !== undefined && tip !== undefined && tip !== head.commit) {
      return {
        code: 'workspace_base',
        message: `step "${state.id}" would start from branch ${head.branch} at ${head.commit}, where the steps of "${need}" left it, but the run recorded ${tip} as the tip of ${head.branch}. The run's records of that branch disagree, for a reason teamai does not know, so the step stops instead of leaving out commits the branch may hold. Run git log ${head.branch} to see which of the two it holds, and report this run to the teamai maintainers with its run file ${run.id}.json.`,
      };
    }
  }

  return heads;
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
  const { ancestors } = splitLevels(levelsTo(run, state.id), state.id);
  const mode = resolveMode(definition, ancestors.map((ancestor) => ancestor.step));

  // A confined step reads its directory; an answer reads the checkout, or its own copy. Neither inherits a copy or resumes a session.
  if (confinedOf(definition) !== undefined) return { mode };

  if (definition.answer !== undefined) return mode === 'new' ? planAnswerCopy(run, state, request, handback) : { mode };
  // A role template that gives no role id fails the step before any role it would run with is compared.
  const levels = roleLevelsOf(run, state.id);

  if (!Array.isArray(levels)) return { mode, fail: levels };
  const sessionResult = sessionOf(run, scope, state, definition);

  if (sessionResult && 'code' in sessionResult) return { mode, fail: sessionResult };
  const session = sessionResult ? { session: sessionResult } : {};
  const owner = ancestors.toReversed().find((ancestor) => opensCopy(ancestor.step));
  const modes = request.modes ?? ['read-only'];

  const cloned = mode === 'clone' ? { clone: cloneOf(definition), branch: branchName(run.id, state.id, state.pass ?? 1) }
    : owner && cloneOf(owner.step) ? { clone: cloneOf(owner.step), branch: ownerBranch(run.id, owner) } : undefined;

  // A copy runs with the role it was opened with; a step another file runs there may resolve another only by mistake.
  const conflict = copyRoleConflict(levels);

  if (conflict) return { mode, fail: copyRoleFailure(state.id, levels, conflict) };

  if (cloned?.clone) return planClone(run, state, request, { ...cloned, clone: cloned.clone, mode, session, handback });

  const team = teamOf(definition);

  if (team) return planTeam(run, state, request, { scope, team, session, handback, publish: definition.deliver === 'publish' });

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
    const branch = needed?.branch ?? ownerBranch(run.id, owner);

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
    : ownerBranch(run.id, owner);

  if (mode === 'continue' && !owner) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" continues a workspace, but no enclosing step opens one` } };
  }

  const copy = run.copies?.[branch];

  if (!handback && copy?.owner && !sameDriver(copy.owner, request.driver)) {
    return { mode, defer: { reason: `step "${state.id}" continues a workspace owned by another driver` } };
  }

  const changes = mergeChanges(run, scope, state, definition);

  if (!Array.isArray(changes)) return { mode, fail: changes };
  const [first, ...rest] = mode === 'new' ? changes : [];

  return {
    mode,
    ...session,
    contract: {
      mode,
      base,
      configCommit: base.commit,
      branch,
      start: first ? { commit: first.commit, branch: first.branch } : { commit: copy?.commit ?? base.commit },
      merge: mode === 'continue' ? changes : rest,
    },
  };
}

/**
 * The copy an answer with `workspace: new` reads: a worktree of its own at the run's base, which it must leave as it
 * found it, as a reader does. No other attempt uses it, so it runs beside the steps in the checkout and in other copies.
 * A run with no base commit has no repository to copy, so the answer reads the checkout, as one without `workspace` does.
 */
function planAnswerCopy(run: RunState, state: StepState, request: WorkspaceRequest, handback: boolean): WorkspacePlan {
  const base = run.base ?? request.base;

  if (!base) return { mode: 'read-only' };
  const mode = 'new';

  if (!handback && !(request.modes ?? ['read-only']).includes(mode)) {
    return { mode, defer: { reason: `step "${state.id}" needs workspace ${mode}, which this driver does not provide`, needs: mode } };
  }

  return { mode, contract: { mode: 'read-only', base, configCommit: base.commit, branch: branchName(run.id, state.id, state.pass ?? 1), start: { commit: base.commit }, merge: [] } };
}

/**
 * The failure of step instance `path`, which resolves a role other than the one of the copy an enclosing step, or the
 * run, opened: what each runs with, and where to set the role instead.
 */
function copyRoleFailure(path: string, levels: readonly PathRoleLevel[], { copy, resolved }: NonNullable<ReturnType<typeof copyRoleConflict<RoleIdSpec>>>): WorkflowFailure {
  const opener = copyOpenerWords(levels[copy.opener]);
  const copyRole = copy.runsWith.kind === 'role' ? copy.runsWith.role.id : undefined;
  const failed = (message: string): WorkflowFailure => ({ code: 'role_unavailable', message });

  if (resolved === undefined) {
    return failed(copyRole === undefined
      ? `step "${path}" runs with your roles but continues the copy ${opener.label} opened without a role, which every step there runs with; give step "${path}" that role, or remove it ${opener.from}`
      : `step "${path}" runs with your roles but continues the copy ${opener.label} opened with role ${copyRole}, which every step there runs with; give step "${path}" that role, or remove it ${opener.from}`);
  }

  const role = resolved.role.id;
  const named = resolved.from === 'defaults' ? undefined : levels[resolved.from];

  switch (named?.kind) {
    // The run names no role of its own: a role it gives is its defaults.role.
    case undefined:
    case 'run':
      return failed(copyRole === undefined
        ? `step "${path}" gets role ${role} from defaults.role but continues the copy ${opener.label} opened without a role, which every step there runs with; give the steps continuing that copy its role, or set role ${role} ${opener.on}`
        : `step "${path}" gets role ${role} from defaults.role but continues the copy ${opener.label} opened with role ${copyRole}, which every step there runs with; give the steps continuing that copy its role, or set role ${role} ${opener.on}`);
    case 'step': {
      const { instance } = named;

      if (instance === path) {
        return failed(copyRole === undefined
          ? `step "${path}" has role ${role} but continues the copy ${opener.label} opened without a role, which every step there runs with; remove role from step "${path}", or set it ${opener.on}`
          : `step "${path}" has role ${role} but continues the copy ${opener.label} opened with role ${copyRole}, which every step there runs with; remove role from step "${path}", or set it ${opener.on}`);
      }

      return failed(copyRole === undefined
        ? `step "${path}" gets role ${role} from step "${instance}" but continues the copy ${opener.label} opened without a role, which every step there runs with; remove role from step "${instance}", or set it ${opener.on}`
        : `step "${path}" gets role ${role} from step "${instance}" but continues the copy ${opener.label} opened with role ${copyRole}, which every step there runs with; remove role from step "${instance}", or set it ${opener.on}`);
    }

    default: {
      const unhandled: never = named;

      return unhandled;
    }
  }
}

/** How a role failure names the level that opened a copy, where to set its role, and where to remove it from. */
function copyOpenerWords(opening: PathRoleLevel) {
  switch (opening.kind) {
    // The run's own copy gets its role from defaults.role, as a step's gets it from the step.
    case 'run': return { label: 'the run', on: 'as defaults.role', from: 'from defaults.role' };
    case 'step': return { label: `step "${opening.instance}"`, on: `on step "${opening.instance}"`, from: `from step "${opening.instance}"` };
    default: {
      const unhandled: never = opening;

      return unhandled;
    }
  }
}

/**
 * The contract of a step in the clone on `branch`, opened by the step itself or its nearest enclosing copy: the clone's
 * commit is its base, whatever the run's, and its agent configuration; it merges nothing, as `needs` only order steps
 * there. It continues the clone's branch, held by the driver that opened it. A read-only step is refused: a clone has
 * no reader place.
 */
function planClone(run: RunState, state: StepState, request: WorkspaceRequest, input: {
  clone: ClonePlace; branch: string; mode: WorkspaceMode; session: { session?: LeaseSession }; handback: boolean;
}): WorkspacePlan {
  const { clone, branch, mode, session, handback } = input;

  if (mode === 'read-only') {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" runs read-only inside a clone, which has no reader place; give it workspace: continue` } };
  }

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
 * The contract of a step in the team workspace: `team.branch` rendered from what the step reads when it is leased, its
 * workflow's inputs and the outputs of the steps it needs, else the run's own branch of the step. Only a driver that
 * provides `team` takes it, and a step the copy's owner did not lease waits for it.
 */
function planTeam(run: RunState, state: StepState, request: WorkspaceRequest, input: { scope: Scope; team: TeamPlace; session: { session?: LeaseSession }; handback: boolean; publish: boolean }): WorkspacePlan {
  const { scope, team, session, handback, publish } = input;
  const mode = 'team';

  const branch = team.branch === undefined ? branchName(run.id, state.id, state.pass ?? 1)
    : renderLeaseText(contextOf(scope, statesIn(run, scope), state), state, { what: 'workspace team branch', text: team.branch });

  if (branch instanceof Object) return { mode, fail: branch };

  if (!GIT_BRANCH.test(branch)) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" commits to team branch "${branch}", which git cannot name a branch. Give inputs and step outputs that make workspace team branch a branch name.` } };
  }

  if (!handback && !(request.modes ?? []).includes('team')) {
    return { mode, defer: { reason: `step "${state.id}" runs in the team workspace, which this driver does not provide`, needs: 'team' } };
  }

  const copy = run.copies?.[branch];

  if (!handback && copy?.owner && !sameDriver(copy.owner, request.driver)) {
    return { mode, defer: { reason: `step "${state.id}" commits to team branch ${branch}, which another driver of this run holds` } };
  }

  return { mode, ...session, contract: publish ? { mode, branch, publish } : { mode, branch } };
}

/**
 * The branch of the clone step instance `path` runs in: the clone it opens, else the clone of its nearest enclosing
 * copy. Undefined when it runs in no clone.
 */
export function cloneBranchOf(run: StepTree & Pick<RunState, 'id'>, path: string): string | undefined {
  const own = stepDefinitions(run)(path);

  if (own && cloneOf(own)) return branchName(run.id, path, instanceOf(run, path)?.pass ?? 1);
  const owner = copyOwner(run, path);

  return owner && cloneOf(owner.step) ? ownerBranch(run.id, owner) : undefined;
}

/** A role id, as a step names one or a lease renders one for its item. */
export type RoleIdSpec = Extract<StepRoleSpec, { kind: 'id' }>;

/**
 * A step on the way to a step, outermost first and that step last, with the role it names and the `defaults.role` in
 * effect where it sits: its own workflow file's, else that of the nearest file around it that sets one. Before a lease
 * the role may be a template of the item (`StepRoleSpec`); a lease's levels hold the id it renders (`RoleIdSpec`).
 */
export interface RoleLevel<TRole extends StepRoleSpec = StepRoleSpec> extends Level {
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

/** A level to a step instance as its role resolves: the run, or the step instance it is, as `PathLevel` has it. */
type PathRoleLevel = RoleLevel<RoleIdSpec> & ({ kind: 'run' } | { kind: 'step'; instance: string });

/**
 * The role levels to step instance `path` in the run's definitions, or none when they have no such step. A role
 * written as a template of the item (`{{ item.role }}`) is rendered for the item the level runs for; the failure is why
 * one gives no role.
 */
function roleLevelsOf(run: StepTree, path: string): PathRoleLevel[] | WorkflowFailure {
  const levels = levelsTo(run, path);

  if (!splitLevels(levels, path).own) return [];
  const rendered: PathRoleLevel[] = [];

  for (const level of levels) {
    const { step, defaultRole } = level;
    let roleLevel: PathRoleLevel;

    switch (level.kind) {
      // The run names no role of its own: its copy gets the one in defaults.role.
      case 'run':
        roleLevel = { kind: 'run', step };
        break;
      case 'step': {
        const written = roleLevelOf(step, defaultRole);
        const role = written.role === undefined ? undefined : itemRoleOf({ path: level.instance, role: written.role, item: level.item });

        if (role !== undefined && 'code' in role) return role;
        roleLevel = { kind: 'step', instance: level.instance, step };

        if (role !== undefined) roleLevel.role = role;
        break;
      }

      default: {
        const unhandled: never = level;

        return unhandled;
      }
    }

    if (defaultRole !== undefined) roleLevel.defaultRole = defaultRole;
    rendered.push(roleLevel);
  }

  return rendered;
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
    const { own, ancestors } = splitLevels(levelsTo(run, state.id), state.id);

    if (opensCopy(own?.step ?? definition)) return undefined;
    const owner = ancestors.toReversed().find((ancestor) => opensCopy(ancestor.step));

    return owner && ownerBranch(run.id, owner);
  }

  return planWorkspace(run, scope, state, definition, {
    driver: { kind: '', machine: '', workspace: '' },
    modes: ['read-only', 'new', 'continue'],
    base: run.base ?? { ref: 'HEAD', commit: 'base' },
  }, true).contract?.branch;
}
