/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf, isScriptSource, sourcePath } from '../utils.js';

/** The fields of a tool's paths, each relative to a scope's base: joined by hand, a path under $HOME misses a home that moved. */
/** @type {ReadonlySet<unknown>} */
const CONFIGURED = new Set(['skills', 'rules', 'claudemd', 'settings', 'agents', 'hooks', 'mcp', 'mcpProject']);

/** `path`, or a host's path module (`host.path`, `at.path`). */
function isPathModule(/** @type {ESTree.Node} */ node) {
  return (node.type === 'Identifier' && node.name === 'path')
    || (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'path');
}

/** The configured field `node` reads (`x.settings`, `x?.['rules']`), or undefined. */
function configuredFieldOf(/** @type {ESTree.Node | null | undefined} */ node) {
  const member = node?.type === 'ChainExpression' ? node.expression : node;

  if (member?.type !== 'MemberExpression') return undefined;

  const property = member.computed && member.property.type === 'Literal' ? member.property.value
    : !member.computed && member.property.type === 'Identifier' ? member.property.name : undefined;

  return CONFIGURED.has(property) ? String(property) : undefined;
}

/** `join` or `resolve` when `call` is `path.join`/`resolve`, a host's `X.path.join`, or a bare imported `join`. */
function joinOf(/** @type {ESTree.CallExpression} */ call) {
  const callee = call.callee;

  const operation = callee.type === 'Identifier' ? callee.name
    : callee.type === 'MemberExpression' && isPathModule(callee.object) && callee.property.type === 'Identifier' ? callee.property.name : undefined;

  return operation === 'join' || operation === 'resolve' ? operation : undefined;
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Resolve configured tool paths through locate.' } },
  create(context) {
    if (!(inProductionSource(context) || isScriptSource(sourcePath(context))) || isOneOf(context, ['src/locate.ts'])) return {};
    const reported = new Set();

    const report = (/** @type {ESTree.CallExpression} */ call, /** @type {string} */ property) => {
      if (reported.has(call)) return;
      reported.add(call);
      context.report({ node: call, message: `A tool's configured ${property} path joined by hand misses a tool home that moved, such as an instance's under its home.env. Resolve it with locate(), toolPathUnder() or hookSettingsFile() from src/locate.ts.` });
    };

    /** The configured field a never-reassigned variable `identifier` names was read from: `const s = paths.settings`, `const { skills } = paths`. */
    const heldField = (/** @type {ESTree.IdentifierReference} */ identifier) => {
      const variable = context.sourceCode.getScope(identifier).references.find((reference) => reference.identifier === identifier)?.resolved;

      if (!variable || variable.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init)) return undefined;
      const [definition] = variable.defs;

      if (definition?.type !== 'Variable' || definition.node.type !== 'VariableDeclarator') return undefined;
      const { id, init } = definition.node;

      if (id.type === 'Identifier') return configuredFieldOf(init);

      if (id.type !== 'ObjectPattern') return undefined;
      const property = id.properties.find((entry) => entry.type === 'Property' && entry.value === definition.name);

      if (property?.type !== 'Property' || property.computed || property.key.type !== 'Identifier') return undefined;

      return CONFIGURED.has(property.key.name) ? property.key.name : undefined;
    };

    return {
      MemberExpression(node) {
        const property = configuredFieldOf(node);

        if (property === undefined) return;

        for (let /** @type {ESTree.Node | null} */ parent = node.parent; parent !== null; parent = parent.parent) {
          if (parent.type === 'CallExpression' && joinOf(parent) !== undefined) report(parent, property);
        }
      },
      CallExpression(node) {
        if (joinOf(node) === undefined) return;

        for (const argument of node.arguments) {
          const property = argument.type === 'Identifier' ? heldField(argument) : undefined;

          if (property !== undefined) report(node, property);
        }
      },
    };
  },
});
