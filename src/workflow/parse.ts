import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';
import { extractReferencesFromText, parseExpression } from './expr.js';
import type { InlineWorkflow, OutputSchema, WorkflowDefinition, WorkflowDiagnostic, WorkflowStep } from './types.js';

function isYamlNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'range' in value;
}

const HEADER_KEYS = new Set(['schemaVersion', 'name', 'description', 'inputs', 'outputs', 'ends', 'steps']);
const STEP_KEYS = new Set(['id', 'needs', 'if', 'command', 'env', 'prompt', 'prompt_file', 'agent', 'workflow', 'with', 'output', 'end']);
const TYPE_NAMES = new Set(['string', 'number', 'boolean']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function formatDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: field "${diagnostic.field}": ${diagnostic.message}`;
}

function unknownKey(file: string, lineCounter: LineCounter, node: unknown, field: string, key: string): WorkflowDiagnostic {
  return {
    ...locate(file, lineCounter, node, field, `${file} uses \`${key}\`, which this teamai does not know. Update teamai.`),
    code: 'unknown_key',
  };
}

function locate(file: string, lineCounter: LineCounter, node: unknown, field: string, message: string): WorkflowDiagnostic {
  let line = 1;
  let column = 1;
  const n = (node && typeof node === 'object' && 'range' in node) ? (node as Node) : null;
  const offset = n?.range?.[0];
  if (typeof offset === 'number') {
    const pos = lineCounter.linePos(offset);
    line = pos.line;
    column = pos.col;
  }
  return { file, line, column, field, message };
}

function scalarString(node: unknown): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value;
}

function parseOutput(
  node: unknown,
  field: string,
  file: string,
  lineCounter: LineCounter,
  diagnostics: WorkflowDiagnostic[],
): OutputSchema | undefined {
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
    const items = parseOutput(item, `${field}[]`, file, lineCounter, diagnostics);
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
      if (!key || !TOKEN.test(key) || !valueNode) {
        diagnostics.push(locate(file, lineCounter, keyNode ?? node, field, 'output field names must be tokens'));
        continue;
      }
      const child = parseOutput(valueNode, `${field}.${key}`, file, lineCounter, diagnostics);
      if (child) fields[key] = child;
    }
    return Object.keys(fields).length === node.items.length ? { type: 'object', fields } : undefined;
  }
  diagnostics.push(locate(file, lineCounter, node, field, 'output shorthand must be string, number, boolean, a literal union, an object, or an array'));
  return undefined;
}

interface StepParseResult {
  steps: WorkflowStep[];
  promptFileLocations: Record<number, { line: number; column: number }>;
}

