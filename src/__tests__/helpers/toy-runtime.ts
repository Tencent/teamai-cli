import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = path.join(ROOT, 'src', '__tests__', 'fixtures', 'runtime-toy', 'runtime.mjs');
const BUNDLED = [path.join(ROOT, 'packages', 'runtime-protocol', 'src', 'protocol.ts'), ...['home.ts', 'json.ts', 'process-group.ts', 'regular-file.ts'].map((file) => path.join(ROOT, 'packages', 'shared', 'src', file)), ...['launch.ts', 'definition.ts', 'stdout.ts', 'sessions/fs.ts'].map((file) => path.join(ROOT, 'packages', 'tool-core', 'src', file))];

/**
 * The toy built as one executable file, as a runtime ships: its source with @teamai/runtime-protocol bundled in. One
 * build per source revision is kept in the temp directory, so every test file and worker reuses it.
 */
function bundledToy(): string {
  const hash = createHash('sha256').update(fs.readFileSync(SOURCE));

  for (const file of BUNDLED) hash.update(fs.readFileSync(file));
  const revision = hash.digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), `teamai-toy-runtime-${revision}`, 'runtime.mjs');

  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const building = `${file}.${process.pid}.tmp`;
  buildSync({ entryPoints: [SOURCE], outfile: building, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error' });
  fs.chmodSync(building, 0o755);
  fs.renameSync(building, file);

  return file;
}

/**
 * The toy step runtime: a stdio program that runs each `exec` on the host, keeps its handles and outcomes in its
 * `state` option's directory, and with `die_at` kills the teamai that spawned it at a named point.
 */
export const TOY_RUNTIME = bundledToy();

/** The marker of a runtime folder whose code is its `runtime` file, as `installToyRuntime` writes it. */
export const TOY_RUNTIME_MARKER = 'protocol: 1\nentry: ./runtime\n';

/** Makes `dir` the toy as a runtime folder: its `runtime` and its `RUNTIME.yaml`. */
export function installToyRuntime(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(TOY_RUNTIME, path.join(dir, 'runtime'));
  fs.chmodSync(path.join(dir, 'runtime'), 0o755);
  fs.writeFileSync(path.join(dir, 'RUNTIME.yaml'), TOY_RUNTIME_MARKER);
}
