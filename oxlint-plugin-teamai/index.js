import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';
import learningsRoot from './rules/learnings-root.js';
import configuredToolPaths from './rules/configured-tool-paths.js';
import launchEnv from './rules/launch-env.js';
import noProviderMerge from './rules/no-provider-merge.js';
import workflowBoundaries from './rules/workflow-boundaries.js';
import windowsTests from './rules/windows-tests.js';
import rulesLocate from './rules/rules-locate.js';
import workflowFailureCodes from './rules/workflow-failure-codes.js';
import configLoadOptions from './rules/config-load-options.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'config-load-options': configLoadOptions,
    'configured-tool-paths': configuredToolPaths,
    'launch-env': launchEnv,
    'no-provider-merge': noProviderMerge,
    'workflow-boundaries': workflowBoundaries,
    'windows-tests': windowsTests,
    'rules-locate': rulesLocate,
    'workflow-failure-codes': workflowFailureCodes,
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
    'learnings-root': learningsRoot,
  },
});
