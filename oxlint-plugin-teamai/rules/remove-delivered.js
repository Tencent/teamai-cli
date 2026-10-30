import { defineRule } from '@oxlint/plugins';

import { isOneOf } from '../utils.js';

/** The files where pull deletes the copies it delivered (#1577). */
const PULL_SIDE_FILES = ['src/pull.ts', 'src/resources/skills.ts', 'src/resources/rules.ts', 'src/resources/agents.ts'];

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Delete a delivered copy and its delivery record entry in one call, removeDelivered.' },
  },
  create(context) {
    if (!isOneOf(context, PULL_SIDE_FILES)) return {};
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'remove') return;
        context.report({
          node,
          message: 'Delete a delivered copy with removeDelivered(ledger, dest): it also takes the copy off the delivery record, and a bare remove( leaves a stale entry. For a path pull never records, such as a team-repo file, disable this line and say why.',
        });
      },
    };
  },
});
