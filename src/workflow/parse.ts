import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';

function isYamlNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'range' in value;
}
import { evaluateExpression, expressionPaths, isTruthy, parseExpression, type Expression, type ExpressionPath } from './expression.js';
import { findTemplate, parseTemplate, templatedTexts, templatePaths, templateWithPaths, type Template } from './template.js';
import type { EndOutcome, InlineWorkflow, OutputSchema, WorkflowDefinition, WorkflowDiagnostic, WorkflowStep } from './types.js';
import { STEP_ACTIONS } from './types.js';

const HEADER_KEYS = new Set(['schemaVersion', 'name', 'description', 'inputs', 'ends', 'outputs', 'steps']);
const ACTION_KEYS = Object.keys(STEP_ACTIONS);
const STEP_KEYS = new Set(['id', 'needs', 'if', ...ACTION_KEYS, 'env', 'with', 'agent', 'output', 'end']);
/** Keys a step without an action may carry. */
const END_ONLY_KEYS = new Set(['id', 'needs', 'if', 'end']);
/** The actions as a sentence: `command, prompt, prompt_file, or workflow`. */
const ACTION_LIST = `${ACTION_KEYS.slice(0, -1).join(', ')}, or ${ACTION_KEYS.at(-1)}`;
const TYPE_NAMES = new Set(['string', 'number', 'boolean']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: field "${diagnostic.field}": ${diagnostic.message}`;
}

function unknownKey(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, key: string): WorkflowDiagnostic {
  return {
    ...locate(file, lineCounter, node, field, `${file} uses \`${key}\`, which this teamai does not know. Update teamai.`),
    code: 'unknown_key',
  };
}

/** Paths such as `steps.<id>.outputs.<field>` split on ".", so a name that contains one could never be read. */
function dottedName(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, name: string): WorkflowDiagnostic {
  return { ...locate(file, lineCounter, node, field, `${name} cannot contain "."; a path reads "." as a separator`), code: 'dotted_name' };
}

function locate(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, message: string): WorkflowDiagnostic {
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

function scalarString(node: Node | null | undefined): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value;
}

/** Where a map's `key` is written: its value, or the key when the value is empty. */
function valueNode(map: unknown, key: string): Node | undefined {
  const pair = isMap(map) ? map.items.find((item) => isScalar(item.key) && String(item.key.value) === key) : undefined;
  return isYamlNode(pair?.value) ? pair.value : isYamlNode(pair?.key) ? pair.key : undefined;
}

/** What the checks of one workflow file share: where a diagnostic points, where it goes, and what a sync knows of the other files. */
interface ParseContext {
  file: string;
  lineCounter: LineCounter;
  diagnostics: WorkflowDiagnostic[];
  promptFileLocations: Record<string, { line: number; column: number }>;
  files: WorkflowFiles | undefined;
}

function parseOutput(node: Node, field: string, ctx: ParseContext): OutputSchema | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (isScalar(node)) {
    if (typeof node.value !== 'string') {
      diagnostics.push(locate(file, lineCounter, node, field, 'output shorthand must be string, number, boolean, a literal union, an object, or an array'));
      return undefined;
    }
    const parts = node.value.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length === 1 && TYPE_NAMES.has(parts[0])) {
      return { type: parts[0] as 'string' | 'number' | 'boolean' };
    }
    if (parts.length >= 2 && parts.every((part) => TOKEN.test(part) && !TYPE_NAMES.has(part))) {
      return { type: 'enum', values: parts };
    }
    diagnostics.push(locate(file, lineCounter, node, field, `unknown output type "${node.value}"`));
    return undefined;
  }
  if (isSeq(node)) {
    if (node.items.length !== 1) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an array shorthand has exactly one item type'));
      return undefined;
    }
    const item = node.items[0];
    if (!isYamlNode(item)) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an array shorthand has exactly one item type'));
      return undefined;
    }
    const items = parseOutput(item, `${field}[]`, ctx);
    return items ? { type: 'array', items } : undefined;
  }
  if (isMap(node)) {
    if (node.items.length === 0) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an object shorthand needs at least one field'));
      return undefined;
    }
    const fields: Record<string, OutputSchema> = {};
    for (const pair of node.items) {
      const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
      const valueNode = isYamlNode(pair.value) ? pair.value : undefined;
      const key = scalarString(keyNode);
      if (key?.includes('.')) {
        diagnostics.push(dottedName(file, lineCounter, keyNode, field, `field name "${key}"`));
        continue;
      }
      if (!key || !TOKEN.test(key) || !valueNode) {
        diagnostics.push(locate(file, lineCounter, keyNode ?? node, field, 'output field names must be tokens'));
        continue;
      }
      const child = parseOutput(valueNode, `${field}.${key}`, ctx);
      if (child) fields[key] = child;
    }
    return Object.keys(fields).length === node.items.length ? { type: 'object', fields } : undefined;
  }
  diagnostics.push(locate(file, lineCounter, node, field, 'output shorthand must be string, number, boolean, a literal union, an object, or an array'));
  return undefined;
}

/** What a sync knows about the other workflow files, so a step that runs one can be checked against it. */
export interface WorkflowFiles {
  /** The version of `name` a step would run after this sync, or null when it has none. */
  runnable(name: string): WorkflowDefinition | null;
  /** The workflows running `name` from this file passes through until it runs this file again, such as ship -> check -> ship. */
  cycle(name: string): string[] | undefined;
}

/**
 * Parse one workflow file. A failure is a list of diagnostics; it does not throw,
 * so one bad file cannot stop the rest of a sync. Without `files`, the file is checked on its own.
 */
