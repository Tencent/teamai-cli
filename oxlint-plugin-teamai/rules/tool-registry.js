import path from 'node:path';
import { defineRule } from '@oxlint/plugins';

import { importVisitors } from '../imports.js';
import { lintedPath, scopedFiles, sourcePath } from '../utils.js';

/** The raw tool tables, by the module that defines each. */
const TABLES = new Map([
  ['src/tools.ts', 'TOOLS'],
  ['src/tool-launch/adapters.ts', 'LAUNCH_ADAPTERS'],
  ['src/session-flow/adapters/index.ts', 'ADAPTER_REGISTRY'],
]);

/** The families every built-in tool comes from, by the package that lists them. */
const FAMILIES = new Map([['@teamai/tool-definitions', 'BUILT_IN_TOOLS'], ['@teamai/tool-definitions/facts', 'BUILT_IN_FACTS']]);

/**
 * The tables that list every tool in its user-visible order, each row a BUILT_IN_TOOLS or BUILT_IN_FACTS reference. They stay in src/
 * while sessionStoreDir (src/locate.ts) and the readers in NOT_YET_MOVED do.
 */
const FAMILY_MERGES = new Set(scopedFiles(['src/agent-version.ts', 'src/session-flow/adapters/platform-facts.ts', 'src/token-usage/index.ts']));

/** The registry: tool ids and descriptors, and the launch half beside LAUNCH_ADAPTERS, kept apart so the registry imports no adapter. */
const REGISTRY = new Set(scopedFiles(['src/tool-registry.ts', 'src/tool-launch/tools.ts']));

scopedFiles([...TABLES.keys()]);

/**
 * Readers that still import a raw table. A new reader goes through the registry instead; this list only shrinks,
 * and an entry that no longer reads a table fails until it is removed.
 */
const NOT_YET_MOVED = new Set([
  // They read a table until sessionStoreDir (src/locate.ts) moves into tool-core, after the connected-drivers engine lands.
  'src/locate.ts',
  'src/session-flow/index.ts',
])

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Read the tool tables only through the tool registry.' },
  },
  create(context) {
    const file = lintedPath(context);
    const from = sourcePath(context);

    if (!/^(src|scripts)\//.test(from) || from.startsWith('src/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(from)) return {};

    if (REGISTRY.has(from) || TABLES.has(from) || FAMILY_MERGES.has(from)) return {};
    const root = file.slice(0, file.length - from.length);
    let reads = false;

    return {
      ...importVisitors(({ node, specifier, names }) => {
        const owner = specifier.startsWith('.') ? `${path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier)).replace(/\.[cm]?js$/, '')}.ts` : specifier;
        const table = TABLES.get(owner) ?? FAMILIES.get(owner);

        if (table === undefined || !names.some((name) => name === table || name === '*')) return;
        reads = true;

        if (!NOT_YET_MOVED.has(from)) {
          context.report({ node, message: `Read tools through src/tool-registry.ts, not ${table} from ${owner}, so every reader sees the same tools: a tool the registry adds reaches this one too.` });
        }
      }),
      'Program:exit'(node) {
        if (NOT_YET_MOVED.has(from) && !reads) {
          context.report({ node, message: `${from} no longer reads a raw tool table: remove it from NOT_YET_MOVED in oxlint-plugin-teamai/rules/tool-registry.js.` });
        }
      },
    };
  },
});
