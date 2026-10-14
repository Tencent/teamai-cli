/**
 * Restricted expression parser and template evaluator.
 * Does not use JavaScript eval or Function.
 * Cannot access globals, files, environment variables, or executable code.
 */

export interface StepContext {
  outcome?: string;
  status?: string;
  outputs?: unknown;
  end?: string;
  exitCode?: number;
  [key: string]: unknown;
}

export interface ExprContext {
  inputs?: Record<string, unknown>;
  steps?: Record<string, StepContext>;
  item?: unknown;
  enclosing?: {
    inputs?: Record<string, unknown>;
    steps?: Record<string, StepContext>;
    item?: unknown;
  };
  [key: string]: unknown;
}

export type TokenType =
  | 'STRING'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'NULL'
  | 'IDENT'
  | 'EMPTY_ARRAY'
  | 'DOT'
  | 'NOT'
  | 'EQ'
  | 'NEQ'
  | 'LT'
  | 'LTE'
  | 'GT'
  | 'GTE'
  | 'AND'
  | 'OR'
  | 'LPAREN'
  | 'RPAREN'
  | 'EOF';

export interface Token {
  type: TokenType;
  value?: string | number | boolean | null;
  pos: number;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i]!;

    // Whitespace
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // String literals ('...' or "...")
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      let str = '';
      while (i < len && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < len) {
          i += 1;
          const esc = input[i]!;
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === 'r') str += '\r';
          else str += esc;
        } else {
          str += input[i];
        }
        i += 1;
      }
      if (i >= len) {
        throw new Error(`Unterminated string starting at position ${start}`);
      }
      i += 1; // closing quote
      tokens.push({ type: 'STRING', value: str, pos: start });
      continue;
    }

    // Empty array literal `[]`
    if (ch === '[' && input[i + 1] === ']') {
      tokens.push({ type: 'EMPTY_ARRAY', pos: i });
      i += 2;
      continue;
    }

    // Two-character operators
    if (ch === '=' && input[i + 1] === '=') {
      tokens.push({ type: 'EQ', pos: i });
      i += 2;
      continue;
    }
    if (ch === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'NEQ', pos: i });
      i += 2;
      continue;
    }
    if (ch === '<' && input[i + 1] === '=') {
      tokens.push({ type: 'LTE', pos: i });
      i += 2;
      continue;
    }
    if (ch === '>' && input[i + 1] === '=') {
      tokens.push({ type: 'GTE', pos: i });
      i += 2;
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      tokens.push({ type: 'AND', pos: i });
      i += 2;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      tokens.push({ type: 'OR', pos: i });
      i += 2;
      continue;
    }

    // Single-character operators
    if (ch === '!') {
      tokens.push({ type: 'NOT', pos: i });
      i += 1;
      continue;
    }
    if (ch === '<') {
      tokens.push({ type: 'LT', pos: i });
      i += 1;
      continue;
    }
    if (ch === '>') {
      tokens.push({ type: 'GT', pos: i });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', pos: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', pos: i });
      i += 1;
      continue;
    }
    if (ch === '.') {
      tokens.push({ type: 'DOT', pos: i });
      i += 1;
      continue;
    }

    // Numbers
    if (/\d/.test(ch) || (ch === '-' && /\d/.test(input[i + 1] ?? ''))) {
      const start = i;
      let numStr = ch;
      i += 1;
      while (i < len && /[\d.]/.test(input[i]!)) {
        numStr += input[i];
        i += 1;
      }
      const num = Number(numStr);
      if (Number.isNaN(num)) {
        throw new Error(`Invalid number "${numStr}" at position ${start}`);
      }
      tokens.push({ type: 'NUMBER', value: num, pos: start });
      continue;
    }

    // Identifiers and keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      let ident = ch;
      i += 1;
      while (i < len && /[A-Za-z0-9_$-]/.test(input[i]!)) {
        ident += input[i];
        i += 1;
      }
      if (ident === 'true') {
        tokens.push({ type: 'BOOLEAN', value: true, pos: start });
      } else if (ident === 'false') {
        tokens.push({ type: 'BOOLEAN', value: false, pos: start });
      } else if (ident === 'null') {
        tokens.push({ type: 'NULL', value: null, pos: start });
      } else {
        tokens.push({ type: 'IDENT', value: ident, pos: start });
      }
      continue;
    }

    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }

  tokens.push({ type: 'EOF', pos: len });
  return tokens;
}

