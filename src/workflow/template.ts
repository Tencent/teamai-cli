/**
 * Workflow templates inside prompt text, `env` values and every string inside a `with` value: a `{{ … }}` that starts
 * with `inputs.`, `steps.`, `with.` or, where an item is bound, `item`, after any "!" or "(", or that calls `length`,
 * `any`, `all` or `filter` on one of those, or any function on a step field. It reads one path, or evaluates an
 * expression as an `if` does. Any other `{{ … }}` is plain text, so prompts about GitHub Actions, Jinja, Vue or an
 * Ansible loop stay as written.
 */
import {
  evaluateExpression, expressionPaths, parseExpression, parseFields, resolvePath,
  readsLikeExpression, type Expression, type ExpressionContext, type ExpressionPath, type PathField,
} from './expression.js';
import type { WorkflowStep } from './types.js';

/** A `{{ with.<name>… }}` read: a value the step's own `with` names. Only templates read it; an `if` cannot. */
export interface WithPath {
  root: 'with';
  /** The `with` name, then the names and indexes read inside its value. */
  fields: PathField[];
}

/** What a template reads: an expression path, or a value from the step's own `with`. */
export interface TemplateContext extends ExpressionContext {
  with?: unknown;
}

/**
 * One `{{ … }}` as written, and what it reads: an expression, which may be one path, or a value from the step's own
 * `with`, which no expression reads.
 */
export type TemplateRead = { source: string; expression: Expression } | { source: string; path: WithPath };

/** Literal text and reads, in source order. */
export type Template = Array<string | TemplateRead>;

/** A template that does not parse: the `{{ … }}` as written and why. */
export interface TemplateError {
  source: string;
  message: string;
}

export type TemplateParse = { ok: true; template: Template } | { ok: false; errors: TemplateError[] };

/** What templates read, where no item is bound and where one is. */
interface Syntax {
  /** A template, `${{ … }}` included. */
  template: RegExp;
  /** A template not preceded by `$`: `${{ inputs.x }}` is GitHub Actions text and stays as written. */
  recognized: RegExp;
  /** The start of a path a template reads, which an expression must start with or call a function on. */
  path: RegExp;
}

/** `paths` is the regex source of what a template that reads one path holds between its braces. */
function syntax(paths: string): Syntax {
  const template = new RegExp(`\\{\\{\\s*(${paths})\\s*\\}\\}`);
  return { template, recognized: new RegExp(`(?<!\\$)${template.source}`, 'g'), path: new RegExp(`^(?:${paths})`) };
}

/** `inputs.`, `steps.` or `with.`, then anything up to the closing braces. */
const PATHS = String.raw`(?:inputs|steps|with)\.[^{}]*?`;

/**
 * `item` is a root only where an item is bound: in the templates of a `for_each` step and of the workflow each item
 * runs. Elsewhere `{{ item }}` stays as written, as in a prompt that quotes an Ansible loop.
 */
