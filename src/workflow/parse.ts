import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';
import { fieldsText, parseExpression, type ExpressionPath } from './expression.js';
import {
  findTemplate, parseTemplate, stepExpressions, templatedTexts, templateExpressions, templateWithPaths, type StepExpression, type Template,
} from './template.js';
import type {
  EndOutcome, ForEach, InlineWorkflow, OutputSchema, StepLoop, StepScorers, WorkflowDefaults, WorkflowDefinition, WorkflowDiagnostic, WorkflowLoop, WorkflowStep,
} from './types.js';
import { STEP_ACTIONS } from './types.js';
import {
  isYamlNode, locate, position, scalarString, unknownKey, valueNode, unavailableField, undeclaredField, undeclaredOutput,
  type Child, type GraphNode, type ParseContext, type WorkflowFiles,
} from './parse-context.js';
import {
  conditionDiagnostics, endDiagnostics, expressionSite, readDiagnostics, readScope, splitReads, type ConditionNode, type Ending, type ReadSite,
} from './reads.js';
import { parseHitl } from './parse-hitl.js';
import { loopProblems } from './loop.js';
import { modelValueProblem } from '../models/aliases.js';

const HEADER_KEYS = new Set(['schemaVersion', 'name', 'description', 'inputs', 'defaults', 'ends', 'outputs', 'loop', 'steps']);
const ACTION_KEYS = Object.keys(STEP_ACTIONS);
const STEP_KEYS = new Set(['id', 'needs', 'if', ...ACTION_KEYS, 'env', 'with', 'agent', 'model', 'output', 'end', 'loop', 'break', 'for_each', 'approve', 'choose', 'interactive', 'workspace', 'session', 'scorers']);
const STEP_LOOP_KEYS = new Set(['back_to', 'while', 'max_iterations']);
const FOR_EACH_KEYS = new Set(['items', 'max_parallel']);
const WORKFLOW_LOOP_KEYS = new Set(['while', 'max_iterations']);
/** Keys a step without an action may carry. */
const ACTIONLESS_KEYS = new Set(['id', 'needs', 'if', 'end', 'approve', 'choose', 'loop', 'break']);
/** The actions as a sentence: `command, prompt, prompt_file, or workflow`. */
const ACTION_LIST = `${ACTION_KEYS.slice(0, -1).join(', ')}, or ${ACTION_KEYS.at(-1)}`;
const TYPE_NAMES = new Set(['string', 'number', 'boolean']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * How pull checks what each step expression other than `if` reads; an `if` is also checked for being always false.
 * `loop.while` and `break` are evaluated after their step succeeds, so they may read it.
 */
const EXPRESSION_SITES: Record<Exclude<StepExpression['what'], 'if'>, { code: WorkflowDiagnostic['code'] } | undefined> = {
  'loop.while': { code: 'bad_loop' },
  break: { code: 'bad_loop' },
  for_each: undefined,
};

export function formatDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: field "${diagnostic.field}": ${diagnostic.message}`;
}

/** Paths such as `steps.<id>.outputs.<field>` split on ".", so a name that contains one could never be read. */
function dottedName(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, name: string): WorkflowDiagnostic {
  return { ...locate(file, lineCounter, node, field, `${name} cannot contain "."; a path reads "." as a separator`), code: 'dotted_name' };
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

  const defaultsPair = root.items.find((pair) => scalarString(pair.key) === 'defaults');
  const defaults = defaultsPair ? parseDefaults(defaultsPair.value ?? defaultsPair.key, ctx) : undefined;

  // A malformed inputs header is already reported; checking reads against it would only add noise.
  const { workflow: { ends, outputs, loop, steps } } = parseBody(root, '', 'workflow', ctx, inputsPair && !inputs ? undefined : inputs ?? {}, false);

  if (diagnostics.length > 0 || !name || !description) return { ok: false, diagnostics };
  return {
    ok: true,
    definition: {
      schemaVersion: 'v1alpha1', name, description, ...(inputs ? { inputs } : {}), ...(ends ? { ends } : {}), ...(outputs ? { outputs } : {}),
      ...(loop ? { loop } : {}), ...(defaults ? { defaults } : {}), steps,
    },
    promptFileLocations,
  };
}

/**
 * The `ends`, `outputs`, `loop`, and `steps` of a workflow file, or of an inline workflow whose fields start with `at`.
 * An inline workflow returns, in `outer`, what its steps read of enclosing steps, for the enclosing workflow to check.
 * `itemBound` is whether the workflow runs once per item of a `for_each` step, directly or inside one, so its steps may read `item`.
 */
function parseBody(
  root: YAMLMap.Parsed,
  at: string,
  label: string,
  ctx: ParseContext,
  inputs: Record<string, OutputSchema> | undefined,
  itemBound: boolean,
  parent?: { steps: WorkflowStep[]; needs?: string[] },
  checks?: Array<() => void>,
): { workflow: InlineWorkflow; outer: ReadSite[] } {
  const { file, lineCounter, diagnostics, promptFileLocations, files } = ctx;
  const endsPair = root.items.find((pair) => scalarString(pair.key) === 'ends');
  const ends = endsPair ? parseEnds(endsPair.value ?? endsPair.key, at, ctx) : undefined;

  const outputsPair = root.items.find((pair) => scalarString(pair.key) === 'outputs');
  const outputEntries = outputsPair ? parseOutputs(outputsPair.value ?? outputsPair.key, at, ctx) : undefined;
  const outputs = outputEntries && Object.fromEntries(outputEntries.map((entry) => [entry.name, entry.source]));

  const loopPair = root.items.find((pair) => scalarString(pair.key) === 'loop');
  const loop = loopPair ? parseLoop(loopPair.value ?? loopPair.key, `${at}loop`, label, ctx, false) : undefined;
  const loopWhile = loop?.while === undefined ? undefined : parseExpression(loop.while);
  const loopSite: ReadSite | undefined = loopWhile?.ok ? {
    ...expressionSite('', `${at}loop.while`, position(lineCounter, valueNode(loopPair?.value, 'while')), 'loop.while', [loopWhile.expression]),
    workflow: label,
    code: 'bad_loop',
  } : undefined;

  const stepsPair = root.items.find((pair) => scalarString(pair.key) === 'steps');
  const stepsNode = stepsPair?.value;
  const steps: WorkflowStep[] = [];
  let outer: ReadSite[] = [];
  if (!isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode ?? stepsPair?.key ?? root, `${at}steps`, 'steps must be a non-empty list'));
  } else {
    const queue = checks ?? [];
    const sessions: Array<{ id: string; from: string; node: Node; field: string }> = [];
    const seen = new Set<string>();
    const graph: GraphNode[] = [];
    const conditions: ConditionNode[] = [];
    const reads: ReadSite[] = [];
    const endings: Ending[] = [];
    const references: Array<{ id: string; workflow: string }> = [];
    const placed = new Map<string, { field: string; item: YAMLMap }>();
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
        placed.set(id, { field, item });
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
      const forEachPair = item.items.find((pair) => scalarString(pair.key) === 'for_each');
      // The step's templates and the inline workflow it runs render once per item, so they read item as a template.
      const bindsItem = itemBound || forEachPair !== undefined;
      const inline = isMap(workflowPair?.value)
        ? parseInline(workflowPair.value, `${field}.workflow`, label, ctx, inputs, bindsItem, { steps, needs }, queue)
        : undefined;
      const approvePair = item.items.find((pair) => scalarString(pair.key) === 'approve');
      const choosePair = item.items.find((pair) => scalarString(pair.key) === 'choose');
      const approval = approvePair ? parseHitl('approve', approvePair.value, `${field}.approve`, ctx) : undefined;
      const choice = choosePair ? parseHitl('choose', choosePair.value, `${field}.choose`, ctx) : undefined;
      const hitl = approval ?? choice;
      if (approvePair && choosePair) diagnostics.push(locate(file, lineCounter, choosePair.key, `${field}.choose`, 'approve is the yes-or-no case of choose; use one'));
      if ((approvePair || choosePair) && forEachPair) diagnostics.push(locate(file, lineCounter, forEachPair.key, `${field}.for_each`, 'put the HITL request on a step the for_each step needs'));
      const interactivePair = item.items.find((pair) => scalarString(pair.key) === 'interactive');
      const interactive = isScalar(interactivePair?.value) && interactivePair.value.value === true;
      if (interactivePair && (!isScalar(interactivePair.value) || typeof interactivePair.value.value !== 'boolean')) {
        diagnostics.push(locate(file, lineCounter, interactivePair.value, `${field}.interactive`, 'interactive must be a boolean'));
      } else if (interactive && !promptPair && !promptFilePair) {
        diagnostics.push(locate(file, lineCounter, interactivePair?.value, `${field}.interactive`, 'interactive needs a prompt or prompt_file: a person works in the tool on that prompt'));
      }
      const actions = ACTION_KEYS.map((key) => item.items.find((pair) => scalarString(pair.key) === key)).filter(Boolean);
      if (choosePair && actions.length > 0) diagnostics.push(locate(file, lineCounter, choosePair.key, `${field}.choose`, 'a choose step records the choice; put the work in a step that needs it'));
      const endPair = item.items.find((pair) => scalarString(pair.key) === 'end');
      const end = scalarString(endPair?.value)?.trim();
      if (endPair && (!end || !TOKEN.test(end))) {
        diagnostics.push(locate(file, lineCounter, endPair.value ?? endPair.key ?? item, `${field}.end`, `${label} end must be a name from ends`));
      } else if (endPair && end && id && TOKEN.test(id)) {
        endings.push({ id, field: `${field}.end`, end, node: endPair.value as Node, only: actions.length === 0 });
      }
      if ((endPair || approvePair || choosePair) && actions.length === 0) {
        for (const pair of item.items) {
          const key = scalarString(pair.key);
          if (!key || !STEP_KEYS.has(key) || ACTIONLESS_KEYS.has(key) || (key === 'interactive' && isScalar(pair.value) && pair.value.value === false)) continue;
          diagnostics.push(locate(file, lineCounter, pair.key as Node, `${field}.${key}`, `${label} has no action, so it carries only id, needs, if, end, approve, choose, loop, and break`));
        }
      }
      if (actions.length > 1 || (actions.length === 0 && !endPair && !approvePair && !choosePair)) {
        diagnostics.push(locate(file, lineCounter, item, field, actions.length > 1 ? `a step has exactly one action: ${ACTION_LIST}` : `a step has exactly one action: ${ACTION_LIST}; or no action with end, approve, or choose`));
      }
      if (workflowPair && !inline && (!workflow || !TOKEN.test(workflow))) {
        diagnostics.push(locate(file, lineCounter, workflowPair.value ?? workflowPair.key ?? item, `${field}.workflow`, `${label} workflow must be the name of a workflow in workflows/`));
      }
      if (commandPair && (command === undefined || command.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, commandPair?.value ?? commandPair?.key ?? item, `${field}.command`, 'command must be a non-empty string'));
      }
      const commandTemplate = command === undefined ? undefined : findTemplate(command, bindsItem);
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
      const modelPair = item.items.find((pair) => scalarString(pair.key) === 'model');
      const model = modelPair ? parseModel(modelPair.value ?? modelPair.key, `${field}.model`, ctx) : undefined;
      if (modelPair && model !== undefined && (commandPair || workflowPair)) {
        diagnostics.push(locate(file, lineCounter, modelPair.key ?? item, `${field}.model`, 'model is only allowed on a prompt or prompt_file step'));
      }
      const scorersPair = item.items.find((pair) => scalarString(pair.key) === 'scorers');
      const scorers = scorersPair ? parseScorers(scorersPair.value ?? scorersPair.key, `${field}.scorers`, ctx) : undefined;
      if (scorersPair && commandPair) {
        diagnostics.push(locate(file, lineCounter, scorersPair.key ?? item, `${field}.scorers`, 'scorers is only allowed on a prompt, prompt_file, or workflow step'));
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
      const templates = templatedTexts({ prompt, env, with: withValues, hitl }).map(({ what, text }) => {
        const name = what.slice(what.indexOf('.') + 1);
        const node = what === 'approve.message' ? valueNode(approvePair?.value, 'message') ?? approvePair?.value : what === 'choose.message' ? valueNode(choosePair?.value, 'message') : what === 'prompt' ? promptPair?.value : valueNode(what.startsWith('with.') ? withPair?.value : envPair?.value, name);
        return { what, field: `${field}.${what}`, node: node as Node, text };
      });
      for (const template of templates) {
        const parsed = parseTemplate(template.text, bindsItem);
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
          reads.push({
            ...expressionSite(id, template.field, position(lineCounter, template.node), template.what, templateExpressions(parsed.template)),
            ...(forEachPair ? { item: true } : {}), code: 'bad_template',
          });
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
      const loopPair = item.items.find((pair) => scalarString(pair.key) === 'loop');
      const loop = loopPair ? parseLoop(loopPair.value ?? loopPair.key, `${field}.loop`, label, ctx, true) : undefined;
      const breakPair = item.items.find((pair) => scalarString(pair.key) === 'break');
      const breakSource = breakPair ? conditionSource(breakPair.value) : undefined;
      if (breakPair) {
        const parsed = breakSource === undefined ? undefined : parseExpression(breakSource);
        const node = (breakPair.value ?? breakPair.key ?? item) as Node;
        const reject = (message: string): void => {
          diagnostics.push({ ...locate(file, lineCounter, node, `${field}.break`, `${label} break ${message}`), code: 'bad_loop' });
        };
        if (!parsed) reject('must be an expression');
        else if (!parsed.ok) reject(`does not parse at column ${parsed.column}: ${parsed.message}`);
      }
      const forEach = forEachPair ? parseForEach(forEachPair.value ?? forEachPair.key, `${field}.for_each`, label, ctx) : undefined;
      if (inGraph) {
        const nodes: Record<StepExpression['what'], unknown> = {
          if: ifPair?.value,
          'loop.while': valueNode(loopPair?.value, 'while'),
          break: breakPair?.value,
          for_each: isMap(forEachPair?.value) ? valueNode(forEachPair.value, 'items') : forEachPair?.value,
        };
        for (const { what, source } of stepExpressions({ if: condition, loop, break: breakSource, forEach })) {
          const parsed = parseExpression(source);
          if (!parsed.ok) continue;
          const node = (nodes[what] ?? item) as Node;
          if (what === 'if') conditions.push({ id, field: `${field}.if`, node, expression: parsed.expression });
          else reads.push(expressionSite(id, `${field}.${what}`, position(lineCounter, node), what, [parsed.expression], EXPRESSION_SITES[what]));
        }
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
      const workspacePair = item.items.find((pair) => scalarString(pair.key) === 'workspace');
      const workspaceText = scalarString(workspacePair?.value)?.trim();
      const workspace = workspaceText === 'read-only' || workspaceText === 'new' || workspaceText === 'continue' ? workspaceText : undefined;
      if (workspacePair && !workspace) {
        diagnostics.push({
          ...locate(file, lineCounter, workspacePair.value ?? workspacePair.key ?? item, `${field}.workspace`, `${label} workspace must be read-only, new, or continue`),
          code: 'bad_workspace',
        });
      }
      const sessionPair = item.items.find((pair) => scalarString(pair.key) === 'session');
      let session: WorkflowStep['session'];
      if (sessionPair) {
        const sessionText = scalarString(sessionPair.value)?.trim();
        const fromPair = isMap(sessionPair.value) ? sessionPair.value.items.find((pair) => scalarString(pair.key) === 'from') : undefined;
        const from = scalarString(fromPair?.value)?.trim();
        const extra = isMap(sessionPair.value) && sessionPair.value.items.some((pair) => scalarString(pair.key) !== 'from');
        if (sessionText === 'continue') session = { continue: true };
        else if (from && !extra && TOKEN.test(from)) {
          session = { from };
          if (id && TOKEN.test(id)) sessions.push({ id, from, node: (fromPair?.value ?? sessionPair.value) as Node, field: `${field}.session.from` });
        } else {
          diagnostics.push({
            ...locate(file, lineCounter, sessionPair.value ?? sessionPair.key ?? item, `${field}.session`, `${label} session must be continue, or { from: <step> }`),
            code: 'bad_session',
          });
        }
        if (session && (workflowPair || endPair && actions.length === 0)) {
          diagnostics.push({
            ...locate(file, lineCounter, sessionPair.key ?? item, `${field}.session`, `${label} session is only allowed on a command or prompt step`),
            code: 'bad_session',
          });
          session = undefined;
        }
      }
      if (id && TOKEN.test(id) && (actions.length === 1 || endPair || hitl) && !diagnostics.some((d) => d.field === field || d.field.startsWith(`${field}.`))) {
        steps.push({
          id,
          ...(hitl ? { hitl } : {}),
          ...(interactive ? { interactive: true } : {}),
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
          ...(model !== undefined ? { model } : {}),
          ...(scorers ? { scorers } : {}),
          ...(output ? { output } : {}),
          ...(end ? { end } : {}),
          ...(loop ? { loop } : {}),
          ...(breakSource !== undefined ? { break: breakSource } : {}),
          ...(forEach ? { forEach } : {}),
          ...(workspace ? { workspace } : {}),
          ...(session ? { session } : {}),
        });
      }
    });
    queue.push(() => diagnostics.push(...sessionProblems(file, lineCounter, steps, parent, sessions)));
    if (!checks) for (const check of queue) check();
    diagnostics.push(...graphDiagnostics(ctx, graph, seen));
    diagnostics.push(...conditionDiagnostics(ctx, conditions, reads));
    const needsById = new Map(graph.map((step) => [step.id, step.needs]));
    // An inline workflow that is reported has no step here, so reads of it are not checked.
    const children = childrenOf([...references, ...steps.filter((step) => typeof step.workflow === 'object')], files);
    // A malformed inputs header is already reported; checking reads against it would only add noise.
    // An inline workflow's reads of steps that are not its own are checked by the workflow around it.
    const split = splitReads(reads, at === '' ? undefined : seen);
    outer = split.outer;
    diagnostics.push(...readDiagnostics(file, loopSite ? [...split.local, loopSite] : split.local, { ...readScope(needsById, steps, inputs, children), item: itemBound }));
    for (const problem of loopProblems(steps, stepReads(split.local), loop !== undefined)) {
      const at = placed.get(problem.id);
      const node = problem.key.split('.').reduce<unknown>((map, key) => valueNode(map, key), at?.item);
      diagnostics.push({ ...locate(file, lineCounter, (node ?? at?.item) as Node, `${at?.field}.${problem.key}`, problem.message), code: 'bad_loop' });
    }
    // A malformed ends header is already reported; checking steps against it would only add noise.
    if (!endsPair || ends) diagnostics.push(...endDiagnostics(ctx, ends, endsPair?.value, at, endings, graph));
    diagnostics.push(...outputDiagnostics(ctx, outputEntries ?? [], at, seen, steps, children));
  }
  return { workflow: { ...(ends ? { ends } : {}), ...(outputs ? { outputs } : {}), ...(loop ? { loop } : {}), steps }, outer };
}

function stepReads(sites: ReadSite[]): Map<string, Set<string>> {
  const reads = new Map<string, Set<string>>();
  for (const site of sites) {
    const ids = reads.get(site.id) ?? new Set<string>();
    for (const path of site.paths) if (path.root === 'steps') ids.add(path.step);
    reads.set(site.id, ids);
  }
  return reads;
}

/** An inline `workflow: { steps, outputs?, ends? }`. It reads the enclosing inputs and steps, so it declares no inputs. */
function parseInline(
  node: YAMLMap.Parsed,
  field: string,
  label: string,
  ctx: ParseContext,
  inputs: Record<string, OutputSchema> | undefined,
  itemBound: boolean,
  parent?: { steps: WorkflowStep[]; needs?: string[] },
  checks?: Array<() => void>,
): { workflow: InlineWorkflow; outer: ReadSite[] } {
  const { file, lineCounter, diagnostics } = ctx;
  for (const pair of node.items) {
    const key = scalarString(pair.key);
    if (key === 'steps' || key === 'outputs' || key === 'ends' || key === 'loop') continue;
    if (!key || !HEADER_KEYS.has(key)) {
      diagnostics.push(unknownKey(file, lineCounter, pair.key ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
    } else if (key === 'inputs') {
      diagnostics.push(locate(file, lineCounter, pair.key, `${field}.inputs`, `${label} runs an inline workflow, which declares no inputs; its steps read the enclosing workflow's inputs`));
    } else {
      diagnostics.push(locate(file, lineCounter, pair.key, `${field}.${key}`, `${label} runs an inline workflow, which carries only steps, outputs, ends, and loop`));
    }
  }
  return parseBody(node, `${field}.`, `${label} workflow`, ctx, inputs, itemBound, parent, checks);
}

