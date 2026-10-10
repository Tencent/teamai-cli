import { afterEach } from 'vitest';

// Vitest's worker sends each task update over RPC with a 60s timeout, and
// reads the reply only when its event loop turns. A run of synchronous tests
// (spawnSync of the CLI) never lets it turn, so on a slow runner a streak past
// 60s fails the run with `Timeout calling "onTaskUpdate"` though every test
// passed. Yield once after each test so the streak is one test long.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
