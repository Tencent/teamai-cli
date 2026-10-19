import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseExpression, type ExpressionContext } from '../workflow/expression.js';
import { findTemplate, parseTemplate, renderText, renderValue, type Template } from '../workflow/template.js';

const context: ExpressionContext = {
  inputs: { issue: 42, title: '$(touch pwned)', draft: false, labels: ['bug', 'p1'], owner: { name: 'ana' }, none: null },
  steps: { plan: { outcome: 'success', outputs: { task: { files: ['a.ts'] }, count: 0 } }, lint: { outcome: 'skipped' } },
};

const WITH = 'with is read only as one path, such as with.<name>; an expression reads only inputs, steps and item';
const DEEP = 'an expression nests at most 100 levels deep, counting each "(", "!", call, && and ||';

/** mulberry32: a seeded generator, so a failing case reruns from its seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPENERS = [['(', ')'], ['!', ''], ['any(steps.build.results, ', ')'], ['all(inputs.labels, ', ')'], ['filter(item.xs, ', ')']] as const;
const VALUES = ["steps.build.outcome == 'it''s'", 'inputs.labels[0]', 'item.xs[0].ok[0]', 'length(inputs.labels) < 2', 'null', '[]', 'true'];
const JOINS = [' && ', ' || '];
const STRAYS = ['.ok[0]', ')', '(', '!', '[0]', '}}', '{{ ', "'", "'}}'", '"', '.5', ', ', 'length('];

/**
 * About `tokens` tokens: an expression that parses, nested in calls, "(" and "!", and chained with && and ||. A quarter
 * stay whole, and the rest get stray tokens, are cut short, or open thousands of levels before the expression.
 */
function generated(seed: number, tokens: number): string {
  const next = seeded(seed);
  const below = (limit: number): number => Math.floor(next() * limit);
  const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;
  const width = Math.ceil(Math.cbrt(tokens / 4));
  const chain = (part: () => string[]): string[] => [part(), ...Array.from({ length: below(width) }, () => [pick(JOINS), ...part()])].flat();
  const group = (): string[] => {
    const openers = Array.from({ length: below(width) }, () => pick(OPENERS));
    return [...openers.map(([open]) => open), ...chain(() => [pick(VALUES)]), ...openers.reverse().map(([, close]) => close)];
  };
  const parts = chain(() => ['(', ...chain(group), ')']);
  switch (below(4)) {
    case 1:
      for (let count = 1 + below(3); count > 0; count -= 1) parts.splice(below(parts.length + 1), 0, pick(STRAYS));
      break;
    case 2:
      parts.length = below(parts.length);
      break;
    case 3:
      parts.unshift(...Array.from({ length: below(tokens) }, () => pick(OPENERS)[0]));
      break;
  }
  return parts.join('');
}

