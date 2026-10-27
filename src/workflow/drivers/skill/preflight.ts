/** Before a run: what describe asks the person, and whether a start carries every answer it needs. */
import { isLaunchTool, LAUNCH_ORDER, type LaunchTool } from '../../../tool-launch/tools.js';
import { TOOLS } from '../../../tools.js';
import type { LocalConfig, ToolId } from '../../../types.js';
import type { GateGuards, WorkflowDescription } from '../../describe.js';
import { INVOKE_ASK_NEED, unattendedReason, type Judging } from '../../protocol.js';
import type { OutputSchema } from '../../types.js';
import { describeLiteral, localStartLiteral, startLiteral, type Invocation, type Literal } from './literals.js';
import { judgedBy, type DescribeVerdict } from './transitions.js';
import type { DescribeAsk } from './turn.js';

/**
 * The answers a start must carry: the person's yes for `invoke: ask`, the inputs, how many steps run at once, how
 * optional gates are answered, and the tool of a session whose host names none (`needsTool`).
 */
export type StartAnswer = 'confirmed' | 'inputs' | 'parallel' | 'hitl' | 'tool';

/**
 * Whether a session working in `tool` must name it before it runs `description`: it names none, and a step's model
 * needs one, or a scored step does when the run is `judged`.
 */
export function needsTool(description: WorkflowDescription, input: { tool: ToolId | undefined; judged: boolean }): boolean {
  return input.tool === undefined && (description.facts.modeled.length > 0 || (input.judged && description.facts.scored.length > 0));
}

/**
 * How a run answers its optional gates, as the person picked at start: the agent asks the person (`person`), the agent
 * answers with its best recommendation (`recommend`), or the engine answers them (`auto-approve`). A required approval
 * always goes to the person.
 */
export const HITL_MODES = ['person', 'recommend', 'auto-approve'] as const;
export type HitlMode = typeof HITL_MODES[number];

export type StartCheck =
  | { kind: 'ok'; parallel: number; hitl: HitlMode }
  | { kind: 'confirm-needed'; missing: StartAnswer[]; outOfRange?: { parallel: number; ceiling: number } };

/** The answers a start of `description` needs before it can run. */
export function neededAnswers(description: WorkflowDescription): StartAnswer[] {
  return [
    ...(description.invoke === 'ask' ? ['confirmed' as const] : []),
    ...(Object.keys(description.inputs).length > 0 ? ['inputs' as const] : []),
    ...(description.facts.width > 1 ? ['parallel' as const] : []),
    ...(description.facts.gates.some((gate) => !gate.required) ? ['hitl' as const] : []),
  ];
}

/** Why `description` must run with the local driver, or undefined when this driver runs it: its local route. */
export function localReason(description: WorkflowDescription): string | undefined {
  const { name, facts } = description;
  const route = facts.localRoute;
  if (!route) return undefined;
  const keys = facts.held.find((held) => held.step === route.held)?.env ?? [];
  const lacks = missingReason(route.missing, keys);
  return `Step ${route.held} works in the workspace ${route.opener} opened, and ${lacks}. Only the driver that opened that workspace may go on in it, so the local driver runs the whole of ${name}.`;
}

/**
 * Why a run of `description` needs a person, which an unattended run lacks, as a refusal to `act` on it says it:
 * undefined when it can do without one, its optional gates auto-approved. A run to continue counts only the steps it
 * has not `settled` for good: an approval, a choice or an interactive step that already ran, or whose workflow or
 * `for_each` step settled whole (skipped, or every item done), needs nobody now. Its `invoke: ask` still does.
 */
