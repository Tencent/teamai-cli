/**
 * Workspace planning. The engine names the branch and lists the commits to merge.
 * A driver creates the worktree. This module does not run git.
 */
import { itemsAfter, itemsOf } from './fan-out.js';
import { localId, statesIn, stepDefinitions, type Scope } from './scope.js';
import { parseStepPath } from './step-path.js';
import { passOf, type StepState } from './step-state.js';
import type { DriverIdentity, RunState, WorkflowFailure, WorkflowStep } from './types.js';

export type WorkspaceMode = 'read-only' | 'new' | 'continue';

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
 */
export type WorkspaceContract = {
  base: { ref?: string; commit: string };
  /** The commit agent configuration is restored from before the step runs. */
  configCommit: string;
  branch: string;
  start: { commit: string; branch?: string };
} & (
  | { mode: 'new' | 'continue'; merge: Array<{ branch: string; commit: string }> }
  | { mode: 'read-only'; merge: [] }
);

export interface SessionRef {
  tool: string;
  id: string;
}

export interface WorkspacePlan {
  mode: WorkspaceMode;
  contract?: WorkspaceContract;
  session?: SessionRef;
  /** The step stays pending. `next` does not hand it to this driver. */
  defer?: string;
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
  if (step.workspace) return step.workspace;
  if (step.command !== undefined && step.prompt === undefined && step.promptFile === undefined) return 'read-only';
  for (const ancestor of [...ancestors].reverse()) {
    if (ancestor.workspace !== 'new' && ancestor.workspace !== 'continue') continue;
    return ancestor.forEach ? 'new' : 'continue';
  }
  return 'read-only';
}

interface Ancestor {
  instance: string;
  step: WorkflowStep;
  pass: number;
}

function ancestorsOf(run: RunState, path: string): Ancestor[] {
  const definitionOf = stepDefinitions(run);
  const segments = parseStepPath(path);
  const ancestors: Ancestor[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    const instance = segments.slice(0, length).map((segment) => (
      segment.index === undefined ? segment.id : `${segment.id}[${segment.index}]`
    )).join('.');
    const step = definitionOf(instance);
    if (!step) continue;
    const state = run.steps.find((item) => item.id === instance);
    ancestors.push({ instance, step, pass: state?.pass ?? 1 });
  }
  return ancestors;
}

function changesOf(state: StepState | undefined): StepChanges | undefined {
  if (!state || !('changes' in state) || !state.changes) return undefined;
  return state.changes;
}

/** Direct steps of a workflow step, such as `work.write`, not its fan-out items. */
function workflowChildren(run: RunState, step: StepState): StepState[] {
  const prefix = `${step.id}.`;
  return run.steps.filter((item) => {
    if (!item.id.startsWith(prefix)) return false;
    const rest = item.id.slice(prefix.length);
    return !rest.includes('.') && !rest.includes('[');
  });
}

/** Branches a step merges, `after` items first, then its other needs. An omitted `needs` uses the parent step's needs. */
function mergeChanges(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): StepChanges[] {
  const ordered: Array<{ changes: StepChanges; settledAt: number }> = [];
  const push = (step: StepState | undefined): void => {
    if (!step) return;
    const changes = changesOf(step);
    // A for_each step keeps each item's branch on that item, and a workflow step keeps each child's on that child.
    if (!changes) {
      for (const item of itemsOf(run, step)) push(item);
      for (const child of workflowChildren(run, step)) push(child);
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

function sessionOf(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): SessionRef | WorkflowFailure | undefined {
  if (!definition.session) return undefined;
  if ('continue' in definition.session) {
    const archived = (run.archive ?? []).filter((entry) => entry.step === state.id);
    return sessionFromPasses([...archived, ...(state.passes ?? [])]);
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
  const current = passOf(target);
  return sessionFromPasses([...(target.passes ?? []), ...(current ? [current] : [])]);
}

function sameDriver(left: DriverIdentity, right: DriverIdentity): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
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
  const sessionResult = sessionOf(run, scope, state, definition);
  if (sessionResult && 'code' in sessionResult) return { mode, fail: sessionResult };
  const session = sessionResult ? { session: sessionResult } : {};
  const owner = [...ancestors].reverse().find((ancestor) => opensCopy(ancestor.step));
  const modes = request.modes ?? ['read-only'];
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
      return { mode, defer: `step "${state.id}" reads workspace ${branch}, which needs continue` };
    }
    const base = run.base ?? request.base;
    if (!base) {
      return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" needs the run's base commit` } };
    }
    const copy = run.copies?.[branch];
    if (!handback && copy && !sameDriver(copy.owner, request.driver)) {
      return { mode, defer: `step "${state.id}" reads a workspace owned by another driver` };
    }
    const start = { commit: copy?.commit ?? needed?.commit ?? base.commit };
    return { mode, ...session, contract: { mode, base, configCommit: base.commit, branch, start, merge: [] } };
  }
  if (!handback && !modes.includes(mode)) {
    return { mode, defer: `step "${state.id}" needs workspace ${mode}, which this driver does not provide` };
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
  if (!handback && copy && !sameDriver(copy.owner, request.driver)) {
    return { mode, defer: `step "${state.id}" continues a workspace owned by another driver` };
  }
  const changes = mergeChanges(run, scope, state, definition);
  const [first, ...rest] = mode === 'new' ? changes : [];
  return {
    mode,
    ...(sessionResult ? { session: sessionResult } : {}),
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

/** Whether the steps inside `step` run in a copy it opens rather than in the one around it. */
function opensCopy(step: WorkflowStep): boolean {
  return step.workspace === 'new' || (step.forEach !== undefined && step.workspace === 'continue');
}

/**
 * The existing branch a step that has not started yet would run in. A leaf, or a `for_each` step whose items are leaves,
 * uses the branch its lease names. The steps of a workflow continue or read the copy around it, unless it opens its own;
 * a branch they open themselves does not exist yet.
 */
export function plannedBranch(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): string | undefined {
  if (definition.workflow !== undefined) {
    if (opensCopy(definition)) return undefined;
    const owner = [...ancestorsOf(run, state.id)].reverse().find((ancestor) => opensCopy(ancestor.step));
    return owner && branchName(run.id, owner.instance, owner.pass);
  }
  return planWorkspace(run, scope, state, definition, {
    driver: { kind: '', machine: '', workspace: '' },
    modes: ['read-only', 'new', 'continue'],
    base: run.base ?? { ref: 'HEAD', commit: 'base' },
  }, true).contract?.branch;
}
