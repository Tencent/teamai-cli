/**
 * The workflow expression language: `if` conditions, and what templates read and evaluate.
 * It reads `inputs`, `steps` and the `item` of a `for_each`, compares numbers, and calls `length`, `any`, `all` and
 * `filter`, whose predicate reads each element of the list as `.`. Its evaluation never throws.
 */
import type { VisibleOutcome } from './step-state.js';
import { INDEX } from './step-path.js';
import type { OutputSchema } from './types.js';

/** A field name, or an array index such as the 0 in `tags[0]`. */
export type PathField = string | number;

/** A value read by a path. A missing value is `null`. */
export type ExpressionPath =
  | { root: 'inputs'; fields: PathField[]; column: number }
  /** The item a `for_each` step instance runs for. */
  | { root: 'item'; fields: PathField[]; column: number }
  | { root: 'steps'; step: string; field: 'outcome' | 'end' | 'outputs' | 'passes' | 'results' | 'branches' | 'choice' | 'note'; fields: PathField[]; column: number };

/** `<`, `<=`, `>` and `>=` compare two numbers; with anything else they are false. */
const COMPARISONS = {
  '<': (left: number, right: number) => left < right,
  '<=': (left: number, right: number) => left <= right,
  '>': (left: number, right: number) => left > right,
  '>=': (left: number, right: number) => left >= right,
};
type Comparison = keyof typeof COMPARISONS;

/** Each function, as a call to it is written. */
const FUNCTIONS = {
  length: 'length(list)',
  any: 'any(list, predicate)',
  all: 'all(list, predicate)',
  filter: 'filter(list, predicate)',
};
type FunctionName = keyof typeof FUNCTIONS;

export type Expression =
  | { kind: 'literal'; value: null | boolean | number | string | []; column: number }
  | { kind: 'path'; path: ExpressionPath; column: number }
  | { kind: 'not'; operand: Expression; column: number }
  | { kind: 'binary'; operator: '==' | '!=' | Comparison | '&&' | '||'; left: Expression; right: Expression; column: number }
  | { kind: 'call'; name: 'length'; list: Expression; column: number }
  /** `predicate` reads each element of `list` through `element` expressions. */
  | { kind: 'call'; name: Exclude<FunctionName, 'length'>; list: Expression; predicate: Expression; column: number }
  /** `.`, `.a.b` or `.a[0]`: the current element of a predicate, or a value inside it. */
  | { kind: 'element'; fields: PathField[]; column: number };

/** Change branches named on `for_each` results, in item order. An empty fan-out is an empty list. */
export function branchNames(results: Array<{ branch?: string }> | undefined): string[] | undefined {
  if (!results) return undefined;
  if (results.length === 0) return [];
  const names = results.flatMap((item) => item.branch ? [item.branch] : []);
  return names.length > 0 ? names : undefined;
}

/** A step as an expression sees it. `outcome` is set once the step settled. */
export interface ExpressionStep {
  outcome?: VisibleOutcome;
  end?: string;
  outputs?: unknown;
  /** Every settled pass of the step, earliest first: those a loop ran again, then the current one once it settled. */
  passes?: ExpressionPass[];
  /** The current pass's HITL choice, when answered. */
  choice?: string;
  /** The note attached to that HITL answer. */
  note?: string;
  /** For a settled `for_each` step: how each item settled, in item order. `branch` is the item's change branch. */
  results?: Array<{ item?: unknown; outcome: VisibleOutcome; outputs?: unknown; branch?: string }>;
  /** Change branches of a settled `for_each`, in item order. */
  branches?: string[];
}

/** One pass of a step in `steps.<id>.passes`. */
export interface ExpressionPass {
  pass: number;
  outcome: VisibleOutcome;
  outputs?: unknown;
  end?: string;
  results?: ExpressionStep['results'];
  /** The choice retained for this pass. */
  choice?: string;
  /** The note retained for this pass. */
  note?: string;
}

