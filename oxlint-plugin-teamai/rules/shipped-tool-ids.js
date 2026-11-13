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
  // Detects a shipped tool's installed version from its own executable.
  'src/agent-version.ts': { count: 1 },
  // Reads the recorded homes of shipped tools.
  'src/doctor.ts': { count: 1 },
  'src/doctor-delivery.ts': { count: 1 },
  // Detects shipped tools before any team config, and so any instance, is loaded.
  'src/known-agents.ts': { count: 2 },
  // The shipped tool's install gate, and the leftovers of a shipped tool's default home that releases before #1221 wrote.
  'src/locate.ts': { count: 3 },
  'src/mcp-reconcile.ts': { count: 1 },
  // The legacy agent Markdown only shipped tools wrote.
  'src/resources/agent-folders.ts': { count: 1 },
  // Parses an instance's `extends`, which must name a shipped tool.
  'src/tool-instances.ts': { count: 4 },
  // A confined launch runs a shipped tool's own adapter; the local driver passes it the base of an instance.
  'src/tool-launch/confined.ts': { count: 1 },
  'src/workflow/drivers/local/local-driver.ts': { count: 1 },
  // Not yet resolved for an instance: team agents for an instance, model aliases keyed by shipped tool, and the
  // session a skill-driver run works in. Each moves to toolOf when that tool's instances get the feature.
  'src/resources/agents.ts': { count: 7 },
  'src/models/aliases.ts': { count: 1 },
  'src/benchmark/start.ts': { count: 1 },
  'src/scorers/judge-model.ts': { count: 1 },
  'src/workflow/confined-place.ts': { count: 1 },
  'src/workflow/confined-step.ts': { count: 1 },
  'src/workflow/step-model.ts': { count: 1 },
  'src/workflow/drivers/skill/child-model.ts': { count: 1 },
  'src/workflow/drivers/skill/skill-driver.ts': { count: 2 },
  'src/workflow/drivers/skill/skill-state.ts': { count: 1 },
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