export function parseWorkflow(file: string, content: string, files?: WorkflowFiles): {
  ok: true;
  definition: WorkflowDefinition;
  promptFileLocations: Record<string, { line: number; column: number }>;
} | { ok: false; diagnostics: WorkflowDiagnostic[] } {
  const diagnostics: WorkflowDiagnostic[] = [];
  const promptFileLocations: Record<string, { line: number; column: number }> = {};
  if (content.trim() === '') {
    return { ok: false, diagnostics: [{ file, line: 1, column: 1, field: '(root)', message: 'workflow file is empty' }] };
  }

  const lineCounter = new LineCounter();
  const ctx: ParseContext = { file, lineCounter, diagnostics, promptFileLocations, files };
  const doc = parseDocument(content, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const pos = lineCounter.linePos(error.pos[0] ?? 0);
      diagnostics.push({
        file,
        line: pos.line,
        column: pos.col,
        field: '(document)',
        message: error.message,
      });
    }
    return { ok: false, diagnostics };
  }

  const root = doc.contents;
  if (!isMap(root)) {
    return { ok: false, diagnostics: [locate(file, lineCounter, root, '(root)', 'workflow must be a YAML mapping')] };
  }

  for (const pair of root.items) {
    const key = scalarString(pair.key);
    if (!key || !HEADER_KEYS.has(key)) {
      diagnostics.push(unknownKey(file, lineCounter, pair.key ?? root, key ?? '(root)', key ?? '(root)'));
    }
  }

  const schemaPair = root.items.find((pair) => scalarString(pair.key) === 'schemaVersion');
  const schemaValue = scalarString(schemaPair?.value);
  if (schemaValue !== 'v1alpha1') {
    diagnostics.push(locate(file, lineCounter, schemaPair?.value ?? schemaPair?.key ?? root, 'schemaVersion', 'schemaVersion must be v1alpha1'));
  }

  const namePair = root.items.find((pair) => scalarString(pair.key) === 'name');
  const name = scalarString(namePair?.value);
  const fileName = file.slice(file.lastIndexOf('/') + 1).replace(/\.yaml$/, '');
  if (!name || !TOKEN.test(name)) {
    diagnostics.push(locate(file, lineCounter, namePair?.value ?? namePair?.key ?? root, 'name', 'name must be a non-empty token'));
  } else if (name !== fileName) {
    diagnostics.push(locate(file, lineCounter, namePair?.value ?? namePair?.key ?? root, 'name', `name must match the file name "${fileName}"`));
  }

  const descriptionPair = root.items.find((pair) => scalarString(pair.key) === 'description');
  const description = scalarString(descriptionPair?.value)?.trim();
  if (!description) {
    diagnostics.push(locate(file, lineCounter, descriptionPair?.value ?? descriptionPair?.key ?? root, 'description', 'description must be a non-empty string'));
  }

  const inputsPair = root.items.find((pair) => scalarString(pair.key) === 'inputs');
  let inputs: Record<string, OutputSchema> | undefined;
  if (inputsPair && !isMap(inputsPair.value)) {
    diagnostics.push(locate(file, lineCounter, inputsPair.value ?? inputsPair.key ?? root, 'inputs', 'inputs must map each input name to a type'));
  } else if (inputsPair) {
    const schema = parseOutput(inputsPair.value as Node, 'inputs', ctx);
    if (schema?.type === 'object') inputs = schema.fields;
  }

  // A malformed inputs header is already reported; checking reads against it would only add noise.
  const { workflow: { ends, outputs, steps } } = parseBody(root, '', ctx, inputsPair && !inputs ? undefined : inputs ?? {});

  if (diagnostics.length > 0 || !name || !description) return { ok: false, diagnostics };
  return {
    ok: true,
    definition: { schemaVersion: 'v1alpha1', name, description, ...(inputs ? { inputs } : {}), ...(ends ? { ends } : {}), ...(outputs ? { outputs } : {}), steps },
    promptFileLocations,
  };
}

/**
 * The `ends`, `outputs`, and `steps` of a workflow file, or of an inline workflow whose fields start with `at`.
 * An inline workflow returns, in `outer`, what its steps read of enclosing steps, for the enclosing workflow to check.
 */
