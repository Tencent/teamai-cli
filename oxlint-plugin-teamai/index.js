import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';
import learningsRoot from './rules/learnings-root.js';
import noProviderMerge from './rules/no-provider-merge.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
    'learnings-root': learningsRoot,
    'no-provider-merge': noProviderMerge,
  },
});
