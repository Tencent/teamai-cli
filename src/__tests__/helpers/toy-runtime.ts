import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The toy step runtime: a stdio program that runs each `exec` on the host, keeps its handles and outcomes in its
 * `state` option's directory, and with `die_at` kills the teamai that spawned it at a named point.
 */
export const TOY_RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'runtime-toy', 'runtime.mjs');
