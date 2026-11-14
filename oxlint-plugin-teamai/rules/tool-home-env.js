import { defineRule } from '@oxlint/plugins';
import { inProductionSource, inTestSupport, isOneOf, isScriptSource, repositoryPath, sourcePath, stringLiteralValue } from '../utils.js';

/** @typedef {import('@oxlint/plugins').ESTree.Node} Node */

/** The one module that decides which home variables start a tool's command (`toolCommandEnv`). */
const OWNER = 'src/tool-launch/tools.ts';

/**
 * Every variable that moves a shipped tool's home, as `toolHomeVariableNames` in `src/tool-home.ts` lists them, which
 * covers each launch profile's `homeEnv`. `src/__tests__/tool-home-env-variables.test.ts` pins the two together.
 */
export const HOME_VARIABLES = new Set([
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEBUDDY_CONFIG_DIR', 'COPILOT_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'DSH_HOME', 'HERMES_DATA_DIR_SUFFIX', 'HERMES_HOME',
  'JOYCODE_HOME', 'OMP_PROFILE', 'OPENCLAW_HOME', 'OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
  'PI_CONFIG_DIR', 'PI_PROFILE', 'QODERCN_CLI_HOME', 'QODERCN_CONFIG_DIR', 'QODER_CLI_HOME', 'QODER_CONFIG_DIR', 'XDG_CONFIG_HOME',
]);

/** The fields that hold a home variable's name: a relocatable spec's, a launch profile's, a descriptor home's, an instance home's. */
const VARIABLE_FIELDS = new Set(['envVar', 'homeEnv', 'rootVariable', 'env']);

/** The calls that answer with a home variable's name. */
const VARIABLE_CALLS = new Set(['homeVariableOf', 'deliveredHomeVariableOf']);

/**
 * Files that spell a home variable as data, never to set it: the descriptors and launch profiles that declare each
 * tool's, the registry and `RELOCATABLE_TOOLS` that list them, and `tool-home.ts`, which reads them and names the one
 * that moved a home. A write there is still caught by its form.
 */
const NAMING_FILES = /^(packages\/tool-[a-z-]+\/src\/(definitions|launch)\.ts|src\/(tool-registry|tool-home|types)\.ts)$/;

/**
 * The name `node`, a member's property, spells when it is not computed.
 * @param {Node} node
 * @returns {string | undefined}
 */
function propertyName(node) {
  return node.type === 'Identifier' ? node.name : undefined;
}

/**
 * Whether the computed key `node` evaluates to a tool's home variable: a literal one, a field that holds one
 * (`spec.envVar`, `instance.home.env`, `profile.homeEnv`, `home.rootVariable`), or `homeVariableOf(...)`.
 * @param {Node} node
 * @returns {boolean}
 */
function namesHomeVariable(node) {
  const literal = stringLiteralValue(node);

  if (literal !== undefined) return HOME_VARIABLES.has(literal);

  if (node.type === 'ChainExpression') return namesHomeVariable(node.expression);

  if (node.type === 'TSNonNullExpression') return namesHomeVariable(node.expression);

  if (node.type === 'CallExpression') return node.callee.type === 'Identifier' && VARIABLE_CALLS.has(node.callee.name);

  if (node.type !== 'MemberExpression' || node.computed) return false;
  const field = propertyName(node.property);

  return field !== undefined && VARIABLE_FIELDS.has(field);
}

/**
 * Whether the key of a property or member, `computed` or not, is a tool's home variable.
 * @param {Node} key
 * @param {boolean} computed
 * @returns {boolean}
 */
function isHomeVariableKey(key, computed) {
  if (computed) return namesHomeVariable(key);
  const name = propertyName(key) ?? stringLiteralValue(key);

  return name !== undefined && HOME_VARIABLES.has(name);
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Set a tool\'s home variable on a command only through toolCommandEnv.' },
  },
  create(context) {
    // `@teamai/tool-testing` is test-only and never bundled (its package.json): it stands in for teamai's toolCommandEnv.
    const testOnly = repositoryPath(context).relative.startsWith('packages/tool-testing/');
    const inScope = (inProductionSource(context) && !inTestSupport(context) && !testOnly) || isScriptSource(sourcePath(context));

    if (!inScope || isOneOf(context, [OWNER])) return {};
    const message = 'Take a tool\'s home variables from toolCommandEnv in src/tool-launch/tools.ts, the one place that decides which variables start a tool\'s command in which home, instead of setting one here.';
    const namingFile = NAMING_FILES.test(repositoryPath(context).relative);

    return {
      // A spelling outside the files that name these variables: whatever form writes it (a tuple loop, Object.assign,
      // Reflect.set) starts from this literal. A computed member's key is a read, or a write the assignment check reports.
      Literal(node) {
        const value = stringLiteralValue(node);

        if (namingFile || value === undefined || !HOME_VARIABLES.has(value)) return;
        const { parent } = node;

        if ((parent?.type === 'Property' && parent.key === node) || parent?.type === 'TSLiteralType') return;

        if (parent?.type === 'MemberExpression' && parent.computed && parent.property === node) return;
        context.report({ node, message: `${value} is spelled here, where nothing should set it: ${message} A read of the variable takes \`env.${value}\`.` });
      },
      Property(node) {
        if (node.parent.type === 'ObjectExpression' && isHomeVariableKey(node.key, node.computed)) context.report({ node: node.key, message });
      },
      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression' && isHomeVariableKey(node.left.property, node.left.computed)) context.report({ node: node.left, message });
      },
    };
  },
});
