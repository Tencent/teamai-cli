import { describe, expect, it } from 'vitest';
import {
  evaluateExpression,
  evaluateTemplate,
  extractReferencesFromText,
  parseExpression,
} from '../workflow/expr.js';

describe('workflow expression parser and evaluator', () => {
  it('evaluates boolean literals and operators', () => {
    expect(evaluateExpression('true', {})).toBe(true);
    expect(evaluateExpression('false', {})).toBe(false);
    expect(evaluateExpression('!true', {})).toBe(false);
    expect(evaluateExpression('!false', {})).toBe(true);
    expect(evaluateExpression('true && false', {})).toBe(false);
    expect(evaluateExpression('true || false', {})).toBe(true);
    expect(evaluateExpression('(true || false) && !false', {})).toBe(true);
  });

  it('evaluates equality and relational comparisons', () => {
    expect(evaluateExpression("1 == 1", {})).toBe(true);
    expect(evaluateExpression("1 != 2", {})).toBe(true);
    expect(evaluateExpression("'a' == 'a'", {})).toBe(true);
    expect(evaluateExpression("'a' != 'b'", {})).toBe(true);
    expect(evaluateExpression("10 > 5", {})).toBe(true);
    expect(evaluateExpression("5 <= 5", {})).toBe(true);
    expect(evaluateExpression("3 < 2", {})).toBe(false);
    expect(evaluateExpression("null == null", {})).toBe(true);
  });

  it('evaluates array equality with empty array', () => {
    expect(evaluateExpression("steps.build.branches != []", {
      steps: { build: { branches: ['feat-1'] } },
    })).toBe(true);
    expect(evaluateExpression("steps.build.branches == []", {
      steps: { build: { branches: [] } },
    })).toBe(true);
  });

  it('reads inputs, steps outcomes and nested outputs', () => {
    const ctx = {
      inputs: { issue: 42, label: 'bug' },
      steps: {
        trust: { outcome: 'success', outputs: { trusted: true } },
        classify: { outcome: 'success', outputs: { actionable: true, author: { login: 'alice' } } },
      },
    };

    expect(evaluateExpression('inputs.issue == 42', ctx)).toBe(true);
    expect(evaluateExpression("steps.trust.outcome == 'success'", ctx)).toBe(true);
    expect(evaluateExpression('steps.trust.outputs.trusted && steps.classify.outputs.actionable', ctx)).toBe(true);
    expect(evaluateExpression("steps.classify.outputs.author.login == 'alice'", ctx)).toBe(true);
  });

  it('supports recovery branch condition when dependency failed', () => {
    const ctx = {
      steps: {
        trust: { outcome: 'failed' },
        classify: { status: 'skipped' },
      },
    };
    const expr = "steps.trust.outcome != 'success' || !steps.trust.outputs.trusted || !steps.classify.outputs.actionable";
    expect(evaluateExpression(expr, ctx)).toBe(true);
  });

  it('safely handles undefined and forbidden properties without globals or prototype pollution', () => {
    expect(evaluateExpression('steps.nonexistent.outcome', {})).toBeUndefined();
    expect(evaluateExpression('inputs.__proto__', {})).toBeUndefined();
    expect(evaluateExpression('steps.constructor', {})).toBeUndefined();
    expect(() => parseExpression('process.exit(1)')).toThrow();
  });

  it('evaluates templates and preserves type for single expression', () => {
    const ctx = {
      inputs: { issue: 42, config: { retries: 3 } },
      steps: {
        fetch: { outputs: { title: 'Fix bug' } },
      },
    };

    // Single {{ expr }} preserves type
    expect(evaluateTemplate('{{inputs.issue}}', ctx)).toBe(42);
    expect(evaluateTemplate('{{inputs.config}}', ctx)).toEqual({ retries: 3 });

    // Multi-expression interpolates strings
    expect(evaluateTemplate('Issue #{{inputs.issue}}: {{steps.fetch.outputs.title}}', ctx))
      .toBe('Issue #42: Fix bug');

    // Missing step renders empty string
    expect(evaluateTemplate('Hello {{steps.missing.outputs.text}} World', ctx))
      .toBe('Hello  World');
  });

  it('extracts references to steps and inputs', () => {
    const refs1 = extractReferencesFromText(
      "steps.trust.outputs.trusted && steps.classify.outputs.actionable && inputs.flag"
    );
    expect(refs1.steps.sort()).toEqual(['classify', 'trust']);
    expect(refs1.inputs).toEqual(['flag']);

    const refs2 = extractReferencesFromText(
      "Issue {{inputs.issue}} from {{steps.fetch.outputs.author.login}}"
    );
    expect(refs2.steps).toEqual(['fetch']);
    expect(refs2.inputs).toEqual(['issue']);
  });
});