export function attendedReason(description: WorkflowDescription, act: 'start' | 'continue', settled: ReadonlySet<string> = new Set()): string | undefined {
  const { name, facts } = description;
  // `a.b.c` is settled when `a`, `a.b` or `a.b.c` is: a workflow's steps exist in the run only once it starts, and an
  // item's path (`a[0].b`) is not the definition's (`a.b`).
  const left = (step: string): boolean => !step.split('.').some((_, at, segments) => settled.has(segments.slice(0, at + 1).join('.')));
  const interactive = facts.interactive.filter(left);
  const gates = facts.gates.filter((gate) => left(gate.step));
  const required = gates.filter((gate) => gate.required);
  const open = gates.filter((gate) => !gate.required && gate.kind === 'choose' && gate.default === undefined);
  const needs = [
    ...(description.invoke === 'ask' ? [INVOKE_ASK_NEED] : []),
    ...(interactive.length > 0 ? [`${listOf(interactive)} ${interactive.length > 1 ? 'are' : 'is'} interactive, worked with a person`] : []),
    ...(required.length > 0 ? [`only a person can answer the ${gatesNoun(required)} at ${listOf(required.map((gate) => gate.step))}`] : []),
    ...(open.length > 0 ? [`the ${open.length > 1 ? 'choices' : 'choice'} at ${listOf(open.map((gate) => gate.step))} ${open.length > 1 ? 'have' : 'has'} no default, so --auto-approve leaves ${open.length > 1 ? 'them' : 'it'} to a person`] : []),
  ];
  if (needs.length === 0) return undefined;
  return unattendedReason(name, listOf(needs), act);
}

/** Checks a start of `description` against what describe asked. `ceiling` is the most steps the driver runs at once. */
export function checkStartAnswers(input: {
  description: WorkflowDescription;
  answers: { parallel?: number; confirmed: boolean; hitl?: HitlMode; judge?: false };
  inputs: unknown;
  ceiling: number;
  tool: ToolId | undefined;
}): StartCheck {
  const { description, answers, inputs, ceiling } = input;
  const given: Record<StartAnswer, boolean> = {
    confirmed: answers.confirmed, inputs: inputs !== undefined, parallel: answers.parallel !== undefined, hitl: answers.hitl !== undefined, tool: input.tool !== undefined,
  };
  const missing = [...neededAnswers(description), ...(needsTool(description, { tool: input.tool, judged: answers.judge !== false }) ? ['tool' as const] : [])].filter((answer) => !given[answer]);
  const outOfRange = answers.parallel !== undefined && answers.parallel > ceiling ? { parallel: answers.parallel, ceiling } : undefined;
  if (missing.length > 0 || outOfRange) return { kind: 'confirm-needed', missing, ...(outOfRange ? { outOfRange } : {}) };
  return { kind: 'ok', parallel: answers.parallel ?? 1, hitl: answers.hitl ?? 'person' };
}

/** `items` as an English list: `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.slice(-1).join('')}` : items.join('');
}

/** What `gates` are, by kind: approvals, choices, or both; one gate's noun is singular unless `plural`. */
function gatesNoun(gates: ReadonlyArray<{ kind: 'approve' | 'choose' }>, plural = gates.length > 1): string {
  const kinds = new Set(gates.map((gate) => gate.kind));
  if (kinds.size > 1) return 'approvals and choices';
  const noun = kinds.has('choose') ? 'choice' : 'approval';
  return plural ? `${noun}s` : noun;
}

/** The start option that has the engine answer optional `noun`, as its label names it. */
function autoAnswered(noun: string): string {
  return `answer optional ${noun} automatically`;
}

type GateFact = WorkflowDescription['facts']['gates'][number];

/** What optional `gate` guards, as a sentence: what its step does, or for a choice, what it picks from. */
function optionalGateFact(gate: GateFact): string {
  switch (gate.kind) {
    case 'approve':
      return `Optional approval at ${gate.step}: ${guardsFact(gate.guards)}${gate.deliver ? ', then opens a pull request' : ''}.`;
    case 'choose': {
      const picks = gate.default !== undefined ? `"answer automatically" picks ${gate.default}` : 'no default, so "answer automatically" leaves it to you';
      return `Optional choice at ${gate.step}: one of ${gate.options.join(', ')}; ${picks}.`;
    }
    default: {
      const unhandled: never = gate;
      return unhandled;
    }
  }
}

/** What a gated step does once answered, as the part of its line after the step. */
function guardsFact(guards: GateGuards): string {
  switch (guards.kind) {
    case 'command':
      return `before \`${guards.line}\``;
    case 'prompt':
      return 'before a prompt step, which a child agent works';
    case 'interactive':
      return 'before an interactive step, which you work here with this session\'s agent';
    case 'workflow':
      return guards.name !== undefined ? `before workflow ${guards.name}` : 'before an inline workflow';
    case 'end':
      return `before ${guards.workflow ?? 'the run'} ends ${guards.end}`;
    case 'none':
      return `no action; ${guards.waiting.length > 0 ? `${listOf(guards.waiting)} wait${guards.waiting.length > 1 ? '' : 's'} for it` : 'no step waits for it'}`;
    default: {
      const unhandled: never = guards;
      return unhandled;
    }
  }
}

