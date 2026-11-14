/** Before a run: what describe asks the person, and whether a start carries every answer it needs. */
import { isLaunchTool, LAUNCH_ORDER } from '../../../tool-launch/tools.js';
import { baseToolOf, TOOL_ORDER } from '../../../tool-registry.js';
import type { LocalConfig } from '../../../types.js';
import type { GateGuards, WorkflowDescription } from '../../describe.js';
import { INVOKE_ASK_NEED, unattendedReason, verifiedLeftOpen, type Judging } from '../../protocol.js';
import { onlyPersonAnswers } from '../../types.js';
import { envAdvice } from '../../requirements.js';
import type { OutputSchema } from '../../types.js';
import { describeLiteral, localStartLiteral, startLiteral, type Invocation, type Literal } from './literals.js';
import { judgedBy, type DescribeVerdict } from './transitions.js';
import type { DescribeAsk, DescribedInput } from './turn.js';

/**
 * The answers a start must carry: the person's yes for `invoke: ask`, the inputs, how many steps run at once, how
 * optional gates are answered, and the tool of a session whose host names none (`needsTool`).
 */
export type StartAnswer = 'confirmed' | 'inputs' | 'parallel' | 'hitl' | 'tool';

/**
 * Whether a session working in `tool` must name it before it runs `description`: it names none, and a step's model
 * needs one, or a scored step does when the run is `judged`.
 */