export type AstNode =
  | { type: 'Literal'; value: unknown }
  | { type: 'MemberAccess'; path: string[] }
  | { type: 'UnaryOp'; op: '!'; arg: AstNode }
  | { type: 'BinaryOp'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'; left: AstNode; right: AstNode };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private match(...types: TokenType[]): Token | null {
    const current = this.peek();
    if (types.includes(current.type)) {
      this.pos += 1;
      return current;
    }
    return null;
  }

  private expect(type: TokenType): Token {
    const token = this.match(type);
    if (!token) {
      throw new Error(`Expected token ${type} but got ${this.peek().type} at position ${this.peek().pos}`);
    }
    return token;
  }

  public parse(): AstNode {
    const node = this.parseOr();
    if (this.peek().type !== 'EOF') {
      throw new Error(`Unexpected extra tokens after expression at position ${this.peek().pos}`);
    }
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.match('OR')) {
      const right = this.parseAnd();
      left = { type: 'BinaryOp', op: '||', left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseEquality();
    while (this.match('AND')) {
      const right = this.parseEquality();
      left = { type: 'BinaryOp', op: '&&', left, right };
    }
    return left;
  }

  private parseEquality(): AstNode {
    let left = this.parseRelational();
    let token: Token | null;
    while ((token = this.match('EQ', 'NEQ')) !== null) {
      const op = token.type === 'EQ' ? '==' : '!=';
      const right = this.parseRelational();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  private parseRelational(): AstNode {
    let left = this.parseUnary();
    let token: Token | null;
    while ((token = this.match('LT', 'LTE', 'GT', 'GTE')) !== null) {
      const opMap: Record<string, '<' | '<=' | '>' | '>='> = {
        LT: '<',
        LTE: '<=',
        GT: '>',
        GTE: '>=',
      };
      const op = opMap[token.type]!;
      const right = this.parseUnary();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.match('NOT')) {
      const arg = this.parseUnary();
      return { type: 'UnaryOp', op: '!', arg };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const token = this.peek();

    if (token.type === 'STRING' || token.type === 'NUMBER' || token.type === 'BOOLEAN' || token.type === 'NULL') {
      this.pos += 1;
      return { type: 'Literal', value: token.value };
    }

    if (token.type === 'EMPTY_ARRAY') {
      this.pos += 1;
      return { type: 'Literal', value: [] };
    }

    if (token.type === 'LPAREN') {
      this.pos += 1;
      const inner = this.parseOr();
      this.expect('RPAREN');
      return inner;
    }

    if (token.type === 'IDENT') {
      this.pos += 1;
      const path: string[] = [String(token.value)];
      while (this.match('DOT')) {
        const next = this.expect('IDENT');
        path.push(String(next.value));
      }
      return { type: 'MemberAccess', path };
    }

    throw new Error(`Unexpected token ${token.type} at position ${token.pos}`);
  }
}

export function parseExpression(input: string): AstNode {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('Empty expression');
  }
  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  return parser.parse();
}

const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

function resolvePath(base: unknown, path: string[]): unknown {
  let curr = base;
  for (const seg of path) {
    if (curr === null || curr === undefined || typeof curr !== 'object') {
      return undefined;
    }
    if (FORBIDDEN_PROPERTIES.has(seg)) {
      return undefined;
    }
    curr = (curr as Record<string, unknown>)[seg];
  }
  return curr;
}

export function evaluateAst(node: AstNode, context: ExprContext): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;

    case 'MemberAccess': {
      const [head, ...rest] = node.path;
      if (!head) return undefined;

      // Check context directly (inputs, steps, item, etc.)
      if (head === 'inputs') {
        const value = resolvePath(context.inputs, rest);
        if (value !== undefined) return value;
        return resolvePath(context.enclosing?.inputs, rest);
      }

      if (head === 'steps') {
        const stepId = rest[0];
        if (!stepId) return undefined;
        const localStep = context.steps?.[stepId];
        if (localStep) {
          return resolvePath(localStep, rest.slice(1));
        }
        const enclosingStep = context.enclosing?.steps?.[stepId];
        if (enclosingStep) {
          return resolvePath(enclosingStep, rest.slice(1));
        }
        return undefined;
      }

      if (head === 'item') {
        if (context.item !== undefined) {
          return resolvePath(context.item, rest);
        }
        if (context.enclosing?.item !== undefined) {
          return resolvePath(context.enclosing.item, rest);
        }
        return undefined;
      }

      // Other top-level variable in context
      if (head in context) {
        return resolvePath(context[head], rest);
      }

      // Check enclosing
      if (context.enclosing && head in context.enclosing) {
        return resolvePath((context.enclosing as Record<string, unknown>)[head], rest);
      }

      return undefined;
    }

    case 'UnaryOp': {
      if (node.op === '!') {
        return !evaluateAst(node.arg, context);
      }
      return undefined;
    }

    case 'BinaryOp': {
      if (node.op === '&&') {
        const leftVal = evaluateAst(node.left, context);
        return leftVal ? evaluateAst(node.right, context) : leftVal;
      }
      if (node.op === '||') {
        const leftVal = evaluateAst(node.left, context);
        return leftVal ? leftVal : evaluateAst(node.right, context);
      }

      const left = evaluateAst(node.left, context);
      const right = evaluateAst(node.right, context);

      if (node.op === '==') {
        if (Array.isArray(left) && Array.isArray(right)) {
          return left.length === right.length && left.every((item, i) => item === right[i]);
        }
        return left === right;
      }
      if (node.op === '!=') {
        if (Array.isArray(left) && Array.isArray(right)) {
          return !(left.length === right.length && left.every((item, i) => item === right[i]));
        }
        return left !== right;
      }
      if (node.op === '<') {
        return (left as number) < (right as number);
      }
      if (node.op === '<=') {
        return (left as number) <= (right as number);
      }
      if (node.op === '>') {
        return (left as number) > (right as number);
      }
      if (node.op === '>=') {
        return (left as number) >= (right as number);
      }
      return undefined;
    }
  }
}

