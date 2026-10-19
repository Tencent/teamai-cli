import { describe, expect, it } from 'vitest';
import { evaluateExpression, expressionPaths, isTruthy, parseExpression, type ExpressionContext } from '../workflow/expression.js';

const context: ExpressionContext = {
  steps: {
    check: { outcome: 'failed' },
    review: {
      outcome: 'success',
      outputs: { verdict: 'fix', count: 0, notes: '', tags: ['a', 'b'], meta: { level: 1, kind: 'x' }, matrix: [[1, 2], [3, 4]], files: [{ path: 'a.ts' }] },
    },
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
    ["steps.review.outputs.tags[1] == 'b'", true],
    ['steps.review.outputs.tags[2] == null', true],
    ['steps.review.outputs.verdict[0] == null', true],
    ['steps.review.outputs.meta[0] == null', true],
    ['steps.review.outputs.matrix[1][0] == 3', true],
    ["steps.review.outputs.files[0].path == 'a.ts'", true],
    ['steps.review.outputs.count < 1', true],
    ['steps.review.outputs.count <= 0', true],
    ['steps.review.outputs.count > 0', false],
    ['steps.review.outputs.count >= 0', true],
    ['1.5 > 1', true],
    ['steps.review.outputs.verdict < 1', false],
    ['steps.review.outputs.verdict >= 1', false],
    ['inputs.missing < 1', false],
    ['1 < 2 == true', true],
    ["!steps.check.outcome == 'success'", true],
    ['length(steps.review.outputs.tags) == 2', true],
    ["any(steps.review.outputs.files, .path == 'a.ts')", true],
    ["all(steps.review.outputs.tags, . != 'c')", true],
    ["filter(steps.review.outputs.tags, . == 'z') == []", true],
    ["length(filter(steps.review.outputs.tags, . != 'a')) == 1", true],
    ['any([], . == 1)', false],
    ['all([], . == 1)', true],
    ['filter([], true) == []', true],
    ['filter(steps.review.outputs.tags, 1) == steps.copy.outputs.tags', true],
    ['length(steps.review.outputs.verdict) == null', true],
    ['any(steps.review.outputs.meta, true) == null', true],
    ['all(inputs.missing, true) == null', true],
    ['filter(steps.review.outputs.count, true) == null', true],
    ['any(steps.review.outputs.matrix, any(., . == 4))', true],
    ['all(steps.review.outputs.matrix, length(.) == 2)', true],
    ['any(steps.review.outputs.matrix, .[1] == 4)', true],
    ['any(steps.review.outputs.tags, . == steps.copy.outputs.tags[1])', true],
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
    ['1 < 2 < 3', 7, 'unexpected "<"'],
    ["steps.review.outputs.count < '3'", 30, "compares '3' with <, but it is not a number"],
    ['inputs.n > null', 12, 'compares null with >, but it is not a number'],
    ['true >= 1', 1, 'compares true with >=, but it is not a number'],
    ["'it''s' < 3", 1, "compares 'it''s' with <, but it is not a number"],
    ["true 'it''s'", 6, "unexpected 'it''s'"],
    ['inputs.n < .5', 12, 'numbers need a leading digit, as in 0.5'],
    ['any(inputs.xs, . < .5)', 20, 'numbers need a leading digit, as in 0.5'],
    ['all(inputs.xs, any(.ys, . == .25))', 30, 'numbers need a leading digit, as in 0.5'],
    ["['a']", 2, 'the only array literal is []'],
    ['env.HOME', 1, '"env" is not readable; an expression reads only inputs, steps and item'],
    ['github.ref', 1, '"github" is not readable; an expression reads only inputs, steps and item'],
    ["contains(steps.review.outputs.tags, 'a')", 1, '"contains" is not a function; the functions are length, any, all and filter'],
    ['inputs.list(1)', 12, 'unexpected "("'],
    ['any(steps.review.outputs.tags, true) < 1', 1, 'compares any(...) with <, but it is not a number'],
    ['filter(steps.review.outputs.tags, true) > 0', 1, 'compares filter(...) with >, but it is not a number'],
    ['(1 == 1) < 2', 4, 'compares a condition with <, but it is not a number'],
    ["length('abc') == 3", 8, "passes 'abc' to length as its list, but it is not an array"],
    ['any(length(steps.review.outputs.tags), true)', 5, 'passes length(...) to any as its list, but it is not an array'],
    ['all(null, true)', 5, 'passes null to all as its list, but it is not an array'],
    ['length(steps.review.outputs.tags, 1)', 1, 'length is called as length(list)'],
    ['length()', 1, 'length is called as length(list)'],
    ['any(steps.review.outputs.tags)', 1, 'any is called as any(list, predicate)'],
    ['all(steps.review.outputs.tags, true, false)', 1, 'all is called as all(list, predicate)'],
    [".path == 'a.ts'", 1, '".path" reads the current element, which exists only inside the predicate of any, all or filter'],
    ['length(.) == 1', 8, '"." reads the current element, which exists only inside the predicate of any, all or filter'],
    ['process.env.SECRET', 1, '"process" is not readable; an expression reads only inputs, steps and item'],
    ['steps.check', 1, '"steps.check" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches'],
    ['steps.check.status', 1, '"steps.check.status" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches'],
    ['steps.check.outcome.text', 1, '"steps.check.outcome.text" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches'],
    ['inputs.', 7, 'unexpected "."'],
    ['inputs.tags[-1]', 12, '"[-1]" is not an index; write a whole number from 0, such as [0]'],
    ['inputs.tags[inputs.n] == 1', 12, '"[inputs.n]" is not an index; write a whole number from 0, such as [0]'],
    ['inputs.tags[01]', 12, '"[01]" is not an index; write a whole number from 0, such as [0]'],
    ['inputs.tags[0', 12, 'an index is not closed with ]'],
    ['steps.check.outcome[0]', 1, '"steps.check.outcome[0]" indexes outcome, which is a name; compare it whole, as in steps.check.outcome == \'<name>\''],
    ['steps.check.end[0]', 1, '"steps.check.end[0]" indexes end, which is a name; compare it whole, as in steps.check.end == \'<name>\''],
    ['steps.build[2].outcome', 1, '"steps.build[2].outcome" indexes a step; an index reads an array in its outputs, as in steps.build.outputs.<field>[2]'],
  ])('rejects %j at column %i', (source, column, message) => {
    expect(parseExpression(source)).toEqual({ ok: false, column, message });
  });

  it('reads a digit-named field below the element, which only a lone .<digits> cannot be', () => {
    const parsed = parseExpression('any(inputs.xs, .5.x == 1 || .a.5 == 1)');
    if (!parsed.ok) throw new Error(parsed.message);

    expect(evaluateExpression(parsed.expression, { inputs: { xs: [{ 5: { x: 1 } }] }, steps: {} })).toBe(true);
  });

  it('compares values nested 4,000 levels deep without overflowing the stack', () => {
    const nested = (bottom: unknown): unknown => {
      let value = bottom;
      for (let level = 0; level < 4000; level += 1) value = level % 2 === 0 ? [value] : { a: value };
      return value;
    };
    const parsed = parseExpression('inputs.a == inputs.b && inputs.a != inputs.c');
    if (!parsed.ok) throw new Error(parsed.message);

    expect(evaluateExpression(parsed.expression, { inputs: { a: nested(1), b: nested(1), c: nested(2) }, steps: {} })).toBe(true);
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

  it('lists the paths inside list arguments and predicates, and no relative path', () => {
    const parsed = parseExpression("any(steps.review.outputs.files, .path == inputs.file) && length(steps.copy.outputs.tags) > 0");
    if (!parsed.ok) throw new Error(parsed.message);

    expect(expressionPaths(parsed.expression)).toEqual([
      { root: 'steps', step: 'review', field: 'outputs', fields: ['files'], column: 5 },
      { root: 'inputs', fields: ['file'], column: 42 },
      { root: 'steps', step: 'copy', field: 'outputs', fields: ['tags'], column: 65 },
    ]);
  });

  it('lists an index as a number among the fields a path reads', () => {
    const parsed = parseExpression('steps.review.outputs.matrix[0][1] == inputs.tags[2]');
    if (!parsed.ok) throw new Error(parsed.message);

    expect(expressionPaths(parsed.expression)).toEqual([
      { root: 'steps', step: 'review', field: 'outputs', fields: ['matrix', 0, 1], column: 1 },
      { root: 'inputs', fields: ['tags', 2], column: 38 },
    ]);
  });

  it.each([
    ["steps.loop.passes[0].outputs.verdict == 'fix'", true],
    ["steps.loop.passes[1].outcome == 'success'", true],
    ['length(steps.loop.passes) == 2', true],
    ["any(steps.loop.passes, .outputs.verdict == 'pass')", true],
    ['steps.loop.passes[2] == null', true],
    ['steps.check.passes == null', true],
  ])('reads the passes of a step: %s is %s', (source, value) => {
    const parsed = parseExpression(source);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(evaluateExpression(parsed.expression, { steps: { ...context.steps, loop: { passes: [
      { pass: 1, outcome: 'success', outputs: { verdict: 'fix' } },
      { pass: 2, outcome: 'success', outputs: { verdict: 'pass' } },
    ] } } })).toBe(value);
  });
});