function needsReach(start: string[] | undefined, target: string, steps: Map<string, WorkflowStep>): boolean {
  const seen = new Set<string>();
  const stack = [...start ?? []];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id === target) return true;
    stack.push(...steps.get(id)?.needs ?? []);
  }
  return false;
}

/** `session.from` must name a step this one waits for, in its own workflow or the enclosing one, and not a `for_each`. */
function sessionProblems(
  file: string,
  lineCounter: LineCounter,
  steps: WorkflowStep[],
  parent: { steps: WorkflowStep[]; needs?: string[] } | undefined,
  sites: Array<{ id: string; from: string; node: Node; field: string }>,
): WorkflowDiagnostic[] {
  const local = new Map(steps.map((step) => [step.id, step]));
  const enclosing = new Map((parent?.steps ?? []).map((step) => [step.id, step]));
  const problems: WorkflowDiagnostic[] = [];
  for (const site of sites) {
    const own = local.get(site.from);
    const target = own ?? enclosing.get(site.from);
    const reject = (message: string): void => {
      problems.push({ ...locate(file, lineCounter, site.node, site.field, message), code: 'bad_session' });
    };
    if (!target) {
      reject(`step "${site.id}" session.from names "${site.from}", which is not a step it can read`);
      continue;
    }
    if (target.forEach) {
      reject(`step "${site.id}" session.from names "${site.from}", which is a for_each step`);
      continue;
    }
    const reached = own ? needsReach(local.get(site.id)?.needs, site.from, local) : needsReach(parent?.needs, site.from, enclosing);
    if (!reached) reject(`step "${site.id}" session.from names "${site.from}", which is not a step it needs, directly or through its needs`);
  }
  return problems;
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

/**
 * A step's `loop`, or, with `step` false, a workflow's, which has no `back_to`. Where `back_to` sits in the graph is
 * checked once every step is known.
 */
function parseLoop(node: Node | null | undefined, field: string, label: string, ctx: ParseContext, step: true): StepLoop | undefined;
function parseLoop(node: Node | null | undefined, field: string, label: string, ctx: ParseContext, step: false): WorkflowLoop | undefined;
function parseLoop(node: Node | null | undefined, field: string, label: string, ctx: ParseContext, step: boolean): StepLoop | WorkflowLoop | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  const reject = (at: Node | null | undefined, where: string, message: string): void => {
    diagnostics.push({ ...locate(file, lineCounter, at, where, message), code: 'bad_loop' });
  };
  if (!isMap(node)) {
    reject(node, field, `${label} loop must map ${step ? 'back_to, ' : ''}max_iterations, and optionally while`);
    return undefined;
  }
  const before = diagnostics.length;
  const keys = step ? STEP_LOOP_KEYS : WORKFLOW_LOOP_KEYS;
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (!step && key === 'back_to') reject(keyNode, `${field}.back_to`, `${label} loop has no back_to; each round runs every step of the workflow`);
    else if (!key || !keys.has(key)) diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
  }
  const at = (key: string): Node | undefined => valueNode(node, key);
  const backTo = step ? scalarString(at('back_to'))?.trim() : undefined;
  if (step && (!backTo || !TOKEN.test(backTo))) reject(at('back_to') ?? node, `${field}.back_to`, `${label} loop.back_to must name a step`);
  const maxNode = at('max_iterations');
  const max: unknown = isScalar(maxNode) ? maxNode.value : undefined;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    reject(at('max_iterations') ?? node, `${field}.max_iterations`, `${label} loop.max_iterations must be a whole number from 1`);
  }
  const whileNode = at('while');
  const condition = whileNode ? conditionSource(whileNode) : undefined;
  if (whileNode) {
    const parsed = condition === undefined ? undefined : parseExpression(condition);
    if (!parsed) reject(whileNode, `${field}.while`, `${label} loop.while must be an expression`);
    else if (!parsed.ok) reject(whileNode, `${field}.while`, `${label} loop.while does not parse at column ${parsed.column}: ${parsed.message}`);
  }
  if (diagnostics.length > before) return undefined;
  const loop = { ...(condition !== undefined ? { while: condition } : {}), maxIterations: max as number };
  return backTo ? { backTo, ...loop } : loop;
}

