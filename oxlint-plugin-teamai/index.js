import { register } from 'node:module';
import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';
import attemptResultWrites from './rules/attempt-result-writes.js';
import learningsRoot from './rules/learnings-root.js';
import configuredToolPaths from './rules/configured-tool-paths.js';
import launchEnv from './rules/launch-env.js';
import launchThroughWorkflows from './rules/launch-through-workflows.js';
import noProviderMerge from './rules/no-provider-merge.js';
import workflowBoundaries from './rules/workflow-boundaries.js';
import windowsTests from './rules/windows-tests.js';
import rulesLocate from './rules/rules-locate.js';
import workflowFailureCodes from './rules/workflow-failure-codes.js';
import configLoadOptions from './rules/config-load-options.js';
import toolFacts from './rules/tool-facts.js';
import noLowValueComments from './rules/no-low-value-comments.js';
import suppressionReason from './rules/suppression-reason.js';
import yamlParse from './rules/yaml-parse.js';
import packageBoundaries from './rules/package-boundaries.js';
import toolRegistry from './rules/tool-registry.js';
import mockSource from './rules/mock-source.js';
import processReads from './rules/process-reads.js';
import uncachedEntry from './rules/uncached-entry.js';
import familyFacts from './rules/family-facts.js';
import shippedToolIds from './rules/shipped-tool-ids.js';
import toolHomeEnv from './rules/tool-home-env.js';

// The anti-slop rules are vendored TypeScript. oxlint imports plugins with plain
// Node, and `npm run lint` runs on Node 20 in CI, which can't import TypeScript:
// load them through the esbuild loader the scripts use.
register('../scripts/typescript-loader.mjs', import.meta.url);

const { antiSlopRules } = await import('./anti-slop/index.ts');

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'config-load-options': configLoadOptions,
    'configured-tool-paths': configuredToolPaths,
    'launch-env': launchEnv,
    'launch-through-workflows': launchThroughWorkflows,
    'no-provider-merge': noProviderMerge,
    'workflow-boundaries': workflowBoundaries,
    'windows-tests': windowsTests,
    'rules-locate': rulesLocate,
    'workflow-failure-codes': workflowFailureCodes,
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
    'attempt-result-writes': attemptResultWrites,
    'learnings-root': learningsRoot,
    'tool-facts': toolFacts,
    'no-low-value-comments': noLowValueComments,
    'suppression-reason': suppressionReason,
    'yaml-parse': yamlParse,
    'package-boundaries': packageBoundaries,
    'tool-registry': toolRegistry,
    'mock-source': mockSource,
    'process-reads': processReads,
    'uncached-entry': uncachedEntry,
    'family-facts': familyFacts,
    'shipped-tool-ids': shippedToolIds,
    'tool-home-env': toolHomeEnv,
    ...antiSlopRules,
  },
});
