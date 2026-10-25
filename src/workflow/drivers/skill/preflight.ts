/** Before a run: what describe asks the person, and whether a start carries every answer it needs. */
import type { WorkflowDescription } from '../../describe.js';
import type { Judging } from '../../protocol.js';
import { localStartLiteral, startLiteral, type Invocation } from './literals.js';
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

/**
 * Why `description` must run with the local driver, or undefined when this driver runs it: it has interactive steps,
 * which no person works in through this driver yet, or a local route.
 */
export function localReason(description: WorkflowDescription): string | undefined {
  const { name, facts } = description;
  const route = facts.localRoute;
  if (route) {
    const keys = facts.held.find((held) => held.step === route.held)?.env ?? [];
    const lacks = route.missing === 'env'
      ? `needs env ${keys.join(', ')}, which a coding session keeps from its agents`
      : 'runs under a token budget, which no coding session meters for teamai';
    return `Step ${route.held} works in the workspace ${route.opener} opened, and ${lacks}. Only the driver that opened that workspace may go on in it, so the local driver runs the whole of ${name}.`;
  }
  if (facts.interactive.length > 0) {
    return `${name} has steps this driver does not run in a coding session yet: ${facts.interactive.join(', ')}. The person can run it in a terminal with the local driver.`;
  }
  return undefined;
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

/** What the optional gates of `description` are, by kind, for a label: approvals, choices, or both. */
function optionalGatesNoun(description: WorkflowDescription): string {
  const kinds = new Set(description.facts.gates.filter((gate) => !gate.required).map((gate) => gate.kind));
  return kinds.size > 1 ? 'approvals and choices' : kinds.has('choose') ? 'choices' : 'approvals';
}

/**
 * The describe reply's `ask` of the kind the transitions chose. With `judging` here, each option comes
 * again without judging.
 */
export function askFor(verdict: DescribeVerdict, description: WorkflowDescription, invocation: Invocation, judging: Judging): DescribeAsk {
  const { name, facts } = description;
  switch (verdict.ask) {
    case 'start':
      return { kind: 'start', start: startLiteral(invocation, name) };
    case 'local':
      return { kind: 'local', reason: verdict.reason, start: localStartLiteral(invocation, name) };
    case 'ask': {
      const needed = neededAnswers(description);
      const inputNames = Object.keys(description.inputs);
      const flags = { confirmed: needed.includes('confirmed'), inputs: needed.includes('inputs') };
      const here = judging.kind === 'here';
      const required = facts.gates.filter((gate) => gate.required).map((gate) => gate.step);
      const optional = facts.gates.filter((gate) => !gate.required).map((gate) => gate.step);
      const noun = optionalGatesNoun(description);
      const text = [
        ...(inputNames.length > 0 ? [`${name} needs the input${inputNames.length > 1 ? 's' : ''} ${inputNames.join(', ')}.`] : []),
        ...(needed.includes('parallel') ? [`It can run up to ${facts.width} steps at once.`] : []),
        ...(needed.includes('confirmed') ? ['The team asks that you agree before it starts.'] : []),
        ...(required.length > 0 ? [`Only you can answer the approval${required.length > 1 ? 's' : ''} at ${required.join(', ')}, from your own terminal or teamai dashboard.`] : []),
        ...(needed.includes('hitl') ? [`Optional ${noun}: ${optional.join(', ')}.`] : []),
        ...(here ? [`${judging.tool} judges ${facts.scored.map((scored) => scored.step).join(', ')} here, with one confined judge call per pass.`] : []),
        needed.includes('parallel') ? 'How should it run?' : needed.includes('hitl') ? `How should optional ${noun} be answered?` : 'Start it?',
      ].join(' ');
      const widths: Array<{ label: string; parallel?: number }> = needed.includes('parallel')
        ? [
          { label: `Up to ${facts.width} steps at once`, parallel: facts.width },
          { label: 'One step at a time', parallel: 1 },
        ]
        : [{ label: needed.includes('hitl') ? '' : 'Start it' }];
      const modes: Array<{ label: string; hitl?: HitlMode }> = needed.includes('hitl')
        ? [
          { label: `Ask me at optional ${noun}`, hitl: 'person' },
          { label: `You decide optional ${noun}`, hitl: 'recommend' },
          { label: `Answer optional ${noun} automatically`, hitl: 'auto-approve' },
        ]
        : [{ label: '' }];
      const options = widths.flatMap((width) => modes.map((mode) => ({
        ...width, ...mode, label: [width.label, mode.label].filter((part) => part !== '').join(', '),
      })));
      const starts = options.flatMap(({ label, ...option }) => [
        { label, start: startLiteral(invocation, name, { ...flags, ...option }) },
        ...(here ? [{ label: `${label}, without judging`, start: startLiteral(invocation, name, { ...flags, ...option, noJudge: true }) }] : []),
      ]);
      return { kind: 'ask', question: { text, inputs: Object.entries(description.inputs).map(([input, type]) => ({ name: input, type })), options: starts } };
    }
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}
