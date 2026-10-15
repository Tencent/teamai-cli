/**
 * Workflow templates: `{{ inputs.… }}`, `{{ steps.… }}` and `{{ with.… }}` inside prompt text, `env` values and
 * every string inside a `with` value. Any other `{{ … }}` is plain text, so prompts about GitHub Actions or Jinja stay as written.
 */
import { parseExpression, resolvePath, type ExpressionContext, type ExpressionPath } from './expression.js';
import type { WorkflowStep } from './types.js';

/** A `{{ with.<name>… }}` read: a value the step's own `with` names. Only templates read it; an `if` cannot. */
export interface WithPath {
  root: 'with';
  /** The `with` name, then the fields read inside its value. */
  fields: string[];
}

/** What a template reads: an expression path, or a value from the step's own `with`. */
export interface TemplateContext extends ExpressionContext {
  with?: unknown;
}

/** One `{{ path }}` and where it sits in the source text. */
export interface TemplateRead {
  /** The whole `{{ … }}` as written. */
  source: string;
  path: ExpressionPath | WithPath;
}

/** Literal text and reads, in source order. */
export type Template = Array<string | TemplateRead>;

/** A recognized template that is not one path: the `{{ … }}` as written and why. */
export interface TemplateError {
  source: string;
  message: string;
}

export type TemplateParse = { ok: true; template: Template } | { ok: false; errors: TemplateError[] };

/** A `{{ … }}` whose content starts with `inputs.`, `steps.` or `with.`. */
const TEMPLATE = /\{\{\s*((?:inputs|steps|with)\.[^{}]*?)\s*\}\}/;
/** A template not preceded by `$`: `${{ inputs.x }}` is GitHub Actions text and stays as written. */
const RECOGNIZED = new RegExp(`(?<!\\$)${TEMPLATE.source}`, 'g');
/** `with.<name>`, then any fields inside its value. */
const WITH_PATH = /^with(?:\.[A-Za-z0-9_-]+)+$/;

/**
 * The first template-like `{{ … }}` in `text` as written, if any; used to reject one where text is never rendered,
 * such as `command`. It also finds `${{ … }}`, since a command would receive those braces as written too.
 */
export function findTemplate(text: string): string | undefined {
  return TEMPLATE.exec(text)?.[0];
}

/** The one path a recognized template reads, or why it does not read exactly one. */
function readOf(inner: string): ExpressionPath | WithPath | string {
  if (inner.startsWith('with.')) {
    return WITH_PATH.test(inner) ? { root: 'with', fields: inner.split('.').slice(1) } : 'a template reads one path, such as with.<name>';
  }
  const parsed = parseExpression(inner);
  if (!parsed.ok) return parsed.message;
  return parsed.expression.kind === 'path' ? parsed.expression.path : 'a template reads one path';
}

/** Splits `text` into literal text and reads. Every recognized template must be exactly one path. */
export function parseTemplate(text: string): TemplateParse {
  const template: Template = [];
  const errors: TemplateError[] = [];
  let index = 0;
  for (const match of text.matchAll(RECOGNIZED)) {
    const source = match[0];
    const path = readOf(match[1] ?? '');
    if (typeof path === 'string') {
      errors.push({ source, message: path });
    } else {
      if (match.index > index) template.push(text.slice(index, match.index));
      template.push({ source, path });
    }
    index = match.index + source.length;
  }
  if (errors.length > 0) return { ok: false, errors };
  if (index < text.length) template.push(text.slice(index));
  return { ok: true, template };
}

/** Every `inputs` and `steps` path a template reads, in source order. */
export function templatePaths(template: Template): ExpressionPath[] {
  return template.flatMap((part) => (typeof part === 'string' || part.path.root === 'with' ? [] : [part.path]));
}

/** Every `with` value a template reads, in source order. */
export function templateWithPaths(template: Template): WithPath[] {
  return template.flatMap((part) => (typeof part === 'string' || part.path.root !== 'with' ? [] : [part.path]));
}

/** Reads a path. A `with` path walks the step's `with` values the way an `inputs` path walks the inputs. */
function resolve(path: ExpressionPath | WithPath, context: TemplateContext): unknown {
  if (path.root !== 'with') return resolvePath(path, context);
  return resolvePath({ root: 'inputs', fields: path.fields, column: 1 }, { inputs: context.with, steps: {} });
}

/** A value as text: strings as they are, numbers and booleans as text, objects and arrays as JSON, null as ''. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Renders a template to text. A missing path renders as ''. */
export function renderText(template: Template, context: TemplateContext): string {
  return template.map((part) => (typeof part === 'string' ? part : textOf(resolve(part.path, context)))).join('');
}

/** Renders a whole value: a template that is exactly one `{{ path }}` keeps the JSON value it reads; anything else is text. */
export function renderValue(template: Template, context: TemplateContext): unknown {
  const only = template.length === 1 ? template[0] : undefined;
  if (only !== undefined && typeof only !== 'string') return resolve(only.path, context);
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
export function templatedTexts(step: Pick<WorkflowStep, 'prompt' | 'env' | 'with'>): Array<{ what: string; text: string }> {
  return [
    ...Object.entries(step.with ?? {}).flatMap(([name, value]) => stringsIn(value).map((text) => ({ what: `with.${name}`, text }))),
    ...(step.prompt !== undefined ? [{ what: 'prompt', text: step.prompt }] : []),
    ...Object.entries(step.env ?? {}).map(([name, text]) => ({ what: `env.${name}`, text })),
  ];
}

/**
 * Renders every string inside a value, at any depth, with `renderValue`, so a string that is exactly one
 * `{{ path }}` keeps the JSON value it reads. Other values stay as they are. Fails at the first template that does not parse.
 */
export function renderStrings(value: unknown, context: TemplateContext): { ok: true; value: unknown } | { ok: false; error: TemplateError } {
  if (typeof value === 'string') {
    const parsed = parseTemplate(value);
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
