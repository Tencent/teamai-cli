import { describe, expect, it } from 'vitest';
import { evaluateExpression, expressionPaths, isTruthy, parseExpression, type ExpressionContext } from '../workflow/expression.js';

const context: ExpressionContext = {
  steps: {
    check: { outcome: 'failed' },
    review: { outcome: 'success', outputs: { verdict: 'fix', count: 0, notes: '', tags: ['a', 'b'], meta: { level: 1, kind: 'x' } } },
    copy: { outcome: 'success', outputs: { tags: ['a', 'b'], reversed: ['b', 'a'], meta: { kind: 'x', level: 1 }, other: { level: 1, kind: 'x', extra: null } } },
  },
};

function evaluate(source: string): unknown {
  const parsed = parseExpression(source);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.message}`);
  return evaluateExpression(parsed.expression, context);
}

describe('workflow expressions', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['null', false],
    ['0', false],
    ["''", false],
    ['1', true],
    ["'no'", true],
    ['[]', true],
    ['steps.review.outputs.meta', true],
    ['steps.review.outputs.count', false],
    ['steps.review.outputs.notes', false],
  ])('treats %s as truthy: %s', (source, truthy) => {
    expect(isTruthy(evaluate(source))).toBe(truthy);
  });

  it.each([
    ["steps.check.outcome == 'failed'", true],
    ["steps.check.outcome != 'failed'", false],
    ["'1' == 1", false],
    ["'Build' == 'build'", false],
    ['0 == false', false],
    ["null == ''", false],
    ['1 == 1.0', true],
    ['steps.review.outputs.meta == steps.copy.outputs.meta', true],
    ['steps.review.outputs.tags == steps.copy.outputs.tags', true],
    ['steps.review.outputs.tags == steps.copy.outputs.reversed', false],
    ['steps.review.outputs.meta == steps.copy.outputs.other', false],
    ['[] == []', true],
    ['steps.review.outputs.tags == []', false],
    ['steps.missing.outcome == null', true],
    ['steps.review.outputs.verdict.deeper == null', true],
    ['steps.review.outputs.tags.length == null', true],
    ['inputs.issue == null', true],
    ['inputs == null', true],
    ["steps.review.end == null", true],
    ['!true', false],
    ['!!steps.review.outputs.meta', true],
    ['!null', true],
    ["true || steps.missing.outcome == 'x'", true],
    ['true && false', false],
    ['false || null', false],
    ['true || false && false', true],
    ['(true || false) && false', false],
    ["!(steps.check.outcome == 'success') && steps.review.outputs.verdict == 'fix'", true],
  ])('evaluates %s to %s', (source, expected) => {
    expect(evaluate(source)).toBe(expected);
  });

  it.each([
    ['', 1, 'expected a value, found the end of the expression'],
    ["steps.check.outcome == ", 24, 'expected a value, found the end of the expression'],
    ["steps.check.outcome = 'failed'", 21, 'unexpected "="'],
    ["steps.check.outcome == 'failed", 24, "a string is not closed with '"],
    ['steps.check.outcome == "failed"', 24, "strings use single quotes, as in 'failed'"],
    ['(true', 6, 'expected ")", found the end of the expression'],
    ['true false', 6, 'unexpected "false"'],
    ["1 == 1 == 1", 8, 'unexpected "=="'],
    ["['a']", 2, 'the only array literal is []'],
    ['env.HOME', 1, '"env" is not readable; an expression reads only inputs and steps'],
    ['github.ref', 1, '"github" is not readable; an expression reads only inputs and steps'],
    ["contains(steps.review.outputs.tags, 'a')", 1, '"contains" is not readable; an expression reads only inputs and steps'],
    ['process.env.SECRET', 1, '"process" is not readable; an expression reads only inputs and steps'],
    ['steps.check', 1, '"steps.check" must read steps.<id>.outcome, steps.<id>.end or steps.<id>.outputs'],
    ['steps.check.status', 1, '"steps.check.status" must read steps.<id>.outcome, steps.<id>.end or steps.<id>.outputs'],
    ['steps.check.outcome.text', 1, '"steps.check.outcome.text" must read steps.<id>.outcome, steps.<id>.end or steps.<id>.outputs'],
    ['inputs.', 7, 'unexpected "."'],
  ])('rejects %j at column %i', (source, column, message) => {
    expect(parseExpression(source)).toEqual({ ok: false, column, message });
  });

  it('lists the paths an expression reads, with their columns', () => {
    const parsed = parseExpression("inputs.issue.number == 1 || !(steps.check.outcome == 'failed' && steps.review.outputs.verdict.text)");
    if (!parsed.ok) throw new Error(parsed.message);

    expect(expressionPaths(parsed.expression)).toEqual([
      { root: 'inputs', fields: ['issue', 'number'], column: 1 },
      { root: 'steps', step: 'check', field: 'outcome', fields: [], column: 31 },
      { root: 'steps', step: 'review', field: 'outputs', fields: ['verdict', 'text'], column: 66 },
    ]);
  });
});
