const assert = require('node:assert/strict');

assert.equal(require('./limits.cjs').retryDelayMs(), 13700);
