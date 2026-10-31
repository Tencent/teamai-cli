import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { fieldsText, parseExpression, type ExpressionPath } from './expression.js';
import {
  findTemplate, parseTemplate, stepExpressions, templatedTexts, templateExpressions, templateWithPaths, type StepExpression, type Template,
} from './template.js';
import type {
  Budget, EndOutcome, ForEach, InlineWorkflow, OutputSchema, StepLoop, StepScorers, StepWorkspace, WorkflowDefaults, WorkflowDefinition, WorkflowDiagnostic, WorkflowLoop, WorkflowStep,
} from './types.js';
import { INVOKE_VALUES, STEP_ACTIONS, stepWorkflow } from './types.js';
import {
  isYamlNode, locate, position, scalarString, unknownKey, valueNode, unavailableField, undeclaredField, undeclaredOutput,
  type Child, type GraphNode, type ParseContext, type WorkflowFiles,
} from './parse-context.js';
import {
  conditionDiagnostics, endDiagnostics, expressionSite, readDiagnostics, readScope, splitReads, type ConditionNode, type Ending, type ReadSite,
} from './reads.js';
import { parseHitl } from './parse-hitl.js';
import { loopProblems, stepLoops } from './loop.js';
import { modelValueProblem } from '../models/aliases.js';
import type { StepModel } from './step-model.js';
import { ClonePlaceSchema } from './clone.js';
import { mergeRequirements, ON_LIMIT, REQUIREMENT_KEYS, RequirementsSchema, SANDBOX_WITHHELD_ENV, SetupSchema, type InEffect, type OnLimit, type Requirements, type Setup } from './requirements.js';
import { sameEnvName } from '../resources/env-key.js';

/**
 * The first release that reads `invoke` and `alias`. An older CLI refuses either as an unknown key and drops the
 * workflow (`dropsKeptVersion`), which `review --branch` warns about.
 */
export const INVOKE_ALIAS_SINCE = '0.28.0';