function parseForEach(node: Node | null | undefined, field: string, label: string, ctx: ParseContext): ForEach | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  const reject = (at: Node | null | undefined, where: string, message: string): void => {
    diagnostics.push({ ...locate(file, lineCounter, at, where, message), code: 'bad_loop' });
  };
  const map = isMap(node) ? node : undefined;
  const before = diagnostics.length;
  for (const pair of map?.items ?? []) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (!key || !FOR_EACH_KEYS.has(key)) diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
  }
  const itemsNode = map ? valueNode(map, 'items') : node;
  const items = conditionSource(itemsNode);
  const parsed = items === undefined ? undefined : parseExpression(items);
  if (!parsed) {
    reject(itemsNode ?? node, map ? `${field}.items` : field,
      map ? `${label} for_each.items must be an expression` : `${label} for_each must be an expression, or a map of items and max_parallel`);
  } else if (!parsed.ok) {
    reject(itemsNode, map ? `${field}.items` : field, `${label} for_each does not parse at column ${parsed.column}: ${parsed.message}`);
  }
  const maxNode = map ? valueNode(map, 'max_parallel') : undefined;
  const max: unknown = isScalar(maxNode) ? maxNode.value : undefined;
  if (maxNode && (typeof max !== 'number' || !Number.isInteger(max) || max < 1)) {
    reject(maxNode, `${field}.max_parallel`, `${label} for_each.max_parallel must be a whole number from 1`);
  }
  if (diagnostics.length > before || items === undefined) return undefined;
  return { items, ...(maxNode ? { maxParallel: max as number } : {}) };
}

