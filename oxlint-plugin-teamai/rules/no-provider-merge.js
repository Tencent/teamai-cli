import { defineRule } from '@oxlint/plugins';

import { lintedPath } from '../utils.js';

const SCOPE = '/src/providers/';
const DELIVERY_FILE = '/src/workflow/pr-delivery.ts';
const DANGEROUS_IDENTIFIER = /^(?:autoMerge|mergePullRequest|auto_merge|merge_when_pipeline_succeeds)$/;

/** @param {string} file */
function isScoped(file) {
  return file.includes(SCOPE) || file.endsWith(DELIVERY_FILE);
}

/** @param {unknown} value */
function dangerousText(value) {
  if (typeof value !== 'string') return false;
  return /^(?:merge|merge[-_]?pulls?|(?:pr|mr)\s+merge)$/i.test(value)
    || /\/merge\b(?!\s+requests?)/i.test(value)
    || /\/accept\b/i.test(value)
    || /auto_?merge|merge_when_pipeline_succeeds|mergePullRequest/i.test(value);
}

/** @param {unknown} callee */
function dangerousCallee(callee) {
  if (typeof callee !== 'object' || callee === null) return false;
  const node = /** @type {{ type?: unknown, name?: unknown, computed?: unknown, property?: unknown }} */ (callee);
  if (node.type === 'Identifier') return typeof node.name === 'string' && (DANGEROUS_IDENTIFIER.test(node.name) || node.name === 'merge');
  if (node.type !== 'MemberExpression' || node.computed) return false;
  const property = /** @type {{ type?: unknown, name?: unknown } | undefined} */ (node.property);
  return property?.type === 'Identifier'
    && typeof property.name === 'string'
    && (DANGEROUS_IDENTIFIER.test(property.name)
      || property.name === 'merge'
      || property.name === 'accept');
}

/** Keep provider and workflow delivery code read-only: it may create requests, never merge them. */
export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Do not merge, accept, or auto-merge pull/merge requests.' },
  },
  create(context) {
    if (!isScoped(lintedPath(context))) return {};
    const message = 'Workflow delivery must not merge, accept, or auto-merge a pull/merge request.';
    return {
      CallExpression(node) {
        if (dangerousCallee(node.callee)) context.report({ node, message });
      },
      Literal(node) {
        if (dangerousText(node.value)) context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => dangerousText(quasi.value.raw))) context.report({ node, message });
      },
      Property(node) {
        const key = node.computed ? undefined : node.key;
        if (key?.type === 'Identifier' && DANGEROUS_IDENTIFIER.test(key.name)) {
          context.report({ node, message });
        }
      },
    };
  },
});
