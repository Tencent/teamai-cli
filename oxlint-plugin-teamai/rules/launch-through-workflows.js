import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { importVisitors } from '../imports.js';
import { lintedPath, sourcePath, stringLiteralValue, workspaceRoot } from '../utils.js';

/** The folders that may launch a tool: the workflow drivers, and the runtimes that launch tools for them. */
export const ALLOWED = ['src/workflow/', 'packages/runtime-tools/', 'packages/runtime-sandbox/'];

/**
 * The modules that launch a tool, by repository path or by package, and the names that do; `undefined` is every name.
 * A package's entry covers every subpath of it.
 */
/** @type {Record<string, string[] | undefined>} */
export const LAUNCHERS = {
  'src/workflow/runtimes/tool-caller.ts': undefined,
  'src/workflow/confined-launch.ts': ['runConfined', '*'],
  '@teamai/runtime-tools': undefined,
  '@teamai/tool-launch': undefined,
};

/**
 * The entry of LAUNCHERS an import of `specifier` from `from` reaches: the repository path of a relative one, or the
 * package of an `@teamai/` one, any subpath of it.
 * @param {string} from
 * @param {string} specifier
 */
function launcherOf(from, specifier) {
  if (specifier.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts');

  if (!specifier.startsWith('@teamai/')) return undefined;
  const [scope, name] = specifier.split('/');

  return `${scope}/${name}`;
}

/** The executable of every tool teamai launches, as `executableOf` in src/launch-registry.ts names it; a test keeps the two equal. */
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
    // From the workspace root, so a package's own folder is told apart from src/: `packages/runtime-tools/src/x.ts`.
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));
    const from = root === undefined ? sourcePath(context) : path.posix.relative(root, file);

    if (ALLOWED.some((folder) => from.startsWith(folder)) || from.startsWith('src/__tests__/') || from.endsWith('.test.ts')) return {};

    return {
      ...importVisitors(({ node, specifier, typeOnly, names }) => {
        const to = typeOnly ? undefined : launcherOf(from, specifier);

        if (to === undefined || !(to in LAUNCHERS)) return;
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