/** A `model`, on a step or in `defaults`: an alias or a model name, which the lease carries as written. */
function parseModel(node: Node | null | undefined, field: string, ctx: ParseContext): string | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  const model = scalarString(node);
  const problem = modelValueProblem(model);
  if (problem !== undefined) {
    diagnostics.push(locate(file, lineCounter, node, field, `model ${problem}`));
    return undefined;
  }
  return model;
}

function parseDefaults(node: Node | null | undefined, ctx: ParseContext): WorkflowDefaults | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node)) {
    diagnostics.push(locate(file, lineCounter, node, 'defaults', 'defaults must be a mapping'));
    return undefined;
  }
  let model: string | undefined;
  let scorers: { batch: boolean } | undefined;
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (key === 'model') model = parseModel(valueNode(node, 'model'), 'defaults.model', ctx);
    else if (key === 'scorers') scorers = parseDefaultScorers(valueNode(node, 'scorers'), ctx);
    else diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `defaults.${key ?? 'key'}`, key ?? 'key'));
  }
  if (model === undefined && scorers === undefined) return undefined;
  return { ...(model !== undefined ? { model } : {}), ...(scorers ? { scorers } : {}) };
}

function parseBatch(node: Node | undefined, field: string, ctx: ParseContext): boolean | undefined {
  if (isScalar(node) && typeof node.value === 'boolean') return node.value;
  ctx.diagnostics.push(locate(ctx.file, ctx.lineCounter, node, field, 'batch must be true or false'));
  return undefined;
}

