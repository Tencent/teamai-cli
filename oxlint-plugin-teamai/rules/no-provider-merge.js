import { defineRule } from '@oxlint/plugins';
import { isOneOf, scopedFiles, sourcePath } from '../utils.js';

const DELIVERY = scopedFiles(['src/workflow/pr-delivery.ts']);

const MERGE = /\b(?:pr|mr)\s+merge\b|^merge(?:[-_]?pulls?)?$|\/merge\b(?!\s+requests?)|\/accept\b|auto_?merge|merge_when_pipeline_succeeds|mergePullRequest/i;
export default defineRule({
  meta: { type: 'problem', docs: { description: 'Providers and workflow delivery may find or create pull requests, never merge them.' } },
  create(context) {
    if (!sourcePath(context).startsWith('src/providers/') && !isOneOf(context, DELIVERY)) return {};
    const message = 'Providers and workflow delivery must not merge, accept or enable auto-merge on pull requests.';
    return {
      Literal(node) {
        if (typeof node.value === 'string' && MERGE.test(node.value)) context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => MERGE.test(quasi.value.raw))) context.report({ node, message });
      },
      Identifier(node) {
        if (/^(?:auto_?merge|merge_when_pipeline_succeeds|mergePullRequest)$/i.test(node.name)) context.report({ node, message });
      },
    };
  },
});
