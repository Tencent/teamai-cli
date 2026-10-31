import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';
import learningsRoot from './rules/learnings-root.js';

import configuredToolPaths from './rules/configured-tool-paths.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'configured-tool-paths': configuredToolPaths,
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
    'learnings-root': learningsRoot,
  },
});
