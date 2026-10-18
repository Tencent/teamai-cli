import { isMap, isScalar, isSeq, type Node } from 'yaml';
import { isYamlNode, locate, scalarString, unknownKey, valueNode, type ParseContext } from './parse-context.js';
import type { StepHitl } from './types.js';

/** Normalizes approve and choose declarations into one HITL request while retaining YAML-key diagnostics. */
export function parseHitl(kind: StepHitl['kind'], node: Node | null | undefined, field: string, ctx: ParseContext): StepHitl | undefined {
  const { file, lineCounter, diagnostics } = ctx;
  const reject = (at: Node | null | undefined, key: string, message: string): void => {
    diagnostics.push(locate(file, lineCounter, at, key, message));
  };
  if (kind === 'approve' && isScalar(node) && typeof node.value === 'string') {
    if (!node.value.trim()) reject(node, field, 'approve must be a non-empty message');
    else return { kind, message: node.value, options: ['yes', 'no'], required: false };
    return undefined;
  }
  if (!isMap(node)) {
    reject(node, field, `${kind} must be a mapping${kind === 'approve' ? ' or a non-empty message' : ''}`);
    return undefined;
  }
  const keys = new Set(kind === 'approve' ? ['message', 'required'] : ['message', 'options', 'default']);
  for (const pair of node.items) {
    const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
    const key = scalarString(keyNode);
    if (!key || !keys.has(key)) diagnostics.push(unknownKey(file, lineCounter, keyNode ?? node, `${field}.${key ?? 'key'}`, key ?? 'key'));
  }
  const messageNode = valueNode(node, 'message');
  const message = scalarString(messageNode);
  if (!message?.trim()) reject(messageNode ?? node, `${field}.message`, `${kind}.message must be a non-empty string`);
  const requiredNode = valueNode(node, 'required');
  const required = isScalar(requiredNode) && requiredNode.value === true;
  if (requiredNode && (!isScalar(requiredNode) || typeof requiredNode.value !== 'boolean')) reject(requiredNode, `${field}.required`, `${kind}.required must be a boolean`);
  let options = ['yes', 'no'];
  const optionsNode = valueNode(node, 'options');
  if (kind === 'choose') {
    const values = isSeq(optionsNode) ? optionsNode.items.map((item) => scalarString(isYamlNode(item) ? item : undefined)) : [];
    if (values.length < 2 || values.some((value) => !value || /\s/.test(value)) || new Set(values).size !== values.length) {
      reject(optionsNode ?? node, `${field}.options`, 'choose.options must contain at least two unique non-empty strings without whitespace');
    } else options = values as string[];
  }
  const defaultNode = valueNode(node, 'default');
  const choice = scalarString(defaultNode);
  if (defaultNode && (!choice || !options.includes(choice))) reject(defaultNode, `${field}.default`, 'choose.default must be one of choose.options');
  return message ? { kind, message, options, required, ...(choice !== undefined ? { default: choice } : {}) } : undefined;
}
