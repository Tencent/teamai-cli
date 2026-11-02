/**
 * The benchmark plan a run measures, and where its steps sit: the `plan` a `teamai benchmark plan` step printed beside
 * the workflow a `from` step runs, admitted and frozen with the run, whose steps sit under that `from` step.
 */
import { z } from 'zod';
import { fromRequirements } from '../workflow/engine.js';
import { stepDefinitions } from '../workflow/scope.js';
import { stepWorkflow, type RunState, type WorkflowFailure } from '../workflow/types.js';
import { BENCHMARK_PLAN_SCHEMA_VERSION, BenchmarkPlanSchema, type BenchmarkPlan } from './plan.js';

export interface RunPlan {
  plan: BenchmarkPlan;
  /** The path of the workflow that runs the plan's steps, with a trailing `.`. */
  prefix: string;
  /** The path of the step that printed the plan. */
  producer: string;
}

/**
 * Whether the trials of the plan step `producer` prints run their prompts `permissions: unattended`: every step that runs
 * the plan is a strict sandbox. Otherwise each trial runs with its tool's own permission settings.
 */
export function trialsUnattended(run: RunState, producer: string): boolean {
  const runners = fromRequirements(run, producer);
  return runners.length > 0 && runners.every((requires) => requires.floor?.isolation === 'sandbox');
}

const VersionedSchema = z.object({ schemaVersion: z.unknown() }).passthrough();

/**
 * The plan of `run`, or of the `from` step `under` sits beneath. Refused when the run runs no benchmark plan there, runs
 * more than one and `under` names none, or the plan is of a schemaVersion this teamai does not read.
 */
export function planOfRun(run: RunState, under?: string): { found: RunPlan } | { failure: WorkflowFailure } {
  const definitionOf = stepDefinitions(run);
  const planned = run.steps.flatMap((state) => {
    const runs = stepWorkflow(definitionOf(state.id) ?? {});
    if (runs?.kind !== 'from' || (under !== undefined && !under.startsWith(`${state.id}.`))) return [];
    const producer = `${state.id.slice(0, state.id.lastIndexOf('.') + 1)}${runs.step}`;
    const plan = run.admitted?.[producer]?.output.plan;
    return plan === undefined ? [] : [{ step: state.id, producer, plan }];
  });
  const [only, ...more] = planned;
  if (!only) {
    return { failure: { code: 'invalid_arguments', message: `Run ${run.id} runs no benchmark plan${under !== undefined ? ` around step "${under}"` : ''}: no step of it runs the workflow a teamai benchmark plan step printed. Run teamai benchmark only as a step of the benchmark workflow.` } };
  }
  if (more.length > 0) {
    return { failure: { code: 'invalid_arguments', message: `Run ${run.id} runs more than one benchmark plan, in steps ${planned.map(({ step }) => `"${step}"`).join(', ')}, so teamai benchmark report cannot tell which one to report. Run one benchmark plan per run.` } };
  }
  const versioned = VersionedSchema.safeParse(only.plan);
  const version = versioned.success ? versioned.data.schemaVersion : undefined;
  if (version !== BENCHMARK_PLAN_SCHEMA_VERSION) {
    return { failure: { code: 'run_unreadable', message: `Step "${only.producer}" of run ${run.id} printed a benchmark plan of schemaVersion ${JSON.stringify(version) ?? 'none'}, and this teamai reads only schemaVersion ${BENCHMARK_PLAN_SCHEMA_VERSION}. Run the benchmark with the teamai that planned it, or start it again.` } };
  }
  const plan = BenchmarkPlanSchema.safeParse(only.plan);
  if (!plan.success) {
    return { failure: { code: 'run_unreadable', message: `Step "${only.producer}" of run ${run.id} printed a benchmark plan this teamai cannot read: ${plan.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Update teamai, or start the benchmark again.` } };
  }
  return { found: { plan: plan.data, prefix: `${only.step}.`, producer: only.producer } };
}