/** `defaults.scorers` sets only `batch`. */
function parseDefaultScorers(node: Node | undefined, ctx: ParseContext): { batch: boolean } | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node) || !node.has('batch')) {
    diagnostics.push(locate(file, lineCounter, node, 'defaults.scorers', 'defaults.scorers must be { batch: true } or { batch: false }'));
    return undefined;
  }
  let batch: boolean | undefined;
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (key === 'batch') batch = parseBatch(valueNode(node, 'batch'), 'defaults.scorers.batch', ctx);
    else diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `defaults.scorers.${key ?? 'key'}`, key ?? 'key'));
  }
  return batch === undefined ? undefined : { batch };
}

/** A step's `scorers`: a list of names, or `{ names, batch }`. */
function parseScorers(node: Node | null | undefined, field: string, ctx: ParseContext): StepScorers | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  let list: Node | null | undefined = node;
  let batch: boolean | undefined;
  if (isMap(node)) {
    list = undefined;
    for (const pair of node.items) {
      const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
      const key = scalarString(keyNode);
      if (key === 'names') list = valueNode(node, 'names');
      else if (key === 'batch') batch = parseBatch(valueNode(node, 'batch'), `${field}.batch`, ctx);
      else diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
    }
  }
  if (!isSeq(list) || list.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, list ?? node, field, 'scorers must list scorer names, as [name, …] or { names: [name, …], batch: true }'));
    return undefined;
  }
  const names: string[] = [];
  for (const item of list.items) {
    const name = isScalar(item) ? String(item.value) : undefined;
    if (name === undefined || !TOKEN.test(name)) {
      diagnostics.push(locate(file, lineCounter, list, field, `scorer ${name === undefined ? 'names' : `"${name}"`} must be a token, the name of a file in scorers/`));
    } else if (names.includes(name)) {
      diagnostics.push(locate(file, lineCounter, list, field, `scorers lists "${name}" twice`));
    } else {
      names.push(name);
    }
  }
  return { names, ...(batch !== undefined ? { batch } : {}) };
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
    const step = steps.find((step) => step.id === path.step);
    const unavailable = step && unavailableField(path, !!step.forEach, step.hitl?.options);
    if (unavailable) {
      diagnostics.push(at(unavailable));
      continue;
    }
    const undeclared = undeclaredOutput(children, path);
    if (undeclared) {
      diagnostics.push({ ...at(undeclared), code: 'undeclared_output' });
      continue;
    }
    const field = undeclaredField(path, step?.output, !!step?.forEach, step?.hitl?.options);
    if (field) diagnostics.push(at(field));
  }
  return diagnostics;
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

