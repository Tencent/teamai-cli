import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { importVisitors } from '../imports.js';
import { scopedFiles, sourcePath } from '../utils.js';

/** The folders that may launch a tool: the workflow drivers, and the launcher itself. */
const ALLOWED = ['src/workflow/', 'src/tool-launch/'];

/** The modules that launch a tool, and the names that do; `undefined` is every name. */
/** @type {Record<string, string[] | undefined>} */
const LAUNCHERS = {
  'src/tool-launch/call.ts': undefined,
  'src/tool-launch/run.ts': undefined,
  'src/tool-launch/confined.ts': ['runConfined', '*'],
};

/**
 * Callers that launch a tool outside a workflow today. This list may only shrink: move a caller's AI work into a
 * workflow step, then delete its entry. A listed file that no longer imports the launcher is reported, so it is removed.
 */
const BASELINE = scopedFiles([]);

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Launch AI tools only from workflow drivers.' } },
  create(context) {
    const from = sourcePath(context);

    if (ALLOWED.some((folder) => from.startsWith(folder)) || from.startsWith('src/__tests__/') || from.endsWith('.test.ts')) return {};
    const inBaseline = BASELINE.includes(from);
    let launches = false;

    return {
      ...importVisitors(({ node, specifier, typeOnly, names }) => {
        if (typeOnly || !specifier.startsWith('.')) return;
        const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts');

        if (!(to in LAUNCHERS)) return;
        const launching = LAUNCHERS[to];

        if (launching !== undefined && !names.some((name) => launching.includes(name))) return;
        launches = true;

        if (!inBaseline) context.report({ node, message: 'Only a workflow driver launches an AI tool. Run this AI work as a workflow step instead of importing the launcher (docs/designs/ai-through-workflows.md).' });
      }),
      'Program:exit'(node) {
        if (inBaseline && !launches) context.report({ node, message: 'This file no longer launches an AI tool. Remove it from BASELINE in oxlint-plugin-teamai/rules/launch-through-workflows.js.' });
      },
    };
  },
});