const HEADER_KEYS = new Set(['schemaVersion', 'name', 'description', 'inputs', 'defaults', 'ends', 'outputs', 'loop', 'timeout', 'budget', 'setup', 'steps', 'finally', 'invoke', 'alias']);
const ACTION_KEYS = Object.keys(STEP_ACTIONS);
const STEP_KEYS = new Set(['id', 'needs', 'if', ...ACTION_KEYS, 'env', 'with', 'agent', 'tool', 'model', 'output', 'end', 'loop', 'break', 'for_each', 'approve', 'choose', 'interactive', 'workspace', 'session', 'scorers', 'requires', 'timeout', 'budget', 'max_turns', 'on_limit', 'permissions', 'deliver']);
const EXACT_MODEL_KEYS: ReadonlySet<string> = new Set(['name', 'effort']);
const STEP_LOOP_KEYS = new Set(['back_to', 'while', 'max_iterations']);
const FOR_EACH_KEYS = new Set(['items', 'max_parallel']);
const WORKFLOW_LOOP_KEYS = new Set(['while', 'max_iterations']);
/** Keys a step without an action may carry. */
const ACTIONLESS_KEYS = new Set(['id', 'needs', 'if', 'end', 'approve', 'choose', 'loop', 'break']);
/** What a `finally` step may carry: it runs a command, read-only, in no workspace of its own. */
const FINALLY_STEP_KEYS = new Set(['id', 'needs', 'if', 'command', 'env', 'output', 'timeout']);
/** The actions as a sentence: `command, prompt, prompt_file, or workflow`. */
const ACTION_LIST = `${ACTION_KEYS.slice(0, -1).join(', ')}, or ${ACTION_KEYS.at(-1)}`;
const TYPE_NAMES = new Set(['string', 'number', 'boolean']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A scorer a step lists: a token, the name of a file in scorers/, or a scorer a run generates, whose name holds a colon. */
const SCORER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION = /^(\d+)(ms|s|m|h)$/;
const DURATION_UNITS = new Map([['ms', 1], ['s', 1000], ['m', 60_000], ['h', 3_600_000]]);
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

/**
 * Where a type shorthand sits: in `inputs`; as a step's whole `output`; as a field of that output's object; or deeper.
 * Only a step output may be `json`, and only a field of its object a `workflow`.
 */
type OutputPlace = 'input' | 'output' | 'field' | 'nested';

const WORKFLOW_PLACE = 'a workflow is only a field of a step output, such as output: { definition: workflow }';

function parseOutput(node: Node, field: string, ctx: ParseContext, place: OutputPlace): OutputSchema | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  const inner: OutputPlace = place === 'input' ? 'input' : 'nested';
  if (isScalar(node)) {
    if (typeof node.value !== 'string') {
      diagnostics.push(locate(file, lineCounter, node, field, 'output shorthand must be string, number, boolean, a literal union, an object, or an array'));
      return undefined;
    }
    const parts = node.value.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length === 1 && TYPE_NAMES.has(parts[0])) {
      return { type: parts[0] as 'string' | 'number' | 'boolean' };
    }
    if (parts.length === 1 && parts[0] === 'json') {
      if (place !== 'input') return { type: 'json' };
      diagnostics.push(locate(file, lineCounter, node, field, 'an input cannot be json; only a step output can'));
      return undefined;
    }
    if (parts.length === 1 && parts[0] === 'workflow') {
      if (place === 'field') return { type: 'workflow' };
      diagnostics.push(locate(file, lineCounter, node, field, place === 'input' ? 'an input cannot be a workflow; only a field of a step output can' : WORKFLOW_PLACE));
      return undefined;
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
    const items = parseOutput(item, `${field}[]`, ctx, inner);
    return items ? { type: 'array', items } : undefined;
  }
  if (isMap(node)) {
    if (node.items.length === 0) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an object shorthand needs at least one field'));
      return undefined;
    }
    const fields: Record<string, OutputSchema> = {};
    let bundleField: string | undefined;
    for (const pair of node.items) {
      const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
      const fieldValueNode = isYamlNode(pair.value) ? pair.value : undefined;
      const key = scalarString(keyNode);
      if (key?.includes('.')) {
        diagnostics.push(dottedName(file, lineCounter, keyNode, field, `field name "${key}"`));
        continue;
      }
      if (!key || !TOKEN.test(key) || !fieldValueNode) {
        diagnostics.push(locate(file, lineCounter, keyNode ?? node, field, 'output field names must be tokens'));
        continue;
      }
      const child = parseOutput(fieldValueNode, `${field}.${key}`, ctx, place === 'output' ? 'field' : inner);
      if (child?.type === 'workflow' && bundleField !== undefined) {
        diagnostics.push(locate(file, lineCounter, fieldValueNode, `${field}.${key}`, `a step output has at most one workflow field; "${bundleField}" is one already`));
        continue;
      }
      if (child?.type === 'workflow') bundleField = key;
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

  const invokeNode = valueNode(root, 'invoke');
  const invoke = INVOKE_VALUES.find((value) => value === scalarString(invokeNode));
  if (invokeNode && invoke === undefined) diagnostics.push({ ...locate(file, lineCounter, invokeNode, 'invoke', 'invoke must be allow, ask or deny'), code: 'bad_invoke' });
  const aliasNode = valueNode(root, 'alias');
  const alias = scalarString(aliasNode);
  if (aliasNode && (!alias || !TOKEN.test(alias))) diagnostics.push({ ...locate(file, lineCounter, aliasNode, 'alias', 'alias must be a non-empty token'), code: 'bad_alias' });
  else if (alias !== undefined && alias === name) diagnostics.push({ ...locate(file, lineCounter, aliasNode ?? root, 'alias', `alias must differ from the workflow name "${name}"`), code: 'bad_alias' });

  const inputsPair = root.items.find((pair) => scalarString(pair.key) === 'inputs');
  let inputs: Record<string, OutputSchema> | undefined;
  if (inputsPair && !isMap(inputsPair.value)) {
    diagnostics.push(locate(file, lineCounter, inputsPair.value ?? inputsPair.key ?? root, 'inputs', 'inputs must map each input name to a type'));
  } else if (inputsPair) {
    const schema = parseOutput(inputsPair.value as Node, 'inputs', ctx, 'input');
    if (schema?.type === 'object') inputs = schema.fields;
  }

  const defaultsPair = root.items.find((pair) => scalarString(pair.key) === 'defaults');
  const defaults = defaultsPair ? parseDefaults(defaultsPair.value ?? defaultsPair.key, ctx) : undefined;
  const timeoutPair = root.items.find((pair) => scalarString(pair.key) === 'timeout');
  const timeout = timeoutPair ? parseTimeout(timeoutPair.value ?? timeoutPair.key, 'timeout', ctx) : undefined;
  const budgetPair = root.items.find((pair) => scalarString(pair.key) === 'budget');
  const budget = budgetPair ? parseBudget(budgetPair.value ?? budgetPair.key, 'budget', ctx) : undefined;
  const setupPair = root.items.find((pair) => scalarString(pair.key) === 'setup');
  const setup = setupPair ? parseSetup(setupPair.value ?? setupPair.key, ctx) : undefined;

  // A malformed inputs header is already reported; checking reads against it would only add noise.
  const readInputs = inputsPair && !inputs ? undefined : inputs ?? {};
  // `finally` steps are read-only commands that run once the graph ends, whatever its outcome. They read the inputs and
  // each other, never `steps`; the outputs may read them.
  const finallySteps = valueNode(root, 'finally') === undefined ? undefined
    : parseBody(root, '', 'finally', ctx, readInputs, false, { list: 'finally' }).workflow.steps;
  const { workflow: { ends, outputs, loop, steps } } = parseBody(root, '', 'workflow', ctx, readInputs, false, { finally: finallySteps });
  for (const step of finallySteps ?? []) {
    if (steps.some((item) => item.id === step.id)) diagnostics.push(locate(file, lineCounter, valueNode(root, 'finally') ?? root, 'finally', `finally step id "${step.id}" is also a step in steps`));
  }
  if (diagnostics.length === 0) withheldEnvRequired(root, { defaults, steps }, '', {}, ctx, { says: '', runs: [] });

  if (diagnostics.length > 0 || !name || !description) return { ok: false, diagnostics };
  return {
    ok: true,
    definition: {
      schemaVersion: 'v1alpha1', name, description, ...(invoke ? { invoke } : {}), ...(alias ? { alias } : {}), ...(inputs ? { inputs } : {}), ...(ends ? { ends } : {}), ...(outputs ? { outputs } : {}),
      ...(loop ? { loop } : {}), ...(defaults ? { defaults } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(budget ? { budget } : {}), ...(setup ? { setup } : {}), steps,
      ...(finallySteps ? { finally: finallySteps } : {}),
    },
    promptFileLocations,
  };
}

/** How `parseBody` reads a workflow's steps. */
interface BodyOptions {
  /** For an inline workflow: the steps of the workflow around it, and what the step that runs it needs. */
  parent?: { steps: WorkflowStep[]; needs?: string[] };
  checks?: Array<() => void>;
  /** `finally`: the top-level `finally` list alone, which has no `ends`, `outputs` or `loop` of its own. */
  list?: 'steps' | 'finally';
  /** The top-level `finally` steps, which the workflow's `outputs` may read too. */
  finally?: WorkflowStep[];
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
  { parent, checks, list = 'steps', finally: finallySteps = [] }: BodyOptions = {},
): { workflow: InlineWorkflow; outer: ReadSite[] } {
  const { file, lineCounter, diagnostics, promptFileLocations, files } = ctx;
  const header = (key: string): (typeof root.items)[number] | undefined => (list === 'steps' ? root.items.find((pair) => scalarString(pair.key) === key) : undefined);
  const endsPair = header('ends');
  const ends = endsPair ? parseEnds(endsPair.value ?? endsPair.key, at, ctx) : undefined;

  const outputsPair = header('outputs');
  const outputEntries = outputsPair ? parseOutputs(outputsPair.value ?? outputsPair.key, at, ctx) : undefined;
  const outputs = outputEntries && Object.fromEntries(outputEntries.map((entry) => [entry.name, entry.source]));

  const loopPair = header('loop');
  const loop = loopPair ? parseLoop(loopPair.value ?? loopPair.key, `${at}loop`, label, ctx, false) : undefined;
  const loopWhile = loop?.while === undefined ? undefined : parseExpression(loop.while);
  const loopSite: ReadSite | undefined = loopWhile?.ok ? {
    ...expressionSite('', `${at}loop.while`, position(lineCounter, valueNode(loopPair?.value, 'while')), 'loop.while', [loopWhile.expression]),
    workflow: label,
    code: 'bad_loop',
  } : undefined;

  const stepsPair = root.items.find((pair) => scalarString(pair.key) === list);
  const stepsNode = stepsPair?.value;
  const steps: WorkflowStep[] = [];
  let outer: ReadSite[] = [];
  if (!isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode ?? stepsPair?.key ?? root, `${at}${list}`, `${list} must be a non-empty list`));
  } else {
    const queue = checks ?? [];
    const sessions: Array<{ id: string; from: string; node: Node; field: string }> = [];
    const fromSites: FromSite[] = [];
    const producers: Producer[] = [];
    const seen = new Set<string>();
    const graph: GraphNode[] = [];
    const conditions: ConditionNode[] = [];
    const reads: ReadSite[] = [];
    const endings: Ending[] = [];
    const references: Array<{ id: string; workflow: string }> = [];
    const placed = new Map<string, { field: string; item: YAMLMap }>();
    stepsNode.items.forEach((item, index) => {
      const field = `${at}${list}[${index}]`;
      if (!isMap(item)) {
        diagnostics.push(locate(file, lineCounter, item, field, 'a step must be a mapping with exactly one action'));
        return;
      }
      for (const pair of item.items) {
        const key = scalarString(pair.key);
        if (!key || !STEP_KEYS.has(key)) {
          diagnostics.push(unknownKey(file, lineCounter, pair.key ?? item, `${field}.${key ?? 'key'}`, key ?? 'key'));
        } else if (list === 'finally' && !FINALLY_STEP_KEYS.has(key)) {
          diagnostics.push(locate(file, lineCounter, pair.key ?? item, `${field}.${key}`, `a finally step runs a read-only command, so it carries only ${[...FINALLY_STEP_KEYS].join(', ')}`));
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
      const stepLabel = id ? `step "${id}"` : field;
      const needsPair = item.items.find((pair) => scalarString(pair.key) === 'needs');
      let needs: string[] | undefined;
      if (needsPair) {
        const values = isSeq(needsPair.value) ? needsPair.value.items.map((need) => scalarString(isYamlNode(need) ? need : undefined)) : [];
        if (!isSeq(needsPair.value) || values.some((need) => !need || !TOKEN.test(need))) {
          diagnostics.push(locate(file, lineCounter, needsPair.value ?? needsPair.key ?? item, `${field}.needs`, `${stepLabel} needs must be a list of step ids`));
        } else {
          needs = values as string[];
          if (id && TOKEN.test(id)) graph.push({ id, field: `${field}.needs`, needs, node: needsPair.value as Node });
        }
      } else if (index > 0) {
        diagnostics.push({
          ...locate(file, lineCounter, item, `${field}.needs`, `${stepLabel} must declare needs; use needs: [] for another root`),
          code: 'missing_needs',
        });
      }
      // A step with a malformed id or missing needs is already reported; checking what it reads would only add noise.
      const inGraph = id !== undefined && TOKEN.test(id) && (needs !== undefined || index === 0);
      const ifPair = item.items.find((pair) => scalarString(pair.key) === 'if');
      const condition = ifPair ? conditionSource(ifPair.value) : undefined;
      if (ifPair) {
        const parsed = condition === undefined ? undefined : parseExpression(condition);
        const ifSite = ifPair.value ?? ifPair.key ?? item;
        if (!parsed) {
          diagnostics.push(locate(file, lineCounter, ifSite, `${field}.if`, `${stepLabel} if must be an expression`));
        } else if (!parsed.ok) {
          diagnostics.push(locate(file, lineCounter, ifSite, `${field}.if`, `${stepLabel} if does not parse at column ${parsed.column}: ${parsed.message}`));
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
      const workflowMap = isMap(workflowPair?.value) ? workflowPair.value : undefined;
      const workflowFromPair = workflowMap?.items.find((pair) => scalarString(pair.key) === 'from');
      const fromStep = scalarString(workflowFromPair?.value)?.trim();
      const runsFrom = workflowMap?.items.length === 1 && fromStep !== undefined && TOKEN.test(fromStep) ? { from: fromStep } : undefined;
      const inline = workflowMap && !workflowFromPair
        ? parseInline(workflowMap, `${field}.workflow`, stepLabel, ctx, inputs, bindsItem, { parent: { steps, needs }, checks: queue })
        : undefined;
      if (workflowFromPair && !runsFrom) {
        diagnostics.push(locate(file, lineCounter, workflowMap, `${field}.workflow`, `${stepLabel} workflow must be the name of a workflow in workflows/, an inline workflow, or { from: <step> }`));
      } else if (runsFrom && id) {
        fromSites.push({ id, from: runsFrom.from, needs, node: (workflowFromPair?.value ?? workflowMap) as Node, field: `${field}.workflow.from` });
      }
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
        diagnostics.push(locate(file, lineCounter, endPair.value ?? endPair.key ?? item, `${field}.end`, `${stepLabel} end must be a name from ends`));
      } else if (endPair && end && id && TOKEN.test(id)) {
        endings.push({ id, field: `${field}.end`, end, node: endPair.value as Node, only: actions.length === 0 });
      }
      if ((endPair || approvePair || choosePair) && actions.length === 0) {
        for (const pair of item.items) {
          const key = scalarString(pair.key);
          if (!key || !STEP_KEYS.has(key) || ACTIONLESS_KEYS.has(key) || (key === 'interactive' && isScalar(pair.value) && pair.value.value === false)) continue;
          diagnostics.push(locate(file, lineCounter, pair.key as Node, `${field}.${key}`, `${stepLabel} has no action, so it carries only id, needs, if, end, approve, choose, loop, and break`));
        }
      }
      if (actions.length > 1 || (actions.length === 0 && !endPair && !approvePair && !choosePair)) {
        diagnostics.push(locate(file, lineCounter, item, field, actions.length > 1 ? `a step has exactly one action: ${ACTION_LIST}` : `a step has exactly one action: ${ACTION_LIST}; or no action with end, approve, or choose`));
      }
      if (workflowPair && !inline && !workflowFromPair && (!workflow || !TOKEN.test(workflow))) {
        diagnostics.push(locate(file, lineCounter, workflowPair.value ?? workflowPair.key ?? item, `${field}.workflow`, `${stepLabel} workflow must be the name of a workflow in workflows/`));
      }
      if (commandPair && (command === undefined || command.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, commandPair?.value ?? commandPair?.key ?? item, `${field}.command`, 'command must be a non-empty string'));
      }
      const commandTemplate = command === undefined ? undefined : findTemplate(command, bindsItem);
      if (commandTemplate !== undefined) {
        diagnostics.push(locate(file, lineCounter, commandPair?.value as Node, `${field}.command`,
          `${stepLabel} command contains ${commandTemplate}; command strings are not templated; pass the value through env:`));
      }
      if (promptPair && (prompt === undefined || prompt.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, promptPair.value ?? promptPair.key ?? item, `${field}.prompt`, 'prompt must be a non-empty string'));
      }
      if (promptFilePair) {
        if (!isPromptFilePath(promptFile)) {
          diagnostics.push(locate(file, lineCounter, promptFilePair.value ?? promptFilePair.key ?? item, `${field}.prompt_file`, 'prompt_file must be a relative path under prompts/'));
        } else if (isYamlNode(promptFilePair.value)) {
          const promptFileLocate = locate(file, lineCounter, promptFilePair.value, `${field}.prompt_file`, '');
          promptFileLocations[field] = { line: promptFileLocate.line, column: promptFileLocate.column };
        }
      }
      const agentPair = item.items.find((pair) => scalarString(pair.key) === 'agent');
      const agent = scalarString(agentPair?.value)?.trim();
      if (agentPair && (!agent || !TOKEN.test(agent))) {
        diagnostics.push(locate(file, lineCounter, agentPair.value ?? agentPair.key ?? item, `${field}.agent`, 'agent must be a non-empty token'));
      } else if (agentPair && (commandPair || workflowPair)) {
        diagnostics.push(locate(file, lineCounter, agentPair.key ?? item, `${field}.agent`, 'agent is only allowed on a prompt or prompt_file step'));
      }
      const toolPair = item.items.find((pair) => scalarString(pair.key) === 'tool');
      const tool = scalarString(toolPair?.value)?.trim();
      if (toolPair && (commandPair || workflowPair)) {
        diagnostics.push(locate(file, lineCounter, toolPair.key ?? item, `${field}.tool`, 'tool is only allowed on a prompt or prompt_file step'));
      } else if (toolPair && (!tool || !TOKEN.test(tool))) {
        diagnostics.push(locate(file, lineCounter, toolPair.value ?? toolPair.key ?? item, `${field}.tool`, 'tool must be the id of a tool, such as claude or codex, written as is'));
      }
      const modelPair = item.items.find((pair) => scalarString(pair.key) === 'model');
      const model = modelPair ? parseStepModel(modelPair.value ?? modelPair.key, `${field}.model`, ctx) : undefined;
      if (modelPair && model !== undefined && (commandPair || workflowPair)) {
        diagnostics.push(locate(file, lineCounter, modelPair.key ?? item, `${field}.model`, 'model is only allowed on a prompt or prompt_file step'));
      }
      const scorersPair = item.items.find((pair) => scalarString(pair.key) === 'scorers');
      const scorers = scorersPair ? parseScorers(scorersPair.value ?? scorersPair.key, `${field}.scorers`, ctx) : undefined;
      if (scorersPair && commandPair) {
        diagnostics.push(locate(file, lineCounter, scorersPair.key ?? item, `${field}.scorers`, 'scorers is only allowed on a prompt, prompt_file, or workflow step'));
      }
      const requiresPair = item.items.find((pair) => scalarString(pair.key) === 'requires');
      const requires = requiresPair ? parseRequires(requiresPair.value ?? requiresPair.key, `${field}.requires`, ctx) : undefined;
      const stepTimeoutPair = item.items.find((pair) => scalarString(pair.key) === 'timeout');
      const timeout = stepTimeoutPair ? parseTimeout(stepTimeoutPair.value ?? stepTimeoutPair.key, `${field}.timeout`, ctx) : undefined;
      const budgetPair = item.items.find((pair) => scalarString(pair.key) === 'budget');
      const budget = budgetPair ? parseBudget(budgetPair.value ?? budgetPair.key, `${field}.budget`, ctx) : undefined;
      const maxTurnsPair = item.items.find((pair) => scalarString(pair.key) === 'max_turns');
      const maxTurnsValue: unknown = isScalar(maxTurnsPair?.value) ? maxTurnsPair.value.value : undefined;
      const maxTurns = typeof maxTurnsValue === 'number' && Number.isSafeInteger(maxTurnsValue) && maxTurnsValue > 0 ? maxTurnsValue : undefined;
      if (maxTurnsPair && maxTurns === undefined) {
        diagnostics.push(locate(file, lineCounter, maxTurnsPair.value ?? maxTurnsPair.key, `${field}.max_turns`, `${stepLabel} max_turns must be a positive whole number`));
      } else if (maxTurnsPair && actions.length > 0 && !promptPair && !promptFilePair) {
        diagnostics.push(locate(file, lineCounter, maxTurnsPair.key, `${field}.max_turns`, `${stepLabel} max_turns is only allowed on a prompt or prompt_file step`));
      }
      const permissionsPair = item.items.find((pair) => scalarString(pair.key) === 'permissions');
      const permissions = scalarString(permissionsPair?.value) === 'unattended' ? 'unattended' as const : undefined;
      if (permissionsPair && permissions === undefined) {
        diagnostics.push(locate(file, lineCounter, permissionsPair.value ?? permissionsPair.key, `${field}.permissions`, `${stepLabel} permissions must be unattended, which lets the tool edit and run commands without asking`));
      } else if (permissionsPair && !promptPair && !promptFilePair) {
        diagnostics.push(locate(file, lineCounter, permissionsPair.key, `${field}.permissions`, `${stepLabel} permissions is only allowed on a prompt or prompt_file step`));
      }
      const onLimitPair = item.items.find((pair) => scalarString(pair.key) === 'on_limit');
      const onLimit = onLimitPair ? parseOnLimit(onLimitPair.value ?? onLimitPair.key, {
        field: `${field}.on_limit`, stepLabel, ends: forEachPair ? 'fan-out' : promptPair || promptFilePair ? 'prompt' : workflowPair && actions.length === 1 ? 'workflow' : actions.length > 0 ? 'none' : undefined,
        limits: { timeout: stepTimeoutPair !== undefined, budget: budgetPair !== undefined, maxTurns: maxTurnsPair !== undefined },
      }, ctx) : undefined;
      const endsPromptTurn = onLimit === 'end_turn' && (promptPair !== undefined || promptFilePair !== undefined);
      if (budgetPair && actions.length > 0 && !workflowPair && !endsPromptTurn) {
        diagnostics.push(locate(file, lineCounter, budgetPair.key, `${field}.budget`, `${stepLabel} budget is only allowed on a workflow step, or on a prompt step with on_limit: end_turn`));
      }
      const envPair = item.items.find((pair) => scalarString(pair.key) === 'env');
      const env = envPair ? parseEnv(envPair.value ?? envPair.key, `${field}.env`, stepLabel, ctx) : undefined;
      const withPair = item.items.find((pair) => scalarString(pair.key) === 'with');
      let withValues: Record<string, unknown> | undefined;
      // A step with no action already reports every key it may not carry.
      if (withPair && commandPair) {
        diagnostics.push(locate(file, lineCounter, withPair.key as Node, `${field}.with`, `${stepLabel} with is not allowed on a command step; pass values through env:`));
      } else if (withPair && inline) {
        diagnostics.push(locate(file, lineCounter, withPair.key as Node, `${field}.with`,
          `${stepLabel} with is not allowed on an inline workflow; its steps read the enclosing inputs and steps`));
      } else if (withPair && actions.length > 0) {
        if (!isMap(withPair.value) || withPair.value.items.length === 0) {
          const what = workflowPair ? "the workflow's inputs" : 'names';
          diagnostics.push(locate(file, lineCounter, withPair.value ?? withPair.key ?? item, `${field}.with`, `${stepLabel} with must map ${what} to values`));
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
          label: stepLabel, field, workflow, node: workflowPair.value as Node, with: keys && { node: (withPair?.key ?? workflowPair.value) as Node, keys },
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
              ...locate(file, lineCounter, template.node, template.field, `${stepLabel} ${template.what} template ${problem.source}: ${problem.message}`),
              code: 'bad_template',
            });
          }
        }
        // A malformed with is already reported; checking the prompt's reads against it would only add noise.
        if (parsed.ok && !(template.what === 'prompt' && withPair && !withValues)) {
          for (const problem of withReadProblems(stepLabel, template.what, parsed.template, withValues)) {
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
        diagnostics.push(locate(file, lineCounter, envPair.key as Node, `${field}.env`, `${stepLabel} env is only allowed on a command step`));
      }
      const stepLoopPair = item.items.find((pair) => scalarString(pair.key) === 'loop');
      const stepLoop = stepLoopPair ? parseLoop(stepLoopPair.value ?? stepLoopPair.key, `${field}.loop`, stepLabel, ctx, true) : undefined;
      const breakPair = item.items.find((pair) => scalarString(pair.key) === 'break');
      const breakSource = breakPair ? conditionSource(breakPair.value) : undefined;
      if (breakPair) {
        const parsed = breakSource === undefined ? undefined : parseExpression(breakSource);
        const node = (breakPair.value ?? breakPair.key ?? item) as Node;
        const reject = (message: string): void => {
          diagnostics.push({ ...locate(file, lineCounter, node, `${field}.break`, `${stepLabel} break ${message}`), code: 'bad_loop' });
        };
        if (!parsed) reject('must be an expression');
        else if (!parsed.ok) reject(`does not parse at column ${parsed.column}: ${parsed.message}`);
      }
      const forEach = forEachPair ? parseForEach(forEachPair.value ?? forEachPair.key, `${field}.for_each`, stepLabel, ctx) : undefined;
      if (inGraph) {
        const nodes: Record<StepExpression['what'], unknown> = {
          if: ifPair?.value,
          'loop.while': valueNode(stepLoopPair?.value, 'while'),
          break: breakPair?.value,
          for_each: isMap(forEachPair?.value) ? valueNode(forEachPair.value, 'items') : forEachPair?.value,
        };
        for (const { what, source } of stepExpressions({ if: condition, loop: stepLoop, break: breakSource, forEach })) {
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
        diagnostics.push(locate(file, lineCounter, outputPair.key as Node, `${field}.output`, `${stepLabel} output is not allowed on a workflow step; declare outputs in the workflow it runs`));
      } else if (outputPair?.value) {
        output = parseOutput(outputPair.value, `${field}.output`, ctx, 'output');
        if (output && workflowField(output) !== undefined && id) {
          producers.push({ id, node: outputPair.value, field: `${field}.output`, repeats: bindsItem || loop !== undefined });
        }
      } else if (outputPair) {
        diagnostics.push(locate(file, lineCounter, outputPair.key ?? item, `${field}.output`, 'output must be a shorthand type'));
      }
      const workspacePair = item.items.find((pair) => scalarString(pair.key) === 'workspace');
      const workspace = parseStepWorkspace(workspacePair?.value);
      if (workspacePair && !workspace) {
        diagnostics.push({
          ...locate(file, lineCounter, workspacePair.value ?? workspacePair.key ?? item, `${field}.workspace`, `${stepLabel} workspace must be read-only, new, continue, or { clone: { commit, repo?, team } } with a full commit and team { treatment: none } or { revision, selection, treatment }`),
          code: 'bad_workspace',
        });
      }
      const sessionPair = item.items.find((pair) => scalarString(pair.key) === 'session');
      const deliverPair = item.items.find((pair) => scalarString(pair.key) === 'deliver');
      const deliver = scalarString(deliverPair?.value)?.trim();
      // Only what no enclosing step can change is checked per file. A prompt without workspace may continue the copy of
      // the step that runs its workflow, so workflow start checks it on the whole tree.
      const undeliverable = deliver !== 'pr' ? `${stepLabel} deliver must be pr; TeamAI opens a pull request and never merges`
        : workspace === 'read-only' ? `${stepLabel} has deliver: pr but runs read-only; set workspace: new so it has a branch to deliver`
          : commandPair && workspace === undefined ? `${stepLabel} has deliver: pr but runs read-only, as a command without workspace does; set workspace: new so it has a branch to deliver`
            : undefined;
      if (deliverPair && undeliverable) {
        diagnostics.push({
          ...locate(file, lineCounter, deliverPair.value ?? deliverPair.key ?? item, `${field}.deliver`, undeliverable),
          code: 'bad_delivery',
        });
      }
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
            ...locate(file, lineCounter, sessionPair.value ?? sessionPair.key ?? item, `${field}.session`, `${stepLabel} session must be continue, or { from: <step> }`),
            code: 'bad_session',
          });
        }
        if (session && (workflowPair || endPair && actions.length === 0)) {
          diagnostics.push({
            ...locate(file, lineCounter, sessionPair.key ?? item, `${field}.session`, `${stepLabel} session is only allowed on a command or prompt step`),
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
          ...(runsFrom ? { workflow: runsFrom } : {}),
          ...(workflow ? { workflow } : {}),
          ...(withValues ? { with: withValues } : {}),
          ...(agent ? { agent } : {}),
          ...(tool ? { tool } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(scorers ? { scorers } : {}),
          ...(requires ? { requires } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(budget ? { budget } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(permissions ? { permissions } : {}),
          ...(onLimit ? { onLimit } : {}),
          ...(output ? { output } : {}),
          ...(end ? { end } : {}),
          ...(stepLoop ? { loop: stepLoop } : {}),
          ...(breakSource !== undefined ? { break: breakSource } : {}),
          ...(forEach ? { forEach } : {}),
          ...(workspace ? { workspace } : {}),
          ...(deliver === 'pr' ? { deliver } : {}),
          ...(session ? { session } : {}),
        });
      }
    });
    queue.push(() => diagnostics.push(...sessionProblems(file, lineCounter, steps, parent, sessions)));
    queue.push(() => diagnostics.push(...fromProblems(ctx, steps, fromSites, producers)));
    if (!checks) for (const check of queue) check();
    diagnostics.push(...graphDiagnostics(ctx, graph, seen));
    diagnostics.push(...conditionDiagnostics(ctx, conditions, reads));
    const needsById = new Map(graph.map((step) => [step.id, step.needs]));
    // An inline workflow that is reported has no step here, so reads of it are not checked.
    const children = childrenOf([...references, ...steps.filter((step) => stepWorkflow(step)?.kind === 'inline')], files);
    // A malformed inputs header is already reported; checking reads against it would only add noise.
    // An inline workflow's reads of steps that are not its own are checked by the workflow around it.
    const split = splitReads(reads, at === '' ? undefined : seen);
    outer = split.outer;
    diagnostics.push(...readDiagnostics(file, loopSite ? [...split.local, loopSite] : split.local, { ...readScope(needsById, steps, inputs, children), item: itemBound }));
    for (const problem of loopProblems(steps, stepReads(split.local), loop !== undefined)) {
      const placedStep = placed.get(problem.id);
      const node = problem.key.split('.').reduce<unknown>((map, key) => valueNode(map, key), placedStep?.item);
      diagnostics.push({ ...locate(file, lineCounter, (node ?? placedStep?.item) as Node, `${placedStep?.field}.${problem.key}`, problem.message), code: 'bad_loop' });
    }
    // A malformed ends header is already reported; checking steps against it would only add noise.
    if (!endsPair || ends) diagnostics.push(...endDiagnostics(ctx, ends, endsPair?.value, at, endings, graph));
    const readable = [...steps, ...finallySteps];
    diagnostics.push(...outputDiagnostics(ctx, outputEntries ?? [], at, new Set(readable.map((step) => step.id)), readable, children));
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
  options: BodyOptions,
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
  return parseBody(node, `${field}.`, `${label} workflow`, ctx, inputs, itemBound, options);
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

/** A step that runs `workflow: { from }`, with what it needs as written. */
interface FromSite {
  id: string;
  from: string;
  needs: string[] | undefined;
  node: Node;
  field: string;
}

/** A step whose output has a workflow field, and whether it runs per item or in a workflow loop. */
interface Producer {
  id: string;
  node: Node;
  field: string;
  repeats: boolean;
}

/** The field of `output` that holds a workflow, or undefined when it has none. */
export function workflowField(output: OutputSchema | undefined): string | undefined {
  if (output?.type !== 'object') return undefined;
  return Object.entries(output.fields).find(([, schema]) => schema.type === 'workflow')?.[0];
}

/**
 * A `from` step runs the workflow output of a step it needs directly. A step with a workflow output runs once: the run
 * admits its workflow when it reports and never replaces it, so it may not run per item or in a loop.
 */
function fromProblems({ file, lineCounter }: ParseContext, steps: WorkflowStep[], sites: FromSite[], producers: Producer[]): WorkflowDiagnostic[] {
  const local = new Map(steps.map((step) => [step.id, step]));
  const loops = stepLoops(steps);
  const problems: WorkflowDiagnostic[] = [];
  for (const site of sites) {
    if (!site.needs?.includes(site.from)) {
      problems.push(locate(file, lineCounter, site.node, site.field, `step "${site.id}" workflow.from names "${site.from}", which is not a step it needs`));
      continue;
    }
    const producer = local.get(site.from);
    // A producer that is not a step, or that has a problem of its own, is reported already.
    if (producer && workflowField(producer.output) === undefined) {
      problems.push(locate(file, lineCounter, site.node, site.field, `step "${site.id}" workflow.from names "${site.from}", whose output has no workflow field`));
    }
  }
  for (const producer of producers) {
    if (producer.repeats || [...loops.ranges.values()].some((range) => range.has(producer.id))) {
      problems.push(locate(file, lineCounter, producer.node, producer.field, `step "${producer.id}" outputs a workflow, so it runs once; it may not repeat in a loop or run per item of a for_each`));
    }
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
  if (child.finally) {
    return [locate(file, lineCounter, node, `${field}.workflow`,
      `${label} runs workflow "${workflow}", which has finally steps; only a run of that workflow runs them, so start it with teamai workflow start`)];
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
function childrenOf(steps: Array<Pick<WorkflowStep, 'id' | 'workflow'>>, files: WorkflowFiles | undefined): Map<string, Child> {
  const children = new Map<string, Child>();
  for (const step of steps) {
    const { id } = step;
    const runs = stepWorkflow(step);
    if (runs?.kind === 'inline') {
      children.set(id, { label: `the inline workflow of step "${id}"`, outputs: runs.workflow.outputs, ends: runs.workflow.ends });
      continue;
    }
    if (!files || runs?.kind !== 'named' || files.cycle(runs.name)) continue;
    const child = files.runnable(runs.name);
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

/**
 * A step's `model`: an alias or a model name, as `parseModel` reads it, or the exact model, `{ name, effort? }`, which
 * the lease carries as written and no driver resolves through models/aliases.yaml.
 */
function parseStepModel(node: Node | null | undefined, field: string, ctx: ParseContext): string | StepModel | undefined {
  if (!isMap(node)) return parseModel(node, field, ctx);
  const name = scalarString(valueNode(node, 'name'));
  const effortNode = valueNode(node, 'effort');
  const effort = scalarString(effortNode);
  const known = node.items.every((pair) => isScalar(pair.key) && EXACT_MODEL_KEYS.has(String(pair.key.value)));
  if (name === undefined || !known || modelValueProblem(name) !== undefined || (effortNode !== undefined && modelValueProblem(effort) !== undefined)) {
    ctx.diagnostics.push(locate(ctx.file, ctx.lineCounter, node, field, 'model must be an alias or a model name, or { name, effort? } with the exact model'));
    return undefined;
  }
  return { name, ...(effort !== undefined ? { effort } : {}) };
}

function parseDefaults(node: Node | null | undefined, ctx: ParseContext): WorkflowDefaults | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node)) {
    diagnostics.push(locate(file, lineCounter, node, 'defaults', 'defaults must be a mapping'));
    return undefined;
  }
  let model: string | undefined;
  let scorers: { batch: boolean } | undefined;
  let requires: Requirements | undefined;
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (key === 'model') model = parseModel(valueNode(node, 'model'), 'defaults.model', ctx);
    else if (key === 'scorers') scorers = parseDefaultScorers(valueNode(node, 'scorers'), ctx);
    else if (key === 'requires') requires = parseRequires(valueNode(node, 'requires'), 'defaults.requires', ctx);
    else diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `defaults.${key ?? 'key'}`, key ?? 'key'));
  }
  if (model === undefined && scorers === undefined && requires === undefined) return undefined;
  return { ...(model !== undefined ? { model } : {}), ...(scorers ? { scorers } : {}), ...(requires ? { requires } : {}) };
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

/** A step's `scorers`: a list of names, or `{ names, batch, sampling }`. */
function parseScorers(node: Node | null | undefined, field: string, ctx: ParseContext): StepScorers | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  let list: Node | null | undefined = node;
  let batch: boolean | undefined;
  let sampling: 'all' | undefined;
  if (isMap(node)) {
    list = undefined;
    for (const pair of node.items) {
      const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
      const key = scalarString(keyNode);
      if (key === 'names') list = valueNode(node, 'names');
      else if (key === 'batch') batch = parseBatch(valueNode(node, 'batch'), `${field}.batch`, ctx);
      else if (key === 'sampling') sampling = parseSampling(valueNode(node, 'sampling'), `${field}.sampling`, ctx);
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
    if (name === undefined || !SCORER_NAME.test(name)) {
      diagnostics.push(locate(file, lineCounter, list, field, `scorer ${name === undefined ? 'names' : `"${name}"`} must be a token, the name of a file in scorers/`));
    } else if (names.includes(name)) {
      diagnostics.push(locate(file, lineCounter, list, field, `scorers lists "${name}" twice`));
    } else {
      names.push(name);
    }
  }
  return { names, ...(batch !== undefined ? { batch } : {}), ...(sampling ? { sampling } : {}) };
}

function parseSampling(node: Node | undefined, field: string, ctx: ParseContext): 'all' | undefined {
  if (isScalar(node) && node.value === 'all') return 'all';
  ctx.diagnostics.push(locate(ctx.file, ctx.lineCounter, node, field, 'sampling must be all, which judges every pass; leave it out to use each scorer\'s samplingRate'));
  return undefined;
}

/**
 * `requires` maps requirement names to values. A name this version does not know is `unknown_key`, so an older CLI
 * drops the workflow rather than run it without the requirement.
 */
function parseRequires(node: Node | null | undefined, field: string, ctx: ParseContext): Requirements | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node)) {
    diagnostics.push(locate(file, lineCounter, node, field, `${field} must map ${[...REQUIREMENT_KEYS].join(', ')} to values`));
    return undefined;
  }
  const before = diagnostics.length;
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (key === undefined || !REQUIREMENT_KEYS.has(key)) diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
  }
  const parsed = RequirementsSchema.safeParse(node.toJSON());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [key] = issue.path;
      const at = typeof key === 'string' ? valueNode(node, key) ?? node : node;
      diagnostics.push(locate(file, lineCounter, at, [field, ...issue.path].join('.'), `${[field, ...issue.path].join('.')}: ${issue.message}`));
    }
  }
  return parsed.success && diagnostics.length === before ? parsed.data : undefined;
}