export function needsTool(description: WorkflowDescription, input: { tool: string | undefined; judged: boolean }): boolean {
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

/**
 * Why `description` must run with the local driver, or undefined when this driver runs it: its steps that run as a team
 * role, its benchmark trials, or its local route.
 */
export function localReason(description: WorkflowDescription): string | undefined {
  const { name, facts } = description;

  if (facts.held.some((held) => held.missing.includes('role'))) {
    return `${name} runs steps as a team role, which only a driver that declares can.role runs, as teamai must deliver the role into the copy each such step works in, and this driver does not. Start it with --driver local.`;
  }

  if (facts.held.some((held) => held.missing.includes('prepare'))) {
    return `${name} is a benchmark, whose trials run only on a driver that declares a sandbox, and this driver does not. Add --sandbox on a machine that is one.`;
  }

  const route = facts.localRoute;

  if (!route) return undefined;
  const keys = facts.held.find((held) => held.step === route.held)?.env ?? [];
  const lacks = missingReason(route.missing, keys);

  switch (route.copy) {
    case 'run': return `Step ${route.held} works in the workspace the run opens, as the header of ${name} says workspace: new, and ${lacks}. Only the driver that opened that workspace may go on in it, so the local driver runs the whole of ${name}.`;
    case 'step': return `Step ${route.held} works in the workspace ${route.opener} opened, and ${lacks}. Only the driver that opened that workspace may go on in it, so the local driver runs the whole of ${name}.`;
    default: {
      const unhandled: never = route;

      return unhandled;
    }
  }
}

/**
 * Why a run of `description` needs a person before it starts or goes on, which an unattended run lacks, as a refusal to
 * `act` on it says it: its `invoke: ask`. A step only a person can take needs none here: the session hands the run to
 * one when it reaches that step.
 */
export function attendedReason(description: WorkflowDescription, act: 'start' | 'continue'): string | undefined {
  return description.invoke === 'ask' ? unattendedReason(description.name, INVOKE_ASK_NEED, act) : undefined;
}

/** What needs a person, a clause each: the `interactive` steps, and the `gates` only a person can answer. */
export function personClauses({ interactive, gates }: { interactive: readonly string[]; gates: ReadonlyArray<{ step: string; kind: 'approve' | 'choose' }> }): string[] {
  return [
    ...(interactive.length > 0 ? [`${listOf(interactive)} ${interactive.length > 1 ? 'are' : 'is'} interactive, worked with a person`] : []),
    ...(gates.length > 0 ? [`only a person can answer the ${gatesNoun(gates)} at ${listOf(gates.map((gate) => gate.step))}`] : []),
  ];
}

/**
 * Whether step `step`, by its definition path, is left to run in a run whose steps `settled` for good. `a.b.c` is settled
 * when `a`, `a.b` or `a.b.c` is: a workflow's steps exist in the run only once it starts, and an item's path (`a[0].b`)
 * is not the definition's (`a.b`).
 */
export function isLeft(step: string, settled: ReadonlySet<string>): boolean {
  return !step.split('.').some((_, at, segments) => settled.has(segments.slice(0, at + 1).join('.')));
}

/** Checks a start of `description` against what describe asked. `ceiling` is the most steps the driver runs at once. */
export function checkStartAnswers(input: {
  description: WorkflowDescription;
  answers: { parallel?: number; confirmed: boolean; hitl?: HitlMode; judge?: false };
  inputs: unknown;
  ceiling: number;
  tool: string | undefined;
}): StartCheck {
  const { description, answers, inputs, ceiling } = input;

  const given: Record<StartAnswer, boolean> = {
    confirmed: answers.confirmed, inputs: inputs !== undefined, parallel: answers.parallel !== undefined, hitl: answers.hitl !== undefined, tool: input.tool !== undefined,
  };

  const missing = [...neededAnswers(description), ...(needsTool(description, { tool: input.tool, judged: answers.judge !== false }) ? ['tool' as const] : [])].filter((answer) => !given[answer]);
  const outOfRange = answers.parallel !== undefined && answers.parallel > ceiling ? { parallel: answers.parallel, ceiling } : undefined;

  if (missing.length > 0 || outOfRange) {
    const check: StartCheck = { kind: 'confirm-needed', missing };

    if (outOfRange) check.outOfRange = outOfRange;

    return check;
  }

  return { kind: 'ok', parallel: answers.parallel ?? 1, hitl: answers.hitl ?? 'person' };
}

/** `items` as an English list: `a`, `a and b`, `a, b and c`. */
export function listOf(items: readonly string[]): string {
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
    case 'json':
    case 'workflow':
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
  const attended = answering === 'picked';
  const people = attended ? [] : personClauses({ interactive, gates: facts.gates.filter((gate) => onlyPersonAnswers(gate, { autoApprove: true })) });
  const confined = listOf(facts.confined);
  // A run with both says why judging is not here once, on the scored line.
  const [isScored, isConfined, oneConfined] = [facts.scored.length > 0, facts.confined.length > 0, facts.confined.length === 1];

  return [
    ...(named.length > 0 ? [`${name} needs the input${named.length > 1 ? 's' : ''} ${listOf(named)}.`] : []),
    ...(facts.width > 1 ? [`It can run up to ${facts.width} steps at once.`] : []),
    ...(attended && interactive.length > 0 ? [`${listOf(interactive)} ${many ? 'are' : 'is'} interactive: you work in ${many ? 'them' : 'it'} here, with this session's agent.`] : []),
    ...(attended && required.length > 0 ? [`Only you can answer the ${gatesNoun(required)} at ${listOf(required.map((gate) => gate.step))}, from your own terminal or teamai dashboard.`] : []),
    ...optional.map(optionalGateFact),
    ...(optional.length > 0 ? [optionalAnswersFact(optional, answering)] : []),
    ...(people.length > 0 ? [`Nobody attends this run, so when it reaches a step only a person can take, it is offered on teamai-reports for one to continue, and this session stops: ${people.join('; ')}.`] : []),
    ...facts.deliver.map(({ step, onto }) => (onto !== undefined ? `It opens a pull request from ${step} onto the pull request of ${onto}.`
      : facts.base !== undefined ? `It opens a pull request from ${step} into ${facts.base}.`
        : `${step} opens a pull request, which needs a branch to target: check out a branch here before you start it.`)),
    ...(missing.length > 0 ? [`${listOf(missing)} ${one ? 'has' : 'have'} no value on this machine: ${envAdvice(missing, new Set(facts.requiresEnv.declaredHere))} before the steps that require ${one ? 'it' : 'them'} run, or those steps fail.`] : []),
    ...facts.held.map(heldFact),
    ...facts.budgets.map(({ step, tokens }) => (step === undefined ? `It may spend at most ${tokens} tokens.` : `${step} may spend at most ${tokens} tokens each time it starts.`)),
    ...(facts.timeout !== undefined ? [`It stops after ${durationOf(facts.timeout)}.`] : []),
    ...(judging.kind === 'here' && isScored ? [`${judging.tool} judges ${scored} here, with one confined judge call per pass.`] : []),
    ...(judging.kind === 'session' && isScored ? [`${scored} ${facts.scored.length > 1 ? 'are' : 'is'} judged by this session in a subagent once the run is done, at best-effort isolation. ${judging.reason}`] : []),
    ...(judging.kind === 'session' && judging.verified ? [verifiedLeftOpen(judging.verified)] : []),
    ...(judging.kind === 'elsewhere' && isScored ? [`${scored} ${facts.scored.length > 1 ? 'are' : 'is'} not judged on this machine. ${judging.reason}`] : []),
    ...(judging.kind === 'here' && isConfined ? [`${judging.tool} runs ${confined} here, confined to the directory ${oneConfined ? 'it answers' : 'each answers'} from.`] : []),
    ...(judging.kind === 'session' && isConfined ? [`A fresh subagent of this session runs ${confined}, reading only ${oneConfined ? 'its' : 'each one\'s'} directory, at best-effort isolation, unless ${oneConfined ? 'it asks' : 'one asks'} for verified isolation, which another driver runs.${isScored ? '' : ` ${judging.reason}`}`] : []),
    ...(judging.kind === 'elsewhere' && isConfined ? [`${confined} ${oneConfined ? 'does' : 'do'} not run on this machine.${isScored ? '' : ` ${judging.reason}`}`] : []),
    ...(description.invoke === 'ask' ? ['The team asks that you agree before it starts.'] : []),
  ];
}

/**
 * The starts the question offers: the recommended one, which runs at the full width with the agent deciding optional
 * gates and judging on, then the same start with one answer changed. At most five, whatever the workflow.
 */
function optionsOf(description: WorkflowDescription, judging: Judging, invocation: Invocation, tool: string | undefined): Array<{ label: string; start: Literal }> {
  const { name, facts } = description;
  const flags = { ...startFlags(description), tool };
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
function startFlags(description: WorkflowDescription) {
  const needed = neededAnswers(description);

  return { confirmed: needed.includes('confirmed'), inputs: needed.includes('inputs') };
}

/** The answers of the recommended start: every step it can run at once, and the agent deciding optional gates. */
function recommendedPick(description: WorkflowDescription): StartPick {
  const needed = neededAnswers(description);

  const pick: StartPick = {};

  if (needed.includes('parallel')) pick.parallel = description.facts.width;

  if (needed.includes('hitl')) pick.hitl = 'recommend';

  return pick;
}

/** The inputs of `description`, as describe lists them for its `{inputs}` slot, each with what `proposed` holds for it. */
function inputsOf(description: WorkflowDescription, proposed: Proposed): DescribedInput[] {
  return Object.entries(description.inputs).map(([input, type]) => ({ name: input, type, ...proposed[input] }));
}

/** The value and why describe proposes, by input; an input it proposes nothing for is absent. */
export type Proposed = Readonly<Record<string, { value?: unknown; why: string }>>;

/**
 * The prompt tool a person's local run must be told: the session's `tool`, when nothing on this machine picks the tool
 * prompt steps run on and the local driver launches `tool`. `workflows.tools.default` picks one, and so does each of
 * `aiTools`, the tools the member names, unless it names a tool teamai calls but runs no steps on, which the step passes
 * over. Undefined when one of those picks a tool, or when no tool the local driver launches is known.
 */
export function localPromptTool({ config, tool, aiTools }: { config: LocalConfig; tool: string | undefined; aiTools: readonly string[] }): string | undefined {
  const picks = (named: string) => isLaunchTool(named) || !LAUNCH_ORDER.some((launched) => launched === named);
  const picked = !!config.workflows?.tools.default || aiTools.some(picks);

  return !picked && tool !== undefined && isLaunchTool(baseToolOf(tool)) ? tool : undefined;
}

/**
 * The describe reply's `ask` of the kind the transitions chose. `tools.local`: the prompt tool a local start names.
 * `tools.session`: the tool the session declared, which every skill start it offers keeps. `proposed`: the value and why
 * describe proposes for each input it has one for.
 */
export function askFor(verdict: DescribeVerdict, description: WorkflowDescription, invocation: Invocation, judging: Judging, tools: { local?: string; session?: string }, proposed: Proposed): DescribeAsk {
  const { name } = description;
  const session = tools.session !== undefined ? { tool: tools.session } : {};
  const facts = factsOf(description, judging, verdict.ask === 'unattended' ? 'auto-approve' : 'picked').map((fact) => `- ${fact}`);

  switch (verdict.ask) {
    case 'start':
      return startAsk(facts, startLiteral(invocation, name, session), []);
    case 'unattended': {
      const inputs = inputsOf(description, proposed);
      const start = startLiteral(invocation, name, { ...startFlags(description), ...recommendedPick(description), hitl: 'auto-approve', ...session });

      return startAsk(facts, start, inputs);
    }

    case 'tool':
      return {
        kind: 'tool', reason: 'This coding session names no tool, which the run needs for the models of its steps or its judging.', describe: describeLiteral(invocation, name, { tool: '{tool}' }), tools: [...TOOL_ORDER],
      };
    case 'local':
    case 'denied':
      return verdict.ask === 'local' ? { kind: 'local', reason: verdict.reason, start: localStartLiteral(invocation, name, { tool: tools.local }) } : { kind: 'denied', reason: verdict.reason };
    case 'ask': {
      const options = optionsOf(description, judging, invocation, tools.session);
      const confirmed = description.invoke === 'ask';
      const inputs = inputsOf(description, proposed);

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

/** The `start` ask: the facts to say before it, when there are any, and the inputs its `{inputs}` slot lists, when it has one. */
function startAsk(facts: string[], start: Literal, inputs: DescribedInput[]): DescribeAsk {
  const ask: DescribeAsk = { kind: 'start', start };

  if (facts.length > 0) ask.say = facts.join('\n');

  if (inputs.length > 0) ask.inputs = inputs;

  return ask;
}

/** The most steps the skill driver runs at once when the member set no `workflows.max_parallel`. */
const SKILL_MAX_CHILDREN = 3;

/** The most steps the skill driver runs at once for `config`. */
export function ceilingOf(config: LocalConfig): number {
  return config.workflows?.max_parallel ?? SKILL_MAX_CHILDREN;
}