function parseStepsList(
  stepsNode: Node,
  prefix: string,
  file: string,
  lineCounter: LineCounter,
  diagnostics: WorkflowDiagnostic[],
): StepParseResult {
  const steps: WorkflowStep[] = [];
  const promptFileLocations: Record<number, { line: number; column: number }> = {};
  if (!isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode, prefix, `${prefix} must be a non-empty list`));
    return { steps, promptFileLocations };
  }

  const seen = new Set<string>();
  stepsNode.items.forEach((item, index) => {
    const field = `${prefix}[${index}]`;
    if (!isMap(item)) {
      diagnostics.push(locate(file, lineCounter, item, field, 'a step must be a mapping'));
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
    }

    // needs
    let needs: string[] | undefined;
    const needsPair = item.items.find((pair) => scalarString(pair.key) === 'needs');
    if (needsPair) {
      if (isSeq(needsPair.value)) {
        needs = [];
        for (const it of needsPair.value.items) {
          if (isScalar(it) && typeof it.value === 'string' && TOKEN.test(it.value)) {
            needs.push(it.value);
          } else {
            diagnostics.push(locate(file, lineCounter, isYamlNode(it) ? it : needsPair.value, `${field}.needs`, 'needs items must be token step ids'));
          }
        }
      } else {
        diagnostics.push(locate(file, lineCounter, needsPair.value ?? needsPair.key, `${field}.needs`, 'needs must be a list of step ids'));
      }
    }

    // if
    let ifCond: string | undefined;
    const ifPair = item.items.find((pair) => scalarString(pair.key) === 'if');
    if (ifPair) {
      let val: string | undefined;
      if (isScalar(ifPair.value) && typeof ifPair.value.value === 'boolean') {
        val = String(ifPair.value.value);
      } else {
        val = scalarString(ifPair.value)?.trim();
      }
      if (!val) {
        diagnostics.push(locate(file, lineCounter, ifPair.value ?? ifPair.key, `${field}.if`, 'if must be a non-empty expression string'));
      } else {
        try {
          parseExpression(val);
          ifCond = val;
        } catch (err) {
          diagnostics.push(locate(file, lineCounter, ifPair.value ?? ifPair.key, `${field}.if`, `invalid expression: ${(err as Error).message}`));
        }
      }
    }

    // env
    let env: Record<string, string> | undefined;
    const envPair = item.items.find((pair) => scalarString(pair.key) === 'env');
    if (envPair) {
      if (isMap(envPair.value)) {
        env = {};
        for (const pair of envPair.value.items) {
          const k = scalarString(pair.key);
          const vNode = pair.value;
          let vStr: string | undefined;
          if (isScalar(vNode)) {
            vStr = String(vNode.value ?? '');
          } else {
            vStr = undefined;
          }
          if (!k || vStr === undefined) {
            diagnostics.push(locate(file, lineCounter, pair.key ?? envPair.value, `${field}.env`, 'env values must be strings'));
          } else {
            env[k] = vStr;
          }
        }
      } else {
        diagnostics.push(locate(file, lineCounter, envPair.value ?? envPair.key, `${field}.env`, 'env must be a mapping'));
      }
    }

    // with
    let withInputs: Record<string, unknown> | undefined;
    const withPair = item.items.find((pair) => scalarString(pair.key) === 'with');
    if (withPair) {
      if (isMap(withPair.value)) {
        withInputs = {};
        for (const pair of withPair.value.items) {
          const k = scalarString(pair.key);
          if (!k || !TOKEN.test(k)) {
            diagnostics.push(locate(file, lineCounter, pair.key ?? withPair.value, `${field}.with`, 'with keys must be tokens'));
          } else if (isScalar(pair.value)) {
            withInputs[k] = pair.value.value;
          } else if (isMap(pair.value) || isSeq(pair.value)) {
            withInputs[k] = pair.value.toJSON();
          }
        }
      } else {
        diagnostics.push(locate(file, lineCounter, withPair.value ?? withPair.key, `${field}.with`, 'with must be a mapping'));
      }
    }

    // end
    let end: string | undefined;
    const endPair = item.items.find((pair) => scalarString(pair.key) === 'end');
    if (endPair) {
      const val = scalarString(endPair.value)?.trim();
      if (!val || !TOKEN.test(val)) {
        diagnostics.push(locate(file, lineCounter, endPair.value ?? endPair.key, `${field}.end`, 'end must be a non-empty token'));
      } else {
        end = val;
      }
    }

    // Actions
    const commandPair = item.items.find((pair) => scalarString(pair.key) === 'command');
    const command = scalarString(commandPair?.value);
    const promptPair = item.items.find((pair) => scalarString(pair.key) === 'prompt');
    const prompt = scalarString(promptPair?.value);
    const promptFilePair = item.items.find((pair) => scalarString(pair.key) === 'prompt_file');
    const promptFile = scalarString(promptFilePair?.value);
    const workflowPair = item.items.find((pair) => scalarString(pair.key) === 'workflow');

    let workflowVal: string | InlineWorkflow | undefined;
    if (workflowPair) {
      if (isScalar(workflowPair.value)) {
        const wfName = scalarString(workflowPair.value)?.trim();
        if (!wfName || !TOKEN.test(wfName)) {
          diagnostics.push(locate(file, lineCounter, workflowPair.value ?? workflowPair.key, `${field}.workflow`, 'workflow reference must be a non-empty token'));
        } else {
          workflowVal = wfName;
        }
      } else if (isMap(workflowPair.value)) {
        // Inline workflow
        const inlineStepsPair = workflowPair.value.items.find((p) => scalarString(p.key) === 'steps');
        if (!inlineStepsPair || !isSeq(inlineStepsPair.value)) {
          diagnostics.push(locate(file, lineCounter, workflowPair.value, `${field}.workflow`, 'inline workflow must have steps'));
        } else {
          const inlineParsed = parseStepsList(inlineStepsPair.value, `${field}.workflow.steps`, file, lineCounter, diagnostics);
          let inlineOutputs: Record<string, string> | undefined;
          const inlineOutputsPair = workflowPair.value.items.find((p) => scalarString(p.key) === 'outputs');
          if (inlineOutputsPair && isMap(inlineOutputsPair.value)) {
            inlineOutputs = {};
            for (const p of inlineOutputsPair.value.items) {
              const k = scalarString(p.key);
              const v = scalarString(p.value)?.trim();
              if (k && TOKEN.test(k) && v) {
                inlineOutputs[k] = v;
              }
            }
          }
          workflowVal = {
            steps: inlineParsed.steps,
            ...(inlineOutputs ? { outputs: inlineOutputs } : {}),
          };
        }
      } else {
        diagnostics.push(locate(file, lineCounter, workflowPair.value ?? workflowPair.key, `${field}.workflow`, 'workflow must be a workflow name or inline workflow'));
      }
    }

    const actions = [commandPair, promptPair, promptFilePair, workflowPair].filter(Boolean);
    if (actions.length > 1) {
      diagnostics.push(locate(file, lineCounter, item, field, 'a step has at most one action: command, prompt, prompt_file, or workflow'));
    } else if (actions.length === 0 && !end) {
      diagnostics.push(locate(file, lineCounter, item, field, 'a step must have an action (command, prompt, prompt_file, workflow) or end'));
    }

    if (commandPair && (command === undefined || command.trim() === '')) {
      diagnostics.push(locate(file, lineCounter, commandPair?.value ?? commandPair?.key ?? item, `${field}.command`, 'command must be a non-empty string'));
    }
    if (promptPair && (prompt === undefined || prompt.trim() === '')) {
      diagnostics.push(locate(file, lineCounter, promptPair.value ?? promptPair.key ?? item, `${field}.prompt`, 'prompt must be a non-empty string'));
    }
    if (promptFilePair) {
      if (!isPromptFilePath(promptFile)) {
        diagnostics.push(locate(file, lineCounter, promptFilePair.value ?? promptFilePair.key ?? item, `${field}.prompt_file`, 'prompt_file must be a relative path under prompts/'));
      } else if (isYamlNode(promptFilePair.value)) {
        const position = locate(file, lineCounter, promptFilePair.value, `${field}.prompt_file`, '');
        promptFileLocations[index] = { line: position.line, column: position.column };
      }
    }

    // agent
    const agentPair = item.items.find((pair) => scalarString(pair.key) === 'agent');
    const agent = scalarString(agentPair?.value)?.trim();
    if (agentPair && (!agent || !TOKEN.test(agent))) {
      diagnostics.push(locate(file, lineCounter, agentPair.value ?? agentPair.key ?? item, `${field}.agent`, 'agent must be a non-empty token'));
    } else if (agentPair && (commandPair || workflowPair || actions.length === 0)) {
      diagnostics.push(locate(file, lineCounter, agentPair.key ?? item, `${field}.agent`, 'agent is only allowed on a prompt or prompt_file step'));
    }

    // env only on command
    if (envPair && !commandPair) {
      diagnostics.push(locate(file, lineCounter, envPair.key ?? item, `${field}.env`, 'env is only allowed on a command step'));
    }

    // with only on workflow
    if (withPair && !workflowPair) {
      diagnostics.push(locate(file, lineCounter, withPair.key ?? item, `${field}.with`, 'with is only allowed on a workflow step'));
    }

    let output: OutputSchema | undefined;
    const outputPair = item.items.find((pair) => scalarString(pair.key) === 'output');
    if (outputPair?.value) {
      output = parseOutput(outputPair.value, `${field}.output`, file, lineCounter, diagnostics);
    } else if (outputPair) {
      diagnostics.push(locate(file, lineCounter, outputPair.key ?? item, `${field}.output`, 'output must be a shorthand type'));
    }

    if (id && TOKEN.test(id) && actions.length <= 1 && (actions.length === 1 || end) && !diagnostics.some((d) => d.field.startsWith(field))) {
      steps.push({
        id,
        ...(needs ? { needs } : {}),
        ...(ifCond ? { if: ifCond } : {}),
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        ...(prompt ? { prompt } : {}),
        ...(promptFile ? { promptFile } : {}),
        ...(agent ? { agent } : {}),
        ...(workflowVal ? { workflow: workflowVal } : {}),
        ...(withInputs ? { with: withInputs } : {}),
        ...(output ? { output } : {}),
        ...(end ? { end } : {}),
      });
    }
  });

  return { steps, promptFileLocations };
}