/** How the walk reached a level: through the workflow files on the way, from the step of this file that runs them. */
interface Caller {
  /** How the message reaches the level, such as `steps[1].workflow runs workflow "check", whose `. */
  says: string;
  /** The workflow files on the way there, so a cycle among them ends the walk. */
  runs: readonly string[];
  /** Where to report a level in another file: the `workflow` of the step that runs it. */
  at?: { node: Node | undefined; field: string };
}

/**
 * Reports each level of `workflow`, parsed from `node`, whose own `requires.env` names a credential that the strict
 * sandbox in effect there withholds anyway: its `defaults`, its steps, inline workflows, and, with `files`, the
 * workflow files its steps run, reported at the step of this file that runs them.
 */
function withheldEnvRequired(node: Node | undefined, workflow: { defaults?: WorkflowDefaults; steps: readonly WorkflowStep[] }, at: string, outer: InEffect, ctx: ParseContext, caller: Caller): void {
  const report = (requires: InEffect, level: unknown, field: string, env: readonly string[] | undefined): void => {
    const withheld = withheldKeys(requires, env);
    if (withheld.length === 0) return;
    const where = caller.at ?? { node: valueNode(valueNode(level, 'requires'), 'env') ?? node, field: `${field}.requires.env` };
    ctx.diagnostics.push(locate(ctx.file, ctx.lineCounter, where.node, where.field,
      `${caller.says}${field}.requires.env names ${withheld.join(', ')}, which the strict sandbox it runs in withholds from every step. Remove ${withheld.length > 1 ? 'them' : 'it'} from requires.env, or drop strict.`));
  };
  const scope = mergeRequirements(outer, workflow.defaults?.requires);
  report(scope, valueNode(node, 'defaults'), `${at}defaults`, workflow.defaults?.requires?.env);
  const steps = valueNode(node, 'steps');
  workflow.steps.forEach((step, index) => {
    const item = isSeq(steps) ? steps.items[index] : undefined;
    const field = `${at}steps[${index}]`;
    const requires = mergeRequirements(scope, step.requires);
    report(requires, item, field, step.requires?.env);
    const runs = stepWorkflow(step);
    if (runs?.kind === 'inline') withheldEnvRequired(valueNode(item, 'workflow'), runs.workflow, `${field}.workflow.`, requires, ctx, caller);
    if (runs?.kind !== 'named' || caller.runs.includes(runs.name)) return;
    const child = ctx.files?.runnable(runs.name);
    if (child) {
      withheldEnvRequired(undefined, child, '', requires, ctx, {
        says: `${caller.says}${field}.workflow runs workflow "${runs.name}", whose `, runs: [...caller.runs, runs.name],
        at: caller.at ?? { node: valueNode(item, 'workflow'), field: `${field}.workflow` },
      });
    }
  });
}