function parseBody(
  root: YAMLMap.Parsed,
  at: string,
  ctx: ParseContext,
  inputs: Record<string, OutputSchema> | undefined,
): { workflow: InlineWorkflow; outer: ReadSite[] } {
  const { file, lineCounter, diagnostics, promptFileLocations, files } = ctx;
  const endsPair = root.items.find((pair) => scalarString(pair.key) === 'ends');
  const ends = endsPair ? parseEnds(endsPair.value ?? endsPair.key, at, ctx) : undefined;

  const outputsPair = root.items.find((pair) => scalarString(pair.key) === 'outputs');
  const outputEntries = outputsPair ? parseOutputs(outputsPair.value ?? outputsPair.key, at, ctx) : undefined;
  const outputs = outputEntries && Object.fromEntries(outputEntries.map((entry) => [entry.name, entry.source]));

  const stepsPair = root.items.find((pair) => scalarString(pair.key) === 'steps');
  const stepsNode = stepsPair?.value;
  const steps: WorkflowStep[] = [];
  let outer: ReadSite[] = [];
  if (!isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode ?? stepsPair?.key ?? root, `${at}steps`, 'steps must be a non-empty list'));
  } else {
    const seen = new Set<string>();
    const graph: GraphNode[] = [];
    const conditions: ConditionNode[] = [];
    const reads: ReadSite[] = [];
    const endings: Ending[] = [];
    const references: Array<{ id: string; workflow: string }> = [];
    stepsNode.items.forEach((item, index) => {
      const field = `${at}steps[${index}]`;
      if (!isMap(item)) {
        diagnostics.push(locate(file, lineCounter, item, field, 'a step must be a mapping with exactly one action'));
        return;
      }
      for (const pair of item.items) {
        const key = scalarString(pair.key);
        if (!key || !STEP_KEYS.has(key)) {
          diagnostics.push(unknownKey(file, lineCounter, pair.key ?? item, `${field}.${key ?? 'key'}`, key ?? 'key'));
        }
      }
      const idPair = item.items.find((pair) => scalarString(pair.key) === 'id');
      const id = scalarString(idPair?.value)?.trim();
      if (!id || !TOKEN.test(id)) {
        diagnostics.push(locate(file, lineCounter, idPair?.value ?? idPair?.key ?? item, `${field}.id`, 'id must be a non-empty token'));
      } else if (seen.has(id)) {
        diagnostics.push(locate(file, lineCounter, idPair?.value ?? item, `${field}.id`, `step id "${id}" is duplicated`));
      } else {
        seen.add(id);
        if (id.includes('.')) diagnostics.push(dottedName(file, lineCounter, idPair?.value, `${field}.id`, `step id "${id}"`));
      }
      const label = id ? `step "${id}"` : field;
      const needsPair = item.items.find((pair) => scalarString(pair.key) === 'needs');
      let needs: string[] | undefined;
      if (needsPair) {
        const values = isSeq(needsPair.value) ? needsPair.value.items.map((need) => scalarString(isYamlNode(need) ? need : undefined)) : [];
        if (!isSeq(needsPair.value) || values.some((need) => !need || !TOKEN.test(need))) {
          diagnostics.push(locate(file, lineCounter, needsPair.value ?? needsPair.key ?? item, `${field}.needs`, `${label} needs must be a list of step ids`));
        } else {
          needs = values as string[];
          if (id && TOKEN.test(id)) graph.push({ id, field: `${field}.needs`, needs, node: needsPair.value as Node });
        }
      } else if (index > 0) {
        diagnostics.push({
          ...locate(file, lineCounter, item, `${field}.needs`, `${label} must declare needs; use needs: [] for another root`),
          code: 'missing_needs',
        });
      }
      // A step with a malformed id or missing needs is already reported; checking what it reads would only add noise.
      const inGraph = id !== undefined && TOKEN.test(id) && (needs !== undefined || index === 0);
      const ifPair = item.items.find((pair) => scalarString(pair.key) === 'if');
      const condition = ifPair ? conditionSource(ifPair.value) : undefined;
      if (ifPair) {
        const parsed = condition === undefined ? undefined : parseExpression(condition);
        const at = ifPair.value ?? ifPair.key ?? item;
        if (!parsed) {
          diagnostics.push(locate(file, lineCounter, at, `${field}.if`, `${label} if must be an expression`));
        } else if (!parsed.ok) {
          diagnostics.push(locate(file, lineCounter, at, `${field}.if`, `${label} if does not parse at column ${parsed.column}: ${parsed.message}`));
        } else if (inGraph) {
          conditions.push({ id, field: `${field}.if`, node: at as Node, expression: parsed.expression });
        }
      }
      const commandPair = item.items.find((pair) => scalarString(pair.key) === 'command');
      const command = scalarString(commandPair?.value);
      const promptPair = item.items.find((pair) => scalarString(pair.key) === 'prompt');
      const prompt = scalarString(promptPair?.value);
      const promptFilePair = item.items.find((pair) => scalarString(pair.key) === 'prompt_file');
      const promptFile = scalarString(promptFilePair?.value);
      const workflowPair = item.items.find((pair) => scalarString(pair.key) === 'workflow');
      const workflow = scalarString(workflowPair?.value)?.trim();
      const inline = isMap(workflowPair?.value)
        ? parseInline(workflowPair.value, `${field}.workflow`, label, ctx, inputs)
        : undefined;
      const actions = ACTION_KEYS.map((key) => item.items.find((pair) => scalarString(pair.key) === key)).filter(Boolean);
      const endPair = item.items.find((pair) => scalarString(pair.key) === 'end');
      const end = scalarString(endPair?.value)?.trim();
      if (endPair && (!end || !TOKEN.test(end))) {
        diagnostics.push(locate(file, lineCounter, endPair.value ?? endPair.key ?? item, `${field}.end`, `${label} end must be a name from ends`));
      } else if (endPair && end && id && TOKEN.test(id)) {
        endings.push({ id, field: `${field}.end`, end, node: endPair.value as Node, only: actions.length === 0 });
      }
      if (endPair && actions.length === 0) {
        for (const pair of item.items) {
          const key = scalarString(pair.key);
          if (!key || !STEP_KEYS.has(key) || END_ONLY_KEYS.has(key)) continue;
          diagnostics.push(locate(file, lineCounter, pair.key as Node, `${field}.${key}`, `${label} has no action, so it carries only id, needs, if, and end`));
        }
      }
      if (actions.length > 1 || (actions.length === 0 && !endPair)) {
        diagnostics.push(locate(file, lineCounter, item, field, `a step has exactly one action: ${ACTION_LIST}`));
      }
      if (workflowPair && !inline && (!workflow || !TOKEN.test(workflow))) {
        diagnostics.push(locate(file, lineCounter, workflowPair.value ?? workflowPair.key ?? item, `${field}.workflow`, `${label} workflow must be the name of a workflow in workflows/`));
      }
      if (commandPair && (command === undefined || command.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, commandPair?.value ?? commandPair?.key ?? item, `${field}.command`, 'command must be a non-empty string'));
      }
      const commandTemplate = command === undefined ? undefined : findTemplate(command);
      if (commandTemplate !== undefined) {
        diagnostics.push(locate(file, lineCounter, commandPair?.value as Node, `${field}.command`,
          `${label} command contains ${commandTemplate}; command strings are not templated; pass the value through env:`));
      }
      if (promptPair && (prompt === undefined || prompt.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, promptPair.value ?? promptPair.key ?? item, `${field}.prompt`, 'prompt must be a non-empty string'));
      }
      if (promptFilePair) {
        if (!isPromptFilePath(promptFile)) {
          diagnostics.push(locate(file, lineCounter, promptFilePair.value ?? promptFilePair.key ?? item, `${field}.prompt_file`, 'prompt_file must be a relative path under prompts/'));
        } else if (isYamlNode(promptFilePair.value)) {
          const position = locate(file, lineCounter, promptFilePair.value, `${field}.prompt_file`, '');
          promptFileLocations[field] = { line: position.line, column: position.column };
        }
      }
      const agentPair = item.items.find((pair) => scalarString(pair.key) === 'agent');
      const agent = scalarString(agentPair?.value)?.trim();
      if (agentPair && (!agent || !TOKEN.test(agent))) {
        diagnostics.push(locate(file, lineCounter, agentPair.value ?? agentPair.key ?? item, `${field}.agent`, 'agent must be a non-empty token'));
      } else if (agentPair && (commandPair || workflowPair)) {
        diagnostics.push(locate(file, lineCounter, agentPair.key ?? item, `${field}.agent`, 'agent is only allowed on a prompt or prompt_file step'));
      }
      const envPair = item.items.find((pair) => scalarString(pair.key) === 'env');
      const env = envPair ? parseEnv(envPair.value ?? envPair.key, `${field}.env`, label, ctx) : undefined;
      const withPair = item.items.find((pair) => scalarString(pair.key) === 'with');
      let withValues: Record<string, unknown> | undefined;
      // A step with no action already reports every key it may not carry.
      if (withPair && commandPair) {
        diagnostics.push(locate(file, lineCounter, withPair.key as Node, `${field}.with`, `${label} with is not allowed on a command step; pass values through env:`));
      } else if (withPair && inline) {
        diagnostics.push(locate(file, lineCounter, withPair.key as Node, `${field}.with`,
          `${label} with is not allowed on an inline workflow; its steps read the enclosing inputs and steps`));
      } else if (withPair && actions.length > 0) {
        if (!isMap(withPair.value) || withPair.value.items.length === 0) {
          const what = workflowPair ? "the workflow's inputs" : 'names';
          diagnostics.push(locate(file, lineCounter, withPair.value ?? withPair.key ?? item, `${field}.with`, `${label} with must map ${what} to values`));
        } else {
          withValues = withPair.value.toJSON() as Record<string, unknown>;
        }
      }
      if (workflowPair && workflow && TOKEN.test(workflow) && id && TOKEN.test(id)) references.push({ id, workflow });
      if (workflowPair && workflow && TOKEN.test(workflow) && files) {
        // A malformed with is already reported, so its keys are not compared.
        const keys = !withPair ? [] : withValues && isMap(withPair.value)
          ? withPair.value.items.map((pair) => ({ name: isScalar(pair.key) ? String(pair.key.value) : '', node: pair.key as Node }))
          : undefined;
        diagnostics.push(...referenceDiagnostics(ctx, files, {
          label, field, workflow, node: workflowPair.value as Node, with: keys && { node: (withPair?.key ?? workflowPair.value) as Node, keys },
        }));
      }
      const templates = templatedTexts({ prompt, env, with: withValues }).map(({ what, text }) => {
        const name = what.slice(what.indexOf('.') + 1);
        const node = what === 'prompt' ? promptPair?.value : valueNode(what.startsWith('with.') ? withPair?.value : envPair?.value, name);
        return { what, field: `${field}.${what}`, node: node as Node, text };
      });
      for (const template of templates) {
        const parsed = parseTemplate(template.text);
        if (!parsed.ok) {
          for (const problem of parsed.errors) {
            diagnostics.push({
              ...locate(file, lineCounter, template.node, template.field, `${label} ${template.what} template ${problem.source}: ${problem.message}`),
              code: 'bad_template',
            });
          }
        }
        // A malformed with is already reported; checking the prompt's reads against it would only add noise.
        if (parsed.ok && !(template.what === 'prompt' && withPair && !withValues)) {
          for (const problem of withReadProblems(label, template.what, parsed.template, withValues)) {
            diagnostics.push({ ...locate(file, lineCounter, template.node, template.field, problem), code: 'bad_template' });
          }
        }
        if (inGraph && parsed.ok) {
          reads.push({ id, field: template.field, at: position(lineCounter, template.node), what: template.what, paths: templatePaths(parsed.template), code: 'bad_template' });
        }
      }
      // What the inline workflow reads of this workflow's steps must be steps this step needs, directly or not.
      if (inline && inGraph) {
        reads.push(...inline.outer.map((site) => ({ ...site, id, reader: site.reader ?? site.id })));
      }
      // A step with no action already reports every key it may not carry.
      if (envPair && !commandPair && actions.length > 0) {
        diagnostics.push(locate(file, lineCounter, envPair.key as Node, `${field}.env`, `${label} env is only allowed on a command step`));
      }
      let output: OutputSchema | undefined;
      const outputPair = item.items.find((pair) => scalarString(pair.key) === 'output');
      if (outputPair && workflowPair) {
        diagnostics.push(locate(file, lineCounter, outputPair.key as Node, `${field}.output`, `${label} output is not allowed on a workflow step; declare outputs in the workflow it runs`));
      } else if (outputPair?.value) {
        output = parseOutput(outputPair.value, `${field}.output`, ctx);
      } else if (outputPair) {
        diagnostics.push(locate(file, lineCounter, outputPair.key ?? item, `${field}.output`, 'output must be a shorthand type'));
      }
      if (id && TOKEN.test(id) && (actions.length === 1 || endPair) && !diagnostics.some((d) => d.field === field || d.field.startsWith(`${field}.`))) {
        steps.push({
          id,
          ...(needs ? { needs } : {}),
          ...(condition !== undefined ? { if: condition } : {}),
          ...(command ? { command } : {}),
          ...(env ? { env } : {}),
          ...(prompt ? { prompt } : {}),
          ...(promptFile ? { promptFile } : {}),
          ...(inline ? { workflow: inline.workflow } : {}),
          ...(workflow ? { workflow } : {}),
          ...(withValues ? { with: withValues } : {}),
          ...(agent ? { agent } : {}),
          ...(output ? { output } : {}),
          ...(end ? { end } : {}),
        });
      }
    });
    diagnostics.push(...graphDiagnostics(ctx, graph, seen));
    diagnostics.push(...conditionDiagnostics(ctx, conditions, reads));
    const needsById = new Map(graph.map((step) => [step.id, step.needs]));
    // An inline workflow that is reported has no step here, so reads of it are not checked.
    const children = childrenOf([...references, ...steps.filter((step) => typeof step.workflow === 'object')], files);
    // A malformed inputs header is already reported; checking reads against it would only add noise.
    // An inline workflow's reads of steps that are not its own are checked by the workflow around it.
    const split = splitReads(reads, at === '' ? undefined : seen);
    outer = split.outer;
    diagnostics.push(...readDiagnostics(file, split.local, readScope(needsById, steps, inputs, children)));
    // A malformed ends header is already reported; checking steps against it would only add noise.
    if (!endsPair || ends) diagnostics.push(...endDiagnostics(ctx, ends, endsPair?.value, at, endings, graph));
    diagnostics.push(...outputDiagnostics(ctx, outputEntries ?? [], at, seen, steps, children));
  }
  return { workflow: { ...(ends ? { ends } : {}), ...(outputs ? { outputs } : {}), steps }, outer };
}