/** Who answers optional gates: whom the start the person picks names (`picked`), or the engine, as an unattended start has it (`auto-approve`). */
type GateAnswering = 'picked' | 'auto-approve';

/** How `answering` answers the `optional` gates. */
function optionalAnswersFact(optional: readonly GateFact[], answering: GateAnswering): string {
  const noun = gatesNoun(optional, true);
  const choices = optional.filter((gate) => gate.kind === 'choose');
  const choiceAnswer = `each choice with its default${choices.some((gate) => gate.default === undefined) ? ', if it has one' : ''}`;
  const answers = [...(optional.some((gate) => gate.kind === 'approve') ? ['each approval yes'] : []), ...(choices.length > 0 ? [choiceAnswer] : [])].join(' and ');
  return answering === 'auto-approve' ? `It answers optional ${noun} automatically: ${answers}.`
    : `The recommended start lets this session's agent answer optional ${noun} and say why; "${autoAnswered(noun)}" answers ${answers}.`;
}

function typeOf(schema: OutputSchema): string {
  switch (schema.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'object':
      return schema.type;
    case 'enum':
      return `one of ${schema.values.join(', ')}`;
    case 'array':
      return `list of ${typeOf(schema.items)}`;
    default: {
      const unhandled: never = schema;
      return unhandled;
    }
  }
}

/** `ms` in the largest unit that divides it: `2h`, `90s`. */
function durationOf(ms: number): string {
  const unit = ([['h', 3_600_000], ['m', 60_000], ['s', 1_000]] as const).find(([, size]) => ms % size === 0);
  return unit ? `${ms / unit[1]}${unit[0]}` : `${ms}ms`;
}

type HeldFact = WorkflowDescription['facts']['held'][number];

/** Why a coding session cannot give a held step what it lacks, `missing`; `env` is the keys the step requires. */
function missingReason(missing: HeldFact['missing'][number], env: readonly string[]): string {
  if (missing === 'env') return `needs env ${listOf(env)}, which a coding session keeps from its agents`;
  if (missing === 'tokens') return 'runs under a token budget, which no coding session meters for teamai';
  if (missing.startsWith('policy.')) return `needs ${missing.slice('policy.'.length)}, which workflows.allow in this machine's local config does not allow`;
  return `needs ${missing}, which a coding session does not provide`;
}

/** Why this driver is held from step `held`, and what the person does about it. */
function heldFact(held: HeldFact): string {
  const reasons = held.missing.map((missing) => missingReason(missing, held.env));
  const after = held.missing.some((missing) => missing.startsWith('policy.'))
    ? 'so no driver on this machine runs it'
    : 'so you finish it in your own terminal with teamai workflow resume once the run reaches it';
  return `${held.step} ${reasons.join(', and ')}, ${after}.`;
}

