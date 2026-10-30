import { definePlugin } from '@oxlint/plugins';

import removeDelivered from './rules/remove-delivered.js';
import learningsRoot from './rules/learnings-root.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'remove-delivered': removeDelivered,
    'learnings-root': learningsRoot,
  },
});