export interface ExpressionContext {
  inputs?: unknown;
  steps: Record<string, ExpressionStep>;
  /** The item of the `for_each` the expression is evaluated for. */
  item?: unknown;
  /** The element a predicate is evaluated for. */
  element?: unknown;
}

export type ExpressionParse =
  | { ok: true; expression: Expression }
  | { ok: false; column: number; message: string };

type Token =
  | { kind: 'word'; text: string; column: number }
  | { kind: 'number'; value: number; column: number }
  | { kind: 'string'; value: string; column: number }
  | { kind: 'symbol'; text: string; column: number }
  | { kind: 'element'; text: string; column: number }
  | { kind: 'end'; column: number };

class ExpressionError extends Error {
  constructor(readonly column: number, message: string) {
    super(message);
  }
}

const WORD = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+|\[[^\]]*\]?)*/y;
/** One name or `[index]` of a path, in order. */
const FIELD = /\.?([A-Za-z0-9_-]+)|\[([^\]]*)(\]?)/y;
const WHOLE_INDEX = new RegExp(`^(?:${INDEX})$`);
/** `.`, then any names and indexes, as in `.a.b[0]` or `.[0]`. */
const ELEMENT = /\.(?:(?:[A-Za-z0-9_-]+|\[[^\]]*\]?)(?:\.[A-Za-z0-9_-]+|\[[^\]]*\]?)*)?/y;
/** A word with no "." or "[", which a "(" makes a function name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const NUMBER = /-?[0-9]+(?:\.[0-9]+)?/y;
const SYMBOLS = ['==', '!=', '<=', '>=', '&&', '||', '!', '<', '>', '(', ')', '[', ']', ','];

/** Reads the token that starts at or after `index`. Lexing is lazy, so errors come in source order. */
function lexAt(source: string, from: number): { token: Token; next: number } {
  let index = from;
  while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
  const column = index + 1;
  if (index >= source.length) return { token: { kind: 'end', column }, next: index };
  const char = source[index] ?? '';
  if (char === "'") {
    let value = '';
    let end = index + 1;
    for (;;) {
      if (end >= source.length) throw new ExpressionError(column, "a string is not closed with '");
      if (source[end] === "'") {
        if (source[end + 1] !== "'") break;
        value += "'";
        end += 2;
        continue;
      }
      value += source[end];
      end += 1;
    }
    return { token: { kind: 'string', value, column }, next: end + 1 };
  }
  if (char === '"') throw new ExpressionError(column, "strings use single quotes, as in 'failed'");
  NUMBER.lastIndex = index;
  const number = NUMBER.exec(source);
  if (number) return { token: { kind: 'number', value: Number(number[0]), column }, next: index + number[0].length };
  WORD.lastIndex = index;
  const word = WORD.exec(source);
  if (word) return { token: { kind: 'word', text: word[0], column }, next: index + word[0].length };
  ELEMENT.lastIndex = index;
  const element = ELEMENT.exec(source);
  if (element) return { token: { kind: 'element', text: element[0], column }, next: index + element[0].length };
  const symbol = SYMBOLS.find((candidate) => source.startsWith(candidate, index)) ?? char;
  return { token: { kind: 'symbol', text: symbol, column }, next: index + symbol.length };
}

/** A string literal as the expression writes it, with each ' doubled. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'end': return 'the end of the expression';
    case 'word':
    case 'element':
      return `"${token.text}"`;
    case 'number': return String(token.value);
    case 'string': return quoted(token.value);
    case 'symbol': return `"${token.text}"`;
  }
}

/** The names and indexes of a path written at `column`. The WORD token rule has already checked its shape. */
function fieldsOf(text: string, column: number): PathField[] {
  const fields: PathField[] = [];
  for (FIELD.lastIndex = 0; FIELD.lastIndex < text.length;) {
    const at = column + FIELD.lastIndex;
    const match = FIELD.exec(text);
    if (!match) break;
    if (match[1] !== undefined) {
      fields.push(match[1]);
    } else if (match[3] === '') {
      throw new ExpressionError(at, 'an index is not closed with ]');
    } else if (WHOLE_INDEX.test(match[2] ?? '')) {
      fields.push(Number(match[2]));
    } else {
      throw new ExpressionError(at, `"${match[0]}" is not an index; write a whole number from 0, such as [0]`);
    }
  }
  return fields;
}