/** The keys of a level's own `requires.env` that the strict sandbox in effect there withholds. */
function withheldKeys(requires: InEffect, env: readonly string[] = []): string[] {
  return requires.floor?.isolation === 'sandbox' ? env.filter((key) => sameEnvName(SANDBOX_WITHHELD_ENV, key) !== undefined) : [];
}

/** A step's `workspace`: `read-only`, `new`, `continue`, or `{ clone: … }`; undefined when it is none of them. */
function parseStepWorkspace(node: Node | null | undefined): StepWorkspace | undefined {
  const text = scalarString(node)?.trim();
  if (text === 'read-only' || text === 'new' || text === 'continue') return text;
  if (!isMap(node)) return undefined;
  const parsed = z.object({ clone: ClonePlaceSchema }).strict().safeParse(node.toJSON());
  return parsed.success ? parsed.data : undefined;
}

/** `setup: { command, requires: { env } }`. A key this version does not know, at either level, is `unknown_key`. */
function parseSetup(node: Node | null | undefined, ctx: ParseContext): Setup | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node)) {
    diagnostics.push(locate(file, lineCounter, node, 'setup', 'setup must be { command: <shell command>, requires: { env: [...] } }'));
    return undefined;
  }
  const before = diagnostics.length;
  const unknownKeys = (map: YAMLMap, field: string, known: readonly string[]): void => {
    for (const pair of map.items) {
      const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
      const key = scalarString(keyNode);
      if (key === undefined || !known.includes(key)) diagnostics.push(unknownKey(file, lineCounter, keyNode ?? map, `${field}.${key ?? 'key'}`, key ?? 'key'));
    }
  };
  unknownKeys(node, 'setup', ['command', 'requires']);
  const requires = valueNode(node, 'requires');
  if (isMap(requires)) unknownKeys(requires, 'setup.requires', ['env']);
  const parsed = SetupSchema.safeParse(node.toJSON());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') continue;
      const field = ['setup', ...issue.path].join('.');
      const [key] = issue.path;
      const at = typeof key === 'string' ? valueNode(node, key) ?? node : node;
      diagnostics.push(locate(file, lineCounter, at, field, issue.path[0] === 'command' ? 'setup.command must be a shell command' : `${field}: ${issue.message}`));
    }
  }
  return parsed.success && diagnostics.length === before ? parsed.data : undefined;
}