/** An inline `workflow: { steps, outputs?, ends? }`. It reads the enclosing inputs and steps, so it declares no inputs. */
function parseInline(
  node: YAMLMap.Parsed,
  field: string,
  label: string,
  ctx: ParseContext,
  inputs: Record<string, OutputSchema> | undefined,
): { workflow: InlineWorkflow; outer: ReadSite[] } {
  const { file, lineCounter, diagnostics } = ctx;
  for (const pair of node.items) {
    const key = scalarString(pair.key);
    if (key === 'steps' || key === 'outputs' || key === 'ends') continue;
    if (!key || !HEADER_KEYS.has(key)) {
      diagnostics.push(unknownKey(file, lineCounter, pair.key ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
    } else if (key === 'inputs') {
      diagnostics.push(locate(file, lineCounter, pair.key, `${field}.inputs`, `${label} runs an inline workflow, which declares no inputs; its steps read the enclosing workflow's inputs`));
    } else {
      diagnostics.push(locate(file, lineCounter, pair.key, `${field}.${key}`, `${label} runs an inline workflow, which carries only steps, outputs, and ends`));
    }
  }
  return parseBody(node, `${field}.`, ctx, inputs);
}

/**
 * Splits what steps read into reads of their own workflow, and reads of steps that are not in it.
 * `ids` is undefined for a workflow file, whose steps can read nothing outside it.
 */
function splitReads(sites: ReadSite[], ids: Set<string> | undefined): { local: ReadSite[]; outer: ReadSite[] } {
  const inside = (path: ExpressionPath): boolean => !ids || path.root === 'inputs' || ids.has(path.step);
  const endInside = ({ step }: { step: string }): boolean => !ids || ids.has(step);
  return {
    local: sites.map((site) => ({ ...site, paths: site.paths.filter(inside), ends: site.ends?.filter(endInside) })),
    outer: sites.flatMap((site) => {
      const paths = site.paths.filter((path) => !inside(path));
      return paths.length > 0 ? [{ ...site, paths, ends: site.ends?.filter((end) => !endInside(end)) }] : [];
    }),
  };
}

/** A step that runs a workflow file by name. */
interface Reference {
  label: string;
  field: string;
  workflow: string;
  node: Node;
  /** The keys `with` passes, and where to report a missing one. Undefined when `with` is malformed. */
  with?: { node: Node; keys: Array<{ name: string; node: Node }> };
}

/** Diagnostics for a step that runs a workflow file, checked against the version that step would run. */
function referenceDiagnostics({ file, lineCounter }: ParseContext, files: WorkflowFiles, reference: Reference): WorkflowDiagnostic[] {
  const { label, field, workflow, node } = reference;
  const cycle = files.cycle(workflow);
  if (cycle) return [locate(file, lineCounter, node, `${field}.workflow`, `${label} runs workflow "${workflow}" in a cycle: ${cycle.join(' -> ')}`)];
  const child = files.runnable(workflow);
  if (!child) {
    return [locate(file, lineCounter, node, `${field}.workflow`,
      `${label} runs workflow "${workflow}", which has no runnable version; fix or add workflows/${workflow}.yaml`)];
  }
  if (!reference.with) return [];
  const inputs = child.inputs ?? {};
  const passed = new Set(reference.with.keys.map((key) => key.name));
  return [
    ...Object.keys(inputs).filter((name) => !passed.has(name)).map((name) => locate(file, lineCounter, reference.with?.node, `${field}.with`,
      `${label} with does not pass input "${name}", which workflow "${workflow}" declares`)),
    ...reference.with.keys.filter((key) => !Object.hasOwn(inputs, key.name)).map((key) => locate(file, lineCounter, key.node, `${field}.with.${key.name}`,
      `${label} with.${key.name} is not an input workflow "${workflow}" declares`)),
  ];
}

/** What a reader may read of the workflow a step runs, and how a message names that workflow. */
interface Child {
  label: string;
  outputs?: Record<string, string>;
  ends?: Record<string, EndOutcome>;
}

/**
 * The workflow each step runs: an inline one as written, a file as a sync knows it.
 * A step whose reference is reported has none, so its reads are not checked.
 */
function childrenOf(steps: Array<{ id: string; workflow?: string | InlineWorkflow }>, files: WorkflowFiles | undefined): Map<string, Child> {
  const children = new Map<string, Child>();
  for (const { id, workflow } of steps) {
    if (typeof workflow === 'object') {
      children.set(id, { label: `the inline workflow of step "${id}"`, outputs: workflow.outputs, ends: workflow.ends });
      continue;
    }
    if (!files || workflow === undefined || files.cycle(workflow)) continue;
    const child = files.runnable(workflow);
    if (child) children.set(id, { label: `workflow "${child.name}"`, outputs: child.outputs, ends: child.ends });
  }
  return children;
}

/** Why `path` reads an output the workflow its step runs does not declare, or undefined. */
function undeclaredOutput(children: Map<string, Child>, path: ExpressionPath): string | undefined {
  if (path.root !== 'steps' || path.field !== 'outputs' || path.fields.length === 0) return undefined;
  const child = children.get(path.step);
  if (!child || Object.hasOwn(child.outputs ?? {}, path.fields[0]!)) return undefined;
  return `reads steps.${path.step}.outputs.${path.fields.join('.')}, which is not an output ${child.label} declares`;
}

/** `env` maps variable names to text. A YAML number or boolean is read as its text. */
function parseEnv(node: Node | null | undefined, field: string, label: string, ctx: ParseContext): Record<string, string> | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node) || node.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, node, field, `${label} env must map variable names to values`));
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const name = isScalar(keyNode) ? String(keyNode.value) : undefined;
    if (name === undefined || !ENV_NAME.test(name)) {
      diagnostics.push(locate(file, lineCounter, keyNode ?? node, `${field}.${name ?? 'key'}`, `${label} env name "${name ?? ''}" must match ${ENV_NAME.source}`));
      continue;
    }
    const value: unknown = isScalar(pair.value) ? pair.value.value : undefined;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      const at = isYamlNode(pair.value) ? pair.value : isYamlNode(pair.key) ? pair.key : node;
      diagnostics.push(locate(file, lineCounter, at, `${field}.${name}`, `${label} env.${name} must be a string, number, or boolean`));
      continue;
    }
    env[name] = String(value);
  }
  return Object.keys(env).length === node.items.length ? env : undefined;
}

