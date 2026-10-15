import { describe, expect, it } from 'vitest';
import type { ExpressionContext } from '../workflow/expression.js';
import { findTemplate, parseTemplate, renderText, renderValue, type Template } from '../workflow/template.js';

const context: ExpressionContext = {
  inputs: { issue: 42, title: '$(touch pwned)', draft: false, labels: ['bug', 'p1'], owner: { name: 'ana' }, none: null },
  steps: { plan: { outcome: 'success', outputs: { task: { files: ['a.ts'] }, count: 0 } }, lint: { outcome: 'skipped' } },
};

function template(text: string): Template {
  const parsed = parseTemplate(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.errors[0]?.message}`);
  return parsed.template;
}

describe('workflow templates', () => {
  it.each([
    ['a string as it is', '{{ inputs.title }}', '$(touch pwned)'],
    ['a number as text', 'issue {{inputs.issue}}', 'issue 42'],
    ['a boolean as text', '{{ inputs.draft }}', 'false'],
    ['zero as text', '{{ steps.plan.outputs.count }}', '0'],
    ['an array as JSON', '{{ inputs.labels }}', '["bug","p1"]'],
    ['an object as JSON', '{{ steps.plan.outputs.task }}', '{"files":["a.ts"]}'],
    ['null as empty text', '[{{ inputs.none }}]', '[]'],
    ['a missing path as empty text', '[{{ steps.lint.outputs.report }}]', '[]'],
    ['an outcome', '{{ steps.lint.outcome }}', 'skipped'],
    ['other braces as written', '${{ secrets.TOKEN }} {{ name }} {{ env.HOME }} {{inputs}}', '${{ secrets.TOKEN }} {{ name }} {{ env.HOME }} {{inputs}}'],
  ])('renders %s', (_case, text, rendered) => {
    expect(renderText(template(text), context)).toBe(rendered);
  });

  it.each([
    ['an object', '{{ steps.plan.outputs.task }}', { files: ['a.ts'] }],
    ['a number', '{{inputs.issue}}', 42],
    ['null', '{{ inputs.none }}', null],
    ['text around a path as a string', '#{{ inputs.issue }}', '#42'],
    ['two paths as a string', '{{ inputs.issue }}{{ inputs.draft }}', '42false'],
    ['plain text as it is', 'v1', 'v1'],
  ])('renders a whole value: %s', (_case, text, value) => {
    expect(renderValue(template(text), context)).toEqual(value);
  });

  it.each([
    ['{{ inputs.issue == 1 }}', 'a template reads one path'],
    ['{{ steps.plan }}', '"steps.plan" must read steps.<id>.outcome, steps.<id>.end or steps.<id>.outputs'],
    ['{{ inputs.a b }}', 'unexpected "b"'],
  ])('rejects %s', (text, message) => {
    expect(parseTemplate(`before ${text} after`)).toEqual({ ok: false, errors: [{ source: text, message }] });
  });

  it('finds a template in text that is never rendered', () => {
    expect(findTemplate('echo "{{inputs.title}}" "{{ steps.plan.outputs.task }}"')).toBe('{{inputs.title}}');
    expect(findTemplate('echo "${{ secrets.TOKEN }} {{ name }}"')).toBeUndefined();
  });

  it('finds a ${{ … }} template in a command too, since the command would receive the braces as written', () => {
    expect(findTemplate('echo "${{ inputs.title }}"')).toBe('{{ inputs.title }}');
  });

  it('renders a step\'s own with values, and leaves a template right after a $ as written', () => {
    const withContext = { ...context, with: { task: { title: 'Crash' }, ref: 'main' } };

    expect(renderText(template('{{ with.task.title }} on {{with.ref}}, {{ with.none }}'), withContext)).toBe('Crash on main, ');
    expect(renderValue(template('{{ with.task }}'), withContext)).toEqual({ title: 'Crash' });
    expect(renderText(template('${{ inputs.issue }} ${{with.ref}} $ {{ inputs.issue }}'), withContext)).toBe('${{ inputs.issue }} ${{with.ref}} $ 42');
  });

  it.each([
    ['{{ with.task == 1 }}'],
    ['{{ with. }}'],
  ])('rejects %s as more than one with path', (text) => {
    expect(parseTemplate(text)).toEqual({ ok: false, errors: [{ source: text, message: 'a template reads one path, such as with.<name>' }] });
  });
});