/** The names and indexes of a path, root included, such as a template's `with.refs[1]`, or why an index is malformed. */
export function parseFields(text: string): { ok: true; fields: PathField[] } | { ok: false; message: string } {
  try {
    return { ok: true, fields: fieldsOf(text, 1) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, message: error.message };
    throw error;
  }
}

function parsePath(token: { text: string; column: number }): ExpressionPath {
  const [root, ...segments] = fieldsOf(token.text, token.column);
  if (root === 'inputs' || root === 'item') return { root, fields: segments, column: token.column };
  if (root !== 'steps') {
    throw new ExpressionError(token.column, `"${root}" is not readable; an expression reads only inputs, steps and item`);
  }
  const [step, field, ...fields] = segments;
  if (typeof step === 'string' && typeof field === 'number') {
    throw new ExpressionError(token.column, `"${token.text}" indexes a step; an index reads an array in its outputs, as in steps.${step}.outputs.<field>[${field}]`);
  }
  if (typeof step !== 'string' || !field) throw new ExpressionError(token.column, `"${token.text}" ${STEP_FIELDS}`);
  if (field === 'outputs' || field === 'passes' || field === 'results' || field === 'branches') return { root, step, field, fields, column: token.column };
  if ((field === 'outcome' || field === 'end' || field === 'choice' || field === 'note') && fields.length === 0) return { root, step, field, fields, column: token.column };
  if ((field === 'outcome' || field === 'end' || field === 'choice' || field === 'note') && typeof fields[0] === 'number') {
    throw new ExpressionError(token.column, `"${token.text}" indexes ${field}, which is a name; compare it whole, as in steps.${step}.${field} == '<name>'`);
  }
  throw new ExpressionError(token.column, `"${token.text}" ${STEP_FIELDS}`);
}

const STEP_FIELDS = 'must read steps.<id>.outcome, steps.<id>.end, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results or steps.<id>.branches';

/**
 * A type pull knows for a value before the run: a declared shorthand, or `unknown`, which any value fits, such as the
 * item of a `for_each` result. Every field and index inside `unknown` reads `unknown` too.
 */
export type DeclaredType =
  | OutputSchema
  | { type: 'unknown' }
  | { type: 'array'; items: DeclaredType }
  | { type: 'object'; fields: Record<string, DeclaredType> };

const UNKNOWN: DeclaredType = { type: 'unknown' };

/**
 * The type the `output` a step declares gives `steps.<id>.<field>`, or undefined when it gives none: outcome and end
 * are names, each item of `passes` holds the outputs of one pass, and each item of `results` the item and outputs of one
 * `for_each` item.
 */
export function stepFieldSchema(field: Extract<ExpressionPath, { root: 'steps' }>['field'], output: OutputSchema | undefined, forEach: boolean, choices?: string[]): DeclaredType | undefined {
  const results: DeclaredType = { type: 'array', items: { type: 'object', fields: { item: UNKNOWN, outcome: { type: 'string' }, outputs: output ?? UNKNOWN, branch: { type: 'string' } } } };
  switch (field) {
    case 'choice': return choices ? { type: 'enum', values: choices } : undefined;
    case 'note': return { type: 'string' };
    case 'outcome':
    case 'end':
      return { type: 'string' };
    case 'outputs': return forEach ? undefined : output;
    case 'passes':
      return { type: 'array', items: { type: 'object', fields: { pass: { type: 'number' }, outcome: { type: 'string' }, end: { type: 'string' },
        ...(choices ? { choice: { type: 'enum' as const, values: choices }, note: { type: 'string' as const } } : {}),
        ...(forEach ? { results } : { outputs: output ?? UNKNOWN }),
      } } };
    case 'results': return forEach ? results : undefined;
    case 'branches': return { type: 'array', items: { type: 'string' } };
  }
}