/**
 * Validates graph structure and semantics of a workflow:
 * - missing references
 * - cycles
 * - unreachable steps
 * - invalid outputs
 * - unreachable declared ends
 */
function validateWorkflowGraph(
  definition: WorkflowDefinition,
  file: string,
  diagnostics: WorkflowDiagnostic[],
): void {
  const stepMap = new Map<string, WorkflowStep>();
  const stepIndices = new Map<string, number>();
  for (const [i, s] of definition.steps.entries()) {
    stepMap.set(s.id, s);
    stepIndices.set(s.id, i);
  }

  const declaredInputs = new Set(Object.keys(definition.inputs ?? {}));
  const declaredEnds = new Set(Object.keys(definition.ends ?? {}));

  // Determine effective dependencies
  // If NO step has `needs`, each step i > 0 depends on step i-1 (sequential workflow)
  const anyHasNeeds = definition.steps.some((s) => s.needs !== undefined);
  const effectiveDeps = new Map<string, string[]>();

  for (const [i, step] of definition.steps.entries()) {
    if (anyHasNeeds) {
      effectiveDeps.set(step.id, step.needs ? [...step.needs] : []);
    } else {
      effectiveDeps.set(step.id, i > 0 ? [definition.steps[i - 1]!.id] : []);
    }
  }

  // 1. Check missing references in needs
  for (const [i, step] of definition.steps.entries()) {
    const field = `steps[${i}].needs`;
    if (step.needs) {
      for (const dep of step.needs) {
        if (!stepMap.has(dep)) {
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field,
            message: `step "${dep}" needed by "${step.id}" does not exist in this workflow`,
          });
        } else if (dep === step.id) {
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field,
            message: `step "${step.id}" cannot depend on itself`,
          });
        }
      }
    }

    // Check expression references in if, env, with
    const exprTexts: Array<{ fieldName: string; text: string }> = [];
    if (step.if) exprTexts.push({ fieldName: `steps[${i}].if`, text: step.if });
    if (step.env) {
      for (const [k, v] of Object.entries(step.env)) {
        exprTexts.push({ fieldName: `steps[${i}].env.${k}`, text: v });
      }
    }
    if (step.with) {
      for (const [k, v] of Object.entries(step.with)) {
        if (typeof v === 'string') {
          exprTexts.push({ fieldName: `steps[${i}].with.${k}`, text: v });
        }
      }
    }

    for (const { fieldName, text } of exprTexts) {
      const refs = extractReferencesFromText(text);
      for (const refStep of refs.steps) {
        if (!stepMap.has(refStep)) {
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field: fieldName,
            message: `step "${step.id}" references missing step "${refStep}"`,
          });
        }
      }
      for (const refInput of refs.inputs) {
        if (definition.inputs && !declaredInputs.has(refInput)) {
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field: fieldName,
            message: `step "${step.id}" references input "${refInput}" which is not declared in inputs`,
          });
        }
      }
    }

    // Check end declared in ends
    if (step.end && definition.ends && !declaredEnds.has(step.end)) {
      diagnostics.push({
        file,
        line: 1,
        column: 1,
        field: `steps[${i}].end`,
        message: `step "${step.id}" specifies end "${step.end}" which is not declared in workflow ends`,
      });
    }
  }

  // 2. Cycle detection in dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cyclesFound = new Set<string>();

  function dfsCycle(nodeId: string, path: string[]) {
    visited.add(nodeId);
    inStack.add(nodeId);
    path.push(nodeId);

    const deps = effectiveDeps.get(nodeId) ?? [];
    for (const dep of deps) {
      if (!stepMap.has(dep)) continue;
      if (inStack.has(dep)) {
        const cycleStartIndex = path.indexOf(dep);
        const cycle = path.slice(cycleStartIndex).concat(dep);
        const cycleKey = cycle.join(' -> ');
        if (!cyclesFound.has(cycleKey)) {
          cyclesFound.add(cycleKey);
          const stepIndex = stepIndices.get(nodeId) ?? 0;
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field: `steps[${stepIndex}].needs`,
            message: `cycle detected in step dependencies: ${cycleKey}`,
          });
        }
      } else if (!visited.has(dep)) {
        dfsCycle(dep, path);
      }
    }

    path.pop();
    inStack.delete(nodeId);
  }

  for (const step of definition.steps) {
    if (!visited.has(step.id)) {
      dfsCycle(step.id, []);
    }
  }

  // 3. Reachability of steps
  // In a DAG, roots are steps with no effective dependencies.
  // Reachable steps are those reachable by forward traversal from any root.
  const roots: string[] = [];
  const dependents = new Map<string, string[]>();
  for (const step of definition.steps) {
    dependents.set(step.id, []);
  }
  for (const [id, deps] of effectiveDeps) {
    if (deps.length === 0) {
      roots.push(id);
    }
    for (const dep of deps) {
      if (dependents.has(dep)) {
        dependents.get(dep)!.push(id);
      }
    }
  }

  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (reachable.has(curr)) continue;
    reachable.add(curr);
    for (const next of dependents.get(curr) ?? []) {
      // A step is reachable if at least one of its dependency paths can be reached
      if (!reachable.has(next)) {
        queue.push(next);
      }
    }
  }

  for (const [i, step] of definition.steps.entries()) {
    if (!reachable.has(step.id)) {
      diagnostics.push({
        file,
        line: 1,
        column: 1,
        field: `steps[${i}]`,
        message: `step "${step.id}" is unreachable`,
      });
    }
  }

  // Check unconditional end step making subsequent steps unreachable
  let unconditionalEndSeen: string | null = null;
  for (const [i, step] of definition.steps.entries()) {
    if (!anyHasNeeds && unconditionalEndSeen !== null) {
      diagnostics.push({
        file,
        line: 1,
        column: 1,
        field: `steps[${i}]`,
        message: `step "${step.id}" is unreachable because step "${unconditionalEndSeen}" ends the workflow unconditionally`,
      });
    }
    if (step.end && !step.if && !step.command && !step.prompt && !step.workflow) {
      unconditionalEndSeen = step.id;
    }
  }

  // 4. Validate outputs
  if (definition.outputs) {
    for (const [outName, expr] of Object.entries(definition.outputs)) {
      const field = `outputs.${outName}`;
      try {
        if (expr.includes('{{')) {
          const subExprs = [...expr.matchAll(/\{\{\s*([\s\S]+?)\s*\}\}/g)].map((m) => m[1]);
          for (const sub of subExprs) {
            parseExpression(sub);
          }
        } else {
          parseExpression(expr);
        }
      } catch (err) {
        diagnostics.push({
          file,
          line: 1,
          column: 1,
          field,
          message: `invalid expression in outputs: ${(err as Error).message}`,
        });
      }
      const refs = extractReferencesFromText(expr);
      for (const refStep of refs.steps) {
        if (!stepMap.has(refStep)) {
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field,
            message: `output "${outName}" references step "${refStep}" which does not exist in this workflow`,
          });
        }
      }
      for (const refInput of refs.inputs) {
        if (definition.inputs && !declaredInputs.has(refInput)) {
          diagnostics.push({
            file,
            line: 1,
            column: 1,
            field,
            message: `output "${outName}" references input "${refInput}" which is not declared in inputs`,
          });
        }
      }
    }
  }

  // 5. Reachability of declared ends
  if (definition.ends) {
    for (const endName of declaredEnds) {
      const stepsWithEnd = definition.steps.filter((s) => s.end === endName);
      if (stepsWithEnd.length === 0) {
        diagnostics.push({
          file,
          line: 1,
          column: 1,
          field: `ends.${endName}`,
          message: `declared end "${endName}" is not reached by any step in this workflow`,
        });
      } else if (!stepsWithEnd.some((s) => reachable.has(s.id))) {
        diagnostics.push({
          file,
          line: 1,
          column: 1,
          field: `ends.${endName}`,
          message: `declared end "${endName}" is unreachable`,
        });
      }
    }
  }
}

