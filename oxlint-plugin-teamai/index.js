import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';
import learningsRoot from './rules/learnings-root.js';

import configuredToolPaths from './rules/configured-tool-paths.js';

import launchEnv from './rules/launch-env.js';

import noProviderMerge from './rules/no-provider-merge.js';

import workflowBoundaries from './rules/workflow-boundaries.js';

import windowsTests from './rules/windows-tests.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'configured-tool-paths': configuredToolPaths,
    'launch-env': launchEnv,
    'no-provider-merge': noProviderMerge,
    'workflow-boundaries': workflowBoundaries,
    'windows-tests': windowsTests,
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
    'learnings-root': learningsRoot,
  },
});