class Parser {
  private lookahead: { token: Token; next: number } | undefined;
  private index = 0;
  private depth = 0;
  private predicateDepth = 0;

  constructor(private readonly source: string) {}

  parse(): Expression {
    const expression = this.or();
    const rest = this.peek();
    if (rest.kind !== 'end') throw new ExpressionError(rest.column, `unexpected ${describe(rest)}`);
    return expression;
  }

  private peek(): Token {
    this.lookahead ??= lexAt(this.source, this.index);
    return this.lookahead.token;
  }

  private take(): Token {
    const token = this.peek();
    this.index = this.lookahead?.next ?? this.index;
    this.lookahead = undefined;
    return token;
  }

  private symbol(text: string): Token | undefined {
    const token = this.peek();
    if (token.kind !== 'symbol' || token.text !== text) return undefined;
    return this.take();
  }

  /** One level deeper in the tree. Text pasted in a prompt could otherwise nest or chain deep enough to overflow the stack. */
  private deeper(column: number): void {
    if (this.depth === 100) throw new ExpressionError(column, 'an expression nests at most 100 levels deep, counting each "(", "!", call, && and ||');
    this.depth += 1;
  }

  private or(): Expression {
    const depth = this.depth;
    let left = this.and();
    for (let operator = this.symbol('||'); operator; operator = this.symbol('||')) {
      this.deeper(operator.column);
      left = { kind: 'binary', operator: '||', left, right: this.and(), column: operator.column };
    }
    this.depth = depth;
    return left;
  }

  private and(): Expression {
    const depth = this.depth;
    let left = this.not();
    for (let operator = this.symbol('&&'); operator; operator = this.symbol('&&')) {
      this.deeper(operator.column);
      left = { kind: 'binary', operator: '&&', left, right: this.not(), column: operator.column };
    }
    this.depth = depth;
    return left;
  }

  private not(): Expression {
    const depth = this.depth;
    this.deeper(this.peek().column);
    const operator = this.symbol('!');
    const expression: Expression = operator ? { kind: 'not', operand: this.not(), column: operator.column } : this.equality();
    this.depth = depth;
    return expression;
  }

  private equality(): Expression {
    const left = this.comparison();
    const operator = this.symbol('==') ?? this.symbol('!=');
    if (!operator || operator.kind !== 'symbol') return left;
    return { kind: 'binary', operator: operator.text as '==' | '!=', left, right: this.comparison(), column: operator.column };
  }

  private comparison(): Expression {
    const left = this.primary();
    const operator = this.peek();
    if (operator.kind !== 'symbol' || !Object.hasOwn(COMPARISONS, operator.text)) return left;
    this.take();
    return { kind: 'binary', operator: operator.text as Comparison, left, right: this.primary(), column: operator.column };
  }

  /** The arguments of a call, after its "(". */
  private call(name: FunctionName, column: number): Expression {
    const usage = (): ExpressionError => new ExpressionError(column, `${name} is called as ${FUNCTIONS[name]}`);
    if (this.symbol(')')) throw usage();
    const list = this.or();
    if (name === 'length') {
      if (!this.symbol(')')) throw usage();
      return { kind: 'call', name, list, column };
    }
    if (!this.symbol(',')) throw usage();
    this.predicateDepth += 1;
    const predicate = this.or();
    this.predicateDepth -= 1;
    if (!this.symbol(')')) throw usage();
    return { kind: 'call', name, list, predicate, column };
  }

