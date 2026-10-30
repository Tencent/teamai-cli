import { definePlugin } from '@oxlint/plugins';

import homeEnv from './rules/home-env.js';
import removeDelivered from './rules/remove-delivered.js';

export default definePlugin({
  meta: { name: 'teamai' },
  rules: {
    'home-env': homeEnv,
    'remove-delivered': removeDelivered,
  },
});