/**
 * Parse one workflow file. A failure is a list of diagnostics; it does not throw,
 * so one bad file cannot stop the rest of a sync.
 */
export function parseWorkflow(file: string, content: string): {
  ok: true;
  definition: WorkflowDefinition;
  promptFileLocations: Record<number, { line: number; column: number }>;
} | { ok: false; diagnostics: WorkflowDiagnostic[] } {
  const diagnostics: WorkflowDiagnostic[] = [];
  if (content.trim() === '') {
    return { ok: false, diagnostics: [{ file, line: 1, column: 1, field: '(root)', message: 'workflow file is empty' }] };
  }

  const lineCounter = new LineCounter();
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

  // inputs
  let inputs: Record<string, OutputSchema> | undefined;
  const inputsPair = root.items.find((pair) => scalarString(pair.key) === 'inputs');
  if (inputsPair) {
    if (isMap(inputsPair.value)) {
      inputs = {};
      for (const pair of inputsPair.value.items) {
        const k = scalarString(pair.key);
        if (!k || !TOKEN.test(k)) {
          diagnostics.push(locate(file, lineCounter, pair.key ?? inputsPair.value, 'inputs', 'input names must be tokens'));
          continue;
        }
        if (isYamlNode(pair.value)) {
          const parsed = parseOutput(pair.value, `inputs.${k}`, file, lineCounter, diagnostics);
          if (parsed) inputs[k] = parsed;
        }
      }
    } else {
      diagnostics.push(locate(file, lineCounter, inputsPair.value ?? inputsPair.key, 'inputs', 'inputs must be a mapping'));
    }
  }

  // outputs
  let outputs: Record<string, string> | undefined;
  const outputsPair = root.items.find((pair) => scalarString(pair.key) === 'outputs');
  if (outputsPair) {
    if (isMap(outputsPair.value)) {
      outputs = {};
      for (const pair of outputsPair.value.items) {
        const k = scalarString(pair.key);
        const v = scalarString(pair.value)?.trim();
        if (!k || !TOKEN.test(k)) {
          diagnostics.push(locate(file, lineCounter, pair.key ?? outputsPair.value, 'outputs', 'output names must be tokens'));
          continue;
        }
        if (!v) {
          diagnostics.push(locate(file, lineCounter, pair.value ?? pair.key, `outputs.${k}`, 'output values must be expressions'));
        } else {
          outputs[k] = v;
        }
      }
    } else {
      diagnostics.push(locate(file, lineCounter, outputsPair.value ?? outputsPair.key, 'outputs', 'outputs must be a mapping'));
    }
  }

  // ends
  let ends: Record<string, 'succeeded' | 'failed'> | undefined;
  const endsPair = root.items.find((pair) => scalarString(pair.key) === 'ends');
  if (endsPair) {
    if (isMap(endsPair.value)) {
      ends = {};
      for (const pair of endsPair.value.items) {
        const k = scalarString(pair.key);
        if (!k || !TOKEN.test(k)) {
          diagnostics.push(locate(file, lineCounter, pair.key ?? endsPair.value, 'ends', 'end names must be tokens'));
          continue;
        }
        let outcome: 'succeeded' | 'failed' | undefined;
        if (isScalar(pair.value)) {
          const v = scalarString(pair.value)?.trim();
          if (v === 'succeeded' || v === 'failed') {
            outcome = v;
          }
        } else if (isMap(pair.value)) {
          const statusPair = pair.value.items.find((p) => scalarString(p.key) === 'status');
          const v = scalarString(statusPair?.value)?.trim();
          if (v === 'succeeded' || v === 'failed') {
            outcome = v;
          }
        }
        if (!outcome) {
          diagnostics.push(locate(file, lineCounter, pair.value ?? pair.key, `ends.${k}`, 'end outcome must be succeeded or failed'));
        } else {
          ends[k] = outcome;
        }
      }
    } else if (isSeq(endsPair.value)) {
      ends = {};
      for (const item of endsPair.value.items) {
        if (isMap(item)) {
          const idPair = item.items.find((p) => scalarString(p.key) === 'id');
          const statusPair = item.items.find((p) => scalarString(p.key) === 'status');
          const id = scalarString(idPair?.value)?.trim();
          const status = scalarString(statusPair?.value)?.trim() ?? 'succeeded';
          if (!id || !TOKEN.test(id)) {
            diagnostics.push(locate(file, lineCounter, idPair?.value ?? item, 'ends', 'end names must be tokens'));
          } else if (status !== 'succeeded' && status !== 'failed') {
            diagnostics.push(locate(file, lineCounter, statusPair?.value ?? item, `ends.${id}`, 'end outcome must be succeeded or failed'));
          } else {
            ends[id] = status as 'succeeded' | 'failed';
          }
        } else {
          diagnostics.push(locate(file, lineCounter, item, 'ends', 'end list items must be mappings'));
        }
      }
    } else {
      diagnostics.push(locate(file, lineCounter, endsPair.value ?? endsPair.key, 'ends', 'ends must be a mapping or list'));
    }
  }

  const stepsPair = root.items.find((pair) => scalarString(pair.key) === 'steps');
  const stepsNode = stepsPair?.value;
  let steps: WorkflowStep[] = [];
  let promptFileLocations: Record<number, { line: number; column: number }> = {};

  if (!stepsNode || !isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode ?? stepsPair?.key ?? root, 'steps', 'steps must be a non-empty list'));
  } else {
    const res = parseStepsList(stepsNode, 'steps', file, lineCounter, diagnostics);
    steps = res.steps;
    promptFileLocations = res.promptFileLocations;
  }

  const definition: WorkflowDefinition = {
    schemaVersion: 'v1alpha1',
    name: name ?? '',
    description: description ?? '',
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    ...(ends ? { ends } : {}),
    steps,
  };

  // Run graph validations if syntax parse didn't have errors
  if (steps.length > 0) {
    validateWorkflowGraph(definition, file, diagnostics);
  }

  if (diagnostics.length > 0 || !name || !description) return { ok: false, diagnostics };
  return {
    ok: true,
    definition,
    promptFileLocations,
  };
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isPromptFilePath(value: string | undefined): value is string {
  if (!value || value.trim() === '' || pathIsAbsolute(value)) return false;
  const segments = value.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  return segments.length >= 2 && segments[0] === 'prompts' && !segments.includes('..');
}