/** A positive whole number of `ms`, `s`, `m`, or `h`, such as `30s` or `2h`, read as milliseconds; undefined otherwise. */
export function durationMs(text: string): number | undefined {
  const [, amount = '', unit = ''] = DURATION.exec(text.trim()) ?? [];
  const ms = Number(amount) * (DURATION_UNITS.get(unit) ?? 0);
  return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}

/** A `timeout`, read with durationMs. */
function parseTimeout(node: Node | null | undefined, field: string, ctx: ParseContext): number | undefined {
  const ms = durationMs(scalarString(node) ?? '');
  if (ms !== undefined) return ms;
  ctx.diagnostics.push(locate(ctx.file, ctx.lineCounter, node, field, `${field} must be a positive duration, such as 500ms, 30s, 10m, or 2h`));
  return undefined;
}

/**
 * A step's `on_limit`, or undefined when it is not one. `ends` is what the step runs: a prompt's turn ends at its
 * `timeout`, `max_turns` or `budget`; a workflow step's `timeout` and `budget` are the allowance its prompts spend.
 */
function parseOnLimit(
  node: Node | null | undefined, { field, stepLabel, ends, limits }: { field: string; stepLabel: string; ends: 'prompt' | 'workflow' | 'fan-out' | 'none' | undefined; limits: { timeout: boolean; budget: boolean; maxTurns: boolean } },
  ctx: ParseContext,
): OnLimit | undefined {
  const value = scalarString(node);
  const problem = (message: string): undefined => {
    ctx.diagnostics.push(locate(ctx.file, ctx.lineCounter, node, field, `${stepLabel} ${message}`));
    return undefined;
  };
  const onLimit = ON_LIMIT.find((known) => known === value);
  if (onLimit === undefined) return problem('on_limit must be end_turn or fail');
  switch (ends) {
    // A step with no action already reports every key it may not carry.
    case undefined:
      return onLimit;
    case 'none':
      return problem('on_limit is only allowed on a prompt, prompt_file or workflow step');
    case 'fan-out':
      return problem('on_limit is not allowed on a for_each step');
    case 'prompt':
      return limits.timeout || limits.budget || limits.maxTurns ? onLimit : problem('on_limit needs a timeout, max_turns or budget to end the turn at');
    case 'workflow':
      return limits.timeout || limits.budget ? onLimit : problem('on_limit on a workflow step needs a timeout or budget, which its prompts spend');
    default: {
      const unhandled: never = ends;
      return unhandled;
    }
  }
}