function template(text: string, item = false): Template {
  const parsed = parseTemplate(text, item);
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
    ['an array element', '{{ inputs.labels[1] }} {{ steps.plan.outputs.task.files[0] }}', 'p1 a.ts'],
    ['other braces as written', '${{ secrets.TOKEN }} {{ name }} {{ env.HOME }} {{inputs}}', '${{ secrets.TOKEN }} {{ name }} {{ env.HOME }} {{inputs}}'],
  ])('renders %s', (_case, text, rendered) => {
    expect(renderText(template(text), context)).toBe(rendered);
  });

  it.each([
    ['a count', '{{ length(inputs.labels) }}', '2'],
    ['a filtered list', "{{ filter(inputs.labels, . == 'p1') }}", '["p1"]'],
    ['a check on a list', "{{ any(inputs.labels, . == 'bug') }} {{ all(inputs.labels, . == 'bug') }}", 'true false'],
    ['a compared count', '{{ length(inputs.labels) > 3 }}', 'false'],
    ['a comparison that starts with a path', '{{ inputs.issue == 42 }} {{ inputs.issue < 1 }}', 'true false'],
    ['an outcome compared', "{{ steps.lint.outcome == 'skipped' }}", 'true'],
    ['a negated call', "{{ !any(inputs.labels, . == 'bug') }}", 'false'],
    ['a call in parentheses', '{{ (length(inputs.labels)) }}', '2'],
    ['a call after &&', "{{ true && any(inputs.labels, . == 'p1') }}", 'true'],
    ['a call with a brace in its arguments', "{{ filter(inputs.labels, . == '}') }}", '[]'],
    ['a nested call', "{{ length(filter(inputs.labels, . != 'bug')) }}", '1'],
    ['a call on a missing list as empty text, the null it is in an if', '[{{ length(steps.lint.results) }}] [{{ filter(steps.lint.results, .ok) }}]', '[] []'],
    ['a missing list compared as false, as in an if', '{{ length(steps.lint.results) > 0 }}', 'false'],
  ])('evaluates %s', (_case, text, rendered) => {
    expect(renderText(template(text), context)).toBe(rendered);
  });

  it.each([
    ['an object', '{{ steps.plan.outputs.task }}', { files: ['a.ts'] }],
    ['a number', '{{inputs.issue}}', 42],
    ['null', '{{ inputs.none }}', null],
    ['text around a path as a string', '#{{ inputs.issue }}', '#42'],
    ['two paths as a string', '{{ inputs.issue }}{{ inputs.draft }}', '42false'],
    ['plain text as it is', 'v1', 'v1'],
    ['a filtered list as an array', "{{ filter(inputs.labels, . == 'p1') }}", ['p1']],
    ['a count as a number', '{{ length(inputs.labels) }}', 2],
    ['a check as a boolean', "{{ any(inputs.labels, . == 'bug') }}", true],
    ['text around an expression as a string', 'n={{ length(inputs.labels) }}', 'n=2'],
  ])('renders a whole value: %s', (_case, text, value) => {
    expect(renderValue(template(text), context)).toEqual(value);
  });

  it.each([
    ['{{ steps.plan }}', '"steps.plan" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches'],
    ['{{ inputs.a b }}', 'unexpected "b"'],
    ['{{ inputs.labels[-1] }}', '"[-1]" is not an index; write a whole number from 0, such as [0]'],
    ['{{ with.refs[x] }}', '"[x]" is not an index; write a whole number from 0, such as [0]'],
  ])('rejects %s', (text, message) => {
    expect(parseTemplate(`before ${text} after`, false)).toEqual({ ok: false, errors: [{ source: text, message }] });
  });

  it('finds a template in text that is never rendered', () => {
    expect(findTemplate('echo "{{inputs.title}}" "{{ steps.plan.outputs.task }}"', false)).toBe('{{inputs.title}}');
    expect(findTemplate('echo "${{ secrets.TOKEN }} {{ name }}"', false)).toBeUndefined();
  });

  it('finds a ${{ … }} template in a command too, since the command would receive the braces as written', () => {
    expect(findTemplate('echo "${{ inputs.title }}"', false)).toBe('{{ inputs.title }}');
    expect(findTemplate('echo "${{ length(inputs.files) }}"', false)).toBe('{{ length(inputs.files) }}');
    expect(findTemplate('echo "${{ !inputs.draft }}"', false)).toBe('{{ !inputs.draft }}');
  });

  it('reads item only where an item is bound, and leaves it as written elsewhere', () => {
    const text = 'Explain {{ item }}, {{ item.name }} and {{ item[0] }}.';
    const itemContext = { ...context, item: { name: 'web' } };

    expect(renderText(template(text, true), itemContext)).toBe('Explain {"name":"web"}, web and .');
    expect(renderText(template(text, false), itemContext)).toBe(text);
    expect(findTemplate('echo {{ item.name }}', true)).toBe('{{ item.name }}');
    expect(findTemplate('echo {{ item.name }}', false)).toBeUndefined();
  });

  it('renders a step\'s own with values, and leaves a template right after a $ as written', () => {
    const withContext = { ...context, with: { task: { title: 'Crash' }, ref: 'main' } };

    expect(renderText(template('{{ with.task.title }} on {{with.ref}}, {{ with.none }}'), withContext)).toBe('Crash on main, ');
    expect(renderValue(template('{{ with.task }}'), withContext)).toEqual({ title: 'Crash' });
    expect(renderValue(template('{{ with.refs[1] }}'), { ...withContext, with: { refs: ['main', 'dev'] } })).toBe('dev');
    expect(renderText(template('${{ inputs.issue }} ${{with.ref}} $ {{ inputs.issue }}'), withContext)).toBe('${{ inputs.issue }} ${{with.ref}} $ 42');
  });

  it.each([
    ['{{ with.task == 1 }}'],
    ['{{ with. }}'],
  ])('rejects %s, since with is read only as one path', (text) => {
    expect(parseTemplate(text, false)).toEqual({ ok: false, errors: [{ source: text, message: WITH }] });
  });

  it.each([
    ['a double-quoted string', '{{ filter(steps.build.results, .outcome == "failed") }}', "strings use single quotes, as in 'failed'"],
    ['= for ==', "{{ any(steps.build.results, .outcome = 'failed') }}", 'any is called as any(list, predicate)'],
    ['a field a step does not have', '{{ length(steps.build.result) }}',
      '"steps.build.result" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches'],
    ['a string compared with <', "{{ length(inputs.xs) < 'x' }}", "compares 'x' with <, but it is not a number"],
    ['a call on a with value', '{{ length(with.xs) }}', '"with" is not readable; an expression reads only inputs, steps and item'],
    ['a call after a third brace', '{{{ length(steps.build.results) }}', 'expected a value, found "{"'],
    ['a call in 5,000 parentheses', `{{ ${'('.repeat(5000)}length(steps.build.results)${')'.repeat(5000)} }}`, DEEP],
    ['a call after 20,000 !', `{{ ${'!'.repeat(20000)}any(steps.build.results, .ok) }}`, DEEP],
    ['a call in a chain of 5,000 &&', `{{ length(steps.build.results)${' && true'.repeat(5000)} }}`, DEEP],
  ])('rejects a call with %s, with the parse error', (_case, text, message) => {
    expect(parseTemplate(`Fix ${text} first.`, false)).toEqual({ ok: false, errors: [{ source: text, message }] });
  });

  it('renders a comparison of values nested 4,000 levels deep', () => {
    const nested = (bottom: unknown): unknown => JSON.parse(`${'['.repeat(4000)}${JSON.stringify(bottom)}${']'.repeat(4000)}`);
    const deep = { inputs: { a: nested(1), b: nested(1), c: nested(2) }, steps: {} };

    expect(renderText(template('{{ inputs.a == inputs.b }} {{ inputs.a == inputs.c }}'), deep)).toBe('true false');
  });

  it('evaluates a call on item only where an item is bound', () => {
    const text = 'Count {{ length(item.xs) }}.';

    expect(renderText(template(text, true), { ...context, item: { xs: [1, 2] } })).toBe('Count 2.');
    expect(renderText(template(text, false), { ...context, item: { xs: [1, 2] } })).toBe(text);
  });

  it('rejects a call that a }} inside its arguments cuts short', () => {
    expect(parseTemplate("Fix {{ filter(steps.build.results, .name == '}}') }} first.", false)).toEqual({
      ok: false, errors: [{ source: "{{ filter(steps.build.results, .name == '}}", message: "a string is not closed with '" }],
    });
  });

  it.each([
    ['a Vue or Angular call', '{{ filter(items) }}'],
    ['a Liquid call', '{{ all(products) }}'],
    ['a Jinja filter', '{{ items | length }}'],
    ['a Jinja call', '{{ range(10) }}'],
    ['a GitHub Actions expression', '${{ length(steps.build.results) }}'],
    ['a Handlebars block', '{{#each items}}{{this}}{{/each}}'],
    ['a Handlebars triple-stash', '{{{ x }}}'],
    ['a Go template', '{{ len .Items }} {{ .Name }}'],
    ['a call on a root no expression reads, such as a typo of inputs', '{{ length(input.xs) }}'],
    ['a call on literals alone', "{{ length('abc') }} {{ length(5) }} {{ any(3, .x) }}"],
    ['5,000 parentheses', `{{ ${'('.repeat(5000)} }}`],
  ])('leaves %s as text', (_case, text) => {
    expect(renderText(template(`Explain ${text} here.`), context)).toBe(`Explain ${text} here.`);
  });

  it.each([10, 100, 1_000, 10_000])('parses, scans and evaluates generated text of about %i tokens without throwing', (tokens) => {
    const bound = { ...context, item: { xs: [{ ok: [true] }] } };
    for (let seed = 1; seed <= 50; seed += 1) {
      const text = generated(seed * tokens, tokens);
      expect(() => {
        const parsed = parseExpression(text);
        if (parsed.ok) evaluateExpression(parsed.expression, bound);
        for (const item of [false, true]) {
          for (const wrapped of [text, `Fix {{ ${text} }}.`, `Fix {{ steps.build.results && ${text} }}.`, `Fix {{ length(${text}) }}.`]) {
            findTemplate(wrapped, item);
            const scanned = parseTemplate(wrapped, item);
            if (scanned.ok) {
              renderText(scanned.template, bound);
              renderValue(scanned.template, bound);
            }
          }
        }
      }, `seed ${seed * tokens}`).not.toThrow();
    }
  });

  const tableContext = {
    inputs: { name: 'N', title: 'T', x: true, l: [1, 2, 3] },
    steps: { a: { outcome: 'success', outputs: { l: [{ k: 'x' }, { k: 'y' }], n: 2 } }, build: { outcome: 'failed', results: [] } },
    item: { name: 'I' },
  } satisfies ExpressionContext;
  const AS_WRITTEN = Symbol('as written');
  const STEP_FIELDS = 'must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches';

  it.each<[string, string, boolean, typeof AS_WRITTEN | { renders: string } | { error: string }]>([
    ['a Jinja filter', '{{ items | length }}', false, AS_WRITTEN],
    ['a Jinja call', '{{ range(10) }}', false, AS_WRITTEN],
    ['a Jinja filter on a root', '{{ inputs.name | upper }}', false, { error: 'unexpected "|"' }],
    ['a Jinja variable and loop', '{{ name }} {% for x in xs %}{{ x.name }}{% endfor %}', false, AS_WRITTEN],
    ['Liquid', "{{ all(products) }} {{ product.title | upcase }} {{ product.title | append: 'x' }}", false, AS_WRITTEN],
    ['a Vue call', '{{ filter(items) }} {{ filter(items, fn) }}', false, AS_WRITTEN],
    ['a Vue call that names inputs later', '{{ filter(items).map(i => inputs[i]) }}', false, AS_WRITTEN],
    ['a Vue call on a bare steps or inputs', '{{ length(steps) }} of the wizard, {{ all(inputs, isValid) }}', false, AS_WRITTEN],
    ['a Vue item outside a for_each', '{{ item.name }}', false, AS_WRITTEN],
    ['a Vue item in a for_each', '{{ item.name }}', true, { renders: 'I' }],
    ['a Vue method on a root', '{{ inputs.items.filter(x => x) }}', false, { error: 'unexpected "("' }],
    ['an Angular pipe outside a for_each', '{{ item.title | uppercase }}', false, AS_WRITTEN],
    ['an Angular pipe in a for_each', '{{ item.title | uppercase }}', true, { error: 'unexpected "|"' }],
    ['Handlebars blocks', '{{#each inputs.items}}x{{/each}} {{#if (length inputs.items)}}y{{/if}} {{#each steps}}{{this}}{{/each}}', false, AS_WRITTEN],
    ['a Handlebars triple-stash on a root', '{{{ inputs.title }}}', false, { renders: '{T}' }],
    ['Go templates', '{{ .Values.x }} {{ len .Items }} {{ range .Items }}{{ .Name }}{{ end }} {{ index .Map "steps" }}', false, AS_WRITTEN],
    ['GitHub Actions', '${{ inputs.x }} ${{ length(steps.a.outputs.l) > 0 }} ${{ steps.x.outputs.y }}', false, AS_WRITTEN],
    ['an Ansible item outside a for_each', 'msg={{ item }}', false, AS_WRITTEN],
    ['an Ansible item in a for_each', 'msg={{ item }}', true, { renders: 'msg={"name":"I"}' }],
    ['prose quoting a teamai expression', '`{{ length(steps.a.outputs.l) }}`', false, { renders: '`2`' }],
    ['a call on a typo of inputs', '{{ length(input.tags) }} {{ lenth(inputs.tags) }}', false, AS_WRITTEN],
    ['a misspelled function name on a step', '{{ lenght(steps.build.results) }}', false, { error: '"lenght" is not a function; the functions are length, any, all and filter' }],
    ['a misspelled steps root', '{{ length(step.build.results) }}', false, { error: '"step" is not readable; an expression reads only inputs, steps and item' }],
    ['a negated path', '{{ !steps.build.outcome }} {{ !inputs.x }}', false, { renders: 'false false' }],
    ['a path in parentheses', '{{ (steps.build.outcome) }} {{ (inputs.x) }}', false, { renders: 'failed true' }],
    ['an unclosed call', '{{ length(steps.a.outputs.l }}', false, { error: 'length is called as length(list)' }],
    ['a double-quoted string', '{{ any(steps.a.outputs.l, .k == "x") }}', false, { error: "strings use single quotes, as in 'failed'" }],
    ['= for ==', '{{ inputs.x = 1 }}', false, { error: 'unexpected "="' }],
    ['a field a step does not have', '{{ steps.build.result }}', false, { error: `"steps.build.result" ${STEP_FIELDS}` }],
    ['a comparison that starts with a path', '{{ steps.a.outputs.n < 3 }}', false, { renders: 'true' }],
    ['a call on with', '{{ length(with.items) }}', false, { error: '"with" is not readable; an expression reads only inputs, steps and item' }],
    ['with in an expression', '{{ with.x == 1 }}', false, { error: WITH }],
  ])('classifies %s', (_case, text, item, expected) => {
    const parsed = parseTemplate(text, item);
    const rendered = parsed.ok ? renderText(parsed.template, tableContext) : undefined;
    const actual = !parsed.ok ? { error: parsed.errors[0]?.message } : rendered === text ? AS_WRITTEN : { renders: rendered };
    expect(actual).toEqual(expected);
  });

  it('finds a call in a command, which would receive its braces as written, and leaves other text', () => {
    expect(findTemplate("echo {{ length(steps.build.results) }} {{ filter(items) }}", false)).toBe('{{ length(steps.build.results) }}');
    expect(findTemplate('echo {{ filter(items) }} {{ length(item.xs) }}', false)).toBeUndefined();
    expect(findTemplate('echo {{ length(item.xs) }}', true)).toBe('{{ length(item.xs) }}');
  });
});