function parseEnds(node: Node | null | undefined, prefix: string, ctx: ParseContext): Record<string, EndOutcome> | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node) || node.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, node, `${prefix}ends`, 'ends must map each end name to succeeded or failed'));
    return undefined;
  }
  const ends: Record<string, EndOutcome> = {};
  for (const pair of node.items) {
    const name = scalarString(isYamlNode(pair.key) ? pair.key : undefined);
    const outcome = scalarString(isYamlNode(pair.value) ? pair.value : undefined);
    if (!name || !TOKEN.test(name) || (outcome !== 'succeeded' && outcome !== 'failed')) {
      const at = isYamlNode(pair.value) ? pair.value : isYamlNode(pair.key) ? pair.key : node;
      diagnostics.push(locate(file, lineCounter, at, `${prefix}ends.${name ?? 'key'}`, 'ends must map each end name to succeeded or failed'));
      continue;
    }
    ends[name] = outcome;
  }
  return Object.keys(ends).length === node.items.length ? ends : undefined;
}

const OUTPUT_PATH = 'such as steps.<id>.outputs.<field>';

/** One `outputs` entry: the name, the path as written, and what it reads. */
interface OutputEntry {
  name: string;
  source: string;
  node: Node;
  path: ExpressionPath;
}

/** `outputs` maps names to paths that read this workflow's steps. Returns the well-formed entries; the others are reported. */
function parseOutputs(node: Node | null | undefined, prefix: string, ctx: ParseContext): OutputEntry[] {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node) || node.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, node, `${prefix}outputs`, `outputs must map each name to a path ${OUTPUT_PATH}`));
    return [];
  }
  const entries: OutputEntry[] = [];
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const name = scalarString(keyNode);
    if (name?.includes('.')) {
      diagnostics.push(dottedName(file, lineCounter, keyNode, `${prefix}outputs`, `output name "${name}"`));
      continue;
    }
    if (!name || !TOKEN.test(name)) {
      diagnostics.push(locate(file, lineCounter, keyNode ?? node, `${prefix}outputs`, 'output names must be tokens'));
      continue;
    }
    const valueNode = isYamlNode(pair.value) ? pair.value : undefined;
    const source = scalarString(valueNode);
    const parsed = source === undefined ? undefined : parseExpression(source);
    if (source === undefined || !parsed?.ok || parsed.expression.kind !== 'path' || parsed.expression.path.root !== 'steps') {
      diagnostics.push(locate(file, lineCounter, valueNode ?? keyNode, `${prefix}outputs.${name}`, `output "${name}" must be a path that reads a step, ${OUTPUT_PATH}`));
      continue;
    }
    entries.push({ name, source, node: valueNode as Node, path: parsed.expression.path });
  }
  return entries;
}