  private primary(): Expression {
    const token = this.take();
    const column = token.column;
    switch (token.kind) {
      case 'number':
      case 'string':
        return { kind: 'literal', value: token.value, column };
      case 'word':
        if (token.text === 'true' || token.text === 'false') return { kind: 'literal', value: token.text === 'true', column };
        if (token.text === 'null') return { kind: 'literal', value: null, column };
        if (NAME.test(token.text) && this.symbol('(')) {
          if (!Object.hasOwn(FUNCTIONS, token.text)) throw new ExpressionError(column, `"${token.text}" is not a function; the functions are length, any, all and filter`);
          return this.call(token.text as FunctionName, column);
        }
        return { kind: 'path', path: parsePath(token), column };
      case 'symbol':
        if (token.text === '(') {
          const inner = this.or();
          const close = this.take();
          if (close.kind !== 'symbol' || close.text !== ')') throw new ExpressionError(close.column, `expected ")", found ${describe(close)}`);
          return inner;
        }
        if (token.text === '[') {
          const close = this.take();
          if (close.kind !== 'symbol' || close.text !== ']') throw new ExpressionError(close.column, 'the only array literal is []');
          return { kind: 'literal', value: [], column };
        }
        throw new ExpressionError(column, `expected a value, found ${describe(token)}`);
      case 'element':
        if (/^\.[0-9]+$/.test(token.text) || (this.predicateDepth === 0 && /^\.[0-9]/.test(token.text))) {
          throw new ExpressionError(column, 'numbers need a leading digit, as in 0.5');
        }
        if (this.predicateDepth === 0) {
          throw new ExpressionError(column, `"${token.text}" reads the current element, which exists only inside the predicate of any, all or filter`);
        }
        return { kind: 'element', fields: fieldsOf(token.text.slice(1), column + 1), column };
      case 'end':
        throw new ExpressionError(column, 'expected a value, found the end of the expression');
    }
  }
}

/** An operand or argument whose type does not fit where it is used, and the column it starts at. */
export interface TypeProblem {
  column: number;
  message: string;
}

function textOf(expression: Expression): string {
  switch (expression.kind) {
    case 'literal': return typeof expression.value === 'string' ? quoted(expression.value) : JSON.stringify(expression.value);
    case 'path': {
      const { path } = expression;
      return path.root === 'steps' ? `steps.${path.step}.${path.field}${fieldsText(path.fields)}` : `${path.root}${fieldsText(path.fields)}`;
    }
    case 'element': {
      const text = fieldsText(expression.fields);
      return text.startsWith('.') ? text : `.${text}`;
    }
    case 'call': return `${expression.name}(...)`;
    default: return 'a condition';
  }
}

interface ElementType {
  items: DeclaredType;
  list: Expression;
}

/** The type a workflow declares for what a path reads, or undefined when it is not known before the run. */
export type SchemaOf = (path: ExpressionPath) => DeclaredType | undefined;

type StaticType = Exclude<DeclaredType, { type: 'unknown' }> | { type: 'array'; items?: undefined } | { type: 'null' };

function known(type: DeclaredType | undefined): StaticType | undefined {
  return type?.type === 'unknown' ? undefined : type;
}

function typeOf(expression: Expression, schemaOf: SchemaOf, element: ElementType | undefined): StaticType | undefined {
  switch (expression.kind) {
    case 'literal': {
      const { value } = expression;
      if (value === null) return { type: 'null' };
      if (Array.isArray(value)) return { type: 'array' };
      return typeof value === 'number' ? { type: 'number' } : typeof value === 'string' ? { type: 'string' } : { type: 'boolean' };
    }
    case 'path': return known(schemaOf(expression.path));
    case 'element': return element && known(schemaAt(element.items, expression.fields));
    case 'not':
    case 'binary':
      return { type: 'boolean' };
    case 'call': {
      if (expression.name === 'length') return { type: 'number' };
      if (expression.name !== 'filter') return { type: 'boolean' };
      const list = typeOf(expression.list, schemaOf, element);
      return list?.type === 'array' ? list : { type: 'array' };
    }
  }
}

/**
 * The comparisons whose operands are not numbers, the list arguments that are not arrays, and what predicates read
 * that the items of their list do not declare. Parsing passes no `schemaOf`, so it finds only what the expression itself
 * shows, such as `x < 'a'`; pull passes the declared types.
 */
export function typeProblems(expression: Expression, schemaOf: SchemaOf = () => undefined): TypeProblem[] {
  return problemsIn(expression, schemaOf, undefined);
}

