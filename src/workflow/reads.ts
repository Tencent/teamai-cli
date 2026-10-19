import { isMap, type Node } from 'yaml';
import {
  evaluateExpression, expressionPaths, fieldsText, isTruthy, schemaAt, stepFieldSchema, typeProblems, type DeclaredType, type Expression, type ExpressionPath,
} from './expression.js';
import {
  isYamlNode, locate, position, scalarString, unavailableField, undeclaredField, undeclaredOutput, type Child, type GraphNode, type ParseContext,
} from './parse-context.js';
import { ancestors, stepLoops } from './loop.js';
import type { EndOutcome, OutputSchema, WorkflowDiagnostic, WorkflowStep } from './types.js';

export interface ConditionNode {
  id: string;
  field: string;
  node: Node;
  expression: Expression;
}

/** Reports an `if` that is always false, and queues what every other `if` reads for `readDiagnostics`. */
export function conditionDiagnostics({ file, lineCounter }: ParseContext, conditions: ConditionNode[], reads: ReadSite[]): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const condition of conditions) {
    const paths = expressionPaths(condition.expression);
    if (paths.length === 0 && !isTruthy(evaluateExpression(condition.expression, { steps: {} }))) {
      diagnostics.push({
        ...locate(file, lineCounter, condition.node, condition.field, `step "${condition.id}" if is always false, so the step never runs`),
        code: 'false_if',
      });
      continue;
    }
    reads.push(expressionSite(condition.id, condition.field, position(lineCounter, condition.node), 'if', [condition.expression]));
  }
  return diagnostics;
}

/** What an expression reads, or the expressions of one template, all checked as one `if` is. */
export function expressionSite(
  id: string,
  field: string,
  at: { line: number; column: number },
  what: string,
  expressions: Expression[],
  afterRun?: { code: WorkflowDiagnostic['code'] },
): ReadSite {
  return {
    id, field, at, what, paths: expressions.flatMap(expressionPaths), ends: expressions.flatMap(endComparisons), expressions,
    ...(afterRun ? { afterRun: true, code: afterRun.code } : {}),
  };
}

/** Where a step reads paths, in one of the fields `what` names. */
export interface ReadSite {
  /** The step whose ancestors the site may read: the reader, or the step that runs the inline workflow the reader is in. */
  id: string;
  /** The step that reads, when it is inside an inline workflow that `id` runs. */
  reader?: string;
  field: string;
  at: { line: number; column: number };
  /** `if`, `loop.while`, `break`, `for_each`, `prompt`, `prompt_file`, `with.<name>` or `env.<NAME>`. */
  what: string;
  paths: ExpressionPath[];
  /** The names an `if` compares a step's end with. */
  ends?: Array<{ step: string; end: string }>;
  /** The `if` itself, or each expression of a template, whose comparisons and lists are checked against the types its paths declare. */
  expressions: Expression[];
  /** The site is evaluated after its step succeeds, so it may read that step too. */
  afterRun?: boolean;
  /**
   * For a workflow's own `loop.while`, how messages name the workflow. It is evaluated after a round, so it may read
   * every step of the workflow, and `id` names no step.
   */
  workflow?: string;
  /** A template of a `for_each` step, rendered once per item, so it may read `item`. */
  item?: boolean;
  code?: WorkflowDiagnostic['code'];
}

/**
 * What a workflow lets a step read: its ancestors through `needs`, the steps after it in its own loop's range in their
 * previous pass, the output each step declares, and the declared inputs.
 */
export interface ReadScope {
  ids: Set<string>;
  ancestors: (id: string) => Set<string>;
  previous: (id: string) => Set<string>;
  outputs: Map<string, OutputSchema | undefined>;
  hitl: Map<string, string[]>;
  /** The steps with `for_each`, which have results in place of outputs. */
  forEach: Set<string>;
  /** Undefined when the inputs header is malformed, so `inputs.…` reads are not checked. */
  inputs?: OutputSchema;
  /** The workflow each workflow step runs: an inline one, or a file when a sync knows it. */
  children: Map<string, Child>;
  /** The workflow runs once per item of a `for_each` step, so every site in it may read `item`. */
  item?: boolean;
}