/** Each output reads a step of this workflow, and only a field that step's `output`, or the workflow it runs, declares. */
function outputDiagnostics(
  { file, lineCounter }: ParseContext,
  entries: OutputEntry[],
  prefix: string,
  ids: Set<string>,
  steps: WorkflowStep[],
  children: Map<string, Child>,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const { name, node, path } of entries) {
    if (path.root !== 'steps') continue;
    const at = (message: string): WorkflowDiagnostic => locate(file, lineCounter, node, `${prefix}outputs.${name}`, `output "${name}" ${message}`);
    if (!ids.has(path.step)) {
      diagnostics.push(at(`reads steps.${path.step}, which is not a step in this workflow`));
      continue;
    }
    const undeclared = undeclaredOutput(children, path);
    if (undeclared) {
      diagnostics.push({ ...at(undeclared), code: 'undeclared_output' });
      continue;
    }
    const output = steps.find((step) => step.id === path.step)?.output;
    if (path.field === 'outputs' && output && !declaresField(output, path.fields)) {
      diagnostics.push(at(`reads steps.${path.step}.outputs.${path.fields.join('.')}, which is not in the output step "${path.step}" declares`));
    }
  }
  return diagnostics;
}

interface GraphNode {
  id: string;
  field: string;
  needs: string[];
  node: Node;
}

