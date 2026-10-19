/**
 * Workspace planning. The engine names the branch and lists the commits to merge.
 * A driver creates the worktree. This module does not run git.
 */
import { isItem, itemsAfter, itemsOf } from './fan-out.js';
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

/** The git contract on a `new` or `continue` lease. Paths stay off it. */
export interface WorkspaceContract {
  mode: 'new' | 'continue';
  base: { ref: string; commit: string };
  /** The commit agent configuration is restored from before the step runs. */
  configCommit: string;
  branch: string;
  start: { commit: string; branch?: string };
  merge: Array<{ branch: string; commit: string }>;
}

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
 * How a step runs. An explicit `workspace` wins. A command that omits it is read-only, even inside a copy.
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

/** Branches a step merges, `after` items first, then its other needs. An omitted `needs` uses the parent step's needs. */
function mergeChanges(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): StepChanges[] {
  const ordered: Array<{ changes: StepChanges; settledAt: number }> = [];
  const push = (step: StepState | undefined): void => {
    if (!step) return;
    const changes = changesOf(step);
    // A for_each step keeps each item's branch on that item, not on itself.
    if (!changes) {
      for (const item of itemsOf(run, step)) push(item);
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
  if (isItem(state)) {
    const ownerId = state.id.replace(/\[\d+\]$/, '');
    const owner = run.steps.find((item) => item.id === ownerId);
    if (owner) {
      const items = itemsOf(run, owner);
      const after = itemsAfter(owner.id, items.map((item) => item.item));
      const index = items.indexOf(state);
      if (Array.isArray(after) && index >= 0) {
        for (const other of after[index] ?? []) push(items[other]);
      }
    }
  }
  if (definition.needs === undefined && scope.runner) {
    const parent = stepDefinitions(run)(scope.runner.id);
    const prefix = scope.runner.id.includes('.') ? scope.runner.id.slice(0, scope.runner.id.lastIndexOf('.') + 1) : '';
    for (const id of parent?.needs ?? []) push(run.steps.find((item) => item.id === `${prefix}${id}`));
  } else {
    const states = statesIn(run, scope);
    for (const id of definition.needs ?? []) push(states.find((item) => localId(scope, item) === id));
  }
  return ordered.map((item) => item.changes);
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
  base?: { ref: string; commit: string };
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
  if (mode === 'read-only') return { mode, ...(sessionResult ? { session: sessionResult } : {}) };

  const modes = request.modes ?? ['read-only'];
  if (!handback && !modes.includes(mode)) {
    return { mode, defer: `step "${state.id}" needs workspace ${mode}, which this driver does not provide` };
  }
  const base = run.base ?? request.base;
  if (!base) {
    return { mode, fail: { code: 'workspace_base', message: `step "${state.id}" needs the run's base commit` } };
  }
  const owner = [...ancestors].reverse().find((ancestor) => ancestor.step.workspace === 'new'
    || (ancestor.step.forEach !== undefined && ancestor.step.workspace === 'continue'));
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

/** The branch a step would use, when it runs in a workspace. */
export function plannedBranch(run: RunState, scope: Scope, state: StepState, definition: WorkflowStep): string | undefined {
  return planWorkspace(run, scope, state, definition, {
    driver: { kind: '', machine: '', workspace: '' },
    modes: ['read-only', 'new', 'continue'],
    base: run.base ?? { ref: 'HEAD', commit: 'base' },
  }, true).contract?.branch;
}