export function readScope(
  needs: Map<string, string[]>,
  steps: WorkflowStep[],
  inputs: Record<string, OutputSchema> | undefined,
  children: Map<string, Child>,
): ReadScope {
  return {
    children,
    hitl: new Map(steps.flatMap((step) => step.hitl ? [[step.id, step.hitl.options]] : [])),
    ids: new Set([...needs.keys(), ...steps.map((step) => step.id)]),
    ancestors: (id) => ancestors(needs, id),
    previous: stepLoops(steps).previous,
    outputs: new Map(steps.map((step) => [step.id, step.output])),
    forEach: new Set(steps.filter((step) => step.forEach).map((step) => step.id)),
    ...(inputs ? { inputs: { type: 'object', fields: inputs } } : {}),
  };
}

/**
 * Diagnostics for what each `if` and template reads: only declared inputs, only steps it needs,
 * directly or through their needs, and only output fields that a step with `output` declares.
 */
export function readDiagnostics(file: string, sites: ReadSite[], scope: ReadScope): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const site of sites) {
    const at = (message: string): WorkflowDiagnostic => ({
      file, ...site.at, field: site.field, message, ...(site.code ? { code: site.code } : {}),
    });
    const readable = site.workflow !== undefined ? scope.ids : new Set([
      ...scope.ancestors(site.id), ...scope.previous(site.id), ...(site.afterRun && site.reader === undefined ? [site.id] : []),
    ]);
    const subject = site.workflow ?? `step "${site.reader ?? site.id}"`;
    const reported = new Set<string>();
    let itemReported = false;
    for (const path of site.paths) {
      if (path.root === 'inputs') {
        if (scope.inputs && !schemaAt(scope.inputs, path.fields)) {
          diagnostics.push(at(`${subject} ${site.what} reads inputs${fieldsText(path.fields)}, which is not an input the workflow declares`));
        }
        continue;
      }
      if (path.root === 'item') {
        if (!site.item && !scope.item && !itemReported) {
          diagnostics.push(at(`${subject} ${site.what} reads item, which is bound only in the templates of a for_each step and in the workflow each item runs`));
        }
        itemReported = true;
        continue;
      }
      if (!readable.has(path.step)) {
        if (!reported.has(path.step)) {
          diagnostics.push(at(site.workflow !== undefined
            ? `${subject} ${site.what} reads steps.${path.step}, which is not one of its steps`
            : site.reader === undefined
              ? `${subject} ${site.what} reads steps.${path.step}, which is not a step it needs, directly or through its needs`
              : `${subject} ${site.what} reads steps.${path.step}, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs`));
        }
        reported.add(path.step);
        continue;
      }
      // A step pull rejected has its own diagnostic already.
      const unavailable = scope.outputs.has(path.step) && unavailableField(path, scope.forEach.has(path.step), scope.hitl.get(path.step));
      if (unavailable) {
        diagnostics.push(at(`${subject} ${site.what} ${unavailable}`));
        continue;
      }
      const undeclared = undeclaredOutput(scope.children, path);
      if (undeclared) {
        diagnostics.push({ ...at(`${subject} ${site.what} ${undeclared}`), code: 'undeclared_output' });
        continue;
      }
      const field = undeclaredField(path, scope.outputs.get(path.step), scope.forEach.has(path.step), scope.hitl.get(path.step));
      if (field) diagnostics.push(at(`${subject} ${site.what} ${field}`));
    }
    // A path this site does not list reads an enclosing workflow, which checks its type.
    const schemaOf = (path: ExpressionPath): DeclaredType | undefined => (site.paths.includes(path) ? declaredSchema(scope, readable, path) : undefined);
    for (const problem of site.expressions.flatMap((expression) => typeProblems(expression, schemaOf))) {
      diagnostics.push(at(`${subject} ${site.what} ${problem.message}`));
    }
    for (const expression of site.expressions) {
      for (const { step, value } of fieldComparisons(expression, 'choice')) {
        const options = readable.has(step) ? scope.hitl.get(step) : undefined;
        if (options && !options.includes(value)) diagnostics.push(at(`${subject} ${site.what} compares steps.${step}.choice with '${value}', which is not one of its options: ${options.join(', ')}`));
      }
    }
    for (const { step, end } of site.ends ?? []) {
      const child = readable.has(step) ? scope.children.get(step) : undefined;
      if (!child || Object.hasOwn(child.ends ?? {}, end)) continue;
      diagnostics.push({
        ...at(`${subject} ${site.what} compares steps.${step}.end with '${end}', which is not an end ${child.label} declares`),
        code: 'undeclared_end',
      });
    }
  }
  return diagnostics;
}