/** `{{ with.<name> }}` reads a value its step's own `with` declares, and only from the step's prompt or prompt_file text. */
function withReadProblems(label: string, what: string, template: Template, declared: Record<string, unknown> | undefined): string[] {
  return templateWithPaths(template).flatMap((path) => {
    const read = `${label} ${what} reads with${fieldsText(path.fields)}`;
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
  const runners: WorkflowStep[] = [];
  for (const index of trail.slice(0, -1)) {
    const runner = levels[levels.length - 1]?.[index];
    if (typeof runner?.workflow !== 'object') return [];
    runners.push(runner);
    levels.push(runner.workflow.steps);
  }
  const step = levels[levels.length - 1]?.[trail[trail.length - 1] ?? -1];
  if (!step) return [];
  const field = `${stepField(trail)}.prompt_file`;
  const bindsItem = step.forEach !== undefined || runners.some((runner) => runner.forEach !== undefined);
  const parsed = parseTemplate(text, bindsItem);
  if (!parsed.ok) {
    return parsed.errors.map((problem): WorkflowDiagnostic => ({
      file, ...at, field, message: `step "${step.id}" prompt_file template ${problem.source}: ${problem.message}`, code: 'bad_template',
    }));
  }
  const diagnostics: WorkflowDiagnostic[] = withReadProblems(`step "${step.id}"`, 'prompt_file', parsed.template, step.with)
    .map((message): WorkflowDiagnostic => ({ file, ...at, field, message, code: 'bad_template' }));
  let sites: ReadSite[] = [{
    ...expressionSite(step.id, field, at, 'prompt_file', templateExpressions(parsed.template)), ...(step.forEach ? { item: true } : {}), code: 'bad_template',
  }];
  // Check the reads in the step's own workflow, then hand what it reads of enclosing steps out, one workflow at a time.
  for (let level = levels.length - 1; level >= 0 && sites.length > 0; level -= 1) {
    const steps = levels[level] ?? [];
    const split = splitReads(sites, level === 0 ? undefined : new Set(steps.map((item) => item.id)));
    const needs = new Map(steps.map((item) => [item.id, item.needs ?? []]));
    const item = runners.slice(0, level).some((runner) => runner.forEach !== undefined);
    diagnostics.push(...readDiagnostics(file, split.local, { ...readScope(needs, steps, definition.inputs ?? {}, childrenOf(steps, files)), item }));
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
