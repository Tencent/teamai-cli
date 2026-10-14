import { createHash, randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from '../update.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, workflowsRunBy } from './cache.js';
import {
  evaluateExpression, expressionPaths, isRecord, isTruthy, parseExpression, resolvePath,
  type Expression, type ExpressionPath, type ExpressionStep, type VisibleOutcome,
} from './expression.js';
import { outputMismatch } from './output.js';
import { noteRunRecord, pendingRecords } from './records.js';
import { parseTemplate, renderStrings, renderText, templatedTexts, templatePaths, type TemplateContext, type TemplateError } from './template.js';
import { generateRunId, isRunId, readRun, runLockPath, writeRun } from './store.js';
import type {
  CachedWorkflow,
  DriverIdentity,
  InlineWorkflow,
  OutputSchema,
  RunState,
  RunStatus,
  StepOutcome,
  StepState,
  TokenUsage,
  WorkflowDefinition,
  WorkflowEnvelope,
  WorkflowFailure,
  WorkflowStep,
} from './types.js';
import { hasAction } from './types.js';

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

/**
 * Recent settled attempt ids kept for `repeated_report`.
 * Older ids are no longer listed; revision and the active lease still reject them.
 */
export const SETTLED_ATTEMPTS_LIMIT = 32;

export interface ReportInput {
  attempt: string;
  revision: number;
  outcome: StepOutcome;
  driver: DriverIdentity;
  outputs?: unknown;
  exitCode?: number;
  message?: string;
  tool?: string;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

function error(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

function ok(value: Record<string, unknown>): WorkflowEnvelope {
  return { data: value };
}

function sameDriver(left: DriverIdentity, right: DriverIdentity): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRun<T extends WorkflowEnvelope>(
  config: LocalConfig,
  runId: string,
  mutate: (run: RunState, now: string) => Promise<{ envelope: T; save: boolean }>,
): Promise<T> {
  if (!isRunId(runId)) return error('invalid_run', 'Run id must look like r followed by 8 or 16 hex digits') as T;
  const lock = runLockPath(config, runId);
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    held = await acquireLock(lock);
    if (!held) await delay(LOCK_WAIT_MS);
  }
  if (!held) return error('busy', `Run ${runId} is locked by another process`) as T;
  try {
    const loaded = await readRun(config, runId);
    if (loaded === 'missing') return error('run_not_found', `Run ${runId} was not found`) as T;
    if (loaded === 'corrupt') return error('run_unreadable', `Run ${runId} could not be read`) as T;
    // One timestamp per operation, so a settled run's end record and its run file agree.
    const now = new Date().toISOString();
    const result = await mutate(loaded, now);
    if (result.save) {
      loaded.updatedAt = now;
      await writeRun(config, loaded);
    }
    return result.envelope;
  } finally {
    await releaseLock(lock);
  }
}

interface RenderedLease {
  prompt?: string;
  env?: Record<string, string>;
}

/** A workflow inside a run: the top-level one, or the sub-workflow a step runs. */
interface Scope {
  /** What every step path inside it starts with: '' at the top, `<workflow step path>.` inside a sub-workflow. */
  prefix: string;
  definition: WorkflowDefinition | InlineWorkflow;
  inputs: Record<string, unknown> | undefined;
  /** For an inline workflow: the enclosing workflows' steps, by id, which its own steps hide. */
  outer?: Record<string, ExpressionStep>;
}

function topScope(run: RunState): Scope {
  return { prefix: '', definition: run.definition, inputs: run.inputs };
}

/**
 * The scope of the workflow a step runs, or undefined when the run did not keep that workflow.
 * An inline workflow reads the inputs and the steps of the workflow `scope` around it.
 */
function childScope(run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep): Scope | undefined {
  if (typeof step.workflow === 'object') {
    return { prefix: `${state.id}.`, definition: step.workflow, inputs: scope.inputs, outer: expressionSteps(scope, states) };
  }
  const definition = step.workflow === undefined ? undefined : run.workflows?.[step.workflow];
  return definition && { prefix: `${state.id}.`, definition, inputs: state.inputs };
}

/** The step instances directly inside a scope, in declaration order. */
function statesIn(run: RunState, scope: Scope): StepState[] {
  return run.steps.filter((state) => state.id.startsWith(scope.prefix) && !state.id.slice(scope.prefix.length).includes('.'));
}

/** The step id an instance has inside its own workflow. */
function localId(scope: Scope, state: StepState): string {
  return state.id.slice(scope.prefix.length);
}

/** The scope and definition of the step instance at `path`, or undefined when the run file does not describe it. */
export function locateStep(run: RunState, path: string): { scope: Scope; step: WorkflowStep } | undefined {
  let scope = topScope(run);
  const ids = path.split('.');
  for (const [index, id] of ids.entries()) {
    const step = scope.definition.steps.find((item) => item.id === id);
    if (!step) return undefined;
    if (index === ids.length - 1) return { scope, step };
    const state = run.steps.find((item) => item.id === `${scope.prefix}${id}`);
    const child = state && childScope(run, scope, statesIn(run, scope), state, step);
    if (!child) return undefined;
    scope = child;
  }
  return undefined;
}

/** A step's `with` holds a template that does not parse. Pull rejects one, so the run file was changed. */
function withTemplateFailure(state: StepState, error: TemplateError): WorkflowFailure {
  return { code: 'invalid_template', message: `step "${state.id}" with template ${error.source}: ${error.message}` };
}

/**
 * Renders a step's prompt and env from its workflow's inputs and settled steps only,
 * so a repeated `next` for the same attempt renders the same text.
 * Pull rejects a template that does not parse, so a failure here means the run file was changed.
 */
function renderLease(scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep): RenderedLease | WorkflowFailure {
  const context: TemplateContext = { inputs: scope.inputs, steps: expressionSteps(scope, states) };
  // A prompt step's `with` renders first, by the same rules as a workflow step's; its prompt reads it as `with.<name>`.
  if (definition.with !== undefined) {
    const values = renderStrings(definition.with, context);
    if (!values.ok) return withTemplateFailure(state, values.error);
    context.with = values.value;
  }
  const rendered = new Map<string, string>();
  for (const { what, text } of templatedTexts(definition)) {
    if (what.startsWith('with.')) continue;
    const parsed = parseTemplate(text);
    if (!parsed.ok) {
      const [problem] = parsed.errors;
      return { code: 'invalid_template', message: `step "${state.id}" ${what} template ${problem?.source}: ${problem?.message}` };
    }
    rendered.set(what, renderText(parsed.template, context));
  }
  const env = Object.keys(definition.env ?? {}).map((name) => [name, rendered.get(`env.${name}`) ?? ''] as const);
  return {
    ...(rendered.has('prompt') ? { prompt: rendered.get('prompt') } : {}),
    ...(definition.env ? { env: Object.fromEntries(env) } : {}),
  };
}

function leaseEnvelope(run: RunState, state: StepState, definition: WorkflowStep, rendered: RenderedLease): WorkflowEnvelope {
  return ok({ lease: {
    run: run.id,
    step: state.id,
    attempt: state.lease?.attempt,
    revision: state.lease?.revision,
    ...(definition.command !== undefined ? { command: definition.command } : {}),
    ...(rendered.env ? { env: rendered.env } : {}),
    ...(rendered.prompt !== undefined ? { prompt: rendered.prompt } : {}),
    ...(definition.agent !== undefined ? { agent: definition.agent } : {}),
    ...(definition.output ? { output: definition.output } : {}),
  } });
}

/** Fails a step the engine cannot hand out, so the rest of the graph keeps settling. Like a skip, it does not bump `revision`. */
function failStep(step: StepState, failure: WorkflowFailure): void {
  step.status = 'failed';
  step.outcome = 'failed';
  step.lease = undefined;
  step.attempt = undefined;
  step.message = failure.message;
  step.failure = failure;
}

/** The status of a run, or of a workflow inside it, once it has settled. */
type FinalRunStatus = Exclude<RunStatus, 'running'>;

/** How a workflow of the run settled: its outcome, the end it reached, and the outputs it returns. */
interface WorkflowResult {
  outcome: FinalRunStatus;
  end?: string;
  outputs?: Record<string, unknown>;
}

/**
 * Ends the run. Every path that settles a run goes through here, so anything that reacts to a settled run hooks in here.
 * Returns a copy of the settled run for the end record, which publishes after the run lock is released (#1126).
 */
function settleRun(run: RunState, now: string, outcome: FinalRunStatus, end?: string): RunState {
  run.status = outcome;
  if (end !== undefined) run.end = end;
  run.updatedAt = now;
  return { ...run, steps: run.steps.map((step) => ({ ...step })) };
}

function doneEnvelope(run: RunState): WorkflowEnvelope {
  return ok({ done: { run: run.id, outcome: run.status, ...(run.end !== undefined ? { end: run.end } : {}) } });
}

/** A step with `end` and no action only ends the workflow; the engine settles it without a lease. */
function endsOnly(step: WorkflowStep | undefined): boolean {
  return step?.end !== undefined && !hasAction(step);
}

/** A step that ran and did not succeed. Later issues add `timeout` and `cancelled`. */
function stopped(step: StepState): boolean {
  return step.status === 'failed';
}

function settled(step: StepState | undefined): boolean {
  return step?.status === 'succeeded' || step?.status === 'failed' || step?.status === 'skipped';
}

/** The step ids these paths read. */
function stepsRead(paths: ExpressionPath[]): Set<string> {
  return new Set(paths.flatMap((path) => (path.root === 'steps' ? [path.step] : [])));
}

/**
 * The step ids a step reads in its `if` and templates, and, when it runs an inline workflow, the ids that workflow's
 * steps read outside it, at any depth. An `if` or template that does not parse reads nothing here; settling its own
 * workflow reports it.
 */
function readsOf(step: WorkflowStep): Set<string> {
  const parsed = step.if === undefined ? undefined : parseExpression(step.if);
  const paths = [
    ...(parsed?.ok ? expressionPaths(parsed.expression) : []),
    ...templatedTexts(step).flatMap(({ text }) => {
      const template = parseTemplate(text);
      return template.ok ? templatePaths(template.template) : [];
    }),
  ];
  const ids = stepsRead(paths);
  if (typeof step.workflow === 'object') {
    const own = new Set(step.workflow.steps.map((item) => item.id));
    for (const item of step.workflow.steps) for (const id of readsOf(item)) if (!own.has(id)) ids.add(id);
  }
  return ids;
}

interface RunReads {
  /** Each step's parsed `if`. */
  conditions: Map<string, Expression>;
  /** The step ids each step's `if` and templates read. */
  reads: Map<string, Set<string>>;
  /** The path each declared output reads. */
  outputs: Map<string, ExpressionPath>;
}

/** Parses every `if` and template in a workflow of the run. A run file whose `if` does not parse cannot settle; the message names the step. */
function parseReads(run: RunState, scope: Scope): RunReads | string {
  const conditions = new Map<string, Expression>();
  const reads = new Map<string, Set<string>>();
  const own = new Set(scope.definition.steps.map((step) => step.id));
  for (const step of scope.definition.steps) {
    if (step.if !== undefined) {
      const parsed = parseExpression(step.if);
      if (!parsed.ok) return `Run ${run.id} step "${scope.prefix}${step.id}" has an if that does not parse: ${parsed.message}`;
      conditions.set(step.id, parsed.expression);
    }
    // A template that does not parse reads nothing; the step fails when it would be leased.
    // An inline workflow's reads of enclosing steps settled before it started, so only its own steps are waited for.
    reads.set(step.id, new Set([...readsOf(step)].filter((id) => !scope.outer || own.has(id))));
  }
  const outputs = new Map<string, ExpressionPath>();
  for (const [name, source] of Object.entries(scope.definition.outputs ?? {})) {
    const parsed = parseExpression(source);
    const workflow = 'name' in scope.definition ? `workflow "${scope.definition.name}"` : `step "${scope.prefix.slice(0, -1)}" inline workflow`;
    if (!parsed.ok || parsed.expression.kind !== 'path') return `Run ${run.id} ${workflow} output "${name}" is not a path`;
    outputs.set(name, parsed.expression.path);
  }
  return { conditions, reads, outputs };
}

const VISIBLE_OUTCOMES: Partial<Record<StepState['status'], VisibleOutcome>> ={ succeeded: 'success', failed: 'failed', skipped: 'skipped' };

/**
 * What expressions in a workflow read as `steps.<id>`: its own step instances, by their id in that workflow,
 * and, in an inline workflow, the enclosing steps its own steps do not hide.
 */
function expressionSteps(scope: Scope, states: StepState[]): Record<string, ExpressionStep> {
  return { ...scope.outer, ...Object.fromEntries(states.map((step) => [localId(scope, step), {
    ...(VISIBLE_OUTCOMES[step.status] ? { outcome: VISIBLE_OUTCOMES[step.status] } : {}),
    ...(step.end !== undefined ? { end: step.end } : {}),
    ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
  }])) };
}

/**
 * Marks every pending step of a workflow that can no longer run as `skipped`, until nothing changes:
 * the skip rule in `mustSkip`, and a ready step whose `if` is false.
 * Returns whether a step is ready: everything it needs and everything its `if` and templates read has settled.
 */
function skipUnreachable(scope: Scope, states: StepState[], { conditions, reads }: RunReads): (step: StepState) => boolean {
  const byId = new Map(states.map((step) => [localId(scope, step), step]));
  const declared = new Map(scope.definition.steps.map((step) => [step.id, step.needs ?? []]));
  const needs = (step: StepState): Array<StepState | undefined> => (declared.get(localId(scope, step)) ?? []).map((id) => byId.get(id));
  const ready = (step: StepState): boolean => needs(step).every(settled)
    && [...reads.get(localId(scope, step)) ?? []].every((id) => settled(byId.get(id)));
  for (let changed = true; changed;) {
    changed = false;
    for (const step of states) {
      if (step.status !== 'pending') continue;
      const condition = conditions.get(localId(scope, step));
      const conditionFalse = (): boolean => !!condition && ready(step)
        && !isTruthy(evaluateExpression(condition, { inputs: scope.inputs, steps: expressionSteps(scope, states) }));
      if (!mustSkip(needs(step), condition, (need) => localId(scope, need)) && !conditionFalse()) continue;
      step.status = 'skipped';
      changed = true;
    }
  }
  return ready;
}

/**
 * A step is skipped when a step it needs stopped and its `if` does not read that step,
 * or when every step it needs was skipped. An `if` that reads every stopped dependency is a recovery step.
 */
function mustSkip(needs: Array<StepState | undefined>, condition: Expression | undefined, id: (need: StepState) => string): boolean {
  const read = stepsRead(condition ? expressionPaths(condition) : []);
  if (needs.some((need) => need && stopped(need) && !read.has(id(need)))) return true;
  return needs.length > 0 && needs.every((need) => need?.status === 'skipped');
}

/** How settling a workflow of the run ended: a step to lease, the workflow's outcome, or a run file that cannot settle. */
type Settled =
  | { lease: StepState; definition: WorkflowStep; rendered: RenderedLease }
  | WorkflowResult
  | { unreadable: string };

/**
 * Starts the workflow a step runs with the values its `with` renders to in the step's own workflow.
 * Its steps join the run right after the step, which is `running` until they settle.
 */
function startWorkflowStep(run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep, child: Scope): WorkflowFailure | undefined {
  // An inline workflow takes no `with`: it already reads the enclosing inputs.
  if ('name' in child.definition) {
    const rendered = renderStrings(step.with ?? {}, { inputs: scope.inputs, steps: expressionSteps(scope, states) });
    if (!rendered.ok) return withTemplateFailure(state, rendered.error);
    const mismatch = inputsMismatch(child.definition.name, child.definition.inputs, rendered.value);
    if (mismatch) return { code: 'invalid_inputs', message: `step "${state.id}" with does not fit workflow "${child.definition.name}": ${mismatch}` };
    if (child.definition.inputs) {
      state.inputs = rendered.value as Record<string, unknown>;
      child.inputs = state.inputs;
    }
  }
  state.status = 'running';
  const steps = child.definition.steps.map((step): StepState => ({ id: `${child.prefix}${step.id}`, status: 'pending' }));
  run.steps.splice(run.steps.indexOf(state) + 1, 0, ...steps);
  return undefined;
}

/** A workflow step takes the outcome, the end, and the outputs of the workflow it ran. */
function finishWorkflowStep(state: StepState, result: WorkflowResult): void {
  state.status = result.outcome;
  state.outcome = result.outcome === 'succeeded' ? 'success' : 'failed';
  if (result.end !== undefined) state.end = result.end;
  if (result.outputs !== undefined) state.outputs = result.outputs;
}

/** The values a workflow returns, read from its own steps; a skipped step reads null. */
function workflowOutputs(scope: Scope, states: StepState[], paths: Map<string, ExpressionPath>): Record<string, unknown> | undefined {
  if (!scope.definition.outputs) return undefined;
  const context = { inputs: scope.inputs, steps: expressionSteps(scope, states) };
  return Object.fromEntries([...paths].map(([name, path]) => [name, resolvePath(path, context)]));
}

/**
 * Settles one workflow of the run while no lease is open: skips, end-only steps, and the workflows its steps run.
 * Returns the first step to lease in declaration order, where a running workflow step stands for its own steps,
 * or the workflow's outcome once nothing is left to run.
 */
function settleScope(run: RunState, scope: Scope): Settled {
  const reads = parseReads(run, scope);
  if (typeof reads === 'string') return { unreadable: reads };
  const states = statesIn(run, scope);
  const defined = new Map(scope.definition.steps.map((item) => [item.id, item]));
  const definitionOf = (state: StepState): WorkflowStep | undefined => defined.get(localId(scope, state));
  // A step that cannot render, or a workflow step that finishes, changes the graph, and settling starts again.
  for (;;) {
    const canRun = skipUnreachable(scope, states, reads);
    const ready = (item: StepState): boolean => item.status === 'pending' && canRun(item);
    const ending = states.find((item) => ready(item) && endsOnly(definitionOf(item)));
    if (ending) ending.status = 'succeeded';
    const reached = states.find((item) => item.status === 'succeeded' && definitionOf(item)?.end !== undefined);
    const end = reached ? definitionOf(reached)?.end : undefined;
    if (end !== undefined) {
      for (const item of states) if (item.status === 'pending') item.status = 'skipped';
      return { outcome: scope.definition.ends?.[end] ?? 'failed', end, outputs: workflowOutputs(scope, states, reads.outputs) };
    }
    const state = states.find((item) => item.status === 'running' || ready(item));
    if (!state) {
      if (states.some((item) => item.status === 'pending')) {
        return { unreadable: `Run ${run.id} has pending steps whose needs cannot be met` };
      }
      return { outcome: states.some(stopped) ? 'failed' : 'succeeded', outputs: workflowOutputs(scope, states, reads.outputs) };
    }
    const definition = definitionOf(state);
    if (!definition) return { unreadable: `Run ${run.id} has no definition for step "${state.id}"` };
    if (definition.workflow !== undefined) {
      const child = childScope(run, scope, states, state, definition);
      if (!child) return { unreadable: `Run ${run.id} step "${state.id}" runs workflow "${definition.workflow}", which the run did not keep` };
      const failure = state.status === 'pending' ? startWorkflowStep(run, scope, states, state, definition, child) : undefined;
      if (failure) {
        failStep(state, failure);
        continue;
      }
      const result = settleScope(run, child);
      if (!('outcome' in result)) return result;
      finishWorkflowStep(state, result);
      continue;
    }
    const rendered = renderLease(scope, states, state, definition);
    if ('code' in rendered) {
      failStep(state, rendered);
      continue;
    }
    return { lease: state, definition, rendered };
  }
}

/** Why `inputs` do not fit what the workflow declares, naming the field, or null when they fit. Every declared input is required. */
function inputsMismatch(name: string, declared: Record<string, OutputSchema> | undefined, inputs: unknown): string | null {
  if (!isRecord(inputs)) return 'inputs must be a JSON object';
  const mismatch = outputMismatch({ type: 'object', fields: declared ?? {} }, inputs, 'inputs');
  if (mismatch) return mismatch;
  // The shorthand allows extra object keys, so an undeclared input is checked here.
  const extra = Object.keys(inputs).find((key) => !declared || !Object.hasOwn(declared, key));
  return extra === undefined ? null : `inputs.${extra} is not an input workflow "${name}" declares`;
}

/** Every workflow `cached` runs through its steps, directly or not, from the cache, and one hash over all of their sources. */
async function loadWorkflows(
  config: LocalConfig,
  cached: CachedWorkflow,
): Promise<{ workflows: Record<string, WorkflowDefinition>; sourceHash: string } | { failed: WorkflowEnvelope }> {
  const workflows: Record<string, WorkflowDefinition> = {};
  const hashes: Array<[string, string]> = [];
  const visit = async (definition: WorkflowDefinition, through: string[]): Promise<WorkflowEnvelope | undefined> => {
    for (const { step, workflow } of workflowsRunBy(definition)) {
      if (through.includes(workflow)) {
        const cycle = [...through.slice(through.indexOf(workflow)), workflow].join(' -> ');
        return error('workflow_recursion', `Workflow "${cached.definition.name}" cannot start: its sub-workflows run in a cycle: ${cycle}`);
      }
      if (Object.hasOwn(workflows, workflow)) continue;
      const child = await loadCachedWorkflow(config, workflow);
      if (!child) {
        return error('workflow_not_found', `Workflow "${definition.name}" step "${step}" runs workflow "${workflow}", which has no runnable version. Check workflows/${workflow}.yaml and pull again.`);
      }
      workflows[workflow] = child.definition;
      hashes.push([workflow, child.sourceHash]);
      const failed = await visit(child.definition, [...through, workflow]);
      if (failed) return failed;
    }
    return undefined;
  };
  const failed = await visit(cached.definition, [cached.definition.name]);
  if (failed) return { failed };
  if (hashes.length === 0) return { workflows, sourceHash: cached.sourceHash };
  const hash = createHash('sha256').update(cached.sourceHash);
  for (const [name, sourceHash] of hashes.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update('\0').update(name).update('\0').update(sourceHash);
  }
  return { workflows, sourceHash: hash.digest('hex') };
}

/** Creates a run. `inputs` are checked against the declared inputs before the run file exists. */
export async function startRun(
  config: LocalConfig,
  name: string,
  inputs: unknown = {},
  options: { driver?: DriverIdentity } = {},
): Promise<WorkflowEnvelope> {
  const cached = await loadCachedWorkflow(config, name);
  if (!cached) {
    return error('workflow_not_found', `Workflow "${name}" has no runnable version. Check workflows/${name}.yaml and pull again.`);
  }
  const mismatch = inputsMismatch(cached.definition.name, cached.definition.inputs, inputs);
  if (mismatch) return error('invalid_inputs', mismatch);
  const tree = await loadWorkflows(config, cached);
  if ('failed' in tree) return tree.failed;
  const now = new Date().toISOString();
  const run: RunState = {
    schemaVersion: 'v1alpha1',
    id: generateRunId(),
    name: cached.definition.name,
    revision: 1,
    status: 'running',
    ...(cached.definition.inputs ? { inputs: inputs as Record<string, unknown> } : {}),
    sourceHash: tree.sourceHash,
    definition: cached.definition,
    ...(Object.keys(tree.workflows).length > 0 ? { workflows: tree.workflows } : {}),
    steps: cached.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRun(config, run);
  // #1083: publish the start record; a failed publication is queued locally
  // and retried on the next pull — it never fails the run itself.
  const record = await noteRunRecord(config, run, options.driver, 'start');
  return ok({ run: run.id, name: run.name, status: run.status, revision: run.revision, record });
}

/** A run started before `needs` existed ran its steps in order; settling it as a graph would run every such step as a root. */
function missingNeeds(run: RunState): string | undefined {
  for (const definition of [run.definition, ...Object.values(run.workflows ?? {})]) {
    const step = definition.steps.slice(1).find((item) => item.needs === undefined);
    if (step) return `Run ${run.id} was started by an older teamai: step "${step.id}" in workflow "${definition.name}" has no needs. Start a new run.`;
  }
  return undefined;
}

export async function leaseNext(config: LocalConfig, runId: string, driver: DriverIdentity): Promise<WorkflowEnvelope> {
  // The end record publishes AFTER withRun releases the run lock (#1126 P3):
  // publication does a reports-branch push, and no network I/O may hold the
  // lock other engine operations wait on.
  let settledRun: RunState | undefined;
  let alreadySettled = false;
  const envelope = await withRun(config, runId, async (run, now) => {
    if (run.status !== 'running') {
      // Settled by an earlier next, which published the end record; the
      // done envelope still reports the queue-derived record state.
      alreadySettled = true;
      return { save: false, envelope: doneEnvelope(run) };
    }
    const older = missingNeeds(run);
    if (older) return { save: false, envelope: error('run_unreadable', older) };
    const leased = run.steps.find((step) => step.status === 'leased');
    if (leased?.lease) {
      if (!sameDriver(leased.lease.driver, driver)) {
        return { save: false, envelope: ok({ wait: { reason: `${leased.id} is leased` } }) };
      }
      const located = locateStep(run, leased.id);
      if (!located) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no definition for step "${leased.id}"`) };
      const rendered = renderLease(located.scope, statesIn(run, located.scope), leased, located.step);
      if (!('code' in rendered)) return { save: false, envelope: leaseEnvelope(run, leased, located.step, rendered) };
      failStep(leased, rendered);
    }
    // Settle the graph here, while no lease is open, so a later report still matches its lease revision.
    const result = settleScope(run, topScope(run));
    if ('unreadable' in result) return { save: false, envelope: error('run_unreadable', result.unreadable) };
    if ('outcome' in result) {
      settledRun = settleRun(run, now, result.outcome, result.end);
      return { save: true, envelope: doneEnvelope(run) };
    }
    const step = result.lease;
    const attempt = `a${randomBytes(4).toString('hex')}`;
    step.status = 'leased';
    step.attempt = attempt;
    step.outcome = undefined;
    step.lease = { attempt, revision: run.revision, driver };
    return { save: true, envelope: leaseEnvelope(run, step, result.definition, result.rendered) };
  });
  if (settledRun || alreadySettled) {
    const record = settledRun
      ? await noteRunRecord(config, settledRun, driver, 'end')
      : ((await pendingRecords(config)).length > 0 ? 'pending' : 'published');
    const done = (envelope as { data?: { done?: Record<string, unknown> } }).data?.done;
    if (done) done.record = record;
  }
  return envelope;
}

function driverFrom(value: unknown): DriverIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const driver = value as DriverIdentity;
  if (typeof driver.kind !== 'string' || driver.kind === '') return undefined;
  if (typeof driver.machine !== 'string' || driver.machine === '') return undefined;
  if (typeof driver.workspace !== 'string' || driver.workspace === '') return undefined;
  return { kind: driver.kind, machine: driver.machine, workspace: driver.workspace };
}

export function parseReport(value: unknown): ReportInput | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'report must be a JSON object';
  const record = value as Record<string, unknown>;
  if (typeof record.attempt !== 'string' || record.attempt === '') return 'attempt must be a string';
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision)) return 'revision must be an integer';
  if (record.outcome !== 'success' && record.outcome !== 'failed' && record.outcome !== 'released') {
    return 'outcome must be success, failed, or released';
  }
  const driver = driverFrom(record.driver);
  if (!driver) return 'driver must include kind, machine, and workspace';
  const report: ReportInput = { attempt: record.attempt, revision: record.revision, outcome: record.outcome, driver };
  if ('outputs' in record) report.outputs = record.outputs;
  if (record.exitCode !== undefined) {
    if (typeof record.exitCode !== 'number' || !Number.isInteger(record.exitCode)) return 'exitCode must be an integer';
    report.exitCode = record.exitCode;
  }
  if (record.message !== undefined) {
    if (typeof record.message !== 'string') return 'message must be a string';
    report.message = record.message;
  }
  for (const field of ['tool', 'model', 'session'] as const) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string') return `${field} must be a string`;
    report[field] = record[field];
  }
  if (record.tokens !== undefined) {
    if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) return 'tokens must be an object';
    const value = record.tokens as Record<string, unknown>;
    const tokens: TokenUsage = {};
    for (const field of ['input', 'output', 'cachedInput'] as const) {
      if (value[field] === undefined) continue;
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) return `tokens.${field} must be a finite number`;
      tokens[field] = value[field];
    }
    report.tokens = tokens;
  }
  if (record.failure !== undefined) {
    if (!record.failure || typeof record.failure !== 'object' || Array.isArray(record.failure)) return 'failure must be an object';
    const value = record.failure as Record<string, unknown>;
    if (typeof value.code !== 'string') return 'failure.code must be a string';
    if (typeof value.message !== 'string') return 'failure.message must be a string';
    report.failure = { code: value.code, message: value.message };
  }
  return report;
}

export function parseDriverPayload(value: unknown): DriverIdentity | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'next payload must be a JSON object';
  const driver = driverFrom((value as { driver?: unknown }).driver);
  return driver ?? 'driver must include kind, machine, and workspace';
}

function rememberSettledAttempt(run: RunState, attempt: string): void {
  run.settledAttempts.push(attempt);
  const extra = run.settledAttempts.length - SETTLED_ATTEMPTS_LIMIT;
  if (extra > 0) run.settledAttempts.splice(0, extra);
  // settledAttempts is a bounded dedup history; the cumulative count feeds the
  // run record's iterations field, which must not cap at SETTLED_ATTEMPTS_LIMIT.
  run.settledCount = (run.settledCount ?? 0) + 1;
}

export async function reportAttempt(config: LocalConfig, runId: string, report: ReportInput): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    // Settled membership wins. An old revision of a settled attempt is still repeated_report.
    if (run.settledAttempts.includes(report.attempt)) {
      return { save: false, envelope: error('repeated_report', `Attempt ${report.attempt} was already reported`) };
    }
    if (report.revision !== run.revision) {
      return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) };
    }
    const step = run.steps.find((item) => item.status === 'leased' && item.lease?.attempt === report.attempt);
    if (!step?.lease) {
      return { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) };
    }
    if (!sameDriver(step.lease.driver, report.driver)) {
      return { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') };
    }

    const defined = locateStep(run, step.id)?.step;
    let outcome = report.outcome;
    let message = report.message;
    let failure = report.failure;
    if (outcome === 'success' && defined?.output) {
      const mismatch = outputMismatch(defined.output, report.outputs);
      if (mismatch) {
        outcome = 'failed';
        message = `stdout JSON does not match output: ${mismatch}`;
        failure = { code: 'invalid_output', message };
      }
    }

    step.lease = undefined;
    step.attempt = undefined;
    step.exitCode = report.exitCode;
    step.message = message;
    step.tool = report.tool;
    step.model = report.model;
    step.session = report.session;
    step.tokens = report.tokens;
    step.failure = failure;
    step.outcome = outcome;
    if (outcome === 'released') {
      step.status = 'pending';
    } else if (outcome === 'success') {
      step.status = 'succeeded';
      if (report.outputs !== undefined) step.outputs = report.outputs;
    } else {
      step.status = 'failed';
    }
    rememberSettledAttempt(run, report.attempt);
    run.revision += 1;
    return {
      save: true,
      envelope: ok({
        accepted: true,
        revision: run.revision,
        step: { id: step.id, status: step.status, outcome },
      }),
    };
  });
}