function problemsIn(expression: Expression, schemaOf: SchemaOf, element: ElementType | undefined): TypeProblem[] {
  switch (expression.kind) {
    case 'literal':
    case 'path':
      return [];
    case 'element':
      return element && !schemaAt(element.items, expression.fields)
        ? [{ column: expression.column, message: `reads ${textOf(expression)}, which is not in an item of ${textOf(element.list)}` }]
        : [];
    case 'not': return problemsIn(expression.operand, schemaOf, element);
    case 'call': {
      const problems = problemsIn(expression.list, schemaOf, element);
      const list = typeOf(expression.list, schemaOf, element);
      if (list && list.type !== 'array') {
        problems.push({ column: expression.list.column, message: `passes ${textOf(expression.list)} to ${expression.name} as its list, but it is not an array` });
      }
      if (expression.name === 'length') return problems;
      const items = list?.type === 'array' && list.items ? { items: list.items, list: expression.list } : undefined;
      return [...problems, ...problemsIn(expression.predicate, schemaOf, items)];
    }
    case 'binary': {
      const problems = [...problemsIn(expression.left, schemaOf, element), ...problemsIn(expression.right, schemaOf, element)];
      if (!Object.hasOwn(COMPARISONS, expression.operator)) return problems;
      for (const operand of [expression.left, expression.right]) {
        const type = typeOf(operand, schemaOf, element);
        if (type && type.type !== 'number') {
          problems.push({ column: operand.column, message: `compares ${textOf(operand)} with ${expression.operator}, but it is not a number` });
        }
      }
      return problems;
    }
  }
}

/** Parses an expression. Columns are 1-based offsets into `source`. */
export function parseExpression(source: string): ExpressionParse {
  try {
    const expression = new Parser(source).parse();
    const [problem] = typeProblems(expression);
    if (problem) return { ok: false, ...problem };
    return { ok: true, expression };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, column: error.column, message: error.message };
    throw error;
  }
}

/** A step field written as a path, `steps` misspelled `step` included, as in `steps.build.results`. */
const STEP_FIELD = /^steps?\.[A-Za-z0-9_-]+\.(?:outcome|end|outputs|passes|results|choice|note)(?![A-Za-z0-9_-])/;

/**
 * Whether `source` reads like an expression, judged by its tokens alone and past any that do not lex: its first value,
 * or the first argument of a call in it, after any "!" and "(", is a path `path` matches, or a step field. Only a step
 * field counts after a name that is not a function, since other text, such as a Vue sample, calls its own functions on
 * its own names. Unlike parseExpression, it also finds an expression with a mistake in it, such as a misspelled
 * function or a double-quoted string.
 */
export function readsLikeExpression(source: string, path: RegExp): boolean {
  let first: 'value' | 'unknown call' | undefined = 'value';
  let previous: Token | undefined;
  for (let index = 0; ;) {
    let lexed: { token: Token; next: number };
    try {
      lexed = lexAt(source, index);
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      index = error.column;
      first = undefined;
      previous = undefined;
      continue;
    }
    const { token, next } = lexed;
    if (token.kind === 'end') return false;
    if (token.kind === 'symbol' && token.text === '(' && previous?.kind === 'word' && NAME.test(previous.text)) {
      first = Object.hasOwn(FUNCTIONS, previous.text) ? 'value' : 'unknown call';
    } else if (first !== undefined && token.kind === 'word' && (STEP_FIELD.test(token.text) || (first === 'value' && path.test(token.text)))) {
      return true;
    } else if (!(token.kind === 'symbol' && (token.text === '!' || token.text === '('))) {
      first = undefined;
    }
    previous = token;
    index = next;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The names and indexes after a path's root, as a path writes them, such as `.files[0].path`. */
export function fieldsText(fields: PathField[]): string {
  return fields.map((field) => (typeof field === 'number' ? `[${field}]` : `.${field}`)).join('');
}

/** Reads a path. Anything missing along the way, including a step that has not settled, is `null`. */
export function resolvePath(path: ExpressionPath, context: ExpressionContext): unknown {
  if (path.root === 'inputs') return readFields(context.inputs, path.fields);
  if (path.root === 'item') return readFields(context.item, path.fields);
  const step = Object.hasOwn(context.steps, path.step) ? context.steps[path.step] : undefined;
  return readFields(step?.[path.field], path.fields);
}

/** The type `schema` declares for the value `fields` names inside it, or undefined when it declares none. */
export function schemaAt(schema: DeclaredType, fields: PathField[]): DeclaredType | undefined {
  let current = schema;
  for (const field of fields) {
    if (current.type === 'unknown') return current;
    if (typeof field === 'number') {
      if (current.type !== 'array') return undefined;
      current = current.items;
    } else {
      if (current.type !== 'object' || !Object.hasOwn(current.fields, field)) return undefined;
      current = current.fields[field]!;
    }
  }
  return current;
}

function readFields(value: unknown, fields: PathField[]): unknown {
  let current = value;
  for (const field of fields) {
    if (typeof field === 'number') current = Array.isArray(current) ? current[field] : undefined;
    else current = isRecord(current) && Object.hasOwn(current, field) ? current[field] : undefined;
  }
  return current ?? null;
}

/** The falsy values are `false`, `null`, `0` and `''`. Everything else, `[]` and `{}` included, is truthy. */
export function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === '');
}

