/**
 * Workflow templates inside prompt text, `env` values and every string inside a `with` value: a `{{ … }}` that starts
 * with `inputs.`, `steps.`, `with.`, `run.` or, where an item is bound, `item`, after any "!" or "(", or that calls `length`,
 * `any`, `all` or `filter` on one of those, or any function on a step field. It reads one path, or evaluates an
 * expression as an `if` does. Any other `{{ … }}` is plain text, so prompts about GitHub Actions, Jinja, Vue or an
 * Ansible loop stay as written.
 */
import { z } from 'zod';
import type { JsonValue } from '../types.js';
import {
  evaluateExpression, expressionPaths, parseExpression, parseFields, resolvePath, schemaAt,
  readsLikeExpression, type Expression, type ExpressionContext, type ExpressionPath, type PathField,
} from './expression.js';
import type { StepState } from './step-state.js';
import type { OutputSchema, WorkflowFailure, WorkflowStep } from './types.js';
import { isJsonObject } from '../types.js';

/** A `{{ with.<name>… }}` read: a value the step's own `with` names. Only templates read it; an `if` cannot. */
export interface WithPath {
  root: 'with';
  /** The `with` name, then the names and indexes read inside its value. */
  fields: PathField[];
}

/** What a template reads: an expression path, a value from the step's own `with`, or a variable its caller offers. */
export interface TemplateContext extends ExpressionContext {
  with?: unknown;
  /** The values of the variables a caller of `parseTemplate` named, by root, such as `{ doc: { id } }`. */
  variables?: unknown;
}

/**
 * One `{{ … }}` as written, and what it reads: an expression, which may be one path, a value from the step's own
 * `with`, which no expression reads, or a variable whose root its caller named, as one path, root included.
 */
export type TemplateRead = { source: string; expression: Expression } | { source: string; path: WithPath } | { source: string; variable: PathField[] };

/** Literal text and reads, in source order. */
export type Template = Array<string | TemplateRead>;

/** Whether a part of a template is a read rather than literal text. */
export function isTemplateRead(part: string | TemplateRead): part is TemplateRead {
  return part instanceof Object;
}

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

/** `inputs.`, `steps.`, `with.` or `run.`, then anything up to the closing braces. */
const PATHS = String.raw`(?:inputs|steps|with|run)\.[^{}]*?`;

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

/** `\{{`: a literal `{{`. Only the backslash is dropped, and nothing after it is read as a template. */
const ESCAPED = '\\{{';

const WITH_MESSAGE = 'with is read only as one path, such as with.<name>; an expression reads only inputs, steps, item and run.id';

/**
 * A template-like `{{ … }}` in `text` as written, if any; used to reject one where text is never rendered, such as
 * `command`. Unlike parseTemplate, it also finds `${{ … }}`, path or expression, since a command would receive those
 * braces as written too.
 */
export function findTemplate(text: string, item: boolean): string | undefined {
  const { template, path } = item ? SYNTAX.bound : SYNTAX.unbound;

  return template.exec(text)?.[0] ?? [...text.matchAll(ANY_BRACES)].find((match) => readsLikeExpression(match[1] ?? '', path))?.[0];
}

/** What a template reads, or why it does not parse. A read that starts with one of `variables` and a "." is that variable. */
function readOf(inner: string, variables: readonly string[]): { ok: true; read: { expression: Expression } | { path: WithPath } | { variable: PathField[] } } | { ok: false; message: string } {
  if (variables.some((root) => inner.startsWith(`${root}.`))) {
    const parsed = parseFields(inner);

    return parsed.ok ? { ok: true, read: { variable: parsed.fields } } : { ok: false, message: parsed.message };
  }

  if (inner.startsWith('with.')) {
    if (!WITH_PATH.test(inner)) return { ok: false, message: WITH_MESSAGE };
    const parsed = parseFields(inner);

    return parsed.ok ? { ok: true, read: { path: { root: 'with', fields: parsed.fields.slice(1) } } } : { ok: false, message: parsed.message };
  }

  const parsed = parseExpression(inner);

  return parsed.ok ? { ok: true, read: { expression: parsed.expression } } : { ok: false, message: parsed.message };
}

