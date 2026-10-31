import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';
import configuredToolPaths from './rules/configured-tool-paths.js';
import learningsRoot from './rules/learnings-root.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
    'configured-tool-paths': configuredToolPaths,
    'learnings-root': learningsRoot,
  },
});
