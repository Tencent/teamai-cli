/**
 * The workflow expression language: `if` conditions, and the paths that templates read.
 * It reads only `inputs` and `steps`, has no functions, and its evaluation never throws.
 */

/** A value read by a path. A missing value is `null`. */
export type ExpressionPath =
  | { root: 'inputs'; fields: string[]; column: number }
  | { root: 'steps'; step: string; field: 'outcome' | 'end' | 'outputs'; fields: string[]; column: number };

export type Expression =
  | { kind: 'literal'; value: null | boolean | number | string | []; column: number }
  | { kind: 'path'; path: ExpressionPath; column: number }
  | { kind: 'not'; operand: Expression; column: number }
  | { kind: 'binary'; operator: '==' | '!=' | '&&' | '||'; left: Expression; right: Expression; column: number };

/** The outcome an expression reads of a settled step. */
export type VisibleOutcome = 'success' | 'failed' | 'skipped';

/** A step as an expression sees it. `outcome` is set once the step settled. */
export interface ExpressionStep {
  outcome?: VisibleOutcome;
  end?: string;
  outputs?: unknown;
}

export interface ExpressionContext {
  inputs?: unknown;
  steps: Record<string, ExpressionStep>;
}

export type ExpressionParse =
  | { ok: true; expression: Expression }
  | { ok: false; column: number; message: string };

type Token =
  | { kind: 'word'; text: string; column: number }
  | { kind: 'number'; value: number; column: number }
  | { kind: 'string'; value: string; column: number }
  | { kind: 'symbol'; text: string; column: number }
  | { kind: 'end'; column: number };

class ExpressionError extends Error {
  constructor(readonly column: number, message: string) {
    super(message);
  }
}

const WORD = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/y;
const NUMBER = /-?[0-9]+(?:\.[0-9]+)?/y;
const SYMBOLS = ['==', '!=', '&&', '||', '!', '(', ')', '[', ']'];

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
  const symbol = SYMBOLS.find((candidate) => source.startsWith(candidate, index)) ?? char;
  return { token: { kind: 'symbol', text: symbol, column }, next: index + symbol.length };
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'end': return 'the end of the expression';
    case 'word': return `"${token.text}"`;
    case 'number': return String(token.value);
    case 'string': return `'${token.value}'`;
    case 'symbol': return `"${token.text}"`;
  }
}

function parsePath(token: { text: string; column: number }): ExpressionPath {
  const [root, ...segments] = token.text.split('.');
  if (root === 'inputs') return { root, fields: segments, column: token.column };
  if (root !== 'steps') {
    throw new ExpressionError(token.column, `"${root}" is not readable; an expression reads only inputs and steps`);
  }
  const [step, field, ...fields] = segments;
  if (!step || !field) {
    throw new ExpressionError(token.column, `"${token.text}" must read steps.<id>.outcome, steps.<id>.end or steps.<id>.outputs`);
  }
  if (field === 'outputs') return { root, step, field, fields, column: token.column };
  if ((field === 'outcome' || field === 'end') && fields.length === 0) return { root, step, field, fields, column: token.column };
  throw new ExpressionError(token.column, `"${token.text}" must read steps.<id>.outcome, steps.<id>.end or steps.<id>.outputs`);
}

class Parser {
  private lookahead: { token: Token; next: number } | undefined;
  private index = 0;

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

  private or(): Expression {
    let left = this.and();
    for (let operator = this.symbol('||'); operator; operator = this.symbol('||')) {
      left = { kind: 'binary', operator: '||', left, right: this.and(), column: operator.column };
    }
    return left;
  }

  private and(): Expression {
    let left = this.not();
    for (let operator = this.symbol('&&'); operator; operator = this.symbol('&&')) {
      left = { kind: 'binary', operator: '&&', left, right: this.not(), column: operator.column };
    }
    return left;
  }

  private not(): Expression {
    const operator = this.symbol('!');
    if (operator) return { kind: 'not', operand: this.not(), column: operator.column };
    return this.compare();
  }

  private compare(): Expression {
    const left = this.primary();
    const operator = this.symbol('==') ?? this.symbol('!=');
    if (!operator || operator.kind !== 'symbol') return left;
    return { kind: 'binary', operator: operator.text as '==' | '!=', left, right: this.primary(), column: operator.column };
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
      case 'end':
        throw new ExpressionError(column, 'expected a value, found the end of the expression');
    }
  }
}

/** Parses an expression. Columns are 1-based offsets into `source`. */
export function parseExpression(source: string): ExpressionParse {
  try {
    return { ok: true, expression: new Parser(source).parse() };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, column: error.column, message: error.message };
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a path. Anything missing along the way, including a step that has not settled, is `null`. */
export function resolvePath(path: ExpressionPath, context: ExpressionContext): unknown {
  let value: unknown;
  if (path.root === 'inputs') {
    value = context.inputs;
  } else {
    const step = Object.hasOwn(context.steps, path.step) ? context.steps[path.step] : undefined;
    value = step?.[path.field];
  }
  for (const field of path.fields) {
    value = isRecord(value) && Object.hasOwn(value, field) ? value[field] : undefined;
  }
  return value ?? null;
}

/** The falsy values are `false`, `null`, `0` and `''`. Everything else, `[]` and `{}` included, is truthy. */
export function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === '');
}

/** Strict JSON equality: no type coercion, case-sensitive strings, arrays in order, objects by their keys. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
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
      }
    }
  }
}

/** Every path an expression reads, in source order. */
export function expressionPaths(expression: Expression): ExpressionPath[] {
  switch (expression.kind) {
    case 'literal': return [];
    case 'path': return [expression.path];
    case 'not': return expressionPaths(expression.operand);
    case 'binary': return [...expressionPaths(expression.left), ...expressionPaths(expression.right)];
  }
}