function declaredSchema(scope: ReadScope, readable: Set<string>, path: ExpressionPath): DeclaredType | undefined {
  if (path.root === 'inputs') return scope.inputs && schemaAt(scope.inputs, path.fields);
  if (path.root === 'item' || !readable.has(path.step)) return undefined;
  const schema = stepFieldSchema(path.field, scope.outputs.get(path.step), scope.forEach.has(path.step), scope.hitl.get(path.step));
  return schema && schemaAt(schema, path.fields);
}

/**
 * Splits what steps read into reads of their own workflow, and reads of steps that are not in it.
 * `ids` is undefined for a workflow file, whose steps can read nothing outside it.
 */
export function splitReads(sites: ReadSite[], ids: Set<string> | undefined): { local: ReadSite[]; outer: ReadSite[] } {
  const inside = (path: ExpressionPath): boolean => !ids || path.root !== 'steps' || ids.has(path.step);
  const endInside = ({ step }: { step: string }): boolean => !ids || ids.has(step);
  return {
    local: sites.map((site) => ({ ...site, paths: site.paths.filter(inside), ends: site.ends?.filter(endInside) })),
    outer: sites.flatMap((site) => {
      const paths = site.paths.filter((path) => !inside(path));
      return paths.length > 0 ? [{ ...site, paths, ends: site.ends?.filter((end) => !endInside(end)) }] : [];
    }),
  };
}

/** The names an expression compares a step's end with, as in `steps.check.end == 'ready'`. */
function endComparisons(expression: Expression): Array<{ step: string; end: string }> {
  return fieldComparisons(expression, 'end').map(({ step, value }) => ({ step, end: value }));
}

function fieldComparisons(expression: Expression, field: 'end' | 'choice'): Array<{ step: string; value: string }> {
  if (expression.kind === 'not') return fieldComparisons(expression.operand, field);
  if (expression.kind === 'call') return [...fieldComparisons(expression.list, field), ...(expression.name === 'length' ? [] : fieldComparisons(expression.predicate, field))];
  if (expression.kind !== 'binary') return [];
  if (expression.operator === '&&' || expression.operator === '||') return [...fieldComparisons(expression.left, field), ...fieldComparisons(expression.right, field)];
  const [read, value] = expression.left.kind === 'path' ? [expression.left, expression.right] : [expression.right, expression.left];
  if (read.kind !== 'path' || read.path.root !== 'steps' || read.path.field !== field) return [];
  return value.kind === 'literal' && typeof value.value === 'string' ? [{ step: read.path.step, value: value.value }] : [];
}

export interface Ending {
  id: string;
  field: string;
  end: string;
  node: Node;
  /** The step has no action and only ends the workflow. */
  only: boolean;
}

/** Diagnostics that keep `end` on steps consistent with the declared `ends`. */
export function endDiagnostics(
  { file, lineCounter }: ParseContext,
  ends: Record<string, EndOutcome> | undefined,
  endsNode: unknown,
  prefix: string,
  endings: Ending[],
  graph: GraphNode[],
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const endOnly = new Set(endings.filter((step) => step.only).map((step) => step.id));
  for (const step of graph) {
    for (const need of step.needs.filter((id) => endOnly.has(id))) {
      diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" needs "${need}", which only ends the workflow, so "${step.id}" can never run`));
    }
  }
  for (const step of endings) {
    if (!ends) {
      diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" ends with "${step.end}", but the workflow declares no ends`));
    } else if (!Object.hasOwn(ends, step.end)) {
      diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" ends with "${step.end}", which is not declared in ends`));
    }
  }
  if (isMap(endsNode)) {
    for (const pair of endsNode.items) {
      const name = scalarString(isYamlNode(pair.key) ? pair.key : undefined);
      if (!name || endings.some((step) => step.end === name)) continue;
      diagnostics.push(locate(file, lineCounter, isYamlNode(pair.key) ? pair.key : endsNode, `${prefix}ends.${name}`, `end "${name}" is declared in ends, but no step ends with it`));
    }
  }
  return diagnostics;
}