/** What the person needs to know before `description` runs, a sentence each, in the order a run meets it. */
function factsOf(description: WorkflowDescription, judging: Judging, answering: GateAnswering): string[] {
  const { name, inputs, facts } = description;
  const named = Object.entries(inputs).map(([input, type]) => `${input} (${typeOf(type)})`);
  const required = facts.gates.filter((gate) => gate.required);
  const optional = facts.gates.filter((gate) => !gate.required);
  const { interactive } = facts;
  const missing = facts.requiresEnv.missingHere;
  const [one, many] = [missing.length === 1, interactive.length > 1];
  const scored = listOf(facts.scored.map((step) => step.step));
  return [
    ...(named.length > 0 ? [`${name} needs the input${named.length > 1 ? 's' : ''} ${listOf(named)}.`] : []),
    ...(facts.width > 1 ? [`It can run up to ${facts.width} steps at once.`] : []),
    ...(interactive.length > 0 ? [`${listOf(interactive)} ${many ? 'are' : 'is'} interactive: you work in ${many ? 'them' : 'it'} here, with this session's agent.`] : []),
    ...(required.length > 0 ? [`Only you can answer the ${gatesNoun(required)} at ${listOf(required.map((gate) => gate.step))}, from your own terminal or teamai dashboard.`] : []),
    ...optional.map(optionalGateFact),
    ...(optional.length > 0 ? [optionalAnswersFact(optional, answering)] : []),
    ...facts.deliver.map(({ step, onto }) => (onto !== undefined ? `It opens a pull request from ${step} onto the pull request of ${onto}.`
      : facts.base !== undefined ? `It opens a pull request from ${step} into ${facts.base}.`
        : `${step} opens a pull request, which needs a branch to target: check out a branch here before you start it.`)),
    ...(missing.length > 0 ? [`${listOf(missing)} ${one ? 'has' : 'have'} no value on this machine: set ${one ? 'it' : 'them'} with ${listOf(missing.map((key) => `teamai env set ${key}`))} before the steps that require ${one ? 'it' : 'them'} run, or those steps fail.`] : []),
    ...facts.held.map(heldFact),
    ...facts.budgets.map(({ step, tokens }) => (step === undefined ? `It may spend at most ${tokens} tokens.` : `${step} may spend at most ${tokens} tokens each time it starts.`)),
    ...(facts.timeout !== undefined ? [`It stops after ${durationOf(facts.timeout)}.`] : []),
    ...(judging.kind === 'here' ? [`${judging.tool} judges ${scored} here, with one confined judge call per pass.`] : []),
    ...(judging.kind === 'session' ? [`${scored} ${facts.scored.length > 1 ? 'are' : 'is'} judged by this session in a subagent once the run is done, at best-effort isolation. ${judging.reason}`] : []),
    ...(judging.kind === 'session' && judging.verified ? [`${listOf(judging.verified)} ${judging.verified.length > 1 ? 'ask' : 'asks'} for verified isolation, so that work stays open for another driver.`] : []),
    ...(judging.kind === 'elsewhere' ? [`${scored} ${facts.scored.length > 1 ? 'are' : 'is'} not judged on this machine. ${judging.reason}`] : []),
    ...(description.invoke === 'ask' ? ['The team asks that you agree before it starts.'] : []),
  ];
}

/**
 * The starts the question offers: the recommended one, which runs at the full width with the agent deciding optional
 * gates and judging on, then the same start with one answer changed. At most five, whatever the workflow.
 */
function optionsOf(description: WorkflowDescription, judging: Judging, invocation: Invocation, tool: ToolId | undefined): Array<{ label: string; start: Literal }> {
  const { name, facts } = description;
  const flags = { ...startFlags(description), ...(tool !== undefined ? { tool } : {}) };
  const noun = gatesNoun(facts.gates.filter((gate) => !gate.required), true);
  const judged = judgedBy(judging) !== undefined;
  const recommended = recommendedPick(description);
  const others: Array<{ label: string; pick: StartPick }> = [
    ...(recommended.hitl ? [
      { label: `Same, but ask me at optional ${noun}`, pick: { ...recommended, hitl: 'person' as const } },
      { label: `Same, but ${autoAnswered(noun)}`, pick: { ...recommended, hitl: 'auto-approve' as const } },
    ] : []),
    ...(recommended.parallel !== undefined ? [{ label: 'Same, but one step at a time', pick: { ...recommended, parallel: 1 } }] : []),
    ...(judged ? [{ label: 'Same, but without judging', pick: { ...recommended, noJudge: true as const } }] : []),
  ];
  const parts = [
    ...(recommended.parallel !== undefined ? [`up to ${recommended.parallel} steps at once`] : []),
    ...(recommended.hitl ? [`you decide optional ${noun}`] : []),
    ...(judged ? ['with judging'] : []),
  ];
  const first = others.length > 0 ? `Recommended: ${parts.join(', ')}` : flags.confirmed ? 'Yes, start it' : 'Start it';
  return [{ label: first, pick: recommended }, ...others].map(({ label, pick }) => ({ label, start: startLiteral(invocation, name, { ...flags, ...pick }) }));
}

/** The answers one offered start carries beside the person's yes and the inputs. */
interface StartPick {
  parallel?: number;
  hitl?: HitlMode;
  noJudge?: true;
}

