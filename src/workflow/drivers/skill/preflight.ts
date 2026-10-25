/** Before a run: what describe asks the person, and whether a start carries every answer it needs. */
import type { WorkflowDescription } from '../../describe.js';
import type { Judging } from '../../protocol.js';
import { localStartLiteral, startLiteral, type Invocation } from './literals.js';
import type { DescribeAsk } from './turn.js';

/** The answers a start must carry: the person's yes for `invoke: ask`, the inputs, and how many steps run at once. */
export type StartAnswer = 'confirmed' | 'inputs' | 'parallel';

export type StartCheck =
  | { kind: 'ok'; parallel: number }
  | { kind: 'confirm-needed'; missing: StartAnswer[]; outOfRange?: { parallel: number; ceiling: number } };

/** The answers a start of `description` needs before it can run. */
export function neededAnswers(description: WorkflowDescription): StartAnswer[] {
  return [
    ...(description.invoke === 'ask' ? ['confirmed' as const] : []),
    ...(Object.keys(description.inputs).length > 0 ? ['inputs' as const] : []),
    ...(description.facts.width > 1 ? ['parallel' as const] : []),
  ];
}

/** Steps this driver does not run, by path: interactive steps, which no person answers through it. */
export function localOnlySteps(description: WorkflowDescription): string[] {
  return description.facts.interactive;
}

/** Checks a start of `description` against what describe asked. `ceiling` is the most steps the driver runs at once. */
export function checkStartAnswers(input: {
  description: WorkflowDescription;
  answers: { parallel?: number; confirmed: boolean };
  inputs: unknown;
  ceiling: number;
}): StartCheck {
  const { description, answers, inputs, ceiling } = input;
  const given: Record<StartAnswer, boolean> = { confirmed: answers.confirmed, inputs: inputs !== undefined, parallel: answers.parallel !== undefined };
  const missing = neededAnswers(description).filter((answer) => !given[answer]);
  const outOfRange = answers.parallel !== undefined && answers.parallel > ceiling ? { parallel: answers.parallel, ceiling } : undefined;
  if (missing.length > 0 || outOfRange) return { kind: 'confirm-needed', missing, ...(outOfRange ? { outOfRange } : {}) };
  return { kind: 'ok', parallel: answers.parallel ?? 1 };
}

/**
 * The describe reply's `ask` of kind `kind`, the one the transitions chose. With `judging` here, each option comes
 * again without judging.
 */
export function askFor(kind: DescribeAsk['kind'], description: WorkflowDescription, invocation: Invocation, judging: Judging): DescribeAsk {
  const { name, facts } = description;
  switch (kind) {
    case 'start':
      return { kind, start: startLiteral(invocation, name) };
    case 'local': {
      const steps = localOnlySteps(description).join(', ');
      return {
        kind,
        reason: `${name} has steps this driver does not run in a coding session yet: ${steps}. The person can run it in a terminal with the local driver.`,
        start: localStartLiteral(invocation, name),
      };
    }
    case 'ask': {
      const needed = neededAnswers(description);
      const inputNames = Object.keys(description.inputs);
      const flags = { confirmed: needed.includes('confirmed'), inputs: needed.includes('inputs') };
      const here = judging.kind === 'here';
      const text = [
        ...(inputNames.length > 0 ? [`${name} needs the input${inputNames.length > 1 ? 's' : ''} ${inputNames.join(', ')}.`] : []),
        ...(needed.includes('parallel') ? [`It can run up to ${facts.width} steps at once.`] : []),
        ...(needed.includes('confirmed') ? ['The team asks that you agree before it starts.'] : []),
        ...(here ? [`${judging.tool} judges ${facts.scored.map((scored) => scored.step).join(', ')} here, with one confined judge call per pass.`] : []),
        needed.includes('parallel') ? 'How should it run?' : 'Start it?',
      ].join(' ');
      const options = needed.includes('parallel')
        ? [
          { label: `Up to ${facts.width} steps at once`, parallel: facts.width },
          { label: 'One step at a time', parallel: 1 },
        ]
        : [{ label: 'Start it' }];
      const starts = options.flatMap(({ label, ...option }) => [
        { label, start: startLiteral(invocation, name, { ...flags, ...option }) },
        ...(here ? [{ label: `${label}, without judging`, start: startLiteral(invocation, name, { ...flags, ...option, noJudge: true }) }] : []),
      ]);
      return { kind, question: { text, inputs: Object.entries(description.inputs).map(([input, type]) => ({ name: input, type })), options: starts } };
    }
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}
