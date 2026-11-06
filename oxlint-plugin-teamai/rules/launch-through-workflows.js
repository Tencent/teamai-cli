import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { importVisitors } from '../imports.js';
import { sourcePath, stringLiteralValue } from '../utils.js';

/** The folders that may launch a tool: the workflow drivers, and the launcher itself. */
const ALLOWED = ['src/workflow/', 'src/tool-launch/'];

/** The modules that launch a tool, and the names that do; `undefined` is every name. */
/** @type {Record<string, string[] | undefined>} */
const LAUNCHERS = {
  'src/tool-launch/call.ts': undefined,
  'src/tool-launch/run.ts': undefined,
  'src/tool-launch/confined.ts': ['runConfined', '*'],
};

/** The executable of every tool teamai launches, as `executableOf` in src/tool-launch/tools.ts names it; a test keeps the two equal. */
export const TOOL_EXECUTABLES = new Set([
  'claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'opencode', 'codebuddy', 'workbuddy', 'openclaw',
  'cursor-agent', 'copilot', 'qodercli', 'kiro-cli', 'pi', 'omp', 'muse', 'hermes', 'agy',
]);

/** The first argument of each tool binary call that asks the tool about itself or its sessions, and no model; `--version` for any tool. */
/** @type {Record<string, string[]>} */
const NO_AI = { claude: ['plugin'], opencode: ['serve', 'session'] };

/** The functions that start a process from a command and its arguments: node's, cross-spawn's, execa's, and teamai's wrappers. */
const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'crossSpawn', 'execa', 'execaSync', 'execCommand', 'probeBinary', 'execute']);

/** @param {any} callee */
function calleeName(callee) {
  if (callee?.type === 'Identifier') return callee.name;

  if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier') return callee.property.name;

  return undefined;
}

/** @param {any} node */
function literalText(node) {
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked;

  return stringLiteralValue(node);
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Launch AI tools only from workflow drivers.' } },
  create(context) {
    const from = sourcePath(context);

    if (ALLOWED.some((folder) => from.startsWith(folder)) || from.startsWith('src/__tests__/') || from.endsWith('.test.ts')) return {};

    return {
      ...importVisitors(({ node, specifier, typeOnly, names }) => {
        if (typeOnly || !specifier.startsWith('.')) return;
        const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts');

        if (!(to in LAUNCHERS)) return;
        const launching = LAUNCHERS[to];

        if (launching !== undefined && !names.some((name) => launching.includes(name))) return;
        context.report({ node, message: 'Only a workflow driver launches an AI tool. Run this AI work as a workflow step instead of importing the launcher (docs/designs/ai-through-workflows.md).' });
      }),
      /** @param {any} node */
      CallExpression(node) {
        const spawner = calleeName(node.callee) ?? '';
        const executable = SPAWNERS.has(spawner) ? literalText(node.arguments[0]) : undefined;

        if (executable === undefined || !TOOL_EXECUTABLES.has(executable)) return;
        const args = node.arguments[1];
        // probeBinary asks for `--version` when it is given no arguments.
        const first = args === undefined && spawner === 'probeBinary' ? '--version' : args?.type === 'ArrayExpression' ? literalText(args.elements[0]) : undefined;

        if (first !== undefined && (first === '--version' || (NO_AI[executable] ?? []).includes(first))) return;
        context.report({ node, message: `Only a workflow driver runs the AI tool ${executable}. Run this AI work as a workflow step instead (docs/designs/ai-through-workflows.md).` });
      },
    };
  },
});
