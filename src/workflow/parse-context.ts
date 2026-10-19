/** The YAML and diagnostic helpers parse.ts and reads.ts share, kept apart so neither imports the other. */

import { isMap, isScalar, type LineCounter, type Node } from 'yaml';
import { fieldsText, schemaAt, stepFieldSchema, type ExpressionPath } from './expression.js';
import type { EndOutcome, OutputSchema, WorkflowDefinition, WorkflowDiagnostic } from './types.js';

export function isYamlNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'range' in value;
}

export function locate(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, message: string): WorkflowDiagnostic {
  let line = 1;
  let column = 1;
  const offset = node?.range?.[0];
  if (typeof offset === 'number') {
    const pos = lineCounter.linePos(offset);
    line = pos.line;
    column = pos.col;
  }
  return { file, line, column, field, message };
}

export function scalarString(node: Node | null | undefined): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value;
}

/** What the checks of one workflow file share: where a diagnostic points, where it goes, and what a sync knows of the other files. */
export interface ParseContext {
  file: string;
  lineCounter: LineCounter;
  diagnostics: WorkflowDiagnostic[];
  promptFileLocations: Record<string, { line: number; column: number }>;
  files: WorkflowFiles | undefined;
}

/** What a sync knows about the other workflow files, so a step that runs one can be checked against it. */
export interface WorkflowFiles {
  /** The version of `name` a step would run after this sync, or null when it has none. */
  runnable(name: string): WorkflowDefinition | null;
  /** The workflows running `name` from this file passes through until it runs this file again, such as ship -> check -> ship. */
  cycle(name: string): string[] | undefined;
}

/** What a reader may read of the workflow a step runs, and how a message names that workflow. */
export interface Child {
  label: string;
  outputs?: Record<string, string>;
  ends?: Record<string, EndOutcome>;
}

/** Why `path` reads an output the workflow its step runs does not declare, or undefined. A pass and a result have the same outputs. */
export function undeclaredOutput(children: Map<string, Child>, path: ExpressionPath): string | undefined {
  if (path.root !== 'steps') return undefined;
  const [index, field, name, nestedField, nestedName] = path.fields;
  const inPass = (path.field === 'passes' || path.field === 'results') && typeof index === 'number' && field === 'outputs';
  const inPassResult = path.field === 'passes' && typeof index === 'number' && field === 'results' && typeof name === 'number' && nestedField === 'outputs';
  const output = path.field === 'outputs' ? index : inPass ? name : inPassResult ? nestedName : undefined;
  if (output === undefined) return undefined;
  const child = children.get(path.step);
  if (!child || Object.hasOwn(child.outputs ?? {}, output)) return undefined;
  return `reads steps.${path.step}.${path.field}${fieldsText(path.fields)}, which is not an output ${child.label} declares`;
}

/** Why a step does not expose the field a path reads, shared by step reads and workflow outputs. */
export function unavailableField(path: ExpressionPath, forEach: boolean, choices?: string[]): string | undefined {
  if (path.root !== 'steps') return undefined;
  const inPass = path.field === 'passes' && typeof path.fields[0] === 'number';
  const field = inPass ? path.fields[1] : path.field;
  const step = `steps.${path.step}${inPass ? `.passes[${path.fields[0]}]` : ''}`;
  if (!choices && (field === 'choice' || field === 'note')) return `reads ${step}.${field}, but step "${path.step}" has no approve or choose, so it has no ${field}`;
  if (forEach && field === 'outputs') return `reads ${step}.outputs, but step "${path.step}" has for_each, so its outputs are in ${step}.results`;
  if (!forEach && field === 'results') return `reads ${step}.results, but step "${path.step}" has no for_each, so it has no results`;
  return undefined;
}

/** Why `path` reads what the `output` its step declares does not have, or undefined. */
export function undeclaredField(path: ExpressionPath, output: OutputSchema | undefined, forEach: boolean, choices?: string[]): string | undefined {
  if (path.root !== 'steps' || (path.field !== 'outputs' && path.field !== 'passes' && path.field !== 'results')) return undefined;
  const schema = stepFieldSchema(path.field, output, forEach, choices);
  if (!schema || schemaAt(schema, path.fields)) return undefined;
  const read = `steps.${path.step}.${path.field}${fieldsText(path.fields)}`;
  if (path.field === 'outputs') return `reads ${read}, which is not in the output step "${path.step}" declares`;
  return path.field === 'passes'
    ? `reads ${read}, which is not in a pass of step "${path.step}": pass, outcome, end, and ${forEach ? 'results with outputs as its output declares' : 'outputs as its output declares'}`
    : `reads ${read}, which is not in a result of step "${path.step}": item, outcome, and outputs as its output declares`;
}

export interface GraphNode {
  id: string;
  field: string;
  needs: string[];
  node: Node;
}

export function position(lineCounter: LineCounter, node: Node | null | undefined): { line: number; column: number } {
  const { line, column } = locate('', lineCounter, node, '', '');
  return { line, column };
}

/** Reports a YAML key whose meaning requires a newer CLI. */
export function unknownKey(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, key: string): WorkflowDiagnostic {
  return {
    ...locate(file, lineCounter, node, field, `${file} uses \`${key}\`, which this teamai does not know. Update teamai.`),
    code: 'unknown_key',
  };
}

/** Where a map's `key` is written: its value, or the key when the value is empty. */
export function valueNode(map: unknown, key: string): Node | undefined {
  const pair = isMap(map) ? map.items.find((item) => isScalar(item.key) && String(item.key.value) === key) : undefined;
  return isYamlNode(pair?.value) ? pair.value : isYamlNode(pair?.key) ? pair.key : undefined;
}
