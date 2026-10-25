/** Before a run: what describe asks the person, and whether a start carries every answer it needs. */
import type { ToolName } from '../../../resources/agent-format.js';
import { isLaunchTool, type LaunchTool } from '../../../tool-launch/tools.js';
import type { LocalConfig } from '../../../types.js';
import type { WorkflowDescription } from '../../describe.js';
import type { Judging } from '../../protocol.js';
import type { OutputSchema } from '../../types.js';
import { localStartLiteral, startLiteral, type Invocation, type Literal } from './literals.js';
import type { DescribeVerdict } from './transitions.js';
import type { DescribeAsk } from './turn.js';

/**
 * The answers a start must carry: the person's yes for `invoke: ask`, the inputs, how many steps run at once, and how
 * optional gates are answered.
 */
export type StartAnswer = 'confirmed' | 'inputs' | 'parallel' | 'hitl';

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
  const lacks = route.missing === 'env'
    ? `needs env ${keys.join(', ')}, which a coding session keeps from its agents`
    : 'runs under a token budget, which no coding session meters for teamai';
  return `Step ${route.held} works in the workspace ${route.opener} opened, and ${lacks}. Only the driver that opened that workspace may go on in it, so the local driver runs the whole of ${name}.`;
}

/** Checks a start of `description` against what describe asked. `ceiling` is the most steps the driver runs at once. */
export function checkStartAnswers(input: {
  description: WorkflowDescription;
  answers: { parallel?: number; confirmed: boolean; hitl?: HitlMode };
  inputs: unknown;
  ceiling: number;
}): StartCheck {
  const { description, answers, inputs, ceiling } = input;
  const given: Record<StartAnswer, boolean> = {
    confirmed: answers.confirmed, inputs: inputs !== undefined, parallel: answers.parallel !== undefined, hitl: answers.hitl !== undefined,
  };
  const missing = neededAnswers(description).filter((answer) => !given[answer]);
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

/** Why this driver is held from step `held`, and what the person does about it. */
function heldFact(held: WorkflowDescription['facts']['held'][number]): string {
  const reasons = held.missing.map((missing) => {
    if (missing === 'env') return `needs env ${listOf(held.env)}, which a coding session keeps from its agents`;
    if (missing === 'tokens') return 'runs under a token budget, which no coding session meters for teamai';
    if (missing.startsWith('policy.')) return `needs ${missing.slice('policy.'.length)}, which workflows.allow in this machine's local config does not allow`;
    return `needs ${missing}, which a coding session does not provide`;
  });
  const after = held.missing.some((missing) => missing.startsWith('policy.'))
    ? 'so no driver on this machine runs it'
    : 'so you finish it in your own terminal with teamai workflow resume once the run reaches it';
  return `${held.step} ${reasons.join(', and ')}, ${after}.`;
}

/** What the person needs to know before `description` runs, a sentence each, in the order a run meets it. */
function factsOf(description: WorkflowDescription, judging: Judging): string[] {
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
    ...(optional.length > 0 ? [`Optional ${gatesNoun(optional, true)}: ${optional.map((gate) => gate.step).join(', ')}.`] : []),
    ...facts.deliver.map(({ step, onto }) => (onto !== undefined ? `It opens a pull request from ${step} onto the pull request of ${onto}.`
      : facts.base !== undefined ? `It opens a pull request from ${step} into ${facts.base}.`
        : `${step} opens a pull request, which needs a branch to target: check out a branch here before you start it.`)),
    ...(missing.length > 0 ? [`${listOf(missing)} ${one ? 'has' : 'have'} no value on this machine: set ${one ? 'it' : 'them'} with ${listOf(missing.map((key) => `teamai env set ${key}`))} before the steps that require ${one ? 'it' : 'them'} run, or those steps fail.`] : []),
    ...facts.held.map(heldFact),
    ...facts.budgets.map(({ step, tokens }) => (step === undefined ? `It may spend at most ${tokens} tokens.` : `${step} may spend at most ${tokens} tokens each time it starts.`)),
    ...(facts.timeout !== undefined ? [`It stops after ${durationOf(facts.timeout)}.`] : []),
    ...(judging.kind === 'here' ? [`${judging.tool} judges ${scored} here, with one confined judge call per pass.`] : []),
    ...(judging.kind === 'elsewhere' ? [`${scored} ${facts.scored.length > 1 ? 'are' : 'is'} not judged on this machine. ${judging.reason}`] : []),
    ...(description.invoke === 'ask' ? ['The team asks that you agree before it starts.'] : []),
  ];
}

/**
 * The starts the question offers: the recommended one, which runs at the full width with the agent deciding optional
 * gates and judging on, then the same start with one answer changed. At most five, whatever the workflow.
 */
function optionsOf(description: WorkflowDescription, judging: Judging, invocation: Invocation): Array<{ label: string; start: Literal }> {
  const { name, facts } = description;
  const needed = neededAnswers(description);
  const flags = { confirmed: needed.includes('confirmed'), inputs: needed.includes('inputs') };
  const noun = gatesNoun(facts.gates.filter((gate) => !gate.required), true);
  const here = judging.kind === 'here';
  const recommended: StartPick = {
    ...(needed.includes('parallel') ? { parallel: facts.width } : {}), ...(needed.includes('hitl') ? { hitl: 'recommend' as const } : {}),
  };
  const others: Array<{ label: string; pick: StartPick }> = [
    ...(recommended.hitl ? [
      { label: `Same, but ask me at optional ${noun}`, pick: { ...recommended, hitl: 'person' as const } },
      { label: `Same, but answer optional ${noun} automatically`, pick: { ...recommended, hitl: 'auto-approve' as const } },
    ] : []),
    ...(recommended.parallel !== undefined ? [{ label: 'Same, but one step at a time', pick: { ...recommended, parallel: 1 } }] : []),
    ...(here ? [{ label: 'Same, but without judging', pick: { ...recommended, noJudge: true as const } }] : []),
  ];
  const parts = [
    ...(recommended.parallel !== undefined ? [`up to ${recommended.parallel} steps at once`] : []),
    ...(recommended.hitl ? [`you decide optional ${noun}`] : []),
    ...(here ? ['with judging'] : []),
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

/**
 * The prompt tool a person's local run must be told: the session's `tool`, when this machine's config names no default
 * prompt tool (`workflows.tools.default`) and the local driver launches `tool`. Undefined when the config names one,
 * or when no tool the local driver launches is known.
 */
export function localPromptTool(config: LocalConfig, tool: ToolName | undefined): LaunchTool | undefined {
  return config.workflows?.tools.default === undefined && tool !== undefined && isLaunchTool(tool) ? tool : undefined;
}

/** The describe reply's `ask` of the kind the transitions chose. `local.tool`: the prompt tool a local start names. */
export function askFor(verdict: DescribeVerdict, description: WorkflowDescription, invocation: Invocation, judging: Judging, local: { tool?: string } = {}): DescribeAsk {
  const { name } = description;
  const facts = factsOf(description, judging).map((fact) => `- ${fact}`);
  switch (verdict.ask) {
    case 'start':
      return { kind: 'start', ...(facts.length > 0 ? { say: facts.join('\n') } : {}), start: startLiteral(invocation, name) };
    case 'local':
    case 'denied':
      return verdict.ask === 'local' ? { kind: 'local', reason: verdict.reason, start: localStartLiteral(invocation, name, local) } : { kind: 'denied', reason: verdict.reason };
    case 'ask': {
      const options = optionsOf(description, judging, invocation);
      const confirmed = description.invoke === 'ask';
      const inputs = Object.entries(description.inputs).map(([input, type]) => ({ name: input, type }));
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