/** A `budget`: `{ tokens: <positive whole number> }`. A key this version does not know is `unknown_key`. */
function parseBudget(node: Node | null | undefined, field: string, ctx: ParseContext): Budget | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  if (!isMap(node)) {
    diagnostics.push(locate(file, lineCounter, node, field, `${field} must be { tokens: <count> }`));
    return undefined;
  }
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (key !== 'tokens') diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
  }
  const tokensNode = valueNode(node, 'tokens');
  const tokens: unknown = isScalar(tokensNode) ? tokensNode.value : undefined;
  if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0) return { tokens };
  diagnostics.push(locate(file, lineCounter, tokensNode ?? node, `${field}.tokens`, `${field}.tokens must be a positive whole number of tokens`));
  return undefined;
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
    const outputValueNode = isYamlNode(pair.value) ? pair.value : undefined;
    const source = scalarString(outputValueNode);
    const parsed = source === undefined ? undefined : parseExpression(source);
    if (source === undefined || !parsed?.ok || parsed.expression.kind !== 'path' || parsed.expression.path.root !== 'steps') {
      diagnostics.push(locate(file, lineCounter, outputValueNode ?? keyNode, `${prefix}outputs.${name}`, `output "${name}" must be a path that reads a step, ${OUTPUT_PATH}`));
      continue;
    }
    entries.push({ name, source, node: outputValueNode as Node, path: parsed.expression.path });
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
    const step = steps.find((candidate) => candidate.id === path.step);
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
    const cycleIds = [...cycle.slice(start), ...cycle.slice(0, start)];
    const step = byId.get(cycleIds[0] ?? '');
    if (!step) continue;
    diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" is in a needs cycle: ${[...cycleIds, step.id].join(' -> ')}`));
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
    const runs = runner && stepWorkflow(runner);
    if (runs?.kind !== 'inline') return [];
    runners.push(runner);
    levels.push(runs.workflow.steps);
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
