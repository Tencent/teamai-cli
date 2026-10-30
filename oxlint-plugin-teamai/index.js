import { definePlugin } from '@oxlint/plugins';

import removeDelivered from './rules/remove-delivered.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'remove-delivered': removeDelivered,
  },
});