const SYNTAX = {
  unbound: syntax(PATHS),
  /** Those, and `item`, bare or with names and indexes. */
  bound: syntax(String.raw`${PATHS}|item(?![A-Za-z0-9_-])(?:[.[][^{}]*?)?`),
};
/** `with.<name>`, then any names and indexes inside its value. */
const WITH_PATH = /^with\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+|\[[^\]]*\]?)*$/;
/** A `{{ … }}`, `${{ … }}` included, up to the first `}}`, that holds no other `{{`. */
const ANY_BRACES = /\{\{((?:(?!\{\{)[\s\S])*?)\}\}/g;
/** Those not preceded by `$`. */
const BRACES = new RegExp(`(?<!\\$)${ANY_BRACES.source}`, 'g');

const WITH_MESSAGE = 'with is read only as one path, such as with.<name>; an expression reads only inputs, steps and item';

/**
 * A template-like `{{ … }}` in `text` as written, if any; used to reject one where text is never rendered, such as
 * `command`. Unlike parseTemplate, it also finds `${{ … }}`, path or expression, since a command would receive those
 * braces as written too.
 */
export function findTemplate(text: string, item: boolean): string | undefined {
  const { template, path } = item ? SYNTAX.bound : SYNTAX.unbound;
  return template.exec(text)?.[0] ?? [...text.matchAll(ANY_BRACES)].find((match) => readsLikeExpression(match[1] ?? '', path))?.[0];
}

/** What a template reads, or why it does not parse. */
function readOf(inner: string): { expression: Expression } | { path: WithPath } | string {
  if (inner.startsWith('with.')) {
    if (!WITH_PATH.test(inner)) return WITH_MESSAGE;
    const parsed = parseFields(inner);
    return parsed.ok ? { path: { root: 'with', fields: parsed.fields.slice(1) } } : parsed.message;
  }
  const parsed = parseExpression(inner);
  return parsed.ok ? { expression: parsed.expression } : parsed.message;
}

/**
 * Splits `text` into literal text and reads. A `{{ … }}` that starts with a path is a template, and so is one between
 * them that reads like an expression, as written or with a mistake in it; every template must parse. `item` is
 * whether an item is bound where the text renders; where none is, `{{ item }}` is literal text.
 */
export function parseTemplate(text: string, item: boolean): TemplateParse {
  const { recognized, path } = item ? SYNTAX.bound : SYNTAX.unbound;
  const template: Template = [];
  const errors: TemplateError[] = [];
  const read = (source: string, inner: string): void => {
    const parsed = readOf(inner);
    if (typeof parsed === 'string') errors.push({ source, message: parsed });
    else template.push({ source, ...parsed });
  };
  const literal = (segment: string): void => {
    let index = 0;
    for (const match of segment.matchAll(BRACES)) {
      if (!readsLikeExpression(match[1] ?? '', path)) continue;
      if (match.index > index) template.push(segment.slice(index, match.index));
      read(match[0], match[1] ?? '');
      index = match.index + match[0].length;
    }
    if (index < segment.length) template.push(segment.slice(index));
  };
  let index = 0;
  for (const match of text.matchAll(recognized)) {
    literal(text.slice(index, match.index));
    read(match[0], match[1] ?? '');
    index = match.index + match[0].length;
  }
  literal(text.slice(index));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, template };
}

/** Every expression a template evaluates, one path included, in source order. */
export function templateExpressions(template: Template): Expression[] {
  return template.flatMap((part) => (typeof part === 'string' || !('expression' in part) ? [] : [part.expression]));
}

/** Every `inputs`, `steps` and `item` path a template reads, in source order. */
export function templatePaths(template: Template): ExpressionPath[] {
  return templateExpressions(template).flatMap(expressionPaths);
}

/** Every `with` value a template reads, in source order. */
export function templateWithPaths(template: Template): WithPath[] {
  return template.flatMap((part) => (typeof part === 'string' || !('path' in part) ? [] : [part.path]));
}

/**
 * The value a read renders: its expression, evaluated as an `if` is, or its `with` path, which walks the step's `with`
 * values the way an `inputs` path walks the inputs.
 */
function valueOf(read: TemplateRead, context: TemplateContext): unknown {
  if ('expression' in read) return evaluateExpression(read.expression, context);
  return resolvePath({ root: 'inputs', fields: read.path.fields, column: 1 }, { inputs: context.with, steps: {} });
}

/** A value as text: strings as they are, numbers and booleans as text, objects and arrays as JSON, null as ''. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Renders a template to text. A missing value renders as ''. */
export function renderText(template: Template, context: TemplateContext): string {
  return template.map((part) => (typeof part === 'string' ? part : textOf(valueOf(part, context)))).join('');
}

/** Renders a whole value: a template that is exactly one `{{ … }}` keeps the JSON value it reads; anything else is text. */
export function renderValue(template: Template, context: TemplateContext): unknown {
  const only = template.length === 1 ? template[0] : undefined;
  if (only !== undefined && typeof only !== 'string') return valueOf(only, context);
  return renderText(template, context);
}

/** Every string inside a value, at any depth: the templates a `with` value holds. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

/**
 * The texts a step templates: `with.<name>` once per string inside that value, `prompt`, and `env.<NAME>`.
 * Pull and the engine share this one list, so they agree on which fields are templates.
 */
export function templatedTexts(step: Pick<WorkflowStep, 'prompt' | 'env' | 'with' | 'hitl'>): Array<{ what: string; text: string }> {
  return [
    ...(step.hitl ? [{ what: `${step.hitl.kind}.message`, text: step.hitl.message }] : []),
    ...Object.entries(step.with ?? {}).flatMap(([name, value]) => stringsIn(value).map((text) => ({ what: `with.${name}`, text }))),
    ...(step.prompt !== undefined ? [{ what: 'prompt', text: step.prompt }] : []),
    ...Object.entries(step.env ?? {}).map(([name, text]) => ({ what: `env.${name}`, text })),
  ];
}

/** One expression a step evaluates, named by the field YAML writes it at. */
export interface StepExpression {
  what: 'if' | 'loop.while' | 'break' | 'for_each';
  source: string;
}

/**
 * The expressions a step evaluates. Pull and the engine share this one list, so they agree on which fields are
 * expressions and on what a step reads.
 */
export function stepExpressions(step: Pick<WorkflowStep, 'if' | 'loop' | 'break' | 'forEach'>): StepExpression[] {
  return [
    ...(step.if !== undefined ? [{ what: 'if' as const, source: step.if }] : []),
    ...(step.loop?.while !== undefined ? [{ what: 'loop.while' as const, source: step.loop.while }] : []),
    ...(step.break !== undefined ? [{ what: 'break' as const, source: step.break }] : []),
    ...(step.forEach !== undefined ? [{ what: 'for_each' as const, source: step.forEach.items }] : []),
  ];
}

/**
 * Renders every string inside a value, at any depth, with `renderValue`, so a string that is exactly one
 * `{{ … }}` keeps the JSON value it reads. Other values stay as they are. Fails at the first template that does not parse.
 * `item` is a template only when `context` binds one.
 */
export function renderStrings(value: unknown, context: TemplateContext): { ok: true; value: unknown } | { ok: false; error: TemplateError } {
  if (typeof value === 'string') {
    const parsed = parseTemplate(value, Object.hasOwn(context, 'item'));
    return parsed.ok ? { ok: true, value: renderValue(parsed.template, context) } : { ok: false, error: parsed.errors[0]! };
  }
  if (!value || typeof value !== 'object') return { ok: true, value };
  const rendered: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    const result = renderStrings(item, context);
    if (!result.ok) return result;
    rendered.push([key, result.value]);
  }
  return { ok: true, value: Array.isArray(value) ? rendered.map(([, item]) => item) : Object.fromEntries(rendered) };
}
