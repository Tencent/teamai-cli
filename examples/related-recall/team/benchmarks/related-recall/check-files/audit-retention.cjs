const assert = require('node:assert/strict');

assert.equal(require('./limits.cjs').auditRetentionDays(), 47);