/** Diagnostics for the `needs` graph: ids that name no step, and cycles reported at their first declared step. */
function graphDiagnostics({ file, lineCounter }: ParseContext, graph: GraphNode[], ids: Set<string>): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const step of graph) {
    for (const need of step.needs) {
      if (!ids.has(need)) {
        diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" needs "${need}", which is not a step in this workflow`));
      }
    }
  }

  const byId = new Map(graph.map((step) => [step.id, step]));
  const order = new Map(graph.map((step, index) => [step.id, index]));
  const visited = new Map<string, 'open' | 'closed'>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string): void => {
    visited.set(id, 'open');
    path.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (visited.get(need) === 'open') cycles.push(path.slice(path.indexOf(need)));
      else if (!visited.has(need) && byId.has(need)) visit(need);
    }
    path.pop();
    visited.set(id, 'closed');
  };
  for (const step of graph) if (!visited.has(step.id)) visit(step.id);

  const first = (cycle: string[]): number => Math.min(...cycle.map((id) => order.get(id) ?? 0));
  for (const cycle of cycles.sort((left, right) => first(left) - first(right))) {
    const start = cycle.findIndex((id) => order.get(id) === first(cycle));
    const ids = [...cycle.slice(start), ...cycle.slice(0, start)];
    const step = byId.get(ids[0] ?? '');
    if (!step) continue;
    diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" is in a needs cycle: ${[...ids, step.id].join(' -> ')}`));
  }
  return diagnostics;
}

/** The text of an `if`. A YAML boolean or number is read as the same literal, so `if: false` is the expression `false`. */
function conditionSource(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  const value: unknown = node.value;
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' ? String(value) : undefined;
}

interface ConditionNode {
  id: string;
  field: string;
  node: Node;
  expression: Expression;
}

/** Whether `fields` names a value inside `schema`. Only object fields can be read further. */
function declaresField(schema: OutputSchema, fields: string[]): boolean {
  let current = schema;
  for (const field of fields) {
    if (current.type !== 'object' || !Object.hasOwn(current.fields, field)) return false;
    current = current.fields[field]!;
  }
  return true;
}

/** Reports an `if` that is always false, and queues what every other `if` reads for `readDiagnostics`. */
function conditionDiagnostics({ file, lineCounter }: ParseContext, conditions: ConditionNode[], reads: ReadSite[]): WorkflowDiagnostic[] {
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
    reads.push({ id: condition.id, field: condition.field, at: position(lineCounter, condition.node), what: 'if', paths, ends: endComparisons(condition.expression) });
  }
  return diagnostics;
}

function position(lineCounter: LineCounter, node: Node | null | undefined): { line: number; column: number } {
  const { line, column } = locate('', lineCounter, node, '', '');
  return { line, column };
}

/** Where a step reads paths: its `if`, its prompt, or one `env` value. */
interface ReadSite {
  /** The step whose ancestors the site may read: the reader, or the step that runs the inline workflow the reader is in. */
  id: string;
  /** The step that reads, when it is inside an inline workflow that `id` runs. */
  reader?: string;
  field: string;
  at: { line: number; column: number };
  /** `if`, `prompt`, `prompt_file` or `env.<NAME>`. */
  what: string;
  paths: ExpressionPath[];
  /** The names an `if` compares a step's end with. */
  ends?: Array<{ step: string; end: string }>;
  code?: WorkflowDiagnostic['code'];
}

/** What a workflow lets a step read: its ancestors through `needs`, the output each step declares, and the declared inputs. */
interface ReadScope {
  ancestors: (id: string) => Set<string>;
  outputs: Map<string, OutputSchema | undefined>;
  /** Undefined when the inputs header is malformed, so `inputs.…` reads are not checked. */
  inputs?: OutputSchema;
  /** The workflow each workflow step runs: an inline one, or a file when a sync knows it. */
  children: Map<string, Child>;
}

function readScope(
  needs: Map<string, string[]>,
  steps: WorkflowStep[],
  inputs: Record<string, OutputSchema> | undefined,
  children: Map<string, Child>,
): ReadScope {
  return {
    children,
    ancestors: (id) => {
      const found = new Set<string>();
      const pending = [...(needs.get(id) ?? [])];
      for (let need = pending.pop(); need !== undefined; need = pending.pop()) {
        if (found.has(need)) continue;
        found.add(need);
        pending.push(...(needs.get(need) ?? []));
      }
      return found;
    },
    outputs: new Map(steps.map((step) => [step.id, step.output])),
    ...(inputs ? { inputs: { type: 'object', fields: inputs } } : {}),
  };
}

/**
 * Diagnostics for what each `if` and template reads: only declared inputs, only steps it needs,
 * directly or through their needs, and only output fields that a step with `output` declares.
 */
