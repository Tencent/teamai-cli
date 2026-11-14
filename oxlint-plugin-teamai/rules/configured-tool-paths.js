/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf } from '../utils.js';

/** The fields of a tool's paths, each relative to a scope's base: joined by hand, a path under $HOME misses a home that moved. */
/** @type {ReadonlySet<unknown>} */
const CONFIGURED = new Set(['skills', 'rules', 'claudemd', 'settings', 'agents', 'hooks', 'mcp', 'mcpProject']);

/** `path`, or a host's path module (`host.path`, `at.path`). */
function isPathModule(/** @type {ESTree.Node} */ node) {
  return (node.type === 'Identifier' && node.name === 'path')
    || (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'path');
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Resolve configured tool paths through locate.' } },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, ['src/locate.ts'])) return {};
    const reported = new Set();

    return {
      MemberExpression(node) {
        const property = node.computed && node.property.type === 'Literal' ? node.property.value
          : !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;

        if (!CONFIGURED.has(property)) return;
        /** @type {ESTree.Node | null} */
        let parent = node.parent;

        for (; parent !== null; parent = parent.parent) {
          if (parent.type !== 'CallExpression') continue;
          const callee = parent.callee;

          const operation = callee.type === 'Identifier' ? callee.name
            : callee.type === 'MemberExpression' && isPathModule(callee.object) && callee.property.type === 'Identifier' ? callee.property.name : undefined;

          if ((operation !== 'join' && operation !== 'resolve') || reported.has(parent)) continue;
          reported.add(parent);
          context.report({ node: parent, message: `A tool's configured ${property} path joined by hand misses a tool home that moved, such as an instance's under its home.env. Resolve it with locate(), toolPathUnder() or hookSettingsFile() from src/locate.ts.` });
        }
      },
    };
  },
});