/** Whether every start of `description` carries the person's yes, and the `{inputs}` slot. */
function startFlags(description: WorkflowDescription): { confirmed: boolean; inputs: boolean } {
  const needed = neededAnswers(description);
  return { confirmed: needed.includes('confirmed'), inputs: needed.includes('inputs') };
}

/** The answers of the recommended start: every step it can run at once, and the agent deciding optional gates. */
function recommendedPick(description: WorkflowDescription): StartPick {
  const needed = neededAnswers(description);
  return { ...(needed.includes('parallel') ? { parallel: description.facts.width } : {}), ...(needed.includes('hitl') ? { hitl: 'recommend' as const } : {}) };
}

/** The inputs of `description`, as describe lists them for its `{inputs}` slot. */
function inputsOf(description: WorkflowDescription): Array<{ name: string; type: OutputSchema }> {
  return Object.entries(description.inputs).map(([input, type]) => ({ name: input, type }));
}

/**
 * The prompt tool a person's local run must be told: the session's `tool`, when nothing on this machine picks the tool
 * prompt steps run on and the local driver launches `tool`. `workflows.tools.default` picks one, and so does each of
 * `aiTools`, the tools the member names, unless it names a tool teamai calls but runs no steps on, which the step passes
 * over. Undefined when one of those picks a tool, or when no tool the local driver launches is known.
 */
export function localPromptTool({ config, tool, aiTools }: { config: LocalConfig; tool: ToolId | undefined; aiTools: readonly string[] }): LaunchTool | undefined {
  const picks = (named: string) => isLaunchTool(named) || !LAUNCH_ORDER.some((launched) => launched === named);
  const picked = !!config.workflows?.tools.default || aiTools.some(picks);
  return !picked && tool !== undefined && isLaunchTool(tool) ? tool : undefined;
}

/**
 * The describe reply's `ask` of the kind the transitions chose. `tools.local`: the prompt tool a local start names.
 * `tools.session`: the tool the session declared, which every skill start it offers keeps.
 */
export function askFor(verdict: DescribeVerdict, description: WorkflowDescription, invocation: Invocation, judging: Judging, tools: { local?: string; session?: ToolId }): DescribeAsk {
  const { name } = description;
  const session = tools.session !== undefined ? { tool: tools.session } : {};
  const facts = factsOf(description, judging, verdict.ask === 'unattended' ? 'auto-approve' : 'picked').map((fact) => `- ${fact}`);
  switch (verdict.ask) {
    case 'start':
      return { kind: 'start', ...(facts.length > 0 ? { say: facts.join('\n') } : {}), start: startLiteral(invocation, name, session) };
    case 'unattended': {
      const inputs = inputsOf(description);
      const start = startLiteral(invocation, name, { ...startFlags(description), ...recommendedPick(description), hitl: 'auto-approve', ...session });
      return { kind: 'start', ...(facts.length > 0 ? { say: facts.join('\n') } : {}), start, ...(inputs.length > 0 ? { inputs } : {}) };
    }
    case 'tool':
      return {
        kind: 'tool', reason: 'This coding session names no tool, which the run needs for the models of its steps or its judging.', describe: describeLiteral(invocation, name, { tool: '{tool}' }), tools: Object.keys(TOOLS),
      };
    case 'local':
    case 'denied':
      return verdict.ask === 'local' ? { kind: 'local', reason: verdict.reason, start: localStartLiteral(invocation, name, { tool: tools.local }) } : { kind: 'denied', reason: verdict.reason };
    case 'ask': {
      const options = optionsOf(description, judging, invocation, tools.session);
      const confirmed = description.invoke === 'ask';
      const inputs = inputsOf(description);
      const closing = options.length > 1 ? (confirmed ? 'Start it, and if so, how should it run?' : 'How should it run?')
        : confirmed || inputs.length === 0 ? 'Start it?' : `What should the input${inputs.length > 1 ? 's' : ''} be?`;
      return { kind: 'ask', question: { text: [...facts, closing].join('\n'), inputs, options } };
    }
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}

/** The most steps the skill driver runs at once when the member set no `workflows.max_parallel`. */
const SKILL_MAX_CHILDREN = 3;

/** The most steps the skill driver runs at once for `config`. */
export function ceilingOf(config: LocalConfig): number {
  return config.workflows?.max_parallel ?? SKILL_MAX_CHILDREN;
}
