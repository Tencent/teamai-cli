import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';

function isYamlNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'range' in value;
}
import type { OutputSchema, WorkflowDefinition, WorkflowDiagnostic, WorkflowStep } from './types.js';

const HEADER_KEYS = new Set(['schemaVersion', 'name', 'description', 'steps']);
const STEP_KEYS = new Set(['id', 'command', 'prompt', 'prompt_file', 'agent', 'output']);
const TYPE_NAMES = new Set(['string', 'number', 'boolean']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function formatDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: field "${diagnostic.field}": ${diagnostic.message}`;
}

function unknownKey(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, key: string): WorkflowDiagnostic {
  return {
    ...locate(file, lineCounter, node, field, `${file} uses \`${key}\`, which this teamai does not know. Update teamai.`),
    code: 'unknown_key',
  };
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

function parseOutput(
  node: Node,
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
  const promptFileLocations: Record<number, { line: number; column: number }> = {};
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

  const stepsPair = root.items.find((pair) => scalarString(pair.key) === 'steps');
  const stepsNode = stepsPair?.value;
  const steps: WorkflowStep[] = [];
  if (!isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode ?? stepsPair?.key ?? root, 'steps', 'steps must be a non-empty list'));
  } else {
    const seen = new Set<string>();
    stepsNode.items.forEach((item, index) => {
      const field = `steps[${index}]`;
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
      }
      const commandPair = item.items.find((pair) => scalarString(pair.key) === 'command');
      const command = scalarString(commandPair?.value);
      const promptPair = item.items.find((pair) => scalarString(pair.key) === 'prompt');
      const prompt = scalarString(promptPair?.value);
      const promptFilePair = item.items.find((pair) => scalarString(pair.key) === 'prompt_file');
      const promptFile = scalarString(promptFilePair?.value);
      const actions = [commandPair, promptPair, promptFilePair].filter(Boolean);
      if (actions.length !== 1) {
        diagnostics.push(locate(file, lineCounter, item, field, 'a step has exactly one action: command, prompt, or prompt_file'));
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
      const agentPair = item.items.find((pair) => scalarString(pair.key) === 'agent');
      const agent = scalarString(agentPair?.value)?.trim();
      if (agentPair && (!agent || !TOKEN.test(agent))) {
        diagnostics.push(locate(file, lineCounter, agentPair.value ?? agentPair.key ?? item, `${field}.agent`, 'agent must be a non-empty token'));
      } else if (agentPair && commandPair) {
        diagnostics.push(locate(file, lineCounter, agentPair.key ?? item, `${field}.agent`, 'agent is only allowed on a prompt or prompt_file step'));
      }
      let output: OutputSchema | undefined;
      const outputPair = item.items.find((pair) => scalarString(pair.key) === 'output');
      if (outputPair?.value) {
        output = parseOutput(outputPair.value, `${field}.output`, file, lineCounter, diagnostics);
      } else if (outputPair) {
        diagnostics.push(locate(file, lineCounter, outputPair.key ?? item, `${field}.output`, 'output must be a shorthand type'));
      }
      if (id && TOKEN.test(id) && actions.length === 1 && !diagnostics.some((d) => d.field.startsWith(field))) {
        steps.push({
          id,
          ...(command ? { command } : {}),
          ...(prompt ? { prompt } : {}),
          ...(promptFile ? { promptFile } : {}),
          ...(agent ? { agent } : {}),
          ...(output ? { output } : {}),
        });
      }
    });
  }

  if (diagnostics.length > 0 || !name || !description) return { ok: false, diagnostics };
  return {
    ok: true,
    definition: { schemaVersion: 'v1alpha1', name, description, steps },
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