/**
 * Strict JSON equality: no type coercion, case-sensitive strings, arrays in order, objects by their keys. It walks the
 * pairs with a stack of its own, since a value a step reports can nest deeper than the call stack goes.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  const pairs: Array<[unknown, unknown]> = [[left, right]];
  for (let pair = pairs.pop(); pair; pair = pairs.pop()) {
    const [a, b] = pair;
    if (a === b) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      a.forEach((item, index) => pairs.push([item, b[index]]));
      continue;
    }
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length || !keys.every((key) => Object.hasOwn(b, key))) return false;
    for (const key of keys) pairs.push([a[key], b[key]]);
  }
  return true;
}

/** Evaluates an expression. It never throws. */
export function evaluateExpression(expression: Expression, context: ExpressionContext): unknown {
  switch (expression.kind) {
    case 'literal': return Array.isArray(expression.value) ? [] : expression.value;
    case 'path': return resolvePath(expression.path, context);
    case 'not': return !isTruthy(evaluateExpression(expression.operand, context));
    case 'binary': {
      const left = evaluateExpression(expression.left, context);
      switch (expression.operator) {
        case '&&': return isTruthy(left) && isTruthy(evaluateExpression(expression.right, context));
        case '||': return isTruthy(left) || isTruthy(evaluateExpression(expression.right, context));
        case '==': return deepEqual(left, evaluateExpression(expression.right, context));
        case '!=': return !deepEqual(left, evaluateExpression(expression.right, context));
        default: {
          const right = evaluateExpression(expression.right, context);
          return typeof left === 'number' && typeof right === 'number' && COMPARISONS[expression.operator](left, right);
        }
      }
    }
    case 'call': {
      const list = evaluateExpression(expression.list, context);
      if (!Array.isArray(list)) return null;
      if (expression.name === 'length') return list.length;
      const { predicate } = expression;
      const holds = (element: unknown): boolean => isTruthy(evaluateExpression(predicate, { ...context, element }));
      switch (expression.name) {
        case 'any': return list.some(holds);
        case 'all': return list.every(holds);
        case 'filter': return list.filter(holds);
      }
    }
    case 'element': return readFields(context.element, expression.fields);
  }
}

/** Every `inputs`, `steps` and `item` path an expression reads, in source order. */
export function expressionPaths(expression: Expression): ExpressionPath[] {
  switch (expression.kind) {
    case 'literal': return [];
    case 'path': return [expression.path];
    case 'not': return expressionPaths(expression.operand);
    case 'binary': return [...expressionPaths(expression.left), ...expressionPaths(expression.right)];
    case 'call': return [...expressionPaths(expression.list), ...(expression.name === 'length' ? [] : expressionPaths(expression.predicate))];
    case 'element': return [];
  }
}
