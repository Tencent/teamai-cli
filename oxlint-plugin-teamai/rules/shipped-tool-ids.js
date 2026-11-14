/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { isProductionSource, repositoryPath, scopedFiles } from '../utils.js';

/** The two predicates that hold only for a tool teamai ships, never for a tool instance a team or member defines. */
const SHIPPED_ONLY_PREDICATES = new Set(['isToolId', 'isAgentToolId']);

/** Where they are defined: the registry, and the registry factory it is built from. */
const DEFINITIONS = new Set(scopedFiles(['src/tool-registry.ts', 'packages/tool-core/src/registry.ts']));

/**
 * Files that still name a predicate, with how many times and why each one means only a tool teamai ships. A new
 * reference in any file fails; this list only shrinks, and a count above what the file holds fails until it is lowered.
 */
export const SHIPPED_ONLY = new Map(Object.entries({
  // A version detector runs the shipped tool's own executable; an instance may run another build, so its version is
  // unknown and its hooks stay waited.
  'src/agent-version.ts': { count: 1 },
  // A toolPaths entry replaces the default of the shipped tool it names; an instance replaces its own only through its
  // `paths`, read just before.
  'src/doctor-delivery.ts': { count: 1 },
  // Detects the shipped tools a developer uses in their home before any team config, and so any instance, is loaded.
  'src/known-agents.ts': { count: 1 },
  // A shipped tool's install gate and the leftovers of its default home that releases before #1221 wrote; and the
  // sessions channel, typed over the shipped session platforms: an instance's own store is read through `storeDirOf`
  // (src/session-flow/adapters/index.ts).
  'src/locate.ts': { count: 3 },
  // The leftovers of a shipped tool's default home that releases before #1221 wrote.
  'src/mcp-reconcile.ts': { count: 1 },
  // Refuses an instance's `extends` that names no shipped tool, before the gate on the tools instances extend, and a
  // name that takes a shipped tool's.
  'src/tool-instances.ts': { count: 3 },
  // A confined launch runs a shipped tool's own adapter; the local driver passes it the base of an instance.
  // The instances to list beside the shipped tools: one named like a shipped tool adjusts it and is listed already.
  'src/workflow/drivers/local/local-driver.ts': { count: 1 },
  // An aliases file maps the tools teamai ships; an instance takes the entry of the tool it extends.
  'src/models/aliases.ts': { count: 1 },
  // A session variable names the shipped tool that sets it; an instance runs that tool and sets the same variable.
  'src/workflow/drivers/skill/skill-driver.ts': { count: 1 },
}));

scopedFiles([...SHIPPED_ONLY.keys()]);

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Resolve a tool name through toolOf, so a tool instance gets the facts of the tool it extends.' },
  },
  create(context) {
    const { relative } = repositoryPath(context);

    if (!isProductionSource(relative) || DEFINITIONS.has(relative)) return {};
    const allowed = SHIPPED_ONLY.get(relative)?.count ?? 0;
    /** @type {Array<{ node: ESTree.Node, name: string }>} */
    const references = [];

    return {
      Identifier(node) {
        if (SHIPPED_ONLY_PREDICATES.has(node.name) && node.parent?.type !== 'ImportSpecifier') references.push({ node, name: node.name });
      },
      'Program:exit'(node) {
        if (references.length > allowed) {
          for (const { node: reference, name } of references) {
            context.report({ node: reference, message: `${name} is false for a tool instance, so it gets none of the facts of the tool it extends. Resolve the name with toolOf, baseToolOf, baseDescriptorOf, agentFormatOf or toolHomeOf; a check that must hold only for a shipped tool takes a SHIPPED_ONLY entry in oxlint-plugin-teamai/rules/shipped-tool-ids.js, with its reason.` });
          }
        }

        if (references.length < allowed) {
          context.report({ node, message: `${relative} names isToolId or isAgentToolId fewer times than SHIPPED_ONLY allows: lower or remove its entry in oxlint-plugin-teamai/rules/shipped-tool-ids.js.` });
        }
      },
    };
  },
});