export function evaluateExpression(expr: string, context: ExprContext): unknown {
  const ast = parseExpression(expr);
  return evaluateAst(ast, context);
}

/**
 * Evaluates template expressions `{{ ... }}` in a string or data structure.
 * If the string is a single `{{ expr }}`, returns the raw evaluated value (preserving type).
 * In text with `{{ expr }}`, undefined or null renders as empty string.
 */
export function evaluateTemplate(template: string, context: ExprContext): unknown {
  const singleMatch = template.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
  if (singleMatch && singleMatch[1]) {
    return evaluateExpression(singleMatch[1], context);
  }

  return template.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (_match, expr) => {
    try {
      const val = evaluateExpression(expr, context);
      if (val === undefined || val === null) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val);
    } catch {
      return '';
    }
  });
}

/**
 * Deep template expansion for objects/arrays.
 */
export function evaluateDeepTemplates(value: unknown, context: ExprContext): unknown {
  if (typeof value === 'string') {
    return evaluateTemplate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => evaluateDeepTemplates(item, context));
  }
  if (value && typeof value === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      res[k] = evaluateDeepTemplates(v, context);
    }
    return res;
  }
  return value;
}

export interface ExtractedRefs {
  steps: string[];
  inputs: string[];
}

/**
 * Extracts referenced step IDs and input names from an expression or template string.
 */
export function extractReferencesFromText(text: string): ExtractedRefs {
  const steps = new Set<string>();
  const inputs = new Set<string>();

  const subExprs: string[] = [];
  const templateMatches = [...text.matchAll(/\{\{\s*([\s\S]+?)\s*\}\}/g)];
  if (templateMatches.length > 0) {
    for (const m of templateMatches) {
      if (m[1]) subExprs.push(m[1]);
    }
  } else {
    subExprs.push(text);
  }

  for (const expr of subExprs) {
    try {
      const ast = parseExpression(expr);
      walkAst(ast, (node) => {
        if (node.type === 'MemberAccess') {
          if (node.path[0] === 'steps' && node.path[1]) {
            steps.add(node.path[1]);
          } else if (node.path[0] === 'inputs' && node.path[1]) {
            inputs.add(node.path[1]);
          }
        }
      });
    } catch {
      // Regex fallback if syntax error
      for (const m of expr.matchAll(/steps\.([A-Za-z0-9_-]+)/g)) {
        if (m[1]) steps.add(m[1]);
      }
      for (const m of expr.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)) {
        if (m[1]) inputs.add(m[1]);
      }
    }
  }

  return { steps: [...steps], inputs: [...inputs] };
}

function walkAst(node: AstNode, visitor: (node: AstNode) => void): void {
  visitor(node);
  if (node.type === 'UnaryOp') {
    walkAst(node.arg, visitor);
  } else if (node.type === 'BinaryOp') {
    walkAst(node.left, visitor);
    walkAst(node.right, visitor);
  }
}