/** The syntax of `item`'s templates, with `variables`, plain names, read as paths too. */
function syntaxOf(item: boolean, variables: readonly string[]): Syntax {
  if (variables.length === 0) return item ? SYNTAX.bound : SYNTAX.unbound;
  const roots = String.raw`(?:${variables.join('|')})\.[^{}]*?`;

  return syntax(item ? String.raw`${PATHS}|${roots}|item(?![A-Za-z0-9_-])(?:[.[][^{}]*?)?` : `${PATHS}|${roots}`);
}

/**
 * Splits `text` into literal text and reads. A `{{ … }}` that starts with a path is a template, and so is one between
 * them that reads like an expression, as written or with a mistake in it; every template must parse. `\{{` is a
 * literal `{{`, so `text.replaceAll('{{', '\\{{')` renders as `text`. `item` is whether an item is bound where the
 * text renders; where none is, `{{ item }}` is literal text. `variables` are the roots of the variables the caller
 * offers, such as `doc` for `{{ doc.id }}`, which render from `TemplateContext.variables`.
 */
export function parseTemplate(text: string, item: boolean, variables: readonly string[] = []): TemplateParse {
  const { recognized, path } = syntaxOf(item, variables);
  const template: Template = [];
  const errors: TemplateError[] = [];

  const read = (source: string, inner: string): void => {
    const parsed = readOf(inner, variables);

    if (!parsed.ok) errors.push({ source, message: parsed.message });
    else template.push({ source, ...parsed.read });
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

  const scan = (piece: string): void => {
    let index = 0;

    for (const match of piece.matchAll(recognized)) {
      literal(piece.slice(index, match.index));
      read(match[0], match[1] ?? '');
      index = match.index + match[0].length;
    }

    literal(piece.slice(index));
  };

  text.split(ESCAPED).forEach((piece, at) => {
    if (at > 0) template.push('{{');
    scan(piece);
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, template };
}

/** Every expression a template evaluates, one path included, in source order. */
export function templateExpressions(template: Template): Expression[] {
  return template.flatMap((part) => (isTemplateRead(part) && 'expression' in part ? [part.expression] : []));
}

/** Every `inputs`, `steps` and `item` path a template reads, in source order. */
export function templatePaths(template: Template): ExpressionPath[] {
  return templateExpressions(template).flatMap(expressionPaths);
}

/**
 * A step `role` as parse admits it: the id of a role in `manifest/roles.yaml`, or, where an item is bound, a template
 * that reads only the item its `for_each` instance runs for, such as `{{ item.role }}`, which the lease of each item
 * renders to an id.
 */
export type StepRoleSpec = { kind: 'id'; id: string } | { kind: 'item_template'; source: string; template: Template };

/** A step `role` as written, read as a template of its item when it is one (`StepRoleSpec`), else as an id. */
export function stepRoleSpec(role: string): StepRoleSpec {
  const parsed = parseTemplate(role, true);

  const readsItemOnly = parsed.ok && parsed.template.some(isTemplateRead) && templateWithPaths(parsed.template).length === 0
    && templatePaths(parsed.template).every((path) => path.root === 'item');

  return parsed.ok && readsItemOnly ? { kind: 'item_template', source: role, template: parsed.template } : { kind: 'id', id: role };
}

/** Every `with` value a template reads, in source order. */
export function templateWithPaths(template: Template): WithPath[] {
  return template.flatMap((part) => (isTemplateRead(part) && 'path' in part ? [part.path] : []));
}

/**
 * The value a read renders: its expression, evaluated as an `if` is, or its `with` path, which walks the step's `with`
 * values the way an `inputs` path walks the inputs.
 */
function valueOf(read: TemplateRead, context: TemplateContext): JsonValue {
  if ('expression' in read) return evaluateExpression(read.expression, context);

  if ('variable' in read) return resolvePath({ root: 'inputs', fields: read.variable, column: 1 }, { inputs: context.variables, steps: {} });

  return resolvePath({ root: 'inputs', fields: read.path.fields, column: 1 }, { inputs: context.with, steps: {} });
}

/** A value as text: strings as they are, numbers and booleans as text, objects and arrays as JSON, null as ''. */
function textOf(value: JsonValue): string {
  if (value === null) return '';

  return isJsonObject(value) || Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/** Renders a template to text. A missing value renders as ''. */
export function renderText(template: Template, context: TemplateContext): string {
  return template.map((part) => (isTemplateRead(part) ? textOf(valueOf(part, context)) : part)).join('');
}

/**
 * `text`, the template at `what` of the step `state` is leased for, rendered from `context`, what the step reads when
 * it is leased. Pull rejects a template that does not parse, so a failure here means the run file was changed.
 */
export function renderLeaseText(context: TemplateContext, state: Pick<StepState, 'id'>, { what, text }: { what: string; text: string }): string | WorkflowFailure {
  const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

  if (!parsed.ok) {
    const [problem] = parsed.errors;

    return { code: 'invalid_template', message: `step "${state.id}" ${what} template ${problem?.source}: ${problem?.message}` };
  }

  return renderText(parsed.template, context);
}

/** Renders a whole value: a template that is exactly one `{{ … }}` keeps the JSON value it reads; anything else is text. */
export function renderValue(template: Template, context: TemplateContext): JsonValue {
  const only = template.length === 1 ? template[0] : undefined;

  if (only !== undefined && isTemplateRead(only)) return valueOf(only, context);

  return renderText(template, context);
}

/** Every string inside a value, at any depth: the templates a `with` value holds. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- a with value is what YAML toJSON gives, which a !!set tag makes a Set rather than JSON
export function stringsIn(value: unknown): string[] {
  const text = z.string().safeParse(value);

  if (text.success) return [text.data];

  if (value instanceof Object) return Object.values(value).flatMap(stringsIn);

  return [];
}

/**
 * The texts a step templates: `with.<name>` once per string inside that value, `prompt`, `answer`, `model` when it is not the
 * exact model, `env.<NAME>`, `writes[<n>]`, and `for_each.max_parallel` when it is not a number. Pull and the engine share
 * this one list, so they agree on which fields are templates.
 */
export function templatedTexts(step: Pick<WorkflowStep, 'prompt' | 'answer' | 'env' | 'with' | 'hitl' | 'model' | 'workspace' | 'writes' | 'forEach'>): Array<{ what: string; text: string }> {
  const maxParallel = step.forEach?.maxParallel;
  const confined = step.workspace instanceof Object && 'confined' in step.workspace ? step.workspace.confined : undefined;

  return [
    ...(step.hitl ? [{ what: `${step.hitl.kind}.message`, text: step.hitl.message }] : []),
    ...Object.entries(step.with ?? {}).flatMap(([name, value]) => stringsIn(value).map((text) => ({ what: `with.${name}`, text }))),
    ...(step.prompt !== undefined ? [{ what: 'prompt', text: step.prompt }] : []),
    ...(step.answer !== undefined ? [{ what: 'answer', text: step.answer }] : []),
    ...(step.model !== undefined && !(step.model instanceof Object) ? [{ what: 'model', text: step.model }] : []),
    ...(confined !== undefined ? [{ what: 'workspace.confined', text: confined }] : []),
    ...Object.entries(step.env ?? {}).map(([name, text]) => ({ what: `env.${name}`, text })),
    ...(step.writes ?? []).map((text, index) => ({ what: `writes[${index}]`, text })),
    ...(maxParallel instanceof Object ? [{ what: 'for_each.max_parallel', text: maxParallel.template }] : []),
  ];
}

/** What a template the lease renders, a `model` or a confined directory, may read; pull checks that each step it reads is one the step needs. */
function isLeaseRead(path: ExpressionPath): boolean {
  return path.root === 'inputs' || path.root === 'item' || (path.root === 'steps' && path.field === 'outputs');
}

/** The sources of the reads in `template` that a lease cannot render from what the step is leased with. */
function unleasedReads(template: Template): string[] {
  return template.flatMap((part) => (isTemplateRead(part) && 'expression' in part && !expressionPaths(part.expression).every(isLeaseRead) ? [part.source] : []));
}

/** Why a confined directory, parsed as `template`, cannot render: a read of anything but an input, the item, or a step's outputs. */
export function confinedTemplateErrors(template: Template): TemplateError[] {
  return unleasedReads(template).map((source) => ({ source, message: 'a confined directory template reads only inputs, item and the outputs of steps the step needs' }));
}

/**
 * Why a step's `model`, parsed as `template`, cannot render an alias or a model name: a read of anything but an input,
 * the item, or a step's outputs, or literal text a model cannot hold. A `with` read is `withReadProblems`' to report.
 */
export function modelTemplateErrors(text: string, template: Template): TemplateError[] {
  const literal = template.filter((part) => !isTemplateRead(part)).join('');

  return [
    ...(/\s|\{\{/.test(literal) ? [{ source: text, message: 'text outside a template cannot hold a space or {{, and {{ item }} is a template only where for_each binds an item' }] : []),
    ...unleasedReads(template).map((source) => ({ source, message: 'a model template reads only inputs, item and the outputs of steps the step needs' })),
  ];
}

/**
 * Why a `writes` path, parsed as `template`, cannot render: a read of anything but an input, so every attempt of the
 * step keeps the same paths, which pull and the person reading the file can see.
 */
export function writesTemplateErrors(template: Template): TemplateError[] {
  return template.flatMap((part) => (isTemplateRead(part) && 'expression' in part && !expressionPaths(part.expression).every((read) => read.root === 'inputs')
    ? [{ source: part.source, message: 'a writes template reads only inputs' }] : []));
}

/**
 * Why a `for_each.max_parallel` template `text`, parsed as `template`, may not render a whole number from 1: it is not one
 * `{{ … }}` alone, or that read is not a number input of `inputs`. A read of an input `inputs` lacks is the read check's
 * to report.
 */
export function maxParallelTemplateErrors(text: string, template: Template, inputs: Record<string, OutputSchema> | undefined): TemplateError[] {
  const [read, ...rest] = template;

  if (read === undefined || !isTemplateRead(read) || rest.length > 0) {
    return [{ source: text, message: 'a max_parallel template is one {{ … }} and nothing else, so it renders a whole number' }];
  }

  const path = 'expression' in read && read.expression.kind === 'path' ? read.expression.path : undefined;
  const declared = path?.root === 'inputs' && inputs ? schemaAt({ type: 'object', fields: inputs }, path.fields) : undefined;

  if (path?.root === 'inputs' && inputs && declared === undefined) return [];

  return declared?.type === 'number' ? [] : [{ source: read.source, message: 'a max_parallel template reads only a number input' }];
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
// oxlint-disable-next-line teamai/no-unknown-parameters -- engine.ts passes a step's with, whose values YAML toJSON gives, which a !!set tag makes a Set rather than JSON
export function renderStrings(value: unknown, context: TemplateContext): { ok: true; value: unknown } | { ok: false; error: TemplateError } {
  const text = z.string().safeParse(value);

  if (text.success) {
    const parsed = parseTemplate(text.data, Object.hasOwn(context, 'item'));

    return parsed.ok ? { ok: true, value: renderValue(parsed.template, context) } : { ok: false, error: parsed.errors[0]! };
  }

  if (!(value instanceof Object)) return { ok: true, value };
  const rendered: Array<[string, unknown]> = [];

  for (const [key, item] of Object.entries(value)) {
    const result = renderStrings(item, context);

    if (!result.ok) return result;
    rendered.push([key, result.value]);
  }

  return { ok: true, value: Array.isArray(value) ? rendered.map(([, item]) => item) : Object.fromEntries(rendered) };
}