function readDiagnostics(file: string, sites: ReadSite[], scope: ReadScope): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const site of sites) {
    const at = (message: string): WorkflowDiagnostic => ({
      file, ...site.at, field: site.field, message, ...(site.code ? { code: site.code } : {}),
    });
    const readable = scope.ancestors(site.id);
    const reader = site.reader ?? site.id;
    const reported = new Set<string>();
    for (const path of site.paths) {
      if (path.root === 'inputs') {
        if (scope.inputs && !declaresField(scope.inputs, path.fields)) {
          diagnostics.push(at(`step "${reader}" ${site.what} reads inputs.${path.fields.join('.')}, which is not an input the workflow declares`));
        }
        continue;
      }
      if (!readable.has(path.step)) {
        if (!reported.has(path.step)) {
          diagnostics.push(at(site.reader === undefined
            ? `step "${reader}" ${site.what} reads steps.${path.step}, which is not a step it needs, directly or through its needs`
            : `step "${reader}" ${site.what} reads steps.${path.step}, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs`));
        }
        reported.add(path.step);
        continue;
      }
      const undeclared = undeclaredOutput(scope.children, path);
      if (undeclared) {
        diagnostics.push({ ...at(`step "${reader}" ${site.what} ${undeclared}`), code: 'undeclared_output' });
        continue;
      }
      const output = scope.outputs.get(path.step);
      if (path.field === 'outputs' && output && !declaresField(output, path.fields)) {
        diagnostics.push(at(`step "${reader}" ${site.what} reads steps.${path.step}.outputs.${path.fields.join('.')}, which is not in the output step "${path.step}" declares`));
      }
    }
    for (const { step, end } of site.ends ?? []) {
      const child = readable.has(step) ? scope.children.get(step) : undefined;
      if (!child || Object.hasOwn(child.ends ?? {}, end)) continue;
      diagnostics.push({
        ...at(`step "${reader}" ${site.what} compares steps.${step}.end with '${end}', which is not an end ${child.label} declares`),
        code: 'undeclared_end',
      });
    }
  }
  return diagnostics;
}

/** The names an expression compares a step's end with, as in `steps.check.end == 'ready'`. */
function endComparisons(expression: Expression): Array<{ step: string; end: string }> {
  if (expression.kind === 'not') return endComparisons(expression.operand);
  if (expression.kind !== 'binary') return [];
  if (expression.operator === '&&' || expression.operator === '||') {
    return [...endComparisons(expression.left), ...endComparisons(expression.right)];
  }
  const [read, value] = expression.left.kind === 'path' ? [expression.left, expression.right] : [expression.right, expression.left];
  if (read.kind !== 'path' || read.path.root !== 'steps' || read.path.field !== 'end') return [];
  return value.kind === 'literal' && typeof value.value === 'string' ? [{ step: read.path.step, end: value.value }] : [];
}

interface Ending {
  id: string;
  field: string;
  end: string;
  node: Node;
  /** The step has no action and only ends the workflow. */
  only: boolean;
}

/** Diagnostics that keep `end` on steps consistent with the declared `ends`. */
function endDiagnostics(
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

/** `{{ with.<name> }}` reads a value its step's own `with` declares, and only from the step's prompt or prompt_file text. */
function withReadProblems(label: string, what: string, template: Template, declared: Record<string, unknown> | undefined): string[] {
  return templateWithPaths(template).flatMap((path) => {
    const read = `${label} ${what} reads with.${path.fields.join('.')}`;
    if (what !== 'prompt' && what !== 'prompt_file') return [`${read}; only a prompt reads with`];
    if (!declared) return [`${read}, but the step has no with`];
    return Object.hasOwn(declared, path.fields[0] ?? '') ? [] : [`${read}, which is not a name its with declares`];
  });
}

/**
 * Diagnostics for the templates in the text a step's `prompt_file` resolved to, placed at its `prompt_file` field.
 * `trail` is the step's index in each workflow on the way to it: `[2, 0]` is the first step of the inline workflow of step 2.
 */
export function promptFileDiagnostics(
  file: string,
  definition: WorkflowDefinition,
  trail: number[],
  text: string,
  at: { line: number; column: number },
  files?: WorkflowFiles,
): WorkflowDiagnostic[] {
  const levels: WorkflowStep[][] = [definition.steps];
  for (const index of trail.slice(0, -1)) {
    const workflow = levels[levels.length - 1]?.[index]?.workflow;
    if (typeof workflow !== 'object') return [];
    levels.push(workflow.steps);
  }
  const step = levels[levels.length - 1]?.[trail[trail.length - 1] ?? -1];
  if (!step) return [];
  const field = `${stepField(trail)}.prompt_file`;
  const parsed = parseTemplate(text);
  if (!parsed.ok) {
    return parsed.errors.map((problem) => ({
      file, ...at, field, message: `step "${step.id}" prompt_file template ${problem.source}: ${problem.message}`, code: 'bad_template',
    }));
  }
  const diagnostics: WorkflowDiagnostic[] = withReadProblems(`step "${step.id}"`, 'prompt_file', parsed.template, step.with)
    .map((message): WorkflowDiagnostic => ({ file, ...at, field, message, code: 'bad_template' }));
  let sites: ReadSite[] = [{ id: step.id, field, at, what: 'prompt_file', paths: templatePaths(parsed.template), code: 'bad_template' }];
  // Check the reads in the step's own workflow, then hand what it reads of enclosing steps out, one workflow at a time.
  for (let level = levels.length - 1; level >= 0 && sites.length > 0; level -= 1) {
    const steps = levels[level] ?? [];
    const split = splitReads(sites, level === 0 ? undefined : new Set(steps.map((item) => item.id)));
    const needs = new Map(steps.map((item) => [item.id, item.needs ?? []]));
    diagnostics.push(...readDiagnostics(file, split.local, readScope(needs, steps, definition.inputs ?? {}, childrenOf(steps, files))));
    const enclosing = levels[level - 1]?.[trail[level - 1] ?? -1];
    sites = enclosing ? split.outer.map((site) => ({ ...site, id: enclosing.id, reader: site.reader ?? site.id })) : [];
  }
  return diagnostics;
}

/** The field of the step at `trail`, its index in each workflow on the way to it, such as `steps[2].workflow.steps[0]`. */
export function stepField(trail: number[]): string {
  return trail.map((index) => `steps[${index}]`).join('.workflow.');
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isPromptFilePath(value: string | undefined): value is string {
  if (!value || value.trim() === '' || pathIsAbsolute(value)) return false;
  const segments = value.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  return segments.length >= 2 && segments[0] === 'prompts' && !segments.includes('..');
}
